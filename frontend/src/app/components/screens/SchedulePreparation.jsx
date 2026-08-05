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
  BarChart2,
  ExternalLink,
  X,
  Loader2,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { api, scheduleReadinessApi, schedulesApi, vedanjaySldcSchedulesApi } from '@/services/api';
import { useApi } from '@/hooks/useApi';
import { LoadingSpinner } from '@/app/components/common/LoadingSpinner';
import { buildCsvText, downloadCsvText, downloadXlsxFromRows } from '@/app/components/common/downloadUtils';
import { useAuth, useTheme, useWorkflowGuide } from '@/app/appContexts';
import { toast } from 'sonner';
import { S3_BASE_URL } from '@/config/appConfig';
import { CHART_COLORS, getActualLineColor } from '@/config/chartPalette';
import { fetchTextFromS3Optional } from '@/services/s3Utils';
import { DSM_PENALTY_CONFIG_BY_STATE, DEFAULT_DSM_PENALTY_CONFIG } from '@/config/dsmPenaltyConfig';
import { calculatePenaltyRs as calculatePenaltyRsShared } from '@/shared/freezeRules';
import { findGsnpTvmActivePowerIndex, resolveMeterMwFactor } from '@/utils/meterUnit';
import { parseBlockFromTimestamp } from '@/utils/meterTime';
import { filterPlantsForUser, getDisabledPlantPattern } from '@/utils/plantAccess';
import {
  computeIntradayRunIndexByKey,
  formatMachineScheduleDisplayName,
} from '@/utils/machineScheduleDisplay';

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
  ANDAD: 'raw/vedanjay/ANDAD/',
  BALAKWADA: 'raw/vedanjay/BALAKWADA/',
  GUGARIYAKHEDI: 'raw/vedanjay/GUGARIYAKHEDI/',
  NANDGAON: 'raw/vedanjay/NANDGAON/',
  BAMKHAL: 'raw/vedanjay/BAMKHAL/',
  SAWDA: 'raw/vedanjay/SAWDA/',
  ZETRIC: 'raw/vedanjay/multiple_generator/ZTRIC/',
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
const VEDANJAY_OUTPUTS_BASE_PREFIXES = {
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
  SAWDA: 'generated/vedanjay/SAWDA/outputs/',
  ZETRIC: 'generated/vedanjay/multiple_generator/ZTRIC/',
  SIRMOUR: 'generated/vedanjay/SIRMOUR/outputs/',
  ANJANGAON: 'generated/vedanjay/ANJANGAON/outputs/',
  ANJANGOAN: 'generated/vedanjay/ANJANGOAN/outputs/',
};
const GENERATED_OUTPUTS_BASE_PREFIXES = VEDANJAY_OUTPUTS_BASE_PREFIXES;
const LEGACY_OUTPUTS_BASE_PREFIX = 'outputs/';
const GSNP_INTRADAY_PREFIX = 'gsnp_dc_reg_';
const DSM_EPSILON = 0.001;
const SLDC_UPLOAD_REFRESH_EVENT = 'vedanjay:sldc-upload-refresh';
const PREPARATION_S3_LIST_CACHE_TTL_MS = 15_000;
const preparationS3ListCache = new Map();

function getPreparationS3ListCacheKey(prefixes, limit = 5000) {
  return JSON.stringify({
    prefixes: Array.from(new Set((prefixes || []).map((prefix) => String(prefix || '').trim()).filter(Boolean))).sort(),
    limit: Number(limit || 5000),
  });
}

function getPreparationCachedS3List(prefixes, limit = 5000) {
  const key = getPreparationS3ListCacheKey(prefixes, limit);
  const entry = preparationS3ListCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > PREPARATION_S3_LIST_CACHE_TTL_MS) {
    preparationS3ListCache.delete(key);
    return null;
  }
  return entry.items;
}

function setPreparationCachedS3List(prefixes, items, limit = 5000) {
  if (preparationS3ListCache.size > 250) preparationS3ListCache.clear();
  preparationS3ListCache.set(getPreparationS3ListCacheKey(prefixes, limit), {
    ts: Date.now(),
    items: Array.isArray(items) ? items : [],
  });
}
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
  {
    id: 10,
    code: 'BAMKHAL',
    name: 'BAMKHAL',
    state: 'Madhya Pradesh',
    type: 'Solar',
    capacityMw: 5,
    latitude: 21.93,
    longitude: 75.671111,
  },
  {
    id: 11,
    code: 'ANDAD',
    name: 'ANDAD',
    state: 'Madhya Pradesh',
    type: 'Solar',
    capacityMw: 7.5,
    latitude: 21.95972222,
    longitude: 75.80583333,
  },
  {
    id: 12,
    code: 'GUGARIYAKHEDI',
    name: 'GUGARIYAKHEDI',
    state: 'Madhya Pradesh',
    type: 'Solar',
    capacityMw: 7.5,
    latitude: 21.83944444,
    longitude: 75.71888889,
  },
  {
    id: 13,
    code: 'BALAKWADA',
    name: 'BALAKWADA',
    state: 'Madhya Pradesh',
    type: 'Solar',
    capacityMw: 7.5,
    latitude: 22.00583333,
    longitude: 75.52333333,
  },
  {
    id: 14,
    code: 'NANDGAON',
    name: 'NANDGAON',
    state: 'Madhya Pradesh',
    type: 'Solar',
    capacityMw: 7.5,
    latitude: 21.88222222,
    longitude: 75.48027778,
  },
  {
    id: 15,
    code: 'SAWDA',
    name: 'SAWDA',
    state: 'Madhya Pradesh',
    type: 'Solar',
    capacityMw: 7.5,
  },
  {
    id: 16,
    code: 'ZETRIC',
    name: 'ZETRIC',
    state: 'Maharashtra',
    type: 'Solar',
    capacityMw: 25,
    latitude: 18.557968,
    longitude: 76.859083,
  },
  {
    id: 9,
    code: 'ANJANGAON',
    name: 'ANJANGAON',
    state: 'Madhya Pradesh',
    type: 'Solar',
    capacityMw: 7.5,
  },
];
const DSM_DEFAULT_ALLOWED_LIMIT_PERCENT = 10;

function getAllowedBandPercent(plantState, plantType) {
  const config = DSM_PENALTY_CONFIG_BY_STATE[plantState] || DEFAULT_DSM_PENALTY_CONFIG;
  const typeConfig = config.byType?.[plantType] || config.byType?.Solar;
  return typeConfig?.baseBand ?? DSM_DEFAULT_ALLOWED_LIMIT_PERCENT;
}

function formatDsmMw(value, decimals = 2, fallback = '-') {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return num.toFixed(decimals);
}

function calcDsmAccuracyPercent(scheduledMw, actualMw) {
  const scheduled = Number(scheduledMw);
  const actual = Number(actualMw);
  if (!Number.isFinite(scheduled) || !Number.isFinite(actual)) return null;
  if (Math.abs(actual) <= DSM_EPSILON) {
    return Math.abs(scheduled) <= DSM_EPSILON ? 100 : 0;
  }
  const raw = (1 - (Math.abs(actual - scheduled) / Math.abs(actual))) * 100;
  if (!Number.isFinite(raw)) return 0;
  return Math.min(100, Math.max(0, raw));
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
  if (code === 'ANJANGOAN') return 'ANJANGAON';
  if (code === 'ZETRICSOLARPARK') return 'ZETRIC';
  // Backend / user inputs sometimes send OSEL; S3 and internal prefixes use OSEPL.
  if (code === 'OSEL') return 'OSEPL';
  return code;
}

function getSpecialS3PlantFolder(value) {
  const code = normalizePlantCode(value);
  if (code === 'ANJANGAON') return 'ANJANGOAN';
  return code;
}

function getSpecialS3PlantFolderAliases(value) {
  const normalized = normalizePlantCode(value);
  const preferred = getSpecialS3PlantFolder(value);
  return Array.from(new Set([preferred, normalized].filter(Boolean)));
}

function getGeneratedPlantCodeAliases(code) {
  const normalized = normalizePlantCode(code);
  if (normalized === 'ANJANGAON') return ['ANJANGAON', 'ANJANGOAN'];
  return normalized ? [normalized] : [];
}

function isZetricCode(value) {
  return normalizePlantCode(value) === 'ZETRIC';
}

function derivePlantCodeFromName(name) {
  const text = String(name || '').trim();
  if (!text) return null;
  const match = text.match(/\(([A-Za-z0-9_-]+)\)/);
  if (match) return match[1].toUpperCase();
  if (/^[A-Z0-9_-]{2,6}$/.test(text)) return text.toUpperCase();
  const compact = text.replace(/[^A-Za-z0-9]/g, '');
  if (!compact) return null;
  const code = compact.toUpperCase();
  return code === 'ZETRICSOLARPARK' ? 'ZETRIC' : code;
}

function getPlantCodeKey(plant) {
  return normalizePlantCode(
    plant?.code
    || derivePlantCodeFromName(plant?.name)
    || plant?.name
    || ''
  );
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
  if (isZetricCode(code)) return Array.from(new Set(prefixes));
  if (String(code || '').trim().toUpperCase() === 'ANJANGAON') prefixes.push('raw/vedanjay/ANJANGOAN/');
  if (code && LEGACY_RAW_BASE_PREFIXES[code]) prefixes.push(LEGACY_RAW_BASE_PREFIXES[code]);
  const derived = derivePlantFolders(plant || { code });
  if (derived) {
    prefixes.push(`raw/vedanjay/${derived.upper}/`);
    if (derived.upper === 'ANJANGAON') prefixes.push('raw/vedanjay/ANJANGOAN/');
    prefixes.push(`raw/${derived.folder}/${derived.lower}/`);
  }
  return Array.from(new Set(prefixes));
}

function getPlantGeneratedPrefixes(plant) {
  const prefixes = [];
  const code = plant?.code || derivePlantCodeFromName(plant?.name);
  getGeneratedPlantCodeAliases(code).forEach((alias) => {
    if (GENERATED_OUTPUTS_BASE_PREFIXES[alias]) prefixes.push(GENERATED_OUTPUTS_BASE_PREFIXES[alias]);
  });
  if (isZetricCode(code)) return Array.from(new Set(prefixes));
  if (code && LEGACY_GENERATED_OUTPUTS_BASE_PREFIXES[code]) prefixes.push(LEGACY_GENERATED_OUTPUTS_BASE_PREFIXES[code]);
  const derived = derivePlantFolders(plant || { code });
  if (derived) {
    prefixes.push(`generated/vedanjay/${derived.upper}/outputs/`);
    if (derived.upper === 'ANJANGAON') prefixes.push('generated/vedanjay/ANJANGOAN/outputs/');
    prefixes.push(`generated/${derived.folder}/${derived.lower}/outputs/`);
  }
  return Array.from(new Set(prefixes));
}

// =============================================================================
// S3 HELPERS
// =============================================================================
async function listS3Objects(prefix) {
  const normalizedPrefix = String(prefix || '').trim();
  const cached = getPreparationCachedS3List([normalizedPrefix], 5000);
  if (cached) return cached;
  try {
    const proxyResp = await fetch('/api/s3/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [normalizedPrefix], limit: 5000 }),
    });
    if (!proxyResp.ok) return [];
    const payload = await proxyResp.json().catch(() => ({}));
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const parsed = items
      .map((item) => ({
        key: String(item?.key || '').trim(),
        lastModified: String(item?.last_modified || item?.lastModified || '').trim(),
      }))
      .filter((item) => item.key);
    setPreparationCachedS3List([normalizedPrefix], parsed, 5000);
    return parsed;
  } catch {
    return [];
  }
}

async function listS3ObjectsAcrossPrefixes(prefixes, userOrRole = null) {
  const started = performance.now();
  const disabledPattern = getDisabledPlantPattern(userOrRole);
  const safePrefixes = Array.from(new Set(
    (prefixes || [])
      .map((prefix) => String(prefix || '').trim())
      .filter((prefix) => prefix && !disabledPattern.test(prefix))
  ));
  const batchSize = 25;
  const batches = [];
  for (let i = 0; i < safePrefixes.length; i += batchSize) {
    batches.push(safePrefixes.slice(i, i + batchSize));
  }
  const listBatch = async (batch) => {
    const cached = getPreparationCachedS3List(batch, 5000);
    if (cached) return cached;
    try {
      const proxyResp = await fetch('/api/s3/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: batch, limit: 5000 }),
      });
      if (!proxyResp.ok) return [];
      const payload = await proxyResp.json().catch(() => ({}));
      const parsed = (Array.isArray(payload?.items) ? payload.items : [])
        .map((item) => ({
          key: String(item?.key || '').trim(),
          lastModified: String(item?.last_modified || item?.lastModified || '').trim(),
        }))
        .filter((item) => item.key);
      setPreparationCachedS3List(batch, parsed, 5000);
      return parsed;
    } catch {
      return [];
    }
  };
  const settled = [];
  const concurrency = 4;
  for (let i = 0; i < batches.length; i += concurrency) {
    const chunk = batches.slice(i, i + concurrency);
    const chunkSettled = await Promise.allSettled(chunk.map((batch) => listBatch(batch)));
    settled.push(...chunkSettled);
  }
  const result = settled
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value || []);
  console.debug(`[timing] preparation s3-list prefixes=${safePrefixes.length} batches=${batches.length} elapsed_ms=${Math.round(performance.now() - started)} items=${result.length}`);
  return result;
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
    ...getSpecialS3PlantFolderAliases(code).map((folder) => `frozenschedules/vedanjay/${folder}/${date}/`),
    ...generatedPrefixes.map((prefix) => `${prefix}${date}/frozen/`),
    `${LEGACY_OUTPUTS_BASE_PREFIX}${date}/frozen/`,
  ];
}

function getIntradayPrefixes(date, plant) {
  const code = String(plant?.code || derivePlantCodeFromName(plant?.name) || '').trim().toUpperCase();
  if (isZetricCode(code)) {
    return [`raw/vedanjay/multiple_generator/ZTRIC/${date}/enercast_data/intraday/`];
  }
  const derived = derivePlantFolders(plant || { code });
  const rawPrefixes = [];
  if (code) rawPrefixes.push(`raw/vedanjay/${code}/`);
  if (code === 'ANJANGAON') rawPrefixes.push('raw/vedanjay/ANJANGOAN/');
  if (derived?.upper) rawPrefixes.push(`raw/vedanjay/${derived.upper}/`);
  if (derived?.upper === 'ANJANGAON') rawPrefixes.push('raw/vedanjay/ANJANGOAN/');
  return Array.from(new Set(rawPrefixes)).map((prefix) => `${prefix}${date}/enercast_data/intraday/`);
}

