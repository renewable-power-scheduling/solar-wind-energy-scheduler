import { useState, useMemo, useEffect } from 'react';
import createPlotlyComponent from 'react-plotly.js/factory';
import Plotly from 'plotly.js-dist-min';
import {
  Download,
  CheckCircle,
  AlertTriangle,
  Edit3,
  Calendar,
  Wind,
  TrendingUp,
  Clock,
  FileText,
  RefreshCw,
  Upload,
  AlertCircle,
  Layers,
  Activity,
  BarChart2,
  ExternalLink,
  X,
  Loader2,
} from 'lucide-react';
import { api } from '@/services/api';
import { useApi } from '@/hooks/useApi';
import { LoadingSpinner } from '@/app/components/common/LoadingSpinner';
import { buildCsvText, downloadCsvText, downloadXlsxFromRows } from '@/app/components/common/downloadUtils';
import { useTheme } from '@/app/App';
import { toast } from 'sonner';
import { S3_BASE_URL } from '@/config/appConfig';
import { DSM_PENALTY_CONFIG_BY_STATE, DEFAULT_DSM_PENALTY_CONFIG } from '@/config/dsmPenaltyConfig';

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
    name: 'OSEPL',
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

function getSchedulePrefixes(date, plant) {
  const rawPrefixes = getPlantRawPrefixes(plant);
  const generatedPrefixes = getPlantGeneratedPrefixes(plant);
  return [
    ...rawPrefixes.map((prefix) => `${prefix}${date}/`),
    ...generatedPrefixes.map((prefix) => `${prefix}${date}/`),
    `${LEGACY_OUTPUTS_BASE_PREFIX}${date}/`,
  ];
}

