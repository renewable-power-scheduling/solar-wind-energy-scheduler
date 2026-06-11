import { useMemo, useState, useEffect } from 'react';
import { Upload, FileText, Download, Snowflake } from 'lucide-react';
import { toast } from 'sonner';
import { api, scheduleReadinessApi } from '@/services/api';
import { useApi } from '@/hooks/useApi';
import { parseBlockFromTimestamp } from '@/utils/meterTime';
import { downloadCsvText, downloadXlsxFromSheets } from '@/app/components/common/downloadUtils';
import { S3_BASE_URL, DISABLE_S3_META, HIDE_METADATA } from '@/config/appConfig';
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

const TOTAL_BLOCKS = 96;
const BLOCK_MINUTES = 15;
const DAY_AHEAD_SUFFIX = /_DA0\.csv$/i;
const PLANT_CAPACITY_FALLBACK = {
  BHUPALPALLY: 10,
  CME: 4,
  GSNP: 20,
  KASIPET: 15,
  KILAJ: 20,
  KOTHAGUDEM: 37,
  OSEPL: 20,
  SIRMOUR: 5.1,
  ANJANGAON: 7.5,
};
const PLANT_STATE_FALLBACK = {
  BHUPALPALLY: 'Telangana',
  CME: 'Maharashtra',
  KASIPET: 'Telangana',
  KILAJ: 'Maharashtra',
  KOTHAGUDEM: 'Telangana',
  OSEPL: 'Maharashtra',
  GSNP: 'Madhya Pradesh',
  SIRMOUR: 'Madhya Pradesh',
  ANJANGAON: 'Madhya Pradesh',
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
];

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

