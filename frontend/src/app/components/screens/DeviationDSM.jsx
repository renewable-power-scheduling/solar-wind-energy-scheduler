import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Download, Filter, TrendingDown } from 'lucide-react';
import { toast } from 'sonner';
import { jsPDF } from 'jspdf';
import { useTheme } from '@/app/appContexts';
import createPlotlyComponent from 'react-plotly.js/factory';
import Plotly from 'plotly.js-dist-min';
import { S3_BASE_URL } from '@/config/appConfig';
import { DSM_PENALTY_CONFIG_BY_STATE, DEFAULT_DSM_PENALTY_CONFIG } from '@/config/dsmPenaltyConfig';
import { calculatePenaltyRs as calculatePenaltyRsShared } from '@/shared/freezeRules';
import { api } from '@/services/api';
import { useApi } from '@/hooks/useApi';
import DownloadFormatModal from '@/app/components/common/DownloadFormatModal';
import { buildCsvText, downloadBlob, downloadCsvText, downloadXlsxFromRows } from '@/app/components/common/downloadUtils';
import { parseBlockFromTimestamp } from '@/utils/meterTime';
import { canUserAccessPlantCode, getCurrentUserFromStorage, getDisabledPlantPattern } from '@/utils/plantAccess';
import { calculateOseplOfficePayableReceivable, calculateOseplSettlement } from '@/utils/oseplPenalty';
import { resolveMeterMwFactor } from '@/utils/meterUnit';

let Plot = null;
try {
  Plot = createPlotlyComponent(Plotly);
} catch (error) {
  console.error('Failed to initialize Plotly for DeviationDSM:', error);
}

const RAW_BASE_PREFIXES = [
  'raw/vedanjay/BHUPALPALLY/',
  'raw/vedanjay/CME/',
  'raw/vedanjay/GSNP/',
  'raw/vedanjay/KASIPET/',
  'raw/vedanjay/KILAJ/',
  'raw/vedanjay/KOTHAGUDEM/',
  'raw/vedanjay/OSEPL/',
  'raw/vedanjay/ANDAD/',
  'raw/vedanjay/BALAKWADA/',
  'raw/vedanjay/GUGARIYAKHEDI/',
  'raw/vedanjay/NANDGAON/',
  'raw/vedanjay/BAMKHAL/',
  'raw/vedanjay/SAWDA/',
  'raw/vedanjay/multiple_generator/ZTRIC/',
  'raw/vedanjay/ANJANGAON/',
  'raw/vedanjay/ANJANGOAN/',
  'raw/vedanjay/SIRMOUR/',
  'raw/GSNP/gsnp/',
  'raw/Sirmour/sirmour/',
];
const GENERATED_OUTPUTS_BASE_PREFIXES = [
  'generated/vedanjay/BHUPALPALLY/outputs/',
  'generated/vedanjay/CME/outputs/',
  'generated/vedanjay/GSNP/outputs/',
  'generated/vedanjay/KASIPET/outputs/',
  'generated/vedanjay/KILAJ/outputs/',
  'generated/vedanjay/KOTHAGUDEM/outputs/',
  'generated/vedanjay/OSEPL/outputs/',
  'generated/vedanjay/ANDAD/outputs/',
  'generated/vedanjay/BALAKWADA/outputs/',
  'generated/vedanjay/GUGARIYAKHEDI/outputs/',
  'generated/vedanjay/NANDGAON/outputs/',
  'generated/vedanjay/BAMKHAL/outputs/',
  'generated/vedanjay/SAWDA/outputs/',
  'generated/vedanjay/multiple_generator/ZTRIC/',
  'generated/vedanjay/ANJANGAON/outputs/',
  'generated/vedanjay/SIRMOUR/outputs/',
  'generated/GSNP/gsnp/outputs/',
  'generated/Sirmour/sirmour/outputs/',
];
const UPLOADS_BASE_PREFIXES = [
  'uploads/vedanjay/BHUPALPALLY/',
  'uploads/vedanjay/CME/',
  'uploads/vedanjay/GSNP/',
  'uploads/vedanjay/KASIPET/',
  'uploads/vedanjay/KILAJ/',
  'uploads/vedanjay/KOTHAGUDEM/',
  'uploads/vedanjay/OSEPL/',
  'uploads/vedanjay/ANDAD/',
  'uploads/vedanjay/BALAKWADA/',
  'uploads/vedanjay/GUGARIYAKHEDI/',
  'uploads/vedanjay/NANDGAON/',
  'uploads/vedanjay/BAMKHAL/',
  'uploads/vedanjay/SAWDA/',
  'uploads/vedanjay/ZETRIC/',
  'uploads/vedanjay/ANJANGAON/',
  'uploads/vedanjay/ANJANGOAN/',
  'uploads/vedanjay/SIRMOUR/',
];
const FROZEN_ARTIFACT_BASE_PREFIXES = [
  'frozenschedules/vedanjay/BHUPALPALLY/',
  'frozenschedules/vedanjay/CME/',
  'frozenschedules/vedanjay/GSNP/',
  'frozenschedules/vedanjay/KASIPET/',
  'frozenschedules/vedanjay/KILAJ/',
  'frozenschedules/vedanjay/KOTHAGUDEM/',
  'frozenschedules/vedanjay/OSEPL/',
  'frozenschedules/vedanjay/ANDAD/',
  'frozenschedules/vedanjay/BALAKWADA/',
  'frozenschedules/vedanjay/GUGARIYAKHEDI/',
  'frozenschedules/vedanjay/NANDGAON/',
  'frozenschedules/vedanjay/BAMKHAL/',
  'frozenschedules/vedanjay/SAWDA/',
  'frozenschedules/vedanjay/ZETRIC/',
  'frozenschedules/vedanjay/ANJANGAON/',
  'frozenschedules/vedanjay/ANJANGOAN/',
  'frozenschedules/vedanjay/SIRMOUR/',
];
const LEGACY_OUTPUTS_BASE_PREFIX = 'outputs/';
const EPSILON = 0.001;
const S3_PRIMARY_PLANT = 'Globus Steel N Power (GSNP)';
const S3_SECONDARY_PLANT = 'SIRMOUR';
const PLANT_CAPACITY_MW = {
  BHUPALPALLY: 0,
  CME: 5,
  GSNP: 20,
  [S3_PRIMARY_PLANT]: 20,
  KASIPET: 0,
  KILAJ: 20,
  KOTHAGUDEM: 0,
  OSEPL: 20,
  ANDAD: 7.5,
  BALAKWADA: 7.5,
  GUGARIYAKHEDI: 7.5,
  NANDGAON: 7.5,
  BAMKHAL: 5,
  SAWDA: 7.5,
  ZETRIC: 25,
  ANJANGAON: 7.5,
  [S3_SECONDARY_PLANT]: 5.1,
};
const PLANT_STATE_FALLBACK = {
  BHUPALPALLY: 'Telangana',
  CME: 'Maharashtra',
  GSNP: 'Madhya Pradesh',
  KASIPET: 'Telangana',
  KILAJ: 'Maharashtra',
  KOTHAGUDEM: 'Telangana',
  OSEPL: 'Maharashtra',
  ANDAD: 'Madhya Pradesh',
  BALAKWADA: 'Madhya Pradesh',
  GUGARIYAKHEDI: 'Madhya Pradesh',
  NANDGAON: 'Madhya Pradesh',
  BAMKHAL: 'Madhya Pradesh',
  SAWDA: 'Madhya Pradesh',
  ZETRIC: 'Maharashtra',
  ANJANGAON: 'Madhya Pradesh',
  [S3_PRIMARY_PLANT]: 'Madhya Pradesh',
  [S3_SECONDARY_PLANT]: 'Madhya Pradesh',
};
const PLANT_TYPE_FALLBACK = {
  BHUPALPALLY: 'Solar',
  CME: 'Solar',
  GSNP: 'Solar',
  KASIPET: 'Solar',
  KILAJ: 'Solar',
  KOTHAGUDEM: 'Solar',
  OSEPL: 'Solar',
  ANDAD: 'Solar',
  BALAKWADA: 'Solar',
  GUGARIYAKHEDI: 'Solar',
  NANDGAON: 'Solar',
  BAMKHAL: 'Solar',
  SAWDA: 'Solar',
  ZETRIC: 'Solar',
  ANJANGAON: 'Solar',
  [S3_PRIMARY_PLANT]: 'Solar',
  [S3_SECONDARY_PLANT]: 'Solar',
};
const DSM_DEFAULT_ALLOWED_LIMIT_PERCENT = 10;
const DSM_BLOCK_DURATION_HOURS = 0.25;
const KWH_PER_MWH = 1000;
const getIstDateKey = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
// Plant visibility is role-based (see plantAccess).

function derivePlantFoldersFromName(name) {
  const text = String(name || '').trim();
  if (!text) return null;
  let folder = text;
  // S3 canonical folder uses OSEPL; UI may show OSEL.
  if (folder.toUpperCase().replace(/\s+/g, '') === 'OSEL') {
    folder = 'OSEPL';
  }
  if (/^[A-Z0-9_-]+$/.test(folder) && folder.length > 4) {
    const lower = folder.toLowerCase();
    folder = lower.charAt(0).toUpperCase() + lower.slice(1);
  }
  const lowerFolder = folder.toLowerCase().replace(/\s+/g, '');
  const upperFolder = folder.toUpperCase().replace(/\s+/g, '');
  return { folder, lower: lowerFolder, upper: upperFolder };
}

function normalizePlantName(rawName) {
  const text = String(rawName || '').trim();
  if (!text) return text;
  const lower = text.toLowerCase();
  if (lower === 'anjangoan') return 'ANJANGAON';
  if ([
    'bhupalpally',
    'cme',
    'kasipet',
    'kilaj',
    'kothagudem',
    'osepl',
    'andad',
    'balakwada',
    'gugariyakhedi',
    'nandgaon',
    'bamkhal',
    'sawda',
    'anjangaon',
  ].includes(lower)) {
    return lower.toUpperCase();
  }
  if (lower === 'gsnp' || lower.includes('globus steel') || lower.includes('(gsnp)')) {
    return 'GSNP';
  }
  if (lower === 'sirmour' || lower.includes('sirmour')) {
    return S3_SECONDARY_PLANT;
  }
  return text;
}
const isBlockedPlant = (name) => {
  const code = normalizePlantName(name);
  return !canUserAccessPlantCode(code, getCurrentUserFromStorage());
};

function normalizeStateName(rawState) {
  const text = String(rawState || '').trim();
  if (!text) return text;
  const lower = text.toLowerCase();
  if (lower === 'mh' || lower === 'maharashtra') return 'Maharashtra';
  if (lower === 'tl' || lower === 'telangana') return 'Telangana';
  if (lower === 'mp' || lower === 'madhya pradesh' || lower === 'madhyapradesh') return 'Madhya Pradesh';
  return text;
}

function buildDynamicPrefixes(plants) {
  const raw = [];
  const generated = [];
  const uploads = [];
  plants.forEach((plant) => {
    const code = String(plant?.code || normalizePlantName(plant?.name) || '').trim().toUpperCase();
    if (code === 'ZETRIC') {
      raw.push('raw/vedanjay/multiple_generator/ZTRIC/');
      generated.push('generated/vedanjay/multiple_generator/ZTRIC/');
      uploads.push('uploads/vedanjay/ZETRIC/');
      return;
    }
    const derived = derivePlantFoldersFromName(plant?.name);
    if (!derived) return;
    raw.push(`raw/vedanjay/${derived.upper}/`);
    raw.push(`raw/${derived.folder}/${derived.lower}/`);
    generated.push(`generated/vedanjay/${derived.upper}/outputs/`);
    generated.push(`generated/${derived.folder}/${derived.lower}/outputs/`);
    uploads.push(`uploads/vedanjay/${derived.upper}/`);
  });
  return {
    raw: Array.from(new Set(raw)),
    generated: Array.from(new Set(generated)),
    uploads: Array.from(new Set(uploads)),
  };
}

