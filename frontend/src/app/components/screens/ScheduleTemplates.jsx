import { useEffect, useMemo, useState } from 'react';
import {
  RefreshCw,
  FileSearch,
  FileText,
  Wand2,
  History,
  AlertTriangle,
  CheckCircle,
  Download,
  Building2,
  CalendarDays,
  FileSpreadsheet,
} from 'lucide-react';
import { api, templateTransformApi } from '@/services/api';
import { toast } from 'sonner';
import { S3_BASE_URL, HIDE_METADATA } from '@/config/appConfig';
import DownloadFormatModal from '@/app/components/common/DownloadFormatModal';
import {
  downloadBlob,
  downloadCsvText,
  downloadXlsxFromCsvText,
  downloadTelanganaTemplateXlsx,
  downloadVedanjayMhXlsx,
  convertXlsxBlobToCsvText,
} from '@/app/components/common/downloadUtils';

const GSNP_NAME = 'Globus Steel N Power (GSNP)';
const SUPPORTED_PLANT_CODES = ['BHUPALPALLY', 'CME', 'GSNP', 'KASIPET', 'KILAJ', 'KOTHAGUDEM', 'OSEPL', 'SIRMOUR'];
const TELANGANA_PLANT_CODES = new Set(['BHUPALPALLY', 'KASIPET', 'KOTHAGUDEM']);
const FALLBACK_PLANTS = [
  { id: 1, code: 'BHUPALPALLY', name: 'BHUPALPALLY', type: 'Solar', state: 'Telangana' },
  { id: 2, code: 'CME', name: 'CME', type: 'Solar', state: 'Maharashtra' },
  { id: 3, code: 'GSNP', name: 'Globus Steel N Power (GSNP)', type: 'Solar', state: 'Madhya Pradesh' },
  { id: 4, code: 'KASIPET', name: 'KASIPET', type: 'Solar', state: 'Telangana' },
  { id: 5, code: 'KILAJ', name: 'KILAJ', type: 'Solar', state: 'Maharashtra' },
  { id: 6, code: 'KOTHAGUDEM', name: 'KOTHAGUDEM', type: 'Solar', state: 'Telangana' },
  { id: 7, code: 'OSEPL', name: 'OSEPL', type: 'Solar', state: 'Maharashtra' },
  { id: 8, code: 'SIRMOUR', name: 'SIRMOUR', type: 'Solar', state: 'Madhya Pradesh' },
];
const FALLBACK_CAPACITY_BY_CODE = {
  BHUPALPALLY: 10,
  CME: 4,
  GSNP: 20,
  KASIPET: 15,
  KILAJ: 20,
  KOTHAGUDEM: 37,
  OSEPL: 20,
  SIRMOUR: 5.1,
};
const SLDC_TEMPLATE_MAP_STORAGE_KEY = 'vedanjay-sldc-template-map-v1';

function derivePlantCodeFromName(name) {
  const text = String(name || '').trim();
  if (!text) return null;
  const match = text.match(/\(([A-Za-z0-9_-]+)\)/);
  if (match) return match[1].toUpperCase();
  if (/^[A-Z0-9_-]{2,6}$/.test(text)) return text.toUpperCase();
  const compact = text.replace(/[^A-Za-z0-9]/g, '');
  return compact ? compact.toUpperCase() : null;
}

function isSupportedPlant(plant) {
  const code = String(plant?.code || '').trim().toUpperCase();
  if (SUPPORTED_PLANT_CODES.includes(code)) return true;

  const name = String(plant?.name || '').trim().toLowerCase();
  return (
    name.includes('gsnp') ||
    name.includes('globus steel') ||
    name.includes('sirmour') ||
    name.includes('bhupalpally') ||
    name.includes('kasipet') ||
    name.includes('kothagudem') ||
    name.includes('cme') ||
    name.includes('kilaj') ||
    name.includes('osepl')
  );
}

function resolvePlantCode(plant) {
  const code = String(plant?.code || '').trim().toUpperCase();
  if (code) return code;
  const name = String(plant?.name || '').toLowerCase();
  if (name.includes('bhupalpally')) return 'BHUPALPALLY';
  if (name.includes('kasipet')) return 'KASIPET';
  if (name.includes('kilaj')) return 'KILAJ';
  if (name.includes('kothagudem')) return 'KOTHAGUDEM';
  if (name.includes('osepl')) return 'OSEPL';
  if (name.includes('cme')) return 'CME';
  if (name.includes('gsnp') || name.includes('globus steel')) return 'GSNP';
  if (name.includes('sirmour')) return 'SIRMOUR';
  return derivePlantCodeFromName(plant?.name);
}

function normalizePlantName(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function derivePlantFolders(plant) {
  const name = String(plant?.name || plant?.code || '').trim();
  if (!name) return null;
  let folder = name;
  if (/^[A-Z0-9_-]+$/.test(folder) && folder.length > 4) {
    const lower = folder.toLowerCase();
    folder = lower.charAt(0).toUpperCase() + lower.slice(1);
  }
  const lowerFolder = folder.toLowerCase().replace(/\s+/g, '');
  return { folder, lower: lowerFolder };
}

function parseS3ListXml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  return Array.from(doc.getElementsByTagName('Contents'))
    .map((node) => ({
      key: node.getElementsByTagName('Key')[0]?.textContent || '',
      last_modified: node.getElementsByTagName('LastModified')[0]?.textContent || '',
    }))
    .filter((item) => item.key);
}

async function listS3Objects(prefix) {
  const url = `${S3_BASE_URL}/?list-type=2&prefix=${encodeURIComponent(prefix)}`;
  const xml = await fetch(url).then((r) => r.text());
  return parseS3ListXml(xml);
}

async function listLatestScheduleFilesFromS3(targetDate, plant) {
  const normalizedCode = String(resolvePlantCode(plant) || '').trim().toUpperCase();
  const derived = derivePlantFolders(plant || { code: normalizedCode });
  const rawPrefix = normalizedCode
    ? `raw/vedanjay/${normalizedCode}`
    : (derived ? `raw/vedanjay/${derived.folder.toUpperCase().replace(/\s+/g, '')}` : null);
  const legacyRawPrefix = normalizedCode === 'SIRMOUR'
    ? 'raw/Sirmour/sirmour'
    : normalizedCode === 'GSNP'
      ? 'raw/GSNP/gsnp'
      : (derived ? `raw/${derived.folder}/${derived.lower}` : null);
  const generatedPrefix = normalizedCode
    ? `generated/vedanjay/${normalizedCode}/outputs`
    : (derived ? `generated/vedanjay/${derived.folder.toUpperCase().replace(/\s+/g, '')}/outputs` : null);
  const legacyGeneratedPrefix = normalizedCode === 'SIRMOUR'
    ? 'generated/Sirmour/sirmour/outputs'
    : normalizedCode === 'GSNP'
      ? 'generated/GSNP/gsnp/outputs'
      : (derived ? `generated/${derived.folder}/${derived.lower}/outputs` : null);
  const prefixes = [
    ...(rawPrefix ? [`${rawPrefix}/${targetDate}/`] : []),
    ...(legacyRawPrefix ? [`${legacyRawPrefix}/${targetDate}/`] : []),
    ...(generatedPrefix ? [`${generatedPrefix}/${targetDate}/`] : []),
    ...(legacyGeneratedPrefix ? [`${legacyGeneratedPrefix}/${targetDate}/`] : []),
    `outputs/${targetDate}/`,
  ];
  const settled = await Promise.allSettled(prefixes.map((p) => listS3Objects(p)));
  const objects = settled
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value || []);

  const normalizeToken = (value) =>
    String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  const normalizedCodeLower = String(normalizedCode || '').trim().toLowerCase();
  const plantTokens = [
    normalizedCodeLower,
    derived?.lower,
    derived?.folder,
  ].filter(Boolean);
  const plantTokensNormalized = Array.from(new Set(plantTokens.map(normalizeToken).filter(Boolean)));
  const scheduleFiles = objects
    .filter((o) => {
      const key = String(o.key || '').toLowerCase();
      const fileName = key.split('/').pop() || '';
      const pathSegments = key.split('/').filter(Boolean);
      const normalizedSegments = pathSegments.map(normalizeToken);
      const normalizedFile = normalizeToken(fileName);
      const plantScoped = plantTokensNormalized.length === 0
        ? true
        : plantTokensNormalized.some((token) =>
            normalizedSegments.includes(token) || normalizedFile.includes(token)
          );
      return (
        key.endsWith('.csv') &&
        key.includes('schedule_from_') &&
        !key.includes('/intraday/') &&
        plantScoped
      );
    })
    .sort((a, b) => {
      const getSeq = (k) => {
        const m = String(k || '').match(/schedule_from_(\d+)\.csv$/i);
        return m ? Number.parseInt(m[1], 10) : null;
      };
      const aSeq = getSeq(a.key);
      const bSeq = getSeq(b.key);
      if (aSeq !== null && bSeq !== null && bSeq !== aSeq) return bSeq - aSeq;
      const aTime = Date.parse(a.last_modified || '');
      const bTime = Date.parse(b.last_modified || '');
      const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
      if (timeDiff !== 0) return timeDiff;
      return (b.key || '').localeCompare(a.key || '');
    });

  return scheduleFiles;
}

