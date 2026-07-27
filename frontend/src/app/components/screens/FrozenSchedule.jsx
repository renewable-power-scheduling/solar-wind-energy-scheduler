import { useMemo, useState, useEffect } from 'react';
import { Upload, Download, Snowflake, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { api, scheduleReadinessApi } from '@/services/api';
import { useApi } from '@/hooks/useApi';
import { parseBlockFromTimestamp } from '@/utils/meterTime';
import { downloadCsvText, downloadXlsxFromSheets } from '@/app/components/common/downloadUtils';
import { S3_BASE_URL } from '@/config/appConfig';
import {
  buildFrozenSchedule,
  normalizeIntraday as normalizeIntradayShared,
  getSubmitBlockFromTimestamp,
  getEffectiveStartBlock,
} from '@/shared/freezeRules';
import { getTemplateScheduledMwPreferredColumns } from '@/shared/scheduleColumnPreferences';
import { DSM_PENALTY_CONFIG_BY_STATE, DEFAULT_DSM_PENALTY_CONFIG } from '@/config/dsmPenaltyConfig';
import { useAuth } from '@/app/appContexts';
import { filterPlantsForUser } from '@/utils/plantAccess';
import { resolveMeterMwFactor } from '@/utils/meterUnit';

const TOTAL_BLOCKS = 96;
const BLOCK_MINUTES = 15;
const DAY_AHEAD_SUFFIX = /_DA0\.csv$/i;
const PLANT_CAPACITY_FALLBACK = {
  BHUPALPALLY: 10,
  CME: 5,
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
  ZETRIC: 25,
  ANJANGAON: 7.5,
};
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
  ZETRIC: 'Maharashtra',
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
  ZETRIC: 'Solar',
  ANJANGAON: 'Solar',
};

const pad2 = (value) => String(value).padStart(2, '0');

function parseDateKeyParts(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const ymd = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (ymd) {
    return {
      year: Number.parseInt(ymd[1], 10),
      month: Number.parseInt(ymd[2], 10),
      day: Number.parseInt(ymd[3], 10),
    };
  }

  const dmy = raw.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dmy) {
    return {
      year: Number.parseInt(dmy[3], 10),
      month: Number.parseInt(dmy[2], 10),
      day: Number.parseInt(dmy[1], 10),
    };
  }

  return null;
}

function toUtcDateKey(value) {
  const raw = String(value || '').trim();
  const parts = parseDateKeyParts(raw);
  if (!parts) return raw;

  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (Number.isNaN(date.getTime())) return raw;

  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function addDaysToDateKey(dateString, days) {
  const raw = String(dateString || '').trim();
  const parts = parseDateKeyParts(raw);
  if (!parts) return raw;

  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (Number.isNaN(date.getTime())) return raw;

  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

const getPrevDateKey = (dateString) => addDaysToDateKey(dateString, -1);

const getLocalTodayDateKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
};

const toLocalDateKeyFromTimestamp = (value) => {
  const ts = Date.parse(String(value || ''));
  if (Number.isNaN(ts)) return '';
  const dt = new Date(ts);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
};
const HARDCODED_PLANTS = [
  { id: 1, name: 'Globus Steel N Power (GSNP)', capacity: 20.0, state: 'Madhya Pradesh', type: 'Solar' },
  { id: 2, name: 'SIRMOUR', capacity: 5.1, state: 'Madhya Pradesh', type: 'Solar' },
  { id: 3, name: 'CME', capacity: 5.0, state: 'MH', type: 'Solar' },
  { id: 4, name: 'BHUPALPALLY', capacity: 10.0, state: 'TL', type: 'Solar' },
  { id: 5, name: 'KASIPET', capacity: 15.0, state: 'TL', type: 'Solar' },
  { id: 6, name: 'KOTHAGUDEM', capacity: 37.0, state: 'TL', type: 'Solar' },
  { id: 7, name: 'KILAJ', capacity: 20.0, state: 'MH', type: 'Solar' },
  { id: 8, name: 'OSEL', capacity: 20.0, state: 'MH', type: 'Solar' },
  { id: 9, name: 'ANJANGAON', capacity: 7.5, state: 'Madhya Pradesh', type: 'Solar' },
  { id: 10, name: 'BAMKHAL', capacity: 5.0, state: 'Madhya Pradesh', type: 'Solar' },
  { id: 11, name: 'ANDAD', capacity: 7.5, state: 'Madhya Pradesh', type: 'Solar' },
  { id: 12, name: 'GUGARIYAKHEDI', capacity: 7.5, state: 'Madhya Pradesh', type: 'Solar' },
  { id: 13, name: 'BALAKWADA', capacity: 7.5, state: 'Madhya Pradesh', type: 'Solar' },
  { id: 14, name: 'NANDGAON', capacity: 7.5, state: 'Madhya Pradesh', type: 'Solar' },
  { id: 15, name: 'ZETRIC', code: 'ZETRIC', capacity: 25.0, state: 'Maharashtra', type: 'Solar' },
];

function normalizeFrozenPlantCode(value) {
  const code = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (code === 'OSEL') return 'OSEPL';
  if (code === 'ZETRICSOLARPARK') return 'ZETRIC';
  return code;
}

function getFrozenPlantCodeKey(plant) {
  const explicit = normalizeFrozenPlantCode(plant?.code || plant?.plant_code || plant?.plantCode);
  if (explicit) return explicit;
  const name = String(plant?.name || '').trim();
  const paren = name.match(/\(([A-Za-z0-9_-]+)\)/);
  if (paren?.[1]) return normalizeFrozenPlantCode(paren[1]);
  return normalizeFrozenPlantCode(name);
}

const toNumber = (value) => {
  const parsed = Number.parseFloat(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
};

function blockToTime(block) {
  const idx = Math.max(0, parseInt(block, 10) - 1);
  const startMinutes = idx * BLOCK_MINUTES;
  const endMinutes = startMinutes + BLOCK_MINUTES;
  const formatTime = (mins) => {
    const hh = Math.floor(mins / 60);
    const mm = mins % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };
  return `${formatTime(startMinutes)}-${formatTime(endMinutes)}`;
}

function blockToStartTime(block) {
  const idx = Math.max(0, parseInt(block, 10) - 1);
  const startMinutes = idx * BLOCK_MINUTES;
  const processingLag = 8; // minutes lambda takes to process
  const totalMinutes = (startMinutes + processingLag) % (24 * 60);
  const hh = Math.floor(totalMinutes / 60);
  const mm = totalMinutes % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function formatUiTime(value) {
  const text = String(value || '').trim();
  if (!text) return '--';

  const parsedDate = Date.parse(text);
  if (!Number.isNaN(parsedDate)) {
    return new Date(parsedDate).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).toLowerCase();
  }

  const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (match) {
    const hour24 = Number.parseInt(match[1], 10);
    const minute = match[2];
    if (Number.isFinite(hour24) && hour24 >= 0 && hour24 <= 23) {
      const ampm = hour24 >= 12 ? 'pm' : 'am';
      const hour12 = ((hour24 + 11) % 12) + 1;
      return `${hour12}:${minute} ${ampm}`;
    }
  }

  return text;
}

function parseCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return { headers: [], rows: [] };
  const parseLine = (line) => {
    const out = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"') {
        const peek = line[i + 1];
        if (inQuotes && peek === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        out.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    out.push(current);
    return out.map((c) => c.trim());
  };
  const headers = parseLine(lines[0]).map((h) => h.replace(/^\uFEFF/, '').trim());
  const rows = lines.slice(1).map(parseLine);
  return { headers, rows };
}

function parseCsvWithHeaderDetection(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim() !== '');
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

  let start = 0;
  let best = { idx: 0, score: -1 };
  const scanLimit = Math.min(lines.length, 25);
  for (let i = 0; i < scanLimit; i += 1) {
    const score = scoreHeaderLine(lines[i]);
    if (score > best.score) best = { idx: i, score };
  }
  if (best.score >= 0) start = best.idx;

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

async function listS3Objects(prefix) {
  try {
    const proxyResp = await fetch('/api/s3/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [prefix], limit: 5000 }),
    });
    if (!proxyResp.ok) throw new Error(`S3 proxy list failed: ${proxyResp.status}`);
    const payload = await proxyResp.json();
    return (payload?.items || [])
      .map(it => ({
        key: String(it?.key || '').trim(),
        lastModified: String(it?.last_modified || it?.lastModified || '').trim(),
      }))
      .filter((it) => it.key);
  } catch {
    return [];
  }
}

async function listS3ObjectsAcrossPrefixes(prefixes) {
  const safePrefixes = (prefixes || []).filter(Boolean);
  const settled = await Promise.allSettled(safePrefixes.map((prefix) => listS3Objects(prefix)));
  return settled
    .filter((result) => result.status === 'fulfilled')
    .flatMap((result) => result.value || []);
}

async function fetchS3TextByKey(key) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return '';
  try {
    const proxyResp = await fetch(`/api/s3/text?key=${encodeURIComponent(normalizedKey)}`);
    if (proxyResp.ok) return await proxyResp.text();
  } catch {
    // fall through to direct fetch fallback
  }
  try {
    const directUrl = `${S3_BASE_URL}/${normalizedKey.split('/').map(encodeURIComponent).join('/')}`;
    const directResp = await fetch(directUrl);
    if (directResp.ok) return await directResp.text();
  } catch {
    // ignore
  }
  return '';
}