function parseActualCsv(text) {
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
  const assumeKw = explicitKw || (!explicitMw && avg > 200);
  const factor = assumeKw ? 1 / 1000 : 1;

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

function mapMetaToTriggerReason(metaJson = {}) {
  const scheduleReasonRaw = String(metaJson?.schedule_reason || '').trim();
  const plantStatusRaw = String(metaJson?.plant_status || '').trim();
  const plantStatusUpper = plantStatusRaw.toUpperCase();
  const scheduleReasonLower = scheduleReasonRaw.toLowerCase();

  if (plantStatusUpper && plantStatusUpper !== 'NORMAL') return 'Plant Status Change';
  if (scheduleReasonLower.includes('plant_status')) return 'Plant Status Change';
  if (scheduleReasonLower.includes('curtail') || plantStatusUpper === 'CURTAILMENT') {
    if (scheduleReasonLower.includes('abrupt')) return 'Abrupt Curtailment';
    if (scheduleReasonLower.includes('dynamic')) return 'Dynamic Curtailment';
    return 'Curtailment';
  }
  // Treat abrupt weather changes as dynamic schedules for slot handling.
  if (scheduleReasonLower.includes('abrupt') && scheduleReasonLower.includes('weather')) return 'Dynamic';
  if (scheduleReasonLower.includes('dynamic')) return 'Dynamic';
  if (
    scheduleReasonLower.includes('day_ahead') ||
    scheduleReasonLower.includes('day-ahead') ||
    (scheduleReasonLower.includes('day') && scheduleReasonLower.includes('ahead'))
  ) {
    return 'Day-Ahead';
  }
  return '';
}

async function fetchScheduleTriggerReason(scheduleKey) {
  if (DISABLE_S3_META || HIDE_METADATA) return '';
  const key = String(scheduleKey || '').trim();
  if (!key) return '';
  const candidates = [
    key.replace(/\.csv$/i, '.meta.json'),
  ];
  for (const candidate of candidates) {
    try {
      const url = `${S3_BASE_URL}/${candidate.split('/').map(encodeURIComponent).join('/')}`;
      const payload = await fetch(url).then((r) => (r.ok ? r.json() : null));
      if (!payload) continue;
      const reason = mapMetaToTriggerReason(payload);
      if (reason) return reason;
    } catch {
      // try next candidate
    }
  }
  return '';
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
  const [s3IntradayKeys, setS3IntradayKeys] = useState([]);
  const [meterOptions, setMeterOptions] = useState([]);
  const [selectedMeterKey, setSelectedMeterKey] = useState('');
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
    const rawPlants = Array.isArray(apiPlantsData?.plants) && apiPlantsData.plants.length > 0
      ? apiPlantsData.plants
      : HARDCODED_PLANTS;
    const plants = filterPlantsForUser(rawPlants, currentUser);
    return plants.map((p) => ({
      id: p.id,
      name: p.name,
      capacity: p.capacity,
      state: p.state,
      type: p.type,
    }));
  }, [apiPlantsData, currentUser]);

  const selectedPlant = useMemo(
    () => plantOptions.find((p) => String(p.id) === String(selectedPlantId)),
    [plantOptions, selectedPlantId]
  );

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
      const rows = parseActualCsv(text);
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

  const loadDayAheadByKey = async (key, inlineText = '') => {
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
      source: prev?.source || 'Uploaded Section',
      uploadedAt: prev?.uploadedAt || '',
    }));
    setS3DayAheadKey(key || '');
  };

  const loadMeterByKey = async (key) => {
    if (!key) return;
    const name = key.split('/').pop();
    const url = `${S3_BASE_URL}/${key.split('/').map(encodeURIComponent).join('/')}`;
    const text = await fetch(url).then((r) => r.text());
    const parsedMeter = parseActualCsv(text);
    setActualRows(parsedMeter);
    setActualFile({ name, source: 's3' });
    setS3MeterKey(key);
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
      // Fall through to legacy scan below.
    }

    const prefix = `generated/vedanjay/${normalizedCode}/outputs/${dateValue}/`;
    const objects = await listS3Objects(prefix).catch(() => []);
    const logs = objects.filter((o) => {
      const key = String(o.key || '');
      return /schedule_free(?:z|ze)_from_\d+\.log$/i.test(key) || /_frozen\.log$/i.test(key);
    });

    const logEntries = await Promise.all(
      logs.map(async (obj) => {
        try {
          const url = `${S3_BASE_URL}/${obj.key.split('/').map(encodeURIComponent).join('/')}`;
          const payload = await fetch(url).then((r) => r.json());
          const block = Number.parseInt(String(payload?.block || deriveEndingBlockFromName(obj.key) || ''), 10);
          if (!Number.isFinite(block)) return null;
          return {
            block,
            status: payload?.status || 'Unknown',
            reason: payload?.reason || '',
            freezeTime: payload?.freeze_time || payload?.created_at || obj.lastModified || '',
            sourceScheduleKey: payload?.source_schedule_key || '',
            summary: payload?.summary || null,
          };
        } catch {
          return null;
        }
      })
    );

    const byBlock = {};
    let latest = null;
    logEntries.filter(Boolean).forEach((entry) => {
      byBlock[entry.block] = entry;
      const ts = Date.parse(entry.freezeTime || '') || 0;
      const latestTs = Date.parse(latest?.freezeTime || '') || 0;
      if (!latest || ts >= latestTs) latest = entry;
    });
    setAutoFreezeByBlock(byBlock);
    setLastAutoFreeze(latest);
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

  const handleFetchFromS3 = async () => {
    if (!selectedDate) {
      toast.error('Select a date first');
      return;
    }
    const code = String(plantCode || '').trim();
    if (!code) {
      toast.error('Select a plant to fetch S3 data');
      return;
    }

    setS3Loading(true);
    try {
      const [uploadHistory, meterObjects, dayAheadPrimaryObjects] = await Promise.all([
        scheduleReadinessApi.getUploadHistory({ scheduleDate: selectedDate, plantCode: code, limit: 500 }),
        listS3ObjectsAcrossPrefixes(buildMeterPrefixes(selectedDate, code)),
        listS3ObjectsAcrossPrefixes(buildDayAheadPrefixes(selectedDate, code)),
      ]);

      const historyItems = Array.isArray(uploadHistory?.items) ? uploadHistory.items : [];
      const codeAliases = new Set(getPlantCodeAliases(code));
      const relevantHistory = historyItems.filter((item) => {
        const itemPlantCode = buildPlantCode(String(item?.plant_code || '').trim());
        const plantCodeMatch = codeAliases.has(itemPlantCode);
        const scheduleDateMatch = String(item?.schedule_date || '').trim() === selectedDate;
        return plantCodeMatch && scheduleDateMatch;
      });

      const dayAheadHistory = relevantHistory
        .filter((item) => /\/day-ahead\/|\/dayahead\/|\/day_ahead\//i.test(String(item?.source_file_key || '')))
        .sort((a, b) => (Date.parse(String(b?.uploaded_at || '')) || 0) - (Date.parse(String(a?.uploaded_at || '')) || 0));

      const intradayHistory = relevantHistory
        .filter((item) => !/\/day-ahead\/|\/dayahead\/|\/day_ahead\//i.test(String(item?.source_file_key || '')))
        .sort((a, b) => (Date.parse(String(a?.uploaded_at || '')) || 0) - (Date.parse(String(b?.uploaded_at || '')) || 0));

      const prevDateKey = getPrevDateKey(selectedDate);
      const dayAheadCandidates = dayAheadHistory
        .map((item) => ({
          key: String(item?.source_file_key || item?.output_file_key || '').trim(),
          uploadedAt: item?.uploaded_at || '',
          csv_text: item?.csv_text || '',
        }))
        .filter((item) => item.key || item.csv_text);

        const dayAheadPrimary = (dayAheadPrimaryObjects || [])
          .filter((o) => o.key.toLowerCase().endsWith('.csv'))
          .sort((a, b) => (Date.parse(b.lastModified || '') || 0) - (Date.parse(a.lastModified || '') || 0));


        // Priority 1: Newest DA submitted on the previous day (Standard Baseline).
        const baselineDa = dayAheadCandidates
          .filter((item) => toLocalDateKeyFromTimestamp(item.uploadedAt) === prevDateKey)
          .sort((a, b) => (Date.parse(String(b.uploadedAt || '')) || 0) - (Date.parse(String(a.uploadedAt || '')) || 0))[0] || null;

        // Priority 2: Fallback to latest DA submitted for this date in history.
        const fallbackHistoryDa = [...dayAheadCandidates]
          .sort((a, b) => (Date.parse(String(b.uploadedAt || '')) || 0) - (Date.parse(String(a.uploadedAt || '')) || 0))[0] || null;

        let pickedDayAhead = baselineDa || fallbackHistoryDa;

        // Priority 3: Fallback to latest DA found in the specific S3 "Day-ahead" folder.
        if (!pickedDayAhead && dayAheadPrimary.length > 0) {
          const latestS3File = dayAheadPrimary[0];
          pickedDayAhead = {
            key: latestS3File.key,
            uploadedAt: latestS3File.last_modified,
            csv_text: '',
          };
        }

        if (!pickedDayAhead) {
          throw new Error(
            `Day-ahead schedule not found for ${selectedDate} in history or S3 Day-ahead folder.`
          );
        }

      setDayAheadFile({
        name: (pickedDayAhead.key || '').split('/').pop() || 'day_ahead.csv',
        key: pickedDayAhead.key || '',
        uploadedAt: pickedDayAhead.uploadedAt || '',
        source: 'Uploaded Section',
      });

      const parsedSchedulesRaw = await Promise.all(
        intradayHistory.map(async (item, index) => {
          const sourceKey = String(item?.source_file_key || '').trim();
          const outputKey = String(item?.output_file_key || '').trim();
          let csvText = String(item?.csv_text || '').trim();
          if (!csvText) {
            const fallbackKey = sourceKey || outputKey;
            if (fallbackKey) {
              csvText = await fetchS3TextByKey(fallbackKey);
            }
          }
          const fileName = (sourceKey || outputKey).split('/').pop() || item?.template_file_name || `uploaded_intraday_${index + 1}.csv`;
          const rows = parseScheduleCsv(csvText, { preferredColumns: getTemplateScheduledMwPreferredColumns(code) });
          const triggerReason = String(item?.trigger_reason || item?.reason || '').trim();
          return {
            id: sourceKey || outputKey || `${fileName}-${index}`,
            file: { name: fileName, source: 'upload-history' },
            name: fileName,
            rows,
            generatedBlock: deriveEndingBlockFromName(fileName),
            freezeTime: item?.uploaded_at || '',
            submitBlock: item?.submit_block,
            effectiveBlock: item?.effective_start_block,
            source: 'Uploaded Section',
            meta: triggerReason ? { triggerReason } : undefined,
          };
        })
      );
      const parsedSchedules = parsedSchedulesRaw.filter((item) => Array.isArray(item.rows) && item.rows.length > 0);

      setIntradayFiles(parsedSchedules);
      setS3IntradayKeys(parsedSchedules.map((s) => s.id));

      await loadDayAheadByKey(pickedDayAhead.key || '', pickedDayAhead.csv_text || '');

      const meterUnique = Array.from(new Map((meterObjects || []).map((o) => [o.key, o])).values());
      const meterList = meterUnique
        .filter((o) => o.key.toLowerCase().endsWith('.csv'))
        .sort((a, b) => {
          const aTime = Date.parse(a.lastModified || '');
          const bTime = Date.parse(b.lastModified || '');
          const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
          if (timeDiff !== 0) return timeDiff;
          return String(b.key || '').localeCompare(String(a.key || ''));
        });
      setMeterOptions(meterList);
      const meterPick = pickFirstCsv(meterList, false);
      setSelectedMeterKey(meterPick?.key || '');

      if (meterPick) {
        await loadMeterByKey(meterPick.key);
      } else {
        setActualRows([]);
        setActualFile(null);
        setS3MeterKey('');
      }

      await loadAutoFreezeArtifacts(code, selectedDate);

      toast.success('Uploaded schedules loaded from Schedule Readiness');
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


  const timelineStatusCounts = useMemo(() => {
    const counts = { uploaded: 0, discarded: 0, pending: 0 };
    timelineRows.forEach((row) => {
      const bucket = summarizeStatus(resolveTimelineStatus(row, autoFreezeByBlock));
      if (bucket === 'Uploaded') counts.uploaded += 1;
      else if (bucket === 'Discarded') counts.discarded += 1;
      else counts.pending += 1;
    });
    return counts;
  }, [timelineRows, autoFreezeByBlock]);

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Snowflake className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg sm:text-xl font-semibold text-foreground">Frozen Schedule</h2>
          <p className="text-xs sm:text-sm text-muted-foreground">
            Frozen schedules are captured after SLDC upload confirmation.
          </p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="text-sm font-semibold text-foreground mb-3">Plant Context</h3>
          <div className="space-y-3">
            <label className="text-xs font-medium text-muted-foreground">Plant (optional)</label>
            <select
              value={selectedPlantId}
              onChange={(e) => setSelectedPlantId(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="">Select plant</option>
              {plantOptions.map((plant) => (
                <option key={plant.id} value={plant.id}>
                  {plant.name}
                </option>
              ))}
            </select>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Capacity (MW)</label>
                <input
                  value={manualCapacity || selectedPlant?.capacity || ''}
                  onChange={(e) => setManualCapacity(e.target.value)}
                  placeholder="0"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Plant Type</label>
                <select
                  value={resolvedType}
                  onChange={(e) => setManualType(e.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="Solar">Solar</option>
                  <option value="Wind">Wind</option>
                </select>
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground">State</label>
              <input
                value={manualState || selectedPlant?.state || PLANT_STATE_FALLBACK[plantCode] || ''}
                onChange={(e) => setManualState(e.target.value)}
                placeholder="Telangana"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground">Date</label>
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
              />
            </div>
            <button
              onClick={handleFetchFromS3}
              disabled={s3Loading}
              className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed transition"
            >
              {s3Loading ? 'Loading uploaded schedules...' : 'Load Uploaded Schedules'}
            </button>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-4 lg:col-span-2">
          <h3 className="text-sm font-semibold text-foreground mb-3">Data Sources</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-border bg-muted/20 p-3">
              <p className="text-xs font-semibold text-muted-foreground mb-2">Day-Ahead Baseline</p>
              <p className="text-sm font-semibold text-foreground">{dayAheadFile?.name || '--'}</p>
              <p className="text-[11px] text-muted-foreground">
                Submitted: {dayAheadFile?.uploadedAt ? new Date(dayAheadFile.uploadedAt).toLocaleString() : '--'}
              </p>
              <p className="text-[11px] text-muted-foreground">Source: Uploaded Section</p>
            </div>

            <div className="rounded-lg border border-border bg-muted/20 p-3">
              <p className="text-xs font-semibold text-muted-foreground mb-2">Intraday Schedules</p>
              <p className="text-sm font-semibold text-foreground">
                {intradayFiles.length ? `${intradayFiles.length} file(s) fetched` : '--'}
              </p>
              <p className="text-[11px] text-muted-foreground">Source: Uploaded Section</p>
            </div>
          </div>

          <label className="mt-3 flex flex-col gap-2 rounded-lg border border-dashed border-border p-3 cursor-pointer hover:bg-accent/40 transition">
            <span className="text-xs font-medium text-muted-foreground">Actual / Meter Data (CSV)</span>
            <div className="flex items-center gap-2 text-sm text-foreground">
              <Upload className="w-4 h-4" />
              {actualFile?.name || 'Choose file (optional)'}
            </div>
            {s3MeterKey && (
              <span className="text-[11px] text-muted-foreground">S3: {s3MeterKey}</span>
            )}
            <input
              type="file"
              accept=".csv"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && handleActualUpload(e.target.files[0])}
            />
          </label>

          {meterOptions.length > 0 && (
            <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3">
              <p className="text-xs font-semibold text-muted-foreground mb-2">Meter Files (select one)</p>
              <div className="space-y-2 max-h-40 overflow-y-auto pr-1">
                {meterOptions.map((opt) => {
                  const name = opt.key.split('/').pop();
                  return (
                    <label key={opt.key} className="flex items-center gap-2 text-xs text-foreground">
                      <input
                        type="radio"
                        name="meter"
                        checked={selectedMeterKey === opt.key}
                        onChange={async () => {
                          setSelectedMeterKey(opt.key);
                          const url = `${S3_BASE_URL}/${opt.key.split('/').map(encodeURIComponent).join('/')}`;
                          const text = await fetch(url).then((r) => r.text());
                          const parsedMeter = parseActualCsv(text);
                          setActualRows(parsedMeter);
                          setActualFile({ name, source: 's3' });
                          setS3MeterKey(opt.key);
                        }}
                      />
                      {name}
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Intraday Schedule Timeline</h3>
            <p className="text-xs text-muted-foreground">
              Schedules are system-selected from Schedule Readiness → Uploaded Section (no manual file picking). Day-ahead baseline uses the upload submitted one day before; intraday applies with 45-minute effective delay.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className="text-xs text-muted-foreground">Auto-freeze status</p>
              <p className="text-sm font-semibold text-foreground">
                {lastAutoFreeze
                  ? `Last frozen at block ${lastAutoFreeze.block} (${new Date(lastAutoFreeze.freezeTime).toLocaleTimeString()})`
                  : 'No frozen log found'}
              </p>
              <p className="text-[11px] text-muted-foreground">
                Uploaded: {timelineStatusCounts.uploaded} | Discarded: {timelineStatusCounts.discarded} | Pending: {timelineStatusCounts.pending}
              </p>
            </div>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                {['File Name', 'Uploaded At', 'Submit Time', 'Effective Time', 'Status', 'Source'].map((h) => (
                  <th key={h} className="px-3 py-2 text-left font-semibold uppercase tracking-wide">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {timelineRows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-center text-xs text-muted-foreground">
                    No schedule files found for this plant/date.
                  </td>
                </tr>
              )}
              {timelineRows.map((item) => (
                <tr key={item.id}>
                  <td className="px-3 py-2 text-foreground flex items-center gap-2">
                    <FileText className="w-4 h-4 text-muted-foreground" />
                    {item.name}
                  </td>
                  <td className="px-3 py-2 text-foreground">
                    {(() => {
                      const ts = Date.parse(String(item.freezeTime || ''));
                      return Number.isNaN(ts) ? '--' : new Date(ts).toLocaleString();
                    })()}
                  </td>
                  <td className="px-3 py-2 text-foreground">
                    {Number.isFinite(item.submitBlock) ? blockToTime(item.submitBlock) : '--'}
                  </td>
                  <td className="px-3 py-2 text-foreground">
                    {Number.isFinite(item.effectiveBlock) ? blockToTime(item.effectiveBlock) : '--'}
                  </td>
                  <td className="px-3 py-2 text-foreground text-xs">{resolveTimelineStatus(item, autoFreezeByBlock)}</td>
                  <td className="px-3 py-2 text-foreground text-xs">{String(item.source || 'Uploaded Section')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Frozen Schedule Output</h3>
            <p className="text-xs text-muted-foreground">
              Effective schedule per block with 3-block (45 min) delay and strict slot/queue rules. Penalty shown when actuals are provided.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleExport('csv')}
              className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-semibold text-foreground hover:bg-accent/40 transition"
            >
              <Download className="w-4 h-4" />
              Export CSV
            </button>
            <button
              onClick={() => handleExport('xlsx')}
              className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-semibold text-foreground hover:bg-accent/40 transition"
            >
              <Download className="w-4 h-4" />
              Export XLSX
            </button>
          </div>
        </div>

        {summary && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-lg border border-border bg-muted/40 p-3">
              <p className="text-xs text-muted-foreground">Total Penalty (Rs)</p>
              <p className="text-lg font-semibold text-emerald-600">
                {summary.totalPenalty.toFixed(2)}
              </p>
            </div>
            <div className="rounded-lg border border-border bg-muted/40 p-3">
              <p className="text-xs text-muted-foreground">Actuals Loaded</p>
              <p className="text-lg font-semibold text-foreground">
                {summary.hasActuals ? 'Yes' : 'No'}
              </p>
            </div>
            <div className="rounded-lg border border-border bg-muted/40 p-3">
              <p className="text-xs text-muted-foreground">Plant Capacity (MW)</p>
              <p className="text-lg font-semibold text-foreground">
                {plantCapacity || 0}
              </p>
            </div>
          </div>
        )}

        <div className="mt-4 overflow-x-auto max-h-[550px] overflow-y-auto">
          <table className="min-w-full text-sm">
            <thead className="sticky top-0 bg-muted border-b border-border z-10 text-xs text-muted-foreground">
              <tr>
                {['Block', 'Time', 'Scheduled MW', 'Actual MW', 'Deviation MW', 'Penalty Rs', 'Source'].map((h) => (
                  <th key={h} className="px-3 py-2 text-left font-semibold uppercase tracking-wide">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {resultRows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-4 text-center text-xs text-muted-foreground">
                    Auto-frozen schedule not found for this plant/date yet.
                  </td>
                </tr>
              )}
              {resultRows.map((row) => (
                <tr key={row.block}>
                  <td className="px-3 py-2 text-foreground">{row.block}</td>
                  <td className="px-3 py-2 text-foreground">{row.time}</td>
                  <td className="px-3 py-2 text-foreground">{row.scheduledMw?.toFixed?.(3)}</td>
                  <td className="px-3 py-2 text-foreground">
                    {Number.isFinite(row.actualMw) ? row.actualMw.toFixed(3) : '--'}
                  </td>
                  <td className="px-3 py-2 text-foreground">
                    {Number.isFinite(row.deviationMw) ? row.deviationMw.toFixed(3) : '--'}
                  </td>
                  <td className="px-3 py-2 text-foreground">
                    {Number.isFinite(row.penaltyRs) ? row.penaltyRs.toFixed(2) : '--'}
                  </td>
                  <td className="px-3 py-2 text-foreground">{row.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