function filterScheduleFilesByPlant(files, plant) {
  const normalizedCode = String(resolvePlantCode(plant) || '').trim().toUpperCase();
  const derived = derivePlantFolders(plant || { code: normalizedCode });
  const normalizeToken = (value) =>
    String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  const normalizedCodeLower = String(normalizedCode || '').trim().toLowerCase();
  const plantTokens = [
    normalizedCodeLower,
    derived?.lower,
    derived?.folder,
  ].filter(Boolean);
  const plantTokensNormalized = Array.from(new Set(plantTokens.map(normalizeToken).filter(Boolean)));
  if (!plantTokensNormalized.length) return files;

  return (files || []).filter((file) => {
    const key = String(file?.key || file || '').toLowerCase();
    if (!key) return false;
    const fileName = key.split('/').pop() || '';
    const pathSegments = key.split('/').filter(Boolean);
    const normalizedSegments = pathSegments.map(normalizeToken);
    const normalizedFile = normalizeToken(fileName);
    return plantTokensNormalized.some((token) =>
      normalizedSegments.includes(token) || normalizedFile.includes(token)
    );
  });
}

function sortScheduleFiles(files) {
  return (files || []).slice().sort((a, b) => {
    const getKey = (item) => String(item?.key || item || '');
    const getSeq = (k) => {
      const m = String(k || '').match(/schedule_from_(\d+)\.csv$/i);
      return m ? Number.parseInt(m[1], 10) : null;
    };
    const aKey = getKey(a);
    const bKey = getKey(b);
    const aSeq = getSeq(aKey);
    const bSeq = getSeq(bKey);
    if (aSeq !== null && bSeq !== null && bSeq !== aSeq) return bSeq - aSeq;
    const aTime = Date.parse(a?.lastModified || a?.last_modified || '');
    const bTime = Date.parse(b?.lastModified || b?.last_modified || '');
    const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
    if (timeDiff !== 0) return timeDiff;
    return bKey.localeCompare(aKey);
  });
}

async function fetchTextFromS3(key) {
  const encoded = String(key || '').split('/').map((s) => encodeURIComponent(s)).join('/');
  const resp = await fetch(`${S3_BASE_URL}/${encoded}`);
  if (!resp.ok) throw new Error(`S3 fetch failed: ${resp.status}`);
  return resp.text();
}

function parseCsvRows(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return { headers: [], rows: [] };

  const delimiterCandidates = [',', ';', '\t'];
  const headerCandidate = lines.find((line) => /block/i.test(line)) || lines[0];
  const delimiter = delimiterCandidates.reduce(
    (best, candidate) => {
      const count = String(headerCandidate || '').split(candidate).length - 1;
      return count > best.count ? { value: candidate, count } : best;
    },
    { value: ',', count: -1 }
  ).value;

  const parseLine = (line) => {
    const cells = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === delimiter && !inQuotes) {
        cells.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    cells.push(current.trim());
    return cells;
  };

  const headerLine = lines.find((line) => /block/i.test(line) && line.includes(delimiter)) || lines[0];
  const startIdx = lines.indexOf(headerLine);
  const headers = parseLine(headerLine).map((h) => h.trim());
  const rows = lines.slice(startIdx + 1).map((line) => parseLine(line));
  return { headers, rows };
}