function sortLatestFirst(items) {
  return [...(items || [])].sort((a, b) => {
    const aTime = Date.parse(a?.lastModified || a?.uploadedAt || '');
    const bTime = Date.parse(b?.lastModified || b?.uploadedAt || '');
    const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
    if (timeDiff !== 0) return timeDiff;
    return String(b?.key || b?.name || '').localeCompare(String(a?.key || a?.name || ''));
  });
}

function formatDateTime(value) {
  const ts = Date.parse(String(value || ''));
  return Number.isNaN(ts) ? '--' : new Date(ts).toLocaleString();
}

function normalizeStateLabel(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'tl' || raw === 'telangana') return 'Telangana';
  if (raw === 'mh' || raw === 'maharashtra') return 'Maharashtra';
  if (raw === 'madhyapradesh' || raw === 'madhya pradesh' || raw === 'mp') return 'Madhya Pradesh';
  return String(value || '').trim();
}

function getFrozenArtifactMeta(fileName) {
  const lower = String(fileName || '').toLowerCase();
  if (lower.includes('system_frozen')) {
    return { type: 'system', label: 'System Frozen' };
  }
  if (lower.includes('enercast') && lower.includes('frozen')) {
    return { type: 'enercast', label: 'Enercast Frozen' };
  }
  if (lower.includes('edited_frozen')) {
    return { type: 'edited', label: 'Edited Frozen' };
  }
  return { type: 'other', label: 'Other Frozen File' };
}

function isPreviewableFrozenScheduleKey(key) {
  const lower = String(key || '').toLowerCase();
  if (!lower) return false;
  if (lower.endsWith('.log')) return false;
  return lower.endsWith('.csv') || lower.endsWith('.json');
}

function parseFrozenKeyMeta(key, plantOptions = []) {
  const parts = String(key || '').split('/').filter(Boolean);
  const plantCodeFromKey = buildPlantCode(parts[2] || '');
  const dateValue = parts[3] || '';
  const fileName = parts[4] || key;
  const aliases = new Set(getPlantCodeAliases(plantCodeFromKey));
  const matchedPlant = plantOptions.find((plant) => {
    const plantCode = derivePlantCodeFromName(plant?.name || '') || buildPlantCode(plant?.name || '');
    return aliases.has(plantCode);
  });
  const artifact = getFrozenArtifactMeta(fileName);
  return {
    plantCode: plantCodeFromKey,
    plantName: matchedPlant?.name || plantCodeFromKey || '--',
    state: normalizeStateLabel(matchedPlant?.state || PLANT_STATE_FALLBACK[plantCodeFromKey] || ''),
    scheduleDate: dateValue,
    fileName,
    artifactType: artifact.type,
    artifactLabel: artifact.label,
  };
}

function buildCsvTextFromTable(headers = [], rows = []) {
  const escapeCell = (value) => {
    const text = String(value ?? '');
    if (!text) return '';
    if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  };
  return [headers, ...rows]
    .map((row) => (row || []).map(escapeCell).join(','))
    .join('\n');
}

function buildStructuredRowsFromRawText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line, index) => [index + 1, line]);
}

