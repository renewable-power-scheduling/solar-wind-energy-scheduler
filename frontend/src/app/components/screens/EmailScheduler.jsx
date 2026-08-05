import { AlertCircle, Calendar, Clock, Download, Mail, RefreshCw, Server, Trash2, UploadCloud } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { API_ORIGIN } from '@/config/appConfig';
import { filterPlantsForUser, getCurrentUserFromStorage, isAdminUser } from '@/utils/plantAccess';
import { Switch } from '@/app/components/ui/switch';
import { DSM_PENALTY_CONFIG_BY_STATE, DEFAULT_DSM_PENALTY_CONFIG } from '@/config/dsmPenaltyConfig';
import { calculatePenaltyRs as calculatePenaltyRsShared } from '@/shared/freezeRules';
import { listS3ObjectsAcrossPrefixes, fetchTextFromS3, fetchBytesFromS3 } from '@/services/s3Utils';
import { calculateOseplOfficePayableReceivable, calculateOseplSettlement } from '@/utils/oseplPenalty';
import { parseBlockFromTimestamp } from '@/utils/meterTime';
import { getPpaRateRsPerKwh } from '@/utils/ppaRate';
import { getEmployeeName } from '@/utils/getEmployeeName';
import { resolveMeterMwFactor } from '@/utils/meterUnit';

const emailSchedulerBase = () => {
  // In dev, API_ORIGIN resolves to http://localhost:3001 so we can hit /email-scheduler/*.
  // In docker/prod, keep relative paths so nginx proxies correctly.
  return API_ORIGIN ? `${API_ORIGIN}/email-scheduler` : '/email-scheduler';
};

const ROLE_HEADER = 'X-User-Role';
const USER_HEADER = 'X-User-Name';
const DEFAULT_FROM_EMAIL = 'forecasting.vppl@gmail.com';
const DEFAULT_EMAIL_SIGNATURE_NAME = 'Vedanjay Team';
const SYSTEM_EMAIL_USERS = new Set(['code.vedanjay', 'system_cron', 'system_auto']);
const TO_AUTOFILL_BLOCKLIST = new Set(['shrutinalawade2509@gmail.com']);

const sanitizeToAutofill = (value) => String(value || '')
  .split(',')
  .map((item) => item.trim())
  .filter((item) => item && !TO_AUTOFILL_BLOCKLIST.has(item.toLowerCase()))
  .join(', ');

const normalizeRecipientDefaults = (value) => {
  if (!value || typeof value !== 'object') return {};
  const out = {};
  Object.entries(value).forEach(([plantKey, templateMap]) => {
    const plant = normalizePlantCodeKey(plantKey);
    if (!plant || !templateMap || typeof templateMap !== 'object') return;
    Object.entries(templateMap).forEach(([templateKey, recipients]) => {
      const templateId = String(templateKey || '').trim();
      if (!templateId || !recipients || typeof recipients !== 'object') return;
      const to_email = String(recipients.to_email || recipients.to || '').trim();
      const cc_email = String(recipients.cc_email || recipients.cc || '').trim();
      if (!to_email && !cc_email) return;
      if (!out[plant]) out[plant] = {};
      out[plant][templateId] = { to_email, cc_email };
    });
  });
  return out;
};

const getRecipientDefault = (settings, plantCode, templateId) => {
  const plant = normalizePlantCodeKey(plantCode);
  const template = String(templateId || '').trim();
  if (!plant || !template) return null;
  return settings?.[plant]?.[template] || null;
};

const defaultEmployeeNameForUser = (user) => {
  if (isAdminUser(user)) return 'Admin';
  const token = String(user?.empId || user?.username || '').trim();
  if (token.toLowerCase() === 'intern') return 'Intern';
  return String(user?.name || token || DEFAULT_EMAIL_SIGNATURE_NAME).trim();
};

const deriveRole = (user) => (isAdminUser(user) ? 'admin' : 'testing');

const getSendLogEmployeeName = (row) => {
  const requestedBy = String(row?.requested_by || '').trim();
  const systemKey = requestedBy.toLowerCase();
  if (requestedBy && !SYSTEM_EMAIL_USERS.has(systemKey)) {
    return getEmployeeName(requestedBy);
  }
  return String(row?.employee_name || DEFAULT_EMAIL_SIGNATURE_NAME || '-').trim() || '-';
};

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

const createFileFromBase64 = (base64Text, fileName) => {
  const raw = String(base64Text || '').trim();
  if (!raw) return null;
  const binary = atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const name = String(fileName || 'schedule.xlsx');
  const lower = name.toLowerCase();
  const type = lower.endsWith('.csv')
    ? 'text/csv'
    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return new File([bytes], name, { type });
};

