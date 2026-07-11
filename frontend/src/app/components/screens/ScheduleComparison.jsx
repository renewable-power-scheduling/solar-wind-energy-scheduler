import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Filter, ChevronDown, Upload, X, FileText, Download, BarChart3, Table, CheckCircle, Clock, Maximize2, Minimize2, ArrowLeftRight } from 'lucide-react';
import createPlotlyComponent from 'react-plotly.js/factory';
import Plotly from 'plotly.js-dist-min';
import { toast } from 'sonner';
import { useAuth, useData, useTheme } from '@/app/appContexts';
import { api } from '@/services/api';
import { useApi } from '@/hooks/useApi';
import { S3_BASE_URL, HIDE_METADATA } from '@/config/appConfig';
import { DSM_PENALTY_CONFIG_BY_STATE, DEFAULT_DSM_PENALTY_CONFIG } from '@/config/dsmPenaltyConfig';
import { calculatePenaltyRs as calculatePenaltyRsShared } from '@/shared/freezeRules';
import DownloadFormatModal from '@/app/components/common/DownloadFormatModal';
import { buildCsvText, downloadCsvText, downloadXlsxFromRows } from '@/app/components/common/downloadUtils';
import { parseBlockFromTimestamp } from '@/utils/meterTime';
import { CHART_COLORS, getActualLineColor } from '@/config/chartPalette';
import { canUserAccessPlantCode, getDisabledPlantPattern, isAdminUser } from '@/utils/plantAccess';
import { displayPlantName } from '@/utils/plantDisplay';
import { getPpaRateRsPerKwh } from '@/utils/ppaRate';
import { calculateOseplOfficePayableReceivable, calculateOseplSettlement } from '@/utils/oseplPenalty';
import { allPlantPenaltyApi } from '@/services/allPlantPenaltyApi';
import AllPlantPenaltyReportDialog from '@/app/components/reports/AllPlantPenaltyReportDialog';

const Plot = createPlotlyComponent(Plotly);

const RAW_BASE_PREFIXES = {
  BHUPALPALLY: 'raw/vedanjay/BHUPALPALLY/',
  CME: 'raw/vedanjay/CME/',
  GSNP: 'raw/vedanjay/GSNP/',
  KASIPET: 'raw/vedanjay/KASIPET/',
  KILAJ: 'raw/vedanjay/KILAJ/',
  KOTHAGUDEM: 'raw/vedanjay/KOTHAGUDEM/',
  OSEPL: 'raw/vedanjay/OSEPL/',
  ANDAD: 'raw/vedanjay/ANDAD/',
  BALAKWADA: 'raw/vedanjay/BALAKWADA/',
  GUGARIYAKHEDI: 'raw/vedanjay/GUGARIYAKHEDI/',
  NANDGAON: 'raw/vedanjay/NANDGAON/',
  BAMKHAL: 'raw/vedanjay/BAMKHAL/',
  SIRMOUR: 'raw/vedanjay/SIRMOUR/',
  SAWDA: 'raw/vedanjay/SAWDA/',
  ANJANGAON: 'raw/vedanjay/ANJANGAON/',
  ANJANGOAN: 'raw/vedanjay/ANJANGOAN/',
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
  ANDAD: 'generated/vedanjay/ANDAD/outputs/',
  BALAKWADA: 'generated/vedanjay/BALAKWADA/outputs/',
  GUGARIYAKHEDI: 'generated/vedanjay/GUGARIYAKHEDI/outputs/',
  NANDGAON: 'generated/vedanjay/NANDGAON/outputs/',
  BAMKHAL: 'generated/vedanjay/BAMKHAL/outputs/',
  SIRMOUR: 'generated/vedanjay/SIRMOUR/outputs/',
  SAWDA: 'generated/vedanjay/SAWDA/outputs/',
  ANJANGAON: 'generated/vedanjay/ANJANGAON/outputs/',
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
  ANDAD: 7.5,
  BALAKWADA: 7.5,
  GUGARIYAKHEDI: 7.5,
  NANDGAON: 7.5,
  BAMKHAL: 5,
  SIRMOUR: 5.1,
  SAWDA: 7.5,
  ANJANGAON: 7.5,
};

const SITE_OPTIONS = [
  { code: 'BHUPALPALLY', name: 'BHUPALPALLY', intradayPrefix: '', capacityMw: PLANT_CAPACITY_FALLBACK.BHUPALPALLY, hasMeterDataInS3: true },
  { code: 'KASIPET', name: 'KASIPET', intradayPrefix: '', capacityMw: PLANT_CAPACITY_FALLBACK.KASIPET, hasMeterDataInS3: true },
  { code: 'KOTHAGUDEM', name: 'KOTHAGUDEM', intradayPrefix: '', capacityMw: PLANT_CAPACITY_FALLBACK.KOTHAGUDEM, hasMeterDataInS3: true },
  { code: 'OSEPL', name: 'OSEL', intradayPrefix: '', capacityMw: PLANT_CAPACITY_FALLBACK.OSEPL, hasMeterDataInS3: true },
  { code: 'ANDAD', name: 'ANDAD', intradayPrefix: '', capacityMw: PLANT_CAPACITY_FALLBACK.ANDAD, hasMeterDataInS3: true },
  { code: 'BALAKWADA', name: 'BALAKWADA', intradayPrefix: '', capacityMw: PLANT_CAPACITY_FALLBACK.BALAKWADA, hasMeterDataInS3: true },
  { code: 'GUGARIYAKHEDI', name: 'GUGARIYAKHEDI', intradayPrefix: '', capacityMw: PLANT_CAPACITY_FALLBACK.GUGARIYAKHEDI, hasMeterDataInS3: true },
  { code: 'NANDGAON', name: 'NANDGAON', intradayPrefix: '', capacityMw: PLANT_CAPACITY_FALLBACK.NANDGAON, hasMeterDataInS3: true },
  { code: 'BAMKHAL', name: 'BAMKHAL', intradayPrefix: '', capacityMw: PLANT_CAPACITY_FALLBACK.BAMKHAL, hasMeterDataInS3: true },
  { code: 'SIRMOUR', name: 'SIRMOUR', intradayPrefix: 'vedanjay_sirmour_pv_intra', capacityMw: PLANT_CAPACITY_FALLBACK.SIRMOUR, hasMeterDataInS3: true },
  { code: 'SAWDA', name: 'SAWDA', intradayPrefix: '', capacityMw: PLANT_CAPACITY_FALLBACK.SAWDA, hasMeterDataInS3: true },
  { code: 'ANJANGAON', name: 'ANJANGAON', intradayPrefix: '', capacityMw: PLANT_CAPACITY_FALLBACK.ANJANGAON, hasMeterDataInS3: true },
];
const TOTAL_BLOCKS = 96;
const DSM_ALLOWED_BAND_PERCENT = 10;
const OSEPL_CALC_SOURCE_KEY = 'vedanjay-osepl-calc-source';

const PLANT_STATE_FALLBACK = {
  BHUPALPALLY: 'Telangana',
  CME: 'Maharashtra',
  KASIPET: 'Telangana',
  KILAJ: 'Maharashtra',
  KOTHAGUDEM: 'Telangana',
  OSEPL: 'Maharashtra',
  ANDAD: 'Madhya Pradesh',
  BALAKWADA: 'Madhya Pradesh',
  GUGARIYAKHEDI: 'Madhya Pradesh',
  NANDGAON: 'Madhya Pradesh',
  GSNP: 'Madhya Pradesh',
  BAMKHAL: 'Madhya Pradesh',
  SIRMOUR: 'Madhya Pradesh',
  SAWDA: 'Madhya Pradesh',
  ANJANGAON: 'Madhya Pradesh',
};