async function prepareFrozenFilePayload(file) {
  const key = String(file?.key || '').trim();
  if (!key) throw new Error('File key missing');
  const text = await fetchS3TextByKey(key);
  if (!text) throw new Error('Preview content not found');
  const lowerKey = key.toLowerCase();
  const isJsonLike = lowerKey.endsWith('.json');

  if (isJsonLike) {
    let pretty = text;
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      pretty = text;
    }
    return {
      ...file,
      key,
      text: pretty,
      headers: ['Line', 'Content'],
      rows: buildStructuredRowsFromRawText(pretty),
      isStructured: false,
    };
  }

  const parsed = parseCsvWithHeaderDetection(text);
  return {
    ...file,
    key,
    text,
    headers: parsed.headers || [],
    rows: parsed.rows || [],
    isStructured: Array.isArray(parsed.headers) && parsed.headers.length > 0,
  };
}

async function downloadFrozenFileAs(file, format = 'csv') {
  const payload = await prepareFrozenFilePayload(file);
  const baseName = String(payload?.name || 'frozen_file').replace(/\.[^.]+$/, '');
  const rows = payload.isStructured ? payload.rows : buildStructuredRowsFromRawText(payload.text);
  const headers = payload.isStructured ? payload.headers : ['Line', 'Content'];

  if (format === 'xlsx') {
    await downloadXlsxFromSheets(
      [{ name: 'Frozen File', headers, rows }],
      `${baseName}_${format}`
    );
    return;
  }

  downloadCsvText(buildCsvTextFromTable(headers, rows), `${baseName}_${format}`);
}

function pickFirstCsv(objects, preferDa0 = false) {
  const csvs = objects.filter((o) => o.key.toLowerCase().endsWith('.csv'));
  if (!csvs.length) return null;
  const sortLatestFirst = (items) => [...items].sort((a, b) => {
    const aTime = Date.parse(a.lastModified || '');
    const bTime = Date.parse(b.lastModified || '');
    const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
    if (timeDiff !== 0) return timeDiff;
    return String(b.key || '').localeCompare(String(a.key || ''));
  });
  if (preferDa0) {
    const da0 = sortLatestFirst(csvs.filter((o) => DAY_AHEAD_SUFFIX.test(o.key)))[0];
    if (da0) return da0;
  }
  return sortLatestFirst(csvs)[0];
}

function buildPlantCode(plantName) {
  const text = String(plantName || '').trim();
  if (!text) return '';
  const compact = text.replace(/[^A-Za-z0-9]/g, '');
  const code = compact.toUpperCase();
  if (code === 'ANJANGOAN') return 'ANJANGAON';
  return code === 'OSEL' ? 'OSEPL' : code;
}

function getFrozenSchedulePrefixes(code, dateValue) {
  const normalizedCode = String(code || '').trim().toUpperCase();
  const dateKey = String(dateValue || '').trim();
  if (!normalizedCode || !dateKey) return [];
  const prefixes = [`frozenschedules/vedanjay/${normalizedCode}/${dateKey}/`];
  if (normalizedCode === 'ANJANGAON') {
    prefixes.push(`frozenschedules/vedanjay/ANJANGOAN/${dateKey}/`);
  } else if (normalizedCode === 'ANJANGOAN') {
    prefixes.push(`frozenschedules/vedanjay/ANJANGAON/${dateKey}/`);
  }
  return Array.from(new Set(prefixes));
}

function derivePlantCodeFromName(name) {
  const text = String(name || '').trim();
  if (!text) return null;
  const match = text.match(/\(([A-Za-z0-9_-]+)\)/);
  if (match) {
    const code = match[1].toUpperCase();
    if (code === 'ANJANGOAN') return 'ANJANGAON';
    return code === 'OSEL' ? 'OSEPL' : code;
  }
  if (/^[A-Z0-9_-]{2,6}$/.test(text)) {
    const code = text.toUpperCase();
    if (code === 'ANJANGOAN') return 'ANJANGAON';
    return code === 'OSEL' ? 'OSEPL' : code;
  }
  const compact = text.replace(/[^A-Za-z0-9]/g, '');
  if (!compact) return null;
  const code = compact.toUpperCase();
  if (code === 'ANJANGOAN') return 'ANJANGAON';
  return code === 'OSEL' ? 'OSEPL' : code;
}

function getPlantCodeAliases(code) {
  const normalized = buildPlantCode(code);
  if (normalized === 'ANJANGAON') return ['ANJANGAON', 'ANJANGOAN'];
  return normalized ? [normalized] : [];
}

function buildSchedulePrefixes(date, code) {
  const upper = String(code || '').toUpperCase();
  if (upper === 'ZETRIC') {
    return [
      `generated/vedanjay/multiple_generator/ZTRIC/${date}/`,
      `raw/vedanjay/multiple_generator/ZTRIC/${date}/`,
    ];
  }
  const prefixes = [
    `generated/vedanjay/${upper}/outputs/${date}/`,
    `raw/vedanjay/${upper}/${date}/`,
  ];
  if (upper === 'ANJANGAON') {
    prefixes.push(`raw/vedanjay/ANJANGOAN/${date}/`);
  }
  if (upper === 'GSNP') {
    prefixes.push(`raw/GSNP/gsnp/${date}/`, `generated/GSNP/gsnp/outputs/${date}/`);
  }
  if (upper === 'SIRMOUR') {
    prefixes.push(`raw/Sirmour/sirmour/${date}/`, `generated/Sirmour/sirmour/outputs/${date}/`);
  }
  return Array.from(new Set(prefixes));
}

function buildDayAheadPrefixes(dayAheadDate, code) {
  const upper = String(code || '').toUpperCase();
  if (upper === 'ZETRIC') {
    return [
      `generated/vedanjay/multiple_generator/ZTRIC/${dayAheadDate}/`,
      `raw/vedanjay/multiple_generator/ZTRIC/${dayAheadDate}/enercast_data/day_ahead/`,
    ];
  }
  const prefixes = [];
  const folderVariants = ['Day-ahead', 'day-ahead', 'dayahead', 'day_ahead'];
  for (const folder of folderVariants) {
    prefixes.push(`generated/vedanjay/${upper}/outputs/${dayAheadDate}/${folder}/`);
    if (upper === 'ANJANGAON') {
      prefixes.push(`generated/vedanjay/ANJANGOAN/outputs/${dayAheadDate}/${folder}/`);
    }
    if (upper === 'GSNP') {
      prefixes.push(`generated/GSNP/gsnp/outputs/${dayAheadDate}/${folder}/`);
    }
    if (upper === 'SIRMOUR') {
      prefixes.push(`generated/Sirmour/sirmour/outputs/${dayAheadDate}/${folder}/`);
    }
  }
  return Array.from(new Set(prefixes));
}

