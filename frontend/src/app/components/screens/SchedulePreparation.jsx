import { useState, useMemo, useEffect } from 'react';
import { useRef } from 'react';
import { useCallback } from 'react';
import createPlotlyComponent from 'react-plotly.js/factory';
import Plotly from 'plotly.js-dist-min';
import {
  Download,
  CheckCircle,
  AlertTriangle,
  Edit3,
  Calendar,
  TrendingUp,
  Clock,
  FileText,
  RefreshCw,
  Upload,
  AlertCircle,
  Layers,
  BarChart2,
  ExternalLink,
  X,
  Loader2,
} from 'lucide-react';
import { api, scheduleReadinessApi, schedulesApi } from '@/services/api';
import { useApi } from '@/hooks/useApi';
import { LoadingSpinner } from '@/app/components/common/LoadingSpinner';
import { buildCsvText, downloadCsvText, downloadXlsxFromRows } from '@/app/components/common/downloadUtils';
import { useAuth, useTheme, useWorkflowGuide } from '@/app/appContexts';
import { toast } from 'sonner';
import { S3_BASE_URL } from '@/config/appConfig';
import { fetchTextFromS3Optional } from '@/services/s3Utils';
import { DSM_PENALTY_CONFIG_BY_STATE, DEFAULT_DSM_PENALTY_CONFIG } from '@/config/dsmPenaltyConfig';
import { parseBlockFromTimestamp } from '@/utils/meterTime';
import { filterPlantsForUser, getDisabledPlantPattern } from '@/utils/plantAccess';

const Plot = createPlotlyComponent(Plotly);

// =============================================================================
// S3 CONFIG
// =============================================================================
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
const VEDANJAY_OUTPUTS_BASE_PREFIXES = {
  BHUPALPALLY: 'generated/vedanjay/BHUPALPALLY/outputs/',
  CME: 'generated/vedanjay/CME/outputs/',
  GSNP: 'generated/vedanjay/GSNP/outputs/',
  KASIPET: 'generated/vedanjay/KASIPET/outputs/',
  KILAJ: 'generated/vedanjay/KILAJ/outputs/',
  KOTHAGUDEM: 'generated/vedanjay/KOTHAGUDEM/outputs/',
  OSEPL: 'generated/vedanjay/OSEPL/outputs/',
  SIRMOUR: 'generated/vedanjay/SIRMOUR/outputs/',
};
const GENERATED_OUTPUTS_BASE_PREFIXES = VEDANJAY_OUTPUTS_BASE_PREFIXES;
const LEGACY_OUTPUTS_BASE_PREFIX = 'outputs/';
const GSNP_INTRADAY_PREFIX = 'gsnp_dc_reg_';
const S3_PLANTS = [
  {
    id: 1,
    code: 'BHUPALPALLY',
    name: 'BHUPALPALLY',
    state: 'Telangana',
    type: 'Solar',
    capacityMw: 0,
  },
  {
    id: 2,
    code: 'CME',
    name: 'CME',
    state: 'Maharashtra',
    type: 'Solar',
    capacityMw: 0,
  },
  {
    id: 3,
    code: 'GSNP',
    name: 'Globus Steel N Power (GSNP)',
    state: 'Madhya Pradesh',
    type: 'Solar',
    capacityMw: 20,
    intradayPrefix: GSNP_INTRADAY_PREFIX,
  },
  {
    id: 4,
    code: 'KASIPET',
    name: 'KASIPET',
    state: 'Telangana',
    type: 'Solar',
    capacityMw: 0,
  },
  {
    id: 5,
    code: 'KOTHAGUDEM',
    name: 'KOTHAGUDEM',
    state: 'Telangana',
    type: 'Solar',
    capacityMw: 0,
  },
  {
    id: 6,
    code: 'KILAJ',
    name: 'KILAJ',
    state: 'Maharashtra',
    type: 'Solar',
    capacityMw: 20,
  },
  {
    id: 7,
    code: 'OSEPL',
    name: 'OSEL',
    state: 'Maharashtra',
    type: 'Solar',
    capacityMw: 20,
  },
  {
    id: 8,
    code: 'SIRMOUR',
    name: 'SIRMOUR',
    state: 'Madhya Pradesh',
    type: 'Solar',
    capacityMw: 5.1,
    intradayPrefix: 'vedanjay_sirmour_pv_intra',
  },
];
const DSM_DEFAULT_ALLOWED_LIMIT_PERCENT = 10;

function getAllowedBandPercent(plantState, plantType) {
  const config = DSM_PENALTY_CONFIG_BY_STATE[plantState] || DEFAULT_DSM_PENALTY_CONFIG;
  const typeConfig = config.byType?.[plantType] || config.byType?.Solar;
  return typeConfig?.baseBand ?? DSM_DEFAULT_ALLOWED_LIMIT_PERCENT;
}

function normalizePlantKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeStateLabel(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const key = raw.toUpperCase().replace(/\./g, '').replace(/\s+/g, '');
  // Treat placeholder values as unknown so we can fall back to local config.
  if (key === 'ALLSTATES' || key === 'ALL' || key === 'NA' || key === 'N/A') return '';
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
}

function normalizePlantCode(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!code) return '';
  // Backend / user inputs sometimes send OSEL; S3 and internal prefixes use OSEPL.
  if (code === 'OSEL') return 'OSEPL';
  return code;
}

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
  return code !== 'CME';
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
  const upperFolder = folder.toUpperCase().replace(/\s+/g, '');
  return { folder, lower: lowerFolder, upper: upperFolder };
}

function getPlantRawPrefixes(plant) {
  const prefixes = [];
  const code = plant?.code || derivePlantCodeFromName(plant?.name);
  if (code && RAW_BASE_PREFIXES[code]) prefixes.push(RAW_BASE_PREFIXES[code]);
  if (code && LEGACY_RAW_BASE_PREFIXES[code]) prefixes.push(LEGACY_RAW_BASE_PREFIXES[code]);
  const derived = derivePlantFolders(plant || { code });
  if (derived) {
    prefixes.push(`raw/vedanjay/${derived.upper}/`);
    prefixes.push(`raw/${derived.folder}/${derived.lower}/`);
  }
  return Array.from(new Set(prefixes));
}

function getPlantGeneratedPrefixes(plant) {
  const prefixes = [];
  const code = plant?.code || derivePlantCodeFromName(plant?.name);
  if (code && GENERATED_OUTPUTS_BASE_PREFIXES[code]) prefixes.push(GENERATED_OUTPUTS_BASE_PREFIXES[code]);
  if (code && LEGACY_GENERATED_OUTPUTS_BASE_PREFIXES[code]) prefixes.push(LEGACY_GENERATED_OUTPUTS_BASE_PREFIXES[code]);
  const derived = derivePlantFolders(plant || { code });
  if (derived) {
    prefixes.push(`generated/vedanjay/${derived.upper}/outputs/`);
    prefixes.push(`generated/${derived.folder}/${derived.lower}/outputs/`);
  }
  return Array.from(new Set(prefixes));
}

// =============================================================================
// S3 HELPERS
// =============================================================================
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

function getSchedulePrefixes(date, plant) {
  const rawPrefixes = getPlantRawPrefixes(plant);
  const generatedPrefixes = getPlantGeneratedPrefixes(plant);
  return [
    ...rawPrefixes.map((prefix) => `${prefix}${date}/`),
    ...generatedPrefixes.map((prefix) => `${prefix}${date}/`),
    `${LEGACY_OUTPUTS_BASE_PREFIX}${date}/`,
  ];
}

function getFrozenSchedulePrefixes(date, plant) {
  const generatedPrefixes = getPlantGeneratedPrefixes(plant);
  const code = String(plant?.code || derivePlantCodeFromName(plant?.name) || '').trim().toUpperCase();
  return [
    ...(code ? [`frozenschedules/vedanjay/${code}/${date}/`] : []),
    ...generatedPrefixes.map((prefix) => `${prefix}${date}/frozen/`),
    `${LEGACY_OUTPUTS_BASE_PREFIX}${date}/frozen/`,
  ];
}

function getIntradayPrefixes(date, plant) {
  const code = String(plant?.code || derivePlantCodeFromName(plant?.name) || '').trim().toUpperCase();
  const derived = derivePlantFolders(plant || { code });
  const rawPrefixes = [];
  if (code) rawPrefixes.push(`raw/vedanjay/${code}/`);
  if (derived?.upper) rawPrefixes.push(`raw/vedanjay/${derived.upper}/`);
  return Array.from(new Set(rawPrefixes)).map((prefix) => `${prefix}${date}/enercast_data/intraday/`);
}

function getDayAheadPrefixes(date, plant) {
  const code = String(plant?.code || derivePlantCodeFromName(plant?.name) || '').trim().toUpperCase();
  const derived = derivePlantFolders(plant || { code });
  const prefixes = [];
  if (code) prefixes.push(`generated/vedanjay/${code}/outputs/${date}/Day-ahead/`);
  if (derived?.upper) prefixes.push(`generated/vedanjay/${derived.upper}/outputs/${date}/Day-ahead/`);
  return Array.from(new Set(prefixes));
}

function getMeterPrefixes(date, plant) {
  const rawPrefixes = getPlantRawPrefixes(plant);
  const generatedPrefixes = getPlantGeneratedPrefixes(plant);
  return [
    ...rawPrefixes.map((prefix) => `${prefix}${date}/metered_data/`),
    ...generatedPrefixes.map((prefix) => `${prefix}${date}/meter/`),
    `${LEGACY_OUTPUTS_BASE_PREFIX}${date}/meter/`,
    `${date}/meter/`,
  ];
}

