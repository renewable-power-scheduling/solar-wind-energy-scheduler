import { AlertCircle, Calendar, Clock, Mail, RefreshCw, Server, Trash2, UploadCloud } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { API_ORIGIN } from '@/config/appConfig';
import { filterPlantsForUser, getCurrentUserFromStorage, isAdminUser } from '@/utils/plantAccess';
import { useData } from '@/app/appContexts';
import { Switch } from '@/app/components/ui/switch';
import { DSM_PENALTY_CONFIG_BY_STATE, DEFAULT_DSM_PENALTY_CONFIG } from '@/config/dsmPenaltyConfig';
import { calculatePenaltyRs as calculatePenaltyRsShared } from '@/shared/freezeRules';
import { listS3ObjectsAcrossPrefixes, fetchTextFromS3 } from '@/services/s3Utils';
import { calculateOseplOfficePayableReceivable, calculateOseplSettlement } from '@/utils/oseplPenalty';
import { parseBlockFromTimestamp } from '@/utils/meterTime';
import { getPpaRateRsPerKwh } from '@/utils/ppaRate';

const emailSchedulerBase = () => {
  // In dev, API_ORIGIN resolves to http://localhost:3001 so we can hit /email-scheduler/*.
  // In docker/prod, keep relative paths so nginx proxies correctly.
  return API_ORIGIN ? `${API_ORIGIN}/email-scheduler` : '/email-scheduler';
};

const ROLE_HEADER = 'X-User-Role';
const USER_HEADER = 'X-User-Name';
const DEFAULT_EMAIL_SIGNATURE_NAME = 'Code Vedanjay';

const deriveRole = (user) => (isAdminUser(user) ? 'admin' : 'testing');

const sanitizeTemplatesForRole = (groups, role) => {
  const isAdminRole = String(role || '').trim().toLowerCase() === 'admin';
  if (isAdminRole) return groups || {};
  // Intern/employee should also see and use template default To/CC (same as admin).
  return groups || {};
};

const deriveTemplateCategory = (template) => {
  const raw = String(template?.category || template?.template_type || template?.type || '').trim();
  if (raw) return raw;

  const id = String(template?.id || '').toLowerCase();
  const label = String(template?.label || template?.name || '').toLowerCase();
  const hay = `${id} ${label}`;
  if (hay.includes('portal')) return 'Portal Issue';
  if (hay.includes('dsm')) return 'DSM';
  if (hay.includes('day') || hay.includes('da')) return 'Day-Ahead';
  if (hay.includes('intra') || hay.includes('id')) return 'Intraday';
  return 'Custom';
};

const formatLocalDateTime = (value) => {
  if (!value) return '';
  try {
    const dt = new Date(value);
    return dt.toLocaleString();
  } catch {
    return String(value);
  }
};

const getIstTodayDateKey = () => {
  try {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  } catch {
    // Fallback to local timezone (still YYYY-MM-DD in most modern browsers with en-CA).
    return new Date().toLocaleDateString('en-CA');
  }
};