function buildMeterPrefixes(date, code) {
  const upper = String(code || '').toUpperCase();
  if (upper === 'ZETRIC') {
    return [`raw/vedanjay/multiple_generator/ZTRIC/${date}/metered_data/`];
  }
  const prefixes = [
    `raw/vedanjay/${upper}/${date}/metered_data/`,
    `generated/vedanjay/${upper}/outputs/${date}/meter/`,
  ];
  if (upper === 'ANJANGAON') {
    prefixes.push(`raw/vedanjay/ANJANGOAN/${date}/metered_data/`);
  }
  if (upper === 'GSNP') {
    prefixes.push(`raw/GSNP/gsnp/${date}/metered_data/`, `generated/GSNP/gsnp/outputs/${date}/meter/`);
  }
  if (upper === 'SIRMOUR') {
    prefixes.push(`raw/Sirmour/sirmour/${date}/metered_data/`, `generated/Sirmour/sirmour/outputs/${date}/meter/`);
  }
  return Array.from(new Set(prefixes));
}

function normalizeHeaderToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function parseScheduleCsv(text, options = {}) {
  const { headers, rows } = parseCsvWithHeaderDetection(text);
  if (!headers.length) return [];
  const normalized = headers.map((h) => h.toLowerCase().replace(/\s+/g, ''));
  const preferredColumns = (options.preferredColumns || []).filter(Boolean);
  const preferredIdx = preferredColumns.length
    ? normalized.findIndex((h, idx) => {
      const headerToken = normalizeHeaderToken(headers[idx]);
      return preferredColumns.some((col) => {
        const prefToken = normalizeHeaderToken(col);
        if (!prefToken || !headerToken) return false;
        return (
          prefToken === headerToken ||
          headerToken.includes(prefToken) ||
          prefToken.includes(headerToken)
        );
      });
    })
    : -1;
  const blockIdx = normalized.findIndex((h) => h.includes('block'));
  // Prefer "to/end" time column over "from" to avoid off-by-one when timestamps mark block start.
  const timeIdx = (() => {
    const timeCols = normalized
      .map((h, idx) => ({ h, idx }))
      .filter(({ h }) => h.includes('time'));
    if (!timeCols.length) return -1;
    const endLike = timeCols.find(({ h }) =>
      h.includes('totime') ||
      h.includes('endtime') ||
      /\bto\b/.test(h) ||
      h.endsWith('to') ||
      h.endsWith('end')
    );
    if (endLike) return endLike.idx;
    // If both from/to exist, the "to" column typically comes second, so pick the last time column.
    return timeCols[timeCols.length - 1].idx;
  })();
  const scheduledIdx = normalized.findIndex(
    (h) =>
      (h.includes('scheduled') || h.includes('schedule') || h.includes('sch_mw') || h.includes('schmw')) &&
      !h.includes('forecast') &&
      !h.includes('actual')
  );
  const mwIdx = normalized.findIndex(
    (h) =>
      (h.includes('mw') || h.includes('power')) &&
      !h.includes('forecast') &&
      !h.includes('actual') &&
      !h.includes('meter')
  );
  const valueIdx = preferredIdx !== -1
    ? preferredIdx
    : scheduledIdx !== -1
      ? scheduledIdx
      : mwIdx !== -1
        ? mwIdx
        : 2;

  const isStartTimeOnly =
    timeIdx !== -1 &&
    normalized[timeIdx].includes('from') &&
    !normalized.some((h) => h.includes('to'));

  return rows
    .map((cols, idx) => {
      const blockRaw = blockIdx !== -1 ? cols[blockIdx] : '';
      const timeRaw = timeIdx !== -1 ? cols[timeIdx] : '';
      let block = Number.parseInt(String(blockRaw || '').trim(), 10);
      if (!Number.isFinite(block)) {
        const fromTime = parseBlockFromTimestamp(timeRaw, { totalBlocks: TOTAL_BLOCKS });
        if (Number.isFinite(fromTime)) {
          // When we only have the start time column, shift by +1 because parseBlockFromTimestamp
          // treats the timestamp as the END of the block.
          block = isStartTimeOnly ? Math.min(fromTime + 1, TOTAL_BLOCKS) : fromTime;
        }
      }
      if (!Number.isFinite(block)) block = idx + 1;
      const scheduledMw = toNumber(cols[valueIdx]);
      return Number.isFinite(block)
        ? { block, time: blockToTime(block), scheduledMw }
        : null;
    })
    .filter(Boolean);
}