const readS3ScheduleObjectForEmail = async (key) => {
  const fileName = String(key || '').split('/').pop() || 'schedule.csv';
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm') || lower.endsWith('.xls')) {
    const buffer = await fetchBytesFromS3(key);
    const XLSX = await import('xlsx');
    const workbook = XLSX.read(buffer, { type: 'array' });
    const firstSheetName = workbook.SheetNames?.[0];
    const sheet = firstSheetName ? workbook.Sheets[firstSheetName] : null;
    const csvText = sheet ? XLSX.utils.sheet_to_csv(sheet, { blankrows: false }) : '';
    return {
      csvText,
      file: new File([buffer], fileName, {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
      fileName,
    };
  }
  const csvText = await fetchTextFromS3(key);
  return {
    csvText,
    file: createFileFromCsv(csvText, fileName),
    fileName,
  };
};

const ensureTestingSubject = (rawSubject) => {
  return String(rawSubject || '').trim();
};

const ensureTestingBody = (rawBody) => {
  return String(rawBody || '').trimEnd();
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

const addDaysToDateKey = (dateKey, days) => {
  const raw = String(dateKey || '').trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return raw;
  const yyyy = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  const dt = new Date(Date.UTC(yyyy, mm - 1, dd));
  dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
  return dt.toISOString().slice(0, 10);
};

const applyTemplateVars = (text, vars) => {
  const raw = String(text || '');
  return raw.replace(/\{([a-z_]+)\}/gi, (match, key) => {
    const k = String(key || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(vars, k)) return String(vars[k] ?? '');
    return match;
  });
};

const TELANGANA_DA1_BODY_PLANTS = new Set(['BHUPALPALLY', 'KASIPET', 'KOTHAGUDEM']);

const isDayAheadTemplate = (templateId) => {
  const key = String(templateId || '').trim().toLowerCase();
  return key.includes('da0') || key.includes('da1');
};

const isTelanganaDa1Template = ({ plantCode, templateId }) => {
  const plant = normalizePlantCodeKey(plantCode);
  const key = String(templateId || '').trim().toLowerCase();
  return TELANGANA_DA1_BODY_PLANTS.has(plant) && key.includes('da1');
};

const isDa1HiddenForPlant = ({ plantCode, templateId }) => {
  const plant = normalizePlantCodeKey(plantCode);
  const key = String(templateId || '').trim().toLowerCase();
  return ['SIRMOUR', 'OSEPL'].includes(plant) && key.includes('da1');
};

const isSirmourIntradayTemplate = ({ plantCode, templateId, category }) => {
  const plant = normalizePlantCodeKey(plantCode);
  const key = String(templateId || '').trim().toLowerCase();
  const cat = String(category || '').trim().toLowerCase();
  return plant === 'SIRMOUR' && (key === 'sirmour_intraday' || key.includes('intra') || cat.includes('intra'));
};

const isGsnpIntradayTemplate = ({ plantCode, templateId, category }) => {
  const plant = normalizePlantCodeKey(plantCode);
  const key = String(templateId || '').trim().toLowerCase();
  const cat = String(category || '').trim().toLowerCase();
  return plant === 'GSNP' && (key === 'gsnp_intraday' || key.includes('intra') || cat.includes('intra'));
};

const isIliosPvIntradayTemplate = ({ plantCode, templateId, category }) => {
  const plant = normalizePlantCodeKey(plantCode);
  const key = String(templateId || '').trim().toLowerCase();
  const cat = String(category || '').trim().toLowerCase();
  return plant === 'ILIOS_PV' && (key === 'ilios_pv_intraday' || key.includes('intra') || cat.includes('intra'));
};

const buildSirmourIntradayBody = (dateKey) => {
  const vars = buildTemplateVars(dateKey);
  return `Dear Sir/Mam,\nPlease find attached Final Intraday Schedule SIRMOUR_PV for Date ${vars.date_dotted}.`;
};

const buildGsnpIntradaySubject = (dateKey) => {
  const vars = buildTemplateVars(dateKey);
  return `Globus Steel N Power Intraday for ${vars.month_full}-${vars.year_full}`;
};

const buildGsnpIntradayBody = (dateKey) => {
  const vars = buildTemplateVars(dateKey);
  return `Dear Sir/mam,\n\nPlease Find the attached Intraday Forecast of "Globus Steel N Power" for Date ${vars.date_dotted}`;
};

const buildIliosPvIntradaySubject = (dateKey) => {
  const vars = buildTemplateVars(dateKey);
  return `Ilios_PV Intraday Schedule for the Month of ${vars.month_full}_${vars.year_full}`;
};

const buildIliosPvIntradayBody = (dateKey) => {
  const vars = buildTemplateVars(dateKey);
  return `Dear Sir/Mam,\n\nPlease find attached the Intraday Schedule ILIOS_PV for Date ${vars.date_dotted}`;
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

const parseSupportNumber = (value) => {
  const raw = String(value ?? '').replace(/,/g, '').trim();
  if (!raw || raw === '-' || raw === '--') return null;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

const inferSupportUnit = (header) => {
  const key = String(header || '').toLowerCase();
  if (key.includes('kwh') || key.includes('kw h')) return 'kwh';
  if (key.includes('mw')) return 'mw';
  return 'mw';
};

const supportValueToKwh = (value, header) => {
  const num = parseSupportNumber(value);
  if (!Number.isFinite(num)) return null;
  return inferSupportUnit(header) === 'kwh' ? num : num * 250;
};

const findSupportColumn = (headers, matchers) => {
  const normalized = (headers || []).map((h) => toHeaderKey(h));
  return normalized.findIndex((h) => matchers.some((matcher) => h.includes(matcher)));
};

const getSupportPenaltySlabs = (plantCode) => {
  const plant = normalizePlantCodeKey(plantCode);
  const state = PLANT_STATE_FALLBACK[plant] || '';
  const typeCfg = DSM_PENALTY_CONFIG_BY_STATE?.[state]?.byType?.Solar
    || DEFAULT_DSM_PENALTY_CONFIG?.byType?.Solar
    || {};
  const configured = Array.isArray(typeCfg.bands) ? typeCfg.bands : [];
  return configured.length
    ? configured.map((band) => ({
      min: Number(band.min || 0),
      max: Number.isFinite(Number(band.max)) ? Number(band.max) : Infinity,
      rate: Number(band.rate || 0),
    }))
    : [
      { min: 0, max: 15, rate: 0 },
      { min: 15, max: 20, rate: 0.5 },
      { min: 20, max: 25, rate: 0.75 },
      { min: 25, max: 35, rate: 1 },
      { min: 35, max: Infinity, rate: 1.5 },
    ];
};

const calculateSupportBandBreakup = ({ deviationKwh, avcKwh, plantCode }) => {
  const absDeviation = Math.abs(Number(deviationKwh || 0));
  const safeAvc = Math.abs(Number(avcKwh || 0));
  if (!Number.isFinite(absDeviation) || !Number.isFinite(safeAvc) || safeAvc <= 0 || absDeviation <= 0) {
    return { errorPct: 0, totalPenalty: 0, bandValues: [] };
  }
  const errorPct = (absDeviation / safeAvc) * 100;
  const slabs = getSupportPenaltySlabs(plantCode);
  const bandValues = slabs.map((slab) => {
    const spanPct = Math.max(0, Math.min(errorPct, slab.max) - slab.min);
    const energyKwh = safeAvc * (spanPct / 100);
    const penalty = energyKwh * Number(slab.rate || 0);
    return {
      label: `${slab.min}-${slab.max === Infinity ? 'Above' : slab.max}%`,
      penalty,
    };
  });
  const totalPenalty = bandValues.reduce((sum, band) => sum + Number(band.penalty || 0), 0);
  return { errorPct, totalPenalty, bandValues };
};

const buildSupportCalculationPreview = ({ preview, plantCode, reportDate }) => {
  const header = Array.isArray(preview?.header) ? preview.header : [];
  const rows = Array.isArray(preview?.rows) ? preview.rows : [];
  if (!header.length || !rows.length) return null;

  const blockIdx = findSupportColumn(header, ['block', 'timeblocks', 'blk']);
  const dateIdx = findSupportColumn(header, ['date', 'datetime']);
  const scheduleIdx = findSupportColumn(header, ['schedulekwh', 'schedulemw', 'scheduledkwh', 'scheduledmw', 'schedule']);
  const actualIdx = findSupportColumn(header, ['meterdatakwh', 'meterdatamw', 'meterkwh', 'metermw', 'actualkwh', 'actualmw', 'generationkwh', 'generationmw', 'actual']);
  const avcIdx = findSupportColumn(header, ['avckwh', 'avcmw', 'abckwh', 'abcmw', 'availabilitykwh', 'availabilitymw', 'capacity']);
  if (scheduleIdx === -1 || actualIdx === -1) return null;

  const plant = normalizePlantCodeKey(plantCode);
  const capacityKwh = Number(PLANT_CAPACITY_FALLBACK[plant] || 0) * 250;
  const supportColumns = [
    'Date',
    'Block',
    'Schedule kWh',
    'Meter kWh',
    'AvC/ABC kWh',
    'Deviation kWh',
    'Error %',
    'Direction',
    'Under Band 1',
    'Under Band 2',
    'Under Band 3',
    'Under Band 4',
    'Under Band 5',
    'Over Band 6',
    'Over Band 7',
    'Over Band 8',
    'Over Band 9',
    'Over Band 10',
    'Total DSM Penalty',
  ];

  const supportRows = rows.slice(0, 96).map((row, idx) => {
    const scheduleKwh = supportValueToKwh(row?.[scheduleIdx], header[scheduleIdx]) ?? 0;
    const actualKwh = supportValueToKwh(row?.[actualIdx], header[actualIdx]) ?? 0;
    const avcKwh = avcIdx !== -1
      ? (supportValueToKwh(row?.[avcIdx], header[avcIdx]) ?? capacityKwh)
      : capacityKwh;
    const deviationKwh = actualKwh - scheduleKwh;
    const direction = deviationKwh < 0 ? 'Under' : deviationKwh > 0 ? 'Over' : 'None';
    const breakup = calculateSupportBandBreakup({ deviationKwh, avcKwh, plantCode: plant });
    const bandPenalties = Array.from({ length: 5 }, (_, i) => Number(breakup.bandValues?.[i]?.penalty || 0));
    const underValues = direction === 'Under' ? bandPenalties : [0, 0, 0, 0, 0];
    const overValues = direction === 'Over' ? bandPenalties : [0, 0, 0, 0, 0];

    return {
      Date: dateIdx !== -1 ? (row?.[dateIdx] || reportDate || '') : (reportDate || ''),
      Block: blockIdx !== -1 ? (row?.[blockIdx] || idx + 1) : idx + 1,
      'Schedule kWh': scheduleKwh.toFixed(2),
      'Meter kWh': actualKwh.toFixed(2),
      'AvC/ABC kWh': Number(avcKwh || 0).toFixed(2),
      'Deviation kWh': deviationKwh.toFixed(2),
      'Error %': Number(breakup.errorPct || 0).toFixed(2),
      Direction: direction,
      'Under Band 1': underValues[0].toFixed(2),
      'Under Band 2': underValues[1].toFixed(2),
      'Under Band 3': underValues[2].toFixed(2),
      'Under Band 4': underValues[3].toFixed(2),
      'Under Band 5': underValues[4].toFixed(2),
      'Over Band 6': overValues[0].toFixed(2),
      'Over Band 7': overValues[1].toFixed(2),
      'Over Band 8': overValues[2].toFixed(2),
      'Over Band 9': overValues[3].toFixed(2),
      'Over Band 10': overValues[4].toFixed(2),
      'Total DSM Penalty': Number(breakup.totalPenalty || 0).toFixed(2),
    };
  });

  return { columns: supportColumns, rows: supportRows };
};

const PLANT_CAPACITY_FALLBACK = {
  BHUPALPALLY: 10,
  KASIPET: 15,
  KOTHAGUDEM: 37,
  OSEPL: 20,
  ANDAD: 7.5,
  BALAKWADA: 7.5,
  GUGARIYAKHEDI: 7.5,
  NANDGAON: 7.5,
  BAMKHAL: 5,
  SIRMOUR: 5.1,
  SAWDA: 7.5,
  ZETRIC: 25,
  ANJANGAON: 7.5,
  ILIOS_PV: 50,
};

const normalizePlantCodeKey = (plantCode) => {
  const code = String(plantCode || '').trim().toUpperCase();
  if (code === 'OSEL') return 'OSEPL';
  return code;
};
const getSpecialS3PlantFolder = (plantCode) => {
  const code = normalizePlantCodeKey(plantCode);
  if (code === 'ANJANGAON') return 'ANJANGOAN';
  return code;
};
const getSpecialS3PlantFolderAliases = (plantCode) => {
  const normalized = normalizePlantCodeKey(plantCode);
  const preferred = getSpecialS3PlantFolder(plantCode);
  return Array.from(new Set([preferred, normalized].filter(Boolean)));
};

const getVedanjaySldcSchedulePlantFolder = (plantCode) => {
  const code = normalizePlantCodeKey(plantCode);
  if (code === 'OSEL') return 'OSEPL';
  if (code === 'ANJANGOAN') return 'ANJANGAON';
  if (code === 'SHRIMOUR' || code === 'SHROMOUR') return 'SIRMOUR';
  if (code === 'ZETRICSOLARPARK') return 'ZETRIC';
  return code;
};

const getVedanjaySldcSchedulePrefix = (plantCode, dateKey) =>
  `Vedanjay SLDC Schedules/${getVedanjaySldcSchedulePlantFolder(plantCode)}/${String(dateKey || '').trim()}/`;

const pickLatestVedanjaySldcSchedule = (objects) => {
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
};

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
  const templateKey = String(template?.id || templateId || '').trim().toLowerCase();
  let subjectDateKey = dateKey;
  if (prefix === 'Dayahead Schedule' && isDayAheadTemplate(templateKey)) {
    try {
      const raw = String(dateKey || '').trim();
      const [yyyy, mm, dd] = raw.split('-').map((part) => Number(part));
      const nextDate = new Date(Date.UTC(yyyy, mm - 1, dd));
      nextDate.setUTCDate(nextDate.getUTCDate() + 1);
      subjectDateKey = nextDate.toISOString().slice(0, 10);
    } catch {
      subjectDateKey = dateKey;
    }
  }
  const dateLabel = formatDdMmYyyy(subjectDateKey);
  if (plant === 'SIRMOUR' && prefix === 'Intraday Schedule') {
    const capacity = formatSubjectCapacityMw(PLANT_CAPACITY_FALLBACK[plant]);
    return `Final Intraday Schedule ${plant} (${capacity} MW) for ${dateLabel}`;
  }
  if (plant === 'ILIOS_PV' && prefix === 'Dayahead Schedule') {
    return `Dayahead Schedule Ilios_PV (50MW) for ${dateLabel}`;
  }
  if (plant === 'ILIOS_PV' && prefix === 'Intraday Schedule') {
    return buildIliosPvIntradaySubject(dateKey);
  }
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
  ANDAD: 'Madhya Pradesh',
  BALAKWADA: 'Madhya Pradesh',
  GUGARIYAKHEDI: 'Madhya Pradesh',
  NANDGAON: 'Madhya Pradesh',
  BAMKHAL: 'Madhya Pradesh',
  SIRMOUR: 'Madhya Pradesh',
  SAWDA: 'Madhya Pradesh',
  ZETRIC: 'Maharashtra',
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

function parseScheduleSeriesMap(text, options = {}) {
  const { headers, rows } = parseCsvWithHeaderDetection(text);
  const normalized = headers.map(toHeaderKey);
  const blockIdx = normalized.findIndex((h) => h.includes('block') || h.includes('blk') || h === 'sno' || h.includes('srno'));
  if (blockIdx === -1) return new Map();

  const findCol = (matchers) => normalized.findIndex((h) => matchers.some((m) => h.includes(m)));
  const findExactCol = (value) => normalized.findIndex((h) => h === value);
  const siteCode = normalizePlantCodeKey(options.siteCode || options.plantCode || '');
  let scheduleIdx = siteCode === 'OSEPL'
    ? normalized.findIndex((h) => h.includes('declared') && h.includes('forecast'))
    : -1;
  if (scheduleIdx === -1) scheduleIdx = findExactCol('scheduledmw');
  if (scheduleIdx === -1) scheduleIdx = findCol(['scheduledmw']);
  if (scheduleIdx === -1) scheduleIdx = findCol(['algoschedulemw', 'algoschedule', 'systemschedule', 'finalschedule']);
  if (scheduleIdx === -1) scheduleIdx = findCol(['stationschedule']);
  if (scheduleIdx === -1) scheduleIdx = findCol(['schedule', 'scheduled']);
  if (scheduleIdx === -1) scheduleIdx = findCol(['baseforecastmw', 'baseforecast', 'base']);
  if (scheduleIdx === -1) scheduleIdx = findCol(['intradayforecastmw', 'intradayforecast', 'intraday']);
  if (scheduleIdx === -1) scheduleIdx = findCol(['forecastmw', 'forecast']);
  if (scheduleIdx === -1 && siteCode === 'SIRMOUR') {
    const sirmourIdx = normalized.findIndex(
      (h) => h.includes('sirmour') && !h.includes('availability') && !h.includes('capacity')
    );
    if (sirmourIdx !== -1) scheduleIdx = sirmourIdx;
  }
  if (['SIRMOUR', 'ANJANGAON'].includes(siteCode)) {
    const explicitForecastIdx = normalized.findIndex(
      (h) =>
        (h === 'forecast' || h === 'forcast' || h.endsWith('forecast') || h.endsWith('forcast')) &&
        !h.includes('availability') &&
        !h.includes('capacity')
    );
    if (explicitForecastIdx !== -1) scheduleIdx = explicitForecastIdx;
  }
  if (scheduleIdx !== -1) {
    const headerKey = normalized[scheduleIdx] || '';
    if (headerKey.includes('availability') || headerKey.includes('capacity') || headerKey.includes('meter') || headerKey.includes('actual')) {
      scheduleIdx = -1;
    }
  }
  if (scheduleIdx === -1) return new Map();

  const isOseplEndBlockTemplate =
    siteCode === 'OSEPL' &&
    !normalized.some((h) => h.includes('time') || h.includes('from') || h.includes('to')) &&
    normalized.includes('declaredforecast') &&
    normalized.includes('interavc') &&
    normalized.includes('schedule');

  const map = new Map();
  (rows || []).forEach((cols) => {
    const parsedBlock = parseBlockNumber(cols?.[blockIdx]);
    const block = isOseplEndBlockTemplate && Number.isFinite(parsedBlock) && parsedBlock >= 1
      ? parsedBlock + 1
      : parsedBlock;
    if (!Number.isFinite(block) || block < 1 || block > TOTAL_BLOCKS) return;
    const value = parseFloat(String(cols?.[scheduleIdx] ?? '').replace(/,/g, '').trim());
    if (!Number.isFinite(value)) return;
    map.set(block, value);
  });
  return map;
}

function parseAvailabilitySeriesMap(text, options = {}) {
  const { headers, rows } = parseCsvWithHeaderDetection(text);
  const normalized = headers.map(toHeaderKey);
  const blockIdx = normalized.findIndex((h) => h.includes('block') || h.includes('blk') || h === 'sno' || h.includes('srno'));
  if (blockIdx === -1) return new Map();

  const siteCode = normalizePlantCodeKey(options.siteCode || options.plantCode || '');
  let availabilityIdx = normalized.findIndex(
    (h) =>
      h.includes('availability') ||
      h.includes('availablecapacity') ||
      h.includes('avcmw') ||
      h.includes('interavc') ||
      h === 'avc'
  );
  if (availabilityIdx === -1 && siteCode === 'GSNP') {
    availabilityIdx = normalized.findIndex((h) => h.includes('globus') && !h.includes('forecast'));
  }
  if (availabilityIdx === -1) return new Map();

  const map = new Map();
  (rows || []).forEach((cols) => {
    const block = parseBlockNumber(cols?.[blockIdx]);
    if (!Number.isFinite(block) || block < 1 || block > TOTAL_BLOCKS) return;
    const value = parseFloat(String(cols?.[availabilityIdx] ?? '').replace(/,/g, '').trim());
    if (!Number.isFinite(value)) return;
    map.set(block, value);
  });
  return map;
}

const EMAIL_TELANGANA_PLANTS = new Set(['BHUPALPALLY', 'KASIPET', 'KOTHAGUDEM']);
const EMAIL_MH_TEMPLATE_PLANTS = new Set(['OSEPL', 'CME']);

function formatSchedulePreviewNumber(value, decimals = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '';
  const fixed = num.toFixed(decimals);
  return fixed.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
}

function blockToScheduleInterval(block) {
  const idx = Math.max(0, Number(block) - 1);
  const startMinutes = idx * 15;
  const endMinutes = (idx + 1) * 15;
  const fmt = (minutes) => {
    const hh = Math.floor(minutes / 60) % 24;
    const mm = minutes % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };
  return `${fmt(startMinutes)}-${fmt(endMinutes)}`;
}

function buildPreviewAvailabilityResolver(scheduleMap) {
  const activeBlocks = Array.from(scheduleMap.entries())
    .filter(([, value]) => Number.isFinite(Number(value)) && Number(value) > 0)
    .map(([block]) => Number(block))
    .filter((block) => Number.isFinite(block))
    .sort((a, b) => a - b);

  if (!activeBlocks.length) return () => 0;

  const first = activeBlocks[0];
  const last = activeBlocks[activeBlocks.length - 1];
  return (block, capacity) => {
    const safeBlock = Number(block);
    if (!Number.isFinite(safeBlock)) return capacity;
    if (safeBlock < first || safeBlock > last) return 0;
    return capacity;
  };
}

function buildSldcSchedulePreview({ csvText, plantCode }) {
  const plantKey = String(plantCode || '').trim().toUpperCase();
  const scheduleMap = parseScheduleSeriesMap(csvText, { plantCode });
  if (!plantKey || !scheduleMap || scheduleMap.size === 0) {
    const rawPreview = buildCsvPreview(csvText, 96);
    return enhanceSchedulePreviewRows({ preview: rawPreview, plantCode });
  }

  const capacity = Number(PLANT_CAPACITY_FALLBACK[plantKey] || 0);
  const resolveAvailability = buildPreviewAvailabilityResolver(scheduleMap);
  const gsnpAvailabilityMap = plantKey === 'GSNP' ? parseAvailabilitySeriesMap(csvText, { plantCode }) : null;

  if (EMAIL_TELANGANA_PLANTS.has(plantKey)) {
    return {
      header: ['Block', 'Time Period', 'Forecast(MW)', 'AvC(MW)', 'Station Schedule'],
      rows: Array.from({ length: TOTAL_BLOCKS }, (_, idx) => {
        const block = idx + 1;
        const scheduleValue = Number(scheduleMap.get(block));
        const stationSchedule = Number.isFinite(scheduleValue) ? scheduleValue : 0;
        const avc = resolveAvailability(block, capacity);
        return [
          block,
          blockToScheduleInterval(block),
          '',
          formatSchedulePreviewNumber(avc),
          formatSchedulePreviewNumber(stationSchedule),
        ];
      }),
    };
  }

  if (EMAIL_MH_TEMPLATE_PLANTS.has(plantKey)) {
    return {
      header: ['Block', 'Declared Forecast', 'Inter Avc', 'Schedule'],
      rows: Array.from({ length: TOTAL_BLOCKS }, (_, idx) => {
        const block = idx + 1;
        const scheduleValue = Number(scheduleMap.get(block));
        const schedule = Number.isFinite(scheduleValue) ? scheduleValue : 0;
        const avc = resolveAvailability(block, capacity);
        return [
          block,
          formatSchedulePreviewNumber(schedule),
          formatSchedulePreviewNumber(avc),
          formatSchedulePreviewNumber(schedule),
        ];
      }),
    };
  }

  return {
    header: ['Block', 'Block Interval', 'Availability', 'Forecast'],
    rows: Array.from({ length: TOTAL_BLOCKS }, (_, idx) => {
      const block = idx + 1;
      const forecastValue = Number(scheduleMap.get(block));
      const forecast = Number.isFinite(forecastValue) ? forecastValue : 0;
      const gsnpAvailability = gsnpAvailabilityMap?.has(block) ? Number(gsnpAvailabilityMap.get(block)) : null;
      const avc = Number.isFinite(gsnpAvailability) ? gsnpAvailability : resolveAvailability(block, capacity);
      return [
        block,
        blockToScheduleInterval(block),
        formatSchedulePreviewNumber(avc),
        formatSchedulePreviewNumber(forecast),
      ];
    }),
  };
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

async function buildSupportFilePreview(file, { plantCode, reportDate }) {
  const fileName = String(file?.name || '').toLowerCase();
  if (!file) return null;

  if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
    const XLSX = await import('xlsx');
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    const sheets = (workbook.SheetNames || []).slice(0, 6).map((sheetName) => {
      const sheet = workbook.Sheets?.[sheetName];
      const csvText = sheet ? XLSX.utils.sheet_to_csv(sheet, { blankrows: false }) : '';
      const preview = buildCsvPreview(csvText, 20);
      return {
        sheetName,
        rawPreview: preview,
        calculationPreview: buildSupportCalculationPreview({ preview, plantCode, reportDate }),
      };
    }).filter((sheet) => sheet.rawPreview?.header?.length);
    return { fileName: file.name, sheets };
  }

  const csvText = await file.text();
  const preview = buildCsvPreview(csvText, 25);
  return {
    fileName: file.name,
    sheets: preview ? [{
      sheetName: 'CSV',
      rawPreview: preview,
      calculationPreview: buildSupportCalculationPreview({ preview, plantCode, reportDate }),
    }] : [],
  };
}

function sanitizeSupportWorkbookSheetName(name, usedNames = new Set()) {
  const base = String(name || 'Sheet')
    .replace(/[:\\/?*\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31) || 'Sheet';
  let candidate = base;
  let suffix = 1;
  while (usedNames.has(candidate.toLowerCase())) {
    const tail = ` ${suffix}`;
    candidate = `${base.slice(0, Math.max(1, 31 - tail.length))}${tail}`;
    suffix += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function arrayBufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || []);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToBlob(base64Text, contentType = 'application/octet-stream') {
  const binary = atob(String(base64Text || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: contentType });
}

function downloadBrowserBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = String(fileName || 'download');
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function getVedanjayLogoBase64() {
  const logoPaths = ['/image.png', '/vedanjay logo.png'];
  for (const path of logoPaths) {
    try {
      const response = await fetch(path, { cache: 'force-cache' });
      if (!response.ok) continue;
      const buffer = await response.arrayBuffer();
      return { base64: arrayBufferToBase64(buffer), path };
    } catch {
      // Try the next configured logo path.
    }
  }
  return { base64: '', path: '' };
}

function makeSupportPreviewXlsxName(fileName, plantKey, dateKey) {
  const plant = String(plantKey || '').trim().toUpperCase();
  const dateLabel = formatDdMmYyyy(dateKey || '');
  if (plant === 'OSEPL') return `Daily_DSM_Penalty_Report_OSEPL_${dateLabel}.xlsx`;
  if (plant === 'SIRMOUR') return `Daily_DSM_Penalty_Report_SIRMOUR_${dateLabel}.xlsx`;
  if (isTelanganaDsmPlant(plant)) return `Daily_DSM_Penalty_Report_TELANGANA_${dateLabel}.xlsx`;
  const rawName = String(fileName || '').split(',')[0]?.trim() || '';
  const baseName = rawName
    ? rawName.replace(/\.[^.]+$/i, '')
    : `${String(plantKey || 'DSM').trim() || 'DSM'}_${String(dateKey || 'support').trim() || 'support'}_support_preview`;
  return `${baseName.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120) || 'support_preview'}.xlsx`;
}

async function buildSupportPreviewXlsxBase64(preview) {
  const workbookSheets = Array.isArray(preview?.workbookSheets) ? preview.workbookSheets : [];
  if (workbookSheets.length) {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    const usedNames = new Set();
    const logoInfo = await getVedanjayLogoBase64();
    const thinBorder = {
      top: { style: 'thin', color: { argb: 'FF000000' } },
      left: { style: 'thin', color: { argb: 'FF000000' } },
      bottom: { style: 'thin', color: { argb: 'FF000000' } },
      right: { style: 'thin', color: { argb: 'FF000000' } },
    };
    workbookSheets.forEach((sheet, index) => {
      const rows = Array.isArray(sheet?.rows) ? sheet.rows : [];
      if (!rows.length) return;
      const worksheet = workbook.addWorksheet(
        sanitizeSupportWorkbookSheetName(sheet?.sheetName || `Sheet ${index + 1}`, usedNames)
      );
      const isSummarySheet = String(sheet?.sheetName || '').trim().toLowerCase() === 'summary';
      const isTelanganaOfficeLayout = sheet?.layout === 'telangana-office';
      const isSirmourCalculationSheet = String(sheet?.sheetName || '').trim().toLowerCase() === 'sirmour_schedule';
      const firstSummaryRowIndex = isSummarySheet
        ? rows.findIndex((row) => Array.isArray(row) && row.some((value) => value !== null && value !== undefined && value !== ''))
        : -1;
      const summaryTopSpacerRows = isTelanganaOfficeLayout ? 0 : 11;
      const summaryRows = isSummarySheet && firstSummaryRowIndex >= 0 ? rows.slice(firstSummaryRowIndex) : rows;
      const rowsForSheet = isSummarySheet ? [...Array.from({ length: summaryTopSpacerRows }, () => []), ...summaryRows] : rows;
      rowsForSheet.forEach((rowValues) => {
        const values = Array.isArray(rowValues) ? rowValues : [rowValues ?? ''];
        const excelRow = worksheet.addRow(values);
        const hasAnyValue = excelRow.values.some((value, valueIndex) => valueIndex > 0 && value !== null && value !== undefined && value !== '');
        const rowText = values.map((value) => String(value ?? '').trim().toLowerCase()).join('|');
        const isHeaderRow =
          rowText.includes('timeslots(date+endtime)')
          || rowText.includes('datetime(date+block endtime)')
          || rowText.includes('installed capacity')
          || rowText.includes('deviation_charges')
          || rowText.includes('time blocks');
        excelRow.eachCell({ includeEmpty: false }, (cell) => {
          cell.font = { name: 'Calibri', size: 11, color: { argb: 'FF000000' } };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
          cell.alignment = { vertical: 'middle' };
          if (hasAnyValue) cell.border = thinBorder;
        });
        if (isSirmourCalculationSheet) {
          const columnFillByHeader = new Map();
          values.forEach((value, valueIndex) => {
            const header = String(value ?? '').trim().toLowerCase();
            if (['schedule(kwh)', 'meter data(kwh)', 'avc(kwh)'].includes(header)) {
              columnFillByHeader.set(valueIndex + 1, 'FFFFFF00');
            } else if (header === '% error') {
              columnFillByHeader.set(valueIndex + 1, 'FFFF6666');
            } else if (header === 'dsm penalty') {
              columnFillByHeader.set(valueIndex + 1, 'FF92D050');
            }
          });
          if (columnFillByHeader.size) worksheet.__sirmourColumnFillByHeader = columnFillByHeader;
          const fills = worksheet.__sirmourColumnFillByHeader;
          if (fills instanceof Map) {
            excelRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
              const fillColor = fills.get(colNumber);
              if (!fillColor) return;
              cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillColor } };
            });
          }
        }
        if (isHeaderRow) {
          excelRow.eachCell({ includeEmpty: false }, (cell) => {
            cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF000000' } };
            if (isSummarySheet) {
              cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFBDD7EE' } };
            }
          });
        }
      });
      if (isSummarySheet) {
        if (!isTelanganaOfficeLayout) {
          worksheet.mergeCells('B2:E2');
          worksheet.mergeCells('B3:E3');
          worksheet.getRow(1).height = 8;
          worksheet.getRow(2).height = 34;
          worksheet.getRow(3).height = 22;
          worksheet.getRow(4).height = 18;
          worksheet.getRow(5).height = 14;
        }
        if (!isTelanganaOfficeLayout && logoInfo.base64) {
          const logoId = workbook.addImage({ base64: logoInfo.base64, extension: 'png' });
          const isFullLogo = logoInfo.path === '/image.png';
          worksheet.addImage(logoId, {
            tl: { col: 0.15, row: 0.65 },
            ext: isFullLogo ? { width: 380, height: 88 } : { width: 78, height: 78 },
            editAs: 'oneCell',
          });
        }
        if (!isTelanganaOfficeLayout && logoInfo.path !== '/image.png') {
          worksheet.getCell('B2').value = 'VEDANJAY POWER';
          worksheet.getCell('B2').font = { name: 'Calibri', size: 18, bold: true, color: { argb: 'FF3F9E3F' } };
          worksheet.getCell('B3').value = 'CONNECTING TO A MORE SUSTAINABLE FUTURE';
          worksheet.getCell('B3').font = { name: 'Calibri', size: 8, bold: true, color: { argb: 'FF2D4B5A' } };
          worksheet.getCell('B2').alignment = { vertical: 'middle', horizontal: 'left' };
          worksheet.getCell('B3').alignment = { vertical: 'middle', horizontal: 'left' };
        }
        const firstVisibleRowIndex = rowsForSheet.findIndex((row) => Array.isArray(row) && row.some((value) => value !== null && value !== undefined && value !== ''));
        const summaryHeaderRowNumber = Math.max(1, firstVisibleRowIndex + 1);
        const summaryHeaderRow = worksheet.getRow(summaryHeaderRowNumber);
        summaryHeaderRow.height = 28;
        summaryHeaderRow.eachCell({ includeEmpty: false }, (cell) => {
          cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF000000' } };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFBDD7EE' } };
          cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
          cell.border = thinBorder;
        });
        worksheet.getRow(summaryHeaderRowNumber + 1).eachCell({ includeEmpty: false }, (cell) => {
          cell.border = thinBorder;
          cell.alignment = { vertical: 'middle', horizontal: 'left' };
        });
        if (isTelanganaOfficeLayout) {
          worksheet.mergeCells('A9:F9');
          ['A', 'B'].forEach((col) => {
            worksheet.getColumn(col).numFmt = 'dd\\.mm\\.yyyy';
          });
          worksheet.getColumn('C').numFmt = 'mmm-yy';
          worksheet.getColumn('F').numFmt = '0';
          worksheet.getColumn('G').numFmt = '0';
          worksheet.getColumn('H').numFmt = '0';
          worksheet.getColumn('I').numFmt = '0.00';
          worksheet.getColumn('J').numFmt = '0.00';
          worksheet.getColumn('K').numFmt = '0%';
        }
      }
      if (sheet?.layout === 'telangana-office-detail') {
        worksheet.mergeCells('B8:E8');
        worksheet.getColumn('A').numFmt = 'dd\\.mm\\.yyyy\\ h:mm';
        ['B', 'C', 'D', 'E', 'G', 'H'].forEach((col) => {
          worksheet.getColumn(col).numFmt = '0.00';
        });
        worksheet.getColumn('F').numFmt = '0.000';
      }
      worksheet.columns.forEach((column) => {
        let maxLength = 10;
        column.eachCell({ includeEmpty: false }, (cell) => {
          const value = cell.value;
          const text = typeof value === 'object' && value?.formula ? value.formula : String(value ?? '');
          maxLength = Math.max(maxLength, Math.min(42, text.length + 2));
        });
        column.width = maxLength;
      });
    });
    if (workbook.worksheets.length) {
      const output = await workbook.xlsx.writeBuffer();
      return arrayBufferToBase64(output);
    }
  }

  const XLSX = await import('xlsx');
  const workbook = XLSX.utils.book_new();
  const usedNames = new Set();
  const sheets = Array.isArray(preview?.sheets) ? preview.sheets : [];
  if (!sheets.length) return '';
  sheets.forEach((sheet, index) => {
    const rawPreview = sheet?.rawPreview || {};
    const header = Array.isArray(rawPreview.header) ? rawPreview.header : [];
    const rows = Array.isArray(rawPreview.rows) ? rawPreview.rows : [];
    if (!header.length && !rows.length) return;
    const aoa = [
      header.map((value) => value ?? ''),
      ...rows.map((row) => Array.isArray(row) ? row.map((value) => value ?? '') : [row ?? '']),
    ];
    const worksheet = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(
      workbook,
      worksheet,
      sanitizeSupportWorkbookSheetName(sheet?.sheetName || `Sheet ${index + 1}`, usedNames)
    );
  });
  if (!workbook.SheetNames?.length) return '';
  const output = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  return arrayBufferToBase64(output);
}