function getManualEditsPrefix(date, plant, scheduleType = '') {
  const code = String(plant?.code || derivePlantCodeFromName(plant?.name) || '').trim().toUpperCase();
  if (!code || !date) return '';
  const normalized = String(scheduleType || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  const inferFolder = () => {
    // Future-date edits are always treated as Day-ahead in this app.
    try {
      const todayIst = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      if (String(date) > String(todayIst)) return 'DA';
    } catch {
      // ignore
    }
    if (normalized === 'DAY_AHEAD' || normalized === 'DA') return 'DA';
    // Default to intraday (includes explicit INTRADAY when the date is not future).
    return 'INTRADAY';
  };
  const folder = inferFolder();
  return `manual-edits/vedanjay/${code}/${date}/${folder}/`;
}

function mergeUniqueObjects(objectSets) {
  return Array.from(new Map(objectSets.flat().map((o) => [o.key, o])).values());
}

function isScheduleCsvKey(key) {
  const k = String(key || '').toLowerCase();
  return (
    k.endsWith('.csv') &&
    !k.includes('/frozen/') &&
    !k.includes('/day-ahead/') &&
    !k.includes('/day_ahead/') &&
    !k.includes('/intraday/') &&
    k.includes('schedule_from_')
  );
}

function isFrozenScheduleCsvKey(key) {
  const k = String(key || '').toLowerCase();
  const inNewFrozenFolder = k.includes('/frozenschedules/') || k.startsWith('frozenschedules/');
  return (
    k.endsWith('.csv') &&
    (k.includes('/frozen/') || inNewFrozenFolder) &&
    !k.includes('/intraday/') &&
    (/schedule_free(?:z|ze)_from_\d+\.csv$/i.test(k) || /_frozen\.csv$/i.test(k) || /edited_frozen\.csv$/i.test(k) || /system_frozen\.csv$/i.test(k))
  );
}

function isScheduleFromCsvKey(key) {
  const k = String(key || '').toLowerCase();
  return k.endsWith('.csv') && /schedule_(?:free(?:z|ze)_)?from_\d+\.csv$/i.test(k);
}

function getPlantFrozenFileName(plant) {
  const code = String(plant?.code || derivePlantCodeFromName(plant?.name) || '').trim().toUpperCase();
  return code ? `${code}_frozen.csv` : '';
}

function getLatestObject(objects, matcher) {
  const extractTrailingNumber = (key) => {
    const fileName = (key || '').split('/').pop() || '';
    const match = fileName.match(/_(\d+)(?=\.[^.]+$)/);
    return match ? parseInt(match[1], 10) : null;
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

function getScheduleCandidatePriority(key = '') {
  const normalized = String(key).toLowerCase();
  if (normalized.includes('/raw/')) return 0;
  if (normalized.startsWith('outputs/')) return 1;
  if (normalized.includes('/generated/')) return 2;
  return 3;
}

function extractScheduleRevision(key = '') {
  const fileName = String(key || '').split('/').pop() || '';
  const match = fileName.match(/schedule_(?:free(?:z|ze)_)?from_(\d+)\.csv$/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function sortLatestFirst(items) {
  const extractTrailingNumber = (key) => {
    const fileName = (key || '').split('/').pop() || '';
    const match = fileName.match(/_(\d+)(?=\.[^.]+$)/);
    return match ? parseInt(match[1], 10) : null;
  };

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

function findLatestCsvByKeywords(objects, requiredKeywords = []) {
  const lowered = requiredKeywords.map((k) => String(k).toLowerCase());
  return getLatestObject(objects, (key) => {
    const k = key.toLowerCase();
    if (!k.endsWith('.csv')) return false;
    return lowered.every((kw) => k.includes(kw));
  });
}

function findLatestIntradayCsv(objects) {
  const intradayCsvs = objects.filter((o) => {
    const key = String(o.key || '').toLowerCase();
    return key.endsWith('.csv') && key.includes('/intraday/');
  });
  if (intradayCsvs.length) {
    return pickLatestIntradayForDate(intradayCsvs);
  }
  return findLatestCsvByKeywords(objects, ['intraday']) || findLatestCsvByKeywords(objects, ['forecast', 'intraday']);
}

function extractIntradaySortScore(key) {
  const fileName = String(key || '').split('/').pop() || '';
  const lower = fileName.toLowerCase();

  const datedSlot = lower.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})(?:\+\d{4})?\.csv$/);
  if (datedSlot) {
    const [, y, m, d, hh, mm] = datedSlot;
    return Number(`${y}${m}${d}${hh}${mm}`);
  }

  const slotOnly = lower.match(/(\d{2})-(\d{2})(?:\+\d{4})?\.csv$/);
  if (slotOnly) {
    const [, hh, mm] = slotOnly;
    return Number(`${hh}${mm}`);
  }

  return null;
}

function pickLatestIntradayForDate(objects, intradayPrefix = GSNP_INTRADAY_PREFIX) {
  const csvs = objects.filter((o) => o.key.toLowerCase().endsWith('.csv'));
  if (!csvs.length) return null;

  const prioritized = csvs.filter((o) => {
    const fileName = o.key.split('/').pop()?.toLowerCase() || '';
    return fileName.startsWith(String(intradayPrefix || '').toLowerCase());
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

function findLatestMeterCsv(objects) {
  return (
    getLatestObject(
      objects,
      (key) => key.toLowerCase().endsWith('.csv') && key.toLowerCase().includes('/meter/')
    ) ||
    findLatestCsvByKeywords(objects, ['meter']) ||
    findLatestCsvByKeywords(objects, ['generation'])
  );
}

// =============================================================================
// CSV PARSER N/A maps columns from schedule_from_XX.csv
// =============================================================================
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

function toUiNumericText(value, fallback = '0') {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const numericPattern = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;
  if (!numericPattern.test(raw)) return fallback;
  const num = Number(raw);
  if (!Number.isFinite(num)) return fallback;
  const truncated = Math.trunc(num * 100) / 100;
  const fixed = truncated.toFixed(2);
  return fixed.replace(/\.?0+$/, '');
}

function blockToTime(block, addMinutes = 0) {
  const idx = Math.max(0, parseInt(block, 10) - 1);
  const totalMinutes = (idx * 15) + addMinutes;
  const normalized = ((totalMinutes % (24 * 60)) + (24 * 60)) % (24 * 60);
  const h = Math.floor(normalized / 60);
  const m = normalized % 60;
  return `${String(h)}:${String(m).padStart(2, '0')}`;
}

function blockToInterval(block) {
  const idx = Math.max(0, parseInt(block, 10) - 1);
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

function getCurrentIstBlock(totalBlocks = 96) {
  const now = new Date();
  const istNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const totalMinutes = (istNow.getHours() * 60) + istNow.getMinutes();
  const block = Math.floor(totalMinutes / 15) + 1;
  return Math.min(Math.max(block, 1), totalBlocks);
}

/**
 * Parses the schedule_from_XX.csv produced by lambda_engine.py.
 * Expected columns: block, timestamp, algo_schedule_mw, condition_used,
 *                   BaseForecast, IntradayForecast_mw
 */
function parseScheduleCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line && line.trim().length > 0);
  if (!lines.length) return [];

  // Find real header row (supports files with meta lines before headers).
  const headerIdx = lines.findIndex((line) => {
    const l = String(line || '').toLowerCase();
    return l.includes('block') && (l.includes('schedule') || l.includes('forecast') || l.includes('timestamp'));
  });

  const csvTextFromHeader = headerIdx > 0 ? lines.slice(headerIdx).join('\n') : text;
  const { headers, rows } = parseCsv(csvTextFromHeader);
  if (!headers.length) return [];

  const normalized = headers.map((h) =>
    h.toLowerCase().replace(/["']/g, '').replace(/[\s_-]+/g, '')
  );
  const findCol = (matchers) =>
    normalized.findIndex((h) => matchers.some((m) => h.includes(m)));

  const blockCol = findCol(['block', 'blockno']);
  const algoCol = findCol([
    'algoschedulemw',
    'algoschedule',
    'systemschedule',
    'finalschedule',
    'schedule',
    'scheduledmw',
    'scheduled',
  ]);
  const baseCol = findCol(['baseforecastmw', 'baseforecast', 'base']);
  const intradayCol = findCol(['intradayforecastmw', 'intradayforecast', 'intraday']);
  const condCol = findCol(['conditionused', 'condition', 'triggerreason']);

  const toScheduleRows = (inputRows) =>
    inputRows
      .filter((cols) => cols.length > 1)
      .map((cols) => {
        const block = blockCol >= 0 ? cols[blockCol] : '';
        const algoValue = algoCol >= 0 ? cols[algoCol] : '';
        const baseValue = baseCol >= 0 ? cols[baseCol] : '';
        const intradayValue = intradayCol >= 0 ? cols[intradayCol] : '';
        const conditionValue = condCol >= 0 ? cols[condCol] : '';
        return {
          block: parseInt(block, 10) || 0,
          time: blockToTime(block),
          algo: toUiNumericText(algoValue),
          base: toUiNumericText(baseValue),
          intraday: toUiNumericText(intradayValue),
          condition: conditionValue || 'NONE',
        };
      })
      .filter((r) => r.block > 0);

  const parsed = toScheduleRows(rows);
  if (parsed.length) return parsed;

  // Fallback: handle GSNP intraday-style files by mapping forecast into schedule fields.
  const intradayRows = parseForecastIntradayCsv(csvTextFromHeader);
  return intradayRows.map((r) => ({
    block: r.block,
    time: blockToTime(r.block),
    algo: toUiNumericText(r.forecastText),
    base: '0',
    intraday: toUiNumericText(r.forecastText),
    condition: 'AUTO_FALLBACK',
  }));
}

function parseDayAheadCsv(text) {
  const parsed = parseScheduleCsv(text);
  if (Array.isArray(parsed) && parsed.length) return parsed;

  const fallbackRows = parseForecastIntradayCsv(text);
  return (fallbackRows || []).map((r) => ({
    block: r.block,
    time: blockToTime(r.block),
    algo: toUiNumericText(r.forecastText),
    base: '0',
    intraday: '0',
    condition: 'AUTO_FALLBACK',
  }));
}

function parseManualEditsCsvByBlock(text) {
  const { headers, rows } = parseCsv(String(text || ''));
  if (!headers.length) return new Map();
  const norm = headers.map((h) =>
    String(h || '').toLowerCase().replace(/["']/g, '').replace(/[^a-z0-9]+/g, '')
  );
  const blockIdx = norm.findIndex((h) => h === 'block' || h.startsWith('block'));
  const mwIdx = norm.findIndex((h) => h === 'mw' || h.endsWith('mw') || h.includes('schedule'));
  const map = new Map();
  (rows || []).forEach((cols) => {
    const bRaw = cols?.[blockIdx >= 0 ? blockIdx : 0];
    const mRaw = cols?.[mwIdx >= 0 ? mwIdx : 1];
    const block = Number.parseInt(String(bRaw || '').trim(), 10);
    if (!Number.isFinite(block) || block < 1 || block > 96) return;
    const num = Number.parseFloat(String(mRaw ?? '').replace(/,/g, '').trim());
    if (!Number.isFinite(num)) return;
    map.set(block, toUiNumericText(num));
  });
  return map;
}

function pickLatestEditedScheduleKey(objects) {
  const candidates = (Array.isArray(objects) ? objects : [])
    .filter((o) => o?.key)
    .filter((o) => String(o.key).toLowerCase().endsWith('/edited_schedule.csv'));
  if (!candidates.length) return null;
  return sortLatestFirst(candidates)[0] || null;
}

function parseForecastIntradayCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line && line.trim().length > 0);
  if (!lines.length) return [];

  const headerIdx = lines.findIndex((line) => /(block|blk)/i.test(line) && line.includes(','));
  const csvText = headerIdx > 0 ? lines.slice(headerIdx).join('\n') : text;
  const { headers, rows } = parseCsv(csvText);

  const looksLikeSecondaryHeader = (cols = []) => {
    if (!Array.isArray(cols) || !cols.length) return false;
    const merged = cols.map((c) => String(c || '').toLowerCase().trim()).join(' ');
    const keywordHit = /(forecast|intraday|availability|capacity|generation|meter|mw|power|time|block|rev)/i.test(merged);
    const numericLike = cols.filter((c) => {
      const v = String(c || '').trim();
      if (!v) return false;
      return /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(v);
    }).length;
    return keywordHit && numericLike <= Math.max(1, Math.floor(cols.length * 0.2));
  };

  const secondHeader = rows[0] || [];
  const useSecondHeader = looksLikeSecondaryHeader(secondHeader);
  const effectiveHeaders = useSecondHeader
    ? Array.from({ length: Math.max(headers.length, secondHeader.length) }, (_, i) =>
        `${String(headers[i] || '').trim()} ${String(secondHeader[i] || '').trim()}`.trim()
      )
    : headers;
  const effectiveRows = useSecondHeader ? rows.slice(1) : rows;

  const isTimeLikeValue = (raw) => {
    const value = String(raw || '').trim();
    if (!value) return false;
    return /^(\d{1,2}):(\d{2})(?::\d{2})?$/.test(value) || /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.test(value);
  };
  const toNumericCell = (raw) => {
    if (isTimeLikeValue(raw)) return Number.NaN;
    const parsed = Number.parseFloat(String(raw || '').replace(/,/g, '').trim());
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  };
  const normalizedEffective = effectiveHeaders.map((h) =>
    String(h || '')
      .toLowerCase()
      .replace(/["']/g, '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, '')
      .replace(/[^a-z0-9]+/g, '')
  );

  const scoreForecastColumn = (colIdx) => {
    if (colIdx < 0) return -Infinity;
    const header = normalizedEffective[colIdx] || '';
    const isMetaHeader =
      header.includes('fromtime') ||
      header.includes('totime') ||
      header.includes('time') ||
      header.includes('timestamp') ||
      header.includes('date') ||
      header.includes('rev') ||
      header.includes('revision') ||
      header.includes('block');
    if (isMetaHeader) return -Infinity;
    let numericCount = 0;
    let timeLikeCount = 0;
    let positiveCount = 0;
    const sample = effectiveRows.slice(0, 192);
    sample.forEach((cols) => {
      const raw = cols?.[colIdx];
      if (isTimeLikeValue(raw)) timeLikeCount += 1;
      const num = toNumericCell(raw);
      if (Number.isFinite(num)) {
        numericCount += 1;
        if (num > 0) positiveCount += 1;
      }
    });
    if (!numericCount) return -Infinity;

    const headerBonus =
      (header.includes('schmw') || (header.includes('sch') && header.includes('mw')) ? 7 : 0) +
      (header.includes('intradayforecast') ? 6 : 0) +
      (header.includes('forecast') ? 5 : 0) +
      ((header.includes('pv') && header.includes('mw')) ? 3 : 0) +
      (header.includes('mw') ? 2 : 0);

    return (numericCount * 2) + positiveCount + headerBonus - (timeLikeCount * 4);
  };

  const findColEff = (predicates) => normalizedEffective.findIndex((h) => predicates.some((p) => p(h)));
  const blockIdx = findColEff([
    (h) => h.includes('block') || h.includes('blk') || h === 'sno' || h.includes('srno') || h.includes('serialno'),
  ]);
  const timeIdx = findColEff([
    (h) => h.includes('time') || h.includes('timestamp') || h.includes('date') || h.includes('from'),
  ]);

  let forecastIdx = findColEff([
    (h) => h.includes('schmw') || (h.includes('sch') && h.includes('mw')),
    (h) => h.includes('intradayforecast'),
    (h) => h.includes('forecast'),
    (h) => h.includes('pv') && h.includes('mw'),
    (h) => h.includes('sirmour') || h.includes('gsnp'),
  ]);

  const candidateForecastColumns = [];
  if (forecastIdx !== -1) candidateForecastColumns.push(forecastIdx);
  normalizedEffective.forEach((h, i) => {
    if (i === blockIdx || i === timeIdx) return;
    if (h.includes('availability') || h.includes('capacity') || h.includes('revision') || h.includes('rev') || h.includes('avc')) return;
    if (h.includes('schmw') || (h.includes('sch') && h.includes('mw'))) {
      candidateForecastColumns.push(i);
      return;
    }
    if (h.includes('forecast') || h.includes('intraday') || h.includes('pv') || h.includes('mw') || h.includes('power') || h.includes('value')) {
      candidateForecastColumns.push(i);
    }
  });
  if (!candidateForecastColumns.length) {
    normalizedEffective.forEach((h, i) => {
      if (i === blockIdx || i === timeIdx) return;
      if (
        h.includes('availability') ||
        h.includes('capacity') ||
        h.includes('revision') ||
        h.includes('rev') ||
        h.includes('fromtime') ||
        h.includes('totime') ||
        h.includes('avc')
      ) return;
      candidateForecastColumns.push(i);
    });
  }
  const dedupCandidates = Array.from(new Set(candidateForecastColumns));
  forecastIdx = dedupCandidates
    .map((idx) => ({ idx, score: scoreForecastColumn(idx) }))
    .sort((a, b) => b.score - a.score)[0]?.idx ?? -1;
  if (forecastIdx === -1) return [];

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

  const blockFromTime = (raw) => {
    const textVal = String(raw || '').trim();
    if (!textVal) return null;
    const match = textVal.match(/(\d{1,2}):(\d{2})/);
    if (!match) return null;
    const hh = Number.parseInt(match[1], 10);
    const mm = Number.parseInt(match[2], 10);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    const block = (hh * 4) + Math.floor(mm / 15) + 1;
    return block >= 1 && block <= 96 ? block : null;
  };

  return effectiveRows
    .map((cols, idx) => {
      const rawBlock = blockIdx >= 0 ? cols[blockIdx] : '';
      const timeRaw = timeIdx >= 0 ? cols[timeIdx] : '';
      const block = blockIdx >= 0
        ? parseBlock(rawBlock, idx)
        : (blockFromTime(timeRaw) ?? (idx + 1));
      const forecast = toNumericCell(cols[forecastIdx]);
      const forecastText = String(cols[forecastIdx] ?? '').trim();
      return { block, forecast, forecastText };
    })
    .filter(
      (r) =>
        Number.isFinite(r.block) &&
        r.block >= 1 &&
        r.block <= 96 &&
        Number.isFinite(r.forecast) &&
        r.forecastText.length > 0
    );
}

function parseMeterCsvByBlock(text) {
  const { headers, rows } = parseCsv(text);
  const normalizedHeaders = headers.map((h) => h.trim().toLowerCase());
  const compactHeaders = headers.map((h) =>
    String(h || '')
      .toLowerCase()
      .replace(/["']/g, '')
      .replace(/[^a-z0-9]+/g, '')
  );
  const blockIdx = compactHeaders.findIndex((h) =>
    h === 'block' || h === 'blk' || h === 'blockno' || h === 'blocknumber'
  );
  const timeIdx = normalizedHeaders.findIndex((h) => h.includes('time'));
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
    powerIdx = normalizedHeaders.findIndex((h) =>
      h.includes('active power-avg mfm-out(meter power)') ||
      h.includes('meter power') ||
      h.includes('active power') ||
      h.includes('generation') ||
      h === 'mw' ||
      h.endsWith('(kw)') ||
      h.includes('kw')
    );
  }
  if (powerIdx === -1) return [];

  const getBlockFromTimeText = (raw) => parseBlockFromTimestamp(raw, { totalBlocks: 96 });

  const powerHeader = (normalizedHeaders[powerIdx] || '').trim();
  const explicitKw = powerHeader.includes('(kw)') || powerHeader.includes(' kw') || powerHeader === 'kw';
  const explicitMw =
    powerHeader.includes('(mw)') ||
    powerHeader.includes(' mw') ||
    powerHeader === 'mw' ||
    powerHeader.endsWith('mw');

  const parsed = rows
    .map((cols, idx) => {
      const blockFromCol = blockIdx !== -1 ? parseInt(cols[blockIdx], 10) : null;
      const timeRaw = timeIdx !== -1 ? cols[timeIdx] : null;
      const hasTimeColumn = timeIdx !== -1;
      const blockFromTime = hasTimeColumn ? getBlockFromTimeText(timeRaw) : null;
      let block = null;
      if (Number.isFinite(blockFromCol) && blockFromCol >= 1 && blockFromCol <= 96) {
        block = blockFromCol;
      } else if (Number.isFinite(blockFromTime)) {
        block = blockFromTime;
      } else if (!hasTimeColumn) {
        const fallbackBlock = idx + 1;
        if (fallbackBlock >= 1 && fallbackBlock <= 96) block = fallbackBlock;
      }
      const power = parseFloat(String(cols[powerIdx] ?? '').replace(/,/g, '').trim());
      if (!Number.isFinite(block) || block < 1 || block > 96 || !Number.isFinite(power)) return null;
      const mw = power; // unit normalization applied after parsing
      return { block, generationMw: mw };
    })
    .filter(Boolean);

  const nonZero = parsed.map((x) => x.generationMw).filter((v) => Number.isFinite(v) && v > 0);
  const avg = nonZero.length ? (nonZero.reduce((a, b) => a + b, 0) / nonZero.length) : 0;
  const assumeKw = explicitKw || (!explicitMw && avg > 200);
  const factor = assumeKw ? 1 / 1000 : 1;

  const deduped = new Map();
  parsed.forEach((row) => deduped.set(row.block, { ...row, generationMw: row.generationMw * factor }));
  return Array.from(deduped.values()).sort((a, b) => a.block - b.block);
}

function extractLastTimestamp(text) {
  const lines = String(text || '').split(/\r?\n/).filter((line) => line && line.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const firstCell = String(line.split(/[,;\t]/)[0] || '').trim();
    if (!firstCell) continue;
    if (/\d{1,2}:\d{2}/.test(firstCell)) return firstCell;
  }
  return null;
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================
export function SchedulePreparation({ onNavigate, context, filters }) {
  const { isDarkMode } = useTheme();
  const { user: currentUser } = useAuth();
  const workflowGuide = useWorkflowGuide();
  const isAdmin = String(currentUser?.role || '').toLowerCase() === 'admin';
  const toIstYmd = (value) =>
    new Date(value || Date.now()).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const todayIst = toIstYmd(new Date());
  const requestedByLabel = useMemo(() => {
    const name = String(currentUser?.name || '').trim();
    const empId = String(currentUser?.empId || currentUser?.emp_id || '').trim();
    const role = String(currentUser?.role || '').trim();
    const title = String(currentUser?.title || '').trim();
    const primary = name || empId || 'Unknown';
    const suffix = title || role ? ` (${[title, role].filter(Boolean).join(', ')})` : '';
    return `${primary}${suffix}`;
  }, [currentUser]);
  // â”€â”€ Modal states â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const [showExportModal,     setShowExportModal]     = useState(false);
  const [downloadFormat,    setDownloadFormat]    = useState('csv');
  const [isOverwritingLatest, setIsOverwritingLatest] = useState(false);
  const [showValidationModal, setShowValidationModal] = useState(false);
  const [showDeleteModal,     setShowDeleteModal]     = useState(false);
  const [showSubmitModal,     setShowSubmitModal]     = useState(false);
  const [isSubmittingChanges, setIsSubmittingChanges] = useState(false);

  // â”€â”€ Data states â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const [editingMode,       setEditingMode]       = useState(false);
  const [originalData,      setOriginalData]      = useState([]);
  const [editedData,        setEditedData]        = useState([]);
  const [selectedRows,      setSelectedRows]      = useState([]);
  const [lastSelectedRow,   setLastSelectedRow]   = useState(null);
  const [activeCell,        setActiveCell]        = useState(null);
  const [cellDrafts,        setCellDrafts]        = useState({});
  const [bulkValue,         setBulkValue]         = useState('');
  const [rangeStartBlock, setRangeStartBlock] = useState('');
  const [rangeEndBlock, setRangeEndBlock] = useState('');
  const [bulkColumn,        setBulkColumn]        = useState('algo');
  // Active column for manual editing + bulk apply.
  // - algo: Intraday schedule (editable)
  // - dayAhead: Day-ahead schedule (editable)
  const activeEditColumn = bulkColumn === 'dayAhead' ? 'dayAhead' : 'algo';
  const [currentScheduleId,   setCurrentScheduleId]   = useState(null);
  const [validationErrors,    setValidationErrors]    = useState([]);
  const [changes,             setChanges]             = useState([]);
  const [isDataLoaded,        setIsDataLoaded]        = useState(false);
  const [loadedScheduleInfo,  setLoadedScheduleInfo]  = useState(null);
  const [loadingData,         setLoadingData]         = useState(false);
  const [loadError,           setLoadError]           = useState(null);

  // â”€â”€ Graph states â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const [graphLoading,        setGraphLoading]        = useState(false);
  const [graphError,          setGraphError]          = useState(null);
  const [showGraphModal,      setShowGraphModal]      = useState(false);
  const [hoverMarker, setHoverMarker] = useState(null);
  const [hiddenTraceKeys, setHiddenTraceKeys] = useState([]);
  const lastHoverKeyRef = useRef('');
  const [intradayCurve,       setIntradayCurve]       = useState([]);
  const [meterCurve,          setMeterCurve]          = useState([]);
  const [meterDebugInfo,      setMeterDebugInfo]      = useState(null);
  const [latestManualEditedRows, setLatestManualEditedRows] = useState([]);
  const [latestManualSystemRows, setLatestManualSystemRows] = useState([]);
  const [hasSavedManualChanges, setHasSavedManualChanges] = useState(false);
  const [lastSavedManualRequest, setLastSavedManualRequest] = useState(null);
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

  const getChangesStorageKey = () => {
    const plant = String(loadedScheduleInfo?.plant || '').trim().toUpperCase();
    const date = String(loadedScheduleInfo?.date || selectedDate || '').trim();
    if (!plant || !date) return '';
    // Manual change log must remain stable across loading different schedule revisions for the same plant/date.
    // Keep a separate stream per editable column (Intraday vs Day-ahead) to avoid mixing edits.
    const columnKey = activeEditColumn === 'dayAhead' ? 'DA' : 'INTRADAY';
    return `vedanjay-schedule-changes|${plant}|${date}|${columnKey}`;
  };

  const setManualChangeCountLocal = (plantCode, scheduleDate, fileKey, count) => {
    const key = `vedanjay-manual-count|${String(plantCode || '').toUpperCase()}|${scheduleDate}|${fileKey}`;
    try {
      localStorage.setItem(key, String(count));
    } catch {
      // ignore storage errors
    }
  };

  const isSameSourceFile = (changeRow, targetKey) => {
    const target = String(targetKey || '').trim();
    if (!target) return false;
    const source = String(changeRow?.sourceFileKey || changeRow?.source_file_key || '').trim();
    if (!source) return false;
    return source === target;
  };

  const persistChanges = (nextChanges) => {
    const key = getChangesStorageKey();
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify(nextChanges || []));
    } catch {
      // Ignore storage errors
    }
  };

  const getPlantCodeForChanges = () => {
    if (selectedPlantConfig?.code) return String(selectedPlantConfig.code).trim().toUpperCase();
    const name = String(loadedScheduleInfo?.plant || '').trim().toUpperCase();
    if (name.includes('SIRMOUR') || name.includes('SHRIMOUR') || name.includes('SHROMOUR')) return 'SIRMOUR';
    if (name.includes('GSNP') || name.includes('GLOBUS')) return 'GSNP';
    if (name.includes('BHUPALPALLY')) return 'BHUPALPALLY';
    if (name.includes('KASIPET')) return 'KASIPET';
    if (name.includes('KILAJ')) return 'KILAJ';
    if (name.includes('KOTHAGUDEM')) return 'KOTHAGUDEM';
    if (name.includes('OSEPL')) return 'OSEPL';
    if (name.includes('CME')) return 'CME';
    return name;
  };

  // â”€â”€ Filter states â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const { data: apiPlantsData } = useApi(
    () => api.plants.getAll({ noMock: true }),
    { immediate: true, initialData: { plants: [], total: 0, stats: {} } }
  );
  const plantsData = useMemo(() => {
    const roleFilteredFallbackPlants = filterPlantsForUser(S3_PLANTS, currentUser);
    const apiPlants = apiPlantsData?.plants || [];
    if (!apiPlants.length) {
      return { plants: roleFilteredFallbackPlants, total: roleFilteredFallbackPlants.length, stats: {} };
    }
    const enriched = apiPlants.map((plant) => {
      const match = S3_PLANTS.find(
        (p) => normalizePlantKey(p.name) === normalizePlantKey(plant.name) || normalizePlantKey(p.code) === normalizePlantKey(plant.name)
      );
      const code = match?.code || derivePlantCodeFromName(plant.name);
      const capacityMw =
        Number.isFinite(Number(plant.capacityMw)) ? Number(plant.capacityMw)
          : Number.isFinite(Number(plant.capacity)) ? Number(plant.capacity)
            : Number.isFinite(Number(match?.capacityMw)) ? Number(match?.capacityMw)
              : 0;
      const type = plant.type || match?.type || 'Solar';
      const apiState = normalizeStateLabel(plant.state);
      const fallbackState = normalizeStateLabel(match?.state);
      const state = apiState || fallbackState || '';
      return { ...plant, code, capacityMw, type, state };
    });
    const mergedKeys = new Set(enriched.map((p) => normalizePlantKey(p.code || p.name)));
    const extras = roleFilteredFallbackPlants.filter((p) => !mergedKeys.has(normalizePlantKey(p.code || p.name)));
    return { plants: [...enriched, ...extras], total: enriched.length + extras.length, stats: apiPlantsData?.stats || {} };
  }, [apiPlantsData, currentUser]);

  const [selectedState, setSelectedState] = useState(filters?.state || S3_PLANTS[0].state);
  const [selectedPlant, setSelectedPlant] = useState(filters?.plant || S3_PLANTS[0].name);
  const [selectedDate,  setSelectedDate]  = useState(
    filters?.date || toIstYmd(new Date())
  );
  const effectiveScheduleDate = useMemo(
    () => String(loadedScheduleInfo?.date || selectedDate || '').trim(),
    [loadedScheduleInfo, selectedDate]
  );

  const fromDashboard = context?.fromDashboard;
  const fromReadiness = context?.fromReadiness;
  const fromReadinessHistory = Boolean(context?.fromReadinessHistory);
  const tomorrowDate = new Date();
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowIst = toIstYmd(tomorrowDate);
  const canEditScheduleDate =
    effectiveScheduleDate === todayIst ||
    (Boolean(fromReadiness && context?.isDayAhead) && effectiveScheduleDate === tomorrowIst);

  // When a Day-ahead manual edit exists in S3, re-apply it to the Day-ahead column
  // so reopening the Preparation screen shows the edited values (not just the log).
  // Intraday behavior is unchanged.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!effectiveScheduleDate) return;
        // Day-ahead edits are only expected for future date (tomorrow IST).
        if (!(String(effectiveScheduleDate) > String(todayIst))) return;

        const key = normalizePlantKey(selectedPlant);
        const selectedPlantObj = (plantsData?.plants || []).find(
          (plant) =>
            normalizePlantKey(plant.name) === key ||
            normalizePlantKey(plant.code) === key
        );
        const prefix = getManualEditsPrefix(effectiveScheduleDate, selectedPlantObj, 'DAY_AHEAD');
        if (!prefix) return;

        const objects = await listS3Objects(prefix);
        const latest = pickLatestEditedScheduleKey(objects);
        const latestKey = String(latest?.key || '').trim();
        if (!latestKey) return;

        const csvText = await fetchTextFromS3Optional(latestKey).catch(() => null);
        if (!csvText) return;

        const byBlock = parseManualEditsCsvByBlock(csvText);
        if (!byBlock.size) return;

        if (cancelled) return;

        // Apply overlay to both original + edited datasets so the table shows the saved edits.
        const applyOverlay = (rows) => (Array.isArray(rows) ? rows.map((row) => {
          const blk = Number(row?.block);
          if (!Number.isFinite(blk)) return row;
          const updated = byBlock.get(blk);
          if (updated == null) return row;
          return { ...row, dayAhead: String(updated), status: 'Edited' };
        }) : rows);

        setOriginalData((prev) => applyOverlay(prev));
        setEditedData((prev) => applyOverlay(prev));
        setHasSavedManualChanges(true);
        setLastSavedManualRequest({ key: latestKey, lastModified: latest?.lastModified || null, scheduleType: 'DAY_AHEAD' });
      } catch {
        // non-fatal
      }
    })();
    return () => { cancelled = true; };
  }, [effectiveScheduleDate, todayIst, selectedPlant, plantsData?.plants]);
  const selectedPlantCodeForReadiness = useMemo(() => {
    const key = normalizePlantKey(selectedPlant);
    const selectedPlantObj = (plantsData?.plants || []).find(
      (plant) =>
        normalizePlantKey(plant.name) === key ||
        normalizePlantKey(plant.code) === key
    );
    return String(
      selectedPlantObj?.code ||
      derivePlantCodeFromName(selectedPlantObj?.name || selectedPlant) ||
      ''
    ).trim().toUpperCase();
  }, [plantsData?.plants, selectedPlant]);
  const contextPlantCodeForReadiness = useMemo(
    () => normalizePlantCode(
      context?.plantCode ||
      derivePlantCodeFromName(context?.plantName || context?.plant) ||
      ''
    ),
    [context]
  );
  const selectedPlantNameForReadiness = useMemo(
    () => normalizePlantKey(selectedPlant),
    [selectedPlant]
  );
  const contextPlantNameForReadiness = useMemo(
    () => normalizePlantKey(context?.plantName || context?.plant || ''),
    [context]
  );
  const selectedDateForReadiness = useMemo(
    () => String(loadedScheduleInfo?.date || selectedDate || '').trim(),
    [loadedScheduleInfo?.date, selectedDate]
  );
  const contextDateForReadiness = useMemo(
    () => String(context?.scheduleDate || context?.date || '').trim(),
    [context]
  );
  const isReadinessContextForSelectedPlant = useMemo(() => {
    if (!fromReadiness) return false;
    if (fromReadinessHistory) return false;
    if (!contextDateForReadiness || !selectedDateForReadiness) return false;
    if (contextDateForReadiness !== selectedDateForReadiness) return false;
    if (contextPlantCodeForReadiness && selectedPlantCodeForReadiness) {
      return contextPlantCodeForReadiness === selectedPlantCodeForReadiness;
    }
    if (contextPlantNameForReadiness && selectedPlantNameForReadiness) {
      return contextPlantNameForReadiness === selectedPlantNameForReadiness;
    }
    return false;
  }, [
    fromReadiness,
    fromReadinessHistory,
    contextDateForReadiness,
    selectedDateForReadiness,
    contextPlantCodeForReadiness,
    selectedPlantCodeForReadiness,
    contextPlantNameForReadiness,
    selectedPlantNameForReadiness,
  ]);
  const canSubmitChanges = isReadinessContextForSelectedPlant;
  const hasReadinessUploadSource = useMemo(
    () => Boolean(String(context?.sourceFileKey || '').trim()),
    [context?.sourceFileKey]
  );
  const canSaveFromReadinessReadyFlow = canSubmitChanges && hasReadinessUploadSource;
  const selectedPlantConfig = useMemo(() => {
    const key = normalizePlantKey(selectedPlant);
    return (
      plantsData.plants.find(
        (plant) =>
          normalizePlantKey(plant.name) === key ||
          normalizePlantKey(plant.code) === key
      ) || null
    );
  }, [selectedPlant, plantsData]);
  const [hasReadyScheduleForSelection, setHasReadyScheduleForSelection] = useState(false);
  const [checkingReadySchedule, setCheckingReadySchedule] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const checkReadyAvailability = async () => {
      const selectedCode = String(
        selectedPlantConfig?.code ||
        selectedPlantCodeForReadiness ||
        derivePlantCodeFromName(selectedPlantConfig?.name || selectedPlant) ||
        ''
      ).trim().toUpperCase();
      const selectedPlantId = String(selectedPlantConfig?.id || '').trim();
      const selectedNameKey = normalizePlantKey(selectedPlantConfig?.name || selectedPlant);
      const selectedDateKey = String(loadedScheduleInfo?.date || selectedDate || '').trim();
      if (!selectedCode && !selectedNameKey && !selectedPlantId) {
        if (!cancelled) setHasReadyScheduleForSelection(false);
        return;
      }

      let hasReadyFromWorkflow = false;
      try {
        const raw = localStorage.getItem('vedanjay-readiness-workflow-v1');
        const parsed = raw ? JSON.parse(raw) : {};
        const entries = parsed && typeof parsed === 'object' ? Object.entries(parsed) : [];
        hasReadyFromWorkflow = entries.some(([fileKey, entry]) => {
          const status = String(entry?.status || '').trim().toUpperCase();
          if (status !== 'READY') return false;
          const entryCode = String(entry?.plant_code || entry?.plantCode || '').trim().toUpperCase();
          const entryDate = String(entry?.schedule_date || entry?.scheduleDate || '').trim();
          const keyText = String(fileKey || '').toUpperCase();
          const codeMatch = selectedCode
            ? (entryCode === selectedCode || keyText.includes(selectedCode))
            : false;
          const dateMatch = selectedDateKey
            ? (entryDate === selectedDateKey || keyText.includes(selectedDateKey.replace(/-/g, '')))
            : true;
          return codeMatch && dateMatch;
        });
      } catch {
        hasReadyFromWorkflow = false;
      }

      setCheckingReadySchedule(true);
      try {
        try {
          await scheduleReadinessApi.checkTriggers();
        } catch {
          // Best effort refresh; continue with existing readiness data if trigger refresh fails.
        }
        const response = await scheduleReadinessApi.getAll('READY');
        const rows = Array.isArray(response)
          ? response
          : Array.isArray(response?.data)
            ? response.data
            : Array.isArray(response?.items)
              ? response.items
            : Array.isArray(response?.readiness)
              ? response.readiness
              : [];
        const hasReady = rows.some((row) => {
          const rowStatus = String(row?.status || '').trim().toUpperCase();
          if (rowStatus && rowStatus !== 'READY') return false;
          const rowCode = String(
            row?.plant_code ||
            row?.plantCode ||
            row?.code ||
            row?.short_name ||
            ''
          ).trim().toUpperCase();
          const rowName = normalizePlantKey(row?.plant_name || row?.plantName || row?.name || '');
          const rowPlantId = String(row?.plant_id || row?.plantId || row?.id || '').trim();
          const rowDate = String(
            row?.schedule_date ||
            row?.scheduleDate ||
            row?.date ||
            ''
          ).trim();
          const plantMatch =
            (selectedCode && rowCode && selectedCode === rowCode)
            || (selectedNameKey && rowName && selectedNameKey === rowName)
            || (selectedPlantId && rowPlantId && selectedPlantId === rowPlantId);
          if (!plantMatch) return false;
          if (!selectedDateKey || !rowDate) return true;
          return rowDate === selectedDateKey;
        });
        if (!cancelled) setHasReadyScheduleForSelection(Boolean(hasReady || hasReadyFromWorkflow));
      } catch {
        if (!cancelled) setHasReadyScheduleForSelection(Boolean(hasReadyFromWorkflow));
      } finally {
        if (!cancelled) setCheckingReadySchedule(false);
      }
    };
    checkReadyAvailability();
    return () => {
      cancelled = true;
    };
  }, [
    loadedScheduleInfo?.date,
    selectedDate,
    selectedPlant,
    selectedPlantCodeForReadiness,
    selectedPlantConfig?.code,
    selectedPlantConfig?.id,
    selectedPlantConfig?.name,
  ]);
  const canForceSaveChanges =
    !canSaveFromReadinessReadyFlow &&
    !checkingReadySchedule &&
    !hasReadyScheduleForSelection;
  const canSubmitFromForceSave = useMemo(() => {
    const currentScheduleDate = String(loadedScheduleInfo?.date || selectedDate || '').trim();
    const currentPlantCode = String(selectedPlantCodeForReadiness || '').trim().toUpperCase();
    if (!currentScheduleDate || !currentPlantCode) return false;
    if (!hasSavedManualChanges || !lastSavedManualRequest) return false;
    return (
      String(lastSavedManualRequest?.plantCode || '').trim().toUpperCase() === currentPlantCode
      && String(lastSavedManualRequest?.scheduleDate || '').trim() === currentScheduleDate
    );
  }, [hasSavedManualChanges, lastSavedManualRequest, loadedScheduleInfo?.date, selectedDate, selectedPlantCodeForReadiness]);
  const canSubmitNow = canSubmitChanges || canSubmitFromForceSave;
  const appliedNavigationContextRef = useRef('');
  const submitBlockedToastAtRef = useRef(0);
  const getSubmitBlockedMessage = () => {
    if (canSubmitNow) return '';

    // If user is not in READY flow, require Force Save first (when available).
    if (!canSaveFromReadinessReadyFlow) {
      if (hasReadyScheduleForSelection) {
        return 'READY schedule exists for this plant/date. Please submit via Schedule Readiness Upload.';
      }
      if (canForceSaveChanges) {
        return hasEdits
          ? 'Please click Force Save first, then click Submit Changes.'
          : 'Make changes first, then click Force Save and Submit Changes.';
      }
    }

    return 'Please click on Upload button in Schedule Readiness to submit changes.';
  };
  const showSubmitBlockedToast = (mode = 'click') => {
    if (canSubmitNow) return;
    const now = Date.now();
    const cooldownMs = mode === 'hover' ? 3000 : 0;
    if (cooldownMs && now - submitBlockedToastAtRef.current < cooldownMs) return;
    submitBlockedToastAtRef.current = now;
    toast.info(getSubmitBlockedMessage());
  };
  // â”€â”€ Available plants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const availablePlants = useMemo(() => {
    if (selectedState === 'Select State') return ['Select Plant'];
    const plants = plantsData.plants.filter((plant) => plant.state === selectedState).map((plant) => plant.name);
    return ['Select Plant', ...plants];
  }, [selectedState, plantsData]);

  const availableStates = useMemo(() => {
    const states = plantsData.plants.map((plant) => plant.state).filter(Boolean);
    return ['Select State', ...Array.from(new Set(states))];
  }, [plantsData]);

  useEffect(() => {
    if (selectedPlant !== 'Select Plant' && !availablePlants.includes(selectedPlant)) {
      setSelectedPlant('Select Plant');
    }
  }, [availablePlants, selectedPlant]);

  const handleStateChange = (state) => {
    setSelectedState(state);
    setSelectedPlant('Select Plant');
  };

  const handlePlantChange = (plant) => {
    setSelectedPlant(plant);
    const plantConfig = plantsData.plants.find((p) => p.name === plant);
    if (plantConfig) {
      setSelectedState(plantConfig.state);
    }
  };

  // ==========================================================================
  // LOAD DATA FROM S3
  // ==========================================================================
  const handleLoadData = async (dateOverride, options = {}) => {
    const effectiveState = String(options?.state || selectedState || '').trim();
    const effectivePlant = String(options?.plant || selectedPlant || '').trim();

    if (effectiveState && effectiveState !== selectedState) setSelectedState(effectiveState);
    if (effectivePlant && effectivePlant !== selectedPlant) setSelectedPlant(effectivePlant);

    if (effectiveState === 'Select State' || effectivePlant === 'Select Plant' || !effectiveState || !effectivePlant) {
      toast.error('Please select both State and Plant to load data');
      return;
    }

    const effectivePlantConfig =
      plantsData.plants.find((p) => String(p?.name || '').trim() === effectivePlant) ||
      plantsData.plants.find((p) => String(p?.name || '').trim().toLowerCase() === effectivePlant.toLowerCase()) ||
      selectedPlantConfig ||
      null;

    if (effectivePlantConfig && effectiveState !== String(effectivePlantConfig.state || '').trim()) {
      toast.error(`Selected plant is in ${effectivePlantConfig.state}. Please select the correct state.`);
      return;
    }

    const chosenPlant = effectivePlantConfig || plantsData.plants[0] || S3_PLANTS[0];
    const targetDate = typeof dateOverride === 'string'
      ? dateOverride
      : dateOverride instanceof Date
        ? toIstYmd(dateOverride)
        : selectedDate;

    setLoadingData(true);
    setLoadError(null);
    setIsDataLoaded(false);
    setEditingMode(false);
    setOriginalData([]);
    setEditedData([]);
    setSelectedRows([]);
    setLastSelectedRow(null);
    setActiveCell(null);
    setCellDrafts({});
    setBulkValue('');
    setHasSavedManualChanges(false);
    setLastSavedManualRequest(null);
      setGraphError(null);
      setIntradayCurve([]);
      setMeterCurve([]);
      setMeterDebugInfo(null);
      setLatestManualEditedRows([]);
      setLatestManualSystemRows([]);

    try {
      let parsedIntradayForSelectedDate = [];
      let latestIntradayKeyForSelectedDate = '';
      let intradayForecastByBlock = null;
      let dayAheadScheduleByBlock = null;

      const explicitSourceKey = String(
        context?.sourceFileKey ||
        context?.sourceKey ||
        context?.file_key ||
        context?.fileKey ||
        ''
      ).trim();

      const schedulePlantCode = String(
        chosenPlant?.code ||
        derivePlantCodeFromName(chosenPlant?.name) ||
        effectivePlantConfig?.code ||
        derivePlantCodeFromName(effectivePlant) ||
        ''
      )
        .trim()
        .toUpperCase();

      const listResp = await schedulesApi.list({
        plant: schedulePlantCode,
        date: targetDate,
        type: 'intraday',
        limit: 20000,
      });

      // Load schedule CSV (generated/vedanjay/<PLANT>/outputs/<DATE>/schedule_from_*.csv)
      const scheduleCandidates = (Array.isArray(listResp?.items) ? listResp.items : [])
        .map((item) => ({
          key: String(item?.key || '').trim(),
          lastModified: String(item?.last_modified || item?.lastModified || '').trim(),
        }))
        .filter((o) => o.key && isScheduleCsvKey(o.key));
      const requestedByKey = explicitSourceKey
        ? scheduleCandidates.find((o) => String(o.key || '').trim() === explicitSourceKey)
        : null;
      const requestedByName = context?.fileName
        ? scheduleCandidates.find((o) => o.key.endsWith(`/${context.fileName}`) || o.key.endsWith(context.fileName))
        : null;
      const requestedFileRaw = requestedByKey || requestedByName || null;
      const sortByLatestBlockThenTime = (items) => [...items].sort((a, b) => {
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
      const sortedCandidates = sortByLatestBlockThenTime(scheduleCandidates);
      const requestedFile = requestedFileRaw && isScheduleCsvKey(requestedFileRaw.key)
        ? requestedFileRaw
        : null;
      const numericCandidates = sortedCandidates.filter((o) =>
        /schedule_(?:free(?:z|ze)_)?from_\d+\.csv$/i.test(String(o.key || ''))
      );
      const latestNumericCandidate = numericCandidates[0] || null;
      const explicitCandidate = explicitSourceKey && String(explicitSourceKey).toLowerCase().endsWith('.csv')
        ? { key: explicitSourceKey, lastModified: '' }
        : null;
      const baseCandidates = requestedFile
        ? [requestedFile, ...sortedCandidates.filter((o) => o.key !== requestedFile.key)]
        : sortedCandidates;
      const candidates = explicitCandidate
        ? [explicitCandidate, ...baseCandidates.filter((o) => String(o?.key || '') !== explicitSourceKey)]
        : baseCandidates;

      if (!candidates.length) {
        throw new Error(`No schedule CSV found for ${targetDate}`);
      }

      let latestSchedule = null;
      let csvText = '';
      let lastFetchStatus = null;
      for (const candidate of candidates) {
        const csvUrl = `${S3_BASE_URL}/${String(candidate.key || '').split('/').map((s) => encodeURIComponent(s)).join('/')}`;
        // Try multiple schedule candidates; skip inaccessible objects (e.g., 403) and continue.
        const response = await fetch(csvUrl);
        if (response.ok) {
          latestSchedule = candidate;
          csvText = await response.text();
          break;
        }
        lastFetchStatus = response.status;
      }

      let parsed = [];
      let loadedFromIntradayFallback = false;

      if (latestSchedule) {
        parsed = parseScheduleCsv(csvText);
        if (!parsed.length) {
          throw new Error('Schedule CSV parsed but returned no valid rows');
        }
      } else {
        // Fallback: if schedule CSV is inaccessible (often 403), build schedule from latest intraday CSV.
        const intradayObjectsFlat = await listS3ObjectsAcrossPrefixes(getIntradayPrefixes(targetDate, chosenPlant), currentUser);
        const intradayObjects = mergeUniqueObjects([intradayObjectsFlat]);
        const fallbackIntraday =
          pickLatestIntradayForDate(intradayObjects, chosenPlant.intradayPrefix) ||
          findLatestIntradayCsv(intradayObjects) ||
          findLatestIntradayCsv(objects);

        if (!fallbackIntraday) {
          throw new Error(`Failed to fetch schedule CSV from S3${lastFetchStatus ? `: ${lastFetchStatus}` : ''}`);
        }

        const intradayUrl = `${S3_BASE_URL}/${String(fallbackIntraday.key || '').split('/').map((s) => encodeURIComponent(s)).join('/')}`;
        const intradayText = await fetch(intradayUrl).then((r) => {
          if (!r.ok) throw new Error(`Failed to fetch schedule CSV from S3${lastFetchStatus ? `: ${lastFetchStatus}` : ''}`);
          return r.text();
        });
        const intradayRows = parseForecastIntradayCsv(intradayText);
        parsed = intradayRows.map((r) => ({
          block: r.block,
          time: blockToTime(r.block),
          algo: toUiNumericText(r.forecastText),
          base: toUiNumericText(r.forecastText),
          intraday: toUiNumericText(r.forecastText),
          condition: 'Normal',
        }));
        if (!parsed.length) {
          throw new Error(`Failed to fetch schedule CSV from S3${lastFetchStatus ? `: ${lastFetchStatus}` : ''}`);
        }
        latestSchedule = fallbackIntraday;
        loadedFromIntradayFallback = true;
      }

      // Ensure Intraday column always comes from intraday path for selected plant/date.
      try {
        const intradayObjectsFlat = await listS3ObjectsAcrossPrefixes(getIntradayPrefixes(targetDate, chosenPlant), currentUser);
        const intradayObjectsMerged = mergeUniqueObjects([intradayObjectsFlat]);
        const latestIntraday =
          pickLatestIntradayForDate(intradayObjectsMerged, chosenPlant.intradayPrefix) ||
          findLatestIntradayCsv(intradayObjectsMerged);

        if (latestIntraday) {
          const intradayUrl = `${S3_BASE_URL}/${String(latestIntraday.key || '').split('/').map((s) => encodeURIComponent(s)).join('/')}`;
          const intradayText = await fetch(intradayUrl).then((r) => {
            if (!r.ok) throw new Error(`Intraday fetch failed: ${r.status}`);
            return r.text();
          });
          parsedIntradayForSelectedDate = parseForecastIntradayCsv(intradayText);
          latestIntradayKeyForSelectedDate = String(latestIntraday.key || '');

          if (parsedIntradayForSelectedDate.length) {
            const intradayByBlock = new Map(
              parsedIntradayForSelectedDate.map((row) => [row.block, toUiNumericText(row.forecastText)])
            );
            intradayForecastByBlock = intradayByBlock;
            parsed = parsed.map((row) => ({
              ...row,
              intraday: intradayByBlock.has(row.block)
                ? intradayByBlock.get(row.block)
                : (row.intraday || '0'),
            }));
          }
        }
      } catch {
        // Keep schedule load resilient even if intraday path fetch fails.
      }

      // Load latest Day-ahead schedule file (generated/.../Day-ahead/) and hydrate Day-ahead column by block.
      let latestDayAheadKeyForSelectedDate = '';
      let latestDayAheadNumericCandidate = null;
      try {
        const dayAheadObjectsFlat = await listS3ObjectsAcrossPrefixes(getDayAheadPrefixes(targetDate, chosenPlant), currentUser);
        const dayAheadObjects = mergeUniqueObjects([dayAheadObjectsFlat]);
        const dayAheadCandidates = sortLatestFirst(dayAheadObjects.filter((o) => isScheduleFromCsvKey(o.key)));
        latestDayAheadNumericCandidate = dayAheadCandidates[0] || null;

        let latestDayAhead = null;
        let dayAheadCsvText = '';
        for (const candidate of dayAheadCandidates) {
          const csvUrl = `${S3_BASE_URL}/${String(candidate.key || '').split('/').map((s) => encodeURIComponent(s)).join('/')}`;
          const response = await fetch(csvUrl);
          if (response.ok) {
            latestDayAhead = candidate;
            dayAheadCsvText = await response.text();
            break;
          }
        }

        if (latestDayAhead && dayAheadCsvText) {
          const parsedDayAhead = parseDayAheadCsv(dayAheadCsvText);
          if (parsedDayAhead.length) {
            const dayAheadByBlock = new Map(
              parsedDayAhead.map((row) => [row.block, row])
            );
            dayAheadScheduleByBlock = dayAheadByBlock;
            parsed = parsed.map((row) => {
              const match = dayAheadByBlock.get(row.block);
              if (!match) {
                return {
                  ...row,
                  dayAhead: row.dayAhead ?? '0',
                  dayAheadBase: row.dayAheadBase ?? row.base ?? '0',
                  dayAheadIntraday: row.dayAheadIntraday ?? row.intraday ?? '0',
                  dayAheadCondition: row.dayAheadCondition ?? 'NONE',
                };
              }
              return {
                ...row,
                dayAhead: toUiNumericText(match.algo, row.dayAhead ?? '0'),
                dayAheadBase: toUiNumericText(match.base, row.base ?? '0'),
                dayAheadIntraday: toUiNumericText(match.intraday, row.intraday ?? '0'),
                dayAheadCondition: String(match.condition || 'Normal'),
              };
            });
          }
          latestDayAheadKeyForSelectedDate = String(latestDayAhead.key || '');
        }
      } catch {
        // Keep schedule load resilient even if day-ahead fetch fails.
      } finally {
        // Ensure Day-ahead column exists even if no file found.
        parsed = parsed.map((row) => ({
          ...row,
          dayAhead: row.dayAhead ?? '0',
          dayAheadBase: row.dayAheadBase ?? row.base ?? '0',
          dayAheadIntraday: row.dayAheadIntraday ?? row.intraday ?? '0',
          dayAheadCondition: row.dayAheadCondition ?? 'NONE',
        }));
      }

      // Some revision CSVs can be partial (only include changed blocks).
      // Pad to 96 blocks using Day-ahead as the baseline when available, so the graph and table
      // always show a complete schedule curve.
      const rowsByBlock = new Map(parsed.map((row) => [Number(row.block), row]).filter(([b]) => Number.isFinite(b)));
      const padded = [];
      for (let block = 1; block <= 96; block += 1) {
        const existing = rowsByBlock.get(block);
        if (existing) {
          padded.push(existing);
          continue;
        }
        const da = dayAheadScheduleByBlock?.get?.(block);
        const daAlgo = da ? toUiNumericText(da.algo) : '0';
        const daBase = da ? toUiNumericText(da.base) : '0';
        const daIntra = da ? toUiNumericText(da.intraday) : '0';
        const intradayForecast = intradayForecastByBlock?.get?.(block) ?? '';
        padded.push({
          block,
          time: blockToTime(block),
          algo: daAlgo,
          base: daBase,
          intraday: intradayForecast ? toUiNumericText(intradayForecast) : daIntra,
          condition: 'PADDED_BASELINE',
          dayAhead: daAlgo,
          dayAheadBase: daBase,
          dayAheadIntraday: daIntra,
          dayAheadCondition: da ? String(da.condition || 'Normal') : 'NONE',
        });
      }
      parsed = padded;

      setOriginalData(parsed);
      setEditedData(parsed);
      setEditingMode(false);
      setSelectedRows([]);
      setLastSelectedRow(null);
      setActiveCell(null);
      setCellDrafts({});
      setBulkValue('');
      setIsDataLoaded(true);
      setCurrentScheduleId(null);
      setSelectedDate(targetDate);
      setLoadedScheduleInfo({
        state:    selectedState,
        plant:    chosenPlant.name,
        date:     targetDate,

        endingBlock: extractScheduleRevision(latestSchedule.key),
        endingBlockTime: (() => {
          const block = extractScheduleRevision(latestSchedule.key);
          return Number.isFinite(block) ? blockToTime(block, 8) : null;
        })(),
        fileName: latestSchedule.key.split('/').pop(),
        sourceKey: latestSchedule.key,
        intradaySourceKey: latestIntradayKeyForSelectedDate || null,
        dayAheadFileName: latestDayAheadKeyForSelectedDate ? latestDayAheadKeyForSelectedDate.split('/').pop() : null,
        dayAheadSourceKey: latestDayAheadKeyForSelectedDate || null,
        dayAheadLatestNumericKey: latestDayAheadNumericCandidate?.key || null,
        dayAheadEndingBlock: latestDayAheadKeyForSelectedDate ? extractScheduleRevision(latestDayAheadKeyForSelectedDate) : null,
        dayAheadEndingBlockTime: (() => {
          const block = latestDayAheadKeyForSelectedDate ? extractScheduleRevision(latestDayAheadKeyForSelectedDate) : null;
          return Number.isFinite(block) ? blockToTime(block, 8) : null;
        })(),
        latestNumericKey: latestNumericCandidate?.key || null,
        source:   loadedFromIntradayFallback
          ? 'S3 (intraday fallback)'
          : 'S3 (Schedule)',
      });

      // â”€â”€ 2. Load latest intraday + meter curves for Plotly â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      setGraphLoading(true);
      const curveWarnings = [];

      try {
        if (parsedIntradayForSelectedDate.length) {
          setIntradayCurve(parsedIntradayForSelectedDate);
        } else {
          // Fallback path if intraday wasn't available during row hydration.
          const intradayObjectsFlat = await listS3ObjectsAcrossPrefixes(getIntradayPrefixes(targetDate, chosenPlant), currentUser);
          const intradayObjectsMerged = mergeUniqueObjects([intradayObjectsFlat]);
          const latestIntraday =
            pickLatestIntradayForDate(intradayObjectsMerged, chosenPlant.intradayPrefix) ||
            findLatestIntradayCsv(intradayObjectsMerged) ||
            findLatestIntradayCsv(objects);
          if (latestIntraday) {
            const intradayUrl = `${S3_BASE_URL}/${String(latestIntraday.key || '').split('/').map((s) => encodeURIComponent(s)).join('/')}`;
            const intradayText = await fetch(intradayUrl).then((r) => {
              if (!r.ok) throw new Error(`Intraday fetch failed: ${r.status}`);
              return r.text();
            });
            const parsedIntraday = parseForecastIntradayCsv(intradayText);
            if (!parsedIntraday.length) {
              throw new Error('Forecast column not found in latest intraday CSV');
            }
            setIntradayCurve(parsedIntraday);
          }
        }
      } catch {
        // Ignore intraday curve load warning in UI
      }

      // Load latest manual request CSVs for graph comparison (edited + system).
      try {
        const manualPrefix = getManualEditsPrefix(targetDate, chosenPlant);
        if (manualPrefix) {
          let latestFolderKey = '';
          const latestJsonKey = `${manualPrefix}latest.json`;
          const latestJsonText = await fetchTextFromS3Optional(latestJsonKey).catch(() => null);
          if (latestJsonText) {
            let payload = {};
            try {
              payload = JSON.parse(latestJsonText);
            } catch {
              payload = {};
            }
            const candidate = String(
              payload?.latest_request_id ||
                payload?.latest_request_folder ||
                payload?.request_id ||
                payload?.latest ||
                payload?.folder ||
                ''
            ).trim();
            if (candidate) {
              latestFolderKey = candidate.includes('/')
                ? candidate.replace(/^\/+|\/+$/g, '')
                : `${manualPrefix}${candidate}`.replace(/^\/+|\/+$/g, '');
            }
          }

          if (!latestFolderKey) {
            const manualObjects = await listS3Objects(manualPrefix).catch(() => []);
            const manualFolders = manualObjects
              .map((o) => String(o.key || ''))
              .filter((k) => /^manual-edits\/.+\/INTRADAY\/manual-\d+/.test(k))
              .sort((a, b) => b.localeCompare(a));
            if (manualFolders.length) {
              const top = manualFolders[0];
              const match = top.match(/^(.*\/manual-[^/]+)/);
              latestFolderKey = match?.[1] || (top.endsWith('/') ? top.slice(0, -1) : top);
            }
          }

          if (latestFolderKey) {
            const editedKey = `${latestFolderKey.replace(/\/+$/, '')}/edited_schedule.csv`;
            const systemKey = `${latestFolderKey.replace(/\/+$/, '')}/system_schedule.csv`;
            const [editedText, systemText] = await Promise.all([
              fetchTextFromS3Optional(editedKey).catch(() => null),
              fetchTextFromS3Optional(systemKey).catch(() => null),
            ]);

            // `manual-edits/.../edited_schedule.csv` + `system_schedule.csv` are sparse block->MW exports,
            // not full schedule_from_*.csv files. Parse them accordingly so graph series are populated.
            const editedByBlock = editedText ? parseManualEditsCsvByBlock(editedText) : new Map();
            const systemByBlock = systemText ? parseManualEditsCsvByBlock(systemText) : new Map();
            const manualEditedRows = Array.from(editedByBlock.entries()).map(([block, algo]) => ({ block, algo }));
            const manualSystemRows = Array.from(systemByBlock.entries()).map(([block, algo]) => ({ block, algo }));

            if (manualEditedRows.length) setLatestManualEditedRows(manualEditedRows);
            if (manualSystemRows.length) setLatestManualSystemRows(manualSystemRows);

            // If manual-edits exports exist, use them to seed the editable schedule so the
            // "Edited Schedule" line reflects the latest edited_schedule.csv.
            const preferredAlgoRows = manualEditedRows.length
              ? manualEditedRows
              : manualSystemRows.length
                ? manualSystemRows
                : [];

            if (preferredAlgoRows.length) {
              const algoByBlock = new Map(
                preferredAlgoRows
                  .map((row) => [Number(row.block), row?.algo])
                  .filter(([b]) => Number.isFinite(b))
              );
              const seeded = parsed.map((row) => (
                algoByBlock.has(Number(row.block))
                  ? { ...row, algo: algoByBlock.get(Number(row.block)) }
                  : row
              ));
              setEditedData(seeded);
            }
          }
        }
      } catch {
        // Keep graph resilient when manual-edits folder/latest pointer is unavailable.
      }

      try {
        if (isMeterAvailable(chosenPlant)) {
          // Always use latest updated meter CSV by LastModified.
          const meterObjectsFlat = await listS3ObjectsAcrossPrefixes(getMeterPrefixes(targetDate, chosenPlant), currentUser);
          const meterObjects = mergeUniqueObjects([meterObjectsFlat]);
          const meterObjectsOutputs = meterObjects;
          const meterObject = findLatestMeterCsv(meterObjects) || findLatestMeterCsv(objects);
          const meterObjectFallback = meterObject || findLatestMeterCsv(meterObjectsOutputs);

          if (!meterObjectFallback) {
            throw new Error('Meter CSV not found');
          }

            const meterUrlBase = `${S3_BASE_URL}/${String(meterObjectFallback.key || '').split('/').map((s) => encodeURIComponent(s)).join('/')}`;
            const meterUrl = `${meterUrlBase}?t=${Date.now()}`;
            const meterText = await fetch(meterUrl, { cache: 'no-store' }).then((r) => {
              if (!r.ok) throw new Error(`Meter fetch failed: ${r.status}`);
              return r.text();
            });
            const parsedMeter = parseMeterCsvByBlock(meterText);
            const lastTimestamp = extractLastTimestamp(meterText);
            const lastBlockFromTime = parseBlockFromTimestamp(lastTimestamp, { totalBlocks: 96 });
            const clampBlock = Number.isFinite(lastBlockFromTime) ? lastBlockFromTime : null;
            const sanitizedMeter = clampBlock
              ? parsedMeter.filter((row) => Number.isFinite(row.block) && row.block <= clampBlock)
              : parsedMeter;
            setMeterCurve(sanitizedMeter);
            const maxBlock = sanitizedMeter.length
              ? sanitizedMeter.reduce((mx, row) => (row.block > mx ? row.block : mx), 0)
              : null;
            const minBlock = parsedMeter.length
              ? parsedMeter.reduce((mn, row) => (row.block < mn ? row.block : mn), Number.POSITIVE_INFINITY)
              : null;
            setMeterDebugInfo({
              fileName: meterObjectFallback?.key?.split('/').pop() || 'N/A',
              maxBlock,
              minBlock: Number.isFinite(minBlock) ? minBlock : null,
              rowCount: parsedMeter.length,
              lastTimestamp: extractLastTimestamp(meterText),
            });
          } else {
            setMeterCurve([]);
            setMeterDebugInfo(null);
          }
        } catch {
          // Ignore meter curve load warning in UI
          setMeterDebugInfo(null);
        }

      setGraphError(curveWarnings.length ? curveWarnings.join(' | ') : null);
      setGraphLoading(false);

      if (loadedFromIntradayFallback) {
        toast.warning(`Schedule CSV unavailable (403). Loaded from intraday: ${latestSchedule.key.split('/').pop()}`);
      } else {
        toast.success(`Schedule loaded: ${latestSchedule.key.split('/').pop()}`);
      }
    } catch (err) {
      setLoadError(err.message);
      toast.error(err.message);
    } finally {
      setLoadingData(false);
    }
  };

  // Auto-load when navigated from Dashboard/Readiness
  useEffect(() => {
    if (!(fromDashboard || fromReadiness)) return;
    if (!(context?.plant || context?.plantName)) return;

    const plantName = context?.plant || context?.plantName;
    const dashboardDate = context?.scheduleDate || context?.date || selectedDate;
    // Some callers pass only plantName ("OSEL") without plantCode.
    // Normalize to the internal/S3 plant code (OSEL -> OSEPL) so dropdown selection works.
    const plantCodeFromContext = normalizePlantCode(
      context?.plantCode || derivePlantCodeFromName(plantName) || ''
    );
    const navKey = [
      String(plantName || '').trim().toLowerCase(),
      String(dashboardDate || '').trim(),
      plantCodeFromContext,
      fromDashboard ? '1' : '0',
      fromReadiness ? '1' : '0',
    ].join('|');
    if (appliedNavigationContextRef.current === navKey) return;
    if (!Array.isArray(plantsData?.plants) || plantsData.plants.length === 0) return;

    const normalizedName = String(plantName || '').trim();
    const normalizedNameLower = normalizedName.toLowerCase();
    const hasCodeInName = (candidateName) => {
      const text = String(candidateName || '');
      if (!plantCodeFromContext) return false;
      return (
        text.toUpperCase().includes(`(${plantCodeFromContext})`) ||
        text.toUpperCase().includes(` ${plantCodeFromContext} `) ||
        text.toUpperCase().startsWith(`${plantCodeFromContext} `) ||
        text.toUpperCase().endsWith(` ${plantCodeFromContext}`)
      );
    };

    const plantFromContext =
      plantsData.plants.find((plant) => String(plant.name || '').trim() === normalizedName) ||
      plantsData.plants.find((plant) => String(plant.name || '').trim().toLowerCase() === normalizedNameLower) ||
      (plantCodeFromContext
        ? plantsData.plants.find((plant) => normalizePlantCode(plant?.code) === plantCodeFromContext)
        : null) ||
      (plantCodeFromContext
        ? plantsData.plants.find((plant) => hasCodeInName(plant?.name))
        : null) ||
      plantsData.plants[0] ||
      S3_PLANTS[0];

    appliedNavigationContextRef.current = navKey;
    setSelectedState(plantFromContext.state);
    setSelectedPlant(plantFromContext.name);
    setSelectedDate(dashboardDate);
    if (fromReadiness && context?.isDayAhead) {
      setBulkColumn('dayAhead');
    }
    setHasSavedManualChanges(false);
    setLastSavedManualRequest(null);
    handleLoadData(dashboardDate, { state: plantFromContext.state, plant: plantFromContext.name });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromDashboard, fromReadiness, context, plantsData?.plants, selectedDate]);


  // ==========================================================================
  // API HOOKS
  // ==========================================================================
  const { loading: deleteLoading, execute: deleteSchedule } = useApi(
    api.schedules.delete,
    {
      onSuccess: () => {
        setShowDeleteModal(false);
        setOriginalData([]);
        setEditedData([]);
        setEditingMode(false);
        setSelectedRows([]);
        setLastSelectedRow(null);
        setActiveCell(null);
        setCellDrafts({});
        setBulkValue('');
        setIsDataLoaded(false);
        toast.success('Schedule deleted');
      },
      onError: (e) => toast.error(`Delete failed: ${e.message}`),
    }
  );

  // ==========================================================================
  // HANDLERS
  // ==========================================================================
  const handleDeleteSchedule = async () => {
    if (currentScheduleId) {
      await deleteSchedule(currentScheduleId);
    } else {
      setOriginalData([]);
      setEditedData([]);
      setEditingMode(false);
      setSelectedRows([]);
      setLastSelectedRow(null);
      setActiveCell(null);
      setCellDrafts({});
      setBulkValue('');
      setIsDataLoaded(false);
      setShowDeleteModal(false);
    }
  };

  const handleSubmitToDatabase = async () => {
    if (!canSubmitNow) {
      showSubmitBlockedToast('click');
      return;
    }
    // S3 folder convention for manual-edits:
    // - Intraday: INTRADAY
    // - Day-ahead: DA (legacy screens used DAY_AHEAD; keep backward-compatible reads below)
    const submitScheduleTypeFolder = activeEditColumn === 'dayAhead' ? 'DA' : 'INTRADAY';
    const currentScheduleDate = String(loadedScheduleInfo?.date || selectedDate || '').trim();
    const currentPlantCode = String(getPlantCodeForChanges() || '').trim().toUpperCase();
    const currentSourceScheduleKey = String(
      getOverwriteTargetKey(activeEditColumn) || loadedScheduleInfo?.sourceKey || ''
    ).trim();
    const savedMatchesCurrent =
      Boolean(lastSavedManualRequest) &&
      String(lastSavedManualRequest?.plantCode || '').trim().toUpperCase() === currentPlantCode &&
      String(lastSavedManualRequest?.scheduleDate || '').trim() === currentScheduleDate;
    const savedChangedBlocks = savedMatchesCurrent
      ? Number(lastSavedManualRequest?.changedBlocks ?? 0)
      : 0;

    const modifiedBlocks = hasEdits ? getChangedRows().length : savedChangedBlocks;
    setIsSubmittingChanges(true);
    try {
      const resolveLatestManualEditsFolder = async ({ plantCode, scheduleDate }) => {
        const safePlantCode = String(plantCode || '').trim().toUpperCase();
        const safeDate = String(scheduleDate || '').trim();
        if (!safePlantCode || !safeDate) return null;

        const legacyFolders = submitScheduleTypeFolder === 'DA' ? ['DA', 'DAY_AHEAD'] : [submitScheduleTypeFolder];
        const manualPrefixes = legacyFolders.map(
          (folder) => `manual-edits/vedanjay/${safePlantCode}/${safeDate}/${folder}/`
        );
        let latestFolderKey = '';
        let resolvedPrefix = manualPrefixes[0] || '';

        try {
          for (const manualPrefix of manualPrefixes) {
            const latestJsonKey = `${manualPrefix}latest.json`;
            const latestJsonText = await fetchTextFromS3Optional(latestJsonKey).catch(() => null);
            if (!latestJsonText) continue;
            let payload = {};
            try {
              payload = JSON.parse(latestJsonText);
            } catch {
              payload = {};
            }
            const candidate = String(
              payload?.latest_request_id ||
                payload?.latest_request_folder ||
                payload?.request_id ||
                payload?.latest ||
                payload?.folder ||
                ''
            ).trim();
            if (!candidate) continue;
            resolvedPrefix = manualPrefix;
            latestFolderKey = candidate.includes('/')
              ? candidate.replace(/^\/+|\/+$/g, '')
              : `${manualPrefix}${candidate}`.replace(/^\/+|\/+$/g, '');
            break;
          }
        } catch {
          // ignore and fall back to listing
        }

        if (!latestFolderKey) {
          for (const manualPrefix of manualPrefixes) {
            const manualObjects = await listS3Objects(manualPrefix).catch(() => []);
            const manualFolders = manualObjects
              .map((o) => String(o.key || ''))
              .filter((k) => k.startsWith(manualPrefix) && /\/manual-\d+/.test(k))
              .sort((a, b) => b.localeCompare(a));
            if (!manualFolders.length) continue;
            const top = manualFolders[0];
            const match = top.match(/^(.*\/manual-[^/]+)/);
            resolvedPrefix = manualPrefix;
            latestFolderKey = match?.[1] || (top.endsWith('/') ? top.slice(0, -1) : top);
            break;
          }
        }

        if (!latestFolderKey) return null;
        const folderKey = latestFolderKey.replace(/\/+$/, '');
        const requestId = folderKey.split('/').pop() || '';
        return {
          requestId,
          plantCode: safePlantCode,
          scheduleDate: safeDate,
          scheduleTypeFolder: resolvedPrefix.split('/').filter(Boolean).pop() || submitScheduleTypeFolder,
          editedScheduleKey: `${folderKey}/edited_schedule.csv`,
          systemScheduleKey: `${folderKey}/system_schedule.csv`,
        };
      };

      let resolvedRequest = null;

      if (hasEdits && modifiedBlocks > 0) {
        const saveResult = await handleSaveEdits();
        if (!saveResult?.ok || !saveResult?.request) return;
        resolvedRequest = saveResult.request;
      } else if (!hasEdits && savedMatchesCurrent && savedChangedBlocks > 0) {
        resolvedRequest = lastSavedManualRequest;
      } else {
        const scheduleDate = currentScheduleDate;
        const plantCode = currentPlantCode;
        const latest = await resolveLatestManualEditsFolder({ plantCode, scheduleDate });
        if (!latest) {
          if (!currentSourceScheduleKey) {
            toast.error('No source schedule file found to submit as-is.');
            return;
          }
          resolvedRequest = {
            requestId: '',
            plantCode,
            plantName: loadedScheduleInfo?.plant || selectedPlant || plantCode,
            scheduleDate,
            scheduleType: submitScheduleTypeFolder,
            editedScheduleKey: '',
            systemScheduleKey: currentSourceScheduleKey,
            changedBlocks: 0,
          };
        } else {
          resolvedRequest = {
            requestId: latest.requestId,
            plantCode: latest.plantCode,
            plantName: loadedScheduleInfo?.plant || selectedPlant || latest.plantCode,
            scheduleDate: latest.scheduleDate,
            scheduleType: submitScheduleTypeFolder,
            editedScheduleKey: latest.editedScheduleKey,
            systemScheduleKey: latest.systemScheduleKey,
            changedBlocks: 0,
          };
          setLastSavedManualRequest(resolvedRequest);
          setHasSavedManualChanges(true);
        }
      }

      const plantCode = resolvedRequest?.plantCode;
      const plantName = resolvedRequest?.plantName;
      const plantId = Number(selectedPlantConfig?.id);
      const scheduleDate = resolvedRequest?.scheduleDate;
      const requestId = resolvedRequest?.requestId;
      const preferredKey = modifiedBlocks > 0
        ? resolvedRequest?.editedScheduleKey
        : resolvedRequest?.systemScheduleKey;
      const originalSourceKey = String(loadedScheduleInfo?.sourceKey || '').trim();

      if (!preferredKey) {
        toast.error('Unable to determine source CSV for template conversion.');
        return;
      }

      const params = new URLSearchParams();
      if (Number.isFinite(plantId) && plantId > 0) params.set('plantId', String(plantId));
      if (plantName) params.set('plantName', String(plantName));
      if (plantCode) params.set('plantCode', String(plantCode));
      params.set('sourceFileKey', String(preferredKey));
      if (originalSourceKey) params.set('originSourceKey', originalSourceKey);
      if (scheduleDate) params.set('scheduleDate', String(scheduleDate));
      if (requestId) params.set('manualRequestId', String(requestId));
      params.set('fromReadiness', '1');
      const url = `/templates?${params.toString()}`;
      window.history.replaceState({}, '', url);
      setShowSubmitModal(false);
      toast.success('Schedule submitted. Opening Schedule Templates.');
      if (workflowGuide?.active) workflowGuide.setStep('tmpl_convert');
      else workflowGuide?.start?.('tmpl_convert');
      onNavigate('templates', {
        fromReadiness: true,
        plantId: Number.isFinite(plantId) && plantId > 0 ? plantId : undefined,
        plantName,
        plantCode,
        sourceFileKey: preferredKey,
        originSourceKey: originalSourceKey,
        scheduleDate,
        manualRequestId: requestId,
      });
    } finally {
      setIsSubmittingChanges(false);
    }
  };

  // Upload CSV handler removed

  const handleExport = async (format = 'csv') => {
    if (!editedData.length) { toast.error('No data to export'); return; }
    const headers = ['Block', 'Time', 'System Schedule (MW)', 'Day-ahead (MW)', 'Intraday Forecast (MW)'];
    const rows = editedData.map((r) => [r.block, r.time, r.algo, r.dayAhead ?? '0', r.intraday]);
    const filenameBase = `schedule-${loadedScheduleInfo?.date || selectedDate}`;
    if (format === 'xlsx') {
      await downloadXlsxFromRows(headers, rows, filenameBase, 'Schedule');
    } else {
      const csvText = buildCsvText(headers, rows);
      downloadCsvText(csvText, filenameBase);
    }
    setShowExportModal(false);
  };

  const buildOverwriteCsvText = (rowsOverride = null, column = 'algo') => {
    const rowsToUse = Array.isArray(rowsOverride) ? rowsOverride : editedData;
    const selectedColumn = column === 'dayAhead' ? 'dayAhead' : 'algo';
    const headers = [
      'block',
      'timestamp',
      'algo_schedule_mw',
      'condition_used',
      'BaseForecast',
      'IntradayForecast_mw',
    ];
    const datePrefix = String(loadedScheduleInfo?.date || selectedDate || '').trim();
    const rows = rowsToUse.map((r) => {
      const block = r.block;
      const time = blockToTime(block);
      const timestamp = datePrefix ? `${datePrefix}T${time}:00` : time;
      const algo = selectedColumn === 'dayAhead' ? toUiNumericText(r.dayAhead) : toUiNumericText(r.algo);
      const base = selectedColumn === 'dayAhead'
        ? toUiNumericText(r.dayAheadBase || r.base || r.dayAhead || r.algo)
        : toUiNumericText(r.base || r.algo);
      const intraday = selectedColumn === 'dayAhead'
        ? toUiNumericText(r.dayAheadIntraday || r.intraday || r.dayAhead || r.algo)
        : toUiNumericText(r.intraday || r.algo);
      const condition = selectedColumn === 'dayAhead'
        ? String(r.dayAheadCondition || r.condition || 'MANUAL_EDIT')
        : String(r.condition || 'MANUAL_EDIT');
      return [block, timestamp, algo, condition, base, intraday].join(',');
    });
    return [headers.join(','), ...rows].join('\n');
  };

  const getOverwriteTargetKey = (column = 'algo') => {
    const isDayAhead = column === 'dayAhead';
    const sourceKey = String(isDayAhead ? loadedScheduleInfo?.dayAheadSourceKey : loadedScheduleInfo?.sourceKey || '').trim();
    const numericKey = String(isDayAhead ? loadedScheduleInfo?.dayAheadLatestNumericKey : loadedScheduleInfo?.latestNumericKey || '').trim();
    const scheduleKeyPattern = /schedule_(?:free(?:z|ze)_)?from_\d+\.csv$/i;
    if (scheduleKeyPattern.test(sourceKey)) return sourceKey;
    if (scheduleKeyPattern.test(numericKey)) return numericKey;
    return sourceKey || numericKey;
  };

  const handleOverwriteLatest = async () => {
    if (!editedData.length) { toast.error('No data to save'); return; }
    const targetKey = getOverwriteTargetKey(activeEditColumn);
    if (!targetKey) {
      toast.error('Latest schedule key not found. Load schedule from S3 first.');
      return;
    }
    setIsOverwritingLatest(true);
    try {
      const csvText = buildOverwriteCsvText(null, activeEditColumn);
      await api.schedules.overwriteLatest({
        sourceFileKey: targetKey,
        csvText,
        requestedBy: requestedByLabel,
      });
      setChanges([]);
      toast.success('Latest schedule overwritten in S3.');
      setShowExportModal(false);
    } catch (error) {
      toast.error(error?.message || 'Failed to overwrite latest schedule');
    } finally {
      setIsOverwritingLatest(false);
    }
  };

  const toNumberSafe = (value) => {
    const n = Number(String(value ?? '').replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  const isCellChanged = (rowIndex, column) => {
    const current = toNumberSafe(editedData[rowIndex]?.[column]);
    const original = toNumberSafe(originalData[rowIndex]?.[column]);
    if (current === null && original === null) return false;
    return current !== original;
  };

  const hasEdits = editedData.some((_, idx) => isCellChanged(idx, activeEditColumn));

  const getChangedRows = () => editedData
    .map((row, idx) => {
      if (!isCellChanged(idx, activeEditColumn)) return null;
      return { row, idx };
    })
    .filter(Boolean);

  const evaluateFormula = (rawInput, baseValue) => {
    const input = String(rawInput ?? '').trim();
    if (!input) return baseValue;
    const base = Number.isFinite(baseValue) ? baseValue : 0;

    const pctMatch = input.match(/^\s*=?\s*([+-])?\s*(\d+(\.\d+)?)\s*%\s*$/);
    if (pctMatch) {
      const sign = pctMatch[1] === '-' ? -1 : 1;
      const pct = Number(pctMatch[2]);
      if (!Number.isFinite(pct)) return null;
      return base + (base * sign * pct) / 100;
    }

    if (input.startsWith('=')) {
      const expr = input.slice(1).trim();
      const match = expr.match(/^value\s*([+\-*/])\s*([0-9.]+)\s*$/i);
      if (!match) return null;
      const op = match[1];
      const rhs = Number(match[2]);
      if (!Number.isFinite(rhs)) return null;
      switch (op) {
        case '+': return base + rhs;
        case '-': return base - rhs;
        case '*': return base * rhs;
        case '/': return rhs === 0 ? null : base / rhs;
        default: return null;
      }
    }

    const numeric = Number(input);
    return Number.isFinite(numeric) ? numeric : null;
  };

  const getCellKey = (rowIndex, column) => `${rowIndex}:${column}`;

  const commitCellEdit = (rowIndex, column) => {
    const key = getCellKey(rowIndex, column);
    const rawValue = cellDrafts[key];
    if (rawValue === undefined) return;
    const baseValue = toNumberSafe(editedData[rowIndex]?.[column]);
    const computed = evaluateFormula(rawValue, baseValue);
    if (!Number.isFinite(computed)) {
      toast.error('Invalid formula or value');
      setCellDrafts((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }
    const updated = [...editedData];
    updated[rowIndex] = {
      ...updated[rowIndex],
      [column]: toUiNumericText(computed, updated[rowIndex][column]),
    };
    setEditedData(updated);
    setCellDrafts((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const cancelCellEdit = (rowIndex, column) => {
    const key = getCellKey(rowIndex, column);
    setCellDrafts((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const toggleRowSelection = (rowIndex, checked, shiftKey = false) => {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (shiftKey && lastSelectedRow !== null) {
        const start = Math.min(lastSelectedRow, rowIndex);
        const end = Math.max(lastSelectedRow, rowIndex);
        for (let i = start; i <= end; i += 1) {
          if (checked) next.add(i);
          else next.delete(i);
        }
      } else if (checked) {
        next.add(rowIndex);
      } else {
        next.delete(rowIndex);
      }
      return Array.from(next);
    });
    setLastSelectedRow(rowIndex);
  };

  const toggleSelectAll = (checked) => {
    if (checked) {
      setSelectedRows(editedData.map((_, idx) => idx));
    } else {
      setSelectedRows([]);
    }
  };

  const handleApplyBulk = () => {
    if (!editingMode) return;
    if (!bulkValue.trim()) {
      toast.error('Enter a value or formula to apply');
      return;
    }
    const targetRows = selectedRows.length
      ? selectedRows
      : activeCell?.rowIndex !== undefined
        ? [activeCell.rowIndex]
        : [];
    if (!targetRows.length) {
      toast.error('Select at least one row to apply bulk changes');
      return;
    }
    const updated = [...editedData];
    for (const rowIndex of targetRows) {
      const baseValue = toNumberSafe(updated[rowIndex]?.[activeEditColumn]);
      const computed = evaluateFormula(bulkValue, baseValue);
      if (!Number.isFinite(computed)) {
        toast.error('Invalid formula or value');
        return;
      }
      updated[rowIndex] = {
        ...updated[rowIndex],
        [activeEditColumn]: toUiNumericText(computed, updated[rowIndex][activeEditColumn]),
      };
    }
    setEditedData(updated);
    setBulkValue('');
  };

  useEffect(() => {
    if (!editingMode) return;
    const start = Number.parseInt(rangeStartBlock, 10);
    const end = Number.parseInt(rangeEndBlock, 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    const minBlock = Math.max(1, Math.min(start, end));
    const maxBlock = Math.min(editedData.length || 96, Math.max(start, end));
    if (minBlock > maxBlock) return;
    const next = [];
    for (let b = minBlock; b <= maxBlock; b += 1) {
      next.push(b - 1);
    }
    setSelectedRows(next);
    setLastSelectedRow(maxBlock - 1);
  }, [rangeStartBlock, rangeEndBlock, editingMode, editedData.length]);

  useEffect(() => {
    if (editingMode) return;
    setRangeStartBlock('');
    setRangeEndBlock('');
  }, [editingMode]);

  const handleSaveEdits = async (options = {}) => {
    const normalizeScheduleDate = (value) => {
      const raw = String(value || '').trim();
      const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/);
      if (isoMatch) return isoMatch[1];
      const dmyMatch = raw.match(/^(\d{2})-(\d{2})-(\d{4})/);
      if (dmyMatch) return `${dmyMatch[3]}-${dmyMatch[2]}-${dmyMatch[1]}`;
      return raw;
    };

    const nowIstIso = () => {
      const text = new Date().toLocaleString('sv-SE', {
        timeZone: 'Asia/Kolkata',
        hour12: false,
      }); // "YYYY-MM-DD HH:mm:ss"
      return `${text.replace(' ', 'T')}+05:30`;
    };

    const isForceSave = Boolean(options?.force);
    if (!hasEdits) return { ok: false, reason: 'no_edits' };
    setIsOverwritingLatest(true);
    try {
      const rowsToSave = getChangedRows();
      const isDayAhead = activeEditColumn === 'dayAhead';
      const targetKey = getOverwriteTargetKey(activeEditColumn);
      if (!targetKey) {
        throw new Error('Latest schedule key not found. Load schedule from S3 first.');
      }
      const savedAt = new Date().toISOString();
      const requestedBy = requestedByLabel;
      const scheduleDate = normalizeScheduleDate(loadedScheduleInfo?.date || selectedDate || '');
      const plantCode = getPlantCodeForChanges();
      const normalizedChanges = rowsToSave
        .map(({ row }) => ({
          block: Number(row.block),
          mw: toNumberSafe(row[activeEditColumn]),
        }))
        .filter((item) => Number.isFinite(item.block) && Number.isFinite(item.mw))
        .sort((a, b) => a.block - b.block);

      if (!normalizedChanges.length) {
        throw new Error('No valid changed rows found for manual submission.');
      }

      const referenceBlock = Number.isFinite(
        Number(activeEditColumn === 'dayAhead' ? loadedScheduleInfo?.dayAheadEndingBlock : loadedScheduleInfo?.endingBlock)
      )
        ? Number(activeEditColumn === 'dayAhead' ? loadedScheduleInfo?.dayAheadEndingBlock : loadedScheduleInfo?.endingBlock)
        : normalizedChanges[0].block;

      const requestIdPrefix = isForceSave ? 'force-manual' : 'manual';
      const requestId = `${requestIdPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

      const daRevisionRaw =
        (Number.isFinite(Number(loadedScheduleInfo?.dayAheadEndingBlock)) ? Number(loadedScheduleInfo?.dayAheadEndingBlock) : null)
        ?? extractScheduleRevision(targetKey)
        ?? extractScheduleRevision(loadedScheduleInfo?.dayAheadSourceKey || '')
        ?? extractScheduleRevision(loadedScheduleInfo?.dayAheadLatestNumericKey || '');
      const daRevision = Number.isFinite(Number(daRevisionRaw)) ? Math.trunc(Number(daRevisionRaw)) : null;
      if (isDayAhead && !Number.isFinite(daRevision)) {
        throw new Error('Revision not found for Day-Ahead schedule. Please reload Day-Ahead schedule from S3 and try again.');
      }

      const saveResponse = await api.schedules.submitManualChanges({
        org_id: 'vedanjay',
        site_id: plantCode,
        schedule_date: scheduleDate,
        // Manual-changes pipeline uses "DA" for day-ahead; intraday stays "INTRADAY".
        schedule_type: activeEditColumn === 'dayAhead' ? 'DA' : 'INTRADAY',
        ...(isDayAhead ? { revision: daRevision } : {}),
        reference_block: referenceBlock,
        baseline_schedule_s3_key: targetKey,
        submitted_by: requestedBy,
        submitted_at_ist: nowIstIso(),
        comment: 'Manual correction from Schedule Preparation UI',
        request_id: requestId,
        changes: normalizedChanges,
      });
      const resolvedRequestId = String(saveResponse?.request_id || requestId);
      const scheduleTypeFolder = activeEditColumn === 'dayAhead' ? 'DA' : 'INTRADAY';
      const requestPrefix = `manual-edits/vedanjay/${plantCode}/${scheduleDate}/${scheduleTypeFolder}/${resolvedRequestId}`;
      const editedScheduleKey = `${requestPrefix}/edited_schedule.csv`;
      const systemScheduleKey = `${requestPrefix}/system_schedule.csv`;

      const existingForFile = Array.isArray(changes)
        ? changes
        : [];
      let nextChanges = [...existingForFile];
      rowsToSave.forEach(({ row, idx }) => {
        const oldValue = originalData[idx]?.[activeEditColumn] ?? row[activeEditColumn];
        const newValue = row[activeEditColumn];
        nextChanges = [
          ...nextChanges,
          {
            block: row.block,
            time: row.time,
            oldValue,
            newValue,
            savedAt,
            requestedBy,
            sourceFileKey: targetKey,
          },
        ];
        api.schedules.appendChangeLog({
          plantCode,
          scheduleDate,
          sourceFileKey: targetKey,
          block: row.block,
          time: row.time,
          oldValue,
          newValue,
          savedAt,
          requestedBy,
        }).catch(() => {});
      });
      setChanges(nextChanges);
      persistChanges(nextChanges);
      setOriginalData(editedData);
      setEditingMode(false);
      setSelectedRows([]);
      setLastSelectedRow(null);
      setActiveCell(null);
      setCellDrafts({});
      setBulkValue('');
      setHasSavedManualChanges(true);
      const nextRequest = {
        requestId: resolvedRequestId,
        plantCode,
        plantName: loadedScheduleInfo?.plant || selectedPlant || plantCode,
        scheduleDate,
        scheduleType: scheduleTypeFolder,
        editedScheduleKey,
        systemScheduleKey,
        changedBlocks: normalizedChanges.length,
      };
      setLastSavedManualRequest(nextRequest);

      // Persist manual change count for dashboard display
      const plantCodeForChanges = plantCode;
      const scheduleDateForChanges = scheduleDate;
      // Key by full schedule file key to avoid mixing counts across plants with same filename.
      setManualChangeCountLocal(plantCodeForChanges, scheduleDateForChanges, targetKey, nextChanges.length);

      toast.success('Changes saved. You can now click Submit Changes.');
      if (workflowGuide?.isStep?.('prep_save') || workflowGuide?.isStep?.('prep_save_ready')) {
        workflowGuide.setStep('prep_submit');
      }
      return { ok: true, request: nextRequest };
    } catch (error) {
      toast.error(error?.message || 'Failed to submit manual changes');
      return { ok: false, error };
    } finally {
      setIsOverwritingLatest(false);
    }
  };

  const handleCancelEdits = () => {
    setEditedData(originalData);
    setEditingMode(false);
    setSelectedRows([]);
    setLastSelectedRow(null);
    setActiveCell(null);
    setCellDrafts({});
    setBulkValue('');
  };

  useEffect(() => {
    if (hasEdits) {
      setHasSavedManualChanges(false);
    }
  }, [hasEdits]);

  const plotSeries = useMemo(() => {
    const blockLimit = 96;

    const blocks = Array.from({ length: blockLimit }, (_, i) => i + 1);
    const toNumOrNull = (value) => {
      if (value === null || value === undefined) return null;
      if (typeof value === 'string' && value.trim() === '') return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };
    const editedScheduleMap = new Map(
      editedData
        .map((r) => [Number(r.block), toNumOrNull(r.algo)])
        .filter(([b]) => Number.isFinite(b))
    );
    const latestManualEditedMap = new Map(
      latestManualEditedRows
        .map((r) => [Number(r.block), toNumOrNull(r.algo)])
        .filter(([b]) => Number.isFinite(b))
    );
    const dayAheadScheduleMap = new Map(
      editedData
        .map((r) => [Number(r.block), toNumOrNull(r.dayAhead ?? r.day_ahead)])
        .filter(([b]) => Number.isFinite(b))
    );
    const latestManualSystemMap = new Map(
      latestManualSystemRows
        .map((r) => [Number(r.block), toNumOrNull(r.algo)])
        .filter(([b]) => Number.isFinite(b))
    );
    const systemScheduleMap = new Map(
      originalData
        .map((r) => [Number(r.block), toNumOrNull(r.algo)])
        .filter(([b]) => Number.isFinite(b))
    );
    const intradayMap = new Map(
      intradayCurve
        .map((r) => [Number(r.block), toNumOrNull(r.forecast)])
        .filter(([b]) => Number.isFinite(b))
    );
    const meterMap = new Map(
      meterCurve
        .map((r) => [Number(r.block), toNumOrNull(r.generationMw)])
        .filter(([b]) => Number.isFinite(b))
    );
    const meterMaxBlock = meterCurve.length
      ? meterCurve.reduce((mx, r) => {
          const b = Number(r.block);
          return Number.isFinite(b) ? Math.max(mx, b) : mx;
        }, 0)
      : null;
    const capacityMw = Number(selectedPlantConfig?.capacityMw || 0);
    const plantState = selectedPlantConfig?.state;
    const plantType = selectedPlantConfig?.type || 'Solar';
    const allowedBandPercent = getAllowedBandPercent(plantState, plantType);
    const allowedBandMw = (capacityMw * allowedBandPercent) / 100;
    const intervals = blocks.map((b) => blockToInterval(b));
    const blockLabels = blocks.map((b, idx) => `Block ${b} (${intervals[idx]})`);
    const hoverCustomdata = blocks.map((b, idx) => [b, intervals[idx]]);
      return {
        blocks,
        intervals,
        blockLabels,
        hoverCustomdata,
        allowedBandMw,
        systemSchedule: blocks.map((b) => (systemScheduleMap.has(b) ? systemScheduleMap.get(b) : null)),
        editedSchedule: blocks.map((b) => (
          latestManualEditedMap.has(b)
            ? latestManualEditedMap.get(b)
            : (editedScheduleMap.has(b) ? editedScheduleMap.get(b) : null)
        )),
        dayAheadSchedule: blocks.map((b) => (dayAheadScheduleMap.has(b) ? dayAheadScheduleMap.get(b) : null)),
      manualSystemSchedule: blocks.map((b) => (latestManualSystemMap.has(b) ? latestManualSystemMap.get(b) : null)),
      intradayForecast: blocks.map((b) => (intradayMap.has(b) ? intradayMap.get(b) : null)),
      actualMetered: blocks.map((b) => {
        if (Number.isFinite(meterMaxBlock) && b > meterMaxBlock) return null;
        return meterMap.has(b) ? meterMap.get(b) : null;
      }),
      allowedBandPercent,
      upperAllowedBand: blocks.map((b) => {
        const schedule = latestManualEditedMap.has(b)
          ? latestManualEditedMap.get(b)
          : (editedScheduleMap.has(b) ? editedScheduleMap.get(b) : null);
        return Number.isFinite(schedule) ? schedule + allowedBandMw : null;
      }),
      lowerAllowedBand: blocks.map((b) => {
        const schedule = latestManualEditedMap.has(b)
          ? latestManualEditedMap.get(b)
          : (editedScheduleMap.has(b) ? editedScheduleMap.get(b) : null);
        return Number.isFinite(schedule) ? schedule - allowedBandMw : null;
      }),
      blockLimit,
    };
  }, [editedData, originalData, latestManualEditedRows, latestManualSystemRows, intradayCurve, meterCurve, selectedPlantConfig, selectedDate, loadedScheduleInfo]);

  const meterMaxBlock = useMemo(
    () => (meterCurve.length ? Math.max(...meterCurve.map((r) => Number(r.block) || 0)) : null),
    [meterCurve]
  );

  const selectedScheduleDate = useMemo(
    () => String(loadedScheduleInfo?.date || selectedDate || '').trim(),
    [loadedScheduleInfo, selectedDate]
  );

  const isTodaySelected = useMemo(() => {
    if (!selectedScheduleDate) return false;
    const todayIst = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    return selectedScheduleDate === todayIst;
  }, [selectedScheduleDate]);

  useEffect(() => {
    const key = getChangesStorageKey();
    if (!key) {
      setChanges([]);
      return;
    }
    const plantCode = getPlantCodeForChanges();
    const scheduleDate = String(loadedScheduleInfo?.date || selectedDate || '').trim();
    const normalizeChangeRows = (rows) => (rows || []).map((c) => ({
      block: c.block,
      time: c.time,
      oldValue: c.old_value ?? c.oldValue ?? '',
      newValue: c.new_value ?? c.newValue ?? '',
      savedAt: c.saved_at ?? c.savedAt ?? '',
      sourceFileKey: c.source_file_key ?? c.sourceFileKey ?? '',
      requestedBy: c.requested_by ?? c.requestedBy ?? '',
    }));

    const loadFromLocal = () => {
      try {
        const raw = localStorage.getItem(key);
        const parsed = raw ? JSON.parse(raw) : [];
        const normalized = Array.isArray(parsed) ? normalizeChangeRows(parsed) : [];
        setChanges(normalized);
      } catch {
        setChanges([]);
      }
    };

    const loadFromS3 = async () => {
      if (!plantCode || !scheduleDate) return null;
      const changeKey = `generated/vedanjay/${plantCode}/outputs/${scheduleDate}/schedule_changes.json`;
      const text = await fetchTextFromS3Optional(changeKey).catch(() => null);
      if (!text) return null;
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
      const rows = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.items)
          ? payload.items
          : [];
      return normalizeChangeRows(rows);
    };

    const loadChanges = async () => {
      try {
        const s3Rows = await loadFromS3();
        if (s3Rows !== null) {
          setChanges(s3Rows);
          persistChanges(s3Rows);
          return;
        }
      } catch {
        // ignore and fall back
      }
      // If S3 not available, just use local cache; skip API to avoid noisy 404/422 responses.
      loadFromLocal();
    };

    loadChanges();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedScheduleInfo, activeEditColumn]);

  const plotLayout = useMemo(() => {
    return {
      margin: { l: 50, r: 20, t: 50, b: 40 },
      uirevision: `${loadedScheduleInfo?.fileName || ''}|${selectedState || ''}|${selectedPlant || ''}|${loadedScheduleInfo?.date || selectedDate || ''}`,
      paper_bgcolor: isDarkMode ? 'rgba(0,0,0,0)' : '#ffffff',
      plot_bgcolor: isDarkMode ? 'rgba(0,0,0,0)' : '#ffffff',
      font: { color: isDarkMode ? '#cbd5e1' : '#1f2937', size: 11 },
      xaxis: {
        title: 'Block No',
        type: 'category',
        tickmode: 'array',
        tickvals: plotSeries.blockLabels.filter((_, idx) => idx % 12 === 0),
        ticktext: plotSeries.blocks.filter((_, idx) => idx % 12 === 0),
        gridcolor: isDarkMode ? 'rgba(148,163,184,0.2)' : 'rgba(100,116,139,0.22)',
        autorange: false,
        range: [-0.5, Math.max(plotSeries.blockLimit - 0.5, 11.5)],
        showspikes: true,
        spikemode: 'across',
        spikesnap: 'cursor',
        spikethickness: 1,
        spikedash: 'solid',
        spikecolor: isDarkMode ? 'rgba(226,232,240,0.55)' : 'rgba(15,23,42,0.45)',
      },
      yaxis: {
        title: 'Power (MW)',
        gridcolor: isDarkMode ? 'rgba(148,163,184,0.2)' : 'rgba(100,116,139,0.22)'
      },
      hovermode: 'x unified',
      // Avoid "carry-forward" hover where missing meter blocks show the last available meter value.
      hoverdistance: 1,
      spikedistance: 1,
      hoverlabel: {
        bgcolor: isDarkMode ? 'rgba(15,23,42,0.78)' : 'rgba(255,255,255,0.78)',
        bordercolor: isDarkMode ? '#334155' : '#94a3b8',
        font: { color: isDarkMode ? '#e2e8f0' : '#0f172a', size: 12 },
        namelength: -1,
        align: 'left',
      },
      legend: {
        orientation: 'h',
        x: 0,
        y: 1.2,
        yanchor: 'bottom',
        bgcolor: isDarkMode ? 'rgba(0,0,0,0)' : 'rgba(255,255,255,0.92)',
        font: { color: isDarkMode ? '#cbd5e1' : '#1f2937' },
        itemclick: 'toggle',
        itemdoubleclick: false,
        groupclick: 'toggleitem',
      }
    };
  }, [isDarkMode, plotSeries, loadedScheduleInfo, selectedDate, selectedPlant, selectedState]);

  useEffect(() => {
    setHiddenTraceKeys([]);
  }, [selectedDate, selectedPlant, loadedScheduleInfo?.fileName, loadedScheduleInfo?.sourceKey]);

  const plotData = useMemo(() => ([
    {
      uid: 'allowedBand-lower',
      x: plotSeries.blockLabels,
      y: plotSeries.lowerAllowedBand,
      customdata: plotSeries.hoverCustomdata,
      type: 'scatter',
      mode: 'lines',
      name: `Allowed Band (\u00b1${plotSeries.allowedBandPercent}%)`,
      line: { color: '#9ca3af', width: 0.8, dash: 'solid' },
      opacity: 0.9,
      hoverinfo: 'skip',
      showlegend: false,
      legendgroup: 'allowedBand',
      connectgaps: false
    },
    {
      uid: 'allowedBand-upper',
      x: plotSeries.blockLabels,
      y: plotSeries.upperAllowedBand,
      customdata: plotSeries.hoverCustomdata,
      type: 'scatter',
      mode: 'lines',
      name: `Allowed Band (\u00b1${plotSeries.allowedBandPercent}%)`,
      line: { color: '#9ca3af', width: 0.8, dash: 'solid' },
      fill: 'tonexty',
      fillcolor: isDarkMode ? 'rgba(156,163,175,0.10)' : 'rgba(156,163,175,0.14)',
      opacity: 0.9,
      hoverinfo: 'skip',
      showlegend: true,
      legendgroup: 'allowedBand',
      connectgaps: false
    },
    {
      uid: 'systemSchedule',
      x: plotSeries.blockLabels,
      y: plotSeries.systemSchedule,
      customdata: plotSeries.hoverCustomdata,
      type: 'scatter',
      mode: 'lines',
      name: 'System Schedule (MW)',
      line: { color: '#1d4ed8', width: 1.6 },
      hovertemplate: 'System: %{y:.2f} MW<extra></extra>',
      connectgaps: false
    },
    {
      uid: 'manualRequestCsv',
      x: plotSeries.blockLabels,
      y: plotSeries.editedSchedule,
      customdata: plotSeries.hoverCustomdata,
      type: 'scatter',
      mode: 'lines',
      name: 'Edited Schedule (MW)',
      line: { color: '#22c55e', width: 1.6 },
      hovertemplate: 'Edited: %{y:.2f} MW<extra></extra>',
      connectgaps: false
    },
    {
      uid: 'dayAheadSchedule',
      x: plotSeries.blockLabels,
      y: plotSeries.dayAheadSchedule,
      customdata: plotSeries.hoverCustomdata,
      type: 'scatter',
      mode: 'lines',
      name: 'Day-ahead Schedule (MW)',
      line: { color: '#ec4899', width: 1.6 },
      hovertemplate: 'Day-ahead: %{y:.2f} MW<extra></extra>',
      connectgaps: false
    },
    {
      uid: 'intradayForecast',
      x: plotSeries.blockLabels,
      y: plotSeries.intradayForecast,
      customdata: plotSeries.hoverCustomdata,
      type: 'scatter',
      mode: 'lines',
      name: 'Enercast Intraday Forecast (MW)',
      line: { color: '#f59e0b', width: 1.6 },
      hovertemplate: 'Enercast Intraday: %{y:.2f} MW<extra></extra>',
      connectgaps: false
    },
    {
      uid: 'meterData',
      x: plotSeries.blockLabels,
      y: plotSeries.actualMetered,
      type: 'scatter',
      mode: 'lines',
      name: 'Meter Data (MW)',
      line: { color: isDarkMode ? '#ffffff' : '#000000', width: 1.8 },
      hovertemplate: 'Meter Data: %{y:.2f} MW<extra></extra>',
      connectgaps: false
    },
    ].map((trace) => {
      const normalizedTrace = (() => {
        if (String(trace?.type || '').toLowerCase() !== 'scatter') return trace;
        if (!String(trace?.mode || '').includes('lines')) return trace;
        return { ...trace, line: { ...(trace.line || {}), shape: 'hv' } };
      })();
      return {
        ...normalizedTrace,
        visible: isTraceHidden(normalizedTrace?.uid) ? 'legendonly' : true,
      };
    })), [plotSeries, isDarkMode, isTraceHidden]);

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
        symbol: 'circle-open',
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

  // ==========================================================================
  // RENDER
  // ==========================================================================
  return (
    <>
      <div className="flex-1 overflow-auto bg-slate-950 min-h-0 relative overflow-x-hidden">
        {/* Background blobs */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-0 left-1/4 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl animate-pulse" />
          <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />
        </div>

        <div className="w-full p-4 sm:p-6 lg:p-8 space-y-6 sm:space-y-8 max-w-[1800px] mx-auto relative z-10">

          {/* â”€â”€ Page Header â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 border border-slate-700/50 shadow-2xl">
            <div className="absolute inset-0 bg-gradient-to-r from-indigo-500/5 via-transparent to-purple-500/5" />
            <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-bl from-indigo-500/10 to-transparent rounded-full blur-2xl" />
            <div className="relative p-4 sm:p-6 lg:p-8">
              <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-6">
                <div className="flex items-start gap-4 sm:gap-5">
                  <div className="relative">
                    <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/25">
                      <Calendar className="w-6 h-6 sm:w-7 sm:h-7 text-white" />
                    </div>
                  </div>
                  <div>
                    <h1 className="text-2xl sm:text-3xl font-bold text-white mb-2 tracking-tight">Schedule Preparation</h1>
                    <div className="flex flex-wrap items-center gap-2 sm:gap-4 text-slate-400">
                      <div className="flex items-center gap-2">
                        <span className="relative flex h-2 w-2">
                          <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75 animate-ping" />
                          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                        </span>
                        <span className="text-xs sm:text-sm font-medium">Ready</span>
                      </div>
                      <span className="text-slate-600 hidden sm:inline">|</span>
                      <span className="text-xs sm:text-sm">S3 Schedule Viewer</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* â”€â”€ Filters â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
          {!fromDashboard && (
            <div className="rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm p-4 sm:p-6">
              <div className="flex items-center gap-3 mb-4 sm:mb-6">
                <div className="p-3 rounded-xl bg-indigo-500/10">
                  <Layers className="w-5 h-5 sm:w-6 sm:h-6 text-indigo-400" />
                </div>
                <div>
                  <h3 className="text-lg sm:text-xl font-bold text-foreground">Load Schedule from S3</h3>
                  <p className="text-xs sm:text-sm text-slate-400">Select state, plant and date to fetch schedule data</p>
                  <p className="text-[11px] sm:text-xs text-slate-300 mt-1">
                    <span className="font-semibold">Plant:</span> {selectedPlantConfig?.name || selectedPlant || 'Select Plant'}{' '}
                    <span className="mx-1">|</span>
                    <span className="font-semibold">State:</span> {selectedPlantConfig?.state || selectedState || 'Select State'}
                  </p>
                </div>
              </div>

              {/* 4-col grid: State | Plant | Date | Load Button */}
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                <div>
                  <label className="text-xs font-medium text-slate-400 mb-2 block">State</label>
                  <select
                    value={selectedState}
                    onChange={(e) => handleStateChange(e.target.value)}
                    className="w-full px-3.5 py-2.5 sm:px-4 sm:py-3 rounded-xl bg-slate-800/50 border border-slate-700/50 text-slate-300 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all appearance-none cursor-pointer"
                  >
                    {availableStates.map((state) => (
                      <option key={state} value={state}>{state}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-xs font-medium text-slate-400 mb-2 block">Plant</label>
                  <select
                    value={selectedPlant}
                    onChange={(e) => handlePlantChange(e.target.value)}
                    disabled={selectedState === 'Select State'}
                    className="w-full px-3.5 py-2.5 sm:px-4 sm:py-3 rounded-xl bg-slate-800/50 border border-slate-700/50 text-slate-300 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all appearance-none cursor-pointer disabled:opacity-50"
                  >
                    {availablePlants.map((p) => <option key={p}>{p}</option>)}
                  </select>
                </div>

                <div>
                  <label className="text-xs font-medium text-slate-400 mb-2 block">Date</label>
                  <input
                    type="date"
                    value={selectedDate}
                    onChange={(e) => setSelectedDate(e.target.value)}
                    className="w-full px-3.5 py-2.5 sm:px-4 sm:py-3 rounded-xl bg-slate-800/50 border border-slate-700/50 text-slate-300 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                  />
                </div>

                <div className="flex items-end sm:col-span-2 xl:col-span-1">
                  <button
                    onClick={handleLoadData}
                    disabled={loadingData}
                    className="w-full min-w-[160px] min-h-[44px] px-5 sm:px-6 py-2.5 sm:py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white font-semibold hover:from-indigo-500 hover:to-purple-500 transition-all duration-200 shadow-lg shadow-indigo-500/25 disabled:opacity-60 flex items-center justify-center gap-2 active:scale-[0.98] active:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
                  >
                    {loadingData
                      ? <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span className="font-semibold">Loading...</span>
                        </>
                      : <><RefreshCw className="w-4 h-4" /> <span className="font-semibold">Load Data</span></>}
                  </button>
                </div>
              </div>

              {/* Success banner */}
              {isDataLoaded && (
                <div className="mt-6 p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl flex items-center gap-3">
                  <CheckCircle className="w-5 h-5 text-emerald-400 flex-shrink-0" />
                  <div className="text-sm text-emerald-400 space-y-0.5">
                    <div>
                      <span className="font-semibold">Loaded:</span>{' '}
                      {loadedScheduleInfo?.fileName} - {' '}
                      <span className="font-semibold">{loadedScheduleInfo?.date}</span>
                      {loadedScheduleInfo?.endingBlockTime ? (
                        <>
                          {' '}<span className="font-semibold">Time:{loadedScheduleInfo.endingBlockTime}</span>
                        </>
                      ) : null}
                    </div>
                    <div className="text-xs sm:text-sm text-emerald-300">
                      <span className="font-semibold">Plant:</span> {loadedScheduleInfo?.plant || 'N/A'}{' '}
                      <span className="mx-1">|</span>
                      <span className="font-semibold">State:</span> {loadedScheduleInfo?.state || 'N/A'}
                    </div>
                  </div>
                </div>
              )}

              {/* Error banner */}
              {loadError && (
                <div className="mt-6 p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-3">
                  <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
                  <span className="text-sm text-red-400">{loadError}</span>
                </div>
              )}
            </div>
          )}

          {/* â”€â”€ Content (only when data is loaded) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
          {(isDataLoaded || fromDashboard) && (
            <>
              {/* â”€â”€ Plotly Graph â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
              <div className="grid grid-cols-1 gap-4 sm:gap-6">

                <div className="rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm p-4 sm:p-6">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
                  <div className="flex items-center gap-3">
                    <div className="p-3 rounded-xl bg-indigo-500/10">
                      <BarChart2 className="w-5 h-5 sm:w-6 sm:h-6 text-indigo-400" />
                    </div>
                    <div>
                      <h3 className="text-lg sm:text-xl font-bold text-foreground">Schedule Graph</h3>
                      <p className="text-xs sm:text-sm text-muted-foreground">
                        Interactive Plotly chart N/A {loadedScheduleInfo?.date || selectedDate}
                      </p>
                    </div>
                  </div>

                    <div className="flex flex-col sm:flex-row gap-2 sm:items-center sm:ml-auto">
                      <button
                        onClick={() => setShowGraphModal(true)}
                        disabled={!editedData.length}
                        className="w-full sm:w-auto flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-slate-800/50 text-slate-300 text-xs sm:text-sm font-semibold hover:bg-slate-700 hover:text-white transition-all border border-slate-700 disabled:opacity-50"
                      >
                        <ExternalLink className="w-4 h-4" />
                        Expand
                      </button>
                    </div>
                  </div>

                  {/* Graph area */}
                  <div className={`rounded-xl overflow-auto border ${isDarkMode ? 'border-slate-700/50 bg-slate-800/30' : 'border-border bg-white'}`} style={{ height: 420 }}>
                    {(loadingData || graphLoading) && (
                      <div className="flex items-center justify-center h-full gap-3 text-slate-400">
                        <LoadingSpinner size="md" />
                        <span className="text-sm">Loading graph...</span>
                      </div>
                    )}

                    {!(loadingData || graphLoading) && editedData.length === 0 && (
                      <div className="flex flex-col items-center justify-center h-full gap-3 text-slate-500 px-8 text-center">
                        <BarChart2 className="w-12 h-12 text-slate-700" />
                        <p className="text-sm">No schedule data to plot</p>
                      </div>
                    )}

                      {!(loadingData || graphLoading) && editedData.length > 0 && (
                        <Plot
                          data={[...plotData, hoverMarkerTrace]}
                          layout={plotLayout}
                          config={{ displayModeBar: false, responsive: true }}
                          style={{ width: '100%', height: '100%' }}
                          useResizeHandler
                          onHover={handlePlotHover}
                          onUnhover={handlePlotUnhover}
                          onClick={handlePlotClick}
                          onLegendClick={handleLegendClick}
                          onLegendDoubleClick={handleLegendDoubleClick}
                        />
                      )}
                    </div>
                      {meterDebugInfo && (
                        <div className="mt-3 text-xs text-muted-foreground flex flex-wrap gap-3">
                          <span>Meter file: <span className="text-foreground">{meterDebugInfo.fileName}</span></span>
                          <span>Rows: <span className="text-foreground">{meterDebugInfo.rowCount ?? 'N/A'}</span></span>
                          <span>Min block: <span className="text-foreground">{meterDebugInfo.minBlock ?? 'N/A'}</span></span>
                          <span>Max block: <span className="text-foreground">{meterDebugInfo.maxBlock ?? 'N/A'}</span></span>
                          <span>Last timestamp: <span className="text-foreground">{meterDebugInfo.lastTimestamp ?? 'N/A'}</span></span>
                        </div>
                      )}
                      {Number.isFinite(meterMaxBlock) && meterMaxBlock < 96 && (
                        <p className="text-[11px] text-amber-300 mt-2">
                          Meter data available till Block {meterMaxBlock} ({blockToInterval(meterMaxBlock)}) N/A {meterDebugInfo?.lastTimestamp || 'timestamp N/A'}. Remaining blocks show as empty values.
                        </p>
                      )}
                    {graphError && <p className="mt-2 text-xs text-amber-300">{graphError}</p>}
                  </div>

              </div>

              {/* â”€â”€ Manual Changes Log â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
              {changes.length > 0 && (
                <div className="rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm p-4 sm:p-6">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4 sm:mb-6">
                    <div className="flex items-center gap-3">
                      <div className="p-3 rounded-xl bg-amber-500/10">
                        <Clock className="w-5 h-5 sm:w-6 sm:h-6 text-amber-400" />
                      </div>
                      <div>
                        <h3 className="text-lg sm:text-xl font-bold text-amber-400">Manual Changes Log</h3>
                        <p className="text-xs sm:text-sm text-slate-400">Track all modifications</p>
                      </div>
                    </div>
                    <div className="px-4 py-2 bg-amber-500/10 text-amber-400 text-xs sm:text-sm font-semibold rounded-xl border border-amber-500/20">
                      {changes.length} Changes
                    </div>
                  </div>
                  <div className="space-y-3">
                    {changes.map((change, i) => {
                      const rawTime = String(change.time || '').trim();
                      const displayTime = rawTime.replace(/^n\/a\s+/i, '').replace(/^n\/a$/i, '').trim();
                      const oldNum = Number.parseFloat(change.oldValue);
                      const newNum = Number.parseFloat(change.newValue);
                      const safeOld = Number.isFinite(oldNum) ? oldNum : 0;
                      const safeNew = Number.isFinite(newNum) ? newNum : 0;
                      const delta = safeNew - safeOld;
                      let pctLabel = '';
                      if (safeOld === 0) {
                        if (safeNew === 0) {
                          pctLabel = '0.0%';
                        } else {
                          pctLabel = `${delta >= 0 ? '+' : '-'}∞%`;
                        }
                      } else {
                        const pctValue = (delta / safeOld) * 100;
                        pctLabel = `${pctValue >= 0 ? '+' : ''}${pctValue.toFixed(1)}%`;
                      }
                      return (
                        <div key={i} className="p-4 sm:p-5 bg-slate-800/50 rounded-xl border border-slate-700/50 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 hover:bg-slate-800/70 transition-all group">
                          <div className="flex items-center gap-4">
                            <div className="p-3 bg-amber-500/10 rounded-xl group-hover:bg-amber-500/20 transition-colors">
                              <Clock className="w-5 h-5 text-amber-400" />
                            </div>
                            <div>
                              <p className="text-sm font-semibold text-white">
                                Block {change.block}{displayTime ? ` - ${displayTime}` : ''}
                              </p>
                              <p className="text-xs text-slate-400 mt-1">
                                <span className="text-red-400 font-semibold">{change.oldValue} MW</span>
                                {' -> '}
                                <span className="text-emerald-400 font-semibold">{change.newValue} MW</span>
                              </p>
                              {(() => {
                                const showRequestedBy = isAdmin && Boolean(change.requestedBy);
                                const showSavedAt = Boolean(change.savedAt);
                                if (!showRequestedBy && !showSavedAt) return null;
                                return (
                                <p className="text-[11px] text-slate-500 mt-1">
                                  {showRequestedBy ? `By ${change.requestedBy}` : ''}
                                  {showRequestedBy && showSavedAt ? ' | ' : ''}
                                  {showSavedAt ? `Saved ${new Date(change.savedAt).toLocaleString()}` : ''}
                                </p>
                                );
                              })()}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className={`text-sm font-semibold ${delta >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {pctLabel}
                            </span>
                            <TrendingUp className={`w-5 h-5 ${delta >= 0 ? 'text-emerald-400' : 'text-red-400'}`} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* â”€â”€ Schedule Table â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
              <div className="rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm overflow-hidden">
                <div className="p-4 sm:p-6 border-b border-slate-700/50 bg-gradient-to-r from-slate-800/50 to-transparent">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="p-3 rounded-xl bg-indigo-500/10">
                        <FileText className="w-5 h-5 sm:w-6 sm:h-6 text-indigo-400" />
                      </div>
                      <div>
                        <h3 className="text-lg sm:text-xl font-bold text-white">15-Minute Schedule Blocks</h3>
                        <p className="text-xs sm:text-sm text-slate-400">
                          {editedData.length} blocks N/A {effectiveScheduleDate}
                        </p>
                        {effectiveScheduleDate && !canEditScheduleDate && (
                          <p className="text-[11px] text-amber-300/90 mt-1">
                            {fromReadiness && context?.isDayAhead
                              ? `Editing is disabled for other dates. Only today (${todayIst}) and tomorrow (${tomorrowIst}) are editable in day-ahead flow.`
                              : `Editing is disabled for past/future dates. Only today (${todayIst}) is editable.`}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
                      {!editingMode ? (
                        <button
                          onClick={() => {
                            setEditingMode(true);
                            setSelectedRows([]);
                            setLastSelectedRow(null);
                            setActiveCell(null);
                            setCellDrafts({});
                            setBulkValue('');
                            // Guided workflow: highlight Save for READY flow, Force Save for direct/manual flow.
                            if (workflowGuide?.active) {
                              if (canSaveFromReadinessReadyFlow) workflowGuide.setStep?.('prep_save_ready');
                              else workflowGuide.setStep?.('prep_force_save');
                            } else {
                              if (canSaveFromReadinessReadyFlow) workflowGuide?.start?.('prep_save_ready');
                              else workflowGuide?.start?.('prep_force_save');
                            }
                          }}
                          data-guide-id="prep-edit"
                          disabled={!editedData.length || !canEditScheduleDate}
                          title={
                            !editedData.length
                              ? 'Load schedule data first'
                              : !canEditScheduleDate
                                ? (fromReadiness && context?.isDayAhead
                                    ? `Editing is allowed only for today (${todayIst}) and tomorrow (${tomorrowIst}) in day-ahead flow`
                                    : `Editing is allowed only for today (${todayIst})`)
                                : ''
                          }
                          className="w-full sm:w-auto px-4 sm:px-5 py-2.5 sm:py-3 rounded-xl bg-slate-800 text-slate-200 font-semibold hover:bg-slate-700 transition-all flex items-center justify-center gap-2 border border-slate-700 disabled:opacity-50"
                        >
                          <Edit3 className="w-4 h-4" />
                          Edit
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            onMouseEnter={() => showSubmitBlockedToast('hover')}
                            onFocus={() => showSubmitBlockedToast('hover')}
                            onClick={() => {
                              if (!canSaveFromReadinessReadyFlow) {
                                showSubmitBlockedToast('click');
                                return;
                              }
                              if (!workflowGuide?.active) workflowGuide?.start?.('prep_save_ready');
                              handleSaveEdits({ force: false });
                            }}
                            data-guide-id="prep-save"
                            disabled={!canSaveFromReadinessReadyFlow || !hasEdits || isOverwritingLatest}
                            title={
                              !canSaveFromReadinessReadyFlow
                                ? 'Please click on Upload button in Schedule Readiness to submit changes.'
                                : !hasEdits
                                  ? 'No changes to save'
                                  : ''
                            }
                            className="w-full sm:w-auto px-4 sm:px-5 py-2.5 sm:py-3 rounded-xl bg-emerald-600 text-white font-semibold hover:bg-emerald-500 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                          >
                            <CheckCircle className="w-4 h-4" />
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (!canForceSaveChanges) return;
                              if (!workflowGuide?.active) workflowGuide?.start?.('prep_force_save');
                              handleSaveEdits({ force: true });
                            }}
                            data-guide-id="prep-force-save"
                            disabled={!canForceSaveChanges || !hasEdits || isOverwritingLatest}
                            title={
                              !canForceSaveChanges
                                ? (canSaveFromReadinessReadyFlow
                                    ? 'This schedule is in READY flow. Use Save.'
                                    : 'READY schedule exists for this plant/date, use Save.')
                                : !hasEdits
                                  ? 'No changes to save'
                                  : 'Save even when Schedule Readiness Upload is not available for this plant/date.'
                            }
                            className="w-full sm:w-auto px-4 sm:px-5 py-2.5 sm:py-3 rounded-xl bg-amber-600 text-white font-semibold hover:bg-amber-500 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                          >
                            <AlertTriangle className="w-4 h-4" />
                            Force Save
                          </button>
                          <button
                            onClick={handleCancelEdits}
                            className="w-full sm:w-auto px-4 sm:px-5 py-2.5 sm:py-3 rounded-xl bg-slate-800 text-slate-200 font-semibold hover:bg-slate-700 transition-all flex items-center justify-center gap-2 border border-slate-700"
                          >
                            <X className="w-4 h-4" />
                            Cancel
                          </button>
                        </>
                      )}
                          <button
                            type="button"
                            onMouseEnter={() => showSubmitBlockedToast('hover')}
                            onFocus={() => showSubmitBlockedToast('hover')}
                            onClick={() => {
                              if (!canSubmitNow) {
                                showSubmitBlockedToast('click');
                                return;
                              }
                              setShowSubmitModal(true);
                              if (workflowGuide?.active) {
                                if (workflowGuide?.isStep?.('prep_submit')) {
                                  workflowGuide.next();
                                } else if (workflowGuide?.isStep?.('prep_edit')) {
                                  // User can submit without editing; jump ahead to Templates guidance.
                                  workflowGuide.setStep?.('tmpl_convert');
                                }
                              }
                            }}
                        data-guide-id="prep-submit"
                        disabled={!editedData.length || isSubmittingChanges || isOverwritingLatest}
                        title={
                          !canSubmitNow
                            ? getSubmitBlockedMessage()
                            : !editedData.length
                              ? 'Load schedule data first'
                              : ''
                        }
                        className={`w-full sm:w-auto px-5 sm:px-6 py-2.5 sm:py-3 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 text-white font-semibold transition-all duration-300 flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/25 disabled:opacity-50 disabled:cursor-not-allowed ${
                          canSubmitNow ? 'hover:from-emerald-500 hover:to-teal-500' : 'opacity-50 cursor-not-allowed'
                        }`}
                      >
                        <Upload className="w-5 h-5" />
                        Submit Changes
                      </button>
                      <button
                        onClick={() => { setDownloadFormat('csv'); setShowExportModal(true); }}
                        className="w-full sm:w-auto px-5 sm:px-6 py-2.5 sm:py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white font-semibold hover:from-indigo-500 hover:to-purple-500 transition-all duration-300 flex items-center justify-center gap-2 shadow-lg shadow-indigo-500/25"
                      >
                        <Download className="w-5 h-5" />
                        Export CSV
                      </button>
                    </div>
                  </div>
                </div>

                {editingMode && (
                  <div className="px-4 sm:px-6 py-3 border-b border-slate-700/70 bg-gradient-to-r from-slate-900/90 via-slate-900/80 to-slate-900/70">
                    <div className="flex flex-col lg:flex-row lg:items-center gap-3">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-slate-200">Bulk Apply</span>
                        <select
                          value={bulkColumn}
                          onChange={(e) => {
                            const next = String(e.target.value || '').trim();
                            setBulkColumn(next === 'dayAhead' ? 'dayAhead' : 'algo');
                            setActiveCell(null);
                            setCellDrafts({});
                          }}
                          className="px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-xs text-slate-200"
                        >
                          <option value="algo">System Schedule (MW)</option>
                          <option value="dayAhead">Day-ahead (MW)</option>
                        </select>
                      </div>
                      <div className="flex-1 flex flex-col sm:flex-row sm:items-center gap-2">
                        <input
                          value={bulkValue}
                          onChange={(e) => setBulkValue(e.target.value)}
                          placeholder="e.g. 100, +10%, =value * 1.1"
                          className="flex-1 px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-sm text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-400/70 focus:border-emerald-400/60"
                        />
                        <button
                          onClick={handleApplyBulk}
                          className="px-4 py-2 rounded-lg bg-emerald-500 text-white text-sm font-semibold hover:bg-emerald-400 transition-colors shadow-sm shadow-emerald-500/30"
                        >
                          Apply
                        </button>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
                        <div className="flex items-center gap-2">
                          <span className="text-slate-200 font-semibold">Range</span>
                          <input
                            type="number"
                            min="1"
                            max="96"
                            value={rangeStartBlock}
                            onChange={(e) => setRangeStartBlock(e.target.value)}
                            placeholder="Start"
                            className="w-20 px-2 py-1.5 rounded-md bg-slate-950 border border-slate-700 text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-400/60"
                          />
                          <span className="text-slate-400">to</span>
                          <input
                            type="number"
                            min="1"
                            max="96"
                            value={rangeEndBlock}
                            onChange={(e) => setRangeEndBlock(e.target.value)}
                            placeholder="End"
                            className="w-20 px-2 py-1.5 rounded-md bg-slate-950 border border-slate-700 text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-400/60"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              setRangeStartBlock('');
                              setRangeEndBlock('');
                            }}
                            className="px-2 py-1.5 rounded-md border border-slate-700 text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
                          >
                            Clear
                          </button>
                        </div>
                        <span className="text-slate-500">|</span>
                        <div>
                          Selected: <span className="text-white font-semibold">{selectedRows.length}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                <div className="overflow-auto max-h-[520px]">
                  <table className="w-full">
                    <thead
                      className={`sticky top-0 z-10 backdrop-blur-sm border-b ${
                        isDarkMode
                          ? 'bg-slate-800/90 border-slate-700/70'
                          : 'bg-slate-100 border-slate-200'
                      }`}
                    >
                      <tr>
                        {editingMode && (
                          <th
                            className={`px-4 sm:px-5 py-3 sm:py-4 text-left text-xs font-semibold uppercase tracking-wider whitespace-nowrap ${
                              isDarkMode ? 'text-white' : 'text-slate-900'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={editedData.length > 0 && selectedRows.length === editedData.length}
                              onChange={(e) => toggleSelectAll(e.target.checked)}
                              className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-indigo-500 focus:ring-indigo-500/60"
                            />
                          </th>
                        )}
                        {['Block', 'Time Period', 'System Schedule (MW)', 'Day-ahead (MW)', 'Intraday (MW)', 'Status'].map((h) => (
                          <th
                            key={h}
                            className={`px-4 sm:px-5 py-3 sm:py-4 text-left text-xs font-semibold uppercase tracking-wider whitespace-nowrap ${
                              isDarkMode ? 'text-white' : 'text-slate-900'
                            }`}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {editedData.map((row, i) => {
                        const rowEdited = isCellChanged(i, activeEditColumn);
                        const isSelected = selectedRows.includes(i);
                        const algoKey = getCellKey(i, 'algo');
                        const dayAheadKey = getCellKey(i, 'dayAhead');
                        const intradayKey = getCellKey(i, 'intraday');
                        const algoDraft = cellDrafts[algoKey];
                        const dayAheadDraft = cellDrafts[dayAheadKey];
                        const intradayDraft = cellDrafts[intradayKey];
                        const algoActive = activeCell?.rowIndex === i && activeCell?.column === 'algo';
                        const dayAheadActive = activeCell?.rowIndex === i && activeCell?.column === 'dayAhead';
                        const intradayActive = activeCell?.rowIndex === i && activeCell?.column === 'intraday';
                        const canEditAlgo = editingMode && activeEditColumn === 'algo';
                        const canEditDayAhead = editingMode && activeEditColumn === 'dayAhead';
                        const beyondMeterWindow = false;
                        return (
                          <tr
                            key={row.block}
                            className={`group hover:bg-slate-800/30 transition-all duration-200 ${
                              isSelected ? 'bg-indigo-500/10' : rowEdited ? 'bg-amber-500/5' : ''
                            }`}
                          >
                            {editingMode && (
                              <td className="px-4 sm:px-5 py-3 sm:py-4">
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={(e) => toggleRowSelection(i, e.target.checked, e.shiftKey)}
                                  className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-indigo-500 focus:ring-indigo-500/60"
                                />
                              </td>
                            )}
                            <td className={`px-4 sm:px-5 py-3 sm:py-4 text-xs sm:text-sm font-mono ${isDarkMode ? 'text-slate-500' : 'text-black'}`}>
                              {row.block}
                            </td>
                            <td className="px-4 sm:px-5 py-3 sm:py-4">
                              <div className="flex items-center gap-2">
                                <div className="p-1.5 bg-slate-800 rounded-lg group-hover:bg-slate-700 transition-colors">
                                  <Clock className={`w-3.5 h-3.5 ${isDarkMode ? 'text-slate-400' : 'text-black'}`} />
                                </div>
                                <span className={`text-xs sm:text-sm font-semibold ${isDarkMode ? 'text-white' : 'text-black'}`}>{blockToInterval(row.block)}</span>
                              </div>
                            </td>

                            {/* System Schedule editable */}
                            <td className="px-4 sm:px-5 py-3 sm:py-4">
                              {canEditAlgo ? (
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  value={algoDraft !== undefined ? algoDraft : row.algo}
                                  onChange={(e) => setCellDrafts((prev) => ({ ...prev, [algoKey]: e.target.value }))}
                                  onFocus={() => setActiveCell({ rowIndex: i, column: 'algo' })}
                                  onBlur={() => commitCellEdit(i, 'algo')}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      e.preventDefault();
                                      commitCellEdit(i, 'algo');
                                    }
                                    if (e.key === 'Escape') {
                                      e.preventDefault();
                                      cancelCellEdit(i, 'algo');
                                    }
                                  }}
                                  className={`w-28 sm:w-32 px-3 py-2 rounded-xl text-xs sm:text-sm font-semibold focus:outline-none transition-all ${
                                    isCellChanged(i, 'algo')
                                      ? 'bg-amber-500/10 border border-amber-500/40 text-amber-200'
                                      : 'bg-slate-800 border border-slate-700 text-indigo-300'
                                  } ${algoActive ? 'ring-2 ring-indigo-500/60' : ''}`}
                                />
                              ) : (
                                <span className="text-xs sm:text-sm font-semibold text-indigo-400">{row.algo}</span>
                              )}
                            </td>

                            <td className="px-4 sm:px-5 py-3 sm:py-4">
                              {canEditDayAhead ? (
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  value={dayAheadDraft !== undefined ? dayAheadDraft : (row.dayAhead ?? '0')}
                                  onChange={(e) => setCellDrafts((prev) => ({ ...prev, [dayAheadKey]: e.target.value }))}
                                  onFocus={() => setActiveCell({ rowIndex: i, column: 'dayAhead' })}
                                  onBlur={() => commitCellEdit(i, 'dayAhead')}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      e.preventDefault();
                                      commitCellEdit(i, 'dayAhead');
                                    }
                                    if (e.key === 'Escape') {
                                      e.preventDefault();
                                      cancelCellEdit(i, 'dayAhead');
                                    }
                                  }}
                                  className={`w-28 sm:w-32 px-3 py-2 rounded-xl text-xs sm:text-sm font-semibold focus:outline-none transition-all ${
                                    isCellChanged(i, 'dayAhead')
                                      ? 'bg-amber-500/10 border border-amber-500/40 text-amber-200'
                                      : 'bg-slate-800 border border-slate-700 text-teal-300'
                                  } ${dayAheadActive ? 'ring-2 ring-teal-500/60' : ''}`}
                                />
                              ) : (
                                <span className="text-xs sm:text-sm font-semibold text-teal-300">{row.dayAhead ?? '0'}</span>
                              )}
                            </td>

                            <td className="px-4 sm:px-5 py-3 sm:py-4">
                              <span className={`text-xs sm:text-sm ${isDarkMode ? 'text-slate-400' : 'text-black'}`}>
                                {row.intraday}
                              </span>
                            </td>
                            <td className="px-4 sm:px-5 py-3 sm:py-4">
                              {beyondMeterWindow ? (
                                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-700/50 text-slate-200 border border-slate-600/60">
                                  <Clock className="w-3 h-3" /> Awaiting meter
                                </span>
                              ) : rowEdited ? (
                                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                                  <Edit3 className="w-3 h-3" /> Modified
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                  <CheckCircle className="w-3 h-3" /> Original
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
          MODALS
      â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */}

      {/* Graph Modal */}
      {showGraphModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className={`rounded-2xl shadow-2xl w-full max-w-6xl border ${isDarkMode ? 'bg-slate-900 border-slate-700' : 'bg-card border-border'}`}>
            <div className={`px-6 py-5 flex items-center justify-between ${isDarkMode ? 'border-b border-slate-700 bg-gradient-to-r from-slate-800/50 to-transparent' : 'border-b border-border bg-muted/50'}`}>
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-indigo-500/10">
                  <BarChart2 className="w-6 h-6 text-indigo-400" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-foreground">Schedule Graph</h2>
                  <p className="text-sm text-muted-foreground">{loadedScheduleInfo?.date || selectedDate}</p>
                </div>
              </div>
              <button
                onClick={() => setShowGraphModal(false)}
                className={`p-2 rounded-lg transition-colors ${isDarkMode ? 'hover:bg-slate-800' : 'hover:bg-muted'}`}
              >
                <X className="w-5 h-5 text-muted-foreground" />
              </button>
            </div>
            <div className="p-6">
              <div className={`h-[70vh] rounded-xl overflow-auto border ${isDarkMode ? 'border-slate-700/50 bg-slate-800/30' : 'border-border bg-white'}`}>
                {editedData.length > 0 ? (
                  <Plot
                    data={[...plotData, hoverMarkerTrace]}
                    layout={plotLayout}
                    config={{ displayModeBar: false, responsive: true }}
                    style={{ width: '100%', height: '100%' }}
                    useResizeHandler
                    onHover={handlePlotHover}
                    onUnhover={handlePlotUnhover}
                    onClick={handlePlotClick}
                    onLegendClick={handleLegendClick}
                    onLegendDoubleClick={handleLegendDoubleClick}
                  />
                ) : (
                  <div className="flex items-center justify-center h-full text-slate-500">
                    No schedule data to plot
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Export Modal */}
      {showExportModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 rounded-2xl shadow-2xl w-full max-w-md border border-slate-700">
            <div className="px-6 py-4 border-b border-slate-700">
              <h2 className="text-lg font-semibold text-white">Export Schedule</h2>
              <p className="text-sm text-slate-400 mt-1">Download all {editedData.length} blocks</p>
            </div>
            <div className="p-6">
              <p className="text-sm font-semibold text-black mb-4">Select file format:</p>
              <div className="space-y-3">
                <label className="flex items-center gap-3 text-sm text-slate-200">
                  <input
                    type="radio"
                    name="schedule-export-format"
                    value="csv"
                    checked={downloadFormat === 'csv'}
                    onChange={() => setDownloadFormat('csv')}
                    className="h-4 w-4 text-indigo-500 border-slate-600 bg-slate-800 focus:ring-indigo-500/60"
                  />
                  CSV
                </label>
                <label className="flex items-center gap-3 text-sm text-slate-200">
                  <input
                    type="radio"
                    name="schedule-export-format"
                    value="xlsx"
                    checked={downloadFormat === 'xlsx'}
                    onChange={() => setDownloadFormat('xlsx')}
                    className="h-4 w-4 text-indigo-500 border-slate-600 bg-slate-800 focus:ring-indigo-500/60"
                  />
                  Excel (.xlsx)
                </label>
              </div>
              <p className="text-xs text-amber-300 mt-3">
                Overwrite Latest will replace the current latest schedule_from_XX.csv in S3 (no revision history).
              </p>
            </div>
            <div className="px-6 py-4 border-t border-slate-700 flex gap-3">
              <button onClick={() => setShowExportModal(false)} className="flex-1 px-4 py-2 rounded-xl border border-slate-700 text-slate-300 hover:bg-slate-800 transition-all font-medium">Cancel</button>
              <button onClick={() => handleExport(downloadFormat)} className="flex-1 px-4 py-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-500 transition-all font-medium flex items-center justify-center gap-2">
                <Download className="w-4 h-4" /> Download
              </button>
              <button
                onClick={handleOverwriteLatest}
                disabled={isOverwritingLatest}
                className="flex-1 px-4 py-2 rounded-xl bg-amber-600 text-white hover:bg-amber-500 transition-all font-medium flex items-center justify-center gap-2 disabled:opacity-60"
              >
                {isOverwritingLatest ? 'Saving...' : 'Overwrite Latest'}
              </button>
            </div>
          </div>
        </div>
      )}


      {/* Validation Modal */}
      {showValidationModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 rounded-2xl shadow-2xl w-full max-w-lg border border-slate-700">
            <div className="px-6 py-4 border-b border-slate-700">
              <h2 className="text-lg font-semibold text-white">Validation Results</h2>
            </div>
            <div className="p-6 space-y-4">
              {validationErrors.length === 0 ? (
                <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl flex gap-3">
                  <CheckCircle className="w-6 h-6 text-emerald-400 flex-shrink-0" />
                  <div><p className="font-semibold text-emerald-400">Validation Passed</p>
                    <p className="text-sm text-slate-300 mt-1">All blocks are valid.</p></div>
                </div>
              ) : (
                <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex gap-3">
                  <AlertTriangle className="w-6 h-6 text-red-400 flex-shrink-0" />
                  <div><p className="font-semibold text-red-400">Validation Failed</p>
                    <ul className="text-sm text-slate-300 mt-1 list-disc list-inside space-y-1">
                      {validationErrors.map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  </div>
                </div>
              )}
              <div className="space-y-2">
                {[['Total Blocks', editedData.length], ['Modified', changes.length]].map(([k, v]) => (
                  <div key={k} className="flex justify-between p-3 bg-slate-800/50 rounded-xl">
                    <span className="text-sm text-slate-400">{k}</span>
                    <span className="text-sm font-semibold text-white">{v}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="px-6 py-4 border-t border-slate-700">
              <button onClick={() => setShowValidationModal(false)}
                className={`w-full px-4 py-2 rounded-xl font-medium transition-all ${validationErrors.length === 0 ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'border border-slate-700 text-slate-300 hover:bg-slate-800'}`}>
                {validationErrors.length === 0 ? 'Continue' : 'Close'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 rounded-2xl shadow-2xl w-full max-w-md border border-slate-700">
            <div className="px-6 py-4 border-b border-red-500/20 bg-red-500/5">
              <h2 className="text-lg font-semibold text-white">Delete Schedule</h2>
              <p className="text-sm text-slate-400 mt-1">This action cannot be undone</p>
            </div>
            <div className="p-6">
              <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex gap-3">
                <AlertTriangle className="w-6 h-6 text-red-400 flex-shrink-0" />
                <p className="text-sm text-slate-300">All schedule data for {loadedScheduleInfo?.date} will be cleared.</p>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-slate-700 flex gap-3">
              <button onClick={() => setShowDeleteModal(false)} className="flex-1 px-4 py-2 rounded-xl border border-slate-700 text-slate-300 hover:bg-slate-800 transition-all font-medium">Cancel</button>
              <button onClick={handleDeleteSchedule} disabled={deleteLoading} className="flex-1 px-4 py-2 rounded-xl bg-red-600 text-white hover:bg-red-500 transition-all font-medium disabled:opacity-50">
                {deleteLoading ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Submit Modal */}
      {showSubmitModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 rounded-2xl shadow-2xl w-full max-w-md border border-slate-700">
            <div className="px-6 py-4 border-b border-emerald-500/20 bg-emerald-500/5">
              <h2 className="text-lg font-semibold text-white">Submit Schedule</h2>
              <p className="text-sm text-slate-400 mt-1">Confirm submission</p>
            </div>
            <div className="p-6 space-y-3">
              {[
                ['Plant', loadedScheduleInfo?.plant || plantsData.plants[0]?.name || S3_PLANTS[0].name],
                ['Date', loadedScheduleInfo?.date || selectedDate],
                ['Modified Blocks', hasEdits
                  ? getChangedRows().length
                  : (
                    String(lastSavedManualRequest?.plantCode || '').trim().toUpperCase() === String(getPlantCodeForChanges() || '').trim().toUpperCase()
                    && String(lastSavedManualRequest?.scheduleDate || '').trim() === String(loadedScheduleInfo?.date || selectedDate || '').trim()
                      ? (lastSavedManualRequest?.changedBlocks ?? 0)
                      : 0
                  )
                ],
                ['Request ID', hasEdits
                  ? 'Will create on submit'
                  : (
                    String(lastSavedManualRequest?.plantCode || '').trim().toUpperCase() === String(getPlantCodeForChanges() || '').trim().toUpperCase()
                    && String(lastSavedManualRequest?.scheduleDate || '').trim() === String(loadedScheduleInfo?.date || selectedDate || '').trim()
                      ? (lastSavedManualRequest?.requestId || 'Latest (from S3)')
                      : 'Latest (from S3)'
                  )
                ],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between p-3 bg-slate-800/50 rounded-xl">
                  <span className="text-sm text-slate-400">{k}</span>
                  <span className="text-sm font-semibold text-white">{v}</span>
                </div>
              ))}
            </div>
            <div className="px-6 py-4 border-t border-slate-700 flex gap-3">
              <button onClick={() => setShowSubmitModal(false)} className="flex-1 px-4 py-2 rounded-xl border border-slate-700 text-slate-300 hover:bg-slate-800 transition-all font-medium">Cancel</button>
              <button
                onClick={handleSubmitToDatabase}
                disabled={isSubmittingChanges || isOverwritingLatest}
                className="flex-1 px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-500 transition-all font-medium disabled:opacity-50"
              >
                {isSubmittingChanges ? 'Submitting...' : 'Submit'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

