const PLANT_TYPE_FALLBACK = {
  BHUPALPALLY: 'Solar',
  CME: 'Solar',
  KASIPET: 'Solar',
  KILAJ: 'Solar',
  KOTHAGUDEM: 'Solar',
  OSEPL: 'Solar',
  ANDAD: 'Solar',
  BALAKWADA: 'Solar',
  GUGARIYAKHEDI: 'Solar',
  NANDGAON: 'Solar',
  GSNP: 'Solar',
  BAMKHAL: 'Solar',
  SIRMOUR: 'Solar',
  SAWDA: 'Solar',
  ANJANGAON: 'Solar',
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

function normalizePlantCode(code) {
  const upper = String(code || '').trim().toUpperCase();
  if (!upper) return '';
  const aliases = {
    BHOPALPALLY: 'BHUPALPALLY',
    OSEL: 'OSEPL',
  };
  return aliases[upper] || upper;
}

function isMeterAvailable(plant) {
  if (plant && plant.hasMeterDataInS3 === false) return false;
  if (plant && plant.hasMeterDataInS3 === true) return true;
  const code = String(plant?.code || derivePlantCodeFromName(plant?.name) || '').trim().toUpperCase();
  return code !== 'CME' && code !== 'KILAJ';
}

function derivePlantFolders(name) {
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

function buildSiteOptionsFromApi(plants, userOrRole = null) {
  if (!plants?.length) return SITE_OPTIONS.filter((p) => canUserAccessPlantCode(p.code, userOrRole));
  const fromApi = plants
    .filter((p) => canUserAccessPlantCode(normalizePlantCode(p.code || derivePlantCodeFromName(p.name)), userOrRole))
    .map((plant) => {
      const code = normalizePlantCode(
        plant.code
        || derivePlantCodeFromName(plant.name)
        || String(plant.name || '').toUpperCase().replace(/\s+/g, '_')
    );
    const fallback = SITE_OPTIONS.find((p) => p.code === code);
    const rawFlag = plant.has_meter_data_in_s3;
    const camelFlag = plant.hasMeterDataInS3;
    const resolvedFlag = (typeof rawFlag === 'boolean')
      ? rawFlag
      : (typeof camelFlag === 'boolean')
        ? camelFlag
        : (typeof fallback?.hasMeterDataInS3 === 'boolean'
          ? fallback.hasMeterDataInS3
          : isMeterAvailable({ code }));
    return {
      code,
      name: plant.name,
      intradayPrefix: plant.intradayPrefix || '',
      capacityMw: plant.capacity || 0,
      state: plant.state,
      type: plant.type,
      hasMeterDataInS3: resolvedFlag,
    };
  });
  const mergedKeys = new Set(fromApi.map((p) => String(p.code || p.name).toUpperCase()));
  const extras = SITE_OPTIONS.filter((p) => !mergedKeys.has(String(p.code || p.name).toUpperCase()));
  return [...fromApi, ...extras].filter((p) => canUserAccessPlantCode(p.code, userOrRole));
}
function getFrozenSchedulePrefixes(date, site) {
  const code = String(site?.code || '').toUpperCase();
  const generatedPrefix = GENERATED_OUTPUTS_BASE_PREFIXES[code];
  const derived = derivePlantFolders(site?.name);
  const prefixes = [];
  if (generatedPrefix) prefixes.push(`${generatedPrefix}${date}/frozen/`);
  if (LEGACY_GENERATED_OUTPUTS_BASE_PREFIXES[code]) {
    prefixes.push(`${LEGACY_GENERATED_OUTPUTS_BASE_PREFIXES[code]}${date}/frozen/`);
  }
  if (derived) {
    prefixes.push(`generated/vedanjay/${derived.upper}/outputs/${date}/frozen/`);
    prefixes.push(`generated/${derived.folder}/${derived.lower}/outputs/${date}/frozen/`);
  }
  prefixes.push(`${LEGACY_OUTPUTS_BASE_PREFIX}${date}/frozen/`);
  return Array.from(new Set(prefixes));
}

function getIntradayPrefixes(date, site) {
  const code = String(site?.code || '').toUpperCase();
  const derived = derivePlantFolders(site?.name);
  const prefixes = [];
  if (code) prefixes.push(`raw/vedanjay/${code}/${date}/enercast_data/intraday/`);
  if (code === 'ANJANGAON') prefixes.push(`raw/vedanjay/ANJANGOAN/${date}/enercast_data/intraday/`);
  if (derived?.upper) prefixes.push(`raw/vedanjay/${derived.upper}/${date}/enercast_data/intraday/`);
  if (derived?.upper === 'ANJANGAON') prefixes.push(`raw/vedanjay/ANJANGOAN/${date}/enercast_data/intraday/`);
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

function getAllowedLimitPercent(plantState, plantType) {
  const config = DSM_PENALTY_CONFIG_BY_STATE[normalizeStateName(plantState)] || DEFAULT_DSM_PENALTY_CONFIG;
  const typeConfig = config.byType?.[plantType] || config.byType?.Solar;
  return typeConfig?.baseBand ?? DSM_ALLOWED_BAND_PERCENT;
}

function calculatePenaltyRs({ scheduledMw, actualMw, capacityMw, plantState, plantType }) {
  const normalizedType = String(plantType || 'Solar');
  return calculatePenaltyRsShared({
    scheduledMw,
    actualMw,
    capacityMw,
    plantState,
    plantType: normalizedType,
    penaltyConfigByState: DSM_PENALTY_CONFIG_BY_STATE,
    defaultPenaltyConfig: DEFAULT_DSM_PENALTY_CONFIG,
  });
}

function roundToDecimals(value, decimals = 2) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** Number(decimals || 0);
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function getMeterPrefixes(date, site) {
  const code = String(site?.code || '').toUpperCase();
  const rawPrefix = RAW_BASE_PREFIXES[code];
  const legacyRawPrefix = LEGACY_RAW_BASE_PREFIXES[code];
  const generatedPrefix = GENERATED_OUTPUTS_BASE_PREFIXES[code];
  const derived = derivePlantFolders(site?.name);
  const prefixes = [];
  if (rawPrefix) prefixes.push(`${rawPrefix}${date}/metered_data/`);
  if (code === 'ANJANGAON') prefixes.push(`raw/vedanjay/ANJANGOAN/${date}/metered_data/`);
  if (legacyRawPrefix) prefixes.push(`${legacyRawPrefix}${date}/metered_data/`);
  if (generatedPrefix) prefixes.push(`${generatedPrefix}${date}/meter/`);
  if (LEGACY_GENERATED_OUTPUTS_BASE_PREFIXES[code]) {
    prefixes.push(`${LEGACY_GENERATED_OUTPUTS_BASE_PREFIXES[code]}${date}/meter/`);
  }
  if (derived) {
    prefixes.push(`raw/vedanjay/${derived.upper}/${date}/metered_data/`);
    if (derived.upper === 'ANJANGAON') prefixes.push(`raw/vedanjay/ANJANGOAN/${date}/metered_data/`);
    prefixes.push(`generated/vedanjay/${derived.upper}/outputs/${date}/meter/`);
    prefixes.push(`generated/${derived.folder}/${derived.lower}/outputs/${date}/meter/`);
    prefixes.push(`raw/${derived.folder}/${derived.lower}/${date}/metered_data/`);
  }
  prefixes.push(`${LEGACY_OUTPUTS_BASE_PREFIX}${date}/meter/`, `${date}/meter/`);
  return Array.from(new Set(prefixes));
}

function getVedanjaySldcSchedulePlantFolder(plantCode) {
  const code = normalizePlantCode(plantCode);
  if (code === 'OSEL') return 'OSEPL';
  if (code === 'ANJANGOAN') return 'ANJANGAON';
  if (code === 'SHRIMOUR' || code === 'SHROMOUR') return 'SIRMOUR';
  return code;
}

function getVedanjaySldcSchedulePrefixes(date, site) {
  const code = normalizePlantCode(
    String(site?.code || '').trim().toUpperCase()
    || derivePlantCodeFromName(site?.name)
  );
  const folder = getVedanjaySldcSchedulePlantFolder(code);
  const dateKey = String(date || '').trim();
  if (!folder || !dateKey) return [];
  const prefixes = [`Vedanjay SLDC Schedules/${folder}/${dateKey}/`];
  if (folder !== code && code) {
    prefixes.push(`Vedanjay SLDC Schedules/${code}/${dateKey}/`);
  }
  return Array.from(new Set(prefixes));
}

function pickLatestVedanjaySldcSchedule(objects) {
  const candidates = (Array.isArray(objects) ? objects : []).filter((obj) => {
    const key = String(obj?.key || '').trim().toLowerCase();
    return /\.(csv|xlsx|xlsm|xls)$/.test(key);
  });
  return candidates.sort((a, b) => {
    const aTime = Date.parse(String(a?.lastModified || a?.last_modified || ''));
    const bTime = Date.parse(String(b?.lastModified || b?.last_modified || ''));
    const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
    if (timeDiff !== 0) return timeDiff;
    return String(b?.key || '').localeCompare(String(a?.key || ''));
  })[0] || null;
}

function isFrozenScheduleCsvKey(key) {
  const k = String(key || '').toLowerCase();
  if (!k.endsWith('.csv') || !k.includes('/frozen/')) return false;
  if (k.includes('/intraday/')) return false;
  return /schedule_free(?:z|ze)_from_\d+\.csv$/i.test(k) || /_frozen\.csv$/i.test(k);
}

function getFrozenFileNameForSite(site) {
  const code = String(site?.code || '').trim().toUpperCase();
  return code ? `${code}_frozen.csv` : '';
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
  const match = fileName.match(/schedule_(?:free(?:z|ze)_)?from_(\d+)\.csv$/i);
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

async function listS3Objects(prefix) {
  try {
    const proxyResp = await fetch('/api/s3/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [prefix], limit: 5000 }),
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

async function listS3ObjectsAcrossPrefixes(prefixes, userOrRole = null) {
  const disabledPattern = getDisabledPlantPattern(userOrRole);
  const safePrefixes = (prefixes || []).filter((prefix) => prefix && !disabledPattern.test(prefix));
  const settled = await Promise.allSettled(safePrefixes.map((prefix) => listS3Objects(prefix)));
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

async function fetchTabularTextFromS3(key) {
  const rawKey = String(key || '').trim();
  const lowerKey = rawKey.toLowerCase();
  if (!/\.(xlsx|xlsm|xls)$/.test(lowerKey)) {
    return fetchTextFromS3(rawKey);
  }

  const params = new URLSearchParams({ key: rawKey });
  const response = await fetch(`/api/s3/bytes?${params.toString()}`);
  if (!response.ok) {
    const error = new Error(`S3 file fetch failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }

  const XLSX = await import('xlsx');
  const buffer = await response.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const firstSheetName = workbook.SheetNames?.[0];
  if (!firstSheetName) return '';
  const sheet = workbook.Sheets[firstSheetName];
  return XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
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
  let parentHeader = '';
  const headers = Array.from({ length: maxCols }, (_, i) => {
    const h1 = header1[i] || '';
    const h2 = useSecondHeader ? (maybeHeader2[i] || '') : '';
    if (h1) parentHeader = h1;
    const effectiveParent = h1 || parentHeader;
    if (effectiveParent && h2) return `${effectiveParent} ${h2}`.trim();
    return effectiveParent || h2;
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

function parseBlockFromStartTimestamp(raw) {
  const m = String(raw || '').match(/(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?/);
  if (!m) return null;
  const hh = Number.parseInt(m[1], 10);
  const mm = Number.parseInt(m[2], 10);
  const ss = m[3] !== undefined ? Number.parseInt(m[3], 10) : 0;
  const ms = m[4] !== undefined ? Number.parseInt(m[4], 10) : 0;
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss) || !Number.isFinite(ms)) return null;
  if (hh < 0 || hh > 24 || mm < 0 || mm > 59 || ss < 0 || ss > 59) return null;
  if (hh === 24) {
    if (mm === 0 && ss === 0 && ms === 0) return TOTAL_BLOCKS;
    return null;
  }
  const totalMinutes = (hh * 60) + mm;
  const block = Math.floor(totalMinutes / 15) + 1;
  return (block >= 1 && block <= TOTAL_BLOCKS) ? block : null;
}

function detectMeterTimeConvention(rows, timeIdx) {
  const evaluate = (resolver) => {
    const seen = new Set();
    let parsed = 0;
    let duplicates = 0;
    rows.slice(0, Math.min(rows.length, 200)).forEach((cols) => {
      const raw = cols?.[timeIdx];
      const val = String(raw ?? '').trim();
      if (!val) return;
      const rangeMatch = val.match(/(\d{1,2}:\d{2})(?:\s*[-\u2013\u2014]\s*)(\d{1,2}:\d{2})/);
      const probe = rangeMatch ? rangeMatch[1] : val;
      const block = resolver(probe);
      if (!Number.isFinite(block) || block < 1 || block > TOTAL_BLOCKS) return;
      parsed += 1;
      if (seen.has(block)) duplicates += 1;
      seen.add(block);
    });
    const unique = seen.size;
    const missing = Math.max(0, TOTAL_BLOCKS - unique);
    // Heavily prefer higher unique coverage and fewer collisions.
    const score = (unique * 100) - (duplicates * 25) - (missing * 10) + parsed;
    return { score, unique, duplicates, missing, parsed };
  };

  const startEval = evaluate((t) => parseBlockFromStartTimestamp(t));
  const endEval = evaluate((t) => parseBlockFromTimestamp(t, { totalBlocks: TOTAL_BLOCKS }));
  const nearestEval = evaluate((t) => parseBlockFromNearestQuarterStart(t));

  // Choose the strongest convention by score.
  // Tie-breakers keep current behavior stable where possible.
  const candidates = [
    { mode: 'start', eval: startEval },
    { mode: 'end', eval: endEval },
    { mode: 'nearest', eval: nearestEval },
  ];
  candidates.sort((a, b) => {
    if (b.eval.score !== a.eval.score) return b.eval.score - a.eval.score;
    // Prefer end-time convention for meter exports when scores tie.
    // Many meter CSVs label each sample by the *end* of the 15-min block
    // (e.g. 16:45 represents 16:30-16:45). Picking "nearest" (start-like)
    // causes a consistent +1 block shift in graph/table.
    const rank = { end: 3, nearest: 2, start: 1 };
    return (rank[b.mode] || 0) - (rank[a.mode] || 0);
  });
  return candidates[0]?.mode || 'end';
}

function buildMeterTimeBlockResolver(rows, timeIdx) {
  if (timeIdx === -1) return () => null;
  const convention = detectMeterTimeConvention(rows, timeIdx);
  return (raw) => {
    const textVal = String(raw ?? '').trim();
    if (!textVal) return null;

    const rangeMatch = textVal.match(/(\d{1,2}:\d{2})(?:\s*[-\u2013\u2014]\s*)(\d{1,2}:\d{2})/);
    if (rangeMatch) {
      // For explicit ranges, start-time mapping is stable and deterministic.
      const startBlock = parseBlockFromStartTimestamp(rangeMatch[1]);
      if (Number.isFinite(startBlock)) return startBlock;
      return parseBlockFromTimestamp(rangeMatch[1], { totalBlocks: TOTAL_BLOCKS });
    }

    if (convention === 'start') {
      const startBlock = parseBlockFromStartTimestamp(textVal);
      if (Number.isFinite(startBlock)) return startBlock;
      const nearestQuarterBlock = parseBlockFromNearestQuarterStart(textVal);
      if (Number.isFinite(nearestQuarterBlock)) return nearestQuarterBlock;
      const endBlock = parseBlockFromTimestamp(textVal, { totalBlocks: TOTAL_BLOCKS });
      if (Number.isFinite(endBlock)) return endBlock;
      return null;
    }
    if (convention === 'nearest') {
      const nearestQuarterBlock = parseBlockFromNearestQuarterStart(textVal);
      if (Number.isFinite(nearestQuarterBlock)) return nearestQuarterBlock;
      const endBlock = parseBlockFromTimestamp(textVal, { totalBlocks: TOTAL_BLOCKS });
      if (Number.isFinite(endBlock)) return endBlock;
      const startBlock = parseBlockFromStartTimestamp(textVal);
      if (Number.isFinite(startBlock)) return startBlock;
      return null;
    }
    const endBlock = parseBlockFromTimestamp(textVal, { totalBlocks: TOTAL_BLOCKS });
    if (Number.isFinite(endBlock)) return endBlock;
    const nearestQuarterBlock = parseBlockFromNearestQuarterStart(textVal);
    if (Number.isFinite(nearestQuarterBlock)) return nearestQuarterBlock;
    return null;
  };
}

function parseTimeParts(raw) {
  const m = String(raw || '').match(/(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?/);
  if (!m) return null;
  const hh = Number.parseInt(m[1], 10);
  const mm = Number.parseInt(m[2], 10);
  const ss = m[3] !== undefined ? Number.parseInt(m[3], 10) : 0;
  const ms = m[4] !== undefined ? Number.parseInt(m[4], 10) : 0;
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss) || !Number.isFinite(ms)) return null;
  if (hh < 0 || hh > 24 || mm < 0 || mm > 59 || ss < 0 || ss > 59 || ms < 0 || ms > 999) return null;
  return { hh, mm, ss, ms };
}

function parseBlockFromNearestQuarterStart(raw) {
  const parts = parseTimeParts(raw);
  if (!parts) return null;
  const { hh, mm, ss, ms } = parts;
  if (hh === 24) {
    if (mm === 0 && ss === 0 && ms === 0) return TOTAL_BLOCKS;
    return null;
  }
  const totalSeconds = (hh * 3600) + (mm * 60) + ss + (ms / 1000);
  const roundedSeconds = Math.round(totalSeconds / 900) * 900;
  const clampedSeconds = roundedSeconds >= 86400 ? 86399.999 : Math.max(0, roundedSeconds);
  const totalMinutes = Math.floor(clampedSeconds / 60);
  const block = Math.floor(totalMinutes / 15) + 1;
  return (block >= 1 && block <= TOTAL_BLOCKS) ? block : null;
}

function isLikelyMidnightCarryRow(raw) {
  const parts = parseTimeParts(raw);
  if (!parts) return false;
  return parts.hh === 0 && parts.mm === 0 && (parts.ss > 0 || parts.ms > 0);
}

function getDistanceFromBlockStartSeconds(raw, block) {
  const parts = parseTimeParts(raw);
  if (!parts || !Number.isFinite(block)) return Number.POSITIVE_INFINITY;
  const totalSeconds = (parts.hh * 3600) + (parts.mm * 60) + parts.ss + (parts.ms / 1000);
  const blockStartSeconds = (Number(block) - 1) * 900;
  return Math.abs(totalSeconds - blockStartSeconds);
}

function preferMeterPointCandidate(currentPoint, incomingPoint) {
  if (!currentPoint) return true;
  const currentDistance = Number(currentPoint?.distanceToBlockStartSeconds);
  const incomingDistance = Number(incomingPoint?.distanceToBlockStartSeconds);
  if (Number.isFinite(incomingDistance) && Number.isFinite(currentDistance)) {
    if (incomingDistance + 1e-9 < currentDistance) return true;
    if (currentDistance + 1e-9 < incomingDistance) return false;
  } else if (Number.isFinite(incomingDistance) && !Number.isFinite(currentDistance)) {
    return true;
  } else if (!Number.isFinite(incomingDistance) && Number.isFinite(currentDistance)) {
    return false;
  }
  // Stable tie-breaker: keep first row encountered.
  return false;
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
  } else if (mode === 'uploaded_forecast') {
    // Uploaded Vedanjay file must use Declared Forecast when present.
    const preferredCol = Number.isFinite(options.preferredColumnIndex)
      ? options.preferredColumnIndex
      : null;
    if (preferredCol !== null && preferredCol >= 0 && preferredCol < normalized.length) {
      valueIdx = preferredCol;
    } else {
      const declaredIdx = normalized.findIndex(
        (h) => h.includes('declared') && h.includes('forecast')
      );
      if (declaredIdx !== -1) {
        valueIdx = declaredIdx;
      } else {
        valueIdx = normalized.findIndex(
          (h) =>
            (h.includes('forecast') || h.includes('forcast')) &&
            !h.includes('availability') &&
            !h.includes('capacity')
        );
      }
    }
  } else {
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

  // Use a compact key so headers like "Scheduled (MW)" also match "scheduledmw".
  const normalized = headers.map((h) =>
    String(h || '')
      .toLowerCase()
      .replace(/["']/g, '')
      .replace(/[^a-z0-9]+/g, '')
  );
  const findCol = (matchers) => normalized.findIndex((h) => matchers.some((m) => h.includes(m)));
  const findExactCol = (value) => normalized.findIndex((h) => h === value);

  const blockIdx = findCol(['block', 'blockno', 'blk']);
  // Frozen schedule files contain an explicit "Scheduled MW" column; prefer it over algo/system schedules.
  const scheduledMwIdx = findExactCol('scheduledmw') !== -1
    ? findExactCol('scheduledmw')
    : findCol(['scheduledmw']);
  const algoIdx = findCol(['algoschedulemw', 'algoschedule', 'systemschedule', 'finalschedule']);
  const genericScheduleIdx = findCol(['schedule', 'scheduled']);
  const baseIdx = findCol(['baseforecastmw', 'baseforecast', 'base']);
  const intradayIdx = findCol(['intradayforecastmw', 'intradayforecast', 'intraday']);

  // GSNP may present intraday-style schedule file; fallback to intraday parser.
  if (blockIdx === -1 || (scheduledMwIdx === -1 && algoIdx === -1 && genericScheduleIdx === -1)) {
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

    let value = scheduledMwIdx !== -1 ? parseFloat(cols[scheduledMwIdx]) : NaN;
    if (!Number.isFinite(value) && algoIdx !== -1) {
      value = parseFloat(cols[algoIdx]);
    }
    if (!Number.isFinite(value) && genericScheduleIdx !== -1) {
      value = parseFloat(cols[genericScheduleIdx]);
    }
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
  const normalized = headers.map((h) => String(h || '').toLowerCase().replace(/["']/g, '').trim());
  const compactHeaders = headers.map((h) =>
    String(h || '')
      .toLowerCase()
      .replace(/["']/g, '')
      .replace(/[^a-z0-9]+/g, '')
  );

  const blockIdx = compactHeaders.findIndex((h) => h.includes('block') || h === 'blk');
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
      h.includes('active power') ||
      h.includes('meter power') ||
      h.includes('generation') ||
      h.includes('kw') ||
      h.includes('mw')
    );
  }

  if (powerIdx === -1) {
    const ignored = (h) => h.includes('time') || h.includes('date') || h.includes('block');
    let best = { idx: -1, score: -1 };
    const sample = rows.slice(0, Math.min(rows.length, 192));
    for (let col = 0; col < headers.length; col += 1) {
      if (ignored(normalized[col] || '')) continue;
      let numericCount = 0;
      let absSum = 0;
      sample.forEach((r) => {
        const v = parseFloat(String(r[col] ?? '').replace(/,/g, '').trim());
        if (Number.isFinite(v)) {
          numericCount += 1;
          absSum += Math.abs(v);
        }
      });
      if (!numericCount) continue;
      const avgAbs = absSum / numericCount;
      const score = (numericCount * 1000) + avgAbs;
      if (score > best.score) best = { idx: col, score };
    }
    powerIdx = best.idx;
  }

  if (powerIdx === -1) return new Map();

  const powerHeader = normalized[powerIdx] || '';
  const explicitKw = powerHeader.includes('(kw)') || powerHeader.includes(' kw') || powerHeader === 'kw';
  const explicitMw = powerHeader.includes('(mw)') || powerHeader.includes(' mw') || powerHeader === 'mw';

  const getBlockFromTimeText = buildMeterTimeBlockResolver(rows, timeIdx);

  const parsedPoints = rows
    .map((cols, idx) => {
      const blockFromCol = blockIdx !== -1 ? parseBlockNumber(cols[blockIdx]) : null;
      const timeRaw = timeIdx !== -1 ? cols[timeIdx] : null;
      const hasTimeColumn = timeIdx !== -1;
      const blockFromTime = hasTimeColumn ? getBlockFromTimeText(timeRaw) : null;
      const fallbackBlock = idx + 1;
      let block = null;
      if (Number.isFinite(blockFromCol) && blockFromCol >= 1 && blockFromCol <= TOTAL_BLOCKS) {
        block = blockFromCol;
      } else if (Number.isFinite(blockFromTime)) {
        block = blockFromTime;
      } else if (blockIdx === -1 && timeIdx === -1 && Number.isFinite(fallbackBlock) && fallbackBlock >= 1 && fallbackBlock <= TOTAL_BLOCKS) {
        // Keep a stable fallback for rows where the time value is present but not parseable
        // only when the file has neither block nor time columns.
        block = fallbackBlock;
      }
      const value = parseFloat(String(cols[powerIdx] ?? '').replace(/,/g, '').trim());
      if (!Number.isFinite(block) || block < 1 || block > TOTAL_BLOCKS || !Number.isFinite(value)) return null;
      return {
        block,
        value,
        idx,
        timeRaw,
        distanceToBlockStartSeconds: getDistanceFromBlockStartSeconds(timeRaw, block),
      };
    })
    .filter(Boolean);

  const shouldDropCarryMidnight =
    blockIdx === -1 &&
    timeIdx !== -1 &&
    parsedPoints.length > TOTAL_BLOCKS;
  const normalizedPoints = shouldDropCarryMidnight
    ? parsedPoints.filter((p) => !isLikelyMidnightCarryRow(p.timeRaw))
    : parsedPoints;

  const parsedRaw = parsedPoints.map((p) => p.value);
  const nonZero = parsedRaw.filter((v) => v > 0);
  const avg = nonZero.length ? (nonZero.reduce((a, b) => a + b, 0) / nonZero.length) : 0;
  const assumeKw = explicitKw || (!explicitMw && avg > 200);
  const factor = assumeKw ? 1 / 1000 : 1;

  const bestPointByBlock = new Map();
  normalizedPoints.forEach((p) => {
    const existing = bestPointByBlock.get(p.block);
    if (preferMeterPointCandidate(existing, p)) {
      bestPointByBlock.set(p.block, p);
    }
  });

  const map = new Map();
  bestPointByBlock.forEach((p, block) => {
    map.set(block, p.value * factor);
  });
  return map;
}

function parseUploadedForecastAndAvc(text, options = {}) {
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

  const preferredCol = Number.isFinite(options.preferredColumnIndex)
    ? options.preferredColumnIndex
    : null;
  const siteCode = String(options.siteCode || '').toUpperCase();
  const resolvedState = String(
    options.siteState ||
    PLANT_STATE_FALLBACK[siteCode] ||
    ''
  ).toLowerCase();
  const TELANGANA_STATION_PLANTS = new Set(['BHUPALPALLY', 'KASIPET', 'KOTHAGUDEM']);

  let forecastIdx = -1;
  if (preferredCol !== null && preferredCol >= 0 && preferredCol < normalized.length) {
    forecastIdx = preferredCol;
  }

  // Telangana plants: force "Station Schedule" if present.
  if (forecastIdx === -1 && TELANGANA_STATION_PLANTS.has(siteCode)) {
    const stationIdx = normalized.findIndex(
      (h) => h.includes('stationschedule') && !h.includes('availability') && !h.includes('capacity')
    );
    if (stationIdx !== -1) forecastIdx = stationIdx;
  }

  if (forecastIdx === -1) {
    const declaredIdx = normalized.findIndex((h) => h.includes('declared') && h.includes('forecast'));
    if (declaredIdx !== -1) {
      forecastIdx = declaredIdx;
    } else {
      forecastIdx = normalized.findIndex(
        (h) =>
          (h.includes('forecast') || h.includes('forcast')) &&
          !h.includes('availability') &&
          !h.includes('capacity')
      );
    }
  }

  // Telangana Vedanjay files often name the forecast column "Station Schedule".
  // Prefer Station Schedule as forecast column (Telangana plants primarily, but allow for any file).
  if (forecastIdx === -1) {
    const stationIdx = normalized.findIndex(
      (h) => h.includes('stationschedule') && !h.includes('availability') && !h.includes('capacity')
    );
    if (stationIdx !== -1) forecastIdx = stationIdx;
  }

  // SIRMOUR files may expose plant name as the forecast column.
  if (forecastIdx === -1 && siteCode === 'SIRMOUR') {
    const sirmourIdx = normalized.findIndex(
      (h) => h.includes('sirmour') && !h.includes('availability') && !h.includes('capacity')
    );
    if (sirmourIdx !== -1) forecastIdx = sirmourIdx;
  }

  if (['SIRMOUR', 'ANJANGAON'].includes(siteCode)) {
    const explicitForecastIdx = normalized.findIndex(
      (h) =>
        (h === 'forecast' || h === 'forcast' || h.endsWith('forecast') || h.endsWith('forcast')) &&
        !h.includes('availability') &&
        !h.includes('capacity')
    );
    if (explicitForecastIdx !== -1) {
      forecastIdx = explicitForecastIdx;
    }
  }

  // Last resort: pick the numeric column with the strongest signal (nonÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‹Å“meta).
  if (forecastIdx === -1) {
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
    forecastIdx = best.idx;
  }

  let avcIdx = normalized.findIndex((h) => h.includes('avc') && !h.includes('capacity'));
  if (avcIdx === -1) {
    avcIdx = normalized.findIndex((h) => h.includes('availability') && !h.includes('capacity'));
  }
  let errorBlockIdx = normalized.findIndex(
    (h) =>
      h.includes('errorblock') ||
      h.includes('errorblocks') ||
      h.includes('maint') ||
      h.includes('scadaissue')
  );
  if (errorBlockIdx !== -1 && isMetaColumn(normalized[errorBlockIdx] || '', errorBlockIdx)) {
    errorBlockIdx = -1;
  }

  const parseUnitFactor = (header) => {
    const key = String(header || '').toLowerCase();
    const explicitKw = key.includes('(kw)') || key.includes('kw');
    const explicitMw = key.includes('(mw)') || key.includes('mw');
    const explicitW = (key.includes('(w)') || key.endsWith('w')) && !explicitMw && !explicitKw;
    if (explicitW) return 1 / 1_000_000;
    if (explicitKw) return 1 / 1000;
    return 1;
  };

  const forecastFactor = parseUnitFactor(headers[forecastIdx] || '');
  const avcFactor = parseUnitFactor(headers[avcIdx] || '');

  // OSEPL intraday template ("Block, Declared Forecast, Inter Avc, Schedule")
  // is end-time aligned in the team's manual workbook:
  // file block N corresponds to UI block N+1.
  // Keep this shift for both 1..96 and 0..95 style files to match manual DSM reports.
  const isOseplEndBlockTemplate =
    siteCode === 'OSEPL' &&
    timeIdx === -1 &&
    normalized.includes('declaredforecast') &&
    normalized.includes('interavc') &&
    normalized.includes('schedule');

  const forecastMap = new Map();
  const avcMap = new Map();
  const errorBlockMap = new Map();
  rows.forEach((cols, i) => {
    const parsedBlock = blockIdx !== -1 ? parseBlockNumber(cols[blockIdx]) : null;
    const sourceBlock = (() => {
      if (Number.isFinite(parsedBlock)) {
        if (isOseplEndBlockTemplate && parsedBlock >= 0 && parsedBlock <= (TOTAL_BLOCKS - 1)) {
          return parsedBlock;
        }
        if (parsedBlock >= 1 && parsedBlock <= TOTAL_BLOCKS) return parsedBlock;
      }
      return i + 1;
    })();
    if (!Number.isFinite(sourceBlock) || sourceBlock < 1 || sourceBlock > TOTAL_BLOCKS) return;
    const block = isOseplEndBlockTemplate ? (sourceBlock + 1) : sourceBlock;
    if (!Number.isFinite(block) || block < 1 || block > TOTAL_BLOCKS) return;

    if (forecastIdx !== -1) {
      const forecastVal = parseFloat(cols[forecastIdx]);
      if (Number.isFinite(forecastVal)) {
        forecastMap.set(block, forecastVal * forecastFactor);
      }
    }
    if (avcIdx !== -1 && !isMetaColumn(normalized[avcIdx] || '', avcIdx)) {
      const avcVal = parseFloat(cols[avcIdx]);
      if (Number.isFinite(avcVal)) {
        avcMap.set(block, avcVal * avcFactor);
      }
    }
    if (errorBlockIdx !== -1) {
      const raw = String(cols[errorBlockIdx] ?? '').trim();
      if (raw !== '') {
        const flag = parseFloat(raw);
        if (Number.isFinite(flag)) {
          errorBlockMap.set(block, flag === 1 ? 1 : 0);
        }
      }
    }
  });

  forecastMap._meta = { valueHeader: headers[forecastIdx] || '', valueIdx: forecastIdx };
  avcMap._meta = { valueHeader: headers[avcIdx] || '', valueIdx: avcIdx };
  errorBlockMap._meta = { valueHeader: headers[errorBlockIdx] || '', valueIdx: errorBlockIdx };

  return { forecastMap, avcMap, errorBlockMap };
}


function normalizeMeterHeaderName(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function parseUploadedMeterData(text) {
  const { headers, rows } = parseCsvWithHeaderDetection(text);
  const normalizedHeaders = headers.map((h) => normalizeMeterHeaderName(h));
  const requiredHeader = normalizeMeterHeaderName('Meter data (live)  (kW)');
  const powerIdx = normalizedHeaders.findIndex((h) =>
    normalizeMeterHeaderName(h) === requiredHeader || normalizeMeterHeaderName(h).includes(requiredHeader)
  );
  if (powerIdx === -1) {
    throw new Error('Invalid file format');
  }

  const blockIdx = normalizedHeaders.findIndex((h) => h.includes('block') || h === 'blk');
  const endIdx = normalizedHeaders.findIndex((h) => h.includes('end'));
  const startIdx = normalizedHeaders.findIndex((h) => h.includes('start'));
  const timeIdx = endIdx !== -1
    ? endIdx
    : (startIdx !== -1
      ? startIdx
      : normalizedHeaders.findIndex((h) =>
          h.includes('time') || h.includes('timestamp') || h.includes('datetime')
        ));

  const map = new Map(Array.from({ length: TOTAL_BLOCKS }, (_, i) => [i + 1, null]));

  const getBlockFromTimeText = buildMeterTimeBlockResolver(rows, timeIdx);

  const parsedPoints = [];
  rows.forEach((cols, idx) => {
    const rawValue = cols[powerIdx];
    const parsedValue = parseFloat(String(rawValue ?? '').replace(/,/g, '').trim());
    if (!Number.isFinite(parsedValue)) return;

    const blockFromCol = blockIdx !== -1 ? parseBlockNumber(cols[blockIdx]) : null;
    const blockFromTime = timeIdx !== -1 ? getBlockFromTimeText(cols[timeIdx]) : null;
    const fallbackBlock = idx + 1;
    const block = Number.isFinite(blockFromCol) && blockFromCol >= 1 && blockFromCol <= TOTAL_BLOCKS
      ? blockFromCol
      : (Number.isFinite(blockFromTime) && blockFromTime >= 1 && blockFromTime <= TOTAL_BLOCKS
        ? blockFromTime
        : (blockIdx === -1 && timeIdx === -1 ? fallbackBlock : null));
    if (!Number.isFinite(block) || block < 1 || block > TOTAL_BLOCKS) return;
    parsedPoints.push({
      block,
      valueMw: parsedValue / 1000,
      idx,
      timeRaw: timeIdx !== -1 ? cols[timeIdx] : null,
      distanceToBlockStartSeconds: getDistanceFromBlockStartSeconds(timeIdx !== -1 ? cols[timeIdx] : null, block),
    });
  });

  const shouldDropCarryMidnight =
    blockIdx === -1 &&
    timeIdx !== -1 &&
    parsedPoints.length > TOTAL_BLOCKS;
  const normalizedPoints = shouldDropCarryMidnight
    ? parsedPoints.filter((p) => !isLikelyMidnightCarryRow(p.timeRaw))
    : parsedPoints;

  const bestPointByBlock = new Map();
  normalizedPoints.forEach((p) => {
    const existing = bestPointByBlock.get(p.block);
    if (preferMeterPointCandidate(existing, p)) {
      bestPointByBlock.set(p.block, p);
    }
  });

  bestPointByBlock.forEach((p, block) => {
    map.set(block, p.valueMw);
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
    const schedMatch = fileName.match(/schedule_(?:free(?:z|ze)_)?from_(\d+)\.csv$/i);
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

function findLatestMeterCsv(objects) {
  if (!Array.isArray(objects) || objects.length === 0) return null;
  const candidates = objects.filter((o) => {
    const key = String(o?.key || '').toLowerCase();
    if (!key.endsWith('.csv')) return false;
    return key.includes('/meter/') || key.includes('/metered_data/');
  });
  return sortLatestFirst(candidates)[0] || null;
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
  const { user: currentUser } = useAuth();
  const isAdmin = isAdminUser(currentUser);
  const dataContext = useData();
  const sharedData = dataContext?.sharedData;
  const updateSharedData = dataContext?.updateSharedData;
  const [selectedSite, setSelectedSite] = useState('');
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [showGraph, setShowGraph] = useState(true);
  const [hoverMarker, setHoverMarker] = useState(null);
  const [hiddenTraceKeys, setHiddenTraceKeys] = useState([]);
  const lastHoverKeyRef = useRef('');
  const [isUploading, setIsUploading] = useState(false);
  const [isMeterUploading, setIsMeterUploading] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [showPenaltyReportDialog, setShowPenaltyReportDialog] = useState(false);
  const [penaltyReportReadiness, setPenaltyReportReadiness] = useState(null);
  const [isSavingComparisonResult, setIsSavingComparisonResult] = useState(false);
  const [comparisonSaveRevision, setComparisonSaveRevision] = useState(0);
  const [vedanjayPenaltyResult, setVedanjayPenaltyResult] = useState(null);
  const [isRecalculatingVedanjay, setIsRecalculatingVedanjay] = useState(false);
  const [downloadFormat, setDownloadFormat] = useState('csv');
  const [oseplCalcSource, setOseplCalcSource] = useState(() => {
    try {
      const stored = String(localStorage.getItem(OSEPL_CALC_SOURCE_KEY) || '').trim().toLowerCase();
      if (stored === 'vedanjay') return 'vedanjay';
      if (stored === 'manualedited') return 'manualEdited';
      return 'machine';
    } catch {
      return 'machine';
    }
  });
  const [uploadTime, setUploadTime] = useState(null);
  const [meterUploadTime, setMeterUploadTime] = useState(null);
  const [fileName, setFileName] = useState('');
  const [meterUploadName, setMeterUploadName] = useState('');
  const [isGraphFullscreen, setIsGraphFullscreen] = useState(false);
  const chartContainerRef = useRef(null);
  const tableContainerRef = useRef(null);
  const pendingComparisonSaveRef = useRef('');
  const toTraceVisibilityKey = useCallback((traceUid) => {
    const uid = String(traceUid || '').trim();
    if (!uid) return '';
    if (uid.startsWith('allowedBand-')) return 'allowedBand';
    return uid;
  }, []);
  const toggleTraceVisibilityByUid = useCallback((traceUid) => {
    const key = toTraceVisibilityKey(traceUid);
    if (!key) return;
    setHiddenTraceKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return Array.from(next);
    });
  }, [toTraceVisibilityKey]);
  const isTraceHidden = useCallback((traceUid) => {
    const key = toTraceVisibilityKey(traceUid);
    if (!key) return false;
    return hiddenTraceKeys.includes(key);
  }, [hiddenTraceKeys, toTraceVisibilityKey]);

  useEffect(() => {
    try {
      localStorage.setItem(OSEPL_CALC_SOURCE_KEY, oseplCalcSource);
    } catch {
      // ignore storage errors
    }
  }, [oseplCalcSource]);

  useEffect(() => {
    if (!isAdmin && showPenaltyReportDialog) {
      setShowPenaltyReportDialog(false);
    }
  }, [isAdmin, showPenaltyReportDialog]);

  const refreshPenaltyReportReadiness = useCallback(async () => {
    if (!isAdmin || !selectedDate) {
      setPenaltyReportReadiness(null);
      return;
    }
    try {
      const readiness = await allPlantPenaltyApi.getReadiness({
        startDate: selectedDate,
        endDate: selectedDate,
      });
      setPenaltyReportReadiness(readiness);
    } catch {
      setPenaltyReportReadiness(null);
    }
  }, [isAdmin, selectedDate]);

  useEffect(() => {
    refreshPenaltyReportReadiness();
  }, [refreshPenaltyReportReadiness]);

  const penaltyReportLoadedPlantCodes = useMemo(() => {
    const loadedRows = Array.isArray(penaltyReportReadiness?.loaded) ? penaltyReportReadiness.loaded : [];
    const codes = loadedRows
      .filter((row) => String(row?.schedule_date || '') === String(selectedDate || ''))
      .map((row) => normalizePlantCode(row?.plant_code))
      .filter(Boolean);
    return Array.from(new Set(codes));
  }, [penaltyReportReadiness, selectedDate]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement) {
        setIsGraphFullscreen(false);
      }
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  useEffect(() => {
    setHiddenTraceKeys([]);
  }, [selectedSite, selectedDate]);

  const [systemFrozenMap, setSystemFrozenMap] = useState(null);
  const [editedFrozenMap, setEditedFrozenMap] = useState(null);
  const [enercastFrozenMap, setEnercastFrozenMap] = useState(null);
  const [intradayMap, setIntradayMap] = useState(null);
  const [meterMap, setMeterMap] = useState(null);
  const [uploadedMap, setUploadedMap] = useState(null);
  const [uploadedAvcMap, setUploadedAvcMap] = useState(null);
  const [uploadedErrorBlockMap, setUploadedErrorBlockMap] = useState(null);
  const [testingMap, setTestingMap] = useState(null);
  const [testingAvcMap, setTestingAvcMap] = useState(null);
  const [testingErrorBlockMap, setTestingErrorBlockMap] = useState(null);

  const [systemFrozenMeta, setSystemFrozenMeta] = useState(null);
  const [editedFrozenMeta, setEditedFrozenMeta] = useState(null);
  const [intradayMeta, setIntradayMeta] = useState(null);
  const [meterMeta, setMeterMeta] = useState(null);
  const [testingFileName, setTestingFileName] = useState('');

  const { data: apiPlantsData } = useApi(
    () => api.plants.getAll({ noMock: true }),
    { immediate: true, initialData: { plants: [], total: 0, stats: {} } }
  );
  const siteOptions = useMemo(
    () => buildSiteOptionsFromApi(apiPlantsData?.plants || [], currentUser),
    [apiPlantsData, currentUser]
  );

  const selectedSiteConfig = useMemo(
    () => siteOptions.find((site) => site.code === selectedSite) || null,
    [selectedSite, siteOptions]
  );

  const selectedSiteContext = useMemo(() => {
    let siteCode = normalizePlantCode(
      String(selectedSiteConfig?.code || '').trim().toUpperCase()
      || derivePlantCodeFromName(selectedSiteConfig?.name)
      || derivePlantCodeFromName(selectedSite)
      || String(selectedSite || '').trim().toUpperCase()
    );
    const nameProbe = `${selectedSiteConfig?.name || ''} ${selectedSite || ''}`.toUpperCase();
    if (nameProbe.includes('KILAJ')) {
      siteCode = 'KILAJ';
    }

    let siteCapacityMw =
      Number(selectedSiteConfig?.capacityMw || 0)
      || PLANT_CAPACITY_FALLBACK[siteCode]
      || PLANT_CAPACITY_FALLBACK[String(selectedSiteConfig?.name || '').toUpperCase()]
      || 0;
    if (siteCode === 'KILAJ') {
      siteCapacityMw = 20;
    }

    let plantState =
      selectedSiteConfig?.state
      || PLANT_STATE_FALLBACK[siteCode]
      || '';
    if (['BHOPALPALLY', 'BHUPALPALLY', 'KASIPET', 'KOTHAGUDEM'].includes(siteCode)) {
      plantState = 'Telangana';
    }

    const plantType =
      selectedSiteConfig?.type
      || PLANT_TYPE_FALLBACK[siteCode]
      || 'Solar';

    return {
      siteCode,
      siteCapacityMw,
      plantState,
      plantType,
    };
  }, [selectedSiteConfig, selectedSite]);

  const selectedSiteHasMeterInS3 = useMemo(
    () => isMeterAvailable(selectedSiteConfig),
    [selectedSiteConfig]
  );

  const shouldShowManualMeterUpload = !!selectedSiteConfig && selectedSiteHasMeterInS3 === false;

  useEffect(() => {
    let cancelled = false;
    const loadStoredResult = async () => {
      const plantCode = selectedSiteContext.siteCode;
      if (!plantCode || !selectedDate) {
        setVedanjayPenaltyResult(null);
        return;
      }
      try {
        const result = await allPlantPenaltyApi.getDailyResult({
          plantCode,
          scheduleDate: selectedDate,
        });
        if (!cancelled) setVedanjayPenaltyResult(result);
      } catch {
        if (!cancelled) setVedanjayPenaltyResult(null);
      }
    };
    loadStoredResult();
    return () => {
      cancelled = true;
    };
  }, [selectedDate, selectedSiteContext.siteCode]);

  useEffect(() => {
    if (selectedSite && !selectedSiteConfig) {
      setSelectedSite('');
    }
  }, [selectedSite, selectedSiteConfig]);

  useEffect(() => {
    setMeterUploadName('');
    setMeterUploadTime(null);
    setIsMeterUploading(false);
    setMeterMap(null);
    setMeterMeta(null);
    setSystemFrozenMap(null);
    setEditedFrozenMap(null);
    setEnercastFrozenMap(null);
    setSystemFrozenMeta(null);
    setEditedFrozenMeta(null);
    setUploadedMap(null);
    setUploadedAvcMap(null);
    setUploadedErrorBlockMap(null);
    setTestingMap(null);
    setTestingAvcMap(null);
    setTestingErrorBlockMap(null);
    setUploadTime(null);
    setFileName('');
    setTestingFileName('');
  }, [selectedSite, selectedDate]);

  const getFrozenSchedulePrefix = (date, siteConfig) => {
    const resolvedSiteCode = normalizePlantCode(
      String(siteConfig?.code || '').trim().toUpperCase()
      || derivePlantCodeFromName(siteConfig?.name)
      || derivePlantCodeFromName(selectedSite)
      || String(selectedSite || '').trim().toUpperCase()
    );
    if (!resolvedSiteCode) return null;
    const prefixes = [`frozenschedules/vedanjay/${resolvedSiteCode}/${date}/`];
    if (resolvedSiteCode === 'ANJANGAON') {
      prefixes.push(`frozenschedules/vedanjay/ANJANGOAN/${date}/`);
    } else if (resolvedSiteCode === 'ANJANGOAN') {
      prefixes.push(`frozenschedules/vedanjay/ANJANGAON/${date}/`);
    }
    return prefixes;
  };

  const handleLoadData = async () => {
    if (!selectedSite) {
      toast.info('Select plant first');
      return;
    }

    setIsLoading(true);
    try {
      const frozenPrefixes = getFrozenSchedulePrefix(selectedDate, selectedSiteConfig);
      const [frozenObjectsRaw, intradayFlat, meterFlat, vedanjaySldcFlat, activeVedanjay] = await Promise.all([
        frozenPrefixes?.length ? listS3ObjectsAcrossPrefixes(frozenPrefixes, currentUser) : Promise.resolve([]),
        listS3ObjectsAcrossPrefixes(getIntradayPrefixes(selectedDate, selectedSiteConfig), currentUser),
        listS3ObjectsAcrossPrefixes(getMeterPrefixes(selectedDate, selectedSiteConfig), currentUser),
        listS3ObjectsAcrossPrefixes(getVedanjaySldcSchedulePrefixes(selectedDate, selectedSiteConfig), currentUser),
        allPlantPenaltyApi.getActiveVedanjaySchedule({
          plantCode: selectedSiteContext.siteCode,
          scheduleDate: selectedDate,
        }).catch(() => null),
      ]);
      const intradayObjects = Array.from(new Map(intradayFlat.map((o) => [o.key, o])).values());
      const meterObjects = Array.from(new Map(meterFlat.map((o) => [o.key, o])).values());
      const vedanjaySldcObjects = Array.from(new Map((vedanjaySldcFlat || []).map((o) => [o.key, o])).values());
      const frozenObjects = Array.from(new Map((frozenObjectsRaw || []).map((o) => [o.key, o])).values());
      const systemFrozenObject = frozenObjects.find((o) => /\/system_frozen\.csv$/i.test(String(o?.key || '')));
      const editedFrozenObject = frozenObjects.find((o) => /\/edited_frozen\.csv$/i.test(String(o?.key || '')));
      const enercastFrozenObject = frozenObjects.find((o) => /\/enercast_edited_frozen\.csv$/i.test(String(o?.key || '')));
      const systemFrozenKey = systemFrozenObject ? systemFrozenObject.key : null;
      const editedFrozenKey = editedFrozenObject ? editedFrozenObject.key : null;
      const enercastFrozenKey = enercastFrozenObject ? enercastFrozenObject.key : null;

      const latestIntraday = pickLatestIntradayForDate(
        intradayObjects,
        selectedSiteConfig?.intradayPrefix || ''
      );
      const meterCandidates = sortLatestFirst(
        meterObjects.filter((o) => o.key.toLowerCase().endsWith('.csv'))
      );

      const meterRequired = selectedSiteHasMeterInS3
        && String(selectedSiteConfig?.code || '').trim().toUpperCase() !== 'GSNP';
      const fallbackMeter =
        findLatestMeterCsv(meterObjects);
      const latestMeter = meterRequired ? (meterCandidates[0] || fallbackMeter) : null;
      const latestVedanjaySldc = pickLatestVedanjaySldcSchedule(vedanjaySldcObjects);

      if (!latestIntraday) {
        throw new Error('No intraday file found in S3 for selected date');
      }
      if (meterRequired && !latestMeter) {
        toast.warning('No meter file found in S3 for selected date; loading frozen and intraday data only.');
      }

      const scheduleFetches = [
        systemFrozenKey && systemFrozenObject
          ? fetchTextFromS3(systemFrozenKey).then((t) => ({ kind: 'system', text: t }))
          : Promise.resolve({ kind: 'system', text: null }),
        editedFrozenKey && editedFrozenObject
          ? fetchTextFromS3(editedFrozenKey).then((t) => ({ kind: 'edited', text: t }))
          : Promise.resolve({ kind: 'edited', text: null }),
        enercastFrozenKey && enercastFrozenObject
          ? fetchTextFromS3(enercastFrozenKey).then((t) => ({ kind: 'enercast', text: t }))
          : Promise.resolve({ kind: 'enercast', text: null }),
      ];

      const [intradayText, meterText, ...scheduleTexts] = await Promise.all([
        fetchTextFromS3(latestIntraday.key),
        latestMeter
          ? fetchTextFromS3(latestMeter.key).catch(() => null)
          : Promise.resolve(null),
        ...scheduleFetches,
      ]);

      const parsedIntraday = parseSeriesMap(intradayText, 'intraday', {
        preferredHeaders: selectedSiteConfig?.state === 'Telangana' ? ['Station Schedule'] : [],
      });
      const parsedMeter = meterText ? parseMeterSeriesMap(meterText) : new Map();
      if (!parsedIntraday.size) {
        toast.warning('Intraday Forecast column not found in latest intraday file; loaded schedule/meter only.');
      }

      setIntradayMap(parsedIntraday);
      // If this plant does not have meter in S3 and user already uploaded manual meter,
      // keep the uploaded data instead of overwriting with empty S3 meter.
      const shouldPreserveManualMeter = !meterRequired && meterMap && meterMap.size > 0;
      setMeterMap(shouldPreserveManualMeter ? meterMap : parsedMeter);

      const systemText = scheduleTexts.find((r) => r?.kind === 'system')?.text ?? null;
      const editedText = scheduleTexts.find((r) => r?.kind === 'edited')?.text ?? null;
      const enercastText = scheduleTexts.find((r) => r?.kind === 'enercast')?.text ?? null;
      const parsedSystem = systemText ? parseScheduleSeriesMap(systemText) : new Map();
      const parsedEdited = editedText ? parseScheduleSeriesMap(editedText) : new Map();
      const parsedEnercastFrozen = enercastText ? parseScheduleSeriesMap(enercastText) : new Map();
      let s3VedanjayMap = null;
      let s3VedanjayAvcMap = null;
      let s3VedanjayErrorBlockMap = null;
      if (latestVedanjaySldc?.key) {
        try {
          const sldcText = await fetchTabularTextFromS3(latestVedanjaySldc.key);
          const resolvedSiteCode = selectedSiteContext.siteCode;
          const preferredColumnIndex = resolvedSiteCode === 'KILAJ' ? 7 : null;
          const parsedSldc = parseUploadedForecastAndAvc(sldcText, {
            preferredColumnIndex,
            siteState: selectedSiteConfig?.state,
            siteCode: resolvedSiteCode,
          });
          if (parsedSldc.forecastMap?.size) {
            s3VedanjayMap = parsedSldc.forecastMap;
            s3VedanjayAvcMap = parsedSldc.avcMap?.size ? parsedSldc.avcMap : null;
            s3VedanjayErrorBlockMap = parsedSldc.errorBlockMap?.size ? parsedSldc.errorBlockMap : null;
          } else {
            toast.warning('Latest Vedanjay SLDC schedule was found in S3, but no forecast column could be parsed.');
          }
        } catch (error) {
          console.error(error);
          toast.warning(error?.message || 'Latest Vedanjay SLDC schedule could not be loaded from S3.');
        }
      }

      if (systemFrozenKey && !systemFrozenObject) {
        toast.warning('system_frozen.csv not found in S3 for selected plant/date');
      }
      if (editedFrozenKey && !editedFrozenObject) {
        toast.warning('edited_frozen.csv not found in S3 for selected plant/date');
      }

      setSystemFrozenMap(parsedSystem.size ? parsedSystem : null);
      setEditedFrozenMap(parsedEdited.size ? parsedEdited : null);
      setEnercastFrozenMap(parsedEnercastFrozen.size ? parsedEnercastFrozen : null);
      const storedVedanjayMap = activeVedanjay?.blocks
        ? new Map(
            Object.entries(activeVedanjay.blocks)
              .map(([block, value]) => [Number(block), Number(value)])
              .filter(([block, value]) => Number.isInteger(block) && block >= 1 && block <= 96 && Number.isFinite(value))
          )
        : null;
      const resolvedVedanjayMap = s3VedanjayMap?.size
        ? s3VedanjayMap
        : (storedVedanjayMap?.size ? storedVedanjayMap : null);
      setUploadedMap(resolvedVedanjayMap);
      setUploadedAvcMap(s3VedanjayMap?.size ? s3VedanjayAvcMap : null);
      setUploadedErrorBlockMap(s3VedanjayMap?.size ? s3VedanjayErrorBlockMap : null);
      setFileName(
        s3VedanjayMap?.size
          ? latestVedanjaySldc.key.split('/').pop()
          : (activeVedanjay?.filename || '')
      );
      setSystemFrozenMeta(
        systemFrozenObject
          ? {
              fileName: systemFrozenObject.key.split('/').pop(),
              lastModified: systemFrozenObject.lastModified,
            }
          : null
      );
      setEditedFrozenMeta(
        editedFrozenObject
          ? {
              fileName: editedFrozenObject.key.split('/').pop(),
              lastModified: editedFrozenObject.lastModified,
            }
          : null
      );

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

      const loadedFrozenParts = [
        systemFrozenObject ? 'system_frozen.csv' : null,
        editedFrozenObject ? 'edited_frozen.csv' : null,
        enercastFrozenObject ? 'enercast_edited_frozen.csv' : null,
      ].filter(Boolean);
      const loadedParts = [
        ...(loadedFrozenParts.length ? loadedFrozenParts : ['(no frozen schedule found)']),
        'intraday',
        latestMeter && parsedMeter.size ? 'meter' : null,
        s3VedanjayMap?.size ? 'Vedanjay SLDC schedule' : null,
        !s3VedanjayMap?.size && storedVedanjayMap?.size ? 'Vedanjay upload' : null,
      ].filter(Boolean);
      pendingComparisonSaveRef.current = `${selectedSiteContext.siteCode}:${selectedDate}`;
      toast.success(`Loaded: ${loadedParts.join(', ')}`);
    } catch (error) {
      console.error(error);
      setSystemFrozenMap(null);
      setEditedFrozenMap(null);
      setEnercastFrozenMap(null);
      setIntradayMap(null);
      setMeterMap(null);
      setSystemFrozenMeta(null);
      setEditedFrozenMeta(null);
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
      const resolvedSiteCode = normalizePlantCode(
        String(selectedSiteConfig?.code || '').trim().toUpperCase()
        || derivePlantCodeFromName(selectedSiteConfig?.name)
        || derivePlantCodeFromName(selectedSite)
        || String(selectedSite || '').trim().toUpperCase()
      );
      const preferredColumnIndex = resolvedSiteCode === 'KILAJ' ? 7 : null; // Column H (1-based)
      const { forecastMap, avcMap, errorBlockMap } = parseUploadedForecastAndAvc(text, {
        preferredColumnIndex,
        siteState: selectedSiteConfig?.state,
        siteCode: resolvedSiteCode,
      });
      if (!forecastMap.size) {
        throw new Error('Forecast column not found in uploaded file');
      }
      pendingComparisonSaveRef.current = `${resolvedSiteCode}:${selectedDate}`;
      setTestingMap(forecastMap);
      setTestingAvcMap(avcMap?.size ? avcMap : null);
      setTestingErrorBlockMap(errorBlockMap?.size ? errorBlockMap : null);
      setTestingFileName(file.name);
      setUploadTime(new Date());
      toast.success('Testing schedule uploaded and added to graph');
    } catch (error) {
      console.error(error);
      setTestingMap(null);
      setTestingAvcMap(null);
      setTestingErrorBlockMap(null);
      setTestingFileName('');
      toast.error(error?.message || 'Failed to parse uploaded schedule');
    } finally {
      setIsUploading(false);
      event.target.value = '';
    }
  };

  const handleMeterUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setIsMeterUploading(true);
    setMeterUploadName(file.name);
    try {
      const text = await readUploadedTabularFile(file);
      const parsed = parseUploadedMeterData(text);
      setMeterMap(parsed);
      setMeterMeta({
        fileName: file.name,
        lastModified: new Date().toISOString(),
      });
      setMeterUploadTime(new Date());
      toast.success('Meter data uploaded successfully');
    } catch (error) {
      console.error(error);
      toast.error(error?.message || 'Failed to parse uploaded meter data');
      setMeterUploadName('');
      setMeterUploadTime(null);
    } finally {
      setIsMeterUploading(false);
      event.target.value = '';
    }
  };

  const handleClear = () => {
    setSystemFrozenMap(null);
    setEditedFrozenMap(null);
    setEnercastFrozenMap(null);
    setIntradayMap(null);
    setMeterMap(null);
    setUploadedMap(null);
    setUploadedAvcMap(null);
    setUploadedErrorBlockMap(null);
    setTestingMap(null);
    setTestingAvcMap(null);
    setTestingErrorBlockMap(null);
    setSystemFrozenMeta(null);
    setEditedFrozenMeta(null);
    setIntradayMeta(null);
    setMeterMeta(null);
    setUploadTime(null);
    setMeterUploadTime(null);
    setFileName('');
    setTestingFileName('');
    setMeterUploadName('');
    setIsMeterUploading(false);
    setVedanjayPenaltyResult(null);
    toast.success('Comparison cleared');
  };

  const handleRecalculateVedanjay = async () => {
    if (!selectedSiteContext.siteCode || !selectedDate) return;
    setIsRecalculatingVedanjay(true);
    try {
      const response = await allPlantPenaltyApi.recalculate({
        plantCode: selectedSiteContext.siteCode,
        scheduleDate: selectedDate,
        sources: ['VEDANJAY'],
      });
      const result = response?.items?.[0] || null;
      setVedanjayPenaltyResult(result);
      toast.success(result?.status === 'Pending' ? 'Vedanjay penalty is still pending meter data' : 'Vedanjay penalty recalculated');
    } catch (error) {
      toast.error(error?.message || 'Vedanjay penalty recalculation failed');
    } finally {
      setIsRecalculatingVedanjay(false);
    }
  };

  const rows = useMemo(() => {
    const hasAnyScheduleSource = Boolean(systemFrozenMap || editedFrozenMap || enercastFrozenMap || intradayMap || uploadedMap || testingMap);
    if (!hasAnyScheduleSource) return [];
    const todayIst = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const isTodaySelected = selectedDate === todayIst;
    const currentIstBlock = isTodaySelected ? getCurrentIstBlock() : TOTAL_BLOCKS;

    const resolvedSiteCode = selectedSiteContext.siteCode;
    const availableCapacityMw = selectedSiteContext.siteCapacityMw;
    const plantState = selectedSiteContext.plantState;
    const plantType = selectedSiteContext.plantType;

    const isOsepl = resolvedSiteCode === 'OSEPL';

    return Array.from({ length: TOTAL_BLOCKS }, (_, i) => {
      const block = i + 1;
      const intradayForecastMw = intradayMap?.get(block) ?? null;
      const machineScheduleRaw = systemFrozenMap?.get(block) ?? null;
      const manualEditedScheduleRaw = editedFrozenMap?.get(block) ?? null;
      const enercastFrozenScheduleRaw = enercastFrozenMap?.get(block) ?? null;
      const machineScheduleMw = Number.isFinite(machineScheduleRaw)
        ? roundToDecimals(machineScheduleRaw, 2)
        : null;
      const manualEditedScheduleMw = Number.isFinite(manualEditedScheduleRaw)
        ? roundToDecimals(manualEditedScheduleRaw, 2)
        : null;
      const enercastFrozenScheduleMw = Number.isFinite(enercastFrozenScheduleRaw)
        ? roundToDecimals(enercastFrozenScheduleRaw, 2)
        : null;
      const vedanjayScheduleMw = uploadedMap?.get(block) ?? null;
      const testingScheduleRaw = testingMap?.get(block) ?? null;
      const testingScheduleMw = Number.isFinite(testingScheduleRaw)
        ? roundToDecimals(testingScheduleRaw, 2)
        : null;
      const meterActualRaw = block <= currentIstBlock ? (meterMap?.get(block) ?? null) : null;
      const schedulesNearZero = [machineScheduleMw, manualEditedScheduleMw, vedanjayScheduleMw, testingScheduleMw, intradayForecastMw]
        .every((v) => !Number.isFinite(v) || Math.abs(v) <= 1e-6);
      // Workbook-style OSEPL cleanup:
      // - block 1 often carries prior-day 00:00:xx meter residue
      // - late-evening tiny negative tail (after 19:15) is treated as zero
      const meterActualMw = (() => {
        if (!isOsepl || !Number.isFinite(meterActualRaw)) return meterActualRaw;
        if (block === 1 && schedulesNearZero && meterActualRaw < 0 && Math.abs(meterActualRaw) <= 0.10) {
          return 0;
        }
        if (block >= 78 && schedulesNearZero && meterActualRaw < 0 && Math.abs(meterActualRaw) <= 0.10) {
          return 0;
        }
        return meterActualRaw;
      })();
      const uploadedAvcMw = uploadedAvcMap?.get(block) ?? null;
      const uploadedErrorBlockFlag = uploadedErrorBlockMap?.get(block) ?? 0;
      const testingAvcMw = testingAvcMap?.get(block) ?? null;
      const testingErrorBlockFlag = testingErrorBlockMap?.get(block) ?? 0;
      const oseplCapacityMw = (isOsepl && Number.isFinite(uploadedAvcMw))
        ? uploadedAvcMw
        : availableCapacityMw;
      const oseplTestingCapacityMw = (isOsepl && Number.isFinite(testingAvcMw))
        ? testingAvcMw
        : availableCapacityMw;
      const deviationMachineMw = (Number.isFinite(meterActualMw) && Number.isFinite(machineScheduleMw))
        ? (meterActualMw - machineScheduleMw)
        : null;
      const deviationManualEditedMw = (Number.isFinite(meterActualMw) && Number.isFinite(manualEditedScheduleMw))
        ? (meterActualMw - manualEditedScheduleMw)
        : null;
      const deviationEnercastMw = (Number.isFinite(meterActualMw) && Number.isFinite(enercastFrozenScheduleMw))
        ? (meterActualMw - enercastFrozenScheduleMw)
        : null;
      const deviationVedanjayMw = (Number.isFinite(meterActualMw) && Number.isFinite(vedanjayScheduleMw))
        ? (meterActualMw - vedanjayScheduleMw)
        : null;
      const deviationTestingMw = (Number.isFinite(meterActualMw) && Number.isFinite(testingScheduleMw))
        ? (meterActualMw - testingScheduleMw)
        : null;
      const deviationMachinePct = (Number.isFinite(meterActualMw) && Number.isFinite(machineScheduleMw) && availableCapacityMw > 0)
        ? ((meterActualMw - machineScheduleMw) / availableCapacityMw) * 100
        : null;
      const deviationManualEditedPct = (Number.isFinite(meterActualMw) && Number.isFinite(manualEditedScheduleMw) && availableCapacityMw > 0)
        ? ((meterActualMw - manualEditedScheduleMw) / availableCapacityMw) * 100
        : null;
      const deviationEnercastPct = (Number.isFinite(meterActualMw) && Number.isFinite(enercastFrozenScheduleMw) && availableCapacityMw > 0)
        ? ((meterActualMw - enercastFrozenScheduleMw) / availableCapacityMw) * 100
        : null;
      const deviationVedanjayPct = (Number.isFinite(meterActualMw) && Number.isFinite(vedanjayScheduleMw) && availableCapacityMw > 0)
        ? ((meterActualMw - vedanjayScheduleMw) / availableCapacityMw) * 100
        : null;
      const deviationTestingPct = (Number.isFinite(meterActualMw) && Number.isFinite(testingScheduleMw) && availableCapacityMw > 0)
        ? ((meterActualMw - testingScheduleMw) / availableCapacityMw) * 100
        : null;
      const dsmDeviationMachinePct = (Number.isFinite(meterActualMw) && Number.isFinite(machineScheduleMw) && machineScheduleMw > 0)
        ? (Math.abs(meterActualMw - machineScheduleMw) / machineScheduleMw) * 100
        : null;
      const dsmDeviationManualEditedPct = (Number.isFinite(meterActualMw) && Number.isFinite(manualEditedScheduleMw) && manualEditedScheduleMw > 0)
        ? (Math.abs(meterActualMw - manualEditedScheduleMw) / manualEditedScheduleMw) * 100
        : null;
      const dsmDeviationEnercastPct = (Number.isFinite(meterActualMw) && Number.isFinite(enercastFrozenScheduleMw) && Math.abs(enercastFrozenScheduleMw) > 1e-6)
        ? (Math.abs(meterActualMw - enercastFrozenScheduleMw) / Math.abs(enercastFrozenScheduleMw)) * 100
        : null;
      const dsmDeviationVedanjayPct = (Number.isFinite(meterActualMw) && Number.isFinite(vedanjayScheduleMw) && vedanjayScheduleMw > 0)
        ? (Math.abs(meterActualMw - vedanjayScheduleMw) / vedanjayScheduleMw) * 100
        : null;
      const dsmDeviationTestingPct = (Number.isFinite(meterActualMw) && Number.isFinite(testingScheduleMw) && testingScheduleMw > 0)
        ? (Math.abs(meterActualMw - testingScheduleMw) / testingScheduleMw) * 100
        : null;
      const penaltyMachine = calculatePenaltyRs({
        scheduledMw: Number.isFinite(machineScheduleMw) ? machineScheduleMw : null,
        actualMw: Number.isFinite(meterActualMw) ? meterActualMw : null,
        capacityMw: availableCapacityMw,
        plantState,
        plantType,
      });
      const penaltyManualEdited = calculatePenaltyRs({
        scheduledMw: Number.isFinite(manualEditedScheduleMw) ? manualEditedScheduleMw : null,
        actualMw: Number.isFinite(meterActualMw) ? meterActualMw : null,
        capacityMw: availableCapacityMw,
        plantState,
        plantType,
      });
      const penaltyEnercast = calculatePenaltyRs({
        scheduledMw: Number.isFinite(enercastFrozenScheduleMw) ? enercastFrozenScheduleMw : null,
        actualMw: Number.isFinite(meterActualMw) ? meterActualMw : null,
        capacityMw: availableCapacityMw,
        plantState,
        plantType,
      });
      const penaltyVedanjay = calculatePenaltyRs({
        scheduledMw: Number.isFinite(vedanjayScheduleMw) ? vedanjayScheduleMw : null,
        actualMw: Number.isFinite(meterActualMw) ? meterActualMw : null,
        capacityMw: availableCapacityMw,
        plantState,
        plantType,
      });
      const penaltyTesting = calculatePenaltyRs({
        scheduledMw: Number.isFinite(testingScheduleMw) ? testingScheduleMw : null,
        actualMw: Number.isFinite(meterActualMw) ? meterActualMw : null,
        capacityMw: availableCapacityMw,
        plantState,
        plantType,
      });

      const oseplSettlementMachine = (isOsepl && Number.isFinite(machineScheduleMw) && Number.isFinite(meterActualMw))
        ? calculateOseplSettlement(machineScheduleMw, meterActualMw, oseplCapacityMw)
        : null;
      const oseplSettlementManualEdited = (isOsepl && Number.isFinite(manualEditedScheduleMw) && Number.isFinite(meterActualMw))
        ? calculateOseplSettlement(manualEditedScheduleMw, meterActualMw, oseplCapacityMw)
        : null;
      const oseplSettlementVedanjay = (isOsepl && Number.isFinite(vedanjayScheduleMw) && Number.isFinite(meterActualMw))
        ? calculateOseplSettlement(vedanjayScheduleMw, meterActualMw, oseplCapacityMw)
        : null;
      const oseplSettlementTesting = (isOsepl && Number.isFinite(testingScheduleMw) && Number.isFinite(meterActualMw))
        ? calculateOseplSettlement(testingScheduleMw, meterActualMw, oseplTestingCapacityMw)
        : null;

      const oseplOfficeMachine = (isOsepl && Number.isFinite(machineScheduleMw) && Number.isFinite(meterActualMw))
        ? calculateOseplOfficePayableReceivable(machineScheduleMw, meterActualMw, oseplCapacityMw)
        : null;
      const oseplOfficeManualEdited = (isOsepl && Number.isFinite(manualEditedScheduleMw) && Number.isFinite(meterActualMw))
        ? calculateOseplOfficePayableReceivable(manualEditedScheduleMw, meterActualMw, oseplCapacityMw)
        : null;
      const oseplOfficeVedanjay = (isOsepl && Number.isFinite(vedanjayScheduleMw) && Number.isFinite(meterActualMw))
        ? calculateOseplOfficePayableReceivable(vedanjayScheduleMw, meterActualMw, oseplCapacityMw)
        : null;
      const oseplOfficeTesting = (isOsepl && Number.isFinite(testingScheduleMw) && Number.isFinite(meterActualMw))
        ? calculateOseplOfficePayableReceivable(testingScheduleMw, meterActualMw, oseplTestingCapacityMw)
        : null;

      return {
        block,
        timeLabel: blockToInterval(block),
        meterActualMw,
        machineScheduleMw,
        manualEditedScheduleMw,
        vedanjayScheduleMw,
        testingScheduleMw,
        intradayForecastMw,
        availableCapacityMw,
        oseplAvcMw: isOsepl && Number.isFinite(uploadedAvcMw) ? uploadedAvcMw : null,
        oseplErrorBlockFlag: uploadedErrorBlockFlag,
        oseplTestingAvcMw: isOsepl && Number.isFinite(testingAvcMw) ? testingAvcMw : null,
        oseplTestingErrorBlockFlag: testingErrorBlockFlag,

        // Backward-compatible aliases (kept for existing chart/table logic).
        time: blockToInterval(block),
        intradayForecast: intradayForecastMw,
        meterActual: meterActualMw,
        machineSchedule: machineScheduleMw,
        manualEditedSchedule: manualEditedScheduleMw,
        enercastFrozenSchedule: enercastFrozenScheduleMw,
        vedanjaySchedule: vedanjayScheduleMw,
        testingSchedule: testingScheduleMw,

        deviationMachineMw,
        deviationManualEditedMw,
        deviationEnercastMw,
        deviationVedanjayMw,
        deviationTestingMw,
        deviationMachinePct,
        deviationManualEditedPct,
        deviationEnercastPct,
        deviationVedanjayPct,
        deviationTestingPct,
        dsmDeviationMachinePct,
        dsmDeviationManualEditedPct,
        dsmDeviationEnercastPct,
        dsmDeviationVedanjayPct,
        dsmDeviationTestingPct,
        penaltyMachine,
        penaltyManualEdited,
        penaltyEnercast,
        penaltyVedanjay,
        penaltyTesting,

        oseplPayableMachineRs: isOsepl ? (oseplOfficeMachine?.payableRs ?? null) : null,
        oseplReceivableMachineRs: isOsepl ? (oseplOfficeMachine?.receivableRs ?? null) : null,
        oseplFinalMachineRs: isOsepl ? (oseplSettlementMachine?.finalPenaltyRs ?? null) : null,

        oseplPayableManualEditedRs: isOsepl ? (oseplOfficeManualEdited?.payableRs ?? null) : null,
        oseplReceivableManualEditedRs: isOsepl ? (oseplOfficeManualEdited?.receivableRs ?? null) : null,
        oseplFinalManualEditedRs: isOsepl ? (oseplSettlementManualEdited?.finalPenaltyRs ?? null) : null,

        oseplPayableVedanjayRs: isOsepl ? (oseplOfficeVedanjay?.payableRs ?? null) : null,
        oseplReceivableVedanjayRs: isOsepl ? (oseplOfficeVedanjay?.receivableRs ?? null) : null,
        oseplFinalVedanjayRs: isOsepl ? (oseplSettlementVedanjay?.finalPenaltyRs ?? null) : null,
        oseplPayableTestingRs: isOsepl ? (oseplOfficeTesting?.payableRs ?? null) : null,
        oseplReceivableTestingRs: isOsepl ? (oseplOfficeTesting?.receivableRs ?? null) : null,
        oseplFinalTestingRs: isOsepl ? (oseplSettlementTesting?.finalPenaltyRs ?? null) : null,
      };
    });
  }, [systemFrozenMap, editedFrozenMap, enercastFrozenMap, intradayMap, meterMap, uploadedMap, uploadedAvcMap, uploadedErrorBlockMap, testingMap, testingAvcMap, testingErrorBlockMap, selectedDate, selectedSiteContext]);

  const comparisonSummary = useMemo(() => {
    if (!rows.length) {
      return {
        avgMachineDevPct: 0,
        avgManualEditedDevPct: 0,
        avgEnercastDevPct: 0,
        avgVedanjayDevPct: 0,
        avgTestingDevPct: 0,
        avgAbsDevPct: 0,
        totalPenaltyMachine: 0,
        totalPenaltyManualEdited: 0,
        totalPenaltyEnercast: 0,
        totalPenaltyVedanjay: 0,
        totalPenaltyTesting: 0,
        totalOseplFinalMachine: 0,
        totalOseplFinalManualEdited: 0,
        totalOseplFinalVedanjay: 0,
        totalOseplFinalTesting: 0,
      validDiffCount: 0,
    };
    }
    const useMachine = rows.some((r) => Number.isFinite(r.machineSchedule));
    const useManualEdited = rows.some((r) => Number.isFinite(r.manualEditedSchedule));
    const useEnercast = rows.some((r) => Number.isFinite(r.enercastFrozenSchedule));
    const machineDevRows = useMachine ? rows.filter((r) => Number.isFinite(r.deviationMachinePct)) : [];
    const manualEditedDevRows = useManualEdited ? rows.filter((r) => Number.isFinite(r.deviationManualEditedPct)) : [];
    const enercastDevRows = useEnercast ? rows.filter((r) => Number.isFinite(r.deviationEnercastPct)) : [];
    const vedanjayDevRows = rows.filter((r) => Number.isFinite(r.deviationVedanjayPct));
    const testingDevRows = rows.filter((r) => Number.isFinite(r.deviationTestingPct));
    const avgMachineDevPct = machineDevRows.length
      ? machineDevRows.reduce((sum, r) => sum + (r.deviationMachinePct || 0), 0) / machineDevRows.length
      : 0;
    const avgManualEditedDevPct = manualEditedDevRows.length
      ? manualEditedDevRows.reduce((sum, r) => sum + (r.deviationManualEditedPct || 0), 0) / manualEditedDevRows.length
      : 0;
    const avgEnercastDevPct = enercastDevRows.length
      ? enercastDevRows.reduce((sum, r) => sum + r.deviationEnercastPct, 0) / enercastDevRows.length
      : 0;
    const avgVedanjayDevPct = vedanjayDevRows.length
      ? vedanjayDevRows.reduce((sum, r) => sum + (r.deviationVedanjayPct || 0), 0) / vedanjayDevRows.length
      : 0;
    const avgTestingDevPct = testingDevRows.length
      ? testingDevRows.reduce((sum, r) => sum + (r.deviationTestingPct || 0), 0) / testingDevRows.length
      : 0;
    const totalPenaltyMachine = useMachine ? rows.reduce((sum, r) => sum + (r.penaltyMachine || 0), 0) : 0;
    const totalPenaltyManualEdited = useManualEdited ? rows.reduce((sum, r) => sum + (r.penaltyManualEdited || 0), 0) : 0;
    const totalPenaltyEnercast = useEnercast
      ? rows.reduce((sum, r) => sum + (Number.isFinite(r.penaltyEnercast) ? r.penaltyEnercast : 0), 0)
      : 0;
    const totalPenaltyVedanjay = rows.reduce((sum, r) => sum + (r.penaltyVedanjay || 0), 0);
    const totalPenaltyTesting = rows.reduce((sum, r) => sum + (r.penaltyTesting || 0), 0);
    const absDeviations = [];
    rows.forEach((r) => {
      if (useMachine && Number.isFinite(r.deviationMachinePct)) absDeviations.push(Math.abs(r.deviationMachinePct));
      if (useManualEdited && Number.isFinite(r.deviationManualEditedPct)) absDeviations.push(Math.abs(r.deviationManualEditedPct));
      if (Number.isFinite(r.deviationVedanjayPct)) absDeviations.push(Math.abs(r.deviationVedanjayPct));
      if (Number.isFinite(r.deviationTestingPct)) absDeviations.push(Math.abs(r.deviationTestingPct));
    });
    const avgAbsDevPct = absDeviations.length
      ? absDeviations.reduce((sum, v) => sum + v, 0) / absDeviations.length
      : 0;

    const totalOseplFinalMachine = useMachine
      ? rows.reduce((sum, r) => sum + (Number.isFinite(r.oseplFinalMachineRs) ? r.oseplFinalMachineRs : 0), 0)
      : 0;
    const totalOseplFinalManualEdited = useManualEdited
      ? rows.reduce((sum, r) => sum + (Number.isFinite(r.oseplFinalManualEditedRs) ? r.oseplFinalManualEditedRs : 0), 0)
      : 0;
    const totalOseplFinalVedanjay = rows.reduce(
      (sum, r) => sum + (Number.isFinite(r.oseplFinalVedanjayRs) ? r.oseplFinalVedanjayRs : 0),
      0
    );
    const totalOseplFinalTesting = rows.reduce(
      (sum, r) => sum + (Number.isFinite(r.oseplFinalTestingRs) ? r.oseplFinalTestingRs : 0),
      0
    );
    return {
      avgMachineDevPct,
      avgManualEditedDevPct,
      avgEnercastDevPct,
      avgVedanjayDevPct,
      avgTestingDevPct,
      avgAbsDevPct,
      totalPenaltyMachine,
      totalPenaltyManualEdited,
      totalPenaltyEnercast,
      totalPenaltyVedanjay,
      totalPenaltyTesting,
      totalOseplFinalMachine,
      totalOseplFinalManualEdited,
      totalOseplFinalVedanjay,
      totalOseplFinalTesting,
      validDiffCount: Math.max(machineDevRows.length, manualEditedDevRows.length, enercastDevRows.length, vedanjayDevRows.length, testingDevRows.length),
    };
  }, [rows]);

  useEffect(() => {
    const loadKey = `${selectedSiteContext.siteCode}:${selectedDate}`;
    if (!rows.length || pendingComparisonSaveRef.current !== loadKey) return;
    pendingComparisonSaveRef.current = '';
    const persistOsepl = selectedSiteContext.siteCode === 'OSEPL';

    const sourceDefinitions = [
      {
        source: 'SYSTEM',
        scheduleField: 'machineScheduleMw',
        deviationField: 'deviationMachineMw',
        deviationPercentField: 'deviationMachinePct',
        penaltyField: persistOsepl ? 'oseplFinalMachineRs' : 'penaltyMachine',
        payableField: 'oseplPayableMachineRs',
        receivableField: 'oseplReceivableMachineRs',
        scheduleFile: systemFrozenMeta?.fileName || null,
      },
      {
        source: 'MANUAL',
        scheduleField: 'manualEditedScheduleMw',
        deviationField: 'deviationManualEditedMw',
        deviationPercentField: 'deviationManualEditedPct',
        penaltyField: persistOsepl ? 'oseplFinalManualEditedRs' : 'penaltyManualEdited',
        payableField: 'oseplPayableManualEditedRs',
        receivableField: 'oseplReceivableManualEditedRs',
        scheduleFile: editedFrozenMeta?.fileName || null,
      },
      {
        source: 'ENERCAST',
        scheduleField: 'enercastFrozenSchedule',
        deviationField: 'deviationEnercastMw',
        deviationPercentField: 'deviationEnercastPct',
        penaltyField: 'penaltyEnercast',
        scheduleFile: enercastFrozenMap ? 'enercast_edited_frozen.csv' : null,
      },
      {
        source: 'TESTENV',
        scheduleField: 'testingScheduleMw',
        deviationField: 'deviationTestingMw',
        deviationPercentField: 'deviationTestingPct',
        penaltyField: persistOsepl ? 'oseplFinalTestingRs' : 'penaltyTesting',
        payableField: 'oseplPayableTestingRs',
        receivableField: 'oseplReceivableTestingRs',
        scheduleFile: testingMap ? (testingFileName || null) : null,
      },
      {
        source: 'VEDANJAY',
        scheduleField: 'vedanjayScheduleMw',
        deviationField: 'deviationVedanjayMw',
        deviationPercentField: 'deviationVedanjayPct',
        penaltyField: persistOsepl ? 'oseplFinalVedanjayRs' : 'penaltyVedanjay',
        payableField: 'oseplPayableVedanjayRs',
        receivableField: 'oseplReceivableVedanjayRs',
        scheduleFile: fileName || null,
      },
    ];
    const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);
    const payload = {
      plant_code: selectedSiteContext.siteCode,
      schedule_date: selectedDate,
      sources: sourceDefinitions.map((definition) => ({
        source: definition.source,
        schedule_file: definition.scheduleFile,
        meter_file: meterMeta?.fileName || meterUploadName || null,
        blocks: rows.map((row) => ({
          block_number: row.block,
          scheduled_mw: finiteOrNull(row[definition.scheduleField]),
          actual_meter_mw: finiteOrNull(row.meterActualMw),
          deviation_mw: finiteOrNull(row[definition.deviationField]),
          deviation_percent: finiteOrNull(row[definition.deviationPercentField]),
          penalty_amount: finiteOrNull(row[definition.penaltyField]),
          payable_amount: finiteOrNull(row[definition.payableField]),
          receivable_amount: finiteOrNull(row[definition.receivableField]),
          net_settlement: finiteOrNull(row[definition.penaltyField]),
          ppa_amount: null,
        })),
      })),
    };

    let cancelled = false;
    setIsSavingComparisonResult(true);
    allPlantPenaltyApi.storeComparisonResults(payload)
      .then(() => {
        if (cancelled) return;
        refreshPenaltyReportReadiness();
        toast.success('Comparison penalties saved for the all-plant report');
      })
      .catch((error) => {
        if (!cancelled) {
          toast.warning(error?.message || 'Comparison is displayed, but report values could not be saved.');
        }
      })
      .finally(() => {
        if (!cancelled) setIsSavingComparisonResult(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    rows,
    selectedDate,
    selectedSiteContext.siteCode,
    systemFrozenMeta,
    editedFrozenMeta,
    enercastFrozenMap,
    testingMap,
    testingFileName,
    fileName,
    meterMeta,
    meterUploadName,
    refreshPenaltyReportReadiness,
    comparisonSaveRevision,
  ]);

  const plotData = useMemo(() => {
    if (!rows.length) return [];
    const capacityMw =
      Number(selectedSiteConfig?.capacityMw || 0)
      || PLANT_CAPACITY_FALLBACK[String(selectedSiteConfig?.code || '').toUpperCase()]
      || PLANT_CAPACITY_FALLBACK[String(selectedSiteConfig?.name || '').toUpperCase()]
      || 0;
    const resolvedSiteCode = normalizePlantCode(
      String(selectedSiteConfig?.code || '').trim().toUpperCase()
      || derivePlantCodeFromName(selectedSiteConfig?.name)
      || derivePlantCodeFromName(selectedSite)
      || String(selectedSite || '').trim().toUpperCase()
    );
    const plantState =
      selectedSiteConfig?.state
      || PLANT_STATE_FALLBACK[resolvedSiteCode]
      || '';
    const plantType =
      selectedSiteConfig?.type
      || PLANT_TYPE_FALLBACK[resolvedSiteCode]
      || 'Solar';
    let allowedBandPercent = getAllowedLimitPercent(plantState, plantType);
    if (['BHUPALPALLY', 'KASIPET', 'KOTHAGUDEM'].includes(resolvedSiteCode)) {
      allowedBandPercent = 15;
    }
    const allowedBandMw = (capacityMw * allowedBandPercent) / 100;
    const hideMeterLine = String(selectedSiteConfig?.code || '').trim().toUpperCase() === 'GSNP';
    const blockIntervals = rows.map((r) => blockToInterval(r.block));
    const blockLabels = rows.map((r) => `Block ${r.block} (${blockToInterval(r.block)})`);
    const hoverCustomdata = rows.map((r) => [r.block, blockToInterval(r.block)]);
    const meterSeriesRaw = rows.map((r) => (Number.isFinite(r.meterActual) ? r.meterActual : null));
    // Plot-only smoothing for meter line:
    // fill short missing stretches so graph does not look "broken"
    // while keeping raw values unchanged for calculations and table exports.
    const meterSeries = (() => {
      const series = [...meterSeriesRaw];
      const maxFillGapBlocks = 3;
      let i = 0;
      while (i < series.length) {
        if (Number.isFinite(series[i])) {
          i += 1;
          continue;
        }
        const start = i;
        while (i < series.length && !Number.isFinite(series[i])) i += 1;
        const end = i - 1;
        const prevIdx = start - 1;
        const nextIdx = i;
        const gapLen = end - start + 1;
        const hasPrev = prevIdx >= 0 && Number.isFinite(series[prevIdx]);
        const hasNext = nextIdx < series.length && Number.isFinite(series[nextIdx]);
        if (!(hasPrev && hasNext) || gapLen > maxFillGapBlocks) continue;
        const prevVal = Number(series[prevIdx]);
        const nextVal = Number(series[nextIdx]);
        for (let g = 1; g <= gapLen; g += 1) {
          const t = g / (gapLen + 1);
          series[start + (g - 1)] = prevVal + ((nextVal - prevVal) * t);
        }
      }
      return series;
    })();

    const traces = [];
    const hasMachine = Boolean(rows.some((r) => Number.isFinite(r.machineSchedule)));
    const hasManualEdited = Boolean(rows.some((r) => Number.isFinite(r.manualEditedSchedule)));
    const hasEnercastFrozen = Boolean(rows.some((r) => Number.isFinite(r.enercastFrozenSchedule)));
    const hasVedanjay = Boolean(rows.some((r) => Number.isFinite(r.vedanjaySchedule)));
    const hasTesting = Boolean(rows.some((r) => Number.isFinite(r.testingSchedule)));
    const hasMeter = Boolean(!hideMeterLine && meterSeriesRaw.some((v) => Number.isFinite(v)));

    const bandBaseline = hasManualEdited
      ? 'manualEdited'
      : hasMachine
        ? 'machine'
        : null;

    const baselineSeries = rows.map((r) => {
      if (bandBaseline === 'manualEdited') return r.manualEditedSchedule ?? null;
      if (bandBaseline === 'machine') return r.machineSchedule ?? null;
      return null;
    });

    if (hasMachine) {
      traces.push({
        uid: 'systemFrozenSchedule',
        x: blockLabels,
        y: rows.map((r) => r.machineSchedule ?? null),
        customdata: hoverCustomdata,
        type: 'scatter',
        mode: 'lines',
        name: 'System Frozen Schedule (MW)',
        line: { color: CHART_COLORS.machineSchedule, width: 1.6 },
        hovertemplate: '%{y:.2f} MW<extra>System Frozen Schedule</extra>',
        connectgaps: false,
      });
    }

    if (hasManualEdited) {
      traces.push({
        uid: 'editedFrozenSchedule',
        x: blockLabels,
        y: rows.map((r) => r.manualEditedSchedule ?? null),
        customdata: hoverCustomdata,
        type: 'scatter',
        mode: 'lines',
        name: 'Edited Frozen Schedule (MW)',
        line: { color: '#ec4899', width: 1.6 },
        hovertemplate: '%{y:.2f} MW<extra>Edited Frozen Schedule</extra>',
        connectgaps: false,
      });
    }

    if (hasEnercastFrozen) {
      traces.push({
        uid: 'enercastEditedFrozenSchedule',
        x: blockLabels,
        y: rows.map((r) => r.enercastFrozenSchedule ?? null),
        customdata: hoverCustomdata,
        type: 'scatter',
        mode: 'lines',
        name: 'Enercast Frozen Schedule (MW)',
        line: { color: CHART_COLORS.enercastFrozen, width: 1.8 },
        hovertemplate: '%{y:.2f} MW<extra>Enercast Frozen Schedule</extra>',
        connectgaps: false,
      });
    }

    // Allowed band should follow edited_frozen.csv when available; otherwise fall back to system_frozen.csv.
    if (bandBaseline) {
      traces.push(
        {
          uid: 'allowedBand-lower',
          x: blockLabels,
          y: baselineSeries.map((v) => (Number.isFinite(v) ? v - allowedBandMw : null)),
          customdata: hoverCustomdata,
          type: 'scatter',
          mode: 'lines',
          name: `Allowed Band (\u00b1${allowedBandPercent}%)`,
          line: { color: CHART_COLORS.allowedBand, width: 0.8, dash: 'solid' },
          opacity: 0.9,
          hoverinfo: 'skip',
          showlegend: false,
          legendgroup: 'allowedBand',
          connectgaps: false,
        },
        {
          uid: 'allowedBand-upper',
          x: blockLabels,
          y: baselineSeries.map((v) => (Number.isFinite(v) ? v + allowedBandMw : null)),
          customdata: hoverCustomdata,
          type: 'scatter',
          mode: 'lines',
          name: `Allowed Band (\u00b1${allowedBandPercent}%)`,
          line: { color: CHART_COLORS.allowedBand, width: 0.8, dash: 'solid' },
          fill: 'tonexty',
          fillcolor: isDarkMode ? 'rgba(156,163,175,0.10)' : 'rgba(156,163,175,0.14)',
          opacity: 0.9,
          hoverinfo: 'skip',
          showlegend: true,
          legendgroup: 'allowedBand',
          connectgaps: false,
        }
      );
    }

    if (hasVedanjay) {
      traces.push({
        uid: 'uploadedVedanjaySchedule',
        x: blockLabels,
        y: rows.map((r) => r.vedanjaySchedule ?? null),
        customdata: blockIntervals,
        type: 'scatter',
        mode: 'lines',
        name: 'Vedanjay Schedule',
        line: { color: CHART_COLORS.vedanjaySchedule, width: 1.6 },
        hovertemplate: '%{y:.2f} MW<extra>Vedanjay Schedule</extra>',
        connectgaps: false,
      });
    }

    if (hasTesting) {
      traces.push({
        uid: 'uploadedTestingSchedule',
        x: blockLabels,
        y: rows.map((r) => r.testingSchedule ?? null),
        customdata: blockIntervals,
        type: 'scatter',
        mode: 'lines',
        name: 'Testing Schedule',
        line: { color: '#8b5cf6', width: 1.6 },
        hovertemplate: '%{y:.2f} MW<extra>Testing Schedule</extra>',
        connectgaps: false,
      });
    }

    if (hasMeter) {
      traces.push({
        uid: 'meterData',
        x: blockLabels,
        y: meterSeries,
        type: 'scatter',
        mode: 'lines',
        name: 'Meter Data (MW)',
        line: { color: getActualLineColor(isDarkMode), width: 1.8 },
        hovertemplate: 'Meter Data: %{y:.2f} MW<extra>Meter Data</extra>',
        connectgaps: true,
      });
    }

    return traces.map((trace) => {
      const normalizedTrace = (() => {
        if (String(trace?.type || '').toLowerCase() !== 'scatter') return trace;
        if (!String(trace?.mode || '').includes('lines')) return trace;
        const isAllowedBandTrace = String(trace?.uid || '').startsWith('allowedBand');
        const traceColor = trace?.line?.color || (isDarkMode ? '#e2e8f0' : '#0f172a');
        if (isAllowedBandTrace) {
          return { ...trace, line: { ...(trace.line || {}), shape: 'spline', smoothing: 0.45 } };
        }
        return {
          ...trace,
          mode: 'lines+markers',
          line: { ...(trace.line || {}), shape: 'spline', smoothing: 0.45 },
          marker: {
            symbol: 'square',
            size: 5,
            color: traceColor,
            line: { width: 0, color: traceColor },
          },
        };
      })();
      return {
        ...normalizedTrace,
        visible: isTraceHidden(normalizedTrace?.uid) ? 'legendonly' : true,
      };
    });
  }, [rows, selectedSiteConfig, selectedSite, isDarkMode, isTraceHidden]);

  const dataPresence = useMemo(() => {
    const hasMeter = rows.some((r) => Number.isFinite(r.meterActual));
    const hasIntraday = rows.some((r) => Number.isFinite(r.intradayForecast));
    const hasMachine = rows.some((r) => Number.isFinite(r.machineSchedule));
    const hasManualEdited = rows.some((r) => Number.isFinite(r.manualEditedSchedule));
    const hasEnercastFrozen = rows.some((r) => Number.isFinite(r.enercastFrozenSchedule));
    const hasVedanjay = rows.some((r) => Number.isFinite(r.vedanjaySchedule));
    const hasTesting = rows.some((r) => Number.isFinite(r.testingSchedule));
    return {
      hasMeter,
      hasIntraday,
      hasMachine,
      hasManualEdited,
      hasEnercastFrozen,
      hasVedanjay,
      hasTesting,
    };
  }, [rows]);

  useEffect(() => {
    if (oseplCalcSource === 'manualEdited' && !dataPresence.hasManualEdited) {
      setOseplCalcSource('machine');
    }
  }, [oseplCalcSource, dataPresence.hasManualEdited]);

  const isOseplSite = selectedSiteContext.siteCode === 'OSEPL';
  const isDailySummarySite = ['SIRMOUR', 'KASIPET', 'BHUPALPALLY', 'KOTHAGUDEM'].includes(selectedSiteContext.siteCode);

  const plantDailySummary = useMemo(() => {
    if (!isDailySummarySite || !rows.length) return null;

    const siteCode = String(selectedSiteContext.siteCode || '').trim().toUpperCase();
    const isTodaySelected = selectedDate === new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const currentIstBlock = isTodaySelected ? getCurrentIstBlock() : TOTAL_BLOCKS;
    const BLOCK_HOURS = 0.25;
    const KWH_PER_MWH = 1000;

    const monthKey = (() => {
      try {
        const dt = new Date(`${selectedDate}T00:00:00Z`);
        const month = dt.toLocaleString('en-US', { month: 'short', timeZone: 'Asia/Kolkata' });
        const yy = dt.toLocaleString('en-CA', { year: '2-digit', timeZone: 'Asia/Kolkata' });
        return `${month}-${yy}`;
      } catch {
        return '';
      }
    })();

    const generationKwh = rows.reduce((sum, r) => {
      if (Number(r.block) > currentIstBlock) return sum;
      const actualMw = Number(r.meterActualMw);
      if (!Number.isFinite(actualMw)) return sum;
      return sum + (actualMw * BLOCK_HOURS * KWH_PER_MWH);
    }, 0);

    const pickPenalty = (row) => {
      if (oseplCalcSource === 'vedanjay') return Number(row.penaltyVedanjay);
      if (oseplCalcSource === 'manualEdited') return Number(row.penaltyManualEdited);
      return Number(row.penaltyMachine);
    };

    const ppaRateRsPerKwh = getPpaRateRsPerKwh({ siteCode, siteConfig: selectedSiteConfig });

    const penaltySample = rows.reduce((acc, r) => {
      if (Number(r.block) > currentIstBlock) return acc;
      const v = pickPenalty(r);
      if (Number.isFinite(v)) {
        acc.count += 1;
        acc.sum += v;
      }
      return acc;
    }, { count: 0, sum: 0 });

    const errorFlagField = 'oseplErrorBlockFlag';
    const expectedScadaBlocks = rows.filter((r) => Number(r.block) <= currentIstBlock);
    const hasErrorFlags = expectedScadaBlocks.some((r) => Number(r?.[errorFlagField]) === 1);
    const availableScadaBlocks = expectedScadaBlocks.filter((r) => Number(r?.[errorFlagField]) !== 1).length;
    const scadaAvailabilityPercent = expectedScadaBlocks.length > 0
      ? (hasErrorFlags
        ? (availableScadaBlocks / expectedScadaBlocks.length) * 100
        : 100)
      : 100;

    const dsmPenaltyMaintenanceRs = penaltySample.sum;

    const dsmPenaltyScadaRs = hasErrorFlags
      ? rows.reduce((sum, r) => {
        if (Number(r.block) > currentIstBlock) return sum;
        if (Number(r?.oseplErrorBlockFlag) === 1) return sum;
        const v = pickPenalty(r);
        return Number.isFinite(v) ? sum + v : sum;
      }, 0)
      : dsmPenaltyMaintenanceRs;

    const hasPenaltyData = penaltySample.count > 0;
    const paisaPerKwhScada = hasPenaltyData && generationKwh > 0 ? ((dsmPenaltyScadaRs / generationKwh) * 100).toFixed(2) : '--';
    const paisaPerKwhMaintenance = hasPenaltyData && generationKwh > 0 ? ((dsmPenaltyMaintenanceRs / generationKwh) * 100).toFixed(2) : '--';

    const sourceLabel =
      oseplCalcSource === 'vedanjay'
        ? 'Vedanjay'
        : oseplCalcSource === 'manualEdited'
          ? 'Manual Edited'
          : 'Machine';

    if (siteCode === 'SIRMOUR') {
      const netRevenue = Number.isFinite(ppaRateRsPerKwh) ? generationKwh * ppaRateRsPerKwh : null;
      const impactPct = Number.isFinite(netRevenue) && netRevenue > 0 ? (dsmPenaltyMaintenanceRs / netRevenue) * 100 : null;
      return {
        title: 'Sirmour Daily Summary',
        subtitle: `15-min block-wise settlement totals (${sourceLabel})`,
        variant: 'sirmour',
        columns: ['From', 'To', 'Project', 'Installed Capacity (MW)', 'Generation (kWh)', 'DSM Penalty (Rs.)', 'Paisa / kWh', 'Net Revenue', '%Impact'],
        row: {
          From: selectedDate,
          To: selectedDate,
          Project: 'Sirmour_Schedule',
          'Installed Capacity (MW)': Number(selectedSiteContext.siteCapacityMw || 0).toFixed(1),
          'Generation (kWh)': generationKwh ? generationKwh.toFixed(0) : '0',
          'DSM Penalty (Rs.)': hasPenaltyData ? dsmPenaltyMaintenanceRs.toFixed(0) : '--',
          'Paisa / kWh': paisaPerKwhMaintenance,
          'Net Revenue': Number.isFinite(netRevenue) ? netRevenue.toFixed(2) : '--',
          '%Impact': Number.isFinite(impactPct) ? `${impactPct.toFixed(2)}%` : '--',
        },
      };
    }

    return {
      title: `${displayPlantName(siteCode)} Daily Summary`,
      subtitle: `15-min block-wise settlement totals (${sourceLabel})`,
      variant: 'multi',
      columns: [
        'Date',
        'To',
        'Month',
        'Project',
        'Installed Capacity (MW)',
        'Generation (kWh)',
        'DSM Penalty (Rs.) As per SCADA Availability',
        'DSM Penalty (Rs.) As Maintenance Information',
        'Paisa/kWh SCADA Availability',
        'Paisa/kWh Maintenance Information',
        'SCADA Availability(%)',
      ],
      row: {
        Date: selectedDate,
        To: selectedDate,
        Month: monthKey,
        Project: siteCode,
        'Installed Capacity (MW)': Number(selectedSiteContext.siteCapacityMw || 0).toFixed(0),
        'Generation (kWh)': generationKwh ? generationKwh.toFixed(0) : '0',
        'DSM Penalty (Rs.) As per SCADA Availability': hasPenaltyData ? dsmPenaltyScadaRs.toFixed(0) : '--',
        'DSM Penalty (Rs.) As Maintenance Information': hasPenaltyData ? dsmPenaltyMaintenanceRs.toFixed(0) : '--',
        'Paisa/kWh SCADA Availability': paisaPerKwhScada,
        'Paisa/kWh Maintenance Information': paisaPerKwhMaintenance,
        'SCADA Availability(%)': `${Number(scadaAvailabilityPercent || 0).toFixed(0)}%`,
      },
    };
  }, [isDailySummarySite, rows, selectedDate, selectedSiteContext, oseplCalcSource, selectedSiteConfig]);

  const oseplDailySummaryVedanjay = useMemo(() => {
    if (!isOseplSite || !rows.length || !dataPresence.hasVedanjay) return null;

    const PPA_RATE = 9.27;
    const BLOCK_HOURS = 0.25;
    const KWH_PER_MWH = 1000;
    const round2 = (value) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      return Math.round((n + Number.EPSILON) * 100) / 100;
    };

    const dt = new Date(`${selectedDate}T00:00:00+05:30`);
    const month = dt.toLocaleString('en-US', { month: 'short', timeZone: 'Asia/Kolkata' });
    const year2 = dt.toLocaleString('en-US', { year: '2-digit', timeZone: 'Asia/Kolkata' });
    const monthKey = `${month}-${year2}`;

    const todayIst = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const isTodaySelected = selectedDate === todayIst;
    const currentIstBlock = isTodaySelected ? getCurrentIstBlock() : TOTAL_BLOCKS;

    const errorFlagField = 'oseplErrorBlockFlag';
    const expectedScadaBlocks = rows.filter((r) => Number(r.block) <= currentIstBlock);
    const hasErrorFlags = expectedScadaBlocks.some((r) => Number(r?.[errorFlagField]) === 1);
    const availableScadaBlocks = expectedScadaBlocks.filter((r) => Number(r?.[errorFlagField]) !== 1).length;
    const scadaAvailabilityPercent = expectedScadaBlocks.length > 0
      ? (hasErrorFlags
        ? (availableScadaBlocks / expectedScadaBlocks.length) * 100
        : 100)
      : 100;

    const generationKwh = rows.reduce((sum, r) => {
      if (Number(r.block) > currentIstBlock) return sum;
      const actualMw = Number(r.meterActualMw);
      if (!Number.isFinite(actualMw)) return sum;
      return sum + (actualMw * BLOCK_HOURS * KWH_PER_MWH);
    }, 0);

    const scheduledKwh = rows.reduce((sum, r) => {
      if (Number(r.block) > currentIstBlock) return sum;
      const sched = Number(r.vedanjayScheduleMw);
      if (!Number.isFinite(sched)) return sum;
      return sum + (sched * BLOCK_HOURS * KWH_PER_MWH);
    }, 0);

    const totalsRaw = rows.reduce((acc, r) => {
      if (Number(r.block) > currentIstBlock) return acc;
      const payableRaw = Number(r.oseplPayableVedanjayRs);
      const receivableRaw = Number(r.oseplReceivableVedanjayRs);
      const finalRaw = Number(r.oseplFinalVedanjayRs);

      if (Number.isFinite(payableRaw)) acc.totalPayable += payableRaw;
      if (Number.isFinite(receivableRaw)) acc.totalReceivable += receivableRaw;
      if (Number.isFinite(receivableRaw) && Number.isFinite(payableRaw)) acc.netDsm += (receivableRaw - payableRaw);
      if (Number.isFinite(finalRaw)) acc.dsmPenalty += finalRaw;
      return acc;
    }, { totalPayable: 0, totalReceivable: 0, netDsm: 0, dsmPenalty: 0 });

    const totals = {
      totalPayable: round2(totalsRaw.totalPayable) ?? 0,
      totalReceivable: round2(totalsRaw.totalReceivable) ?? 0,
      netDsm: round2(totalsRaw.netDsm) ?? 0,
      dsmPenalty: round2(totalsRaw.dsmPenalty) ?? 0,
    };

    const adjustedDsm = hasErrorFlags
      ? rows.reduce((sum, r) => {
        if (Number(r.block) > currentIstBlock) return sum;
        if (Number(r?.oseplErrorBlockFlag) === 1) return sum;
        const finalRaw = Number(r.oseplFinalVedanjayRs);
        return Number.isFinite(finalRaw) ? sum + finalRaw : sum;
      }, 0)
      : totals.dsmPenalty;

    return {
      fromDate: selectedDate,
      monthKey,
      project: 'ESSEL',
      installedCapacityMw: selectedSiteContext.siteCapacityMw || 0,
      scadaAvailabilityPercent,
      generationKwh,
      scheduledUnitPpaRs: scheduledKwh * PPA_RATE,
      payableRs: totals.totalPayable,
      receivableRs: totals.totalReceivable,
      netDsmRs: totals.netDsm,
      dsmPenaltyRs: totals.dsmPenalty,
      dsmPenaltyAvailabilityRs: adjustedDsm,
      ppaRate: PPA_RATE,
    };
  }, [isOseplSite, rows, selectedDate, selectedSiteContext, dataPresence.hasVedanjay]);

  const oseplDailySummaryManualEdited = useMemo(() => {
    if (!isOseplSite || !rows.length || !dataPresence.hasManualEdited) return null;

    const PPA_RATE = 9.27;
    const BLOCK_HOURS = 0.25;
    const KWH_PER_MWH = 1000;
    const round2 = (value) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      return Math.round((n + Number.EPSILON) * 100) / 100;
    };

    const dt = new Date(`${selectedDate}T00:00:00+05:30`);
    const month = dt.toLocaleString('en-US', { month: 'short', timeZone: 'Asia/Kolkata' });
    const year2 = dt.toLocaleString('en-US', { year: '2-digit', timeZone: 'Asia/Kolkata' });
    const monthKey = `${month}-${year2}`;

    const todayIst = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const isTodaySelected = selectedDate === todayIst;
    const currentIstBlock = isTodaySelected ? getCurrentIstBlock() : TOTAL_BLOCKS;

    const errorFlagField = 'oseplErrorBlockFlag';
    const expectedScadaBlocks = rows.filter((r) => Number(r.block) <= currentIstBlock);
    const hasErrorFlags = expectedScadaBlocks.some((r) => Number(r?.[errorFlagField]) === 1);
    const availableScadaBlocks = expectedScadaBlocks.filter((r) => Number(r?.[errorFlagField]) !== 1).length;
    const scadaAvailabilityPercent = expectedScadaBlocks.length > 0
      ? (hasErrorFlags
        ? (availableScadaBlocks / expectedScadaBlocks.length) * 100
        : 100)
      : 100;

    const generationKwh = rows.reduce((sum, r) => {
      if (Number(r.block) > currentIstBlock) return sum;
      const actualMw = Number(r.meterActualMw);
      if (!Number.isFinite(actualMw)) return sum;
      return sum + (actualMw * BLOCK_HOURS * KWH_PER_MWH);
    }, 0);

    const scheduledKwh = rows.reduce((sum, r) => {
      if (Number(r.block) > currentIstBlock) return sum;
      const sched = Number(r.manualEditedScheduleMw);
      if (!Number.isFinite(sched)) return sum;
      return sum + (sched * BLOCK_HOURS * KWH_PER_MWH);
    }, 0);

    const totalsRaw = rows.reduce((acc, r) => {
      if (Number(r.block) > currentIstBlock) return acc;
      const payableRaw = Number(r.oseplPayableManualEditedRs);
      const receivableRaw = Number(r.oseplReceivableManualEditedRs);
      const finalRaw = Number(r.oseplFinalManualEditedRs);

      if (Number.isFinite(payableRaw)) acc.totalPayable += payableRaw;
      if (Number.isFinite(receivableRaw)) acc.totalReceivable += receivableRaw;
      if (Number.isFinite(receivableRaw) && Number.isFinite(payableRaw)) acc.netDsm += (receivableRaw - payableRaw);
      if (Number.isFinite(finalRaw)) acc.dsmPenalty += finalRaw;
      return acc;
    }, { totalPayable: 0, totalReceivable: 0, netDsm: 0, dsmPenalty: 0 });

    const totals = {
      totalPayable: round2(totalsRaw.totalPayable) ?? 0,
      totalReceivable: round2(totalsRaw.totalReceivable) ?? 0,
      netDsm: round2(totalsRaw.netDsm) ?? 0,
      dsmPenalty: round2(totalsRaw.dsmPenalty) ?? 0,
    };

    const adjustedDsm = hasErrorFlags
      ? rows.reduce((sum, r) => {
        if (Number(r.block) > currentIstBlock) return sum;
        if (Number(r?.oseplErrorBlockFlag) === 1) return sum;
        const finalRaw = Number(r.oseplFinalManualEditedRs);
        return Number.isFinite(finalRaw) ? sum + finalRaw : sum;
      }, 0)
      : totals.dsmPenalty;

    return {
      fromDate: selectedDate,
      monthKey,
      project: 'ESSEL',
      installedCapacityMw: selectedSiteContext.siteCapacityMw || 0,
      scadaAvailabilityPercent,
      generationKwh,
      scheduledUnitPpaRs: scheduledKwh * PPA_RATE,
      payableRs: totals.totalPayable,
      receivableRs: totals.totalReceivable,
      netDsmRs: totals.netDsm,
      dsmPenaltyRs: totals.dsmPenalty,
      dsmPenaltyAvailabilityRs: adjustedDsm,
      ppaRate: PPA_RATE,
    };
  }, [isOseplSite, rows, selectedDate, selectedSiteContext, dataPresence.hasManualEdited]);

  const plantDailySummaryVedanjay = useMemo(() => {
    if (!isDailySummarySite || !rows.length || !dataPresence.hasVedanjay) return null;

    const siteCode = String(selectedSiteContext.siteCode || '').trim().toUpperCase();
    const todayIst = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const isTodaySelected = selectedDate === todayIst;
    const currentIstBlock = isTodaySelected ? getCurrentIstBlock() : TOTAL_BLOCKS;
    const BLOCK_HOURS = 0.25;
    const KWH_PER_MWH = 1000;

    const monthKey = (() => {
      try {
        const dt = new Date(`${selectedDate}T00:00:00Z`);
        const month = dt.toLocaleString('en-US', { month: 'short', timeZone: 'Asia/Kolkata' });
        const yy = dt.toLocaleString('en-CA', { year: '2-digit', timeZone: 'Asia/Kolkata' });
        return `${month}-${yy}`;
      } catch {
        return '';
      }
    })();

    const generationKwh = rows.reduce((sum, r) => {
      if (Number(r.block) > currentIstBlock) return sum;
      const actualMw = Number(r.meterActualMw);
      if (!Number.isFinite(actualMw)) return sum;
      return sum + (actualMw * BLOCK_HOURS * KWH_PER_MWH);
    }, 0);

    const expectedScadaBlocks = rows.filter((r) => Number(r.block) <= currentIstBlock);
    const hasErrorFlags = expectedScadaBlocks.some((r) => Number(r?.oseplErrorBlockFlag) === 1);
    const availableScadaBlocks = expectedScadaBlocks.filter((r) => Number(r?.oseplErrorBlockFlag) !== 1).length;
    const scadaAvailabilityPercent = expectedScadaBlocks.length > 0
      ? (hasErrorFlags
        ? (availableScadaBlocks / expectedScadaBlocks.length) * 100
        : 100)
      : 100;

    const dsmPenaltyMaintenanceRs = rows.reduce((sum, r) => {
      if (Number(r.block) > currentIstBlock) return sum;
      const v = Number(r.penaltyVedanjay);
      return Number.isFinite(v) ? sum + v : sum;
    }, 0);

    const dsmPenaltyScadaRs = hasErrorFlags
      ? rows.reduce((sum, r) => {
        if (Number(r.block) > currentIstBlock) return sum;
        if (Number(r?.oseplErrorBlockFlag) === 1) return sum;
        const v = Number(r.penaltyVedanjay);
        return Number.isFinite(v) ? sum + v : sum;
      }, 0)
      : dsmPenaltyMaintenanceRs;

    const paisaPerKwhScada = generationKwh > 0 ? ((dsmPenaltyScadaRs / generationKwh) * 100).toFixed(2) : '--';
    const paisaPerKwhMaintenance = generationKwh > 0 ? ((dsmPenaltyMaintenanceRs / generationKwh) * 100).toFixed(2) : '--';

    const ppaRateRsPerKwh = getPpaRateRsPerKwh({ siteCode, siteConfig: selectedSiteConfig });

    if (siteCode === 'SIRMOUR') {
      const netRevenue = Number.isFinite(ppaRateRsPerKwh) ? generationKwh * ppaRateRsPerKwh : null;
      const impactPct = Number.isFinite(netRevenue) && netRevenue > 0 ? (dsmPenaltyMaintenanceRs / netRevenue) * 100 : null;
      return {
        title: 'Sirmour Daily Summary',
        subtitle: 'Vedanjay uploaded schedule only',
        variant: 'sirmour',
        columns: ['From', 'To', 'Project', 'Installed Capacity (MW)', 'Generation (kWh)', 'DSM Penalty (Rs.)', 'Paisa / kWh', 'Net Revenue', '%Impact'],
        row: {
          From: selectedDate,
          To: selectedDate,
          Project: 'Sirmour_Schedule',
          'Installed Capacity (MW)': Number(selectedSiteContext.siteCapacityMw || 0).toFixed(1),
          'Generation (kWh)': generationKwh ? generationKwh.toFixed(0) : '0',
          'DSM Penalty (Rs.)': dsmPenaltyMaintenanceRs ? dsmPenaltyMaintenanceRs.toFixed(0) : '0',
          'Paisa / kWh': paisaPerKwhMaintenance,
          'Net Revenue': Number.isFinite(netRevenue) ? netRevenue.toFixed(2) : '--',
          '%Impact': Number.isFinite(impactPct) ? `${impactPct.toFixed(2)}%` : '--',
        },
      };
    }

    return {
      title: `${displayPlantName(siteCode)} Daily Summary`,
      subtitle: 'Vedanjay uploaded schedule only',
      variant: 'multi',
      columns: [
        'Date',
        'To',
        'Month',
        'Project',
        'Installed Capacity (MW)',
        'Generation (kWh)',
        'DSM Penalty (Rs.) As per SCADA Availability',
        'DSM Penalty (Rs.) As Maintenance Information',
        'Paisa/kWh SCADA Availability',
        'Paisa/kWh Maintenance Information',
        'SCADA Availability(%)',
      ],
      row: {
        Date: selectedDate,
        To: selectedDate,
        Month: monthKey,
        Project: siteCode,
        'Installed Capacity (MW)': Number(selectedSiteContext.siteCapacityMw || 0).toFixed(0),
        'Generation (kWh)': generationKwh ? generationKwh.toFixed(0) : '0',
        'DSM Penalty (Rs.) As per SCADA Availability': dsmPenaltyScadaRs ? dsmPenaltyScadaRs.toFixed(0) : '0',
        'DSM Penalty (Rs.) As Maintenance Information': dsmPenaltyMaintenanceRs ? dsmPenaltyMaintenanceRs.toFixed(0) : '0',
        'Paisa/kWh SCADA Availability': paisaPerKwhScada,
        'Paisa/kWh Maintenance Information': paisaPerKwhMaintenance,
        'SCADA Availability(%)': `${Number(scadaAvailabilityPercent || 0).toFixed(0)}%`,
      },
    };
  }, [isDailySummarySite, rows, selectedDate, selectedSiteContext, dataPresence.hasVedanjay, selectedSiteConfig]);

  const plantDailySummaryManualEdited = useMemo(() => {
    if (!isDailySummarySite || !rows.length || !dataPresence.hasManualEdited) return null;

    const siteCode = String(selectedSiteContext.siteCode || '').trim().toUpperCase();
    const todayIst = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const isTodaySelected = selectedDate === todayIst;
    const currentIstBlock = isTodaySelected ? getCurrentIstBlock() : TOTAL_BLOCKS;
    const BLOCK_HOURS = 0.25;
    const KWH_PER_MWH = 1000;

    const monthKey = (() => {
      try {
        const dt = new Date(`${selectedDate}T00:00:00Z`);
        const month = dt.toLocaleString('en-US', { month: 'short', timeZone: 'Asia/Kolkata' });
        const yy = dt.toLocaleString('en-CA', { year: '2-digit', timeZone: 'Asia/Kolkata' });
        return `${month}-${yy}`;
      } catch {
        return '';
      }
    })();

    const generationKwh = rows.reduce((sum, r) => {
      if (Number(r.block) > currentIstBlock) return sum;
      const actualMw = Number(r.meterActualMw);
      if (!Number.isFinite(actualMw)) return sum;
      return sum + (actualMw * BLOCK_HOURS * KWH_PER_MWH);
    }, 0);

    const expectedScadaBlocks = rows.filter((r) => Number(r.block) <= currentIstBlock);
    const hasErrorFlags = expectedScadaBlocks.some((r) => Number(r?.oseplErrorBlockFlag) === 1);
    const availableScadaBlocks = expectedScadaBlocks.filter((r) => Number(r?.oseplErrorBlockFlag) !== 1).length;
    const scadaAvailabilityPercent = expectedScadaBlocks.length > 0
      ? (hasErrorFlags
        ? (availableScadaBlocks / expectedScadaBlocks.length) * 100
        : 100)
      : 100;

    const dsmPenaltyMaintenanceRs = rows.reduce((sum, r) => {
      if (Number(r.block) > currentIstBlock) return sum;
      const v = Number(r.penaltyManualEdited);
      return Number.isFinite(v) ? sum + v : sum;
    }, 0);

    const dsmPenaltyScadaRs = hasErrorFlags
      ? rows.reduce((sum, r) => {
        if (Number(r.block) > currentIstBlock) return sum;
        if (Number(r?.oseplErrorBlockFlag) === 1) return sum;
        const v = Number(r.penaltyManualEdited);
        return Number.isFinite(v) ? sum + v : sum;
      }, 0)
      : dsmPenaltyMaintenanceRs;

    const paisaPerKwhScada = generationKwh > 0 ? ((dsmPenaltyScadaRs / generationKwh) * 100).toFixed(2) : '--';
    const paisaPerKwhMaintenance = generationKwh > 0 ? ((dsmPenaltyMaintenanceRs / generationKwh) * 100).toFixed(2) : '--';

    const ppaRateRsPerKwh = getPpaRateRsPerKwh({ siteCode, siteConfig: selectedSiteConfig });

    if (siteCode === 'SIRMOUR') {
      const netRevenue = Number.isFinite(ppaRateRsPerKwh) ? generationKwh * ppaRateRsPerKwh : null;
      const impactPct = Number.isFinite(netRevenue) && netRevenue > 0 ? (dsmPenaltyMaintenanceRs / netRevenue) * 100 : null;
      return {
        title: 'Sirmour Daily Summary',
        subtitle: 'Manual edited schedule only',
        variant: 'sirmour',
        columns: ['From', 'To', 'Project', 'Installed Capacity (MW)', 'Generation (kWh)', 'DSM Penalty (Rs.)', 'Paisa / kWh', 'Net Revenue', '%Impact'],
        row: {
          From: selectedDate,
          To: selectedDate,
          Project: 'Sirmour_Schedule',
          'Installed Capacity (MW)': Number(selectedSiteContext.siteCapacityMw || 0).toFixed(1),
          'Generation (kWh)': generationKwh ? generationKwh.toFixed(0) : '0',
          'DSM Penalty (Rs.)': dsmPenaltyMaintenanceRs ? dsmPenaltyMaintenanceRs.toFixed(0) : '0',
          'Paisa / kWh': paisaPerKwhMaintenance,
          'Net Revenue': Number.isFinite(netRevenue) ? netRevenue.toFixed(2) : '--',
          '%Impact': Number.isFinite(impactPct) ? `${impactPct.toFixed(2)}%` : '--',
        },
      };
    }

    return {
      title: `${displayPlantName(siteCode)} Daily Summary`,
      subtitle: 'Manual edited schedule only',
      variant: 'multi',
      columns: [
        'Date',
        'To',
        'Month',
        'Project',
        'Installed Capacity (MW)',
        'Generation (kWh)',
        'DSM Penalty (Rs.) As per SCADA Availability',
        'DSM Penalty (Rs.) As Maintenance Information',
        'Paisa/kWh SCADA Availability',
        'Paisa/kWh Maintenance Information',
        'SCADA Availability(%)',
      ],
      row: {
        Date: selectedDate,
        To: selectedDate,
        Month: monthKey,
        Project: siteCode,
        'Installed Capacity (MW)': Number(selectedSiteContext.siteCapacityMw || 0).toFixed(0),
        'Generation (kWh)': generationKwh ? generationKwh.toFixed(0) : '0',
        'DSM Penalty (Rs.) As per SCADA Availability': dsmPenaltyScadaRs ? dsmPenaltyScadaRs.toFixed(0) : '0',
        'DSM Penalty (Rs.) As Maintenance Information': dsmPenaltyMaintenanceRs ? dsmPenaltyMaintenanceRs.toFixed(0) : '0',
        'Paisa/kWh SCADA Availability': paisaPerKwhScada,
        'Paisa/kWh Maintenance Information': paisaPerKwhMaintenance,
        'SCADA Availability(%)': `${Number(scadaAvailabilityPercent || 0).toFixed(0)}%`,
      },
    };
  }, [isDailySummarySite, rows, selectedDate, selectedSiteContext, dataPresence.hasManualEdited, selectedSiteConfig]);

  useEffect(() => {
    if (!updateSharedData) return;
    const siteCode = String(selectedSiteContext.siteCode || '').trim().toUpperCase();
    const entry = (() => {
      if (siteCode === 'OSEPL' && oseplDailySummaryVedanjay) {
        return {
          columns: [
            'From',
            'Month',
            'Project',
            'Installed Capacity',
            'SCADA availability %',
            'Generation(kWh)',
            'Scheduled unit*PPA',
            'Payable',
            'Receivable',
            'DSM Penalty (Rs.)',
            'SCADA Adjusted DSM',
            'PPA',
          ],
          rows: [
            {
              From: oseplDailySummaryVedanjay.fromDate,
              Month: oseplDailySummaryVedanjay.monthKey,
              Project: oseplDailySummaryVedanjay.project,
              'Installed Capacity': Number(oseplDailySummaryVedanjay.installedCapacityMw || 0).toFixed(0),
              'SCADA availability %': `${Number(oseplDailySummaryVedanjay.scadaAvailabilityPercent || 0).toFixed(0)}%`,
              'Generation(kWh)': Number(oseplDailySummaryVedanjay.generationKwh || 0).toFixed(0),
              'Scheduled unit*PPA': Number(oseplDailySummaryVedanjay.scheduledUnitPpaRs || 0).toFixed(0),
              Payable: Number(oseplDailySummaryVedanjay.payableRs || 0).toFixed(0),
              Receivable: Number(oseplDailySummaryVedanjay.receivableRs || 0).toFixed(0),
              'DSM Penalty (Rs.)': Number(oseplDailySummaryVedanjay.dsmPenaltyRs || 0).toFixed(0),
              'SCADA Adjusted DSM': Number(oseplDailySummaryVedanjay.dsmPenaltyAvailabilityRs || 0).toFixed(0),
              PPA: Number(oseplDailySummaryVedanjay.ppaRate || 0).toFixed(2),
            },
          ],
        };
      }
      if (plantDailySummaryVedanjay) {
        return {
          columns: plantDailySummaryVedanjay.columns,
          rows: [plantDailySummaryVedanjay.row],
        };
      }
      return null;
    })();

    if (entry) {
      const prevMap = sharedData?.dsmDailySummaryVedanjayByPlant || {};
      const nextMap = { ...prevMap, [siteCode]: { date: selectedDate, payload: entry } };
      updateSharedData({ dsmDailySummaryVedanjayByPlant: nextMap });
    }

    const manualEntry = (() => {
      if (siteCode === 'OSEPL' && oseplDailySummaryManualEdited) {
        return {
          columns: [
            'From',
            'Month',
            'Project',
            'Installed Capacity',
            'SCADA availability %',
            'Generation(kWh)',
            'Scheduled unit*PPA',
            'Payable',
            'Receivable',
            'DSM Penalty (Rs.)',
            'SCADA Adjusted DSM',
            'PPA',
          ],
          rows: [
            {
              From: oseplDailySummaryManualEdited.fromDate,
              Month: oseplDailySummaryManualEdited.monthKey,
              Project: oseplDailySummaryManualEdited.project,
              'Installed Capacity': Number(oseplDailySummaryManualEdited.installedCapacityMw || 0).toFixed(0),
              'SCADA availability %': `${Number(oseplDailySummaryManualEdited.scadaAvailabilityPercent || 0).toFixed(0)}%`,
              'Generation(kWh)': Number(oseplDailySummaryManualEdited.generationKwh || 0).toFixed(0),
              'Scheduled unit*PPA': Number(oseplDailySummaryManualEdited.scheduledUnitPpaRs || 0).toFixed(0),
              Payable: Number(oseplDailySummaryManualEdited.payableRs || 0).toFixed(0),
              Receivable: Number(oseplDailySummaryManualEdited.receivableRs || 0).toFixed(0),
              'DSM Penalty (Rs.)': Number(oseplDailySummaryManualEdited.dsmPenaltyRs || 0).toFixed(0),
              'SCADA Adjusted DSM': Number(oseplDailySummaryManualEdited.dsmPenaltyAvailabilityRs || 0).toFixed(0),
              PPA: Number(oseplDailySummaryManualEdited.ppaRate || 0).toFixed(2),
            },
          ],
        };
      }
      if (plantDailySummaryManualEdited) {
        return {
          columns: plantDailySummaryManualEdited.columns,
          rows: [plantDailySummaryManualEdited.row],
        };
      }
      return null;
    })();

    if (manualEntry) {
      const prevManual = sharedData?.dsmDailySummaryManualEditedByPlant || {};
      const nextManual = { ...prevManual, [siteCode]: { date: selectedDate, payload: manualEntry } };
      updateSharedData({ dsmDailySummaryManualEditedByPlant: nextManual });
    }
  }, [
    updateSharedData,
    sharedData,
    selectedSiteContext.siteCode,
    selectedDate,
    oseplDailySummaryVedanjay,
    plantDailySummaryVedanjay,
    oseplDailySummaryManualEdited,
    plantDailySummaryManualEdited,
  ]);


  const hoverMarkerTrace = useMemo(() => {
    const markerColor = hoverMarker?.color || (isDarkMode ? '#e2e8f0' : '#0f172a');
    return {
      uid: 'hover-marker',
      x: hoverMarker ? [hoverMarker.x] : [],
      y: hoverMarker ? [hoverMarker.y] : [],
      type: 'scatter',
      mode: 'markers',
      xaxis: hoverMarker?.xaxis || 'x',
      yaxis: hoverMarker?.yaxis || 'y',
      hoverinfo: 'skip',
      showlegend: false,
      marker: {
        symbol: 'square-open',
        size: 9,
        color: markerColor,
        line: { width: 2, color: markerColor },
      },
    };
  }, [hoverMarker, isDarkMode]);

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

  const handlePlotClick = useCallback((event) => {
    const points = event?.points;
    if (!Array.isArray(points) || points.length === 0) return;
    const point = points.find((p) => String(p?.fullData?.uid || '').trim() && p?.fullData?.uid !== 'hover-marker');
    const traceUid = point?.fullData?.uid;
    if (!traceUid) return;
    toggleTraceVisibilityByUid(traceUid);
  }, [toggleTraceVisibilityByUid]);

  const handleLegendClick = useCallback((event) => {
    const curveNumber = Number(event?.curveNumber);
    if (!Number.isFinite(curveNumber)) return false;
    const trace = event?.data?.[curveNumber];
    const traceUid = trace?.uid;
    if (!traceUid) return false;
    toggleTraceVisibilityByUid(traceUid);
    return false;
  }, [toggleTraceVisibilityByUid]);

  const handleLegendDoubleClick = useCallback(() => false, []);

  const tableColumns = useMemo(() => {
    const formatMw = (value) => (Number.isFinite(value) ? value.toFixed(3) : '--');
    const formatSignedMw = (value) => {
      if (!Number.isFinite(value)) return '--';
      if (value > 0) return `+${value.toFixed(3)}`;
      return value.toFixed(3);
    };
    const formatFixed = (value, decimals) => {
      if (!Number.isFinite(value)) return null;
      const factor = 10 ** Number(decimals || 0);
      const rounded = Math.round((value + Number.EPSILON) * factor) / factor;
      return rounded.toFixed(decimals);
    };
    const formatPct = (value) => {
      const out = formatFixed(value, 2);
      return out == null ? '--' : `${out}%`;
    };
    const formatRs = (value) => {
      const out = formatFixed(value, 2);
      return out == null ? '--' : `Rs ${out}`;
    };
    const formatSignedRs = (value) => {
      const out = formatFixed(value, 2);
      if (out == null) return '--';
      return Number(value) > 0 ? `Rs +${out}` : `Rs ${out}`;
    };
    const oseplSourceLabel =
      oseplCalcSource === 'vedanjay'
        ? 'Vedanjay'
        : oseplCalcSource === 'manualEdited'
          ? 'Manual Edited'
          : 'Machine';
    const getOseplSelected = (row, field) => {
      if (!row) return null;
      const pick = (kind) => {
        if (oseplCalcSource === 'vedanjay') {
          if (kind === 'payable') return row.oseplPayableVedanjayRs;
          if (kind === 'receivable') return row.oseplReceivableVedanjayRs;
          if (kind === 'final') return row.oseplFinalVedanjayRs;
          return null;
        }
        if (oseplCalcSource === 'manualEdited') {
          if (kind === 'payable') return row.oseplPayableManualEditedRs;
          if (kind === 'receivable') return row.oseplReceivableManualEditedRs;
          if (kind === 'final') return row.oseplFinalManualEditedRs;
          return null;
        }
        if (kind === 'payable') return row.oseplPayableMachineRs;
        if (kind === 'receivable') return row.oseplReceivableMachineRs;
        if (kind === 'final') return row.oseplFinalMachineRs;
        return null;
      };

      if (field === 'net') {
        const payable = Number(pick('payable'));
        const receivable = Number(pick('receivable'));
        const safePayable = Number.isFinite(payable) ? payable : 0;
        const safeReceivable = Number.isFinite(receivable) ? receivable : 0;
        return safeReceivable - safePayable;
      }
      if (oseplCalcSource === 'vedanjay') {
        if (field === 'payable') return row.oseplPayableVedanjayRs;
        if (field === 'receivable') return row.oseplReceivableVedanjayRs;
        if (field === 'final') return row.oseplFinalVedanjayRs;
        return null;
      }
      if (oseplCalcSource === 'manualEdited') {
        if (field === 'payable') return row.oseplPayableManualEditedRs;
        if (field === 'receivable') return row.oseplReceivableManualEditedRs;
        if (field === 'final') return row.oseplFinalManualEditedRs;
        return null;
      }
      if (field === 'payable') return row.oseplPayableMachineRs;
      if (field === 'receivable') return row.oseplReceivableMachineRs;
      if (field === 'final') return row.oseplFinalMachineRs;
      return null;
    };

    let cols = [
      {
        id: 'block',
        header: 'Block',
        cellClassName: 'text-foreground font-medium',
        render: (row) => row.block,
        export: (row) => String(row.block),
      },
      {
        id: 'time',
        header: 'Time',
        cellClassName: 'text-muted-foreground',
        render: (row) => row.timeLabel,
        export: (row) => row.timeLabel,
      },
      {
        id: 'machineSchedule',
        header: 'System Schedule (MW)',
        cellClassName: 'text-indigo-600',
        render: (row) => (formatFixed(row.machineScheduleMw, 2) ?? '--'),
        export: (row) => (Number.isFinite(row.machineScheduleMw) ? row.machineScheduleMw.toFixed(2) : ''),
      },
      {
        id: 'meter',
        header: 'Actual MW',
        cellClassName: 'text-red-600',
        render: (row) => formatMw(row.meterActualMw),
        export: (row) => (Number.isFinite(row.meterActualMw) ? row.meterActualMw.toFixed(3) : ''),
      },
      {
        id: 'devMachineMw',
        header: 'Deviation MW',
        cellClassName: 'text-slate-700',
        render: (row) => formatSignedMw(row.deviationMachineMw),
        export: (row) => (Number.isFinite(row.deviationMachineMw) ? (row.deviationMachineMw > 0 ? `+${row.deviationMachineMw.toFixed(3)}` : row.deviationMachineMw.toFixed(3)) : ''),
      },
      {
        id: 'devMachine',
        header: 'Deviation % (Capacity)',
        tooltip: 'Deviation relative to plant capacity',
        cellClassName: 'text-slate-700',
        render: (row) => formatPct(row.deviationMachinePct),
        export: (row) => formatFixed(row.deviationMachinePct, 2) || '',
      },
      {
        id: 'devMachineDsm',
        header: isOseplSite ? 'Error % (Machine)' : 'Deviation % (DSM)',
        tooltip: 'Deviation relative to scheduled generation (used for DSM slab / penalty calculation)',
        cellClassName: 'text-slate-700',
        render: (row) => formatPct(row.dsmDeviationMachinePct),
        export: (row) => formatFixed(row.dsmDeviationMachinePct, 2) || '',
      },
      {
        id: 'penMachine',
        header: 'Penalty (System Schedule)',
        cellClassName: 'text-slate-700',
        render: (row) => formatRs(row.penaltyMachine),
        export: (row) => formatFixed(row.penaltyMachine, 2) || '',
      },
      {
        id: 'manualEditedSchedule',
        header: 'Edited Schedule (MW)',
        cellClassName: 'text-yellow-700',
        render: (row) => (formatFixed(row.manualEditedScheduleMw, 2) ?? '--'),
        export: (row) => (Number.isFinite(row.manualEditedScheduleMw) ? row.manualEditedScheduleMw.toFixed(2) : ''),
      },
      {
        id: 'devManualEdited',
        header: 'Deviation % (Capacity, Manual)',
        tooltip: 'Deviation relative to plant capacity',
        cellClassName: 'text-slate-700',
        render: (row) => formatPct(row.deviationManualEditedPct),
        export: (row) => formatFixed(row.deviationManualEditedPct, 2) || '',
      },
      {
        id: 'devManualEditedDsm',
        header: isOseplSite ? 'Error % (Manual)' : 'Deviation % (DSM, Manual)',
        tooltip: 'Deviation relative to scheduled generation (used for DSM slab / penalty calculation)',
        cellClassName: 'text-slate-700',
        render: (row) => formatPct(row.dsmDeviationManualEditedPct),
        export: (row) => formatFixed(row.dsmDeviationManualEditedPct, 2) || '',
      },
      {
        id: 'penManualEdited',
        header: 'Penalty (Manual Edited Schedule)',
        cellClassName: 'text-slate-700',
        render: (row) => formatRs(row.penaltyManualEdited),
        export: (row) => formatFixed(row.penaltyManualEdited, 2) || '',
      },
      {
        id: 'vedanjaySchedule',
        header: 'Vedanjay Schedule (MW)',
        cellClassName: 'text-emerald-700',
        render: (row) => formatMw(row.vedanjayScheduleMw),
        export: (row) => (Number.isFinite(row.vedanjayScheduleMw) ? row.vedanjayScheduleMw.toFixed(3) : ''),
      },
      {
        id: 'devVedanjay',
        header: 'Deviation % (Capacity, Vedanjay)',
        tooltip: 'Deviation relative to plant capacity',
        cellClassName: 'text-slate-700',
        render: (row) => formatPct(row.deviationVedanjayPct),
        export: (row) => formatFixed(row.deviationVedanjayPct, 2) || '',
      },
      {
        id: 'devVedanjayDsm',
        header: isOseplSite ? 'Error % (Vedanjay)' : 'Deviation % (DSM, Vedanjay)',
        tooltip: 'Deviation relative to scheduled generation (used for DSM slab / penalty calculation)',
        cellClassName: 'text-slate-700',
        render: (row) => formatPct(row.dsmDeviationVedanjayPct),
        export: (row) => formatFixed(row.dsmDeviationVedanjayPct, 2) || '',
      },
      {
        id: 'penVedanjay',
        header: 'Penalty (Vedanjay Schedule)',
        cellClassName: 'text-slate-700',
        render: (row) => formatRs(row.penaltyVedanjay),
        export: (row) => formatFixed(row.penaltyVedanjay, 2) || '',
      },
      {
        id: 'testingSchedule',
        header: 'Testing Schedule (MW)',
        cellClassName: 'text-violet-700',
        render: (row) => formatMw(row.testingScheduleMw),
        export: (row) => (Number.isFinite(row.testingScheduleMw) ? row.testingScheduleMw.toFixed(3) : ''),
      },
      {
        id: 'testingActual',
        header: 'Actual MW',
        cellClassName: 'text-red-600',
        render: (row) => formatMw(row.meterActualMw),
        export: (row) => (Number.isFinite(row.meterActualMw) ? row.meterActualMw.toFixed(3) : ''),
      },
      {
        id: 'devTestingMw',
        header: 'Deviation MW',
        cellClassName: 'text-slate-700',
        render: (row) => formatSignedMw(row.deviationTestingMw),
        export: (row) => (Number.isFinite(row.deviationTestingMw) ? (row.deviationTestingMw > 0 ? `+${row.deviationTestingMw.toFixed(3)}` : row.deviationTestingMw.toFixed(3)) : ''),
      },
      {
        id: 'devTesting',
        header: 'Deviation % (Capacity)',
        tooltip: 'Testing schedule deviation relative to plant capacity',
        cellClassName: 'text-slate-700',
        render: (row) => formatPct(row.deviationTestingPct),
        export: (row) => formatFixed(row.deviationTestingPct, 2) || '',
      },
      {
        id: 'penTesting',
        header: 'Penalty (Testing Schedule)',
        cellClassName: 'text-slate-700',
        render: (row) => formatRs(row.penaltyTesting),
        export: (row) => formatFixed(row.penaltyTesting, 2) || '',
      },
      {
        id: 'intraday',
        header: 'Intraday Forecast (MW)',
        cellClassName: 'text-amber-600',
        render: (row) => formatMw(row.intradayForecastMw),
        export: (row) => (Number.isFinite(row.intradayForecastMw) ? row.intradayForecastMw.toFixed(3) : ''),
      },
    ];

    if (dataPresence.hasEnercastFrozen) {
      const enercastColumns = [
        {
          id: 'enercastSchedule',
          header: 'Enercast Schedule (MW)',
          cellClassName: 'text-cyan-700',
          render: (row) => (formatFixed(row.enercastFrozenSchedule, 2) ?? '--'),
          export: (row) => (Number.isFinite(row.enercastFrozenSchedule) ? row.enercastFrozenSchedule.toFixed(2) : ''),
        },
        {
          id: 'enercastActual',
          header: 'Actual MW',
          cellClassName: 'text-red-600',
          render: (row) => (formatFixed(row.meterActualMw, 3) ?? '--'),
          export: (row) => (Number.isFinite(row.meterActualMw) ? row.meterActualMw.toFixed(3) : ''),
        },
        {
          id: 'devEnercastMw',
          header: 'Deviation MW',
          cellClassName: 'text-slate-700',
          render: (row) => {
            const value = formatFixed(row.deviationEnercastMw, 2);
            if (value == null) return '--';
            return Number(row.deviationEnercastMw) > 0 ? `+${value}` : value;
          },
          export: (row) => {
            if (!Number.isFinite(row.deviationEnercastMw)) return '';
            const value = row.deviationEnercastMw.toFixed(2);
            return row.deviationEnercastMw > 0 ? `+${value}` : value;
          },
        },
        {
          id: 'devEnercast',
          header: 'Deviation % (Capacity)',
          tooltip: 'Enercast deviation relative to plant capacity',
          cellClassName: 'text-slate-700',
          render: (row) => formatPct(row.deviationEnercastPct),
          export: (row) => formatFixed(row.deviationEnercastPct, 2) || '',
        },
        {
          id: 'devEnercastDsm',
          header: 'Deviation % (DSM)',
          tooltip: 'Absolute Enercast deviation relative to Enercast schedule; unavailable when schedule is zero',
          cellClassName: 'text-slate-700',
          render: (row) => formatPct(row.dsmDeviationEnercastPct),
          export: (row) => formatFixed(row.dsmDeviationEnercastPct, 2) || '',
        },
        {
          id: 'penEnercast',
          header: 'Penalty (Rs)',
          cellClassName: 'text-slate-700',
          render: (row) => formatRs(row.penaltyEnercast),
          export: (row) => formatFixed(row.penaltyEnercast, 2) || '',
        },
      ];
      const insertAt = cols.findIndex((col) => col.id === 'vedanjaySchedule');
      cols.splice(insertAt >= 0 ? insertAt : cols.length, 0, ...enercastColumns);
    }

    if (isOseplSite) {
      const hiddenIds = new Set([
        'devMachine',
        'devManualEdited',
        'devVedanjay',
        'penMachine',
        'penManualEdited',
        'penVedanjay',
      ]);
      cols = cols.filter((col) => !hiddenIds.has(col.id));
    } else {
      // Non-OSEPL plants: hide DSM% columns to avoid confusion with the generic penalty bands UI.
      const hiddenIds = new Set([
        'devMachineDsm',
        'devManualEditedDsm',
        'devVedanjayDsm',
      ]);
      cols = cols.filter((col) => !hiddenIds.has(col.id));
    }

    if (isOseplSite) {
      cols.push(
        {
          id: 'oseplPayable',
          header: `OSEL Payable (${oseplSourceLabel})`,
          cellClassName: 'text-slate-700',
          render: (row) => formatRs(getOseplSelected(row, 'payable')),
          export: (row) => {
            const value = getOseplSelected(row, 'payable');
            return formatFixed(Number(value), 2) || '';
          },
        },
        {
          id: 'oseplReceivable',
          header: `OSEL Receivable (${oseplSourceLabel})`,
          cellClassName: 'text-slate-700',
          render: (row) => formatRs(getOseplSelected(row, 'receivable')),
          export: (row) => {
            const value = getOseplSelected(row, 'receivable');
            return formatFixed(Number(value), 2) || '';
          },
        },
        {
          id: 'oseplNet',
          header: `OSEL Net DSM (${oseplSourceLabel})`,
          cellClassName: 'text-slate-700',
          render: (row) => formatSignedRs(getOseplSelected(row, 'net')),
          export: (row) => {
            const value = getOseplSelected(row, 'net');
            return formatFixed(Number(value), 2) || '';
          },
        }
      );
    }

    return cols;
  }, [dataPresence.hasEnercastFrozen, isOseplSite, oseplCalcSource]);

  const buildOseplDailySummary = useCallback((sourceMode) => {
    if (!isOseplSite || !rows.length) return null;

    const PPA_RATE = 9.27;
    const BLOCK_HOURS = 0.25;
    const KWH_PER_MWH = 1000;
    const round2 = (value) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      return Math.round((n + Number.EPSILON) * 100) / 100;
    };

    const dt = new Date(`${selectedDate}T00:00:00+05:30`);
    const month = dt.toLocaleString('en-US', { month: 'short', timeZone: 'Asia/Kolkata' });
    const year2 = dt.toLocaleString('en-US', { year: '2-digit', timeZone: 'Asia/Kolkata' });
    const monthKey = `${month}-${year2}`;

    const todayIst = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const isTodaySelected = selectedDate === todayIst;
    const currentIstBlock = isTodaySelected ? getCurrentIstBlock() : TOTAL_BLOCKS;

    const expectedScadaBlocks = rows.filter((r) => Number(r.block) <= currentIstBlock);
    const hasErrorFlags = expectedScadaBlocks.some((r) => Number(r?.oseplErrorBlockFlag) === 1);
    const availableScadaBlocks = expectedScadaBlocks.filter((r) => Number(r?.oseplErrorBlockFlag) !== 1).length;
    const scadaAvailabilityPercent = expectedScadaBlocks.length > 0
      ? (hasErrorFlags
        ? (availableScadaBlocks / expectedScadaBlocks.length) * 100
        : 100)
      : 100;

    const generationKwh = rows.reduce((sum, r) => {
      if (Number(r.block) > currentIstBlock) return sum;
      const actualMw = Number(r.meterActualMw);
      if (!Number.isFinite(actualMw)) return sum;
      return sum + (actualMw * BLOCK_HOURS * KWH_PER_MWH);
    }, 0);

    const selectedScheduledMw = (row) => {
      if (sourceMode === 'vedanjay') return row.vedanjayScheduleMw;
      if (sourceMode === 'testing') return row.testingScheduleMw;
      if (sourceMode === 'manualEdited') return row.manualEditedScheduleMw;
      return row.machineScheduleMw;
    };

    const scheduledKwh = rows.reduce((sum, r) => {
      if (Number(r.block) > currentIstBlock) return sum;
      const sched = selectedScheduledMw(r);
      if (!Number.isFinite(sched)) return sum;
      return sum + (sched * BLOCK_HOURS * KWH_PER_MWH);
    }, 0);

    const pickSettlement = (row, kind) => {
      if (sourceMode === 'vedanjay') {
        if (kind === 'payable') return row.oseplPayableVedanjayRs;
        if (kind === 'receivable') return row.oseplReceivableVedanjayRs;
        return row.oseplFinalVedanjayRs;
      }
      if (sourceMode === 'testing') {
        if (kind === 'payable') return row.oseplPayableTestingRs;
        if (kind === 'receivable') return row.oseplReceivableTestingRs;
        return row.oseplFinalTestingRs;
      }
      if (sourceMode === 'manualEdited') {
        if (kind === 'payable') return row.oseplPayableManualEditedRs;
        if (kind === 'receivable') return row.oseplReceivableManualEditedRs;
        return row.oseplFinalManualEditedRs;
      }
      if (kind === 'payable') return row.oseplPayableMachineRs;
      if (kind === 'receivable') return row.oseplReceivableMachineRs;
      return row.oseplFinalMachineRs;
    };

    const totalsRaw = rows.reduce((acc, r) => {
      if (Number(r.block) > currentIstBlock) return acc;
      const payableRaw = Number(pickSettlement(r, 'payable'));
      const receivableRaw = Number(pickSettlement(r, 'receivable'));
      const finalRaw = Number(pickSettlement(r, 'final'));

      if (Number.isFinite(payableRaw)) acc.totalPayable += payableRaw;
      if (Number.isFinite(receivableRaw)) acc.totalReceivable += receivableRaw;
      if (Number.isFinite(receivableRaw) && Number.isFinite(payableRaw)) acc.netDsm += (receivableRaw - payableRaw);
      if (Number.isFinite(finalRaw)) acc.dsmPenalty += finalRaw;
      return acc;
    }, { totalPayable: 0, totalReceivable: 0, netDsm: 0, dsmPenalty: 0 });

    const totals = {
      totalPayable: round2(totalsRaw.totalPayable) ?? 0,
      totalReceivable: round2(totalsRaw.totalReceivable) ?? 0,
      netDsm: round2(totalsRaw.netDsm) ?? 0,
      dsmPenalty: round2(totalsRaw.dsmPenalty) ?? 0,
    };

    const adjustedDsm = hasErrorFlags
      ? rows.reduce((sum, r) => {
        if (Number(r.block) > currentIstBlock) return sum;
        if (Number(r?.[errorFlagField]) === 1) return sum;
        const finalRaw = Number(pickSettlement(r, 'final'));
        return Number.isFinite(finalRaw) ? sum + finalRaw : sum;
      }, 0)
      : totals.dsmPenalty;

    return {
      fromDate: selectedDate,
      monthKey,
      project: 'ESSEL',
      installedCapacityMw: selectedSiteContext.siteCapacityMw || 0,
      scadaAvailabilityPercent,
      generationKwh,
      scheduledUnitPpaRs: scheduledKwh * PPA_RATE,
      payableRs: totals.totalPayable,
      receivableRs: totals.totalReceivable,
      netDsmRs: totals.netDsm,
      dsmPenaltyRs: totals.dsmPenalty,
      dsmPenaltyAvailabilityRs: adjustedDsm,
      ppaRate: PPA_RATE,
    };
  }, [isOseplSite, rows, selectedDate, selectedSiteContext]);

  const oseplDailySummary = useMemo(() => buildOseplDailySummary(oseplCalcSource), [buildOseplDailySummary, oseplCalcSource]);

  const oseplPenaltyReportRows = useMemo(() => {
    if (!isOseplSite || !rows.length) return [];
    const buildRow = (type, sourceMode, summary) => {
      const result = summary || null;
      const netSettlement = result
        ? (Number(result.receivableRs || 0) - Number(result.payableRs || 0) - Number(result.dsmPenaltyRs || 0))
        : null;
      return {
        Type: type,
        'Project Details': result
          ? `${result.fromDate} / ${result.monthKey} / ${result.project}`
          : '--',
        'Net Settlement (₹)': Number.isFinite(netSettlement) ? Math.round(netSettlement).toString() : '--',
        'Installed Capacity': result ? Number(result.installedCapacityMw || 0).toFixed(0) : '--',
        'SCADA Availability': result ? `${Number(result.scadaAvailabilityPercent || 0).toFixed(0)}%` : '--',
        'Generation (kWh)': result ? Number(result.generationKwh || 0).toFixed(0) : '--',
        'Scheduled Units': result ? Number(result.scheduledUnitPpaRs || 0).toFixed(0) : '--',
        'DSM Penalty (₹)': result ? Number(result.dsmPenaltyRs || 0).toFixed(0) : '--',
        'Payable (₹)': result ? Number(result.payableRs || 0).toFixed(0) : '--',
        'Receivable (₹)': result ? Number(result.receivableRs || 0).toFixed(0) : '--',
        sourceMode,
      };
    };

    const machineSummary = buildOseplDailySummary('machine');
    const manualSummary = buildOseplDailySummary('manualEdited');
    const vedanjaySummary = buildOseplDailySummary('vedanjay');
    const testingSummary = buildOseplDailySummary('testing');

    return [
      buildRow('System (Auto)', 'machine', machineSummary),
      buildRow('Manual', 'manualEdited', manualSummary),
      buildRow('Vedanjay (UI)', 'vedanjay', vedanjaySummary),
      buildRow('Testing Env', 'testing', testingSummary),
    ];
  }, [buildOseplDailySummary, isOseplSite, rows.length]);

  const summaryCards = useMemo(() => {
    if (!rows.length) return [];
    if (isOseplSite && oseplDailySummary) {
      const fmtRs = (value) => `Rs ${Number(value || 0).toFixed(0)}`;
      return [
        {
          key: 'oseplFrom',
          label: 'From',
          value: String(oseplDailySummary.fromDate || ''),
          valueClassName: 'text-foreground',
        },
        {
          key: 'oseplScada',
          label: 'SCADA Availability %',
          value: `${Number(oseplDailySummary.scadaAvailabilityPercent || 0).toFixed(0)}%`,
          valueClassName: 'text-foreground',
        },
        {
          key: 'oseplGen',
          label: 'Total Generation (kWh)',
          value: Number(oseplDailySummary.generationKwh || 0).toFixed(0),
          valueClassName: 'text-foreground',
        },
        {
          key: 'oseplScheduledValue',
          label: 'Scheduled Value (Scheduled ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â PPA)',
          value: fmtRs(oseplDailySummary.scheduledUnitPpaRs),
          valueClassName: 'text-foreground',
        },
        {
          key: 'oseplPayable',
          label: 'Total Payable',
          value: fmtRs(oseplDailySummary.payableRs),
          valueClassName: 'text-foreground',
        },
        {
          key: 'oseplReceivable',
          label: 'Total Receivable',
          value: fmtRs(oseplDailySummary.receivableRs),
          valueClassName: 'text-foreground',
        },
        {
          key: 'oseplDsmPenalty',
          label: 'DSM Penalty',
          value: fmtRs(oseplDailySummary.dsmPenaltyRs),
          valueClassName: 'text-foreground',
        },
        {
          key: 'oseplAdjusted',
          label: 'SCADA Adjusted DSM',
          value: fmtRs(oseplDailySummary.dsmPenaltyAvailabilityRs),
          valueClassName: 'text-foreground',
        },
      ];
    }

    const cards = [];
    if (dataPresence.hasMachine) {
      cards.push({
        key: 'penMachine',
        label: isOseplSite ? 'Total OSEL Final (System Schedule)' : 'Total Penalty (System Schedule)',
        value: `Rs ${(isOseplSite ? comparisonSummary.totalOseplFinalMachine : comparisonSummary.totalPenaltyMachine).toFixed(2)}`,
        valueClassName: 'text-emerald-600',
      });
      cards.push({
        key: 'devMachine',
        label: 'Avg Deviation % (Capacity)',
        value: `${comparisonSummary.avgMachineDevPct.toFixed(2)}%`,
        valueClassName: 'text-foreground',
      });
    }
    if (dataPresence.hasManualEdited) {
      cards.push({
        key: 'penManualEdited',
        label: isOseplSite ? 'Total OSEL Final (Manual Edited Schedule)' : 'Total Penalty (Manual edited Schedule)',
        value: `Rs ${(isOseplSite ? comparisonSummary.totalOseplFinalManualEdited : comparisonSummary.totalPenaltyManualEdited).toFixed(2)}`,
        valueClassName: 'text-emerald-600',
      });
      cards.push({
        key: 'devManualEdited',
        label: 'Avg Deviation % (Capacity, Manual edited)',
        value: `${comparisonSummary.avgManualEditedDevPct.toFixed(2)}%`,
        valueClassName: 'text-foreground',
      });
    }
    if (dataPresence.hasEnercastFrozen) {
      cards.push({
        key: 'penEnercast',
        label: 'Total Penalty (Enercast Edited Frozen)',
        value: `Rs ${comparisonSummary.totalPenaltyEnercast.toFixed(2)}`,
        valueClassName: 'text-emerald-600',
      });
      cards.push({
        key: 'devEnercast',
        label: 'Avg Deviation % (Capacity, Enercast)',
        value: `${comparisonSummary.avgEnercastDevPct.toFixed(2)}%`,
        valueClassName: 'text-foreground',
      });
    }
    if (dataPresence.hasVedanjay) {
      cards.push({
        key: 'penVedanjay',
        label: isOseplSite ? 'Total OSEL Final (Vedanjay Schedule)' : 'Total Penalty (Vedanjay Schedule)',
        value: `Rs ${(isOseplSite ? comparisonSummary.totalOseplFinalVedanjay : comparisonSummary.totalPenaltyVedanjay).toFixed(2)}`,
        valueClassName: 'text-emerald-600',
      });
      cards.push({
        key: 'devVedanjay',
        label: 'Avg Deviation % (Vedanjay)',
        value: `${comparisonSummary.avgVedanjayDevPct.toFixed(2)}%`,
        valueClassName: 'text-foreground',
      });
    }
    if (dataPresence.hasTesting) {
      cards.push({
        key: 'penTesting',
        label: isOseplSite ? 'Total OSEL Final (Testing Schedule)' : 'Total Penalty (Testing Schedule)',
        value: `Rs ${(isOseplSite ? comparisonSummary.totalOseplFinalTesting : comparisonSummary.totalPenaltyTesting).toFixed(2)}`,
        valueClassName: 'text-violet-700',
      });
      cards.push({
        key: 'devTesting',
        label: 'Avg Deviation % (Testing)',
        value: `${comparisonSummary.avgTestingDevPct.toFixed(2)}%`,
        valueClassName: 'text-foreground',
      });
    }
    cards.push({
      key: 'devAbs',
      label: 'Avg Absolute Deviation %',
      value: `${comparisonSummary.avgAbsDevPct.toFixed(2)}%`,
      valueClassName: 'text-foreground',
    });
    return cards;
  }, [rows.length, dataPresence, comparisonSummary, isOseplSite, oseplDailySummary]);

  const exportComparison = async (format = 'csv') => {
    if (!rows.length) {
      toast.info('No comparison data to export');
      return;
    }
    const headers = tableColumns.map((c) => c.header);
    const rowsData = rows.map((r) => tableColumns.map((c) => c.export(r)));
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
    const container = showGraph ? chartContainerRef.current : tableContainerRef.current;
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
              <div className="flex items-center gap-4 sm:gap-5">
                <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/25">
                  <ArrowLeftRight className="w-6 h-6 sm:w-7 sm:h-7 text-white" />
                </div>
                <div>
                  <h1 className="text-2xl sm:text-3xl font-bold text-foreground tracking-tight leading-tight">Schedule Comparison</h1>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-3 sm:gap-4">
                {isAdmin && (
                  <button
                    onClick={() => setShowPenaltyReportDialog(true)}
                    disabled={isSavingComparisonResult}
                    className="w-full sm:w-auto group relative px-5 sm:px-6 py-2.5 sm:py-3 rounded-xl bg-gradient-to-r from-violet-700 to-purple-600 hover:from-violet-600 hover:to-purple-500 text-white shadow-lg shadow-purple-500/20 transition-all duration-300 flex items-center justify-center gap-3 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <FileText className="w-5 h-5" />
                    <div className="text-left">
                      <p className="text-sm font-semibold">Generate All Plant Penalty Report</p>
                      <p className="text-xs text-purple-100">
                        {penaltyReportReadiness?.ready
                          ? 'All plants loaded'
                          : `${penaltyReportReadiness?.loaded_count || 0}/${penaltyReportReadiness?.required_count || 6} plants loaded`}
                      </p>
                    </div>
                  </button>
                )}
                {(rows.length > 0 || uploadedMap || testingMap) && (
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

            {shouldShowManualMeterUpload && (
              <div className="relative">
                <input
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  onChange={handleMeterUpload}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  disabled={isMeterUploading}
                />
                <button
                  disabled={isMeterUploading}
                  className="w-full sm:w-auto px-4 py-2.5 rounded-xl bg-gradient-to-r from-amber-600 to-orange-600 text-white text-sm font-medium transition-all duration-300 flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  <Upload className={`w-4 h-4 ${isMeterUploading ? 'animate-bounce' : ''}`} />
                  {isMeterUploading ? 'Uploading...' : (meterUploadName || 'Upload Meter Data')}
                </button>
              </div>
            )}


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
                  Load Frozen Schedule
                </>
              )}
            </button>

            {isAdmin && (
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
                  {isUploading ? 'Uploading...' : testingFileName ? testingFileName : 'Upload Testing schedule CSV/XLSX'}
                </button>
              </div>
            )}

            {uploadTime && (
              <div className="w-full sm:w-auto flex items-center gap-2 px-4 py-2.5 rounded-xl bg-background border border-border">
                <Clock className="w-4 h-4 text-emerald-400" />
                <span className="text-sm text-foreground">
                  Testing uploaded: <span className="text-emerald-400 font-medium">{formatUploadTime(uploadTime)}</span>
                </span>
              </div>
            )}

            {meterUploadTime && (
              <div className="w-full sm:w-auto flex items-center gap-2 px-4 py-2.5 rounded-xl bg-background border border-border">
                <Clock className="w-4 h-4 text-amber-400" />
                <span className="text-sm text-foreground">
                  Meter uploaded: <span className="text-amber-400 font-medium">{formatUploadTime(meterUploadTime)}</span>
                </span>
              </div>
            )}

          </div>
        </div>

        {isAdmin && vedanjayPenaltyResult && (
          <div className="rounded-2xl border border-purple-200 bg-card p-4 shadow-sm">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Vedanjay Uploaded Schedule Penalty</h3>
                <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2 text-sm">
                  <span className="text-muted-foreground">
                    Status: <strong className="text-foreground">{vedanjayPenaltyResult.status}</strong>
                  </span>
                  <span className="text-muted-foreground">
                    Penalty:{' '}
                    <strong className="text-purple-700">
                      {Number.isFinite(vedanjayPenaltyResult.total_penalty)
                        ? `Rs ${Number(vedanjayPenaltyResult.total_penalty).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : '--'}
                    </strong>
                  </span>
                  <span className="text-muted-foreground">
                    Meter Coverage: <strong className="text-foreground">{vedanjayPenaltyResult.calculated_blocks || 0}/96</strong>
                  </span>
                  {vedanjayPenaltyResult.highest_penalty_block && (
                    <span className="text-muted-foreground">
                      Highest: <strong className="text-foreground">
                        Block {vedanjayPenaltyResult.highest_penalty_block}, Rs {Number(vedanjayPenaltyResult.highest_penalty_amount || 0).toFixed(2)}
                      </strong>
                    </span>
                  )}
                </div>
                {vedanjayPenaltyResult.missing_data_reason && (
                  <p className="mt-2 text-xs text-amber-700">{vedanjayPenaltyResult.missing_data_reason}</p>
                )}
              </div>
              {['Pending', 'Partially Calculated', 'Failed'].includes(vedanjayPenaltyResult.status) && (
                <button
                  onClick={handleRecalculateVedanjay}
                  disabled={isRecalculatingVedanjay}
                  className="rounded-xl border border-purple-300 px-4 py-2 text-sm font-medium text-purple-700 hover:bg-purple-50 disabled:opacity-50"
                >
                  {isRecalculatingVedanjay ? 'Recalculating...' : 'Recalculate Vedanjay Penalty'}
                </button>
              )}
            </div>
          </div>
        )}

        {!rows.length && (
          <div className="rounded-2xl bg-card border border-border backdrop-blur-sm p-8 sm:p-20">
            <div className="flex flex-col items-center gap-6">
              <div className="p-6 rounded-full bg-muted">
                <FileText className="w-16 h-16 text-muted-foreground" />
              </div>
              <div className="text-center">
                <h3 className="text-lg sm:text-xl font-bold text-foreground mb-2">No Schedule Data Available</h3>
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
                    {!HIDE_METADATA && systemFrozenMeta && (
                      <p className="text-xs text-muted-foreground mt-1">System Frozen: {systemFrozenMeta.fileName}</p>
                    )}
                    {!HIDE_METADATA && editedFrozenMeta && (
                      <p className="text-xs text-muted-foreground mt-1">Edited Frozen: {editedFrozenMeta.fileName}</p>
                    )}
                    {!HIDE_METADATA && intradayMeta && (
                      <>
                        <p className="text-xs text-muted-foreground mt-1">Latest Intraday: {intradayMeta.fileName}</p>
                        {intradayMeta.valueHeader && (
                          <p className="text-[11px] text-muted-foreground mt-0.5">
                            Intraday column: {intradayMeta.valueHeader} ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¢ non-zero: {intradayMeta.nonZero ?? 0}
                            {Number.isFinite(intradayMeta.min) && Number.isFinite(intradayMeta.max)
                              ? ` ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¢ range: ${intradayMeta.min.toFixed(3)}ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œ${intradayMeta.max.toFixed(3)}`
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
                    className="relative px-3 sm:px-4 py-2 text-xs sm:text-sm font-semibold rounded-xl transition-all duration-300 text-muted-foreground hover:text-foreground hover:bg-muted"
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
              <div
                ref={tableContainerRef}
                className={isGraphFullscreen ? 'fixed inset-0 z-50 bg-background p-4 sm:p-6 overflow-auto space-y-4' : 'space-y-4'}
              >
                {!isOseplSite && (
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
                    <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3">
                      {summaryCards.map((card) => (
                        <div key={card.key} className="rounded-lg bg-background border border-border p-3">
                          <p className="text-[11px] text-muted-foreground mb-1">{card.label}</p>
                          <p className={`text-lg font-bold ${card.valueClassName || 'text-foreground'}`}>{card.value}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {!isOseplSite && plantDailySummary && (
                  <div className="rounded-xl border border-border bg-muted/30 p-4 sm:p-5">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div>
                        <h4 className="text-sm sm:text-base font-semibold text-foreground">{plantDailySummary.title}</h4>
                        <p className="text-xs text-muted-foreground">{plantDailySummary.subtitle}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setOseplCalcSource('machine')}
                          className={`px-3 py-2 text-xs font-semibold rounded-lg border transition-colors ${oseplCalcSource === 'machine' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-background text-foreground border-border hover:bg-muted'}`}
                        >
                          Machine
                        </button>
                        <button
                          type="button"
                          onClick={() => setOseplCalcSource('manualEdited')}
                          disabled={!dataPresence.hasManualEdited}
                          title={!dataPresence.hasManualEdited ? 'Manual Edited schedule not loaded' : 'Use Manual Edited schedule'}
                          className={`px-3 py-2 text-xs font-semibold rounded-lg border transition-colors ${oseplCalcSource === 'manualEdited' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-background text-foreground border-border hover:bg-muted'} ${!dataPresence.hasManualEdited ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                          Manual Edited
                        </button>
                        <button
                          type="button"
                          onClick={() => setOseplCalcSource('vedanjay')}
                          disabled={!dataPresence.hasVedanjay}
                          title={!dataPresence.hasVedanjay ? 'Vedanjay schedule not uploaded' : 'Use Vedanjay schedule'}
                          className={`px-3 py-2 text-xs font-semibold rounded-lg border transition-colors ${oseplCalcSource === 'vedanjay' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-background text-foreground border-border hover:bg-muted'} ${!dataPresence.hasVedanjay ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                          Vedanjay
                        </button>
                      </div>
                    </div>

                    <div className="mt-4 overflow-x-auto rounded-lg border border-border bg-background">
                      <table className="min-w-full">
                        <thead className="bg-green-700">
                          <tr>
                            {plantDailySummary.columns.map((h) => (
                              <th
                                key={h}
                                className="px-3 sm:px-4 py-3 text-left text-xs font-semibold text-white uppercase tracking-wider whitespace-nowrap"
                              >
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          <tr
                            className={`hover:bg-muted/50 transition-all duration-150 ${
                              String(selectedSiteContext?.siteCode || '').trim().toUpperCase() === 'BHUPALPALLY'
                                ? 'bg-yellow-200'
                                : String(selectedSiteContext?.siteCode || '').trim().toUpperCase() === 'KOTHAGUDEM'
                                  ? 'bg-slate-200'
                                  : 'bg-orange-100'
                            }`}
                          >
                            {plantDailySummary.columns.map((h) => (
                              <td key={h} className="px-3 sm:px-4 py-2.5 whitespace-nowrap text-foreground tabular-nums">
                                {String(plantDailySummary.row?.[h] ?? '')}
                              </td>
                            ))}
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {isOseplSite && oseplDailySummary && (
                  <div className="rounded-xl border border-border bg-muted/30 p-4 sm:p-5">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div>
                        <h4 className="text-sm sm:text-base font-semibold text-foreground">OSEPL Penalty Report Preview</h4>
                        <p className="text-xs text-muted-foreground">Net Settlement = Receivable - Payable - DSM Penalty</p>
                      </div>
                      <div className="flex items-center gap-2">
                      </div>
                    </div>

                    <div className="mt-3 text-xs font-medium text-emerald-700">
                      Positive net settlement means receivable is higher after deductions.
                    </div>

                    <div className="mt-4 overflow-x-auto rounded-lg border border-border bg-background">
                      <table className="min-w-[980px] w-full text-sm">
                        <thead className="bg-green-700">
                          <tr>
                            {[
                              'Type',
                              'Project Details',
                              'Net Settlement (₹)',
                              'Installed Capacity',
                              'SCADA Availability',
                              'Generation (kWh)',
                              'Scheduled Units',
                              'DSM Penalty (₹)',
                              'Payable (₹)',
                              'Receivable (₹)',
                            ].map((h) => (
                              <th
                                key={h}
                                className="px-3 sm:px-4 py-3 text-left text-xs font-semibold text-white uppercase tracking-wider whitespace-nowrap"
                              >
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {oseplPenaltyReportRows.map((row) => {
                            const netValue = Number(String(row['Net Settlement (₹)']).replace(/,/g, ''));
                            const netClass = Number.isFinite(netValue)
                              ? (netValue >= 0 ? 'bg-green-200 text-foreground' : 'bg-red-200 text-foreground')
                              : 'bg-background text-foreground';
                            return (
                              <tr key={`${row.Type}-${row['Project Details']}`} className="hover:bg-muted/50 transition-all duration-150">
                                <td className="px-3 sm:px-4 py-2.5 whitespace-nowrap text-foreground font-semibold">{row.Type}</td>
                                <td className="px-3 sm:px-4 py-2.5 whitespace-nowrap text-foreground">{row['Project Details']}</td>
                                <td className={`px-3 sm:px-4 py-2.5 whitespace-nowrap font-semibold tabular-nums ${netClass}`}>{row['Net Settlement (₹)']}</td>
                                <td className="px-3 sm:px-4 py-2.5 whitespace-nowrap text-foreground tabular-nums">{row['Installed Capacity']}</td>
                                <td className="px-3 sm:px-4 py-2.5 whitespace-nowrap text-foreground tabular-nums">{row['SCADA Availability']}</td>
                                <td className="px-3 sm:px-4 py-2.5 whitespace-nowrap text-foreground tabular-nums">{row['Generation (kWh)']}</td>
                                <td className="px-3 sm:px-4 py-2.5 whitespace-nowrap text-foreground tabular-nums">{row['Scheduled Units']}</td>
                                <td className="px-3 sm:px-4 py-2.5 whitespace-nowrap text-foreground tabular-nums">{row['DSM Penalty (₹)']}</td>
                                <td className="px-3 sm:px-4 py-2.5 whitespace-nowrap text-foreground tabular-nums">{row['Payable (₹)']}</td>
                                <td className="px-3 sm:px-4 py-2.5 whitespace-nowrap text-foreground tabular-nums">{row['Receivable (₹)']}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                <div className={`overflow-x-auto overflow-y-auto ${isGraphFullscreen ? 'h-[calc(100vh-220px)]' : 'max-h-[550px]'}`}>
                  <table className="min-w-max w-full text-sm">
                    <thead className="sticky top-0 bg-muted border-b border-border z-10">
                      <tr>
                        {tableColumns.map((col) => (
                          <th
                            key={col.id}
                            className="px-3 sm:px-4 py-3 text-left text-xs font-semibold text-foreground uppercase tracking-wider whitespace-nowrap"
                            title={col.tooltip || ''}
                          >
                            {col.header}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {rows.map((row) => (
                        <tr key={row.block} className="hover:bg-muted/50 transition-all duration-150">
                          {tableColumns.map((col) => (
                            <td
                              key={`${row.block}-${col.id}`}
                              className={`px-3 sm:px-4 py-2.5 whitespace-nowrap ${col.cellClassName || 'text-foreground'}`}
                            >
                              {col.render(row)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {false && isOseplSite && oseplDailySummary && (
                  <div className="rounded-xl border border-border bg-muted/30 p-4 sm:p-5">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div>
                        <h4 className="text-sm sm:text-base font-semibold text-foreground">OSEL Daily Summary</h4>
                        <p className="text-xs text-muted-foreground">15-min block-wise settlement totals (payable / receivable / final)</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setOseplCalcSource('machine')}
                          className={`px-3 py-2 text-xs font-semibold rounded-lg border transition-colors ${oseplCalcSource === 'machine' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-background text-foreground border-border hover:bg-muted'}`}
                        >
                          Machine
                        </button>
                        <button
                          type="button"
                          onClick={() => setOseplCalcSource('manualEdited')}
                          disabled={!dataPresence.hasManualEdited}
                          className={`px-3 py-2 text-xs font-semibold rounded-lg border transition-colors ${
                            oseplCalcSource === 'manualEdited'
                              ? 'bg-indigo-600 text-white border-indigo-600'
                              : 'bg-background text-foreground border-border hover:bg-muted'
                          } ${!dataPresence.hasManualEdited ? 'opacity-50 cursor-not-allowed' : ''}`}
                          title={!dataPresence.hasManualEdited ? 'Manual Edited schedule not loaded' : 'Use Manual Edited schedule'}
                        >
                          Manual Edited
                        </button>
                        <button
                          type="button"
                          onClick={() => setOseplCalcSource('vedanjay')}
                          className={`px-3 py-2 text-xs font-semibold rounded-lg border transition-colors ${oseplCalcSource === 'vedanjay' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-background text-foreground border-border hover:bg-muted'}`}
                        >
                          Vedanjay
                        </button>
                      </div>
                    </div>

                    <div className="mt-4 overflow-x-auto">
                      <table className="min-w-max w-full text-sm">
                        <thead className="bg-muted border-b border-border">
                          <tr>
                            {[
                              'From',
                              'Month',
                              'Project',
                              'Installed Capacity',
                              'SCADA availability %',
                              'Generation(kWh)',
                              'Scheduled unit*PPA',
                              'Payable',
                              'Receivable',
                              'DSM Penalty (Rs.)',
                              'SCADA Adjusted DSM',
                              'PPA',
                            ].map((h) => (
                              <th
                                key={h}
                                className="px-3 sm:px-4 py-3 text-left text-xs font-semibold text-foreground uppercase tracking-wider whitespace-nowrap"
                              >
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          <tr className="hover:bg-muted/50 transition-all duration-150">
                            <td className="px-3 sm:px-4 py-2.5 whitespace-nowrap text-foreground">{oseplDailySummary.fromDate}</td>
                            <td className="px-3 sm:px-4 py-2.5 whitespace-nowrap text-foreground">{oseplDailySummary.monthKey}</td>
                            <td className="px-3 sm:px-4 py-2.5 whitespace-nowrap text-foreground">{oseplDailySummary.project}</td>
                            <td className="px-3 sm:px-4 py-2.5 whitespace-nowrap text-foreground tabular-nums">{oseplDailySummary.installedCapacityMw.toFixed(0)}</td>
                            <td className="px-3 sm:px-4 py-2.5 whitespace-nowrap text-foreground tabular-nums">{oseplDailySummary.scadaAvailabilityPercent.toFixed(0)}%</td>
                            <td className="px-3 sm:px-4 py-2.5 whitespace-nowrap text-foreground tabular-nums">{oseplDailySummary.generationKwh.toFixed(0)}</td>
                            <td className="px-3 sm:px-4 py-2.5 whitespace-nowrap text-foreground tabular-nums">{oseplDailySummary.scheduledUnitPpaRs.toFixed(0)}</td>
                            <td className="px-3 sm:px-4 py-2.5 whitespace-nowrap text-foreground tabular-nums">{oseplDailySummary.payableRs.toFixed(0)}</td>
                            <td className="px-3 sm:px-4 py-2.5 whitespace-nowrap text-foreground tabular-nums">{oseplDailySummary.receivableRs.toFixed(0)}</td>
                            <td className="px-3 sm:px-4 py-2.5 whitespace-nowrap text-foreground tabular-nums">{oseplDailySummary.dsmPenaltyRs.toFixed(0)}</td>
                            <td className="px-3 sm:px-4 py-2.5 whitespace-nowrap text-foreground tabular-nums">{oseplDailySummary.dsmPenaltyAvailabilityRs.toFixed(0)}</td>
                            <td className="px-3 sm:px-4 py-2.5 whitespace-nowrap text-foreground tabular-nums">{oseplDailySummary.ppaRate.toFixed(2)}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

              </div>
            ) : (
              <div
                ref={chartContainerRef}
                className={isGraphFullscreen ? 'fixed inset-0 z-50 bg-background p-4 sm:p-6' : 'p-6'}
              >
                <div className={`${isGraphFullscreen ? 'h-[calc(100vh-2rem)] sm:h-[calc(100vh-3rem)]' : 'h-[500px]'} bg-background rounded-xl border border-border p-4 overflow-auto`}>
                    <Plot
                    data={[...plotData, hoverMarkerTrace]}
                    layout={{
                      margin: { l: 70, r: 20, t: 20, b: 60 },
                      uirevision: `${selectedSiteContext?.siteCode || ''}|${selectedDate || ''}`,
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
                        showspikes: true,
                        spikemode: 'across',
                        spikesnap: 'cursor',
                        spikethickness: 1,
                        spikedash: 'solid',
                        spikecolor: isDarkMode ? 'rgba(226,232,240,0.55)' : 'rgba(15,23,42,0.45)',
                      },
                      yaxis: {
                        title: 'Power (MW)',
                        gridcolor: isDarkMode ? 'rgba(148,163,184,0.2)' : 'rgba(100,116,139,0.22)',
                      },
                      hovermode: 'x unified',
                      // Avoid "carry-forward" hover where missing meter blocks show the last available meter value.
                      hoverdistance: 1,
                      spikedistance: 1,
                      legend: {
                        orientation: 'h',
                        x: 0,
                        y: 1.1,
                        bgcolor: isDarkMode ? 'rgba(0,0,0,0)' : 'rgba(255,255,255,0.9)',
                        font: { color: isDarkMode ? '#cbd5e1' : '#1f2937' },
                        itemclick: 'toggle',
                        itemdoubleclick: false,
                        groupclick: 'toggleitem',
                      },
                      hoverlabel: {
                        bgcolor: isDarkMode ? 'rgba(15,23,42,0.78)' : 'rgba(255,255,255,0.78)',
                        bordercolor: isDarkMode ? '#334155' : '#cbd5e1',
                        font: { color: isDarkMode ? '#e2e8f0' : '#0f172a' },
                        namelength: -1,
                        align: 'left',
                      },
                    }}
                    config={{ displayModeBar: false, responsive: true }}
                    style={{ width: '100%', height: '100%' }}
                    useResizeHandler
                    onHover={handlePlotHover}
                    onUnhover={handlePlotUnhover}
                    onClick={handlePlotClick}
                    onLegendClick={handleLegendClick}
                    onLegendDoubleClick={handleLegendDoubleClick}
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
      {isAdmin && (
        <AllPlantPenaltyReportDialog
          open={showPenaltyReportDialog}
          onClose={() => setShowPenaltyReportDialog(false)}
          currentUser={currentUser}
          defaultDate={selectedDate}
          loadedPlantCodes={penaltyReportLoadedPlantCodes}
          loadedCount={penaltyReportReadiness?.loaded_count || 0}
          requiredCount={penaltyReportReadiness?.required_count || 6}
        />
      )}
    </div>
  );
}