function getDayAheadPrefixes(date, plant) {
  const code = String(plant?.code || derivePlantCodeFromName(plant?.name) || '').trim().toUpperCase();
  if (isZetricCode(code)) {
    return [
      `generated/vedanjay/multiple_generator/ZTRIC/${date}/Day-ahead/`,
      `raw/vedanjay/multiple_generator/ZTRIC/${date}/enercast_data/day_ahead/`,
    ];
  }
  const derived = derivePlantFolders(plant || { code });
  const prefixes = [];
  getGeneratedPlantCodeAliases(code).forEach((alias) => {
    prefixes.push(`generated/vedanjay/${alias}/outputs/${date}/Day-ahead/`);
  });
  if (derived?.upper) prefixes.push(`generated/vedanjay/${derived.upper}/outputs/${date}/Day-ahead/`);
  if (derived?.upper === 'ANJANGAON') prefixes.push(`generated/vedanjay/ANJANGOAN/outputs/${date}/Day-ahead/`);
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
  const code = normalizePlantCode(String(plant?.code || derivePlantCodeFromName(plant?.name) || '').trim().toUpperCase());
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
  return `manual-edits/vedanjay/${getSpecialS3PlantFolder(code)}/${date}/${folder}/`;
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
function parseScheduleCsv(text, options = {}) {
  const plantCode = String(options?.plantCode || '').trim().toUpperCase();
  const isZetricPlant = plantCode === 'ZETRIC' || plantCode === 'ZTRIC';
  const lines = text.split(/\r?\n/).filter((line) => line && line.trim().length > 0);
  if (!lines.length) return [];

  // Find real header row (supports files with meta lines before headers).
  const headerIdx = lines.findIndex((line) => {
    const l = String(line || '').toLowerCase();
    return (l.includes('block') || l.includes('blk')) &&
      (l.includes('schedule') || l.includes('forecast') || l.includes('timestamp') || l.includes('ztric') || l.includes('zetric') || l.includes('mw') || l.includes('availability'));
  });

  const csvTextFromHeader = headerIdx > 0 ? lines.slice(headerIdx).join('\n') : text;
  const { headers, rows } = parseCsv(csvTextFromHeader);
  if (!headers.length) return [];

  const normalized = headers.map((h) =>
    h.toLowerCase().replace(/["']/g, '').replace(/[\s_-]+/g, '')
  );
  const findCol = (matchers) =>
    normalized.findIndex((h) => matchers.some((m) => h.includes(m)));

  const blockCol = findCol(['block', 'blockno', 'blkno', 'blk']);
  const zetricSourceForecastCol = isZetricPlant ? findCol(['sourceforecastmw', 'sourceforecast']) : -1;
  const zetricScheduleCol = findCol(['ztricpark', 'zetricpark', 'ztric', 'zetric']);
  const algoCol = zetricSourceForecastCol >= 0 ? zetricSourceForecastCol : zetricScheduleCol >= 0 ? zetricScheduleCol : findCol([
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

function parseZetricDayAheadCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((line) => line && line.trim().length > 0);
  if (!lines.length) return [];
  const headerIdx = lines.findIndex((line) => {
    const l = String(line || '').toLowerCase();
    return (l.includes('block') || l.includes('blk')) && l.includes('source_forecast_mw');
  });
  if (headerIdx < 0) return [];
  const { headers, rows } = parseCsv(lines.slice(headerIdx).join('\n'));
  const norm = headers.map((h) => String(h || '').toLowerCase().replace(/["']/g, '').replace(/[^a-z0-9]+/g, ''));
  const blockIdx = norm.findIndex((h) => h === 'block' || h === 'blockno' || h === 'blk' || h === 'blkno');
  const sourceForecastIdx = norm.findIndex((h) => h === 'sourceforecastmw' || h === 'sourceforecast');
  if (sourceForecastIdx < 0) return [];
  return (rows || [])
    .map((cols, idx) => {
      const blockRaw = blockIdx >= 0 ? cols[blockIdx] : idx + 1;
      const block = Number.parseInt(String(blockRaw || '').trim(), 10);
      const value = toUiNumericText(cols[sourceForecastIdx]);
      return {
        block: Number.isFinite(block) ? block : idx + 1,
        time: blockToTime(Number.isFinite(block) ? block : idx + 1),
        algo: value,
        base: value,
        intraday: '0',
        condition: 'DAY_AHEAD_SOURCE_FORECAST',
      };
    })
    .filter((r) => r.block >= 1 && r.block <= 96);
}

function parseDayAheadCsv(text, options = {}) {
  const plantCode = String(options?.plantCode || '').trim().toUpperCase();
  if (isZetricCode(plantCode)) {
    const zetricRows = parseZetricDayAheadCsv(text);
    if (zetricRows.length) return zetricRows;
  }
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

const ZETRIC_FALLBACK_METER_ASSET_NAMES = [
  'polybond',
  'sn heat',
  'integrated',
  'de solar',
  'indiqube',
  'gajlaxmi',
  'chakur one block 1',
  'chakur one block 2',
];

function compactMeterHeader(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/["']/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function getConfiguredZetricMeterAssetTokens(config) {
  const plants = Array.isArray(config?.template_config?.multi_generator_plants)
    ? config.template_config.multi_generator_plants
    : [];
  const activePlant = plants.find((plant) => Array.isArray(plant?.assets) && plant.assets.length) || {};
  const configuredAssets = Array.isArray(activePlant?.assets)
    ? activePlant.assets
    : Array.isArray(config?.assets)
      ? config.assets
      : [];
  const names = configuredAssets
    .filter((asset) => asset?.meterAvailable !== false && asset?.meter_available !== false)
    .map((asset) => asset?.assetName || asset?.asset_name || asset?.name || '')
    .filter(Boolean);
  const sourceNames = names.length ? names : ZETRIC_FALLBACK_METER_ASSET_NAMES;
  return sourceNames.map(compactMeterHeader).filter(Boolean);
}

function isZetricMeterAssetFile(key, assetTokens) {
  const token = compactMeterHeader(`${key || ''} ${String(key || '').split('/').pop() || ''}`);
  return assetTokens.some((assetToken) => assetToken && token.includes(assetToken));
}

function sumMeterRowsByBlock(rowSets) {
  const byBlock = new Map();
  (rowSets || []).forEach((rows) => {
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      const block = Number(row?.block);
      const generationMw = Number(row?.generationMw);
      if (!Number.isFinite(block) || !Number.isFinite(generationMw)) return;
      byBlock.set(block, (byBlock.get(block) || 0) + generationMw);
    });
  });
  return Array.from(byBlock.entries())
    .map(([block, generationMw]) => ({ block, generationMw }))
    .sort((a, b) => a.block - b.block);
}

function parseMeterCsvByBlock(text, options = {}) {
  const { headers, rows } = parseCsv(text);
  const normalizedHeaders = headers.map((h) => h.trim().toLowerCase());
  const compactHeaders = headers.map(compactMeterHeader);
  const blockIdx = compactHeaders.findIndex((h) =>
    h === 'block' || h === 'blk' || h === 'blockno' || h === 'blocknumber'
  );
  const timeIdx = normalizedHeaders.findIndex((h) => h.includes('time'));
  const isZetricMeter = isZetricCode(options?.plantCode || options?.plant_code);
  const zetricAssetTokens = isZetricMeter ? getConfiguredZetricMeterAssetTokens(options?.zetricConfig) : [];
  const zetricPowerIndexes = isZetricMeter
    ? compactHeaders
      .map((header, idx) => ({ header, idx }))
      .filter(({ header, idx }) => {
        if (idx === blockIdx || idx === timeIdx) return false;
        if (!header) return false;
        if (['date', 'datetime', 'timestamp', 'time', 'interval', 'blockinterval'].includes(header)) return false;
        if (/(schedule|forecast|availability|avc|condition|status|remark|total|sum)/i.test(header)) return false;
        return zetricAssetTokens.some((token) => token && header.includes(token));
      })
      .map(({ idx }) => idx)
    : [];
  const gsnpTvmPowerIdx = findGsnpTvmActivePowerIndex(headers, {
    plantCode: options?.plantCode || options?.plant_code,
    plantName: options?.plantName || options?.plant_name,
    sourceKey: options?.sourceKey || options?.source_key,
  });
  let powerIdx = gsnpTvmPowerIdx !== -1
    ? gsnpTvmPowerIdx
    : compactHeaders.findIndex((h) =>
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
  if (powerIdx === -1 && !zetricPowerIndexes.length) return [];

  const getBlockFromTimeText = (raw) => parseBlockFromTimestamp(raw, { totalBlocks: 96 });

  const powerHeaders = zetricPowerIndexes.length
    ? zetricPowerIndexes.map((idx) => normalizedHeaders[idx] || '')
    : [normalizedHeaders[powerIdx] || ''];
  const powerHeader = powerHeaders.join(' ');
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
      const powerValues = zetricPowerIndexes.length
        ? zetricPowerIndexes
          .map((idx) => parseFloat(String(cols[idx] ?? '').replace(/,/g, '').trim()))
          .filter(Number.isFinite)
        : [parseFloat(String(cols[powerIdx] ?? '').replace(/,/g, '').trim())].filter(Number.isFinite);
      const power = powerValues.reduce((sum, value) => sum + value, 0);
      if (!Number.isFinite(block) || block < 1 || block > 96 || !powerValues.length || !Number.isFinite(power)) return null;
      const mw = power; // unit normalization applied after parsing
      return { block, generationMw: mw };
    })
    .filter(Boolean);

  const nonZero = parsed.map((x) => x.generationMw).filter((v) => Number.isFinite(v) && v > 0);
  const avg = nonZero.length ? (nonZero.reduce((a, b) => a + b, 0) / nonZero.length) : 0;
  const factor = resolveMeterMwFactor({
    plantCode: options?.plantCode || options?.plant_code,
    plantName: options?.plantName || options?.plant_name,
    sourceKey: options?.sourceKey || options?.source_key,
    explicitKw,
    explicitMw,
    averageValue: avg,
  });

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
  const [showTableGraph,      setShowTableGraph]      = useState(false);
  const [tableGraphColumn,    setTableGraphColumn]    = useState('algo');
  const [showDsmCheck,        setShowDsmCheck]        = useState(false);
  const [hoverMarker, setHoverMarker] = useState(null);
  const [plotResetRevision, setPlotResetRevision] = useState(0);
  const [hiddenTraceKeys, setHiddenTraceKeys] = useState(['dayAheadSchedule']);
  const graphContainerRef = useRef(null);
  const lastHoverKeyRef = useRef('');
  const [intradayCurve,       setIntradayCurve]       = useState([]);
  const [meterCurve,          setMeterCurve]          = useState([]);
  const [enercastFrozenRows,  setEnercastFrozenRows]  = useState([]);
  const [meterDebugInfo,      setMeterDebugInfo]      = useState(null);
  const [latestManualEditedRows, setLatestManualEditedRows] = useState([]);
  const [latestManualSystemRows, setLatestManualSystemRows] = useState([]);
  const [vedanjaySldcLatest, setVedanjaySldcLatest] = useState(null);
  const [vedanjaySldcLoading, setVedanjaySldcLoading] = useState(false);
  const [vedanjaySldcUploading, setVedanjaySldcUploading] = useState(false);
  const [vedanjaySldcFile, setVedanjaySldcFile] = useState(null);
  const [vedanjaySldcSubmissionTime, setVedanjaySldcSubmissionTime] = useState('');
  const [vedanjaySldcError, setVedanjaySldcError] = useState('');
  const vedanjaySldcFileInputRef = useRef(null);
  const previousVedanjayFilterRef = useRef(null);
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
    const plant = normalizePlantCode(selectedPlantConfig?.code || loadedScheduleInfo?.plant || '');
    // Use the currently selected date (not the last-loaded schedule date) so the log card
    // never shows previous-date rows while a new schedule is loading.
    const date = String(selectedDate || loadedScheduleInfo?.date || '').trim();
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
    if (selectedPlantConfig?.code) return normalizePlantCode(selectedPlantConfig.code);
    const name = String(loadedScheduleInfo?.plant || '').trim().toUpperCase();
    if (name.includes('SIRMOUR') || name.includes('SHRIMOUR') || name.includes('SHROMOUR')) return 'SIRMOUR';
    if (name.includes('GSNP') || name.includes('GLOBUS')) return 'GSNP';
    if (name.includes('BHUPALPALLY')) return 'BHUPALPALLY';
    if (name.includes('KASIPET')) return 'KASIPET';
    if (name.includes('KILAJ')) return 'KILAJ';
    if (name.includes('KOTHAGUDEM')) return 'KOTHAGUDEM';
    if (name.includes('OSEPL') || name.includes('OSEL')) return 'OSEPL';
    if (name.includes('CME')) return 'CME';
    return normalizePlantCode(name);
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
    const merged = [];
    const seenCodes = new Set();
    [...enriched, ...roleFilteredFallbackPlants].forEach((plant) => {
      const code = getPlantCodeKey(plant) || normalizePlantKey(plant?.name);
      if (!code || seenCodes.has(code)) return;
      seenCodes.add(code);
      merged.push(plant);
    });
    return { plants: merged, total: merged.length, stats: apiPlantsData?.stats || {} };
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

  const urlContext = useMemo(() => {
    if (typeof window === 'undefined') return {};
    try {
      const params = new URLSearchParams(window.location.search || '');
      const readBool = (key) => {
        const raw = String(params.get(key) || '').trim().toLowerCase();
        return raw === '1' || raw === 'true' || raw === 'yes';
      };
      return {
        fromDashboard: readBool('fromDashboard'),
        fromReadiness: readBool('fromReadiness'),
        fromReadinessHistory: readBool('fromReadinessHistory'),
        isDayAhead: readBool('isDayAhead'),
        plantName: String(params.get('plantName') || '').trim(),
        plantCode: String(params.get('plantCode') || '').trim(),
        scheduleDate: String(params.get('scheduleDate') || '').trim(),
        date: String(params.get('date') || '').trim(),
        sourceFileKey: String(params.get('sourceFileKey') || '').trim(),
        sourceKey: String(params.get('sourceKey') || '').trim(),
        fileKey: String(params.get('fileKey') || '').trim(),
        file_key: String(params.get('file_key') || '').trim(),
      };
    } catch {
      return {};
    }
  }, []);
  const resolvedContext = useMemo(
    () => ({ ...urlContext, ...(context || {}) }),
    [context, urlContext]
  );
  const fromDashboard = resolvedContext?.fromDashboard;
  const fromReadiness = resolvedContext?.fromReadiness;
  const fromReadinessHistory = Boolean(resolvedContext?.fromReadinessHistory);
  const tomorrowDate = new Date();
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowIst = toIstYmd(tomorrowDate);
  const canEditScheduleDate =
    (Boolean(effectiveScheduleDate) && effectiveScheduleDate <= todayIst) ||
    (Boolean(fromReadiness && resolvedContext?.isDayAhead) && effectiveScheduleDate === tomorrowIst);

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
      resolvedContext?.plantCode ||
      derivePlantCodeFromName(resolvedContext?.plantName || resolvedContext?.plant) ||
      ''
    ),
    [resolvedContext]
  );
  const selectedPlantNameForReadiness = useMemo(
    () => normalizePlantKey(selectedPlant),
    [selectedPlant]
  );
  const contextPlantNameForReadiness = useMemo(
    () => normalizePlantKey(resolvedContext?.plantName || resolvedContext?.plant || ''),
    [resolvedContext]
  );
  const selectedDateForReadiness = useMemo(
    () => String(loadedScheduleInfo?.date || selectedDate || '').trim(),
    [loadedScheduleInfo?.date, selectedDate]
  );
  const contextDateForReadiness = useMemo(
    () => String(resolvedContext?.scheduleDate || resolvedContext?.date || '').trim(),
    [resolvedContext]
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
    () => Boolean(String(
      resolvedContext?.sourceFileKey ||
      resolvedContext?.sourceKey ||
      resolvedContext?.fileKey ||
      resolvedContext?.file_key ||
      ''
    ).trim()),
    [resolvedContext]
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

  const selectedPlantCodeForVedanjaySldc = useMemo(() => String(
    selectedPlantConfig?.code ||
    selectedPlantCodeForReadiness ||
    derivePlantCodeFromName(selectedPlantConfig?.name || selectedPlant) ||
    ''
  ).trim().toUpperCase(), [
    selectedPlantConfig?.code,
    selectedPlantConfig?.name,
    selectedPlantCodeForReadiness,
    selectedPlant,
  ]);

  const clearVedanjaySldcSelectedFile = useCallback(() => {
    setVedanjaySldcFile(null);
    setVedanjaySldcSubmissionTime('');
    setVedanjaySldcError('');
    if (vedanjaySldcFileInputRef.current) {
      vedanjaySldcFileInputRef.current.value = '';
    }
  }, []);

  useEffect(() => {
    const currentFilterKey = JSON.stringify({
      state: String(selectedState || ''),
      plant: String(selectedPlant || ''),
      date: String(selectedDate || ''),
    });
    const previousFilterKey = previousVedanjayFilterRef.current;
    previousVedanjayFilterRef.current = currentFilterKey;
    if (previousFilterKey === null || previousFilterKey === currentFilterKey) return;
    clearVedanjaySldcSelectedFile();
  }, [clearVedanjaySldcSelectedFile, selectedDate, selectedPlant, selectedState]);

  const normalizeVedanjaySldcLatest = useCallback((payload) => {
    if (!payload?.found) return null;
    const rows = Array.isArray(payload?.data)
      ? payload.data
      : (Array.isArray(payload?.rows) ? payload.rows : []);
    return {
      ...payload,
      data: rows
        .map((row) => ({
          block: Number(row?.block),
          mw: Number(row?.mw ?? row?.MW ?? row?.schedule_mw ?? row?.scheduled_mw),
        }))
        .filter((row) => Number.isFinite(row.block) && row.block >= 1 && row.block <= 96 && Number.isFinite(row.mw)),
    };
  }, []);

  const loadLatestVedanjaySldcSchedule = useCallback(async ({ plantCode, scheduleDate, silent = false } = {}) => {
    const code = String(plantCode || selectedPlantCodeForVedanjaySldc || '').trim().toUpperCase();
    const dateKey = String(scheduleDate || selectedDate || '').trim();
    if (!code || !dateKey || selectedState === 'Select State' || selectedPlant === 'Select Plant') {
      setVedanjaySldcLatest(null);
      return null;
    }

    setVedanjaySldcLoading(true);
    if (!silent) setVedanjaySldcError('');
    try {
      const payload = await vedanjaySldcSchedulesApi.getLatest({ plantCode: code, scheduleDate: dateKey });
      const normalized = normalizeVedanjaySldcLatest(payload);
      setVedanjaySldcLatest(normalized);
      return normalized;
    } catch (error) {
      setVedanjaySldcLatest(null);
      if (!silent) setVedanjaySldcError(error?.message || 'Failed to load Vedanjay SLDC schedule');
      return null;
    } finally {
      setVedanjaySldcLoading(false);
    }
  }, [
    normalizeVedanjaySldcLatest,
    selectedDate,
    selectedPlant,
    selectedPlantCodeForVedanjaySldc,
    selectedState,
  ]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const latest = await loadLatestVedanjaySldcSchedule({ silent: true });
      if (cancelled) return;
      if (!latest) setVedanjaySldcError('');
    };
    run();
    return () => { cancelled = true; };
  }, [loadLatestVedanjaySldcSchedule]);

  const handleVedanjaySldcUpload = useCallback(async () => {
    if (!vedanjaySldcFile) {
      toast.error('Please choose a CSV or XLSX file');
      return;
    }
    const ext = `.${String(vedanjaySldcFile.name || '').split('.').pop()}`.toLowerCase();
    if (!['.csv', '.xlsx'].includes(ext)) {
      toast.error('Only CSV and XLSX files are allowed');
      return;
    }
    const plantCode = selectedPlantCodeForVedanjaySldc;
    const scheduleDate = String(selectedDate || '').trim();
    if (!plantCode || !scheduleDate) {
      toast.error('Please select plant and schedule date');
      return;
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(vedanjaySldcSubmissionTime)) {
      toast.error('Please enter the SLDC submission time');
      return;
    }

    setVedanjaySldcUploading(true);
    setVedanjaySldcError('');
    try {
      const payload = await vedanjaySldcSchedulesApi.upload({
        file: vedanjaySldcFile,
        plantCode,
        plantName: selectedPlantConfig?.name || selectedPlant,
        scheduleDate,
        state: selectedState,
        sldcSubmissionTime: vedanjaySldcSubmissionTime,
        uploader: requestedByLabel,
        uploaderEmployeeId: currentUser?.empId || currentUser?.emp_id || currentUser?.username || '',
        uploaderName: currentUser?.name || '',
        uploaderRole: currentUser?.role || '',
      });
      const normalized = normalizeVedanjaySldcLatest(payload);
      setVedanjaySldcLatest(normalized);
      clearVedanjaySldcSelectedFile();
      setPlotResetRevision((current) => current + 1);
      toast.success('Vedanjay SLDC schedule uploaded');
    } catch (error) {
      const message = error?.message || 'Failed to upload Vedanjay SLDC schedule';
      setVedanjaySldcError(message);
      toast.error(message);
    } finally {
      setVedanjaySldcUploading(false);
    }
  }, [
    clearVedanjaySldcSelectedFile,
    normalizeVedanjaySldcLatest,
    requestedByLabel,
    currentUser,
    selectedDate,
    selectedPlant,
    selectedPlantConfig?.name,
    selectedPlantCodeForVedanjaySldc,
    selectedState,
    vedanjaySldcFile,
    vedanjaySldcSubmissionTime,
  ]);

  const formatVedanjaySldcUploadedAt = useCallback((value) => {
    if (!value) return '';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return String(value);
    return parsed.toLocaleString('en-IN', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Kolkata',
    });
  }, []);

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
    const currentPlantCode = String(getPlantCodeForChanges() || selectedPlantCodeForReadiness || '').trim().toUpperCase();
    if (!currentScheduleDate || !currentPlantCode) return false;
    if (!hasSavedManualChanges || !lastSavedManualRequest) return false;
    return (
      String(lastSavedManualRequest?.plantCode || '').trim().toUpperCase() === currentPlantCode
      && String(lastSavedManualRequest?.scheduleDate || '').trim() === currentScheduleDate
    );
  }, [getPlantCodeForChanges, hasSavedManualChanges, lastSavedManualRequest, loadedScheduleInfo?.date, selectedDate, selectedPlantCodeForReadiness]);
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
    const seenCodes = new Set();
    const plants = [];
    plantsData.plants
      .filter((plant) => plant.state === selectedState)
      .forEach((plant) => {
        const code = getPlantCodeKey(plant) || normalizePlantKey(plant?.name);
        if (!code || seenCodes.has(code)) return;
        seenCodes.add(code);
        plants.push(plant.name);
      });
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

  const resetLoadedScheduleView = useCallback(() => {
    setIsDataLoaded(false);
    setLoadedScheduleInfo(null);
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
    setLoadError(null);
    setGraphError(null);
    setGraphLoading(false);
    setIntradayCurve([]);
    setMeterCurve([]);
    setEnercastFrozenRows([]);
    setMeterDebugInfo(null);
    setLatestManualEditedRows([]);
    setLatestManualSystemRows([]);
    setVedanjaySldcLatest(null);
    setHoverMarker(null);
    setPlotResetRevision((current) => current + 1);
  }, []);

  const handleStateChange = (state) => {
    if (state !== selectedState) {
      resetLoadedScheduleView();
    }
    setSelectedState(state);
    setSelectedPlant('Select Plant');
  };

  const handlePlantChange = (plant) => {
    if (plant !== selectedPlant) {
      resetLoadedScheduleView();
    }
    setSelectedPlant(plant);
    const plantConfig = plantsData.plants.find((p) => p.name === plant);
    if (plantConfig) {
      setSelectedState(plantConfig.state);
    }
  };

  const handleDateChange = (dateValue) => {
    if (dateValue !== selectedDate) {
      resetLoadedScheduleView();
    }
    setSelectedDate(dateValue);
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
      setGraphLoading(true);
      setIntradayCurve([]);
      setMeterCurve([]);
      setEnercastFrozenRows([]);
      setMeterDebugInfo(null);
      setLatestManualEditedRows([]);
      setLatestManualSystemRows([]);

    try {
      let parsedIntradayForSelectedDate = [];
      let latestIntradayKeyForSelectedDate = '';
      let intradayForecastByBlock = null;
      let dayAheadScheduleByBlock = null;

      const explicitSourceKey = String(
        resolvedContext?.sourceFileKey ||
        resolvedContext?.sourceKey ||
        resolvedContext?.file_key ||
        resolvedContext?.fileKey ||
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

      const intradayObjectsPromise = listS3ObjectsAcrossPrefixes(getIntradayPrefixes(targetDate, chosenPlant), currentUser)
        .catch(() => []);
      const meterObjectsPromise = isMeterAvailable(chosenPlant)
        ? listS3ObjectsAcrossPrefixes(getMeterPrefixes(targetDate, chosenPlant), currentUser).catch(() => [])
        : Promise.resolve([]);

      const scheduleListStarted = performance.now();
      const listResp = await schedulesApi.latestFiles({
        plant: schedulePlantCode,
        date: targetDate,
        type: 'intraday',
        limitPerPlant: 2000,
      });
      console.debug(`[timing] preparation latest-files ${schedulePlantCode}: ${Math.round(performance.now() - scheduleListStarted)}ms (${Array.isArray(listResp?.items) ? listResp.items.length : 0})`);

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
      const intradayRunByKey = computeIntradayRunIndexByKey(numericCandidates);
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

      const missingScheduleMessage = !candidates.length
        ? `No schedule CSV found for ${targetDate}`
        : '';

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
        parsed = parseScheduleCsv(csvText, { plantCode: chosenPlant?.code || chosenPlant?.name });
        if (!parsed.length) {
          throw new Error('Schedule CSV parsed but returned no valid rows');
        }
      } else if (candidates.length) {
        // Fallback: if schedule CSV is inaccessible (often 403), build schedule from latest intraday CSV.
        const intradayObjectsFlat = await intradayObjectsPromise;
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
        const intradayObjectsFlat = await intradayObjectsPromise;
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
          const parsedDayAhead = parseDayAheadCsv(dayAheadCsvText, { plantCode: chosenPlant?.code || chosenPlant?.name });
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
      // Pad to 96 blocks WITHOUT pulling day-ahead values into the intraday/system schedule baseline.
      // System Schedule (row.algo) must reflect intraday schedule_from_XX.csv only.
      if (parsed.length) {
        const rowsByBlock = new Map(parsed.map((row) => [Number(row.block), row]).filter(([b]) => Number.isFinite(b)));
        const padded = [];
        let lastAlgo = '0';
        let lastBase = '0';
        let lastIntraday = '0';
        for (let block = 1; block <= 96; block += 1) {
          const existing = rowsByBlock.get(block);
          if (existing) {
            lastAlgo = existing.algo ?? lastAlgo;
            lastBase = existing.base ?? lastBase;
            lastIntraday = existing.intraday ?? lastIntraday;
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
            algo: lastAlgo,
            base: lastBase,
            intraday: intradayForecast ? toUiNumericText(intradayForecast) : lastIntraday,
            condition: 'PADDED_BASELINE',
            dayAhead: daAlgo,
            dayAheadBase: daBase,
            dayAheadIntraday: daIntra,
            dayAheadCondition: da ? String(da.condition || 'Normal') : 'NONE',
          });
        }
        parsed = padded;
      }

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
        plantCode: schedulePlantCode,
        intradayRunIndex: latestSchedule
          ? intradayRunByKey.get(String(latestSchedule.key || '').trim()) || null
          : null,

        endingBlock: latestSchedule ? extractScheduleRevision(latestSchedule.key) : null,
        endingBlockTime: (() => {
          const block = latestSchedule ? extractScheduleRevision(latestSchedule.key) : null;
          return Number.isFinite(block) ? blockToTime(block, 8) : null;
        })(),
        fileName: latestSchedule ? latestSchedule.key.split('/').pop() : null,
        sourceKey: latestSchedule ? latestSchedule.key : null,
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
          : latestSchedule
            ? 'S3 (Schedule)'
            : 'No schedule CSV',
      });

      setLoadingData(false);

      // â”€â”€ 2. Load latest intraday + meter curves for Plotly â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      const curveWarnings = [];

      try {
        if (parsedIntradayForSelectedDate.length) {
          setIntradayCurve(parsedIntradayForSelectedDate);
        } else {
          // Fallback path if intraday wasn't available during row hydration.
          const intradayObjectsFlat = await intradayObjectsPromise;
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

      try {
        if (isMeterAvailable(chosenPlant)) {
          // Always use latest updated meter CSV by LastModified.
          const meterObjectsFlat = await meterObjectsPromise;
          const meterObjects = mergeUniqueObjects([meterObjectsFlat]);
          const meterObjectsOutputs = meterObjects;
          const isZetricMeterPlant = isZetricCode(schedulePlantCode);
          const zetricMeterConfig = isZetricMeterPlant
            ? await api.multiGeneratorPlant.get('ZETRIC_SOLAR_PARK').then((response) => response?.item || null).catch(() => null)
            : null;
          const zetricAssetTokens = isZetricMeterPlant ? getConfiguredZetricMeterAssetTokens(zetricMeterConfig) : [];
          const meterCandidates = sortLatestFirst(
            meterObjects.filter((o) => String(o?.key || '').toLowerCase().endsWith('.csv'))
          );
          const zetricMatchedMeterFiles = isZetricMeterPlant
            ? meterCandidates.filter((o) => isZetricMeterAssetFile(o.key, zetricAssetTokens))
            : [];
          const zetricMeterFiles = isZetricMeterPlant
            ? (zetricMatchedMeterFiles.length ? zetricMatchedMeterFiles : meterCandidates)
            : [];
          const meterObject = isZetricMeterPlant
            ? (zetricMeterFiles[0] || null)
            : findLatestMeterCsv(meterObjects);
          const meterObjectFallback = meterObject || (isZetricMeterPlant ? null : findLatestMeterCsv(meterObjectsOutputs));

          if (!meterObjectFallback) {
            throw new Error('Meter CSV not found');
          }

          const fetchMeterText = async (key) => {
            const meterUrlBase = `${S3_BASE_URL}/${String(key || '').split('/').map((s) => encodeURIComponent(s)).join('/')}`;
            const meterUrl = `${meterUrlBase}?t=${Date.now()}`;
            return fetch(meterUrl, { cache: 'no-store' }).then((r) => {
              if (!r.ok) throw new Error(`Meter fetch failed: ${r.status}`);
              return r.text();
            });
          };
          const meterTexts = isZetricMeterPlant
            ? await Promise.all(zetricMeterFiles.map((file) => fetchMeterText(file.key).catch(() => null)))
            : [await fetchMeterText(meterObjectFallback.key)];
          const parsedMeter = isZetricMeterPlant
            ? sumMeterRowsByBlock(
              meterTexts
                .filter(Boolean)
                .map((text) => parseMeterCsvByBlock(text, {
                  plantCode: schedulePlantCode,
                  zetricConfig: zetricMeterConfig,
                }))
            )
            : parseMeterCsvByBlock(meterTexts[0], {
              plantCode: schedulePlantCode,
              sourceKey: meterObjectFallback?.key,
              zetricConfig: zetricMeterConfig,
            });
          const lastBlocks = meterTexts
            .filter(Boolean)
            .map((text) => parseBlockFromTimestamp(extractLastTimestamp(text), { totalBlocks: 96 }))
            .filter(Number.isFinite);
          const lastBlockFromTime = lastBlocks.length ? Math.max(...lastBlocks) : null;
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
            fileName: isZetricMeterPlant && zetricMeterFiles.length > 1
              ? `${zetricMeterFiles.length} ZETRIC asset meter files`
              : meterObjectFallback?.key?.split('/').pop() || 'N/A',
            maxBlock,
            minBlock: Number.isFinite(minBlock) ? minBlock : null,
            rowCount: parsedMeter.length,
            lastTimestamp: (() => {
              const timestamps = meterTexts.filter(Boolean).map(extractLastTimestamp).filter(Boolean).sort();
              return timestamps.length ? timestamps[timestamps.length - 1] : null;
            })(),
          });
        } else {
          setMeterCurve([]);
          setMeterDebugInfo(null);
        }
      } catch {
        // Ignore meter curve load warning in UI
        setMeterDebugInfo(null);
      }

      // Load latest manual request CSVs for graph comparison (edited + system).
      try {
        // Load manual-edits for graph comparison only. Do not seed `editedData` from these exports:
        // System Schedule must always come from schedule_from_*.csv (algo_schedule_mw -> row.algo).
        const manualPrefix = getManualEditsPrefix(targetDate, chosenPlant, 'INTRADAY');
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
          }
        }
      } catch {
        // Keep graph resilient when manual-edits folder/latest pointer is unavailable.
      }

      try {
        const frozenPrefixes = getFrozenSchedulePrefixes(targetDate, chosenPlant);
        const frozenObjects = mergeUniqueObjects([
          await listS3ObjectsAcrossPrefixes(frozenPrefixes, currentUser).catch(() => []),
        ]);
        const enercastFrozenObject = sortLatestFirst(
          frozenObjects.filter((o) => /\/enercast_edited_frozen\.csv$/i.test(String(o?.key || '')))
        )[0] || null;
        if (enercastFrozenObject?.key) {
          const frozenText = await fetchTextFromS3Optional(String(enercastFrozenObject.key)).catch(() => null);
          const frozenByBlock = frozenText ? parseManualEditsCsvByBlock(frozenText) : new Map();
          const frozenRows = Array.from(frozenByBlock.entries()).map(([block, algo]) => ({ block, algo }));
          setEnercastFrozenRows(frozenRows);
        } else {
          setEnercastFrozenRows([]);
        }
      } catch {
        setEnercastFrozenRows([]);
      }

      setGraphError(curveWarnings.length ? curveWarnings.join(' | ') : null);
      setGraphLoading(false);

      if (missingScheduleMessage) {
        setLoadError(missingScheduleMessage);
        setGraphError((prev) => prev || missingScheduleMessage);
        toast.warning(`${missingScheduleMessage}. Showing available graph data.`);
      } else if (loadedFromIntradayFallback) {
        const rawName = latestSchedule.key.split('/').pop();
        const displayName = formatMachineScheduleDisplayName({
          baseName: rawName,
          key: latestSchedule.key,
          plantCodeOrName: schedulePlantCode,
          scheduleDate: targetDate,
          isDayAhead: false,
          intradayRunIndex: intradayRunByKey.get(String(latestSchedule.key || '').trim()),
        });
        toast.warning(`Schedule CSV unavailable (403). Loaded from intraday: ${displayName}`);
      } else {
        const rawName = latestSchedule.key.split('/').pop();
        const displayName = formatMachineScheduleDisplayName({
          baseName: rawName,
          key: latestSchedule.key,
          plantCodeOrName: schedulePlantCode,
          scheduleDate: targetDate,
          isDayAhead: false,
          intradayRunIndex: intradayRunByKey.get(String(latestSchedule.key || '').trim()),
        });
        toast.success(`Schedule loaded: ${displayName}`);
      }
    } catch (err) {
      setLoadError(err.message);
      toast.error(err.message);
    } finally {
      setLoadingData(false);
    }
  };

  useEffect(() => {
    const onSldcUploadRefresh = (event) => {
      const detail = event?.detail || {};
      const eventDate = String(detail?.scheduleDate || '').trim();
      const selectedDateKey = String(selectedDate || '').trim();
      if (eventDate && selectedDateKey && eventDate !== selectedDateKey) return;

      const affectedCodes = new Set(
        [
          ...(Array.isArray(detail?.plantCodes) ? detail.plantCodes : []),
          detail?.plantCode,
        ]
          .map((code) => normalizePlantCode(code))
          .filter(Boolean)
      );
      const currentPlantCode = normalizePlantCode(
        selectedPlantConfig?.code ||
          derivePlantCodeFromName(selectedPlantConfig?.name || selectedPlant) ||
          selectedPlant
      );
      if (affectedCodes.size && currentPlantCode && !affectedCodes.has(currentPlantCode)) return;
      if (selectedState === 'Select State' || selectedPlant === 'Select Plant') return;

      handleLoadData(eventDate || selectedDateKey, {
        state: selectedState,
        plant: selectedPlant,
      });
    };

    window.addEventListener(SLDC_UPLOAD_REFRESH_EVENT, onSldcUploadRefresh);
    return () => window.removeEventListener(SLDC_UPLOAD_REFRESH_EVENT, onSldcUploadRefresh);
  }, [selectedDate, selectedPlant, selectedPlantConfig, selectedState]);

  // Auto-load when navigated from Dashboard/Readiness
  useEffect(() => {
    if (!(fromDashboard || fromReadiness)) return;
    if (!(resolvedContext?.plant || resolvedContext?.plantName)) return;

    const plantName = resolvedContext?.plant || resolvedContext?.plantName;
    const dashboardDate = resolvedContext?.scheduleDate || resolvedContext?.date || selectedDate;
    // Some callers pass only plantName ("OSEL") without plantCode.
    // Normalize to the internal/S3 plant code (OSEL -> OSEPL) so dropdown selection works.
    const plantCodeFromContext = normalizePlantCode(
      resolvedContext?.plantCode || derivePlantCodeFromName(plantName) || ''
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
    if (fromReadiness && resolvedContext?.isDayAhead) {
      setBulkColumn('dayAhead');
    }
    setHasSavedManualChanges(false);
    setLastSavedManualRequest(null);
    handleLoadData(dashboardDate, { state: plantFromContext.state, plant: plantFromContext.name });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromDashboard, fromReadiness, resolvedContext, plantsData?.plants, selectedDate]);


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
        const manualPrefixes = getSpecialS3PlantFolderAliases(safePlantCode).flatMap((plantFolder) =>
          legacyFolders.map((folder) => `manual-edits/vedanjay/${plantFolder}/${safeDate}/${folder}/`)
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
      } else if (modifiedBlocks === 0) {
        // Zero-change submit must continue with the currently loaded schedule file.
        // Do not resolve latest manual-edits folder/system_schedule.csv in this path.
        const scheduleDate = currentScheduleDate;
        const plantCode = currentPlantCode;
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
    if (bulkColumn === 'implementedSldc') {
      toast.info('Implemented schedule in SLDC is display-only.');
      return;
    }
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

      if (isDayAhead) {
        const csvText = buildOverwriteCsvText(null, 'dayAhead');
        await api.schedules.overwriteLatest({
          sourceFileKey: targetKey,
          csvText,
          requestedBy,
        });

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
          requestId: '',
          plantCode,
          plantName: loadedScheduleInfo?.plant || selectedPlant || plantCode,
          scheduleDate,
          scheduleType: 'DAY_AHEAD',
          editedScheduleKey: targetKey,
          systemScheduleKey: targetKey,
          changedBlocks: normalizedChanges.length,
        };
        setLastSavedManualRequest(nextRequest);
        setManualChangeCountLocal(plantCode, scheduleDate, targetKey, nextChanges.length);
        toast.success('Day-ahead file overwritten successfully.');
        if (workflowGuide?.isStep?.('prep_save') || workflowGuide?.isStep?.('prep_save_ready')) {
          workflowGuide.setStep('prep_submit');
        }
        return { ok: true, request: nextRequest };
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
        // Use the previous manual-edits output as the base when saving again for the same plant/date/type,
        // so newly submitted blocks preserve earlier manual edits.
        source_file_key: (() => {
          const scheduleTypeFolder = activeEditColumn === 'dayAhead' ? 'DA' : 'INTRADAY';
          const prev = lastSavedManualRequest;
          if (!prev) return targetKey;
          const prevPlant = normalizePlantCode(prev.plantCode || '');
          const currPlant = normalizePlantCode(plantCode);
          const prevDate = String(prev.scheduleDate || '').trim();
          const currDate = String(scheduleDate || '').trim();
          const prevType = String(prev.scheduleType || '').trim().toUpperCase();
          if (prevPlant && currPlant && prevPlant !== currPlant) return targetKey;
          if (prevDate && currDate && prevDate !== currDate) return targetKey;
          if (prevType && prevType !== scheduleTypeFolder) return targetKey;
          const key = String(prev.editedScheduleKey || '').trim();
          return key || targetKey;
        })(),
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
      const requestPrefix = `manual-edits/vedanjay/${getSpecialS3PlantFolder(plantCode)}/${scheduleDate}/${scheduleTypeFolder}/${resolvedRequestId}`;
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
    const enercastFrozenMap = new Map(
      enercastFrozenRows
        .map((r) => [Number(r.block), toNumOrNull(r.algo)])
        .filter(([b]) => Number.isFinite(b))
    );
    const vedanjaySldcMap = new Map(
      (vedanjaySldcLatest?.data || [])
        .map((r) => [Number(r.block), toNumOrNull(r.mw)])
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
    const timeLabels = blocks.map((b) => blockToTime(b).padStart(5, '0'));
    const blockLabels = blocks.map((b, idx) => `Block ${b} (${intervals[idx]})`);
    const visibleTimelineStartBlock = 21; // 05:00 IST
    const visibleTimelineEndBlock = 77; // 19:00 IST
    const visibleTimeline = blocks
      .map((block, idx) => ({
        block,
        blockLabel: blockLabels[idx],
        timeLabel: timeLabels[idx],
      }))
      .filter(({ block }) => block >= visibleTimelineStartBlock && block <= visibleTimelineEndBlock);
    const hoverCustomdata = blocks.map((b, idx) => [b, intervals[idx]]);
    const getAllowedBandBaseline = (block) => {
      if (vedanjaySldcMap.has(block)) return vedanjaySldcMap.get(block);
      return latestManualEditedMap.has(block)
        ? latestManualEditedMap.get(block)
        : (editedScheduleMap.has(block) ? editedScheduleMap.get(block) : null);
    };
      return {
        blocks,
        intervals,
        timeLabels,
        blockLabels,
        visibleTimeline,
        visibleTimelineStartBlock,
        visibleTimelineEndBlock,
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
      implementedSldcSchedule: blocks.map((b) => (vedanjaySldcMap.has(b) ? vedanjaySldcMap.get(b) : null)),
      intradayForecast: blocks.map((b) => (intradayMap.has(b) ? intradayMap.get(b) : null)),
      enercastFrozenSchedule: blocks.map((b) => (enercastFrozenMap.has(b) ? enercastFrozenMap.get(b) : null)),
      actualMetered: blocks.map((b) => {
        if (Number.isFinite(meterMaxBlock) && b > meterMaxBlock) return null;
        return meterMap.has(b) ? meterMap.get(b) : null;
      }),
      allowedBandPercent,
      upperAllowedBand: blocks.map((b) => {
        const schedule = getAllowedBandBaseline(b);
        return Number.isFinite(schedule) ? schedule + allowedBandMw : null;
      }),
      lowerAllowedBand: blocks.map((b) => {
        const schedule = getAllowedBandBaseline(b);
        return Number.isFinite(schedule) ? schedule - allowedBandMw : null;
      }),
      blockLimit,
    };
  }, [editedData, originalData, latestManualEditedRows, latestManualSystemRows, intradayCurve, enercastFrozenRows, meterCurve, vedanjaySldcLatest, selectedPlantConfig, selectedDate, loadedScheduleInfo]);

  const meterMaxBlock = useMemo(
    () => (meterCurve.length ? Math.max(...meterCurve.map((r) => Number(r.block) || 0)) : null),
    [meterCurve]
  );

  const selectedScheduleDate = useMemo(
    () => String(loadedScheduleInfo?.date || selectedDate || '').trim(),
    [loadedScheduleInfo, selectedDate]
  );

  const isLoadedSelectionCurrent = useMemo(() => {
    if (!isDataLoaded || !loadedScheduleInfo) return false;
    const loadedDate = String(loadedScheduleInfo?.date || '').trim();
    const currentDate = String(selectedDate || '').trim();
    if (!loadedDate || !currentDate || loadedDate !== currentDate) return false;

    const loadedPlantCode = normalizePlantCode(
      loadedScheduleInfo?.plantCode ||
        derivePlantCodeFromName(loadedScheduleInfo?.plant) ||
        loadedScheduleInfo?.plant ||
        ''
    );
    const currentPlantCode = normalizePlantCode(
      selectedPlantConfig?.code ||
        derivePlantCodeFromName(selectedPlantConfig?.name || selectedPlant) ||
        selectedPlant ||
        ''
    );
    return Boolean(loadedPlantCode && currentPlantCode && loadedPlantCode === currentPlantCode);
  }, [isDataLoaded, loadedScheduleInfo, selectedDate, selectedPlant, selectedPlantConfig]);

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
    // Avoid showing stale rows from a previous date/plant while the next log loads.
    setChanges([]);
    const plantCode = getPlantCodeForChanges();
    const scheduleDate = String(selectedDate || loadedScheduleInfo?.date || '').trim();
    const normalizeChangeRows = (rows) => (rows || []).map((c) => ({
      block: c.block,
      time: c.time,
      oldValue: c.old_value ?? c.oldValue ?? '',
      newValue: c.new_value ?? c.newValue ?? '',
      savedAt: c.saved_at ?? c.savedAt ?? '',
      sourceFileKey: c.source_file_key ?? c.sourceFileKey ?? '',
      requestedBy: c.requested_by ?? c.requestedBy ?? '',
    }));

    const filterRowsForSelection = (rows) => {
      const safePlant = String(plantCode || '').trim().toUpperCase();
      const safeDate = String(scheduleDate || '').trim();
      if (!safePlant && !safeDate) return rows;

      const toIstYmdSafe = (isoLike) => {
        try {
          const d = new Date(isoLike);
          if (Number.isNaN(d.getTime())) return '';
          return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        } catch {
          return '';
        }
      };

      const extractPlantFromKey = (key) => {
        const match = String(key || '').match(/\/generated\/vedanjay\/([^/]+)\//i);
        return match?.[1] ? normalizePlantCode(match[1]) : '';
      };

      const extractDateFromKey = (key) => {
        const text = String(key || '');
        const outputsMatch = text.match(/\/outputs\/(\d{4}-\d{2}-\d{2})\//i);
        if (outputsMatch?.[1]) return outputsMatch[1];
        const manualMatch = text.match(/\/manual-edits\/[^/]+\/[^/]+\/(\d{4}-\d{2}-\d{2})\//i);
        if (manualMatch?.[1]) return manualMatch[1];
        return '';
      };

      return (Array.isArray(rows) ? rows : []).filter((row) => {
        const sourceKey = String(row?.sourceFileKey || '').trim();
        const keyPlant = sourceKey ? extractPlantFromKey(sourceKey) : '';
        const keyDate = sourceKey ? extractDateFromKey(sourceKey) : '';

        if (safePlant && keyPlant && keyPlant !== safePlant) return false;
        if (safeDate && keyDate && keyDate !== safeDate) return false;

        // If key doesn't include a date (legacy/local), fall back to savedAt IST day.
        if (safeDate && !keyDate) {
          const savedDay = toIstYmdSafe(row?.savedAt);
          if (savedDay && savedDay !== safeDate) return false;
        }
        return true;
      });
    };

    const loadFromLocal = () => {
      try {
        const raw = localStorage.getItem(key);
        const parsed = raw ? JSON.parse(raw) : [];
        const normalized = Array.isArray(parsed) ? normalizeChangeRows(parsed) : [];
        setChanges(filterRowsForSelection(normalized));
      } catch {
        setChanges([]);
      }
    };

    const loadFromS3 = async () => {
      if (!plantCode || !scheduleDate) return null;
        const isDayAheadLog = activeEditColumn === 'dayAhead'
          || /\/day-ahead\/|\/dayahead\/|\/day_ahead\//i.test(String(getOverwriteTargetKey(activeEditColumn) || ''));
        const changeKey = plantCode === 'ZETRIC'
          ? (isDayAheadLog
            ? `generated/vedanjay/multiple_generator/ZTRIC/${scheduleDate}/Day-ahead/schedule_changes.json`
            : `generated/vedanjay/multiple_generator/ZTRIC/${scheduleDate}/schedule_changes.json`)
          : (isDayAheadLog
            ? `generated/vedanjay/${plantCode}/outputs/${scheduleDate}/Day-ahead/schedule_changes.json`
            : `generated/vedanjay/${plantCode}/outputs/${scheduleDate}/schedule_changes.json`);
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
      return filterRowsForSelection(normalizeChangeRows(rows));
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
  }, [
    selectedDate,
    selectedPlantConfig?.code,
    loadedScheduleInfo?.date,
    loadedScheduleInfo?.plant,
    activeEditColumn,
  ]);

  const plotLayout = useMemo(() => {
    const plotPlantCode = normalizePlantCode(
      selectedPlantConfig?.code ||
      derivePlantCodeFromName(selectedPlantConfig?.name || selectedPlant) ||
      selectedPlant
    );
    const isSirmourPlot = plotPlantCode === 'SIRMOUR' || normalizePlantKey(selectedPlant) === 'sirmour';
    const sirmourYAxisTicks = Array.from({ length: 11 }, (_, idx) => idx * 0.5);
    return {
      margin: { l: 50, r: 20, t: 108, b: 82 },
      uirevision: `${loadedScheduleInfo?.fileName || ''}|${selectedState || ''}|${selectedPlant || ''}|${loadedScheduleInfo?.date || selectedDate || ''}|${plotResetRevision}`,
      paper_bgcolor: isDarkMode ? 'rgba(0,0,0,0)' : '#ffffff',
      plot_bgcolor: isDarkMode ? 'rgba(0,0,0,0)' : '#ffffff',
      font: { color: isDarkMode ? '#cbd5e1' : '#1f2937', size: 11 },
      xaxis: {
        title: 'Time (IST)',
        type: 'category',
        tickmode: 'array',
        tickvals: plotSeries.visibleTimeline.map((item) => item.blockLabel),
        ticktext: plotSeries.visibleTimeline.map((item) => item.timeLabel),
        tickangle: -45,
        tickfont: { size: 10 },
        automargin: true,
        gridcolor: isDarkMode ? 'rgba(148,163,184,0.2)' : 'rgba(100,116,139,0.22)',
        autorange: false,
        range: [
          plotSeries.visibleTimelineStartBlock - 1.5,
          plotSeries.visibleTimelineEndBlock - 0.5,
        ],
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
        ...(isSirmourPlot
          ? {
              autorange: false,
              range: [0, 5],
              tickmode: 'array',
              tickvals: sirmourYAxisTicks,
              ticktext: sirmourYAxisTicks.map((value) => String(value)),
            }
          : {})
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
        y: 1.3,
        yanchor: 'bottom',
        bgcolor: isDarkMode ? 'rgba(0,0,0,0)' : 'rgba(255,255,255,0.92)',
        font: { color: isDarkMode ? '#cbd5e1' : '#1f2937' },
        itemclick: 'toggle',
        itemdoubleclick: false,
        groupclick: 'toggleitem',
      }
    };
  }, [isDarkMode, plotSeries, loadedScheduleInfo, selectedDate, selectedPlant, selectedPlantConfig, selectedState, plotResetRevision]);

  useEffect(() => {
    setHiddenTraceKeys(['dayAheadSchedule']);
  }, [selectedDate, selectedPlant, loadedScheduleInfo?.fileName, loadedScheduleInfo?.sourceKey, vedanjaySldcLatest?.s3_key]);

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
      uid: 'enercastFrozenSchedule',
      x: plotSeries.blockLabels,
      y: plotSeries.enercastFrozenSchedule,
      customdata: plotSeries.hoverCustomdata,
      type: 'scatter',
      mode: 'lines',
      name: 'Enercast Frozen Schedule (MW)',
      line: { color: CHART_COLORS.enercastFrozen, width: 1.8 },
      hovertemplate: 'Enercast Frozen: %{y:.2f} MW<extra></extra>',
      connectgaps: false
    },
    (vedanjaySldcLatest?.data || []).length ? {
      uid: 'implementedSldcSchedule',
      x: plotSeries.blockLabels,
      y: plotSeries.implementedSldcSchedule,
      customdata: plotSeries.hoverCustomdata,
      type: 'scatter',
      mode: 'lines',
      name: 'Implemented Schedule in SLDC',
      line: { color: '#06b6d4', width: 1.8 },
      hovertemplate: 'Implemented SLDC: %{y:.2f} MW<extra></extra>',
      connectgaps: false
    } : null,
    {
      uid: 'meterData',
      x: plotSeries.blockLabels,
      y: plotSeries.actualMetered,
      type: 'scatter',
      mode: 'lines',
      name: 'Meter Data (MW)',
      line: { color: getActualLineColor(isDarkMode), width: 1.8 },
      hovertemplate: 'Meter Data: %{y:.2f} MW<extra></extra>',
      connectgaps: false
    },
    ].filter(Boolean).map((trace) => {
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
            size: 9,
            color: traceColor,
            line: { width: 0, color: traceColor },
          },
        };
      })();
      return {
        ...normalizedTrace,
        hoverinfo: 'none',
        hovertemplate: null,
        visible: isTraceHidden(normalizedTrace?.uid) ? 'legendonly' : true,
      };
    })), [plotSeries, isDarkMode, isTraceHidden, vedanjaySldcLatest?.data]);

  const hasGraphPlotData = useMemo(() => (
    plotData.some((trace) =>
      Array.isArray(trace?.y) &&
      trace.y.some((value) => Number.isFinite(Number(value)))
    )
  ), [plotData]);

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

  const tableDisplayColumn = useMemo(() => {
    if (bulkColumn === 'dayAhead') return 'dayAhead';
    if (bulkColumn === 'implementedSldc') return 'implementedSldc';
    return 'algo';
  }, [bulkColumn]);

  const implementedSldcByBlock = useMemo(() => {
    const rows = Array.isArray(vedanjaySldcLatest?.data) ? vedanjaySldcLatest.data : [];
    return new Map(
      rows
        .map((row) => [Number(row?.block), row?.mw])
        .filter(([block]) => Number.isFinite(block))
    );
  }, [vedanjaySldcLatest?.data]);

  const hasImplementedSldcSchedule = implementedSldcByBlock.size > 0;

  useEffect(() => {
    if (!hasImplementedSldcSchedule && showDsmCheck) {
      setShowDsmCheck(false);
    }
  }, [hasImplementedSldcSchedule, showDsmCheck]);

  const dsmCheckRows = useMemo(() => {
    if (!hasImplementedSldcSchedule) return [];
    const blocks = Array.isArray(plotSeries?.blocks) && plotSeries.blocks.length
      ? plotSeries.blocks
      : Array.from({ length: 96 }, (_, idx) => idx + 1);
    const currentIstBlock = isTodaySelected ? getCurrentIstBlock(96) : 96;
    const capacityMw = Number(selectedPlantConfig?.capacityMw || selectedPlantConfig?.capacity || 0);
    const plantState = selectedPlantConfig?.state || selectedState || '';
    const plantType = selectedPlantConfig?.type || 'Solar';
    const plantName = selectedPlantConfig?.code || selectedPlantConfig?.name || selectedPlant || '';
    const allowedBandPercent = getAllowedBandPercent(plantState, plantType);
    const allowedBandMw = (Math.abs(capacityMw) * allowedBandPercent) / 100;

    return blocks.map((block, idx) => {
      const scheduledRaw = implementedSldcByBlock.get(Number(block));
      const actualRaw = Number(block) <= currentIstBlock ? plotSeries?.actualMetered?.[idx] : null;
      const scheduled = Number(scheduledRaw);
      const actual = Number(actualRaw);
      const hasSchedule = Number.isFinite(scheduled);
      const hasMeter = Number.isFinite(actual);
      const lowerLimitMw = hasSchedule ? scheduled - allowedBandMw : null;
      const upperLimitMw = hasSchedule ? scheduled + allowedBandMw : null;

      if (!hasSchedule || !hasMeter) {
        return {
          block,
          time: blockToInterval(block),
          scheduled: hasSchedule ? scheduled : null,
          actual: hasMeter ? actual : null,
          deviation: null,
          percentage: null,
          lowerLimitMw,
          upperLimitMw,
          penaltyRs: 0,
          accuracy: null,
          excessDeviationMw: 0,
          breachDirection: 'NONE',
          status: !hasSchedule ? 'No SLDC data' : 'Awaiting meter',
        };
      }

      const deviation = actual - scheduled;
      const percentage = capacityMw > 0 ? (deviation / capacityMw) * 100 : null;
      const underGenerationMw = actual < lowerLimitMw ? (lowerLimitMw - actual) : 0;
      const overGenerationMw = actual > upperLimitMw ? (actual - upperLimitMw) : 0;
      const excessDeviationMw = Math.max(underGenerationMw, overGenerationMw, 0);
      const isBreach = excessDeviationMw > DSM_EPSILON;
      const penaltyRs = calculatePenaltyRsShared({
        scheduledMw: scheduled,
        actualMw: actual,
        capacityMw,
        plantState,
        plantType,
        penaltyConfigByState: DSM_PENALTY_CONFIG_BY_STATE,
        defaultPenaltyConfig: DEFAULT_DSM_PENALTY_CONFIG,
      }) || 0;
      const breachDirection = underGenerationMw > DSM_EPSILON
        ? 'UNDER_GENERATION'
        : overGenerationMw > DSM_EPSILON
          ? 'OVER_GENERATION'
          : 'NONE';

      return {
        block,
        time: blockToInterval(block),
        plant: plantName,
        type: plantType,
        scheduled,
        actual,
        deviation,
        percentage,
        lowerLimitMw,
        upperLimitMw,
        penaltyRs,
        accuracy: calcDsmAccuracyPercent(scheduled, actual),
        excessDeviationMw,
        breachDirection,
        status: isBreach
          ? (breachDirection === 'UNDER_GENERATION' ? 'Under-generation penalty' : 'Over-generation penalty')
          : 'No penalty',
      };
    });
  }, [
    hasImplementedSldcSchedule,
    implementedSldcByBlock,
    plotSeries,
    selectedPlant,
    selectedPlantConfig,
    selectedState,
    isTodaySelected,
  ]);

  const dsmCheckSummary = useMemo(() => {
    const calculatedRows = dsmCheckRows.filter(
      (row) => Number.isFinite(row.scheduled) && Number.isFinite(row.actual)
    );
    const breachCount = calculatedRows.filter((row) => row.excessDeviationMw > DSM_EPSILON).length;
    const totalPenalty = calculatedRows.reduce((sum, row) => sum + (Number(row.penaltyRs) || 0), 0);
    const maxDeviation = calculatedRows.reduce((max, row) => Math.max(max, Math.abs(Number(row.deviation) || 0)), 0);
    const withinBand = calculatedRows.length
      ? Math.round(((calculatedRows.length - breachCount) / calculatedRows.length) * 100)
      : 0;
    return {
      calculatedBlocks: calculatedRows.length,
      breachCount,
      totalPenalty,
      maxDeviation,
      withinBand,
    };
  }, [dsmCheckRows]);

  const tableScheduleColumnLabel = useMemo(() => {
    if (tableDisplayColumn === 'dayAhead') return 'Day-ahead (MW)';
    if (tableDisplayColumn === 'implementedSldc') return 'Implemented schedule in SLDC';
    return 'System Schedule (MW)';
  }, [tableDisplayColumn]);

  const getTableScheduleValue = useCallback((row, index) => {
    if (tableDisplayColumn === 'dayAhead') return row?.dayAhead ?? '0';
    if (tableDisplayColumn === 'implementedSldc') {
      const value = implementedSldcByBlock.get(Number(row?.block));
      return value ?? '';
    }
    return originalData?.[index]?.algo ?? row?.algo;
  }, [implementedSldcByBlock, originalData, tableDisplayColumn]);

  const tableGraphOptions = useMemo(() => ([
    { value: 'algo', label: 'System Schedule (MW)', seriesKey: 'systemSchedule', color: '#1d4ed8' },
    { value: 'dayAhead', label: 'Day-ahead (MW)', seriesKey: 'dayAheadSchedule', color: '#ec4899' },
    { value: 'implementedSldc', label: 'Implemented schedule in SLDC', seriesKey: 'implementedSldcSchedule', color: '#06b6d4' },
  ]), []);

  const tableGraphOption = useMemo(
    () => tableGraphOptions.find((option) => option.value === tableGraphColumn) || tableGraphOptions[0],
    [tableGraphColumn, tableGraphOptions]
  );

  const tableGraphData = useMemo(() => {
    const yValues = plotSeries?.[tableGraphOption.seriesKey] || [];
    return [{
      x: plotSeries.blockLabels,
      y: yValues,
      customdata: plotSeries.hoverCustomdata,
      type: 'scatter',
      mode: 'lines+markers',
      name: tableGraphOption.label,
      line: { color: tableGraphOption.color, width: 2, shape: 'spline', smoothing: 0.45 },
      marker: { symbol: 'square', size: 5, color: tableGraphOption.color },
      hovertemplate: '%{customdata[1]}<br>%{y:.2f} MW<extra></extra>',
      connectgaps: false,
    }];
  }, [plotSeries, tableGraphOption]);

  const tableGraphLayout = useMemo(() => ({
    margin: { l: 42, r: 12, t: 16, b: 70 },
    paper_bgcolor: isDarkMode ? 'rgba(0,0,0,0)' : '#ffffff',
    plot_bgcolor: isDarkMode ? 'rgba(0,0,0,0)' : '#ffffff',
    font: { color: isDarkMode ? '#cbd5e1' : '#1f2937', size: 10 },
    xaxis: {
      title: 'Time (IST)',
      type: 'category',
      tickmode: 'array',
      tickvals: plotSeries.visibleTimeline.map((item) => item.blockLabel),
      ticktext: plotSeries.visibleTimeline.map((item) => item.timeLabel),
      tickangle: -45,
      tickfont: { size: 9 },
      automargin: true,
      gridcolor: isDarkMode ? 'rgba(148,163,184,0.2)' : 'rgba(100,116,139,0.22)',
      autorange: false,
      range: [
        plotSeries.visibleTimelineStartBlock - 1.5,
        plotSeries.visibleTimelineEndBlock - 0.5,
      ],
    },
    yaxis: {
      title: 'MW',
      gridcolor: isDarkMode ? 'rgba(148,163,184,0.2)' : 'rgba(100,116,139,0.22)',
    },
    hovermode: 'x unified',
    showlegend: false,
  }), [isDarkMode, plotSeries]);

  const handlePlotHover = useCallback((event) => {
    const points = event?.points;
    if (!Array.isArray(points) || points.length === 0) return;
    const visiblePoints = points
      .filter((p) => {
        const name = String(p?.fullData?.name || '').toLowerCase();
        const uid = String(p?.fullData?.uid || '');
        return (
          p?.fullData?.type === 'scatter' &&
          uid !== 'hover-marker' &&
          p?.y !== null &&
          p?.y !== undefined &&
          Number.isFinite(Number(p.y))
        );
      });
    const anchorPoints = visiblePoints.filter((p) => {
      const name = String(p?.fullData?.name || '').toLowerCase();
      const uid = String(p?.fullData?.uid || '');
      return !uid.startsWith('allowedBand') && !name.includes('allowed band');
    });
    const point =
      anchorPoints[0]
      || visiblePoints[0]
      || points[0];
    if (!point) return;

    const x = point.x;
    const y = point.y;
    if (x == null || y == null) return;
    let hoverPosition = null;
    const nativeEvent = event?.event;
    const containerRect = graphContainerRef.current?.getBoundingClientRect?.();
    if (nativeEvent && containerRect) {
      const pointerX = Number(nativeEvent.clientX) - containerRect.left;
      if (Number.isFinite(pointerX)) {
        hoverPosition = {
          left: Math.min(Math.max(pointerX, 170), Math.max(170, containerRect.width - 170)),
          top: 72,
        };
      }
    }

    const traceColor =
      point?.fullData?.line?.color
      || point?.fullData?.marker?.color
      || '#111827';
    const xaxis = point?.fullData?.xaxis || 'x';
    const yaxis = point?.fullData?.yaxis || 'y';
    const interval = Array.isArray(point?.customdata) ? String(point.customdata[1] || '') : '';
    const hoverTitle = interval ? interval.split('-')[0] : String(x || '');
    const hoverOrder = {
      meterData: 10,
      implementedSldcSchedule: 20,
      enercastFrozenSchedule: 30,
      manualRequestCsv: 40,
      systemSchedule: 50,
      'allowedBand-upper': 60,
      'allowedBand-lower': 70,
    };
    const items = visiblePoints
      .map((p) => {
        const uid = String(p?.fullData?.uid || '');
        const rawName = String(p?.fullData?.name || '').replace(/\s*\(MW\)\s*$/i, '');
        const name =
          uid === 'meterData' ? 'Meter Data' :
          uid === 'implementedSldcSchedule' ? 'Implemented Schedule' :
          uid === 'enercastFrozenSchedule' ? 'Enercast Schedule' :
          uid === 'manualRequestCsv' ? 'Edited Schedule' :
          uid === 'systemSchedule' ? 'System Schedule' :
          uid === 'allowedBand-upper' ? 'Upper Band' :
          uid === 'allowedBand-lower' ? 'Lower Band' :
          rawName
            .replace(/^Day-ahead Schedule$/i, 'Day-ahead')
            .replace(/^Enercast Frozen Schedule$/i, 'Enercast Schedule')
            .replace(/^Implemented Schedule in SLDC$/i, 'Implemented Schedule');
        return {
          uid,
          name,
          value: Number(p.y),
          color: p?.fullData?.line?.color || p?.fullData?.marker?.color || '#111827',
        };
      })
      .sort((a, b) => (hoverOrder[a.uid] ?? 999) - (hoverOrder[b.uid] ?? 999));
    const key = `${point?.fullData?.name || ''}|${x}|${y}|${traceColor}|${xaxis}|${yaxis}|${items.map((item) => `${item.name}:${item.value}`).join('|')}`;
    if (key === lastHoverKeyRef.current) return;
    lastHoverKeyRef.current = key;

    setHoverMarker({ x, y, color: traceColor, xaxis, yaxis, title: hoverTitle, items, position: hoverPosition });
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

  const handlePlotRelayout = useCallback(() => {
    lastHoverKeyRef.current = '';
    setHoverMarker(null);
  }, []);

  const handlePlotDoubleClick = useCallback(() => {
    lastHoverKeyRef.current = '';
    setHoverMarker(null);
    setPlotResetRevision((current) => current + 1);
  }, []);

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

  const ScheduleGraphHoverCard = () => {
    const items = Array.isArray(hoverMarker?.items) ? hoverMarker.items : [];
    if (!items.length) return null;

    return (
      <div
        className={`pointer-events-none absolute z-20 min-w-[230px] max-w-[340px] -translate-x-1/2 rounded-md border px-2.5 py-1.5 text-xs shadow-lg ${
          isDarkMode
            ? 'border-slate-600 bg-slate-950/90 text-slate-100'
            : 'border-slate-300 bg-white/90 text-slate-950'
        }`}
        style={{
          left: hoverMarker?.position?.left ?? 220,
          top: hoverMarker?.position?.top ?? 72,
        }}
      >
        <div className="mb-0.5 font-semibold">{hoverMarker.title || ''}</div>
        <div className="space-y-0.5">
          {items.map((item) => (
            <div key={`${item.name}-${item.color}`} className="flex items-center justify-between gap-4">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className="h-2 w-5 flex-none border-t-2"
                  style={{ borderColor: item.color }}
                />
                <span className="truncate">{item.name}</span>
              </span>
              <span className="flex-none font-medium">{item.value.toFixed(2)} MW</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

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
          <div className="flex items-center gap-3">
            <Calendar className={`w-8 h-8 sm:w-9 sm:h-9 ${isDarkMode ? 'text-white' : 'text-slate-950'}`} />
            <h1 className={`text-2xl sm:text-3xl font-bold tracking-tight ${isDarkMode ? 'text-white' : 'text-slate-950'}`}>Schedule Preparation</h1>
          </div>

          {/* â”€â”€ Filters â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
          {!fromDashboard && (
            <div className="space-y-4 sm:space-y-5">
              <div className="rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm p-4 sm:p-6 shadow-lg shadow-slate-950/10">
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
                      onChange={(e) => handleDateChange(e.target.value)}
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
              </div>

              {!isDataLoaded && (
                <div className="rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm p-4 sm:p-6 shadow-lg shadow-slate-950/10">
                  <div className="flex items-start gap-3 mb-4">
                    <div className="p-3 rounded-xl bg-emerald-500/10">
                      <FileText className="w-5 h-5 sm:w-6 sm:h-6 text-emerald-400" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-lg sm:text-xl font-bold text-foreground">Upload SLDC-Submitted Schedule</h3>
                    </div>
                  </div>

                  <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
                        <input
                          ref={vedanjaySldcFileInputRef}
                          type="file"
                          accept=".csv,.xlsx"
                          onChange={(event) => setVedanjaySldcFile(event.target.files?.[0] || null)}
                          className="w-full sm:w-auto text-sm text-slate-300 file:mr-3 file:px-4 file:py-2 file:rounded-xl file:border file:border-emerald-900/70 file:bg-emerald-950 file:text-emerald-100 file:font-semibold hover:file:bg-emerald-900"
                        />
                        <label className={`flex flex-col gap-1.5 text-xs font-semibold ${isDarkMode ? 'text-slate-300' : 'text-slate-600'}`}>
                          <span>SLDC Submission Time <span className="font-medium text-emerald-600">(IST)</span></span>
                          <div className={`flex min-h-[42px] min-w-[190px] items-center gap-2 rounded-xl border px-3 shadow-sm transition-colors focus-within:border-emerald-500 focus-within:ring-2 focus-within:ring-emerald-500/20 ${
                            isDarkMode
                              ? 'border-slate-700 bg-slate-900 text-slate-100'
                              : 'border-slate-300 bg-white text-slate-900'
                          }`}>
                            <Clock className="h-4 w-4 flex-none text-emerald-600" aria-hidden="true" />
                            <input
                              type="time"
                              value={vedanjaySldcSubmissionTime}
                              onChange={(event) => setVedanjaySldcSubmissionTime(event.target.value)}
                              required
                              aria-label="SLDC submission time in IST"
                              className={`min-w-0 flex-1 bg-transparent text-sm font-semibold text-inherit outline-none ${isDarkMode ? '[color-scheme:dark]' : '[color-scheme:light]'}`}
                            />
                          </div>
                        </label>
                        <button
                          type="button"
                          onClick={handleVedanjaySldcUpload}
                          disabled={!vedanjaySldcFile || !vedanjaySldcSubmissionTime || vedanjaySldcUploading || !selectedPlantCodeForVedanjaySldc || !selectedDate}
                          className={`min-h-[40px] px-4 py-2 rounded-xl text-sm font-semibold transition-all border flex items-center justify-center gap-2 ${
                            vedanjaySldcFile && vedanjaySldcSubmissionTime && !vedanjaySldcUploading && selectedPlantCodeForVedanjaySldc && selectedDate
                              ? 'bg-emerald-600/90 text-white border-emerald-500 hover:bg-emerald-500'
                              : 'bg-emerald-500/15 text-emerald-200 border-emerald-500/30'
                          } disabled:cursor-not-allowed disabled:opacity-100`}
                        >
                          {vedanjaySldcUploading ? (
                            <>
                              <Loader2 className="w-4 h-4 animate-spin" />
                              Uploading...
                            </>
                          ) : (
                            <>
                              <Upload className="w-4 h-4" />
                              Upload
                            </>
                          )}
                        </button>
                      </div>
                    </div>

                    <div className="text-xs sm:text-sm text-slate-400 lg:text-right min-w-0">
                      {vedanjaySldcLoading ? (
                        <span className="inline-flex items-center gap-2">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          Checking active upload...
                        </span>
                      ) : vedanjaySldcLatest ? (
                        <div className="space-y-1">
                          <div>
                            <span className="font-semibold text-slate-300">Active:</span>{' '}
                            <span className="text-slate-200 break-all">{vedanjaySldcLatest.filename || vedanjaySldcLatest.stored_filename}</span>
                          </div>
                          <div>
                            <span className="font-semibold text-slate-300">SLDC submitted:</span>{' '}
                            {vedanjaySldcLatest.sldc_submission_time || 'N/A'} IST
                          </div>
                          <div>
                            <span className="font-semibold text-slate-300">Portal uploaded:</span>{' '}
                            {formatVedanjaySldcUploadedAt(vedanjaySldcLatest.uploaded_at) || 'N/A'}
                          </div>
                          {isAdmin && (
                            <div>
                              <span className="font-semibold text-slate-300">Uploaded by:</span>{' '}
                              {vedanjaySldcLatest.uploaded_by?.name || vedanjaySldcLatest.uploader || 'N/A'}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span>No Vedanjay SLDC upload for this plant/date.</span>
                      )}
                    </div>
                  </div>
                  {vedanjaySldcError && (
                    <p className="mt-3 text-xs text-amber-300">{vedanjaySldcError}</p>
                  )}
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
          {((isDataLoaded && isLoadedSelectionCurrent) || fromDashboard) && (
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
                        disabled={!hasGraphPlotData}
                        className="w-full sm:w-auto flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-slate-800/50 text-slate-300 text-xs sm:text-sm font-semibold hover:bg-slate-700 hover:text-white transition-all border border-slate-700 disabled:opacity-50"
                      >
                        <ExternalLink className="w-4 h-4" />
                        Expand
                      </button>
                    </div>
                  </div>

                  {/* Graph area */}
                  <div ref={graphContainerRef} className={`relative rounded-xl overflow-auto border ${isDarkMode ? 'border-slate-700/50 bg-slate-800/30' : 'border-border bg-white'}`} style={{ height: 585 }}>
                    {(loadingData || graphLoading) && (
                      <div className="flex items-center justify-center h-full gap-3 text-slate-400">
                        <LoadingSpinner size="md" />
                      </div>
                    )}

                    {!(loadingData || graphLoading) && !hasGraphPlotData && (
                      <div className="flex flex-col items-center justify-center h-full gap-3 text-slate-500 px-8 text-center">
                        <BarChart2 className="w-12 h-12 text-slate-700" />
                        <p className="text-sm">No graph data to plot</p>
                      </div>
                    )}

                      {!(loadingData || graphLoading) && hasGraphPlotData && (
                        <>
                          <ScheduleGraphHoverCard />
                          <Plot
                            data={[...plotData, hoverMarkerTrace]}
                            layout={plotLayout}
                            config={{ displayModeBar: false, responsive: true, doubleClick: 'reset+autosize' }}
                            style={{ width: '100%', height: '100%' }}
                            useResizeHandler
                            onHover={handlePlotHover}
                            onUnhover={handlePlotUnhover}
                            onClick={handlePlotClick}
                            onRelayout={handlePlotRelayout}
                            onDoubleClick={handlePlotDoubleClick}
                            onLegendClick={handleLegendClick}
                            onLegendDoubleClick={handleLegendDoubleClick}
                          />
                        </>
                      )}
                    </div>
                    {graphError && <p className="mt-2 text-xs text-amber-300">{graphError}</p>}
                  </div>

              </div>

              <div className="rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm p-4 sm:p-6 shadow-lg shadow-slate-950/10">
                <div className="flex items-start gap-3 mb-4">
                  <div className="p-3 rounded-xl bg-emerald-500/10">
                    <FileText className="w-5 h-5 sm:w-6 sm:h-6 text-emerald-400" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-lg sm:text-xl font-bold text-foreground">Upload SLDC-Submitted Schedule</h3>
                  </div>
                </div>

                <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
                      <input
                        ref={vedanjaySldcFileInputRef}
                        type="file"
                        accept=".csv,.xlsx"
                        onChange={(event) => setVedanjaySldcFile(event.target.files?.[0] || null)}
                        className="w-full sm:w-auto text-sm text-slate-300 file:mr-3 file:px-4 file:py-2 file:rounded-xl file:border file:border-emerald-900/70 file:bg-emerald-950 file:text-emerald-100 file:font-semibold hover:file:bg-emerald-900"
                      />
                      <label className={`flex flex-col gap-1.5 text-xs font-semibold ${isDarkMode ? 'text-slate-300' : 'text-slate-600'}`}>
                        <span>SLDC Submission Time <span className="font-medium text-emerald-600">(IST)</span></span>
                        <div className={`flex min-h-[42px] min-w-[190px] items-center gap-2 rounded-xl border px-3 shadow-sm transition-colors focus-within:border-emerald-500 focus-within:ring-2 focus-within:ring-emerald-500/20 ${
                          isDarkMode
                            ? 'border-slate-700 bg-slate-900 text-slate-100'
                            : 'border-slate-300 bg-white text-slate-900'
                        }`}>
                          <Clock className="h-4 w-4 flex-none text-emerald-600" aria-hidden="true" />
                          <input
                            type="time"
                            value={vedanjaySldcSubmissionTime}
                            onChange={(event) => setVedanjaySldcSubmissionTime(event.target.value)}
                            required
                            aria-label="SLDC submission time in IST"
                            className={`min-w-0 flex-1 bg-transparent text-sm font-semibold text-inherit outline-none ${isDarkMode ? '[color-scheme:dark]' : '[color-scheme:light]'}`}
                          />
                        </div>
                      </label>
                      <button
                        type="button"
                        onClick={handleVedanjaySldcUpload}
                        disabled={!vedanjaySldcFile || !vedanjaySldcSubmissionTime || vedanjaySldcUploading || !selectedPlantCodeForVedanjaySldc || !selectedDate}
                        className={`min-h-[40px] px-4 py-2 rounded-xl text-sm font-semibold transition-all border flex items-center justify-center gap-2 ${
                          vedanjaySldcFile && vedanjaySldcSubmissionTime && !vedanjaySldcUploading && selectedPlantCodeForVedanjaySldc && selectedDate
                            ? 'bg-emerald-600/90 text-white border-emerald-500 hover:bg-emerald-500'
                            : 'bg-emerald-500/15 text-emerald-200 border-emerald-500/30'
                        } disabled:cursor-not-allowed disabled:opacity-100`}
                      >
                        {vedanjaySldcUploading ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Uploading...
                          </>
                        ) : (
                          <>
                            <Upload className="w-4 h-4" />
                            Upload
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  <div className="text-xs sm:text-sm text-slate-400 lg:text-right min-w-0">
                    {vedanjaySldcLoading ? (
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Checking active upload...
                      </span>
                    ) : vedanjaySldcLatest ? (
                      <div className="space-y-1">
                        <div>
                          <span className="font-semibold text-slate-300">Active:</span>{' '}
                          <span className="text-slate-200 break-all">{vedanjaySldcLatest.filename || vedanjaySldcLatest.stored_filename}</span>
                        </div>
                        <div>
                          <span className="font-semibold text-slate-300">SLDC submitted:</span>{' '}
                          {vedanjaySldcLatest.sldc_submission_time || 'N/A'} IST
                        </div>
                        <div>
                          <span className="font-semibold text-slate-300">Portal uploaded:</span>{' '}
                          {formatVedanjaySldcUploadedAt(vedanjaySldcLatest.uploaded_at) || 'N/A'}
                        </div>
                        {isAdmin && (
                          <div>
                            <span className="font-semibold text-slate-300">Uploaded by:</span>{' '}
                            {vedanjaySldcLatest.uploaded_by?.name || vedanjaySldcLatest.uploader || 'N/A'}
                          </div>
                        )}
                      </div>
                    ) : (
                      <span>No Vedanjay SLDC upload for this plant/date.</span>
                    )}
                  </div>
                </div>
                {vedanjaySldcError && (
                  <p className="mt-3 text-xs text-amber-300">{vedanjaySldcError}</p>
                )}
              </div>

              {hasImplementedSldcSchedule && (
                <div className="rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm p-4 sm:p-6">
                  <button
                    type="button"
                    onClick={() => setShowDsmCheck((prev) => !prev)}
                    className={`w-full rounded-xl border px-4 py-3 text-left transition-all ${
                      isDarkMode
                        ? 'border-cyan-500/30 bg-slate-900/80 hover:bg-slate-900 text-slate-100'
                        : 'border-cyan-200 bg-white hover:bg-cyan-50 text-slate-900'
                    }`}
                    aria-expanded={showDsmCheck}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-400">
                          {showDsmCheck ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                        </span>
                        <div>
                          <div className="text-sm font-bold">DSM Check</div>
                          <div className={`text-xs ${isDarkMode ? 'text-slate-400' : 'text-slate-600'}`}>
                            Implemented schedule in SLDC vs meter data
                          </div>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 font-semibold text-cyan-300">
                          {dsmCheckSummary.calculatedBlocks} blocks checked
                        </span>
                        <span className={`rounded-lg px-2.5 py-1 font-semibold ${
                          dsmCheckSummary.breachCount > 0
                            ? 'bg-red-500/10 text-red-400 border border-red-500/30'
                            : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                        }`}>
                          {dsmCheckSummary.breachCount} breaches
                        </span>
                      </div>
                    </div>
                  </button>

                  {showDsmCheck && (
                    <div className={`mt-3 rounded-xl border overflow-hidden ${
                      isDarkMode ? 'border-slate-700 bg-slate-900/70' : 'border-slate-200 bg-white'
                    }`}>
                      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 p-3 sm:p-4 border-b border-slate-700/50">
                        {[
                          ['DSM Breaches', dsmCheckSummary.breachCount],
                          ['Total Penalty', `Rs ${dsmCheckSummary.totalPenalty.toFixed(2)}`],
                          ['Max Deviation', `${formatDsmMw(dsmCheckSummary.maxDeviation, 3, '0.000')} MW`],
                          ['Within Band', `${dsmCheckSummary.withinBand}%`],
                        ].map(([label, value]) => (
                          <div key={label} className={`rounded-lg border px-3 py-2 ${
                            isDarkMode ? 'border-slate-700 bg-slate-950/50' : 'border-slate-200 bg-slate-50'
                          }`}>
                            <div className={`text-[11px] uppercase tracking-wide ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                              {label}
                            </div>
                            <div className={`mt-1 text-sm font-bold ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
                              {value}
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="overflow-auto max-h-[360px]">
                        <table className="w-full text-sm">
                          <thead className={`sticky top-0 z-10 ${isDarkMode ? 'bg-slate-800' : 'bg-slate-100'}`}>
                            <tr>
                              {[
                                'Block/Time',
                                'Schedule MW',
                                'Meter Data',
                                'Deviation',
                                'Deviation %',
                                'Allowed Band',
                                'Penalty',
                                'Accuracy %',
                                'Status',
                              ].map((header) => (
                                <th
                                  key={header}
                                  className={`px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide whitespace-nowrap ${
                                    isDarkMode ? 'text-white' : 'text-slate-900'
                                  }`}
                                >
                                  {header}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-800/60">
                            {dsmCheckRows.map((row) => {
                              const isBreach = row.excessDeviationMw > DSM_EPSILON;
                              const isPending = row.status === 'Awaiting meter' || row.status === 'No SLDC data';
                              return (
                                <tr key={`dsm-check-top-${row.block}`} className={isDarkMode ? 'hover:bg-slate-800/40' : 'hover:bg-slate-50'}>
                                  <td className={`px-3 py-2 font-medium whitespace-nowrap ${isDarkMode ? 'text-slate-100' : 'text-slate-900'}`}>
                                    B{row.block} - {row.time}
                                  </td>
                                  <td className="px-3 py-2 whitespace-nowrap tabular-nums text-cyan-300">
                                    {Number.isFinite(row.scheduled) ? `${formatDsmMw(row.scheduled, 2)} MW` : '-'}
                                  </td>
                                  <td className={`px-3 py-2 whitespace-nowrap tabular-nums font-semibold ${isDarkMode ? 'text-slate-100' : 'text-slate-900'}`}>
                                    {Number.isFinite(row.actual) ? `${formatDsmMw(row.actual, 2)} MW` : '-'}
                                  </td>
                                  <td className={`px-3 py-2 whitespace-nowrap tabular-nums font-semibold ${
                                    isBreach ? 'text-red-500' : 'text-emerald-500'
                                  }`}>
                                    {Number.isFinite(row.deviation) ? `${row.deviation >= 0 ? '+' : ''}${formatDsmMw(row.deviation, 3)} MW` : '-'}
                                  </td>
                                  <td className={`px-3 py-2 whitespace-nowrap tabular-nums ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>
                                    {Number.isFinite(row.percentage) ? `${row.percentage >= 0 ? '+' : ''}${row.percentage.toFixed(2)}%` : '-'}
                                  </td>
                                  <td className={`px-3 py-2 whitespace-nowrap tabular-nums ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>
                                    {Number.isFinite(row.lowerLimitMw) && Number.isFinite(row.upperLimitMw)
                                      ? `${formatDsmMw(row.lowerLimitMw, 3)} to ${formatDsmMw(row.upperLimitMw, 3)} MW`
                                      : '-'}
                                  </td>
                                  <td className={`px-3 py-2 whitespace-nowrap tabular-nums font-semibold ${
                                    row.penaltyRs > 0 ? 'text-red-500' : 'text-emerald-500'
                                  }`}>
                                    Rs {Number(row.penaltyRs || 0).toFixed(2)}
                                  </td>
                                  <td className={`px-3 py-2 whitespace-nowrap tabular-nums ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>
                                    {Number.isFinite(row.accuracy) ? `${row.accuracy.toFixed(2)}%` : '-'}
                                  </td>
                                  <td className="px-3 py-2 whitespace-nowrap">
                                    {isPending ? (
                                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-slate-500/15 text-slate-300 text-xs font-semibold">
                                        <Clock className="w-3 h-3" />
                                        {row.status}
                                      </span>
                                    ) : isBreach ? (
                                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-red-500/15 text-red-500 text-xs font-semibold">
                                        <AlertTriangle className="w-3 h-3" />
                                        {row.status}
                                      </span>
                                    ) : (
                                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-emerald-500/15 text-emerald-500 text-xs font-semibold">
                                        No penalty
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
                  )}
                </div>
              )}

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
                              ? `Editing is disabled for other future dates. Previous days, today (${todayIst}), and tomorrow (${tomorrowIst}) are editable in day-ahead flow.`
                              : `Editing is disabled for future dates. Previous days and today (${todayIst}) are editable.`}
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
                                    ? `Editing is allowed for previous days, today (${todayIst}), and tomorrow (${tomorrowIst}) in day-ahead flow`
                                    : `Editing is allowed for previous days and today (${todayIst})`)
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
                        type="button"
                        onClick={() => {
                          const nextColumn = tableDisplayColumn || 'algo';
                          setTableGraphColumn(nextColumn);
                          setShowTableGraph((prev) => !prev || tableGraphColumn !== nextColumn);
                        }}
                        disabled={!editedData.length}
                        title={!editedData.length ? 'Load schedule data first' : ''}
                        className="w-full sm:w-auto px-5 sm:px-6 py-2.5 sm:py-3 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 text-white font-semibold hover:from-cyan-500 hover:to-blue-500 transition-all duration-300 flex items-center justify-center gap-2 shadow-lg shadow-cyan-500/25 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <BarChart2 className="w-5 h-5" />
                        Plot Graph
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
                            const safeNext = next === 'dayAhead' || next === 'implementedSldc' ? next : 'algo';
                            setBulkColumn(safeNext);
                            setTableGraphColumn(safeNext);
                            if (safeNext === 'implementedSldc' && !(vedanjaySldcLatest?.data || []).length) {
                              loadLatestVedanjaySldcSchedule({ silent: false });
                            }
                            setActiveCell(null);
                            setCellDrafts({});
                          }}
                          className="px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-xs text-slate-200"
                        >
                          <option value="algo">System Schedule (MW)</option>
                          <option value="dayAhead">Day-ahead (MW)</option>
                          <option value="implementedSldc">Implemented schedule in SLDC</option>
                        </select>
                      </div>
                      <div className="flex-1 flex flex-col sm:flex-row sm:items-center gap-2">
                        <input
                          value={bulkValue}
                          onChange={(e) => setBulkValue(e.target.value)}
                          disabled={bulkColumn === 'implementedSldc'}
                          placeholder={bulkColumn === 'implementedSldc' ? 'Implemented SLDC schedule is display-only' : 'e.g. 100, +10%, =value * 1.1'}
                          className="flex-1 px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-sm text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-400/70 focus:border-emerald-400/60 disabled:opacity-60"
                        />
                        <button
                          onClick={handleApplyBulk}
                          disabled={bulkColumn === 'implementedSldc'}
                          className="px-4 py-2 rounded-lg bg-emerald-500 text-white text-sm font-semibold hover:bg-emerald-400 transition-colors shadow-sm shadow-emerald-500/30 disabled:opacity-50 disabled:cursor-not-allowed"
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

                {false && hasImplementedSldcSchedule && (
                  <div className="px-4 sm:px-6 py-3 border-b border-slate-700/70 bg-slate-950/40">
                    <button
                      type="button"
                      onClick={() => setShowDsmCheck((prev) => !prev)}
                      className={`w-full rounded-xl border px-4 py-3 text-left transition-all ${
                        isDarkMode
                          ? 'border-cyan-500/30 bg-slate-900/80 hover:bg-slate-900 text-slate-100'
                          : 'border-cyan-200 bg-white hover:bg-cyan-50 text-slate-900'
                      }`}
                      aria-expanded={showDsmCheck}
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-400">
                            {showDsmCheck ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                          </span>
                          <div>
                            <div className="text-sm font-bold">DSM Check</div>
                            <div className={`text-xs ${isDarkMode ? 'text-slate-400' : 'text-slate-600'}`}>
                              Implemented schedule in SLDC vs meter data
                            </div>
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 font-semibold text-cyan-300">
                            {dsmCheckSummary.calculatedBlocks} blocks checked
                          </span>
                          <span className={`rounded-lg px-2.5 py-1 font-semibold ${
                            dsmCheckSummary.breachCount > 0
                              ? 'bg-red-500/10 text-red-400 border border-red-500/30'
                              : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                          }`}>
                            {dsmCheckSummary.breachCount} breaches
                          </span>
                        </div>
                      </div>
                    </button>

                    {showDsmCheck && (
                      <div className={`mt-3 rounded-xl border overflow-hidden ${
                        isDarkMode ? 'border-slate-700 bg-slate-900/70' : 'border-slate-200 bg-white'
                      }`}>
                        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 p-3 sm:p-4 border-b border-slate-700/50">
                          {[
                            ['DSM Breaches', dsmCheckSummary.breachCount],
                            ['Total Penalty', `Rs ${dsmCheckSummary.totalPenalty.toFixed(2)}`],
                            ['Max Deviation', `${formatDsmMw(dsmCheckSummary.maxDeviation, 3, '0.000')} MW`],
                            ['Within Band', `${dsmCheckSummary.withinBand}%`],
                          ].map(([label, value]) => (
                            <div key={label} className={`rounded-lg border px-3 py-2 ${
                              isDarkMode ? 'border-slate-700 bg-slate-950/50' : 'border-slate-200 bg-slate-50'
                            }`}>
                              <div className={`text-[11px] uppercase tracking-wide ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                                {label}
                              </div>
                              <div className={`mt-1 text-sm font-bold ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
                                {value}
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="overflow-auto max-h-[360px]">
                          <table className="w-full text-sm">
                            <thead className={`sticky top-0 z-10 ${isDarkMode ? 'bg-slate-800' : 'bg-slate-100'}`}>
                              <tr>
                                {[
                                  'Block/Time',
                                  'Schedule MW',
                                  'Meter Data',
                                  'Deviation',
                                  'Deviation %',
                                  'Allowed Band',
                                  'Penalty',
                                  'Accuracy %',
                                  'Status',
                                ].map((header) => (
                                  <th
                                    key={header}
                                    className={`px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide whitespace-nowrap ${
                                      isDarkMode ? 'text-white' : 'text-slate-900'
                                    }`}
                                  >
                                    {header}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/60">
                              {dsmCheckRows.map((row) => {
                                const isBreach = row.excessDeviationMw > DSM_EPSILON;
                                const isPending = row.status === 'Awaiting meter' || row.status === 'No SLDC data';
                                return (
                                  <tr key={`dsm-check-${row.block}`} className={isDarkMode ? 'hover:bg-slate-800/40' : 'hover:bg-slate-50'}>
                                    <td className={`px-3 py-2 font-medium whitespace-nowrap ${isDarkMode ? 'text-slate-100' : 'text-slate-900'}`}>
                                      B{row.block} - {row.time}
                                    </td>
                                    <td className="px-3 py-2 whitespace-nowrap tabular-nums text-cyan-300">
                                      {Number.isFinite(row.scheduled) ? `${formatDsmMw(row.scheduled, 2)} MW` : '-'}
                                    </td>
                                    <td className={`px-3 py-2 whitespace-nowrap tabular-nums font-semibold ${isDarkMode ? 'text-slate-100' : 'text-slate-900'}`}>
                                      {Number.isFinite(row.actual) ? `${formatDsmMw(row.actual, 2)} MW` : '-'}
                                    </td>
                                    <td className={`px-3 py-2 whitespace-nowrap tabular-nums font-semibold ${
                                      isBreach ? 'text-red-500' : 'text-emerald-500'
                                    }`}>
                                      {Number.isFinite(row.deviation) ? `${row.deviation >= 0 ? '+' : ''}${formatDsmMw(row.deviation, 3)} MW` : '-'}
                                    </td>
                                    <td className={`px-3 py-2 whitespace-nowrap tabular-nums ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>
                                      {Number.isFinite(row.percentage) ? `${row.percentage >= 0 ? '+' : ''}${row.percentage.toFixed(2)}%` : '-'}
                                    </td>
                                    <td className={`px-3 py-2 whitespace-nowrap tabular-nums ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>
                                      {Number.isFinite(row.lowerLimitMw) && Number.isFinite(row.upperLimitMw)
                                        ? `${formatDsmMw(row.lowerLimitMw, 3)} to ${formatDsmMw(row.upperLimitMw, 3)} MW`
                                        : '-'}
                                    </td>
                                    <td className={`px-3 py-2 whitespace-nowrap tabular-nums font-semibold ${
                                      row.penaltyRs > 0 ? 'text-red-500' : 'text-emerald-500'
                                    }`}>
                                      Rs {Number(row.penaltyRs || 0).toFixed(2)}
                                    </td>
                                    <td className={`px-3 py-2 whitespace-nowrap tabular-nums ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>
                                      {Number.isFinite(row.accuracy) ? `${row.accuracy.toFixed(2)}%` : '-'}
                                    </td>
                                    <td className="px-3 py-2 whitespace-nowrap">
                                      {isPending ? (
                                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-slate-500/15 text-slate-300 text-xs font-semibold">
                                          <Clock className="w-3 h-3" />
                                          {row.status}
                                        </span>
                                      ) : isBreach ? (
                                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-red-500/15 text-red-500 text-xs font-semibold">
                                          <AlertTriangle className="w-3 h-3" />
                                          {row.status}
                                        </span>
                                      ) : (
                                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-emerald-500/15 text-emerald-500 text-xs font-semibold">
                                          No penalty
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
                    )}
                  </div>
                )}

                <div className={`flex flex-col ${showTableGraph ? 'lg:flex-row' : ''}`}>
                <div className={`overflow-auto max-h-[520px] ${showTableGraph ? 'lg:w-3/5 lg:border-r lg:border-slate-700/50' : 'w-full'}`}>
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
                        {['Block', 'Time Period', tableScheduleColumnLabel, 'Status'].map((h) => (
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
                        const algoDraft = cellDrafts[algoKey];
                        const dayAheadDraft = cellDrafts[dayAheadKey];
                        const algoActive = activeCell?.rowIndex === i && activeCell?.column === 'algo';
                        const dayAheadActive = activeCell?.rowIndex === i && activeCell?.column === 'dayAhead';
                        const canEditAlgo = editingMode && activeEditColumn === 'algo';
                        const canEditDayAhead = editingMode && activeEditColumn === 'dayAhead';
                        const systemBaselineValue = originalData?.[i]?.algo ?? row.algo;
                        const implementedValue = getTableScheduleValue(row, i);
                        const displayedEditableColumn =
                          tableDisplayColumn === 'algo' || tableDisplayColumn === 'dayAhead'
                            ? tableDisplayColumn
                            : null;
                        const displayedCellChanged = displayedEditableColumn
                          ? isCellChanged(i, displayedEditableColumn)
                          : false;
                        const savedChangeForCell = displayedEditableColumn
                          ? [...(Array.isArray(changes) ? changes : [])]
                              .reverse()
                              .find((change) => Number(change?.block) === Number(row?.block))
                          : null;
                        const showValueComparison = displayedCellChanged || Boolean(savedChangeForCell);
                        const originalDisplayValue = savedChangeForCell
                          ? savedChangeForCell.oldValue
                          : displayedEditableColumn
                            ? (originalData?.[i]?.[displayedEditableColumn] ?? '')
                            : '';
                        const modifiedDisplayValue = savedChangeForCell
                          ? savedChangeForCell.newValue
                          : displayedEditableColumn
                            ? (row?.[displayedEditableColumn] ?? '')
                            : '';
                        const valueComparison = showValueComparison ? (
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-tight">
                            <span className="text-slate-400">
                              Original: <span className="font-semibold text-red-400">{originalDisplayValue === '' ? '-' : originalDisplayValue} MW</span>
                            </span>
                            <span className="text-slate-400">
                              Modified: <span className="font-semibold text-emerald-400">{modifiedDisplayValue === '' ? '-' : modifiedDisplayValue} MW</span>
                            </span>
                          </div>
                        ) : null;
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

                            <td className="px-4 sm:px-5 py-3 sm:py-4">
                              {tableDisplayColumn === 'algo' && canEditAlgo ? (
                                <div>
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
                                  {valueComparison}
                                </div>
                              ) : tableDisplayColumn === 'dayAhead' && canEditDayAhead ? (
                                <div>
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
                                  {valueComparison}
                                </div>
                              ) : tableDisplayColumn === 'algo' ? (
                                <div>
                                  <span className="text-xs sm:text-sm font-semibold text-indigo-400">{systemBaselineValue}</span>
                                  {valueComparison}
                                </div>
                              ) : tableDisplayColumn === 'dayAhead' ? (
                                <div>
                                  <span className="text-xs sm:text-sm font-semibold text-teal-300">{row.dayAhead ?? '0'}</span>
                                  {valueComparison}
                                </div>
                              ) : (
                                <span className="text-xs sm:text-sm font-semibold text-cyan-300">
                                  {implementedValue === '' ? '-' : implementedValue}
                                </span>
                              )}
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
                {showTableGraph && (
                  <div className="lg:w-2/5 p-4 sm:p-5 bg-slate-950/30">
                    <div className="h-full rounded-xl border border-slate-700/50 bg-slate-900/60 p-3 sm:p-4">
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3">
                        <div>
                          <h4 className="text-sm font-bold text-white">Plotted Graph</h4>
                          <p className="text-xs text-slate-400">{tableGraphOption.label}</p>
                        </div>
                        <select
                          value={tableGraphColumn}
                          onChange={(event) => setTableGraphColumn(event.target.value)}
                          className="px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-xs text-slate-200"
                        >
                          {tableGraphOptions.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </div>
                      <div className={`relative rounded-lg overflow-hidden border ${isDarkMode ? 'border-slate-700/50 bg-slate-800/30' : 'border-border bg-white'}`} style={{ height: 420 }}>
                        <Plot
                          data={tableGraphData}
                          layout={tableGraphLayout}
                          config={{ displayModeBar: false, responsive: true }}
                          style={{ width: '100%', height: '100%' }}
                          useResizeHandler
                        />
                      </div>
                    </div>
                  </div>
                )}
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
              <div ref={graphContainerRef} className={`relative h-[70vh] rounded-xl overflow-auto border ${isDarkMode ? 'border-slate-700/50 bg-slate-800/30' : 'border-border bg-white'}`}>
                {hasGraphPlotData ? (
                  <>
                    <ScheduleGraphHoverCard />
                    <Plot
                      data={[...plotData, hoverMarkerTrace]}
                      layout={plotLayout}
                      config={{ displayModeBar: false, responsive: true, doubleClick: 'reset+autosize' }}
                      style={{ width: '100%', height: '100%' }}
                      useResizeHandler
                      onHover={handlePlotHover}
                      onUnhover={handlePlotUnhover}
                      onClick={handlePlotClick}
                      onRelayout={handlePlotRelayout}
                      onDoubleClick={handlePlotDoubleClick}
                      onLegendClick={handleLegendClick}
                      onLegendDoubleClick={handleLegendDoubleClick}
                    />
                  </>
                ) : (
                  <div className="flex items-center justify-center h-full text-slate-500">
                    No graph data to plot
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

















