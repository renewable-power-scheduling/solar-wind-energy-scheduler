
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  FileText,
  Download,
  Calendar,
  BarChart3,
  TrendingUp,
  FileSpreadsheet,
  Eye,
  X,
  Trash2,
  RefreshCw,
  CheckCircle,
  Clock
} from 'lucide-react';
import { api } from '@/services/api';
import { useApi } from '@/hooks/useApi';
import { jsPDF } from 'jspdf';
import { toast } from 'sonner';
import { API_BASE_URL, API_ORIGIN } from '@/config/appConfig';
import {
  fetchTextFromS3,
  listS3ObjectsAcrossPrefixes,
  filterVisibleScheduleObjects,
  isAnyScheduleCsvKey,
} from '@/services/s3Utils';
import { DSM_PENALTY_CONFIG_BY_STATE, DEFAULT_DSM_PENALTY_CONFIG } from '@/config/dsmPenaltyConfig';
import { parseBlockFromTimestamp } from '@/utils/meterTime';
import { useAuth } from '@/app/appContexts';
import { filterPlantsForUser } from '@/utils/plantAccess';
import { resolveMeterMwFactor } from '@/utils/meterUnit';

const TARGET_PLANTS = [
  { name: 'BHUPALPALLY', state: 'Telangana', type: 'Solar', capacityMw: 0, dsmThresholdMw: 0 },
  { name: 'CME', state: 'Maharashtra', type: 'Solar', capacityMw: 5, dsmThresholdMw: 0 },
  { name: 'Globus Steel N Power (GSNP)', state: 'Madhya Pradesh', type: 'Solar', capacityMw: 20, dsmThresholdMw: 2.0 },
  { name: 'KASIPET', state: 'Telangana', type: 'Solar', capacityMw: 0, dsmThresholdMw: 0 },
  { name: 'KILAJ', state: 'Maharashtra', type: 'Solar', capacityMw: 20, dsmThresholdMw: 2.0 },
  { name: 'KOTHAGUDEM', state: 'Telangana', type: 'Solar', capacityMw: 0, dsmThresholdMw: 0 },
  { name: 'OSEL', state: 'Maharashtra', type: 'Solar', capacityMw: 20, dsmThresholdMw: 2.0 },
  { name: 'BAMKHAL', state: 'Madhya Pradesh', type: 'Solar', capacityMw: 5, dsmThresholdMw: 0.5 },
  { name: 'SIRMOUR', state: 'Madhya Pradesh', type: 'Solar', capacityMw: 5.1, dsmThresholdMw: 0.51 },
  { name: 'ANJANGAON', state: 'Madhya Pradesh', type: 'Solar', capacityMw: 7.5, dsmThresholdMw: 0.75 },
  { name: 'ANDAD', state: 'Madhya Pradesh', type: 'Solar', capacityMw: 7.5, dsmThresholdMw: 0.75 },
  { name: 'GUGARIYAKHEDI', state: 'Madhya Pradesh', type: 'Solar', capacityMw: 7.5, dsmThresholdMw: 0.75 },
  { name: 'BALAKWADA', state: 'Madhya Pradesh', type: 'Solar', capacityMw: 7.5, dsmThresholdMw: 0.75 },
  { name: 'NANDGAON', state: 'Madhya Pradesh', type: 'Solar', capacityMw: 7.5, dsmThresholdMw: 0.75 },
];
const DSM_DEFAULT_ALLOWED_LIMIT_PERCENT = 10;
const DSM_BLOCK_DURATION_HOURS = 0.25;
const KWH_PER_MWH = 1000;
const PLANT_CODE_MAP = {
  bhupalpally: 'BHUPALPALLY',
  cme: 'CME',
  'globus steel n power (gsnp)': 'GSNP',
  gsnp: 'GSNP',
  kasipet: 'KASIPET',
  kilaj: 'KILAJ',
  kothagudem: 'KOTHAGUDEM',
  osepl: 'OSEPL',
  andad: 'ANDAD',
  balakwada: 'BALAKWADA',
  gugariyakhedi: 'GUGARIYAKHEDI',
  nandgaon: 'NANDGAON',
  bamkhal: 'BAMKHAL',
  sirmour: 'SIRMOUR',
  anjangaon: 'ANJANGAON',
};
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
};
const LEGACY_OUTPUTS_BASE_PREFIX = 'outputs/';
const normalizeText = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
const normalizeStateLabel = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const key = raw.toUpperCase().replace(/\./g, '');
  const map = {
    TL: 'Telangana',
    TS: 'Telangana',
    MH: 'Maharashtra',
    MP: 'Madhya Pradesh',
    RJ: 'Rajasthan',
    GJ: 'Gujarat',
    TN: 'Tamil Nadu',
    KA: 'Karnataka',
  };
  return map[key] || raw;
};
const normalizeStateName = (rawState) => {
  const text = String(rawState || '').trim();
  if (!text) return text;
  const lower = text.toLowerCase();
  if (lower === 'mh' || lower === 'maharashtra') return 'Maharashtra';
  if (lower === 'tl' || lower === 'telangana') return 'Telangana';
  if (lower === 'mp' || lower === 'madhya pradesh' || lower === 'madhyapradesh') return 'Madhya Pradesh';
  return text;
};

const getPenaltyConfig = (plantState, plantType) => {
  const config = DSM_PENALTY_CONFIG_BY_STATE[normalizeStateName(plantState)] || DEFAULT_DSM_PENALTY_CONFIG;
  return config.byType?.[plantType] || config.byType?.Solar || { bands: [] };
};

const getAllowedLimitPercent = (plantState, plantType) => {
  const config = DSM_PENALTY_CONFIG_BY_STATE[normalizeStateName(plantState)] || DEFAULT_DSM_PENALTY_CONFIG;
  const typeConfig = config.byType?.[plantType] || config.byType?.Solar;
  return typeConfig?.baseBand ?? DSM_DEFAULT_ALLOWED_LIMIT_PERCENT;
};

const getPenaltyRateForDeviationPercent = (absDeviationPercent, plantState, plantType) => {
  const config = getPenaltyConfig(plantState, plantType);
  const band = (config.bands || []).find((b) => absDeviationPercent >= b.min && absDeviationPercent < b.max);
  return band ? band.rate : 0;
};
const REPORT_TYPES = [
  { id: 'schedule', name: 'Schedule Summary', icon: FileText, color: 'primary', description: 'Day-ahead schedule integrity, revisions, and submission readiness.' },
  { id: 'deviation', name: 'Deviation Analysis', icon: TrendingUp, color: 'destructive', description: 'Actual vs scheduled performance and deviation band compliance.' },
];
const REPORT_PLANT_CATEGORIES = ['Wind', 'Solar'];
const REPORT_STATES = ['Maharashtra', 'Madhya Pradesh', 'Rajasthan', 'Telangana'];

const getApiOrigin = () => {
  if (API_ORIGIN) return API_ORIGIN;
  if (typeof window !== 'undefined') return window.location.origin;
  return '';
};

const resolveReportFileUrl = (fileUrl) => {
  if (!fileUrl) return null;
  const value = String(fileUrl).trim();
  if (!value) return null;

  if (/^(blob:|data:|https?:\/\/)/i.test(value)) return value;

  const apiBase = API_BASE_URL;
  const apiOrigin = getApiOrigin();

  if (value.startsWith('/api/')) return `${apiOrigin}${value}`;
  if (value.startsWith('/')) return `${apiOrigin}${value}`;

  return `${apiBase}/${value.replace(/^\/+/, '')}`;
};

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const formatNumber = (value, decimals = 2) => {
  const parsed = toNumber(value, 0);
  return parsed.toFixed(decimals);
};

const formatDateLabel = (value) => {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

const formatTimeLabel = (value) => {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
};

const getRevisionCountLabel = (count) => {
  const n = toNumber(count, 0);
  return n > 0 ? String(n) : 'No files in S3 for selected plant';
};

const getFinalRevisionLabel = (count, revisionNo, fileName = '') => {
  const n = toNumber(count, 0);
  if (n <= 0) return 'No files in S3 for selected plant';
  const filePart = String(fileName || '').trim();
  return filePart || '--';
};

const buildBlockTimeRange = (blockNumber) => {
  const safeBlock = Math.max(1, Math.min(96, Number(blockNumber) || 1));
  const startMinutes = (safeBlock - 1) * 15;
  const endMinutes = startMinutes + 15;
  const toLabel = (minutes) => {
    const hh = Math.floor((minutes % (24 * 60)) / 60);
    const mm = minutes % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };
  return `${toLabel(startMinutes)}-${toLabel(endMinutes)}`;
};

const ensureAllBlocks = (rows, mapper) => {
  const byBlock = new Map(rows.map((row) => [Number(row.block), row]));
  const result = [];
  for (let block = 1; block <= 96; block += 1) {
    const existing = byBlock.get(block);
    result.push(mapper(block, existing || null));
  }
  return result;
};

const toIsoDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().split('T')[0];
};

const getReportIsoDate = (report) => {
  const candidate = report?.generatedDate || report?.date || report?.sortDate || '';
  return toIsoDate(candidate);
};

const mapReportTypeToId = (value) => {
  const normalized = normalizeText(value);
  if (normalized === 'schedule' || normalized.includes('schedule summary')) return 'schedule';
  if (normalized === 'deviation' || normalized.includes('deviation analysis')) return 'deviation';
  if (normalized === 'financial-impact' || normalized.includes('dsm financial impact')) return 'financial-impact';
  return '';
};

const getPlantCodeFromName = (plantName) => {
  const normalized = normalizeText(plantName);
  if (PLANT_CODE_MAP[normalized]) return PLANT_CODE_MAP[normalized];
  if (normalized.includes('bhupalpally')) return 'BHUPALPALLY';
  if (normalized.includes('cme')) return 'CME';
  if (normalized.includes('gsnp') || normalized.includes('globus steel')) return 'GSNP';
  if (normalized.includes('kasipet')) return 'KASIPET';
  if (normalized.includes('kothagudem')) return 'KOTHAGUDEM';
  if (normalized.includes('sirmour') || normalized.includes('shromoutr') || normalized.includes('shirmour')) return 'SIRMOUR';
  if (normalized.includes('anjangaon') || normalized.includes('anjangoan')) return 'ANJANGAON';
  if (normalized.includes('andad')) return 'ANDAD';
  if (normalized.includes('balakwada')) return 'BALAKWADA';
  if (normalized.includes('gugariyakhedi')) return 'GUGARIYAKHEDI';
  if (normalized.includes('nandgaon')) return 'NANDGAON';
  if (normalized.includes('bamkhal')) return 'BAMKHAL';
  return null;
};

const getPlantByCode = (plantCode) =>
  TARGET_PLANTS.find((p) => getPlantCodeFromName(p.name) === plantCode) || TARGET_PLANTS[0];

const getSchedulePrefixes = (date, plantCode) => {
  const rawPrefix = RAW_BASE_PREFIXES[plantCode];
  const legacyRawPrefix = LEGACY_RAW_BASE_PREFIXES[plantCode];
  const generatedPrefix = GENERATED_OUTPUTS_BASE_PREFIXES[plantCode];
  const prefixes = [];
  if (rawPrefix) prefixes.push(`${rawPrefix}${date}/`);
  if (legacyRawPrefix) prefixes.push(`${legacyRawPrefix}${date}/`);
  if (generatedPrefix) prefixes.push(`${generatedPrefix}${date}/`);
  if (LEGACY_GENERATED_OUTPUTS_BASE_PREFIXES[plantCode]) {
    prefixes.push(`${LEGACY_GENERATED_OUTPUTS_BASE_PREFIXES[plantCode]}${date}/`);
  }
  prefixes.push(`${LEGACY_OUTPUTS_BASE_PREFIX}${date}/`);
  return prefixes;
};

const getMeterPrefixes = (date, plantCode) => {
  const rawPrefix = RAW_BASE_PREFIXES[plantCode];
  const legacyRawPrefix = LEGACY_RAW_BASE_PREFIXES[plantCode];
  const generatedPrefix = GENERATED_OUTPUTS_BASE_PREFIXES[plantCode];
  const prefixes = [];
  if (rawPrefix) prefixes.push(`${rawPrefix}${date}/metered_data/`);
  if (plantCode === 'ANJANGAON') prefixes.push(`raw/vedanjay/ANJANGOAN/${date}/metered_data/`);
  if (legacyRawPrefix) prefixes.push(`${legacyRawPrefix}${date}/metered_data/`);
  if (generatedPrefix) prefixes.push(`${generatedPrefix}${date}/meter/`);
  if (LEGACY_GENERATED_OUTPUTS_BASE_PREFIXES[plantCode]) {
    prefixes.push(`${LEGACY_GENERATED_OUTPUTS_BASE_PREFIXES[plantCode]}${date}/meter/`);
  }
  prefixes.push(`${LEGACY_OUTPUTS_BASE_PREFIX}${date}/meter/`, `${date}/meter/`);
  return prefixes;
};

const isScheduleCsvKey = (key) => {
  const lower = String(key || '').toLowerCase();
  return lower.endsWith('.csv') && !lower.includes('/intraday/') && isAnyScheduleCsvKey(lower);
};

const extractScheduleRevision = (key = '') => {
  const fileName = String(key || '').split('/').pop() || '';
  const match = fileName.match(/schedule_(?:free(?:z|ze)_)?from_(\d+)\.csv$/i);
  return match ? Number.parseInt(match[1], 10) : null;
};