function parseActualCsv(text, options = {}) {
  const { headers, rows } = parseCsvWithHeaderDetection(text);
  if (!headers.length) return [];
  const normalizedHeaders = headers.map((h) => String(h || '').toLowerCase().trim());
  const compactHeaders = headers.map((h) =>
    String(h || '')
      .toLowerCase()
      .replace(/["']/g, '')
      .replace(/[^a-z0-9]+/g, '')
  );

  const blockIdx = compactHeaders.findIndex((h) =>
    h === 'block' || h === 'blk' || h === 'blockno' || h === 'blocknumber'
  );
  const endIdx = normalizedHeaders.findIndex((h) => h.includes('end'));
  const startIdx = normalizedHeaders.findIndex((h) => h.includes('start'));
  const timeIdx = endIdx !== -1
    ? endIdx
    : (startIdx !== -1
      ? startIdx
      : compactHeaders.findIndex((h) =>
          h.includes('time') || h.includes('timestamp') || h.includes('datetime')
        ));
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
  if (powerIdx === -1) {
    const ignored = (h) => h.includes('time') || h.includes('date') || h.includes('block');
    let best = { idx: -1, score: -1 };
    const sample = rows.slice(0, Math.min(rows.length, 192));
    for (let col = 0; col < headers.length; col += 1) {
      if (ignored(normalizedHeaders[col] || '')) continue;
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
  if (powerIdx === -1) return [];

  const getBlockFromTimeText = (raw) => {
    const text = String(raw ?? '').trim();
    if (!text) return null;
    // If the time column contains a range like "07:45-08:00",
    // use the END time to map to the correct block.
    const rangeMatch = text.match(/(\d{1,2}:\d{2})(?:\s*[-–]\s*)(\d{1,2}:\d{2})/);
    if (rangeMatch) {
      return parseBlockFromTimestamp(rangeMatch[2], { totalBlocks: 96 });
    }
    return parseBlockFromTimestamp(text, { totalBlocks: 96 });
  };

  const powerHeader = (normalizedHeaders[powerIdx] || '').trim();
  const explicitKw = powerHeader.includes('(kw)') || powerHeader.includes(' kw') || powerHeader === 'kw';
  const explicitMw =
    powerHeader.includes('(mw)') ||
    powerHeader.includes(' mw') ||
    powerHeader === 'mw' ||
    powerHeader.endsWith('mw');

  const isStartOnly = timeIdx === startIdx && endIdx === -1;
  const parsed = rows
    .map((cols, idx) => {
      const blockFromCol = blockIdx !== -1 ? parseInt(cols[blockIdx], 10) : null;
      const timeRaw = timeIdx !== -1 ? cols[timeIdx] : null;
      const hasTimeColumn = timeIdx !== -1;
      const blockFromTime = hasTimeColumn ? getBlockFromTimeText(timeRaw) : null;
      const adjustedBlockFromTime = (Number.isFinite(blockFromTime) && isStartOnly)
        ? Math.min(blockFromTime + 1, TOTAL_BLOCKS)
        : blockFromTime;
      let block = null;
      if (Number.isFinite(blockFromCol) && blockFromCol >= 1 && blockFromCol <= 96) {
        block = blockFromCol;
      } else if (Number.isFinite(adjustedBlockFromTime)) {
        block = adjustedBlockFromTime;
      } else if (!hasTimeColumn) {
        const fallbackBlock = idx + 1;
        if (fallbackBlock >= 1 && fallbackBlock <= 96) block = fallbackBlock;
      }
      const power = parseFloat(String(cols[powerIdx] ?? '').replace(/,/g, '').trim());
      if (!Number.isFinite(block) || block < 1 || block > 96 || !Number.isFinite(power)) return null;
      return { block, generationMw: power };
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
  parsed.forEach((row) => deduped.set(row.block, { block: row.block, actualMw: row.generationMw * factor }));
  return Array.from(deduped.values()).sort((a, b) => a.block - b.block);
}

function deriveEndingBlockFromName(name) {
  const match = String(name || '').match(/schedule_from_(\d+)\.csv$/i);
  if (!match) return null;
  const block = Number.parseInt(match[1], 10);
  return Number.isFinite(block) ? block : null;
}

function resolveTimelineStatus(item, autoFreezeByBlock = {}) {
  const block = Number.isFinite(item?.generatedBlock) ? Number(item.generatedBlock) : null;
  const autoEntry = Number.isFinite(block) ? autoFreezeByBlock?.[block] : null;
  if (autoEntry?.status) {
    return autoEntry.reason ? `${autoEntry.status} (${autoEntry.reason})` : autoEntry.status;
  }
  return item?.status || 'Pending';
}

function summarizeStatus(statusText) {
  const lowered = String(statusText || '').toLowerCase();
  if (lowered.includes('discard')) return 'Discarded';
  if (lowered.includes('upload') || lowered.includes('frozen')) return 'Uploaded';
  return 'Pending';
}

export function FrozenSchedule() {
  const { user: currentUser } = useAuth();
  const [selectedDate, setSelectedDate] = useState(() => getLocalTodayDateKey());
  const [dayAheadFile, setDayAheadFile] = useState(null);
  const [dayAheadRows, setDayAheadRows] = useState([]);
  const [intradayFiles, setIntradayFiles] = useState([]);
  const [actualFile, setActualFile] = useState(null);
  const [actualRows, setActualRows] = useState([]);
  const [s3DayAheadKey, setS3DayAheadKey] = useState('');
  const [s3MeterKey, setS3MeterKey] = useState('');
  const [meterOptions, setMeterOptions] = useState([]);
  const [selectedMeterKey, setSelectedMeterKey] = useState('');
  const [availableDayAheadFiles, setAvailableDayAheadFiles] = useState([]);
  const [availableFrozenFiles, setAvailableFrozenFiles] = useState([]);
  const [previewFile, setPreviewFile] = useState(null);
  const [selectedStateFilter, setSelectedStateFilter] = useState('');
  const [selectedArtifactFilter, setSelectedArtifactFilter] = useState('all');
  const [selectedFrozenFileKey, setSelectedFrozenFileKey] = useState('');
  const [selectedPlantId, setSelectedPlantId] = useState('');
  const [manualCapacity, setManualCapacity] = useState('');
  const [manualState, setManualState] = useState('');
  const [manualType, setManualType] = useState('');
  const [resultRows, setResultRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [s3Loading, setS3Loading] = useState(false);
  const [autoFreezeByBlock, setAutoFreezeByBlock] = useState({});
  const [lastAutoFreeze, setLastAutoFreeze] = useState(null);

  const { data: apiPlantsData } = useApi(
    () => api.plants.getAll({}),
    { immediate: true, initialData: { plants: [], total: 0, stats: {} } }
  );

  const plantOptions = useMemo(() => {
    const apiPlants = Array.isArray(apiPlantsData?.plants) ? apiPlantsData.plants : [];
    const rawPlants = [...apiPlants, ...HARDCODED_PLANTS];
    const plants = filterPlantsForUser(rawPlants, currentUser);
    const byCode = new Map();
    plants.forEach((plant) => {
      const code = getFrozenPlantCodeKey(plant);
      if (!code || byCode.has(code)) return;
      byCode.set(code, plant);
    });
    return Array.from(byCode.values()).map((p) => {
      const code = getFrozenPlantCodeKey(p);
      return {
        id: p.id ?? code,
        code,
        name: p.name,
        capacity: p.capacity,
        state: p.state,
        type: p.type,
      };
    });
  }, [apiPlantsData, currentUser]);

  const stateOptions = useMemo(() => {
    const uniqueStates = Array.from(
      new Set(plantOptions.map((plant) => normalizeStateLabel(plant?.state)).filter(Boolean))
    );
    return uniqueStates.sort((a, b) => a.localeCompare(b));
  }, [plantOptions]);

  const filteredPlantOptions = useMemo(() => {
    if (!selectedStateFilter) return plantOptions;
    return plantOptions.filter((plant) => normalizeStateLabel(plant?.state) === selectedStateFilter);
  }, [plantOptions, selectedStateFilter]);

  const selectedPlant = useMemo(
    () => plantOptions.find((p) => String(p.id) === String(selectedPlantId)),
    [plantOptions, selectedPlantId]
  );

  const visibleFrozenFiles = useMemo(() => {
    return availableFrozenFiles.filter((file) => {
      if (selectedStateFilter && normalizeStateLabel(file?.state) !== selectedStateFilter) return false;
      if (selectedPlantId && String(file?.plantId || '') !== String(selectedPlantId)) return false;
      if (selectedArtifactFilter !== 'all' && String(file?.artifactType || '') !== selectedArtifactFilter) return false;
      return true;
    });
  }, [availableFrozenFiles, selectedStateFilter, selectedPlantId, selectedArtifactFilter]);

  const selectedFrozenFile = useMemo(() => {
    if (!selectedFrozenFileKey) return visibleFrozenFiles[0] || null;
    return visibleFrozenFiles.find((file) => file.key === selectedFrozenFileKey) || visibleFrozenFiles[0] || null;
  }, [visibleFrozenFiles, selectedFrozenFileKey]);

  useEffect(() => {
    if (visibleFrozenFiles.length === 0) {
      setSelectedFrozenFileKey('');
      setPreviewFile(null);
      return;
    }
    if (!selectedFrozenFileKey || !visibleFrozenFiles.some((file) => file.key === selectedFrozenFileKey)) {
      setSelectedFrozenFileKey(visibleFrozenFiles[0].key);
    }
  }, [visibleFrozenFiles, selectedFrozenFileKey]);

  useEffect(() => {
    if (!selectedFrozenFile) {
      setPreviewFile(null);
      return;
    }
    handlePreviewFile(selectedFrozenFile);
  }, [selectedFrozenFile]);

  const plantCode = derivePlantCodeFromName(selectedPlant?.name || '') || buildPlantCode(selectedPlant?.name || '');
  const plantCapacity =
    toNumber(manualCapacity) ??
    toNumber(selectedPlant?.capacity) ??
    PLANT_CAPACITY_FALLBACK[plantCode] ??
    0;
  const plantType = manualType || selectedPlant?.type || PLANT_TYPE_FALLBACK[plantCode] || 'Solar';
  const resolvedType = plantType || 'Solar';

  const normalizedIntraday = useMemo(() => {
    return normalizeIntradayShared(intradayFiles);
  }, [intradayFiles]);

  const timelineRows = useMemo(() => {
    if (normalizedIntraday.length > 0) return normalizedIntraday;
    const fallbackRows = Object.values(autoFreezeByBlock || {})
      .filter((entry) => Number.isFinite(entry?.block))
      .map((entry) => {
        const block = Number(entry.block);
        const sourceNameRaw = String(entry.sourceScheduleKey || '').trim();
        const sourceName = sourceNameRaw
          ? (sourceNameRaw.split('/').pop() || sourceNameRaw)
          : `schedule_from_${String(block).padStart(2, '0')}.csv`;
        const submitBlock = String(entry.status || '').toLowerCase() === 'uploaded'
          ? (getSubmitBlockFromTimestamp(entry.freezeTime) ?? block)
          : null;
        const effectiveBlock = Number.isFinite(submitBlock) ? getEffectiveStartBlock(submitBlock) : null;
        return {
          id: `auto-${block}-${entry.freezeTime || ''}`,
          name: sourceName,
          generatedBlock: block,
          submitBlock,
          effectiveBlock,
          status: entry.reason ? `${entry.status} (${entry.reason})` : (entry.status || '--'),
          freezeTime: entry.freezeTime || '',
          source: 'Auto-freeze log',
          readOnly: true,
        };
      })
      .sort((a, b) => (a.generatedBlock || TOTAL_BLOCKS + 1) - (b.generatedBlock || TOTAL_BLOCKS + 1));
    return fallbackRows;
  }, [normalizedIntraday, autoFreezeByBlock]);

  const handleActualUpload = async (file) => {
    try {
      const text = await file.text();
      const rows = parseActualCsv(text, {
        plantCode,
        plantName: selectedPlant?.name,
        sourceKey: file?.name,
      });
      if (!rows.length) {
        toast.error('Could not parse actual/meter file');
        return;
      }
      setActualFile(file);
      setActualRows(rows);
      toast.success('Actual/meter file loaded');
    } catch (error) {
      toast.error('Failed to read actual/meter file');
    }
  };

  const loadDayAheadByKey = async (key, inlineText = '', fileMeta = null) => {
    if (!key && !inlineText) return;
    const name = key ? key.split('/').pop() : 'day_ahead_uploaded.csv';
    const text = inlineText || await fetch(`${S3_BASE_URL}/${key.split('/').map(encodeURIComponent).join('/')}`).then((r) => r.text());
    const preferredColumns = getTemplateScheduledMwPreferredColumns(plantCode);
    const parsedDayAhead = parseScheduleCsv(text, { preferredColumns });
    setDayAheadRows(parsedDayAhead);
    setDayAheadFile((prev) => ({
      ...(prev || {}),
      name,
      key: key || (prev?.key || ''),
      source: fileMeta?.source || prev?.source || 'Uploaded Section',
      uploadedAt: fileMeta?.uploadedAt || fileMeta?.lastModified || prev?.uploadedAt || '',
      lastModified: fileMeta?.lastModified || fileMeta?.uploadedAt || prev?.lastModified || '',
    }));
    setS3DayAheadKey(key || '');
  };

  const loadMeterByKey = async (key) => {
    if (!key) return;
    const name = key.split('/').pop();
    const url = `${S3_BASE_URL}/${key.split('/').map(encodeURIComponent).join('/')}`;
    const text = await fetch(url).then((r) => r.text());
    const parsedMeter = parseActualCsv(text, {
      plantCode,
      plantName: selectedPlant?.name,
      sourceKey: key,
    });
    setActualRows(parsedMeter);
    setActualFile({ name, source: 's3' });
    setS3MeterKey(key);
  };

  const handlePreviewFile = async (file) => {
    try {
      const payload = await prepareFrozenFilePayload(file);
      setPreviewFile(payload);
    } catch (error) {
      toast.error(error?.message || 'Failed to preview file');
    }
  };

  const handleDownloadFileAs = async (file, format = 'csv') => {
    try {
      await downloadFrozenFileAs(file, format);
      toast.success(`Downloaded as ${String(format || '').toUpperCase()}`);
    } catch (error) {
      toast.error(error?.message || `Failed to download ${format}`);
    }
  };

  const loadAutoFreezeArtifacts = async (code, dateValue) => {
    const normalizedCode = String(code || '').trim().toUpperCase();

    // Canonical convention: frozenschedules/vedanjay/<PLANT>/<DATE>/<PLANT>_frozen.log
    // Avoid noisy 404s by listing first; only fetch if the object exists.
    try {
      if (normalizedCode && dateValue) {
        const frozenPrefixes = getFrozenSchedulePrefixes(normalizedCode, dateValue);
        const frozenObjects = await listS3ObjectsAcrossPrefixes(frozenPrefixes).catch(() => []);
        const expectedSuffixes = [
          `/${normalizedCode}_frozen.log`.toLowerCase(),
          normalizedCode === 'ANJANGAON' ? '/ANJANGOAN_frozen.log' : null,
          normalizedCode === 'ANJANGOAN' ? '/ANJANGAON_frozen.log' : null,
        ].filter(Boolean);
        const logKey = frozenObjects.find((o) =>
          expectedSuffixes.some((suffix) => String(o?.key || '').toLowerCase().endsWith(suffix))
        )?.key;

        if (logKey) {
          const text = await fetchS3TextByKey(logKey);
          const trimmed = String(text || '').trim();
          if (trimmed) {
            let payload = null;
            try {
              payload = JSON.parse(trimmed);
            } catch {
              payload = null;
            }

            const parsedBlock = Number.parseInt(String(payload?.block || ''), 10);
            const block = Number.isFinite(parsedBlock) ? parsedBlock : 1;
            const entry = {
              block,
              status: payload?.status || 'Unknown',
              reason: payload?.reason || '',
              freezeTime: payload?.freeze_time || payload?.created_at || '',
              sourceScheduleKey: payload?.source_schedule_key || '',
              summary: payload?.summary || null,
              logKey,
            };
            setAutoFreezeByBlock({ [block]: entry });
            setLastAutoFreeze(entry);
            return;
          }
        }
      }
    } catch {
      setAutoFreezeByBlock({});
      setLastAutoFreeze(null);
    }
  };

  useEffect(() => {
    if (!dayAheadRows.length) {
      setResultRows([]);
      setSummary(null);
      return;
    }

    const uploadedLayers = normalizedIntraday.filter((item) => String(item.status || '').startsWith('Uploaded'));
    try {
      const { rows, summary: computedSummary } = buildFrozenSchedule({
        dayAheadRows,
        intradayLayers: uploadedLayers,
        actualRows,
        plantCapacity,
        plantState: manualState || selectedPlant?.state || PLANT_STATE_FALLBACK[plantCode] || 'Telangana',
        plantType: manualType || selectedPlant?.type || PLANT_TYPE_FALLBACK[plantCode] || 'Solar',
        penaltyConfigByState: DSM_PENALTY_CONFIG_BY_STATE,
        defaultPenaltyConfig: DEFAULT_DSM_PENALTY_CONFIG,
        dayAheadSourceLabel: (s3DayAheadKey || '').split('/').pop() || '',
      });
      setResultRows(rows);
      setSummary(computedSummary);
    } catch {
      setResultRows([]);
      setSummary(null);
    }
  }, [
    dayAheadRows,
    normalizedIntraday,
    actualRows,
    plantCapacity,
    manualState,
    manualType,
    selectedPlant,
    plantCode,
  ]);

  useEffect(() => {
    if (selectedMeterKey) {
      loadMeterByKey(selectedMeterKey).catch(() => {
        toast.error('Failed to load selected meter file');
      });
    }
  }, [selectedMeterKey]);

  useEffect(() => {
    if (selectedPlantId && !filteredPlantOptions.some((plant) => String(plant.id) === String(selectedPlantId))) {
      setSelectedPlantId('');
    }
  }, [filteredPlantOptions, selectedPlantId]);

  const handleFetchFromS3 = async () => {
    if (!selectedDate) {
      toast.error('Select a date first');
      return;
    }

    setS3Loading(true);
    try {
      const candidatePlants = filteredPlantOptions.filter((plant) => {
        if (!selectedPlantId) return true;
        return String(plant.id) === String(selectedPlantId);
      });

      if (!candidatePlants.length) {
        throw new Error('No plants available for the selected filters');
      }

      const prefixes = Array.from(
        new Set(
          candidatePlants.flatMap((plant) => {
            const code = derivePlantCodeFromName(plant?.name || '') || buildPlantCode(plant?.name || '');
            return getFrozenSchedulePrefixes(code, selectedDate);
          })
        )
      );

      const frozenObjects = await listS3ObjectsAcrossPrefixes(prefixes);
      const frozenFileOptions = sortLatestFirst(
        (frozenObjects || [])
          .filter((o) => isPreviewableFrozenScheduleKey(o?.key))
          .map((o) => {
            const meta = parseFrozenKeyMeta(o.key, plantOptions);
            if (!['system', 'edited', 'enercast'].includes(meta.artifactType)) {
              return null;
            }
            const matchedPlant = plantOptions.find((plant) => {
              const code = derivePlantCodeFromName(plant?.name || '') || buildPlantCode(plant?.name || '');
              return getPlantCodeAliases(meta.plantCode).includes(code);
            });
            return {
              key: o.key,
              name: meta.fileName,
              uploadedAt: o.lastModified || '',
              lastModified: o.lastModified || '',
              source: 'Frozen Folder',
              plantCode: meta.plantCode,
              plantName: meta.plantName,
              plantId: matchedPlant?.id || '',
              state: meta.state,
              scheduleDate: meta.scheduleDate,
              artifactType: meta.artifactType,
              artifactLabel: meta.artifactLabel,
            };
          })
          .filter(Boolean)
      );

      setAvailableFrozenFiles(frozenFileOptions);
      setSelectedFrozenFileKey('');
      setAvailableDayAheadFiles([]);
      setDayAheadFile(null);
      setDayAheadRows([]);
      setIntradayFiles([]);
      setMeterOptions([]);
      setSelectedMeterKey('');
      setActualRows([]);
      setActualFile(null);
      setS3DayAheadKey('');
      setS3MeterKey('');
      setAutoFreezeByBlock({});
      setLastAutoFreeze(null);
      setResultRows([]);
      setSummary(null);

      toast.success(`${frozenFileOptions.length} frozen file(s) loaded`);
    } catch (error) {
      toast.error(error.message || 'Failed to load S3 data');
    } finally {
      setS3Loading(false);
    }
  };

  const buildCsvSection = (headers, rows) => {
    const escapeCell = (value) => {
      const text = String(value ?? '');
      if (!text) return '';
      if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
      return text;
    };
    const all = [headers, ...(rows || [])];
    return all.map((row) => (row || []).map(escapeCell).join(',')).join('\n');
  };

  const handleExport = async (format = 'csv') => {
    if (!resultRows.length) {
      toast.error('No auto-frozen schedule available');
      return;
    }

    const uploadedLayers = normalizedIntraday.filter((item) => String(item.status || '').startsWith('Uploaded'));
    const appliedHeaders = [
      'Type',
      'File Name',
      'Uploaded At',
      'Submit Time',
      'Effective Time',
      'Submit Block',
      'Effective Block',
      'Source',
    ];
    const appliedRows = [
      [
        'Day-Ahead (Baseline)',
        dayAheadFile?.name || (s3DayAheadKey || '').split('/').pop() || '',
        dayAheadFile?.uploadedAt || '',
        '',
        '',
        '',
        '',
        'Uploaded Section',
      ],
      ...uploadedLayers.map((layer) => [
        'Intraday',
        layer.name || '',
        layer.freezeTime || '',
        Number.isFinite(layer.submitBlock) ? blockToTime(layer.submitBlock) : '',
        Number.isFinite(layer.effectiveBlock) ? blockToTime(layer.effectiveBlock) : '',
        Number.isFinite(layer.submitBlock) ? layer.submitBlock : '',
        Number.isFinite(layer.effectiveBlock) ? layer.effectiveBlock : '',
        String(layer.source || 'Uploaded Section'),
      ]),
    ];

    const frozenHeaders = [
      'Block',
      'Time',
      'Scheduled MW',
      'Actual MW',
      'Deviation MW',
      'Deviation %',
      'Penalty Rs',
      'Source Schedule',
    ];
    const frozenRows = resultRows.map((r) => [
      r.block,
      r.time,
      r.scheduledMw?.toFixed?.(3) ?? r.scheduledMw ?? '',
      r.actualMw?.toFixed?.(3) ?? '',
      r.deviationMw?.toFixed?.(3) ?? '',
      Number.isFinite(r.deviationPct) ? r.deviationPct.toFixed(2) : '',
      r.penaltyRs?.toFixed?.(2) ?? '',
      r.source,
    ]);
    const plantLabel = buildPlantCode(selectedPlant?.name || 'plant');
    const dateLabel = toUtcDateKey(selectedDate) || getLocalTodayDateKey();
    const filenameBase = `${plantLabel}_${dateLabel}_frozen`;
    if (format === 'xlsx') {
      await downloadXlsxFromSheets(
        [
          { name: 'Frozen Schedule', headers: frozenHeaders, rows: frozenRows },
          { name: 'Applied Files', headers: appliedHeaders, rows: appliedRows },
        ],
        filenameBase
      );
      return;
    }
    const sections = [
      buildCsvSection(appliedHeaders, appliedRows),
      '',
      buildCsvSection(frozenHeaders, frozenRows),
    ];
    downloadCsvText(sections.join('\n'), filenameBase);
  };


  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Snowflake className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg sm:text-xl font-semibold text-foreground">Frozen Schedule</h2>
          <p className="text-xs sm:text-sm text-muted-foreground">
            Browse only frozen-folder artifacts by date, state, and plant with preview and export actions.
          </p>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
        <div className="grid gap-4 xl:grid-cols-[1.2fr_1.2fr_1fr_1fr_auto]">
          <div>
            <label className="mb-2 block text-xs font-medium text-muted-foreground">State</label>
            <select
              value={selectedStateFilter}
              onChange={(e) => setSelectedStateFilter(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="">All states</option>
              {stateOptions.map((state) => (
                <option key={state} value={state}>
                  {state}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-2 block text-xs font-medium text-muted-foreground">Plant</label>
            <select
              value={selectedPlantId}
              onChange={(e) => setSelectedPlantId(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="">All plants</option>
              {filteredPlantOptions.map((plant) => (
                <option key={plant.id} value={plant.id}>
                  {plant.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-2 block text-xs font-medium text-muted-foreground">Date</label>
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-2 block text-xs font-medium text-muted-foreground">File Type</label>
            <select
              value={selectedArtifactFilter}
              onChange={(e) => setSelectedArtifactFilter(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="all">All Schedule Files</option>
              <option value="system">System Frozen</option>
              <option value="edited">Edited Frozen</option>
              <option value="enercast">Enercast Frozen</option>
            </select>
          </div>
          <div className="flex items-end">
            <button
              onClick={handleFetchFromS3}
              disabled={s3Loading}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCw className={`h-4 w-4 ${s3Loading ? 'animate-spin' : ''}`} />
              {s3Loading ? 'Loading...' : 'Load Frozen Files'}
            </button>
          </div>
        </div>
      </div>
      <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Preview</h3>
            <p className="text-xs text-muted-foreground">
              {selectedFrozenFile
                ? `${selectedFrozenFile.artifactLabel} - ${selectedFrozenFile.name}`
                : 'No schedule file selected.'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => handleDownloadFileAs(previewFile, 'xlsx')}
            disabled={!previewFile?.key}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground transition hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            Download XLSX
          </button>
        </div>
        {previewFile ? (
          <div className="mt-4 overflow-hidden rounded-xl border border-border">
            <div className="border-b border-border bg-muted/30 px-4 py-3">
              <p className="font-medium text-foreground">{previewFile.name}</p>
              <p className="text-xs text-muted-foreground">{previewFile.key}</p>
            </div>
            <div className="max-h-[520px] overflow-auto">
              {previewFile.isStructured ? (
                <table className="min-w-full text-sm">
                  <thead className="sticky top-0 bg-muted/90 text-xs text-muted-foreground backdrop-blur">
                    <tr>
                      {previewFile.headers.map((header, index) => (
                        <th key={`${header}-${index}`} className="px-3 py-2 text-left font-semibold uppercase tracking-wide">
                          {header || `Column ${index + 1}`}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {previewFile.rows.slice(0, 200).map((row, rowIndex) => (
                      <tr key={`preview-row-${rowIndex}`} className="hover:bg-accent/20 transition">
                        {previewFile.headers.map((_, cellIndex) => (
                          <td key={`preview-cell-${rowIndex}-${cellIndex}`} className="px-3 py-2 text-foreground">
                            {row?.[cellIndex] || '--'}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <pre className="whitespace-pre-wrap p-4 text-xs text-foreground">
                  {previewFile.text || 'No preview content available.'}
                </pre>
              )}
            </div>
          </div>
        ) : (
          <div className="mt-4 rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
            No schedule file selected.
          </div>
        )}
      </div>
    </div>
  );
}
