import { useEffect, useMemo, useRef, useState } from 'react';
import { Filter, ChevronDown, Upload, X, FileText, Download, BarChart3, Table, CheckCircle, Clock, Maximize2, Minimize2, ArrowLeftRight } from 'lucide-react';
import createPlotlyComponent from 'react-plotly.js/factory';
import Plotly from 'plotly.js-dist-min';
import { toast } from 'sonner';
import { useTheme } from '@/app/App';
import { api } from '@/services/api';
import { useApi } from '@/hooks/useApi';
import { S3_BASE_URL, HIDE_METADATA } from '@/config/appConfig';
import { DSM_PENALTY_CONFIG_BY_STATE, DEFAULT_DSM_PENALTY_CONFIG } from '@/config/dsmPenaltyConfig';
import DownloadFormatModal from '@/app/components/common/DownloadFormatModal';
import { buildCsvText, downloadCsvText, downloadXlsxFromRows } from '@/app/components/common/downloadUtils';

const Plot = createPlotlyComponent(Plotly);

const RAW_BASE_PREFIXES = {
  BHUPALPALLY: 'raw/vedanjay/BHUPALPALLY/',
  CME: 'raw/vedanjay/CME/',
  GSNP: 'raw/vedanjay/GSNP/',
  KASIPET: 'raw/vedanjay/KASIPET/',
  KILAJ: 'raw/vedanjay/KILAJ/',
  KOTHAGUDEM: 'raw/vedanjay/KOTHAGUDEM/',
  OSEPL: 'raw/vedanjay/OSEPL/',
  SIRMOUR: 'raw/vedanjay/SIRMOUR/',
};
const LEGACY_RAW_BASE_PREFIXES = {
  GSNP: 'raw/GSNP/gsnp/',
  SIRMOUR: 'raw/Sirmour/sirmour/',
};
const LEGACY_GENERATED_OUTPUTS_BASE_PREFIXES = {
  GSNP: 'generated/GSNP/gsnp/outputs/',
  SIRMOUR: 'generated/Sirmour/sirmour/outputs/',
};
const GENERATED_OUTPUTS_BASE_PREFIXES = {
  BHUPALPALLY: 'generated/vedanjay/BHUPALPALLY/outputs/',
  CME: 'generated/vedanjay/CME/outputs/',
  GSNP: 'generated/vedanjay/GSNP/outputs/',
  KASIPET: 'generated/vedanjay/KASIPET/outputs/',
  KILAJ: 'generated/vedanjay/KILAJ/outputs/',
  KOTHAGUDEM: 'generated/vedanjay/KOTHAGUDEM/outputs/',
  OSEPL: 'generated/vedanjay/OSEPL/outputs/',
  SIRMOUR: 'generated/vedanjay/SIRMOUR/outputs/',
};
const LEGACY_OUTPUTS_BASE_PREFIX = 'outputs/';
const PLANT_CAPACITY_FALLBACK = {
  BHUPALPALLY: 10,
  CME: 4,
  GSNP: 20,
  KASIPET: 15,
  KILAJ: 20,
  KOTHAGUDEM: 37,
  OSEPL: 20,
  SIRMOUR: 5.1,
};

const SITE_OPTIONS = [
  { code: 'BHUPALPALLY', name: 'BHUPALPALLY', intradayPrefix: '', capacityMw: PLANT_CAPACITY_FALLBACK.BHUPALPALLY },
  { code: 'CME', name: 'CME', intradayPrefix: '', capacityMw: PLANT_CAPACITY_FALLBACK.CME },
  { code: 'GSNP', name: 'Globus Steel N Power (GSNP)', intradayPrefix: 'gsnp_dc_reg_', capacityMw: PLANT_CAPACITY_FALLBACK.GSNP },
  { code: 'KASIPET', name: 'KASIPET', intradayPrefix: '', capacityMw: PLANT_CAPACITY_FALLBACK.KASIPET },
  { code: 'KILAJ', name: 'KILAJ', intradayPrefix: '', capacityMw: PLANT_CAPACITY_FALLBACK.KILAJ },
  { code: 'KOTHAGUDEM', name: 'KOTHAGUDEM', intradayPrefix: '', capacityMw: PLANT_CAPACITY_FALLBACK.KOTHAGUDEM },
  { code: 'OSEPL', name: 'OSEPL', intradayPrefix: '', capacityMw: PLANT_CAPACITY_FALLBACK.OSEPL },
  { code: 'SIRMOUR', name: 'SIRMOUR', intradayPrefix: 'vedanjay_sirmour_pv_intra', capacityMw: PLANT_CAPACITY_FALLBACK.SIRMOUR },
];
const TOTAL_BLOCKS = 96;
const DSM_ALLOWED_BAND_PERCENT = 10;
const DSM_BLOCK_DURATION_HOURS = 0.25;
const KWH_PER_MWH = 1000;
const EPSILON = 1e-6;

const PLANT_STATE_FALLBACK = {
  BHUPALPALLY: 'Telangana',
  CME: 'Maharashtra',
  KASIPET: 'Telangana',
  KILAJ: 'Maharashtra',
  KOTHAGUDEM: 'Telangana',
  OSEPL: 'Maharashtra',
  GSNP: 'Madhya Pradesh',
  SIRMOUR: 'Madhya Pradesh',
};

const PLANT_TYPE_FALLBACK = {
  BHUPALPALLY: 'Solar',
  CME: 'Solar',
  KASIPET: 'Solar',
  KILAJ: 'Solar',
  KOTHAGUDEM: 'Solar',
  OSEPL: 'Solar',
  GSNP: 'Solar',
  SIRMOUR: 'Solar',
};

function derivePlantCodeFromName(name) {
  const text = String(name || '').trim();
  if (!text) return null;
  const match = text.match(/\(([A-Za-z0-9_-]+)\)/);
  if (match) return match[1].toUpperCase();
  if (/^[A-Z0-9_-]{2,6}$/.test(text)) return text.toUpperCase();
  const compact = text.replace(/[^A-Za-z0-9]/g, '');
  return compact ? compact.toUpperCase() : null;
}

function isMeterAvailable(plant) {
  const code = String(plant?.code || derivePlantCodeFromName(plant?.name) || '').trim().toUpperCase();
  return code !== 'CME' && code !== 'KILAJ';
}

function derivePlantFolders(name) {
  const text = String(name || '').trim();
  if (!text) return null;
  let folder = text;
  if (/^[A-Z0-9_-]+$/.test(folder) && folder.length > 4) {
    const lower = folder.toLowerCase();
    folder = lower.charAt(0).toUpperCase() + lower.slice(1);
  }
  const lowerFolder = folder.toLowerCase().replace(/\s+/g, '');
  const upperFolder = folder.toUpperCase().replace(/\s+/g, '');
  return { folder, lower: lowerFolder, upper: upperFolder };
}

function buildSiteOptionsFromApi(plants) {
  if (!plants?.length) return SITE_OPTIONS;
  const fromApi = plants.map((plant) => ({
    code: plant.code || derivePlantCodeFromName(plant.name) || String(plant.name || '').toUpperCase().replace(/\s+/g, '_'),
    name: plant.name,
    intradayPrefix: plant.intradayPrefix || '',
    capacityMw: plant.capacity || 0,
    state: plant.state,
    type: plant.type,
  }));
  const mergedKeys = new Set(fromApi.map((p) => String(p.code || p.name).toUpperCase()));
  const extras = SITE_OPTIONS.filter((p) => !mergedKeys.has(String(p.code || p.name).toUpperCase()));
  return [...fromApi, ...extras];
}
function getSchedulePrefixes(date, site) {
  const code = String(site?.code || '').toUpperCase();
  const rawPrefix = RAW_BASE_PREFIXES[code];
  const legacyRawPrefix = LEGACY_RAW_BASE_PREFIXES[code];
  const generatedPrefix = GENERATED_OUTPUTS_BASE_PREFIXES[code];
  const derived = derivePlantFolders(site?.name);
  const prefixes = [];
  if (rawPrefix) prefixes.push(`${rawPrefix}${date}/`);
  if (legacyRawPrefix) prefixes.push(`${legacyRawPrefix}${date}/`);
  if (generatedPrefix) prefixes.push(`${generatedPrefix}${date}/`);
  if (LEGACY_GENERATED_OUTPUTS_BASE_PREFIXES[code]) {
    prefixes.push(`${LEGACY_GENERATED_OUTPUTS_BASE_PREFIXES[code]}${date}/`);
  }
  if (derived) {
    prefixes.push(`raw/vedanjay/${derived.upper}/${date}/`);
    prefixes.push(`generated/vedanjay/${derived.upper}/outputs/${date}/`);
    prefixes.push(`generated/${derived.folder}/${derived.lower}/outputs/${date}/`);
    prefixes.push(`raw/${derived.folder}/${derived.lower}/${date}/`);
  }
  prefixes.push(`${LEGACY_OUTPUTS_BASE_PREFIX}${date}/`);
  return Array.from(new Set(prefixes));
}