const sortScheduleObjects = (items) => {
  return [...items].sort((a, b) => {
    const aRev = extractScheduleRevision(a.key);
    const bRev = extractScheduleRevision(b.key);
    if (aRev !== null && bRev !== null && bRev !== aRev) return bRev - aRev;
    const aTime = Date.parse(a.lastModified || '');
    const bTime = Date.parse(b.lastModified || '');
    const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
    if (timeDiff !== 0) return timeDiff;
    return String(b.key || '').localeCompare(String(a.key || ''));
  });
};

const getObjectTime = (obj) => {
  const ts = Date.parse(obj?.lastModified || '');
  return Number.isNaN(ts) ? 0 : ts;
};

const parseCsv = (text) => {
  const lines = String(text || '').split(/\r?\n/).filter((line) => line && line.trim().length > 0);
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
};

const parseScheduleCsvRows = (text) => {
  const lines = String(text || '').split(/\r?\n/).filter((line) => line && line.trim().length > 0);
  if (!lines.length) return [];
  const headerIdx = lines.findIndex((line) => {
    const l = String(line || '').toLowerCase();
    return l.includes('block') && (l.includes('schedule') || l.includes('forecast') || l.includes('timestamp'));
  });
  const csvTextFromHeader = headerIdx > 0 ? lines.slice(headerIdx).join('\n') : text;
  const { headers, rows } = parseCsv(csvTextFromHeader);
  if (!headers.length) return [];
  const normalized = headers.map((h) => String(h || '').toLowerCase().replace(/["']/g, '').replace(/[\s_-]+/g, ''));
  const findCol = (matchers) => normalized.findIndex((h) => matchers.some((m) => h.includes(m)));
  const blockIdx = findCol(['block', 'blockno', 'blk']);
  const scheduleIdx = findCol(['algoschedulemw', 'algoschedule', 'systemschedule', 'finalschedule', 'scheduledmw', 'scheduled', 'schedule']);
  if (blockIdx === -1 || scheduleIdx === -1) return [];

  return rows
    .map((cols) => {
      const block = parseInt(cols[blockIdx], 10);
      const scheduledMw = parseFloat(cols[scheduleIdx]);
      if (!Number.isFinite(block) || block < 1 || block > 96 || !Number.isFinite(scheduledMw)) return null;
      return {
        block,
        time: buildBlockTimeRange(block),
        scheduledMw,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.block - b.block);
};

const parseMeterCsvRows = (text, options = {}) => {
  const { headers, rows } = parseCsv(text);
  if (!headers.length) return [];
  const normalized = headers.map((h) => String(h || '').toLowerCase());
  const blockIdx = normalized.findIndex((h) => h.includes('block') || h.includes('blk'));
  const timeIdx = normalized.findIndex((h) => h.includes('time'));
  const powerIdx = normalized.findIndex((h) =>
    h.includes('active power') || h.includes('meter power') || h.includes('generation') || h.includes('kw') || h.includes('mw')
  );
  if (powerIdx === -1) return [];

  const header = normalized[powerIdx] || '';
  const isKw = header.includes('(kw)') || header.includes(' kw');
  const factor = resolveMeterMwFactor({
    plantCode: options?.plantCode || options?.plant_code,
    plantName: options?.plantName || options?.plant_name,
    sourceKey: options?.sourceKey || options?.source_key,
    explicitKw: isKw,
    explicitMw: header.includes('(mw)') || header.includes(' mw') || header === 'mw',
    averageValue: 0,
  });

  const getBlockFromTime = (raw) => parseBlockFromTimestamp(raw, { totalBlocks: 96 });

  const parsed = rows
    .map((cols, idx) => {
      const blockFromCol = blockIdx !== -1 ? parseInt(cols[blockIdx], 10) : null;
        const timeRaw = timeIdx !== -1 ? cols[timeIdx] : null;
        const hasTimeColumn = timeIdx !== -1;
        const blockFromTime = hasTimeColumn ? getBlockFromTime(timeRaw) : null;
        let block = null;
        if (Number.isFinite(blockFromCol)) {
          block = blockFromCol;
        } else if (Number.isFinite(blockFromTime)) {
          block = blockFromTime;
        } else if (!hasTimeColumn) {
          block = idx + 1;
        }
      const power = parseFloat(String(cols[powerIdx] ?? '').replace(/,/g, '').trim());
      if (!Number.isFinite(block) || block < 1 || block > 96 || !Number.isFinite(power)) return null;
      return { block, actualMw: power * factor };
    })
    .filter(Boolean);

  return Array.from(parsed.reduce((acc, row) => acc.set(row.block, row), new Map()).values()).sort((a, b) => a.block - b.block);
};

const buildReportDataFromBackend = async ({ reportType, reportDate, plantName, state }) => {
  const selectedDate = toIsoDate(reportDate) || reportDate;
  const selectedPlantCode = getPlantCodeFromName(plantName);
  const normalizedState = normalizeText(normalizeStateLabel(state));
  const fallbackCodes = TARGET_PLANTS
    .filter((p) => {
      if (!normalizedState) return true;
      return normalizeText(normalizeStateLabel(p.state)) === normalizedState;
    })
    .map((p) => getPlantCodeFromName(p.name))
    .filter(Boolean);
  const candidatePlantCodes = selectedPlantCode
    ? [selectedPlantCode]
    : (fallbackCodes.length ? fallbackCodes : TARGET_PLANTS.map((p) => getPlantCodeFromName(p.name)).filter(Boolean));

  let chosenPlantCode = candidatePlantCodes[0] || 'GSNP';
  let scheduleObjects = [];

  if (selectedPlantCode) {
    const objects = await listS3ObjectsAcrossPrefixes(getSchedulePrefixes(selectedDate, selectedPlantCode));
    const visibleObjects = await filterVisibleScheduleObjects(objects.filter((obj) => isScheduleCsvKey(obj.key)));
    scheduleObjects = sortScheduleObjects(visibleObjects);
  } else {
    // No plant selected: compare both configured MP solar plants and pick the one with latest S3 file.
    const byPlant = await Promise.all(candidatePlantCodes.map(async (code) => {
      const objects = await listS3ObjectsAcrossPrefixes(getSchedulePrefixes(selectedDate, code));
      const visibleObjects = await filterVisibleScheduleObjects(objects.filter((obj) => isScheduleCsvKey(obj.key)));
      const csvs = sortScheduleObjects(visibleObjects);
      const latestByTime = csvs.length ? [...csvs].sort((a, b) => getObjectTime(b) - getObjectTime(a))[0] : null;
      return { code, csvs, latestByTime };
    }));

    const best = byPlant
      .filter((entry) => entry.csvs.length > 0)
      .sort((a, b) => getObjectTime(b.latestByTime) - getObjectTime(a.latestByTime))[0];

    if (best) {
      chosenPlantCode = best.code;
      scheduleObjects = best.csvs;
    }
  }

  if (!scheduleObjects.length) {
    const fallbackObjects = await listS3ObjectsAcrossPrefixes(getSchedulePrefixes(selectedDate, chosenPlantCode));
    const visibleFallback = await filterVisibleScheduleObjects(fallbackObjects.filter((obj) => isScheduleCsvKey(obj.key)));
    scheduleObjects = sortScheduleObjects(visibleFallback);
  }

  const finalScheduleObject = scheduleObjects.length
    ? [...scheduleObjects].sort((a, b) => getObjectTime(b) - getObjectTime(a))[0]
    : null;
  const revisionZeroObject = [...scheduleObjects].sort((a, b) => {
    const aRev = extractScheduleRevision(a.key);
    const bRev = extractScheduleRevision(b.key);
    if (aRev !== null && bRev !== null && aRev !== bRev) return aRev - bRev;
    return Date.parse(a.lastModified || '') - Date.parse(b.lastModified || '');
  })[0] || null;

  const finalRows = finalScheduleObject ? parseScheduleCsvRows(await fetchTextFromS3(finalScheduleObject.key)) : [];
  const revisionZeroRows = revisionZeroObject ? parseScheduleCsvRows(await fetchTextFromS3(revisionZeroObject.key)) : [];
  const revisionZeroMap = new Map(revisionZeroRows.map((row) => [row.block, row.scheduledMw]));
  const finalRevisionNo = extractScheduleRevision(finalScheduleObject?.key || '') ?? 0;

  const meterObjects = await listS3ObjectsAcrossPrefixes(getMeterPrefixes(selectedDate, chosenPlantCode));
  const latestMeterObject = [...meterObjects]
    .filter((obj) => String(obj.key || '').toLowerCase().endsWith('.csv'))
    .sort((a, b) => Date.parse(b.lastModified || '') - Date.parse(a.lastModified || ''))[0] || null;
  const meterRows = latestMeterObject
    ? parseMeterCsvRows(await fetchTextFromS3(latestMeterObject.key), {
        plantCode: chosenPlantCode,
        plantName,
        sourceKey: latestMeterObject.key,
      })
    : [];
  const meterMap = new Map(meterRows.map((row) => [row.block, row.actualMw]));
  const plantConfig = getPlantByCode(chosenPlantCode);
  const capacityMw = toNumber(plantConfig?.capacityMw, 20);
  const plantState = plantConfig?.state || '';
  const plantType = plantConfig?.type || 'Solar';
  const allowedPercent = getAllowedLimitPercent(plantState, plantType);

  const scheduleRows = ensureAllBlocks(finalRows, (block, row) => {
    const actualMw = meterMap.get(block);
    const hasActualReading = Number.isFinite(actualMw);
    const revision0Mw = revisionZeroMap.get(block);
    const scheduledMw = row ? toNumber(row.scheduledMw, 0) : 0;
    const allowedMw = Math.abs(capacityMw) * (allowedPercent / 100);
    const lowerLimitMw = scheduledMw - allowedMw;
    const upperLimitMw = scheduledMw + allowedMw;
    const deviationMw = scheduledMw - (hasActualReading ? actualMw : 0);
    const deviationPct = capacityMw > 0 ? (deviationMw / capacityMw) * 100 : 0;
    const underGenerationMw = hasActualReading && actualMw < lowerLimitMw ? (lowerLimitMw - actualMw) : 0;
    const overGenerationMw = hasActualReading && actualMw > upperLimitMw ? (actualMw - upperLimitMw) : 0;
    const excessDeviationMw = Math.max(underGenerationMw, overGenerationMw, 0);
    return {
      block,
      time: row?.time || buildBlockTimeRange(block),
      scheduledMw,
      actualMw: hasActualReading ? actualMw : 0,
      hasActualReading,
      capacityMw,
      allowedMw,
      lowerLimitMw,
      upperLimitMw,
      revisionNo: finalRevisionNo,
      revision0Mw: Number.isFinite(revision0Mw) ? revision0Mw : null,
      deviationMw,
      deviationPct,
      excessDeviationMw,
    };
  });

  const deviationRows = scheduleRows
    .filter((row) => row.hasActualReading)
    .map((row) => {
      const deviationMw = toNumber(row.deviationMw, 0);
      const absDeviationPercent = Math.abs(toNumber(row.deviationPct, 0));
      const deviationEnergyKwh = Math.abs(deviationMw) * DSM_BLOCK_DURATION_HOURS * KWH_PER_MWH;
      const penaltyBands = getPenaltyConfig(plantState, plantType).bands || [];
      const penaltyRs = absDeviationPercent > 0
        ? penaltyBands.reduce((sum, band) => {
            const bandSpan = Math.min(absDeviationPercent, band.max) - band.min;
            if (bandSpan <= 0) return sum;
            const bandEnergyKwh = deviationEnergyKwh * (bandSpan / absDeviationPercent);
            return sum + (bandEnergyKwh * band.rate);
          }, 0)
        : 0;
      const penaltyRate = getPenaltyRateForDeviationPercent(absDeviationPercent, plantState, plantType);
      return {
        ...row,
        penaltyRate,
        deviationEnergyKwh,
        penaltyRs,
      };
    });
  const hasAnyBackendRows = finalRows.length > 0;
  const effectiveHeaderDate = selectedDate;

  const revisionHistory = await Promise.all(
    scheduleObjects.slice(0, 10).map(async (obj, index) => {
      const rows = parseScheduleCsvRows(await fetchTextFromS3(obj.key));
      const totalMWh = rows.reduce((sum, row) => sum + (toNumber(row.scheduledMw, 0) * 0.25), 0);
      const revisionNo = extractScheduleRevision(obj.key) ?? index;
      const reason = revisionNo === 0
        ? 'Day-ahead base forecast'
        : (revisionNo === finalRevisionNo ? 'Grid instructions' : 'Forecast updates');
      return {
        revisionNo,
        submittedAt: obj.lastModified || null,
        totalMWh,
        reason,
      };
    })
  );

  const totalScheduledEnergyMWh = scheduleRows.reduce((sum, row) => sum + (toNumber(row.scheduledMw, 0) * 0.25), 0);
  const totalScheduledEnergyMWhForDeviation = deviationRows.reduce((sum, row) => sum + (toNumber(row.scheduledMw, 0) * 0.25), 0);
  const totalActualGenerationMWh = deviationRows.reduce((sum, row) => sum + (toNumber(row.actualMw, 0) * 0.25), 0);
  const totalScheduledMwSum = scheduleRows.reduce((sum, row) => sum + toNumber(row.scheduledMw, 0), 0);
  const totalScheduledMwSumForDeviation = deviationRows.reduce((sum, row) => sum + toNumber(row.scheduledMw, 0), 0);
  const totalActualMwSum = deviationRows.reduce((sum, row) => sum + toNumber(row.actualMw, 0), 0);
  const netDeviationMWh = totalScheduledEnergyMWhForDeviation - totalActualGenerationMWh;
  const avgDeviationMw = deviationRows.length
    ? deviationRows.reduce((sum, row) => sum + Math.abs(toNumber(row.deviationMw, 0)), 0) / deviationRows.length
    : 0;
  const maxPositiveDeviationMw = deviationRows.length
    ? Math.max(...deviationRows.map((row) => toNumber(row.deviationMw, 0)))
    : 0;
  const maxNegativeDeviationMw = deviationRows.length
    ? Math.min(...deviationRows.map((row) => toNumber(row.deviationMw, 0)))
    : 0;
  const overallDeviationPct = deviationRows.length
    ? deviationRows.reduce((sum, row) => sum + Math.abs(toNumber(row.deviationPct, 0)), 0) / deviationRows.length
    : 0;

  const dsmRows = deviationRows.map((row) => {
    const deviationMw = toNumber(row.deviationMw, 0);
    const pct = toNumber(row.deviationPct, 0);
    const allowedForBlock = toNumber(row.allowedMw, 0);
    const excessDeviationMw = toNumber(row.excessDeviationMw, 0);
    const deviationEnergyMwh = toNumber(row.deviationEnergyKwh, 0) / KWH_PER_MWH;
    const charge = toNumber(row.penaltyRs, 0);
    return {
      block: row.block,
      time: row.time,
      deviationMw,
      deviationPct: pct,
      dsmRate: toNumber(row.penaltyRate, 0),
      allowedMw: allowedForBlock,
      excessDeviationMw,
      excessEnergyMwh: deviationEnergyMwh,
      charge,
    };
  });

  const totalDsmCharges = dsmRows.reduce((sum, row) => sum + row.charge, 0);
  const positiveSettlement = 0;
  const negativeSettlement = totalDsmCharges;
  const worstBlock = dsmRows.reduce((max, row) => (row.charge > max.charge ? row : max), { charge: 0, block: null });

  return {
    reportType,
    hasAnyBackendRows,
    header: {
      plantName: TARGET_PLANTS.find((p) => getPlantCodeFromName(p.name) === chosenPlantCode)?.name || plantName || 'N/A',
      plantCapacityMw: capacityMw,
      finalRevisionFileName: finalScheduleObject?.key ? String(finalScheduleObject.key).split('/').pop() : '',
      allRevisionFileNames: scheduleObjects.map((obj) => String(obj?.key || '').split('/').pop()).filter(Boolean),
      date: effectiveHeaderDate || reportDate,
      scheduleType: 'Intraday',
      latestRevisionNumber: finalRevisionNo,
      finalRevisionUsed: finalRevisionNo,
      revisionSubmissionTime: finalScheduleObject?.lastModified || null,
      dataSource: 'S3',
      totalBlocks: 96,
      dsmRateVersion: `Penalty uses state bands from DSM config: Schedule +/- (Plant Capacity x ${allowedPercent}%). Deviation energy split across bands by % and charged at band rates.`,
      applicableStateRules: state || 'Madhya Pradesh DSM',
    },
    schedule: {
      rows: scheduleRows,
      revisionHistory,
      kpis: {
        totalScheduledMwSum,
        totalScheduledEnergyMWh,
        avgScheduledPowerMw: scheduleRows.length ? scheduleRows.reduce((sum, row) => sum + toNumber(row.scheduledMw, 0), 0) / scheduleRows.length : 0,
        maxScheduledMw: scheduleRows.length ? Math.max(...scheduleRows.map((row) => toNumber(row.scheduledMw, 0))) : 0,
        minScheduledMw: scheduleRows.length ? Math.min(...scheduleRows.map((row) => toNumber(row.scheduledMw, 0))) : 0,
        numberOfRevisions: scheduleObjects.length,
        finalRevisionUsed: finalRevisionNo,
      },
    },
    deviation: {
      rows: deviationRows,
      kpis: {
        totalScheduledMwSum: totalScheduledMwSumForDeviation,
        totalActualMwSum,
        totalScheduledEnergyMWh: totalScheduledEnergyMWhForDeviation,
        totalActualGenerationMWh,
        netDeviationMWh,
        avgDeviationMw,
        maxPositiveDeviationMw,
        maxNegativeDeviationMw,
        overallDeviationPct,
      },
    },
    dsm: {
      rows: dsmRows,
      kpis: {
        totalDsmCharges,
        positiveSettlement,
        negativeSettlement,
        netPayableReceivable: positiveSettlement - negativeSettlement,
        averageDsmRate: dsmRows.length ? dsmRows.reduce((sum, row) => sum + row.dsmRate, 0) / dsmRows.length : 0,
        worstBlockPenalty: worstBlock.charge,
      },
    },
  };
};

const generatePDFReport = async (reportType, reportDate, filters = {}) => {
  const doc = new jsPDF();
  const reportTypeId = mapReportTypeToId(reportType);
  const data = await buildReportDataFromBackend({
    reportType: reportTypeId,
    reportDate,
    plantName: filters?.plantName,
    state: filters?.state,
  });

  const pageWidth = doc.internal.pageSize.width;
  const pageHeight = doc.internal.pageSize.height;
  const left = 14;
  const right = pageWidth - 14;
  const lineHeight = 5;

  const drawSectionTitle = (title, yPos) => {
    doc.setFontSize(12);
    doc.setTextColor(30);
    doc.text(title, left, yPos);
    doc.setDrawColor(200);
    doc.line(left, yPos + 2, right, yPos + 2);
    return yPos + 10;
  };

  const drawMetaRow = (label, value, yPos) => {
    doc.setFontSize(9);
    doc.setTextColor(90);
    doc.text(label, left, yPos);
    doc.setTextColor(30);
    doc.text(String(value ?? '--'), left + 35, yPos);
  };

  const drawKeyValue = (label, value, x, y) => {
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(label, x, y);
    doc.setFontSize(11);
    doc.setTextColor(20);
    doc.text(String(value), x, y + 6);
  };

  const drawInsight = (text, x, y) => {
    doc.setFontSize(9);
    doc.setTextColor(40);
    doc.text(`• ${text}`, x, y);
  };

  const ensureSpace = (yPos, required = 20) => {
    if (yPos + required > pageHeight - 20) {
      doc.addPage();
      return 20;
    }
    return yPos;
  };

  // Header
  doc.setFontSize(18);
  doc.setTextColor(30, 64, 175);
  doc.text('Vedanjay Power Control Dashboard', left, 20);
  doc.setFontSize(14);
  doc.setTextColor(30);
  doc.text(reportType, left, 28);
  doc.setDrawColor(220);
  doc.line(left, 31, right, 31);

  // Report metadata
  let y = 38;
  drawMetaRow('Plant', data.header.plantName, y);
  drawMetaRow('Date', data.header.date || reportDate, y + lineHeight);
  drawMetaRow('Schedule Type', data.header.scheduleType, y + lineHeight * 2);
  drawMetaRow(
    'Final Revision',
    getFinalRevisionLabel(data.schedule.kpis.numberOfRevisions, data.header.finalRevisionUsed, data.header.finalRevisionFileName),
    y + lineHeight * 3
  );
  drawMetaRow('Data Source', data.header.dataSource, y + lineHeight * 4);
  drawMetaRow('Generated', new Date().toLocaleString(), y + lineHeight * 5);

  y = y + lineHeight * 7;
  y = drawSectionTitle('Executive Summary', y);

  // Executive summary KPIs
  if (reportTypeId === 'schedule') {
    drawKeyValue('Total Scheduled Energy (MWh)', data.schedule.kpis.totalScheduledEnergyMWh.toFixed(3), left, y);
    drawKeyValue('Average Scheduled Power (MW)', data.schedule.kpis.avgScheduledPowerMw.toFixed(3), left + 70, y);
    drawKeyValue('Number of Revisions', getRevisionCountLabel(data.schedule.kpis.numberOfRevisions), left + 140, y);
    y += 16;
  } else if (reportTypeId === 'deviation') {
    drawKeyValue('Total Scheduled Energy (MWh)', data.deviation.kpis.totalScheduledEnergyMWh.toFixed(3), left, y);
    drawKeyValue('Total Actual Generation (MWh)', data.deviation.kpis.totalActualGenerationMWh.toFixed(3), left + 70, y);
    drawKeyValue('Net Deviation (MWh)', data.deviation.kpis.netDeviationMWh.toFixed(3), left + 140, y);
    y += 16;
  } else {
    drawKeyValue('Total DSM Charges (Rs)', data.dsm.kpis.totalDsmCharges.toFixed(2), left, y);
    drawKeyValue('Positive Settlement (Rs)', data.dsm.kpis.positiveSettlement.toFixed(2), left + 70, y);
    drawKeyValue('Net Position (Rs)', data.dsm.kpis.netPayableReceivable.toFixed(2), left + 140, y);
    y += 16;
  }

  y = ensureSpace(y, 26);
  y = drawSectionTitle('Key Insights', y);
  if (reportTypeId === 'schedule') {
    drawInsight(
      `Final revision used: ${getFinalRevisionLabel(data.schedule.kpis.numberOfRevisions, data.schedule.kpis.finalRevisionUsed, data.header.finalRevisionFileName)}`,
      left,
      y
    );
    drawInsight(`Total scheduled energy: ${data.schedule.kpis.totalScheduledEnergyMWh.toFixed(3)} MWh`, left, y + 6);
    drawInsight(`Schedule rows: ${data.schedule.rows.length}`, left, y + 12);
    y += 22;
  } else if (reportTypeId === 'deviation') {
    drawInsight(`Overall deviation: ${data.deviation.kpis.overallDeviationPct.toFixed(2)}%`, left, y);
    drawInsight(`Max positive deviation: ${data.deviation.kpis.maxPositiveDeviationMw.toFixed(3)} MW`, left, y + 6);
    drawInsight(`Max negative deviation: ${data.deviation.kpis.maxNegativeDeviationMw.toFixed(3)} MW`, left, y + 12);
    y += 22;
  } else {
    const net = data.dsm.kpis.netPayableReceivable;
    drawInsight(`Settlement position: ${net >= 0 ? 'Receivable' : 'Payable'}`, left, y);
    drawInsight(`Average DSM rate: ${data.dsm.kpis.averageDsmRate.toFixed(3)} Rs/kWh`, left, y + 6);
    drawInsight(`Worst block penalty: Rs ${data.dsm.kpis.worstBlockPenalty.toFixed(2)}`, left, y + 12);
    y += 22;
  }

  y = ensureSpace(y, 28);
  y = drawSectionTitle('Detailed Records (All Blocks)', y);

  if (reportTypeId === 'schedule') {
    const headerText = 'Block No | Time | Scheduled MW | Revision No | Delta Rev0->Final';
    doc.text(headerText, 14, y);
    y += 6;
    data.schedule.rows.forEach((row) => {
      if (y > pageHeight - 20) {
        doc.addPage();
        y = 20;
        doc.text(headerText, 14, y);
        y += 6;
      }
      const delta = row.revision0Mw === null ? '--' : (row.scheduledMw - row.revision0Mw).toFixed(3);
      doc.text(`${row.block} | ${row.time} | ${row.scheduledMw.toFixed(3)} | ${row.revisionNo} | ${delta}`, 14, y);
      y += 5;
    });
  } else if (reportTypeId === 'deviation') {
    const headerText = 'Block No | Time | Scheduled MW | Actual MW | Deviation MW | % Deviation | Penalty (Rs)';
    doc.text(headerText, 14, y);
    y += 6;
    data.deviation.rows.forEach((row) => {
      if (y > pageHeight - 20) {
        doc.addPage();
        y = 20;
        doc.text(headerText, 14, y);
        y += 6;
      }
      doc.text(
        `${row.block} | ${row.time} | ${toNumber(row.scheduledMw, 0).toFixed(3)} | ${toNumber(row.actualMw, 0).toFixed(3)} | ${toNumber(row.deviationMw, 0).toFixed(3)} | ${toNumber(row.deviationPct, 0).toFixed(2)}% | ${toNumber(row.penaltyRs, 0).toFixed(2)}`,
        14,
        y
      );
      y += 5;
    });
  } else {
    const headerText = 'Block No | Deviation MW | DSM Rate (Rs/kWh) | Charge (Rs)';
    doc.text(headerText, 14, y);
    y += 6;
    data.dsm.rows.forEach((row) => {
      if (y > pageHeight - 20) {
        doc.addPage();
        y = 20;
        doc.text(headerText, 14, y);
        y += 6;
      }
      doc.text(`${row.block} | ${row.deviationMw.toFixed(3)} | ${row.dsmRate.toFixed(3)} | ${row.charge.toFixed(2)}`, 14, y);
      y += 5;
    });
  }

  y = ensureSpace(y + 6, 28);
  y = drawSectionTitle('End-of-Report Summary', y);

  if (reportTypeId === 'schedule') {
    const missingBlocks = Math.max(0, 96 - (data.schedule.rows?.length || 0));
    const rowsWithDelta = data.schedule.rows.filter((row) => Number.isFinite(row.revision0Mw));
    const largestDelta = rowsWithDelta.length
      ? rowsWithDelta.reduce((max, row) => Math.max(max, Math.abs(toNumber(row.scheduledMw, 0) - toNumber(row.revision0Mw, 0))), 0)
      : 0;
    doc.setFontSize(9);
    doc.setTextColor(40);
    doc.text(
      `Revision Summary (S3 files): Total revisions ${getRevisionCountLabel(data.schedule.kpis.numberOfRevisions)}, Final revision ${getFinalRevisionLabel(data.schedule.kpis.numberOfRevisions, data.schedule.kpis.finalRevisionUsed, data.header.finalRevisionFileName)}`,
      left,
      y
    );
    doc.text(`Largest revision delta: ${largestDelta.toFixed(3)} MW`, left, y + 6);
    doc.text(`Data completeness: ${data.schedule.rows.length}/96 blocks, Missing blocks: ${missingBlocks}`, left, y + 12);
    y += 22;
  } else if (reportTypeId === 'deviation') {
    const deviationRows = data.deviation.rows || [];
    const withinThreshold = deviationRows.filter((row) => toNumber(row.excessDeviationMw, 0) <= 0).length;
    const breaches = deviationRows.filter((row) => toNumber(row.excessDeviationMw, 0) > 0).length;
    const pct = (count) => deviationRows.length ? ((count / deviationRows.length) * 100).toFixed(1) : '0.0';
    const worstBlocks = [...deviationRows]
      .sort((a, b) => Math.abs(toNumber(b.deviationMw, 0)) - Math.abs(toNumber(a.deviationMw, 0)))
      .slice(0, 5)
      .map((row) => `B${row.block} ${row.time} (${toNumber(row.deviationMw, 0).toFixed(2)} MW)`)
      .join(', ');

    doc.setFontSize(9);
    doc.setTextColor(40);
    doc.text(`Deviation compliance: Within threshold: ${pct(withinThreshold)}%, Breach: ${pct(breaches)}%`, left, y);
    doc.text(`Worst 5 blocks: ${worstBlocks || 'N/A'}`, left, y + 6);
    doc.text('Root-cause notes: Review meter/forecast variance in top deviation blocks.', left, y + 12);
    y += 22;
  } else {
    const totalCharges = data.dsm.kpis.totalDsmCharges || 0;
    const breachRows = data.dsm.rows.filter((row) => toNumber(row.excessDeviationMw, 0) > 0);
    const normalRows = data.dsm.rows.filter((row) => toNumber(row.excessDeviationMw, 0) <= 0);
    const chargeSharePct = (rows) => totalCharges
      ? ((rows.reduce((sum, row) => sum + toNumber(row.charge, 0), 0) / totalCharges) * 100).toFixed(1)
      : '0.0';
    const topPenalty = [...data.dsm.rows]
      .sort((a, b) => toNumber(b.charge, 0) - toNumber(a.charge, 0))
      .slice(0, 5)
      .map((row) => `B${row.block} (${toNumber(row.charge, 0).toFixed(2)})`)
      .join(', ');
    const netLabel = data.dsm.kpis.netPayableReceivable >= 0 ? 'Receivable' : 'Payable';

    doc.setFontSize(9);
    doc.setTextColor(40);
    doc.text(`Settlement summary: Total DSM Charges Rs ${totalCharges.toFixed(2)} | Net position ${netLabel}`, left, y);
    doc.text(`Charge distribution: Breach blocks ${chargeSharePct(breachRows)}%, Normal blocks ${chargeSharePct(normalRows)}%`, left, y + 6);
    doc.text(`Top 5 penalty blocks: ${topPenalty || 'N/A'}`, left, y + 12);
    y += 22;
  }

  y = ensureSpace(y + 4, 24);
  doc.setFontSize(9);
  doc.setTextColor(80);
  doc.text('Prepared by: ____________________', left, y);
  doc.text('Reviewed by: ____________________', left + 70, y);
  doc.text('Approved by: ____________________', left + 140, y);

  doc.setFontSize(8);
  doc.setTextColor(120);
  doc.text('Confidential — For internal operations only', left, pageHeight - 12);
  doc.text(`Generated on ${new Date().toLocaleString()}`, left, pageHeight - 6);

  const blob = doc.output('blob');
  const url = URL.createObjectURL(blob);
  return {
    blob,
    url,
    filename: `${reportType.replace(/\s+/g, '-')}-report-${reportDate}.pdf`,
    data,
  };
};

export function Reports({ isActive = true } = {}) {
  const { user: currentUser } = useAuth();
  const reportsTableScrollRef = useRef(null);
  const reportsTouchRef = useRef({ x: 0, y: 0, scrollLeft: 0, active: false });
  const [selectedReport, setSelectedReport] = useState('');
  const [reportDate, setReportDate] = useState(new Date().toISOString().split('T')[0]);
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [selectedReportData, setSelectedReportData] = useState(null);
  const [viewedReport, setViewedReport] = useState(null);
  
  // Reports state
  const [reports, setReports] = useState([]);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);
  const [previewData, setPreviewData] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);

  // Real-time update state
  const [pendingReports, setPendingReports] = useState([]);
  const [showNewReportNotification, setShowNewReportNotification] = useState(false);
  const [pollingInterval, setPollingInterval] = useState(null);
  const pollingCountRef = useRef(0);
  const MAX_POLLING_ATTEMPTS = 10; // Poll for up to 30 seconds (3s * 10)

  // Filter state
  const [filters, setFilters] = useState({
    plantCategory: '',
    state: '',
    plantId: '',
    period: 'daily'
  });

  const { data: plantsData, error: plantsError } = useApi(
    () => api.plants.getAll({ noMock: true, status: 'Active' }),
    { immediate: true, initialData: { plants: [], total: 0 } }
  );

  const activeTargetPlants = useMemo(() => {
    let list = plantsData?.plants || [];
    list = list.filter((p) => {
      const status = normalizeText(p.status);
      return status === 'active' || !status;
    });
    // Use full plant master list for filters (all categories/states/plants).
    const mergedKeys = new Set(list.map((p) => normalizeText(p.code || p.name)));
    const extras = TARGET_PLANTS
      .map((p, idx) => ({ id: p.id || `fallback-${idx}`, code: getPlantCodeFromName(p.name), name: p.name, state: p.state, type: p.type, capacityMw: p.capacityMw }))
      .filter((p) => !mergedKeys.has(normalizeText(p.code || p.name)));
    return filterPlantsForUser([...list, ...extras], currentUser);
  }, [plantsData, currentUser]);

  const plantCategoryOptions = useMemo(() => {
    return REPORT_PLANT_CATEGORIES;
  }, []);

  const stateOptions = useMemo(() => {
    return REPORT_STATES;
  }, []);

  const plantOptions = useMemo(() => {
    let list = activeTargetPlants;
    if (filters.plantCategory) {
      list = list.filter((p) => normalizeText(p.type) === normalizeText(filters.plantCategory));
    }
    if (filters.state) {
      list = list.filter(
        (p) =>
          normalizeText(normalizeStateLabel(p.state)) ===
          normalizeText(normalizeStateLabel(filters.state))
      );
    }

    return list;
  }, [activeTargetPlants, filters.plantCategory, filters.state]);

  useEffect(() => {
    if (!filters.plantId) return;
    const stillValid = plantOptions.some((p) => String(p.id) === String(filters.plantId));
    if (!stillValid) {
      setFilters((prev) => ({ ...prev, plantId: '' }));
    }
  }, [filters.plantId, plantOptions]);

  const reportTypes = REPORT_TYPES;

  const selectedPlantName = useMemo(() => {
    const selectedPlant = plantOptions.find((p) => String(p.id) === String(filters.plantId));
    return selectedPlant?.name || '';
  }, [filters.plantId, plantOptions]);

  const currentPreviewTypeId = useMemo(() => {
    const activeType = String(
      selectedReportData?.type ||
      viewedReport?.type ||
      reportTypes.find((r) => r.id === selectedReport)?.name ||
      selectedReport ||
      ''
    );
    return mapReportTypeToId(activeType);
  }, [selectedReportData?.type, viewedReport?.type, selectedReport, reportTypes]);

  const isStructuredPreview = currentPreviewTypeId === 'schedule' || currentPreviewTypeId === 'deviation' || currentPreviewTypeId === 'financial-impact';

  const toneClasses = {
    emerald: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    amber: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    red: 'bg-red-500/15 text-red-300 border-red-500/30',
    indigo: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
    slate: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  };

  const previewInsights = useMemo(() => {
    if (!previewData || !currentPreviewTypeId) return null;
    if (currentPreviewTypeId === 'schedule') {
      const rows = previewData.schedule?.rows || [];
      const rowsWithRev0 = rows.filter((row) => Number.isFinite(row.revision0Mw));
      const avgRevisionDelta = rowsWithRev0.length
        ? rowsWithRev0.reduce((sum, row) => sum + Math.abs(toNumber(row.scheduledMw, 0) - toNumber(row.revision0Mw, 0)), 0) / rowsWithRev0.length
        : 0;
      const maxRow = rows.reduce((best, row) => (
        toNumber(row.scheduledMw, -Infinity) > toNumber(best?.scheduledMw, -Infinity) ? row : best
      ), rows[0] || null);
      const stability = avgRevisionDelta <= 0.5 ? { label: 'Stable', tone: 'emerald' }
        : avgRevisionDelta <= 1.5 ? { label: 'Moderate', tone: 'amber' }
          : { label: 'Volatile', tone: 'red' };
        return {
          summary: [
            { label: 'Total Schedule (sum algo MW)', value: `${formatNumber(previewData.schedule.kpis.totalScheduledMwSum, 3)} MW` },
            { label: 'Average Scheduled Power', value: `${formatNumber(previewData.schedule.kpis.avgScheduledPowerMw, 3)} MW` },
            { label: 'Final Revision Used', value: getFinalRevisionLabel(previewData.schedule.kpis.numberOfRevisions, previewData.schedule.kpis.finalRevisionUsed, previewData.header?.finalRevisionFileName) },
        ],
        highlights: [
          `Revisions in S3 files: ${getRevisionCountLabel(previewData.schedule.kpis.numberOfRevisions)}`,
          `Avg revision delta: ${formatNumber(avgRevisionDelta, 3)} MW`,
          maxRow ? `Peak schedule: Block ${maxRow.block} (${maxRow.time})` : 'Peak schedule not available',
        ],
        statusLabel: 'Revision Stability',
        statusValue: stability.label,
        statusTone: stability.tone,
        coverageLabel: 'Data Coverage',
        coverageValue: previewData.hasAnyBackendRows ? 'Complete' : 'Partial',
        coverageTone: previewData.hasAnyBackendRows ? 'emerald' : 'amber',
      };
    }
    if (currentPreviewTypeId === 'deviation') {
      const rows = previewData.deviation?.rows || [];
      const worstRow = rows.reduce((best, row) => {
        const score = Math.abs(toNumber(row.deviationMw, 0));
        return score > Math.abs(toNumber(best?.deviationMw, 0)) ? row : best;
      }, rows[0] || null);
      const breachCount = rows.filter((row) => toNumber(row.excessDeviationMw, 0) > 0).length;
      const band = breachCount === 0
        ? { label: 'Within Threshold', tone: 'emerald' }
        : { label: `${breachCount} Breach Blocks`, tone: 'red' };
      return {
        summary: [
          { label: 'Total Schedule (sum algo MW)', value: `${formatNumber(previewData.deviation.kpis.totalScheduledMwSum, 3)} MW` },
          { label: 'Total Actual Generation (sum meter MW)', value: `${formatNumber(previewData.deviation.kpis.totalActualMwSum, 3)} MW` },
        ],
        highlights: [
          `Average absolute deviation: ${formatNumber(previewData.deviation.kpis.avgDeviationMw, 3)} MW`,
          `Max positive deviation: ${formatNumber(previewData.deviation.kpis.maxPositiveDeviationMw, 3)} MW`,
          worstRow ? `Worst block: ${worstRow.block} (${worstRow.time})` : 'Worst block not available',
        ],
        statusLabel: 'Deviation Threshold',
        statusValue: band.label,
        statusTone: band.tone,
        coverageLabel: 'Data Coverage',
        coverageValue: previewData.hasAnyBackendRows ? 'Complete' : 'Partial',
        coverageTone: previewData.hasAnyBackendRows ? 'emerald' : 'amber',
      };
    }
    const netPosition = toNumber(previewData.dsm.kpis.netPayableReceivable, 0);
    const settlement = netPosition >= 0 ? { label: 'Receivable', tone: 'emerald' } : { label: 'Payable', tone: 'red' };
    return {
      summary: [
        { label: 'Total DSM Charges', value: `Rs ${formatNumber(previewData.dsm.kpis.totalDsmCharges, 2)}` },
        { label: 'Positive Settlement', value: `Rs ${formatNumber(previewData.dsm.kpis.positiveSettlement, 2)}` },
        { label: 'Net Position', value: `Rs ${formatNumber(netPosition, 2)}` },
      ],
      highlights: [
        `Average DSM rate: ${formatNumber(previewData.dsm.kpis.averageDsmRate, 3)} Rs/kWh`,
        `Worst block penalty: Rs ${formatNumber(previewData.dsm.kpis.worstBlockPenalty, 2)}`,
        `Negative settlement: Rs ${formatNumber(previewData.dsm.kpis.negativeSettlement, 2)}`,
      ],
      statusLabel: 'Settlement Position',
      statusValue: settlement.label,
      statusTone: settlement.tone,
      coverageLabel: 'Data Coverage',
      coverageValue: previewData.hasAnyBackendRows ? 'Complete' : 'Partial',
      coverageTone: previewData.hasAnyBackendRows ? 'emerald' : 'amber',
    };
  }, [previewData, currentPreviewTypeId]);

  const loadPreviewData = useCallback(async (forcedTypeId = '', forcedDate = null) => {
    const resolvedType = forcedTypeId || currentPreviewTypeId || selectedReport;
    const reportTypeId = mapReportTypeToId(resolvedType);
    if (!reportTypeId) {
      setPreviewData(null);
      return;
    }
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const data = await buildReportDataFromBackend({
        reportType: reportTypeId,
        reportDate: forcedDate || reportDate,
        plantName: selectedPlantName,
        state: filters.state,
      });
      setPreviewData(data);
    } catch (error) {
      setPreviewData(null);
      setPreviewError(error.message || 'Failed to load report preview data');
    } finally {
      setPreviewLoading(false);
    }
  }, [currentPreviewTypeId, selectedReport, reportDate, selectedPlantName, filters.state]);

  useEffect(() => {
    if (!isActive || !showPreviewModal || !isStructuredPreview) return undefined;
    loadPreviewData();
    const interval = setInterval(() => {
      loadPreviewData();
    }, 30000);
    return () => clearInterval(interval);
  }, [isActive, showPreviewModal, isStructuredPreview, loadPreviewData]);

  // Fetch reports from API with filters
  const fetchReports = useCallback(async (options = {}) => {
    try {
      const { showLoading = true } = options;
      
      if (showLoading) {
        setReportsLoading(true);
      }
      setErrorMessage(null);
      
      const result = await api.reports.getAll({ 
        noMock: true, 
        state: filters.state || undefined,
        plantId: /^\d+$/.test(String(filters.plantId || '')) ? filters.plantId : undefined
      });
      const reportsList = Array.isArray(result?.reports) ? result.reports : [];
      
      // If no reports from backend, show empty state (no fake reports)
      if (reportsList.length === 0) {
        setReports((prev) => prev.filter((r) => r.source === 'pending' || !!r.localUrl));
        setReportsLoading(false);
        return;
      }
      
      if (reportsList.length) {
        // Transform reports from database
        const transformedReports = reportsList.map((r) => ({
          id: r.id,
          name: r.name || 'Unknown Report',
          date: r.date || new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
          type: r.type || 'General',
          size: r.size || 'N/A',
          status: r.status || 'Ready',
          filePath: r.filePath || null,
          source: 'database',
          sortDate: r.createdAt || r.generatedDate || new Date().toISOString()
        }));
        
        // Sort by date (newest first)
        const sortedReports = transformedReports.sort((a, b) => {
          const dateA = new Date(a.sortDate);
          const dateB = new Date(b.sortDate);
          return dateB - dateA;
        });
        setReports((prev) => {
          const localReports = prev.filter((r) => r.source === 'pending' || r.localUrl);
          return [...localReports, ...sortedReports.filter((r) => !localReports.some((lr) => lr.id === r.id))];
        });
      }
    } catch (error) {
      console.error('Error fetching reports:', error);
      setReports([]);
      setErrorMessage(`Failed to load reports: ${error.message || 'Unknown error'}`);
    } finally {
      setReportsLoading(false);
    }
  }, [filters.state, filters.plantId]);

  // Fetch reports when filters change
  useEffect(() => {
    // Small delay to avoid too many API calls while typing
    const timer = setTimeout(() => {
      fetchReports();
    }, 300);
    
    return () => clearTimeout(timer);
  }, [filters.state, filters.plantId, fetchReports]);


const handleGenerateReport = async () => {
    // Clear previous error
    setErrorMessage(null);
    
    // If no report type selected but we have a viewed report, use its type
    let reportId = selectedReport;
    if (!reportId && viewedReport && viewedReport.type) {
      const reportType = reportTypes.find(rt => rt.name === viewedReport.type);
      if (reportType) {
        reportId = reportType.id;
        setSelectedReport(reportId);
      }
    }
    
    if (!reportId) {
      setErrorMessage('Please select a report type');
      return;
    }

    setIsGenerating(true);

    try {
      // Use reportId which was determined earlier (may be from viewedReport)
      const reportTypeName = reportTypes.find(r => r.id === reportId)?.name || viewedReport?.type || reportId;
      const reportName = `${reportTypeName} - ${reportDate}`;
      const currentDate = new Date();
      const selectedPlant = plantOptions.find((p) => String(p.id) === String(filters.plantId));
      const pdfResult = await generatePDFReport(reportTypeName, reportDate, {
        ...filters,
        plantName: selectedPlant?.name,
      });
      const reportSize = pdfResult?.blob?.size
        ? `${(pdfResult.blob.size / (1024 * 1024)).toFixed(2)} MB`
        : 'N/A';
      
      // OPTIMISTIC UPDATE: Add new report immediately to the table with "Generating" status
      const tempReportId = `pending-${Date.now()}`;
      const optimisticReport = {
        id: tempReportId,
        name: reportName,
        type: reportTypeName,
        date: currentDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
        size: reportSize,
        status: 'Generating',
        filePath: pdfResult?.url || null,
        localUrl: pdfResult?.url || null,
        filename: pdfResult?.filename || null,
        source: 'pending',
        sortDate: currentDate.toISOString()
      };
      
      // Add to reports list immediately (at the top since it's the newest)
      setReports(prev => [optimisticReport, ...prev]);
      setPendingReports(prev => [optimisticReport, ...prev]);
      
      // Show notification
      setShowNewReportNotification(true);
      setTimeout(() => {
        setShowNewReportNotification(false);
      }, 5000);

      // Save to backend
      const reportConfig = {
        name: reportName,
        type: reportTypeName,
        format: 'PDF',
        generatedDate: reportDate,
        period: filters.period || 'daily',
        status: 'Ready',
        size: reportSize,
        plantId: selectedPlant?.id || null,
        plantName: selectedPlant?.name || null,
        state: filters.state || null,
        plantCategory: filters.plantCategory || null
      };
      
      const result = await api.reports.generate(reportConfig);
      
      if (result && result.reportId) {
        // Success - update the optimistic report with real data
        const newReportId = typeof result.reportId === 'number' ? result.reportId : result.reportId.id || Date.now();
        
        setReports(prev => prev.map(r => 
          r.id === tempReportId 
            ? { 
                ...r, 
                id: newReportId, 
                status: 'Ready',
                filePath: result.downloadUrl || r.filePath || null,
                localUrl: r.localUrl || null,
                source: 'database'
              }
            : r
        ));
        
        // Also update pendingReports
        setPendingReports(prev => prev.map(r => 
          r.id === tempReportId 
            ? { 
                ...r, 
                id: newReportId, 
                status: 'Ready',
                filePath: result.downloadUrl || r.filePath || null,
                localUrl: r.localUrl || null,
                source: 'database'
              }
            : r
        ));
        
        // Start polling to ensure the report appears in the list from backend
        startPollingForNewReport(tempReportId, newReportId);
        
        // Clear any error
        setErrorMessage(null);
      } else {
        // Report generated but failed to save - keep optimistic report but show warning
        setErrorMessage('Report generated but save verification pending. Refresh to see in list.');
      }
    } catch (error) {
      console.error('Report generation error:', error);
      setErrorMessage(`Error generating report: ${error.message || 'Unknown error'}`);
      
      // Remove the optimistic report on error
      setReports(prev => prev.filter(r => r.source !== 'pending' || r.status !== 'Generating'));
      setPendingReports(prev => prev.filter(r => r.source !== 'pending' || r.status !== 'Generating'));
    } finally {
      setIsGenerating(false);
    }
  };

  // Start polling to check for new reports after generation
  const startPollingForNewReport = useCallback((tempId, realId) => {
    pollingCountRef.current = 0;
    
    // Clear any existing interval
    if (pollingInterval) {
      clearInterval(pollingInterval);
    }
    
    // Poll every 3 seconds for up to 30 seconds
    const interval = setInterval(async () => {
      pollingCountRef.current += 1;
      
      try {
        await fetchReports({ showLoading: false, append: true });
        
        // Check if our real report is now in the list from backend
        const hasRealReport = reports.some(r => 
          (r.id === realId || r.id === tempId) && 
          r.status === 'Ready' &&
          r.source === 'database'
        );
        
        // If we found the real report, update pending status
        if (hasRealReport) {
          setReports(prev => prev.map(r => 
            r.id === tempId ? { ...r, source: 'database' } : r
          ));
          setPendingReports(prev => prev.filter(r => r.id !== tempId));
        }
        
        if (hasRealReport || pollingCountRef.current >= MAX_POLLING_ATTEMPTS) {
          clearInterval(interval);
          setPollingInterval(null);
        }
      } catch (error) {
        console.warn('Polling error:', error);
        if (pollingCountRef.current >= MAX_POLLING_ATTEMPTS) {
          clearInterval(interval);
          setPollingInterval(null);
        }
      }
    }, 3000);
    
    setPollingInterval(interval);
  }, [fetchReports, reports, MAX_POLLING_ATTEMPTS, pollingInterval]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollingInterval) {
        clearInterval(pollingInterval);
      }
    };
  }, [pollingInterval]);

  /**
   * Handle downloading an existing report PDF
   * Downloads the actual file from the backend using report.filePath or report.url
   * Does NOT regenerate the PDF
   */
  const handleDownloadReport = async (report) => {
    try {
      // If the report has status "Generating", show info message and don't proceed
      if (report.status === 'Generating') {
        toast.info('Report is still generating. Please wait for it to complete.');
        return;
      }

      if (report.localUrl) {
        const anchor = document.createElement('a');
        anchor.href = report.localUrl;
        anchor.download = report.filename || `${report.name || 'report'}.pdf`;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        toast.success('Download started');
        return;
      }

      // Get the file URL from report.filePath or report.url (single source of truth)
      const fileUrl = report.filePath || report.url;
      
      if (!fileUrl) {
        toast.error('No file available for download');
        return;
      }

      const downloadUrl = resolveReportFileUrl(fileUrl);
      if (!downloadUrl) {
        toast.error('No file available for download');
        return;
      }

      console.log('Downloading report from:', downloadUrl);

      // Method 1: Use window.open for direct download
      window.open(downloadUrl, '_blank');

      // Method 2: Also create an anchor tag for reliable download
      const anchor = document.createElement('a');
      anchor.href = downloadUrl;
      anchor.download = `${report.name || 'report'}.pdf`;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      
      // Try to trigger download
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);

      toast.success('Download started');
    } catch (error) {
      console.error('Download error:', error);
      toast.error(`Error downloading report: ${error.message || 'Unknown error'}`);
    }
  };

  // Get current date inputs for fallback


  /**
   * Handle viewing a report
   * Previews the actual PDF if filePath or url exists
   * Shows "Preview not available" if no file is present
   */
  const handleViewReport = async (report) => {
    setSelectedReportData(report);
    setViewedReport(report);
    setShowPreviewModal(true);
    toast.success(`Viewing report: ${report.name}`);
    
    // Set report type from report.type field (single source of truth)
    if (report?.type) {
      const normalizedType = String(report.type).toLowerCase();
      const reportType = reportTypes.find(rt => rt.name === report.type || rt.id === normalizedType);
      if (reportType) {
        setSelectedReport(reportType.id);
        await loadPreviewData(reportType.id, reportDate);
      } else {
        // If type doesn't match known types, still set it
        setSelectedReport(report.type);
        await loadPreviewData(report.type, reportDate);
      }
    }
    
    // Use report.date directly (single source of truth)
    // The date field is already in the correct format from the API transformation
    // No need to extract from name
  };

  /**
   * Normalize report ID to consistent format
   * Handles string IDs (like 'pending-123456789'), numeric IDs, and object IDs
   */
  const normalizeReportId = (id) => {
    if (id === null || id === undefined) return null;
    
    // If it's a number, return as-is for backend
    if (typeof id === 'number') return id;
    
    // If it's a string, return as-is
    if (typeof id === 'string') return id;
    
    // If it's an object (like MongoDB _id), convert to string
    return String(id);
  };

  /**
   * Handle deleting a report from database
   * - Optimistically removes from UI
   * - Calls backend delete API for database reports
   */
  const handleDeleteReport = async (report) => {
    // Normalize the report ID
    const reportId = normalizeReportId(report.id);
    
    if (!reportId) {
      toast.error('Invalid report ID');
      return;
    }
    
    // Show confirmation dialog
    if (!window.confirm(`Are you sure you want to delete "${report.name}"?`)) {
      return;
    }

    // Reports from database have numeric IDs and source === 'database'
    const numericId = parseInt(reportId, 10);
    const isPendingReport = String(reportId).startsWith('pending-');
    const isDatabaseReport = !isPendingReport && !isNaN(numericId);
    
    // Store current reports state for potential restore on error
    const currentReports = [...reports];
    
    try {
      setDeletingId(reportId);
      
      // OPTIMISTIC UPDATE: Remove from UI immediately
      setReports(prev => prev.filter(r => normalizeReportId(r.id) !== reportId));
      
      // Also remove from pendingReports if present
      setPendingReports(prev => prev.filter(r => normalizeReportId(r.id) !== reportId));
      
      // Show success message immediately (optimistic UI)
      toast.success(`Report "${report.name}" deleted successfully`);
      
      // Clean up local object URL if present
      if (report.localUrl) {
        URL.revokeObjectURL(report.localUrl);
      }

      // Only call backend delete for actual database reports
      if (isDatabaseReport) {
        await api.reports.delete(numericId);
        await fetchReports({ showLoading: false });
        console.log('Database report deleted successfully:', numericId);
      } else if (isPendingReport) {
        console.log('Pending report removed from UI only (not yet in backend):', reportId);
      }
      
    } catch (error) {
      console.error('Delete error:', error);
      
      // Handle API errors gracefully
      if (error.message?.includes('Failed to fetch') || error.status === 0 || error.name === 'ApiError') {
        // Backend not available - keep the optimistic deletion
        console.log('Backend unavailable, report removed from UI only');
        toast.success(`Report deleted (backend unavailable)`);
      } else {
        // Restore reports on other errors
        setReports(currentReports);
        toast.error(`Failed to delete report: ${error.message || 'Unknown error'}`);
      }
    } finally {
      setDeletingId(null);
    }
  };

  const handlePreviewReport = async () => {
    if (!selectedReport) {
      setErrorMessage('Please select a report type');
      return;
    }
    setSelectedReportData(null);
    setViewedReport(null);
    setShowPreviewModal(true);
    await loadPreviewData(selectedReport, reportDate);
  };

  // Live clock state
  const [currentTime, setCurrentTime] = useState(new Date());

  // Update time every second for live clock
  useEffect(() => {
    if (!isActive) return undefined;
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, [isActive]);

  // If the user navigates away from Reports, stop background polling to reduce CPU/network churn.
  useEffect(() => {
    if (isActive) return undefined;
    if (pollingInterval) {
      clearInterval(pollingInterval);
      setPollingInterval(null);
    }
    return undefined;
  }, [isActive, pollingInterval]);

  const parseSizeToMb = (sizeText) => {
    if (!sizeText || typeof sizeText !== 'string') return 0;
    const match = sizeText.trim().match(/([\d.]+)\s*(kb|mb|gb)/i);
    if (!match) return 0;
    const value = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    if (unit === 'gb') return value * 1024;
    if (unit === 'kb') return value / 1024;
    return value;
  };

  const handleClearAllReports = async () => {
    if (reports.length === 0) {
      toast.info('No reports to delete');
      return;
    }

    if (!window.confirm('Delete all reports from the database? This cannot be undone.')) {
      return;
    }

    try {
      setDeletingId('all');
      const ids = reports.map((r) => normalizeReportId(r.id)).filter(Boolean);
      await Promise.allSettled(
        ids.map((id) => {
          const numericId = parseInt(id, 10);
          if (!isNaN(numericId)) {
            return api.reports.delete(numericId);
          }
          return Promise.resolve();
        })
      );
      setReports([]);
      setPendingReports([]);
      toast.success('All reports deleted');
      await fetchReports({ showLoading: false });
    } catch (error) {
      toast.error(`Failed to delete all reports: ${error.message || 'Unknown error'}`);
    } finally {
      setDeletingId(null);
    }
  };

  const visibleReports = useMemo(() => {
    const filterCategory = normalizeText(filters.plantCategory);
    const filterState = normalizeText(filters.state);
    const filterPlantId = String(filters.plantId || '').trim();
    const selectedPlant = plantOptions.find((p) => String(p.id) === filterPlantId);
    const selectedPlantName = selectedPlant?.name || '';
    const selectedPlantCode = getPlantCodeFromName(selectedPlantName);

    return reports.filter((report) => {
      const reportPlantId = report?.plantId != null ? String(report.plantId) : '';
      const reportPlantName = String(report?.plantName || report?.plant || report?.plant_code || '');
      const reportState = String(report?.state || '');
      const reportCategory = String(report?.plantCategory || report?.category || '');

      const matchesPlant =
        !filterPlantId ||
        reportPlantId === filterPlantId ||
        normalizeText(reportPlantName) === normalizeText(selectedPlantName) ||
        (selectedPlantCode && getPlantCodeFromName(reportPlantName) === selectedPlantCode);

      const matchesState =
        !filterState ||
        normalizeText(reportState) === filterState;

      const matchesCategory =
        !filterCategory ||
        normalizeText(reportCategory) === filterCategory;

      return matchesPlant && matchesState && matchesCategory;
    });
  }, [reports, filters.plantCategory, filters.state, filters.plantId, plantOptions]);

  const stats = useMemo(() => {
    const totalReports = visibleReports.length;
    const totalMb = visibleReports.reduce((sum, r) => sum + parseSizeToMb(r.size), 0);
    const totalSize = totalMb >= 1024
      ? `${(totalMb / 1024).toFixed(1)} GB`
      : `${totalMb.toFixed(1)} MB`;
    const activeCount = visibleReports.filter((r) => String(r.status).toLowerCase() !== 'ready').length;
    return {
      totalReports,
      totalSize,
      activeCount,
    };
  }, [visibleReports]);

  return (
    <div className="flex-1 overflow-auto bg-slate-950 min-h-0 relative">
      {/* Animated background elements */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />
      </div>

      <div className="w-full p-4 sm:p-6 lg:p-8 space-y-6 sm:space-y-8 max-w-[1600px] mx-auto relative z-10">
        {/* Premium Header */}
        <div className="relative overflow-hidden rounded-2xl bg-linear-to-br from-slate-900 via-slate-800 to-slate-900 border border-slate-700/50 shadow-2xl flex flex-col min-h-0 max-h-[70vh]">
          <div className="absolute inset-0 bg-linear-to-r from-indigo-500/5 via-transparent to-purple-500/5" />
          <div className="absolute top-0 right-0 w-64 h-64 bg-linear-to-bl from-indigo-500/10 to-transparent rounded-full blur-2xl" />
          
          <div className="relative p-4 sm:p-6 lg:p-8">
            <div className="flex items-start gap-4 sm:gap-5">
              <div className="relative">
                <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-xl bg-linear-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/25">
                  <BarChart3 className="w-6 h-6 sm:w-7 sm:h-7 text-white" />
                </div>
              </div>
              <div>
                <h1 className="text-2xl sm:text-3xl font-bold text-white mb-2 tracking-tight">
                  Reports & Analytics
                  <span className="text-transparent bg-clip-text bg-linear-to-r from-indigo-400 to-purple-400"> Dashboard</span>
                </h1>
                <div className="flex flex-wrap items-center gap-2 sm:gap-4 text-slate-400">
                  <div className="flex items-center gap-2">
                    <span className="relative flex h-2 w-2">
                      <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75 animate-ping" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                    </span>
                    <span className="text-xs sm:text-sm font-medium">Live Monitoring</span>
                  </div>
                  <span className="text-slate-600 hidden sm:inline">•</span>
                  <span className="text-xs sm:text-sm font-mono">{currentTime.toLocaleTimeString()}</span>
                  <span className="text-slate-600 hidden sm:inline">•</span>
                  <span className="text-xs sm:text-sm">{currentTime.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Report Type Selection */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
          {reportTypes.map(report => {
            const Icon = report.icon;
            const isSelected = selectedReport === report.id;

            const colorMap = {
              primary: { glow: 'bg-indigo-500/20', text: 'text-indigo-400' },
              destructive: { glow: 'bg-red-500/20', text: 'text-red-400' },
              success: { glow: 'bg-emerald-500/20', text: 'text-emerald-400' },
              secondary: { glow: 'bg-slate-500/20', text: 'text-slate-400' }
            };
            const colors = colorMap[report.color] || colorMap.secondary;

            return (
              <div
                key={report.id}
                onClick={() => setSelectedReport(report.id)}
                className={`group relative overflow-hidden rounded-2xl bg-linear-to-br from-slate-900 to-slate-800 border transition-all duration-500 cursor-pointer hover:-translate-y-1 hover:shadow-2xl ${
                  isSelected 
                    ? `border-${report.color === 'primary' ? 'indigo' : report.color === 'destructive' ? 'red' : report.color === 'success' ? 'emerald' : 'slate'}-500/50 shadow-lg shadow-${report.color === 'primary' ? 'indigo' : report.color === 'destructive' ? 'red' : report.color === 'success' ? 'emerald' : 'slate'}-500/20` 
                    : 'border-slate-700/50 hover:border-slate-600'
                }`}
              >
                <div className={`absolute inset-0 bg-linear-to-r ${colors.glow} opacity-0 group-hover:opacity-100 transition-opacity duration-500`} />
                <div className={`absolute top-0 right-0 w-32 h-32 bg-linear-to-bl ${colors.glow} rounded-full blur-3xl opacity-50 group-hover:opacity-75 transition-opacity duration-500`} />
                
                <div className="relative p-5 sm:p-6">
                  <div className={`relative w-fit mb-4 p-3 rounded-xl bg-linear-to-br ${colors.glow} group-hover:scale-110 transition-transform duration-300`}>
                    <Icon className={`w-5 h-5 sm:w-6 sm:h-6 ${colors.text}`} />
                  </div>
                  <h3 className={`text-sm sm:text-base font-semibold text-foreground mb-2 group-hover:text-${report.color === 'primary' ? 'indigo' : report.color === 'destructive' ? 'red' : report.color === 'success' ? 'emerald' : 'slate'}-400 transition-colors`}>{report.name}</h3>
                  <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-slate-700/60 bg-slate-900/70 px-3 py-1 text-[11px] uppercase tracking-widest text-slate-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    Preview available
                  </div>
                </div>
                
                {isSelected && (
                  <div className="absolute inset-0 border-2 border-indigo-500/50 rounded-2xl pointer-events-none">
                    <div className="absolute top-2 right-2 w-2 h-2 bg-indigo-500 rounded-full animate-pulse" />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Report Configuration */}
        <div className="relative rounded-2xl bg-linear-to-br from-slate-900 via-slate-800 to-slate-900 border border-slate-700/50 shadow-2xl">
          <div className="absolute inset-0 bg-linear-to-r from-indigo-500/5 via-transparent to-purple-500/5" />
          <div className="absolute top-0 left-0 w-64 h-64 bg-linear-to-br from-indigo-500/5 to-transparent rounded-full blur-2xl" />
          
          <div className="relative p-4 sm:p-6 lg:p-8">
            <div className="flex items-center gap-4 mb-6">
              <div className="p-3 rounded-xl bg-indigo-500/10">
                <BarChart3 className="w-5 h-5 sm:w-6 sm:h-6 text-indigo-400" />
              </div>
              <div>
                <h3 className="text-lg sm:text-xl font-bold text-foreground">Report Configuration</h3>
                <p className="text-xs sm:text-sm text-muted-foreground">Configure your report parameters</p>
              </div>
            </div>
            
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 sm:gap-8">
              <div className="space-y-5">
                <div>
                  <label className="text-sm font-medium text-foreground mb-2.5 block">Report Type</label>
                  <select 
                    value={selectedReport}
                    onChange={(e) => setSelectedReport(e.target.value)}
                    className="w-full px-3.5 py-2.5 sm:px-4 sm:py-3 rounded-xl bg-card border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                  >
                    <option value="">Select Report Type</option>
                    {reportTypes.map(type => (
                      <option key={type.id} value={type.id}>{type.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-sm font-medium text-foreground mb-2.5 block">Plant Category</label>
                  <select 
                    value={filters.plantCategory}
                    onChange={(e) => setFilters(prev => ({ ...prev, plantCategory: e.target.value, state: '', plantId: '' }))}
                    className="w-full px-3.5 py-2.5 sm:px-4 sm:py-3 rounded-xl bg-card border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                  >
                    <option value="">Select Category</option>
                    {plantCategoryOptions.map((category) => (
                      <option key={category} value={category}>{category}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-sm font-medium text-foreground mb-2.5 block">State</label>
                  <select 
                    value={filters.state}
                    onChange={(e) => setFilters(prev => ({ ...prev, state: e.target.value, plantId: '' }))}
                    className="w-full px-3.5 py-2.5 sm:px-4 sm:py-3 rounded-xl bg-card border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                  >
                    <option value="">Select State</option>
                    {stateOptions.map((stateName) => (
                      <option key={stateName} value={stateName}>{stateName}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-sm font-medium text-foreground mb-2.5 block">Plant</label>
                  <select
                    value={filters.plantId}
                    onChange={(e) => setFilters(prev => ({ ...prev, plantId: e.target.value }))}
                    className="w-full px-3.5 py-2.5 sm:px-4 sm:py-3 rounded-xl bg-card border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                  >
                    <option value="">Select Plant</option>
                    {plantOptions.length === 0 ? (
                      <option disabled>
                        {plantsError ? 'No plants available (backend error)' : 'No active plants'}
                      </option>
                    ) : (
                      plantOptions.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))
                    )}
                  </select>
                </div>
              </div>

              <div className="space-y-5">
                <div>
                  <label className="text-sm font-medium text-foreground mb-2.5 block">Date</label>
                  <input 
                    type="date"
                    value={reportDate}
                    onChange={(e) => setReportDate(e.target.value)}
                    className="w-full px-3.5 py-2.5 sm:px-4 sm:py-3 rounded-xl bg-card border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                  />
                </div>

                <div>
                  <label className="text-sm font-medium text-foreground mb-2.5 block">Export Format</label>
                  <div className="w-full px-3.5 py-2.5 sm:px-4 sm:py-3 rounded-xl bg-card border border-border text-sm">
                    <span className="text-foreground font-medium">PDF Document</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">Only PDF format is available</p>
                </div>
              </div>
            </div>

            <div className="mt-6 sm:mt-8 flex flex-col sm:flex-row gap-3 sm:gap-4">
              <button 
                onClick={handlePreviewReport}
                className="w-full sm:flex-1 px-6 py-3.5 rounded-xl bg-card hover:bg-accent border border-border transition-all font-semibold flex items-center justify-center gap-2 text-foreground"
              >
                <Eye className="w-5 h-5" />
                Preview Report
              </button>
              <button 
                onClick={handleGenerateReport}
                disabled={isGenerating}
                className={`w-full sm:flex-1 px-6 py-3.5 rounded-xl bg-linear-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white shadow-lg shadow-indigo-500/25 hover:shadow-indigo-500/40 transition-all font-semibold flex items-center justify-center gap-2 ${isGenerating ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {isGenerating ? (
                  <>
                    <RefreshCw className="w-5 h-5 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Download className="w-5 h-5" />
                    Generate PDF
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Error Message Display */}
        {errorMessage && (
          <div className="mt-4 p-4 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm">
            <div className="flex items-center gap-2">
              <span>{errorMessage}</span>
            </div>
            <button 
              onClick={() => setErrorMessage(null)}
              className="mt-2 text-xs underline hover:text-destructive/80"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Statistics Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6">
          {[
            { label: 'Total Reports Generated', value: stats.totalReports, subtext: 'From database', icon: FileText, color: 'indigo', gradient: 'from-emerald-500 to-green-400', glow: 'bg-indigo-500/20' },
            { label: 'Data Exported', value: stats.totalSize, subtext: 'Total size', icon: Download, color: 'emerald', gradient: 'from-emerald-600 to-teal-600', glow: 'bg-emerald-500/20' },
            { label: 'Scheduled Reports', value: stats.activeCount, subtext: 'Active schedules', icon: Calendar, color: 'amber', gradient: 'from-amber-600 to-orange-600', glow: 'bg-amber-500/20' }
          ].map((stat, i) => (
            <div 
              key={i}
              className="group relative overflow-hidden rounded-2xl bg-linear-to-br from-slate-900 to-slate-800 border border-slate-700/50 hover:border-slate-600 transition-all duration-500 hover:-translate-y-1 hover:shadow-2xl cursor-pointer"
            >
              <div className={`absolute inset-0 bg-linear-to-r ${stat.glow} opacity-0 group-hover:opacity-100 transition-opacity duration-500`} />
              <div className={`absolute top-0 right-0 w-32 h-32 bg-linear-to-bl ${stat.glow} rounded-full blur-3xl opacity-50 group-hover:opacity-75 transition-opacity duration-500`} />
              
              <div className="relative p-5 sm:p-6">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <p className="text-xs sm:text-sm font-medium text-slate-400 uppercase tracking-wider">{stat.label}</p>
                    <div className={`text-3xl sm:text-4xl xl:text-5xl font-bold mt-2 bg-linear-to-r ${stat.gradient} bg-clip-text text-transparent`}>
                      {stat.value}
                    </div>
                  </div>
                  <div className={`p-3 rounded-xl bg-linear-to-br ${stat.glow} group-hover:scale-110 transition-transform duration-300`}>
                    <stat.icon className={`w-5 h-5 sm:w-6 sm:h-6 text-${stat.color}-400`} />
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs sm:text-sm text-slate-400 group-hover:text-slate-300 transition-colors">
                  <TrendingUp className="w-4 h-4 text-indigo-400" />
                  {stat.subtext}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* New Report Notification */}
        {showNewReportNotification && (
          <div className="fixed bottom-6 right-6 z-[60] animate-in slide-in-from-right duration-300">
            <div className="bg-blue-600 border border-blue-700 text-white dark:bg-white dark:border-slate-200 dark:text-black px-4 py-3 rounded-lg shadow-lg flex items-center gap-3">
              <CheckCircle className="w-5 h-5" />
              <div>
                <p className="font-medium">Report Generated!</p>
                <p className="text-sm opacity-90">Check the Recent Reports table</p>
              </div>
              <button 
                onClick={() => setShowNewReportNotification(false)}
                className="ml-2 p-1 hover:bg-blue-500/40 dark:hover:bg-slate-200 rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* Recent Reports */}
        <div className="relative rounded-2xl bg-linear-to-br from-slate-900 via-slate-800 to-slate-900 border border-slate-700/50 shadow-2xl">
          <div className="absolute inset-0 bg-linear-to-r from-indigo-500/5 via-transparent to-purple-500/5" />
          
          <div className="relative p-4 sm:p-6 border-b border-slate-700/50">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div className="flex items-center gap-3 sm:gap-4">
                <div className="p-3 rounded-xl bg-indigo-500/10">
                  <FileSpreadsheet className="w-5 h-5 sm:w-6 sm:h-6 text-indigo-400" />
                </div>
                <div>
                  <h3 className="text-lg sm:text-xl font-bold text-foreground">Recent Reports</h3>
                  <p className="text-xs sm:text-sm text-muted-foreground">Previously generated reports</p>
                </div>
              </div>
              <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
                <button 
                  onClick={handleClearAllReports}
                  className="w-full sm:w-auto px-4 py-2.5 rounded-xl bg-red-600/20 hover:bg-red-600/30 border border-red-600/30 hover:border-red-600/50 transition-all flex items-center justify-center gap-2 text-black dark:text-red-200 font-medium disabled:opacity-50"
                  disabled={reportsLoading || deletingId === 'all'}
                >
                  {deletingId === 'all' ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      Clearing...
                    </>
                  ) : (
                    <>
                      <Trash2 className="w-4 h-4" />
                      Clear All
                    </>
                  )}
                </button>
                <button 
                  onClick={() => fetchReports({ showLoading: true })}
                  className="w-full sm:w-auto px-4 py-2.5 rounded-xl bg-slate-800/50 hover:bg-slate-700/50 border border-slate-700/50 hover:border-slate-600 transition-all flex items-center justify-center gap-2 text-white font-medium"
                  disabled={reportsLoading}
                >
                  <RefreshCw className={`w-4 h-4 ${reportsLoading ? 'animate-spin' : ''}`} />
                  Refresh
                </button>
              </div>
            </div>
          </div>
          
          <div className="flex-1 min-h-0 max-h-[55vh] sm:max-h-[60vh]">
            <div className="h-full w-full overflow-y-auto overscroll-contain" style={{ WebkitOverflowScrolling: 'touch' }}>
              <div
                ref={reportsTableScrollRef}
                className="w-full overflow-x-scroll"
                style={{
                  WebkitOverflowScrolling: 'touch',
                  touchAction: 'pan-x pan-y',
                  overscrollBehaviorX: 'contain',
                }}
                onTouchStart={(event) => {
                  const touch = event.touches[0];
                  const target = reportsTableScrollRef.current;
                  if (!touch || !target) return;
                  reportsTouchRef.current = {
                    x: touch.clientX,
                    y: touch.clientY,
                    scrollLeft: target.scrollLeft,
                    active: true,
                  };
                }}
                onTouchMove={(event) => {
                  const touch = event.touches[0];
                  const target = reportsTableScrollRef.current;
                  const state = reportsTouchRef.current;
                  if (!touch || !target || !state.active) return;
                  const dx = touch.clientX - state.x;
                  const dy = touch.clientY - state.y;
                  if (Math.abs(dx) > Math.abs(dy)) {
                    target.scrollLeft = state.scrollLeft - dx;
                  }
                }}
                onTouchEnd={() => {
                  reportsTouchRef.current.active = false;
                }}
              >
                <div className="min-w-[900px] w-max">
                  <table className="min-w-[900px] w-full">
              <thead className="bg-slate-800/50">
                <tr>
                  {['Report Name', 'Type', 'Status', 'Generated Date', 'File Size', 'Actions'].map(header => (
                    <th key={header} className="px-6 py-4 text-left text-xs font-semibold text-white dark:text-white uppercase tracking-wider">
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {reportsLoading && visibleReports.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center">
                      <div className="flex flex-col items-center gap-3">
                        <div className="w-10 h-10 rounded-full border-2 border-slate-700 border-t-indigo-500 animate-spin" />
                        <p className="text-sm text-slate-400">Loading reports...</p>
                      </div>
                    </td>
                  </tr>
                ) : visibleReports.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center">
                      <div className="flex flex-col items-center gap-3">
                        <div className="p-4 rounded-full bg-slate-800/50">
                          <FileSpreadsheet className="w-10 h-10 text-slate-600" />
                        </div>
                        <div>
                          <p className="text-base font-semibold text-slate-400">No reports found</p>
                          <p className="text-sm text-slate-500 mt-1">Generate a new report to get started</p>
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : (
                  visibleReports.map((report) => (
                    <tr 
                      key={report.id || report.name} 
                      className={`hover:bg-slate-800/50 transition-colors group ${
                        report.status === 'Generating' ? 'bg-indigo-500/5' : ''
                      }`}
                    >
                      <td className="px-6 py-5">
                        <div className="flex items-center gap-3">
                          <div className={`p-2.5 rounded-xl ${
                            report.status === 'Generating' ? 'bg-indigo-500/20 animate-pulse' : 'bg-indigo-500/20'
                          }`}>
                            <FileSpreadsheet className={`w-5 h-5 ${
                              report.status === 'Generating' ? 'text-indigo-400' : 'text-indigo-400'
                            }`} />
                          </div>
                          <div>
                            <p className="text-sm font-medium text-white group-hover:text-indigo-400 transition-colors">{report.name}</p>
                            <p className="text-xs text-slate-500">PDF Document</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-5">
                        <span className="inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 text-slate-300 border border-slate-700">
                          {report.type}
                        </span>
                      </td>
                      <td className="px-6 py-5">
                        {report.status === 'Generating' ? (
                          <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-500/20 text-amber-400 border border-amber-500/30">
                            <Clock className="w-4 h-4 animate-pulse" />
                            Generating...
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                            <CheckCircle className="w-4 h-4" />
                            Ready
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-5 text-sm text-slate-400">{report.date}</td>
                      <td className="px-6 py-5 text-sm font-semibold text-white">{report.size}</td>
                      <td className="px-6 py-5">
                        <div className="flex gap-2" style={{ position: 'relative', zIndex: 10 }}>
                          {/* View Button */}
                          <button
                            onClick={() => {
                              console.log('View button clicked for report:', report.id);
                              handleViewReport(report);
                            }}
                            disabled={report.status === 'Generating'}
                            className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white text-sm font-medium flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            style={{ pointerEvents: 'auto' }}
                          >
                            <Eye className="w-4 h-4" />
                            View
                          </button>
                          
                          {/* Download Button */}
                          <button
                            onClick={() => {
                              console.log('Download button clicked for report:', report.id);
                              handleDownloadReport(report);
                            }}
                            disabled={report.status === 'Generating'}
                            className="px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            style={{ pointerEvents: 'auto' }}
                          >
                            <Download className="w-4 h-4" />
                            Download
                          </button>
                          
                          {/* Delete Button */}
                          <button
                            onClick={() => {
                              console.log('Delete button clicked for report:', report.id);
                              handleDeleteReport(report);
                            }}
                            disabled={report.status === 'Generating' || deletingId !== null}
                            className="px-3.5 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-medium flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            style={{ pointerEvents: 'auto' }}
                          >
                            {deletingId !== null ? (
                              <>
                                <RefreshCw className="w-4 h-4 animate-spin" />
                                Deleting...
                              </>
                            ) : (
                              <>
                                <Trash2 className="w-4 h-4" />
                                Delete
                              </>
                            )}
                          </button>
                        </div>
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
        </div>
      </div>

      {/* Preview Modal */}
      {showPreviewModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="relative overflow-hidden rounded-2xl bg-linear-to-br from-slate-900 via-slate-800 to-slate-900 border border-slate-700 shadow-2xl w-full max-w-6xl max-h-[90vh] flex flex-col">
            <div className="absolute inset-0 bg-linear-to-r from-indigo-500/5 via-transparent to-purple-500/5" />
            
            <div className="relative px-4 sm:px-8 py-4 sm:py-6 border-b border-slate-700 shrink-0">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 sm:gap-4">
                  <div className="p-3 rounded-xl bg-indigo-500/10">
                    <FileText className="w-5 h-5 sm:w-6 sm:h-6 text-indigo-400 shrink-0" />
                  </div>
                  <div>
                    <h2 className="text-lg sm:text-xl font-bold text-foreground">Report Preview</h2>
                    <p className="text-xs sm:text-sm text-muted-foreground mt-1">
                      {selectedReportData 
                        ? `${selectedReportData.name} - ${selectedReportData.date}`
                        : `${reportTypes.find(r => r.id === selectedReport)?.name || 'Report'} - ${reportDate}`
                      }
                    </p>
                  </div>
                </div>
                <button 
                  onClick={() => {
                    setShowPreviewModal(false);
                    setSelectedReportData(null);
                    setViewedReport(null);
                  }}
                  className="p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 hover:border-slate-600 transition-all"
                >
                  <X className="w-5 h-5 text-slate-400" />
                </button>
              </div>
            </div>
            
            <div className="relative flex-1 overflow-auto p-4 sm:p-8">
              <div className="space-y-6">
                {previewLoading ? (
                  <div className="rounded-xl border border-border bg-card p-12 text-center text-foreground">
                    <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-3" />
                    Loading report data from S3...
                  </div>
                ) : previewError ? (
                  <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-red-200">
                    {previewError}
                  </div>
                ) : isStructuredPreview && previewData ? (
                  <>
                    <div className="rounded-xl border border-border bg-card p-4 sm:p-6">
                      <h3 className="text-xl sm:text-2xl font-bold text-foreground mb-4">
                        {currentPreviewTypeId === 'schedule' ? 'Schedule Summary Report' : currentPreviewTypeId === 'deviation' ? 'Deviation Analysis Report' : 'DSM Financial Impact Report'}
                      </h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-sm">
                        <div className="rounded-lg border border-border bg-background p-3"><p className="text-muted-foreground">Plant Name</p><p className="text-foreground font-semibold">{previewData.header.plantName}</p></div>
                        <div className="rounded-lg border border-border bg-background p-3"><p className="text-muted-foreground">Plant Capacity</p><p className="text-foreground font-semibold">{Number.isInteger(toNumber(previewData.header.plantCapacityMw, 0)) ? String(toNumber(previewData.header.plantCapacityMw, 0)) : formatNumber(previewData.header.plantCapacityMw, 1)} MW</p></div>
                        <div className="rounded-lg border border-border bg-background p-3"><p className="text-muted-foreground">Date</p><p className="text-foreground font-semibold">{formatDateLabel(previewData.header.date)}</p></div>
                        <div className="rounded-lg border border-border bg-background p-3"><p className="text-muted-foreground">Final Revision Used</p><p className="text-foreground font-semibold">{getFinalRevisionLabel(previewData.schedule.kpis.numberOfRevisions, previewData.header.finalRevisionUsed, previewData.header?.finalRevisionFileName)}</p></div>
                        <div className="rounded-lg border border-border bg-background p-3"><p className="text-muted-foreground">Data Source</p><p className="text-foreground font-semibold">{previewData.header.dataSource}</p></div>
                      </div>
                    </div>
                    {!previewData.hasAnyBackendRows && (
                      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-amber-200 text-sm">
                        No schedule/meter rows were found in S3 for the selected plant/date. Report is generated with available metadata only.
                      </div>
                    )}

                    {previewInsights && (
                      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                        <div className="rounded-xl border border-border bg-card p-5">
                          <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Executive Summary</p>
                          <div className="mt-4 space-y-3">
                            {previewInsights.summary.map((item) => (
                              <div key={item.label} className="flex items-center justify-between gap-4">
                                <span className="text-xs text-muted-foreground">{item.label}</span>
                                <span className="text-sm font-semibold text-foreground">{item.value}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                        <div className="rounded-xl border border-border bg-card p-5">
                          <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Key Highlights</p>
                          <div className="mt-4 space-y-3">
                            {previewInsights.highlights.map((item, index) => (
                              <div key={`${item}-${index}`} className="flex items-start gap-3 text-sm text-foreground">
                                <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-indigo-400" />
                                <span>{item}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                        <div className="rounded-xl border border-border bg-card p-5">
                          <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Status & Coverage</p>
                          <div className="mt-4 space-y-4 text-sm">
                            <div>
                              <p className="text-xs text-muted-foreground">{previewInsights.statusLabel}</p>
                              <span className={`mt-2 inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${toneClasses[previewInsights.statusTone] || toneClasses.slate}`}>
                                {previewInsights.statusValue}
                              </span>
                            </div>
                            <div>
                              <p className="text-xs text-muted-foreground">{previewInsights.coverageLabel}</p>
                              <span className={`mt-2 inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${toneClasses[previewInsights.coverageTone] || toneClasses.slate}`}>
                                {previewInsights.coverageValue}
                              </span>
                            </div>
                            <div className="rounded-lg border border-border bg-background p-3 text-xs text-muted-foreground">
                              Generated from the latest available S3 schedule and meter datasets.
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {currentPreviewTypeId === 'schedule' && (
                      <>
                        <div className="flex items-center justify-between">
                          <div>
                            <h4 className="text-lg font-semibold text-foreground">Schedule KPIs</h4>
                            <p className="text-xs text-muted-foreground">Revision-level summary and energy integrity checks.</p>
                          </div>
                          <span className="rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 py-1 text-xs font-semibold text-indigo-300">Intraday</span>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                          {[
                            ['Total Schedule (sum algo MW)', previewData.schedule.kpis.totalScheduledMwSum.toFixed(3)],
                            ['Average Scheduled Power (MW)', previewData.schedule.kpis.avgScheduledPowerMw.toFixed(3)],
                            ['Maximum Scheduled MW', previewData.schedule.kpis.maxScheduledMw.toFixed(3)],
                            ['Minimum Scheduled MW', previewData.schedule.kpis.minScheduledMw.toFixed(3)],
                            ['Revisions in S3 Files', getRevisionCountLabel(previewData.schedule.kpis.numberOfRevisions)],
                            ['Final Revision Used for Submission', getFinalRevisionLabel(previewData.schedule.kpis.numberOfRevisions, previewData.schedule.kpis.finalRevisionUsed, previewData.header?.finalRevisionFileName)],
                          ].map(([label, value]) => (
                            <div key={label} className="rounded-xl border border-border bg-card p-4"><p className="text-xs text-muted-foreground uppercase tracking-wider">{label}</p><p className="text-2xl font-bold text-foreground mt-2">{value}</p></div>
                          ))}
                        </div>
                        <div className="max-h-[360px] overflow-auto rounded-lg border border-border">
                          <table className="w-full text-sm">
                            <thead className="sticky top-0 bg-muted"><tr>{['Block No', 'Time', 'Scheduled MW'].map((h) => <th key={h} className="px-3 py-2 text-left text-xs text-white dark:text-white uppercase tracking-wide">{h}</th>)}</tr></thead>
                            <tbody className="divide-y divide-border">{previewData.schedule.rows.map((r) => <tr key={r.block}><td className="px-3 py-2 text-foreground">{r.block}</td><td className="px-3 py-2 text-foreground">{r.time}</td><td className="px-3 py-2 text-foreground">{toNumber(r.scheduledMw, 0).toFixed(3)}</td></tr>)}</tbody>
                          </table>
                        </div>
                      </>
                    )}

                    {currentPreviewTypeId === 'deviation' && (
                      <>
                        <div className="flex items-center justify-between">
                          <div>
                            <h4 className="text-lg font-semibold text-foreground">Deviation KPIs</h4>
                            <p className="text-xs text-muted-foreground">Deviation band performance across all 96 blocks.</p>
                          </div>
                          <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-300">DSM Compliance</span>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                          {[
                            ['Total Schedule (sum algo MW)', previewData.deviation.kpis.totalScheduledMwSum.toFixed(3)],
                            ['Total Actual Generation (sum meter MW)', previewData.deviation.kpis.totalActualMwSum.toFixed(3)],
                            ['Net Deviation (MWh)', previewData.deviation.kpis.netDeviationMWh.toFixed(3)],
                            ['Average Deviation (MW)', previewData.deviation.kpis.avgDeviationMw.toFixed(3)],
                            ['Max Positive Deviation (MW)', previewData.deviation.kpis.maxPositiveDeviationMw.toFixed(3)],
                            ['Max Negative Deviation (MW)', previewData.deviation.kpis.maxNegativeDeviationMw.toFixed(3)],
                          ].map(([label, value]) => (
                            <div key={label} className="rounded-xl border border-border bg-card p-4"><p className="text-xs text-muted-foreground uppercase tracking-wider">{label}</p><p className="text-2xl font-bold text-foreground mt-2">{value}</p></div>
                          ))}
                        </div>
                        <div className="max-h-[360px] overflow-auto rounded-lg border border-border">
                          <table className="w-full text-sm">
                            <thead className="sticky top-0 bg-muted"><tr>{['Block No', 'Time', 'Scheduled MW', 'Actual MW', 'Deviation MW', '% Deviation', 'Penalty (Rs)'].map((h) => <th key={h} className="px-3 py-2 text-left text-xs text-white dark:text-white uppercase tracking-wide">{h}</th>)}</tr></thead>
                            <tbody className="divide-y divide-border">{previewData.deviation.rows.map((r) => <tr key={r.block}><td className="px-3 py-2 text-foreground">{r.block}</td><td className="px-3 py-2 text-foreground">{r.time}</td><td className="px-3 py-2 text-foreground">{toNumber(r.scheduledMw, 0).toFixed(3)}</td><td className="px-3 py-2 text-foreground">{toNumber(r.actualMw, 0).toFixed(3)}</td><td className="px-3 py-2 text-foreground">{toNumber(r.deviationMw, 0).toFixed(3)}</td><td className="px-3 py-2 text-foreground">{toNumber(r.deviationPct, 0).toFixed(2)}%</td><td className="px-3 py-2 text-foreground">{toNumber(r.penaltyRs, 0).toFixed(2)}</td></tr>)}</tbody>
                          </table>
                        </div>
                      </>
                    )}

                    {currentPreviewTypeId === 'financial-impact' && (
                      <>
                        <div className="flex items-center justify-between">
                          <div>
                            <h4 className="text-lg font-semibold text-foreground">Settlement KPIs</h4>
                            <p className="text-xs text-muted-foreground">Financial exposure and DSM charge distribution.</p>
                          </div>
                          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-300">Finance Summary</span>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                          {[
                            ['Total DSM Charges (Rs)', previewData.dsm.kpis.totalDsmCharges.toFixed(2)],
                            ['Positive Deviation Settlement (Rs)', previewData.dsm.kpis.positiveSettlement.toFixed(2)],
                            ['Net DSM Payable / Receivable (Rs)', previewData.dsm.kpis.netPayableReceivable.toFixed(2)],
                            ['Average DSM Rate (Rs/kWh)', previewData.dsm.kpis.averageDsmRate.toFixed(3)],
                            ['Worst Block Penalty (Rs)', previewData.dsm.kpis.worstBlockPenalty.toFixed(2)],
                          ].map(([label, value]) => (
                            <div key={label} className="rounded-xl border border-border bg-card p-4"><p className="text-xs text-muted-foreground uppercase tracking-wider">{label}</p><p className="text-2xl font-bold text-foreground mt-2">{value}</p></div>
                          ))}
                        </div>
                        <div className="max-h-[360px] overflow-auto rounded-lg border border-border">
                          <table className="w-full text-sm">
                            <thead className="sticky top-0 bg-muted"><tr>{['Block No', 'Deviation MW', 'DSM Rate (Rs/kWh)', 'Charge (Rs)'].map((h) => <th key={h} className="px-3 py-2 text-left text-xs text-white dark:text-white uppercase tracking-wide">{h}</th>)}</tr></thead>
                            <tbody className="divide-y divide-border">{previewData.dsm.rows.map((r) => <tr key={r.block}><td className="px-3 py-2 text-foreground">{r.block}</td><td className="px-3 py-2 text-foreground">{r.deviationMw.toFixed(3)}</td><td className="px-3 py-2 text-foreground">{r.dsmRate.toFixed(3)}</td><td className="px-3 py-2 text-foreground">{r.charge.toFixed(2)}</td></tr>)}</tbody>
                          </table>
                        </div>
                      </>
                    )}

                  </>
                ) : selectedReportData && (selectedReportData.filePath || selectedReportData.url || selectedReportData.localUrl) ? (
                  // Actual PDF Preview for non-schedule report types
                  <div className="relative overflow-hidden rounded-xl bg-slate-800 border border-slate-700 h-[60vh]">
                    <iframe
                      src={(() => {
                        const fileUrl = selectedReportData.localUrl || selectedReportData.filePath || selectedReportData.url;
                        return resolveReportFileUrl(fileUrl) || '';
                      })()}
                      className="w-full h-full border-0"
                      title="Report PDF Preview"
                    />
                  </div>
                ) : selectedReportData ? (
                  // No file available - show preview not available message
                  <div className="relative overflow-hidden rounded-xl bg-linear-to-br from-slate-900 via-slate-800 to-slate-900 border border-slate-700 p-12">
                    <div className="absolute inset-0 bg-linear-to-r from-indigo-500/5 via-transparent to-purple-500/5" />
                    <div className="relative flex flex-col items-center justify-center text-center">
                      <div className="p-4 rounded-full bg-slate-800/50 mb-4">
                        <FileText className="w-12 h-12 text-slate-500" />
                      </div>
                      <h3 className="text-xl font-bold text-white mb-2">Preview Not Available</h3>
                      <p className="text-slate-400 max-w-md">
                        The PDF file for this report is not available. This may happen if the report is still generating or if the file has been deleted.
                      </p>
                    </div>
                  </div>
                ) : (
                  // New report preview - show template/summary
                  <>
                    {/* Report Header */}
                    <div className="border-b border-slate-700 pb-6">
                      <h3 className="text-2xl font-bold text-white mb-3">
                        {reportTypes.find(r => r.id === selectedReport)?.name || 'Report'}
                      </h3>
                      <div className="flex flex-wrap gap-6 text-sm text-slate-400">
                        <div className="flex items-center gap-2">
                          <Calendar className="w-4 h-4 text-indigo-400" />
                          <span>Date: <span className="text-white font-medium">{reportDate}</span></span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Clock className="w-4 h-4 text-indigo-400" />
                          <span>Generated: <span className="text-white font-medium">{new Date().toLocaleDateString()}</span></span>
                        </div>
                        <div className="flex items-center gap-2">
                          <FileText className="w-4 h-4 text-indigo-400" />
                          <span>Format: <span className="text-white font-medium">PDF</span></span>
                        </div>
                      </div>
                    </div>

                    <div className="relative overflow-hidden rounded-xl bg-slate-900/70 border border-slate-700/50 p-10 text-center">
                      <p className="text-sm text-slate-400">
                        Preview data is not available. Use Preview Report after selecting report type/date/plant.
                      </p>
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="relative px-8 py-6 border-t border-slate-700 bg-slate-900/50 flex gap-4 shrink-0">
              <button 
                onClick={() => setShowPreviewModal(false)}
                className="flex-1 px-6 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 hover:border-slate-600 transition-all font-semibold text-white flex items-center justify-center"
              >
                Close
              </button>
              {/* Only show Generate PDF button for new report preview (not when viewing existing reports) */}
              {!viewedReport && (
                <button 
                  onClick={() => {
                    setShowPreviewModal(false);
                    setTimeout(() => {
                      handleGenerateReport();
                    }, 100);
                  }}
                  className="flex-1 px-6 py-3 rounded-xl bg-linear-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white shadow-lg shadow-indigo-500/25 hover:shadow-indigo-500/40 transition-all font-semibold flex items-center justify-center gap-2"
                >
                  <Download className="w-5 h-5" />
                  Generate PDF
                </button>
              )}
              {/* Show Download button when viewing existing report with file */}
              {viewedReport && (viewedReport.filePath || viewedReport.url) && (
                <button 
                  onClick={() => {
                    handleDownloadReport(viewedReport);
                  }}
                  className="flex-1 px-6 py-3 rounded-xl bg-linear-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white shadow-lg shadow-indigo-500/25 hover:shadow-indigo-500/40 transition-all font-semibold flex items-center justify-center gap-2"
                >
                  <Download className="w-5 h-5" />
                  Download PDF
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Reports;