function parseSourceScheduleForecastMap(text, options = {}) {
  const { headers, rows } = parseCsvRows(text);
  if (!headers.length) return new Map();

  const normalize = (value) => String(value || '').toLowerCase().replace(/["']/g, '').replace(/[\s_-]+/g, '');
  const clampForecast = (value) => (Number.isFinite(value) ? Math.max(0, value) : 0);
  const parseNum = (value) => {
    const cleaned = String(value ?? '').replace(/,/g, '').trim();
    const n = Number.parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
  };
  const parseBlock = (value, idx) => {
    const raw = String(value ?? '').trim();
    const direct = Number.parseInt(raw, 10);
    if (Number.isFinite(direct) && direct >= 1 && direct <= 96) return direct;
    const matched = raw.match(/[bB]\s*([0-9]{1,3})/);
    if (matched) {
      const b = Number.parseInt(matched[1], 10);
      if (Number.isFinite(b) && b >= 1 && b <= 96) return b;
    }
    return idx + 1;
  };

  const normalized = headers.map((h) => normalize(h));
  const findCol = (needles) => normalized.findIndex((h) => needles.some((n) => h.includes(n)));

  // SLDC template structure:
  // Block,Block Interval,<Plant Header>,
  // ,,Availability,Forecast
  // 1,00:00-00:15,20,3.5
  const blockHeaderIdx = findCol(['block']);
  const blockIntervalIdx = findCol(['blockinterval']);
  if (blockHeaderIdx === 0 && blockIntervalIdx === 1) {
    let dataStart = 0;
    let forecastCol = 3;
    if (rows.length > 0) {
      const firstRowNormalized = (rows[0] || []).map((v) => normalize(v));
      const firstRowForecastCol = firstRowNormalized.findIndex((h) => h.includes('forecast'));
      const looksLikeSubHeader =
        firstRowForecastCol >= 0 ||
        (firstRowNormalized[0] === '' && firstRowNormalized[1] === '' && firstRowNormalized[2]?.includes('availability'));
      if (looksLikeSubHeader) {
        dataStart = 1;
        if (firstRowForecastCol >= 0) forecastCol = firstRowForecastCol;
      }
    }

    const map = new Map();
    rows.slice(dataStart).forEach((cols, idx) => {
      const block = parseBlock(cols?.[0], idx);
      if (!Number.isFinite(block) || block < 1 || block > 96) return;
      const forecast = parseNum(cols?.[forecastCol]);
      map.set(block, clampForecast(forecast));
    });
    return map;
  }

  const blockIdx = findCol(['block', 'blk', 'blockno']);
  const algoIdx = findCol(['algoschedulemw', 'algoschedule', 'scheduledmw', 'schedule']);
  const forecastIdx = findCol(['forecastmw', 'forecast']);
  const stationScheduleIdx = findCol(['stationschedule', 'station_schedule', 'station']);
  const intradayIdx = findCol(['intradayforecastmw', 'intradayforecast', 'intraday']);
  const fallbackValIdx = normalized.findIndex((h, idx) => idx !== blockIdx && (h.includes('mw') || h.includes('value')));

  const map = new Map();
  const preferForecast = Boolean(options.preferForecast);
  rows.forEach((cols, idx) => {
    const safeBlock = parseBlock(cols?.[blockIdx], idx);
    if (!Number.isFinite(safeBlock) || safeBlock < 1 || safeBlock > 96) return;

    // Prefer algo_schedule_mw for schedule template Forecast column.
    let value = preferForecast ? parseNum(cols?.[forecastIdx]) : parseNum(cols?.[algoIdx]);
    if (!Number.isFinite(value)) {
      value = preferForecast ? parseNum(cols?.[stationScheduleIdx]) : parseNum(cols?.[stationScheduleIdx]);
    }
    if (!Number.isFinite(value)) {
      value = preferForecast ? parseNum(cols?.[algoIdx]) : parseNum(cols?.[forecastIdx]);
    }
    if (!Number.isFinite(value)) value = parseNum(cols?.[intradayIdx]);
    if (!Number.isFinite(value)) value = parseNum(cols?.[fallbackValIdx]);
    map.set(safeBlock, clampForecast(value));
  });

  return map;
}

function blockToInterval(block) {
  const idx = Math.max(0, Number(block) - 1);
  const fromMins = idx * 15;
  const toMins = (idx + 1) * 15;
  const fmt = (mins) => {
    const hh = Math.floor(mins / 60) % 24;
    const mm = mins % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };
  return `${fmt(fromMins)}-${fmt(toMins)}`;
}

function extractRevisionFromKey(sourceKey) {
  const m = String(sourceKey || '').match(/schedule_from_(\d+)\.csv$/i);
  return m ? Number.parseInt(m[1], 10) : 1;
}

function formatSldcPlantHeader(plantCode) {
  if (plantCode === 'GSNP') return 'GLOBUS STEEL N POWER';
  if (plantCode === 'SIRMOUR') return '5.1MW M/s SIRMOUR SMALL HYDRO POWER PVT LTD';
  return plantCode || 'PLANT';
}

function resolveCapacityByPlant({ plantCode, plantName, plantCapacity }) {
  const code = String(plantCode || '').trim().toUpperCase();
  // Enforce known site capacities first to avoid wrong backend values.
  if (FALLBACK_CAPACITY_BY_CODE[code] !== undefined) return Number(FALLBACK_CAPACITY_BY_CODE[code]);

  const parsedCapacity = Number(plantCapacity);
  if (Number.isFinite(parsedCapacity) && parsedCapacity > 0) return parsedCapacity;

  const normalizedName = String(plantName || '').trim().toLowerCase();
  if (normalizedName.includes('gsnp') || normalizedName.includes('globus steel')) return FALLBACK_CAPACITY_BY_CODE.GSNP;
  if (normalizedName.includes('sirmour')) return FALLBACK_CAPACITY_BY_CODE.SIRMOUR;
  return 0;
}

function isTelanganaPlantCode(plantCode) {
  return TELANGANA_PLANT_CODES.has(String(plantCode || '').trim().toUpperCase());
}

function isOseplPlantCode(plantCode) {
  return String(plantCode || '').trim().toUpperCase() === 'OSEPL';
}

function isCmePlantCode(plantCode) {
  return String(plantCode || '').trim().toUpperCase() === 'CME';
}

function formatTelanganaDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return raw;
}

function formatTelanganaPlantName(plantCode, plantName) {
  const name = String(plantName || '').trim();
  if (name) return name;
  return String(plantCode || '').trim().toUpperCase();
}

function formatTelanganaCapacity(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '';
  return num.toFixed(1);
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (text.includes('"')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  if (text.includes(',') || text.includes('\n') || text.includes('\r')) {
    return `"${text}"`;
  }
  return text;
}

const TELANGANA_TEMPLATE_META = {
  BHUPALPALLY: {
    plantName: 'Singareni Collieries Company Limited-Chelpur',
    contractType: 'Mtoa',
    approvalNo: 'TSTRANSCO/21/2023-24',
    toUtility: 'SCCL(BPL-003, BPL-006, BPL-028)',
  },
  KASIPET: {
    plantName: 'Singareni Collieries Company Limited-Kasipet Mines',
    contractType: 'Lta',
    approvalNo: 'TSTRANSCO/20/2023-24',
    toUtility: 'SCCL(BPL-003, BPL-004, BPL-065)',
  },
  KOTHAGUDEM: {
    plantName: 'Singareni Collieries Company Limited-Sitarampatnam',
    contractType: 'Lta',
    approvalNo: 'TGTRANSCO/17/2024-25',
    toUtility:
      'General Manager, SCCL Mandamarri MCL-009,General Manager, SCCL Mandamarri MCL-022,General Manager, SCCL Ramagundam PDL-001,General Manager, SCCL RG3 area PDL-023,General Manager, SCCL Yellandu BKM-002, General Manager, SCCL sathupalli KMM-361.',
  },
};

const VEDANJAY_META = {
  CME: {
    schedulingEntity: 'MH_VEDANJAY',
    posName: 'VSNL Dighi 220kV',
    downStreamName: 'VSNL Dighi 220kV',
    energyType: 'SOLAR',
    contractId: 'CONTRACT21424',
    contractType: 'MTOA',
    exchangeType: 'NA',
    transactionType: 'INTRA',
    reGeneratorName: 'VSNL Dighi 220kV',
    path: 'A-B',
    buyerName: 'OA-MSEDCL',
    stuName: 'VSNL Dighi 220kV',
    approvalNumber: 'VSNLDighi/S/03/26/OA-MSEDCL',
    capacity: 4,
  },
  OSEPL: {
    schedulingEntity: 'MH_VEDANJAY',
    posName: 'Naldurg Inter 132kV',
    downStreamName: 'Naldurg Inter 132kV',
    energyType: 'SOLAR',
    contractId: 'CONTRACT00192',
    contractType: 'LTA',
    exchangeType: 'NA',
    transactionType: 'INTER',
    reGeneratorName: 'Naldurg Inter 132kV',
    path: 'WR-WR',
    buyerName: 'SOLAR_CSEB',
    stuName: 'Naldurg 132kV',
    approvalNumber: 'L_WR_2014_03',
    capacity: 20,
  },
};

function getTelanganaTemplateMeta(plantCode, plantName) {
  const code = String(plantCode || '').trim().toUpperCase();
  const meta = TELANGANA_TEMPLATE_META[code] || {};
  return {
    plantDisplayName: meta.plantName || formatTelanganaPlantName(code, plantName),
    contractType: meta.contractType || 'Mtoa',
    approvalNo: meta.approvalNo || '',
    toUtility: meta.toUtility || '',
  };
}

function buildAvcValueResolver(valuesMap) {
  const nonZeroBlocks = Array.from(valuesMap.entries())
    .filter(([, value]) => Number.isFinite(value) && value > 0)
    .map(([block]) => Number(block))
    .filter((block) => Number.isFinite(block))
    .sort((a, b) => a - b);

  if (!nonZeroBlocks.length) {
    return () => 0;
  }

  const first = nonZeroBlocks[0];
  const last = nonZeroBlocks[nonZeroBlocks.length - 1];
  return (block, capacity) => {
    const safeBlock = Number(block);
    if (!Number.isFinite(safeBlock)) return capacity;
    // Set AVC = 0 for all blocks before intraday starts (incl. 2 blocks before).
    if (safeBlock < first) return 0;
    // Set AVC = 0 for all blocks after intraday ends.
    if (safeBlock > last) return 0;
    return capacity;
  };
}

function buildSldcCsvText({ sourceKey, sourceText, plantCode, plantName, scheduleDate, capacityMw, revisionNumber }) {
  if (isTelanganaPlantCode(plantCode)) {
    const stationScheduleMap = parseSourceScheduleForecastMap(sourceText, { preferForecast: false });
    const capacity = Number.isFinite(Number(capacityMw)) ? Number(capacityMw) : 0;
    const resolveAvc = buildAvcValueResolver(stationScheduleMap);
    const dateValue = formatTelanganaDate(scheduleDate);
    const generatorName = 'Singareni';
    const meta = getTelanganaTemplateMeta(plantCode, plantName);
    const plantDisplayName = meta.plantDisplayName;
    const capacityDisplay = formatTelanganaCapacity(capacity);
    const lines = [
      `Name of Generator,${csvEscape(generatorName)}`,
      `Plant name,${csvEscape(plantDisplayName)}`,
      `Capacity(MW),${csvEscape(capacityDisplay)}`,
      `Date,${csvEscape(dateValue)}`,
      'Type,intraday',
      '',
      '',
      `Contract Type,,,,,${csvEscape(meta.contractType)}`,
      `Approval No,,,,,${csvEscape(meta.approvalNo)}`,
      `To Utility,,,,,${csvEscape(meta.toUtility)}`,
      'Path,',
      `Block,Time Period,Forecast(MW),AvC(MW),Station Schedule,${csvEscape(capacityDisplay)}`,
    ];

    const truncate2 = (value) => {
      const num = Number(value);
      if (!Number.isFinite(num)) return '';
      const truncated = Math.trunc(num * 100) / 100;
      return truncated.toFixed(2);
    };

    for (let block = 1; block <= 96; block += 1) {
      const timePeriod = blockToInterval(block);
      const stationSchedule = stationScheduleMap.get(block);
      const stationValue = truncate2(stationSchedule);
      const avcValue = resolveAvc(block, capacity);
      // For Telangana SLDC, duplicate Station Schedule into the last column (capacity/helper)
      lines.push(`${block},${timePeriod},,${avcValue},${stationValue},${stationValue}`);
    }

    return lines.join('\n');
  }

  if (isOseplPlantCode(plantCode) || isCmePlantCode(plantCode)) {
    const meta = VEDANJAY_META[String(plantCode || '').trim().toUpperCase()] || {};
    const forecastMap = parseSourceScheduleForecastMap(sourceText);
    const capacity = Number.isFinite(Number(meta.capacity))
      ? Number(meta.capacity)
      : Number.isFinite(Number(capacityMw))
        ? Number(capacityMw)
        : 0;
    const resolveAvc = buildAvcValueResolver(forecastMap);
    const lines = [
      'Schedule Template for MH_VEDANJAY and revision INTRADAY,,,',
      ['', 'Scheduling entity', meta.schedulingEntity || 'MH_VEDANJAY', '']
        .map(csvEscape)
        .join(','),
      ['', 'Date', scheduleDate, '']
        .map(csvEscape)
        .join(','),
      ['', 'Revision No', 'INTRADAY', '']
        .map(csvEscape)
        .join(','),
      '',
      ['POS Name', meta.posName || '', meta.posName || '', meta.posName || '']
        .map(csvEscape)
        .join(','),
      ['Down Stream Name', '', '', meta.downStreamName || '']
        .map(csvEscape)
        .join(','),
      ['Energy Type', '', '', meta.energyType || '']
        .map(csvEscape)
        .join(','),
      ['Contract ID', '', '', meta.contractId || '']
        .map(csvEscape)
        .join(','),
      ['Contract Type', '', '', meta.contractType || '']
        .map(csvEscape)
        .join(','),
      ['Exchange Type', '', '', meta.exchangeType || '']
        .map(csvEscape)
        .join(','),
      ['Transaction Type', meta.transactionType || '', meta.transactionType || '', meta.transactionType || '']
        .map(csvEscape)
        .join(','),
      ['RE Generator Name', '', '', meta.reGeneratorName || '']
        .map(csvEscape)
        .join(','),
      ['Path', '', '', meta.path || '']
        .map(csvEscape)
        .join(','),
      ['Buyer Name', '', '', meta.buyerName || '']
        .map(csvEscape)
        .join(','),
      ['STU Name', '', '', meta.stuName || '']
        .map(csvEscape)
        .join(','),
      ['Approval Number', '', '', meta.approvalNumber || '']
        .map(csvEscape)
        .join(','),
      '',
      ['Capacity', capacity, capacity, capacity]
        .map(csvEscape)
        .join(','),
      'Block,Declared Forecast,Inter Avc,Schedule',
    ];

    for (let block = 1; block <= 96; block += 1) {
      const forecast = Number.isFinite(forecastMap.get(block)) ? forecastMap.get(block) : 0;
      const scheduleVal = forecast;
      const avcValue = resolveAvc(block, capacity);
      lines.push(`${block},${scheduleVal},${avcValue},${scheduleVal}`);
    }

    return lines.join('\n');
  }

  const forecastMap = parseSourceScheduleForecastMap(sourceText);
  const revision = Number.isFinite(Number(revisionNumber))
    ? Number(revisionNumber)
    : extractRevisionFromKey(sourceKey);
  const plantHeader = formatSldcPlantHeader(plantCode);
  const capacity = Number.isFinite(Number(capacityMw)) ? Number(capacityMw) : 0;
  const resolveAvc = buildAvcValueResolver(forecastMap);

  const lines = [
    'TYPE:,REG,,',
    `DATE:,${scheduleDate},,`,
    `REVISION:,${revision},,`,
    'REASON:,NA,,',
    `Block,Block Interval,${plantHeader},`,
    ',,Availability,Forecast',
  ];

  for (let block = 1; block <= 96; block += 1) {
    const forecast = Number.isFinite(forecastMap.get(block)) ? forecastMap.get(block) : 0;
    const avcValue = resolveAvc(block, capacity);
    lines.push(`${block},${blockToInterval(block)},${avcValue},${forecast}`);
  }

  return lines.join('\n');
}

function validateSldcPreviewRows(rows, capacityMw, options = {}) {
  const errors = [];
  const warnings = [];
  const allowBlankForecast = options.allowBlankForecast === true;

  if (!Array.isArray(rows) || rows.length === 0) {
    return { is_valid: false, errors: ['No rows generated for SLDC preview.'], warnings };
  }

  if (rows.length !== 96) {
    errors.push(`Expected 96 blocks but got ${rows.length}.`);
  }

  const seen = new Set();
  const capacity = Number(capacityMw);
  rows.forEach((row, idx) => {
    const block = Number.parseInt(row?.Block, 10);
    const forecastRaw = row?.Forecast;
    const forecast = Number.parseFloat(forecastRaw);
    const availability = Number.parseFloat(row?.Availability);
    const rowLabel = `Row ${idx + 1}`;

    if (!Number.isFinite(block) || block < 1 || block > 96) {
      errors.push(`${rowLabel}: invalid block number.`);
    } else if (seen.has(block)) {
      errors.push(`${rowLabel}: duplicate block ${block}.`);
    } else {
      seen.add(block);
    }

    if (!Number.isFinite(forecast)) {
      const isBlankForecast = forecastRaw === '' || forecastRaw === null || forecastRaw === undefined;
      if (!(allowBlankForecast && isBlankForecast)) {
        errors.push(`${rowLabel}: invalid forecast value.`);
      }
    }

    if (!Number.isFinite(availability)) {
      errors.push(`${rowLabel}: invalid availability value.`);
    }
  });

  if (Number.isFinite(capacity) && capacity > 0) {
    const overflow = rows.filter((r) => Number.parseFloat(r?.Forecast) > capacity * 2).length;
    if (overflow > 0) {
      warnings.push(`${overflow} block(s) have forecast above 2x plant capacity.`);
    }
  }

  return { is_valid: errors.length === 0, errors, warnings };
}

function sanitizeValidationAllowNegative(backendValidation, fallbackValidation) {
  const fallback = fallbackValidation || { is_valid: true, errors: [], warnings: [] };
  if (!backendValidation || typeof backendValidation !== 'object') return fallback;

  const errors = (Array.isArray(backendValidation.errors) ? backendValidation.errors : []).filter(
    (msg) => !String(msg || '').toLowerCase().includes('negative')
  );
  const warnings = (Array.isArray(backendValidation.warnings) ? backendValidation.warnings : []).filter(
    (msg) => !String(msg || '').toLowerCase().includes('negative')
  );

  return {
    is_valid: errors.length === 0,
    errors,
    warnings,
  };
}

async function buildPreviewFromSourceCsv({
  sourceKey,
  plantId,
  plantCode,
  plantName,
  scheduleDate,
  capacityMw,
  revisionNumber,
}) {
  const text = await fetchTextFromS3(sourceKey);
  const resolvedPlantCode = plantCode || 'GSNP';
  const resolvedDate = scheduleDate || String(sourceKey || '').match(/(\d{4}-\d{2}-\d{2})/)?.[1] || new Date().toISOString().split('T')[0];
  const resolvedCapacity = resolveCapacityByPlant({
    plantCode: resolvedPlantCode,
    plantName,
    plantCapacity: capacityMw,
  });
  const csvText = buildSldcCsvText({
    sourceKey,
    sourceText: text,
    plantCode: resolvedPlantCode,
    plantName,
    scheduleDate: resolvedDate,
    capacityMw: resolvedCapacity,
    revisionNumber,
  });

  const isTelangana = isTelanganaPlantCode(resolvedPlantCode);
  const isOsepl = isOseplPlantCode(resolvedPlantCode) || isCmePlantCode(resolvedPlantCode);
  const targetColumns = isTelangana
    ? ['Block', 'Time Period', 'Forecast(MW)', 'AvC(MW)', 'Station Schedule']
    : isOsepl
      ? ['Block', 'Declared Forecast', 'Inter Avc', 'Schedule']
      : ['Block', 'Block Interval', 'Availability', 'Forecast'];
  const lines = csvText.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) =>
    isTelangana
      ? line.trim().toLowerCase().startsWith('block,time period')
      : isOsepl
        ? line.trim().toLowerCase().startsWith('block,declared forecast')
        : line.trim().toLowerCase().startsWith('block,block interval')
  );
  const dataLines = headerIndex >= 0 ? lines.slice(headerIndex + 1) : lines;
  const transformedPreview = dataLines
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const cols = line.split(',');
      if (isTelangana) {
        const [block, timePeriod, forecastMw, avcMw, stationSchedule] = cols;
        return {
          Block: block ?? '',
          'Time Period': timePeriod ?? '',
          'Forecast(MW)': forecastMw ?? '',
          'AvC(MW)': avcMw ?? '',
          'Station Schedule': stationSchedule ?? '',
        };
      }
      if (isOsepl) {
        const [block, declaredForecast, interAvc, schedule] = cols;
        return {
          Block: block ?? '',
          'Declared Forecast': declaredForecast ?? '',
          'Inter Avc': interAvc ?? '',
          Schedule: schedule ?? '',
        };
      }
      const [block, blockInterval, availability, forecast] = cols;
      return {
        Block: block ?? '',
        'Block Interval': blockInterval ?? '',
        Availability: availability ?? '',
        Forecast: forecast ?? '',
      };
    });
  const validation = isTelangana
    ? validateSldcPreviewRows(
        transformedPreview.map((row) => ({
          Block: row.Block,
          Availability: row['AvC(MW)'],
          Forecast: row['Station Schedule'],
        })),
        resolvedCapacity,
        { allowBlankForecast: true }
      )
    : isOsepl
      ? validateSldcPreviewRows(
          transformedPreview.map((row) => ({
            Block: row.Block,
            Availability: row['Inter Avc'],
            Forecast: row.Schedule,
          })),
          resolvedCapacity
        )
      : validateSldcPreviewRows(transformedPreview, resolvedCapacity);

  return {
    plant_id: plantId,
    template_id: 'client_fallback_sldc_v1',
    template_version: '1.0.0',
    source_file_key: sourceKey,
    source_hash: 'client-fallback',
    canonical_row_count: transformedPreview.length,
    validation,
    target_columns: targetColumns,
    canonical_preview: [],
    transformed_preview: transformedPreview,
    sldc_metadata: {
      type: 'REG',
      date: resolvedDate,
      revision: Number.isFinite(Number(revisionNumber))
        ? Number(revisionNumber)
        : extractRevisionFromKey(sourceKey),
      reason: 'NA',
      plant_header: formatSldcPlantHeader(resolvedPlantCode),
      capacity_mw: resolvedCapacity,
      template_format: isTelangana ? 'TELANGANA_INTRADAY' : 'DEFAULT_SLDC',
    },
    download_csv_text: csvText,
  };
}