function getIntradayPrefixes(date, site) {
  const code = String(site?.code || '').toUpperCase();
  const rawPrefix = RAW_BASE_PREFIXES[code];
  const legacyRawPrefix = LEGACY_RAW_BASE_PREFIXES[code];
  const generatedPrefix = GENERATED_OUTPUTS_BASE_PREFIXES[code];
  const derived = derivePlantFolders(site?.name);
  const prefixes = [];
  if (rawPrefix) prefixes.push(`${rawPrefix}${date}/enercast_data/intraday/`);
  if (legacyRawPrefix) prefixes.push(`${legacyRawPrefix}${date}/enercast_data/intraday/`);
  if (generatedPrefix) prefixes.push(`${generatedPrefix}${date}/intraday/`);
  if (LEGACY_GENERATED_OUTPUTS_BASE_PREFIXES[code]) {
    prefixes.push(`${LEGACY_GENERATED_OUTPUTS_BASE_PREFIXES[code]}${date}/intraday/`);
  }
  if (derived) {
    prefixes.push(`raw/vedanjay/${derived.upper}/${date}/enercast_data/intraday/`);
    prefixes.push(`generated/vedanjay/${derived.upper}/outputs/${date}/intraday/`);
    prefixes.push(`generated/${derived.folder}/${derived.lower}/outputs/${date}/intraday/`);
    prefixes.push(`raw/${derived.folder}/${derived.lower}/${date}/enercast_data/intraday/`);
  }
  prefixes.push(`${LEGACY_OUTPUTS_BASE_PREFIX}${date}/intraday/`, `${date}/intraday/`);
  return Array.from(new Set(prefixes));
}

