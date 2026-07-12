import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import createPlotlyComponent from 'react-plotly.js/factory';
import Plotly from 'plotly.js-dist-min';
import { 
  Upload, 
  Database, 
  Wind, 
  Sun, 
  MapPin, 
  Zap, 
  Calendar,
  CheckCircle,
  RefreshCw,
  Download,
  MessageSquare,
  FileSpreadsheet,
  Cloud,
  TrendingUp,
  TrendingDown,
  Minus,
  BarChart3,
  AlertTriangle,
  X
} from 'lucide-react';
import { useApi } from '@/hooks/useApi';
import { LoadingSpinner } from '@/app/components/common/LoadingSpinner';
import { ErrorMessage } from '@/app/components/common/ErrorMessage';
import { useAuth, useTheme } from '@/app/appContexts';
import { S3_BASE_URL } from '@/config/appConfig';
import { api } from '@/services/api';
import { filterPlantsForUser, getDisabledPlantPattern } from '@/utils/plantAccess';

const Plot = createPlotlyComponent(Plotly);

const HoverablePlot = ({ data, layout, config, style, useResizeHandler, ...rest }) => {
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

  const nextData = hoverMarkerTrace ? [...(data || []), hoverMarkerTrace] : data;

  return (
    <Plot
      data={nextData}
      layout={layout}
      config={config}
      style={style}
      useResizeHandler={useResizeHandler}
      onHover={handlePlotHover}
      onUnhover={handlePlotUnhover}
      {...rest}
    />
  );
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
  SIRMOUR: 'generated/vedanjay/SIRMOUR/outputs/',
  ANJANGAON: 'generated/vedanjay/ANJANGAON/outputs/',
};
const GENERATED_OUTPUTS_BASE_PREFIXES = VEDANJAY_OUTPUTS_BASE_PREFIXES;
const LEGACY_OUTPUTS_BASE_PREFIX = 'outputs/';
const S3_PLANTS = [
  {
    id: 1,
    code: 'BHUPALPALLY',
    name: 'BHUPALPALLY',
    whatsappKey: 'BHUPALPALLY',
    state: 'Telangana',
    type: 'Solar',
    capacityMw: 10,
  },
  {
    id: 2,
    code: 'CME',
    name: 'CME',
    whatsappKey: 'CME',
    state: 'Maharashtra',
    type: 'Solar',
    capacityMw: 0,
  },
  {
    id: 3,
    code: 'GSNP',
    name: 'Globus Steel N Power (GSNP)',
    whatsappKey: 'GSNP',
    state: 'Madhya Pradesh',
    type: 'Solar',
    capacityMw: 20,
  },
  {
    id: 4,
    code: 'KASIPET',
    name: 'KASIPET',
    whatsappKey: 'KASIPET',
    state: 'Telangana',
    type: 'Solar',
    capacityMw: 15,
  },
  {
    id: 5,
    code: 'KOTHAGUDEM',
    name: 'KOTHAGUDEM',
    whatsappKey: 'KOTHAGUDEM',
    state: 'Telangana',
    type: 'Solar',
    capacityMw: 0,
  },
  {
    id: 6,
    code: 'KILAJ',
    name: 'KILAJ',
    whatsappKey: 'KILAJ',
    state: 'Maharashtra',
    type: 'Solar',
    capacityMw: 20,
  },
  {
    id: 7,
    code: 'OSEPL',
    name: 'OSEL',
    whatsappKey: 'OSEPL',
    state: 'Maharashtra',
    type: 'Solar',
    capacityMw: 20,
  },
  {
    id: 8,
    code: 'SIRMOUR',
    name: 'SIRMOUR',
    whatsappKey: 'Sirmour',
    state: 'Madhya Pradesh',
    type: 'Solar',
    capacityMw: 5.1,
  },
  {
    id: 10,
    code: 'BAMKHAL',
    name: 'BAMKHAL',
    whatsappKey: 'BAMKHAL',
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
    whatsappKey: 'ANDAD',
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
    whatsappKey: 'GUGARIYAKHEDI',
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
    whatsappKey: 'BALAKWADA',
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
    whatsappKey: 'NANDGAON',
    state: 'Madhya Pradesh',
    type: 'Solar',
    capacityMw: 7.5,
    latitude: 21.88222222,
    longitude: 75.48027778,
  },
  {
    id: 9,
    code: 'ANJANGAON',
    name: 'ANJANGAON',
    whatsappKey: 'ANJANGAON',
    state: 'Madhya Pradesh',
    type: 'Solar',
    capacityMw: 7.5,
  },
];

function normalizePlantKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function derivePlantCodeFromName(name) {
  const text = String(name || '').trim();
  if (!text) return null;
  const match = text.match(/\(([A-Za-z0-9_-]+)\)/);
  if (match) {
    const code = match[1].toUpperCase();
    return code === 'OSEL' ? 'OSEPL' : code;
  }
  if (/^[A-Z0-9_-]{2,6}$/.test(text)) {
    const code = text.toUpperCase();
    return code === 'OSEL' ? 'OSEPL' : code;
  }
  const compact = text.replace(/[^A-Za-z0-9]/g, '');
  if (!compact) return null;
  const code = compact.toUpperCase();
  return code === 'OSEL' ? 'OSEPL' : code;
}

function derivePlantFolders(plant) {
  const name = String(plant?.name || plant?.code || '').trim();
  if (!name) return null;
  let folder = name;
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

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line && line.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
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

function normalizeDateToIso(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `${trimmed}T00:00:00.000Z`;
  }
  const match = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (match) {
    const day = match[1].padStart(2, '0');
    const month = match[2].padStart(2, '0');
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    return `${year}-${month}-${day}T00:00:00.000Z`;
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString();
  }
  return null;
}

function formatDateLabel(value) {
  if (!value) return '';
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
  }
  return String(value);
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

function resolvePlantCode(selectedPlant, plants = S3_PLANTS) {
  if (!selectedPlant) return null;
  const text = String(selectedPlant).trim().toLowerCase();
  const numericId = Number.parseInt(text, 10);
  const plant = plants.find(
    (p) =>
      (Number.isFinite(numericId) && p.id === numericId) ||
      String(p.name || '').trim().toLowerCase() === text ||
      String(p.code || '').trim().toLowerCase() === text
  );
  return plant?.code || derivePlantCodeFromName(plant?.name) || null;
}

function isMeterAvailable(plant) {
  const code = String(plant?.code || derivePlantCodeFromName(plant?.name) || '').trim().toUpperCase();
  return code !== 'CME' && code !== 'KILAJ';
}

function getPlantRawPrefixes(plant) {
  const prefixes = [];
  const code = plant?.code || derivePlantCodeFromName(plant?.name);
  if (code && RAW_BASE_PREFIXES[code]) prefixes.push(RAW_BASE_PREFIXES[code]);
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
  if (code && GENERATED_OUTPUTS_BASE_PREFIXES[code]) {
    prefixes.push(GENERATED_OUTPUTS_BASE_PREFIXES[code]);
  }
  if (code && LEGACY_GENERATED_OUTPUTS_BASE_PREFIXES[code]) {
    prefixes.push(LEGACY_GENERATED_OUTPUTS_BASE_PREFIXES[code]);
  }
  const derived = derivePlantFolders(plant || { code });
  if (derived) {
    prefixes.push(`generated/vedanjay/${derived.upper}/outputs/`);
    prefixes.push(`generated/${derived.folder}/${derived.lower}/outputs/`);
  }
  return Array.from(new Set(prefixes));
}

function getIntradayPrefixes(date, plant = null) {
  const rawPrefixes = plant ? getPlantRawPrefixes(plant) : Object.values(RAW_BASE_PREFIXES);
  const generatedPrefixes = plant ? getPlantGeneratedPrefixes(plant) : Object.values(GENERATED_OUTPUTS_BASE_PREFIXES);
  return [
    ...rawPrefixes.map((prefix) => `${prefix}${date}/enercast_data/intraday/`),
    ...generatedPrefixes.map((prefix) => `${prefix}${date}/intraday/`),
    `${LEGACY_OUTPUTS_BASE_PREFIX}${date}/intraday/`,
    `${date}/intraday/`,
  ];
}