function getIntradayPrefixes(date, plant) {
  const rawPrefixes = getPlantRawPrefixes(plant);
  const generatedPrefixes = getPlantGeneratedPrefixes(plant);
  return [
    ...rawPrefixes.map((prefix) => `${prefix}${date}/enercast_data/intraday/`),
    ...generatedPrefixes.map((prefix) => `${prefix}${date}/intraday/`),
    `${LEGACY_OUTPUTS_BASE_PREFIX}${date}/intraday/`,
    `${date}/intraday/`,
  ];
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

function mergeUniqueObjects(objectSets) {
  return Array.from(new Map(objectSets.flat().map((o) => [o.key, o])).values());
}

function isScheduleCsvKey(key) {
  const k = String(key || '').toLowerCase();
  return (
    k.endsWith('.csv') &&
    !k.includes('/intraday/') &&
    k.includes('schedule_from_')
  );
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
  const match = fileName.match(/schedule_from_(\d+)\.csv$/i);
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
// CSV PARSER — maps columns from schedule_from_XX.csv
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
  const blockIdx = normalizedHeaders.findIndex((h) => h.includes('block') || h.includes('blk'));
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
    return shifted >= 1 && shifted <= 96 ? shifted : null;
  };

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
      const hasTime = timeIdx !== -1 && String(timeRaw ?? '').trim() !== '';
      const blockFromTime = timeIdx !== -1 ? getBlockFromTimeText(timeRaw) : null;
      const fallbackBlock = idx + 1;
      let block = null;
      if (Number.isFinite(blockFromCol) && blockFromCol >= 1 && blockFromCol <= 96) {
        block = blockFromCol;
      } else if (Number.isFinite(blockFromTime)) {
        block = blockFromTime;
      } else if (!hasTime) {
        block = fallbackBlock;
      }
      const power = parseFloat(cols[powerIdx]);
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

// =============================================================================
// MAIN COMPONENT
// =============================================================================
export function SchedulePreparation({ onNavigate, context, filters }) {
  const { isDarkMode } = useTheme();
  // ── Modal states ────────────────────────────────────────────────────────
  const [showExportModal,     setShowExportModal]     = useState(false);
  const [downloadFormat,    setDownloadFormat]    = useState('csv');
  const [isOverwritingLatest, setIsOverwritingLatest] = useState(false);
  const [showValidationModal, setShowValidationModal] = useState(false);
  const [showDeleteModal,     setShowDeleteModal]     = useState(false);
  const [showSubmitModal,     setShowSubmitModal]     = useState(false);

  // ── Data states ──────────────────────────────────────────────────────────
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
  const [currentScheduleId,   setCurrentScheduleId]   = useState(null);
  const [validationErrors,    setValidationErrors]    = useState([]);
  const [changes,             setChanges]             = useState([]);
  const [isDataLoaded,        setIsDataLoaded]        = useState(false);
  const [loadedScheduleInfo,  setLoadedScheduleInfo]  = useState(null);
  const [loadingData,         setLoadingData]         = useState(false);
  const [loadError,           setLoadError]           = useState(null);

  // ── Graph states ─────────────────────────────────────────────────────────
  const [graphLoading,        setGraphLoading]        = useState(false);
  const [graphError,          setGraphError]          = useState(null);
  const [showGraphModal,      setShowGraphModal]      = useState(false);
  const [intradayCurve,       setIntradayCurve]       = useState([]);
  const [meterCurve,          setMeterCurve]          = useState([]);

  const getChangesStorageKey = () => {
    const plant = String(loadedScheduleInfo?.plant || '').trim().toUpperCase();
    const date = String(loadedScheduleInfo?.date || selectedDate || '').trim();
    const sourceKey = String(
      loadedScheduleInfo?.latestNumericKey || loadedScheduleInfo?.sourceKey || ''
    ).trim();
    if (!plant || !date || !sourceKey) return '';
    return `vedanjay-schedule-changes|${plant}|${date}|${sourceKey}`;
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

  // ── Filter states ────────────────────────────────────────────────────────
  const { data: apiPlantsData } = useApi(
    () => api.plants.getAll({ noMock: true }),
    { immediate: true, initialData: { plants: [], total: 0, stats: {} } }
  );
  const plantsData = useMemo(() => {
    const apiPlants = apiPlantsData?.plants || [];
    if (!apiPlants.length) {
      return { plants: S3_PLANTS, total: S3_PLANTS.length, stats: {} };
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
      const state = normalizeStateLabel(plant.state || match?.state || '');
      return { ...plant, code, capacityMw, type, state };
    });
    const mergedKeys = new Set(enriched.map((p) => normalizePlantKey(p.code || p.name)));
    const extras = S3_PLANTS.filter((p) => !mergedKeys.has(normalizePlantKey(p.code || p.name)));
    return { plants: [...enriched, ...extras], total: enriched.length + extras.length, stats: apiPlantsData?.stats || {} };
  }, [apiPlantsData]);

  const [selectedState, setSelectedState] = useState(filters?.state || S3_PLANTS[0].state);
  const [selectedPlant, setSelectedPlant] = useState(filters?.plant || S3_PLANTS[0].name);
  const [selectedDate,  setSelectedDate]  = useState(
    filters?.date || new Date().toISOString().split('T')[0]
  );

  const fromDashboard = context?.fromDashboard;
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

  // ── Available plants ─────────────────────────────────────────────────────
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
  const handleLoadData = async (dateOverride) => {
    if (selectedState === 'Select State' || selectedPlant === 'Select Plant') {
      toast.error('Please select both State and Plant to load data');
      return;
    }
    if (selectedPlantConfig && selectedState !== selectedPlantConfig.state) {
      toast.error(`Selected plant is in ${selectedPlantConfig.state}. Please select the correct state.`);
      return;
    }

    const chosenPlant = selectedPlantConfig || plantsData.plants[0] || S3_PLANTS[0];
    const targetDate = typeof dateOverride === 'string'
      ? dateOverride
      : dateOverride instanceof Date
        ? dateOverride.toISOString().split('T')[0]
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
    setGraphError(null);
    setIntradayCurve([]);
    setMeterCurve([]);

    try {
      const scheduleObjectsFlat = await listS3ObjectsAcrossPrefixes(getSchedulePrefixes(targetDate, chosenPlant));
      const objects = mergeUniqueObjects([scheduleObjectsFlat]);

      if (!objects.length) {
        throw new Error(`No files found in S3 for date: ${targetDate}`);
      }

      // ── 1. Load schedule CSV ─────────────────────────────────────────────
      const scheduleFiles = objects.filter((o) => isScheduleCsvKey(o.key));
      const requestedFile = context?.fileName
        ? scheduleFiles.find((o) => o.key.endsWith(`/${context.fileName}`) || o.key.endsWith(context.fileName))
        : null;
      const sortedCandidates = [...scheduleFiles].sort((a, b) => {
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
      const numericCandidates = sortedCandidates.filter((o) =>
        /schedule_from_\d+\.csv$/i.test(String(o.key || ''))
      );
      const latestNumericCandidate = numericCandidates[0] || null;
      const candidates = requestedFile
        ? [requestedFile, ...sortedCandidates.filter((o) => o.key !== requestedFile.key)]
        : sortedCandidates;

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
        const intradayObjectsFlat = await listS3ObjectsAcrossPrefixes(getIntradayPrefixes(targetDate, chosenPlant));
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
        latestNumericKey: latestNumericCandidate?.key || null,
        source:   loadedFromIntradayFallback ? 'S3 (intraday fallback)' : 'S3',
      });

      // ── 2. Load latest intraday + meter curves for Plotly ───────────────
      setGraphLoading(true);
      const curveWarnings = [];

      try {
        // Use latest intraday from date-root path (same logic as Schedule Comparison).
        const intradayObjectsFlat = await listS3ObjectsAcrossPrefixes(getIntradayPrefixes(targetDate, chosenPlant));
        const intradayObjectsMerged = mergeUniqueObjects([intradayObjectsFlat]);
        const intradayObjectsRoot = intradayObjectsMerged;
        const intradayObjectsOutputs = intradayObjectsMerged;
        const latestIntraday =
          pickLatestIntradayForDate(intradayObjectsRoot, chosenPlant.intradayPrefix) ||
          pickLatestIntradayForDate(intradayObjectsOutputs, chosenPlant.intradayPrefix) ||
          findLatestIntradayCsv(intradayObjectsRoot) ||
          findLatestIntradayCsv(intradayObjectsOutputs) ||
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
      } catch {
        // Ignore intraday curve load warning in UI
      }

      try {
        if (isMeterAvailable(chosenPlant)) {
          // Always use latest updated meter CSV by LastModified.
          const meterObjectsFlat = await listS3ObjectsAcrossPrefixes(getMeterPrefixes(targetDate, chosenPlant));
          const meterObjects = mergeUniqueObjects([meterObjectsFlat]);
          const meterObjectsOutputs = meterObjects;
          const meterObject = findLatestMeterCsv(meterObjects) || findLatestMeterCsv(objects);
          const meterObjectFallback = meterObject || findLatestMeterCsv(meterObjectsOutputs);

          if (!meterObjectFallback) {
            throw new Error('Meter CSV not found');
          }

          const meterUrl = `${S3_BASE_URL}/${String(meterObjectFallback.key || '').split('/').map((s) => encodeURIComponent(s)).join('/')}`;
          const meterText = await fetch(meterUrl).then((r) => {
            if (!r.ok) throw new Error(`Meter fetch failed: ${r.status}`);
            return r.text();
          });
          const parsedMeter = parseMeterCsvByBlock(meterText);
          setMeterCurve(parsedMeter);
        } else {
          setMeterCurve([]);
        }
      } catch {
        // Ignore meter curve load warning in UI
      }

      setGraphError(curveWarnings.length ? curveWarnings.join(' • ') : null);
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

  // Auto-load when navigated from Dashboard
  useEffect(() => {
    if (fromDashboard && context?.plant) {
      const dashboardDate = context?.date || selectedDate;
      const plantFromContext = plantsData.plants.find((plant) => plant.name === context.plant) || plantsData.plants[0] || S3_PLANTS[0];
      setSelectedState(plantFromContext.state);
      setSelectedPlant(plantFromContext.name);
      setSelectedDate(dashboardDate);
      handleLoadData(dashboardDate);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromDashboard]);


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

  const { loading: submitLoading, execute: submitScheduleData } = useApi(
    api.schedules.submit,
    {
      onSuccess: () => {
        setShowSubmitModal(false);
        toast.success('Schedule submitted!');
        onNavigate('dashboard');
      },
      onError: (e) => toast.error(`Submit failed: ${e.message}`),
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
    await submitScheduleData({
      plantName: loadedScheduleInfo?.plant,
      scheduleDate: selectedDate,
      status: 'Submitted',
      editedData,
    });
  };

  // Upload CSV handler removed

  const handleExport = async (format = 'csv') => {
    if (!editedData.length) { toast.error('No data to export'); return; }
    const headers = ['Block', 'Time', 'Algo Schedule (MW)', 'Intraday Forecast (MW)'];
    const rows = editedData.map((r) => [r.block, r.time, r.algo, r.intraday]);
    const filenameBase = `schedule-${loadedScheduleInfo?.date || selectedDate}`;
    if (format === 'xlsx') {
      await downloadXlsxFromRows(headers, rows, filenameBase, 'Schedule');
    } else {
      const csvText = buildCsvText(headers, rows);
      downloadCsvText(csvText, filenameBase);
    }
    setShowExportModal(false);
  };

  const buildOverwriteCsvText = (rowsOverride = null) => {
    const rowsToUse = Array.isArray(rowsOverride) ? rowsOverride : editedData;
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
      const algo = toUiNumericText(r.algo);
      const base = toUiNumericText(r.base || r.algo);
      const intraday = toUiNumericText(r.intraday || r.algo);
      const condition = String(r.condition || 'MANUAL_EDIT');
      return [block, timestamp, algo, condition, base, intraday].join(',');
    });
    return [headers.join(','), ...rows].join('\n');
  };

  const handleOverwriteLatest = async () => {
    if (!editedData.length) { toast.error('No data to save'); return; }
    const sourceKey = String(loadedScheduleInfo?.sourceKey || '').trim();
    const numericKey = String(loadedScheduleInfo?.latestNumericKey || '').trim();
    const targetKey = /schedule_from_\d+\.csv$/i.test(sourceKey) ? sourceKey : numericKey;
    if (!targetKey) {
      toast.error('Latest schedule key not found. Load schedule from S3 first.');
      return;
    }
    setIsOverwritingLatest(true);
    try {
      const csvText = buildOverwriteCsvText();
      await api.schedules.overwriteLatest({
        sourceFileKey: targetKey,
        csvText,
        requestedBy: 'admin',
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

  const overwriteLatestFromEdit = async (rowsOverride) => {
    const sourceKey = String(loadedScheduleInfo?.sourceKey || '').trim();
    const numericKey = String(loadedScheduleInfo?.latestNumericKey || '').trim();
    const targetKey = /schedule_from_\d+\.csv$/i.test(sourceKey) ? sourceKey : numericKey;
    if (!targetKey) return;
    try {
      const csvText = buildOverwriteCsvText(rowsOverride);
      await api.schedules.overwriteLatest({
        sourceFileKey: targetKey,
        csvText,
        requestedBy: 'admin',
      });
    } catch (error) {
      toast.error(error?.message || 'Failed to overwrite latest schedule');
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

  const hasEdits = editedData.some(
    (_, idx) => isCellChanged(idx, 'algo')
  );

  const getChangedRows = () => editedData
    .map((row, idx) => {
      if (!isCellChanged(idx, 'algo')) return null;
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
      const baseValue = toNumberSafe(updated[rowIndex]?.algo);
      const computed = evaluateFormula(bulkValue, baseValue);
      if (!Number.isFinite(computed)) {
        toast.error('Invalid formula or value');
        return;
      }
      updated[rowIndex] = {
        ...updated[rowIndex],
        algo: toUiNumericText(computed, updated[rowIndex].algo),
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

  const handleSaveEdits = async () => {
    if (!hasEdits) return;
    setIsOverwritingLatest(true);
    try {
      const rowsToSave = getChangedRows();
      await overwriteLatestFromEdit(editedData);

      const savedAt = new Date().toISOString();
      let nextChanges = [...changes];
      rowsToSave.forEach(({ row, idx }) => {
        const existing = nextChanges.find((c) => c.block === row.block);
        const oldValue = originalData[idx]?.algo ?? row.algo;
        const newValue = row.algo;
        if (existing) {
          nextChanges = nextChanges.map((c) =>
            c.block === row.block ? { ...c, newValue, savedAt } : c
          );
        } else {
          nextChanges = [...nextChanges, {
            block: row.block,
            time: row.time,
            oldValue,
            newValue,
            savedAt,
          }];
        }
        api.schedules.appendChangeLog({
          plantCode: getPlantCodeForChanges(),
          scheduleDate: String(loadedScheduleInfo?.date || selectedDate || '').trim(),
          sourceFileKey: String(loadedScheduleInfo?.latestNumericKey || loadedScheduleInfo?.sourceKey || ''),
          block: row.block,
          time: row.time,
          oldValue,
          newValue,
          savedAt,
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
      toast.success('Changes saved');
    } catch (error) {
      toast.error(error?.message || 'Failed to save changes');
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

  const plotSeries = useMemo(() => {
    const blocks = Array.from({ length: 96 }, (_, i) => i + 1);
    const toNumOrNull = (value) => {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };
    const scheduleMap = new Map(editedData.map((r) => [r.block, toNumOrNull(r.algo)]));
    const intradayMap = new Map(intradayCurve.map((r) => [r.block, toNumOrNull(r.forecast)]));
    const meterMap = new Map(meterCurve.map((r) => [r.block, toNumOrNull(r.generationMw)]));
    const capacityMw = Number(selectedPlantConfig?.capacityMw || 0);
    const plantState = selectedPlantConfig?.state;
    const plantType = selectedPlantConfig?.type || 'Solar';
    const allowedBandPercent = getAllowedBandPercent(plantState, plantType);
    const allowedBandMw = (capacityMw * allowedBandPercent) / 100;
    const intervals = blocks.map((b) => blockToInterval(b));
    const blockLabels = blocks.map((b, idx) => `Block ${b} (${intervals[idx]})`);
    return {
      blocks,
      intervals,
      blockLabels,
      allowedBandMw,
      systemSchedule: blocks.map((b) => (scheduleMap.has(b) ? scheduleMap.get(b) : null)),
      intradayForecast: blocks.map((b) => (intradayMap.has(b) ? intradayMap.get(b) : null)),
      actualMetered: blocks.map((b) => (meterMap.has(b) ? meterMap.get(b) : null)),
      allowedBandPercent,
      upperAllowedBand: blocks.map((b) => {
        const schedule = scheduleMap.has(b) ? scheduleMap.get(b) : null;
        return Number.isFinite(schedule) ? schedule + allowedBandMw : null;
      }),
      lowerAllowedBand: blocks.map((b) => {
        const schedule = scheduleMap.has(b) ? scheduleMap.get(b) : null;
        return Number.isFinite(schedule) ? schedule - allowedBandMw : null;
      }),
    };
  }, [editedData, intradayCurve, meterCurve, selectedPlantConfig]);

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
    }));

    const loadFromLocal = () => {
      try {
        const raw = localStorage.getItem(key);
        const parsed = raw ? JSON.parse(raw) : [];
        setChanges(Array.isArray(parsed) ? normalizeChangeRows(parsed) : []);
      } catch {
        setChanges([]);
      }
    };

    const loadFromS3 = async () => {
      if (!plantCode || !scheduleDate) return null;
      const changeKey = `generated/vedanjay/${plantCode}/outputs/${scheduleDate}/schedule_changes.json`;
      const changeUrl = `${S3_BASE_URL}/${changeKey.split('/').map((s) => encodeURIComponent(s)).join('/')}`;
      const response = await fetch(changeUrl);
      if (!response.ok) return null;
      const payload = await response.json();
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
        // Fall back to API/local below
      }
      if (!plantCode || !scheduleDate) {
        loadFromLocal();
        return;
      }
      api.schedules.getChangeLog({ plantCode, scheduleDate })
        .then((res) => {
          const items = Array.isArray(res?.items) ? res.items : [];
          const normalized = normalizeChangeRows(items);
          setChanges(normalized);
          persistChanges(normalized);
        })
        .catch(() => {
          loadFromLocal();
        });
    };

    loadChanges();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedScheduleInfo]);

  const plotLayout = useMemo(() => {
    return {
      margin: { l: 50, r: 20, t: 50, b: 40 },
      paper_bgcolor: isDarkMode ? 'rgba(0,0,0,0)' : '#ffffff',
      plot_bgcolor: isDarkMode ? 'rgba(0,0,0,0)' : '#ffffff',
      font: { color: isDarkMode ? '#cbd5e1' : '#1f2937', size: 11 },
      xaxis: {
        title: 'Block No',
        type: 'category',
        tickmode: 'array',
        tickvals: plotSeries.blockLabels.filter((_, idx) => idx % 12 === 0),
        ticktext: plotSeries.blocks.filter((_, idx) => idx % 12 === 0),
        gridcolor: isDarkMode ? 'rgba(148,163,184,0.2)' : 'rgba(100,116,139,0.22)'
      },
      yaxis: {
        title: 'Power (MW)',
        gridcolor: isDarkMode ? 'rgba(148,163,184,0.2)' : 'rgba(100,116,139,0.22)'
      },
      hovermode: 'x unified',
      hoverlabel: {
        bgcolor: isDarkMode ? '#1f2937' : '#ffffff',
        bordercolor: isDarkMode ? '#334155' : '#94a3b8',
        font: { color: isDarkMode ? '#e2e8f0' : '#0f172a', size: 12 }
      },
      legend: {
        orientation: 'h',
        x: 0,
        y: 1.2,
        yanchor: 'bottom',
        bgcolor: isDarkMode ? 'rgba(0,0,0,0)' : 'rgba(255,255,255,0.92)',
        font: { color: isDarkMode ? '#cbd5e1' : '#1f2937' },
      }
    };
  }, [isDarkMode, plotSeries]);

  const plotData = useMemo(() => ([
    {
      x: plotSeries.blockLabels,
      y: plotSeries.systemSchedule,
      type: 'scatter',
      mode: 'lines',
      name: 'Machine Generated Schedule (MW)',
      line: { color: '#6366f1', width: 2.5 },
      hovertemplate: 'Machine Generated: %{y} MW<extra></extra>',
      connectgaps: false
    },
    {
      x: plotSeries.blockLabels,
      y: plotSeries.upperAllowedBand,
      type: 'scatter',
      mode: 'lines',
      name: `Upper Allowed Band (+${plotSeries.allowedBandPercent}%)`,
      line: { color: '#ef4444', width: 2.5, dash: 'dot' },
      opacity: 0.95,
      hovertemplate: 'Upper Band: %{y} MW<extra></extra>',
      connectgaps: false
    },
    {
      x: plotSeries.blockLabels,
      y: plotSeries.lowerAllowedBand,
      type: 'scatter',
      mode: 'lines',
      name: `Lower Allowed Band (-${plotSeries.allowedBandPercent}%)`,
      line: { color: '#ef4444', width: 2.5, dash: 'dot' },
      opacity: 0.95,
      hovertemplate: 'Lower Band: %{y} MW<extra></extra>',
      connectgaps: false
    },
    {
      x: plotSeries.blockLabels,
      y: plotSeries.intradayForecast,
      type: 'scatter',
      mode: 'lines',
      name: 'Enercast Intraday Forecast (MW)',
      line: { color: '#f59e0b', width: 2.5 },
      hovertemplate: 'Enercast Intraday: %{y} MW<extra></extra>',
      connectgaps: false
    },
    {
      x: plotSeries.blockLabels,
      y: plotSeries.actualMetered,
      type: 'scatter',
      mode: 'lines',
      name: 'Meter Data (MW)',
      line: { color: isDarkMode ? '#ffffff' : '#000000', width: 2.5 },
      hovertemplate: 'Meter Data: %{y} MW<extra></extra>',
      connectgaps: false
    }
  ]), [plotSeries, isDarkMode]);

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

          {/* ── Page Header ────────────────────────────────────────────────── */}
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
                      <span className="text-slate-600 hidden sm:inline">•</span>
                      <span className="text-xs sm:text-sm">S3 Schedule Viewer</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* ── Filters ─────────────────────────────────────────────────────── */}
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
                          <span className="font-semibold">Loading…</span>
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
                      <span className="font-semibold">Plant:</span> {loadedScheduleInfo?.plant || '—'}{' '}
                      <span className="mx-1">|</span>
                      <span className="font-semibold">State:</span> {loadedScheduleInfo?.state || '—'}
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

          {/* ── Content (only when data is loaded) ──────────────────────── */}
          {(isDataLoaded || fromDashboard) && (
            <>
              {/* ── Plotly Graph + Status ──────────────────────────────────── */}
              <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 sm:gap-6">

                {/* Plotly HTML Graph — 2/3 width */}
                <div className="lg:col-span-3 rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm p-4 sm:p-6">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
                    <div className="flex items-center gap-3">
                      <div className="p-3 rounded-xl bg-indigo-500/10">
                        <BarChart2 className="w-5 h-5 sm:w-6 sm:h-6 text-indigo-400" />
                      </div>
                      <div>
                        <h3 className="text-lg sm:text-xl font-bold text-foreground">Schedule Graph</h3>
                        <p className="text-xs sm:text-sm text-muted-foreground">
                          Interactive Plotly chart — {loadedScheduleInfo?.date || selectedDate}
                        </p>
                      </div>
                    </div>

                    <button
                      onClick={() => setShowGraphModal(true)}
                      disabled={!editedData.length}
                      className="w-full sm:w-auto flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-slate-800/50 text-slate-300 text-xs sm:text-sm font-semibold hover:bg-slate-700 hover:text-white transition-all border border-slate-700 disabled:opacity-50"
                    >
                      <ExternalLink className="w-4 h-4" />
                      Expand
                    </button>
                  </div>

                  {/* Graph area */}
                  <div className={`rounded-xl overflow-auto border ${isDarkMode ? 'border-slate-700/50 bg-slate-800/30' : 'border-border bg-white'}`} style={{ height: 420 }}>
                    {(loadingData || graphLoading) && (
                      <div className="flex items-center justify-center h-full gap-3 text-slate-400">
                        <LoadingSpinner size="md" />
                        <span className="text-sm">Loading graph…</span>
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
                        data={plotData}
                        layout={plotLayout}
                        config={{ displayModeBar: false, responsive: true }}
                        style={{ width: '100%', height: '100%' }}
                        useResizeHandler
                      />
                    )}
                  </div>
                  {graphError && <p className="mt-2 text-xs text-amber-300">{graphError}</p>}
                </div>

                {/* Status Panel — 1/3 width */}
                <div className="rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm p-2 sm:p-3 flex flex-col gap-2">
                  <div className="flex items-center gap-2 mb-0.5">
                    <div className="p-2 rounded-xl bg-emerald-500/10">
                      <Activity className="w-5 h-5 text-emerald-400" />
                    </div>
                    <div>
                      <h3 className="text-sm sm:text-base font-bold text-foreground">Schedule Status</h3>
                      <p className="text-xs text-muted-foreground">Overview</p>
                    </div>
                  </div>

                  {/* Plant info */}
                  <div className="p-2 bg-slate-800/50 rounded-xl border border-slate-700/50">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-xl bg-blue-500/20">
                          <Wind className="w-4 h-4 text-blue-400" />
                        </div>
                        <div>
                          <p className="text-xs font-semibold text-white">
                            {fromDashboard ? context.plant : loadedScheduleInfo?.plant || plantsData.plants[0]?.name || S3_PLANTS[0].name}
                          </p>
                        </div>
                      </div>
                      <span className="px-2.5 py-1 bg-emerald-500/10 text-emerald-400 text-xs font-semibold rounded-lg border border-emerald-500/20">
                        Active
                      </span>
                    </div>
                  </div>

                                    {/* File info */}
                  {loadedScheduleInfo?.fileName && (
                    <div className="p-2 bg-slate-800/50 rounded-xl border border-slate-700/50">
                      <p className="text-[11px] font-medium text-slate-400 mb-1">Source File</p>
                      <p className="text-[11px] font-mono text-indigo-300 break-all">
                        {loadedScheduleInfo.fileName}
                      </p>
                      {Number.isFinite(loadedScheduleInfo?.endingBlock) && loadedScheduleInfo?.endingBlockTime ? (
                        <p className="text-[11px] text-slate-400 mt-2">
                          Time:{loadedScheduleInfo.endingBlockTime}
                        </p>
                      ) : null}
                    </div>
                  )}

                  {/* Stats */}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="p-2 bg-slate-800/50 rounded-xl border border-slate-700/50 text-center">
                      <p className="text-[11px] text-slate-400 mb-1">Total Blocks</p>
                      <p className="text-lg sm:text-xl font-bold bg-gradient-to-r from-emerald-400 to-teal-400 bg-clip-text text-transparent">
                        {editedData.length}
                      </p>
                    </div>
                    <div className="p-2 bg-slate-800/50 rounded-xl border border-slate-700/50 text-center">
                      <p className="text-[11px] text-slate-400 mb-1">Modified</p>
                      <p className="text-lg sm:text-xl font-bold bg-gradient-to-r from-amber-400 to-orange-400 bg-clip-text text-transparent">
                        {editingMode ? getChangedRows().length : changes.length}
                      </p>
                    </div>
                  </div>

                  {/* Avg algo schedule */}
                  {editedData.length > 0 && (
                    <div className="p-2 bg-slate-800/50 rounded-xl border border-slate-700/50">
                      <p className="text-[11px] text-slate-400 mb-1">Avg Algo Schedule</p>
                      <p className="text-lg font-bold text-indigo-300">
                        {(() => {
                          const avg =
                            editedData.reduce((s, r) => s + parseFloat(r.algo || 0), 0) /
                            editedData.length;
                          const truncated = Math.trunc(avg * 10000) / 10000;
                          return truncated.toFixed(4);
                        })()}{' '}
                        <span className="text-sm font-normal text-slate-400">MW</span>
                      </p>
                    </div>
                  )}

                  {/* Action buttons */}
                  <div className="flex flex-col sm:flex-row gap-2 mt-auto">
                  </div>
                </div>
              </div>

              {/* ── Manual Changes Log ─────────────────────────────────────── */}
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
                      const delta = parseFloat(change.newValue) - parseFloat(change.oldValue);
                      const pct = parseFloat(change.oldValue) !== 0
                        ? ((delta / parseFloat(change.oldValue)) * 100).toFixed(1)
                        : '—';
                      return (
                        <div key={i} className="p-4 sm:p-5 bg-slate-800/50 rounded-xl border border-slate-700/50 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 hover:bg-slate-800/70 transition-all group">
                          <div className="flex items-center gap-4">
                            <div className="p-3 bg-amber-500/10 rounded-xl group-hover:bg-amber-500/20 transition-colors">
                              <Clock className="w-5 h-5 text-amber-400" />
                            </div>
                            <div>
                              <p className="text-sm font-semibold text-white">Block {change.block} — {change.time}</p>
                              <p className="text-xs text-slate-400 mt-1">
                                <span className="text-red-400 font-semibold">{change.oldValue} MW</span>
                                {' → '}
                                <span className="text-emerald-400 font-semibold">{change.newValue} MW</span>
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className={`text-sm font-semibold ${delta >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {delta >= 0 ? '+' : ''}{pct}%
                            </span>
                            <TrendingUp className={`w-5 h-5 ${delta >= 0 ? 'text-emerald-400' : 'text-red-400'}`} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* ── Schedule Table ─────────────────────────────────────────── */}
              <div className="rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm overflow-hidden">
                <div className="p-4 sm:p-6 border-b border-slate-700/50 bg-gradient-to-r from-slate-800/50 to-transparent">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="p-3 rounded-xl bg-indigo-500/10">
                        <FileText className="w-5 h-5 sm:w-6 sm:h-6 text-indigo-400" />
                      </div>
                      <div>
                        <h3 className="text-lg sm:text-xl font-bold text-white">15-Minute Schedule Blocks</h3>
                        <p className="text-xs sm:text-sm text-slate-400">{editedData.length} blocks — {loadedScheduleInfo?.date}</p>
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
                          }}
                          disabled={!editedData.length}
                          className="w-full sm:w-auto px-4 sm:px-5 py-2.5 sm:py-3 rounded-xl bg-slate-800 text-slate-200 font-semibold hover:bg-slate-700 transition-all flex items-center justify-center gap-2 border border-slate-700 disabled:opacity-50"
                        >
                          <Edit3 className="w-4 h-4" />
                          Edit
                        </button>
                      ) : (
                        <>
                          <button
                            onClick={handleSaveEdits}
                            disabled={!hasEdits || isOverwritingLatest}
                            className="w-full sm:w-auto px-4 sm:px-5 py-2.5 sm:py-3 rounded-xl bg-emerald-600 text-white font-semibold hover:bg-emerald-500 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                          >
                            <CheckCircle className="w-4 h-4" />
                            Save
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
                          value="algo"
                          disabled
                          className="px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-xs text-slate-200 opacity-70"
                        >
                          <option value="algo">Algo Schedule</option>
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
                    <thead className="bg-slate-800/90 backdrop-blur-sm sticky top-0 z-10 border-b border-slate-700/70">
                      <tr>
                        {editingMode && (
                          <th className={`px-4 sm:px-5 py-3 sm:py-4 text-left text-xs font-semibold uppercase tracking-wider whitespace-nowrap ${
                            isDarkMode ? 'text-slate-200' : 'text-black'
                          }`}>
                            <input
                              type="checkbox"
                              checked={editedData.length > 0 && selectedRows.length === editedData.length}
                              onChange={(e) => toggleSelectAll(e.target.checked)}
                              className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-indigo-500 focus:ring-indigo-500/60"
                            />
                          </th>
                        )}
                        {['Block', 'Time Period', 'Algo Schedule (MW)', 'Intraday (MW)', 'Status'].map((h) => (
                          <th
                            key={h}
                            className={`px-4 sm:px-5 py-3 sm:py-4 text-left text-xs font-semibold uppercase tracking-wider whitespace-nowrap ${
                              isDarkMode ? 'text-slate-200' : 'text-black'
                            }`}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {editedData.map((row, i) => {
                        const rowEdited = isCellChanged(i, 'algo');
                        const isSelected = selectedRows.includes(i);
                        const algoKey = getCellKey(i, 'algo');
                        const intradayKey = getCellKey(i, 'intraday');
                        const algoDraft = cellDrafts[algoKey];
                        const intradayDraft = cellDrafts[intradayKey];
                        const algoActive = activeCell?.rowIndex === i && activeCell?.column === 'algo';
                        const intradayActive = activeCell?.rowIndex === i && activeCell?.column === 'intraday';
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

                            {/* Algo Schedule — editable */}
                            <td className="px-4 sm:px-5 py-3 sm:py-4">
                              {editingMode ? (
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
                              <span className={`text-xs sm:text-sm ${isDarkMode ? 'text-slate-400' : 'text-black'}`}>
                                {row.intraday}
                              </span>
                            </td>
                            <td className="px-4 sm:px-5 py-3 sm:py-4">
                              {rowEdited ? (
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

      {/* ══════════════════════════════════════════════════════════════════════
          MODALS
      ══════════════════════════════════════════════════════════════════════ */}

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
                    data={plotData}
                    layout={plotLayout}
                    config={{ displayModeBar: false, responsive: true }}
                    style={{ width: '100%', height: '100%' }}
                    useResizeHandler
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
                {deleteLoading ? 'Deleting…' : 'Delete'}
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
                ['Modified Blocks', changes.length],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between p-3 bg-slate-800/50 rounded-xl">
                  <span className="text-sm text-slate-400">{k}</span>
                  <span className="text-sm font-semibold text-white">{v}</span>
                </div>
              ))}
            </div>
            <div className="px-6 py-4 border-t border-slate-700 flex gap-3">
              <button onClick={() => setShowSubmitModal(false)} className="flex-1 px-4 py-2 rounded-xl border border-slate-700 text-slate-300 hover:bg-slate-800 transition-all font-medium">Cancel</button>
              <button onClick={handleSubmitToDatabase} disabled={submitLoading} className="flex-1 px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-500 transition-all font-medium disabled:opacity-50">
                {submitLoading ? 'Submitting…' : 'Submit'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}


