async function buildClientSldcPreview({
  selectedSourceKey,
  selectedPlantId,
  selectedPlant,
  selectedDate,
  sourceFiles,
}) {
  const plantCode = resolvePlantCode(selectedPlant) || 'GSNP';
  const resolvedCapacity = resolveCapacityByPlant({
    plantCode,
    plantName: selectedPlant?.name,
    plantCapacity: selectedPlant?.capacity,
  });
  const revisionNumber = sourceFiles.length;

  return buildPreviewFromSourceCsv({
    sourceKey: selectedSourceKey,
    plantId: Number(selectedPlantId),
    plantCode,
    plantName: selectedPlant?.name,
    scheduleDate: selectedDate,
    capacityMw: resolvedCapacity,
    revisionNumber,
  });
}

function toCsvCell(value) {
  const text = String(value ?? '');
  if (text.includes('"') || text.includes(',') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function buildCsvBlobFromPreview(preview) {
  if (preview?.download_csv_text) {
    return new Blob([preview.download_csv_text], { type: 'text/csv;charset=utf-8;' });
  }
  const columns = Array.isArray(preview?.target_columns) ? preview.target_columns : [];
  const rows = Array.isArray(preview?.transformed_preview) ? preview.transformed_preview : [];
  if (!columns.length) throw new Error('No preview columns available to generate CSV.');

  const csvLines = [
    columns.map(toCsvCell).join(','),
    ...rows.map((row) => columns.map((c) => toCsvCell(row?.[c] ?? '')).join(',')),
  ];
  return new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
}

function formatDisplayDateTime(value) {
  const dt = value ? new Date(value) : new Date();
  if (Number.isNaN(dt.getTime())) return '-';
  return dt.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function getFileNameFromKey(key) {
  return String(key || '').split('/').pop() || '';
}

function readSldcTemplateMap() {
  try {
    const raw = localStorage.getItem(SLDC_TEMPLATE_MAP_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeSldcTemplateMap(nextMap) {
  localStorage.setItem(SLDC_TEMPLATE_MAP_STORAGE_KEY, JSON.stringify(nextMap || {}));
}

export function ScheduleTemplates({ context = null }) {
  const today = new Date().toISOString().split('T')[0];
  const [selectedPlantId, setSelectedPlantId] = useState('');
  const [selectedDate, setSelectedDate] = useState(today);
  const [selectedSourceKey, setSelectedSourceKey] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const [plants, setPlants] = useState([]);
  const [sourceFiles, setSourceFiles] = useState([]);
  const [sourceFilesByPlantCode, setSourceFilesByPlantCode] = useState({});
  const [previewResult, setPreviewResult] = useState(null);
  const [generateResult, setGenerateResult] = useState(null);
  const [historyRows, setHistoryRows] = useState([]);
  const [localHistoryRows, setLocalHistoryRows] = useState([]);

  const [loadingPlants, setLoadingPlants] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [loadingGenerate, setLoadingGenerate] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [downloadingRunId, setDownloadingRunId] = useState(null);
  const [localDownloads, setLocalDownloads] = useState({});
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [downloadFormat, setDownloadFormat] = useState('csv');
  const [pendingDownloadAction, setPendingDownloadAction] = useState(null);
  const [hasAppliedReadinessContext, setHasAppliedReadinessContext] = useState(false);
  const [preferredSourceKey, setPreferredSourceKey] = useState('');
  const [autoPreviewRequested, setAutoPreviewRequested] = useState(false);

  const readReadinessContextFromUrl = () => {
    try {
      const params = new URLSearchParams(window.location.search || '');
      if (!params.has('fromReadiness')) return null;
      return {
        plantId: params.get('plantId') || '',
        plantName: params.get('plantName') || '',
        plantCode: params.get('plantCode') || '',
        sourceFileKey: params.get('sourceFileKey') || '',
        scheduleDate: params.get('scheduleDate') || '',
        fromReadiness: params.get('fromReadiness') === '1',
        autoPreview: params.get('autoPreview') === '1',
      };
    } catch {
      return null;
    }
  };

  const getEffectiveReadinessContext = () => {
    const urlContext = readReadinessContextFromUrl();
    if (urlContext) return urlContext;
    if (context?.fromReadiness) return context;
    return null;
  };

  const readinessContextSourceKey = String(getEffectiveReadinessContext()?.sourceFileKey || '').trim();
  const isFromReadiness = Boolean(getEffectiveReadinessContext()?.fromReadiness);

  const selectedPlant = useMemo(
    () => plants.find((p) => String(p.id) === String(selectedPlantId)) || null,
    [plants, selectedPlantId]
  );
  const selectedPlantCode = useMemo(
    () => resolvePlantCode(selectedPlant),
    [selectedPlant]
  );

  const canPreview = Boolean(selectedPlantId && selectedDate && selectedSourceKey) && !loadingPreview;
  const canGenerate = canPreview && Boolean(previewResult?.validation?.is_valid) && !loadingGenerate;

  const appendLocalHistory = (row) => {
    setLocalHistoryRows((prev) => [row, ...prev.filter((r) => r.id !== row.id)]);
  };

  const persistGeneratedTemplate = ({ sourceFileKey, templateFileName, csvText, plantId, plantName }) => {
    if (!sourceFileKey || !templateFileName) return;
    const prev = readSldcTemplateMap();
    prev[sourceFileKey] = {
      source_file_key: sourceFileKey,
      template_file_name: templateFileName,
      csv_text: String(csvText || ''),
      plant_id: plantId ?? null,
      plant_name: plantName || '',
      generated_at: new Date().toISOString(),
    };
    writeSldcTemplateMap(prev);
  };

  const loadPlants = async () => {
    setLoadingPlants(true);
    try {
      const [plantsResult, activeResult] = await Promise.allSettled([
        api.plants.getAll({}),
        templateTransformApi.getActivePlants(),
      ]);
      const plantPayload = plantsResult.status === 'fulfilled' ? plantsResult.value : null;
      const rows = Array.isArray(plantPayload?.plants) ? plantPayload.plants : [];
      const activePlantIds = activeResult.status === 'fulfilled'
        ? (Array.isArray(activeResult.value?.plant_ids)
          ? activeResult.value.plant_ids.map((id) => Number(id))
          : [])
        : [];
      const activePlantNames = activeResult.status === 'fulfilled'
        ? (Array.isArray(activeResult.value?.plant_names) ? activeResult.value.plant_names : [])
        : [];
      const activeNameSet = new Set(activePlantNames.map((name) => normalizePlantName(name)));

      let finalPlants = rows.length ? rows : FALLBACK_PLANTS;
      if (activePlantIds.length > 0) {
        finalPlants = finalPlants.filter((p) => {
          if (activePlantIds.includes(Number(p.id))) return true;
          if (activeNameSet.size === 0) return false;
          const plantKey = normalizePlantName(p?.name);
          return plantKey && activeNameSet.has(plantKey);
        });
      } else {
        finalPlants = finalPlants.filter((p) => isSupportedPlant(p));
      }
      if (!finalPlants.length) {
        finalPlants = rows.length ? rows : FALLBACK_PLANTS;
        toast.warning('No active template plants detected. Showing all plants.');
      }
      // If coming from Readiness, ensure the target plant is present even if not in active list.
      const readinessContext = isFromReadiness ? getEffectiveReadinessContext() : null;
      if (isFromReadiness && readinessContext) {
        const normalizeCode = (value) => {
          const text = String(value || '').trim().toUpperCase();
          if (!text) return '';
          if (text.includes('SIRMOUR') || text.includes('SHRIMOUR') || text.includes('SHROMOUR')) return 'SIRMOUR';
          if (text.includes('GSNP') || text.includes('GLOBUS')) return 'GSNP';
          if (text.includes('BHUPALPALLY')) return 'BHUPALPALLY';
          if (text.includes('KASIPET')) return 'KASIPET';
          if (text.includes('KILAJ')) return 'KILAJ';
          if (text.includes('KOTHAGUDEM')) return 'KOTHAGUDEM';
          if (text.includes('OSEPL')) return 'OSEPL';
          if (text.includes('CME')) return 'CME';
          return text;
        };
        const desiredCode = normalizeCode(readinessContext?.plantCode || readinessContext?.plantName);
        if (desiredCode) {
          const already = finalPlants.some((p) => String(resolvePlantCode(p) || '').trim().toUpperCase() === desiredCode);
          if (!already) {
            const fromRows = rows.find((p) => String(resolvePlantCode(p) || '').trim().toUpperCase() === desiredCode);
            const fromFallback = FALLBACK_PLANTS.find((p) => String(resolvePlantCode(p) || '').trim().toUpperCase() === desiredCode);
            const target = fromRows || fromFallback;
            if (target) {
              finalPlants = [...finalPlants, target];
            }
          }
        }
      }

      setPlants(finalPlants);

      const hasCurrentSelection = finalPlants.some((p) => String(p.id) === String(selectedPlantId));
      if ((!selectedPlantId || !hasCurrentSelection) && finalPlants.length > 0) {
        if (isFromReadiness && readinessContext) {
          const normalizeCode = (value) => {
            const text = String(value || '').trim().toUpperCase();
            if (!text) return '';
            if (text.includes('SIRMOUR') || text.includes('SHRIMOUR') || text.includes('SHROMOUR')) return 'SIRMOUR';
            if (text.includes('GSNP') || text.includes('GLOBUS')) return 'GSNP';
            if (text.includes('BHUPALPALLY')) return 'BHUPALPALLY';
            if (text.includes('KASIPET')) return 'KASIPET';
            if (text.includes('KILAJ')) return 'KILAJ';
            if (text.includes('KOTHAGUDEM')) return 'KOTHAGUDEM';
            if (text.includes('OSEPL')) return 'OSEPL';
            if (text.includes('CME')) return 'CME';
            return text;
          };
          const desiredCode = normalizeCode(readinessContext?.plantCode || readinessContext?.plantName);
          const desiredPlant = desiredCode
            ? finalPlants.find((p) => String(resolvePlantCode(p) || '').trim().toUpperCase() === desiredCode)
            : null;
          if (desiredPlant) {
            setSelectedPlantId(String(desiredPlant.id));
          } else {
            const gsnp = finalPlants.find((p) => String(p.name || '').trim().toLowerCase() === GSNP_NAME.toLowerCase());
            setSelectedPlantId(String((gsnp || finalPlants[0]).id));
          }
        } else {
          setSelectedPlantId('');
        }
      }

    } catch (error) {
      const fallbackPlants = FALLBACK_PLANTS.filter((p) => isSupportedPlant(p));
      setPlants(fallbackPlants);
      if (!selectedPlantId && fallbackPlants.length > 0) {
        setSelectedPlantId(String(fallbackPlants[0].id));
      }
      toast.warning('Plant API unavailable. Using GSNP/SIRMOUR fallback.');
    } finally {
      setLoadingPlants(false);
    }
  };

  const loadSourceFiles = async () => {
    if (!selectedDate) return;
    setLoadingFiles(true);
    setPreviewResult(null);
    setGenerateResult(null);
    try {
      if (!selectedPlantId) {
        setSourceFilesByPlantCode({});
        setSourceFiles([]);
        setSelectedSourceKey('');
        return;
      }
      const plantRef = selectedPlant || { code: selectedPlantCode };
      const plantKey = String(resolvePlantCode(plantRef) || selectedPlantCode || 'PLANT').toUpperCase();

      let files = [];
      try {
        const backendResult = await templateTransformApi.listSourceFiles(selectedDate, selectedPlantId);
        files = Array.isArray(backendResult?.files) ? backendResult.files : [];
        files = sortScheduleFiles(filterScheduleFilesByPlant(files, plantRef));
        if (files.length === 0) {
          files = await listLatestScheduleFilesFromS3(selectedDate, plantRef);
        }
      } catch (backendError) {
        files = await listLatestScheduleFilesFromS3(selectedDate, plantRef);
      }

      files = sortScheduleFiles(files);

      const nextMap = { [plantKey]: files };
      setSourceFilesByPlantCode(nextMap);

      const currentRows = nextMap[plantKey] || [];
      setSourceFiles(currentRows);
      setSelectedSourceKey((prev) => {
        const preferred =
          (preferredSourceKey && currentRows.some((r) => r.key === preferredSourceKey))
            ? preferredSourceKey
            : '';
        if (preferred) return preferred;
        return currentRows.some((r) => r.key === prev) ? prev : currentRows[0]?.key || '';
      });
      if (plantKey && currentRows.length === 0) {
        toast.warning(`No schedule_from_*.csv found for ${plantKey} on ${selectedDate}.`);
      }
    } catch (error) {
      toast.error(`Failed to load source files: ${error.message || 'Unknown error'}`);
    } finally {
      setLoadingFiles(false);
    }
  };

  const loadHistory = async () => {
    setLoadingHistory(true);
    try {
      const result = await templateTransformApi.history({
        plantId: selectedPlantId ? Number(selectedPlantId) : null,
        runDate: selectedDate || null,
        status: statusFilter || null,
        limit: 50,
      });
      setHistoryRows(Array.isArray(result?.items) ? result.items : []);
    } catch (error) {
      toast.error(`Failed to load history: ${error.message || 'Unknown error'}`);
    } finally {
      setLoadingHistory(false);
    }
  };

  const onPreview = async () => {
    if (!canPreview) return;
    setLoadingPreview(true);
    setGenerateResult(null);
    try {
      const fallbackPreview = await buildClientSldcPreview({
        selectedSourceKey,
        selectedPlantId,
        selectedPlant,
        selectedDate,
        sourceFiles,
      });

      const result = await templateTransformApi.preview({
        plant_id: Number(selectedPlantId),
        date: selectedDate,
        source_file_key: selectedSourceKey,
        requested_by: 'admin',
      });
      // Keep backend validation/source metadata, but use deterministic client SLDC layout.
      const normalizedResult = {
        ...result,
        transformed_preview: fallbackPreview.transformed_preview,
        target_columns: fallbackPreview.target_columns,
        canonical_row_count: fallbackPreview.canonical_row_count,
        sldc_metadata: fallbackPreview.sldc_metadata,
        download_csv_text: fallbackPreview.download_csv_text,
        validation: sanitizeValidationAllowNegative(result?.validation, fallbackPreview.validation),
      };
      setPreviewResult(normalizedResult);
      if (result?.validation?.is_valid) toast.success('Preview completed: validation passed.');
      else toast.warning('Preview completed: validation failed.');
      appendLocalHistory({
        id: `local-preview-${Date.now()}`,
        created_at: new Date().toISOString(),
        plant_id: Number(selectedPlantId),
        template_id: normalizedResult?.template_id || 'client_fallback_sldc_v1',
        template_version: normalizedResult?.template_version || '1.0.0',
        status: normalizedResult?.validation?.is_valid ? 'PREVIEW_VALID' : 'PREVIEW_FAILED',
        source_file_key: selectedSourceKey,
        output_file_key: '-',
        metadata: normalizedResult?.sldc_metadata || null,
      });
      await loadHistory();
    } catch (error) {
      const errorText = String(error?.message || error?.detail || '').toLowerCase();
      const shouldFallback =
        error?.status === 404 ||
        error?.status === 400 ||
        errorText.includes('no active template');

      if (shouldFallback && selectedSourceKey) {
        try {
          const fallbackPreview = await buildClientSldcPreview({
            selectedSourceKey,
            selectedPlantId,
            selectedPlant,
            selectedDate,
            sourceFiles,
          });
          setPreviewResult(fallbackPreview);
          appendLocalHistory({
            id: `local-preview-${Date.now()}`,
            created_at: new Date().toISOString(),
            plant_id: Number(selectedPlantId),
            template_id: fallbackPreview?.template_id || 'client_fallback_sldc_v1',
            template_version: fallbackPreview?.template_version || '1.0.0',
            status: fallbackPreview?.validation?.is_valid ? 'PREVIEW_VALID' : 'PREVIEW_FAILED',
            source_file_key: selectedSourceKey,
            output_file_key: '-',
            metadata: fallbackPreview?.sldc_metadata || null,
          });
          toast.warning('Preview API unavailable for this plant. Showing client-side preview from S3.');
          return;
        } catch (fallbackError) {
          toast.error(`Preview fallback failed: ${fallbackError.message || 'Unknown error'}`);
          return;
        }
      }
      toast.error(`Preview failed: ${error.message || 'Unknown error'}`);
    } finally {
      setLoadingPreview(false);
    }
  };

  const downloadCsvOrXlsxFromText = async (csvText, filename, format, sheetName = 'Template', options = {}) => {
    const base = String(filename || 'template').replace(/\.(csv|xlsx|xls)$/i, '');
    const { useTelanganaStyling = false, useVedanjayMhStyling = false } = options;
    if (format === 'xlsx') {
      if (useTelanganaStyling) {
        await downloadTelanganaTemplateXlsx(csvText, base, sheetName);
      } else if (useVedanjayMhStyling) {
        await downloadVedanjayMhXlsx(csvText, base, sheetName);
      } else {
        await downloadXlsxFromCsvText(csvText, base, sheetName, { forceString: true });
      }
    } else {
      downloadCsvText(csvText, base);
    }
  };

  const downloadFromBlobWithFormat = async (blob, filename, format, sheetName = 'Template', options = {}) => {
    const base = String(filename || 'template').replace(/\.(csv|xlsx|xls)$/i, '');
    const lowerName = String(filename || '').toLowerCase();
    const isXlsx = lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls');
    if (format === 'xlsx') {
      if (isXlsx) {
        downloadBlob(blob, `${base}.xlsx`);
      } else {
        const csvText = await blob.text();
        await downloadCsvOrXlsxFromText(csvText, base, 'xlsx', sheetName, options);
      }
      return;
    }
    if (isXlsx) {
      const csvText = await convertXlsxBlobToCsvText(blob);
      downloadCsvText(csvText, base);
      return;
    }
    downloadBlob(blob, `${base}.csv`);
  };

  const onGenerate = async (format = 'csv') => {
    if (!canGenerate) return;
    setLoadingGenerate(true);
    const plantCode = resolvePlantCode(selectedPlant) || 'plant';
    const isTelanganaPlant = isTelanganaPlantCode(plantCode);
    const isVedanjayMh = isOseplPlantCode(plantCode) || isCmePlantCode(plantCode);
    const sourceFileName = getFileNameFromKey(selectedSourceKey).replace(/\.csv$/i, '');
    const filename = `${plantCode}_${selectedDate}_${sourceFileName || 'source'}_sldc_template.csv`;
    try {
      const previewMatchesSource =
        previewResult &&
        String(previewResult?.source_file_key || '') === String(selectedSourceKey || '');
      const localPreview = previewMatchesSource ? previewResult : await buildClientSldcPreview({
        selectedSourceKey,
        selectedPlantId,
        selectedPlant,
        selectedDate,
        sourceFiles,
      });
      const localBlob = buildCsvBlobFromPreview(localPreview);
      const localCsvText = localPreview?.download_csv_text || '';

      const result = await templateTransformApi.generate({
        plant_id: Number(selectedPlantId),
        date: selectedDate,
        source_file_key: selectedSourceKey,
        requested_by: 'admin',
      });
      setGenerateResult(result);
      persistGeneratedTemplate({
        sourceFileKey: selectedSourceKey,
        templateFileName: filename,
        csvText: localCsvText,
        plantId: Number(selectedPlantId),
        plantName: selectedPlant?.name || '',
      });
      appendLocalHistory({
        id: String(result?.run_id || `local-generate-${Date.now()}`),
        created_at: new Date().toISOString(),
        plant_id: Number(selectedPlantId),
        template_id: result?.template_id || previewResult?.template_id || 'client_fallback_sldc_v1',
        template_version: result?.template_version || previewResult?.template_version || '1.0.0',
        status: 'GENERATED',
        source_file_key: selectedSourceKey,
        output_file_key: result?.output_file_key || filename,
        metadata: previewResult?.sldc_metadata || null,
      });
      toast.success('SLDC template generated successfully.');
      // Always download client-built SLDC CSV so Availability/Revision match dashboard rule.
      await downloadCsvOrXlsxFromText(localCsvText, filename, format, 'SLDC Template', {
        useTelanganaStyling: isTelanganaPlant && format === 'xlsx',
        useVedanjayMhStyling: isVedanjayMh && format === 'xlsx',
      });
      await loadHistory();
    } catch (error) {
      if ((error?.status === 404 || error?.status === 400) && previewResult) {
        try {
          const blob = buildCsvBlobFromPreview(previewResult);
          const runId = `local-${Date.now()}`;
          const csvText = previewResult?.download_csv_text || '';

          setLocalDownloads((prev) => ({ ...prev, [runId]: { blob, filename, csvText } }));
          persistGeneratedTemplate({
            sourceFileKey: selectedSourceKey,
            templateFileName: filename,
            csvText,
            plantId: Number(selectedPlantId),
            plantName: selectedPlant?.name || '',
          });
          setGenerateResult({
            run_id: runId,
            output_file_key: filename,
            status: 'GENERATED',
            template_id: previewResult?.template_id || 'client_fallback_v1',
            template_version: previewResult?.template_version || '1.0.0',
            validation: previewResult?.validation || { is_valid: true, errors: [], warnings: [] },
          });
          appendLocalHistory({
            id: runId,
            created_at: new Date().toISOString(),
            plant_id: Number(selectedPlantId),
            template_id: previewResult?.template_id || 'client_fallback_sldc_v1',
            template_version: previewResult?.template_version || '1.0.0',
            status: 'GENERATED',
            source_file_key: selectedSourceKey,
            output_file_key: filename,
            metadata: previewResult?.sldc_metadata || null,
          });

          await downloadCsvOrXlsxFromText(csvText, filename, format, 'SLDC Template', {
            useTelanganaStyling: isTelanganaPlant && format === 'xlsx',
            useVedanjayMhStyling: isVedanjayMh && format === 'xlsx',
          });

          toast.warning('Generated and downloaded using client-side fallback.');
          return;
        } catch (fallbackError) {
          toast.error(`Generate fallback failed: ${fallbackError.message || 'Unknown error'}`);
          return;
        }
      }

      const detail = error?.data?.detail;
      const message = typeof detail === 'string' ? detail : (detail?.message || error.message || 'Generation failed');
      toast.error(message);
    } finally {
      setLoadingGenerate(false);
    }
  };

  const handleDownloadRun = async (runId, format = 'csv') => {
    if (!runId) return;
    setDownloadingRunId(runId);
    try {
      const isTelanganaSelection = isTelanganaPlantCode(resolvePlantCode(selectedPlant));
      const isVedanjayMhSelection = isOseplPlantCode(resolvePlantCode(selectedPlant)) || isCmePlantCode(resolvePlantCode(selectedPlant));
      if (localDownloads[runId]) {
        const { blob, filename, csvText } = localDownloads[runId];
        if (csvText && format !== 'csv') {
          await downloadCsvOrXlsxFromText(
            csvText,
            filename || `template_transform_run_${runId}.csv`,
            format,
            'SLDC Template',
            {
              useTelanganaStyling: isTelanganaSelection && format === 'xlsx',
              useVedanjayMhStyling: isVedanjayMhSelection && format === 'xlsx',
            }
          );
        } else if (csvText && format === 'csv') {
          await downloadCsvOrXlsxFromText(
            csvText,
            filename || `template_transform_run_${runId}.csv`,
            'csv',
            'SLDC Template'
          );
        } else if (blob) {
          await downloadFromBlobWithFormat(
            blob,
            filename || `template_transform_run_${runId}.csv`,
            format,
            'SLDC Template',
            {
              useTelanganaStyling: isTelanganaSelection && format === 'xlsx',
              useVedanjayMhStyling: isVedanjayMhSelection && format === 'xlsx',
            }
          );
        }
        return;
      }

      // Fallback for local run ids when in-memory blob map is not available
      if (String(runId).startsWith('local-') && previewResult) {
        const blob = buildCsvBlobFromPreview(previewResult);
        const plantCode = resolvePlantCode(selectedPlant) || 'plant';
        const filename = `${plantCode}_${selectedDate}_template.csv`;
        await downloadFromBlobWithFormat(blob, filename, format, 'SLDC Template', {
          useTelanganaStyling: isTelanganaSelection && format === 'xlsx',
          useVedanjayMhStyling: isVedanjayMhSelection && format === 'xlsx',
        });
        return;
      }

      const result = await templateTransformApi.downloadGenerated(runId);
      if (result.mode === 'url' && result.url) {
        const response = await fetch(result.url);
        if (!response.ok) throw new Error(`Failed to download file (${response.status})`);
        const blob = await response.blob();
        const filename = result.filename || `template_transform_run_${runId}.csv`;
        await downloadFromBlobWithFormat(blob, filename, format, 'SLDC Template', {
          useTelanganaStyling: isTelanganaSelection && format === 'xlsx',
          useVedanjayMhStyling: isVedanjayMhSelection && format === 'xlsx',
        });
        return;
      }

      if (result.mode === 'blob' && result.blob) {
        const filename = result.filename || `template_transform_run_${runId}.csv`;
        await downloadFromBlobWithFormat(result.blob, filename, format, 'SLDC Template', {
          useTelanganaStyling: isTelanganaSelection && format === 'xlsx',
          useVedanjayMhStyling: isVedanjayMhSelection && format === 'xlsx',
        });
        return;
      }

      toast.error('Download payload is invalid.');
    } catch (error) {
      toast.error(`Download failed: ${error.message || 'Unknown error'}`);
    } finally {
      setDownloadingRunId(null);
    }
  };

  useEffect(() => {
    loadPlants();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (hasAppliedReadinessContext || plants.length === 0) return;

    const effectiveContext = getEffectiveReadinessContext();
    if (!effectiveContext) return;

    const normalizeName = (value) =>
      String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
    const normalizeCode = (value) => {
      const text = String(value || '').trim().toUpperCase();
      if (!text) return '';
      if (text.includes('SIRMOUR') || text.includes('SHRIMOUR') || text.includes('SHROMOUR')) return 'SIRMOUR';
      if (text.includes('GSNP') || text.includes('GLOBUS')) return 'GSNP';
      if (text.includes('BHUPALPALLY')) return 'BHUPALPALLY';
      if (text.includes('KASIPET')) return 'KASIPET';
      if (text.includes('KILAJ')) return 'KILAJ';
      if (text.includes('KOTHAGUDEM')) return 'KOTHAGUDEM';
      if (text.includes('OSEPL')) return 'OSEPL';
      if (text.includes('CME')) return 'CME';
      return text;
    };

    const contextPlantId = String(effectiveContext?.plantId || '').trim();
    const contextPlantNameRaw = String(effectiveContext?.plantName || '').trim();
    const contextPlantName = normalizeName(contextPlantNameRaw);
    const contextPlantCode = normalizeCode(effectiveContext?.plantCode);
    const sourceKey = String(effectiveContext?.sourceFileKey || '').trim();
    const keyMatch = sourceKey.match(/\/vedanjay\/([^/]+)\//i);
    const contextCodeFromKey = keyMatch?.[1] ? normalizeCode(keyMatch[1]) : '';
    const normalizedNameCode = normalizeCode(contextPlantNameRaw);
    let effectiveContextCode = contextPlantCode || normalizedNameCode || contextCodeFromKey;
    if (contextCodeFromKey && contextPlantCode && contextCodeFromKey !== contextPlantCode) {
      effectiveContextCode = contextCodeFromKey;
    }

    const matchingById = plants.find((p) => String(p.id) === contextPlantId);
    const matchingByName = plants.find((p) => normalizeName(p.name) === contextPlantName);
    const matchingByCode = effectiveContextCode
      ? plants.find((p) => String(resolvePlantCode(p) || '').trim().toUpperCase() === effectiveContextCode)
      : null;

    let matchedPlant = null;
    if (effectiveContext?.fromReadiness) {
      if (matchingByCode) {
        matchedPlant = matchingByCode;
      } else if (matchingByName) {
        matchedPlant = matchingByName;
      } else if (matchingById) {
        const idCode = normalizeCode(resolvePlantCode(matchingById) || matchingById?.name);
        if (!effectiveContextCode || idCode === effectiveContextCode) {
          matchedPlant = matchingById;
        }
      }
    } else {
      matchedPlant = matchingById || matchingByName || matchingByCode;
    }

    if (matchedPlant) {
      setSelectedPlantId(String(matchedPlant.id));
    }
    if (effectiveContext?.scheduleDate) {
      setSelectedDate(String(effectiveContext.scheduleDate));
    }
    if (effectiveContext?.sourceFileKey) {
      setPreferredSourceKey(String(effectiveContext.sourceFileKey));
    }
    if (effectiveContext?.autoPreview) {
      setAutoPreviewRequested(true);
    }

    if (effectiveContext?.fromReadiness) {
      toast.info('File received from Schedule Readiness. Review and convert to SLDC template.');
    }
    setHasAppliedReadinessContext(true);
  }, [hasAppliedReadinessContext, plants, readinessContextSourceKey]);

  useEffect(() => {
    if (selectedDate && selectedPlantId) loadSourceFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate, selectedPlantId, preferredSourceKey]);

  useEffect(() => {
    setPreviewResult(null);
    setGenerateResult(null);
    const rows = selectedPlantCode ? (sourceFilesByPlantCode[selectedPlantCode] || []) : [];
    setSourceFiles(rows);
    setSelectedSourceKey((prev) => {
      const preferred =
        (preferredSourceKey && rows.some((r) => r.key === preferredSourceKey))
          ? preferredSourceKey
          : '';
      if (preferred) return preferred;
      return rows.some((r) => r.key === prev) ? prev : rows[0]?.key || '';
    });
  }, [selectedPlantCode, sourceFilesByPlantCode, preferredSourceKey]);

  useEffect(() => {
    setPreviewResult(null);
    setGenerateResult(null);
  }, [selectedSourceKey]);

  useEffect(() => {
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPlantId, selectedDate, statusFilter]);

  useEffect(() => {
    if (!autoPreviewRequested) return;
    if (loadingFiles || loadingPreview) return;
    if (!selectedPlantId || !selectedDate || !selectedSourceKey) return;

    setAutoPreviewRequested(false);
    onPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPreviewRequested, loadingFiles, loadingPreview, selectedPlantId, selectedDate, selectedSourceKey]);

  const previewRows = previewResult?.transformed_preview || [];
  const previewColumns = previewResult?.target_columns || [];
  const visiblePreviewWarnings = useMemo(
    () => (previewResult?.validation?.warnings || []).filter(
      (warn) => !String(warn || '').toLowerCase().includes('auto-filled')
    ),
    [previewResult]
  );
  const combinedHistoryRows = useMemo(() => {
    const allRows = [...localHistoryRows, ...historyRows];
    const filtered = statusFilter ? allRows.filter((r) => r?.status === statusFilter) : allRows;
    return filtered.sort((a, b) => {
      const at = Date.parse(a?.created_at || '');
      const bt = Date.parse(b?.created_at || '');
      return (Number.isNaN(bt) ? 0 : bt) - (Number.isNaN(at) ? 0 : at);
    });
  }, [localHistoryRows, historyRows, statusFilter]);

  const plantNameById = useMemo(() => {
    const map = new Map();
    plants.forEach((p) => map.set(String(p.id), p.name));
    return map;
  }, [plants]);

  return (
    <>
    <div className="flex-1 overflow-auto bg-background relative overflow-x-hidden">
      <div className="max-w-[1600px] mx-auto p-4 sm:p-6 space-y-6 w-full">
        <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/25">
              <FileText className="w-6 h-6 sm:w-7 sm:h-7 text-white" />
            </div>
            <h1 className="text-xl sm:text-2xl font-bold text-foreground">Schedule Templates (Plant-Specific SLDC Conversion)</h1>
          </div>
          <p className="text-xs sm:text-sm text-muted-foreground mt-2">
            Each site can have its own SLDC template. Pick plant + date, fetch latest S3 schedule, preview conversion, then generate and download.
          </p>
        </div>

        {isFromReadiness && (
          <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-4 text-sm text-amber-200">
            Opened from Schedule Readiness pending flow.
            {readinessContextSourceKey ? ` Selected file: ${readinessContextSourceKey}` : ''}
          </div>
        )}

        <div className="rounded-xl border border-border bg-card p-4 sm:p-5 space-y-4">
          <div className="flex items-center gap-2 text-foreground font-semibold">
            <FileSearch className="w-4 h-4" />
            Conversion Inputs
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Plant Site</label>
              <div className="relative">
                <Building2 className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground" />
                <select
                  value={selectedPlantId}
                  onChange={(e) => setSelectedPlantId(e.target.value)}
                  className="w-full pl-8 pr-3 py-2 rounded-md border border-border bg-input-background text-foreground"
                  disabled={loadingPlants}
                >
                  <option value="">{loadingPlants ? 'Loading plants...' : 'Select plant'}</option>
                  {plants.map((plant) => (
                    <option key={plant.id} value={plant.id}>
                      {plant.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Schedule Date</label>
              <div className="relative">
                <CalendarDays className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground" />
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  className="w-full pl-8 pr-3 py-2 rounded-md border border-border bg-input-background text-foreground"
                />
              </div>
            </div>

            <div className="md:col-span-2">
              <label className="text-xs text-muted-foreground mb-1 block">Latest S3 Schedule File</label>
              <div className="relative">
                <FileSpreadsheet className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground" />
                <select
                  value={selectedSourceKey}
                  onChange={(e) => setSelectedSourceKey(e.target.value)}
                  className="w-full pl-8 pr-3 py-2 rounded-md border border-border bg-input-background text-foreground"
                  disabled={loadingFiles}
                >
                  <option value="">{loadingFiles ? 'Loading source files...' : 'Select source file'}</option>
                  {sourceFiles.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.key}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2">
            <button
              onClick={loadSourceFiles}
              disabled={loadingFiles}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2 rounded-md border border-border hover:bg-accent disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${loadingFiles ? 'animate-spin' : ''}`} />
              Refresh Latest S3
            </button>
            <button
              onClick={onPreview}
              disabled={!canPreview}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground disabled:opacity-50"
            >
              <Wand2 className={`w-4 h-4 ${loadingPreview ? 'animate-spin' : ''}`} />
              Convert to SLDC (Preview)
            </button>
            <button
              onClick={() => {
                setPendingDownloadAction(() => (format) => onGenerate(format));
                setDownloadFormat('csv');
                setShowDownloadModal(true);
              }}
              disabled={!canGenerate}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2 rounded-md bg-success text-white disabled:opacity-50"
            >
              <Download className={`w-4 h-4 ${loadingGenerate ? 'animate-spin' : ''}`} />
              Generate and Download
            </button>
          </div>

          {selectedPlant && (
            <p className="text-xs text-muted-foreground">
              Plant: {selectedPlant.name} | Type: {selectedPlant.type} | State: {selectedPlant.state}
            </p>
          )}
        </div>

        {previewResult && (
          <div className="rounded-xl border border-border bg-card p-4 sm:p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div className="font-semibold text-foreground">Converted Template Preview</div>
              <div className="text-xs text-muted-foreground">
                Template: {previewResult.template_id} v{previewResult.template_version}
              </div>
            </div>

            <div className="flex flex-wrap gap-3 sm:gap-4 text-xs sm:text-sm">
              <div className="inline-flex items-center gap-2">
                {previewResult.validation?.is_valid ? (
                  <CheckCircle className="w-4 h-4 text-success" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-destructive" />
                )}
                <span className="text-foreground">
                  Validation: {previewResult.validation?.is_valid ? 'PASS' : 'FAIL'}
                </span>
              </div>
              <div className="text-muted-foreground">Rows: {previewResult.canonical_row_count}</div>
              <div className="text-muted-foreground truncate max-w-[220px] sm:max-w-[700px]">Source: {previewResult.source_file_key}</div>
            </div>
            {!HIDE_METADATA && previewResult?.sldc_metadata && (
              <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                <p>
                  TYPE: {previewResult.sldc_metadata.type} | DATE: {previewResult.sldc_metadata.date} | REVISION: {previewResult.sldc_metadata.revision} | REASON: {previewResult.sldc_metadata.reason}
                </p>
                <p className="mt-1">
                  Plant Header: {previewResult.sldc_metadata.plant_header} | Availability: {previewResult.sldc_metadata.capacity_mw} MW
                </p>
              </div>
            )}

            {previewResult.validation?.errors?.length > 0 && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3">
                <p className="font-medium text-destructive mb-1">Validation Errors</p>
                {previewResult.validation.errors.map((err, idx) => (
                  <p key={`${err}-${idx}`} className="text-xs text-destructive">{err}</p>
                ))}
              </div>
            )}

            {visiblePreviewWarnings.length > 0 && (
              <div className="rounded-md border border-warning/30 bg-warning/10 p-3">
                <p className="font-medium text-warning mb-1">Validation Warnings</p>
                {visiblePreviewWarnings.map((warn, idx) => (
                  <p key={`${warn}-${idx}`} className="text-xs text-warning">{warn}</p>
                ))}
              </div>
            )}

            <div className="overflow-auto border border-border rounded-md">
              <table className="w-full text-xs">
                <thead className="bg-muted/40">
                  <tr>
                    {previewColumns.map((c) => (
                      <th key={c} className="text-left px-3 py-2 font-semibold text-black dark:text-foreground">{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row, rowIndex) => (
                    <tr key={`preview-row-${rowIndex}`} className="border-t border-border">
                      {previewColumns.map((c) => (
                        <td key={`${rowIndex}-${c}`} className="px-3 py-2 text-muted-foreground">
                          {String(row?.[c] ?? '')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="rounded-xl border border-border bg-card p-4 sm:p-5 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div className="inline-flex items-center gap-2 font-semibold text-foreground">
              <History className="w-4 h-4" />
              Conversion History
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="w-full sm:w-auto px-2 py-1 text-sm rounded border border-border bg-input-background"
              >
                <option value="">All Status</option>
                <option value="PREVIEW_VALID">PREVIEW_VALID</option>
                <option value="PREVIEW_FAILED">PREVIEW_FAILED</option>
                <option value="GENERATED">GENERATED</option>
              </select>
              <button
                onClick={loadHistory}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-1 px-3 py-1 rounded border border-border text-sm hover:bg-accent"
              >
                <RefreshCw className={`w-3 h-3 ${loadingHistory ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            </div>
          </div>

          <div className="overflow-auto border border-border rounded-md">
            <table className="w-full text-xs">
              <thead className="bg-muted/40">
                <tr>
                  <th className="text-left px-3 py-2 text-black dark:text-foreground">Time</th>
                  <th className="text-left px-3 py-2 text-black dark:text-foreground">Plant</th>
                  <th className="text-left px-3 py-2 text-black dark:text-foreground">Template</th>
                  <th className="text-left px-3 py-2 text-black dark:text-foreground">Status</th>
                  {!HIDE_METADATA && <th className="text-left px-3 py-2 text-black dark:text-foreground">Metadata</th>}
                  <th className="text-left px-3 py-2 text-black dark:text-foreground">Source</th>
                  <th className="text-left px-3 py-2 text-black dark:text-foreground">Output</th>
                </tr>
              </thead>
              <tbody>
                {combinedHistoryRows.length === 0 ? (
                  <tr>
                    <td className="px-3 py-3 text-muted-foreground" colSpan={HIDE_METADATA ? 6 : 7}>
                      {loadingHistory ? 'Loading history...' : 'No history rows'}
                    </td>
                  </tr>
                ) : (
                  combinedHistoryRows.map((row) => (
                    <tr key={row.id} className="border-t border-border">
                      <td className="px-3 py-2 text-muted-foreground">{formatDisplayDateTime(row.created_at)}</td>
                      <td className="px-3 py-2 text-foreground">{plantNameById.get(String(row.plant_id)) || row.plant_id}</td>
                      <td className="px-3 py-2 text-foreground">{row.template_id} v{row.template_version}</td>
                      <td className="px-3 py-2 text-foreground">{row.status}</td>
                      {!HIDE_METADATA && (
                        <td className="px-3 py-2 text-muted-foreground">
                          {row?.metadata ? (
                            <span>
                              TYPE:{row.metadata.type} | DATE:{row.metadata.date} | REV:{row.metadata.revision} | REASON:{row.metadata.reason}
                            </span>
                          ) : (
                            '-'
                          )}
                        </td>
                      )}
                      <td className="px-3 py-2 text-muted-foreground truncate max-w-[180px] sm:max-w-[320px]">{row.source_file_key}</td>
                      <td className="px-3 py-2">
                        {row.status === 'GENERATED' ? (
                          <button
                            onClick={() => {
                              setPendingDownloadAction(() => (format) => handleDownloadRun(row.run_id || row.id, format));
                              setDownloadFormat('csv');
                              setShowDownloadModal(true);
                            }}
                            disabled={downloadingRunId === (row.run_id || row.id)}
                            className="text-primary hover:underline disabled:opacity-50"
                          >
                            {downloadingRunId === (row.run_id || row.id) ? 'Downloading...' : 'Download'}
                          </button>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
    <DownloadFormatModal
      open={showDownloadModal}
      onClose={() => { setShowDownloadModal(false); setPendingDownloadAction(null); }}
      format={downloadFormat}
      onFormatChange={setDownloadFormat}
      onDownload={() => {
        if (pendingDownloadAction) {
          pendingDownloadAction(downloadFormat);
        }
        setShowDownloadModal(false);
        setPendingDownloadAction(null);
      }}
    />
    </>
  );
}

export default ScheduleTemplates;
