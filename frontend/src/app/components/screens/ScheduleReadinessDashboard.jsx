import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  CheckCircle, Clock, MinusCircle, AlertCircle,
  FileText, AlertTriangle, Wind, Sun, Upload, ArrowRight,
  Layers, TrendingUp, X
} from 'lucide-react';
import { LoadingSpinner } from '@/app/components/common/LoadingSpinner';
import DownloadFormatModal from '@/app/components/common/DownloadFormatModal';
import { downloadCsvText, downloadXlsxFromCsvText } from '@/app/components/common/downloadUtils';
import { toast } from 'sonner';
import { S3_BASE_URL, HIDE_METADATA } from '@/config/appConfig';
import { scheduleReadinessApi } from '@/services/api';

const statusIcons = { READY: CheckCircle, PENDING: Clock, NO_ACTION: MinusCircle, UPLOADED: CheckCircle };
const READINESS_WORKFLOW_STORAGE_KEY = 'vedanjay-readiness-workflow-v1';
const SLDC_TEMPLATE_MAP_STORAGE_KEY = 'vedanjay-sldc-template-map-v1';
const getLocalDateKey = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export function ScheduleReadinessDashboard({ onNavigate }) {
  const [statusFilter, setStatusFilter] = useState('All');
  const [selectedPlant, setSelectedPlant] = useState(null);
  const [showActionModal, setShowActionModal] = useState(false);
  const [actionType, setActionType] = useState(null);
  const [actionReason, setActionReason] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [readinessData, setReadinessData] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState(() => getLocalDateKey());
  const [uploadedPlantFilter, setUploadedPlantFilter] = useState('All');
  const [templateViewRow, setTemplateViewRow] = useState(null);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [downloadFormat, setDownloadFormat] = useState('csv');
  const [pendingTemplateDownload, setPendingTemplateDownload] = useState(null);
  const [workflowByFile, setWorkflowByFile] = useState(() => {
    try {
      const raw = localStorage.getItem(READINESS_WORKFLOW_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  });
  const [sldcTemplateMapBySource, setSldcTemplateMapBySource] = useState(() => {
    try {
      const raw = localStorage.getItem(SLDC_TEMPLATE_MAP_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  });
  const triggerReasonInFlightRef = useRef(new Set());

  // =============================================================================
  // S3 CONFIG
  // =============================================================================
  const RAW_BASE_PREFIXES = [
    'raw/vedanjay/BHUPALPALLY/',
    'raw/vedanjay/CME/',
    'raw/vedanjay/GSNP/',
    'raw/vedanjay/KASIPET/',
    'raw/vedanjay/KILAJ/',
    'raw/vedanjay/KOTHAGUDEM/',
    'raw/vedanjay/OSEPL/',
    'raw/vedanjay/SIRMOUR/',
    'raw/GSNP/gsnp/',
    'raw/Sirmour/sirmour/',
  ];
  const GENERATED_OUTPUTS_BASE_PREFIXES = [
    'generated/vedanjay/BHUPALPALLY/outputs/',
    'generated/vedanjay/CME/outputs/',
    'generated/vedanjay/GSNP/outputs/',
    'generated/vedanjay/KASIPET/outputs/',
    'generated/vedanjay/KILAJ/outputs/',
    'generated/vedanjay/KOTHAGUDEM/outputs/',
    'generated/vedanjay/OSEPL/outputs/',
    'generated/vedanjay/SIRMOUR/outputs/',
    'generated/GSNP/gsnp/outputs/',
    'generated/Sirmour/sirmour/outputs/',
  ];
  const LEGACY_OUTPUTS_BASE_PREFIX = 'outputs/';

  const S3_PLANTS = [
    {
      id: 1,
      code: 'BHUPALPALLY',
      name: 'BHUPALPALLY',
      state: 'Telangana',
      type: 'Solar',
      capacity: 0,
    },
    {
      id: 2,
      code: 'CME',
      name: 'CME',
      state: 'Maharashtra',
      type: 'Solar',
      capacity: 0,
    },
    {
      id: 3,
      code: 'GSNP',
      name: 'Globus Steel N Power (GSNP)',
      state: 'Madhya Pradesh',
      type: 'Solar',
      capacity: 20,
    },
    {
      id: 4,
      code: 'KASIPET',
      name: 'KASIPET',
      state: 'Telangana',
      type: 'Solar',
      capacity: 0,
    },
    {
      id: 5,
      code: 'KOTHAGUDEM',
      name: 'KOTHAGUDEM',
      state: 'Telangana',
      type: 'Solar',
      capacity: 0,
    },
    {
      id: 6,
      code: 'KILAJ',
      name: 'KILAJ',
      state: 'Maharashtra',
      type: 'Solar',
      capacity: 20,
    },
    {
      id: 7,
      code: 'OSEPL',
      name: 'OSEPL',
      state: 'Maharashtra',
      type: 'Solar',
      capacity: 20,
    },
    {
      id: 8,
      code: 'SIRMOUR',
      name: 'SIRMOUR',
      state: 'Madhya Pradesh',
      type: 'Solar',
      capacity: 5.1,
    },
  ];

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

  function getDateSearchPrefixes(date) {
    return [
      ...RAW_BASE_PREFIXES.map((prefix) => `${prefix}${date}/`),
      ...GENERATED_OUTPUTS_BASE_PREFIXES.map((prefix) => `${prefix}${date}/`),
      `${LEGACY_OUTPUTS_BASE_PREFIX}${date}/`,
    ];
  }

  function getUploadSearchPrefixes(date) {
    return [
      `uploads/vedanjay/BHUPALPALLY/${date}/`,
      `uploads/vedanjay/CME/${date}/`,
      `uploads/vedanjay/GSNP/${date}/`,
      `uploads/vedanjay/KASIPET/${date}/`,
      `uploads/vedanjay/KILAJ/${date}/`,
      `uploads/vedanjay/KOTHAGUDEM/${date}/`,
      `uploads/vedanjay/OSEPL/${date}/`,
      `uploads/vedanjay/SIRMOUR/${date}/`,
    ];
  }

  function getPlantFromKey(key) {
    const normalized = String(key || '').toLowerCase();
    const vedanjayMatch = normalized.match(/\/vedanjay\/([^/]+)\//);
    if (vedanjayMatch?.[1]) {
      const code = vedanjayMatch[1].toUpperCase();
      return S3_PLANTS.find((plant) => plant.code === code) || S3_PLANTS[0];
    }
    const rawVedanjayMatch = normalized.match(/raw\/vedanjay\/([^/]+)\//);
    if (rawVedanjayMatch?.[1]) {
      const code = rawVedanjayMatch[1].toUpperCase();
      return S3_PLANTS.find((plant) => plant.code === code) || S3_PLANTS[0];
    }
    if (normalized.includes('/sirmour/sirmour/')) {
      return S3_PLANTS.find((plant) => plant.code === 'SIRMOUR');
    }
    if (normalized.includes('/gsnp/gsnp/')) {
      return S3_PLANTS.find((plant) => plant.code === 'GSNP');
    }
    return S3_PLANTS[0];
  }

  function isScheduleCsvKey(key) {
    const k = String(key || '').toLowerCase();
    return (
      k.endsWith('.csv') &&
      !k.includes('/intraday/') &&
      k.includes('schedule_from_')
    );
  }

  function isUploadedTemplateCsvKey(key) {
    const k = String(key || '').toLowerCase();
    const inUploadPrefix = k.includes('uploads/vedanjay/') || k.includes('/uploads/vedanjay/');
    const looksLikeTemplate = k.includes('sldc_template') || k.includes('template');
    return (
      k.endsWith('.csv') &&
      inUploadPrefix &&
      looksLikeTemplate
    );
  }

  function extractTrailingNumber(key) {
    const fileName = (key || '').split('/').pop() || '';
    const schedMatch = fileName.match(/schedule_from_(\d+)\.csv$/i);
    if (schedMatch) return parseInt(schedMatch[1], 10);
    const trailingMatch = fileName.match(/_(\d+)(?=\.[^.]+$)/);
    return trailingMatch ? parseInt(trailingMatch[1], 10) : null;
  }

  function extractScheduleRevisionToken(value) {
    const text = String(value || '');
    const match = text.match(/schedule_from_(\d+)/i);
    if (!match) return null;
    const revision = Number.parseInt(match[1], 10);
    return Number.isFinite(revision) ? revision : null;
  }

  function getPlantCodeFromKey(key) {
    const normalized = String(key || '').toLowerCase();
    const vedanjayMatch = normalized.match(/\/vedanjay\/([^/]+)\//);
    if (vedanjayMatch?.[1]) return vedanjayMatch[1].toUpperCase();
    if (normalized.includes('/sirmour/')) return 'SIRMOUR';
    if (normalized.includes('/gsnp/')) return 'GSNP';
    return 'GSNP';
  }

  function getS3ObjectUrl(key) {
    const encodedKey = String(key || '')
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return `${S3_BASE_URL}/${encodedKey}`;
  }

  function extractDateFromKey(key) {
    const match = String(key || '').match(/(\d{4}-\d{2}-\d{2})/);
    return match?.[1] || null;
  }

  function isUploadsFolderKey(key) {
    const normalized = String(key || '').trim().toLowerCase();
    return normalized.includes('uploads/vedanjay/');
  }

  function isS3UploadsRow(row) {
    return (
      isUploadsFolderKey(row?.template_s3_key)
      || isUploadsFolderKey(row?.file_key)
      || isUploadsFolderKey(row?.template_s3_url)
    );
  }

  function normalizeTriggerReason(value) {
    const raw = String(value || '').trim();
    if (!raw) return '-';
    const upper = raw.toUpperCase();
    if (upper.startsWith('PLANT_STATUS_CHANGE')) return upper;
    return upper;
  }

  function getTriggerReasonCacheKey(plantCode, scheduleFile, scheduleDate) {
    const safePlant = String(plantCode || '').trim().toUpperCase();
    const fileToken = String(scheduleFile || '')
      .trim()
      .replace(/\.[^.]+$/, '')
      .replace(/\s+/g, '_');
    const safeDate = String(scheduleDate || '').trim();
    // Cache schema version to invalidate stale reason values after parser fixes.
    return `trigger_reason_v6_${safePlant}_${fileToken}_${safeDate}`;
  }

  async function fetchTextFromS3Key(key) {
    const url = getS3ObjectUrl(key);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load template from S3 (${response.status})`);
    }
    return await response.text();
  }

  function findMatchingUploadedTemplate(uploadedTemplates, sourceFileName, sourceRevision) {
    if (!Array.isArray(uploadedTemplates) || uploadedTemplates.length === 0) return null;

    const normalizedSourceName = String(sourceFileName || '').replace(/\.csv$/i, '').toLowerCase();
    const revisionToken = Number.isFinite(sourceRevision) ? `schedule_from_${sourceRevision}` : '';

    const byRevision = revisionToken
      ? uploadedTemplates.find((item) => String(item?.key || '').toLowerCase().includes(revisionToken))
      : null;
    if (byRevision) return byRevision;

    const bySourceName = normalizedSourceName
      ? uploadedTemplates.find((item) => String(item?.key || '').toLowerCase().includes(normalizedSourceName))
      : null;
    if (bySourceName) return bySourceName;

    return null;
  }

  function findMatchingUploadHistory(uploadHistoryItems, fileKey, sourceRevision, plantCode) {
    if (!Array.isArray(uploadHistoryItems) || uploadHistoryItems.length === 0) return null;

    const safeFileKey = String(fileKey || '').trim();
    const sourceFileName = safeFileKey ? (safeFileKey.split('/').pop() || safeFileKey) : '';
    const sourceDate = extractDateFromKey(safeFileKey);

    const exactSource = uploadHistoryItems.find(
      (item) => String(item?.source_file_key || '').trim() === safeFileKey
    );
    if (exactSource) return exactSource;

    const plantScoped = uploadHistoryItems.filter(
      (item) => String(item?.plant_code || '').trim().toUpperCase() === String(plantCode || '').trim().toUpperCase()
    );
    if (plantScoped.length === 0) return null;

    const dateScoped = sourceDate
      ? plantScoped.filter((item) => String(item?.schedule_date || '').trim() === sourceDate)
      : plantScoped;

    const bySourceFileName = sourceFileName
      ? dateScoped.filter((item) =>
          String(item?.source_file_key || '').toLowerCase().includes(sourceFileName.toLowerCase())
        )
      : [];
    if (bySourceFileName.length > 0) {
      return bySourceFileName.sort((a, b) => {
        const at = Date.parse(String(a?.uploaded_at || ''));
        const bt = Date.parse(String(b?.uploaded_at || ''));
        return (Number.isNaN(bt) ? 0 : bt) - (Number.isNaN(at) ? 0 : at);
      })[0];
    }

    const revisionToken = Number.isFinite(sourceRevision) ? `schedule_from_${sourceRevision}` : '';
    if (revisionToken) {
      const byRevision = dateScoped.find((item) =>
        String(item?.source_file_key || '').toLowerCase().includes(revisionToken)
        || String(item?.template_file_name || '').toLowerCase().includes(revisionToken)
      );
      if (byRevision) return byRevision;
    }

    return null;
  }

  function blockToTime(block, addMinutes = 0) {
    if (!Number.isFinite(block)) return null;
    const clamped = Math.min(Math.max(block, 1), 96);
    const idx = clamped - 1;
    const totalMinutes = (idx * 15) + addMinutes;
    const normalized = ((totalMinutes % (24 * 60)) + (24 * 60)) % (24 * 60);
    const hh = Math.floor(normalized / 60);
    const mm = normalized % 60;
    return `${String(hh)}:${String(mm).padStart(2, '0')}`;
  }

  function toDateFromIso(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    // If backend returns ISO without timezone, assume UTC to avoid local-time drift.
    const needsTimezone = !/[zZ]|[+-]\d{2}:\d{2}$/.test(raw);
    const normalized = needsTimezone ? `${raw}Z` : raw;
    const dt = new Date(normalized);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  function formatUploadedTime(value) {
    const dt = toDateFromIso(value);
    if (!dt) return '-';
    return dt.toLocaleString();
  }

  function formatRowClockTime(row) {
    if (String(row?.status || '').toUpperCase() === 'UPLOADED') {
      const uploadedAt = String(row?.uploaded_at || '').trim();
      if (uploadedAt) {
        const dt = toDateFromIso(uploadedAt);
        if (dt) {
          return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
        }
      }
    }
    if (Number.isFinite(row?.ending_block) && row?.ending_block_time) {
      return String(row.ending_block_time);
    }
    return null;
  }

  function parseCsvLine(line) {
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
  }

  function parseSldcBlockTable(csvText) {
    const lines = String(csvText || '')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    if (!lines.length) return [];

    const rows = lines.map(parseCsvLine);
    const normalizeHeaderToken = (value) => String(value || '')
      .trim()
      .toLowerCase()
      .replace(/^\uFEFF/, '')
      .replace(/[^a-z0-9]/g, '');
    const headerIndex = rows.findIndex((row) => {
      const c0 = normalizeHeaderToken(row?.[0]);
      const c1 = normalizeHeaderToken(row?.[1]);
      return c0 === 'block' && (
        c1.includes('blockinterval')
        || c1.includes('timeperiod')
        || c1.includes('declaredforecast')
      );
    });
    if (headerIndex === -1) return [];

    const headerRow = rows[headerIndex] || [];
    const normalizedHeaders = headerRow.map(normalizeHeaderToken);

    const findHeaderIndex = (matcher) => normalizedHeaders.findIndex((h) => matcher(h));
    const blockIdx = findHeaderIndex((h) => h === 'block');
    const intervalIdx = findHeaderIndex((h) => h.includes('blockinterval') || h.includes('timeperiod'));
    const availabilityIdx = findHeaderIndex((h) => h.includes('availability') || h.includes('avc'));
    const forecastIdx = findHeaderIndex((h) => h.includes('forecast'));
    const stationScheduleIdx = findHeaderIndex((h) => h.includes('stationschedule'));
    const isOseplTemplate = normalizedHeaders.some((h) => h.includes('declaredforecast'))
      && normalizedHeaders.some((h) => h.includes('interavc'))
      && normalizedHeaders.some((h) => h === 'schedule');
    const scheduleIndexes = normalizedHeaders
      .map((h, idx) => ({ h, idx }))
      .filter(({ h }) => h.includes('schedule'))
      .map(({ idx }) => idx);
    const isTelanganaTemplate = stationScheduleIdx >= 0 && normalizedHeaders.some((h) =>
      h.includes('timeperiod') || h.includes('avc') || h.includes('forecastmw')
    );

    let dataStart = headerIndex + 1;
    const next = rows[dataStart] || [];
    const n0 = String(next?.[0] || '').trim();
    const n1 = String(next?.[1] || '').trim();
    const n2 = String(next?.[2] || '').trim().toLowerCase();
    const n3 = String(next?.[3] || '').trim().toLowerCase();
    if (n0 === '' && n1 === '' && n2 === 'availability' && n3 === 'forecast') {
      dataStart += 1;
    }

    const normalizeInterval = (value) => {
      const raw = String(value || '').trim();
      if (!raw) return raw;
      const cleaned = raw.replace(/\s+/g, '').replace(/[–—]/g, '-');
      const dotToColon = cleaned.replace(/\b(\d{1,2})\.(\d{2})\b/g, '$1:$2');
      const match = dotToColon.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
      if (!match) return dotToColon;
      const [ , h1, m1, h2, m2 ] = match;
      const pad = (v) => String(v).padStart(2, '0');
      return `${pad(h1)}:${pad(m1)}-${pad(h2)}:${pad(m2)}`;
    };

    const parsed = [];
    for (let i = dataStart; i < rows.length; i += 1) {
      const row = rows[i] || [];
      const block = String(row?.[blockIdx] ?? row?.[0] ?? '').trim();
      let interval = String(row?.[intervalIdx] ?? '').trim();
      let availability = String(row?.[availabilityIdx] ?? '').trim();
      let forecast = String(row?.[forecastIdx] ?? '').trim();
      const stationScheduleRaw = String(row?.[stationScheduleIdx] ?? '').trim();
      let stationSchedule = stationScheduleRaw || '';
      if (!/^\d+$/.test(block)) continue;

      if (isOseplTemplate) {
        if (!availability) availability = String(row?.[findHeaderIndex((h) => h.includes('interavc'))] ?? '').trim();
        if (!forecast) forecast = String(row?.[findHeaderIndex((h) => h.includes('declaredforecast'))] ?? '').trim();
        if (!stationSchedule) stationSchedule = String(row?.[findHeaderIndex((h) => h === 'schedule')] ?? '').trim();
      }

      if (!interval) {
        const blockNum = Number.parseInt(block, 10);
        if (Number.isFinite(blockNum)) {
          const start = blockToTime(blockNum, 0);
          const end = blockToTime(blockNum, 15);
          if (start && end) interval = `${start}-${end}`;
        }
      }
      interval = normalizeInterval(interval);

      if (!availability || !forecast || !stationSchedule) {
        if (isTelanganaTemplate) {
          // Telangana templates have explicit columns; do not infer from other numeric cells.
          if (!stationSchedule) stationSchedule = stationScheduleRaw || '';
          parsed.push({
            block,
            interval,
            availability,
            forecast,
            stationSchedule,
          });
          continue;
        }
        const numericCells = row
          .map((value, idx) => ({ idx, value: String(value ?? '').trim() }))
          .filter(({ idx, value }) => {
            if (idx === blockIdx || idx === intervalIdx) return false;
            return value !== '' && !Number.isNaN(Number(value));
          })
          .map((cell) => cell.value);

        if (!forecast && numericCells.length >= 1) forecast = numericCells[0];
        if (!availability && numericCells.length >= 2) availability = numericCells[1];

        if (!stationSchedule) {
          if (stationScheduleIdx >= 0) {
            stationSchedule = stationScheduleRaw || forecast;
          } else if (scheduleIndexes.length > 0) {
            const scheduleValues = scheduleIndexes
              .map((idx) => String(row?.[idx] ?? '').trim())
              .filter((val) => val !== '' && !Number.isNaN(Number(val)))
              .map((val) => Number(val));
            if (scheduleValues.length > 0) {
              const sum = scheduleValues.reduce((a, b) => a + b, 0);
              stationSchedule = String(Number.isFinite(sum) ? sum : '');
            }
          }
          if (!stationSchedule) stationSchedule = forecast;
        }
      }

      parsed.push({
        block,
        interval,
        availability,
        forecast,
        stationSchedule,
      });
    }

    if (!isTelanganaTemplate && (availabilityIdx < 0 || forecastIdx < 0)) {
      const numericRows = parsed
        .map((row) => ({
          availability: Number.parseFloat(row.availability),
          forecast: Number.parseFloat(row.forecast),
        }))
        .filter((row) => Number.isFinite(row.availability) && Number.isFinite(row.forecast));

      if (numericRows.length >= 12) {
        const roundKey = (value) => value.toFixed(3);
        const distinctAvail = new Set(numericRows.map((r) => roundKey(r.availability))).size;
        const distinctForecast = new Set(numericRows.map((r) => roundKey(r.forecast))).size;
        const availVals = numericRows.map((r) => r.availability);
        const forecastVals = numericRows.map((r) => r.forecast);
        const rangeAvail = Math.max(...availVals) - Math.min(...availVals);
        const rangeForecast = Math.max(...forecastVals) - Math.min(...forecastVals);

        const looksSwapped =
          distinctAvail >= 10 &&
          distinctForecast <= 3 &&
          rangeAvail > rangeForecast * 1.5;

        if (looksSwapped) {
          return parsed.map((row) => ({
            ...row,
            availability: row.forecast,
            forecast: row.availability,
          }));
        }
      }
    }
    return parsed;
  }

  function parseSldcMetadataPairs(csvText) {
    const lines = String(csvText || '')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    if (!lines.length) return [];
    const rows = lines.map(parseCsvLine);
    const headerIndex = rows.findIndex((row) => {
      const c0 = String(row?.[0] || '').trim().toLowerCase();
      const c1 = String(row?.[1] || '').trim().toLowerCase();
      return c0 === 'block' && (c1.includes('block interval') || c1.includes('time period'));
    });
    if (headerIndex <= 0) return [];

    const metadataRows = rows.slice(0, headerIndex);
    const pairs = metadataRows
      .map((row) => {
        const key = String(row?.[0] || '').trim();
        const value = String(row?.[1] || '').trim();
        if (!key) return null;
        return { key, value };
      })
      .filter(Boolean);

    return pairs;
  }

  function extractSldcMetadataRaw(csvText) {
    const lines = String(csvText || '')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    if (!lines.length) return '';
    const rows = lines.map(parseCsvLine);
    const headerIndex = rows.findIndex((row) => {
      const c0 = String(row?.[0] || '').trim().toLowerCase();
      const c1 = String(row?.[1] || '').trim().toLowerCase();
      return c0 === 'block' && c1.includes('block interval');
    });
    if (headerIndex <= 0) return '';
    return lines.slice(0, headerIndex).join('\n');
  }

  function sortLatestFirst(items) {
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

  function sortOldestFirst(items) {
    return [...items].sort((a, b) => {
      const aSeq = extractTrailingNumber(a.key);
      const bSeq = extractTrailingNumber(b.key);
      if (aSeq !== null && bSeq !== null && aSeq !== bSeq) return aSeq - bSeq;

      const aTime = Date.parse(a.lastModified || '');
      const bTime = Date.parse(b.lastModified || '');
      const timeDiff = (Number.isNaN(aTime) ? 0 : aTime) - (Number.isNaN(bTime) ? 0 : bTime);
      if (timeDiff !== 0) return timeDiff;

      return (a.key || '').localeCompare(b.key || '');
    });
  }

  function isDirectScheduleRow(row) {
    const fileName = String(row?.file_name || '').toLowerCase();
    const fileKey = String(row?.file_key || '').toLowerCase();
    return /schedule_from_\d+\.csv$/.test(fileName) || /schedule_from_\d+\.csv$/.test(fileKey);
  }

  function getRowTimestamp(row) {
    const ts = Date.parse(String(row?.uploaded_at || row?.generated_at || ''));
    return Number.isNaN(ts) ? 0 : ts;
  }

  function getReadinessRowDedupKey(row) {
    const plantCode = String(row?.plant_code || '').trim().toUpperCase();
    const scheduleDate = String(row?.schedule_date || '').trim();
    const revision = Number.isFinite(row?.schedule_revision)
      ? row.schedule_revision
      : extractScheduleRevisionToken(row?.file_key)
        || extractScheduleRevisionToken(row?.file_name)
        || extractScheduleRevisionToken(row?.template_file_name);
    if (plantCode && scheduleDate && Number.isFinite(revision)) {
      return `rev|${plantCode}|${scheduleDate}|${revision}`;
    }

    const templateKey = String(row?.template_s3_key || '').trim().toLowerCase();
    if (templateKey) return `tpl|${templateKey}`;

    const fileKey = String(row?.file_key || '').trim().toLowerCase();
    if (fileKey) return `file|${fileKey}`;

    const fileName = String(row?.file_name || '').trim().toLowerCase();
    return `name|${plantCode}|${scheduleDate}|${fileName}`;
  }

  function getReadinessRowScore(row) {
    let score = 0;
    // Prefer rows that are confirmed from uploads so Uploaded counts/tables
    // reflect S3 upload artifacts for the selected date/site.
    if (isS3UploadsRow(row)) score += 220;
    if (String(row?.status || '').toUpperCase() === 'UPLOADED') score += 140;
    if (String(row?.template_s3_key || '').trim()) score += 80;
    if (String(row?.template_file_name || '').trim()) score += 60;
    if (isDirectScheduleRow(row)) score += 40;
    if (row?.is_latest) score += 5;
    return score;
  }

  function dedupeReadinessRows(rows) {
    const bestByKey = new Map();
    rows.forEach((row) => {
      const key = getReadinessRowDedupKey(row);
      const prev = bestByKey.get(key);
      if (!prev) {
        bestByKey.set(key, row);
        return;
      }

      const prevScore = getReadinessRowScore(prev);
      const currScore = getReadinessRowScore(row);
      if (currScore > prevScore) {
        bestByKey.set(key, row);
        return;
      }

      if (currScore === prevScore && getRowTimestamp(row) > getRowTimestamp(prev)) {
        bestByKey.set(key, row);
      }
    });
    return Array.from(bestByKey.values());
  }

  const buildReadinessData = (scheduleFiles, uploadedTemplateFiles = [], uploadHistoryItems = []) => {
    const filesByPlantCode = scheduleFiles.reduce((acc, file) => {
      const plant = getPlantFromKey(file.key);
      const plantCode = plant?.code || 'GSNP';
      if (!acc[plantCode]) acc[plantCode] = [];
      acc[plantCode].push(file);
      return acc;
    }, {});

    const uploadedByPlantCode = uploadedTemplateFiles.reduce((acc, file) => {
      const plantCode = getPlantCodeFromKey(file.key);
      if (!acc[plantCode]) acc[plantCode] = [];
      acc[plantCode].push(file);
      return acc;
    }, {});

    const scheduleRows = Object.entries(filesByPlantCode).flatMap(([plantCode, files]) => {
      const plant = S3_PLANTS.find((p) => p.code === plantCode) || S3_PLANTS[0];
      const sorted = sortLatestFirst(files);
      const uploadedTemplates = sortLatestFirst(uploadedByPlantCode[plantCode] || []);
      return sorted.map((file, index) => {
        const isLatest = index === 0;
        const endingBlock = extractTrailingNumber(file.key);
        const uploadedTemplate = findMatchingUploadedTemplate(uploadedTemplates, file.key.split('/').pop(), endingBlock);
        const uploadedHistory = findMatchingUploadHistory(uploadHistoryItems, file.key, endingBlock, plantCode);
        const workflowEntry = workflowByFile?.[file.key] || {};
        const templateEntry = sldcTemplateMapBySource?.[file.key] || null;
        const defaultStatus = isLatest ? 'READY' : 'NO_ACTION';
        const workflowStatus = String(workflowEntry?.status || '').toUpperCase();
        const statusFromWorkflow = ['READY', 'PENDING', 'NO_ACTION', 'UPLOADED'].includes(workflowStatus)
          ? workflowStatus
          : defaultStatus;
        const status = (uploadedTemplate || uploadedHistory) ? 'UPLOADED' : statusFromWorkflow;
        const uploadedAt = workflowEntry?.uploaded_at
          || (status === 'UPLOADED'
            ? (
              workflowEntry?.updated_at
              || uploadedHistory?.uploaded_at
              || uploadedTemplate?.lastModified
              || null
            )
            : null);
        return {
          id: `${plantCode}-${file.key}-${index}`,
          plant_id: plant.id,
          plant_name: plant.name,
          category: plant.type,
          status,
          trigger_reason: '-',
          upload_deadline: uploadedAt || null,
          uploaded_at: uploadedAt || null,
          file_key: file.key,
          file_name: file.key.split('/').pop(),
          plant_code: plantCode,
          schedule_date: extractDateFromKey(file.key) || selectedDate,
          schedule_revision: endingBlock,
          ending_block: endingBlock,
          ending_block_time: blockToTime(endingBlock, 8),
          generated_at: file.lastModified,
          is_latest: isLatest,
          state: plant.state,
          capacity: plant.capacity,
          template_file_name: templateEntry?.template_file_name || uploadedHistory?.template_file_name || uploadedTemplate?.key?.split('/').pop() || '',
          template_generated_at: templateEntry?.generated_at || uploadedHistory?.uploaded_at || uploadedTemplate?.lastModified || null,
          template_csv_text: templateEntry?.csv_text || uploadedHistory?.csv_text || '',
          template_s3_key: templateEntry?.s3_output_file_key || uploadedHistory?.output_file_key || uploadedTemplate?.key || null,
          template_s3_url: templateEntry?.s3_output_file_url || uploadedHistory?.output_file_url || (uploadedTemplate?.key ? getS3ObjectUrl(uploadedTemplate.key) : null),
        };
      });
    });

    const scheduleKeySet = new Set(scheduleRows.map((row) => String(row.file_key || '').trim()).filter(Boolean));
    const uploadedOnlyRows = [];

    uploadHistoryItems.forEach((item, idx) => {
      const sourceKey = String(item?.source_file_key || '').trim();
      if (sourceKey && scheduleKeySet.has(sourceKey)) return;

      const plantCode = String(item?.plant_code || '').trim().toUpperCase() || getPlantCodeFromKey(sourceKey);
      const plant = S3_PLANTS.find((p) => p.code === plantCode) || S3_PLANTS[0];
      const outputKey = String(item?.output_file_key || '').trim();
      const keyDate =
        extractDateFromKey(outputKey)
        || extractDateFromKey(sourceKey)
        || extractDateFromKey(String(item?.output_file_url || '').trim());
      const scheduleDate = String(keyDate || item?.schedule_date || selectedDate).trim() || selectedDate;
      const fileNameFromSource = sourceKey ? (sourceKey.split('/').pop() || sourceKey) : '';
      const fileName = fileNameFromSource || String(item?.template_file_name || '').trim() || 'uploaded_template.csv';
      const endingBlock = extractTrailingNumber(sourceKey || fileName);
      const scheduleRevision = extractScheduleRevisionToken(sourceKey)
        || extractScheduleRevisionToken(String(item?.template_file_name || '').trim())
        || extractScheduleRevisionToken(outputKey);
      const uploadedAt = item?.uploaded_at || null;

      uploadedOnlyRows.push({
        id: `uploaded-history-${plantCode}-${idx}-${fileName}`,
        plant_id: plant.id,
        plant_name: plant.name,
        category: plant.type,
        status: 'UPLOADED',
        trigger_reason: '-',
        upload_deadline: uploadedAt,
        uploaded_at: uploadedAt,
        file_key: sourceKey || outputKey,
        file_name: fileName,
        plant_code: plantCode,
        schedule_date: scheduleDate,
        schedule_revision: scheduleRevision,
        ending_block: endingBlock,
        ending_block_time: blockToTime(endingBlock, 8),
        generated_at: uploadedAt || item?.created_at || null,
        is_latest: false,
        state: plant.state,
        capacity: plant.capacity,
        template_file_name: String(item?.template_file_name || '').trim(),
        template_generated_at: uploadedAt,
        template_csv_text: String(item?.csv_text || ''),
        template_s3_key: outputKey || null,
        template_s3_url: String(item?.output_file_url || '').trim() || null,
      });
    });

    const uploadedTemplateRows = uploadedTemplateFiles
      .filter((item) => {
        const key = String(item?.key || '').trim();
        if (!key) return false;
        if (scheduleKeySet.has(key)) return false;
        return !uploadedOnlyRows.some((row) => String(row.template_s3_key || '').trim() === key);
      })
      .map((item, idx) => {
        const key = String(item.key || '').trim();
        const plantCode = getPlantCodeFromKey(key);
        const plant = S3_PLANTS.find((p) => p.code === plantCode) || S3_PLANTS[0];
        const scheduleDate = extractDateFromKey(key) || selectedDate;
        return {
          id: `uploaded-template-${plantCode}-${idx}-${key}`,
          plant_id: plant.id,
          plant_name: plant.name,
          category: plant.type,
          status: 'UPLOADED',
          trigger_reason: '-',
          upload_deadline: item.lastModified || null,
          uploaded_at: item.lastModified || null,
          file_key: key,
          file_name: key.split('/').pop() || key,
          plant_code: plantCode,
          schedule_date: scheduleDate,
          schedule_revision: extractScheduleRevisionToken(key),
          ending_block: extractTrailingNumber(key),
          ending_block_time: blockToTime(extractTrailingNumber(key), 8),
          generated_at: item.lastModified || null,
          is_latest: false,
          state: plant.state,
          capacity: plant.capacity,
          template_file_name: key.split('/').pop() || '',
          template_generated_at: item.lastModified || null,
          template_csv_text: '',
          template_s3_key: key,
          template_s3_url: getS3ObjectUrl(key),
        };
      });

    const mergedRows = [...scheduleRows, ...uploadedOnlyRows, ...uploadedTemplateRows];
    const dedupedRows = dedupeReadinessRows(mergedRows);
    return dedupedRows.sort((a, b) => {
      const aTime = Date.parse(a.uploaded_at || a.generated_at || '');
      const bTime = Date.parse(b.uploaded_at || b.generated_at || '');
      const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
      if (timeDiff !== 0) return timeDiff;
      return String(b.file_key || b.file_name || '').localeCompare(String(a.file_key || a.file_name || ''));
    });
  };

  useEffect(() => {
    const syncTemplateMap = () => {
      try {
        const raw = localStorage.getItem(SLDC_TEMPLATE_MAP_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        setSldcTemplateMapBySource(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        setSldcTemplateMapBySource({});
      }
    };
    syncTemplateMap();
    window.addEventListener('focus', syncTemplateMap);
    return () => window.removeEventListener('focus', syncTemplateMap);
  }, []);

  useEffect(() => {
    localStorage.setItem(READINESS_WORKFLOW_STORAGE_KEY, JSON.stringify(workflowByFile));
  }, [workflowByFile]);


  const setWorkflowStatus = useCallback((fileKey, status, extra = {}) => {
    if (!fileKey) return;
    setWorkflowByFile((prev) => ({
      ...prev,
      [fileKey]: {
        ...(prev[fileKey] || {}),
        ...extra,
        status,
        updated_at: new Date().toISOString(),
      },
    }));
  }, []);

  // Load data on mount
  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      try {
        const datePrefixes = getDateSearchPrefixes(selectedDate);
        const uploadPrefixes = getUploadSearchPrefixes(selectedDate);
        const [objectsFlat, uploadedFlat, uploadHistoryResult] = await Promise.all([
          listS3ObjectsAcrossPrefixes(datePrefixes),
          listS3ObjectsAcrossPrefixes(uploadPrefixes),
          scheduleReadinessApi.getUploadHistory({ scheduleDate: selectedDate, limit: 500 }),
        ]);
        const objects = Array.from(new Map(objectsFlat.map((o) => [o.key, o])).values());
        const uploadedObjects = Array.from(new Map(uploadedFlat.map((o) => [o.key, o])).values());
        const scheduleFiles = objects.filter((o) => isScheduleCsvKey(o.key));
        const uploadedTemplates = uploadedObjects.filter((o) => isUploadedTemplateCsvKey(o.key));
        const uploadHistoryItems = Array.isArray(uploadHistoryResult?.items)
          ? uploadHistoryResult.items.filter((item) => {
              const key = String(item?.output_file_key || '').trim().toLowerCase();
              return key.startsWith('uploads/vedanjay/');
            })
          : [];
        setReadinessData(buildReadinessData(scheduleFiles, uploadedTemplates, uploadHistoryItems));
      } catch (error) {
        console.error('Failed to load readiness data from S3:', error);
        setReadinessData([]);
        toast.error('Failed to load readiness data from S3');
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, [selectedDate, workflowByFile, sldcTemplateMapBySource]);

  useEffect(() => {
    if (!Array.isArray(readinessData) || readinessData.length === 0) return;

    readinessData.forEach((row) => {
      const currentReason = normalizeTriggerReason(row?.trigger_reason);
      if (currentReason !== '-' && currentReason !== 'PLANT_STATUS_CHANGE') return;

      const plantCode = String(row?.plant_code || getPlantCodeFromKey(row?.file_key) || '').toUpperCase();
      const scheduleFile = row?.file_name || '';
      const scheduleDate = extractDateFromKey(row?.file_key) || row?.schedule_date || selectedDate;
      if (!plantCode || !scheduleFile || !scheduleDate) return;

      const cacheKey = getTriggerReasonCacheKey(plantCode, scheduleFile, scheduleDate);
      try {
        const cached = localStorage.getItem(cacheKey);
        if (cached !== null) {
          const cachedReason = normalizeTriggerReason(cached);
          if (cachedReason !== '-' && cachedReason !== 'PLANT_STATUS_CHANGE') {
            setReadinessData((prev) => prev.map((item) => (
              item.id === row.id ? { ...item, trigger_reason: cachedReason } : item
            )));
            return;
          }
        }
      } catch {
        // Ignore cache read errors.
      }

      if (triggerReasonInFlightRef.current.has(cacheKey)) return;
      triggerReasonInFlightRef.current.add(cacheKey);

      scheduleReadinessApi.getScheduleReason({
        plant: plantCode,
        scheduleFile,
        date: scheduleDate,
      })
        .then((reason) => {
          const normalized = normalizeTriggerReason(reason);
          try {
            localStorage.setItem(cacheKey, normalized);
          } catch {
            // Ignore cache write errors.
          }
          setReadinessData((prev) => prev.map((item) => (
            item.id === row.id ? { ...item, trigger_reason: normalized } : item
          )));
        })
        .catch(() => {
          setReadinessData((prev) => prev.map((item) => (
            item.id === row.id ? { ...item, trigger_reason: '-' } : item
          )));
        })
        .finally(() => {
          triggerReasonInFlightRef.current.delete(cacheKey);
        });
    });
  }, [readinessData, selectedDate]);

  const baseFilteredRows = useMemo(() => {
    let rows = [...readinessData];
    rows = rows.filter((p) => String(p.schedule_date || '').trim() === selectedDate);
    if (uploadedPlantFilter !== 'All') {
      rows = rows.filter((p) => String(p.plant_name || '').trim() === uploadedPlantFilter);
    }
    return rows;
  }, [readinessData, selectedDate, uploadedPlantFilter]);

  const todayDateKey = useMemo(() => getLocalDateKey(), []);
  const isSelectedToday = selectedDate === todayDateKey;

  // Calculate summary from active date + site filters
  const summary = useMemo(() => {
    const uniquePlantCount = new Set(baseFilteredRows.map((p) => p.plant_id)).size;
    const uploadedFromS3 = baseFilteredRows.filter((p) => isS3UploadsRow(p));
    const uniqueUploadedKeys = new Set(
      uploadedFromS3
        .map((p) => String(p.template_s3_key || p.file_key || p.template_s3_url || '').trim())
        .filter(Boolean)
    );
    const readyCount = baseFilteredRows.filter((p) => p.status === 'READY').length;
    return {
      total: uniquePlantCount,
      ready: isSelectedToday ? readyCount : 0,
      pending: baseFilteredRows.filter((p) => p.status === 'PENDING').length,
      no_action: baseFilteredRows.filter((p) => p.status === 'NO_ACTION').length,
      uploaded: uniqueUploadedKeys.size,
    };
  }, [baseFilteredRows, isSelectedToday]);

  const uploadedPlantOptions = useMemo(() => {
    const names = Array.from(
      new Set(
        readinessData
          .filter((p) => String(p.schedule_date || '').trim() === selectedDate)
          .map((p) => String(p.plant_name || '').trim())
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b));
    return ['All', ...names];
  }, [readinessData, selectedDate]);

  const filteredPlants = useMemo(() => {
    if (!isSelectedToday && statusFilter === 'READY') {
      return [];
    }

    let rows = baseFilteredRows.filter((p) => statusFilter === 'All' || p.status === statusFilter);

    if (statusFilter === 'UPLOADED') {
      rows = rows.filter((p) => isS3UploadsRow(p));
      const seen = new Set();
      rows = rows.filter((p) => {
        const key = String(p.template_s3_key || p.file_key || p.template_s3_url || '').trim();
        if (!key) return false;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    return rows;
  }, [baseFilteredRows, statusFilter, isSelectedToday]);

  const getStatusConfig = (status) => {
    const configs = {
      READY: {
        color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
        iconColor: 'text-emerald-400',
        label: 'Ready'
      },
      PENDING: {
        color: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
        iconColor: 'text-amber-400',
        label: 'Pending'
      },
      NO_ACTION: {
        color: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
        iconColor: 'text-slate-400',
        label: 'No Action'
      },
      UPLOADED: {
        color: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
        iconColor: 'text-blue-400',
        label: 'Uploaded'
      }
    };
    return configs[status] || configs.NO_ACTION;
  };

  const navigateToTemplatesForFile = useCallback((plant) => {
    const normalizeCode = (value) => {
      const text = String(value || '').trim().toUpperCase();
      if (!text) return '';
      if (text.includes('SIRMOUR') || text.includes('SHRIMOUR') || text.includes('SHROMOUR')) return 'SIRMOUR';
      if (text.includes('GSNP') || text.includes('GLOBUS')) return 'GSNP';
      if (text.includes('BHUPALPALLY')) return 'BHUPALPALLY';
      if (text.includes('KASIPET')) return 'KASIPET';
      if (text.includes('KILAJ')) return 'KILAJ';
      if (text.includes('KOTHAGUDEM')) return 'KOTHAGUDEM';
      if (text.includes('OSEPL')) return 'OSEPL';
      if (text.includes('CME')) return 'CME';
      return text;
    };
    const explicitCode = normalizeCode(plant?.plant_code);
    const sourceKey = String(plant?.file_key || plant?.template_s3_key || '').trim();
    const keyMatch = sourceKey.match(/\/vedanjay\/([^/]+)\//i);
    const codeFromKey = keyMatch?.[1] ? normalizeCode(keyMatch[1]) : '';
    const nameCode = normalizeCode(plant?.plant_name);
    const derivedCode = codeFromKey || explicitCode || nameCode;
    if (!sourceKey) return;

    const params = new URLSearchParams();
    if (plant?.plant_id) params.set('plantId', String(plant.plant_id));
    if (plant?.plant_name) params.set('plantName', String(plant.plant_name));
    if (derivedCode) params.set('plantCode', derivedCode);
    params.set('sourceFileKey', sourceKey);
    if (selectedDate) params.set('scheduleDate', String(selectedDate));
    params.set('fromReadiness', '1');
    params.set('autoPreview', '1');

    const url = `/templates?${params.toString()}`;
    window.history.replaceState({}, '', url);
    onNavigate('templates', {
      fromReadiness: true,
      autoPreview: true,
      plantId: plant.plant_id,
      plantName: plant.plant_name,
      plantCode: derivedCode,
      sourceFileKey: sourceKey || undefined,
      scheduleDate: selectedDate,
    });
  }, [onNavigate, selectedDate]);

  const handleReadyUpload = async (plant) => {
    if (!plant) return;
    setIsRefreshing(true);
    try {
      setReadinessData((prev) =>
        prev.map((row) => (row.id === plant.id ? { ...row, status: 'PENDING' } : row))
      );
      if (plant?.file_key) {
        setWorkflowStatus(plant.file_key, 'PENDING', {
          plant_id: plant.plant_id,
          plant_name: plant.plant_name,
          file_name: plant.file_name,
          uploaded_at: null,
        });
      }
      toast.success(`Moved to Pending and opened SLDC conversion: ${plant.file_name}`);
      setTimeout(() => {
        navigateToTemplatesForFile(plant);
      }, 300);
    } catch (error) {
      toast.error(`Action failed: ${error?.message || 'Unable to complete request'}`);
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleActionClick = (plant, action) => {
    setSelectedPlant(plant);
    setActionType(action);
    setActionReason('');
    setShowActionModal(true);
  };

  const executeAction = async () => {
    if (!selectedPlant || !actionType) return;

    setShowActionModal(false);
    setIsRefreshing(true);

    const updateRowStatus = (status, extra = {}) => {
      setReadinessData((prev) =>
        prev.map((plant) => (plant.id === selectedPlant.id ? { ...plant, status, ...extra } : plant))
      );
    };

    const inferPlantCode = (plant) => {
      const direct = String(plant?.plant_code || '').trim().toUpperCase();
      if (direct) return direct;

      const fromTemplate = String(plant?.template_file_name || '').trim().toUpperCase();
      if (fromTemplate) {
        const match = fromTemplate.match(/^([A-Z0-9_-]+)_\d{4}-\d{2}-\d{2}_/);
        if (match?.[1]) return match[1];
      }

      const fromKey = String(plant?.file_key || '').toLowerCase();
      const keyMatch = fromKey.match(/\/vedanjay\/([^/]+)\//);
      if (keyMatch?.[1]) return keyMatch[1].toUpperCase();
      const rawMatch = fromKey.match(/raw\/vedanjay\/([^/]+)\//);
      if (rawMatch?.[1]) return rawMatch[1].toUpperCase();

      const fromName = String(plant?.plant_name || plant?.name || '').toLowerCase();
      if (fromName.includes('bhupalpally')) return 'BHUPALPALLY';
      if (fromName.includes('kasipet')) return 'KASIPET';
      if (fromName.includes('kilaj')) return 'KILAJ';
      if (fromName.includes('kothagudem')) return 'KOTHAGUDEM';
      if (fromName.includes('osepl')) return 'OSEPL';
      if (fromName.includes('cme')) return 'CME';
      if (fromName.includes('gsnp') || fromName.includes('globus steel')) return 'GSNP';
      if (fromName.includes('sirmour') || fromName.includes('shrimour') || fromName.includes('shromour')) return 'SIRMOUR';
      return 'GSNP';
    };

    try {
      if (actionType === 'revise') {
        updateRowStatus('PENDING', { revision_number: (selectedPlant.revision_number || 0) + 1 });
        if (selectedPlant?.file_key) {
          setWorkflowStatus(selectedPlant.file_key, 'PENDING', {
            plant_id: selectedPlant.plant_id,
            plant_name: selectedPlant.plant_name,
            file_name: selectedPlant.file_name,
            uploaded_at: null,
          });
        }
        toast.success(`Revision triggered for ${selectedPlant.plant_name}`);
        setTimeout(() => {
          onNavigate('schedule', {
            plant: selectedPlant.plant_name,
            category: selectedPlant.category,
            type: 'Day-Ahead',
            revision: true,
          });
        }, 500);
      } else if (actionType === 'continue') {
        updateRowStatus('NO_ACTION', { trigger_reason: null });
        if (selectedPlant?.file_key) {
          setWorkflowStatus(selectedPlant.file_key, 'NO_ACTION', { uploaded_at: null });
        }
        toast.info(`Schedule continued for ${selectedPlant.plant_name}`);
      } else if (actionType === 'markReady') {
        updateRowStatus('PENDING');
        if (selectedPlant?.file_key) {
          setWorkflowStatus(selectedPlant.file_key, 'PENDING', {
            plant_id: selectedPlant.plant_id,
            plant_name: selectedPlant.plant_name,
            file_name: selectedPlant.file_name,
            uploaded_at: null,
          });
        }
        toast.success(`Moved to Pending and opened SLDC conversion: ${selectedPlant.file_name}`);
        setTimeout(() => {
          navigateToTemplatesForFile(selectedPlant);
        }, 500);
      } else if (actionType === 'editPending') {
        toast.info(`Opening pending schedule for edit: ${selectedPlant.file_name}`);
        setTimeout(() => {
          navigateToTemplatesForFile(selectedPlant);
        }, 300);
      } else if (actionType === 'confirmUploaded') {
        const csvText = String(selectedPlant?.template_csv_text || '').trim();
        if (!csvText) {
          toast.error('Converted template content not found. Open Schedule Templates and regenerate.');
          return;
        }

        const plantCode = inferPlantCode(selectedPlant);
        const templateFileName = String(selectedPlant?.template_file_name || '').trim()
          || `${plantCode}_${selectedDate}_sldc_template.csv`;

        const uploadResult = await scheduleReadinessApi.uploadConfirmedTemplate({
          plant_code: plantCode,
          schedule_date: selectedDate,
          template_file_name: templateFileName,
          csv_text: csvText,
          source_file_key: selectedPlant?.file_key || null,
          requested_by: 'admin',
        });

        const storageMode = String(uploadResult?.storage_mode || '').trim().toLowerCase();
        const uploadFailedToS3 =
          storageMode === 'local' ||
          String(uploadResult?.message || '').toLowerCase().includes('local fallback');
        if (uploadFailedToS3) {
          toast.error(`S3 upload failed. ${uploadResult?.message || 'Template stored locally.'}`);
          return;
        }

        const confirmedAt = uploadResult?.uploaded_at || new Date().toISOString();
        updateRowStatus('UPLOADED', { uploaded_at: confirmedAt });
        if (selectedPlant?.file_key) {
          setWorkflowStatus(selectedPlant.file_key, 'UPLOADED', {
            plant_id: selectedPlant.plant_id,
            plant_name: selectedPlant.plant_name,
            file_name: selectedPlant.file_name,
            uploaded_at: confirmedAt,
            s3_output_file_key: uploadResult?.output_file_key || null,
            s3_output_file_url: uploadResult?.output_file_url || null,
          });
        }
        toast.success(`Uploaded to cloud and marked Uploaded: ${templateFileName}`);
      }
    } catch (error) {
      toast.error(`Action failed: ${error?.message || 'Unable to complete request'}`);
    } finally {
      setIsRefreshing(false);
      setSelectedPlant(null);
      setActionType(null);
    }
  };

  const getPlantIcon = (name) => String(name || '').toLowerCase().includes('wind') ? Wind : Sun;

  const getActionButtonText = () => {
    if (actionType === 'revise') return 'Trigger Revision';
    if (actionType === 'continue') return 'Continue Schedule';
    if (actionType === 'markReady') return 'Move to Pending';
    if (actionType === 'editPending') return 'Open Template';
    if (actionType === 'confirmUploaded') return 'Yes, Uploaded';
    return 'Confirm';
  };

  const handleHistoryClick = (plant) => {
    toast.info(`Opening history: ${plant.file_name}`);
    onNavigate('schedule', {
      plant: plant.plant_name,
      category: plant.category,
      type: 'Day-Ahead',
      date: selectedDate,
      fileName: plant.file_name,
      fromReadinessHistory: true,
    });
  };

  const handleViewUploadedTemplate = async (plant) => {
    if (!plant) {
      setTemplateViewRow(null);
      return;
    }
    if (String(plant.template_csv_text || '').trim()) {
      setTemplateViewRow(plant);
      return;
    }
    if (!plant.template_s3_key) {
      toast.error('Template content not found.');
      return;
    }
    try {
      const csvText = await fetchTextFromS3Key(plant.template_s3_key);
      const nextPlant = { ...plant, template_csv_text: csvText };
      setReadinessData((prev) =>
        prev.map((row) => (row.id === plant.id ? { ...row, template_csv_text: csvText } : row))
      );
      setTemplateViewRow(nextPlant);
    } catch (error) {
      toast.error(error?.message || 'Failed to load uploaded template');
    }
  };

  const handleDownloadUploadedTemplate = async (plant, format = 'csv') => {
    let csvText = String(plant?.template_csv_text || '').trim();
    if (!csvText && plant?.template_s3_key) {
      try {
        csvText = await fetchTextFromS3Key(plant.template_s3_key);
        setReadinessData((prev) =>
          prev.map((row) => (row.id === plant.id ? { ...row, template_csv_text: csvText } : row))
        );
      } catch (error) {
        toast.error(error?.message || 'Failed to load uploaded template');
        return;
      }
    }
    if (!csvText) {
      toast.error('Converted template content not found. Open Schedule Templates and regenerate.');
      return;
    }
    const fileName = plant?.template_file_name || 'sldc_template.csv';
    const filenameBase = fileName.replace(/\.(csv|xlsx|xls)$/i, '');
    if (format === 'xlsx') {
      await downloadXlsxFromCsvText(csvText, filenameBase, 'Template', { forceString: true });
    } else {
      downloadCsvText(csvText, filenameBase);
    }
    setShowDownloadModal(false);
    setPendingTemplateDownload(null);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-950">
        <div className="flex flex-col items-center gap-6">
          <div className="relative">
            <div className="w-20 h-20 rounded-full border-4 border-slate-800 border-t-indigo-500 animate-spin" />
            <div className="absolute inset-0 w-20 h-20 rounded-full border-4 border-transparent border-b-purple-500 animate-spin" style={{ animationDirection: 'reverse', animationDuration: '1.5s' }} />
          </div>
          <div className="flex flex-col items-center gap-2">
            <p className="text-lg font-semibold text-white">Loading Dashboard</p>
            <p className="text-sm text-slate-400">Fetching schedule readiness data...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto bg-slate-950 min-h-0 relative overflow-x-hidden">
      {/* Animated background elements */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />
      </div>

      <div className="w-full p-4 sm:p-6 lg:p-8 space-y-6 sm:space-y-8 max-w-[2000px] mx-auto relative z-10">
        {/* Premium Header */}
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 border border-slate-700/50 shadow-2xl">
          <div className="absolute inset-0 bg-gradient-to-r from-indigo-500/5 via-transparent to-purple-500/5" />
          <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-bl from-indigo-500/10 to-transparent rounded-full blur-2xl" />
          
          <div className="relative p-4 sm:p-6 lg:p-8">
            <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-6">
              <div className="flex items-start gap-4 sm:gap-5">
                <div className="relative">
                  <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/25">
                    <CheckCircle className="w-6 h-6 sm:w-7 sm:h-7 text-white" />
                  </div>
                </div>
                <div>
                  <h1 className="text-2xl sm:text-3xl font-bold text-white mb-2 tracking-tight">
                    Schedule Readiness
                    <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-purple-400"> Dashboard</span>
                  </h1>
                  <div className="flex flex-wrap items-center gap-2 sm:gap-4 text-slate-400">
                    <div className="flex items-center gap-2">
                      <span className="relative flex h-2 w-2">
                        <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75 animate-ping" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                      </span>
                      <span className="text-xs sm:text-sm font-medium">Live Monitoring</span>
                    </div>
                  </div>
                </div>
              </div>
              
              <div className="flex flex-col sm:flex-row sm:flex-wrap items-end gap-3 sm:gap-4 w-full xl:w-auto">
                <div className="w-full sm:w-[220px]">
                  <input
                    type="date"
                    value={selectedDate}
                    onChange={(e) => setSelectedDate(String(e.target.value || '').trim())}
                    className="w-full px-3.5 py-2.5 sm:px-4 rounded-xl bg-white border border-slate-300 text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <div className="w-full sm:w-[240px]">
                  <select
                    value={uploadedPlantFilter}
                    onChange={(e) => setUploadedPlantFilter(e.target.value)}
                    className="w-full px-3.5 py-2.5 sm:px-4 rounded-xl bg-white border border-slate-300 text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    {uploadedPlantOptions.map((name) => (
                      <option key={`uploaded-site-header-${name}`} value={name}>
                        {name === 'All' ? 'All Sites' : name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 sm:gap-6">
            {[
              { label: 'Total Sites', value: summary.total, subtext: 'Active monitoring', icon: Layers, color: 'blue', gradient: 'from-slate-600 to-slate-700', glow: 'bg-slate-500/20' },
              { label: 'Ready', value: summary.ready, subtext: 'Schedules ready for upload', icon: CheckCircle, color: 'emerald', gradient: 'from-emerald-600 to-teal-600', glow: 'bg-emerald-500/20' },
              { label: 'Pending', value: summary.pending, subtext: 'Require action', icon: Clock, gradient: 'from-amber-600 to-orange-600', glow: 'bg-amber-500/20' },
              { label: 'Uploaded', value: summary.uploaded, subtext: 'Confirmed at SLDC', icon: CheckCircle, gradient: 'from-blue-600 to-cyan-600', glow: 'bg-blue-500/20' },
              { label: 'No Action', value: summary.no_action, subtext: 'Continuing existing', icon: MinusCircle, gradient: 'from-slate-500 to-slate-600', glow: 'bg-slate-500/20' }
            ].map((stat, i) => (
            <div 
              key={i}
              className="group relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 to-slate-800 border border-slate-700/50 hover:border-slate-600 transition-all duration-500 hover:-translate-y-1 hover:shadow-2xl cursor-pointer"
              onClick={() => setStatusFilter(stat.label === 'Total Sites' ? 'All' : stat.label.toUpperCase().replace(' ', '_'))}
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

        {/* Filters */}
        <div className="flex flex-col xl:flex-row xl:items-center gap-4 p-4 rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm">
          <div className="flex items-center gap-2 text-slate-400">
            <Layers className="w-5 h-5" />
            <span className="text-sm font-medium">Filter by Status:</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {['All', 'READY', 'PENDING', 'UPLOADED', 'NO_ACTION'].map((status) => {
              const count = status === 'All'
                ? summary.total
                : status === 'READY'
                  ? summary.ready
                  : status === 'PENDING'
                    ? summary.pending
                    : status === 'UPLOADED'
                      ? summary.uploaded
                      : summary.no_action;
              const isActive = statusFilter === status;
              
              return (
                <button
                  key={status}
                  onClick={() => setStatusFilter(status)}
                  className={`relative px-4 sm:px-5 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-300 ${
                    isActive 
                      ? 'text-white' 
                      : 'text-slate-400 hover:text-white hover:bg-slate-800'
                  }`}
                >
                  {isActive && (
                    <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 shadow-lg shadow-indigo-500/25" />
                  )}
                  <span className="relative z-10 flex items-center gap-2">
                    {status === 'All' ? 'All Sites' : status}
                    {status === 'All' ? ` (${summary.total} Site${summary.total === 1 ? '' : 's'})` : ''}
                    <span className={`px-2 py-0.5 rounded-full text-xs ${isActive ? 'bg-white/20' : 'bg-slate-800'}`}>
                      {count}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="text-xs sm:text-sm text-slate-400">
          Showing <span className="text-white font-semibold">{filteredPlants.length}</span> record(s)
        </div>

        {/* Main Table */}
        <div className="rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm overflow-hidden">
          <div className="p-4 sm:p-6 border-b border-slate-700/50 bg-gradient-to-r from-slate-800/50 to-transparent">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-xl bg-indigo-500/10">
                <FileText className="w-5 h-5 sm:w-6 sm:h-6 text-indigo-400" />
              </div>
              <div>
                <h3 className="text-lg sm:text-xl font-bold text-white">Site Schedule Status</h3>
                <p className="text-xs sm:text-sm text-slate-400">Individual site readiness and action management</p>
              </div>
            </div>
          </div>
          
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-slate-800/50 backdrop-blur-sm">
                  <th className="px-4 sm:px-6 py-3 sm:py-4 text-left text-xs font-semibold text-black dark:text-slate-400 uppercase tracking-wider">Site</th>
                  <th className="px-4 sm:px-6 py-3 sm:py-4 text-left text-xs font-semibold text-black dark:text-slate-400 uppercase tracking-wider">Status</th>
                  <th className="px-4 sm:px-6 py-3 sm:py-4 text-left text-xs font-semibold text-black dark:text-slate-400 uppercase tracking-wider">Trigger Reason</th>
                  <th className="px-4 sm:px-6 py-3 sm:py-4 text-left text-xs font-semibold text-black dark:text-slate-400 uppercase tracking-wider">Uploaded Time</th>
                  <th className="px-4 sm:px-6 py-3 sm:py-4 text-left text-xs font-semibold text-black dark:text-slate-400 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {filteredPlants.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-16 sm:py-20 text-center">
                      <div className="flex flex-col items-center gap-4">
                        <div className="p-4 rounded-full bg-slate-800/50">
                          <FileText className="w-10 h-10 text-slate-600" />
                        </div>
                        <div>
                          <p className="text-base sm:text-lg font-semibold text-slate-400">No sites match the current filter</p>
                          <p className="text-xs sm:text-sm text-slate-500 mt-1">Try adjusting your filter criteria</p>
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : filteredPlants.map((plant) => {
                  const sc = getStatusConfig(plant.status);
                  const StatusIcon = statusIcons[plant.status] || MinusCircle;
                  const PlantIcon = getPlantIcon(plant.plant_name);
                  const isSolar = plant.category === 'Solar';
                  
                  return (
                    <tr 
                      key={plant.id}
                      className="group hover:bg-slate-800/30 transition-all duration-300"
                    >
                      <td className="px-4 sm:px-6 py-4 sm:py-5">
                        <div className="flex items-center gap-4">
                          <div className={`relative p-3 rounded-xl transition-transform duration-300 group-hover:scale-110 ${
                            isSolar 
                              ? 'bg-gradient-to-br from-amber-500/20 to-orange-500/20' 
                              : 'bg-gradient-to-br from-blue-500/20 to-cyan-500/20'
                          }`}>
                            <PlantIcon className={`w-5 h-5 sm:w-6 sm:h-6 ${isSolar ? 'text-amber-400' : 'text-blue-400'}`} />
                          </div>
                          <div>
                            <p className="text-sm sm:text-base font-semibold text-white group-hover:text-indigo-400 transition-colors">{plant.plant_name}</p>
                            <p className="text-xs sm:text-sm text-slate-500">{plant.is_latest ? 'Latest schedule available' : 'Older schedule'}</p>
                            <p className="text-xs text-slate-500 mt-1">{plant.file_name}</p>
                            {plant.template_file_name ? (
                              <p className="text-xs text-blue-300 mt-1">
                                Template: {plant.template_file_name}
                              </p>
                            ) : null}
                            {formatRowClockTime(plant) ? (
                              <p className="text-xs text-slate-500 mt-1">
                                Time:{formatRowClockTime(plant)}
                              </p>
                            ) : null}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 sm:px-6 py-4 sm:py-5">
                        <span className={`inline-flex items-center gap-2 px-3 sm:px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold border ${sc.color}`}>
                          <StatusIcon className={`w-4 h-4 ${sc.iconColor}`} />
                          {sc.label}
                        </span>
                      </td>
                      <td className="px-4 sm:px-6 py-4 sm:py-5">
                        {normalizeTriggerReason(plant.trigger_reason) !== '-' ? (
                          <div className="flex items-center gap-2">
                            <AlertTriangle className="w-5 h-5 text-amber-400" />
                            <span className="text-xs sm:text-sm font-medium text-amber-400">{normalizeTriggerReason(plant.trigger_reason)}</span>
                          </div>
                        ) : (
                          <span className="text-xs sm:text-sm text-slate-500">-</span>
                        )}
                      </td>
                      <td className="px-4 sm:px-6 py-4 sm:py-5">
                        <span className="text-xs sm:text-sm text-slate-300">
                          {plant.status === 'UPLOADED' ? formatUploadedTime(plant.uploaded_at) : '-'}
                        </span>
                      </td>
                      <td className="px-4 sm:px-6 py-4 sm:py-5">
                        <div className="flex flex-col sm:flex-row gap-2">
                          {plant.status === 'PENDING' && (
                            <>
                              <button
                                onClick={() => handleActionClick(plant, 'editPending')}
                                className="w-full sm:w-auto px-3 sm:px-4 py-2 rounded-lg bg-gradient-to-r from-indigo-600 to-purple-600 text-white text-xs sm:text-sm font-semibold hover:from-indigo-500 hover:to-purple-500 transition-all duration-300 flex items-center justify-center gap-2"
                              >
                                <Upload className="w-4 h-4" />
                                Edit / Modify
                              </button>
                              <button
                                onClick={() => handleActionClick(plant, 'confirmUploaded')}
                                className="w-full sm:w-auto px-3 sm:px-4 py-2 rounded-lg bg-blue-700/90 text-white text-xs sm:text-sm font-semibold hover:bg-blue-600 transition-all duration-300 flex items-center justify-center gap-2 border border-blue-500/40"
                              >
                                <CheckCircle className="w-4 h-4" />
                                Uploaded?
                              </button>
                            </>
                          )}
                          {plant.status === 'NO_ACTION' && plant.is_latest && (
                            <button 
                              onClick={() => handleActionClick(plant, 'revise')}
                              className="w-full sm:w-auto px-3 sm:px-4 py-2 rounded-lg bg-slate-800 text-white text-xs sm:text-sm font-semibold hover:bg-slate-700 transition-all duration-300 flex items-center justify-center gap-2 border border-slate-700"
                            >
                              <Upload className="w-4 h-4" />
                              Revise
                            </button>
                          )}
                          {plant.status === 'READY' && plant.is_latest && (
                            <button 
                              onClick={() => handleReadyUpload(plant)}
                              className="w-full sm:w-auto px-3 sm:px-4 py-2 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 text-white text-xs sm:text-sm font-semibold hover:from-emerald-500 hover:to-teal-500 transition-all duration-300 flex items-center justify-center gap-2"
                            >
                              <Upload className="w-4 h-4" />
                              Upload
                            </button>
                          )}
                          {plant.status === 'UPLOADED' && (
                            <>
                              <span className="w-full sm:w-auto px-3 sm:px-4 py-2 rounded-lg bg-blue-500/10 text-blue-300 text-xs sm:text-sm font-semibold border border-blue-500/20 text-center">
                                Uploaded to SLDC
                              </span>
                              <button
                                onClick={() => handleViewUploadedTemplate(plant)}
                                className="w-full sm:w-auto px-3 sm:px-4 py-2 rounded-lg bg-slate-800 text-slate-200 text-xs sm:text-sm font-semibold hover:bg-slate-700 transition-all duration-300 border border-slate-700"
                              >
                                View
                              </button>
                            </>
                          )}
                          {!plant.is_latest && (
                            <button
                              onClick={() => handleHistoryClick(plant)}
                              className="w-full sm:w-auto px-3 sm:px-4 py-2 rounded-lg bg-slate-800 text-slate-200 text-xs sm:text-sm font-semibold hover:bg-slate-700 transition-all duration-300 flex items-center justify-center gap-2 border border-slate-700"
                            >
                              <Clock className="w-4 h-4" />
                              History
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Action Modal */}
      {showActionModal && selectedPlant && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 rounded-2xl shadow-2xl w-full max-w-md border border-slate-700">
            <div className="p-4 sm:p-6 border-b border-slate-700 flex items-center justify-between">
              <div className="flex items-center gap-3 sm:gap-4">
                <div className={`p-3 rounded-xl ${
                  actionType === 'revise' ? 'bg-indigo-500/10' : 
                  actionType === 'continue' ? 'bg-amber-500/10' :
                  actionType === 'confirmUploaded' ? 'bg-blue-500/10' :
                  actionType === 'editPending' ? 'bg-indigo-500/10' :
                  'bg-emerald-500/10'
                }`}>
                  {actionType === 'revise' && <Upload className="w-5 h-5 sm:w-6 sm:h-6 text-indigo-400" />}
                  {actionType === 'continue' && <ArrowRight className="w-5 h-5 sm:w-6 sm:h-6 text-amber-400" />}
                  {actionType === 'confirmUploaded' && <CheckCircle className="w-5 h-5 sm:w-6 sm:h-6 text-blue-400" />}
                  {actionType === 'editPending' && <Upload className="w-5 h-5 sm:w-6 sm:h-6 text-indigo-400" />}
                  {actionType === 'markReady' && <CheckCircle className="w-5 h-5 sm:w-6 sm:h-6 text-emerald-400" />}
                </div>
                <div>
                  <h2 className={`text-lg sm:text-xl font-bold ${
                    actionType === 'confirmUploaded' || actionType === 'markReady'
                      ? 'text-slate-900'
                      : 'text-white'
                  }`}>
                    {actionType === 'revise' && 'Trigger Schedule Revision'}
                    {actionType === 'continue' && 'Continue Existing Schedule'}
                    {actionType === 'confirmUploaded' && 'Upload Confirmation'}
                    {actionType === 'editPending' && 'Edit Pending Schedule'}
                    {actionType === 'markReady' && 'Upload Schedule'}
                  </h2>
                  <p className="text-xs sm:text-sm text-slate-400">{selectedPlant.plant_name}</p>
                </div>
              </div>
              <button 
                onClick={() => setShowActionModal(false)}
                className="p-2 hover:bg-slate-800 rounded-lg transition-colors"
              >
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>
            <div className="p-4 sm:p-6 space-y-4">
              {actionType === 'revise' && (
                <div>
                  <label className="text-sm font-medium text-slate-300 mb-2 block">Reason for Revision</label>
                  <select 
                    value={actionReason} 
                    onChange={(e) => setActionReason(e.target.value)}
                    className="w-full px-3.5 py-2.5 sm:px-4 sm:py-3 rounded-lg bg-slate-800 border border-slate-700 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="">Select a reason...</option>
                    <option value="Weather forecast change">Weather forecast change</option>
                    <option value="Curtailment signal received">Curtailment signal received</option>
                    <option value="Meter deviation detected">Meter deviation detected</option>
                    <option value="Manual trigger from dashboard">Manual trigger from dashboard</option>
                    <option value="Other">Other</option>
                  </select>
                  <p className="text-xs text-slate-500 mt-2">
                    This will trigger a new revision and navigate you to Schedule Preparation to edit the schedule.
                  </p>
                </div>
              )}
              {actionType === 'continue' && (
                <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="w-6 h-6 text-amber-400 shrink-0" />
                    <div>
                      <p className="text-sm font-semibold text-amber-400">Continue with Existing Schedule</p>
                      <p className="text-xs sm:text-sm text-slate-300 mt-1">This will clear all pending triggers and continue with the existing day-ahead schedule.</p>
                    </div>
                  </div>
                </div>
              )}
              {actionType === 'markReady' && (
                <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl">
                  <div className="flex items-start gap-3">
                    <CheckCircle className="w-6 h-6 text-emerald-400 shrink-0" />
                    <div>
                      <p className="text-sm font-semibold text-emerald-400">Move To Pending + Convert</p>
                      <p className="text-xs sm:text-sm text-slate-300 mt-1">This will send the selected CSV to Schedule Templates, auto-select it and start SLDC conversion flow.</p>
                    </div>
                  </div>
                </div>
              )}
              {actionType === 'editPending' && (
                <div className="p-4 bg-indigo-500/10 border border-indigo-500/20 rounded-xl">
                  <div className="flex items-start gap-3">
                    <Upload className="w-6 h-6 text-indigo-400 shrink-0" />
                    <div>
                      <p className="text-sm font-semibold text-indigo-300">Edit/Modify Pending Schedule</p>
                      <p className="text-xs sm:text-sm text-slate-300 mt-1">Open Schedule Templates with this CSV pre-selected so you can modify and regenerate the SLDC template.</p>
                    </div>
                  </div>
                </div>
              )}
              {actionType === 'confirmUploaded' && (
                <div className="p-4 bg-blue-500/10 border border-blue-500/20 rounded-xl">
                  <div className="flex items-start gap-3">
                    <CheckCircle className="w-6 h-6 text-blue-400 shrink-0" />
                    <div>
                      <p className="text-sm font-semibold text-black">Is this schedule uploaded to SLDC?</p>
                      <p className="text-xs sm:text-sm text-slate-300 mt-1">Select Yes to move this file from Pending to Uploaded section in Schedule Readiness.</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div className="p-4 sm:p-6 border-t border-slate-700 flex flex-col sm:flex-row gap-3">
              <button 
                onClick={() => setShowActionModal(false)}
                className={`w-full sm:flex-1 px-4 py-3 rounded-lg font-semibold transition-all duration-300 ${
                  actionType === 'confirmUploaded' || actionType === 'markReady'
                    ? 'bg-slate-100 text-slate-900 hover:bg-slate-200'
                    : 'bg-slate-800 text-white hover:bg-slate-700'
                }`}
              >
                Cancel
              </button>
              <button 
                onClick={executeAction}
                disabled={(actionType === 'revise' && !actionReason) || isRefreshing}
                className={`w-full sm:flex-1 px-4 py-3 rounded-lg font-semibold transition-all duration-300 disabled:opacity-50 flex items-center justify-center gap-2 ${
                  actionType === 'continue' 
                    ? 'bg-gradient-to-r from-amber-600 to-orange-600 text-white' 
                    : actionType === 'markReady'
                    ? 'bg-gradient-to-r from-emerald-600 to-teal-600 text-white'
                    : 'bg-gradient-to-r from-indigo-600 to-purple-600 text-white'
                }`}
              >
                {isRefreshing ? (
                  <>
                    <LoadingSpinner size="sm" />
                    <span>Processing...</span>
                  </>
                ) : (
                  getActionButtonText()
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {templateViewRow && (() => {
        const csvText = String(templateViewRow.template_csv_text || '');
        const blockRows = parseSldcBlockTable(csvText);
        const metadataRaw = extractSldcMetadataRaw(csvText);
        const metadataPairs = parseSldcMetadataPairs(csvText);
        const resolvePlantCode = (row) => {
          const explicit = String(row?.plant_code || '').trim().toUpperCase();
          if (explicit) return explicit;
          const fileName = String(row?.template_file_name || row?.file_name || '').trim();
          const match = fileName.match(/^([A-Z0-9_-]+)_\d{4}-\d{2}-\d{2}_/);
          if (match?.[1]) return match[1].toUpperCase();
          const keyMatch = String(row?.template_s3_key || row?.file_key || '').match(/\/vedanjay\/([^/]+)\//i);
          if (keyMatch?.[1]) return keyMatch[1].toUpperCase();
          return '';
        };
        const TELANGANA_STATION_SCHEDULE_PLANTS = new Set(['BHUPALPALLY', 'KASIPET', 'KOTHAGUDEM']);
        const plantCodeForTemplate = resolvePlantCode(templateViewRow);
        const isTelanganaStationSchedule = TELANGANA_STATION_SCHEDULE_PLANTS.has(plantCodeForTemplate);
        return (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 rounded-2xl shadow-2xl w-full max-w-4xl border border-slate-700 max-h-[90vh] overflow-hidden">
            <div className="p-4 sm:p-5 border-b border-slate-700 flex items-center justify-between">
              <div>
                <h3 className="text-base sm:text-lg font-bold text-black">Uploaded SLDC Template</h3>
                <p className="text-[11px] sm:text-xs text-slate-400 mt-1">
                  {templateViewRow.template_file_name || 'Template file'}
                  {templateViewRow.template_generated_at
                    ? ` | Generated: ${templateViewRow.template_generated_at}`
                    : ''}
                </p>
              </div>
              <button
                onClick={() => setTemplateViewRow(null)}
                className="p-2 hover:bg-slate-800 rounded-lg transition-colors"
              >
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>
            <div className="p-4 sm:p-5 overflow-auto max-h-[60vh]">
              {!HIDE_METADATA && metadataRaw ? (
                <div className="mb-4">
                  <p className="text-xs text-slate-400 mb-2">Metadata</p>
                  {metadataPairs.length > 0 ? (
                    <div className="border border-slate-700 rounded-lg overflow-hidden">
                      <table className="w-full text-xs">
                        <tbody>
                          {metadataPairs.map((pair) => (
                            <tr key={`meta-${pair.key}`} className="border-t border-slate-800 first:border-t-0">
                              <td className="px-3 py-2 text-slate-400 whitespace-nowrap w-48">{pair.key}</td>
                              <td className="px-3 py-2 text-slate-200">{pair.value || '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <pre className="text-xs leading-5 text-slate-300 whitespace-pre-wrap break-all bg-slate-950/40 border border-slate-800 rounded-lg p-3">
                      {metadataRaw}
                    </pre>
                  )}
                </div>
              ) : null}
              {blockRows.length > 0 ? (
                <div className="border border-slate-700 rounded-lg overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-800 sticky top-0">
                      <tr>
                        <th className="px-3 py-2 text-left font-semibold text-black dark:text-slate-200 whitespace-nowrap">Block</th>
                        <th className="px-3 py-2 text-left font-semibold text-black dark:text-slate-200 whitespace-nowrap">Block Interval</th>
                        <th className="px-3 py-2 text-left font-semibold text-black dark:text-slate-200 whitespace-nowrap">Availability</th>
                        <th className="px-3 py-2 text-left font-semibold text-black dark:text-slate-200 whitespace-nowrap">Forecast</th>
                        {isTelanganaStationSchedule && (
                          <th className="px-3 py-2 text-left font-semibold text-black dark:text-slate-200 whitespace-nowrap">Station Schedule</th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {blockRows.map((row) => (
                        <tr key={`block-row-${row.block}`} className="border-t border-slate-800">
                          <td className="px-3 py-2 text-slate-300 whitespace-nowrap">{row.block}</td>
                          <td className="px-3 py-2 text-slate-300 whitespace-nowrap">{row.interval}</td>
                          <td className="px-3 py-2 text-slate-300 whitespace-nowrap">{row.availability}</td>
                          <td className="px-3 py-2 text-slate-300 whitespace-nowrap">{row.forecast}</td>
                          {isTelanganaStationSchedule && (
                            <td className="px-3 py-2 text-slate-300 whitespace-nowrap">{row.stationSchedule}</td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : csvText.trim() ? (
                <pre className="text-xs leading-5 text-slate-200 whitespace-pre-wrap break-all">
                  {csvText}
                </pre>
              ) : (
                <p className="text-sm text-slate-400">
                  Template content is not available in local history. Open Schedule Templates and regenerate.
                </p>
              )}
            </div>
            <div className="p-4 sm:p-5 border-t border-slate-700 flex flex-col sm:flex-row gap-3 justify-end">
              <button
                onClick={() => setTemplateViewRow(null)}
                className="w-full sm:w-auto px-4 py-2 rounded-lg bg-slate-800 text-white font-semibold hover:bg-slate-700 transition-all duration-300"
              >
                Close
              </button>
              <button
                onClick={() => {
                  setPendingTemplateDownload(templateViewRow);
                  setDownloadFormat('csv');
                  setShowDownloadModal(true);
                }}
                className="w-full sm:w-auto px-4 py-2 rounded-lg bg-gradient-to-r from-indigo-600 to-purple-600 text-white font-semibold hover:from-indigo-500 hover:to-purple-500 transition-all duration-300"
              >
                Download
              </button>
            </div>
          </div>
        </div>
      )})()}

      <DownloadFormatModal
        open={showDownloadModal}
        onClose={() => { setShowDownloadModal(false); setPendingTemplateDownload(null); }}
        format={downloadFormat}
        onFormatChange={setDownloadFormat}
        onDownload={() => {
          if (!pendingTemplateDownload) return;
          handleDownloadUploadedTemplate(pendingTemplateDownload, downloadFormat);
        }}
      />
    </div>
  );
}