function buildDsmPayloadSupportPreview(payload, { plantCode, reportDate }) {
  const columns = Array.isArray(payload?.columns) ? payload.columns.map((col) => String(col || '')) : [];
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  if (!columns.length || !rows.length) return null;
  const rawRows = rows.map((row) => columns.map((col) => row?.[col] ?? ''));
  const plant = String(plantCode || '').trim().toUpperCase();
  const dateKey = String(reportDate || '').trim();
  const workbookSheets = Array.isArray(payload?.supportWorkbookSheets) ? payload.supportWorkbookSheets : [];
  const previewSheets = Array.isArray(payload?.supportPreviewSheets) && payload.supportPreviewSheets.length
    ? payload.supportPreviewSheets
    : [{
      sheetName: 'Summary',
      rawPreview: {
        header: columns,
        rows: rawRows,
      },
      calculationPreview: payload,
    }];
  return {
    fileName: makeSupportPreviewXlsxName('', plant, dateKey),
    schemaVersion: 'dsm-support-v2',
    sheets: previewSheets,
    workbookSheets,
  };
}

function normalizeSupportPreviewForDisplay(preview) {
  const sheets = Array.isArray(preview?.sheets) ? preview.sheets : [];
  if (!sheets.length) return preview;
  return {
    ...preview,
    sheets: sheets.map((sheet) => {
      const header = Array.isArray(sheet?.rawPreview?.header) ? sheet.rawPreview.header : [];
      const rows = Array.isArray(sheet?.rawPreview?.rows) ? sheet.rawPreview.rows : [];
      const lastHeader = String(header[header.length - 1] || '').trim().toLowerCase();
      const isSirmourCalculation = /calculations?/i.test(String(sheet?.sheetName || ''))
        && lastHeader.includes('dsm')
        && lastHeader.includes('penalty');
      if (!isSirmourCalculation || !header.length || !rows.length) return sheet;
      return {
        ...sheet,
        rawPreview: {
          ...sheet.rawPreview,
          rows: rows.map((row) => {
            const nextRow = Array.isArray(row) ? [...row] : [];
            if (nextRow.length === header.length - 1) {
              const penaltyValue = nextRow[nextRow.length - 1];
              nextRow.splice(nextRow.length - 1, 0, 0);
              nextRow[nextRow.length - 1] = penaltyValue;
            }
            while (nextRow.length < header.length) nextRow.push('');
            return nextRow.slice(0, header.length);
          }),
        },
      };
    }),
  };
}

function stripDsmSupportPayloadMetadata(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const {
    supportCalculationRows,
    supportCalculationRowsByPlant,
    supportPreviewSheets,
    supportWorkbookSheets,
    ...rest
  } = payload;
  return rest;
}

function formatDsmSupportNumber(value, decimals = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Number(num.toFixed(decimals));
}

function pickDsmSupportPreviewRows(rows) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  return sourceRows.slice(0, 96);
}

function calculateDsmSupportBandValues({ errorPct, avcKwh, plantKey }) {
  const safeErrorPct = Math.max(0, Number(errorPct || 0));
  const safeAvcKwh = Math.max(0, Number(avcKwh || 0));
  const slabs = getSupportPenaltySlabs(plantKey).filter((slab) => Number(slab?.rate || 0) > 0);
  const values = slabs.map((slab) => {
    const min = Number(slab.min || 0);
    const max = Number.isFinite(Number(slab.max)) ? Number(slab.max) : Infinity;
    const spanPct = Math.max(0, Math.min(safeErrorPct, max) - min);
    const energy = safeAvcKwh * (spanPct / 100);
    const rate = Number(slab.rate || 0);
    return { min, max, energy, rate, penalty: energy * rate };
  });
  const totalPenalty = values.reduce((sum, item) => sum + Number(item.penalty || 0), 0);
  return { values, totalPenalty };
}

