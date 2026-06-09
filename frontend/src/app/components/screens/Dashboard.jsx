import { Filter, ChevronDown, X, Layers, TrendingUp, FileText, RefreshCw, LayoutDashboard, Download } from 'lucide-react';
import { useState, useMemo, useEffect, useRef } from 'react';
import { Activity, AlertCircle, Eye, MoreHorizontal, X as XIcon, Wind, Sun, Zap, Upload, ArrowRight, AlertTriangle } from 'lucide-react';
import { api } from '@/services/api';
import { useApi } from '@/hooks/useApi';
import { LoadingSpinner, SkeletonLoader } from '@/app/components/common/LoadingSpinner';
import { ErrorMessage } from '@/app/components/common/ErrorMessage';
import DownloadFormatModal from '@/app/components/common/DownloadFormatModal';
import { downloadCsvText, downloadXlsxFromCsvText } from '@/app/components/common/downloadUtils';
import { toast } from 'sonner';
import { S3_BASE_URL } from '@/config/appConfig';
import { parseBlockFromTimestamp } from '@/utils/meterTime';
import { isNonFrozenScheduleCsvKey, fetchTextFromS3Optional } from '@/services/s3Utils';
import { useAuth } from '@/app/appContexts';
import { getDisabledPlantPattern, isAdminUser } from '@/utils/plantAccess';
import { displayPlantName } from '@/utils/plantDisplay';
import {
  computeIntradayRunIndexByKey,
  formatMachineScheduleDisplayName,
  slugifyPlant,
} from '@/utils/machineScheduleDisplay';

// =============================================================================
// S3 CONFIG
// =============================================================================
const RAW_BASE_PREFIXES_BY_SITE = {
  BHUPALPALLY: 'raw/vedanjay/BHUPALPALLY/',
  CME: 'raw/vedanjay/CME/',
  GSNP: 'raw/vedanjay/GSNP/',
  KASIPET: 'raw/vedanjay/KASIPET/',
  KILAJ: 'raw/vedanjay/KILAJ/',
  KOTHAGUDEM: 'raw/vedanjay/KOTHAGUDEM/',
  OSEPL: 'raw/vedanjay/OSEPL/',
  ANJANGAON: 'raw/vedanjay/ANJANGAON/',
  ANJANGOAN: 'raw/vedanjay/ANJANGOAN/',
  SIRMOUR: 'raw/vedanjay/SIRMOUR/',
};
const LEGACY_RAW_BASE_PREFIXES_BY_SITE = {
  GSNP: 'raw/GSNP/gsnp/',
  SIRMOUR: 'raw/Sirmour/sirmour/',
};
const LEGACY_GENERATED_OUTPUTS_BASE_PREFIXES_BY_SITE = {
  GSNP: 'generated/GSNP/gsnp/outputs/',
  SIRMOUR: 'generated/Sirmour/sirmour/outputs/',
};
const GENERATED_OUTPUTS_BASE_PREFIXES_BY_SITE = {
  BHUPALPALLY: 'generated/vedanjay/BHUPALPALLY/outputs/',
  CME: 'generated/vedanjay/CME/outputs/',
  GSNP: 'generated/vedanjay/GSNP/outputs/',
  KASIPET: 'generated/vedanjay/KASIPET/outputs/',
  KILAJ: 'generated/vedanjay/KILAJ/outputs/',
  KOTHAGUDEM: 'generated/vedanjay/KOTHAGUDEM/outputs/',
  OSEPL: 'generated/vedanjay/OSEPL/outputs/',
  ANJANGAON: 'generated/vedanjay/ANJANGAON/outputs/',
  ANJANGOAN: 'generated/vedanjay/ANJANGOAN/outputs/',
  SIRMOUR: 'generated/vedanjay/SIRMOUR/outputs/',
};
const GENERATED_OUTPUTS_BASE_PREFIXES = Object.values(GENERATED_OUTPUTS_BASE_PREFIXES_BY_SITE).filter(Boolean);
const LEGACY_GENERATED_OUTPUTS_BASE_PREFIXES = Object.values(LEGACY_GENERATED_OUTPUTS_BASE_PREFIXES_BY_SITE).filter(Boolean);
const LEGACY_OUTPUTS_BASE_PREFIX = 'outputs/';

const S3_PLANTS = [];

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

function derivePlantCodeFromName(name) {
  const text = String(name || '').trim();
  if (!text) return '';
  const parenMatch = text.match(/\(([^)]+)\)/);
  if (parenMatch?.[1]) {
    return parenMatch[1].trim().toUpperCase();
  }
  const tokens = text.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!tokens.length) return '';
  if (tokens.length === 1) {
    return tokens[0].toUpperCase();
  }
  const shortTokens = tokens.filter((token) => token.length <= 5);
  if (shortTokens.length) {
    return shortTokens[shortTokens.length - 1].toUpperCase();
  }
  return tokens.map((token) => token[0]).join('').toUpperCase();
}

function normalizePlantKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getGeneratedPlantCodeAliases(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (normalized === 'ANJANGAON' || normalized === 'ANJANGOAN') return ['ANJANGAON', 'ANJANGOAN'];
  return normalized ? [normalized] : [];
}

function extractPlantCodeFromKey(key) {
  const normalized = String(key || '').toLowerCase();
  const vedanjayMatch = normalized.match(/\/vedanjay\/([^/]+)\//);
  if (vedanjayMatch?.[1]) {
    const code = vedanjayMatch[1].toUpperCase();
    return code === 'ANJANGOAN' ? 'ANJANGAON' : code;
  }
  const rawVedanjayMatch = normalized.match(/raw\/vedanjay\/([^/]+)\//);
  if (rawVedanjayMatch?.[1]) {
    const code = rawVedanjayMatch[1].toUpperCase();
    return code === 'ANJANGOAN' ? 'ANJANGAON' : code;
  }
  if (normalized.includes('/kilaj/')) return 'KILAJ';
  if (normalized.includes('/osepl/')) return 'OSEPL';
  if (normalized.includes('/sirmour/')) return 'SIRMOUR';
  if (normalized.includes('/gsnp/')) return 'GSNP';
  return '';
}

function getDisplayPlantName(code) {
  if (!code) return '';
  if (code === 'GSNP') return 'Globus Steel N Power (GSNP)';
  // UI label aliasing: keep canonical code OSEPL for logic, but display as OSEL.
  return displayPlantName(code);
}

function isMeterAvailable(plant) {
  const code = String(plant?.code || derivePlantCodeFromName(plant?.name) || '').trim().toUpperCase();
  return code !== 'CME';
}

function buildDynamicPrefixes(plants) {
  const raw = [];
  const generated = [];
  plants.forEach((plant) => {
    const derived = derivePlantFoldersFromName(plant?.name);
    if (!derived) return;
    raw.push(`raw/vedanjay/${derived.upper}/`);
    if (derived.upper === 'ANJANGAON') raw.push('raw/vedanjay/ANJANGOAN/');
    raw.push(`raw/${derived.folder}/${derived.lower}/`);
    generated.push(`generated/vedanjay/${derived.upper}/outputs/`);
    if (derived.upper === 'ANJANGAON') generated.push('generated/vedanjay/ANJANGOAN/outputs/');
    generated.push(`generated/${derived.folder}/${derived.lower}/outputs/`);
  });
  return {
    raw: Array.from(new Set(raw)),
    generated: Array.from(new Set(generated)),
  };
}

const HIDDEN_PREVIEW_COLUMNS = new Set([
  'scaledenercastforecastmw',
  'conditionused',
  'baseforecast',
  'effectivebaseforecast',
  'deviationmw',
  'deviation',
  'deviationpct',
  'deviationpercent',
  'penaltyrs',
  'sourceschedule',
]);

function normalizeColumnName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
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

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { headers: [], rows: [] };
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
      } else if (ch === ',' && !inQuotes) {
        cells.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    cells.push(current.trim());
    return cells;
  };

  const headers = parseLine(lines[0]).map((h) => h.trim());
  const rows = lines.slice(1).map((line) => parseLine(line).map((v) => v.trim()));
  return { headers, rows };
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
  return Math.min(Math.max(block, 1), 96);
}

function getCompletedIstBlock() {
  const current = getCurrentIstBlock();
  return Math.max(current - 1, 1);
}