const getIstNowTimeKey = () => {
  try {
    const raw = new Date().toLocaleTimeString('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return String(raw || '').trim();
  } catch {
    const dt = new Date();
    const hh = String(dt.getHours()).padStart(2, '0');
    const mm = String(dt.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }
};

const formatDdMmYyyy = (dateKey) => {
  const raw = String(dateKey || '').trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return raw;
  return `${m[3]}-${m[2]}-${m[1]}`;
};

const createFileFromCsv = (csvText, fileName) => {
  const text = typeof csvText === 'string' ? csvText : '';
  const name = String(fileName || 'schedule.csv');
  return new File([text], name, { type: 'text/csv' });
};

const ensureTestingSubject = (rawSubject) => {
  const s = String(rawSubject || '').trim();
  if (!s) return 'TEST';
  if (s.toUpperCase().includes('TEST')) return s;
  return `TEST - ${s}`;
};

const ensureTestingBody = (rawBody) => {
  const body = String(rawBody || '').trimEnd();
  if (!body) return 'TEST EMAIL\n';
  const firstLine = body.split('\n')[0] || '';
  if (firstLine.toUpperCase().includes('TEST')) return body;
  return `TEST EMAIL\n\n${body}`;
};

const buildTemplateVars = (dateKey) => {
  const raw = String(dateKey || '').trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    return {
      date_dashed: raw,
      date_dotted: raw,
      month_full: '',
      month_short: '',
      year_full: '',
      year_short: '',
      next_month_short: '',
    };
  }

  const yyyy = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);

  const istDate = new Date(Date.UTC(yyyy, mm - 1, dd, 0, 0, 0));
  const monthFull = istDate.toLocaleString('en-US', { month: 'long', timeZone: 'Asia/Kolkata' });
  const monthShort = istDate.toLocaleString('en-US', { month: 'short', timeZone: 'Asia/Kolkata' });
  const yearFull = String(yyyy);
  const yearShort = String(yyyy).slice(-2);
  const dateDotted = `${String(dd).padStart(2, '0')}.${String(mm).padStart(2, '0')}.${String(yyyy)}`;
  const dateDashed = `${String(yyyy)}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;

  const nextMonthDate = new Date(Date.UTC(yyyy, mm, 1, 0, 0, 0));
  const nextMonthShort = nextMonthDate.toLocaleString('en-US', { month: 'short', timeZone: 'Asia/Kolkata' });

  return {
    date_dashed: dateDashed,
    date_dotted: dateDotted,
    month_full: monthFull,
    month_short: monthShort,
    year_full: yearFull,
    year_short: yearShort,
    next_month_short: nextMonthShort,
  };
};

const applyTemplateVars = (text, vars) => {
  const raw = String(text || '');
  return raw.replace(/\{([a-z_]+)\}/gi, (match, key) => {
    const k = String(key || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(vars, k)) return String(vars[k] ?? '');
    return match;
  });
};

const parseCsvToRows = (csvText) => {
  const text = String(csvText || '');
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1];
        if (next === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      continue;
    }
    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    if (ch === '\r') continue;
    cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
};

const buildCsvPreview = (csvText, maxRows = 25) => {
  const rows = parseCsvToRows(csvText);
  const safe = rows.filter((r) => Array.isArray(r) && r.some((c) => String(c || '').trim() !== ''));
  if (!safe.length) return null;
  const header = safe[0] || [];
  const dataRows = safe.slice(1, 1 + Math.max(0, maxRows));
  return { header, rows: dataRows };
};

const PLANT_CAPACITY_FALLBACK = {
  BHUPALPALLY: 10,
  KASIPET: 15,
  KOTHAGUDEM: 37,
  OSEPL: 20,
  SIRMOUR: 5.1,
  SAWDA: 7.5,
  ANJANGAON: 7.5,
};

const normalizePlantCodeKey = (plantCode) => String(plantCode || '').trim().toUpperCase();

const formatSubjectCapacityMw = (capacity) => {
  const value = Number(capacity || 0);
  if (!Number.isFinite(value) || value <= 0) return '0';
  return Number.isInteger(value) ? String(value) : String(value).replace(/0+$/, '').replace(/\.$/, '');
};

const getReportSubjectPrefix = ({ template, templateId, category }) => {
  const id = String(template?.id || templateId || '').trim().toLowerCase();
  const cat = String(category || deriveTemplateCategory(template) || '').trim().toLowerCase();
  const hay = `${id} ${cat}`;
  if (hay.includes('dsm')) return 'DSM Report';
  if (hay.includes('intra')) return 'Intraday Schedule';
  if (hay.includes('day') || id.endsWith('_da0') || id.endsWith('_da1') || id.includes('da0') || id.includes('da1')) {
    return 'Dayahead Schedule';
  }
  return '';
};

const buildReportEmailSubject = ({ template, templateId, category, plantCode, dateKey }) => {
  const prefix = getReportSubjectPrefix({ template, templateId, category });
  const plant = normalizePlantCodeKey(plantCode);
  if (!prefix || !plant) return '';
  const dateLabel = formatDdMmYyyy(dateKey);
  if (prefix === 'DSM Report' && ['BHUPALPALLY', 'KASIPET', 'KOTHAGUDEM'].includes(plant)) {
    return `DSM Report Telangana State Plants for ${dateLabel}`;
  }
  const capacity = formatSubjectCapacityMw(PLANT_CAPACITY_FALLBACK[plant]);
  return `${prefix} ${plant} (${capacity} MW) for ${dateLabel}`;
};

const withAttachmentExtension = (fileName, extension) => {
  const base = String(fileName || 'schedule').replace(/\.[^.]+$/, '');
  return `${base}${extension}`;
};

const PLANT_STATE_FALLBACK = {
  BHUPALPALLY: 'Telangana',
  KASIPET: 'Telangana',
  KOTHAGUDEM: 'Telangana',
  OSEPL: 'Maharashtra',
  SIRMOUR: 'Madhya Pradesh',
  SAWDA: 'Madhya Pradesh',
  ANJANGAON: 'Madhya Pradesh',
};

const calculatePenaltyRs = ({ scheduledMw, actualMw, capacityMw, plantState, plantType }) =>
  calculatePenaltyRsShared({
    scheduledMw,
    actualMw,
    capacityMw,
    plantState,
    plantType: String(plantType || 'Solar'),
    penaltyConfigByState: DSM_PENALTY_CONFIG_BY_STATE,
    defaultPenaltyConfig: DEFAULT_DSM_PENALTY_CONFIG,
  });

const TOTAL_BLOCKS = 96;

function getCurrentIstBlock() {
  const now = new Date();
  const istNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const totalMinutes = (istNow.getHours() * 60) + istNow.getMinutes();
  const block = Math.floor(totalMinutes / 15) + 1;
  return Math.min(Math.max(block, 1), TOTAL_BLOCKS);
}

function toHeaderKey(v) {
  return String(v || '').toLowerCase().replace(/["']/g, '').replace(/[^a-z0-9]+/g, '');
}

function parseBlockFromNearestQuarterStart(raw) {
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
  const roundedMinutes = Math.floor((totalMinutes + 7.5) / 15) * 15;
  const block = Math.floor(roundedMinutes / 15) + 1;
  return (block >= 1 && block <= TOTAL_BLOCKS) ? block : null;
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

function parseCsvWithHeaderDetection(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return { headers: [], rows: [] };
  const delimiterCandidates = [',', ';', '\t'];

  const scoreHeaderLine = (line) => {
    const lowered = String(line || '').toLowerCase();
    if (!delimiterCandidates.some((d) => lowered.includes(d))) return -1;
    let score = 0;
    if (/\bblock\b|\bblk\b|\bs\.?\s*no\b|\bsno\b/.test(lowered)) score += 5;
    if (/\btime\b|\btimestamp\b|\bdate\b/.test(lowered)) score += 4;
    if (/meter|actual|forecast|sch[^a-z0-9]*mw|schedule/.test(lowered)) score += 6;
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
      if (ch === '\"') {
        if (inQuotes && line[i + 1] === '\"') {
          current += '\"';
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

  const headers = parseLine(lines[start]).map((h) => h.replace(/^\uFEFF/, '').trim());
  const maybeHeader2 = lines[start + 1] ? parseLine(lines[start + 1]).map((h) => h.replace(/^\uFEFF/, '').trim()) : [];
  const useSecondHeader = maybeHeader2.some((h) => /forecast|availability/i.test(String(h || '')));

  const maxCols = Math.max(headers.length, maybeHeader2.length);
  const mergedHeaders = Array.from({ length: maxCols }, (_, i) => {
    const h1 = headers[i] || '';
    const h2 = useSecondHeader ? (maybeHeader2[i] || '') : '';
    if (h1 && h2) return `${h1} ${h2}`.trim();
    return h1 || h2;
  });

  const dataStart = start + (useSecondHeader ? 2 : 1);
  const rows = lines.slice(dataStart).map((line) => parseLine(line).map((v) => v.trim()));
  return { headers: mergedHeaders, rows };
}

function parseBlockNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const direct = Number.parseInt(text, 10);
  if (Number.isFinite(direct)) return direct;
  const anyNumber = text.match(/([0-9]{1,3})/);
  if (anyNumber) return Number.parseInt(anyNumber[1], 10);
  return null;
}

function parseScheduleSeriesMap(text) {
  const { headers, rows } = parseCsvWithHeaderDetection(text);
  const normalized = headers.map(toHeaderKey);
  const blockIdx = normalized.findIndex((h) => h.includes('block') || h.includes('blk') || h === 'sno' || h.includes('srno'));
  if (blockIdx === -1) return new Map();

  let scheduleIdx = normalized.findIndex((h) => h.includes('stationschedule') && !h.includes('availability') && !h.includes('capacity'));
  if (scheduleIdx === -1) scheduleIdx = normalized.findIndex((h) => h.includes('schedule') && h.includes('mw'));
  if (scheduleIdx === -1) scheduleIdx = normalized.findIndex((h) => h.includes('schedule') || h.includes('schmw') || (h.includes('sch') && h.includes('mw')));
  if (scheduleIdx === -1) scheduleIdx = normalized.findIndex((h) => h.includes('forecast') && !h.includes('forcastavailability'));
  if (scheduleIdx === -1) scheduleIdx = normalized.findIndex((h) => h.includes('mw') && !h.includes('meter') && !h.includes('actual'));
  if (scheduleIdx === -1) return new Map();

  const map = new Map();
  (rows || []).forEach((cols) => {
    const block = parseBlockNumber(cols?.[blockIdx]);
    if (!Number.isFinite(block) || block < 1 || block > TOTAL_BLOCKS) return;
    const value = parseFloat(String(cols?.[scheduleIdx] ?? '').replace(/,/g, '').trim());
    if (!Number.isFinite(value)) return;
    map.set(block, value);
  });
  return map;
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

function getDistanceFromBlockStartSeconds(rawTime, block) {
  const timeMatch = String(rawTime ?? '').match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!timeMatch) return null;
  const hh = Number.parseInt(timeMatch[1], 10);
  const mm = Number.parseInt(timeMatch[2], 10);
  const ss = timeMatch[3] ? Number.parseInt(timeMatch[3], 10) : 0;
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss)) return null;
  const minutes = (hh * 60) + mm + (ss / 60);
  const blockStartMinutes = (Math.max(1, Number(block)) - 1) * 15;
  return Math.abs((minutes - blockStartMinutes) * 60);
}

function isLikelyMidnightCarryRow(rawTime) {
  const t = String(rawTime ?? '').trim();
  if (!t) return false;
  return /^0?0:0?0(?::0?0)?/.test(t) || /^24:00(?::00)?/.test(t);
}

function preferMeterPointCandidate(currentPoint, incomingPoint) {
  if (!currentPoint) return true;
  if (!incomingPoint) return false;
  const aDist = Number(currentPoint.distanceToBlockStartSeconds);
  const bDist = Number(incomingPoint.distanceToBlockStartSeconds);
  const aHasDist = Number.isFinite(aDist);
  const bHasDist = Number.isFinite(bDist);
  if (aHasDist && bHasDist && aDist !== bDist) return bDist < aDist;
  if (bHasDist && !aHasDist) return true;
  if (aHasDist && !bHasDist) return false;
  // Fall back to later row index (usually later file value is more accurate)
  return Number(incomingPoint.idx || 0) > Number(currentPoint.idx || 0);
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
    const score = (unique * 100) - (duplicates * 25) - (missing * 10) + parsed;
    return { score };
  };

  const startEval = evaluate((t) => parseBlockFromStartTimestamp(t));
  const endEval = evaluate((t) => parseBlockFromTimestamp(t, { totalBlocks: TOTAL_BLOCKS }));
  const nearestEval = evaluate((t) => parseBlockFromNearestQuarterStart(t));

  const candidates = [
    { mode: 'start', eval: startEval },
    { mode: 'end', eval: endEval },
    { mode: 'nearest', eval: nearestEval },
  ];
  candidates.sort((a, b) => {
    if (b.eval.score !== a.eval.score) return b.eval.score - a.eval.score;
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
      const startBlock = parseBlockFromStartTimestamp(rangeMatch[1]);
      if (Number.isFinite(startBlock)) return startBlock;
      return parseBlockFromTimestamp(rangeMatch[1], { totalBlocks: TOTAL_BLOCKS });
    }
    if (convention === 'start') {
      const startBlock = parseBlockFromStartTimestamp(textVal);
      if (Number.isFinite(startBlock)) return startBlock;
      const nearestBlock = parseBlockFromNearestQuarterStart(textVal);
      if (Number.isFinite(nearestBlock)) return nearestBlock;
      const endBlock = parseBlockFromTimestamp(textVal, { totalBlocks: TOTAL_BLOCKS });
      if (Number.isFinite(endBlock)) return endBlock;
      return null;
    }
    if (convention === 'nearest') {
      const nearestBlock = parseBlockFromNearestQuarterStart(textVal);
      if (Number.isFinite(nearestBlock)) return nearestBlock;
      const startBlock = parseBlockFromStartTimestamp(textVal);
      if (Number.isFinite(startBlock)) return startBlock;
      const endBlock = parseBlockFromTimestamp(textVal, { totalBlocks: TOTAL_BLOCKS });
      if (Number.isFinite(endBlock)) return endBlock;
      return null;
    }
    const endBlock = parseBlockFromTimestamp(textVal, { totalBlocks: TOTAL_BLOCKS });
    if (Number.isFinite(endBlock)) return endBlock;
    const nearestBlock = parseBlockFromNearestQuarterStart(textVal);
    if (Number.isFinite(nearestBlock)) return nearestBlock;
    const startBlock = parseBlockFromStartTimestamp(textVal);
    if (Number.isFinite(startBlock)) return startBlock;
    return null;
  };
}

function parseMeterSeriesMap(text) {
  const { headers, rows } = parseCsvWithHeaderDetection(text);
  const normalized = headers.map(toHeaderKey);
  const blockIdx = normalized.findIndex((h) => h.includes('block') || h.includes('blk') || h === 'sno' || h.includes('srno'));
  const timeIdx = normalized.findIndex((h) => h.includes('time') || h.includes('timestamp') || h.includes('date') || h.includes('from') || h.includes('to'));

  let powerIdx =
    normalized.findIndex((h) => h.includes('meter') && (h.includes('mw') || h.includes('kw') || h.includes('power'))) ?? -1;
  if (powerIdx === -1) powerIdx = normalized.findIndex((h) => h.includes('meterpower') || (h.includes('meter') && h.includes('power')));
  if (powerIdx === -1) powerIdx = normalized.findIndex((h) => h.includes('actual') && (h.includes('mw') || h.includes('kw') || h.includes('power')));
  if (powerIdx === -1) powerIdx = normalized.findIndex((h) => (h.includes('mw') || h.includes('kw')) && !h.includes('schedule') && !h.includes('sch'));
  if (powerIdx === -1) return new Map();

  const powerHeader = String(normalized[powerIdx] || '');
  const explicitKw = powerHeader.includes('kw') && !powerHeader.includes('mw');
  const explicitMw = powerHeader.includes('mw');

  const getBlockFromTimeText = buildMeterTimeBlockResolver(rows, timeIdx);

  const parsedPoints = (rows || [])
    .map((cols, idx) => {
      const blockFromCol = blockIdx !== -1 ? parseBlockNumber(cols[blockIdx]) : null;
      const timeRaw = timeIdx !== -1 ? cols[timeIdx] : null;
      const blockFromTime = timeIdx !== -1 ? getBlockFromTimeText(timeRaw) : null;
      const fallbackBlock = idx + 1;

      let block = null;
      if (Number.isFinite(blockFromCol) && blockFromCol >= 1 && blockFromCol <= TOTAL_BLOCKS) {
        block = blockFromCol;
      } else if (Number.isFinite(blockFromTime) && blockFromTime >= 1 && blockFromTime <= TOTAL_BLOCKS) {
        block = blockFromTime;
      } else if (blockIdx === -1 && timeIdx === -1 && fallbackBlock >= 1 && fallbackBlock <= TOTAL_BLOCKS) {
        block = fallbackBlock;
      }

      const value = parseFloat(String(cols?.[powerIdx] ?? '').replace(/,/g, '').trim());
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
    if (preferMeterPointCandidate(existing, p)) bestPointByBlock.set(p.block, p);
  });

  const map = new Map();
  bestPointByBlock.forEach((p, block) => {
    map.set(block, p.value * factor);
  });
  return map;
}

const enhanceSchedulePreviewRows = ({ preview, plantCode }) => {
  if (!preview || !Array.isArray(preview.header) || !Array.isArray(preview.rows)) return preview;
  const plantKey = String(plantCode || '').trim().toUpperCase();
  if (!plantKey) return preview;

  const header = preview.header.map((h) => String(h || '').trim());
  const headerKey = header.map((h) => h.toLowerCase().replace(/\s+/g, ' ').trim());

  const idxBlock = headerKey.findIndex((h) => h === 'block');
  const idxScheduled = headerKey.findIndex((h) => h === 'scheduled mw' || h.includes('scheduled'));
  const idxActual = headerKey.findIndex((h) => h === 'actual mw' || h.includes('actual'));
  const idxDevMw = headerKey.findIndex((h) => h === 'deviation mw' || h.includes('deviation mw'));
  const idxDevPct = headerKey.findIndex((h) => h === 'deviation %' || h.includes('deviation %'));
  const idxPenalty = headerKey.findIndex((h) => h === 'penalty rs' || h.includes('penalty'));

  if (idxScheduled === -1 || idxActual === -1) return preview;

  const cap = PLANT_CAPACITY_FALLBACK[plantKey] || 0;
  const plantState = PLANT_STATE_FALLBACK[plantKey] || '';
  const plantType = 'Solar';

  const nextRows = preview.rows.map((r) => {
    const row = Array.isArray(r) ? [...r] : [];
    const sched = Number(String(row[idxScheduled] ?? '').trim());
    const act = Number(String(row[idxActual] ?? '').trim());
    const schedOk = Number.isFinite(sched);
    const actOk = Number.isFinite(act);
    if (!schedOk || !actOk) return row;

    if (idxDevMw !== -1) {
      const existing = String(row[idxDevMw] ?? '').trim();
      if (!existing) row[idxDevMw] = String(act - sched);
    }
    if (idxDevPct !== -1) {
      const existing = String(row[idxDevPct] ?? '').trim();
      if (!existing && cap > 0) row[idxDevPct] = String(((act - sched) / cap) * 100);
    }
    if (idxPenalty !== -1) {
      const existing = String(row[idxPenalty] ?? '').trim();
      if (!existing && plantKey !== 'OSEPL') {
        const penalty = calculatePenaltyRs({
          scheduledMw: schedOk ? sched : null,
          actualMw: actOk ? act : null,
          capacityMw: cap,
          plantState,
          plantType,
        });
        if (penalty != null) row[idxPenalty] = String(penalty);
      }
    }
    if (idxBlock !== -1) {
      // Keep block as-is.
    }
    return row;
  });

  return { header, rows: nextRows };
};

function DsmPreviewTable({ payload, variant = 'default', editable = false, onCellChange }) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const columns = Array.isArray(payload?.columns) ? payload.columns : [];
  if (!rows.length || !columns.length) {
    return (
      <div className="text-sm text-muted-foreground">
        DSM preview is not available yet. Open Schedule Comparison and ensure Manual Edited values are available, then come back here.
      </div>
    );
  }

  const headerClass =
    variant === 'osepl'
      ? 'bg-sky-700 text-white'
      : variant === 'sirmour' || variant === 'multi'
        ? 'bg-green-700 text-white'
        : 'bg-muted';

  return (
    <div className="rounded-lg border border-border overflow-auto max-h-[360px]">
      <table className="min-w-full text-sm border-collapse">
        <thead className={`sticky top-0 ${headerClass}`}>
          <tr>
            {columns.map((col) => (
              <th
                key={col}
                className={`px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide border border-border ${
                  variant === 'sirmour' || variant === 'multi' || variant === 'osepl' ? 'text-white' : 'text-muted-foreground'
                }`}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => {
            const rowClass =
              variant === 'multi'
                ? idx === 0
                  ? 'bg-orange-200'
                  : idx === 1
                    ? 'bg-yellow-200'
                    : 'bg-slate-200'
                : variant === 'sirmour'
                  ? 'bg-orange-200'
                  : 'bg-background';
            return (
              <tr key={idx} className={`${rowClass}`}>
              {columns.map((col) => (
                <td key={col} className="px-3 py-2 whitespace-nowrap border border-border">
                  {editable ? (
                    <input
                      className="w-full bg-transparent text-foreground outline-none"
                      value={String(row?.[col] ?? '')}
                      onChange={(e) => onCellChange?.(idx, col, e.target.value)}
                    />
                  ) : (
                    (row?.[col] ?? '')
                  )}
                </td>
              ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const getDsmPreviewVariant = (plantCode) => {
  const plant = String(plantCode || '').trim().toUpperCase();
  if (plant === 'OSEPL') return 'osepl';
  if (['KASIPET', 'BHUPALPALLY', 'KOTHAGUDEM'].includes(plant)) return 'multi';
  if (plant === 'SIRMOUR') return 'sirmour';
  return 'default';
};

const TELANGANA_DSM_PLANTS = Object.freeze(['KASIPET', 'BHUPALPALLY', 'KOTHAGUDEM']);
const isTelanganaDsmPlant = (plantCode) => TELANGANA_DSM_PLANTS.includes(String(plantCode || '').trim().toUpperCase());

export function EmailScheduler() {
  const currentUser = useMemo(() => getCurrentUserFromStorage(), []);
  const role = useMemo(() => deriveRole(currentUser), [currentUser]);
  const isAdmin = role === 'admin';
  const schedulerBaseUrl = useMemo(() => emailSchedulerBase(), []);
  const pageScrollRef = useRef(null);
  const pageTopRef = useRef(null);
  const dataContext = useData();
  const sharedData = dataContext?.sharedData;

  const [loadingMeta, setLoadingMeta] = useState(true);
  const [metaError, setMetaError] = useState('');
  const [plants, setPlants] = useState([]);
  const [templatesByGroup, setTemplatesByGroup] = useState({});
  const [metaSourceUrl, setMetaSourceUrl] = useState('');
  const [visiblePlantSection, setVisiblePlantSection] = useState(null);
  const [dispatcherStatus, setDispatcherStatus] = useState(null);
  const [plantAutoEmailEnabled, setPlantAutoEmailEnabled] = useState({});
  const [loadingSettings, setLoadingSettings] = useState(false);

  const [templateId, setTemplateId] = useState('');
  const [plantCode, setPlantCode] = useState('');
  const [scheduleDate, setScheduleDate] = useState(() => getIstTodayDateKey());
  const [reportDate, setReportDate] = useState(() => getIstTodayDateKey());
  const [scheduleTime, setScheduleTime] = useState(() => getIstNowTimeKey());
  const [amPm, setAmPm] = useState('AM');
  const [fromEmail, setFromEmail] = useState('code.vedanjaypower@gmail.com');
  const [toEmail, setToEmail] = useState('');
  const [ccEmail, setCcEmail] = useState('');
  const [employeeName, setEmployeeName] = useState(DEFAULT_EMAIL_SIGNATURE_NAME);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  // Custom mode ON = user editable fields.
  // Custom mode OFF = template-controlled + locked fields.
  const [customMode, setCustomMode] = useState(true);
  const [autoSend, setAutoSend] = useState(false);

  const [scheduleAttachmentInfo, setScheduleAttachmentInfo] = useState(null);
  const [scheduleAttachmentFile, setScheduleAttachmentFile] = useState(null);
  const [scheduleAttachmentPreview, setScheduleAttachmentPreview] = useState(null);
  const [scheduleAttachmentS3Status, setScheduleAttachmentS3Status] = useState(''); // '', 'not_found'
  const [extraAttachmentFile, setExtraAttachmentFile] = useState(null);
  const [portalIssueImage, setPortalIssueImage] = useState(null);
  const [portalIssueMode, setPortalIssueMode] = useState(false);
  const [portalIssuePlants, setPortalIssuePlants] = useState(() => new Set());

  const [isDsmEditing, setIsDsmEditing] = useState(false);
  const [dsmSourceMode, setDsmSourceMode] = useState('s3'); // s3 | local
  const [dsmEditedPayload, setDsmEditedPayload] = useState(null);
  const [dsmS3Payload, setDsmS3Payload] = useState(null);
  const dsmEditKey = useMemo(() => `${String(plantCode || '').trim().toUpperCase()}|${String(reportDate || '').trim()}|${String(templateId || '').trim()}`, [plantCode, reportDate, templateId]);
  const lastDsmEditKeyRef = useRef(null);
  const dsmS3FetchSeqRef = useRef(0);

  const PORTAL_ISSUE_PLANT_OPTIONS = useMemo(
    () => ['BHUPALPALLY', 'KASIPET', 'KOTHAGUDEM', 'ANJANGAON', 'OSEPL', 'SIRMOUR'],
    []
  );

  const templateIndex = useMemo(() => {
    const index = new Map();
    Object.values(templatesByGroup || {}).forEach((items) => {
      (Array.isArray(items) ? items : []).forEach((tpl) => {
        if (tpl?.id) index.set(String(tpl.id), tpl);
      });
    });
    return index;
  }, [templatesByGroup]);

  const selectedTemplate = useMemo(() => templateIndex.get(String(templateId || '')) || null, [templateIndex, templateId]);
  const templateCategory = useMemo(() => deriveTemplateCategory(selectedTemplate), [selectedTemplate]);
  const isDsmTemplate = templateCategory.toLowerCase().includes('dsm');

  const resetSchedulerForm = useCallback(() => {
    setPortalIssueMode(false);
    setPortalIssueImage(null);
    setPortalIssuePlants(new Set());
    setPortalIssueSubjectTouched(false);
    setPortalIssueBodyTouched(false);

    setPlantCode('');
    setTemplateId('');
    setReportDate(getIstTodayDateKey());

    setToEmail('');
    setCcEmail('');
    setSubject('');
    setBody('');

    setScheduleAttachmentInfo(null);
    setScheduleAttachmentFile(null);
    setScheduleAttachmentPreview(null);
    setExtraAttachmentFile(null);
  }, []);

  const formatDsmMonthKey = useCallback((dateKey) => {
    try {
      const raw = String(dateKey || '').trim();
      const dt = new Date(`${raw}T00:00:00Z`);
      const month = dt.toLocaleString('en-US', { month: 'short', timeZone: 'Asia/Kolkata' });
      const yy = dt.toLocaleString('en-CA', { year: '2-digit', timeZone: 'Asia/Kolkata' });
      return `${month}-${yy}`;
    } catch {
      return '';
    }
  }, []);

  const defaultDsmPayload = useMemo(() => {
    if (!isDsmTemplate) return { columns: [], rows: [] };
    const dateKey = String(reportDate || scheduleDate || '').trim();
    const plantKey = String(plantCode || '').trim().toUpperCase();
    const monthKey = formatDsmMonthKey(dateKey);

    if (plantKey === 'OSEPL') {
      const columns = [
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
      ];
      return {
        columns,
        rows: [
          {
            From: dateKey,
            Month: monthKey,
            Project: 'ESSEL',
            'Installed Capacity': Number(PLANT_CAPACITY_FALLBACK.OSEPL || 0).toFixed(0),
            'SCADA availability %': '100%',
            'Generation(kWh)': '0',
            'Scheduled unit*PPA': '0',
            Payable: '0',
            Receivable: '0',
            'DSM Penalty (Rs.)': '0',
            'SCADA Adjusted DSM': '0',
            PPA: '0.00',
          },
        ],
        variant: getDsmPreviewVariant(plantKey),
      };
    }

    if (plantKey === 'SIRMOUR') {
      const columns = ['From', 'To', 'Project', 'Installed Capacity (MW)', 'Generation (kWh)', 'DSM Penalty (Rs.)', 'Paisa / kWh', 'Net Revenue', '%Impact'];
      return {
        columns,
        rows: [
          {
            From: dateKey,
            To: dateKey,
            Project: 'Sirmour_Schedule',
            'Installed Capacity (MW)': Number(PLANT_CAPACITY_FALLBACK.SIRMOUR || 0).toFixed(1),
            'Generation (kWh)': '0',
            'DSM Penalty (Rs.)': '0',
            'Paisa / kWh': '--',
            'Net Revenue': '--',
            '%Impact': '--',
          },
        ],
        variant: getDsmPreviewVariant(plantKey),
      };
    }

    // Telangana / multi site daily summary format (single-row; rows are in ScheduleComparison when available).
    const columns = [
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
    ];

    const plantsForPreview = isTelanganaDsmPlant(plantKey) ? TELANGANA_DSM_PLANTS : [plantKey];
    return {
      columns,
      rows: plantsForPreview.map((p) => {
        const cap = Number(PLANT_CAPACITY_FALLBACK[p] || 0);
        return {
          Date: dateKey,
          To: dateKey,
          Month: monthKey,
          Project: p || '',
          'Installed Capacity (MW)': cap ? cap.toFixed(0) : '0',
          'Generation (kWh)': '0',
          'DSM Penalty (Rs.) As per SCADA Availability': '0',
          'DSM Penalty (Rs.) As Maintenance Information': '0',
          'Paisa/kWh SCADA Availability': '--',
          'Paisa/kWh Maintenance Information': '--',
          'SCADA Availability(%)': '100%',
        };
      }),
      variant: getDsmPreviewVariant(plantKey),
    };
  }, [isDsmTemplate, plantCode, reportDate, scheduleDate, formatDsmMonthKey]);

  const buildManualEditedDsmPayloadFromS3 = useCallback(async () => {
    const dateKey = String(reportDate || scheduleDate || '').trim();
    const plantKey = String(plantCode || '').trim().toUpperCase();
    if (!dateKey || !plantKey) return null;

    const buildPayloadFromScheduleAndMeter = async ({ scheduleMap, plantKey: payloadPlantKey }) => {
      const resolvedPlantKey = String(payloadPlantKey || '').trim().toUpperCase();
      if (!resolvedPlantKey) return null;
      if (!scheduleMap || scheduleMap.size === 0) return null;

      // Meter (actuals)
      const meterPrefixes = [
        `raw/vedanjay/${resolvedPlantKey}/${dateKey}/metered_data/`,
        ...(resolvedPlantKey === 'ANJANGAON' ? [`raw/vedanjay/ANJANGOAN/${dateKey}/metered_data/`] : []),
        `generated/vedanjay/${resolvedPlantKey}/outputs/${dateKey}/meter/`,
        `outputs/${dateKey}/meter/`,
        `${dateKey}/meter/`,
      ];
      const meterObjects = await listS3ObjectsAcrossPrefixes(meterPrefixes, undefined, { user: currentUser });
      const meterCsvs = (meterObjects || []).filter((o) => String(o?.key || '').toLowerCase().endsWith('.csv'));
      if (!meterCsvs.length) return null;
      const sortLatestFirst = (items) =>
        [...items].sort((a, b) => {
          const aTime = Date.parse(String(a?.lastModified || a?.last_modified || ''));
          const bTime = Date.parse(String(b?.lastModified || b?.last_modified || ''));
          const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
          if (timeDiff !== 0) return timeDiff;
          return String(b?.key || '').localeCompare(String(a?.key || ''));
        });

      const findLatestMeterCsv = (objects) => {
        if (!Array.isArray(objects) || objects.length === 0) return null;
        const candidates = objects.filter((o) => {
          const key = String(o?.key || '').toLowerCase();
          if (!key.endsWith('.csv')) return false;
          return key.includes('/meter/') || key.includes('/metered_data/');
        });
        return sortLatestFirst(candidates)[0] || null;
      };

      const meterCandidates = sortLatestFirst(meterCsvs);
      const latestMeter = meterCandidates[0] || findLatestMeterCsv(meterCsvs);
      if (!latestMeter?.key) return null;

      const meterText = await fetchTextFromS3(latestMeter.key);
      const meterMap = parseMeterSeriesMap(meterText);
      if (!meterMap || meterMap.size === 0) return null;

      const BLOCK_HOURS = 0.25;
      const KWH_PER_MWH = 1000;
      const cap = Number(PLANT_CAPACITY_FALLBACK[resolvedPlantKey] || 0);
      const plantState = String(PLANT_STATE_FALLBACK[resolvedPlantKey] || '').trim();
      const plantType = 'Solar';
      const monthKey = formatDsmMonthKey(dateKey);
      const isBhupalpallyDsm = resolvedPlantKey === 'BHUPALPALLY';
      const blockLimit = isBhupalpallyDsm && dateKey === getIstTodayDateKey()
        ? getCurrentIstBlock()
        : TOTAL_BLOCKS;
      const dsmBlocks = Array.from({ length: blockLimit }, (_, i) => i + 1);
      const getScheduleMwForDsm = (block) => {
        const sched = Number(scheduleMap.get(block));
        if (!Number.isFinite(sched)) return null;
        return isBhupalpallyDsm ? Math.round(sched * 100) / 100 : sched;
      };

      const generationKwh = dsmBlocks.reduce((sum, block) => {
        const actualMw = Number(meterMap.get(block));
        if (!Number.isFinite(actualMw)) return sum;
        return sum + (actualMw * BLOCK_HOURS * KWH_PER_MWH);
      }, 0);

      if (resolvedPlantKey === 'OSEPL') {
        const PPA_RATE = 9.27;
        const scheduledUnitPpaBlockLimit = dateKey === getIstTodayDateKey() ? getCurrentIstBlock() : TOTAL_BLOCKS;
        const scheduledKwh = Array.from({ length: scheduledUnitPpaBlockLimit }, (_, i) => i + 1).reduce((sum, block) => {
          const sched = Number(scheduleMap.get(block));
          if (!Number.isFinite(sched)) return sum;
          const roundedSched = Math.round((sched + Number.EPSILON) * 100) / 100;
          return sum + (roundedSched * BLOCK_HOURS * KWH_PER_MWH);
        }, 0);

        const totals = Array.from({ length: TOTAL_BLOCKS }, (_, i) => i + 1).reduce((acc, block) => {
          const sched = Number(scheduleMap.get(block));
          const act = Number(meterMap.get(block));
          if (!Number.isFinite(sched) || !Number.isFinite(act)) return acc;
          const oseplCapacityMw = cap > 0 ? cap : 0;
          const settlement = calculateOseplSettlement(sched, act, oseplCapacityMw);
          const office = calculateOseplOfficePayableReceivable(sched, act, oseplCapacityMw);
          if (office) {
            acc.payable += Number(office.payableRs || 0);
            acc.receivable += Number(office.receivableRs || 0);
          }
          if (settlement) acc.final += Number(settlement.finalPenaltyRs || 0);
          return acc;
        }, { payable: 0, receivable: 0, final: 0 });

        const row = {
          From: dateKey,
          Month: monthKey,
          Project: 'ESSEL',
          'Installed Capacity': Number(cap || 0).toFixed(0),
          'SCADA availability %': '100%',
          'Generation(kWh)': Number(generationKwh || 0).toFixed(0),
          'Scheduled unit*PPA': Number((scheduledKwh * PPA_RATE) || 0).toFixed(0),
          Payable: Number(totals.payable || 0).toFixed(0),
          Receivable: Number(totals.receivable || 0).toFixed(0),
          'DSM Penalty (Rs.)': Number(totals.final || 0).toFixed(0),
          'SCADA Adjusted DSM': Number(totals.final || 0).toFixed(0),
          PPA: Number(PPA_RATE || 0).toFixed(2),
        };
        return { columns: Object.keys(row), rows: [row], variant: getDsmPreviewVariant(resolvedPlantKey) };
      }

      if (resolvedPlantKey === 'SIRMOUR') {
        const ppaRateRsPerKwh = getPpaRateRsPerKwh({ siteCode: resolvedPlantKey });
        const dsmPenaltyMaintenanceRs = dsmBlocks.reduce((sum, block) => {
          const sched = getScheduleMwForDsm(block);
          const act = Number(meterMap.get(block));
          if (!Number.isFinite(sched) || !Number.isFinite(act)) return sum;
          const penalty = calculatePenaltyRs({ scheduledMw: sched, actualMw: act, capacityMw: cap, plantState, plantType });
          return Number.isFinite(penalty) ? sum + penalty : sum;
        }, 0);
        const paisaPerKwh = generationKwh > 0 ? ((dsmPenaltyMaintenanceRs / generationKwh) * 100).toFixed(2) : '--';
        const netRevenue = Number.isFinite(ppaRateRsPerKwh) ? generationKwh * ppaRateRsPerKwh : null;
        const impactPct = Number.isFinite(netRevenue) && netRevenue > 0 ? (dsmPenaltyMaintenanceRs / netRevenue) * 100 : null;
        const columns = ['From', 'To', 'Project', 'Installed Capacity (MW)', 'Generation (kWh)', 'DSM Penalty (Rs.)', 'Paisa / kWh', 'Net Revenue', '%Impact'];
        const row = {
          From: dateKey,
          To: dateKey,
          Project: 'Sirmour_Schedule',
          'Installed Capacity (MW)': Number(cap || 0).toFixed(1),
          'Generation (kWh)': Number(generationKwh || 0).toFixed(0),
          'DSM Penalty (Rs.)': Number(dsmPenaltyMaintenanceRs || 0).toFixed(0),
          'Paisa / kWh': paisaPerKwh,
          'Net Revenue': Number.isFinite(netRevenue) ? netRevenue.toFixed(2) : '--',
          '%Impact': Number.isFinite(impactPct) ? `${impactPct.toFixed(2)}%` : '--',
        };
        return { columns, rows: [row], variant: getDsmPreviewVariant(resolvedPlantKey) };
      }

      const dsmPenaltyMaintenanceRs = dsmBlocks.reduce((sum, block) => {
        const sched = getScheduleMwForDsm(block);
        const act = Number(meterMap.get(block));
        if (!Number.isFinite(sched) || !Number.isFinite(act)) return sum;
        const penalty = calculatePenaltyRs({ scheduledMw: sched, actualMw: act, capacityMw: cap, plantState, plantType });
        return Number.isFinite(penalty) ? sum + penalty : sum;
      }, 0);
      const paisaPerKwh = generationKwh > 0 ? ((dsmPenaltyMaintenanceRs / generationKwh) * 100).toFixed(2) : '--';

      const columns = [
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
      ];
      const row = {
        Date: dateKey,
        To: dateKey,
        Month: monthKey,
        Project: resolvedPlantKey,
        'Installed Capacity (MW)': Number(cap || 0).toFixed(0),
        'Generation (kWh)': Number(generationKwh || 0).toFixed(0),
        'DSM Penalty (Rs.) As per SCADA Availability': Number(dsmPenaltyMaintenanceRs || 0).toFixed(0),
        'DSM Penalty (Rs.) As Maintenance Information': Number(dsmPenaltyMaintenanceRs || 0).toFixed(0),
        'Paisa/kWh SCADA Availability': paisaPerKwh,
        'Paisa/kWh Maintenance Information': paisaPerKwh,
        'SCADA Availability(%)': '100%',
      };
      return { columns, rows: [row], variant: getDsmPreviewVariant(resolvedPlantKey) };
    };

    // If user uploaded a local schedule file, use that schedule for DSM preview.
    if (scheduleAttachmentFile) {
      const text = await readUploadedTabularFile(scheduleAttachmentFile);
      const map = parseScheduleSeriesMap(text);
      return buildPayloadFromScheduleAndMeter({ scheduleMap: map, plantKey });
    }

    // Otherwise use Manual edited schedule from S3 (edited_frozen.csv).
    // Special case: Telangana DSM is a single 3-plant summary report.
    const targetPlants = isTelanganaDsmPlant(plantKey) ? TELANGANA_DSM_PLANTS : [plantKey];

    const perPlantPayloads = [];
    for (const targetPlant of targetPlants) {
      const frozenPrefix = `frozenschedules/vedanjay/${targetPlant}/${dateKey}/`;
      const frozenObjects = await listS3ObjectsAcrossPrefixes([frozenPrefix], undefined, { user: currentUser });
      const frozenByKey = new Set((frozenObjects || []).map((o) => String(o?.key || '').trim()).filter(Boolean));
      const editedKey = `${frozenPrefix}edited_frozen.csv`;
      if (!frozenByKey.has(editedKey)) continue;
      const editedText = await fetchTextFromS3(editedKey);
      const scheduleMap = parseScheduleSeriesMap(editedText);
      const payload = await buildPayloadFromScheduleAndMeter({ scheduleMap, plantKey: targetPlant });
      if (payload?.rows?.length) perPlantPayloads.push(payload);
    }

    if (!perPlantPayloads.length) return null;
    if (!isTelanganaDsmPlant(plantKey)) return perPlantPayloads[0];

    const columns = perPlantPayloads[0]?.columns || [];
    const monthKey = formatDsmMonthKey(dateKey);
    const rowByPlant = new Map(
      perPlantPayloads
        .flatMap((p) => (Array.isArray(p?.rows) ? p.rows : []))
        .map((row) => [String(row?.Project || '').trim().toUpperCase(), row])
        .filter(([k]) => k)
    );

    const makeEmptyRow = (projectCode) => {
      const cap = Number(PLANT_CAPACITY_FALLBACK[projectCode] || 0);
      return {
        Date: dateKey,
        To: dateKey,
        Month: monthKey,
        Project: projectCode,
        'Installed Capacity (MW)': cap ? cap.toFixed(0) : '0',
        'Generation (kWh)': '0',
        'DSM Penalty (Rs.) As per SCADA Availability': '0',
        'DSM Penalty (Rs.) As Maintenance Information': '0',
        'Paisa/kWh SCADA Availability': '--',
        'Paisa/kWh Maintenance Information': '--',
        'SCADA Availability(%)': '100%',
      };
    };

    const rows = TELANGANA_DSM_PLANTS.map((p) => rowByPlant.get(p) || makeEmptyRow(p));
    return { columns, rows, variant: 'multi' };
  }, [plantCode, reportDate, scheduleDate, currentUser, formatDsmMonthKey, scheduleAttachmentFile]);

  useEffect(() => {
    if (!isDsmTemplate) return;
    if (dsmSourceMode !== 's3') return;
    const dateKey = String(reportDate || scheduleDate || '').trim();
    const plantKey = String(plantCode || '').trim().toUpperCase();
    if (!dateKey || !plantKey) return;

    const seq = ++dsmS3FetchSeqRef.current;
    (async () => {
      try {
        const payload = await buildManualEditedDsmPayloadFromS3();
        if (seq !== dsmS3FetchSeqRef.current) return;
        setDsmS3Payload(payload);
      } catch {
        if (seq !== dsmS3FetchSeqRef.current) return;
        setDsmS3Payload(null);
      }
    })();
  }, [isDsmTemplate, dsmSourceMode, plantCode, reportDate, scheduleDate, buildManualEditedDsmPayloadFromS3]);

  const effectiveS3DsmPayload = useMemo(() => {
    if (!isDsmTemplate) return { columns: [], rows: [] };
    return dsmS3Payload || defaultDsmPayload;
  }, [isDsmTemplate, dsmS3Payload, defaultDsmPayload]);

  useEffect(() => {
    if (!isDsmTemplate) {
      lastDsmEditKeyRef.current = null;
      setIsDsmEditing(false);
      setDsmSourceMode('s3');
      setDsmEditedPayload(null);
      setDsmS3Payload(null);
      return;
    }

    // Reset edits when plant/date/template changes (new preview context).
    if (lastDsmEditKeyRef.current !== dsmEditKey) {
      lastDsmEditKeyRef.current = dsmEditKey;
      setIsDsmEditing(false);
      setDsmSourceMode('s3');
      setDsmEditedPayload(effectiveS3DsmPayload);
    }
  }, [isDsmTemplate, dsmEditKey, effectiveS3DsmPayload]);

  useEffect(() => {
    if (!isDsmTemplate) return;
    // If the underlying payload changes (e.g. user refreshed comparison data) while not editing,
    // keep the preview in sync.
    if (dsmSourceMode === 's3' && !isDsmEditing) setDsmEditedPayload(effectiveS3DsmPayload);
  }, [isDsmTemplate, isDsmEditing, dsmSourceMode, effectiveS3DsmPayload]);

  const effectiveDsmPayload = useMemo(() => {
    if (!isDsmTemplate) return { columns: [], rows: [] };
    if (dsmSourceMode === 'local') return dsmEditedPayload || defaultDsmPayload;
    return effectiveS3DsmPayload;
  }, [isDsmTemplate, dsmSourceMode, dsmEditedPayload, defaultDsmPayload, effectiveS3DsmPayload]);

  const onDsmCellChange = useCallback((rowIndex, col, value) => {
    setDsmSourceMode('local');
    setDsmEditedPayload((prev) => {
      const base = prev || { columns: [], rows: [] };
      const columns = Array.isArray(base.columns) ? base.columns : [];
      const rows = Array.isArray(base.rows) ? base.rows : [];
      if (!columns.includes(col)) return base;
      if (rowIndex < 0 || rowIndex >= rows.length) return base;
      const nextRows = rows.map((r, idx) => (idx === rowIndex ? { ...(r || {}), [col]: value } : r));
      return { ...base, columns, rows: nextRows };
    });
  }, []);

  const dsmPreviewSourceLabel = useMemo(() => {
    if (!isDsmTemplate) return '';
    if (dsmSourceMode === 'local') return 'Source: Edited in Email Scheduler';
    if (scheduleAttachmentFile?.name) return `Source: Local schedule (${scheduleAttachmentFile.name}) + Meter from S3`;
    return 'Source: S3 Manual Edited schedule + Meter from S3';
  }, [isDsmTemplate, dsmSourceMode, scheduleAttachmentFile]);
  const needsScheduleAttachment = useMemo(() => {
    if (!selectedTemplate) return false;
    const cat = templateCategory.toLowerCase();
    if (cat.includes('portal')) return false;
    if (cat.includes('dsm')) return false;
    return cat.includes('day') || cat.includes('intra') || String(selectedTemplate?.requires_schedule_attachment || '').toLowerCase() === 'true';
  }, [selectedTemplate, templateCategory]);

  const visiblePlants = useMemo(
    () => filterPlantsForUser(plants, currentUser),
    [plants, currentUser]
  );
  const activePlants = useMemo(() => visiblePlants.filter((p) => p?.active), [visiblePlants]);
  const inactivePlants = useMemo(() => visiblePlants.filter((p) => !p?.active), [visiblePlants]);

  const templatesByGroupForPlant = useMemo(() => {
    const selectedPlant = String(plantCode || '').trim();
    if (!selectedPlant) return templatesByGroup || {};

    const out = {};
    Object.entries(templatesByGroup || {}).forEach(([group, items]) => {
      const filtered = (Array.isArray(items) ? items : []).filter(
        (tpl) => String(tpl?.plant_code || '').trim() === selectedPlant
      );
      if (filtered.length) out[group] = filtered;
    });
    return out;
  }, [templatesByGroup, plantCode]);

  const templatesByGroupForPlantFiltered = useMemo(() => {
    const selectedPlant = String(plantCode || '').trim().toUpperCase();
    const allowIntraday = selectedPlant === 'SIRMOUR';
    const allowedSuffixes = ['_da0', '_da1', '_dsm'];

    const out = {};
    const seen = new Set();

    Object.entries(templatesByGroupForPlant || {}).forEach(([group, items]) => {
      const filtered = (Array.isArray(items) ? items : []).filter((tpl) => {
        const id = String(tpl?.id || '').trim();
        if (!id) return false;
        const idLower = id.toLowerCase();
        const ok =
          allowedSuffixes.some((s) => idLower.endsWith(s)) ||
          (allowIntraday && idLower === 'sirmour_intraday');
        if (!ok) return false;
        if (seen.has(idLower)) return false;
        seen.add(idLower);
        return true;
      });
      if (filtered.length) out[group] = filtered;
    });

    return out;
  }, [templatesByGroupForPlant, plantCode]);

  const fileTypeDropdownGroups = useMemo(() => {
    const selectedPlant = String(plantCode || '').trim().toUpperCase();
    const allowIntraday = selectedPlant === 'SIRMOUR';

    const allTemplates = Object.values(templatesByGroupForPlantFiltered || {}).flatMap((items) =>
      Array.isArray(items) ? items : []
    );

    const dayAhead = [];
    const dsm = [];
    const seen = new Set();

    allTemplates.forEach((tpl) => {
      const id = String(tpl?.id || '').trim();
      if (!id) return;
      const key = id.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);

      if (key.endsWith('_dsm')) {
        dsm.push(tpl);
        return;
      }

      if (key.endsWith('_da0') || key.endsWith('_da1') || (allowIntraday && key === 'sirmour_intraday')) {
        dayAhead.push(tpl);
      }
    });

    const out = {};
    if (dayAhead.length) out['Day-Ahead'] = dayAhead;
    if (dsm.length) out['DSM'] = dsm;
    return out;
  }, [templatesByGroupForPlantFiltered, plantCode]);

  const fetchMetadata = useCallback(
    async ({ silent = false } = {}) => {
      setLoadingMeta(true);
      setMetaError('');
      try {
        const response = await fetch('/api/email-scheduler/metadata', {
          headers: {
            [ROLE_HEADER]: role,
            [USER_HEADER]: String(currentUser?.username || currentUser?.empId || '').trim(),
          },
        });
        if (!response.ok) throw new Error('Scheduler metadata is unavailable right now.');
        const data = await response.json();
        setPlants(Array.isArray(data.plants) ? data.plants : []);
        setTemplatesByGroup(sanitizeTemplatesForRole(data.templates || {}, role));
        setMetaSourceUrl(String(data.source_url || '').trim());
        if (!silent) toast.success('Metadata refreshed');
        return { ok: true, data };
      } catch (error) {
        setMetaError(error?.message || 'Unable to load scheduler metadata.');
        if (!silent) toast.error(error?.message || 'Unable to refresh metadata');
        return { ok: false, data: null };
      } finally {
        setLoadingMeta(false);
      }
    },
    [role, currentUser]
  );

  useEffect(() => {
    fetchMetadata({ silent: true });
  }, [fetchMetadata]);

  const fetchDispatcherStatus = useCallback(async () => {
    try {
      const response = await fetch(`${schedulerBaseUrl}/dispatcher-status`, {
        headers: {
          [ROLE_HEADER]: role,
          [USER_HEADER]: String(currentUser?.username || currentUser?.empId || '').trim(),
        },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return;
      setDispatcherStatus(data);
    } catch {
      // ignore
    }
  }, [schedulerBaseUrl, role, currentUser]);

  useEffect(() => {
    fetchDispatcherStatus();
    const id = setInterval(() => fetchDispatcherStatus(), 15000);
    return () => clearInterval(id);
  }, [fetchDispatcherStatus]);

  const fetchSchedulerSettings = useCallback(async () => {
    setLoadingSettings(true);
    try {
      const response = await fetch(`${schedulerBaseUrl}/settings`, {
        headers: {
          [ROLE_HEADER]: role,
          [USER_HEADER]: String(currentUser?.username || currentUser?.empId || '').trim(),
        },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return;
      setPlantAutoEmailEnabled(
        data?.plant_auto_email_enabled && typeof data.plant_auto_email_enabled === 'object'
          ? data.plant_auto_email_enabled
          : {}
      );
    } catch {
      // ignore
    } finally {
      setLoadingSettings(false);
    }
  }, [schedulerBaseUrl, role, currentUser]);

  useEffect(() => {
    fetchSchedulerSettings();
  }, [fetchSchedulerSettings]);

  const isPlantAutoEmailEnabled = useCallback(
    (plantCodeValue) => {
      const code = normalizePlantCodeKey(plantCodeValue);
      if (!code) return true;
      return plantAutoEmailEnabled?.[code] !== false;
    },
    [plantAutoEmailEnabled]
  );

  const updatePlantAutoEmailEnabled = useCallback(async (plantCodeValue, next) => {
    const code = normalizePlantCodeKey(plantCodeValue);
    if (!code) return;
    const value = Boolean(next);
    const nextMap = {
      ...(plantAutoEmailEnabled || {}),
      [code]: value,
    };
    setPlantAutoEmailEnabled(nextMap);
    try {
      const response = await fetch(`${schedulerBaseUrl}/settings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [ROLE_HEADER]: role,
          [USER_HEADER]: String(currentUser?.username || currentUser?.empId || '').trim(),
        },
        body: JSON.stringify({ plant_auto_email_enabled: nextMap }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.detail || 'Failed to update plant auto email setting');
      setPlantAutoEmailEnabled(
        data?.plant_auto_email_enabled && typeof data.plant_auto_email_enabled === 'object'
          ? data.plant_auto_email_enabled
          : nextMap
      );
      toast.success(`${code} cron auto email is ${value ? 'ON' : 'OFF'}`);
    } catch (error) {
      toast.error(error?.message || 'Failed to update plant auto email setting');
      fetchSchedulerSettings();
    }
  }, [schedulerBaseUrl, role, currentUser, fetchSchedulerSettings, plantAutoEmailEnabled]);

  useEffect(() => {
    // Always default Date to "today" in IST on first render.
    setScheduleDate((prev) => prev || getIstTodayDateKey());
    setReportDate((prev) => prev || getIstTodayDateKey());
  }, []);

  useEffect(() => {
    // Default time to "now" (IST) on first render.
    setScheduleTime((prev) => prev || getIstNowTimeKey());
  }, []);

  const lastAppliedTemplateIdRef = useRef('');
  const lastAutoSubjectRef = useRef('');

  useEffect(() => {
    if (!selectedTemplate) return;

    // When custom mode is OFF, template controls the fields.
    // When custom mode is ON, changing Mail Type still refreshes template text.
    const vars = buildTemplateVars(reportDate || scheduleDate);
    const reportSubject = buildReportEmailSubject({
      template: selectedTemplate,
      templateId,
      category: templateCategory,
      plantCode,
      dateKey: reportDate || scheduleDate,
    });
    const nextSubjectRaw = reportSubject || applyTemplateVars(String(selectedTemplate?.subject || '').trim(), vars);
    const nextBodyRaw = applyTemplateVars(String(selectedTemplate?.body || '').trim(), vars);
    const nextDefaultTo = String(selectedTemplate?.default_to || '').trim();
    const nextDefaultCc = String(selectedTemplate?.default_cc || '').trim();
    const selectedTemplateId = String(selectedTemplate?.id || templateId || '').trim();
    const mailTypeChanged = Boolean(selectedTemplateId && lastAppliedTemplateIdRef.current !== selectedTemplateId);

    // Always keep a sane default From address (do not overwrite if user already set one).
    if (!String(fromEmail || '').trim()) setFromEmail('code.vedanjaypower@gmail.com');

    // Always auto-fill To/CC once (when empty) from template defaults, even in Custom mode.
    // This avoids placeholders for interns/employees while still not overwriting edits.
    if (!String(toEmail || '').trim() && nextDefaultTo) setToEmail(nextDefaultTo);
    if (!String(ccEmail || '').trim() && nextDefaultCc) setCcEmail(nextDefaultCc);

    const subjectText = String(subject || '').trim();
    const subjectIsAutoManaged = Boolean(reportSubject && (!subjectText || subjectText === lastAutoSubjectRef.current));
    const shouldHydrate = mailTypeChanged || !customMode || subjectIsAutoManaged || (!subjectText && !String(body || '').trim());
    if (!shouldHydrate) return;
    if (mailTypeChanged) lastAppliedTemplateIdRef.current = selectedTemplateId;

    if (!customMode) {
      setToEmail(nextDefaultTo);
      setCcEmail(nextDefaultCc);
    }

    if (isAdmin) {
      lastAutoSubjectRef.current = nextSubjectRaw;
      setSubject(nextSubjectRaw);
      setBody(nextBodyRaw);
    } else {
      const testingSubject = ensureTestingSubject(nextSubjectRaw);
      lastAutoSubjectRef.current = testingSubject;
      setSubject(testingSubject);
      setBody(ensureTestingBody(nextBodyRaw));
    }
  }, [selectedTemplate, templateId, templateCategory, plantCode, customMode, isAdmin, reportDate, scheduleDate, subject, body, fromEmail, toEmail, ccEmail]);

  const [portalIssueSubjectTouched, setPortalIssueSubjectTouched] = useState(false);
  const [portalIssueBodyTouched, setPortalIssueBodyTouched] = useState(false);

  useEffect(() => {
    // Portal issue mode affects attachment UX.
    if (!portalIssueMode) {
      setPortalIssueImage(null);
      setPortalIssuePlants(new Set());
      setPortalIssueSubjectTouched(false);
      setPortalIssueBodyTouched(false);
      return;
    }
    setScheduleAttachmentFile(null);
    setScheduleAttachmentInfo(null);
  }, [portalIssueMode]);

  const portalIssueSelectedPlants = useMemo(
    () => Array.from(portalIssuePlants || []).map((p) => String(p || '').trim().toUpperCase()).filter(Boolean).sort(),
    [portalIssuePlants]
  );

  const portalIssueSubject = useMemo(() => {
    const date = formatDdMmYyyy(reportDate || scheduleDate);
    return `REMC-TL Portal Issue for ${date}`;
  }, [reportDate, scheduleDate]);

  const portalIssueBody = useMemo(() => {
    const date = formatDdMmYyyy(reportDate || scheduleDate);
    const lines = [];
    lines.push('Dear Sir/Mam,');
    lines.push('');
    lines.push(`The REMC-TL Portal is not working properly for the date ${date}. So, we are unable to submit the DAYAHEAD schedule. Kindly do the needful and resolve the issue as soon as possible.`);
    lines.push('');
    lines.push('We are attaching Dayahead Revision for the below mentioned plants:');
    lines.push('');
    if (portalIssueSelectedPlants.length) {
      portalIssueSelectedPlants.forEach((p, idx) => {
        lines.push(`${idx + 1}. ${p}`);
      });
    } else {
      lines.push('1. (select plants)');
    }
    lines.push('');
    lines.push('Thanks & Regards');
    lines.push('');
    return lines.join('\n');
  }, [reportDate, scheduleDate, portalIssueSelectedPlants]);

  useEffect(() => {
    if (!portalIssueMode) return;
    // Force Mail Type + Suggested timing semantics via controlled values.
    setTemplateId('portal_issue');
    setPlantCode('PORTAL_ISSUE');
    // Portal issue should always be editable (custom mode ON), but still auto-generate content
    // until the user edits it manually.
    setCustomMode(true);
    setSubject((prev) => (portalIssueSubjectTouched && String(prev || '').trim() ? prev : portalIssueSubject));
    setBody((prev) => (portalIssueBodyTouched && String(prev || '').trim() ? prev : portalIssueBody));
  }, [portalIssueMode, portalIssueSubject, portalIssueBody, portalIssueSubjectTouched, portalIssueBodyTouched]);

  useEffect(() => {
    setScheduleAttachmentInfo(null);
    setScheduleAttachmentFile(null);
    setScheduleAttachmentPreview(null);
    setScheduleAttachmentS3Status('');
  }, [plantCode, templateId, reportDate]);

  useEffect(() => {
    if (!portalIssueMode) return;
    const scrollToTop = () => {
      pageTopRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      pageScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      window.scrollTo({ top: 0, behavior: 'smooth' });
      document.documentElement.scrollTo?.({ top: 0, behavior: 'smooth' });
      document.body.scrollTo?.({ top: 0, behavior: 'smooth' });
    };

    requestAnimationFrame(scrollToTop);
  }, [portalIssueMode]);

  const scrollAllParentsToTop = useCallback((startNode) => {
    const scrollOne = (node) => {
      if (!node) return;
      try {
        node.scrollTop = 0;
        node.scrollTo?.({ top: 0, behavior: 'auto' });
      } catch {
        // ignore non-scrollable nodes
      }
    };

    const run = () => {
      pageTopRef.current?.scrollIntoView({ block: 'start', behavior: 'auto' });
      scrollOne(pageScrollRef.current);
      scrollOne(document.scrollingElement);
      scrollOne(document.documentElement);
      scrollOne(document.body);
      window.scrollTo(0, 0);

      let node = startNode;
      while (node && node !== document.body) {
        scrollOne(node);
        node = node.parentElement;
      }

      Array.from(document.querySelectorAll('*')).forEach((el) => {
        const style = window.getComputedStyle(el);
        if (!/(auto|scroll)/.test(`${style.overflowY} ${style.overflow}`)) return;
        if (el.scrollHeight <= el.clientHeight) return;
        scrollOne(el);
      });
    };

    requestAnimationFrame(run);
    setTimeout(run, 60);
  }, []);

  const togglePortalIssueMode = useCallback((event) => {
    const nextPortalIssueMode = !portalIssueMode;
    setPortalIssueMode(nextPortalIssueMode);
    if (nextPortalIssueMode) {
      scrollAllParentsToTop(event?.currentTarget || null);
    }
  }, [portalIssueMode, scrollAllParentsToTop]);

  const validateBasics = () => {
    if (!templateId) return 'Template/Mail Type is required.';
    if (!plantCode) return 'Plant is required.';
    if (!scheduleDate) return 'Send Date is required.';
    if (!reportDate) return 'Report Date is required.';
    if (!scheduleTime) return 'Time is required.';
    if (!fromEmail) return 'From Email is required.';
    if (!toEmail) return 'To Email is required.';
    if (!subject) return 'Subject is required.';
    if (!body) return 'Body is required.';
    if (portalIssueMode && portalIssueSelectedPlants.length === 0) return 'Select at least one plant for Portal Issue.';
    return '';
  };

  const autoS3LoadKey = useMemo(
    () => `${String(plantCode || '').trim().toUpperCase()}|${String(templateId || '').trim()}|${String(reportDate || '').trim()}`,
    [plantCode, templateId, reportDate]
  );
  const autoS3InFlightRef = useRef(0);
  const lastAutoS3LoadedKeyRef = useRef('');

  const loadS3AttachmentForPreview = async () => {
    const plant = String(plantCode || '').trim();
    const tpl = String(templateId || '').trim();
    const date = String(reportDate || '').trim();
    if (!plant || !tpl || !date) return null;
    if (!needsScheduleAttachment) return null;

    const response = await fetch(`${schedulerBaseUrl}/resolve-s3-schedule-attachment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [ROLE_HEADER]: role,
        [USER_HEADER]: String(currentUser?.username || currentUser?.empId || '').trim(),
      },
      body: JSON.stringify({
        plant_name: plantCode,
        template_id: templateId,
        date: reportDate,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = String(data?.detail || 'S3 load failed.');
      if (response.status === 404 || /not found|no .*found|no matching|no schedule|could not find|missing|does not exist/i.test(msg)) {
        setScheduleAttachmentS3Status('not_found');
      }
      throw new Error(String(data?.detail || 'S3 load failed.'));
    }
    setScheduleAttachmentS3Status('');

    const expectedType = templateCategory.toLowerCase().includes('intra') ? 'intraday' : 'dayahead';
    const gotType = String(data?.schedule_type || '').trim().toLowerCase();
    if (expectedType && gotType && expectedType !== gotType) {
      throw new Error(`Loaded wrong file type from S3 (expected ${expectedType}, got ${gotType}). Restart backend and try again.`);
    }

    const csvTextRaw = String(data.csv_text || '');
    const previewRaw = buildCsvPreview(csvTextRaw, 96);
    const preview = enhanceSchedulePreviewRows({ preview: previewRaw, plantCode });
    setScheduleAttachmentPreview(preview);

    const normalizedPlant = String(plantCode || '').trim().toUpperCase();
    const isOsepl = normalizedPlant === 'OSEPL';
    let attachmentFile = createFileFromCsv(csvTextRaw, data.file_name);

    if (!isOsepl) {
      const isTelanganaPlant = ['KASIPET', 'BHUPALPALLY', 'KOTHAGUDEM'].includes(normalizedPlant);
      const isSirmour = normalizedPlant === 'SIRMOUR';
      const sheetName = `${normalizedPlant} ${String(data.schedule_type || '').toUpperCase()}`.trim();
      const attachedXlsxName = withAttachmentExtension(data.file_name, '.xlsx');
      try {
        if (isTelanganaPlant) {
          const { generateTelanganaTemplateFromBaseXlsxBuffer } = await import('@/app/components/common/downloadUtils');
          const buffer = await generateTelanganaTemplateFromBaseXlsxBuffer(csvTextRaw, sheetName);
          attachmentFile = new File([buffer], attachedXlsxName, {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          });
        } else if (isSirmour) {
          const { generateGsnpSirmourXlsxBuffer } = await import('@/app/components/common/downloadUtils');
          const buffer = await generateGsnpSirmourXlsxBuffer(csvTextRaw, sheetName);
          attachmentFile = new File([buffer], attachedXlsxName, {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          });
        }
      } catch {
        // If XLSX generation fails, keep CSV attachment.
      }
    }

    const attachmentInfo = {
      file_name: data.file_name,
      attached_name: attachmentFile?.name || '',
      schedule_type: data.schedule_type,
      lookup_date: data.lookup_date,
      s3_key: data.s3_key,
    };

    setScheduleAttachmentFile(attachmentFile);
    setScheduleAttachmentInfo(attachmentInfo);
    return { file: attachmentFile, info: attachmentInfo };
  };

  const loadS3Attachment = async ({ silent = false } = {}) => {
    const error = validateBasics();
    if (error) {
      if (!silent) toast.error(error);
      throw new Error(error);
    }
    if (!needsScheduleAttachment) {
      if (!silent) toast.message('This template does not require a schedule CSV attachment.');
      return null;
    }

    const response = await fetch(`${schedulerBaseUrl}/resolve-s3-schedule-attachment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [ROLE_HEADER]: role,
        [USER_HEADER]: String(currentUser?.username || currentUser?.empId || '').trim(),
      },
      body: JSON.stringify({
        plant_name: plantCode,
        template_id: templateId,
        date: reportDate,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = String(data?.detail || 'S3 load failed.');
      if (response.status === 404 || /not found|no .*found|no matching|no schedule|could not find|missing|does not exist/i.test(msg)) {
        setScheduleAttachmentS3Status('not_found');
      }
      throw new Error(String(data?.detail || 'S3 load failed.'));
    }
    setScheduleAttachmentS3Status('');

    const expectedType = templateCategory.toLowerCase().includes('intra') ? 'intraday' : 'dayahead';
    const gotType = String(data?.schedule_type || '').trim().toLowerCase();
    if (expectedType && gotType && expectedType !== gotType) {
      throw new Error(`Loaded wrong file type from S3 (expected ${expectedType}, got ${gotType}). Restart backend and try again.`);
    }
    const csvTextRaw = String(data.csv_text || '');
    const previewRaw = buildCsvPreview(csvTextRaw, 96);
    const preview = enhanceSchedulePreviewRows({ preview: previewRaw, plantCode });
    setScheduleAttachmentPreview(preview);
    if (!silent && previewRaw && Array.isArray(previewRaw.rows) && previewRaw.rows.length < 96) {
      toast.warning(`Loaded schedule has ${preview.rows.length} rows in preview (expected 96 blocks). Attachment still includes full file.`);
    }

    const normalizedPlant = String(plantCode || '').trim().toUpperCase();
    const isOsepl = normalizedPlant === 'OSEPL';
    let attachmentFile = createFileFromCsv(csvTextRaw, data.file_name);

    if (!isOsepl) {
      const isTelanganaPlant = ['KASIPET', 'BHUPALPALLY', 'KOTHAGUDEM'].includes(normalizedPlant);
      const isSirmour = normalizedPlant === 'SIRMOUR';
      const sheetName = `${normalizedPlant} ${String(data.schedule_type || '').toUpperCase()}`.trim();
      const attachedXlsxName = withAttachmentExtension(data.file_name, '.xlsx');
      try {
        if (isTelanganaPlant) {
          const { generateTelanganaTemplateFromBaseXlsxBuffer } = await import('@/app/components/common/downloadUtils');
          const buffer = await generateTelanganaTemplateFromBaseXlsxBuffer(csvTextRaw, sheetName);
          attachmentFile = new File([buffer], attachedXlsxName, {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          });
        } else if (isSirmour) {
          const { generateGsnpSirmourXlsxBuffer } = await import('@/app/components/common/downloadUtils');
          const buffer = await generateGsnpSirmourXlsxBuffer(csvTextRaw, sheetName);
          attachmentFile = new File([buffer], attachedXlsxName, {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          });
        } else {
          // Unknown plant template: keep CSV as-is.
        }
      } catch (exc) {
        // If template generation fails, fall back to CSV.
        if (!silent) toast.error(`Template conversion failed; attaching CSV instead. (${exc?.message || 'error'})`);
        attachmentFile = createFileFromCsv(csvTextRaw, data.file_name);
      }
    }

    const attachmentInfo = {
      file_name: data.file_name,
      attached_name: attachmentFile?.name || '',
      schedule_type: data.schedule_type,
      lookup_date: data.lookup_date,
      s3_key: data.s3_key,
    };

    setScheduleAttachmentFile(attachmentFile);
    setScheduleAttachmentInfo(attachmentInfo);
    return { file: attachmentFile, info: attachmentInfo };
  };

  const resolveS3Attachment = async () => {
    try {
      const loaded = await loadS3Attachment();
      if (loaded?.info?.file_name) toast.success(`Loaded attachment from S3: ${loaded.info.file_name}`);
    } catch (err) {
      toast.error(err?.message || 'S3 load failed.');
    }
  };

  useEffect(() => {
    if (portalIssueMode) return;
    if (!needsScheduleAttachment) return;
    if (isDsmTemplate) return;
    if (!plantCode || !templateId || !reportDate) return;
    if (scheduleAttachmentFile || scheduleAttachmentInfo) return;
    if (lastAutoS3LoadedKeyRef.current === autoS3LoadKey) return;

    const runId = ++autoS3InFlightRef.current;
    const timer = setTimeout(() => {
      loadS3AttachmentForPreview()
        .then((loaded) => {
          if (!loaded) return;
          if (runId !== autoS3InFlightRef.current) return;
          lastAutoS3LoadedKeyRef.current = autoS3LoadKey;
        })
        .catch(() => {
          // Silent auto-load; user can click the button for explicit feedback.
        });
    }, 250);

    return () => clearTimeout(timer);
  }, [
    portalIssueMode,
    needsScheduleAttachment,
    isDsmTemplate,
    plantCode,
    templateId,
    reportDate,
    scheduleAttachmentFile,
    scheduleAttachmentInfo,
    autoS3LoadKey,
  ]);

  const portalIssuePasteRef = useRef(null);
  const onPortalIssuePaste = useCallback((event) => {
    if (!portalIssueMode) return;
    const items = Array.from(event.clipboardData?.items || []);
    const imageItem = items.find((it) => (it.type || '').startsWith('image/'));
    if (!imageItem) return;
    const file = imageItem.getAsFile();
    if (!file) return;
    setPortalIssueImage(file);
    toast.success('Pasted image attached.');
  }, [portalIssueMode]);

  const onPortalIssueDrop = useCallback((event) => {
    if (!portalIssueMode) return;
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files || []);
    const img = files.find((f) => (f.type || '').startsWith('image/'));
    if (!img) {
      toast.error('Drop an image file (PNG/JPG/JPEG/GIF/BMP/WEBP).');
      return;
    }
    setPortalIssueImage(img);
    toast.success('Screenshot attached.');
  }, [portalIssueMode]);

  const onPortalIssueDragOver = useCallback((event) => {
    if (!portalIssueMode) return;
    event.preventDefault();
  }, [portalIssueMode]);

  const buildJobFormData = (opts = {}) => {
    const { autoSendOverride, scheduleAttachmentFileOverride } = opts || {};
    const form = new FormData();
    form.set('template_id', templateId);
    form.set('plant_code', plantCode);
    form.set('date', scheduleDate);
    form.set('time', scheduleTime);
    form.set('am_pm', amPm);
    form.set('from_email', fromEmail);
    form.set('to_email', toEmail);
    form.set('cc_email', ccEmail);
    form.set('employee_name', employeeName);
    form.set('subject', subject);
    form.set('body', body);
    const effectiveAutoSend = typeof autoSendOverride === 'boolean' ? autoSendOverride : autoSend;
    form.set('auto_send', effectiveAutoSend ? '1' : '0');
    form.set('portal_issue', portalIssueMode ? '1' : '0');
    if (portalIssueMode) {
      form.set('portal_issue_plants', JSON.stringify(portalIssueSelectedPlants));
    }
    if (isDsmTemplate) form.set('dsm_summary_payload', JSON.stringify(effectiveDsmPayload || {}));

    if (portalIssueMode && portalIssueImage) {
      form.set('attachment', portalIssueImage, portalIssueImage.name || 'portal-issue.png');
    } else {
      const scheduleFile = scheduleAttachmentFileOverride || scheduleAttachmentFile;
      if (scheduleFile) {
        form.set('schedule_attachment', scheduleFile, scheduleFile.name || 'schedule.csv');
      }
      if (extraAttachmentFile) {
        form.set('attachment', extraAttachmentFile, extraAttachmentFile.name);
      }
    }
    return form;
  };

  const getSendNowFormData = async () => {
    if (!needsScheduleAttachment || scheduleAttachmentFile || portalIssueMode) {
      return buildJobFormData();
    }

    toast.message('Loading report attachment from S3...');
    const loaded = await loadS3Attachment({ silent: true });
    if (loaded?.file) {
      toast.success(`Loaded attachment: ${loaded.file.name}`);
      return buildJobFormData({ scheduleAttachmentFileOverride: loaded.file });
    }
    return buildJobFormData();
  };

  const [jobs, setJobs] = useState([]);
  const [loadingJobs, setLoadingJobs] = useState(false);

  const refreshJobs = useCallback(async () => {
    setLoadingJobs(true);
    try {
      const response = await fetch(`${schedulerBaseUrl}/jobs`, {
        headers: {
          [ROLE_HEADER]: role,
          [USER_HEADER]: String(currentUser?.username || currentUser?.empId || '').trim(),
        },
      });
      if (!response.ok) throw new Error('Failed to load jobs.');
      const data = await response.json();
      setJobs(Array.isArray(data?.items) ? data.items : []);
    } catch (err) {
      // Keep UI resilient; show toast but don't break the screen.
      toast.error(err?.message || 'Failed to load jobs.');
    } finally {
      setLoadingJobs(false);
    }
  }, [schedulerBaseUrl, role, currentUser]);

  useEffect(() => {
    refreshJobs();
    const id = setInterval(() => refreshJobs(), 10000);
    return () => clearInterval(id);
  }, [refreshJobs]);

  const [sendLogs, setSendLogs] = useState([]);
  const [loadingSendLogs, setLoadingSendLogs] = useState(false);

  const sendLogsToday = useMemo(() => {
    const todayKey = getIstTodayDateKey();
    const items = Array.isArray(sendLogs) ? sendLogs : [];
    return items.filter((row) => {
      const raw = row?.sent_at || row?.scheduled_at || row?.created_at;
      if (!raw) return false;
      const dt = new Date(raw);
      if (Number.isNaN(dt.getTime())) return false;
      const key = dt.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      return key === todayKey;
    });
  }, [sendLogs]);

  const refreshSendLogs = useCallback(async () => {
    if (!isAdmin) return;
    setLoadingSendLogs(true);
    try {
      const response = await fetch(`${schedulerBaseUrl}/send-logs?limit=500`, {
        headers: {
          [ROLE_HEADER]: role,
          [USER_HEADER]: String(currentUser?.username || currentUser?.empId || '').trim(),
        },
      });
      if (!response.ok) throw new Error('Failed to load send logs.');
      const data = await response.json();
      setSendLogs(Array.isArray(data?.items) ? data.items : []);
    } catch (err) {
      toast.error(err?.message || 'Failed to load send logs.');
    } finally {
      setLoadingSendLogs(false);
    }
  }, [schedulerBaseUrl, role, currentUser, isAdmin]);

  useEffect(() => {
    refreshSendLogs();
    const id = setInterval(() => refreshSendLogs(), 15000);
    return () => clearInterval(id);
  }, [refreshSendLogs]);

  const scheduleEmail = async () => {
    const error = validateBasics();
    if (error) {
      toast.error(error);
      return;
    }
    if (portalIssueMode && !portalIssueImage) {
      toast.error('Paste or attach an image for Portal Issue mode.');
      return;
    }

    try {
      const response = await fetch(`${schedulerBaseUrl}/schedule`, {
        method: 'POST',
        headers: {
          [ROLE_HEADER]: role,
          [USER_HEADER]: String(currentUser?.username || currentUser?.empId || '').trim(),
        },
        body: buildJobFormData({ autoSendOverride: true }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(data?.detail || 'Schedule failed.'));
      toast.success('Scheduled for automatic sending.');
      refreshJobs();
      refreshSendLogs();
    } catch (err) {
      toast.error(err?.message || 'Schedule failed.');
    }
  };

  const scheduleEmailAutoSend = async () => {
    const error = validateBasics();
    if (error) {
      toast.error(error);
      return;
    }
    if (portalIssueMode && !portalIssueImage) {
      toast.error('Paste or attach an image for Portal Issue mode.');
      return;
    }

    try {
      const response = await fetch(`${schedulerBaseUrl}/schedule`, {
        method: 'POST',
        headers: {
          [ROLE_HEADER]: role,
          [USER_HEADER]: String(currentUser?.username || currentUser?.empId || '').trim(),
        },
        body: buildJobFormData({ autoSendOverride: Boolean(autoSend) }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(data?.detail || 'Schedule failed.'));
      toast.success(autoSend ? 'Scheduled (auto-send) successfully.' : 'Queued successfully (auto-send is OFF).');
      refreshJobs();
      refreshSendLogs();
    } catch (err) {
      toast.error(err?.message || 'Schedule failed.');
    }
  };

  const sendNow = async () => {
    const error = validateBasics();
    if (error) {
      toast.error(error);
      return;
    }
    if (portalIssueMode && !portalIssueImage) {
      toast.error('Paste or attach an image for Portal Issue mode.');
      return;
    }

    try {
      const response = await fetch(`${schedulerBaseUrl}/send-report-now`, {
        method: 'POST',
        headers: {
          [ROLE_HEADER]: role,
          [USER_HEADER]: String(currentUser?.username || currentUser?.empId || '').trim(),
        },
        body: await getSendNowFormData(),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(data?.detail || 'Send failed.'));
      toast.success('Sent successfully.');
      refreshJobs();
      refreshSendLogs();
    } catch (err) {
      toast.error(err?.message || 'Send failed.');
    }
  };

  const scheduleAll = async () => {
    if (!isAdmin) {
      toast.error('Schedule All is admin-only.');
      return;
    }
    const error = validateBasics();
    if (error) {
      toast.error(error);
      return;
    }
    try {
      const response = await fetch(`${schedulerBaseUrl}/schedule-all`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [ROLE_HEADER]: role,
          [USER_HEADER]: String(currentUser?.username || currentUser?.empId || '').trim(),
        },
        body: JSON.stringify({
          template_id: templateId,
          date: scheduleDate,
          time: scheduleTime,
          am_pm: amPm,
          from_email: fromEmail,
          employee_name: employeeName,
          auto_send: Boolean(autoSend),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(data?.detail || 'Schedule All failed.'));
      toast.success(`Scheduled ${data?.created || 0} plant mails.`);
      refreshJobs();
      refreshSendLogs();
    } catch (err) {
      toast.error(err?.message || 'Schedule All failed.');
    }
  };

  const deleteJob = async (id) => {
    try {
      const response = await fetch(`${schedulerBaseUrl}/jobs/${encodeURIComponent(String(id))}`, {
        method: 'DELETE',
        headers: {
          [ROLE_HEADER]: role,
          [USER_HEADER]: String(currentUser?.username || currentUser?.empId || '').trim(),
        },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(data?.detail || 'Delete failed.'));
      toast.success('Job deleted.');
      refreshJobs();
      refreshSendLogs();
    } catch (err) {
      toast.error(err?.message || 'Delete failed.');
    }
  };

  const retryJob = async (id) => {
    try {
      const response = await fetch(`${schedulerBaseUrl}/jobs/${encodeURIComponent(String(id))}/retry`, {
        method: 'POST',
        headers: {
          [ROLE_HEADER]: role,
          [USER_HEADER]: String(currentUser?.username || currentUser?.empId || '').trim(),
        },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(data?.detail || 'Retry failed.'));
      toast.success('Retry queued (auto-send enabled).');
      refreshJobs();
      refreshSendLogs();
    } catch (err) {
      toast.error(err?.message || 'Retry failed.');
    }
  };

  return (
    <div
      ref={pageScrollRef}
      className={`flex-1 overflow-auto min-h-0 transition-colors ${portalIssueMode ? 'bg-orange-50' : 'bg-background'}`}
    >
      <div className="w-full p-4 sm:p-6 lg:p-8 space-y-6 max-w-[2000px] mx-auto">
        <div ref={pageTopRef} />
        <section className="bg-card rounded-lg border border-border shadow-sm overflow-hidden">
          <div className="p-4 sm:p-6 border-b border-border bg-muted/30">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex items-start gap-3">
                <div className="h-11 w-11 rounded-lg bg-primary/10 text-primary flex items-center justify-center border border-border">
                  <Mail className="w-6 h-6" />
                </div>
                <div>
                  <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-foreground">Email Scheduler</h1>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Manage scheduled plant mails, custom emails, admin timing setup, and mail tracking.
                  </p>
                  <div className="mt-2 inline-flex items-center gap-2 text-xs text-muted-foreground">
                    <span className={`px-2 py-0.5 rounded-full border ${isAdmin ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-muted/40'}`}>
                      Role: {role}
                    </span>
                    {metaSourceUrl ? (
                      <span className="inline-flex items-center gap-1">
                        <Server className="w-3.5 h-3.5" />
                        Source: {metaSourceUrl}
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    const res = await fetchMetadata({ silent: false });
                    if (res?.ok) {
                      // User expects refresh to reset dropdown + attachments state.
                      resetSchedulerForm();
                    }
                  }}
                  disabled={loadingMeta}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-background hover:bg-accent transition-all text-sm"
                >
                  <RefreshCw className={`w-4 h-4 ${loadingMeta ? 'animate-spin' : ''}`} />
                  Refresh Metadata
                </button>
              </div>
            </div>
          </div>

          <div className="p-4 sm:p-6">
            {metaError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{metaError}</span>
              </div>
            ) : loadingMeta ? (
              <div className="text-sm text-muted-foreground">Loading scheduler metadata...</div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                <button
                  onClick={() => setVisiblePlantSection((p) => (p === 'active' ? null : 'active'))}
                  className="rounded-lg border border-border bg-muted/30 px-4 py-4 text-left hover:bg-accent/40 transition-all"
                >
                  <div className="text-xs text-muted-foreground">Active Plants</div>
                  <div className="mt-1 text-2xl font-semibold text-foreground">{activePlants.length}</div>
                </button>
                <button
                  onClick={() => setVisiblePlantSection((p) => (p === 'inactive' ? null : 'inactive'))}
                  className="rounded-lg border border-border bg-muted/30 px-4 py-4 text-left hover:bg-accent/40 transition-all"
                >
                  <div className="text-xs text-muted-foreground">Inactive Plants</div>
                  <div className="mt-1 text-2xl font-semibold text-foreground">{inactivePlants.length}</div>
                </button>
              </div>
            )}
          </div>
        </section>

        {visiblePlantSection && (
          <section className="bg-card rounded-lg border border-border shadow-sm overflow-hidden">
            <div className="border-b border-border px-4 py-3 sm:px-6 sm:py-4 bg-muted/30">
              <div className="text-sm font-medium text-foreground">Plant Master Snapshot</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {visiblePlantSection === 'active' ? 'Showing active plants.' : 'Showing inactive plants.'}
              </div>
            </div>
            <div className="p-4 sm:p-6">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {(visiblePlantSection === 'active' ? activePlants : inactivePlants).map((plant) => (
                  <div key={plant.plant_code || plant.plant_name} className="rounded-lg border border-border bg-muted/30 px-4 py-3">
                    <div className="text-sm font-semibold text-foreground">{plant.plant_name}</div>
                    <div className="mt-1 text-xs text-muted-foreground">Code: {plant.plant_code || 'N/A'}</div>
                    <div className="mt-3 flex items-center justify-between gap-3">
                      <div className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium ${plant.active ? 'bg-primary/10 text-primary' : 'bg-red-100 text-red-600'}`}>
                        {plant.active ? 'Active' : 'Inactive'}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">Cron Auto Email</span>
                        <Switch
                          checked={isPlantAutoEmailEnabled(plant.plant_code)}
                          onCheckedChange={(value) => updatePlantAutoEmailEnabled(plant.plant_code, value)}
                          disabled={loadingSettings || !plant.plant_code}
                          className="border border-border data-[state=unchecked]:bg-muted data-[state=checked]:bg-primary"
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        <section className={`rounded-lg border shadow-sm overflow-hidden transition-colors ${
          portalIssueMode ? 'bg-orange-50 border-orange-200' : 'bg-card border-border'
        }`}>
          <div className={`border-b px-4 py-3 sm:px-6 sm:py-4 transition-colors ${
            portalIssueMode ? 'border-orange-200 bg-orange-100' : 'border-border bg-muted/30'
          }`}>
            <div className={portalIssueMode ? 'text-sm font-medium text-orange-950' : 'text-sm font-medium text-foreground'}>
              {portalIssueMode ? 'Portal Issue Form' : 'Scheduler Form'}
            </div>
          </div>

          <div className="p-4 sm:p-6 space-y-6">
            <div className="space-y-4">
              <label className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">Employee Name</div>
                <input
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={employeeName}
                  onChange={(e) => setEmployeeName(e.target.value)}
                  placeholder="Operator name"
                />
              </label>

              <label className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">From Email</div>
                <input
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={fromEmail}
                  onChange={(e) => setFromEmail(e.target.value)}
                  placeholder="operations@company.com"
                />
              </label>

              <label className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">To Email</div>
                <input
                  className={`w-full rounded-md border border-border px-3 py-2 text-sm ${!customMode ? 'bg-muted/30 opacity-80 cursor-not-allowed' : 'bg-background'}`}
                  value={toEmail}
                  onChange={(e) => setToEmail(e.target.value)}
                  placeholder="recipient@company.com"
                  disabled={!customMode}
                />
              </label>

              <label className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">CC Email</div>
                <input
                  className={`w-full rounded-md border border-border px-3 py-2 text-sm ${!customMode ? 'bg-muted/30 opacity-80 cursor-not-allowed' : 'bg-background'}`}
                  value={ccEmail}
                  onChange={(e) => setCcEmail(e.target.value)}
                  placeholder="cc@company.com"
                  disabled={!customMode}
                />
              </label>

              <label className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">Subject</div>
                <input
                  className={`w-full rounded-md border border-border px-3 py-2 text-sm ${!customMode ? 'bg-muted/30 opacity-80 cursor-not-allowed' : 'bg-background'}`}
                  value={subject}
                  onChange={(e) => {
                    lastAutoSubjectRef.current = '';
                    setSubject(e.target.value);
                    if (portalIssueMode) setPortalIssueSubjectTouched(true);
                  }}
                  disabled={!customMode}
                />
              </label>

              <label className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">Body</div>
                <textarea
                  className={`w-full rounded-md border border-border px-3 py-2 text-sm min-h-32 ${!customMode ? 'bg-muted/30 opacity-80 cursor-not-allowed' : 'bg-background'}`}
                  value={body}
                  onChange={(e) => {
                    setBody(e.target.value);
                    if (portalIssueMode) setPortalIssueBodyTouched(true);
                  }}
                  disabled={!customMode}
                />
              </label>

              <div className="flex items-center gap-3">
                <Switch
                  checked={customMode}
                  onCheckedChange={setCustomMode}
                  className="border border-border data-[state=unchecked]:bg-muted data-[state=checked]:bg-primary"
                />
                <div className="text-sm">Custom mode (template changes don’t overwrite edits)</div>
              </div>

              {!portalIssueMode ? (
                <div className="grid gap-4 md:grid-cols-3">
                  <label className="space-y-1.5">
                    <div className="text-xs font-medium text-muted-foreground">Plant</div>
                    <select
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                      value={plantCode}
                      onChange={(e) => {
                        const nextPlant = e.target.value;
                        setPlantCode(nextPlant);
                        setTemplateId('');
                      }}
                    >
                      <option value="">Select plant...</option>
                      {activePlants.map((p) => (
                        <option key={p.plant_code} value={p.plant_code}>
                          {p.plant_name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="space-y-1.5">
                    <div className="text-xs font-medium text-muted-foreground">File Type</div>
                    <select
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                      value={templateId}
                      onChange={(e) => setTemplateId(e.target.value)}
                      disabled={!plantCode}
                    >
                      <option value="">Select template...</option>
                      {Object.entries(fileTypeDropdownGroups || {}).map(([group, items]) => (
                        <optgroup key={group} label={group}>
                          {(Array.isArray(items) ? items : []).map((tpl) => (
                            <option key={tpl.id} value={tpl.id}>
                              {tpl.label || tpl.name || tpl.id}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </label>

                  <label className="space-y-1.5">
                    <div className="text-xs font-medium text-muted-foreground">Suggested Time</div>
                    <input
                      className="w-full rounded-md border border-border bg-muted/20 px-3 py-2 text-sm"
                      value={String(
                        selectedTemplate?.timing_hint
                        || (selectedTemplate?.time_24h
                          ? `${selectedTemplate?.time_24h}${selectedTemplate?.am_pm ? ` ${selectedTemplate?.am_pm}` : ''}`
                          : '')
                        || ''
                      )}
                      readOnly
                      placeholder="Suggested time"
                    />
                  </label>
                </div>
              ) : (
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="space-y-1.5">
                    <div className="text-xs font-medium text-muted-foreground">Plants</div>
                    <div className="rounded-md border border-border bg-background px-3 py-2 text-sm space-y-2">
                      {PORTAL_ISSUE_PLANT_OPTIONS.map((code) => (
                        <label key={code} className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={portalIssuePlants.has(code)}
                            onChange={(e) => {
                              setPortalIssuePlants((prev) => {
                                const next = new Set(prev || []);
                                if (e.target.checked) next.add(code);
                                else next.delete(code);
                                return next;
                              });
                            }}
                          />
                          <span>{code}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  <label className="space-y-1.5">
                    <div className="text-xs font-medium text-muted-foreground">Mail Type</div>
                    <input
                      className="w-full rounded-md border border-border bg-muted/20 px-3 py-2 text-sm"
                      value="Issue"
                      readOnly
                    />
                  </label>

                  <label className="space-y-1.5">
                    <div className="text-xs font-medium text-muted-foreground">Suggested Timing</div>
                    <input
                      className="w-full rounded-md border border-border bg-muted/20 px-3 py-2 text-sm"
                      value="Portal Issue Template"
                      readOnly
                    />
                  </label>
                </div>
              )}

              <div className="flex items-center gap-3">
                <Switch
                  checked={autoSend}
                  onCheckedChange={setAutoSend}
                  className="border border-border data-[state=unchecked]:bg-muted data-[state=checked]:bg-primary"
                />
                <div className="text-sm">Auto Send On Scheduled Time</div>
              </div>

              <div className="grid gap-4 md:grid-cols-4">
                <label className="space-y-1.5">
                  <div className="text-xs font-medium text-muted-foreground">Send Date</div>
                  <div className="relative">
                    <Calendar className="absolute left-3 top-2.5 w-4 h-4 text-muted-foreground" />
                    <input
                      type="date"
                      className="w-full rounded-md border border-border bg-background pl-9 pr-3 py-2 text-sm"
                      value={scheduleDate}
                      onChange={(e) => setScheduleDate(e.target.value)}
                    />
                  </div>
                </label>

                <label className="space-y-1.5">
                  <div className="text-xs font-medium text-muted-foreground">Report Date</div>
                  <div className="relative">
                    <Calendar className="absolute left-3 top-2.5 w-4 h-4 text-muted-foreground" />
                    <input
                      type="date"
                      className="w-full rounded-md border border-border bg-background pl-9 pr-3 py-2 text-sm"
                      value={reportDate}
                      onChange={(e) => setReportDate(e.target.value)}
                    />
                  </div>
                </label>

                <label className="space-y-1.5">
                  <div className="text-xs font-medium text-muted-foreground">Time</div>
                  <div className="relative">
                    <Clock className="absolute left-3 top-2.5 w-4 h-4 text-muted-foreground" />
                    <input
                      type="time"
                      className={`w-full rounded-md border border-border pl-9 pr-3 py-2 text-sm ${!customMode ? 'bg-muted/30 opacity-80 cursor-not-allowed' : 'bg-background'}`}
                      value={scheduleTime}
                      onChange={(e) => setScheduleTime(e.target.value)}
                      disabled={!customMode}
                    />
                  </div>
                </label>

                <label className="space-y-1.5">
                  <div className="text-xs font-medium text-muted-foreground">AM/PM</div>
                  <select
                    className={`w-full rounded-md border border-border px-3 py-2 text-sm ${!customMode ? 'bg-muted/30 opacity-80 cursor-not-allowed' : 'bg-background'}`}
                    value={amPm}
                    onChange={(e) => setAmPm(e.target.value)}
                    disabled={!customMode}
                  >
                    <option value="AM">AM</option>
                    <option value="PM">PM</option>
                  </select>
                </label>
              </div>
            </div>

            {isDsmTemplate && (
              <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-foreground">DSM Report Preview</div>
                    {dsmPreviewSourceLabel ? (
                      <div className="mt-1 text-xs text-muted-foreground">{dsmPreviewSourceLabel}</div>
                    ) : null}
                  </div>
                </div>
                <DsmPreviewTable
                  payload={effectiveDsmPayload}
                  variant={getDsmPreviewVariant(plantCode)}
                  editable={false}
                />
              </div>
            )}

            {!portalIssueMode ? (
              <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
                <div className="text-sm font-semibold text-foreground">Schedule Attachment Source</div>

                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={resolveS3Attachment}
                    disabled={!needsScheduleAttachment}
                    className={`inline-flex items-center gap-2 px-3 py-2 rounded-md border text-sm transition-all ${
                      !needsScheduleAttachment
                        ? 'border-border bg-background opacity-50 cursor-not-allowed'
                        : 'border-border bg-background hover:bg-accent'
                    }`}
                  >
                    <UploadCloud className="w-4 h-4" />
                    Load From S3 (CSV)
                  </button>

                  <label className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-background hover:bg-accent transition-all text-sm cursor-pointer">
                    <input
                      type="file"
                      className="hidden"
                      accept=".csv,.xlsx"
                      onChange={(e) => {
                        const f = e.target.files?.[0] || null;
                        if (!f) return;
                        setScheduleAttachmentFile(f);
                        setScheduleAttachmentInfo(null);
                        setScheduleAttachmentPreview(null);
                        setScheduleAttachmentS3Status('');
                        if (isDsmTemplate) {
                          setIsDsmEditing(false);
                          setDsmSourceMode('s3');
                          setDsmEditedPayload(null);
                        }
                      }}
                    />
                    <span>Load Locally</span>
                  </label>
                </div>

                <div className="text-xs text-muted-foreground space-y-1">
                  {!scheduleAttachmentInfo ? (
                    <div>
                      {scheduleAttachmentFile
                        ? `Local schedule attached: ${scheduleAttachmentFile.name}`
                        : scheduleAttachmentS3Status === 'not_found'
                          ? 'Not present in S3'
                          : 'No schedule attachment loaded yet.'}
                    </div>
                  ) : (
                    <>
                      <div>File: {scheduleAttachmentInfo.file_name}</div>
                      {scheduleAttachmentInfo.attached_name && scheduleAttachmentInfo.attached_name !== scheduleAttachmentInfo.file_name ? (
                        <div>Attached as: {scheduleAttachmentInfo.attached_name}</div>
                      ) : null}
                      <div>Type: {scheduleAttachmentInfo.schedule_type}</div>
                      <div>Lookup date: {scheduleAttachmentInfo.lookup_date}</div>
                    </>
                  )}
                </div>

                {scheduleAttachmentPreview ? (
                  <div className="pt-2">
                    <div className="text-xs font-medium text-foreground mb-2">Loaded schedule preview</div>
                    <div className="rounded-md border border-border bg-background overflow-auto max-h-[220px]">
                      <table className="min-w-full text-xs">
                        <thead className="sticky top-0 bg-muted border-b border-border">
                          <tr>
                            {(scheduleAttachmentPreview.header || []).map((h, idx) => (
                              <th key={`${idx}-${h}`} className="px-2 py-1 text-left font-semibold text-foreground whitespace-nowrap">
                                {String(h || '')}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {(scheduleAttachmentPreview.rows || []).map((r, ridx) => (
                            <tr key={ridx} className="hover:bg-muted/40">
                              {(scheduleAttachmentPreview.header || []).map((_, cidx) => (
                                <td key={cidx} className="px-2 py-1 whitespace-nowrap text-foreground">
                                  {String(r?.[cidx] ?? '')}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}

              </div>
            ) : (
              <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
                <div className="text-sm font-semibold text-foreground">Portal Issue Screenshot</div>

                <div className="flex flex-wrap gap-2">
                  <label className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-background hover:bg-accent transition-all text-sm cursor-pointer">
                    <input
                      type="file"
                      className="hidden"
                      accept="image/png,image/jpeg,image/gif,image/bmp,image/webp"
                      onChange={(e) => {
                        const f = e.target.files?.[0] || null;
                        if (!f) return;
                        setPortalIssueImage(f);
                      }}
                    />
                    <span>Upload Screenshot</span>
                  </label>
                  {portalIssueImage && (
                    <button
                      type="button"
                      onClick={() => setPortalIssueImage(null)}
                      className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-background hover:bg-accent transition-all text-sm"
                    >
                      Remove
                    </button>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="text-xs text-muted-foreground">Paste screenshot here with Ctrl + V (PNG/JPG/JPEG/GIF/BMP/WEBP).</div>
                  <div
                    ref={portalIssuePasteRef}
                    onPaste={onPortalIssuePaste}
                    onDragOver={onPortalIssueDragOver}
                    onDrop={onPortalIssueDrop}
                    tabIndex={0}
                    className="rounded-lg border border-dashed border-border bg-background px-4 py-6 text-sm text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                  >
                    {portalIssueImage ? (
                      <div className="space-y-2">
                        <div className="text-xs">Attached: {portalIssueImage.name}</div>
                        <img
                          alt="Portal issue preview"
                          src={URL.createObjectURL(portalIssueImage)}
                          className="max-h-56 rounded-md border border-border"
                        />
                      </div>
                    ) : (
                      <div>Click here and paste an image.</div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {!portalIssueMode && (
              <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-2">
                <div className="text-sm font-semibold text-foreground">Attach PDF/Word</div>
                <label className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-background hover:bg-accent transition-all text-sm cursor-pointer w-fit">
                  <input
                    type="file"
                    className="hidden"
                    accept=".pdf,.doc,.docx"
                    onChange={(e) => {
                      const f = e.target.files?.[0] || null;
                      if (!f) return;
                      setExtraAttachmentFile(f);
                    }}
                  />
                  <span>Choose File</span>
                </label>
                {extraAttachmentFile ? (
                  <div className="text-xs text-muted-foreground">Selected: {extraAttachmentFile.name}</div>
                ) : (
                  <div className="text-xs text-muted-foreground">No file selected.</div>
                )}
              </div>
            )}

            <div className="flex flex-col gap-2 max-w-sm w-full mx-auto">
              <button
                onClick={togglePortalIssueMode}
                className={`px-4 py-2 rounded-md text-sm transition-all text-center text-white ${
                  portalIssueMode ? 'bg-orange-700 hover:bg-orange-800' : 'bg-orange-500 hover:bg-orange-600'
                }`}
              >
                Portal Issue
              </button>
              <button
                onClick={scheduleEmailAutoSend}
                className="px-4 py-2 rounded-md bg-purple-600 hover:bg-purple-700 text-white transition-all text-sm text-center"
              >
                Send Attached Report On Scheduled Time
              </button>
              <button
                onClick={sendNow}
                className="px-4 py-2 rounded-md bg-amber-900 hover:bg-amber-950 text-white transition-all text-sm text-center"
              >
                Send Report Immediately
              </button>
            </div>
          </div>
        </section>

        <section className="bg-card rounded-lg border border-border shadow-sm overflow-hidden">
          <div className="border-b border-border px-4 py-3 sm:px-6 sm:py-4 bg-muted/30 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-foreground">Active Schedules</div>
              <div className="mt-1 text-xs text-muted-foreground">
                Jobs refresh every 10 seconds. Testing users only see their own jobs.
              </div>
            </div>
            <button
              onClick={refreshJobs}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-background hover:bg-accent transition-all text-sm"
            >
              <RefreshCw className={`w-4 h-4 ${loadingJobs ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
          <div className="p-4 sm:p-6">
            {jobs.length === 0 ? (
              <div className="text-sm text-muted-foreground">No scheduled jobs yet.</div>
            ) : (
              <div className="space-y-3">
                {jobs.map((job) => (
                  <div key={job.id} className="rounded-lg border border-border bg-muted/20 px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-foreground truncate">
                        {job.template_id} • {job.plant_code}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        Scheduled: {formatLocalDateTime(job.scheduled_at)} • Status: {job.status}
                      </div>
                      {job.error_message ? (
                        <div className="mt-1 text-xs text-red-600 truncate" title={job.error_message}>
                          Error: {job.error_message}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      {String(job.status || '').toUpperCase() === 'FAILED' ? (
                        <button
                          type="button"
                          onClick={() => retryJob(job.id)}
                          className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-background hover:bg-accent transition-all text-sm"
                          title="Retry failed job (re-queues for immediate auto-send)"
                        >
                          <RefreshCw className="w-4 h-4" />
                          Retry
                        </button>
                      ) : null}
                      <button
                        onClick={() => deleteJob(job.id)}
                        className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-background hover:bg-accent transition-all text-sm"
                        title="Cancel/Delete"
                      >
                        <Trash2 className="w-4 h-4" />
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {isAdmin ? (
          <section className="bg-card rounded-lg border border-border shadow-sm overflow-hidden">
            <div className="border-b border-border px-4 py-3 sm:px-6 sm:py-4 bg-muted/30 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-foreground">Send Log (Admin)</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Latest send/schedule attempts with employee name, recipients, and timestamps.
                </div>
              </div>
              <button
                onClick={refreshSendLogs}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-background hover:bg-accent transition-all text-sm"
              >
                <RefreshCw className={`w-4 h-4 ${loadingSendLogs ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            </div>
            <div className="p-4 sm:p-6">
              {sendLogsToday.length === 0 ? (
                <div className="text-sm text-muted-foreground">No log entries yet.</div>
              ) : (
                <div className="overflow-auto border border-border rounded-lg">
                  <table className="min-w-[1100px] w-full text-sm">
                    <thead className="bg-muted/40 text-muted-foreground">
                      <tr>
                        <th className="text-left font-medium px-3 py-2">Time</th>
                        <th className="text-left font-medium px-3 py-2">Employee</th>
                        <th className="text-left font-medium px-3 py-2">Plant</th>
                        <th className="text-left font-medium px-3 py-2">Mail Type</th>
                        <th className="text-left font-medium px-3 py-2">Status</th>
                        <th className="text-left font-medium px-3 py-2">To</th>
                        <th className="text-left font-medium px-3 py-2">CC</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sendLogsToday.map((row) => (
                        <tr key={row.id} className="border-t border-border">
                          <td className="px-3 py-2 whitespace-nowrap">
                            {formatLocalDateTime(row.sent_at || row.scheduled_at || row.created_at)}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            {String(row.employee_name || row.requested_by || '-').trim() || '-'}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">{row.plant_code || '-'}</td>
                          <td className="px-3 py-2 whitespace-nowrap">{row.template_id || '-'}</td>
                          <td className="px-3 py-2 whitespace-nowrap">{row.status || '-'}</td>
                          <td className="px-3 py-2 break-all">{row.to_email || '-'}</td>
                          <td className="px-3 py-2 break-all">{row.cc_email || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