function getMeterPrefixes(date, plant = null) {
  const rawPrefixes = plant ? getPlantRawPrefixes(plant) : Object.values(RAW_BASE_PREFIXES);
  const generatedPrefixes = plant ? getPlantGeneratedPrefixes(plant) : Object.values(GENERATED_OUTPUTS_BASE_PREFIXES);
  return [
    ...rawPrefixes.map((prefix) => `${prefix}${date}/metered_data/`),
    ...generatedPrefixes.map((prefix) => `${prefix}${date}/meter/`),
    `${LEGACY_OUTPUTS_BASE_PREFIX}${date}/meter/`,
    `${date}/meter/`,
  ];
}

function getWeatherPrefixes(date, plant = null) {
  const rawPrefixes = plant ? getPlantRawPrefixes(plant) : Object.values(RAW_BASE_PREFIXES);
  const generatedPrefixes = plant ? getPlantGeneratedPrefixes(plant) : Object.values(GENERATED_OUTPUTS_BASE_PREFIXES);
  return [
    ...rawPrefixes.map((prefix) => `${prefix}${date}/weather_data/`),
    ...generatedPrefixes.map((prefix) => `${prefix}${date}/weather/`),
    `${LEGACY_OUTPUTS_BASE_PREFIX}${date}/weather/`,
    `${date}/weather/`,
  ];
}

function mergeUniqueObjects(objectSets) {
  return Array.from(new Map(objectSets.flat().map((o) => [o.key, o])).values());
}

function getLatestObjectByExt(objects, extension) {
  if (!objects.length) return null;
  const normalizedExt = extension.toLowerCase();
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

  return objects
    .filter(o => o.key.toLowerCase().endsWith(normalizedExt))
    .sort(compareNewestFirst)[0] || null;
}

async function fetchCsvFromS3(key) {
  const url = `${S3_BASE_URL}/${String(key || '').split('/').map((s) => encodeURIComponent(s)).join('/')}`;
  const text = await fetch(url).then(r => r.text());
  return { url, text };
}

function parseForecastIntradayCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line && line.trim().length > 0);
  if (!lines.length) return { dataPoints: [] };
  const headerIdx = lines.findIndex((line) => /(block|blk)/i.test(line) && line.includes(','));
  const csvText = headerIdx > 0 ? lines.slice(headerIdx).join('\n') : text;
  const { headers, rows } = parseCsv(csvText);

  // Some GSNP intraday files contain a second header row (e.g., metric names).
  // Detect and merge it with row-1 headers instead of treating it as data.
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

  const normalizedEffective = effectiveHeaders.map((h) =>
    String(h || '')
      .toLowerCase()
      .replace(/["']/g, '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, '')
      .replace(/[^a-z0-9]+/g, '')
  );
  const findColEff = (predicates) => normalizedEffective.findIndex((h) => predicates.some((p) => p(h)));

  const blockIdx = findColEff([
    (h) => h.includes('block') || h.includes('blk') || h === 'sno' || h.includes('srno') || h.includes('serialno'),
  ]);
  const timeIdx = findColEff([
    (h) => h.includes('time') || h.includes('timestamp') || h.includes('date') || h.includes('from'),
  ]);
  const actualIdx = findColEff([
    (h) => h.includes('actual'),
    (h) => h.includes('meter'),
    (h) => h.includes('generation') && !h.includes('forecast'),
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
    if (i === blockIdx || i === timeIdx || i === actualIdx) return;
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
      if (i === blockIdx || i === timeIdx || i === actualIdx) return;
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
  if (forecastIdx === -1) return { dataPoints: [] };

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

  const buildTime = (block) => {
    const idx = Math.max(0, Number(block || 1) - 1);
    const hh = Math.floor((idx * 15) / 60);
    const mm = (idx * 15) % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };

  const dataPoints = effectiveRows
    .slice(0, 96)
    .map((cols, idx) => {
      const block = parseBlock(blockIdx >= 0 ? cols[blockIdx] : '', idx);
      const time = (timeIdx >= 0 ? cols[timeIdx] : '')?.trim() || buildTime(block);
      const actualRaw = actualIdx >= 0 ? toNumericCell(cols[actualIdx]) : Number.NaN;
      const forecastRaw = toNumericCell(cols[forecastIdx]);
      const actual = Number.isFinite(actualRaw) ? actualRaw : 0;
      const forecast = Number.isFinite(forecastRaw) ? forecastRaw : 0;
      return {
        time,
        actual,
        forecast,
        actualText: actualIdx >= 0 ? String(cols[actualIdx] ?? '').trim() : '',
        forecastText: String(cols[forecastIdx] ?? '').trim(),
      };
    })
    .filter((d) => d.time);

  return { dataPoints };
}

function parseDateValue(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;

  let parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed;

  // Common fallback for "YYYY-MM-DD HH:mm:ss"
  parsed = new Date(value.replace(' ', 'T'));
  if (!Number.isNaN(parsed.getTime())) return parsed;

  // Fallback for "DD-MM-YYYY HH:mm[:ss]" and "DD/MM/YYYY HH:mm[:ss]"
  const dmyMatch = value.match(
    /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (dmyMatch) {
    const [, dd, mm, yyyy, hh = '0', min = '0', ss = '0'] = dmyMatch;
    parsed = new Date(
      Number(yyyy),
      Number(mm) - 1,
      Number(dd),
      Number(hh),
      Number(min),
      Number(ss)
    );
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  // Fallback for Unix timestamps (seconds or milliseconds)
  if (/^\d{10,13}$/.test(value)) {
    const num = Number(value);
    const ms = value.length === 10 ? num * 1000 : num;
    parsed = new Date(ms);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  return null;
}

function parseMeterCsv(text) {
  const { headers, rows } = parseCsv(text);
  const normalizedHeaders = headers.map((h) => h.trim().toLowerCase());
  const compactHeaders = headers.map((h) =>
    String(h || '')
      .toLowerCase()
      .replace(/["']/g, '')
      .replace(/[^a-z0-9]+/g, '')
  );
  const timeIdx = normalizedHeaders.findIndex((h) => h === 'timestamp' || h.includes('timestamp') || h === 'time');
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
    powerIdx = normalizedHeaders.findIndex(
      (h) =>
        h.includes('active power') ||
        h.includes('meter power') ||
        (h.includes('power') && h.includes('kw')) ||
        h === 'mw'
    );
  }
  if (timeIdx === -1 || powerIdx === -1) {
    return { dataPoints: [] };
  }
  const powerHeader = (normalizedHeaders[powerIdx] || '').trim();
  const explicitKw = powerHeader.includes('(kw)') || powerHeader.includes(' kw') || powerHeader === 'kw';
  const explicitMw =
    powerHeader.includes('(mw)') ||
    powerHeader.includes(' mw') ||
    powerHeader === 'mw' ||
    powerHeader.endsWith('mw');
  const dataPoints = rows
    .map(cols => {
      const time = (cols[timeIdx] || '').trim();
      const raw = parseFloat(String(cols[powerIdx] ?? '').replace(/,/g, '').trim());
      const generation = Number.isFinite(raw) ? raw : 0;
      const parsedTime = parseDateValue(time);
      return {
        time,
        generation,
        timestampMs: parsedTime ? parsedTime.getTime() : null
      };
    })
    .filter(d => d.time);
  const nonZero = dataPoints.map((d) => d.generation).filter((v) => Number.isFinite(v) && v > 0);
  const avg = nonZero.length ? (nonZero.reduce((a, b) => a + b, 0) / nonZero.length) : 0;
  const assumeKw = explicitKw || (!explicitMw && avg > 200);
  if (assumeKw) {
    dataPoints.forEach((d) => {
      d.generation = Number.isFinite(d.generation) ? d.generation / 1000 : d.generation;
    });
  }
  return { dataPoints };
}

function parseWeatherCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => String(line || '').trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  const scoreHeaderLine = (line) => {
    const l = String(line || '').toLowerCase();
    if (!(l.includes(',') || l.includes(';') || l.includes('\t'))) return -1;
    let score = 0;
    if (l.includes('time') || l.includes('date')) score += 5;
    if (l.includes('temperature') || l.includes('temp')) score += 3;
    if (l.includes('wind')) score += 3;
    if (l.includes('irradiance') || l.includes('radiation') || l.includes('ghi') || l.includes('dhi')) score += 3;
    return score;
  };

  let headerIdx = 0;
  let best = { idx: 0, score: -1 };
  const scanLimit = Math.min(lines.length, 30);
  for (let i = 0; i < scanLimit; i += 1) {
    const score = scoreHeaderLine(lines[i]);
    if (score > best.score) best = { idx: i, score };
  }
  if (best.score >= 0) headerIdx = best.idx;

  const csvTextFromHeader = lines.slice(headerIdx).join('\n');
  const { headers, rows } = parseCsv(csvTextFromHeader);

  const normalizedHeaders = headers.map((h) =>
    h
      .trim()
      .toLowerCase()
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, '_')
      .replace(/["']/g, '')
  );
  const findIndex = (candidates, fallbackMatcher = null) => {
    const exactIdx = normalizedHeaders.findIndex((h) => candidates.includes(h));
    if (exactIdx !== -1) return exactIdx;
    if (fallbackMatcher) return normalizedHeaders.findIndex((h) => fallbackMatcher(h));
    return -1;
  };

  const timeIdx = findIndex(['time', 'timestamp', 'date_time', 'datetime', 'date'], (h) => h.includes('time') || h === 'date');
  const tempIdx = findIndex(
    ['temperature_2m', 'temperature', 'temp', 'temp_c', 'temperature_c'],
    (h) => h.includes('temp') || h.includes('temperature')
  );
  const windIdx = findIndex(
    ['wind_speed_10m', 'windspeed', 'wind_speed', 'wind_speed_m_s'],
    (h) => h.includes('wind') && (h.includes('speed') || h.includes('windspeed'))
  );
  const diffuseIdx = findIndex(
    ['diffuse_radiation', 'dhi', 'diffuse'],
    (h) => h.includes('diffuse')
  );
  const globalIdx = findIndex(
    ['global_tilted_irradiance', 'global_irradiance', 'gti', 'ghi', 'global', 'shortwave_radiation'],
    (h) => h.includes('global') || h.includes('irradiance') || h.includes('shortwave') || h.includes('ghi')
  );

  const toNumber = (value) => {
    if (value === null || value === undefined) return null;
    const parsed = parseFloat(String(value).replace(/"/g, '').trim());
    return Number.isFinite(parsed) ? parsed : null;
  };

  const hasMetricColumns = [tempIdx, windIdx, diffuseIdx, globalIdx].some((idx) => idx !== -1);

  // Fallback A: key-value weather CSV (e.g. rows like "temperature_2m,28.4")
  if (!hasMetricColumns && headers.length >= 2) {
    const keyValueMap = new Map(
      rows.map((cols) => [
        String(cols[0] || '')
          .trim()
          .toLowerCase()
          .replace(/\s+/g, '_')
          .replace(/["']/g, ''),
        cols[1],
      ])
    );
    const point = {
      time:
        String(keyValueMap.get('time') || keyValueMap.get('timestamp') || keyValueMap.get('date') || new Date().toISOString()),
      temperature: toNumber(keyValueMap.get('temperature_2m') ?? keyValueMap.get('temperature') ?? keyValueMap.get('temp')),
      wind: toNumber(keyValueMap.get('wind_speed_10m') ?? keyValueMap.get('wind_speed') ?? keyValueMap.get('windspeed')),
      diffuse: toNumber(keyValueMap.get('diffuse_radiation') ?? keyValueMap.get('dhi') ?? keyValueMap.get('diffuse')),
      global: toNumber(
        keyValueMap.get('global_tilted_irradiance') ??
        keyValueMap.get('global_irradiance') ??
        keyValueMap.get('shortwave_radiation') ??
        keyValueMap.get('ghi')
      ),
    };
    if ([point.temperature, point.wind, point.diffuse, point.global].some((v) => v !== null)) {
      return { dataPoints: [point] };
    }
  }

  const dataPoints = rows
    .map((cols, idx) => ({
      time: (timeIdx === -1 ? `T${String(idx + 1).padStart(2, '0')}` : (cols[timeIdx] || '')).replace(/"/g, '').trim(),
      temperature: tempIdx === -1 ? null : toNumber(cols[tempIdx]),
      wind: windIdx === -1 ? null : toNumber(cols[windIdx]),
      diffuse: diffuseIdx === -1 ? null : toNumber(cols[diffuseIdx]),
      global: globalIdx === -1 ? null : toNumber(cols[globalIdx])
    }))
    .filter((d) => [d.temperature, d.wind, d.diffuse, d.global].some((v) => v !== null));

  return { dataPoints };
}

// Trigger a download in browser without navigating away
function triggerDownload(url, filename = '') {
  if (!url) return;
  const link = document.createElement('a');
  link.href = url;
  if (filename) link.download = filename;
  link.target = '_blank';
  link.rel = 'noreferrer';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function DataInputs({ sharedData, updateSharedData }) {
  const { isDarkMode } = useTheme();
  const { user: currentUser } = useAuth();
  // Filter states
  const [selectedPlant, setSelectedPlant] = useState('');
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);

  // Success state for load operation
  const [loadSuccess, setLoadSuccess] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');

  // Chart display states - use useRef to persist state across re-renders
  const [showForecastChart, setShowForecastChart] = useState(false);
  const [showMeterChart, setShowMeterChart] = useState(false);
  
  // Refs for chart state to ensure persistence
  const dataInputsScrollRef = useRef(null);
  const forecastChartRef = useRef(false);
  const meterChartRef = useRef(false);
  const forecastChartSectionRef = useRef(null);
  const meterChartSectionRef = useRef(null);
  const forecastPrevScrollTopRef = useRef(0);
  const meterPrevScrollTopRef = useRef(0);

  // Sync refs with state and log for debugging
  const toggleForecastChart = () => {
    const next = !forecastChartRef.current;
    if (next) {
      forecastPrevScrollTopRef.current = dataInputsScrollRef.current?.scrollTop ?? window.scrollY ?? 0;
    }
    forecastChartRef.current = next;
    setShowForecastChart(next);
    if (!next) {
      requestAnimationFrame(() => {
        const scroller = dataInputsScrollRef.current;
        if (scroller) {
          scroller.scrollTo({ top: forecastPrevScrollTopRef.current, behavior: 'smooth' });
        } else {
          window.scrollTo({ top: forecastPrevScrollTopRef.current, behavior: 'smooth' });
        }
      });
    }
    console.log('Forecast chart toggled:', next, 'data:', forecastData ? 'available' : 'none');
  };

  const toggleMeterChart = () => {
    const next = !meterChartRef.current;
    if (next) {
      meterPrevScrollTopRef.current = dataInputsScrollRef.current?.scrollTop ?? window.scrollY ?? 0;
    }
    meterChartRef.current = next;
    setShowMeterChart(next);
    if (!next) {
      requestAnimationFrame(() => {
        const scroller = dataInputsScrollRef.current;
        if (scroller) {
          scroller.scrollTo({ top: meterPrevScrollTopRef.current, behavior: 'smooth' });
        } else {
          window.scrollTo({ top: meterPrevScrollTopRef.current, behavior: 'smooth' });
        }
      });
    }
    console.log('Meter chart toggled:', next, 'data:', meterData ? 'available' : 'none');
  };

  const [showWhatsAppHistoryModal, setShowWhatsAppHistoryModal] = useState(false);

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
    const pickCapacity = (...values) => {
      for (const value of values) {
        const num = Number(value);
        if (Number.isFinite(num) && num > 0) return num;
      }
      return 0;
    };
    const enriched = apiPlants.map((plant) => {
      const match = S3_PLANTS.find(
        (p) => normalizePlantKey(p.name) === normalizePlantKey(plant.name) || normalizePlantKey(p.code) === normalizePlantKey(plant.name)
      );
      const code = match?.code || derivePlantCodeFromName(plant.name);
      const whatsappKey = match?.whatsappKey;
      const capacityMw = pickCapacity(plant.capacityMw, plant.capacity, match?.capacityMw, match?.capacity);
      const state = plant.state || match?.state;
      const type = plant.type || match?.type;
      return { ...plant, code, whatsappKey, capacityMw, state, type };
    });
    const mergedKeys = new Set(enriched.map((p) => normalizePlantKey(p.code || p.name)));
    const extras = roleFilteredFallbackPlants.filter((p) => !mergedKeys.has(normalizePlantKey(p.code || p.name)));
    return { plants: [...enriched, ...extras], total: enriched.length + extras.length, stats: apiPlantsData?.stats || {} };
  }, [apiPlantsData, currentUser]);
  const plantsLoading = false;

  // Memoized selected plant data - must be defined BEFORE useApi that uses it
  const selectedPlantData = useMemo(() => {
    if (!selectedPlant || !plantsData?.plants) return null;
    const selectedText = String(selectedPlant).trim().toLowerCase();
    return plantsData.plants.find((p) => {
      if (p.id === parseInt(selectedPlant)) return true;
      if (String(p.name || '').trim().toLowerCase() === selectedText) return true;
      if (String(p.code || '').trim().toLowerCase() === selectedText) return true;
      return false;
    });
  }, [selectedPlant, plantsData]);

  // Normalized plant config for downstream components (e.g., chart capacity)
  // Keeps the API-derived plant shape consistent with the S3 fallback list.
  const selectedPlantConfig = useMemo(() => {
    if (selectedPlantData) return selectedPlantData;
    return null;
  }, [selectedPlantData]);

  const {
    data: forecastData,
    loading: forecastLoading,
    error: forecastError,
    execute: fetchForecast,
    reset: resetForecast
  } = useApi(
    async () => {
      const plantInfo = selectedPlantData;
      const objectsFlat = await listS3ObjectsAcrossPrefixes(getIntradayPrefixes(selectedDate, plantInfo), currentUser);
      const objects = mergeUniqueObjects([objectsFlat]);
      const latestCsv = getLatestObjectByExt(objects, '.csv');
      const latestHtml = getLatestObjectByExt(objects, '.html');

      if (!latestCsv && !latestHtml) {
        throw new Error('No intraday forecast files found for selected date');
      }

      let parsed = { dataPoints: [] };
      let latestFileKey = '';
      let latestFileUrl = '';

      if (latestCsv) {
        const csvResponse = await fetchCsvFromS3(latestCsv.key);
        parsed = parseForecastIntradayCsv(csvResponse.text);
        latestFileKey = latestCsv.key;
        latestFileUrl = csvResponse.url;
      } else if (latestHtml) {
        latestFileKey = latestHtml.key;
        latestFileUrl = `${S3_BASE_URL}/${String(latestHtml.key || '').split('/').map((s) => encodeURIComponent(s)).join('/')}`;
      }

      return {
        ...parsed,
        createdAt: latestCsv?.lastModified || latestHtml?.lastModified || new Date().toISOString(),
        fileUrl: latestFileUrl,
        fileName: latestFileKey.split('/').pop(),
        graphUrl: latestHtml ? `${S3_BASE_URL}/${String(latestHtml.key || '').split('/').map((s) => encodeURIComponent(s)).join('/')}` : null,
        graphFileName: latestHtml ? latestHtml.key.split('/').pop() : null
      };
    },
    { immediate: false, initialData: null }
  );

  const {
    data: meterData,
    loading: meterLoading,
    error: meterError,
    execute: fetchMeterData,
    reset: resetMeterData
  } = useApi(
    async () => {
      const plantInfo = selectedPlantData;
      if (!plantInfo) return null;
      if (!isMeterAvailable(plantInfo)) {
        return null;
      }
      const meterObjectsFlat = await listS3ObjectsAcrossPrefixes(getMeterPrefixes(selectedDate, plantInfo), currentUser);
      const meterObjects = mergeUniqueObjects([meterObjectsFlat])
        .filter((o) => o.key.toLowerCase().endsWith('.csv'))
        .sort((a, b) => {
          const aTime = Date.parse(a.lastModified || '');
          const bTime = Date.parse(b.lastModified || '');
          const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
          if (timeDiff !== 0) return timeDiff;
          return (b.key || '').localeCompare(a.key || '');
        });
      if (!meterObjects.length) {
        throw new Error(`No meter CSV found for ${selectedDate}`);
      }
      const meterKey = meterObjects[0].key;
      const { url, text } = await fetchCsvFromS3(meterKey);
      const parsed = parseMeterCsv(text);
      const lastPoint = parsed.dataPoints
        .filter(p => p.timestampMs !== null)
        .sort((a, b) => b.timestampMs - a.timestampMs)[0];
      return {
        ...parsed,
        lastReading: lastPoint?.time || null,
        source: 'S3',
        fileUrl: url,
        fileName: meterKey.split('/').pop()
      };
    },
    { immediate: false, initialData: null }
  );

  const {
    data: weatherCurrent,
    loading: weatherCurrentLoading,
    error: weatherCurrentError,
    execute: fetchWeatherCurrent,
    reset: resetWeatherCurrent
  } = useApi(
    async () => {
      const plantInfo = selectedPlantData;
      const weatherObjectsFlat = await listS3ObjectsAcrossPrefixes(getWeatherPrefixes(selectedDate, plantInfo), currentUser);
      const weatherObjects = mergeUniqueObjects([weatherObjectsFlat])
        .filter((o) => o.key.toLowerCase().endsWith('.csv'))
        .sort((a, b) => {
          const aTime = Date.parse(a.lastModified || '');
          const bTime = Date.parse(b.lastModified || '');
          const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
          if (timeDiff !== 0) return timeDiff;
          return (b.key || '').localeCompare(a.key || '');
        });
      const weatherCurrentObject = weatherObjects.filter((o) => {
        const fileName = (o.key.split('/').pop() || '').toLowerCase();
        return fileName.includes('openmeteo_current') || fileName.includes('current');
      })[0] || weatherObjects[0];
      if (!weatherCurrentObject) {
        throw new Error(`No weather current CSV found for ${selectedDate}`);
      }
      const { url, text } = await fetchCsvFromS3(weatherCurrentObject.key);
      const parsed = parseWeatherCsv(text);
      return { ...parsed, fileUrl: url, fileName: weatherCurrentObject.key.split('/').pop() };
    },
    { immediate: false, initialData: null }
  );

  const {
    execute: fetchWeatherMinutely,
    reset: resetWeatherMinutely
  } = useApi(
    async () => {
      const plantInfo = selectedPlantData;
      const weatherObjectsFlat = await listS3ObjectsAcrossPrefixes(getWeatherPrefixes(selectedDate, plantInfo), currentUser);
      const weatherObjects = mergeUniqueObjects([weatherObjectsFlat])
        .filter((o) => o.key.toLowerCase().endsWith('.csv'))
        .sort((a, b) => {
          const aTime = Date.parse(a.lastModified || '');
          const bTime = Date.parse(b.lastModified || '');
          const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
          if (timeDiff !== 0) return timeDiff;
          return (b.key || '').localeCompare(a.key || '');
        });
      const weatherMinutelyObject = weatherObjects.filter((o) => {
        const fileName = (o.key.split('/').pop() || '').toLowerCase();
        return fileName.includes('openmeteo_minutely15') || fileName.includes('minutely');
      })[0] || weatherObjects[0];
      if (!weatherMinutelyObject) {
        throw new Error(`No weather minutely CSV found for ${selectedDate}`);
      }
      const { url, text } = await fetchCsvFromS3(weatherMinutelyObject.key);
      const parsed = parseWeatherCsv(text);
      return { ...parsed, fileUrl: url, fileName: weatherMinutelyObject.key.split('/').pop() };
    },
    { immediate: false, initialData: null }
  );

  const {
    data: whatsappInstant,
    execute: fetchWhatsAppData,
    reset: resetWhatsAppData
  } = useApi(
    async () => {
      if (!selectedPlantData) return null;
      const siteKey = selectedPlantData.whatsappKey || selectedPlantData.code || selectedPlantData.name || selectedPlant;
      return api.whatsappInstant.get(siteKey);
    },
    { immediate: false, initialData: null }
  );
  const whatsappDataList = useMemo(() => {
    if (!whatsappInstant) return { data: [] };

    // Backend returns `{ data: null }` when no record is found for a site.
    if (Object.prototype.hasOwnProperty.call(whatsappInstant, 'data') && whatsappInstant?.data == null) {
      return { data: [] };
    }

    const parsed = whatsappInstant.parsed || {};
    const hasAnySignal =
      Boolean(String(whatsappInstant.message || '').trim()) ||
      Boolean(String(whatsappInstant.updatedAt || whatsappInstant?.live?.updated_at || '').trim()) ||
      Object.keys(parsed || {}).length > 0;
    if (!hasAnySignal) return { data: [] };

    const curtailmentCapacity = parsed.curtailmentCapacity;
    const rawStatus = String(
      whatsappInstant.status
        || whatsappInstant?.live?.plant_status
        || parsed.plantStatus
        || ''
    ).trim();
    const isCurtailment =
      Boolean(parsed.curtailmentStatus)
      || rawStatus.toLowerCase() === 'curtailment'
      || rawStatus.toUpperCase() === 'CURTAILMENT';
    const plantStatus = rawStatus || (isCurtailment ? 'Curtailment' : 'Normal');

    // Prefer message-provided date/time in IST; fallback to updatedAt.
    const parsedDateKey = String(parsed.date || '').trim();
    const parsedTimeKey = String(parsed.time || '').trim();
    const fallbackIso = normalizeDateToIso(whatsappInstant.updatedAt || whatsappInstant?.live?.updated_at);

    let timestamp = null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(parsedDateKey) && /^\d{1,2}:\d{2}$/.test(parsedTimeKey)) {
      const [h, m] = parsedTimeKey.split(':').map((v) => String(v).padStart(2, '0'));
      timestamp = new Date(`${parsedDateKey}T${h}:${m}:00+05:30`);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(parsedDateKey)) {
      timestamp = new Date(`${parsedDateKey}T00:00:00+05:30`);
    } else if (fallbackIso) {
      const dt = parseDateValue(fallbackIso);
      timestamp = dt && !Number.isNaN(dt.getTime()) ? dt : null;
    }

    const timestampIso = timestamp ? timestamp.toISOString() : null;
    const displayTime = parsedTimeKey || (timestamp
      ? timestamp.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })
      : '');
    return {
      data: [
        {
          id: timestamp ? timestamp.getTime() : Date.now(),
          plantName:
            String(parsed.site || '').trim()
            || selectedPlantData?.name
            || String(whatsappInstant.site || whatsappInstant.plantId || ''),
          date: timestampIso || new Date().toISOString(),
          time: displayTime,
          currentGeneration: parsed.currentGeneration ?? '',
          expectedTrend: parsed.expectedTrend || '',
          curtailmentStatus: Boolean(isCurtailment),
          curtailmentReason: parsed.curtailmentReason || '',
          curtailmentCapacity,
          remarks: parsed.remarks || (curtailmentCapacity ? `Curtailment Capacity: ${curtailmentCapacity} MW` : '') || whatsappInstant.message || '',
          status: plantStatus,
          startTime: String(parsed.startTime || '').trim(),
          endTime: String(parsed.endTime || '').trim(),
        }
      ]
    };
  }, [whatsappInstant, selectedPlantData]);

  // Load data when plant is selected
  useEffect(() => {
    if (selectedPlant) {
      fetchForecast();
      fetchMeterData();
      fetchWhatsAppData();
      fetchWeatherCurrent();
      fetchWeatherMinutely();
    }
  }, [selectedPlant, selectedDate]);

  useEffect(() => {
    if (selectedPlant) return;
    resetForecast();
    resetMeterData();
    resetWeatherCurrent();
    resetWeatherMinutely();
    resetWhatsAppData();
    setLoadSuccess(false);
    setSuccessMessage('');
    forecastChartRef.current = false;
    meterChartRef.current = false;
    setShowForecastChart(false);
    setShowMeterChart(false);
  }, [selectedPlant, resetForecast, resetMeterData, resetWeatherCurrent, resetWeatherMinutely, resetWhatsAppData]);

  // Auto-show chart when data is loaded (optional UX improvement) - defined AFTER useApi hooks
  useEffect(() => {
    if (forecastData && !forecastChartRef.current) {
      // Optionally auto-show chart when data loads
      // forecastChartRef.current = true;
      // setShowForecastChart(true);
    }
  }, [forecastData]);

  useEffect(() => {
    if (showForecastChart && forecastChartSectionRef.current) {
      forecastChartSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [showForecastChart]);

  useEffect(() => {
    if (meterData && !meterChartRef.current) {
      // Optionally auto-show chart when data loads
      // meterChartRef.current = true;
      // setShowMeterChart(true);
    }
  }, [meterData]);

  useEffect(() => {
    if (showMeterChart && meterChartSectionRef.current) {
      meterChartSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [showMeterChart]);

  const handleLoad = async () => {
    if (!selectedPlant) {
      alert('Please select a plant first');
      return;
    }
    
    // Reset success state
    setLoadSuccess(false);
    setSuccessMessage('');
    
    // Fetch data
    await fetchForecast();
    await fetchMeterData();
    await fetchWeatherCurrent();
    await fetchWeatherMinutely();
    await fetchWhatsAppData();
    
    // Show success message
    setLoadSuccess(true);
    setSuccessMessage('Data loaded successfully from S3 for the selected plant and date.');
    
    // Clear success message after 5 seconds
    setTimeout(() => {
      setLoadSuccess(false);
      setSuccessMessage('');
    }, 5000);
  };

  // Calculate delays and status
  const meterDelay = useMemo(() => {
    if (!meterData?.lastReading) return null;
    const now = new Date();
    const lastReading = parseDateValue(meterData.lastReading);
    if (!lastReading) return null;
    const diffMinutes = Math.floor((now - lastReading) / (1000 * 60));
    return diffMinutes < 0 ? 0 : diffMinutes;
  }, [meterData]);

  const forecastPointsCount = useMemo(
    () => (forecastData?.dataPoints?.length ? forecastData.dataPoints.length : 0),
    [forecastData]
  );

  const forecastCoverage = useMemo(() => {
    if (!forecastPointsCount) return 'N/A';
    return `${Math.min(100, Math.round((forecastPointsCount / 96) * 100))}%`;
  }, [forecastPointsCount]);

  return (
    <div ref={dataInputsScrollRef} className={`flex-1 overflow-auto min-h-0 relative overflow-x-hidden ${isDarkMode ? 'bg-slate-950' : 'bg-background'}`}>
      {/* Animated background elements */}
      {isDarkMode && (
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-0 left-1/4 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl animate-pulse" />
          <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />
        </div>
      )}

      <div className="w-full p-4 sm:p-6 lg:p-8 space-y-6 max-w-[1600px] mx-auto relative z-10">
        {/* Premium Header */}
        <div className={`relative overflow-hidden rounded-2xl border ${isDarkMode ? 'bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 border-slate-700/50 shadow-2xl' : 'bg-gradient-to-r from-white via-slate-50 to-emerald-50 border-border shadow-sm'}`}>
          <div className={`absolute inset-0 ${isDarkMode ? 'bg-gradient-to-r from-indigo-500/5 via-transparent to-purple-500/5' : 'bg-gradient-to-r from-emerald-500/5 via-transparent to-cyan-500/5'}`} />
          <div className={`absolute top-0 right-0 w-64 h-64 rounded-full blur-2xl ${isDarkMode ? 'bg-gradient-to-bl from-indigo-500/10 to-transparent' : 'bg-gradient-to-bl from-emerald-400/15 to-transparent'}`} />
          
          <div className="relative p-4 sm:p-6">
            <div className="flex items-start gap-4 sm:gap-5">
              <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/25">
                <Database className="w-6 h-6 sm:w-7 sm:h-7 text-white" />
              </div>
              <div>
                <h1 className="text-2xl sm:text-3xl font-bold text-foreground mb-2 tracking-tight">Data Inputs</h1>
                <div className="flex flex-wrap items-center gap-2 sm:gap-4 text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
                    <span className="text-xs sm:text-sm font-medium">Live Monitoring</span>
                  </div>
                  <span className="text-muted-foreground hidden sm:inline">•</span>
                  <span className="text-xs sm:text-sm">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</span>
                </div>
                <p className="text-xs sm:text-sm text-muted-foreground mt-2">View and manage all data sources for schedule preparation</p>
              </div>
            </div>
          </div>
        </div>

        {/* DATA INPUTS - VIEW ONLY Section */}
        <div className={`rounded-2xl border backdrop-blur-sm p-4 sm:p-6 ${isDarkMode ? 'bg-slate-900/50 border-slate-700/50' : 'bg-white border-border shadow-sm'}`}>
          <div className="flex items-center justify-between mb-4 sm:mb-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-indigo-500/10">
                <Database className="w-5 h-5 text-indigo-400" />
              </div>
              <h2 className="text-base sm:text-lg font-semibold text-foreground">DATA INPUTS - VIEW ONLY</h2>
            </div>
          </div>
          
          <div className="flex flex-col md:flex-row gap-4 mb-6">
            <div className="flex-1">
              <label className="text-sm font-semibold text-foreground mb-2 block">FILTERS: Plant</label>
              {plantsLoading ? (
                <div className={`w-full px-3.5 py-2.5 sm:px-4 sm:py-3 rounded-xl text-sm flex items-center gap-2 ${isDarkMode ? 'bg-slate-800/50 border border-slate-700/50' : 'bg-background border border-border'}`}>
                  <RefreshCw className="w-4 h-4 animate-spin text-indigo-400" />
                  <span className="text-muted-foreground">Loading plants...</span>
                </div>
              ) : (
                <select 
                  value={selectedPlant}
                  onChange={(e) => setSelectedPlant(e.target.value)}
                  className={`w-full px-3.5 py-2.5 sm:px-4 sm:py-3 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all ${isDarkMode ? 'bg-slate-800/50 border border-slate-700/50 text-white' : 'bg-background border border-border text-foreground'}`}
                >
                  <option value="">Select Plant</option>
                  {plantsData?.plants?.map(plant => (
                    <option key={plant.id} value={plant.id}>{plant.name}</option>
                  ))}
                </select>
              )}
            </div>
            <div className="flex-1">
              <label className="text-sm font-semibold text-foreground mb-2 block">Specific Date</label>
              <input 
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className={`w-full px-3.5 py-2.5 sm:px-4 sm:py-3 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all ${isDarkMode ? 'bg-slate-800/50 border border-slate-700/50 text-white' : 'bg-background border border-border text-foreground'}`}
              />
            </div>
            <div className="flex items-end">
              <button 
                onClick={handleLoad}
                disabled={!selectedPlant || plantsLoading || forecastLoading || meterLoading}
                className="w-full md:w-auto px-6 sm:px-8 py-2.5 sm:py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white shadow-lg shadow-indigo-500/25 hover:from-indigo-500 hover:to-purple-500 transition-all font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {forecastLoading || meterLoading ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Loading...
                  </>
                ) : (
                  'LOAD'
                )}
              </button>
            </div>
          </div>
          
          {/* Success Message */}
          {loadSuccess && (
            <div className="mt-4 p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl animate-in fade-in slide-in-from-top-2 duration-300">
              <div className="flex items-center gap-3">
                <CheckCircle className="w-5 h-5 text-emerald-400 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-white">Load Successful</p>
                  <p className="text-xs text-slate-400">{successMessage}</p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Main Grid - Forecast, Meter, Weather, WhatsApp */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
          {/* Forecast Data (Enercast) */}
          <div className={`relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 to-slate-800 border border-slate-700/50 hover:border-slate-500 hover:shadow-xl hover:shadow-slate-900/30 hover:-translate-y-1 transition-all duration-500 ${forecastData ? 'ring-2 ring-emerald-500/20' : ''}`}>
            <div className={`absolute inset-0 bg-gradient-to-r ${forecastData ? 'bg-emerald-500/5' : ''} opacity-0 transition-opacity duration-500`} />
            <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-indigo-500/10 to-transparent rounded-full blur-2xl" />
            
            <div className="relative p-4 sm:p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-xl bg-blue-500/10">
                    <TrendingUp className="w-5 h-5 text-blue-400" />
                  </div>
                  <h3 className="text-sm sm:text-base font-semibold text-white">FORECAST DATA (ENERCAST)</h3>
                </div>
                {forecastData && (
                  <span className="px-3 py-1 rounded-lg text-xs font-semibold bg-emerald-500/10 text-emerald-400 flex items-center gap-1.5 border border-emerald-500/20">
                    <CheckCircle className="w-3.5 h-3.5" /> Loaded
                  </span>
                )}
              </div>
              
              {/* Error Display */}
              {forecastError && (
                <div className="mb-4">
                  <ErrorMessage 
                    error={forecastError} 
                    onRetry={handleLoad}
                    variant="warning"
                  />
                </div>
              )}
              
              {forecastLoading ? (
                <div className="py-8">
                  <LoadingSpinner message="Loading forecast data..." />
                </div>
              ) : forecastData ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Last Updated:</span>
                    <span className="font-medium text-white">
                      {new Date(forecastData.createdAt || Date.now()).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} {new Date(forecastData.createdAt || Date.now()).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Data Points:</span>
                    <span className="font-medium text-white">
                      {forecastPointsCount ? `${forecastPointsCount} (Available)` : 'N/A'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">API Status:</span>
                    <span className="px-3 py-1 rounded-lg text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                      {forecastData.fileUrl ? 'Loaded from S3' : 'N/A'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Coverage:</span>
                    <span className="font-medium text-white">{forecastCoverage}</span>
                  </div>
                  {forecastData.fileUrl && (
                    <div className="flex items-center justify-between text-sm gap-3">
                      <span className="text-slate-400">Latest File:</span>
                      <div className="flex items-center gap-2 max-w-[220px]">
                        <span
                          className="font-medium text-indigo-300 truncate"
                          title={forecastData.fileName}
                        >
                          {forecastData.fileName}
                        </span>
                        <button
                          onClick={() => triggerDownload(forecastData.fileUrl, forecastData.fileName)}
                          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sky-600/80 hover:bg-sky-500 text-xs sm:text-sm font-semibold text-white shadow-sm border border-sky-500"
                        >
                          <Download className="w-4 h-4" />
                          Download CSV
                        </button>
                      </div>
                    </div>
                  )}
                  {forecastData.graphUrl && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-400">Latest Graph:</span>
                      <a
                        href={forecastData.graphUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-blue-300 hover:text-blue-200 truncate max-w-[140px] sm:max-w-[220px]"
                        title={forecastData.graphFileName || 'Enercast graph'}
                      >
                        {forecastData.graphFileName || 'Open Enercast graph'}
                      </a>
                    </div>
                  )}
                  <button
                    onClick={toggleForecastChart}
                    disabled={!forecastData}
                    className="w-full mt-4 px-4 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white shadow-lg shadow-indigo-500/25 hover:from-indigo-500 hover:to-purple-500 transition-all font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    <BarChart3 className="w-4 h-4" />
                    {showForecastChart ? 'HIDE FORECAST CHART' : 'VIEW FORECAST CHART'}
                  </button>
                </div>
              ) : (
                <div className="text-center py-8 text-sm text-slate-400">
                  <p>Select a plant and click LOAD to view forecast data</p>
                </div>
              )}
            </div>
          </div>

          {/* Meter Data (Actual) */}
          <div className={`relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 to-slate-800 border border-slate-700/50 hover:border-slate-500 hover:shadow-xl hover:shadow-slate-900/30 hover:-translate-y-1 transition-all duration-500 ${meterData ? 'ring-2 ring-emerald-500/20' : ''}`}>
            <div className={`absolute inset-0 bg-gradient-to-r ${meterData ? 'bg-emerald-500/5' : ''} opacity-0 transition-opacity duration-500`} />
            <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-amber-500/10 to-transparent rounded-full blur-2xl" />
            
            <div className="relative p-4 sm:p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-xl bg-amber-500/10">
                    <Zap className="w-5 h-5 text-amber-400" />
                  </div>
                  <h3 className="text-sm sm:text-base font-semibold text-white">METER DATA (ACTUAL)</h3>
                </div>
                {meterData && (
                  <span className="px-3 py-1 rounded-lg text-xs font-semibold bg-emerald-500/10 text-emerald-400 flex items-center gap-1.5 border border-emerald-500/20">
                    <CheckCircle className="w-3.5 h-3.5" /> Loaded
                  </span>
                )}
              </div>
              
              {/* Error Display */}
              {meterError && (
                <div className="mb-4">
                  <ErrorMessage 
                    error={meterError} 
                    onRetry={handleLoad}
                    variant="warning"
                  />
                </div>
              )}
              
              {meterLoading ? (
                <div className="py-8">
                  <LoadingSpinner message="Loading meter data..." />
                </div>
              ) : meterData ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Last Reading:</span>
                    <span className="font-medium text-white">
                      {(() => {
                        const readingDate = parseDateValue(meterData.lastReading);
                        if (!readingDate) return 'N/A';
                        return `${readingDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} ${readingDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
                      })()}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Data Points:</span>
                    <span className="font-medium text-white">{meterData.dataPoints?.length ?? 0} (Available)</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Source:</span>
                    <span className="font-medium text-white">{meterData.source || 'N/A'}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Delay:</span>
                    <span className={`font-medium ${meterDelay && meterDelay > 20 ? 'text-red-400' : 'text-white'}`}>
                      {meterDelay === null ? 'N/A' : `${meterDelay} min`}
                    </span>
                  </div>
                  {meterData.fileUrl && (
                    <div className="flex items-center justify-between text-sm gap-3">
                      <span className="text-slate-400">File:</span>
                      <div className="flex items-center gap-2 max-w-[220px]">
                        <span
                          className="font-medium text-amber-300 truncate"
                          title={meterData.fileName}
                        >
                          {meterData.fileName}
                        </span>
                        <button
                          onClick={() => triggerDownload(meterData.fileUrl, meterData.fileName)}
                          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sky-600/80 hover:bg-sky-500 text-xs sm:text-sm font-semibold text-white shadow-sm border border-sky-500"
                        >
                          <Download className="w-4 h-4" />
                          Download CSV
                        </button>
                      </div>
                    </div>
                  )}
                  <button
                    onClick={toggleMeterChart}
                    disabled={!meterData}
                    className="w-full mt-4 px-4 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white shadow-lg shadow-indigo-500/25 hover:from-indigo-500 hover:to-purple-500 transition-all font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    <BarChart3 className="w-4 h-4" />
                    {showMeterChart ? 'HIDE METER CHART' : 'VIEW METER CHART'}
                  </button>
                </div>
              ) : (
                <div className="text-center py-8 text-sm text-slate-400">
                  <p>No meter data available</p>
                </div>
              )}
            </div>
          </div>

        </div>

        {/* Inline Forecast Chart */}
        {showForecastChart && forecastData && (
          <div ref={forecastChartSectionRef} className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 to-slate-800 border border-slate-700/50 p-6 animate-in fade-in slide-in-from-top-2 duration-300">
            <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-bl from-indigo-500/10 to-transparent rounded-full blur-3xl" />
            
            <div className="relative flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-blue-500/10">
                  <BarChart3 className="w-5 h-5 text-blue-400" />
                </div>
                <h3 className="text-lg font-semibold text-white">Forecast Data Chart</h3>
              </div>
              <button
                onClick={toggleForecastChart}
                className="px-4 py-2 rounded-lg bg-slate-700/50 hover:bg-slate-600/50 border border-slate-600/50 text-slate-300 text-sm font-medium transition-all"
              >
                Close
              </button>
            </div>
            <div className="h-80 bg-slate-800/50 rounded-xl border border-slate-700/50 p-4 relative overflow-hidden">
              <ForecastChart
                data={forecastData}
                graphUrl={forecastData?.graphUrl}
                capacityMw={selectedPlantConfig?.capacityMw ?? selectedPlantConfig?.capacity ?? null}
              />
            </div>
          </div>
        )}

        {/* Inline Meter Chart */}
        {showMeterChart && meterData && (
          <div ref={meterChartSectionRef} className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 to-slate-800 border border-slate-700/50 p-6 animate-in fade-in slide-in-from-top-2 duration-300">
            <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-bl from-amber-500/10 to-transparent rounded-full blur-3xl" />
            
            <div className="relative flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-amber-500/10">
                  <BarChart3 className="w-5 h-5 text-amber-400" />
                </div>
                <h3 className="text-lg font-semibold text-white">Meter Data Chart</h3>
              </div>
              <button
                onClick={toggleMeterChart}
                className="px-4 py-2 rounded-lg bg-slate-700/50 hover:bg-slate-600/50 border border-slate-600/50 text-slate-300 text-sm font-medium transition-all"
              >
                Close
              </button>
            </div>
            <div className="h-80 bg-slate-800/50 rounded-xl border border-slate-700/50 p-4 relative overflow-hidden">
              <MeterChart data={meterData} capacityMw={selectedPlantConfig?.capacityMw ?? selectedPlantConfig?.capacity ?? null} />
            </div>
          </div>
        )}

      </div>

      {/* WhatsApp History Modal */}
      {showWhatsAppHistoryModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 rounded-2xl shadow-2xl w-full max-w-4xl border border-slate-700 max-h-[85vh] flex flex-col">
            <div className="px-6 py-5 border-b border-slate-700 bg-gradient-to-r from-slate-800/50 to-transparent flex-shrink-0">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-xl bg-green-500/10">
                    <MessageSquare className="w-6 h-6 text-green-400" />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-white">WhatsApp Message History</h2>
                    <p className="text-sm text-slate-400 mt-1">All incoming messages for this plant</p>
                  </div>
                </div>
                <button 
                  onClick={() => setShowWhatsAppHistoryModal(false)}
                  className="p-2 hover:bg-slate-800 rounded-lg transition-all"
                >
                  <X className="w-5 h-5 text-slate-400" />
                </button>
              </div>
            </div>
            
            <div className="p-6 overflow-y-auto flex-1 scrollbar-thin">
              {whatsappDataList?.data && whatsappDataList.data.length > 0 ? (
                <div className="space-y-4">
                  {whatsappDataList.data.map((msg) => (
                    <div key={msg.id} className="p-5 bg-slate-800/50 rounded-xl border border-slate-700/50 hover:bg-slate-800/70 transition-all">
                      <div className="flex items-start justify-between mb-3">
                        <div>
                          <p className="font-semibold text-white">{msg.plantName}</p>
                          <p className="text-xs text-slate-500 mt-1">
                            {formatDateLabel(msg.date)} {msg.time}
                          </p>
                        </div>
                        <span className={`px-3 py-1 rounded-lg text-xs font-semibold ${
                          msg.curtailmentStatus ? 'bg-red-500/10 text-red-300 border border-red-500/20' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                        }`}>
                          {msg.status || (msg.curtailmentStatus ? 'Curtailment' : 'Normal')}
                        </span>
                      </div>
                      <div className="text-sm text-white space-y-1.5">
                        <p><span className="text-slate-400">Generation:</span> {msg.currentGeneration} MW</p>
                        <p><span className="text-slate-400">Trend:</span> {msg.expectedTrend}</p>
                        {msg.curtailmentCapacity !== undefined && msg.curtailmentCapacity !== '' && (
                          <p><span className="text-slate-400">Curtailment Capacity:</span> {msg.curtailmentCapacity} MW</p>
                        )}
                        {msg.curtailmentStatus && <p><span className="text-slate-400">Curtailment:</span> {msg.curtailmentReason}</p>}
                        {msg.remarks && <p className="text-slate-400 mt-2"><span className="text-slate-500">Remarks:</span> {msg.remarks}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12 text-sm text-slate-400">
                  <MessageSquare className="w-12 h-12 mx-auto mb-3 text-slate-600" />
                  <p>No WhatsApp messages found</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Forecast Chart Component - Plotly
function ForecastChart({ data, graphUrl, capacityMw }) {
  if (!data) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <div className="text-center">
          <LoadingSpinner />
          <p className="text-sm text-muted-foreground mt-2">Loading chart data...</p>
        </div>
      </div>
    );
  }

  if (graphUrl) {
    return (
      <div className="w-full h-full">
        <iframe
          src={graphUrl}
          title="Enercast Forecast Graph"
          className="w-full h-full rounded-lg border border-slate-700/50 bg-slate-900"
        />
      </div>
    );
  }

  if (!data?.dataPoints || !Array.isArray(data.dataPoints) || data.dataPoints.length === 0) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <div className="text-center text-muted-foreground">
          <BarChart3 className="w-12 h-12 mx-auto mb-2 opacity-50" />
          <p>No forecast data available</p>
          <p className="text-xs mt-2">Click LOAD to fetch forecast data</p>
        </div>
      </div>
    );
  }

  const points = data.dataPoints.map((point, i) => ({
    ...point,
    block: i + 1
  }));

  if (points.length === 0) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <div className="text-center text-muted-foreground">
          <BarChart3 className="w-12 h-12 mx-auto mb-2 opacity-50" />
          <p>No valid data points</p>
        </div>
      </div>
    );
  }

  const yAxis = buildYAxisConfig(points.map(p => p.forecast));

  return (
    <div className="w-full h-full">
      <HoverablePlot
        data={[
          {
            x: points.map(p => p.block),
            y: points.map(p => Number(p.forecast || 0)),
            customdata: points.map(p => [p.time, p.forecastText || String(p.forecast ?? '')]),
            type: 'scatter',
            mode: 'lines',
            name: 'Forecast (MW)',
            line: { color: '#f59e0b', width: 2, shape: 'hv' },
            hovertemplate: 'Block %{x}<br>Time %{customdata[0]}<br>Power %{y:.3f} MW<extra>Forecast</extra>',
          }
        ]}
        layout={{
          margin: { l: 50, r: 20, t: 20, b: 40 },
          paper_bgcolor: 'rgba(0,0,0,0)',
          plot_bgcolor: 'rgba(0,0,0,0)',
          font: { color: '#cbd5e1', size: 11 },
          hoverlabel: {
            bgcolor: '#ffffff',
            bordercolor: '#111827',
            font: { color: '#000000', size: 12 }
          },
          xaxis: {
            title: 'Block',
            tickvals: points.length >= 96 ? [1, 24, 48, 72, 96] : [
              1,
              Math.ceil(points.length * 0.25),
              Math.ceil(points.length * 0.5),
              Math.ceil(points.length * 0.75),
              points.length
            ],
            gridcolor: 'rgba(148,163,184,0.2)',
            showspikes: true,
            spikemode: 'across',
            spikesnap: 'cursor',
            spikethickness: 1,
            spikedash: 'solid',
            spikecolor: 'rgba(226,232,240,0.55)',
          },
          yaxis: {
            title: 'Power (MW)',
            gridcolor: 'rgba(148,163,184,0.2)',
            range: yAxis.range,
            tickmode: 'array',
            tickvals: yAxis.tickvals
          },
          hovermode: 'x unified',
          hoverdistance: 30,
          spikedistance: -1,
          legend: { orientation: 'h', x: 0, y: 1.1 }
        }}
        config={{ displayModeBar: false, responsive: true }}
        style={{ width: '100%', height: '100%' }}
        useResizeHandler
      />
    </div>
  );
}

// Meter Chart Component - Plotly
function MeterChart({ data, capacityMw }) {
  if (!data) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <div className="text-center">
          <LoadingSpinner />
          <p className="text-sm text-muted-foreground mt-2">Loading chart data...</p>
        </div>
      </div>
    );
  }

  if (!data?.dataPoints || !Array.isArray(data.dataPoints) || data.dataPoints.length === 0) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <div className="text-center text-muted-foreground">
          <BarChart3 className="w-12 h-12 mx-auto mb-2 opacity-50" />
          <p>No meter data available</p>
          <p className="text-xs mt-2">Click LOAD to fetch meter data</p>
        </div>
      </div>
    );
  }

  const points = data.dataPoints.map((point, i) => ({
    ...point,
    block: i + 1
  }));

  if (points.length === 0) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <div className="text-center text-muted-foreground">
          <BarChart3 className="w-12 h-12 mx-auto mb-2 opacity-50" />
          <p>No valid data points</p>
        </div>
      </div>
    );
  }

  const yAxis = buildYAxisConfig(points.map(p => p.generation));

  return (
    <div className="w-full h-full">
      <HoverablePlot
        data={[
          {
            x: points.map(p => p.block),
            y: points.map(p => Number(p.generation || 0)),
            customdata: points.map(p => p.time),
            type: 'scatter',
            mode: 'lines',
            name: 'Generation (MW)',
            line: { color: '#ef4444', width: 2, shape: 'hv' },
            connectgaps: true,
            hovertemplate: 'Block %{x}<br>Time %{customdata}<br>Power %{y:.3f} MW<extra>Generation</extra>',
          }
        ]}
        layout={{
          margin: { l: 50, r: 20, t: 20, b: 40 },
          paper_bgcolor: 'rgba(0,0,0,0)',
          plot_bgcolor: 'rgba(0,0,0,0)',
          font: { color: '#cbd5e1', size: 11 },
          hoverlabel: {
            bgcolor: '#ffffff',
            bordercolor: '#111827',
            font: { color: '#000000', size: 12 }
          },
          xaxis: {
            title: 'Block',
            tickvals: points.length >= 96 ? [1, 24, 48, 72, 96] : [
              1,
              Math.ceil(points.length * 0.25),
              Math.ceil(points.length * 0.5),
              Math.ceil(points.length * 0.75),
              points.length
            ],
            gridcolor: 'rgba(148,163,184,0.2)',
            showspikes: true,
            spikemode: 'across',
            spikesnap: 'cursor',
            spikethickness: 1,
            spikedash: 'solid',
            spikecolor: 'rgba(226,232,240,0.55)',
          },
          yaxis: {
            title: 'Power (MW)',
            gridcolor: 'rgba(148,163,184,0.2)',
            range: yAxis.range,
            tickmode: 'array',
            tickvals: yAxis.tickvals
          },
          hovermode: 'x unified',
          hoverdistance: 30,
          spikedistance: -1,
          legend: { orientation: 'h', x: 0, y: 1.1 }
        }}
        config={{ displayModeBar: false, responsive: true }}
        style={{ width: '100%', height: '100%' }}
        useResizeHandler
      />
    </div>
  );
}
function WeatherChart({ data, series = [{ key: 'temperature', label: 'Temperature (°C)', color: '#38bdf8' }] }) {
  if (!data?.dataPoints || data.dataPoints.length === 0) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <div className="text-center text-muted-foreground">
          <Cloud className="w-10 h-10 mx-auto mb-2 opacity-50" />
          <p>No weather data available</p>
        </div>
      </div>
    );
  }

  const points = data.dataPoints.map((point, i) => ({
    ...point,
    block: i + 1
  }));

  const tickIndexes = points.length >= 5
    ? [0, Math.floor(points.length * 0.25), Math.floor(points.length * 0.5), Math.floor(points.length * 0.75), points.length - 1]
    : points.map((_, i) => i);
  const tickPairs = tickIndexes
    .map(i => ({ index: i, point: points[i] }))
    .filter(item => Boolean(item.point));
  const tickvals = tickPairs.map(item => item.point.block);
  const ticktext = tickPairs.map(item => {
    const rawTime = item.point.time;
    const dt = parseDateValue(rawTime);
    if (dt) {
      return dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    }
    if (typeof rawTime === 'string' && rawTime.length >= 16) {
      return rawTime.slice(11, 16);
    }
    return `B${item.index + 1}`;
  });

  return (
    <div className="w-full h-full">
      <HoverablePlot
        data={series.map(s => ({
          x: points.map(p => p.block),
          y: points.map(p => Number(p[s.key] || 0)),
          type: 'scatter',
          mode: 'lines',
          name: s.label,
          line: { color: s.color, width: 2.5, shape: 'spline', smoothing: 0.4 },
          hovertemplate: `%{y}<extra>${s.label}</extra>`
        }))}
        layout={{
          margin: { l: 55, r: 20, t: 20, b: 45 },
          paper_bgcolor: 'rgba(0,0,0,0)',
          plot_bgcolor: 'rgba(0,0,0,0)',
          font: { color: '#cbd5e1', size: 11, family: 'Segoe UI, sans-serif' },
          hoverlabel: {
            bgcolor: '#ffffff',
            bordercolor: '#111827',
            font: { color: '#000000', size: 12 }
          },
          hovermode: 'x unified',
          hoverdistance: 30,
          spikedistance: -1,
          xaxis: {
            title: 'Time',
            tickvals,
            ticktext,
            gridcolor: 'rgba(148,163,184,0.2)',
            showspikes: true,
            spikemode: 'across',
            spikesnap: 'cursor',
            spikethickness: 1,
            spikedash: 'solid',
            spikecolor: 'rgba(226,232,240,0.55)',
          },
          yaxis: {
            title: 'Value',
            gridcolor: 'rgba(148,163,184,0.2)',
            zeroline: false
          },
          legend: {
            orientation: 'h',
            x: 0,
            y: 1.12,
            bgcolor: 'rgba(15,23,42,0.45)',
            bordercolor: 'rgba(148,163,184,0.2)',
            borderwidth: 1
          }
        }}
        config={{ displayModeBar: false, responsive: true }}
        style={{ width: '100%', height: '100%' }}
        useResizeHandler
      />
    </div>
  );
}

function getNumericSeries(values = []) {
  return values
    .map((v) => (Number.isFinite(Number(v)) ? Number(v) : null))
    .filter((v) => v !== null);
}

function niceStep(rawStep) {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
  const exponent = Math.floor(Math.log10(rawStep));
  const fraction = rawStep / Math.pow(10, exponent);
  let niceFraction = 1;
  if (fraction <= 1) niceFraction = 1;
  else if (fraction <= 2) niceFraction = 2;
  else if (fraction <= 2.5) niceFraction = 2.5;
  else if (fraction <= 5) niceFraction = 5;
  else niceFraction = 10;
  return niceFraction * Math.pow(10, exponent);
}

function buildYAxisConfig(values, { headroomPct = 0.15, targetTicks = 5 } = {}) {
  const nums = getNumericSeries(values);
  const maxValue = nums.length ? Math.max(...nums) : 0;
  const safeMax = Math.max(0, maxValue);
  const paddedMax = safeMax + safeMax * headroomPct;
  const baseMax = paddedMax > 0 ? paddedMax : 1;
  const step = niceStep(baseMax / targetTicks);
  const top = Math.max(step, Math.ceil(baseMax / step) * step);
  const tickvals = [];
  for (let v = 0; v <= top + step * 0.5; v += step) {
    tickvals.push(Number(v.toFixed(6)));
  }
  return {
    range: [0, top],
    tickvals,
  };
}