function getTodayIstIso() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function parseMeterSeriesMap(text) {
  const { headers, rows } = parseCsv(text);
  const normalizedHeaders = headers.map((h) => String(h || '').trim().toLowerCase());

  const blockIdx = normalizedHeaders.findIndex((h) => h.includes('block') || h.includes('blk'));
  const timeIdx = normalizedHeaders.findIndex((h) => h.includes('time'));
  let powerIdx = normalizedHeaders.findIndex((h) =>
    h.includes('active power') ||
    h.includes('meter power') ||
    h.includes('generation') ||
    h.includes('activepower') ||
    h.includes('act power') ||
    h.includes('kw') ||
    h.includes('mw')
  );
  if (powerIdx === -1 && rows.length) {
    const candidateScores = rows.reduce((acc, cols) => {
      cols.forEach((value, idx) => {
        if (idx === blockIdx || idx === timeIdx) return;
        const num = parseFloat(value);
        if (!Number.isFinite(num)) return;
        const entry = acc[idx] || { count: 0, sum: 0 };
        entry.count += 1;
        entry.sum += num;
        acc[idx] = entry;
      });
      return acc;
    }, {});
    const best = Object.entries(candidateScores)
      .map(([idx, data]) => ({ idx: Number(idx), count: data.count, sum: data.sum }))
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return b.sum - a.sum;
      })[0];
    if (best && best.count > 0) {
      powerIdx = best.idx;
    }
  }
  if (powerIdx === -1) return new Map();

  const powerHeader = normalizedHeaders[powerIdx] || '';
  const explicitKw = powerHeader.includes('(kw)') || powerHeader.includes(' kw');
  const explicitMw = powerHeader.includes('(mw)') || powerHeader.includes(' mw');

  const getBlockFromTimeText = (raw) => parseBlockFromTimestamp(raw, { totalBlocks: 96 });

  const parsedPoints = rows
    .map((cols, idx) => {
      const blockFromCol = blockIdx !== -1 ? parseBlockNumber(cols[blockIdx]) : null;
      const timeRaw = timeIdx !== -1 ? cols[timeIdx] : null;
      const hasTimeColumn = timeIdx !== -1;
      const blockFromTime = hasTimeColumn ? getBlockFromTimeText(timeRaw) : null;
      const fallbackBlock = idx + 1;
      let block = null;
      if (Number.isFinite(blockFromCol) && blockFromCol >= 1 && blockFromCol <= 96) {
        block = blockFromCol;
      } else if (Number.isFinite(blockFromTime)) {
        block = blockFromTime;
      } else if (!hasTimeColumn) {
        block = fallbackBlock;
      }
      const value = parseFloat(String(cols[powerIdx] ?? '').replace(/,/g, '').trim());
      if (!Number.isFinite(block) || block < 1 || block > 96 || !Number.isFinite(value)) return null;
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

function getMeterPrefixesForSite(date, plant, dynamicPrefixes = {}) {
  const siteCode = String(plant?.code || derivePlantCodeFromName(plant?.name) || '').trim().toUpperCase();
  const rawPrefix = RAW_BASE_PREFIXES_BY_SITE[siteCode];
  const legacyRawPrefix = LEGACY_RAW_BASE_PREFIXES_BY_SITE[siteCode];
  const generatedPrefixes = getGeneratedPlantCodeAliases(siteCode)
    .map((code) => GENERATED_OUTPUTS_BASE_PREFIXES_BY_SITE[code])
    .filter(Boolean);
  const derived = derivePlantFoldersFromName(plant?.name);
  const prefixes = [];
  if (rawPrefix) prefixes.push(`${rawPrefix}${date}/metered_data/`);
  if (siteCode === 'ANJANGAON') prefixes.push(`raw/vedanjay/ANJANGOAN/${date}/metered_data/`);
  if (legacyRawPrefix) prefixes.push(`${legacyRawPrefix}${date}/metered_data/`);
  generatedPrefixes.forEach((prefix) => prefixes.push(`${prefix}${date}/meter/`));
  if (LEGACY_GENERATED_OUTPUTS_BASE_PREFIXES_BY_SITE[siteCode]) {
    prefixes.push(`${LEGACY_GENERATED_OUTPUTS_BASE_PREFIXES_BY_SITE[siteCode]}${date}/meter/`);
  }
  if (derived) {
    prefixes.push(`raw/vedanjay/${derived.upper}/${date}/metered_data/`);
    if (derived.upper === 'ANJANGAON') prefixes.push(`raw/vedanjay/ANJANGOAN/${date}/metered_data/`);
    prefixes.push(`generated/vedanjay/${derived.upper}/outputs/${date}/meter/`);
    if (derived.upper === 'ANJANGAON') prefixes.push(`generated/vedanjay/ANJANGOAN/outputs/${date}/meter/`);
    prefixes.push(`generated/${derived.folder}/${derived.lower}/outputs/${date}/meter/`);
    prefixes.push(`raw/${derived.folder}/${derived.lower}/${date}/metered_data/`);
  }
  prefixes.push(`${LEGACY_OUTPUTS_BASE_PREFIX}${date}/meter/`, `${date}/meter/`);
  return Array.from(new Set(prefixes));
}

async function fetchCsvFromS3(key) {
  const url = `${S3_BASE_URL}/${String(key || '').split('/').map((s) => encodeURIComponent(s)).join('/')}`;
  const text = await fetch(url).then((r) => r.text());
  return { url, text };
}

function formatTimeFromIso(iso) {
  if (!iso) return '';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function extractEndingBlockFromScheduleFile(fileName) {
  const match = String(fileName || '').match(/schedule_(?:free(?:z|ze)_)?from_(\d+)\.csv$/i);
  if (!match) return null;
  const block = Number.parseInt(match[1], 10);
  if (!Number.isFinite(block) || block < 1 || block > 96) return null;
  return block;
}

function getGeneratedClockTimeFromScheduleFileName(fileName) {
  const endingBlock = extractEndingBlockFromScheduleFile(fileName);
  if (!endingBlock) return null;
  // Schedules are generated at (block start time + 8 minutes).
  return blockToTime(endingBlock, 8);
}

function blockToTime(block, addMinutes = 0) {
  if (!Number.isFinite(block)) return '-';
  const clamped = Math.min(Math.max(block, 1), 96);
  const idx = clamped - 1;
  const totalMinutes = (idx * 15) + addMinutes;
  const normalizedMinutes = ((totalMinutes % (24 * 60)) + (24 * 60)) % (24 * 60);
  const hh = Math.floor(normalizedMinutes / 60);
  const mm = normalizedMinutes % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function getDateList(endDate, days) {
  const dates = [];
  const end = new Date(endDate);
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(end);
    d.setDate(end.getDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}

function getOutputsDateSearchPrefixes(date, dynamicPrefixes = {}, plant) {
  const { generated = [] } = dynamicPrefixes;
  const prefixes = [];
  const plantCode = String(plant?.code || derivePlantCodeFromName(plant?.name) || '').trim().toUpperCase();
  if (plantCode) {
    const baseGenerated = getGeneratedPlantCodeAliases(plantCode)
      .map((code) => GENERATED_OUTPUTS_BASE_PREFIXES_BY_SITE[code])
      .filter(Boolean);
    const baseLegacy = LEGACY_GENERATED_OUTPUTS_BASE_PREFIXES_BY_SITE[plantCode];
    baseGenerated.forEach((prefix) => prefixes.push(`${prefix}${date}/`));
    if (baseLegacy) prefixes.push(`${baseLegacy}${date}/`);
    const derived = derivePlantFoldersFromName(plant?.name);
    if (derived) {
      prefixes.push(`generated/vedanjay/${derived.upper}/outputs/${date}/`);
      if (derived.upper === 'ANJANGAON') prefixes.push(`generated/vedanjay/ANJANGOAN/outputs/${date}/`);
      prefixes.push(`generated/${derived.folder}/${derived.lower}/outputs/${date}/`);
    }
  } else {
    prefixes.push(...GENERATED_OUTPUTS_BASE_PREFIXES.map((prefix) => `${prefix}${date}/`));
    prefixes.push(...LEGACY_GENERATED_OUTPUTS_BASE_PREFIXES.map((prefix) => `${prefix}${date}/`));
    prefixes.push(...generated.map((prefix) => `${prefix}${date}/`));
    prefixes.push(`${LEGACY_OUTPUTS_BASE_PREFIX}${date}/`);
  }
  return Array.from(new Set(prefixes)).filter(Boolean);
}

function getPlantByKey(key, plants = []) {
  const normalized = String(key || '').toLowerCase();
  const vedanjayMatch = normalized.match(/\/vedanjay\/([^/]+)\//);
  if (vedanjayMatch?.[1]) {
    const rawCode = vedanjayMatch[1].toUpperCase();
    const code = rawCode === 'ANJANGOAN' ? 'ANJANGAON' : rawCode;
    return plants.find((p) => String(p.code || '').toUpperCase() === code) || plants[0];
  }
  if (normalized.includes('/sirmour/sirmour/')) {
    return (
      plants.find((p) => String(p.code || '').toUpperCase() === 'SIRMOUR') ||
      plants.find((p) => String(p.name || '').toLowerCase().includes('sirmour')) ||
      plants[0]
    );
  }
  if (normalized.includes('/gsnp/gsnp/')) {
    return (
      plants.find((p) => String(p.code || '').toUpperCase() === 'GSNP') ||
      plants.find((p) => String(p.name || '').toLowerCase().includes('gsnp')) ||
      plants.find((p) => String(p.name || '').toLowerCase().includes('globus steel')) ||
      plants[0]
    );
  }
  for (const plant of plants) {
    const derived = derivePlantFoldersFromName(plant?.name);
    if (!derived) continue;
    if (normalized.includes(`/${derived.folder.toLowerCase()}/${derived.lower}/`)) {
      return plant;
    }
  }
  return plants[0] || null;
}

function isOutputsAlgoScheduleKey(key) {
  const normalized = String(key || '').toLowerCase();
  if (!normalized.includes('/outputs/')) return false;
  if (normalized.includes('/day-ahead/') || normalized.includes('/day_ahead/') || normalized.includes('/dayahead/')) {
    return false;
  }
  if (normalized.includes('/enercast_data/day_ahead/')) return false;
  const fileName = normalized.split('/').pop() || '';
  return isNonFrozenScheduleCsvKey(fileName);
}

function getScheduleKindFromKey(key) {
  const normalized = String(key || '').toLowerCase();
  if (normalized.includes('/intraday/')) return 'Intraday';
  if (normalized.includes('/day-ahead/') || normalized.includes('/day_ahead/') || normalized.includes('/dayahead/')) {
    return 'Day-Ahead';
  }
  return 'Day-Ahead';
}

function getPlantForFilter(plantFilter, plants = []) {
  const filterKey = normalizePlantKey(plantFilter);
  if (!filterKey || plantFilter === 'Select Plant' || plantFilter === 'All' || plantFilter === 'All Plants') {
    return null;
  }
  return plants.find((plant) => {
    const nameKey = normalizePlantKey(plant?.name);
    const codeKey = normalizePlantKey(plant?.code);
    return nameKey === filterKey || codeKey === filterKey || (nameKey && nameKey.includes(filterKey));
  }) || null;
}

function formatPreviewIntervalLabel(rawValue) {
  const value = String(rawValue ?? '').trim();
  if (!value) return value;
  const dashNormalized = value.replace(/\s*[-–—]\s*/g, '-');
  if (/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(dashNormalized)) {
    return dashNormalized;
  }

  const timeMatch = dashNormalized.match(/(\d{2}):(\d{2})(?::\d{2})?/);
  if (!timeMatch) return value;
  const hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return value;
  const startTotal = (hours * 60 + minutes) % (24 * 60);
  const endTotal = (startTotal + 15) % (24 * 60);
  const formatTime = (totalMinutes) => {
    const hh = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
    const mm = String(totalMinutes % 60).padStart(2, '0');
    return `${hh}:${mm}`;
  };
  return `${formatTime(startTotal)}-${formatTime(endTotal)}`;
}

function formatPreviewCellValue(cell, header, row, headers) {
  const headerKey = String(header || '').trim().toLowerCase();
  if (headerKey === 'timestamp' || headerKey === 'time period' || headerKey === 'time_period') {
    return formatPreviewIntervalLabel(cell);
  }
  return cell;
}

export function Dashboard({ onNavigate, isActive = true }) {
  const { user: currentUser } = useAuth();
  const isAdmin = isAdminUser(currentUser);
  // Filter states
  const [categoryFilter, setCategoryFilter] = useState('All');
  const [plantFilter, setPlantFilter] = useState('Select Plant');
  const [timePeriodFilter, setTimePeriodFilter] = useState('Today');
  const [selectedDate, setSelectedDate] = useState(() => getTodayIstIso());

  // Modal states
  const [showViewModal, setShowViewModal] = useState(false);
  const [showMoreModal, setShowMoreModal] = useState(false);
  const [selectedSchedule, setSelectedSchedule] = useState(null);
  const [viewCsvHeaders, setViewCsvHeaders] = useState([]);
  const [viewCsvRows, setViewCsvRows] = useState([]);
  const [viewCsvLoading, setViewCsvLoading] = useState(false);
  const [viewCsvError, setViewCsvError] = useState('');
  const [isPreviewExpanded, setIsPreviewExpanded] = useState(true);
  const { data: apiPlantsData } = useApi(
    () => api.plants.getAll({ noMock: true }),
    { immediate: true, initialData: { plants: [], total: 0, stats: {} } }
  );
  const availablePlants = useMemo(() => {
    const apiPlants = apiPlantsData?.plants || [];
    return apiPlants.map((plant) => {
      const code = String(plant.code || derivePlantCodeFromName(plant.name) || '').toUpperCase();
      return {
        ...plant,
        code,
        name: plant.name || code,
        type: plant.type || 'Solar',
      };
    });
  }, [apiPlantsData]);
  const dynamicPrefixes = useMemo(() => buildDynamicPrefixes(availablePlants), [availablePlants]);
  const plantOptions = useMemo(
    () => [
      { name: 'Select Plant', type: 'All' },
      ...availablePlants.map((plant) => ({ name: plant.name, type: plant.type || 'All' })),
    ],
    [availablePlants]
  );

  // Live clock
  const [currentTime, setCurrentTime] = useState(new Date());
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [downloadFormat, setDownloadFormat] = useState('csv');
  const [pendingScheduleDownload, setPendingScheduleDownload] = useState(null);

  useEffect(() => {
    if (!isActive) return undefined;
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, [isActive]);

  // API hooks
  const [currentGenerationMw, setCurrentGenerationMw] = useState(0);
  const [currentGenerationBySite, setCurrentGenerationBySite] = useState({});
  const [currentGenerationBlock, setCurrentGenerationBlock] = useState(getCompletedIstBlock());
  const [meterLoading, setMeterLoading] = useState(false);

  useEffect(() => {
    if (!isActive) return undefined;
    const timer = setInterval(() => {
      setCurrentGenerationBlock(getCompletedIstBlock());
    }, 60 * 1000);
    return () => clearInterval(timer);
  }, [isActive]);

  const {
    data: schedulesData,
    loading: schedulesLoading,
    error: schedulesError,
    execute: fetchSchedules
  } = useApi(() => api.schedules.getAll({ limit: 10 }), {
    immediate: true,
    initialData: { schedules: [], total: 0 }
  });

  const [s3Schedules, setS3Schedules] = useState([]);
  const [s3SchedulesLoading, setS3SchedulesLoading] = useState(false);

  const allSchedules = s3Schedules;
  
  // State to track if user wants to see all schedules
  const [showAllSchedules, setShowAllSchedules] = useState(false);

  const isFilterActive =
    categoryFilter !== 'All' ||
    plantFilter !== 'Select Plant' ||
    timePeriodFilter !== 'Today';
  
  // Auto-expand when filters are active to avoid hiding matches
  const schedules = (showAllSchedules || isFilterActive)
    ? allSchedules
    : allSchedules.slice(0, 10);
  
  // Load schedule CSVs from S3 based on date filter
  useEffect(() => {
    const loadSchedules = async () => {
      setS3SchedulesLoading(true);
      try {
        const dates = [selectedDate];

        const dateResults = await Promise.all(
          dates.map(async (date) => {
            const plantForFilter = getPlantForFilter(plantFilter, availablePlants);
            const datePrefixes = getOutputsDateSearchPrefixes(date, dynamicPrefixes, plantForFilter);
            const objectsFlat = await listS3ObjectsAcrossPrefixes(datePrefixes, currentUser);
            const objects = Array.from(new Map(objectsFlat.map((o) => [o.key, o])).values());
            const scheduleCandidates = objects.filter((o) => isOutputsAlgoScheduleKey(o.key));
            const scheduleFiles = scheduleCandidates;
            return Promise.all(scheduleFiles.map(async (file) => {
              const fileName = file.key.split('/').pop();
              const endingBlock = extractEndingBlockFromScheduleFile(fileName);
              const codeFromKey = extractPlantCodeFromKey(file.key);
              const plant = getPlantByKey(file.key, availablePlants);
              const plantCode = String(
                codeFromKey ||
                plant?.code ||
                derivePlantCodeFromName(plant?.name) ||
                ''
              ).toUpperCase();
              const rawType = String(plant?.type || 'Solar');
              const normalizedType = /wind/i.test(rawType) ? 'Wind' : 'Solar';
              const manualChanges = await getManualChangeCount(plantCode, date, file.key);
              const generatedClockTime = getGeneratedClockTimeFromScheduleFileName(fileName);

              return {
                endingBlock: endingBlock ?? 0,
                // Display system-generated schedule time derived from the revision block.
                // Example: schedule_from_57.csv => block 57 starts at 14:00, +8 min => 14:08.
                activityTime: generatedClockTime || '-',
                plant: plant?.name || getDisplayPlantName(plantCode) || availablePlants[0]?.name || 'Unknown Plant',
                plantCode,
                category: normalizedType,
                icon: normalizedType === 'Wind' ? 'Wind' : 'Sun',
                id: file.key,
                lastModified: file.lastModified,
                time: generatedClockTime || '-',
                status: 'Pending',
                changes: manualChanges,
                fileName,
                fileUrl: `${S3_BASE_URL}/${String(file.key || '').split('/').map((s) => encodeURIComponent(s)).join('/')}`,
              };
            }));
          })
        );

        const flattened = dateResults.flat();
        setS3Schedules(flattened);
      } catch (error) {
        console.error('Failed to load schedules from S3:', error);
        setS3Schedules([]);
        toast.error('Failed to load schedule CSVs from S3');
      } finally {
        setS3SchedulesLoading(false);
      }
    };

    loadSchedules();
  }, [selectedDate, timePeriodFilter, dynamicPrefixes, availablePlants, plantFilter]);

  // Load latest meter data for current generation (MW)
  useEffect(() => {
    const loadMeter = async () => {
      setMeterLoading(true);
      try {
        const currentBlock = getCompletedIstBlock();
        setCurrentGenerationBlock(currentBlock);

        const perSiteGeneration = await Promise.all(
          availablePlants.map(async (plant) => {
            if (!isMeterAvailable(plant)) {
              const key = String(plant.code || derivePlantCodeFromName(plant?.name) || plant.name || '').toUpperCase() || 'UNKNOWN';
              return { code: key, name: plant.name, mw: null };
            }
            const meterObjectsFlat = await listS3ObjectsAcrossPrefixes(
              getMeterPrefixesForSite(selectedDate, plant, dynamicPrefixes),
              currentUser
            );
            const meterCandidates = meterObjectsFlat
              .filter((o) => o.key.toLowerCase().endsWith('.csv'))
              .sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
            if (!meterCandidates.length) {
              const key = String(plant.code || derivePlantCodeFromName(plant?.name) || plant.name || '').toUpperCase() || 'UNKNOWN';
              return { code: key, name: plant.name, mw: null };
            }

            let bestMw = null;
            for (const candidate of meterCandidates) {
              try {
                const { text } = await fetchCsvFromS3(candidate.key);
                const meterMap = parseMeterSeriesMap(text);
                if (!meterMap.size) continue;

                // Prefer exact current block, else latest available up to current block.
                if (meterMap.has(currentBlock)) {
                  const v = meterMap.get(currentBlock);
                  const normalized = Number.isFinite(v) ? v : 0;
                  bestMw = normalized < 0 ? 0 : normalized;
                  break;
                }

                const fallbackBlock = Array.from(meterMap.keys())
                  .filter((b) => Number.isFinite(b) && b <= currentBlock)
                  .sort((a, b) => b - a)[0];
                if (Number.isFinite(fallbackBlock)) {
                  const v = meterMap.get(fallbackBlock);
                  const normalized = Number.isFinite(v) ? v : 0;
                  bestMw = normalized < 0 ? 0 : normalized;
                  break;
                }
              } catch {
                // Try next candidate for this site
              }
            }
            const key = String(plant.code || derivePlantCodeFromName(plant?.name) || plant.name || '').toUpperCase() || 'UNKNOWN';
            return { code: key, name: plant.name, mw: bestMw };
          })
        );

        const bySite = perSiteGeneration.reduce((acc, site) => {
          acc[site.code] = Number.isFinite(site.mw) ? site.mw : null;
          return acc;
        }, {});
        const totalMw = perSiteGeneration.reduce((sum, site) => {
          if (!Number.isFinite(site.mw)) return sum;
          return sum + Math.max(0, site.mw);
        }, 0);
        setCurrentGenerationBySite(bySite);
        setCurrentGenerationMw(totalMw);
      } catch (error) {
        console.error('Failed to load meter CSV:', error);
        setCurrentGenerationBySite({});
        setCurrentGenerationMw(0);
      } finally {
        setMeterLoading(false);
      }
    };

    loadMeter();
  }, [selectedDate, availablePlants, dynamicPrefixes]);

  const statsData = useMemo(() => {
    const plantsForStats = availablePlants;
    const activePlants = plantsForStats.length;
    const totalCapacity = plantsForStats.reduce((sum, plant) => sum + (plant.capacity || 0), 0);
    const efficiency = totalCapacity > 0 ? (currentGenerationMw / totalCapacity) * 100 : 0;
    const capacityBySite = plantsForStats.reduce((acc, plant) => {
      const key = String(plant.code || derivePlantCodeFromName(plant?.name) || plant.name || '').toUpperCase() || 'UNKNOWN';
      acc[key] = Number.isInteger(plant.capacity) ? String(plant.capacity) : String(plant.capacity);
      return acc;
    }, {});
    const totalCapacityDisplay = Number.isInteger(totalCapacity)
      ? String(totalCapacity)
      : totalCapacity.toFixed(1);
    const efficiencyBySite = plantsForStats.reduce((acc, plant) => {
      const key = String(plant.code || derivePlantCodeFromName(plant?.name) || plant.name || '').toUpperCase() || 'UNKNOWN';
      const siteCapacity = Number(plant.capacity || 0);
      const siteGeneration = Number(currentGenerationBySite[key] ?? 0);
      const siteEfficiency = siteCapacity > 0 ? (siteGeneration / siteCapacity) * 100 : 0;
      acc[key] = siteEfficiency.toFixed(1);
      return acc;
    }, {});
    return {
      activePlants,
      totalCapacity: totalCapacityDisplay,
      totalCapacityBySite: capacityBySite,
      currentGeneration: currentGenerationMw.toFixed(2),
      currentGenerationBySite: currentGenerationBySite,
      currentGenerationBlock,
      efficiency: efficiency.toFixed(1),
      efficiencyBySite: efficiencyBySite,
    };
  }, [currentGenerationMw, currentGenerationBySite, currentGenerationBlock, availablePlants]);

  const codeToName = useMemo(() => {
    const plantsForStats = availablePlants;
    return plantsForStats.reduce((acc, plant) => {
      const code = String(plant.code || derivePlantCodeFromName(plant?.name) || plant.name || '').toUpperCase();
      if (code) {
        acc[code] = plant.name || code;
      }
      return acc;
    }, {});
  }, [availablePlants]);

  const getDisplayLabel = (code) => {
    const normalized = String(code || '').toUpperCase();
    const name = codeToName[normalized];
    if (name && name.trim()) {
      return displayPlantName(name.trim());
    }
    if (!normalized) return 'UNKNOWN';
    const fallback = normalized.length <= 2 ? `Site ${normalized}` : normalized;
    return displayPlantName(fallback);
  };

  const formatMw = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(1);
  };

  const contractedCapacityBySite = {
    CME: 4,
  };

  const capacityDetails = useMemo(() => {
    const entries = Object.entries(statsData.totalCapacityBySite || {});
    if (!entries.length) return ['No capacity data'];
    const filtered = entries.filter(([key]) => key && key.toUpperCase() !== 'UNDEFINED');
    const finalEntries = filtered.length ? filtered : entries;
    return finalEntries.map(([key, value]) => {
      const label = getDisplayLabel(key);
      const installedDisplay = formatMw(value);
      if (!installedDisplay) return `${label}: N/A`;
      const contracted = contractedCapacityBySite[String(key).toUpperCase()];
      const contractedDisplay = formatMw(contracted);
      if (contractedDisplay) {
        return `${label}: ${contractedDisplay} / ${installedDisplay} MW`;
      }
      return `${label}: ${installedDisplay} MW`;
    });
  }, [statsData.totalCapacityBySite, codeToName]);

  const generationDetails = useMemo(() => {
    const entries = Object.entries(statsData.currentGenerationBySite || {});
    if (!entries.length) return ['No generation data'];
    const filtered = entries.filter(([key]) => key && key.toUpperCase() !== 'UNDEFINED');
    const finalEntries = filtered.length ? filtered : entries;
    return finalEntries.map(([key, value]) => {
      if (value === null || value === undefined) {
        return `${getDisplayLabel(key)}: N/A`;
      }
      return `${getDisplayLabel(key)}: ${Number(value ?? 0).toFixed(2)} MW`;
    });
  }, [statsData.currentGenerationBySite, codeToName]);

  const efficiencyDetails = useMemo(() => {
    const entries = Object.entries(statsData.efficiencyBySite || {});
    if (!entries.length) return ['No efficiency data'];
    const filtered = entries.filter(([key]) => key && key.toUpperCase() !== 'UNDEFINED');
    const finalEntries = filtered.length ? filtered : entries;
    return finalEntries.map(([key, value]) => `${getDisplayLabel(key)}: ${Number(value ?? 0).toFixed(1)}%`);
  }, [statsData.efficiencyBySite, codeToName]);

  const getPlantCapacityForSchedule = (schedule) => {
    if (!schedule) return 'N/A';
    const key = String(schedule.plantCode || derivePlantCodeFromName(schedule.plant) || schedule.plant || '').toUpperCase();
    const capacity = statsData.totalCapacityBySite?.[key];
    const capacityDisplay = formatMw(capacity);
    if (!capacityDisplay) return 'N/A';
    return `${capacityDisplay} MW`;
  };

  // Cache manual change counts per (plant, date) to avoid repeated fetches
  const manualChangeCountCache = useRef(new Map());
  const manualChangeLogCache = useRef(new Map()); // plant|date -> items[]
  const getManualChangeCount = async (plantCode, scheduleDate, sourceFileKey) => {
    const normalizedPlant = String(plantCode || '').toUpperCase();
    const safeKey = String(sourceFileKey || '').trim();
    const key = `${normalizedPlant}|${scheduleDate}|${safeKey}`;
    if (manualChangeCountCache.current.has(key)) {
      const cached = manualChangeCountCache.current.get(key);
      // Never let a cached zero permanently mask newly imported/manual logs.
      if (Number.isFinite(cached) && cached > 0) return cached;
    }

    const localKey = `vedanjay-manual-count|${normalizedPlant}|${scheduleDate}|${safeKey}`;
    const localVal = Number(localStorage.getItem(localKey));
    // Ignore (and clear) stored zeros; they commonly come from older sessions when logs
    // were missing and would otherwise keep the dashboard stuck at 0.
    if (Number.isFinite(localVal) && localVal > 0) {
      manualChangeCountCache.current.set(key, localVal);
      return localVal;
    }
    if (Number.isFinite(localVal) && localVal === 0) {
      try {
        localStorage.removeItem(localKey);
      } catch {
        // ignore storage errors
      }
    }

    let count = 0;
    const plantDateKey = `${normalizedPlant}|${scheduleDate}`;
    let items = manualChangeLogCache.current.get(plantDateKey) || null;

    const fetchChangeLogFromS3 = async () => {
      const changeKey = `generated/vedanjay/${normalizedPlant}/outputs/${scheduleDate}/schedule_changes.json`;
      const parsePayload = (payload) => {
        if (Array.isArray(payload)) return payload;
        if (Array.isArray(payload?.items)) return payload.items;
        return [];
      };

      try {
        const text = await fetchTextFromS3Optional(changeKey).catch(() => null);
        if (!text) return [];
        const payload = JSON.parse(text);
        return parsePayload(payload);
      } catch {
        return [];
      }
    };

    if (!items || (Array.isArray(items) && items.length === 0)) {
      try {
        const resp = await api.schedules.getChangeLog({ plantCode: normalizedPlant, scheduleDate });
        items = Array.isArray(resp?.items) ? resp.items : [];
      } catch {
        // Backend may be unavailable / AWS creds missing; fall back to direct S3 read.
        items = await fetchChangeLogFromS3();
      }
      // Only cache non-empty results; empty caches can keep the UI stuck at 0 until reload.
      if (Array.isArray(items) && items.length > 0) {
        manualChangeLogCache.current.set(plantDateKey, items);
      }
    }

    if (safeKey) {
      const normalizedSafeKey = safeKey.toLowerCase();
      const safeBaseName = normalizedSafeKey.split('/').pop() || normalizedSafeKey;

      const matchesSourceKey = (row) => {
        const source = String(row?.source_file_key || row?.sourceFileKey || '').trim();
        if (!source) return false;
        const normalizedSource = source.toLowerCase();
        if (normalizedSource === normalizedSafeKey) return true;
        // Be tolerant of older logs that store only the filename.
        const sourceBaseName = normalizedSource.split('/').pop() || normalizedSource;
        return sourceBaseName === safeBaseName;
      };

      // Count change-log entries for this schedule file.
      // (If the same block was updated multiple times, each save counts as a manual change event.)
      count = (items || []).filter(matchesSourceKey).length;
    } else {
      count = Array.isArray(items) ? items.length : 0;
    }

    manualChangeCountCache.current.set(key, count);
    // Persist only positive counts; avoid re-introducing sticky zeros.
    try {
      if (count > 0) {
        localStorage.setItem(localKey, String(count));
      } else {
        localStorage.removeItem(localKey);
      }
    } catch {
      // ignore storage errors
    }
    return count;
  };


  // Filter schedules based on all active filters
  const filteredSchedules = useMemo(() => (
    schedules
      .filter(schedule => {
        const scheduleCategory = String(schedule.category || '').toLowerCase();
        const matchesCategory =
          categoryFilter === 'All' ||
          (categoryFilter === 'Wind Plants' && scheduleCategory === 'wind') ||
          (categoryFilter === 'Solar Plants' && scheduleCategory === 'solar');
        const filterKey = normalizePlantKey(plantFilter);
        const scheduleKey = normalizePlantKey(schedule.plant);
        const scheduleCodeKey = normalizePlantKey(schedule.plantCode);
        const scheduleDisplayCodeKey = normalizePlantKey(getDisplayPlantName(schedule.plantCode));
        const scheduleIdKey = normalizePlantKey(extractPlantCodeFromKey(schedule.id));
        const matchesPlant =
          !filterKey ||
          plantFilter === 'Select Plant' ||
          plantFilter === 'All' ||
          plantFilter === 'All Plants' ||
          scheduleKey === filterKey ||
          scheduleCodeKey === filterKey ||
          scheduleDisplayCodeKey === filterKey ||
          scheduleIdKey === filterKey ||
          (filterKey && scheduleKey.includes(filterKey));

        const matchesTimePeriod = timePeriodFilter === 'Today';

        return matchesCategory && matchesPlant && matchesTimePeriod;
      })
      .sort((a, b) => {
        const blockDiff = (b.endingBlock ?? 0) - (a.endingBlock ?? 0);
        if (blockDiff !== 0) return blockDiff;
        const bt = Date.parse(b.lastModified || '');
        const at = Date.parse(a.lastModified || '');
        if (!Number.isNaN(bt) && !Number.isNaN(at) && bt !== at) return bt - at;
        return String(b.fileName || '').localeCompare(String(a.fileName || ''));
      })
  ), [schedules, categoryFilter, plantFilter, timePeriodFilter]);

  const intradayRunByScheduleKey = useMemo(() => {
    const byPlant = new Map();
    for (const item of allSchedules || []) {
      const key = String(item?.id || '').trim();
      if (!key) continue;

      const rawPlant = String(
        item?.plantCode ||
        extractPlantCodeFromKey(key) ||
        derivePlantCodeFromName(item?.plant) ||
        item?.plant ||
        ''
      ).trim();
      const plantSlug = slugifyPlant(rawPlant);
      if (!plantSlug) continue;

      if (!byPlant.has(plantSlug)) byPlant.set(plantSlug, []);
      byPlant.get(plantSlug).push({ key, fileName: item?.fileName });
    }

    const runByKey = new Map();
    for (const [, group] of byPlant.entries()) {
      const groupMap = computeIntradayRunIndexByKey(group);
      for (const [key, run] of groupMap.entries()) runByKey.set(key, run);
    }
    return runByKey;
  }, [allSchedules]);

  // Hardcoded plant options for filter dropdown (independent of loaded data/date)
  const plantNames = useMemo(() => {
    if (categoryFilter === 'Wind Plants') {
      return plantOptions.filter((p) => {
        const type = String(p.type || '').toLowerCase();
        return type === 'wind' || type === 'all';
      });
    }
    if (categoryFilter === 'Solar Plants') {
      return plantOptions.filter((p) => {
        const type = String(p.type || '').toLowerCase();
        return type === 'solar' || type === 'all';
      });
    }
    if (categoryFilter === 'All') {
      return plantOptions;
    }
    return plantOptions;
  }, [categoryFilter, plantOptions]);

  useEffect(() => {
    const exists = plantOptions.some((p) => p.name === plantFilter);
    if (!exists) {
      setPlantFilter('Select Plant');
    }
  }, [plantOptions, plantFilter]);

  // Handler to refresh all data
  const handleRefresh = async () => {
    setCategoryFilter('All');
    setPlantFilter('Select Plant');
    setTimePeriodFilter('Today');
    setSelectedDate(getTodayIstIso());
    
    await fetchSchedules();
    toast.success('Dashboard data refreshed');
  };

  // Handlers for schedule actions
  const handleViewSchedule = async (schedule) => {
    setSelectedSchedule(schedule);
    setShowViewModal(true);
    setIsPreviewExpanded(true);
    setViewCsvHeaders([]);
    setViewCsvRows([]);
    setViewCsvError('');

    if (!schedule?.fileUrl) {
      setViewCsvError('CSV file URL not available.');
      return;
    }

    setViewCsvLoading(true);
    try {
      const url = new URL(schedule.fileUrl, window.location.origin);
      url.searchParams.set('_ts', String(Date.now()));
      const response = await fetch(url.toString(), { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Failed to fetch CSV (${response.status})`);
      }
      const csvText = await response.text();
      const parsed = parseCsv(csvText);
      const headers = parsed.headers || [];
      const visibleIndexes = headers
        .map((header, index) => ({ header, index }))
        .filter(({ header }) => !HIDDEN_PREVIEW_COLUMNS.has(normalizeColumnName(header)))
        .map(({ index }) => index);

      const filteredHeaders = visibleIndexes.map((index) => headers[index]);
      const filteredRows = (parsed.rows || []).map((row) => visibleIndexes.map((index) => row[index]));

      setViewCsvHeaders(filteredHeaders);
      setViewCsvRows(filteredRows);
    } catch (error) {
      console.error(error);
      setViewCsvError(error?.message || 'Failed to load CSV preview.');
      setViewCsvHeaders([]);
      setViewCsvRows([]);
    } finally {
      setViewCsvLoading(false);
    }
  };

  const handleDownloadSchedule = async (schedule, format = 'csv') => {
    if (!schedule?.fileUrl) {
      toast.error('CSV file URL not available.');
      return;
    }
    try {
      const url = new URL(schedule.fileUrl, window.location.origin);
      url.searchParams.set('_ts', String(Date.now()));
      const response = await fetch(url.toString(), { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Failed to download CSV (${response.status})`);
      }
      const csvText = await response.text();
      const fileName = schedule.fileName || 'schedule.csv';
      const filenameBase = fileName.replace(/\.(csv|xlsx|xls)$/i, '');
      if (format === 'xlsx') {
        await downloadXlsxFromCsvText(csvText, filenameBase, 'Schedule');
      } else {
        downloadCsvText(csvText, filenameBase);
      }
      setShowDownloadModal(false);
      setPendingScheduleDownload(null);
    } catch (error) {
      console.error(error);
      toast.error(error?.message || 'Failed to download CSV file');
    }
  };

  const currentBlockStart = blockToTime(statsData.currentGenerationBlock);
  const currentBlockEnd = blockToTime(statsData.currentGenerationBlock, 15);

  return (
    <>
      <div className="flex-1 overflow-auto bg-slate-950 min-h-0 relative overflow-x-hidden">
        {/* Animated background elements */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-0 left-1/4 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl animate-pulse" />
          <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />
        </div>

        <div className="w-full p-4 sm:p-6 lg:p-8 space-y-6 sm:space-y-8 max-w-[1600px] mx-auto relative z-10">
          {/* Premium Page Header */}
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 border border-slate-700/50 shadow-2xl">
            <div className="absolute inset-0 bg-gradient-to-r from-indigo-500/5 via-transparent to-purple-500/5" />
            <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-bl from-indigo-500/10 to-transparent rounded-full blur-2xl" />
            
            <div className="relative p-4 sm:p-6 lg:p-8">
              <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-6">
                <div className="flex items-start gap-4 sm:gap-5">
                  <div className="relative">
                    <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/25">
                      <LayoutDashboard className="w-6 h-6 sm:w-7 sm:h-7 text-white" />
                    </div>
                  </div>
                  <div>
                    <h1 className="text-2xl sm:text-3xl font-bold text-white mb-2 tracking-tight">
                      Dashboard Overview
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
                
                <div className="flex gap-4">
                  <button 
                    onClick={handleRefresh}
                    disabled={schedulesLoading}
                    className="group relative px-4 py-2.5 sm:px-6 sm:py-3 rounded-xl bg-slate-800/50 hover:bg-slate-700/50 border border-slate-700/50 hover:border-slate-600 transition-all duration-300 flex items-center gap-3 disabled:opacity-50"
                  >
                    <RefreshCw className={`w-4 h-4 sm:w-5 sm:h-5 text-indigo-400 ${schedulesLoading ? 'animate-spin' : 'group-hover:rotate-180 transition-transform duration-500'}`} />
                    <div className="text-left">
                      <p className="text-sm font-semibold text-white">Refresh</p>
                      <p className="text-xs text-slate-400">Update data</p>
                    </div>
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Premium Stats Cards */} 
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
            {[
              { label: 'Active Plants', value: statsData.activePlants, subtext: 'Currently operational', icon: Activity, gradient: 'from-emerald-600 to-teal-600', glow: 'bg-emerald-500/20' },
              {
                label: 'Total Capacity',
                value: `${statsData.totalCapacity} MW`,
                subtext: 'Installed capacity',
                details: capacityDetails,
                icon: Zap,
                gradient: 'from-blue-600 to-cyan-600',
                glow: 'bg-blue-500/20'
              },
              {
                label: 'Current Generation',
                value: `${statsData.currentGeneration} MW`,
                subtext: `Real-time output (Block ${statsData.currentGenerationBlock} • ${currentBlockStart} - ${currentBlockEnd})`,
                details: generationDetails,
                icon: TrendingUp,
                gradient: 'from-amber-600 to-orange-600',
                glow: 'bg-amber-500/20',
              },
              {
                label: 'Efficiency',
                value: `${statsData.efficiency}%`,
                subtext: 'Overall performance',
                details: efficiencyDetails,
                icon: Layers,
                gradient: 'from-purple-600 to-pink-600',
                glow: 'bg-purple-500/20'
              }
            ].map((stat, i) => (
              <div 
                key={i}
                className="group relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 to-slate-800 border border-slate-700/50 hover:border-slate-600 transition-all duration-500 hover:-translate-y-1 hover:shadow-2xl cursor-pointer"
              >
                <div className={`absolute inset-0 bg-gradient-to-r ${stat.glow} opacity-0 group-hover:opacity-100 transition-opacity duration-500`} />
                <div className={`absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl ${stat.glow} rounded-full blur-3xl opacity-50 group-hover:opacity-75 transition-opacity duration-500`} />
                
                <div className="relative p-5 sm:p-6">
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <p className="text-xs sm:text-sm font-medium text-slate-400 uppercase tracking-wider">{stat.label}</p>
                      <div className={`text-3xl sm:text-4xl xl:text-5xl font-bold mt-2 bg-gradient-to-r ${stat.gradient} bg-clip-text text-transparent`}>
                        {stat.value}
                      </div>
                    </div>
                    <div className={`p-3 rounded-xl bg-gradient-to-br ${stat.glow} group-hover:scale-110 transition-transform duration-300`}>
                      <stat.icon className="w-5 h-5 sm:w-6 sm:h-6 text-white" />
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-xs sm:text-sm text-slate-400 group-hover:text-slate-300 transition-colors">
                    <TrendingUp className="w-4 h-4 text-indigo-400" />
                    {stat.subtext}
                  </div>
                  {Array.isArray(stat.details) && stat.details.length > 0 && (
                    <div className="mt-2 space-y-1 text-xs text-slate-400">
                      {stat.details.map((detail) => (
                        <p key={detail}>{detail}</p>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Employee Today Overview (removed) */}
          {false && (
            <div className="rounded-2xl bg-slate-900/40 border border-slate-700/40 backdrop-blur-sm overflow-hidden">
              <div className="p-4 sm:p-6 border-b border-slate-700/40 bg-gradient-to-r from-slate-800/40 to-transparent">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="p-3 rounded-xl bg-emerald-500/10">
                      <TrendingUp className="w-5 h-5 sm:w-6 sm:h-6 text-emerald-400" />
                    </div>
                    <div>
                      <h3 className="text-lg sm:text-xl font-bold text-white">Today Overview</h3>
                      <p className="text-xs sm:text-sm text-slate-400 mt-1">Live plant snapshot</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => onNavigate?.('Schedule Readiness')}
                      className="px-4 py-2 rounded-xl bg-slate-800/50 border border-slate-700/50 text-slate-300 text-xs sm:text-sm font-semibold hover:bg-slate-700/50 hover:text-white transition-all"
                    >
                      Schedule Readiness
                    </button>
                    <button
                      type="button"
                      onClick={() => onNavigate?.('Deviation/DSM')}
                      className="px-4 py-2 rounded-xl bg-slate-800/50 border border-slate-700/50 text-slate-300 text-xs sm:text-sm font-semibold hover:bg-slate-700/50 hover:text-white transition-all"
                    >
                      Deviation/DSM
                    </button>
                  </div>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-slate-800/40">
                    <tr>
                      {['Plant', 'Capacity', 'Generation', 'Efficiency'].map((header) => (
                        <th
                          key={header}
                          className="px-4 sm:px-6 py-3 text-left text-xs font-semibold text-white uppercase tracking-wider whitespace-nowrap"
                        >
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {todayOverviewPlants.length ? (
                      todayOverviewPlants.map((plant) => (
                        <tr key={`today-${plant.code}`} className="hover:bg-slate-800/20 transition-colors">
                          <td className="px-4 sm:px-6 py-3 whitespace-nowrap">
                            <div className="text-sm font-semibold text-white">{plant.name}</div>
                            <div className="text-xs text-slate-500">{plant.code}</div>
                          </td>
                          <td className="px-4 sm:px-6 py-3 whitespace-nowrap text-sm text-slate-300 tabular-nums">
                            {Number.isFinite(plant.capacityMw) ? `${plant.capacityMw} MW` : '—'}
                          </td>
                          <td className="px-4 sm:px-6 py-3 whitespace-nowrap text-sm text-slate-300 tabular-nums">
                            {Number.isFinite(plant.generationMw) ? `${plant.generationMw.toFixed(2)} MW` : 'N/A'}
                          </td>
                          <td className="px-4 sm:px-6 py-3 whitespace-nowrap text-sm text-slate-300 tabular-nums">
                            {Number.isFinite(plant.efficiencyPct) ? `${plant.efficiencyPct.toFixed(1)}%` : 'N/A'}
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={4} className="px-6 py-10 text-center text-sm text-slate-400">
                          No plant data available for today.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {isAdmin && (
            <>
          {/* Premium Filters */}
          <div className="flex flex-col xl:flex-row xl:items-center gap-4 p-4 rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm">
            <div className="flex items-center gap-2 text-slate-400">
              <Filter className="w-5 h-5" />
              <span className="text-sm font-medium">Filters:</span>
            </div>
            
            <div className="flex flex-wrap gap-3 w-full xl:w-auto">

              {/* Category Filter */}
              <div className="relative">
                <select 
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  className="w-full sm:w-auto px-4 py-2.5 rounded-xl bg-slate-800/50 border border-slate-700/50 text-slate-300 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all cursor-pointer appearance-none pr-10 hover:bg-slate-800 hover:border-slate-600"
                >
                  <option value="All">Category: All</option>
                  <option value="Wind Plants">Wind Plants</option>
                  <option value="Solar Plants">Solar Plants</option>
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
              </div>

              {/* Date Filter */}
              <div className="relative">
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  className="w-full sm:w-auto px-4 py-2.5 rounded-xl bg-slate-800/50 border border-slate-700/50 text-slate-300 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all cursor-pointer hover:bg-slate-800 hover:border-slate-600"
                />
              </div>

              {/* Plant Filter */}
              <div className="relative">
                <select 
                  value={plantFilter}
                  onChange={(e) => setPlantFilter(e.target.value)}
                  className="w-full sm:w-auto px-4 py-2.5 rounded-xl bg-slate-800/50 border border-slate-700/50 text-slate-300 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all cursor-pointer appearance-none pr-10 hover:bg-slate-800 hover:border-slate-600 max-w-full sm:max-w-[220px]"
                >
                  {plantNames.map((p) => (
                    <option key={p.name} value={p.name}>{displayPlantName(p.name)}</option>
                  ))}
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
              </div>

              {/* Clear Filters Button */}
              {(categoryFilter !== 'All' || plantFilter !== 'Select Plant' || timePeriodFilter !== 'Today') && (
                <button
                  onClick={() => {
                    setCategoryFilter('All');
                    setPlantFilter('Select Plant');
                    setTimePeriodFilter('Today');
                    setSelectedDate(getTodayIstIso());
                  }}
                  className="px-4 py-2.5 rounded-xl bg-slate-800/50 border border-slate-700/50 text-slate-400 text-sm font-medium hover:text-white hover:bg-slate-700/50 transition-all"
                >
                  Clear Filters
                </button>
              )}
            </div>

            <div className="xl:ml-auto flex gap-3 w-full xl:w-auto" />
          </div>

          {/* Premium Activity Table */}
          <div className="rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm overflow-hidden">
            <div className="p-4 sm:p-6 border-b border-slate-700/50 bg-gradient-to-r from-slate-800/50 to-transparent">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div className="flex items-center gap-3 sm:gap-4">
                  <div className="p-3 rounded-xl bg-indigo-500/10">
                    <FileText className="w-5 h-5 sm:w-6 sm:h-6 text-indigo-400" />
                  </div>
                  <div>
                    <h3 className="text-lg sm:text-xl font-bold text-white">Recent Schedule Activity</h3>
                    <p className="text-xs sm:text-sm text-slate-400 mt-1">Latest updates and actions</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button 
                    onClick={() => setTimePeriodFilter('Today')}
                    className={`relative px-3 py-2 sm:px-4 text-xs sm:text-sm font-semibold rounded-xl transition-all duration-300 ${
                      timePeriodFilter === 'Today' 
                        ? 'text-white' 
                        : 'text-slate-400 hover:text-white hover:bg-slate-800'
                    }`}
                  >
                    {timePeriodFilter === 'Today' && (
                      <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 shadow-lg shadow-indigo-500/25" />
                    )}
                    <span className="relative z-10">Today</span>
                  </button>
                </div>
              </div>
            </div>
            
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-800/50 backdrop-blur-sm">
                  <tr>
                    {['Plant', 'Category', 'CSV File', 'Time', 'Manual Changes', 'Action'].map(header => (
                      <th key={header} className="px-4 sm:px-6 py-3 sm:py-4 text-left text-xs font-semibold text-white dark:text-white uppercase tracking-wider">
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {filteredSchedules.length > 0 ? (
                    filteredSchedules.map((item) => {
                      const iconMap = { Wind, Sun };
                      const Icon = iconMap[item.icon] || (item.category === 'Wind' ? Wind : Sun);
                      const isSolar = item.category === 'Solar';
                      const displayCsvFile = item.fileName
                        ? formatMachineScheduleDisplayName({
                            baseName: item.fileName,
                            key: item.id,
                            plantCodeOrName: item.plantCode || item.plant,
                            scheduleDate: selectedDate,
                            isDayAhead: false,
                            intradayRunIndex: intradayRunByScheduleKey.get(String(item.id || '').trim()),
                          })
                        : '-';
                      return (
                        <tr key={`schedule-${item.id || item.fileName}-${item.plant}`} className="group hover:bg-slate-800/30 transition-all duration-300">
                          <td className="px-4 sm:px-6 py-4 sm:py-5 whitespace-nowrap">
                            <div className="flex items-center gap-3">
                              <div className={`p-2 rounded-lg ${
                                isSolar 
                                  ? 'bg-gradient-to-br from-amber-500/20 to-orange-500/20' 
                                  : 'bg-gradient-to-br from-blue-500/20 to-cyan-500/20'
                              }`}>
                                <Icon className={`w-4 h-4 ${isSolar ? 'text-amber-400' : 'text-blue-400'}`} />
                              </div>
                              <span className="text-sm font-medium text-white group-hover:text-indigo-400 transition-colors">{displayPlantName(item.plant)}</span>
                            </div>
                          </td>
                          <td className="px-4 sm:px-6 py-4 sm:py-5 whitespace-nowrap">
                            <span className={`inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-semibold border ${
                              isSolar
                                ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                                : 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                            }`}>
                              {item.category}
                            </span>
                          </td>
                          <td className="px-4 sm:px-6 py-4 sm:py-5 whitespace-nowrap text-xs sm:text-sm text-slate-300">
                            {displayCsvFile}
                          </td>
                          <td className="px-4 sm:px-6 py-4 sm:py-5 whitespace-nowrap text-xs sm:text-sm text-slate-300">
                            {item.activityTime || '-'}
                          </td>
                          <td className="px-4 sm:px-6 py-4 sm:py-5 whitespace-nowrap text-xs sm:text-sm text-slate-400">{item.changes}</td>
                          <td className="px-4 sm:px-6 py-4 sm:py-5 whitespace-nowrap">
                            <div className="flex flex-col sm:flex-row gap-2">
                              <button 
                                onClick={() => handleViewSchedule(item)}
                                className="w-full sm:w-auto px-3 sm:px-4 py-2 rounded-lg bg-white text-black text-xs sm:text-sm font-semibold hover:bg-slate-100 transition-all duration-300 flex items-center justify-center gap-2 border border-slate-200"
                              >
                                <Eye className="w-4 h-4" />
                                View
                              </button>
                              <button
                                onClick={() => {
                                  setPendingScheduleDownload(item);
                                  setDownloadFormat('csv');
                                  setShowDownloadModal(true);
                                }}
                                className="w-full sm:w-auto px-3 sm:px-4 py-2 rounded-lg bg-blue-900 text-black text-xs sm:text-sm font-semibold hover:bg-blue-800 transition-all duration-300 flex items-center justify-center gap-2 border border-blue-700"
                              >
                                <Download className="w-4 h-4" />
                                Download
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan="6" className="px-6 py-16 sm:py-20 text-center">
                        <div className="flex flex-col items-center gap-4">
                          <div className="p-4 rounded-full bg-slate-800/50">
                            <Filter className="w-10 h-10 text-slate-600" />
                          </div>
                          <div>
                            <p className="text-base sm:text-lg font-semibold text-slate-400">
                              No schedules match your filters
                            </p>
                            <p className="text-xs sm:text-sm text-slate-500 mt-1">
                              Try adjusting your filter criteria
                            </p>
                          </div>
                          <button
                            onClick={() => {
                              setCategoryFilter('All');
                              setPlantFilter('Select Plant');
                              setTimePeriodFilter('Today');
                              setSelectedDate(getTodayIstIso());
                            }}
                            className="px-4 py-2 rounded-lg bg-indigo-600/10 text-indigo-400 text-sm font-semibold hover:bg-indigo-600/20 transition-all duration-300"
                          >
                            Clear all filters
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="p-4 border-t border-slate-700/50 bg-slate-800/30 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <p className="text-xs sm:text-sm text-slate-400">
                Showing {filteredSchedules.length} of {showAllSchedules ? allSchedules.length : 10} schedules
              </p>
              <button 
                onClick={() => setShowAllSchedules(!showAllSchedules)}
                className="w-full sm:w-auto px-4 py-2 rounded-lg bg-slate-800/50 text-slate-300 text-xs sm:text-sm font-semibold hover:bg-slate-700 hover:text-white transition-all duration-300"
              >
                {showAllSchedules ? 'Show less ↑' : 'View all schedules →'}
              </button>
            </div>
          </div>

            </>
          )}
        </div>
      </div>

      {/* Premium View Modal */}
      {showViewModal && selectedSchedule && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className={`bg-slate-900 rounded-2xl shadow-2xl w-full flex flex-col border border-slate-700 transition-all duration-300 ${isPreviewExpanded ? 'max-w-6xl max-h-[95vh]' : 'max-w-4xl max-h-[85vh]'}`}>
            <div className="px-6 py-5 border-b border-slate-700 flex-shrink-0 flex items-center justify-between bg-gradient-to-r from-slate-800/50 to-transparent">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-indigo-500/10">
                  <FileText className="w-6 h-6 text-indigo-400" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-black">Schedule Details</h2>
                  <p className="text-sm text-slate-400 mt-1">Read-only view of submitted schedule</p>
                </div>
              </div>
              <button 
                onClick={() => setShowViewModal(false)}
                className="p-2 hover:bg-slate-800 rounded-lg transition-colors"
              >
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6 scrollbar-thin">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 sm:p-5 rounded-xl bg-slate-800/50 border border-slate-700/50">
                {[
                  { label: 'Plant', value: selectedSchedule.plant },
                  { label: 'Category', value: selectedSchedule.category },
                  {
                    label: 'CSV File',
                    value: selectedSchedule.fileName
                      ? formatMachineScheduleDisplayName({
                          baseName: selectedSchedule.fileName,
                          key: selectedSchedule.id,
                          plantCodeOrName: selectedSchedule.plantCode || selectedSchedule.plant,
                          scheduleDate: selectedDate,
                          isDayAhead: false,
                          intradayRunIndex: intradayRunByScheduleKey.get(String(selectedSchedule.id || '').trim()),
                        })
                      : '-',
                  },
                  { label: 'Manual Changes', value: selectedSchedule.changes },
                  { label: 'Plant Capacity', value: getPlantCapacityForSchedule(selectedSchedule) }
                ].map((field, idx) => (
                  <div key={idx}>
                    <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                      {field.label}
                    </label>
                    <p className="text-sm sm:text-base font-semibold text-white mt-2">{field.value}</p>
                  </div>
                ))}
              </div>

              <div className="border border-slate-700/50 rounded-xl overflow-hidden">
                <div className="px-4 sm:px-6 py-4 bg-slate-800/50 border-b border-slate-700/50 flex-shrink-0 flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold text-black">Schedule Data Preview</h3>
                  <button
                    type="button"
                    onClick={() => setIsPreviewExpanded((prev) => !prev)}
                    className="px-3 py-1.5 rounded-lg bg-white text-black text-xs font-semibold hover:bg-slate-100 transition-all duration-200 flex items-center gap-2"
                  >
                    {isPreviewExpanded ? 'Close' : 'Expand'}
                    <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${isPreviewExpanded ? 'rotate-180' : ''}`} />
                  </button>
                </div>
                <div className={isPreviewExpanded ? 'max-h-[70vh] overflow-auto scrollbar-thin transition-all duration-300' : 'max-h-0 overflow-hidden transition-all duration-300'}>
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-slate-800">
                      <tr>
                        {(viewCsvHeaders.length ? viewCsvHeaders : ['No Columns']).map((header) => (
                          <th key={header} className="px-4 py-3 text-left text-xs font-semibold text-white dark:text-white uppercase whitespace-nowrap">
                            {header}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {viewCsvLoading && (
                        <tr>
                          <td colSpan={Math.max(viewCsvHeaders.length, 1)} className="px-4 py-10 text-center text-sm text-slate-400">
                            Loading CSV preview...
                          </td>
                        </tr>
                      )}
                      {!viewCsvLoading && viewCsvError && (
                        <tr>
                          <td colSpan={Math.max(viewCsvHeaders.length, 1)} className="px-4 py-10 text-center text-sm text-red-400">
                            {viewCsvError}
                          </td>
                        </tr>
                      )}
                      {!viewCsvLoading && !viewCsvError && viewCsvRows.length === 0 && (
                        <tr>
                          <td colSpan={Math.max(viewCsvHeaders.length, 1)} className="px-4 py-10 text-center text-sm text-slate-400">
                            No rows found in CSV.
                          </td>
                        </tr>
                      )}
                      {!viewCsvLoading && !viewCsvError && viewCsvRows.map((row, rowIndex) => (
                        <tr key={`preview-row-${rowIndex}`}>
                          {(viewCsvHeaders.length ? row : row.slice(0, 1)).map((cell, cellIndex) => {
                            const header = viewCsvHeaders[cellIndex];
                            const displayValue = formatPreviewCellValue(cell, header, row, viewCsvHeaders);
                            return (
                            <td key={`preview-cell-${rowIndex}-${cellIndex}`} className="px-4 py-3 text-slate-300 whitespace-nowrap">
                              {displayValue || '-'}
                            </td>
                          );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div className="px-6 py-5 border-t border-slate-700 bg-slate-800/30 flex-shrink-0 flex gap-3">
              <button 
                onClick={() => setShowViewModal(false)}
                className="flex-1 px-4 py-3 rounded-xl bg-red-600 text-white font-semibold hover:bg-red-500 transition-all duration-300 border border-red-700"
              >
                Close
              </button>
              <button 
                onClick={() => {
                  setPendingScheduleDownload(selectedSchedule);
                  setDownloadFormat('csv');
                  setShowDownloadModal(true);
                }}
                className="flex-1 px-4 py-3 rounded-xl bg-emerald-600 text-white font-semibold hover:bg-emerald-500 transition-all duration-300 flex items-center justify-center gap-2 border border-emerald-700"
              >
                <Download className="w-4 h-4 text-white" />
                Download
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Premium More Modal */}
      {showMoreModal && selectedSchedule && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 rounded-2xl shadow-2xl w-full max-w-lg border border-slate-700">
            <div className="px-4 sm:px-6 py-5 border-b border-slate-700 bg-gradient-to-r from-slate-800/50 to-transparent">
              <h2 className="text-lg sm:text-xl font-bold text-white">Pending Schedule Actions</h2>
              <p className="text-xs sm:text-sm text-slate-400 mt-1">Choose an action for this pending schedule</p>
            </div>
            
            <div className="p-4 sm:p-6 space-y-4">
              <div className="p-4 sm:p-5 rounded-xl bg-slate-800/50 border border-slate-700/50 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Plant</label>
                  <p className="text-sm sm:text-base font-semibold text-white mt-2">{selectedSchedule.plant}</p>
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Type</label>
                  <p className="text-sm sm:text-base font-semibold text-white mt-2">{selectedSchedule.type}</p>
                </div>
              </div>

              <div className="space-y-3">
                <button className="w-full px-5 sm:px-6 py-3.5 sm:py-4 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 text-white hover:from-emerald-500 hover:to-teal-500 transition-all duration-300 font-semibold text-left flex items-center gap-3 shadow-lg shadow-emerald-500/25">
                  <ArrowRight className="w-5 h-5" />
                  <span>Continue with Pending (Proceed to Submit)</span>
                </button>
                <button className="w-full px-5 sm:px-6 py-3.5 sm:py-4 rounded-xl bg-slate-800 text-slate-300 hover:bg-slate-700 transition-all duration-300 font-semibold text-left flex items-center gap-3 border border-slate-700">
                  <Upload className="w-5 h-5" />
                  <span>Revoke to Draft (Edit Schedule)</span>
                </button>
              </div>

              <div className="p-4 bg-indigo-500/10 border border-indigo-500/20 rounded-xl flex gap-3">
                <AlertTriangle className="w-5 h-5 text-indigo-400 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-slate-300">
                  <span className="font-semibold text-white">Note:</span> Continue will proceed to final submission. Revoke will allow editing the schedule.
                </p>
              </div>
            </div>

            <div className="px-6 py-5 border-t border-slate-700 bg-slate-800/30">
              <button 
                onClick={() => setShowMoreModal(false)}
                className="w-full px-4 py-3 rounded-xl bg-slate-800 text-slate-300 font-semibold hover:bg-slate-700 transition-all duration-300"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <DownloadFormatModal
        open={showDownloadModal}
        onClose={() => { setShowDownloadModal(false); setPendingScheduleDownload(null); }}
        format={downloadFormat}
        onFormatChange={setDownloadFormat}
        onDownload={() => {
          if (!pendingScheduleDownload) return;
          handleDownloadSchedule(pendingScheduleDownload, downloadFormat);
        }}
      />

    </>
  );
}