function normalizeStateName(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  return text
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function getPenaltyConfig(plantState, plantType) {
  const config = DSM_PENALTY_CONFIG_BY_STATE[normalizeStateName(plantState)] || DEFAULT_DSM_PENALTY_CONFIG;
  return config.byType?.[plantType] || config.byType?.Solar || { bands: [] };
}

function getAllowedLimitPercent(plantState, plantType) {
  const config = DSM_PENALTY_CONFIG_BY_STATE[normalizeStateName(plantState)] || DEFAULT_DSM_PENALTY_CONFIG;
  const typeConfig = config.byType?.[plantType] || config.byType?.Solar;
  return typeConfig?.baseBand ?? DSM_ALLOWED_BAND_PERCENT;
}

function calculatePenaltyRs({ scheduledMw, actualMw, capacityMw, plantState, plantType }) {
  if (!Number.isFinite(scheduledMw) || !Number.isFinite(actualMw)) return null;
  const capacity = Math.max(Math.abs(Number(capacityMw) || 0), EPSILON);
  const deviation = actualMw - scheduledMw;
  const percentage = (deviation / capacity) * 100;
  const absDeviationPercent = Math.abs(percentage);
  if (!Number.isFinite(absDeviationPercent) || absDeviationPercent <= 0) return 0;

  const bandPercent = getAllowedLimitPercent(plantState, plantType);
  const allowedMw = (capacity * bandPercent) / 100;
  const lowerLimitMw = scheduledMw - allowedMw;
  const upperLimitMw = scheduledMw + allowedMw;
  const underGenerationMw = actualMw < lowerLimitMw ? (lowerLimitMw - actualMw) : 0;
  const overGenerationMw = actualMw > upperLimitMw ? (actualMw - upperLimitMw) : 0;
  const excessDeviationMw = Math.max(underGenerationMw, overGenerationMw, 0);
  if (excessDeviationMw <= EPSILON) return 0;

  const deviationEnergyKwh = Math.abs(deviation) * DSM_BLOCK_DURATION_HOURS * KWH_PER_MWH;
  const penaltyBands = getPenaltyConfig(plantState, plantType).bands || [];
  return penaltyBands.reduce((sum, band) => {
    const bandSpan = Math.min(absDeviationPercent, band.max) - band.min;
    if (bandSpan <= 0) return sum;
    const bandEnergyKwh = deviationEnergyKwh * (bandSpan / absDeviationPercent);
    return sum + (bandEnergyKwh * band.rate);
  }, 0);
}

function getMeterPrefixes(date, site) {
  const code = String(site?.code || '').toUpperCase();
  const rawPrefix = RAW_BASE_PREFIXES[code];
  const legacyRawPrefix = LEGACY_RAW_BASE_PREFIXES[code];
  const generatedPrefix = GENERATED_OUTPUTS_BASE_PREFIXES[code];
  const derived = derivePlantFolders(site?.name);
  const prefixes = [];
  if (rawPrefix) prefixes.push(`${rawPrefix}${date}/metered_data/`);
  if (legacyRawPrefix) prefixes.push(`${legacyRawPrefix}${date}/metered_data/`);
  if (generatedPrefix) prefixes.push(`${generatedPrefix}${date}/meter/`);
  if (LEGACY_GENERATED_OUTPUTS_BASE_PREFIXES[code]) {
    prefixes.push(`${LEGACY_GENERATED_OUTPUTS_BASE_PREFIXES[code]}${date}/meter/`);
  }
  if (derived) {
    prefixes.push(`raw/vedanjay/${derived.upper}/${date}/metered_data/`);
    prefixes.push(`generated/vedanjay/${derived.upper}/outputs/${date}/meter/`);
    prefixes.push(`generated/${derived.folder}/${derived.lower}/outputs/${date}/meter/`);
    prefixes.push(`raw/${derived.folder}/${derived.lower}/${date}/metered_data/`);
  }
  prefixes.push(`${LEGACY_OUTPUTS_BASE_PREFIX}${date}/meter/`, `${date}/meter/`);
  return Array.from(new Set(prefixes));
}

function isScheduleCsvKey(key) {
  const k = String(key || '').toLowerCase();
  return (
    k.endsWith('.csv') &&
    !k.includes('/intraday/') &&
    k.includes('schedule_from_')
  );
}

function getScheduleCandidatePriority(key = '') {
  const normalized = String(key).toLowerCase();
  if (normalized.includes('/raw/')) return 0;
  if (normalized.includes('/generated/')) return 1;
  if (normalized.startsWith('outputs/')) return 2;
  return 3;
}

function extractScheduleRevision(key = '') {
  const fileName = String(key || '').split('/').pop() || '';
  const match = fileName.match(/schedule_from_(\d+)\.csv$/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function isPlantScopedScheduleKey(key, siteCode, siteName = '') {
  const lower = String(key || '').toLowerCase();
  const code = String(siteCode || '').toUpperCase();
  if (!code) return false;

  const normalizeToken = (value) =>
    String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  const derived = derivePlantFolders(siteName);
  const tokens = [
    code.toLowerCase(),
    derived?.lower,
    derived?.folder,
  ].filter(Boolean);
  const normalizedTokens = Array.from(new Set(tokens.map(normalizeToken).filter(Boolean)));

  const pathSegments = lower.split('/').filter(Boolean);
  const normalizedSegments = pathSegments.map(normalizeToken);
  const fileName = lower.split('/').pop() || '';
  const normalizedFile = normalizeToken(fileName);

  const tokenMatch = normalizedTokens.length === 0
    ? false
    : normalizedTokens.some((token) =>
        normalizedSegments.includes(token) || normalizedFile.includes(token)
      );

  if (tokenMatch) return true;

  if (lower.startsWith(`generated/vedanjay/${code.toLowerCase()}/outputs/`)) return true;
  if (code === 'SIRMOUR') {
    return (
      lower.startsWith('raw/sirmour/sirmour/') ||
      lower.startsWith('generated/sirmour/sirmour/outputs/')
    );
  }
  if (code === 'GSNP') {
    return (
      lower.startsWith('raw/gsnp/gsnp/') ||
      lower.startsWith('generated/gsnp/gsnp/outputs/')
    );
  }

  if (!derived) return false;
  return (
    lower.startsWith(`raw/vedanjay/${derived.upper.toLowerCase()}/`) ||
    lower.startsWith(`raw/${derived.folder.toLowerCase()}/${derived.lower}/`) ||
    lower.startsWith(`generated/vedanjay/${derived.upper.toLowerCase()}/outputs/`) ||
    lower.startsWith(`generated/${derived.folder.toLowerCase()}/${derived.lower}/outputs/`)
  );
}

function parseS3ListXml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  return Array.from(doc.getElementsByTagName('Contents'))
    .map((node) => ({
      key: node.getElementsByTagName('Key')[0]?.textContent || '',
      lastModified: node.getElementsByTagName('LastModified')[0]?.textContent || '',
    }))
    .filter((item) => item.key);
}

async function listS3Objects(prefix) {
  const url = `${S3_BASE_URL}/?list-type=2&prefix=${encodeURIComponent(prefix)}`;
  const xml = await fetch(url).then((r) => r.text());
  return parseS3ListXml(xml);
}

async function listS3ObjectsAcrossPrefixes(prefixes) {
  const settled = await Promise.allSettled(prefixes.map((prefix) => listS3Objects(prefix)));
  return settled
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value || []);
}

async function fetchTextFromS3(key) {
  const encodedKey = String(key || '').split('/').map((s) => encodeURIComponent(s)).join('/');
  const response = await fetch(`${S3_BASE_URL}/${encodedKey}`);
  if (!response.ok) {
    const error = new Error(`S3 fetch failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.text();
}

function toHeaderKey(v) {
  return String(v || '').toLowerCase().replace(/["']/g, '').replace(/[^a-z0-9]+/g, '');
}

function parseCsvWithHeaderDetection(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return { headers: [], rows: [] };
  const delimiterCandidates = [',', ';', '\t'];

  const scoreHeaderLine = (line) => {
    const lowered = String(line || '').toLowerCase();
    if (!delimiterCandidates.some((d) => lowered.includes(d))) return -1;
    let score = 0;
    if (/\bblock\b|\bblk\b|\bs\.?\s*no\b|\bsno\b/.test(lowered)) score += 5;
    if (/\btime\b|\btimestamp\b|\bdate\b/.test(lowered)) score += 4;
    if (/forecast|intraday|day.?ahead|sch[^a-z0-9]*mw/.test(lowered)) score += 6;
    if (/mw|kw|power|generation/.test(lowered)) score += 2;
    return score;
  };

  // Pick the best-looking header row from first 25 lines.
  let start = 0;
  let best = { idx: 0, score: -1 };
  const scanLimit = Math.min(lines.length, 25);
  for (let i = 0; i < scanLimit; i += 1) {
    const score = scoreHeaderLine(lines[i]);
    if (score > best.score) {
      best = { idx: i, score };
    }
  }
  if (best.score >= 0) {
    start = best.idx;
  }

  const headerSample = lines[start] || lines[0] || '';
  const delimiter = delimiterCandidates.reduce(
    (bestDelim, candidate) => {
      const count = headerSample.split(candidate).length - 1;
      return count > bestDelim.count ? { value: candidate, count } : bestDelim;
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

  const header1 = parseLine(lines[start]).map((h) => h.trim());
  const maybeHeader2 = lines[start + 1] ? parseLine(lines[start + 1]).map((h) => h.trim()) : [];
  const useSecondHeader = maybeHeader2.some((h) => /forecast|availability/i.test(h));

  const maxCols = Math.max(header1.length, maybeHeader2.length);
  const headers = Array.from({ length: maxCols }, (_, i) => {
    const h1 = header1[i] || '';
    const h2 = useSecondHeader ? (maybeHeader2[i] || '') : '';
    if (h1 && h2) return `${h1} ${h2}`.trim();
    return h1 || h2;
  });

  const dataStart = start + (useSecondHeader ? 2 : 1);
  const rows = lines.slice(dataStart).map((line) => parseLine(line).map((v) => v.trim()));
  return { headers, rows };
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line && line.trim().length > 0);
  if (!lines.length) return { headers: [], rows: [] };
  const delimiterCandidates = [',', ';', '\t'];
  const headerLine = lines[0];
  const delimiter = delimiterCandidates.reduce((best, candidate) => {
    const count = headerLine.split(candidate).length - 1;
    return count > best.count ? { value: candidate, count } : best;
  }, { value: ',', count: -1 }).value;

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

  const headers = parseLine(lines[0]).map((h) => h.replace(/^\uFEFF/, '').trim());
  const rows = lines.slice(1).map(parseLine);
  return { headers, rows };
}

async function readUploadedTabularFile(file) {
  const fileName = String(file?.name || '').toLowerCase();
  if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
    const XLSX = await import('xlsx');
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    const firstSheetName = workbook.SheetNames?.[0];
    if (!firstSheetName) return '';
    const sheet = workbook.Sheets[firstSheetName];
    return XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
  }
  return file.text();
}

function blockToInterval(block) {
  const idx = Math.max(0, Number(block) - 1);
  const startMinutes = idx * 15;
  const endMinutes = startMinutes + 15;
  const formatTime = (mins) => {
    const normalized = ((mins % (24 * 60)) + (24 * 60)) % (24 * 60);
    const hh = Math.floor(normalized / 60);
    const mm = normalized % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };
  return `${formatTime(startMinutes)}-${formatTime(endMinutes)}`;
}

function parseBlockNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;

  const direct = Number.parseInt(text, 10);
  if (Number.isFinite(direct)) return direct;

  const bMatch = text.match(/[bB]\s*([0-9]{1,3})/);
  if (bMatch) return Number.parseInt(bMatch[1], 10);

  const anyNumber = text.match(/([0-9]{1,3})/);
  if (anyNumber) return Number.parseInt(anyNumber[1], 10);

  return null;
}

function getCurrentIstBlock() {
  const now = new Date();
  const istNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const totalMinutes = (istNow.getHours() * 60) + istNow.getMinutes();
  const block = Math.floor(totalMinutes / 15) + 1;
  return Math.min(Math.max(block, 1), TOTAL_BLOCKS);
}

function parseSeriesMap(text, mode, options = {}) {
  const { headers, rows } = parseCsvWithHeaderDetection(text);
  const normalized = headers.map(toHeaderKey);
  const blockIdx = normalized.findIndex(
    (h) => h.includes('block') || h.includes('blk') || h === 'sno' || h.includes('srno') || h.includes('serialno')
  );
  const timeIdx = normalized.findIndex((h) => h.includes('time') || h.includes('from') || h.includes('to'));
  const isMetaColumn = (h, i) =>
    i === blockIdx ||
    i === timeIdx ||
    h.includes('date') ||
    h.includes('from') ||
    h.includes('to');
  const isForecastLike = (h) =>
    (h.includes('schmw') || (h.includes('sch') && h.includes('mw'))) ||
    (h.includes('avc') && h.includes('mw')) ||
    h.includes('forecast') ||
    h.includes('forcast') ||
    h.includes('intraday') ||
    h.includes('dayahead') ||
    h.includes('pv');

  let valueIdx = -1;
  if (mode === 's3_schedule') {
    valueIdx = normalized.findIndex((h) => h.includes('algoschedule') || h.includes('scheduledmw') || h.includes('schedule'));
    if (valueIdx === -1) {
      valueIdx = normalized.findIndex((h) => h.includes('forecast'));
    }
  } else if (mode === 'intraday') {
    // Intraday files may expose Forecast as forecast, forecastmw, intradayforecast, pvforecast, etc.
    const preferredHeaders = Array.isArray(options.preferredHeaders) ? options.preferredHeaders : [];
    const preferredNormalized = preferredHeaders.map((h) => toHeaderKey(h));
    if (preferredNormalized.length) {
      valueIdx = normalized.findIndex((h) => preferredNormalized.some((p) => h.includes(p)));
    }
    // Prefer SCH_MW for latest intraday schedule.
    if (valueIdx === -1) {
    valueIdx = normalized.findIndex((h) => h.includes('schmw') || (h.includes('sch') && h.includes('mw')));
    }
    if (valueIdx === -1) {
      valueIdx = normalized.findIndex((h) => h.includes('avc') && h.includes('mw'));
    }
    if (valueIdx === -1) valueIdx = normalized.findIndex((h) => isForecastLike(h));
    if (valueIdx === -1) {
      // SIRMOUR/GSNP files may keep plant name as the forecast column.
      valueIdx = normalized.findIndex(
        (h) =>
          (h.includes('sirmour') || h.includes('gsnp') || h === 'pv' || h.includes('plant')) &&
          !h.includes('availability') &&
          !h.includes('capacity')
      );
    }
    if (valueIdx === -1) {
      valueIdx = normalized.findIndex(
        (h, i) =>
          !isMetaColumn(h, i) &&
          !h.includes('avc') &&
          (h.includes('mw') || h.includes('power') || h.includes('value'))
      );
    }
  } else {
    // Uploaded Vedanjay file must use only Forecast/Forcast column.
    valueIdx = normalized.findIndex(
      (h) =>
        (h.includes('stationschedule') || (h.includes('station') && h.includes('schedule'))) &&
        !h.includes('availability') &&
        !h.includes('capacity')
    );
    if (valueIdx === -1) {
      valueIdx = normalized.findIndex(
        (h) =>
        (h.includes('forecast') || h.includes('forcast')) &&
        !h.includes('availability') &&
        !h.includes('capacity')
      );
    }
  }

  if (valueIdx === -1 && mode === 's3_schedule') {
    valueIdx = normalized.findIndex((h, i) => !isMetaColumn(h, i));
  }
  if (valueIdx === -1 && mode === 'intraday') {
    // Last-resort: select the numeric column with the strongest signal.
    let best = { idx: -1, score: -1 };
    for (let col = 0; col < headers.length; col += 1) {
      if (isMetaColumn(normalized[col] || '', col)) continue;
      const h = normalized[col] || '';
      if (h.includes('availability') || h.includes('capacity')) continue;
      let numericCount = 0;
      let magnitude = 0;
      rows.slice(0, Math.min(rows.length, TOTAL_BLOCKS)).forEach((r) => {
        const v = parseFloat(r[col]);
        if (Number.isFinite(v)) {
          numericCount += 1;
          magnitude += Math.abs(v);
        }
      });
      if (!numericCount) continue;
      const score = numericCount * 1000 + (magnitude / numericCount);
      if (score > best.score) {
        best = { idx: col, score };
      }
    }
    valueIdx = best.idx;
  }
  if (valueIdx === -1) return new Map();

  const valueHeader = normalized[valueIdx] || '';
  const explicitKw = valueHeader.includes('(kw)') || valueHeader.includes('kw');
  const explicitMw = valueHeader.includes('(mw)') || valueHeader.includes('mw');
  const explicitW = (valueHeader.includes('(w)') || valueHeader.endsWith('w')) && !explicitMw && !explicitKw;

  const rawPoints = [];
  rows.forEach((cols, i) => {
    const parsedBlock = blockIdx !== -1 ? parseBlockNumber(cols[blockIdx]) : null;
    const block = (Number.isFinite(parsedBlock) && parsedBlock >= 1 && parsedBlock <= TOTAL_BLOCKS)
      ? parsedBlock
      : i + 1;
    if (!Number.isFinite(block) || block < 1 || block > TOTAL_BLOCKS) return;
    const value = parseFloat(cols[valueIdx]);
    if (!Number.isFinite(value)) return;
    rawPoints.push({ block, value });
  });

  const nonZero = rawPoints
    .map((p) => Math.abs(p.value))
    .filter((v) => Number.isFinite(v) && v > 0);
  const avg = nonZero.length ? (nonZero.reduce((a, b) => a + b, 0) / nonZero.length) : 0;
  const assumeKw = explicitKw || (!explicitMw && !explicitW && avg > 200);
  const factor = explicitW ? (1 / 1_000_000) : (assumeKw ? (1 / 1000) : 1);

  const map = new Map();
  rawPoints.forEach((p) => {
    map.set(p.block, p.value * factor);
  });

  // Attach lightweight metadata for debugging intraday selection.
  map._meta = {
    valueHeader: headers[valueIdx] || valueHeader,
    valueIdx,
  };

  return map;
}

function parseScheduleSeriesMap(text) {
  const lines = String(text || '').split(/\r?\n/).filter((line) => line && line.trim().length > 0);
  if (!lines.length) return new Map();

  // Match SchedulePreparation behavior: find actual header even if metadata lines exist.
  const headerIdx = lines.findIndex((line) => {
    const l = String(line || '').toLowerCase();
    return l.includes('block') && (l.includes('schedule') || l.includes('forecast') || l.includes('timestamp'));
  });
  const csvTextFromHeader = headerIdx > 0 ? lines.slice(headerIdx).join('\n') : text;
  const { headers, rows } = parseCsv(csvTextFromHeader);
  if (!headers.length) return new Map();

  const normalized = headers.map((h) =>
    String(h || '').toLowerCase().replace(/["']/g, '').replace(/[\s_-]+/g, '')
  );
  const findCol = (matchers) => normalized.findIndex((h) => matchers.some((m) => h.includes(m)));

  const blockIdx = findCol(['block', 'blockno', 'blk']);
  const algoIdx = findCol([
    'algoschedulemw',
    'algoschedule',
    'systemschedule',
    'finalschedule',
    'scheduledmw',
    'scheduled',
    'schedule',
  ]);
  const baseIdx = findCol(['baseforecastmw', 'baseforecast', 'base']);
  const intradayIdx = findCol(['intradayforecastmw', 'intradayforecast', 'intraday']);

  // GSNP may present intraday-style schedule file; fallback to intraday parser.
  if (blockIdx === -1 || algoIdx === -1) {
    const fallback = parseSeriesMap(csvTextFromHeader, 'intraday');
    return fallback;
  }

  const map = new Map();
  rows.forEach((cols, i) => {
    const parsedBlock = parseBlockNumber(cols[blockIdx]);
    const block = (Number.isFinite(parsedBlock) && parsedBlock >= 1 && parsedBlock <= TOTAL_BLOCKS)
      ? parsedBlock
      : i + 1;
    if (!Number.isFinite(block) || block < 1 || block > TOTAL_BLOCKS) return;

    let value = parseFloat(cols[algoIdx]);
    if (!Number.isFinite(value) && baseIdx !== -1) {
      value = parseFloat(cols[baseIdx]);
    }
    if (!Number.isFinite(value) && intradayIdx !== -1) {
      value = parseFloat(cols[intradayIdx]);
    }
    if (!Number.isFinite(value)) return;
    map.set(block, value);
  });

  return map;
}

function parseMeterSeriesMap(text) {
  const { headers, rows } = parseCsvWithHeaderDetection(text);
  const normalized = headers.map((h) => String(h || '').toLowerCase());

  const blockIdx = normalized.findIndex((h) => h.includes('block') || h.includes('blk'));
  const timeIdx = normalized.findIndex((h) => h.includes('time'));
  const powerIdx = normalized.findIndex((h) =>
    h.includes('active power') || h.includes('meter power') || h.includes('generation') || h.includes('kw') || h.includes('mw')
  );
  if (powerIdx === -1) return new Map();

  const powerHeader = normalized[powerIdx] || '';
  const explicitKw = powerHeader.includes('(kw)') || powerHeader.includes(' kw');
  const explicitMw = powerHeader.includes('(mw)') || powerHeader.includes(' mw');

  const getBlockFromTimeText = (raw) => {
    if (raw === null || raw === undefined) return null;
    const textVal = String(raw).trim();
    if (!textVal) return null;
    const match = textVal.match(/(\d{1,2}):(\d{2})/);
    if (!match) return null;
    const hh = Number.parseInt(match[1], 10);
    const mm = Number.parseInt(match[2], 10);
    if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    const block = (hh * 4) + Math.floor(mm / 15) + 1;
    const shifted = block - 1;
    return shifted >= 1 && shifted <= TOTAL_BLOCKS ? shifted : null;
  };

  const parsedPoints = rows
    .map((cols, idx) => {
      const blockFromCol = blockIdx !== -1 ? parseBlockNumber(cols[blockIdx]) : null;
      const timeRaw = timeIdx !== -1 ? cols[timeIdx] : null;
      const hasTime = timeIdx !== -1 && String(timeRaw ?? '').trim() !== '';
      const blockFromTime = timeIdx !== -1 ? getBlockFromTimeText(timeRaw) : null;
      const fallbackBlock = idx + 1;
      let block = null;
      if (Number.isFinite(blockFromCol) && blockFromCol >= 1 && blockFromCol <= TOTAL_BLOCKS) {
        block = blockFromCol;
      } else if (Number.isFinite(blockFromTime)) {
        block = blockFromTime;
      } else if (!hasTime) {
        block = fallbackBlock;
      }
      const value = parseFloat(cols[powerIdx]);
      if (!Number.isFinite(block) || block < 1 || block > TOTAL_BLOCKS || !Number.isFinite(value)) return null;
      return { block, value };
    })
    .filter(Boolean);

  const parsedRaw = parsedPoints.map((p) => p.value);
  const nonZero = parsedRaw.filter((v) => v > 0);
  const avg = nonZero.length ? (nonZero.reduce((a, b) => a + b, 0) / nonZero.length) : 0;
  const assumeKw = explicitKw || (!explicitMw && avg > 200);
  const factor = assumeKw ? 1 / 1000 : 1;

  const map = new Map();
  parsedPoints.forEach((p) => {
    map.set(p.block, p.value * factor);
  });
  return map;
}

function formatUploadTime(date) {
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

function sortLatestFirst(items) {
  const extractRevisionNumber = (key) => {
    const fileName = (key || '').split('/').pop() || '';
    const schedMatch = fileName.match(/schedule_from_(\d+)\.csv$/i);
    if (schedMatch) return parseInt(schedMatch[1], 10);
    const trailingMatch = fileName.match(/_(\d+)(?=\.[^.]+$)/);
    return trailingMatch ? parseInt(trailingMatch[1], 10) : null;
  };

  return [...items].sort((a, b) => {
    const aRev = extractRevisionNumber(a.key);
    const bRev = extractRevisionNumber(b.key);
    if (aRev !== null && bRev !== null && bRev !== aRev) return bRev - aRev;

    const aTime = Date.parse(a.lastModified || '');
    const bTime = Date.parse(b.lastModified || '');
    const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
    if (timeDiff !== 0) return timeDiff;

    const aGenerated = String(a.key || '').toLowerCase().includes('/generated/');
    const bGenerated = String(b.key || '').toLowerCase().includes('/generated/');
    if (aGenerated !== bGenerated) return bGenerated ? 1 : -1;

    return (b.key || '').localeCompare(a.key || '');
  });
}

function extractIntradaySortScore(key) {
  const fileName = String(key || '').split('/').pop() || '';
  const lower = fileName.toLowerCase();

  // Preferred pattern seen in SIRMOUR files:
  // ..._YYYY-MM-DD-HH-mm+0530.csv
  const datedSlot = lower.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})(?:\+\d{4})?\.csv$/);
  if (datedSlot) {
    const [, y, m, d, hh, mm] = datedSlot;
    return Number(`${y}${m}${d}${hh}${mm}`);
  }

  // Fallback GSNP-like/other patterns: ...HH-MM+0530.csv
  const slotOnly = lower.match(/(\d{2})-(\d{2})(?:\+\d{4})?\.csv$/);
  if (slotOnly) {
    const [, hh, mm] = slotOnly;
    return Number(`${hh}${mm}`);
  }

  return null;
}

function pickLatestIntradayForDate(objects, intradayPrefix) {
  const csvs = objects.filter((o) => o.key.toLowerCase().endsWith('.csv'));
  if (!csvs.length) return null;

  const prioritized = csvs.filter((o) => {
    const fileName = o.key.split('/').pop()?.toLowerCase() || '';
    if (intradayPrefix) return fileName.startsWith(intradayPrefix);
    return fileName.includes('intra');
  });
  const candidates = prioritized.length ? prioritized : csvs;
  return [...candidates].sort((a, b) => {
    const aScore = extractIntradaySortScore(a.key);
    const bScore = extractIntradaySortScore(b.key);
    if (aScore !== null && bScore !== null && bScore !== aScore) return bScore - aScore;

    const aTime = Date.parse(a.lastModified || '');
    const bTime = Date.parse(b.lastModified || '');
    const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
    if (timeDiff !== 0) return timeDiff;

    return (b.key || '').localeCompare(a.key || '');
  })[0] || null;
}

export default function ScheduleComparison() {
  const { isDarkMode } = useTheme();
  const [selectedSite, setSelectedSite] = useState('');
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [showGraph, setShowGraph] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [downloadFormat, setDownloadFormat] = useState('csv');
  const [isLoadingScheduleFiles, setIsLoadingScheduleFiles] = useState(false);
  const [uploadTime, setUploadTime] = useState(null);
  const [fileName, setFileName] = useState('');
  const [isGraphFullscreen, setIsGraphFullscreen] = useState(false);
  const [scheduleFiles, setScheduleFiles] = useState([]);
  const [selectedScheduleKey, setSelectedScheduleKey] = useState('');
  const chartContainerRef = useRef(null);

  useEffect(() => {
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement) {
        setIsGraphFullscreen(false);
      }
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const [s3ScheduleMap, setS3ScheduleMap] = useState(null);
  const [intradayMap, setIntradayMap] = useState(null);
  const [meterMap, setMeterMap] = useState(null);
  const [uploadedMap, setUploadedMap] = useState(null);

  const [s3ScheduleMeta, setS3ScheduleMeta] = useState(null);
  const [intradayMeta, setIntradayMeta] = useState(null);
  const [meterMeta, setMeterMeta] = useState(null);

  const { data: apiPlantsData } = useApi(
    () => api.plants.getAll({ noMock: true }),
    { immediate: true, initialData: { plants: [], total: 0, stats: {} } }
  );
  const siteOptions = useMemo(
    () => buildSiteOptionsFromApi(apiPlantsData?.plants || []),
    [apiPlantsData]
  );

  const selectedSiteConfig = useMemo(
    () => siteOptions.find((site) => site.code === selectedSite) || null,
    [selectedSite, siteOptions]
  );

  useEffect(() => {
    if (selectedSite && !selectedSiteConfig) {
      setSelectedSite('');
    }
  }, [selectedSite, selectedSiteConfig]);

  useEffect(() => {
    const loadScheduleFiles = async () => {
      if (!selectedSiteConfig || !selectedDate) {
        setScheduleFiles([]);
        setSelectedScheduleKey('');
        return;
      }
      setIsLoadingScheduleFiles(true);
      try {
        const outputFlat = await listS3ObjectsAcrossPrefixes(
          getSchedulePrefixes(selectedDate, selectedSiteConfig)
        );
        const outputObjects = Array.from(new Map(outputFlat.map((o) => [o.key, o])).values());
        const sortScheduleCandidates = (items) => [...items].sort((a, b) => {
          const aRev = extractScheduleRevision(a.key);
          const bRev = extractScheduleRevision(b.key);
          if (aRev !== null && bRev !== null && bRev !== aRev) return bRev - aRev;

          const pa = getScheduleCandidatePriority(a.key);
          const pb = getScheduleCandidatePriority(b.key);
          if (pa !== pb) return pa - pb;

          const aTime = Date.parse(a.lastModified || '');
          const bTime = Date.parse(b.lastModified || '');
          const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
          if (timeDiff !== 0) return timeDiff;

          return (b.key || '').localeCompare(a.key || '');
        });
        const allScheduleFiles = outputObjects.filter((o) => isScheduleCsvKey(o.key));
        const plantScopedSchedules = allScheduleFiles.filter((o) =>
          isPlantScopedScheduleKey(o.key, selectedSite, selectedSiteConfig?.name)
        );
        const sharedOutputSchedules = allScheduleFiles.filter((o) =>
          !isPlantScopedScheduleKey(o.key, selectedSite, selectedSiteConfig?.name)
        );
        const scheduleCandidates = [
          ...sortScheduleCandidates(plantScopedSchedules),
          ...sortScheduleCandidates(sharedOutputSchedules),
        ];
        setScheduleFiles(scheduleCandidates);
        setSelectedScheduleKey((prev) => (
          prev && scheduleCandidates.some((o) => o.key === prev)
            ? prev
            : (scheduleCandidates[0]?.key || '')
        ));
      } catch (error) {
        console.error(error);
        setScheduleFiles([]);
        setSelectedScheduleKey('');
      } finally {
        setIsLoadingScheduleFiles(false);
      }
    };

    loadScheduleFiles();
  }, [selectedDate, selectedSite, selectedSiteConfig]);

  const handleLoadData = async () => {
    if (!selectedSite) {
      toast.info('Select plant first');
      return;
    }

    setIsLoading(true);
    try {
      const [outputFlat, intradayFlat, meterFlat] = await Promise.all([
        listS3ObjectsAcrossPrefixes(getSchedulePrefixes(selectedDate, selectedSiteConfig)),
        listS3ObjectsAcrossPrefixes(getIntradayPrefixes(selectedDate, selectedSiteConfig)),
        listS3ObjectsAcrossPrefixes(getMeterPrefixes(selectedDate, selectedSiteConfig)),
      ]);
      const outputObjects = Array.from(new Map(outputFlat.map((o) => [o.key, o])).values());
      const intradayObjects = Array.from(new Map(intradayFlat.map((o) => [o.key, o])).values());
      const meterObjects = Array.from(new Map(meterFlat.map((o) => [o.key, o])).values());

      const sortScheduleCandidates = (items) => [...items].sort((a, b) => {
        const aRev = extractScheduleRevision(a.key);
        const bRev = extractScheduleRevision(b.key);
        if (aRev !== null && bRev !== null && bRev !== aRev) return bRev - aRev;

        const pa = getScheduleCandidatePriority(a.key);
        const pb = getScheduleCandidatePriority(b.key);
        if (pa !== pb) return pa - pb;

        const aTime = Date.parse(a.lastModified || '');
        const bTime = Date.parse(b.lastModified || '');
        const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
        if (timeDiff !== 0) return timeDiff;

        return (b.key || '').localeCompare(a.key || '');
      });
      const allScheduleFiles = outputObjects.filter((o) => isScheduleCsvKey(o.key));
      const plantScopedSchedules = allScheduleFiles.filter((o) =>
        isPlantScopedScheduleKey(o.key, selectedSite, selectedSiteConfig?.name)
      );
      const sharedOutputSchedules = allScheduleFiles.filter((o) =>
        !isPlantScopedScheduleKey(o.key, selectedSite, selectedSiteConfig?.name)
      );
      const scheduleCandidates = [
        ...sortScheduleCandidates(plantScopedSchedules),
        ...sortScheduleCandidates(sharedOutputSchedules),
      ];
      const latestIntraday = pickLatestIntradayForDate(
        intradayObjects,
        selectedSiteConfig?.intradayPrefix || ''
      );
      const meterCandidates = sortLatestFirst(
        meterObjects.filter((o) => o.key.toLowerCase().endsWith('.csv'))
      );

      let latestSchedule = null;
      let parsedSchedule = new Map();
      let fallbackZeroSchedule = null;
      const meterRequired = isMeterAvailable(selectedSiteConfig)
        && String(selectedSiteConfig?.code || '').trim().toUpperCase() !== 'GSNP';
      const latestMeter = meterRequired ? meterCandidates[0] : null;

      if (!scheduleCandidates.length) {
        throw new Error('No schedule file found in S3 for selected date');
      }
      if (!latestIntraday) {
        throw new Error('No intraday file found in S3 for selected date');
      }
      if (meterRequired && !latestMeter) {
        throw new Error('No meter file found in S3 for selected date');
      }

      let lastScheduleStatus = null;
      const scheduleByKey = new Map(scheduleCandidates.map((o) => [o.key, o]));
      const chosenKey = selectedScheduleKey || scheduleCandidates[0]?.key;
      const chosenCandidate = chosenKey ? scheduleByKey.get(chosenKey) : null;

      if (chosenCandidate) {
        try {
          const candidateText = await fetchTextFromS3(chosenCandidate.key);
          const candidateParsed = parseScheduleSeriesMap(candidateText);
          if (!candidateParsed.size) {
            throw new Error('Selected schedule file has no schedule column data');
          }
          latestSchedule = chosenCandidate;
          parsedSchedule = candidateParsed;
        } catch (e) {
          lastScheduleStatus = e?.status || null;
        }
      }

      if (!latestSchedule) {
        for (const candidate of scheduleCandidates) {
          try {
            const candidateText = await fetchTextFromS3(candidate.key);
            const candidateParsed = parseScheduleSeriesMap(candidateText);
            if (candidateParsed.size > 0) {
              const values = Array.from(candidateParsed.values()).filter((v) => Number.isFinite(v));
              const nonZeroCount = values.filter((v) => Math.abs(v) > 1e-6).length;
              if (nonZeroCount > 0) {
                latestSchedule = candidate;
                parsedSchedule = candidateParsed;
                break;
              }
              if (!fallbackZeroSchedule) {
                fallbackZeroSchedule = { candidate, parsed: candidateParsed };
              }
            }
          } catch (e) {
            lastScheduleStatus = e?.status || null;
          }
        }
      }

      if (!latestSchedule && fallbackZeroSchedule) {
        latestSchedule = fallbackZeroSchedule.candidate;
        parsedSchedule = fallbackZeroSchedule.parsed;
        toast.warning('Latest schedule file has all-zero values; loaded latest available schedule data.');
      }

      if (!latestSchedule || !parsedSchedule.size) {
        throw new Error(`Failed to fetch schedule CSV from S3${lastScheduleStatus ? `: ${lastScheduleStatus}` : ''}`);
      }

      const [intradayText, meterText] = await Promise.all([
        fetchTextFromS3(latestIntraday.key),
        latestMeter ? fetchTextFromS3(latestMeter.key) : Promise.resolve(null),
      ]);

      const parsedIntraday = parseSeriesMap(intradayText, 'intraday', {
        preferredHeaders: selectedSiteConfig?.state === 'Telangana' ? ['Station Schedule'] : [],
      });
      const parsedMeter = meterText ? parseMeterSeriesMap(meterText) : new Map();
      if (!parsedIntraday.size) {
        toast.warning('Intraday Forecast column not found in latest intraday file; loaded schedule/meter only.');
      }

      setS3ScheduleMap(parsedSchedule);
      setIntradayMap(parsedIntraday);
      setMeterMap(parsedMeter);
      setS3ScheduleMeta({
        fileName: latestSchedule.key.split('/').pop(),
        lastModified: latestSchedule.lastModified,
      });
      const intradayValues = Array.from(parsedIntraday.values()).filter((v) => Number.isFinite(v));
      const intradayNonZero = intradayValues.filter((v) => Math.abs(v) > 1e-6).length;
      const intradayMin = intradayValues.length ? Math.min(...intradayValues) : null;
      const intradayMax = intradayValues.length ? Math.max(...intradayValues) : null;
      setIntradayMeta({
        fileName: latestIntraday.key.split('/').pop(),
        lastModified: latestIntraday.lastModified,
        valueHeader: parsedIntraday?._meta?.valueHeader || null,
        nonZero: intradayNonZero,
        min: intradayMin,
        max: intradayMax,
      });
      setMeterMeta(
        latestMeter
          ? {
              fileName: latestMeter.key.split('/').pop(),
              lastModified: latestMeter.lastModified,
            }
          : null
      );

      toast.success('Latest S3 schedule, intraday, and meter loaded');
    } catch (error) {
      console.error(error);
      setS3ScheduleMap(null);
      setIntradayMap(null);
      setMeterMap(null);
      setS3ScheduleMeta(null);
      setIntradayMeta(null);
      setMeterMeta(null);
      toast.error(error?.message || 'Failed to load S3 data');
    } finally {
      setIsLoading(false);
    }
  };


  const handleFileUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setIsUploading(true);
    setFileName(file.name);
    try {
      const text = await readUploadedTabularFile(file);
      const parsed = parseSeriesMap(text, 'uploaded_forecast');
      if (!parsed.size) {
        throw new Error('Forecast column not found in uploaded file');
      }
      setUploadedMap(parsed);
      setUploadTime(new Date());
      toast.success('Vedanjay schedule uploaded and added to graph');
    } catch (error) {
      console.error(error);
      setUploadedMap(null);
      toast.error(error?.message || 'Failed to parse uploaded schedule');
    } finally {
      setIsUploading(false);
      event.target.value = '';
    }
  };

  const handleClear = () => {
    setS3ScheduleMap(null);
    setIntradayMap(null);
    setMeterMap(null);
    setUploadedMap(null);
    setS3ScheduleMeta(null);
    setIntradayMeta(null);
    setMeterMeta(null);
    setUploadTime(null);
    setFileName('');
    toast.success('Comparison cleared');
  };

  const rows = useMemo(() => {
    if (!s3ScheduleMap && !intradayMap && !meterMap && !uploadedMap) return [];
    const todayIst = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const isTodaySelected = selectedDate === todayIst;
    const currentIstBlock = isTodaySelected ? getCurrentIstBlock() : TOTAL_BLOCKS;
    const capacityMw =
      Number(selectedSiteConfig?.capacityMw || 0)
      || PLANT_CAPACITY_FALLBACK[String(selectedSiteConfig?.code || '').toUpperCase()]
      || PLANT_CAPACITY_FALLBACK[String(selectedSiteConfig?.name || '').toUpperCase()]
      || 0;
    const plantState =
      selectedSiteConfig?.state ||
      PLANT_STATE_FALLBACK[String(selectedSiteConfig?.code || '').toUpperCase()] ||
      '';
    const plantType =
      selectedSiteConfig?.type ||
      PLANT_TYPE_FALLBACK[String(selectedSiteConfig?.code || '').toUpperCase()] ||
      'Solar';

    return Array.from({ length: TOTAL_BLOCKS }, (_, i) => {
      const block = i + 1;
      const meterActual = block <= currentIstBlock ? (meterMap?.get(block) ?? null) : null;
      const intradayForecast = intradayMap?.get(block) ?? null;
      const uploadedForecast = uploadedMap?.get(block) ?? null;
      const s3Schedule = s3ScheduleMap?.get(block) ?? null;
      const hasDiffInputs = Number.isFinite(s3Schedule) && Number.isFinite(uploadedForecast);
      const diffMw = hasDiffInputs ? s3Schedule - uploadedForecast : null;
      const diffPct = hasDiffInputs && capacityMw > 0
        ? (diffMw / capacityMw) * 100
        : null;
      const penaltyLatestS3 = calculatePenaltyRs({
        scheduledMw: Number.isFinite(s3Schedule) ? s3Schedule : null,
        actualMw: Number.isFinite(meterActual) ? meterActual : null,
        capacityMw,
        plantState,
        plantType,
      });
      const penaltyVedanjay = calculatePenaltyRs({
        scheduledMw: Number.isFinite(uploadedForecast) ? uploadedForecast : null,
        actualMw: Number.isFinite(meterActual) ? meterActual : null,
        capacityMw,
        plantState,
        plantType,
      });
      return {
        block,
        time: blockToInterval(block),
        s3Schedule,
        intradayForecast,
        meterActual,
        uploadedForecast,
        diffMw,
        diffPct,
        penaltyLatestS3,
        penaltyVedanjay,
      };
    });
  }, [s3ScheduleMap, intradayMap, meterMap, uploadedMap, selectedDate, selectedSiteConfig]);

  const comparisonSummary = useMemo(() => {
    if (!rows.length) {
      return {
        avgDiffMw: 0,
        maxDiffMw: 0,
        avgDiffPct: 0,
        totalPenaltyMachine: 0,
        totalPenaltyVedanjay: 0,
        validDiffCount: 0,
      };
    }
    const diffs = rows.filter((r) => Number.isFinite(r.diffMw));
    const diffPcts = rows.filter((r) => Number.isFinite(r.diffPct));
    const avgDiffMw = diffs.length
      ? diffs.reduce((sum, r) => sum + (r.diffMw || 0), 0) / diffs.length
      : 0;
    const maxDiffMw = diffs.length
      ? Math.max(...diffs.map((r) => Math.abs(r.diffMw || 0)))
      : 0;
    const avgDiffPct = diffPcts.length
      ? diffPcts.reduce((sum, r) => sum + (r.diffPct || 0), 0) / diffPcts.length
      : 0;
    const totalPenaltyMachine = rows.reduce((sum, r) => sum + (r.penaltyLatestS3 || 0), 0);
    const totalPenaltyVedanjay = rows.reduce((sum, r) => sum + (r.penaltyVedanjay || 0), 0);
    return {
      avgDiffMw,
      maxDiffMw,
      avgDiffPct,
      totalPenaltyMachine,
      totalPenaltyVedanjay,
      validDiffCount: diffs.length,
    };
  }, [rows]);

  const plotData = useMemo(() => {
    if (!rows.length) return [];
    const capacityMw =
      Number(selectedSiteConfig?.capacityMw || 0)
      || PLANT_CAPACITY_FALLBACK[String(selectedSiteConfig?.code || '').toUpperCase()]
      || PLANT_CAPACITY_FALLBACK[String(selectedSiteConfig?.name || '').toUpperCase()]
      || 0;
    const allowedBandMw = (capacityMw * DSM_ALLOWED_BAND_PERCENT) / 100;
    const hideMeterLine = String(selectedSiteConfig?.code || '').trim().toUpperCase() === 'GSNP';
    const blockIntervals = rows.map((r) => blockToInterval(r.block));
    const blockLabels = rows.map((r) => `Block ${r.block} (${blockToInterval(r.block)})`);
    const base = [
      {
        x: blockLabels,
        y: rows.map((r) => r.s3Schedule),
        customdata: blockIntervals,
        type: 'scatter',
        mode: 'lines',
        name: 'Machine Schedule (MW)',
        line: { color: '#6366f1', width: 2.5 },
        hovertemplate: '%{y:.3f} MW<extra>Machine Schedule</extra>',
        connectgaps: false,
      },
      {
        x: blockLabels,
        y: rows.map((r) =>
          Number.isFinite(r.s3Schedule) ? r.s3Schedule + allowedBandMw : null
        ),
        customdata: blockIntervals,
        type: 'scatter',
        mode: 'lines',
        name: `Upper Allowed Band (+${DSM_ALLOWED_BAND_PERCENT}%)`,
        line: { color: '#ef4444', width: 2.5, dash: 'dot' },
        opacity: 0.95,
        hovertemplate: '%{y:.3f} MW<extra>Upper Allowed Band</extra>',
        connectgaps: false,
      },
      {
        x: blockLabels,
        y: rows.map((r) =>
          Number.isFinite(r.s3Schedule) ? r.s3Schedule - allowedBandMw : null
        ),
        customdata: blockIntervals,
        type: 'scatter',
        mode: 'lines',
        name: `Lower Allowed Band (-${DSM_ALLOWED_BAND_PERCENT}%)`,
        line: { color: '#ef4444', width: 2.5, dash: 'dot' },
        opacity: 0.95,
        hovertemplate: '%{y:.3f} MW<extra>Lower Allowed Band</extra>',
        connectgaps: false,
      },
      {
        x: blockLabels,
        y: rows.map((r) => r.intradayForecast),
        customdata: blockIntervals,
        type: 'scatter',
        mode: 'lines',
        name: 'Enercast Intraday Forecast (MW)',
        line: { color: '#f59e0b', width: 2.5 },
        hovertemplate: '%{y:.3f} MW<extra>Enercast Intraday Forecast</extra>',
        connectgaps: false,
      },
    ];

    if (!hideMeterLine) {
      base.push({
        x: blockLabels,
        y: rows.map((r) => r.meterActual),
        customdata: blockIntervals,
        type: 'scatter',
        mode: 'lines',
        name: 'Meter Data (MW)',
        line: { color: isDarkMode ? '#ffffff' : '#000000', width: 2.5 },
        hovertemplate: '%{y:.3f} MW<extra>Meter Data</extra>',
        connectgaps: false,
      });
    }

    if (uploadedMap) {
      base.push({
        x: blockLabels,
        y: rows.map((r) => r.uploadedForecast ?? null),
        customdata: blockIntervals,
        type: 'scatter',
        mode: 'lines',
        name: 'Vedanjay Schedule',
        line: { color: '#22c55e', width: 2.5 },
        hovertemplate: '%{y:.3f} MW<extra>Vedanjay Schedule</extra>',
        connectgaps: false,
      });
    }

    return base;
  }, [rows, uploadedMap, selectedSiteConfig, isDarkMode]);

  const exportComparison = async (format = 'csv') => {
    if (!rows.length) {
      toast.info('No comparison data to export');
      return;
    }
    const headers = [
      'Block',
      'Time',
      'Machine Schedule (MW)',
      'Enercast Intraday Forecast (MW)',
      'Meter Data (MW)',
      'Vedanjay Schedule',
      'Penalty (Latest S3) Rs',
      'Penalty (Vedanjay) Rs',
      'Difference (MW)',
      'Difference (%)',
    ];
    const rowsData = rows.map((r) => [
      r.block,
      r.time,
      r.s3Schedule === null ? '' : r.s3Schedule.toFixed(3),
      r.intradayForecast === null ? '' : r.intradayForecast.toFixed(3),
      r.meterActual === null ? '' : r.meterActual.toFixed(3),
      r.uploadedForecast === null ? '' : r.uploadedForecast.toFixed(3),
      r.penaltyLatestS3 === null ? '' : r.penaltyLatestS3.toFixed(2),
      r.penaltyVedanjay === null ? '' : r.penaltyVedanjay.toFixed(2),
      r.diffMw === null ? '' : r.diffMw.toFixed(3),
      r.diffPct === null ? '' : r.diffPct.toFixed(2),
    ]);
    const filenameBase = `schedule-comparison-${selectedDate}`;
    if (format === 'xlsx') {
      await downloadXlsxFromRows(headers, rowsData, filenameBase, 'Comparison');
    } else {
      const csv = buildCsvText(headers, rowsData);
      downloadCsvText(csv, filenameBase);
    }
    setShowDownloadModal(false);
  };

  const exitGraphFullscreen = async () => {
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        // Ignore and fallback to in-page fullscreen state reset
      }
    }
    setIsGraphFullscreen(false);
  };

  const toggleGraphFullscreen = async () => {
    const container = chartContainerRef.current;
    if (!container) return;

    const nativeSupported = Boolean(document.fullscreenEnabled && container.requestFullscreen);

    if (nativeSupported) {
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
          setIsGraphFullscreen(false);
        } else {
          await container.requestFullscreen();
          setIsGraphFullscreen(true);
        }
        return;
      } catch {
        // Fallback to in-page fullscreen mode below.
      }
    }

    setIsGraphFullscreen((prev) => !prev);
  };

  return (
    <div className="flex-1 overflow-auto bg-background min-h-0 relative overflow-x-hidden">
      {isDarkMode && (
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-0 left-1/4 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl animate-pulse" />
          <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />
        </div>
      )}

      <div className="w-full p-4 sm:p-6 lg:p-8 space-y-6 sm:space-y-8 max-w-[1600px] mx-auto relative z-10">
        <div className={`relative overflow-hidden rounded-2xl border shadow-sm ${isDarkMode ? 'bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 border-slate-700/50 shadow-2xl' : 'bg-gradient-to-r from-white via-slate-50 to-emerald-50 border-border'}`}>
          <div className={`absolute inset-0 ${isDarkMode ? 'bg-gradient-to-r from-indigo-500/5 via-transparent to-purple-500/5' : 'bg-gradient-to-r from-emerald-500/5 via-transparent to-cyan-500/5'}`} />
          <div className="relative p-4 sm:p-6 lg:p-8">
            <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-6">
              <div className="flex items-start gap-4 sm:gap-5">
                <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/25">
                  <ArrowLeftRight className="w-6 h-6 sm:w-7 sm:h-7 text-white" />
                </div>
                <div>
                  <h1 className="text-2xl sm:text-3xl font-bold text-foreground mb-2 tracking-tight">Schedule Comparison</h1>
                  <p className="text-xs sm:text-sm text-muted-foreground">Latest S3 schedule + latest intraday + latest meter first. Uploaded Vedanjay forecast overlays after successful upload.</p>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-3 sm:gap-4">
                {(rows.length > 0 || uploadedMap) && (
                  <button
                    onClick={handleClear}
                    className="w-full sm:w-auto group relative px-5 sm:px-6 py-2.5 sm:py-3 rounded-xl bg-card hover:bg-muted border border-border transition-all duration-300 flex items-center justify-center gap-3"
                  >
                    <X className="w-5 h-5 text-muted-foreground group-hover:text-foreground transition-colors" />
                    <div className="text-left">
                      <p className="text-sm font-semibold text-foreground">Clear</p>
                      <p className="text-xs text-muted-foreground">Reset comparison</p>
                    </div>
                  </button>
                )}
                <button
                  onClick={() => { setDownloadFormat('csv'); setShowDownloadModal(true); }}
                  disabled={!rows.length}
                  className="w-full sm:w-auto group relative px-5 sm:px-6 py-2.5 sm:py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white shadow-lg shadow-indigo-500/25 transition-all duration-300 flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Download className="w-5 h-5" />
                  <div className="text-left">
                    <p className="text-sm font-semibold">Export</p>
                    <p className="text-xs text-indigo-200">Download CSV</p>
                  </div>
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col xl:flex-row xl:items-center gap-4 p-4 rounded-2xl bg-card border border-border backdrop-blur-sm">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Filter className="w-5 h-5" />
            <span className="text-sm font-medium">Filters:</span>
          </div>

          <div className="flex flex-wrap gap-3 w-full xl:w-auto">
            <div className="relative">
              <select
                value={selectedSite}
                onChange={(e) => setSelectedSite(e.target.value)}
                className="w-full sm:w-auto px-4 py-2.5 rounded-xl bg-background border border-border text-foreground text-sm font-medium appearance-none pr-10"
              >
                <option value="">Select Plant</option>
                {siteOptions.map((site) => (
                  <option key={site.code} value={site.code}>{site.name}</option>
                ))}
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            </div>

            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="w-full sm:w-auto px-4 py-2.5 rounded-xl bg-background border border-border text-foreground text-sm font-medium"
            />

            <div className="relative">
              <select
                value={selectedScheduleKey}
                onChange={(e) => setSelectedScheduleKey(e.target.value)}
                className="w-full sm:w-auto px-4 py-2.5 rounded-xl bg-background border border-border text-foreground text-sm font-medium appearance-none pr-10 max-w-full sm:max-w-[320px]"
                disabled={isLoadingScheduleFiles || !scheduleFiles.length}
              >
                {!scheduleFiles.length && (
                  <option value="">No schedule files</option>
                )}
                {scheduleFiles.map((file) => (
                  <option key={file.key} value={file.key}>
                    {file.key.split('/').pop()}
                  </option>
                ))}
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            </div>

            <button
              onClick={handleLoadData}
              disabled={isLoading}
              className="w-full sm:w-auto px-6 py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white text-sm font-medium transition-all duration-300 flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {isLoading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Loading...
                </>
              ) : (
                <>
                  <Filter className="w-4 h-4" />
                  Load Latest S3
                </>
              )}
            </button>

            <div className="relative">
              <input
                type="file"
                accept=".csv,.xlsx,.xls"
                onChange={handleFileUpload}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                disabled={isUploading}
              />
              <button
                disabled={isUploading}
                className="w-full sm:w-auto px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 text-white text-sm font-medium transition-all duration-300 flex items-center justify-center gap-2 disabled:opacity-50"
              >
                <Upload className={`w-4 h-4 ${isUploading ? 'animate-bounce' : ''}`} />
                {isUploading ? 'Uploading...' : fileName ? fileName : 'Upload Vedanjay CSV/XLSX'}
              </button>
            </div>

            {uploadTime && (
              <div className="w-full sm:w-auto flex items-center gap-2 px-4 py-2.5 rounded-xl bg-background border border-border">
                <Clock className="w-4 h-4 text-emerald-400" />
                <span className="text-sm text-foreground">
                  Uploaded: <span className="text-emerald-400 font-medium">{formatUploadTime(uploadTime)}</span>
                </span>
              </div>
            )}
          </div>
        </div>

        {!rows.length && (
          <div className="rounded-2xl bg-card border border-border backdrop-blur-sm p-8 sm:p-20">
            <div className="flex flex-col items-center gap-6">
              <div className="p-6 rounded-full bg-muted">
                <FileText className="w-16 h-16 text-muted-foreground" />
              </div>
              <div className="text-center">
                <h3 className="text-lg sm:text-xl font-bold text-foreground mb-2">No Schedule Data Available</h3>
                <p className="text-muted-foreground max-w-md">
                  Select plant and date, then click "Load Latest S3". This shows latest day schedule, latest intraday, and latest meter from S3 first.
                </p>
              </div>
              <div className="flex flex-col sm:flex-row items-center gap-3 sm:gap-4 text-xs sm:text-sm text-muted-foreground">
                <div className="flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 text-emerald-500" />
                  <span>Block-wise (1-96)</span>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 text-emerald-500" />
                  <span>Plotly graph with legend + hover</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {rows.length > 0 && (
          <div className="rounded-2xl bg-card border border-border backdrop-blur-sm overflow-hidden">
            <div className="p-4 sm:p-6 border-b border-border bg-muted/50">
              <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-xl bg-indigo-500/10">
                    <Table className="w-5 h-5 sm:w-6 sm:h-6 text-indigo-400" />
                  </div>
                  <div>
                    <h3 className="text-lg sm:text-xl font-bold text-foreground">Comparison Details</h3>
                    <p className="text-xs sm:text-sm text-muted-foreground mt-1">{selectedSiteConfig?.name || selectedSite} - {selectedDate} - 96 x 15-minute blocks</p>
                    {!HIDE_METADATA && s3ScheduleMeta && (
                      <p className="text-xs text-muted-foreground mt-1">Machine Schedule: {s3ScheduleMeta.fileName}</p>
                    )}
                    {!HIDE_METADATA && intradayMeta && (
                      <>
                        <p className="text-xs text-muted-foreground mt-1">Latest Intraday: {intradayMeta.fileName}</p>
                        {intradayMeta.valueHeader && (
                          <p className="text-[11px] text-muted-foreground mt-0.5">
                            Intraday column: {intradayMeta.valueHeader} • non-zero: {intradayMeta.nonZero ?? 0}
                            {Number.isFinite(intradayMeta.min) && Number.isFinite(intradayMeta.max)
                              ? ` • range: ${intradayMeta.min.toFixed(3)}–${intradayMeta.max.toFixed(3)}`
                              : ''}
                          </p>
                        )}
                      </>
                    )}
                    {!HIDE_METADATA && meterMeta && (
                      <p className="text-xs text-muted-foreground mt-1">Latest Meter: {meterMeta.fileName}</p>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => {
                      setShowGraph(false);
                      exitGraphFullscreen();
                    }}
                    className={`relative px-3 sm:px-4 py-2 text-xs sm:text-sm font-semibold rounded-xl transition-all duration-300 ${!showGraph ? 'text-white' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
                  >
                    {!showGraph && <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 shadow-lg shadow-indigo-500/25" />}
                    <span className="relative z-10 flex items-center gap-2"><Table className="w-4 h-4" /> Table</span>
                  </button>
                  <button
                    onClick={() => setShowGraph(true)}
                    className={`relative px-3 sm:px-4 py-2 text-xs sm:text-sm font-semibold rounded-xl transition-all duration-300 ${showGraph ? 'text-white' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
                  >
                    {showGraph && <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 shadow-lg shadow-indigo-500/25" />}
                    <span className="relative z-10 flex items-center gap-2"><BarChart3 className="w-4 h-4" /> Graph</span>
                  </button>
                  <button
                    onClick={toggleGraphFullscreen}
                    disabled={!showGraph}
                    className="relative px-3 sm:px-4 py-2 text-xs sm:text-sm font-semibold rounded-xl transition-all duration-300 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                    title={isGraphFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                  >
                    <span className="relative z-10 flex items-center gap-2">
                      {isGraphFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                      {isGraphFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
                    </span>
                  </button>
                </div>
              </div>
            </div>

            {!showGraph ? (
              <div className="space-y-4">
                <div className="overflow-x-auto max-h-[550px] overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-muted border-b border-border z-10">
                      <tr>
                        {[
                          'Block',
                          'Time',
                          'Machine Schedule (MW)',
                          'Enercast Intraday Forecast (MW)',
                          'Meter Data (MW)',
                          'Vedanjay Schedule',
                          'Penalty (Latest S3)',
                          'Penalty (Vedanjay)',
                          'Difference (MW)',
                          'Difference (%)',
                        ].map((header) => (
                          <th key={header} className="px-3 sm:px-4 py-3 text-left text-xs font-semibold text-black dark:text-foreground uppercase tracking-wider">{header}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {rows.map((row) => (
                        <tr key={row.block} className="hover:bg-muted/50 transition-all duration-150">
                          <td className="px-3 sm:px-4 py-2.5 text-foreground font-medium">{row.block}</td>
                          <td className="px-3 sm:px-4 py-2.5 text-muted-foreground">{row.time}</td>
                          <td className="px-3 sm:px-4 py-2.5 text-indigo-600">{row.s3Schedule === null ? '--' : row.s3Schedule.toFixed(3)}</td>
                          <td className="px-3 sm:px-4 py-2.5 text-amber-600">{row.intradayForecast === null ? '--' : row.intradayForecast.toFixed(3)}</td>
                          <td className="px-3 sm:px-4 py-2.5 text-red-600">{row.meterActual === null ? '--' : row.meterActual.toFixed(3)}</td>
                          <td className="px-3 sm:px-4 py-2.5 text-emerald-700">{row.uploadedForecast === null ? '-' : row.uploadedForecast.toFixed(3)}</td>
                          <td className="px-3 sm:px-4 py-2.5 text-slate-700">{row.penaltyLatestS3 === null ? '--' : `Rs ${row.penaltyLatestS3.toFixed(2)}`}</td>
                          <td className="px-3 sm:px-4 py-2.5 text-slate-700">{row.penaltyVedanjay === null ? '--' : `Rs ${row.penaltyVedanjay.toFixed(2)}`}</td>
                          <td className="px-3 sm:px-4 py-2.5 text-slate-700">{row.diffMw === null ? '--' : row.diffMw.toFixed(3)}</td>
                          <td className="px-3 sm:px-4 py-2.5 text-slate-700">{row.diffPct === null ? '--' : `${row.diffPct.toFixed(2)}%`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="rounded-xl border border-border bg-muted/30 p-4 sm:p-5">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div>
                      <h4 className="text-sm sm:text-base font-semibold text-foreground">Comparison Summary</h4>
                      <p className="text-xs text-muted-foreground">Averages and total penalties for the selected day</p>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Valid blocks: <span className="text-foreground font-semibold">{comparisonSummary.validDiffCount}</span>
                    </div>
                  </div>
                  <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                    <div className="rounded-lg bg-background border border-border p-3">
                      <p className="text-[11px] text-muted-foreground mb-1">Total Penalty (Machine Schedule)</p>
                      <p className="text-lg font-bold text-emerald-600">Rs {comparisonSummary.totalPenaltyMachine.toFixed(2)}</p>
                    </div>
                    <div className="rounded-lg bg-background border border-border p-3">
                      <p className="text-[11px] text-muted-foreground mb-1">Total Penalty (Vedanjay Schedule)</p>
                      <p className="text-lg font-bold text-emerald-600">Rs {comparisonSummary.totalPenaltyVedanjay.toFixed(2)}</p>
                    </div>
                    <div className="rounded-lg bg-background border border-border p-3">
                      <p className="text-[11px] text-muted-foreground mb-1">Avg Difference (MW)</p>
                      <p className="text-lg font-bold text-foreground">{comparisonSummary.avgDiffMw.toFixed(3)}</p>
                    </div>
                    <div className="rounded-lg bg-background border border-border p-3">
                      <p className="text-[11px] text-muted-foreground mb-1">Max Difference (MW)</p>
                      <p className="text-lg font-bold text-foreground">{comparisonSummary.maxDiffMw.toFixed(3)}</p>
                    </div>
                    <div className="rounded-lg bg-background border border-border p-3">
                      <p className="text-[11px] text-muted-foreground mb-1">Avg Difference (%)</p>
                      <p className="text-lg font-bold text-foreground">{comparisonSummary.avgDiffPct.toFixed(2)}%</p>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div
                ref={chartContainerRef}
                className={isGraphFullscreen ? 'fixed inset-0 z-50 bg-background p-4 sm:p-6' : 'p-6'}
              >
                <div className={`${isGraphFullscreen ? 'h-[calc(100vh-2rem)] sm:h-[calc(100vh-3rem)]' : 'h-[500px]'} bg-background rounded-xl border border-border p-4 overflow-auto`}>
                  <Plot
                    data={plotData}
                    layout={{
                      margin: { l: 70, r: 20, t: 20, b: 60 },
                      paper_bgcolor: isDarkMode ? 'rgba(0,0,0,0)' : '#ffffff',
                      plot_bgcolor: isDarkMode ? 'rgba(0,0,0,0)' : '#ffffff',
                      font: { color: isDarkMode ? '#cbd5e1' : '#1f2937', size: 12 },
                      xaxis: {
                        title: 'Block No',
                        tickvals: [1, 12, 24, 36, 48, 60, 72, 84, 96].map(
                          (block) => `Block ${block} (${blockToInterval(block)})`
                        ),
                        ticktext: ['1', '12', '24', '36', '48', '60', '72', '84', '96'],
                        gridcolor: isDarkMode ? 'rgba(148,163,184,0.2)' : 'rgba(100,116,139,0.22)',
                      },
                      yaxis: {
                        title: 'Power (MW)',
                        gridcolor: isDarkMode ? 'rgba(148,163,184,0.2)' : 'rgba(100,116,139,0.22)',
                      },
                      hovermode: 'x unified',
                      legend: {
                        orientation: 'h',
                        x: 0,
                        y: 1.1,
                        bgcolor: isDarkMode ? 'rgba(0,0,0,0)' : 'rgba(255,255,255,0.9)',
                        font: { color: isDarkMode ? '#cbd5e1' : '#1f2937' },
                      },
                      hoverlabel: {
                        bgcolor: isDarkMode ? '#1f2937' : '#ffffff',
                        bordercolor: isDarkMode ? '#334155' : '#cbd5e1',
                        font: { color: isDarkMode ? '#e2e8f0' : '#0f172a' },
                      },
                    }}
                    config={{ displayModeBar: false, responsive: true }}
                    style={{ width: '100%', height: '100%' }}
                    useResizeHandler
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <DownloadFormatModal
        open={showDownloadModal}
        onClose={() => setShowDownloadModal(false)}
        format={downloadFormat}
        onFormatChange={setDownloadFormat}
        onDownload={() => exportComparison(downloadFormat)}
      />
    </div>
  );
}