function normalizeS3ObjectKey(rawKey) {
  const text = String(rawKey || '').trim();
  if (!text) return '';
  if (text.startsWith('s3://')) {
    const rest = text.slice('s3://'.length);
    const firstSlash = rest.indexOf('/');
    if (firstSlash === -1) return '';
    return rest.slice(firstSlash + 1);
  }
  const amazonKeyIdx = text.indexOf('.amazonaws.com/');
  if (amazonKeyIdx !== -1) {
    return text.slice(amazonKeyIdx + '.amazonaws.com/'.length);
  }
  return text;
}

async function listS3Objects(prefix) {
  try {
    const proxyResp = await fetch('/api/s3/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [prefix], limit: 10000 }),
    });
    if (!proxyResp.ok) return [];
    const payload = await proxyResp.json().catch(() => ({}));
    const items = Array.isArray(payload?.items) ? payload.items : [];
    return items
      .map((item) => ({
        key: String(item?.key || '').trim(),
        lastModified: String(item?.last_modified || item?.lastModified || '').trim(),
      }))
      .filter((item) => item.key);
  } catch {
    return [];
  }
}

async function fetchTextFromS3Key(key) {
  const normalizedKey = normalizeS3ObjectKey(key);
  const encodedKey = String(normalizedKey || '').split('/').map((s) => encodeURIComponent(s)).join('/');
  try {
    const resp = await fetch(`${S3_BASE_URL}/${encodedKey}`);
    if (!resp.ok) throw new Error(`S3 fetch failed: ${resp.status}`);
    return await resp.text();
  } catch {
    const proxyUrl = `/api/s3/text?key=${encodeURIComponent(String(normalizedKey || ''))}`;
    const resp = await fetch(proxyUrl);
    if (!resp.ok) return '';
    return await resp.text();
  }
}

async function listS3ObjectsAcrossPrefixes(prefixes, userOrRole = null) {
  const disabledPattern = getDisabledPlantPattern(userOrRole || getCurrentUserFromStorage());
  const safePrefixes = (prefixes || []).filter((prefix) => prefix && !disabledPattern.test(prefix));
  const settled = await Promise.allSettled(safePrefixes.map((prefix) => listS3Objects(prefix)));
  return settled
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value || []);
}

function getLatestObject(objects, matcher) {
  const extractTrailingNumber = (key) => {
    const fileName = (key || '').split('/').pop() || '';
    const schedMatch = fileName.match(/schedule_from_(\d+)\.csv$/i);
    if (schedMatch) return parseInt(schedMatch[1], 10);
    const trailingMatch = fileName.match(/_(\d+)(?=\.[^.]+$)/);
    return trailingMatch ? parseInt(trailingMatch[1], 10) : null;
  };

  const compareNewestFirst = (a, b) => {
    const aSeq = extractTrailingNumber(a.key);
    const bSeq = extractTrailingNumber(b.key);
    if (aSeq !== null && bSeq !== null && bSeq !== aSeq) return bSeq - aSeq;

    const aTime = Date.parse(a.lastModified || '');
    const bTime = Date.parse(b.lastModified || '');
    const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
    if (timeDiff !== 0) return timeDiff;

    return (b.key || '').localeCompare(a.key || '');
  };

  return (
    objects
      .filter((o) => matcher(o.key))
      .sort(compareNewestFirst)[0] || null
  );
}

function extractTrailingNumber(key) {
  const fileName = (key || '').split('/').pop() || '';
  const schedMatch = fileName.match(/schedule_from_(\d+)\.csv$/i);
  if (schedMatch) return parseInt(schedMatch[1], 10);
  const trailingMatch = fileName.match(/_(\d+)(?=\.[^.]+$)/);
  return trailingMatch ? parseInt(trailingMatch[1], 10) : null;
}

function isFrozenScheduleKey(key) {
  const k = String(key || '').toLowerCase();
  if (k.startsWith('frozenschedules/') || k.includes('/frozenschedules/')) {
    return (
      k.endsWith('.csv') &&
      (k.endsWith('/edited_frozen.csv') || k.endsWith('/system_frozen.csv') || /_frozen\.csv$/i.test(k))
    );
  }
  return (
    k.endsWith('.csv') &&
    k.includes('/frozen/') &&
    (/_frozen\.csv$/i.test(k) || /schedule_free(?:z|ze)_from_\d+\.csv$/i.test(k))
  );
}

function getPlantFrozenFileName(plantName) {
  const text = String(plantName || '').trim();
  if (!text) return '';
  const derived = normalizePlantName(text);
  const codeMatch = derived.match(/\(([A-Za-z0-9_-]+)\)/);
  if (codeMatch?.[1]) return `${codeMatch[1].toUpperCase()}_frozen.csv`;
  if (/^[A-Z0-9_-]+$/.test(derived)) return `${derived}_frozen.csv`;
  return `${derived.replace(/\s+/g, '').toUpperCase()}_frozen.csv`;
}

function isNewerObject(candidate, current) {
  if (!current) return true;
  const cSeq = extractTrailingNumber(candidate.key);
  const pSeq = extractTrailingNumber(current.key);
  if (cSeq !== null && pSeq !== null && cSeq !== pSeq) return cSeq > pSeq;

  const cTime = Date.parse(candidate.lastModified || '');
  const pTime = Date.parse(current.lastModified || '');
  if (!Number.isNaN(cTime) && !Number.isNaN(pTime) && cTime !== pTime) return cTime > pTime;

  return String(candidate.key || '').localeCompare(String(current.key || '')) > 0;
}

function sortLatestFirst(items) {
  return [...items].sort((a, b) => {
    const aSeq = extractTrailingNumber(a.key);
    const bSeq = extractTrailingNumber(b.key);
    if (aSeq !== null && bSeq !== null && bSeq !== aSeq) return bSeq - aSeq;

    const aTime = Date.parse(a.lastModified || '');
    const bTime = Date.parse(b.lastModified || '');
    const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
    if (timeDiff !== 0) return timeDiff;

    return (b.key || '').localeCompare(a.key || '');
  });
}

function parseCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((line) => line && line.trim().length > 0);
  if (!lines.length) return { headers: [], rows: [] };

  const delimiterCandidates = [',', ';', '\t'];
  const headerLine = lines[0];
  const delimiter = delimiterCandidates.reduce(
    (best, candidate) => {
      const count = headerLine.split(candidate).length - 1;
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

  const headers = parseLine(lines[0]).map((h) => h.replace(/^\uFEFF/, '').trim());
  const rows = lines.slice(1).map(parseLine);
  return { headers, rows };
}

function blockToTime(block) {
  const idx = Math.max(0, Number(block) - 1);
  const h = Math.floor((idx * 15) / 60);
  const m = (idx * 15) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function blockToInterval(block) {
  const idx = Math.max(0, Number(block) - 1);
  const startMinutes = idx * 15;
  const endMinutes = startMinutes + 15;
  const formatTime = (mins) => {
    const normalized = ((mins % (24 * 60)) + (24 * 60)) % (24 * 60);
    const h = Math.floor(normalized / 60);
    const m = normalized % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  };
  return `${formatTime(startMinutes)}-${formatTime(endMinutes)}`;
}

function formatDateTime(value) {
  if (!value) return '-';
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return '-';
  return dt.toLocaleString();
}

function getCurrentIstBlock() {
  const now = new Date();
  const istNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const totalMinutes = (istNow.getHours() * 60) + istNow.getMinutes();
  const block = Math.floor(totalMinutes / 15) + 1;
  return Math.min(Math.max(block, 1), 96);
}

function parseScheduleBlocks(text, options = {}) {
  const plantName = normalizePlantName(options.plantName || '');
  const isOsepl = plantName === 'OSEPL';
  const useDeclaredForecastForSchedule = isOsepl || plantName === 'ZETRIC';
  const parseBlock = (raw, idx) => {
    const textVal = String(raw || '').trim();
    if (!textVal) return idx + 1;
    const direct = Number.parseInt(textVal, 10);
    if (Number.isFinite(direct)) return direct;
    const bMatch = textVal.match(/[bB]\s*([0-9]{1,3})/);
    if (bMatch) return Number.parseInt(bMatch[1], 10);
    const anyNum = textVal.match(/([0-9]{1,3})/);
    if (anyNum) return Number.parseInt(anyNum[1], 10);
    return idx + 1;
  };

  const lines = String(text || '').split(/\r?\n/).filter((line) => line && line.trim().length > 0);
  if (!lines.length) return [];

  const delimiterCandidates = [',', ';', '\t'];
  const bestHeaderLine = lines.find((line) => /block/i.test(line)) || lines[0];
  const delimiter = delimiterCandidates.reduce(
    (best, candidate) => {
      const count = bestHeaderLine.split(candidate).length - 1;
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

  const parsedRows = lines.map(parseLine);
  // Compact key so headers like "Scheduled (MW)" match "scheduledmw".
  const normalize = (value) =>
    String(value || '')
      .toLowerCase()
      .replace(/["']/g, '')
      .replace(/[^a-z0-9]+/g, '');
  const headerRowIndex = parsedRows.findIndex((row) => {
    const c0 = normalize(row?.[0]);
    if (c0 !== 'block') return false;
    const rowNormalized = (row || []).map(normalize);
    return rowNormalized.some((cell) =>
      cell.includes('blockinterval') ||
      cell.includes('timeperiod') ||
      cell.includes('forecast') ||
      cell.includes('declaredforecast') ||
      cell.includes('stationschedule') ||
      cell.includes('schedule') ||
      cell.includes('avc')
    );
  });

  if (headerRowIndex >= 0) {
    let dataStart = headerRowIndex + 1;
    const headerNormalized = (parsedRows[headerRowIndex] || []).map(normalize);
    const isBlockInterval = headerNormalized.some((h) => h.includes('blockinterval'));
    let forecastCol = headerNormalized.findIndex((h) => h.includes('forecast'));
    const declaredForecastCol = headerNormalized.findIndex((h) => h.includes('declaredforecast'));
    if (declaredForecastCol >= 0) forecastCol = declaredForecastCol;
    const scheduledMwCol = headerNormalized.findIndex((h) => h === 'scheduledmw');
    const algoCol = headerNormalized.findIndex((h) =>
      h.includes('algoschedule') ||
      h.includes('systemschedule') ||
      h.includes('finalschedule') ||
      h.includes('scheduledmw') ||
      h === 'schedule' ||
      h.includes('scheduled')
    );
    const baseCol = headerNormalized.findIndex((h) => h.includes('baseforecast'));
    const intradayCol = headerNormalized.findIndex((h) => h.includes('intraday'));
    let stationScheduleCol = headerNormalized.findIndex((h) => h.includes('stationschedule'));
    let avcCol = headerNormalized.findIndex((h) => h.includes('avc') && !h.includes('capacity'));
    if (avcCol === -1) {
      avcCol = headerNormalized.findIndex((h) => h.includes('availability') && !h.includes('capacity'));
    }

    if (isBlockInterval) {
      let subHeaderForecastCol = -1;
      const maybeSubHeader = parsedRows[dataStart] || [];
      const subNormalized = maybeSubHeader.map(normalize);
      subHeaderForecastCol = subNormalized.findIndex((h) => h.includes('forecast'));
      const subDeclaredForecastCol = subNormalized.findIndex((h) => h.includes('declaredforecast'));
      if (subDeclaredForecastCol >= 0) subHeaderForecastCol = subDeclaredForecastCol;
      if (subHeaderForecastCol >= 0) {
        forecastCol = subHeaderForecastCol;
        dataStart += 1;
      }
    } else {
      // Telangana template (Block, Time Period, Forecast(MW), AvC(MW), Station Schedule)
      if (forecastCol === -1) forecastCol = 2;
      if (avcCol === -1) avcCol = 3;
      if (stationScheduleCol === -1) stationScheduleCol = 4;
    }

    return parsedRows
      .slice(dataStart)
      .map((cols, idx) => {
        const block = parseBlock(cols?.[0], idx);
        const stationRaw = String(cols?.[stationScheduleCol] ?? '').trim();
        const forecastRaw = String(cols?.[forecastCol] ?? '').trim();
        const avcRaw = avcCol >= 0 ? String(cols?.[avcCol] ?? '').trim() : '';
        const scheduledMwRaw = scheduledMwCol >= 0 ? String(cols?.[scheduledMwCol] ?? '').trim() : '';
        const algoRaw = algoCol >= 0 ? String(cols?.[algoCol] ?? '').trim() : '';
        const baseRaw = baseCol >= 0 ? String(cols?.[baseCol] ?? '').trim() : '';
        const intradayRaw = intradayCol >= 0 ? String(cols?.[intradayCol] ?? '').trim() : '';
        const scheduledMwVal = parseFloat(scheduledMwRaw);
        const algoVal = parseFloat(algoRaw);
        const baseVal = parseFloat(baseRaw);
        const intradayVal = parseFloat(intradayRaw);
        const stationVal = parseFloat(stationRaw);
        const forecastVal = parseFloat(forecastRaw);
        const avcVal = parseFloat(avcRaw);
        const hasFrozenScheduledMw = scheduledMwCol >= 0;
        const useScheduledMw = Number.isFinite(scheduledMwVal);
        const useAlgo = Number.isFinite(algoVal);
        const useBase = Number.isFinite(baseVal);
        const useIntraday = Number.isFinite(intradayVal);
        const useForecast = Number.isFinite(forecastVal);

        // OSEPL/ZETRIC: scheduled value must come from Declared Forecast.
        const scheduled = useDeclaredForecastForSchedule
          ? (useForecast ? forecastVal : NaN)
          : hasFrozenScheduledMw
            ? (useScheduledMw ? scheduledMwVal : NaN)
            : useAlgo
              ? algoVal
              : useBase
                ? baseVal
                : useIntraday
                  ? intradayVal
                  : Number.isFinite(stationVal)
                    ? stationVal
                    : (useForecast ? forecastVal : 0);
        const scheduledText = useDeclaredForecastForSchedule
          ? (useForecast ? forecastRaw : '')
          : hasFrozenScheduledMw
            ? (useScheduledMw ? scheduledMwRaw : '')
            : useAlgo
              ? algoRaw
              : useBase
                ? baseRaw
                : useIntraday
                  ? intradayRaw
                  : Number.isFinite(stationVal)
                    ? stationRaw
                    : (useForecast ? forecastRaw : '0');
        return {
          block,
          scheduled,
          scheduledText,
          avcMw: Number.isFinite(avcVal) ? avcVal : null,
          avcText: avcRaw,
        };
      })
      .filter((r) => Number.isFinite(r.block) && r.block >= 1 && r.block <= 96);
  }

  const { headers, rows } = parseCsv(text);
  const normalized = headers.map((h) =>
    String(h || '')
      .toLowerCase()
      .replace(/["']/g, '')
      .replace(/[^a-z0-9]+/g, '')
  );
  const blockCol = normalized.findIndex((h) => h.includes('block'));
  let forecastCol = normalized.findIndex((h) => h.includes('forecast'));
  const declaredForecastCol = normalized.findIndex((h) => h.includes('declaredforecast'));
  if (declaredForecastCol >= 0) forecastCol = declaredForecastCol;
  const scheduledColExact = normalized.findIndex((h) => h === 'scheduledmw');
  const scheduledCol = scheduledColExact !== -1 ? scheduledColExact : normalized.findIndex((h) => h.includes('scheduledmw'));
  const algoCol = normalized.findIndex((h) =>
    h.includes('algoschedule') ||
    h.includes('systemschedule') ||
    h.includes('finalschedule') ||
    h.includes('scheduledmw') ||
    h === 'schedule' ||
    h.includes('scheduled')
  );
  const baseCol = normalized.findIndex((h) => h.includes('baseforecast'));
  const intradayCol = normalized.findIndex((h) => h.includes('intradayforecast') || h.includes('intraday'));
  const hasFrozenScheduledMw = scheduledColExact >= 0;
  let avcCol = normalized.findIndex((h) => h.includes('avc') && !h.includes('capacity'));
  if (avcCol === -1) {
    avcCol = normalized.findIndex((h) => h.includes('availability') && !h.includes('capacity'));
  }

  return rows
    .map((cols, idx) => {
      const block = parseBlock(blockCol >= 0 ? cols[blockCol] : '', idx);
      const forecastRaw = forecastCol >= 0 ? String(cols[forecastCol] ?? '').trim() : '';
      const avcRaw = avcCol >= 0 ? String(cols[avcCol] ?? '').trim() : '';
      const scheduledRaw = scheduledCol >= 0 ? String(cols[scheduledCol] ?? '').trim() : '';
      const algoRaw = algoCol >= 0 ? String(cols[algoCol] ?? '').trim() : '';
      const baseRaw = baseCol >= 0 ? String(cols[baseCol] ?? '').trim() : '';
      const intradayRaw = intradayCol >= 0 ? String(cols[intradayCol] ?? '').trim() : '';
      const forecast = parseFloat(forecastRaw);
      const avcVal = parseFloat(avcRaw);
      const scheduledMw = parseFloat(scheduledRaw);
      const algo = parseFloat(algoRaw);
      const base = parseFloat(baseRaw);
      const intraday = parseFloat(intradayRaw);
      const useForecast = Number.isFinite(forecast);
      const useScheduledMw = Number.isFinite(scheduledMw);
      const useAlgo = Number.isFinite(algo);
      const useBase = Number.isFinite(base);
      const useIntraday = Number.isFinite(intraday);
      const useAlgoOverride = isOsepl && useAlgo && !useForecast;
      // OSEPL: allow a legacy override path when Forecast is missing but Algo exists.
      // ZETRIC requires Declared Forecast with no schedule-column fallback.
      const scheduled = useDeclaredForecastForSchedule
        ? (useForecast ? forecast : (useAlgoOverride ? algo : NaN))
        : hasFrozenScheduledMw
          ? (useScheduledMw ? scheduledMw : NaN)
          : (useAlgo ? algo : (useBase ? base : (useIntraday ? intraday : (useForecast ? forecast : 0))));
      const scheduledText = useDeclaredForecastForSchedule
        ? (useForecast ? forecastRaw : (useAlgoOverride ? algoRaw : ''))
        : hasFrozenScheduledMw
          ? (useScheduledMw ? scheduledRaw : '')
          : (useAlgo ? algoRaw : (useBase ? baseRaw : (useIntraday ? intradayRaw : (useForecast ? forecastRaw : '0'))));
      return {
        block,
        scheduled,
        scheduledText,
        avcMw: Number.isFinite(avcVal) ? avcVal : null,
        avcText: avcRaw,
      };
    })
    .filter((r) => Number.isFinite(r.block) && r.block >= 1 && r.block <= 96);
}

function parseMeterBlocks(text, options = {}) {
  const { headers, rows } = parseCsv(text);
  const normalized = headers.map((h) => h.toLowerCase().replace(/["']/g, '').replace(/\s+/g, ' ').trim());
  const compactHeaders = headers.map((h) =>
    String(h || '')
      .toLowerCase()
      .replace(/["']/g, '')
      .replace(/[^a-z0-9]+/g, '')
  );
  const blockIdx = compactHeaders.findIndex((h) => h.includes('block'));
  const timeIdx = compactHeaders.findIndex((h) =>
    h.includes('time') || h.includes('timestamp') || h.includes('datetime')
  );
  let powerIdx = compactHeaders.findIndex((h) =>
    h === 'mw' ||
    h.endsWith('mw') ||
    h.includes('meterpower') ||
    h.includes('activepower') ||
    h.includes('generation') ||
    h.includes('power') ||
    h.includes('kw')
  );
  if (powerIdx === -1) {
    powerIdx = normalized.findIndex((h) =>
      h.includes('meter power') ||
      h.includes('active power') ||
      h.includes('generation') ||
      h.includes('kw') ||
      h.includes('mw') ||
      h.includes('inv power') ||
      h.includes('solar')
    );
  }

  if (powerIdx === -1) {
    // Fallback: pick the most plausible numeric column (excluding time/date/block columns).
    const ignored = (h) => h.includes('time') || h.includes('date') || h.includes('block');
    let best = { idx: -1, score: -1 };
    for (let col = 0; col < headers.length; col += 1) {
      if (ignored(normalized[col] || '')) continue;
      let numericCount = 0;
      let absSum = 0;
      const sampleRows = rows.slice(0, Math.min(rows.length, 192));
      sampleRows.forEach((r) => {
        const v = parseFloat(String(r[col] ?? '').replace(/,/g, '').trim());
        if (Number.isFinite(v)) {
          numericCount += 1;
          absSum += Math.abs(v);
        }
      });
      if (!numericCount) continue;
      const avgAbs = absSum / numericCount;
      const score = (numericCount * 1000) + avgAbs;
      if (score > best.score) {
        best = { idx: col, score };
      }
    }
    powerIdx = best.idx;
  }

  if (powerIdx === -1) return [];

  const parseBlockFromRaw = (raw) => {
    const textVal = String(raw ?? '').trim();
    if (!textVal) return null;
    const direct = Number.parseInt(textVal, 10);
    if (Number.isFinite(direct) && direct >= 1 && direct <= 96) return direct;
    const bMatch = textVal.match(/[bB]\s*([0-9]{1,3})/);
    if (bMatch) {
      const block = Number.parseInt(bMatch[1], 10);
      if (Number.isFinite(block) && block >= 1 && block <= 96) return block;
    }
    return null;
  };

  const parseBlockFromTime = (raw) => parseBlockFromTimestamp(raw, { totalBlocks: 96 });

  // Detect unit from header text; fallback to heuristic when unit is unclear.
  const powerHeader = normalized[powerIdx] || '';
  const compactPowerHeader = compactHeaders[powerIdx] || '';
  const explicitKw =
    compactPowerHeader === 'kw' ||
    compactPowerHeader.endsWith('kw') ||
    powerHeader.includes('(kw)') ||
    powerHeader.includes(' kw');
  const explicitMw =
    compactPowerHeader === 'mw' ||
    compactPowerHeader.endsWith('mw') ||
    powerHeader.includes('(mw)') ||
    powerHeader.includes(' mw') ||
    powerHeader === 'mw' ||
    powerHeader.endsWith('mw');
  const explicitW = powerHeader.includes('(w)') || powerHeader.endsWith(' w');

  const parsedRaw = rows.map((cols, idx) => {
    const raw = cols[powerIdx];
    const value = parseFloat(String(raw ?? '').replace(/,/g, '').trim());
    const hasReading = raw !== undefined && raw !== null && String(raw).trim() !== '' && Number.isFinite(value);
    const blockFromColumn = blockIdx >= 0 ? parseBlockFromRaw(cols[blockIdx]) : null;
    const timeRaw = timeIdx >= 0 ? cols[timeIdx] : null;
    const hasTimeColumn = timeIdx >= 0;
    const blockFromTime = hasTimeColumn ? parseBlockFromTime(timeRaw) : null;
    let derivedBlock = null;
    if (blockFromColumn !== null) {
      derivedBlock = blockFromColumn;
    } else if (blockFromTime !== null) {
      derivedBlock = blockFromTime;
    } else if (!hasTimeColumn) {
      derivedBlock = idx + 1;
    }
    const block = Number.isFinite(derivedBlock) ? Math.min(Math.max(derivedBlock, 1), 96) : null;
    return { hasReading, value: hasReading ? value : null, block };
  });
  const nonZero = parsedRaw.map((x) => x.value).filter((v) => Number.isFinite(v) && v > 0);
  const avg = nonZero.length ? (nonZero.reduce((a, b) => a + b, 0) / nonZero.length) : 0;
  const factor = explicitW
    ? (1 / 1_000_000)
    : resolveMeterMwFactor({
        plantCode: options?.plantCode || options?.plant_code,
        plantName: options?.plantName || options?.plant_name,
        sourceKey: options?.sourceKey || options?.source_key,
        explicitKw,
        explicitMw,
        averageValue: avg,
      });

  // Keep latest reading for each block when duplicates exist.
  const byBlock = new Map();
  parsedRaw.forEach((item) => {
    if (!item.hasReading || !Number.isFinite(item.block)) return;
    const actual = item.value * factor;
    byBlock.set(item.block, { block: item.block, actual, actualText: String(actual) });
  });

  return Array.from(byBlock.values()).sort((a, b) => a.block - b.block);
}

function extractPlantFromKey(key, selectedDate) {
  const normalizedKey = String(key || '').replace(/\\/g, '/');
  const lowerKey = normalizedKey.toLowerCase();
  const frozenMatch = lowerKey.match(/frozenschedules\/vedanjay\/([^/]+)\//);
  if (frozenMatch?.[1]) {
    return normalizePlantName(frozenMatch[1]);
  }
  const vedanjayMatch = lowerKey.match(/generated\/vedanjay\/([^/]+)\//);
  if (vedanjayMatch?.[1]) {
    return normalizePlantName(vedanjayMatch[1]);
  }
  const rawVedanjayMatch = lowerKey.match(/raw\/vedanjay\/([^/]+)\//);
  if (rawVedanjayMatch?.[1]) {
    return normalizePlantName(rawVedanjayMatch[1]);
  }
  if (lowerKey.includes('uploads/vedanjay/')) {
    const parts = normalizedKey.split('/').filter(Boolean);
    const uploadsIdx = parts.findIndex((p) => p.toLowerCase() === 'uploads');
    if (uploadsIdx >= 0 && parts[uploadsIdx + 2]) {
      return normalizePlantName(parts[uploadsIdx + 2]);
    }
  }
  if (lowerKey.includes('/sirmour/sirmour/')) return S3_SECONDARY_PLANT;
  if (lowerKey.includes('/gsnp/gsnp/')) return 'GSNP';
  const datePrefixes = getSchedulePrefixes(selectedDate);
  const rootDatePrefix = `${selectedDate}/`;

  for (const datePrefix of datePrefixes) {
    if (normalizedKey.startsWith(datePrefix)) {
      const rest = normalizedKey.slice(datePrefix.length);
      const seg = rest.split('/').filter(Boolean);
      if (seg.length > 1) {
        const first = seg[0].toLowerCase();
        if (!['meter', 'intraday', 'weather', 'reports', 'metered_data', 'weather_data', 'enercast_data'].includes(first)) {
          return normalizePlantName(seg[0]);
        }
      }
    }
  }

  // Pattern A (root): {date}/{plant}/...
  if (normalizedKey.startsWith(rootDatePrefix)) {
    const rest = normalizedKey.slice(rootDatePrefix.length);
    const seg = rest.split('/').filter(Boolean);
    if (seg.length > 1) {
      const first = seg[0].toLowerCase();
      if (!['meter', 'intraday', 'weather', 'reports'].includes(first)) {
        return normalizePlantName(seg[0]);
      }
    }
  }

  const parts = normalizedKey.split('/').filter(Boolean);
  const dateIdx = parts.findIndex((p) => p === selectedDate);
  if (parts[0] === 'outputs' && dateIdx === 2) {
    return normalizePlantName(parts[1]);
  }

  return null;
}

function getPlantTypeFromName(name) {
  if (name === S3_PRIMARY_PLANT || name === S3_SECONDARY_PLANT) return 'Solar';
  const n = String(name || '').toLowerCase();
  if (n.includes('wind')) return 'Wind';
  if (n.includes('solar') || n.includes('pv')) return 'Solar';
  return 'Solar';
}

function getAllowedLimitPercent(plantName, plantState, plantType) {
  const config = DSM_PENALTY_CONFIG_BY_STATE[normalizeStateName(plantState)] || DEFAULT_DSM_PENALTY_CONFIG;
  const typeConfig = config.byType?.[plantType] || config.byType?.Solar;
  return typeConfig?.baseBand ?? DSM_DEFAULT_ALLOWED_LIMIT_PERCENT;
}

function getPenaltyConfig(plantState, plantType) {
  const config = DSM_PENALTY_CONFIG_BY_STATE[normalizeStateName(plantState)] || DEFAULT_DSM_PENALTY_CONFIG;
  return config.byType?.[plantType] || config.byType?.Solar || { bands: [] };
}

function formatMw(value, fallback = '0') {
  const num = typeof value === 'number' ? value : Number.parseFloat(String(value ?? '').trim());
  if (!Number.isFinite(num)) return fallback;
  return num.toFixed(3);
}

function formatMwNoRound(value, decimals = 2, fallback = '--') {
  const num = typeof value === 'number' ? value : Number.parseFloat(String(value ?? '').trim());
  if (!Number.isFinite(num)) return fallback;
  const factor = 10 ** decimals;
  const truncated = num >= 0 ? Math.floor(num * factor) / factor : Math.ceil(num * factor) / factor;
  return truncated.toFixed(decimals);
}

function calcAccuracyPercent(scheduledMw, actualMw) {
  const scheduled = Number(scheduledMw);
  const actual = Number(actualMw);
  if (!Number.isFinite(scheduled) || !Number.isFinite(actual)) return null;
  if (Math.abs(actual) <= EPSILON) {
    return Math.abs(scheduled) <= EPSILON ? 100 : 0;
  }
  const raw = (1 - (Math.abs(actual - scheduled) / Math.abs(actual))) * 100;
  if (!Number.isFinite(raw)) return 0;
  return Math.min(100, Math.max(0, raw));
}

function getPenaltyRateForDeviationPercent(absDeviationPercent, plantState, plantType) {
  const config = getPenaltyConfig(plantState, plantType);
  const band = (config.bands || []).find(
    (b) => absDeviationPercent >= b.min && absDeviationPercent < b.max
  );
  return band ? band.rate : 0;
}

function getDsmBandForBlock(scheduledMw, plantName, capacityMw, plantState, plantType) {
  const bandPercent = getAllowedLimitPercent(plantName, plantState, plantType);
  const capacityAbs = Math.abs(Number(capacityMw) || 0);
  const allowedMw = (capacityAbs * bandPercent) / 100;
  return {
    bandPercent,
    allowedMw,
    lowerLimitMw: scheduledMw - allowedMw,
    upperLimitMw: scheduledMw + allowedMw,
  };
}

function getSchedulePrefixes(date, prefixes = {}) {
  const {
    rawPrefixes = RAW_BASE_PREFIXES,
    generatedPrefixes = GENERATED_OUTPUTS_BASE_PREFIXES,
    uploadsPrefixes = UPLOADS_BASE_PREFIXES,
  } = prefixes;
  return [
    ...rawPrefixes.map((prefix) => `${prefix}${date}/`),
    ...generatedPrefixes.map((prefix) => `${prefix}${date}/`),
    ...uploadsPrefixes.map((prefix) => `${prefix}${date}/`),
    `${LEGACY_OUTPUTS_BASE_PREFIX}${date}/`,
  ];
}

function getFrozenSchedulePrefixes(date, prefixes = {}) {
  const {
    generatedPrefixes = GENERATED_OUTPUTS_BASE_PREFIXES,
  } = prefixes;
  return [
    ...generatedPrefixes.map((prefix) => `${prefix}${date}/frozen/`),
    `${LEGACY_OUTPUTS_BASE_PREFIX}${date}/frozen/`,
    ...FROZEN_ARTIFACT_BASE_PREFIXES.map((prefix) => `${prefix}${date}/`),
  ];
}

function isScheduleCsvKey(key) {
  const k = String(key || '').toLowerCase();
  const fileName = k.split('/').pop() || '';
  return (
    k.endsWith('.csv') &&
    !k.includes('/intraday/') &&
    (
      k.includes('schedule_from_') ||
      fileName.startsWith('gsnp_dc_reg_') ||
      fileName.includes('_sldc_template')
    )
  );
}

function isUploadedTemplateCsvKey(key) {
  const k = String(key || '').toLowerCase();
  return k.endsWith('.csv') && k.includes('uploads/vedanjay/') && (k.includes('sldc_template') || k.includes('template'));
}

function keyMatchesDate(key, selectedDate, prefixes = {}) {
  const {
    rawPrefixes = RAW_BASE_PREFIXES,
    generatedPrefixes = GENERATED_OUTPUTS_BASE_PREFIXES,
    uploadsPrefixes = UPLOADS_BASE_PREFIXES,
  } = prefixes;
  const normalizedKey = String(key || '');
  return (
    normalizedKey.includes(`/${selectedDate}/`) ||
    normalizedKey.startsWith(`${selectedDate}/`) ||
    rawPrefixes.some((prefix) => normalizedKey.startsWith(`${prefix}${selectedDate}/`)) ||
    generatedPrefixes.some((prefix) => normalizedKey.startsWith(`${prefix}${selectedDate}/`)) ||
    uploadsPrefixes.some((prefix) => normalizedKey.startsWith(`${prefix}${selectedDate}/`)) ||
    normalizedKey.startsWith(`${LEGACY_OUTPUTS_BASE_PREFIX}${selectedDate}/`)
  );
}

export function DeviationDSM() {
  const themeContext = useTheme();
  const isDarkMode = Boolean(themeContext?.isDarkMode);
  const [selectedDate, setSelectedDate] = useState(() => getIstDateKey());
  const [selectedPlant, setSelectedPlant] = useState('Select Plant');
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);
  const [availablePlants, setAvailablePlants] = useState([]);
  const [scheduleFileByPlant, setScheduleFileByPlant] = useState({});
  const [scheduleUploadedAtByPlant, setScheduleUploadedAtByPlant] = useState({});
  const [scheduleOptionsByPlant, setScheduleOptionsByPlant] = useState({});
  const [selectedScheduleKeyByPlant, setSelectedScheduleKeyByPlant] = useState({});
  const [showTrendFullscreen, setShowTrendFullscreen] = useState(false);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [downloadFormat, setDownloadFormat] = useState('csv');

  const { data: apiPlantsData } = useApi(
    () => api.plants.getAll({ noMock: true }),
    { immediate: true, initialData: { plants: [], total: 0, stats: {} } }
  );

  const apiPlantNames = useMemo(
    () => (apiPlantsData?.plants || [])
      .map((p) => normalizePlantName(p.name))
      .filter((name) => name && !isBlockedPlant(name)),
    [apiPlantsData]
  );

  const plantStateByName = useMemo(() => {
    const entries = (apiPlantsData?.plants || [])
      .map((p) => [normalizePlantName(p.name), normalizeStateName(p.state)])
      .filter(([name]) => name && !isBlockedPlant(name));
    return Object.fromEntries(entries);
  }, [apiPlantsData]);

  const plantTypeByName = useMemo(() => {
    const entries = (apiPlantsData?.plants || [])
      .map((p) => [normalizePlantName(p.name), p.type])
      .filter(([name]) => name && !isBlockedPlant(name));
    return Object.fromEntries(entries);
  }, [apiPlantsData]);

  const plantCapacityByName = useMemo(() => {
    const entries = (apiPlantsData?.plants || [])
      .map((p) => {
        const name = normalizePlantName(p.name);
        const cap =
          Number.isFinite(Number(p.capacityMw)) ? Number(p.capacityMw)
            : Number.isFinite(Number(p.capacity_mw)) ? Number(p.capacity_mw)
              : Number.isFinite(Number(p.capacity)) ? Number(p.capacity)
                : null;
        return [name, cap];
      })
      .filter(([name, cap]) => name && Number.isFinite(cap) && !isBlockedPlant(name));
    return Object.fromEntries(entries);
  }, [apiPlantsData]);

  const dynamicPrefixes = useMemo(
    () => buildDynamicPrefixes((apiPlantsData?.plants || []).filter((p) => !isBlockedPlant(p.name))),
    [apiPlantsData]
  );

  const plantFilterOptions = useMemo(
    () =>
      [
        'Select Plant',
        ...Array.from(
          new Set(
            [S3_PRIMARY_PLANT, S3_SECONDARY_PLANT, ...availablePlants, ...apiPlantNames]
              .map(normalizePlantName)
              .filter((name) => name && !isBlockedPlant(name) && name !== S3_PRIMARY_PLANT)
          )
        ),
      ],
    [availablePlants, apiPlantNames]
  );

  useEffect(() => {
    if (selectedPlant !== 'Select Plant' && !plantFilterOptions.includes(selectedPlant)) {
      setSelectedPlant('Select Plant');
    }
  }, [plantFilterOptions, selectedPlant]);

  useEffect(() => {
    const loadBlockwise = async () => {
      setLoading(true);
      try {
        const frozenScheduleObjects = await listS3ObjectsAcrossPrefixes(
          getFrozenSchedulePrefixes(selectedDate, {
            generatedPrefixes: [...GENERATED_OUTPUTS_BASE_PREFIXES, ...dynamicPrefixes.generated],
          })
        );
        const dateScopedObjectsOutputs = await listS3ObjectsAcrossPrefixes(
          getSchedulePrefixes(selectedDate, {
            rawPrefixes: [...RAW_BASE_PREFIXES, ...dynamicPrefixes.raw],
            generatedPrefixes: [...GENERATED_OUTPUTS_BASE_PREFIXES, ...dynamicPrefixes.generated],
            uploadsPrefixes: [...UPLOADS_BASE_PREFIXES, ...dynamicPrefixes.uploads],
          })
        );
        const dateScopedObjectsRoot = await listS3Objects(`${selectedDate}/`);
        const rootObjects = await listS3Objects(LEGACY_OUTPUTS_BASE_PREFIX);
        let allObjects = [...dateScopedObjectsOutputs, ...dateScopedObjectsRoot, ...rootObjects].filter((o) =>
          keyMatchesDate(o.key, selectedDate, {
            rawPrefixes: [...RAW_BASE_PREFIXES, ...dynamicPrefixes.raw],
            generatedPrefixes: [...GENERATED_OUTPUTS_BASE_PREFIXES, ...dynamicPrefixes.generated],
            uploadsPrefixes: [...UPLOADS_BASE_PREFIXES, ...dynamicPrefixes.uploads],
          })
        );

        if (!allObjects.length) {
          const broadPrefixes = [
            ...RAW_BASE_PREFIXES,
            ...GENERATED_OUTPUTS_BASE_PREFIXES,
            ...UPLOADS_BASE_PREFIXES,
            ...dynamicPrefixes.raw,
            ...dynamicPrefixes.generated,
            ...dynamicPrefixes.uploads,
            LEGACY_OUTPUTS_BASE_PREFIX,
          ];
          const broadObjects = await listS3ObjectsAcrossPrefixes(broadPrefixes);
          allObjects = broadObjects.filter((o) =>
            keyMatchesDate(o.key, selectedDate, {
              rawPrefixes: [...RAW_BASE_PREFIXES, ...dynamicPrefixes.raw],
              generatedPrefixes: [...GENERATED_OUTPUTS_BASE_PREFIXES, ...dynamicPrefixes.generated],
              uploadsPrefixes: [...UPLOADS_BASE_PREFIXES, ...dynamicPrefixes.uploads],
            })
          );
        }

        const frozenCandidates = (frozenScheduleObjects || []).filter((obj) => isFrozenScheduleKey(obj.key));

        if (!frozenCandidates.length) {
          setRows([]);
          setAvailablePlants([]);
          setScheduleFileByPlant({});
          setScheduleUploadedAtByPlant({});
          toast.error(`No frozen schedule found in S3 for ${selectedDate}`);
          return;
        }

        const todayIst = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        const isTodaySelected = selectedDate === todayIst;
        const currentIstBlock = isTodaySelected ? getCurrentIstBlock() : 96;

        const plantToSchedule = new Map();
        const plantToScheduleOptions = new Map();
        const plantToMeter = new Map();

        const upsertScheduleOption = (plant, candidate) => {
          if (!plant || !candidate?.key) return;
          const plantKey = normalizePlantName(plant);
          if (!plantKey) return;
          let store = plantToScheduleOptions.get(plantKey);
          if (!store) {
            store = new Map();
            plantToScheduleOptions.set(plantKey, store);
          }
          const prev = store.get(candidate.key);
          if (!prev) {
            store.set(candidate.key, candidate);
            return;
          }
          const merged = { ...prev, ...candidate };
          if (!prev?.csvText && candidate?.csvText) {
            merged.csvText = candidate.csvText;
          }
          if (isNewerObject(candidate, prev)) {
            merged.lastModified = candidate.lastModified;
          }
          store.set(candidate.key, merged);
        };

        // Use frozen schedule per plant/date for penalty calculation.
        const compareFrozenCandidate = (a, b) => {
          const kindRank = (item) => {
            const kind = String(item?.frozenKind || '').toLowerCase();
            if (kind === 'edited') return 3;
            if (kind === 'system') return 2;
            if (kind === 'legacy') return 1;
            return 0;
          };
          const aRank = kindRank(a);
          const bRank = kindRank(b);
          if (aRank !== bRank) return aRank - bRank;
          if (isNewerObject(a, b)) return 1;
          if (isNewerObject(b, a)) return -1;
          return 0;
        };

        frozenCandidates.forEach((obj) => {
          const plant = normalizePlantName(extractPlantFromKey(obj.key, selectedDate) || S3_PRIMARY_PLANT);
          if (isBlockedPlant(plant)) return;

          const keyLower = String(obj.key || '').toLowerCase();
          const fileName = String(obj.key || '').split('/').pop() || '';
          const fileNameLower = fileName.toLowerCase();
          const isFrozenArtifact = keyLower.startsWith('frozenschedules/') || keyLower.includes('/frozenschedules/');

          let frozenKind = 'legacy';
          if (isFrozenArtifact) {
            if (fileNameLower === 'edited_frozen.csv') frozenKind = 'edited';
            else if (fileNameLower === 'system_frozen.csv') frozenKind = 'system';
            else if (/_frozen\.csv$/i.test(fileNameLower)) frozenKind = 'legacy';
            else return;
          } else {
            // Older frozen convention: outputs/<date>/frozen/<PLANT>_frozen.csv
            const expectedFrozenName = getPlantFrozenFileName(plant);
            if (expectedFrozenName && fileNameLower !== expectedFrozenName.toLowerCase()) return;
            frozenKind = 'legacy';
          }

          const frozenCandidate = { ...obj, isFrozen: true, frozenKind };
          upsertScheduleOption(plant, frozenCandidate);

          const prev = plantToSchedule.get(plant);
          if (!prev || compareFrozenCandidate(frozenCandidate, prev) > 0) {
            // Force "best" frozen schedule to be the selected schedule for penalty calculation.
            plantToSchedule.set(plant, frozenCandidate);
          }
        });

        if (!plantToScheduleOptions.size) {
          setRows([]);
          setAvailablePlants([]);
          setScheduleFileByPlant({});
          setScheduleUploadedAtByPlant({});
          setScheduleOptionsByPlant({});
          toast.error(`No frozen schedule found for ${selectedDate}`);
          return;
        }

        const selectedScheduleMap = { ...selectedScheduleKeyByPlant };
        let selectedScheduleChanged = false;
        const scheduleOptionsMap = {};

        const pickLatestCandidate = (items = []) =>
          items.reduce((best, candidate) => (isNewerObject(candidate, best) ? candidate : best), null);

        Array.from(plantToScheduleOptions.entries()).forEach(([plant, optionMap]) => {
          const options = Array.from(optionMap.values());
          options.sort((a, b) => {
            const aFrozen = Boolean(a?.isFrozen);
            const bFrozen = Boolean(b?.isFrozen);
            if (aFrozen !== bFrozen) return aFrozen ? -1 : 1;
            if (aFrozen && bFrozen) {
              const kindRank = (item) => {
                const kind = String(item?.frozenKind || '').toLowerCase();
                if (kind === 'edited') return 3;
                if (kind === 'system') return 2;
                if (kind === 'legacy') return 1;
                return 0;
              };
              const aKind = kindRank(a);
              const bKind = kindRank(b);
              if (aKind !== bKind) return bKind - aKind;
            }
            const aTime = Date.parse(a.lastModified || '');
            const bTime = Date.parse(b.lastModified || '');
            const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
            if (timeDiff !== 0) return timeDiff;
            return (b.key || '').localeCompare(a.key || '');
          });
          scheduleOptionsMap[plant] = options;
          const selectedKeyRaw = selectedScheduleMap[plant];
          const selectedKey = normalizeS3ObjectKey(selectedKeyRaw);
          const selectedOption = selectedKey ? options.find((o) => o.key === selectedKey) : null;
          if (selectedKeyRaw && selectedKeyRaw !== selectedKey) {
            selectedScheduleMap[plant] = selectedKey;
            selectedScheduleChanged = true;
          }

          // Default: prefer edited_frozen.csv when no explicit selection exists.
          const preferredEdited = options.find((o) => Boolean(o?.isFrozen) && String(o?.frozenKind || '').toLowerCase() === 'edited');
          const latestOption = selectedOption || preferredEdited || pickLatestCandidate(options);
          if (latestOption) {
            plantToSchedule.set(plant, latestOption);
            if (!selectedOption || selectedKey !== latestOption.key) {
              selectedScheduleMap[plant] = latestOption.key;
              selectedScheduleChanged = true;
            }
          }
        });

        allObjects.forEach((obj) => {
          const keyLower = obj.key.toLowerCase();
          const plant = normalizePlantName(extractPlantFromKey(obj.key, selectedDate) || S3_PRIMARY_PLANT);
          if (isBlockedPlant(plant)) return;

          if ((keyLower.includes('/meter/') || keyLower.includes('/metered_data/')) && keyLower.endsWith('.csv')) {
            const prev = plantToMeter.get(plant);
            if (isNewerObject(obj, prev)) {
              plantToMeter.set(plant, obj);
            }
          }
        });

        const plants = Array.from(
          new Set([...plantToSchedule.keys()].map(normalizePlantName).filter((p) => p && !isBlockedPlant(p)))
        );
        const scheduleFileNameMap = Object.fromEntries(
          plants.map((plant) => [plant, (plantToSchedule.get(plant)?.key || '').split('/').pop() || 'N/A'])
        );
        const scheduleUploadedAtMap = Object.fromEntries(
          plants.map((plant) => [plant, plantToSchedule.get(plant)?.lastModified || null])
        );
        setScheduleFileByPlant(scheduleFileNameMap);
        setScheduleUploadedAtByPlant(scheduleUploadedAtMap);
        setScheduleOptionsByPlant(scheduleOptionsMap);
        if (selectedScheduleChanged) {
          setSelectedScheduleKeyByPlant(selectedScheduleMap);
        }
        setAvailablePlants(plants);
        if (selectedPlant !== 'Select Plant' && plants.length && !plants.includes(selectedPlant)) {
          setSelectedPlant('Select Plant');
        }

        const allRows = [];
        const parseWarnings = [];
        for (const plant of plants) {
          const scheduleFile = plantToSchedule.get(plant);

          const [scheduleText] = await Promise.all([
            scheduleFile
              ? (
                  // Prefer inline CSV (from upload history) to avoid S3 403/CORS issues; fall back to fetching object.
                  scheduleFile.csvText && scheduleFile.csvText.trim().length
                    ? Promise.resolve(scheduleFile.csvText)
                    : fetchTextFromS3Key(scheduleFile.key || '')
                )
              : Promise.resolve(''),
          ]);

          const scheduleBlocks = parseScheduleBlocks(scheduleText, { plantName: plant });
          // Collect meter candidates for this plant and pick the best parsed coverage.
          const meterCandidates = allObjects
            .filter((obj) => {
              const p = extractPlantFromKey(obj.key, selectedDate) || 'Default';
              const k = obj.key.toLowerCase();
              return p === plant && (k.includes('/meter/') || k.includes('/metered_data/')) && k.endsWith('.csv');
            })
            .sort((a, b) => {
              const aSeq = extractTrailingNumber(a.key);
              const bSeq = extractTrailingNumber(b.key);
              if (aSeq !== null && bSeq !== null && bSeq !== aSeq) return bSeq - aSeq;
              const aTime = Date.parse(a.lastModified || '');
              const bTime = Date.parse(b.lastModified || '');
              const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
              if (timeDiff !== 0) return timeDiff;
              return (b.key || '').localeCompare(a.key || '');
            });

          let meterBlocks = [];
          let meterSelectionMeta = null;
          for (const candidate of meterCandidates) {
            try {
              const text = await fetchTextFromS3Key(candidate.key || '');
              const parsed = parseMeterBlocks(text, {
                plantCode: plant,
                sourceKey: candidate.key,
              });
              if (!parsed.length) continue;

              const nonZeroCount = parsed.filter((x) => x.actual > 0).length;
              const maxBlock = parsed.reduce((mx, row) => (row.block > mx ? row.block : mx), 0);
              const candidateTime = Date.parse(candidate.lastModified || '');
              const candidateMeta = {
                key: candidate.key,
                nonZeroCount,
                maxBlock,
                candidateTime: Number.isNaN(candidateTime) ? 0 : candidateTime,
              };

              const shouldUseCandidate =
                !meterSelectionMeta ||
                candidateMeta.nonZeroCount > meterSelectionMeta.nonZeroCount ||
                (candidateMeta.nonZeroCount === meterSelectionMeta.nonZeroCount &&
                  candidateMeta.maxBlock > meterSelectionMeta.maxBlock) ||
                (candidateMeta.nonZeroCount === meterSelectionMeta.nonZeroCount &&
                  candidateMeta.maxBlock === meterSelectionMeta.maxBlock &&
                  candidateMeta.candidateTime > meterSelectionMeta.candidateTime);

              if (shouldUseCandidate) {
                meterBlocks = parsed;
                meterSelectionMeta = candidateMeta;
              }
            } catch {
              // Try next candidate
            }
          }

          // Fallback to pre-picked latest meter mapping if candidate scan yielded nothing
          if (!meterBlocks.length) {
            const meterFile = plantToMeter.get(plant);
            if (meterFile) {
              const meterText = await fetchTextFromS3Key(meterFile.key || '');
              meterBlocks = parseMeterBlocks(meterText, {
                plantCode: plant,
                sourceKey: meterFile.key,
              });
              if (meterBlocks.length) {
                const nonZeroCount = meterBlocks.filter((x) => x.actual > 0).length;
                const maxBlock = meterBlocks.reduce((mx, row) => (row.block > mx ? row.block : mx), 0);
                const candidateTime = Date.parse(meterFile.lastModified || '');
                meterSelectionMeta = {
                  key: meterFile.key,
                  nonZeroCount,
                  maxBlock,
                  candidateTime: Number.isNaN(candidateTime) ? 0 : candidateTime,
                };
              }
            }
          }

          if (scheduleBlocks.length > 0 && meterBlocks.length === 0) {
            parseWarnings.push(`Meter blocks not parsed for ${plant}`);
          } else if (meterSelectionMeta && meterSelectionMeta.maxBlock < currentIstBlock) {
            parseWarnings.push(
              `Meter coverage for ${plant} is only up to B${meterSelectionMeta.maxBlock} (${(meterSelectionMeta.key || '').split('/').pop()})`
            );
          }

          const sm = new Map(scheduleBlocks.map((x) => [x.block, x.scheduled]));
          const smText = new Map(scheduleBlocks.map((x) => [x.block, x.scheduledText]));
          const smAvc = new Map(scheduleBlocks.map((x) => [x.block, x.avcMw]));
          const mm = new Map(meterBlocks.map((x) => [x.block, x.actual]));
          const mmText = new Map(meterBlocks.map((x) => [x.block, x.actualText]));

          const lastBlock = isTodaySelected ? currentIstBlock : 96;
          for (let block = 1; block <= lastBlock; block += 1) {
            const hasActualReading = mm.has(block);
            if (!hasActualReading) {
              // Do not assume missing meter as zero; skip this block until meter arrives.
              continue;
            }
            const scheduled = sm.get(block);
            if (!Number.isFinite(scheduled)) {
              parseWarnings.push(`Scheduled MW missing for ${plant} block B${block}`);
              continue;
            }
            const scheduledSafe = scheduled;
            const actual = Number.isFinite(mm.get(block)) ? mm.get(block) : 0;
            const scheduledText = smText.get(block) ?? '0';
            const actualText = mmText.get(block) ?? '0';
            const deviation = actual - scheduledSafe;
            const capacityMw = Number.isFinite(Number(plantCapacityByName[plant]))
              ? Number(plantCapacityByName[plant])
              : (PLANT_CAPACITY_MW[plant] ?? 0);
            const blockAvcMw = smAvc.get(block);
            const oseplCapacityMw = plant === 'OSEPL' && Number.isFinite(blockAvcMw)
              ? Number(blockAvcMw)
              : capacityMw;
            const plantState = plantStateByName[plant] || PLANT_STATE_FALLBACK[plant];
            const plantType = plantTypeByName[plant] || PLANT_TYPE_FALLBACK[plant] || getPlantTypeFromName(plant);
              const { allowedMw, lowerLimitMw, upperLimitMw, bandPercent } = getDsmBandForBlock(
                scheduledSafe,
                plant,
                capacityMw,
                plantState,
                plantType
              );
            const percentage = (deviation / Math.max(Math.abs(capacityMw), EPSILON)) * 100;
            const absDeviationPercent = Math.abs(percentage);
            const underGenerationMw = actual < lowerLimitMw ? (lowerLimitMw - actual) : 0;
            const overGenerationMw = actual > upperLimitMw ? (actual - upperLimitMw) : 0;
            const excessDeviationMw = Math.max(underGenerationMw, overGenerationMw, 0);
            const isBreach = excessDeviationMw > EPSILON;
            const penaltyRate = isBreach
              ? getPenaltyRateForDeviationPercent(absDeviationPercent, plantState, plantType)
              : 0;
            const deviationEnergyKwh = isBreach
              ? Math.abs(deviation) * DSM_BLOCK_DURATION_HOURS * KWH_PER_MWH
              : 0;
            const penaltyRs = isBreach
              ? (
                calculatePenaltyRsShared({
                  scheduledMw: scheduledSafe,
                  actualMw: actual,
                  capacityMw,
                  plantState,
                  plantType,
                  penaltyConfigByState: DSM_PENALTY_CONFIG_BY_STATE,
                  defaultPenaltyConfig: DEFAULT_DSM_PENALTY_CONFIG,
                }) || 0
              )
              : 0;
            const breachDirection = underGenerationMw > EPSILON
              ? 'UNDER_GENERATION'
              : overGenerationMw > EPSILON
                ? 'OVER_GENERATION'
                : 'NONE';
            const oseplSettlement = plant === 'OSEPL'
              ? calculateOseplSettlement(scheduledSafe, actual, oseplCapacityMw)
              : null;
            const oseplOffice = plant === 'OSEPL'
              ? calculateOseplOfficePayableReceivable(scheduledSafe, actual, oseplCapacityMw)
              : null;
            allRows.push({
              block,
              time: blockToInterval(block),
              plant,
              type: plantType,
              capacityMw,
              oseplAvcMw: plant === 'OSEPL' && Number.isFinite(blockAvcMw) ? Number(blockAvcMw) : null,
              allowedMw,
              scheduled,
              scheduledText,
              actual,
              actualText,
              deviation,
              deviationText: '',
              percentage,
              percentageText: '',
              absDeviationPercent,
              bandPercent,
              lowerLimitMw,
              upperLimitMw,
              excessDeviationMw,
              penaltyRate,
              deviationEnergyKwh,
              penaltyRs,
              oseplPayableRs: oseplOffice?.payableRs ?? 0,
              oseplReceivableRs: oseplOffice?.receivableRs ?? 0,
              oseplFinalRs: oseplSettlement?.finalPenaltyRs ?? 0,
              status: isBreach
                ? (breachDirection === 'UNDER_GENERATION' ? 'Under-generation penalty' : 'Over-generation penalty')
                : 'No penalty',
              breachDirection,
            });
          }
        }

        setRows(allRows);
        if (parseWarnings.length) {
          const displayWarnings = parseWarnings.filter(
            (warning) => !String(warning || '').startsWith('Meter coverage for ')
          );
          if (displayWarnings.length) {
            toast.warning(displayWarnings.join(' | '));
          }
        }
      } catch (e) {
        console.error(e);
          setRows([]);
          setAvailablePlants([]);
          setScheduleFileByPlant({});
          setScheduleUploadedAtByPlant({});
          setScheduleOptionsByPlant({});
          toast.error('Failed to load block-wise deviation from S3');
        } finally {
          // Always sort by block number to avoid index-based misalignment in UI
          setRows((prev) => [...prev].sort((a, b) => Number(a.block || 0) - Number(b.block || 0)));
          setLoading(false);
        }
      };

      loadBlockwise();
  }, [selectedDate, dynamicPrefixes, selectedScheduleKeyByPlant]);

  const filteredRows = useMemo(() => {
    if (selectedPlant === 'Select Plant') return [];
    return rows.filter((r) => r.plant === selectedPlant);
  }, [rows, selectedPlant]);

  const summary = useMemo(() => {
    if (!filteredRows.length) return { avg: 0, max: 0, within: 0, dsm: 0, totalPenaltyRs: 0 };
    const abs = filteredRows.map((r) => Math.abs(r.deviation));
    const dsm = filteredRows.filter((r) => r.excessDeviationMw > EPSILON).length;
    const totalPenaltyRs = filteredRows.reduce((sum, r) => sum + (r.penaltyRs || 0), 0);
    return {
      avg: abs.reduce((a, b) => a + b, 0) / abs.length,
      max: Math.max(...abs),
      within: Math.round(((filteredRows.length - dsm) / filteredRows.length) * 100),
      dsm,
      totalPenaltyRs,
    };
  }, [filteredRows]);

  const chartData = useMemo(
    () => filteredRows.map((r, idx) => ({
      idx,
      value: r.deviation,
      block: r.block,
      time: blockToInterval(r.block),
      percentage: r.percentage,
      allowedMw: r.allowedMw,
      status: r.status,
    })),
    [filteredRows]
  );

  const trendChartConfig = useMemo(() => {
    const limitMw = chartData.length
      ? Math.max(...chartData.map((d) => Math.abs(d.allowedMw || 0)))
      : 0;
    const maxAbs = chartData.length
      ? Math.max(...chartData.map((d) => Math.abs(d.value)))
      : 1;
    const yMax = Math.max(maxAbs, limitMw, 1);

    const tickvals = [1, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 96];
    const ticktext = tickvals.map((v) => `B${v}`);

    const data = [
      {
        type: 'bar',
        x: chartData.map((d) => d.block),
        y: chartData.map((d) => d.value),
        marker: {
          color: chartData.map((d) => (Math.abs(d.value) > (d.allowedMw || 0) ? '#ef4444' : '#10b981')),
          line: {
            color: isDarkMode ? '#0f172a' : '#e2e8f0',
            width: 0.6,
          },
        },
        customdata: chartData.map((d) => [d.time, d.percentage, d.status, d.allowedMw || 0]),
        hovertemplate:
          '<b>Block B%{x}</b><br>' +
          'Time: %{customdata[0]}<br>' +
          'Deviation: %{y:.3f} MW<br>' +
          'Deviation %: %{customdata[1]:+.2f}%<br>' +
          'Allowed band: +/- %{customdata[3]:.3f} MW<br>' +
          'Status: %{customdata[2]}<extra></extra>',
      },
    ];

    const layout = {
      margin: { l: 56, r: 18, t: 18, b: 44 },
      paper_bgcolor: isDarkMode ? 'rgba(0,0,0,0)' : '#ffffff',
      plot_bgcolor: isDarkMode ? 'rgba(0,0,0,0)' : '#ffffff',
      font: { color: isDarkMode ? '#cbd5e1' : '#1f2937', size: 11 },
      xaxis: {
        title: 'Block Number',
        tickmode: 'array',
        tickvals,
        ticktext,
        range: [0.5, 96.5],
        showline: true,
        linecolor: isDarkMode ? '#334155' : '#94a3b8',
        gridcolor: isDarkMode ? 'rgba(148,163,184,0.14)' : 'rgba(100,116,139,0.18)',
        showspikes: true,
        spikemode: 'across',
        spikesnap: 'cursor',
        spikethickness: 1,
        spikedash: 'solid',
        spikecolor: isDarkMode ? 'rgba(226,232,240,0.55)' : 'rgba(15,23,42,0.45)',
      },
      yaxis: {
        title: 'Deviation (MW)',
        range: [-(yMax * 1.25), yMax * 1.25],
        zeroline: true,
        zerolinecolor: isDarkMode ? '#64748b' : '#64748b',
        zerolinewidth: 1.3,
        gridcolor: isDarkMode ? 'rgba(148,163,184,0.14)' : 'rgba(100,116,139,0.18)',
      },
      shapes: limitMw > 0
        ? [
            {
              type: 'line',
              xref: 'x',
              yref: 'y',
              x0: 1,
              x1: 96,
              y0: limitMw,
              y1: limitMw,
              line: { color: '#f59e0b', width: 1.2, dash: 'dot' },
            },
            {
              type: 'line',
              xref: 'x',
              yref: 'y',
              x0: 1,
              x1: 96,
              y0: -limitMw,
              y1: -limitMw,
              line: { color: '#f59e0b', width: 1.2, dash: 'dot' },
            },
          ]
        : [],
      showlegend: false,
      hovermode: 'x unified',
      hoverdistance: 30,
      spikedistance: -1,
      hoverlabel: {
        bgcolor: isDarkMode ? '#1f2937' : '#ffffff',
        bordercolor: isDarkMode ? '#334155' : '#cbd5e1',
        font: { color: isDarkMode ? '#e2e8f0' : '#0f172a', size: 12 },
      },
    };

    return { data, layout };
  }, [chartData, isDarkMode]);

  const exportBlockwise = async (format = 'csv') => {
    const showOseplColumns = selectedPlant === 'OSEPL';
    const headers = [
      'Block',
      'Time',
      `${scheduledColumnLabel} (MW)`,
      'Meter Data (MW)',
      'Deviation MW',
      'Deviation %',
      'Penalty',
      ...(showOseplColumns ? ['OSEL Payable', 'OSEL Receivable', 'OSEL Final'] : []),
      'Accuracy %',
    ];
    const rowsData = filteredRows.map((r) => {
      const accuracy = calcAccuracyPercent(r.scheduled, r.actual);
      const deviationPct = r.percentageText
        ? `${r.percentageText}`
        : `${r.percentage >= 0 ? '+' : ''}${r.percentage.toFixed(2)}%`;
      const accuracyText = accuracy === null ? '' : `${accuracy.toFixed(2)}%`;
      const baseRow = [
        `B${r.block}`,
        r.time,
        formatMwNoRound(r.scheduled, 2, '0.00'),
        formatMwNoRound(r.actual, 2, '0.00'),
        r.deviationText || r.deviation.toFixed(3),
        deviationPct,
        r.penaltyRs.toFixed(2),
      ];
      const oseplRow = showOseplColumns
        ? [
            r.oseplPayableRs === null ? '' : Number(r.oseplPayableRs).toFixed(2),
            r.oseplReceivableRs === null ? '' : Number(r.oseplReceivableRs).toFixed(2),
            r.oseplFinalRs === null ? '' : Number(r.oseplFinalRs).toFixed(2),
          ]
        : [];
      return [...baseRow, ...oseplRow, accuracyText];
    });
    const filenameBase = `blockwise-dsm-${selectedDate}`;

    if (format === 'pdf') {
      const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
      const pageWidth = doc.internal.pageSize.width;
      const pageHeight = doc.internal.pageSize.height;
      const left = 40;
      const right = pageWidth - 40;

      doc.setFontSize(16);
      doc.setTextColor(30, 64, 175);
      doc.text('Deviation & DSM Report', left, 40);

      doc.setFontSize(10);
      doc.setTextColor(60);
      doc.text(`Date (IST): ${selectedDate}`, left, 60);
      doc.text(`Plant: ${selectedPlant}`, left + 140, 60);
      doc.text(`Generated: ${new Date().toLocaleString()}`, left + 320, 60);
      doc.setDrawColor(220);
      doc.line(left, 68, right, 68);

      doc.setFontSize(9);
      doc.setTextColor(30);

      const headerText = headers.join(' | ');
      let y = 86;
      const lineHeight = 14;
      doc.text(headerText, left, y);
      y += lineHeight;

      rowsData.forEach((row) => {
        if (y > pageHeight - 40) {
          doc.addPage();
          y = 40;
          doc.setFontSize(9);
          doc.setTextColor(30);
          doc.text(headerText, left, y);
          y += lineHeight;
        }
        const text = row.join(' | ');
        doc.text(text, left, y);
        y += lineHeight;
      });

      doc.setFontSize(8);
      doc.setTextColor(120);
      doc.text('Accuracy % = (1 - |Meter Data - Schedule| / Meter Data) x 100; Special case: 0 vs 0 => 100%', left, pageHeight - 22);
      doc.text('Confidential — For internal operations only', left, pageHeight - 10);

      const blob = doc.output('blob');
      downloadBlob(blob, `${filenameBase}.pdf`);
    } else if (format === 'xlsx') {
      await downloadXlsxFromRows(headers, rowsData, filenameBase, 'Blockwise DSM');
    } else {
      const csv = buildCsvText(headers, rowsData);
      downloadCsvText(csv, filenameBase);
    }
    setShowDownloadModal(false);
  };

  const TrendChart = ({ className = 'h-56' }) => {
    const [hoverMarker, setHoverMarker] = useState(null);
    const lastHoverKeyRef = useRef('');

    const hoverMarkerTrace = useMemo(() => {
      if (!hoverMarker) return null;
      return {
        x: [hoverMarker.x],
        y: [hoverMarker.y],
        type: 'scatter',
        mode: 'markers',
        xaxis: hoverMarker.xaxis || 'x',
        yaxis: hoverMarker.yaxis || 'y',
        hoverinfo: 'skip',
        showlegend: false,
        marker: {
          symbol: 'circle-open',
          size: 12,
          color: hoverMarker.color,
          line: { width: 3, color: hoverMarker.color },
        },
      };
    }, [hoverMarker]);

    const handlePlotHover = useCallback((event) => {
      const points = event?.points;
      if (!Array.isArray(points) || points.length === 0) return;
      const point =
        points.find((p) => p?.fullData?.type === 'scatter' && !String(p?.fullData?.name || '').toLowerCase().includes('allowed band'))
        || points[0];
      if (!point) return;

      const x = point.x;
      const y = point.y;
      if (x == null || y == null) return;

      const traceColor =
        point?.fullData?.line?.color
        || point?.fullData?.marker?.color
        || '#111827';
      const xaxis = point?.fullData?.xaxis || 'x';
      const yaxis = point?.fullData?.yaxis || 'y';
      const key = `${point?.fullData?.name || ''}|${x}|${y}|${traceColor}|${xaxis}|${yaxis}`;
      if (key === lastHoverKeyRef.current) return;
      lastHoverKeyRef.current = key;

      setHoverMarker({ x, y, color: traceColor, xaxis, yaxis });
    }, []);

    const handlePlotUnhover = useCallback(() => {
      lastHoverKeyRef.current = '';
      setHoverMarker(null);
    }, []);

    const data = hoverMarkerTrace ? [...(trendChartConfig.data || []), hoverMarkerTrace] : trendChartConfig.data;

    return (
      <div className={`${className} bg-card rounded border border-border p-2`}>
        {Plot ? (
          <Plot
            data={data}
            layout={trendChartConfig.layout}
            config={{ displayModeBar: false, responsive: true }}
            style={{ width: '100%', height: '100%' }}
            useResizeHandler
            onHover={handlePlotHover}
            onUnhover={handlePlotUnhover}
          />
        ) : (
          <div className="h-full w-full flex items-center justify-center text-sm text-muted-foreground">
            Trend chart is unavailable right now.
          </div>
        )}
      </div>
    );
  };

  const scheduleOptionsForSelected = selectedPlant !== 'Select Plant'
    ? (scheduleOptionsByPlant[selectedPlant] || [])
    : [];
  const scheduleOptionsForSelectedSorted = useMemo(() => {
    const items = [...scheduleOptionsForSelected];
    items.sort((a, b) => {
      const aTime = Date.parse(a?.lastModified || '');
      const bTime = Date.parse(b?.lastModified || '');
      const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
      if (timeDiff !== 0) return timeDiff;
      return String(b?.key || '').localeCompare(String(a?.key || ''));
    });
    return items;
  }, [scheduleOptionsForSelected]);
  const latestEditedFrozenPath = useMemo(() => {
    const editedOptions = scheduleOptionsForSelected.filter(
      (item) => Boolean(item?.isFrozen) && String(item?.frozenKind || '').toLowerCase() === 'edited'
    );
    const latest = editedOptions.reduce((best, item) => (isNewerObject(item, best) ? item : best), null);
    return latest?.key || '';
  }, [scheduleOptionsForSelected]);
  const latestSystemFrozenPath = useMemo(() => {
    const systemOptions = scheduleOptionsForSelected.filter(
      (item) => Boolean(item?.isFrozen) && String(item?.frozenKind || '').toLowerCase() === 'system'
    );
    const latest = systemOptions.reduce((best, item) => (isNewerObject(item, best) ? item : best), null);
    return latest?.key || '';
  }, [scheduleOptionsForSelected]);
  const selectedScheduleKey = selectedPlant !== 'Select Plant'
    ? (normalizeS3ObjectKey(selectedScheduleKeyByPlant[selectedPlant]) || scheduleOptionsForSelectedSorted[0]?.key || '')
    : '';
  const selectedScheduleOption = useMemo(() => {
    if (!selectedScheduleKey) return null;
    const key = normalizeS3ObjectKey(selectedScheduleKey);
    return scheduleOptionsForSelectedSorted.find((opt) => normalizeS3ObjectKey(opt?.key) === key) || null;
  }, [selectedScheduleKey, scheduleOptionsForSelectedSorted]);
  const scheduledColumnLabel = useMemo(() => {
    if (selectedPlant === 'Select Plant') return 'Scheduled';
    const kind = String(selectedScheduleOption?.frozenKind || '').toLowerCase();
    if (Boolean(selectedScheduleOption?.isFrozen)) {
      if (kind === 'system') return 'System Schedule';
      if (kind === 'edited') return 'Edited Schedule';
    }
    return 'Scheduled';
  }, [selectedPlant, selectedScheduleOption]);
  const hasScheduleForSelected =
    selectedPlant !== 'Select Plant' &&
    scheduleFileByPlant[selectedPlant] &&
    scheduleFileByPlant[selectedPlant] !== 'N/A';

  return (
    <div className="flex-1 h-full overflow-auto bg-background p-4 sm:p-6 space-y-6 relative overflow-x-hidden">
      <div className="rounded-xl border border-border bg-card p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/25">
            <TrendingDown className="w-6 h-6 sm:w-7 sm:h-7 text-white" />
          </div>
          <div>
          <h2 className="text-lg sm:text-xl font-bold text-foreground leading-tight">Deviation & DSM</h2>
          {selectedPlant !== 'Select Plant' && (
            <p className="text-muted-foreground text-xs sm:text-sm mt-1">
              Schedule used: <span className="text-foreground font-medium">{scheduleFileByPlant[selectedPlant] || 'N/A'}</span>
            </p>
          )}
          {selectedPlant !== 'Select Plant' && (
            <p className="text-muted-foreground text-[11px] sm:text-xs mt-1 break-all">
              Latest edited frozen path: <span className="text-foreground">{latestEditedFrozenPath || 'N/A'}</span>
            </p>
          )}
          {selectedPlant !== 'Select Plant' && (
            <p className="text-muted-foreground text-[11px] sm:text-xs mt-1 break-all">
              Latest system frozen path: <span className="text-foreground">{latestSystemFrozenPath || 'N/A'}</span>
            </p>
          )}
          {selectedPlant !== 'Select Plant' && scheduleOptionsForSelectedSorted.length > 0 && (
            <div className="mt-2">
              <label className="text-[11px] text-muted-foreground mb-1 block">Select Schedule Template</label>
              <select
                value={selectedScheduleKey}
                onChange={(e) =>
                  setSelectedScheduleKeyByPlant((prev) => ({
                    ...prev,
                    [selectedPlant]: e.target.value,
                  }))
                }
                className="w-full sm:w-auto px-3 py-2 rounded bg-background text-foreground border border-border transition-all duration-200 hover:border-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
              >
                {scheduleOptionsForSelectedSorted.map((opt) => (
                  <option key={opt.key} value={opt.key}>
                    {opt.key.split('/').pop() || opt.key}
                  </option>
                ))}
              </select>
            </div>
          )}
          {selectedPlant !== 'Select Plant' && !hasScheduleForSelected && (
            <p className="text-amber-600 text-xs sm:text-sm mt-1">
              No schedule submitted yet. Please submit a schedule in Schedule Readiness.
            </p>
          )}
          </div>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 w-full lg:w-auto">
          <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} className="w-full sm:w-auto px-3 py-2 rounded bg-background text-foreground border border-border transition-all duration-200 hover:border-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30" />
          <select value={selectedPlant} onChange={(e) => setSelectedPlant(e.target.value)} className="w-full sm:w-auto px-3 py-2 rounded bg-background text-foreground border border-border transition-all duration-200 hover:border-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30">
            {plantFilterOptions.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <button onClick={() => { setDownloadFormat('csv'); setShowDownloadModal(true); }} className="w-full sm:w-auto px-4 py-2 rounded bg-indigo-600 text-white flex items-center justify-center gap-2 transition-all duration-200 hover:bg-indigo-500 hover:shadow-md hover:shadow-indigo-300/40"><Download className="w-4 h-4" />Export</button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
        <div className="rounded-xl border border-border bg-card p-4 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md hover:shadow-slate-200/70 dark:hover:shadow-black/25"><p className="text-muted-foreground text-xs sm:text-sm">Avg Deviation</p><p className="text-2xl sm:text-3xl font-bold text-red-500">{summary.avg.toFixed(2)} MW</p></div>
        <div className="rounded-xl border border-border bg-card p-4 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md hover:shadow-slate-200/70 dark:hover:shadow-black/25"><p className="text-muted-foreground text-xs sm:text-sm">Max Deviation</p><p className="text-2xl sm:text-3xl font-bold text-amber-500">{summary.max.toFixed(2)} MW</p></div>
        <div className="rounded-xl border border-border bg-card p-4 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md hover:shadow-slate-200/70 dark:hover:shadow-black/25"><p className="text-muted-foreground text-xs sm:text-sm">Within DSM Limit</p><p className="text-2xl sm:text-3xl font-bold text-emerald-600">{summary.within}%</p></div>
        <div className="rounded-xl border border-border bg-card p-4 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md hover:shadow-slate-200/70 dark:hover:shadow-black/25"><p className="text-muted-foreground text-xs sm:text-sm">DSM Breaches</p><p className="text-2xl sm:text-3xl font-bold text-violet-600">{summary.dsm}</p></div>
        <div className="rounded-xl border border-border bg-card p-4 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md hover:shadow-slate-200/70 dark:hover:shadow-black/25"><p className="text-muted-foreground text-xs sm:text-sm">Estimated Penalty</p><p className="text-2xl sm:text-3xl font-bold text-rose-600">Rs {summary.totalPenaltyRs.toFixed(2)}</p></div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-3">
          <div>
            <h3 className="text-foreground font-semibold mb-1">Deviation Trend Analysis</h3>
            <p className="text-muted-foreground text-xs sm:text-sm">Block B1 to B96 deviation (MW)</p>
          </div>
          <button
            onClick={() => setShowTrendFullscreen(true)}
            className="w-full sm:w-auto px-3 py-2 rounded bg-indigo-600 text-white text-xs sm:text-sm hover:bg-indigo-500"
          >
            Full Screen
          </button>
        </div>
        <TrendChart />
      </div>

      <div className="rounded-xl border border-border bg-card overflow-auto max-h-[65vh]">
        {loading ? (
          <div className="p-8 text-muted-foreground">Loading block-wise data...</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted">
              <tr>
                {(() => {
                  const showOseplColumns = selectedPlant === 'OSEPL';
                  const headers = [
                    'Block/Time',
                    'Plant',
                    'Type',
                    scheduledColumnLabel,
                    'Meter Data',
                    'Deviation',
                    'Deviation %',
                    'Allowed Band',
                    'Penalty',
                    'Accuracy %',
                    ...(showOseplColumns ? ['OSEL Payable', 'OSEL Receivable', 'OSEL Final'] : []),
                    'Status',
                  ];
                  return headers.map((h) => (
                  <th key={h} className="px-3 sm:px-4 py-3 text-left text-xs sm:text-sm text-white dark:text-white uppercase tracking-wide">{h}</th>
                  ));
                })()}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredRows.map((r) => (
                <tr key={`${r.plant}-${r.block}`} className="hover:bg-muted/50">
                  <td className="px-3 sm:px-4 py-3 text-foreground font-medium whitespace-nowrap leading-5 align-middle">{`B${r.block} - ${r.time}`}</td>
                  <td className="px-3 sm:px-4 py-3 text-foreground whitespace-nowrap leading-5 align-middle">{r.plant}</td>
                  <td className="px-3 sm:px-4 py-3 text-muted-foreground whitespace-nowrap leading-5 align-middle">{r.type}</td>
                  <td className="px-3 sm:px-4 py-3 text-foreground whitespace-nowrap tabular-nums leading-5 align-middle">{formatMwNoRound(r.scheduled, 2, '0.00')} MW</td>
                  <td className="px-3 sm:px-4 py-3 text-foreground font-semibold whitespace-nowrap tabular-nums leading-5 align-middle">{formatMwNoRound(r.actual, 2, '0.00')} MW</td>
                  <td className={`px-3 sm:px-4 py-3 font-semibold whitespace-nowrap tabular-nums leading-5 align-middle ${r.excessDeviationMw > EPSILON ? 'text-red-600' : 'text-emerald-700'}`}>{r.deviation >= 0 ? '+' : ''}{(r.deviationText || r.deviation.toFixed(3))} MW</td>
                  <td className="px-3 sm:px-4 py-3 text-muted-foreground whitespace-nowrap tabular-nums leading-5 align-middle">
                    {r.percentageText
                      ? `${r.percentageText}`
                      : `${r.percentage >= 0 ? '+' : ''}${r.percentage.toFixed(2)}%`}
                  </td>
                  <td className="px-3 sm:px-4 py-3 text-foreground whitespace-nowrap tabular-nums leading-5 align-middle">
                    {r.lowerLimitMw.toFixed(3)} to {r.upperLimitMw.toFixed(3)} MW
                  </td>
                  <td className={`px-3 sm:px-4 py-3 font-semibold whitespace-nowrap tabular-nums leading-5 align-middle ${r.penaltyRs > 0 ? 'text-red-600' : 'text-emerald-700'}`}>Rs {r.penaltyRs.toFixed(2)}</td>
                  <td className="px-3 sm:px-4 py-3 text-foreground font-semibold whitespace-nowrap tabular-nums leading-5 align-middle">
                    {(() => {
                      const accuracy = calcAccuracyPercent(r.scheduled, r.actual);
                      return accuracy === null ? '-' : `${accuracy.toFixed(2)}%`;
                    })()}
                  </td>
                  {selectedPlant === 'OSEPL' && (
                    <>
                      <td className="px-3 sm:px-4 py-3 text-foreground whitespace-nowrap tabular-nums leading-5 align-middle">
                        {r.oseplPayableRs === null ? '-' : `Rs ${Number(r.oseplPayableRs).toFixed(2)}`}
                      </td>
                      <td className="px-3 sm:px-4 py-3 text-foreground whitespace-nowrap tabular-nums leading-5 align-middle">
                        {r.oseplReceivableRs === null ? '-' : `Rs ${Number(r.oseplReceivableRs).toFixed(2)}`}
                      </td>
                      <td className="px-3 sm:px-4 py-3 text-foreground whitespace-nowrap tabular-nums leading-5 align-middle">
                        {r.oseplFinalRs === null ? '-' : `Rs ${Number(r.oseplFinalRs).toFixed(2)}`}
                      </td>
                    </>
                  )}
                  <td className="px-3 sm:px-4 py-3 leading-5 align-middle">
                    {r.excessDeviationMw > EPSILON ? (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-red-500/15 text-red-600 text-xs sm:text-sm">
                        <AlertTriangle className="w-3 h-3" />
                        {r.breachDirection === 'UNDER_GENERATION' ? 'Under-generation penalty' : 'Over-generation penalty'}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-emerald-500/15 text-emerald-700 text-xs sm:text-sm">No penalty</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center gap-2 mb-3">
          <Filter className="w-4 h-4 text-muted-foreground" />
          <h4 className="text-sm font-semibold text-foreground">Penalty Calculation Formula</h4>
        </div>
        <div className="text-xs text-muted-foreground space-y-2">
          <p>1. Schedule MW = Forecast column value from selected schedule/template CSV.</p>
          <p>2. Deviation MW = Meter Data MW - Schedule MW.</p>
          <p>3. Deviation% = (Meter Data - Schedule) / Available Capacity x 100.</p>
          <p>4. Select penalty bands by State + Plant Type (Solar/Wind).</p>
          <p>5. Deviation Energy (kWh) = |Meter Data - Schedule| x 0.25 x 1000.</p>
          <p>6. Penalty (Rs) = Sum over bands of (Band Energy x Band Rate).</p>
          <p>7. Allowed MW = Plant Capacity x (Band% / 100).</p>
          <p>8. Upper Limit = Schedule + Allowed MW.</p>
          <p>9. Lower Limit = Schedule - Allowed MW.</p>
          <p>10. Under-generation excess = max(Lower Limit - Meter Data, 0).</p>
          <p>11. Over-generation excess = max(Meter Data - Upper Limit, 0).</p>
          <p>12. Excess MW = max(Under-generation excess, Over-generation excess).</p>
        </div>
      </div>

      <DownloadFormatModal
        open={showDownloadModal}
        onClose={() => setShowDownloadModal(false)}
        formats={['csv', 'xlsx', 'pdf']}
        format={downloadFormat}
        onFormatChange={setDownloadFormat}
        onDownload={() => exportBlockwise(downloadFormat)}
      />

      {showTrendFullscreen && (
        <div className="fixed inset-0 z-50 bg-black/50 p-4 md:p-8">
          <div className="h-full w-full rounded-xl border border-border bg-card p-4 md:p-6 flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-foreground text-lg font-semibold">Deviation Trend Analysis</h3>
                <p className="text-muted-foreground text-sm">Block B1 to B96 deviation (MW)</p>
              </div>
              <button
                onClick={() => setShowTrendFullscreen(false)}
                className="px-3 py-2 rounded bg-muted text-foreground text-sm hover:bg-muted/70"
              >
                Close
              </button>
            </div>
            <TrendChart className="flex-1 min-h-0" />
          </div>
        </div>
      )}
    </div>
  );
}

export default DeviationDSM;