function blockEndDateTimeLabel(dateKey, block) {
  const safeDate = String(dateKey || '').trim();
  const safeBlock = Math.max(1, Math.min(TOTAL_BLOCKS, Number(block) || 1));
  const totalMinutes = safeBlock * 15;
  const hh = Math.floor(totalMinutes / 60) % 24;
  const mm = totalMinutes % 60;
  return `${safeDate} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function getMonthToDateKeys(dateKey) {
  const match = String(dateKey || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return dateKey ? [dateKey] : [];
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const endDay = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex) || !Number.isFinite(endDay)) return [dateKey];
  return Array.from({ length: Math.max(0, endDay) }, (_, idx) => {
    const dt = new Date(Date.UTC(year, monthIndex, idx + 1));
    return dt.toISOString().slice(0, 10);
  });
}

function buildDsmSupportCalculationRows({ scheduleMap, meterMap, plantKey, dateKey, blockLimit = TOTAL_BLOCKS }) {
  const resolvedPlantKey = String(plantKey || '').trim().toUpperCase();
  const capMw = Number(PLANT_CAPACITY_FALLBACK[resolvedPlantKey] || 0);
  const plantState = String(PLANT_STATE_FALLBACK[resolvedPlantKey] || '').trim();
  const plantType = 'Solar';
  return Array.from({ length: Math.max(0, Math.min(TOTAL_BLOCKS, Number(blockLimit) || TOTAL_BLOCKS)) }, (_, idx) => {
    const block = idx + 1;
    const scheduleMwRaw = Number(scheduleMap?.get(block));
    const actualMwRaw = Number(meterMap?.get(block));
    const scheduleMw = Number.isFinite(scheduleMwRaw) ? Math.round((scheduleMwRaw + Number.EPSILON) * 100) / 100 : 0;
    const actualMw = Number.isFinite(actualMwRaw) ? actualMwRaw : 0;
    const scheduleKwh = scheduleMw * 250;
    const actualKwh = actualMw * 250;
    const avcKwh = capMw * 250;
    const avcMw = capMw;
    const errorPct = avcMw > 0 ? (Math.abs(actualMw - scheduleMw) / avcMw) * 100 : 0;
    const shortFallEnergy = Math.abs(actualMw - scheduleMw) * 250;
    const sharedPenalty = calculatePenaltyRs({
      scheduledMw: scheduleMw,
      actualMw,
      capacityMw: capMw,
      plantState,
      plantType,
    });
    const supportBands = calculateDsmSupportBandValues({
      errorPct,
      avcKwh,
      plantKey: resolvedPlantKey,
    });
    const safePenalty = Number.isFinite(Number(sharedPenalty))
      ? Number(sharedPenalty)
      : Number(supportBands.totalPenalty || 0);
    const activeBandIndex = (supportBands.values || []).reduce(
      (lastIndex, item, itemIndex) => (Number(item.energy || 0) > 0 ? itemIndex : lastIndex),
      -1
    );
    const band = activeBandIndex >= 0 ? activeBandIndex + 1 : 0;
    const bandEnergies = (supportBands.values || []).map((item) => Number(item.energy || 0));
    const bandEnergy = {
      band10To15: bandEnergies[0] || 0,
      band15To20: bandEnergies[1] || 0,
      band20To25: bandEnergies[2] || 0,
      bandAbove25: bandEnergies.slice(3).reduce((sum, value) => sum + Number(value || 0), 0),
    };
    return {
      block,
      date: dateKey,
      timeBlock: blockToScheduleInterval(block),
      dateTime: blockEndDateTimeLabel(dateKey, block),
      scheduleMw,
      actualMw,
      avcMw,
      scheduleKwh,
      actualKwh,
      avcKwh,
      errorPct,
      shortFallEnergy,
      band,
      penalty: safePenalty,
      maintenanceUpdate: 0,
      maintenancePenalty: safePenalty,
      bandDeviationValues: bandEnergies,
      ...bandEnergy,
    };
  });
}

function buildOseplSupportCalculationRows({ scheduleMap, meterMap, dateKey, blockLimit = TOTAL_BLOCKS }) {
  const capMw = Number(PLANT_CAPACITY_FALLBACK.OSEPL || 20);
  const ppaRate = 9.27;
  return Array.from({ length: Math.max(0, Math.min(TOTAL_BLOCKS, Number(blockLimit) || TOTAL_BLOCKS)) }, (_, idx) => {
    const block = idx + 1;
    const scheduleMwRaw = Number(scheduleMap?.get(block));
    const actualMwRaw = Number(meterMap?.get(block));
    const scheduleMw = Number.isFinite(scheduleMwRaw) ? Math.round((scheduleMwRaw + Number.EPSILON) * 100) / 100 : 0;
    const actualMw = Number.isFinite(actualMwRaw) ? actualMwRaw : 0;
    const settlement = calculateOseplSettlement(scheduleMw, actualMw, capMw);
    const office = calculateOseplOfficePayableReceivable(scheduleMw, actualMw, capMw);
    const scheduleKwh = Number(settlement?.scheduledEnergyKwh ?? (scheduleMw * 250));
    const actualKwh = Number(settlement?.actualEnergyKwh ?? (actualMw * 250));
    const avcKwh = Number(settlement?.avcKwh ?? (capMw * 250));
    const scheduledUnitPpa = scheduleKwh * ppaRate;
    const payable = Number(office?.payableRs || 0);
    const receivable = Number(office?.receivableRs || 0);
    const total = scheduledUnitPpa - payable + receivable;
    const generatorEndPenalty = Number(settlement?.finalPenaltyRs || 0);
    const scadaAvailability = 0;
    const scadaPenalty = scadaAvailability ? 0 : generatorEndPenalty;
    return {
      block,
      date: dateKey,
      dateTime: blockEndDateTimeLabel(dateKey, block),
      forecastKwh: scheduleKwh,
      actualKwh,
      avcKwh,
      errorPct: Number(settlement?.errorPctSigned ?? (avcKwh > 0 ? ((actualKwh - scheduleKwh) / avcKwh) * 100 : 0)),
      scheduledUnitPpa,
      payable,
      receivable,
      total,
      generatorEndPenalty,
      scadaAvailability,
      scadaPenalty,
    };
  });
}

function buildOseplSupportSheets({ summaryRow, calculationRows, dateKey, monthKey }) {
  const ppaRate = 9.27;
  const rows = Array.isArray(calculationRows) ? calculationRows : [];
  const summaryColumns = [
    'From',
    'To',
    'Month',
    'Project',
    'Installed Capacity',
    'SCADA availability',
    'Generation(Kwh)',
    'Scheduled unit*PPA',
    'Payable ',
    'Receivable',
    'DSM Penalty(Rs.)',
    'DSM penalty as per SCADA Availability/Maint information',
  ];
  const dailyRows = rows.filter((row) => String(row?.date || '').trim() === String(dateKey || '').trim());
  const fallbackRows = dailyRows.length ? dailyRows : rows;
  const getSummaryNumber = (key, fallback) => {
    const raw = summaryRow?.[key];
    const parsed = Number(String(raw ?? '').replace(/,/g, '').replace(/%/g, '').trim());
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const generationKwh = getSummaryNumber(
    'Generation(kWh)',
    fallbackRows.reduce((sum, row) => sum + Number(row.actualKwh || 0), 0)
  );
  const scheduledUnitPpa = getSummaryNumber(
    'Scheduled unit*PPA',
    fallbackRows.reduce((sum, row) => sum + Number(row.scheduledUnitPpa || 0), 0)
  );
  const payable = getSummaryNumber(
    'Payable',
    fallbackRows.reduce((sum, row) => sum + Number(row.payable || 0), 0)
  );
  const receivable = getSummaryNumber(
    'Receivable',
    fallbackRows.reduce((sum, row) => sum + Number(row.receivable || 0), 0)
  );
  const dsmPenalty = getSummaryNumber(
    'DSM Penalty (Rs.)',
    fallbackRows.reduce((sum, row) => sum + Number(row.generatorEndPenalty || 0), 0)
  );
  const scadaPenalty = getSummaryNumber(
    'SCADA Adjusted DSM',
    fallbackRows.reduce((sum, row) => sum + Number(row.scadaPenalty || 0), 0)
  );
  const summaryDataRow = [
    dateKey,
    dateKey,
    monthKey || '',
    'ESSEL',
    Number(PLANT_CAPACITY_FALLBACK.OSEPL || 20),
    summaryRow?.['SCADA availability %'] || '100%',
    formatDsmSupportNumber(generationKwh, 0),
    formatDsmSupportNumber(scheduledUnitPpa, 2),
    formatDsmSupportNumber(payable, 2),
    formatDsmSupportNumber(receivable, 2),
    formatDsmSupportNumber(dsmPenalty, 2),
    formatDsmSupportNumber(scadaPenalty, 2),
  ];
  const calcColumns = [
    'TimeSlots(date+endtime)',
    'Forecast(kwH)',
    'Actual(Kwh)',
    'AvC(kwh)',
    '% Error',
    'Scheduled unit*PPA',
    'Payable',
    'Receivable',
    'Total',
    'generator-end penalty(Rs.)',
    'Scada/Maintenance Information Availability',
    'Penalty As per Scada Information',
  ];
  const calcRows = rows.map((row) => [
    row.dateTime,
    formatDsmSupportNumber(row.forecastKwh, 2),
    formatDsmSupportNumber(row.actualKwh, 2),
    formatDsmSupportNumber(row.avcKwh, 2),
    formatDsmSupportNumber(row.errorPct, 2),
    formatDsmSupportNumber(row.scheduledUnitPpa, 2),
    formatDsmSupportNumber(row.payable, 2),
    formatDsmSupportNumber(row.receivable, 2),
    formatDsmSupportNumber(row.total, 2),
    formatDsmSupportNumber(row.generatorEndPenalty, 2),
    formatDsmSupportNumber(row.scadaAvailability, 0),
    formatDsmSupportNumber(row.scadaPenalty, 2),
  ]);
  const previewRows = pickDsmSupportPreviewRows(calcRows);
  return {
    supportPreviewSheets: [
      { sheetName: 'Summary', rawPreview: { header: summaryColumns, rows: [summaryDataRow] } },
      { sheetName: 'ESSEL', rawPreview: { header: calcColumns, rows: previewRows } },
    ],
    supportWorkbookSheets: [
      {
        sheetName: 'Summary',
        rows: [
          [],
          summaryColumns,
          summaryDataRow,
        ],
      },
      {
        sheetName: 'ESSEL',
        rows: [
          [],
          ['PPA Rate', '', ppaRate],
          ['Error Blocks', '', '', '', '', '', '', '', '', '', 1],
          ['From', 'Upto', 'UnderInjection Penalty(Rs.)', 'Overinjection penalty (Rs.)'],
          [0, 10, ppaRate, ppaRate],
          [10, 12, formatDsmSupportNumber(ppaRate * 1.1, 3), formatDsmSupportNumber(ppaRate * 0.9, 3)],
          [12, 15, formatDsmSupportNumber(ppaRate * 1.2, 3), formatDsmSupportNumber(ppaRate * 0.8, 3)],
          [15, '', formatDsmSupportNumber(ppaRate * 1.5, 3), 0],
          ['', '', '', '', '', '', '', '', '', 'A-B+C'],
          ['A', 'B', 'C', 'D=(B-C)*100/C', 'E=A*PPA rate', 'F', 'G', 'H=E-F+G'],
          ['', '', '', '', '', '', '', '', '', 'Under/Overinjection'],
          calcColumns,
          ...calcRows,
        ],
      },
    ],
  };
}

function buildSirmourSupportSheets({ summaryRow, calculationRows, dateKey }) {
  const sirmourRate = Number(getPpaRateRsPerKwh({ siteCode: 'SIRMOUR' }) || 2.94);
  const sirmourPenaltySlabs = [
    { from: 0, upto: 10, rate: 0 },
    { from: 10, upto: 15, rate: 0.5 },
    { from: 15, upto: 20, rate: 0.75 },
    { from: 20, upto: Infinity, rate: 1 },
  ];
  const calculateSirmourPenalty = (errorPct, avcKwh) => {
    const safeError = Math.max(0, Number(errorPct || 0));
    const safeAvc = Math.max(0, Number(avcKwh || 0));
    return sirmourPenaltySlabs.reduce((sum, slab) => {
      const upper = Number.isFinite(slab.upto) ? slab.upto : safeError;
      const span = Math.max(0, Math.min(safeError, upper) - slab.from);
      return sum + (safeAvc * (span / 100) * Number(slab.rate || 0));
    }, 0);
  };
  const calcColumns = [
    'Datetime(Date+Block endtime)',
    'Schedule(Kwh)',
    'Meter data(KWh)',
    'AvC(Kwh)',
    '% Error',
    'DSM Penalty',
  ];
  const normalizedRows = (calculationRows || []).map((row) => {
    const scheduleKwh = Number(row?.scheduleKwh || 0);
    const actualKwhRaw = Number(row?.actualKwh || 0);
    const actualKwh = Math.round(actualKwhRaw);
    const rawAvcKwh = Number(row?.avcKwh || 0);
    const avcKwh = scheduleKwh > 0 ? rawAvcKwh : 0;
    const errorPct = avcKwh > 0 ? (Math.abs(actualKwhRaw - scheduleKwh) / avcKwh) * 100 : 0;
    const penalty = calculateSirmourPenalty(errorPct, avcKwh);
    return {
      ...row,
      scheduleKwh,
      actualKwhRaw,
      actualKwh,
      avcKwh,
      errorPct,
      penalty,
    };
  });
  const previewCalculationRows = pickDsmSupportPreviewRows(normalizedRows, ['scheduleKwh', 'actualKwh', 'penalty']);
  const previewCalcRows = previewCalculationRows.map((row) => [
    row.dateTime || blockEndDateTimeLabel(dateKey, row.block),
    formatDsmSupportNumber(row.scheduleKwh),
    formatDsmSupportNumber(row.actualKwh),
    formatDsmSupportNumber(row.avcKwh),
    formatDsmSupportNumber(row.errorPct),
    formatDsmSupportNumber(row.penalty),
  ]);
  const workbookCalcRows = normalizedRows.map((row) => [
    row.dateTime || blockEndDateTimeLabel(dateKey, row.block),
    formatDsmSupportNumber(row.scheduleKwh),
    formatDsmSupportNumber(row.actualKwh),
    formatDsmSupportNumber(row.avcKwh),
    formatDsmSupportNumber(row.errorPct),
    formatDsmSupportNumber(row.penalty),
  ]);
  const generationKwh = normalizedRows.reduce((sum, row) => sum + Number(row.actualKwhRaw || 0), 0);
  const dsmPenaltyRs = normalizedRows.reduce((sum, row) => sum + Number(row.penalty || 0), 0);
  const netRevenue = generationKwh * sirmourRate;
  const impact = netRevenue > 0 ? dsmPenaltyRs / netRevenue : 0;
  const summaryColumns = ['From', 'To', 'Project', 'Installed \nCapacity (Mw)', 'Generation(Kwh)', 'DSM Penalty(Rs.)\n', 'Paisa/Kwh\n', 'Net Revenue\n', '%Impact\n'];
  const summaryDataRow = [
    `${dateKey} 00:15`,
    `${dateKey} 23:45`,
    'Sirmour_Schedule',
    summaryRow?.['Installed Capacity (MW)'] || 5.1,
    formatDsmSupportNumber(generationKwh),
    formatDsmSupportNumber(dsmPenaltyRs),
    generationKwh > 0 ? formatDsmSupportNumber((dsmPenaltyRs / generationKwh) * 100) : 0,
    formatDsmSupportNumber(netRevenue),
    `${formatDsmSupportNumber(impact * 100, 2)}%`,
  ];
  const supportSummaryRow = {
    From: dateKey,
    To: dateKey,
    Project: 'Sirmour_Schedule',
    'Installed Capacity (MW)': Number(summaryRow?.['Installed Capacity (MW)'] || 5.1).toFixed(1),
    'Generation (kWh)': String(formatDsmSupportNumber(generationKwh, 0)),
    'DSM Penalty (Rs.)': String(formatDsmSupportNumber(dsmPenaltyRs, 2)),
    'Paisa / kWh': generationKwh > 0 ? String(formatDsmSupportNumber((dsmPenaltyRs / generationKwh) * 100, 2)) : '--',
    'Net Revenue': String(formatDsmSupportNumber(netRevenue, 2)),
    '%Impact': `${formatDsmSupportNumber(impact * 100, 2)}%`,
  };
  return {
    supportSummaryRow,
    supportPreviewSheets: [
      { sheetName: 'Summary', rawPreview: { header: summaryColumns, rows: [summaryDataRow] } },
      { sheetName: 'Sirmour_Schedule', rawPreview: { header: calcColumns, rows: previewCalcRows } },
    ],
    supportWorkbookSheets: [
      {
        sheetName: 'Summary',
        rows: [
          [],
          [],
          [],
          [],
          [],
          [],
          ['', ...summaryColumns],
          ['', ...summaryDataRow],
        ],
      },
      {
        sheetName: 'Sirmour_Schedule',
        rows: [
          [],
          ['Deviation_Charges Blocks'],
          ['From', 'Upto', 'Deviation_Charges(Rs.)'],
          [0, 10, 0],
          [10, 15, 0.5],
          [15, 20, 0.75],
          [20, '', 1],
          [],
          calcColumns,
          ...workbookCalcRows,
        ],
      },
    ],
  };
}

function buildTelanganaSupportSheets({ summaryRows, calculationRowsByPlant }) {
  const columns = [
    'Date',
    'To',
    'Month',
    'Project',
    'Installed \nCapacity (Mw)',
    'Generation(Kwh)',
    'DSM Penalty(Rs.)\nAs per Scada Availability',
    'DSM Penalty As \nMaintenance Information',
    'Paisa/Kwh\nScada Availability',
    'Paisa/Kwh\nMaintenance Information',
    'Scada Availability(%)',
    'Remarks',
  ];
  const sourceSummaryRows = Array.isArray(summaryRows) ? summaryRows : [];
  const firstDateKey = String(sourceSummaryRows.find((row) => row?.Date || row?.DATE)?.Date || sourceSummaryRows.find((row) => row?.Date || row?.DATE)?.DATE || '').trim();
  const dateMatch = firstDateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const reportYear = dateMatch ? Number(dateMatch[1]) : new Date().getFullYear();
  const reportMonthIndex = dateMatch ? Number(dateMatch[2]) - 1 : new Date().getMonth();
  const reportDay = dateMatch ? Number(dateMatch[3]) : new Date().getDate();
  const reportDate = new Date(reportYear, reportMonthIndex, reportDay, 0, 15, 0, 0);
  const monthDate = new Date(reportYear, reportMonthIndex + 1, 0, 0, 0, 0, 0);
  const daysInMonth = monthDate.getDate();
  const plantTitleMap = {
    KASIPET: 'Kasipet',
    BHUPALPALLY: 'Bhupalpally',
    KOTHAGUDEM: 'Kothagudem',
  };
  const officePlantOrder = ['KASIPET', 'BHUPALPALLY', 'KOTHAGUDEM'];
  const getSummaryValue = (row, ...keys) => {
    for (const key of keys) {
      if (row?.[key] !== undefined && row?.[key] !== null && row?.[key] !== '') return row[key];
    }
    return '';
  };
  const numberFromSummary = (row, fallback, ...keys) => {
    const raw = getSummaryValue(row, ...keys);
    const parsed = Number(String(raw ?? '').replace(/,/g, '').replace(/%/g, '').trim());
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const summaryByPlant = new Map(
    sourceSummaryRows
      .filter((row) => row && typeof row === 'object')
      .map((row) => [String(row.Project || row.PROJECT || '').trim().toUpperCase(), row])
  );
  const summaryDataRows = officePlantOrder.map((plant, index) => {
    const sheetName = plantTitleMap[plant];
    const excelRow = index + 3;
    const sourceRow = summaryByPlant.get(plant) || {};
    const generation = numberFromSummary(sourceRow, 0, 'Generation (kWh)', 'GENERATION (KWH)', 'Generation(Kwh)');
    const dsmPenalty = numberFromSummary(sourceRow, 0, 'DSM Penalty (Rs.) As per SCADA Availability', 'DSM PENALTY (RS.), AS PER SCADA AVAILABILITY', 'DSM Penalty(Rs.)\nAs per Scada Availability');
    const maintenancePenalty = numberFromSummary(sourceRow, dsmPenalty, 'DSM Penalty (Rs.) As Maintenance Information', 'DSM PENALTY (RS.), AS MAINTENANCE INFORMATION', 'DSM Penalty As \nMaintenance Information');
    return [
      reportDate,
      reportDate,
      monthDate,
      sheetName,
      numberFromSummary(sourceRow, Number(PLANT_CAPACITY_FALLBACK[plant] || 0), 'Installed Capacity (MW)', 'INSTALLED CAPACITY (MW)', 'Installed \nCapacity (Mw)'),
      { formula: `SUMIFS(${sheetName}!C:C,${sheetName}!C:C,"<>#N/A",${sheetName}!$A:$A,">="&Summary!$A${excelRow},${sheetName}!$A:$A,"<="&Summary!$B${excelRow}+1)`, result: generation },
      { formula: `SUMIFS(${sheetName}!F:F,${sheetName}!F:F,"<>#N/A",${sheetName}!$A:$A,">="&Summary!$A${excelRow},${sheetName}!$A:$A,"<="&Summary!$B${excelRow}+1)`, result: dsmPenalty },
      { formula: `SUMIFS(${sheetName}!H:H,${sheetName}!H:H,"<>#N/A",${sheetName}!$A:$A,">="&Summary!$A${excelRow},${sheetName}!$A:$A,"<="&Summary!$B${excelRow}+1)`, result: maintenancePenalty },
      { formula: `G${excelRow}/F${excelRow}*100`, result: generation > 0 ? (dsmPenalty / generation) * 100 : 0 },
      { formula: `(H${excelRow}/F${excelRow}*100)`, result: generation > 0 ? (maintenancePenalty / generation) * 100 : 0 },
      { formula: `COUNTIFS(INDIRECT($D${excelRow}&"!$A:$A"),">="&$A${excelRow},INDIRECT($D${excelRow}&"!$A:$A"),"<"&$B${excelRow}+1,INDIRECT($D${excelRow}&"!$C:$C"),"<>#N/A")/((B${excelRow}-A${excelRow}+1)*96)`, result: 1 },
      '',
    ];
  });
  const summaryPreviewRows = summaryDataRows.map((row) => row.map((value) => {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'result')) return value.result;
    return value;
  }));
  const calculationColumns = [
    'Datetime(Date+Block endtime)',
    'Schedule(Kwh)',
    'Meter data(KWh)',
    'AvC(Kwh)',
    '% Error',
    'DSM penalty',
    'Maintenance Update',
    'DSM penalty as per Maintenance Updates',
  ];
  const supportPreviewSheets = [
    { sheetName: 'Summary', rawPreview: { header: columns, rows: summaryPreviewRows } },
  ];
  const supportWorkbookSheets = [
    {
      sheetName: 'Summary',
      layout: 'telangana-office',
      rows: [
        [],
        columns,
        ...summaryDataRows,
        [],
        [],
        [],
        [],
        ['*#N/A Means Meter Data Not Available'],
      ],
    },
  ];
  officePlantOrder.forEach((plant) => {
    const sheetName = plantTitleMap[plant];
    const calculationRows = Array.isArray(calculationRowsByPlant?.[plant]) ? calculationRowsByPlant[plant] : [];
    const previewRows = pickDsmSupportPreviewRows(calculationRows, ['scheduleKwh', 'actualKwh', 'penalty']);
    const rowsByBlock = new Map(calculationRows.map((row) => [Number(row?.block || 0), row]));
    const rows = [];
    for (let day = 1; day <= daysInMonth; day += 1) {
      for (let block = 1; block <= TOTAL_BLOCKS; block += 1) {
        const rowNumber = 10 + ((day - 1) * TOTAL_BLOCKS) + (block - 1);
        const dailyRow = day === reportDay ? rowsByBlock.get(block) : null;
        const scheduleKwh = formatDsmSupportNumber(dailyRow?.scheduleKwh);
        const actualKwh = formatDsmSupportNumber(dailyRow?.actualKwh);
        const avcKwh = formatDsmSupportNumber(dailyRow?.avcKwh ?? (Number(PLANT_CAPACITY_FALLBACK[plant] || 0) * 250));
        const errorPct = formatDsmSupportNumber(dailyRow?.errorPct);
        const penalty = formatDsmSupportNumber(dailyRow?.penalty, 3);
        const maintenanceUpdate = formatDsmSupportNumber(dailyRow?.maintenanceUpdate);
        const maintenancePenalty = formatDsmSupportNumber(dailyRow?.maintenancePenalty ?? dailyRow?.penalty, 2);
        rows.push([
          rowNumber === 10
            ? new Date(reportYear, reportMonthIndex, 1, 0, 15, 0, 0)
            : { formula: `A${rowNumber - 1}+TIME(0,15,0)`, result: new Date(reportYear, reportMonthIndex, day, 0, block * 15, 0, 0) },
          scheduleKwh,
          actualKwh,
          avcKwh,
          { formula: `IF(D${rowNumber}=0,0,100*ABS(B${rowNumber}-C${rowNumber})/D${rowNumber})`, result: errorPct },
          { formula: `IF(AND(E${rowNumber}>$A$5,E${rowNumber}<=$B$5),(E${rowNumber}-$A$5)*(D${rowNumber}*$A$5%*$C$5)/$A$5,IF(AND(E${rowNumber}>$A$6,E${rowNumber}<=$B$6),(D${rowNumber}*($B$5-$A$5)%*$C$5)+((E${rowNumber}-$A$6)*(D${rowNumber}*$A$6%*$C$6)/$A$6),IF(E${rowNumber}>$A$7,(D${rowNumber}*($B$5-$A$5)%*$C$5)+(D${rowNumber}*($B$6-$A$6)%*$C$6)+((E${rowNumber}-$A$7)*(D${rowNumber}*$A$7%*$C$7)/$A$7),0)))`, result: penalty },
          maintenanceUpdate,
          { formula: `IF(G${rowNumber}=0,F${rowNumber},0)`, result: maintenancePenalty },
        ]);
      }
    }
    const previewDataRows = previewRows.map((row) => [
      row.dateTime,
      formatDsmSupportNumber(row.scheduleKwh),
      formatDsmSupportNumber(row.actualKwh),
      formatDsmSupportNumber(row.avcKwh),
      formatDsmSupportNumber(row.errorPct),
      formatDsmSupportNumber(row.penalty),
      formatDsmSupportNumber(row.maintenanceUpdate),
      formatDsmSupportNumber(row.maintenancePenalty),
    ]);
    supportPreviewSheets.push({
      sheetName,
      rawPreview: { header: calculationColumns, rows: previewDataRows },
    });
    supportWorkbookSheets.push({
      sheetName,
      layout: 'telangana-office-detail',
      rows: [
        [],
        ['Deviation_Charges Blocks'],
        ['From', 'Upto', 'Deviation_Charges(Rs.)'],
        [0, 15, 0],
        [15, 25, 0.5],
        [25, 35, 1],
        [35, '', 1.5],
        ['', plant === 'BHUPALPALLY' ? 'Bhupalpalli' : sheetName],
        calculationColumns,
        ...rows,
      ],
    });
  });
  return { supportPreviewSheets, supportWorkbookSheets };
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

function isLikelyMidnightCarryRow(rawTime) {
  const parts = parseTimeParts(rawTime);
  if (!parts) return false;
  return parts.hh === 0 && parts.mm === 0 && (parts.ss > 0 || parts.ms > 0);
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
  return false;
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
      const endBlock = parseBlockFromTimestamp(textVal, { totalBlocks: TOTAL_BLOCKS });
      if (Number.isFinite(endBlock)) return endBlock;
      const startBlock = parseBlockFromStartTimestamp(textVal);
      if (Number.isFinite(startBlock)) return startBlock;
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

function parseMeterSeriesMap(text, options = {}) {
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
  const factor = resolveMeterMwFactor({
    plantCode: options?.plantCode || options?.plant_code,
    plantName: options?.plantName || options?.plant_name,
    sourceKey: options?.sourceKey || options?.source_key,
    explicitKw,
    explicitMw,
    averageValue: avg,
  });

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
    return null;
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

function SupportPreviewTable({ preview, maxRows = 12 }) {
  const header = Array.isArray(preview?.header) ? preview.header : [];
  const rows = Array.isArray(preview?.rows) ? preview.rows : [];
  if (!header.length || !rows.length) return null;
  return (
    <div className="rounded-md border border-border bg-background overflow-auto max-h-[240px]">
      <table className="min-w-full text-xs border-collapse">
        <thead className="sticky top-0 bg-muted border-b border-border">
          <tr>
            {header.map((h, idx) => (
              <th key={`${idx}-${h}`} className="px-2 py-1.5 text-left font-semibold text-foreground whitespace-nowrap border border-border">
                {String(h || '')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, maxRows).map((row, ridx) => (
            <tr key={ridx} className="hover:bg-muted/40">
              {header.map((_, cidx) => (
                <td key={cidx} className="px-2 py-1.5 whitespace-nowrap text-foreground border border-border">
                  {String(row?.[cidx] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SupportCalculationPreviewTable({ payload, maxRows = 12 }) {
  const columns = Array.isArray(payload?.columns) ? payload.columns : [];
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  if (!columns.length || !rows.length) return null;
  return (
    <div className="rounded-md border border-border bg-background overflow-auto max-h-[300px]">
      <table className="min-w-full text-xs border-collapse">
        <thead className="sticky top-0 bg-green-700 text-white">
          <tr>
            {columns.map((col) => (
              <th key={col} className="px-2 py-1.5 text-left font-semibold whitespace-nowrap border border-border">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, maxRows).map((row, ridx) => (
            <tr key={ridx} className="hover:bg-muted/40">
              {columns.map((col) => (
                <td key={col} className="px-2 py-1.5 whitespace-nowrap text-foreground border border-border">
                  {String(row?.[col] ?? '')}
                </td>
              ))}
            </tr>
          ))}
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
  const defaultEmployeeName = useMemo(() => defaultEmployeeNameForUser(currentUser), [currentUser]);
  const schedulerBaseUrl = useMemo(() => emailSchedulerBase(), []);
  const pageScrollRef = useRef(null);
  const pageTopRef = useRef(null);
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [metaError, setMetaError] = useState('');
  const [plants, setPlants] = useState([]);
  const [templatesByGroup, setTemplatesByGroup] = useState({});
  const [metaSourceUrl, setMetaSourceUrl] = useState('');
  const [visiblePlantSection, setVisiblePlantSection] = useState(null);
  const [dispatcherStatus, setDispatcherStatus] = useState(null);
  const [plantAutoEmailEnabled, setPlantAutoEmailEnabled] = useState({});
  const [recipientDefaults, setRecipientDefaults] = useState({});
  const [loadingSettings, setLoadingSettings] = useState(false);
  const [savingRecipientDefaults, setSavingRecipientDefaults] = useState(false);

  const [templateId, setTemplateId] = useState('');
  const [plantCode, setPlantCode] = useState('');
  const [scheduleDate, setScheduleDate] = useState(() => getIstTodayDateKey());
  const [reportDate, setReportDate] = useState(() => getIstTodayDateKey());
  const [scheduleTime, setScheduleTime] = useState(() => getIstNowTimeKey());
  const [amPm, setAmPm] = useState('AM');
  const [fromEmail, setFromEmail] = useState(DEFAULT_FROM_EMAIL);
  const [toEmail, setToEmail] = useState('');
  const [ccEmail, setCcEmail] = useState('');
  const [employeeName, setEmployeeName] = useState(() => defaultEmployeeNameForUser(currentUser));
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
  const [supportFilePreview, setSupportFilePreview] = useState(null);
  const [supportFilePreviewLoading, setSupportFilePreviewLoading] = useState(false);
  const [supportFilePreviewError, setSupportFilePreviewError] = useState('');
  const [dsmLocalScheduleByPlant, setDsmLocalScheduleByPlant] = useState(() => ({}));
  const [portalIssueImage, setPortalIssueImage] = useState(null);
  const [portalIssueMode, setPortalIssueMode] = useState(false);
  const [portalIssuePlants, setPortalIssuePlants] = useState(() => new Set());
  const [dsmCalculationVersion, setDsmCalculationVersion] = useState(0);
  const [dsmSentVersion, setDsmSentVersion] = useState(0);
  const [dsmPreviewLoading, setDsmPreviewLoading] = useState(false);

  const [isDsmEditing, setIsDsmEditing] = useState(false);
  const [dsmSourceMode, setDsmSourceMode] = useState('s3'); // s3 | local
  const [dsmPayloadSource, setDsmPayloadSource] = useState('s3'); // s3 | local_upload | local_edit
  const [dsmEditedPayload, setDsmEditedPayload] = useState(null);
  const [dsmS3Payload, setDsmS3Payload] = useState(null);
  const dsmEditKey = useMemo(() => `${String(plantCode || '').trim().toUpperCase()}|${String(reportDate || '').trim()}|${String(templateId || '').trim()}`, [plantCode, reportDate, templateId]);
  const lastDsmEditKeyRef = useRef(null);
  const dsmS3FetchSeqRef = useRef(0);
  const dsmMeterMapCacheRef = useRef(new Map());
  const dsmMeterMapPromiseCacheRef = useRef(new Map());
  const dsmEditedScheduleMapCacheRef = useRef(new Map());
  const dsmEditedScheduleMapPromiseCacheRef = useRef(new Map());
  const dsmLocalScheduleMapCacheRef = useRef(new Map());
  const [dsmS3LoadRequestKey, setDsmS3LoadRequestKey] = useState('');
  const telanganaDsmUploadCount = useMemo(
    () => TELANGANA_DSM_PLANTS.filter((plant) => dsmLocalScheduleByPlant?.[plant]?.scheduleMap).length,
    [dsmLocalScheduleByPlant]
  );
  const telanganaDsmUploadsReady = useMemo(
    () => TELANGANA_DSM_PLANTS.every((plant) => dsmLocalScheduleByPlant?.[plant]?.scheduleMap),
    [dsmLocalScheduleByPlant]
  );

  const PORTAL_ISSUE_PLANT_OPTIONS = useMemo(
    () => ['BHUPALPALLY', 'KASIPET', 'KOTHAGUDEM', 'ANJANGAON', 'ANDAD', 'BALAKWADA', 'GUGARIYAKHEDI', 'NANDGAON', 'BAMKHAL', 'OSEPL', 'SIRMOUR'],
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

    setFromEmail(DEFAULT_FROM_EMAIL);
    setEmployeeName(defaultEmployeeName);
    setToEmail('');
    setCcEmail('');
    setSubject('');
    setBody('');

    setScheduleAttachmentInfo(null);
    setScheduleAttachmentFile(null);
    setScheduleAttachmentPreview(null);
    setExtraAttachmentFile(null);
    setSupportFilePreview(null);
    setSupportFilePreviewLoading(false);
    setSupportFilePreviewError('');
    setDsmLocalScheduleByPlant({});
    setDsmPayloadSource('s3');
    setDsmS3LoadRequestKey('');
    setDsmS3Payload(null);
    setDsmEditedPayload(null);
    setDsmPreviewLoading(false);
    setDsmCalculationVersion(0);
    setDsmSentVersion(0);
  }, [defaultEmployeeName]);

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

  const buildManualEditedDsmPayloadFromS3 = useCallback(async () => {
    const dateKey = String(reportDate || scheduleDate || '').trim();
    const plantKey = String(plantCode || '').trim().toUpperCase();
    if (!dateKey || !plantKey) return null;

    const getMeterCacheKey = (resolvedPlantKey, targetDateKey = dateKey) => `${targetDateKey}|meter|${String(resolvedPlantKey || '').trim().toUpperCase()}`;
    const getEditedScheduleCacheKey = (resolvedPlantKey, targetDateKey = dateKey) => `${targetDateKey}|sldc_schedule|${String(resolvedPlantKey || '').trim().toUpperCase()}`;

    const getMeterMapForPlant = async (resolvedPlantKey, targetDateKey = dateKey) => {
      const cacheKey = getMeterCacheKey(resolvedPlantKey, targetDateKey);
      if (dsmMeterMapCacheRef.current.has(cacheKey)) {
        return dsmMeterMapCacheRef.current.get(cacheKey) || null;
      }
      if (dsmMeterMapPromiseCacheRef.current.has(cacheKey)) {
        return dsmMeterMapPromiseCacheRef.current.get(cacheKey);
      }

      const promise = (async () => {
        const meterPrefixes = resolvedPlantKey === 'ZETRIC'
          ? [`raw/vedanjay/multiple_generator/ZTRIC/${targetDateKey}/metered_data/`]
          : [
            `raw/vedanjay/${resolvedPlantKey}/${targetDateKey}/metered_data/`,
            ...(resolvedPlantKey === 'ANJANGAON' ? [`raw/vedanjay/ANJANGOAN/${targetDateKey}/metered_data/`] : []),
            `generated/vedanjay/${resolvedPlantKey}/outputs/${targetDateKey}/meter/`,
            `outputs/${targetDateKey}/meter/`,
            `${targetDateKey}/meter/`,
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
        const meterMap = parseMeterSeriesMap(meterText, {
          plantCode: resolvedPlantKey,
          sourceKey: latestMeter.key,
        });
        return meterMap && meterMap.size > 0 ? meterMap : null;
      })();

      dsmMeterMapPromiseCacheRef.current.set(cacheKey, promise);
      try {
        const meterMap = await promise;
        dsmMeterMapCacheRef.current.set(cacheKey, meterMap || null);
        return meterMap || null;
      } finally {
        dsmMeterMapPromiseCacheRef.current.delete(cacheKey);
      }
    };

    const getEditedScheduleMapForPlant = async (resolvedPlantKey, targetDateKey = dateKey) => {
      const cacheKey = getEditedScheduleCacheKey(resolvedPlantKey, targetDateKey);
      if (dsmEditedScheduleMapCacheRef.current.has(cacheKey)) {
        return dsmEditedScheduleMapCacheRef.current.get(cacheKey) || null;
      }
      if (dsmEditedScheduleMapPromiseCacheRef.current.has(cacheKey)) {
        return dsmEditedScheduleMapPromiseCacheRef.current.get(cacheKey);
      }

      const promise = (async () => {
        const prefix = getVedanjaySldcSchedulePrefix(resolvedPlantKey, targetDateKey);
        const objects = await listS3ObjectsAcrossPrefixes([prefix], undefined, { user: currentUser });
        const latestSchedule = pickLatestVedanjaySldcSchedule(objects);
        if (!latestSchedule?.key) return null;
        const loaded = await readS3ScheduleObjectForEmail(latestSchedule.key);
        const scheduleMap = parseScheduleSeriesMap(loaded.csvText, { siteCode: resolvedPlantKey });
        return scheduleMap && scheduleMap.size > 0 ? scheduleMap : null;
      })();

      dsmEditedScheduleMapPromiseCacheRef.current.set(cacheKey, promise);
      try {
        const scheduleMap = await promise;
        dsmEditedScheduleMapCacheRef.current.set(cacheKey, scheduleMap || null);
        return scheduleMap || null;
      } finally {
        dsmEditedScheduleMapPromiseCacheRef.current.delete(cacheKey);
      }
    };

    const buildPayloadFromScheduleAndMeter = async ({ scheduleMap, plantKey: payloadPlantKey }) => {
      const resolvedPlantKey = String(payloadPlantKey || '').trim().toUpperCase();
      if (!resolvedPlantKey) return null;
      if (!scheduleMap || scheduleMap.size === 0) return null;

      const meterMap = await getMeterMapForPlant(resolvedPlantKey);
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
        return Math.round((sched + Number.EPSILON) * 100) / 100;
      };
      const supportCalculationRows = buildDsmSupportCalculationRows({
        scheduleMap,
        meterMap,
        plantKey: resolvedPlantKey,
        dateKey,
        blockLimit: TOTAL_BLOCKS,
      });

      const generationKwh = dsmBlocks.reduce((sum, block) => {
        const actualMw = Number(meterMap.get(block));
        if (!Number.isFinite(actualMw)) return sum;
        return sum + (actualMw * BLOCK_HOURS * KWH_PER_MWH);
      }, 0);

      if (resolvedPlantKey === 'OSEPL') {
        const PPA_RATE = 9.27;
        const buildMonthCalculationRows = async () => {
          const dateKeys = getMonthToDateKeys(dateKey);
          const rowsByDate = await Promise.all(dateKeys.map(async (targetDateKey) => {
            if (targetDateKey === dateKey) {
              return buildOseplSupportCalculationRows({
                scheduleMap,
                meterMap,
                dateKey: targetDateKey,
                blockLimit: TOTAL_BLOCKS,
              });
            }
            const [targetScheduleMap, targetMeterMap] = await Promise.all([
              getEditedScheduleMapForPlant(resolvedPlantKey, targetDateKey).catch(() => null),
              getMeterMapForPlant(resolvedPlantKey, targetDateKey).catch(() => null),
            ]);
            return buildOseplSupportCalculationRows({
              scheduleMap: targetScheduleMap || new Map(),
              meterMap: targetMeterMap || new Map(),
              dateKey: targetDateKey,
              blockLimit: TOTAL_BLOCKS,
            });
          }));
          return rowsByDate.flat();
        };
        const scheduledUnitPpaBlockLimit = dateKey === getIstTodayDateKey() ? getCurrentIstBlock() : TOTAL_BLOCKS;
        const scheduledKwh = Array.from({ length: scheduledUnitPpaBlockLimit }, (_, i) => i + 1).reduce((sum, block) => {
          const sched = Number(scheduleMap.get(block));
          if (!Number.isFinite(sched)) return sum;
          const roundedSched = Math.round((sched + Number.EPSILON) * 100) / 100;
          return sum + (roundedSched * BLOCK_HOURS * KWH_PER_MWH);
        }, 0);

        const totals = dsmBlocks.reduce((acc, block) => {
          const sched = getScheduleMwForDsm(block);
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
        const oseplSupportCalculationRows = await buildMonthCalculationRows();
        const supportSheets = buildOseplSupportSheets({
          summaryRow: row,
          calculationRows: oseplSupportCalculationRows,
          dateKey,
          monthKey,
        });
        return {
          columns: Object.keys(row),
          rows: [row],
          variant: getDsmPreviewVariant(resolvedPlantKey),
          supportCalculationRows: oseplSupportCalculationRows,
          ...supportSheets,
        };
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
        const supportSheets = buildSirmourSupportSheets({
          summaryRow: row,
          calculationRows: supportCalculationRows,
          dateKey,
        });
        const previewRow = supportSheets.supportSummaryRow || row;
        return {
          columns,
          rows: [previewRow],
          variant: getDsmPreviewVariant(resolvedPlantKey),
          supportCalculationRows,
          ...supportSheets,
        };
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
      return {
        columns,
        rows: [row],
        variant: getDsmPreviewVariant(resolvedPlantKey),
        supportCalculationRows,
      };
    };

    // DSM preview must always use latest Vedanjay SLDC schedule from S3.
    // Special case: Telangana DSM is a single 3-plant summary report.
    const targetPlants = isTelanganaDsmPlant(plantKey) ? TELANGANA_DSM_PLANTS : [plantKey];

    const perPlantPayloads = (await Promise.all(
      targetPlants.map(async (targetPlant) => {
        const scheduleMap = await getEditedScheduleMapForPlant(targetPlant);
        if (!scheduleMap) return null;
        return buildPayloadFromScheduleAndMeter({ scheduleMap, plantKey: targetPlant });
      })
    )).filter((payload) => payload?.rows?.length);

    if (!perPlantPayloads.length) return null;
    if (!isTelanganaDsmPlant(plantKey)) return perPlantPayloads[0];
    if (perPlantPayloads.length !== targetPlants.length) return null;

    const columns = perPlantPayloads[0]?.columns || [];
    const rowByPlant = new Map(
      perPlantPayloads
        .flatMap((p) => (Array.isArray(p?.rows) ? p.rows : []))
        .map((row) => [String(row?.Project || '').trim().toUpperCase(), row])
        .filter(([k]) => k)
    );
    const rows = TELANGANA_DSM_PLANTS.map((p) => rowByPlant.get(p)).filter(Boolean);
    if (rows.length !== TELANGANA_DSM_PLANTS.length) return null;
    const calculationRowsByPlant = Object.fromEntries(
      TELANGANA_DSM_PLANTS.map((p) => {
        const payload = perPlantPayloads.find((item) => String(item?.rows?.[0]?.Project || '').trim().toUpperCase() === p);
        return [p, Array.isArray(payload?.supportCalculationRows) ? payload.supportCalculationRows : []];
      })
    );
    const supportSheets = buildTelanganaSupportSheets({
      summaryRows: rows,
      calculationRowsByPlant,
    });
    return { columns, rows, variant: 'multi', supportCalculationRowsByPlant: calculationRowsByPlant, ...supportSheets };
  }, [plantCode, reportDate, scheduleDate, currentUser, formatDsmMonthKey]);

  useEffect(() => {
    if (!isDsmTemplate) return;
    if (dsmSourceMode !== 's3') return;
    const shouldCalculateDsm =
      dsmPayloadSource === 'local_upload' || dsmS3LoadRequestKey === dsmEditKey;
    if (!shouldCalculateDsm) return;
    const dateKey = String(reportDate || scheduleDate || '').trim();
    const plantKey = String(plantCode || '').trim().toUpperCase();
    if (!dateKey || !plantKey) return;

    const seq = ++dsmS3FetchSeqRef.current;
    setDsmPreviewLoading(true);
    (async () => {
      try {
        const payload = await buildManualEditedDsmPayloadFromS3();
        if (seq !== dsmS3FetchSeqRef.current) return;
        setDsmS3Payload(payload);
        setDsmCalculationVersion((prev) => prev + 1);
        setDsmSentVersion(0);
      } catch {
        if (seq !== dsmS3FetchSeqRef.current) return;
        setDsmS3Payload(null);
      } finally {
        if (seq === dsmS3FetchSeqRef.current) setDsmPreviewLoading(false);
      }
    })();
  }, [
    isDsmTemplate,
    dsmSourceMode,
    dsmPayloadSource,
    dsmS3LoadRequestKey,
    dsmEditKey,
    plantCode,
    reportDate,
    scheduleDate,
    buildManualEditedDsmPayloadFromS3,
  ]);

  const effectiveS3DsmPayload = useMemo(() => {
    if (!isDsmTemplate) return { columns: [], rows: [] };
    return dsmS3Payload || { columns: [], rows: [] };
  }, [isDsmTemplate, dsmS3Payload]);

  useEffect(() => {
    if (!isDsmTemplate) {
      lastDsmEditKeyRef.current = null;
      setIsDsmEditing(false);
      setDsmSourceMode('s3');
      setDsmPayloadSource('s3');
      setDsmEditedPayload(null);
      setDsmS3Payload(null);
      setDsmS3LoadRequestKey('');
      setDsmPreviewLoading(false);
      return;
    }

    // Reset edits when plant/date/template changes (new preview context).
    if (lastDsmEditKeyRef.current !== dsmEditKey) {
      lastDsmEditKeyRef.current = dsmEditKey;
      setIsDsmEditing(false);
      setDsmSourceMode('s3');
      setDsmS3LoadRequestKey('');
      if (dsmPayloadSource === 'local_edit') {
        setDsmPayloadSource('s3');
      }
      setDsmEditedPayload(effectiveS3DsmPayload);
    }
  }, [isDsmTemplate, dsmEditKey, effectiveS3DsmPayload, dsmPayloadSource]);

  useEffect(() => {
    if (!isDsmTemplate) return;
    // If the underlying payload changes (e.g. user refreshed comparison data) while not editing,
    // keep the preview in sync.
    if (dsmSourceMode === 's3' && !isDsmEditing) setDsmEditedPayload(effectiveS3DsmPayload);
  }, [isDsmTemplate, isDsmEditing, dsmSourceMode, effectiveS3DsmPayload]);

  const effectiveDsmPayload = useMemo(() => {
    if (!isDsmTemplate) return { columns: [], rows: [] };
    return effectiveS3DsmPayload;
  }, [isDsmTemplate, effectiveS3DsmPayload]);

  const onDsmCellChange = useCallback((rowIndex, col, value) => {
    setDsmSourceMode('local');
    setDsmPayloadSource('local_edit');
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
    if (!dsmS3Payload && dsmPayloadSource === 's3' && dsmS3LoadRequestKey !== dsmEditKey) return '';
    if (scheduleAttachmentInfo?.schedule_type === 'vedanjay_sldc_multi') return 'Source: Vedanjay SLDC schedules + Meter from S3';
    if (isTelanganaDsmPlant(plantCode)) {
      return 'Source: Latest Vedanjay SLDC schedules + Meter from S3';
    }
    if (scheduleAttachmentInfo?.schedule_type === 'vedanjay_sldc') return 'Source: Vedanjay SLDC schedule + Meter from S3';
    return 'Source: Latest Vedanjay SLDC schedule + Meter from S3';
  }, [isDsmTemplate, dsmS3Payload, dsmPayloadSource, dsmS3LoadRequestKey, dsmEditKey, plantCode, scheduleAttachmentInfo]);
  const dsmReportReady = !isDsmTemplate || (!dsmPreviewLoading && dsmCalculationVersion > 0);
  const dsmReportConsumed = isDsmTemplate && dsmCalculationVersion > 0 && dsmSentVersion === dsmCalculationVersion;
  const needsScheduleAttachment = useMemo(() => {
    if (!selectedTemplate) return false;
    const cat = templateCategory.toLowerCase();
    if (cat.includes('portal')) return false;
    if (cat.includes('dsm')) return true;
    return cat.includes('day') || cat.includes('intra') || String(selectedTemplate?.requires_schedule_attachment || '').toLowerCase() === 'true';
  }, [selectedTemplate, templateCategory]);

  const visiblePlants = useMemo(
    () => filterPlantsForUser(plants, currentUser),
    [plants, currentUser]
  );
  const activePlants = useMemo(() => visiblePlants.filter((p) => p?.active), [visiblePlants]);

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
    const allowIntraday = selectedPlant === 'SIRMOUR' || selectedPlant === 'GSNP' || selectedPlant === 'ILIOS_PV';
    const allowedSuffixes = ['_da0', '_da1', '_dsm'];

    const out = {};
    const seen = new Set();

    Object.entries(templatesByGroupForPlant || {}).forEach(([group, items]) => {
      const filtered = (Array.isArray(items) ? items : []).filter((tpl) => {
        const id = String(tpl?.id || '').trim();
        if (!id) return false;
        if (isDa1HiddenForPlant({ plantCode: selectedPlant, templateId: id })) return false;
        const idLower = id.toLowerCase();
        const ok =
          allowedSuffixes.some((s) => idLower.endsWith(s)) ||
          (allowIntraday && (idLower === 'sirmour_intraday' || idLower === 'gsnp_intraday' || idLower === 'ilios_pv_intraday'));
        if (!ok) return false;
        if (seen.has(idLower)) return false;
        seen.add(idLower);
        return true;
      });
      if (filtered.length) out[group] = filtered;
    });

    return out;
  }, [templatesByGroupForPlant, plantCode]);

  useEffect(() => {
    if (isDa1HiddenForPlant({ plantCode, templateId })) {
      setTemplateId('');
    }
  }, [plantCode, templateId]);

  const fileTypeDropdownGroups = useMemo(() => {
    const selectedPlant = String(plantCode || '').trim().toUpperCase();
    const allowIntraday = selectedPlant === 'SIRMOUR' || selectedPlant === 'GSNP' || selectedPlant === 'ILIOS_PV';

    const allTemplates = Object.values(templatesByGroupForPlantFiltered || {}).flatMap((items) =>
      Array.isArray(items) ? items : []
    );

    const dayAhead = [];
    const intraday = [];
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

      if (allowIntraday && (key === 'sirmour_intraday' || key === 'gsnp_intraday' || key === 'ilios_pv_intraday')) {
        intraday.push(tpl);
        return;
      }

      if (key.endsWith('_da0') || key.endsWith('_da1')) {
        dayAhead.push(tpl);
      }
    });

    const out = {};
    if (intraday.length) out['Intraday'] = intraday;
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
      setRecipientDefaults(normalizeRecipientDefaults(data?.recipient_defaults));
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
      setRecipientDefaults(normalizeRecipientDefaults(data?.recipient_defaults || recipientDefaults));
      toast.success(`${code} cron auto email is ${value ? 'ON' : 'OFF'}`);
    } catch (error) {
      toast.error(error?.message || 'Failed to update plant auto email setting');
      fetchSchedulerSettings();
    }
  }, [schedulerBaseUrl, role, currentUser, fetchSchedulerSettings, plantAutoEmailEnabled, recipientDefaults]);

  const selectedRecipientDefault = useMemo(
    () => getRecipientDefault(recipientDefaults, plantCode, templateId),
    [recipientDefaults, plantCode, templateId]
  );

  const saveRecipientDefaultsForSelection = useCallback(async ({ clear = false } = {}) => {
    if (!isAdmin) {
      toast.error('Recipient defaults are admin-only.');
      return;
    }
    const plant = normalizePlantCodeKey(plantCode);
    const template = String(templateId || '').trim();
    if (!plant || !template) {
      toast.error('Select plant and file type first.');
      return;
    }

    const nextMap = normalizeRecipientDefaults(recipientDefaults);
    if (clear) {
      if (nextMap[plant]) {
        delete nextMap[plant][template];
        if (!Object.keys(nextMap[plant]).length) delete nextMap[plant];
      }
    } else {
      const toValue = String(toEmail || '').trim();
      const ccValue = String(ccEmail || '').trim();
      if (!toValue && !ccValue) {
        toast.error('Enter To or CC email before saving defaults.');
        return;
      }
      nextMap[plant] = {
        ...(nextMap[plant] || {}),
        [template]: {
          to_email: toValue,
          cc_email: ccValue,
        },
      };
    }

    setSavingRecipientDefaults(true);
    setRecipientDefaults(nextMap);
    try {
      const response = await fetch(`${schedulerBaseUrl}/settings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [ROLE_HEADER]: role,
          [USER_HEADER]: String(currentUser?.username || currentUser?.empId || '').trim(),
        },
        body: JSON.stringify({ recipient_defaults: nextMap }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.detail || 'Failed to update recipient defaults');
      setRecipientDefaults(normalizeRecipientDefaults(data?.recipient_defaults || nextMap));
      toast.success(clear ? 'Recipient defaults cleared.' : 'Recipient defaults saved.');
    } catch (error) {
      toast.error(error?.message || 'Failed to update recipient defaults');
      fetchSchedulerSettings();
    } finally {
      setSavingRecipientDefaults(false);
    }
  }, [
    isAdmin,
    plantCode,
    templateId,
    recipientDefaults,
    toEmail,
    ccEmail,
    schedulerBaseUrl,
    role,
    currentUser,
    fetchSchedulerSettings,
  ]);

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
    const reportDateKey = reportDate || scheduleDate;
    const vars = buildTemplateVars(reportDateKey);
    const bodyDateKey = isDayAheadTemplate(templateId)
      ? addDaysToDateKey(reportDateKey, 1)
      : reportDateKey;
    const bodyVars = buildTemplateVars(bodyDateKey);
    const reportSubject = buildReportEmailSubject({
      template: selectedTemplate,
      templateId,
      category: templateCategory,
      plantCode,
      dateKey: reportDateKey,
    });
    const isGsnpIntraday = isGsnpIntradayTemplate({ plantCode, templateId, category: templateCategory });
    const isIliosPvIntraday = isIliosPvIntradayTemplate({ plantCode, templateId, category: templateCategory });
    const nextSubjectRaw = isGsnpIntraday
      ? buildGsnpIntradaySubject(reportDateKey)
      : isIliosPvIntraday
      ? buildIliosPvIntradaySubject(reportDateKey)
      : reportSubject || applyTemplateVars(String(selectedTemplate?.subject || '').trim(), vars);
    const nextBodyRaw = isGsnpIntraday
      ? buildGsnpIntradayBody(reportDateKey)
      : isIliosPvIntraday
      ? buildIliosPvIntradayBody(reportDateKey)
      : isSirmourIntradayTemplate({ plantCode, templateId, category: templateCategory })
      ? buildSirmourIntradayBody(reportDateKey)
      : applyTemplateVars(String(selectedTemplate?.body || '').trim(), bodyVars);
    const nextDefaultTo = sanitizeToAutofill(selectedRecipientDefault?.to_email || selectedTemplate?.default_to);
    const nextDefaultCc = String(selectedRecipientDefault?.cc_email || selectedTemplate?.default_cc || '').trim();
    const selectedTemplateId = String(selectedTemplate?.id || templateId || '').trim();
    const mailTypeChanged = Boolean(selectedTemplateId && lastAppliedTemplateIdRef.current !== selectedTemplateId);

    // Always keep a sane default From address (do not overwrite if user already set one).
    if (!String(fromEmail || '').trim() || String(fromEmail || '').trim().toLowerCase() === 'code.vedanjaypower@gmail.com') {
      setFromEmail(DEFAULT_FROM_EMAIL);
    }
    if (!String(employeeName || '').trim() || String(employeeName || '').trim() === 'Code Vedanjay') {
      setEmployeeName(defaultEmployeeName);
    }

    // Always auto-fill To/CC once (when empty) from saved/admin or template defaults, even in Custom mode.
    // This avoids placeholders for interns/employees while still not overwriting edits.
    if (mailTypeChanged) {
      setToEmail(nextDefaultTo);
      setCcEmail(nextDefaultCc);
    } else {
      if (!String(toEmail || '').trim() && nextDefaultTo) setToEmail(nextDefaultTo);
      if (!String(ccEmail || '').trim() && nextDefaultCc) setCcEmail(nextDefaultCc);
    }

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
  }, [selectedTemplate, selectedRecipientDefault, templateId, templateCategory, plantCode, customMode, isAdmin, reportDate, scheduleDate, subject, body, fromEmail, employeeName, defaultEmployeeName, toEmail, ccEmail]);

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
    setExtraAttachmentFile(null);
    setSupportFilePreview(null);
    setSupportFilePreviewLoading(false);
    setSupportFilePreviewError('');
    setDsmLocalScheduleByPlant({});
    setDsmPayloadSource('s3');
    setDsmS3LoadRequestKey('');
    setDsmS3Payload(null);
    setDsmEditedPayload(null);
    setDsmPreviewLoading(false);
    setDsmCalculationVersion(0);
    setDsmSentVersion(0);
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
  const supportPreviewLoadKeyRef = useRef('');

  const saveSupportPreviewToS3 = useCallback(async (preview, { fileName = '', sourceType = '', plantCodeOverride = '' } = {}) => {
    const dateKey = String(reportDate || scheduleDate || '').trim();
    const plantKey = String(plantCodeOverride || plantCode || '').trim().toUpperCase();
    if (!isDsmTemplate || !dateKey || !plantKey || !preview?.sheets?.length) return;
    try {
      let xlsxBase64 = '';
      try {
        xlsxBase64 = await buildSupportPreviewXlsxBase64(preview);
      } catch {
        xlsxBase64 = '';
      }
      await fetch(`${schedulerBaseUrl}/support-preview`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [ROLE_HEADER]: role,
          [USER_HEADER]: String(currentUser?.username || currentUser?.empId || '').trim(),
        },
        body: JSON.stringify({
          plant_code: plantKey,
          report_date: dateKey,
          file_name: String(fileName || preview?.fileName || '').trim(),
          source_type: String(sourceType || '').trim(),
          payload: preview,
          xlsx_base64: xlsxBase64,
          xlsx_file_name: xlsxBase64 ? makeSupportPreviewXlsxName(fileName || preview?.fileName, plantKey, dateKey) : '',
        }),
      });
    } catch {
      // Support preview persistence must not block DSM email work.
    }
  }, [currentUser, isDsmTemplate, plantCode, reportDate, role, scheduleDate, schedulerBaseUrl]);

  const loadStoredSupportPreview = useCallback(async () => {
    const dateKey = String(reportDate || scheduleDate || '').trim();
    const plantKey = String(plantCode || '').trim().toUpperCase();
    if (!isDsmTemplate || !dateKey || !plantKey) return null;
    try {
      const response = await fetch(
        `${schedulerBaseUrl}/support-preview?plant_code=${encodeURIComponent(plantKey)}&report_date=${encodeURIComponent(dateKey)}`,
        {
          headers: {
            [ROLE_HEADER]: role,
            [USER_HEADER]: String(currentUser?.username || currentUser?.empId || '').trim(),
          },
        }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.found || !data?.payload?.sheets?.length) {
        supportPreviewLoadKeyRef.current = '';
        return null;
      }
      const loadKey = `${plantKey}|${dateKey}`;
      if (supportPreviewLoadKeyRef.current && supportPreviewLoadKeyRef.current !== loadKey) {
        return data.payload;
      }
      setSupportFilePreview(normalizeSupportPreviewForDisplay(data.payload));
      setSupportFilePreviewError('');
      return normalizeSupportPreviewForDisplay(data.payload);
    } catch {
      supportPreviewLoadKeyRef.current = '';
      return null;
    }
  }, [currentUser, isDsmTemplate, plantCode, reportDate, role, scheduleDate, schedulerBaseUrl]);

  useEffect(() => {
    if (!isDsmTemplate) {
      setSupportFilePreview(null);
      setSupportFilePreviewError('');
      setSupportFilePreviewLoading(false);
      supportPreviewLoadKeyRef.current = '';
      return;
    }
    const dateKey = String(reportDate || scheduleDate || '').trim();
    const plantKey = String(plantCode || '').trim().toUpperCase();
    if (!dateKey || !plantKey) return;
    const loadKey = `${plantKey}|${dateKey}`;
    if (supportPreviewLoadKeyRef.current === loadKey) return;
    supportPreviewLoadKeyRef.current = loadKey;
    const timer = setTimeout(() => {
      loadStoredSupportPreview();
    }, 0);
    return () => clearTimeout(timer);
  }, [isDsmTemplate, loadStoredSupportPreview, plantCode, reportDate, scheduleDate]);

  useEffect(() => {
    if (!isDsmTemplate) return;
    if (dsmSourceMode !== 's3') return;
    if (dsmS3LoadRequestKey !== dsmEditKey) return;
    const dateKey = String(reportDate || scheduleDate || '').trim();
    const plantKey = String(plantCode || '').trim().toUpperCase();
    const supportPreview = buildDsmPayloadSupportPreview(dsmS3Payload, {
      plantCode: plantKey,
      reportDate: dateKey,
    });
    if (!supportPreview?.sheets?.length) return;
    const normalizedSupportPreview = normalizeSupportPreviewForDisplay(supportPreview);
    setSupportFilePreview(normalizedSupportPreview);
    setSupportFilePreviewError('');
    saveSupportPreviewToS3(normalizedSupportPreview, {
      fileName: normalizedSupportPreview.fileName,
      sourceType: 's3_dsm_calculation',
    });
  }, [dsmEditKey, dsmS3LoadRequestKey, dsmS3Payload, dsmSourceMode, isDsmTemplate, plantCode, reportDate, saveSupportPreviewToS3, scheduleDate]);

  const loadSupportPreviewFromFile = useCallback(async (file, { keepSelectedAttachment = false } = {}) => {
    if (!file) return null;
    if (keepSelectedAttachment) setExtraAttachmentFile(file);
    setSupportFilePreview(null);
    setSupportFilePreviewError('');
    setSupportFilePreviewLoading(true);
    try {
      const preview = await buildSupportFilePreview(file, {
        plantCode,
        reportDate: reportDate || scheduleDate,
      });
      const normalizedPreview = normalizeSupportPreviewForDisplay(preview);
      setSupportFilePreview(normalizedPreview);
      if (!normalizedPreview?.sheets?.length) {
        setSupportFilePreviewError('No previewable rows found in support file.');
      } else {
        saveSupportPreviewToS3(normalizedPreview, {
          fileName: file.name,
          sourceType: keepSelectedAttachment ? 'manual_support_file' : 'support_file',
        });
      }
      return normalizedPreview;
    } catch (err) {
      setSupportFilePreview(null);
      setSupportFilePreviewError(err?.message || 'Could not preview support file.');
      return null;
    } finally {
      setSupportFilePreviewLoading(false);
    }
  }, [plantCode, reportDate, saveSupportPreviewToS3, scheduleDate]);

  const loadSupportReportPreviewFromS3 = useCallback(async (plantCodes = null) => {
    const dateKey = String(reportDate || scheduleDate || '').trim();
    const selectedPlant = String(plantCode || '').trim().toUpperCase();
    const targets = (Array.isArray(plantCodes) && plantCodes.length ? plantCodes : [selectedPlant])
      .map((p) => String(p || '').trim().toUpperCase())
      .filter(Boolean);
    if (!dateKey || !targets.length) return null;

    setSupportFilePreview(null);
    setSupportFilePreviewError('');
    setSupportFilePreviewLoading(true);
    try {
      const allSheets = [];
      const loadedNames = [];

      for (const targetPlant of targets) {
        const prefixes = targetPlant === 'ZETRIC'
          ? [
            `raw/vedanjay/multiple_generator/ZTRIC/${dateKey}/`,
            `generated/vedanjay/multiple_generator/ZTRIC/${dateKey}/`,
            `uploads/vedanjay/ZETRIC/${dateKey}/`,
          ]
          : [
            `raw/vedanjay/${targetPlant}/${dateKey}/`,
            `generated/vedanjay/${targetPlant}/reports/${dateKey}/`,
            `uploads/vedanjay/${targetPlant}/${dateKey}/`,
          ];
        const objects = await listS3ObjectsAcrossPrefixes(prefixes, undefined, { user: currentUser });
        const candidates = (objects || []).filter((obj) => {
          const key = String(obj?.key || '').trim();
          const base = key.split('/').pop() || '';
          if (!/\.(xlsx|xls)$/i.test(base)) return false;
          if (!/(support|dsm|penalty|report)/i.test(base)) return false;
          return !/(schedule|sldc|dc_reg|reg_|intraday|dayahead)/i.test(base);
        });
        if (!candidates.length) continue;

        const scoreCandidate = (obj) => {
          const key = String(obj?.key || '');
          const base = key.split('/').pop()?.toLowerCase() || '';
          let score = 0;
          if (base.includes('support')) score += 8;
          if (base.includes('dsm')) score += 6;
          if (base.includes('penalty')) score += 5;
          if (base.includes('report')) score += 4;
          if (base.includes(targetPlant.toLowerCase())) score += 2;
          if (base.includes(dateKey)) score += 1;
          const time = Date.parse(String(obj?.lastModified || obj?.last_modified || ''));
          return { score, time: Number.isNaN(time) ? 0 : time, key };
        };

        const picked = [...candidates].sort((a, b) => {
          const sa = scoreCandidate(a);
          const sb = scoreCandidate(b);
          if (sb.score !== sa.score) return sb.score - sa.score;
          if (sb.time !== sa.time) return sb.time - sa.time;
          return sb.key.localeCompare(sa.key);
        })[0];

        const key = String(picked?.key || '').trim();
        if (!key) continue;
        const bytes = await fetchBytesFromS3(key);
        const fileName = key.split('/').pop() || `${targetPlant}_${dateKey}_support.xlsx`;
        const file = new File([bytes], fileName, {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
        const preview = await buildSupportFilePreview(file, {
          plantCode: targetPlant,
          reportDate: dateKey,
        });
        loadedNames.push(fileName);
        (preview?.sheets || []).forEach((sheet) => {
          allSheets.push({
            ...sheet,
            sheetName: targets.length > 1 ? `${targetPlant} - ${sheet.sheetName}` : sheet.sheetName,
          });
        });
      }

      const nextPreview = { fileName: loadedNames.join(', ') || 'DSM support XLSX from S3', sheets: allSheets };
      const normalizedNextPreview = normalizeSupportPreviewForDisplay(nextPreview);
      setSupportFilePreview(normalizedNextPreview);
      if (!allSheets.length) {
        if (isDsmTemplate) {
          supportPreviewLoadKeyRef.current = `${selectedPlant}|${dateKey}`;
          const storedPreview = await loadStoredSupportPreview();
          if (storedPreview?.sheets?.length) return storedPreview;
          setSupportFilePreviewError('');
        } else {
          setSupportFilePreviewError('Support XLSX report not found in S3 for selected date.');
        }
      } else {
        supportPreviewLoadKeyRef.current = `${selectedPlant}|${dateKey}|xlsx`;
        saveSupportPreviewToS3(normalizedNextPreview, {
          fileName: normalizedNextPreview.fileName,
          sourceType: 's3_support_xlsx',
        });
      }
      return normalizedNextPreview;
    } catch (err) {
      setSupportFilePreview(null);
      setSupportFilePreviewError(err?.message || 'Could not preview support XLSX report from S3.');
      return null;
    } finally {
      setSupportFilePreviewLoading(false);
    }
  }, [currentUser, isDsmTemplate, loadStoredSupportPreview, plantCode, reportDate, saveSupportPreviewToS3, scheduleDate]);

  const applyLoadedSchedulePreview = useCallback(async ({ csvTextRaw, fileName, attachmentInfo = null }) => {
    const csvText = String(csvTextRaw || '');
    const preview = isDsmTemplate
      ? enhanceSchedulePreviewRows({ preview: buildCsvPreview(csvText, 96), plantCode })
      : buildSldcSchedulePreview({ csvText, plantCode });
    const attachmentFile = createFileFromCsv(csvText, fileName || 'schedule.csv');

    setScheduleAttachmentPreview(preview);
    setScheduleAttachmentFile(attachmentFile);
    setScheduleAttachmentInfo(attachmentInfo);
    setScheduleAttachmentS3Status('');

    if (isDsmTemplate) {
      setIsDsmEditing(false);
      setDsmSourceMode('s3');
      setDsmPayloadSource('s3');
      setDsmEditedPayload(null);
    }

    return { preview, attachmentFile };
  }, [isDsmTemplate, plantCode]);

  const loadDsmEditedFrozenFromS3 = useCallback(async () => {
    const dateKey = String(reportDate || scheduleDate || '').trim();
    const normalizedPlant = String(plantCode || '').trim().toUpperCase();
    if (!dateKey || !normalizedPlant) {
      throw new Error('Plant and Report Date are required.');
    }
    setScheduleAttachmentS3Status('');

    const loadEditedScheduleMap = async (targetPlant) => {
      const plantKey = String(targetPlant || '').trim().toUpperCase();
      if (!plantKey) return null;
      const prefix = getVedanjaySldcSchedulePrefix(plantKey, dateKey);
      const objects = await listS3ObjectsAcrossPrefixes([prefix], undefined, { user: currentUser });
      const latestSchedule = pickLatestVedanjaySldcSchedule(objects);
      if (!latestSchedule?.key) return null;
      const loaded = await readS3ScheduleObjectForEmail(latestSchedule.key);
      return {
        plantKey,
        editedKey: latestSchedule.key,
        csvTextRaw: loaded.csvText,
        file: loaded.file,
        fileName: loaded.fileName,
        scheduleMap: parseScheduleSeriesMap(loaded.csvText, { siteCode: plantKey }),
      };
    };

    const targetPlants = isTelanganaDsmPlant(normalizedPlant) ? TELANGANA_DSM_PLANTS : [normalizedPlant];
    const loadedSchedules = [];
    for (const targetPlant of targetPlants) {
      const loaded = await loadEditedScheduleMap(targetPlant);
      if (!loaded?.scheduleMap) {
        setScheduleAttachmentS3Status('not_found');
        throw new Error(`Vedanjay SLDC schedule not found in S3 for ${targetPlant} on ${dateKey}.`);
      }
      loadedSchedules.push(loaded);
    }

    if (isTelanganaDsmPlant(normalizedPlant)) {
      const nextByPlant = loadedSchedules.reduce((acc, item) => {
        acc[item.plantKey] = { file: item.file, scheduleMap: item.scheduleMap };
        return acc;
      }, {});
      setDsmLocalScheduleByPlant(nextByPlant);
      setScheduleAttachmentFile(null);
      setScheduleAttachmentInfo({
        file_name: 'vedanjay_sldc_schedules_multi',
        attached_name: '',
        schedule_type: 'vedanjay_sldc_multi',
        lookup_date: dateKey,
        s3_key: loadedSchedules.map((item) => item.editedKey).join(','),
      });
      setScheduleAttachmentPreview(null);
      setIsDsmEditing(false);
      setDsmSourceMode('s3');
      setDsmPayloadSource('s3');
      setDsmEditedPayload(null);
      setDsmS3Payload(null);
      setDsmS3LoadRequestKey(dsmEditKey);
      loadSupportReportPreviewFromS3(TELANGANA_DSM_PLANTS);
      return { file: null, info: null, preview: null };
    }

    const single = loadedSchedules[0];
    const attachmentInfo = {
      file_name: single.fileName || 'vedanjay_sldc_schedule',
      attached_name: single.fileName || '',
      schedule_type: 'vedanjay_sldc',
      lookup_date: dateKey,
      s3_key: single.editedKey,
    };
    const { preview, attachmentFile } = await applyLoadedSchedulePreview({
      csvTextRaw: single.csvTextRaw,
      fileName: single.fileName || 'vedanjay_sldc_schedule.csv',
      attachmentInfo,
    });
    setDsmLocalScheduleByPlant({});
    setDsmPayloadSource('s3');
    setDsmS3Payload(null);
    setDsmS3LoadRequestKey(dsmEditKey);
    loadSupportReportPreviewFromS3([normalizedPlant]);
    return { file: attachmentFile, info: attachmentInfo, preview };
  }, [applyLoadedSchedulePreview, currentUser, dsmEditKey, loadSupportReportPreviewFromS3, plantCode, reportDate, scheduleDate]);

  const handleDsmTelanganaLocalUpload = useCallback(async (targetPlant, file) => {
    const resolvedPlant = String(targetPlant || '').trim().toUpperCase();
    if (!resolvedPlant || !file) return;

    setScheduleAttachmentS3Status('');
    setScheduleAttachmentInfo(null);
    setScheduleAttachmentFile(null);
    setScheduleAttachmentPreview(null);
    setDsmEditedPayload(null);
    setDsmS3Payload(null);
    setDsmPayloadSource('local_upload');
    setDsmCalculationVersion(0);
    setDsmSentVersion(0);
    setDsmPreviewLoading(true);
    setIsDsmEditing(false);
    setDsmSourceMode('s3');

    try {
      const csvTextRaw = await readUploadedTabularFile(file);
      const scheduleMap = parseScheduleSeriesMap(csvTextRaw, { siteCode: resolvedPlant });
      if (!scheduleMap || scheduleMap.size === 0) {
        throw new Error(`Could not read ${resolvedPlant} file.`);
      }

      setDsmLocalScheduleByPlant((prev) => ({
        ...(prev || {}),
        [resolvedPlant]: {
          file,
          scheduleMap,
        },
      }));
    } catch (err) {
      setDsmPreviewLoading(false);
      setDsmLocalScheduleByPlant((prev) => {
        const next = { ...(prev || {}) };
        delete next[resolvedPlant];
        return next;
      });
      toast.error(err?.message || `Could not read ${resolvedPlant} file.`);
    }
  }, []);

  const loadS3AttachmentForPreview = async () => {
    const plant = String(plantCode || '').trim();
    const tpl = String(templateId || '').trim();
    const date = String(reportDate || '').trim();
    if (!plant || !tpl || !date) return null;
    if (!needsScheduleAttachment) return null;
    if (isDsmTemplate) return loadDsmEditedFrozenFromS3();

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
    const preview = buildSldcSchedulePreview({ csvText: csvTextRaw, plantCode });
    setScheduleAttachmentPreview(preview);

    const normalizedPlant = String(plantCode || '').trim().toUpperCase();
    const isOsepl = normalizedPlant === 'OSEPL';
    const originalS3File = gotType === 'intraday' ? createFileFromBase64(data.file_base64, data.file_name) : null;
    let attachmentFile = originalS3File || createFileFromCsv(csvTextRaw, data.file_name);

    if (!originalS3File && isOsepl && gotType === 'dayahead') {
      try {
        const { buildOseplDayAheadCsvText } = await import('@/app/components/common/downloadUtils');
        const convertedCsv = buildOseplDayAheadCsvText(csvTextRaw, { reportDate });
        attachmentFile = createFileFromCsv(convertedCsv, data.file_name || 'OSEPL_dayahead.csv');
      } catch {
        attachmentFile = createFileFromCsv(csvTextRaw, data.file_name);
      }
    } else if (!originalS3File && !isOsepl) {
      const isTelanganaPlant = ['KASIPET', 'BHUPALPALLY', 'KOTHAGUDEM'].includes(normalizedPlant);
      const isSirmour = normalizedPlant === 'SIRMOUR';
      const sheetName = `${normalizedPlant} ${String(data.schedule_type || '').toUpperCase()}`.trim();
      const attachedXlsxName = withAttachmentExtension(data.file_name, '.xlsx');
      try {
        if (isTelanganaPlant) {
          const { generateTelanganaTemplateFromBaseXlsxBuffer } = await import('@/app/components/common/downloadUtils');
          const buffer = await generateTelanganaTemplateFromBaseXlsxBuffer(csvTextRaw, sheetName, undefined, {
            templateId,
            scheduleType: data.schedule_type,
            sourceKey: data.s3_key,
            fileName: data.file_name,
            plantCode: normalizedPlant,
            scheduleDate: data.lookup_date,
          });
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
    if (isDsmTemplate) return loadDsmEditedFrozenFromS3();

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
    const preview = buildSldcSchedulePreview({ csvText: csvTextRaw, plantCode });
    setScheduleAttachmentPreview(preview);
    if (!silent && preview && Array.isArray(preview.rows) && preview.rows.length < 96) {
      toast.warning(`Loaded schedule has ${preview.rows.length} rows in preview (expected 96 blocks). Attachment still includes full file.`);
    }

    const normalizedPlant = String(plantCode || '').trim().toUpperCase();
    const isOsepl = normalizedPlant === 'OSEPL';
    const originalS3File = gotType === 'intraday' ? createFileFromBase64(data.file_base64, data.file_name) : null;
    let attachmentFile = originalS3File || createFileFromCsv(csvTextRaw, data.file_name);

    if (!originalS3File && isOsepl && gotType === 'dayahead') {
      try {
        const { buildOseplDayAheadCsvText } = await import('@/app/components/common/downloadUtils');
        const convertedCsv = buildOseplDayAheadCsvText(csvTextRaw, { reportDate });
        attachmentFile = createFileFromCsv(convertedCsv, data.file_name || 'OSEPL_dayahead.csv');
      } catch (exc) {
        if (!silent) toast.error(`Template conversion failed; attaching CSV instead. (${exc?.message || 'error'})`);
        attachmentFile = createFileFromCsv(csvTextRaw, data.file_name);
      }
    } else if (!originalS3File && !isOsepl) {
      const isTelanganaPlant = ['KASIPET', 'BHUPALPALLY', 'KOTHAGUDEM'].includes(normalizedPlant);
      const isSirmour = normalizedPlant === 'SIRMOUR';
      const sheetName = `${normalizedPlant} ${String(data.schedule_type || '').toUpperCase()}`.trim();
      const attachedXlsxName = withAttachmentExtension(data.file_name, '.xlsx');
      try {
        if (isTelanganaPlant) {
          const { generateTelanganaTemplateFromBaseXlsxBuffer } = await import('@/app/components/common/downloadUtils');
          const buffer = await generateTelanganaTemplateFromBaseXlsxBuffer(csvTextRaw, sheetName, undefined, {
            templateId,
            scheduleType: data.schedule_type,
            sourceKey: data.s3_key,
            fileName: data.file_name,
            plantCode: normalizedPlant,
            scheduleDate: data.lookup_date,
          });
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

  const handleSupportFileUpload = useCallback(async (file) => {
    if (!file) return;
    loadSupportPreviewFromFile(file, { keepSelectedAttachment: true });
  }, [loadSupportPreviewFromFile]);

  const handleSupportFileDownload = useCallback(async () => {
    try {
      const dateKey = String(reportDate || scheduleDate || '').trim();
      const plantKey = String(plantCode || '').trim().toUpperCase();
      if (isDsmTemplate && ['OSEPL', 'SIRMOUR', ...TELANGANA_DSM_PLANTS].includes(plantKey)) {
        const payload = dsmS3Payload?.rows?.length ? dsmS3Payload : await buildManualEditedDsmPayloadFromS3();
        const generatedPreview = buildDsmPayloadSupportPreview(payload, {
          plantCode: plantKey,
          reportDate: dateKey,
        });
        if (generatedPreview?.workbookSheets?.length) {
          const normalizedGeneratedPreview = normalizeSupportPreviewForDisplay(generatedPreview);
          const base64 = await buildSupportPreviewXlsxBase64(normalizedGeneratedPreview);
          if (base64) {
            const blob = base64ToBlob(
              base64,
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            );
            downloadBrowserBlob(
              blob,
              makeSupportPreviewXlsxName(normalizedGeneratedPreview.fileName, plantKey, dateKey)
            );
            setSupportFilePreview(normalizedGeneratedPreview);
            saveSupportPreviewToS3(normalizedGeneratedPreview, {
              fileName: normalizedGeneratedPreview.fileName,
              sourceType: 'generated_support_download',
            });
            return;
          }
        }
      }

      if (supportFilePreview?.sheets?.length) {
        const base64 = await buildSupportPreviewXlsxBase64(supportFilePreview);
        if (!base64) {
          toast.error('Support file is not ready to download.');
          return;
        }
        const blob = base64ToBlob(
          base64,
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        downloadBrowserBlob(
          blob,
          makeSupportPreviewXlsxName(supportFilePreview.fileName, plantKey, dateKey)
        );
        return;
      }

      if (extraAttachmentFile) {
        downloadBrowserBlob(extraAttachmentFile, extraAttachmentFile.name || 'support-file');
        return;
      }

      toast.info('No support file is available to download.');
    } catch (error) {
      toast.error(error?.message || 'Could not download support file.');
    }
  }, [buildManualEditedDsmPayloadFromS3, dsmS3Payload, extraAttachmentFile, isDsmTemplate, plantCode, reportDate, saveSupportPreviewToS3, scheduleDate, supportFilePreview]);

  const buildGeneratedDsmSupportAttachmentFile = useCallback(async () => {
    if (!isDsmTemplate) return null;
    const dateKey = String(reportDate || scheduleDate || '').trim();
    const plantKey = String(plantCode || '').trim().toUpperCase();
    if (!dateKey || !plantKey) return null;
    if (!['OSEPL', 'SIRMOUR', ...TELANGANA_DSM_PLANTS].includes(plantKey)) return null;

    const payloadWithWorkbook = effectiveDsmPayload?.supportWorkbookSheets?.length
      ? effectiveDsmPayload
      : dsmS3Payload?.supportWorkbookSheets?.length
        ? dsmS3Payload
        : await buildManualEditedDsmPayloadFromS3();
    const generatedPreview = buildDsmPayloadSupportPreview(payloadWithWorkbook, {
      plantCode: plantKey,
      reportDate: dateKey,
    });
    if (!generatedPreview?.workbookSheets?.length) return null;
    const normalizedGeneratedPreview = normalizeSupportPreviewForDisplay(generatedPreview);
    const base64 = await buildSupportPreviewXlsxBase64(normalizedGeneratedPreview);
    if (!base64) return null;
    setSupportFilePreview(normalizedGeneratedPreview);
    saveSupportPreviewToS3(normalizedGeneratedPreview, {
      fileName: normalizedGeneratedPreview.fileName,
      sourceType: 'generated_support_email',
    });
    return createFileFromBase64(
      base64,
      makeSupportPreviewXlsxName(normalizedGeneratedPreview.fileName, plantKey, dateKey)
    );
  }, [buildManualEditedDsmPayloadFromS3, dsmS3Payload, effectiveDsmPayload, isDsmTemplate, plantCode, reportDate, saveSupportPreviewToS3, scheduleDate]);

  const buildJobFormData = (opts = {}) => {
    const { autoSendOverride, scheduleAttachmentFileOverride, supportAttachmentFileOverride } = opts || {};
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
    if (isDsmTemplate) {
      form.set('dsm_summary_payload', JSON.stringify(stripDsmSupportPayloadMetadata(effectiveDsmPayload || {})));
    }

    if (portalIssueMode && portalIssueImage) {
      form.set('attachment', portalIssueImage, portalIssueImage.name || 'portal-issue.png');
    } else {
      const scheduleFile = scheduleAttachmentFileOverride || scheduleAttachmentFile;
      if (scheduleFile && !isDsmTemplate) {
        form.set('schedule_attachment', scheduleFile, scheduleFile.name || 'schedule.csv');
      }
      const supportFile = supportAttachmentFileOverride || extraAttachmentFile;
      if (supportFile) {
        form.set('attachment', supportFile, supportFile.name || 'support-file.xlsx');
      }
    }
    return form;
  };

  const getSendNowFormData = async () => {
    if (isDsmTemplate) {
      const supportFile = await buildGeneratedDsmSupportAttachmentFile();
      return buildJobFormData({ supportAttachmentFileOverride: supportFile });
    }
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

  const getScheduledFormData = async (autoSendValue) => {
    const supportFile = isDsmTemplate ? await buildGeneratedDsmSupportAttachmentFile() : null;
    if (!needsScheduleAttachment || scheduleAttachmentFile || portalIssueMode || isDsmTemplate) {
      return buildJobFormData({
        autoSendOverride: autoSendValue,
        supportAttachmentFileOverride: supportFile,
      });
    }

    toast.message('Loading report attachment from S3...');
    const loaded = await loadS3Attachment({ silent: true });
    if (loaded?.file) {
      toast.success(`Loaded attachment: ${loaded.file.name}`);
      return buildJobFormData({
        autoSendOverride: autoSendValue,
        scheduleAttachmentFileOverride: loaded.file,
        supportAttachmentFileOverride: supportFile,
      });
    }
    return buildJobFormData({
      autoSendOverride: autoSendValue,
      supportAttachmentFileOverride: supportFile,
    });
  };

  const [jobs, setJobs] = useState([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [sendingNow, setSendingNow] = useState(false);
  const jobsRefreshInFlightRef = useRef(false);

  const refreshJobs = useCallback(async () => {
    if (jobsRefreshInFlightRef.current) return;
    jobsRefreshInFlightRef.current = true;
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
      jobsRefreshInFlightRef.current = false;
    }
  }, [schedulerBaseUrl, role, currentUser]);

  useEffect(() => {
    const shouldRun = () => document.visibilityState === 'visible';
    if (shouldRun()) refreshJobs();
    const id = setInterval(() => {
      if (shouldRun()) refreshJobs();
    }, 30000);
    return () => clearInterval(id);
  }, [refreshJobs]);

  const jobsForSelectedDate = useMemo(() => {
    const selectedDateKey = String(scheduleDate || '').trim();
    const items = Array.isArray(jobs) ? jobs : [];
    if (!selectedDateKey) return items;
    return items.filter((job) => {
      const raw = job?.scheduled_at;
      if (!raw) return false;
      const dt = new Date(raw);
      if (Number.isNaN(dt.getTime())) return false;
      const jobDateKey = dt.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      return jobDateKey === selectedDateKey;
    });
  }, [jobs, scheduleDate]);

  const [sendLogs, setSendLogs] = useState([]);
  const [loadingSendLogs, setLoadingSendLogs] = useState(false);
  const sendLogsRefreshInFlightRef = useRef(false);

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
    if (sendLogsRefreshInFlightRef.current) return;
    sendLogsRefreshInFlightRef.current = true;
    setLoadingSendLogs(true);
    try {
      const response = await fetch(`${schedulerBaseUrl}/send-logs?limit=200`, {
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
      sendLogsRefreshInFlightRef.current = false;
    }
  }, [schedulerBaseUrl, role, currentUser, isAdmin]);

  useEffect(() => {
    const shouldRun = () => document.visibilityState === 'visible';
    if (shouldRun()) refreshSendLogs();
    const id = setInterval(() => {
      if (shouldRun()) refreshSendLogs();
    }, 60000);
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
        body: await getScheduledFormData(true),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(data?.detail || 'Schedule failed.'));
      if (isDsmTemplate) setDsmSentVersion(dsmCalculationVersion);
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
        body: await getScheduledFormData(Boolean(autoSend)),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(data?.detail || 'Schedule failed.'));
      if (isDsmTemplate) setDsmSentVersion(dsmCalculationVersion);
      toast.success(autoSend ? 'Scheduled (auto-send) successfully.' : 'Queued successfully (auto-send is OFF).');
      refreshJobs();
      refreshSendLogs();
    } catch (err) {
      toast.error(err?.message || 'Schedule failed.');
    }
  };

  const sendNow = async () => {
    if (sendingNow) return;
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
      setSendingNow(true);
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
      if (isDsmTemplate) setDsmSentVersion(dsmCalculationVersion);
      toast.success('Sent successfully.');
      refreshJobs();
      refreshSendLogs();
    } catch (err) {
      toast.error(err?.message || 'Send failed.');
    } finally {
      setSendingNow(false);
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
              <div className="grid gap-4">
                <button
                  onClick={() => setVisiblePlantSection((p) => (p === 'active' ? null : 'active'))}
                  className="rounded-lg border border-border bg-muted/30 px-4 py-4 text-left hover:bg-accent/40 transition-all"
                >
                  <div className="text-xs text-muted-foreground">Active Plants</div>
                  <div className="mt-1 text-2xl font-semibold text-foreground">{activePlants.length}</div>
                </button>
              </div>
            )}
          </div>
        </section>

        {visiblePlantSection && (
          <section className="bg-card rounded-lg border border-border shadow-sm overflow-hidden">
            <div className="border-b border-border px-4 py-3 sm:px-6 sm:py-4 bg-muted/30">
              <div className="text-sm font-medium text-foreground">Plant Master Snapshot</div>
              <div className="mt-1 text-xs text-muted-foreground">Showing active plants.</div>
            </div>
            <div className="p-4 sm:p-6">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {activePlants.map((plant) => (
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

              {isAdmin && !portalIssueMode ? (
                <div className="rounded-md border border-border bg-muted/20 px-3 py-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="text-xs font-medium text-muted-foreground">Admin Recipient Defaults</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {selectedRecipientDefault
                          ? 'Saved defaults are active for this plant and file type.'
                          : 'Save current To/CC for the selected plant and file type.'}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => saveRecipientDefaultsForSelection()}
                        disabled={savingRecipientDefaults || !plantCode || !templateId}
                        className="inline-flex items-center justify-center rounded-md border border-border bg-background px-3 py-2 text-xs font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {savingRecipientDefaults ? 'Saving...' : 'Save To/CC'}
                      </button>
                      <button
                        type="button"
                        onClick={() => saveRecipientDefaultsForSelection({ clear: true })}
                        disabled={savingRecipientDefaults || !selectedRecipientDefault}
                        className="inline-flex items-center justify-center rounded-md border border-border bg-background px-3 py-2 text-xs font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}

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
                <div className="text-sm font-semibold text-foreground">
                  {isDsmTemplate ? 'DSM Calculation Source' : 'Schedule Attachment Source'}
                </div>

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
                    {isDsmTemplate ? 'Load DSM From S3 (CSV)' : 'Load Schedule File'}
                    </button>
                  {isAdmin ? (
                    isDsmTemplate && isTelanganaDsmPlant(plantCode) ? (
                      TELANGANA_DSM_PLANTS.map((targetPlant) => {
                        const loadedFile = dsmLocalScheduleByPlant?.[targetPlant]?.file || null;
                        return (
                          <label
                            key={targetPlant}
                            className="inline-flex flex-col gap-1 px-3 py-2 rounded-md border border-border bg-background hover:bg-accent transition-all text-sm cursor-pointer"
                          >
                            <input
                              type="file"
                              className="hidden"
                              accept=".csv,.xlsx,.xls"
                              onChange={async (e) => {
                                const f = e.target.files?.[0] || null;
                                e.target.value = '';
                                if (!f) return;
                                await handleDsmTelanganaLocalUpload(targetPlant, f);
                              }}
                            />
                            <span>{loadedFile ? `Replace ${targetPlant}` : `Upload ${targetPlant}`}</span>
                            <span className="text-[11px] text-muted-foreground">
                              {loadedFile ? loadedFile.name : 'CSV, XLSX, or XLS'}
                            </span>
                          </label>
                        );
                      })
                    ) : (
                      <label
                        className={`inline-flex px-3 py-2 rounded-md border border-border bg-background hover:bg-accent transition-all text-sm cursor-pointer ${
                          isDsmTemplate && ['SIRMOUR', 'OSEPL'].includes(String(plantCode || '').trim().toUpperCase())
                            ? 'flex-col gap-1'
                            : 'items-center gap-2'
                        }`}
                      >
                        <input
                          type="file"
                          className="hidden"
                          accept=".csv,.xlsx,.xls"
                          onChange={async (e) => {
                            const f = e.target.files?.[0] || null;
                            e.target.value = '';
                            if (!f) return;
                            setScheduleAttachmentS3Status('');
                            if (isDsmTemplate) {
                              setIsDsmEditing(false);
                              setDsmSourceMode('s3');
                              setDsmPayloadSource('local_upload');
                              setDsmS3LoadRequestKey('');
                              setDsmS3Payload(null);
                              setDsmEditedPayload(null);
                              setDsmLocalScheduleByPlant({});
                              setDsmCalculationVersion(0);
                              setDsmSentVersion(0);
                              setDsmPreviewLoading(true);
                            }
                            try {
                              const csvTextRaw = await readUploadedTabularFile(f);
                              const preview = isDsmTemplate
                                ? enhanceSchedulePreviewRows({ preview: buildCsvPreview(csvTextRaw, 96), plantCode })
                                : buildSldcSchedulePreview({ csvText: csvTextRaw, plantCode });
                              setScheduleAttachmentFile(f);
                              setScheduleAttachmentInfo(null);
                              setScheduleAttachmentPreview(preview);
                            } catch (err) {
                              if (isDsmTemplate) {
                                setDsmPayloadSource('s3');
                                setDsmPreviewLoading(false);
                              }
                              setScheduleAttachmentFile(null);
                              setScheduleAttachmentInfo(null);
                              setScheduleAttachmentPreview(null);
                              toast.error(err?.message || 'Could not read local schedule file.');
                            }
                          }}
                        />
                        {isDsmTemplate && ['SIRMOUR', 'OSEPL'].includes(String(plantCode || '').trim().toUpperCase()) ? (
                          <>
                            <span>
                              {scheduleAttachmentFile
                                ? `Replace ${String(plantCode || '').trim().toUpperCase()}`
                                : `Upload ${String(plantCode || '').trim().toUpperCase()}`}
                            </span>
                            <span className="text-[11px] text-muted-foreground">
                              {scheduleAttachmentFile ? scheduleAttachmentFile.name : 'CSV, XLSX, or XLS'}
                            </span>
                          </>
                        ) : (
                          <span>Load Locally</span>
                        )}
                      </label>
                    )
                  ) : null}
                </div>

                <div className="text-xs text-muted-foreground space-y-1">
                  {!scheduleAttachmentInfo ? (
                    <div>
                      {isDsmTemplate && dsmPreviewLoading
                        ? 'Calculating DSM preview...'
                        : isDsmTemplate && isTelanganaDsmPlant(plantCode)
                        ? (telanganaDsmUploadsReady
                          ? 'All Telangana plant files uploaded.'
                          : telanganaDsmUploadCount > 0
                            ? `Uploaded ${telanganaDsmUploadCount}/3 Telangana plant files.`
                            : 'Upload Bhupalpally, Kasipet, and Kothagudem files to calculate DSM.')
                        : scheduleAttachmentFile
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

                {isDsmTemplate && dsmPreviewLoading ? (
                  <div className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs font-medium text-foreground">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-primary" />
                    <span>Calculating DSM preview from uploaded schedule and meter data...</span>
                  </div>
                ) : null}

                {isDsmTemplate && dsmReportConsumed ? (
                  <div className="text-xs font-medium text-amber-700">
                    DSM report already sent for this loaded calculation. Load again to send a new copy.
                  </div>
                ) : null}

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

            {!portalIssueMode && isDsmTemplate && (
              <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-2">
                <div className="text-sm font-semibold text-foreground">Support File</div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-background hover:bg-accent transition-all text-sm cursor-pointer w-fit">
                    <input
                      type="file"
                      className="hidden"
                      accept=".pdf,.doc,.docx,.csv,.xlsx,.xls"
                      onChange={(e) => {
                        const f = e.target.files?.[0] || null;
                        e.target.value = '';
                        if (!f) return;
                        handleSupportFileUpload(f);
                      }}
                    />
                    <span>Choose Support File</span>
                  </label>
                  <button
                    type="button"
                    onClick={handleSupportFileDownload}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-background hover:bg-accent transition-all text-sm"
                  >
                    <Download className="w-4 h-4" />
                    <span>Download Support File</span>
                  </button>
                </div>
                {supportFilePreviewLoading ? (
                  <div className="text-xs text-muted-foreground">Preparing support file preview...</div>
                ) : null}
                {supportFilePreviewError ? (
                  <div className="text-xs font-medium text-amber-700">{supportFilePreviewError}</div>
                ) : null}
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
                disabled={isDsmTemplate && (!dsmReportReady || dsmReportConsumed)}
                className={`px-4 py-2 rounded-md bg-purple-600 text-white transition-all text-sm text-center ${
                  isDsmTemplate && (!dsmReportReady || dsmReportConsumed) ? 'opacity-50 cursor-not-allowed hover:bg-purple-600' : 'hover:bg-purple-700'
                }`}
              >
                {isDsmTemplate ? 'Send DSM Mail On Scheduled Time' : 'Send Attached Report On Scheduled Time'}
              </button>
              <button
                onClick={sendNow}
                disabled={sendingNow || (isDsmTemplate && (!dsmReportReady || dsmReportConsumed))}
                className={`px-4 py-2 rounded-md bg-amber-900 text-white transition-all text-sm text-center ${
                  sendingNow || (isDsmTemplate && (!dsmReportReady || dsmReportConsumed)) ? 'opacity-50 cursor-not-allowed hover:bg-amber-900' : 'hover:bg-amber-950'
                }`}
              >
                {sendingNow ? 'Sending...' : (isDsmTemplate ? 'Send DSM Mail Immediately' : 'Send Report Immediately')}
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
            {jobsForSelectedDate.length === 0 ? (
              <div className="text-sm text-muted-foreground">No scheduled jobs for selected date.</div>
            ) : (
              <div className="space-y-3">
                {jobsForSelectedDate.map((job) => (
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
                            {getSendLogEmployeeName(row)}
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
