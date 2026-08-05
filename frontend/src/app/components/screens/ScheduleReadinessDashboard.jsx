import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  CheckCircle, Clock, MinusCircle, AlertCircle,
  FileText, AlertTriangle, Wind, Sun, Upload, ArrowRight,
  Layers, TrendingUp, X, Download
} from 'lucide-react';
import { LoadingSpinner } from '@/app/components/common/LoadingSpinner';
import DownloadFormatModal from '@/app/components/common/DownloadFormatModal';
import { downloadCsvText, downloadXlsxFromCsvText } from '@/app/components/common/downloadUtils';
import { toast } from 'sonner';
import { S3_BASE_URL, HIDE_METADATA } from '@/config/appConfig';
import { useAuth, useWorkflowGuide } from '@/app/appContexts';
import { getEmployeeName } from '@/utils/getEmployeeName.js';
import { api, scheduleReadinessApi, frozenScheduleApi, schedulesApi } from '@/services/api';
import { isAnyScheduleCsvKey, isFrozenScheduleCsvKey, fetchTextFromS3Optional } from '@/services/s3Utils';
import { getSubmitBlockFromTimestamp, getEffectiveStartBlock } from '@/shared/freezeRules';
import { recomputeFrozenForPlantDate, recomputeSystemFrozenForPlantDate } from '@/services/autoFreezeService';
import { canUserAccessPlantCode, filterPlantsForUser, getDisabledPlantPattern, isAdminUser } from '@/utils/plantAccess';
import { toPlantDisplayName } from '@/utils/plantDisplay';
import {
  computeIntradayRunIndexByKey,
  extractScheduleDateFromKey,
  formatMachineScheduleDisplayName,
  replaceMachineScheduleNamesInText,
} from '@/utils/machineScheduleDisplay';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

const statusIcons = { READY: CheckCircle, NO_ACTION: MinusCircle, UPLOADED: CheckCircle };
const READINESS_WORKFLOW_STORAGE_KEY = 'vedanjay-readiness-workflow-v1';
const SLDC_TEMPLATE_MAP_STORAGE_KEY = 'vedanjay-sldc-template-map-v1';
const COMBINED_DAYAHEAD_TEMPLATE_DOWNLOADS_STORAGE_KEY = 'vedanjay-combined-dayahead-template-downloads-v1';
const SLDC_UPLOAD_REFRESH_EVENT = 'vedanjay:sldc-upload-refresh';
const READINESS_S3_LIST_CACHE_TTL_MS = 15_000;
const READINESS_S3_TEXT_CACHE_TTL_MS = 30_000;
const readinessS3ListCache = new Map();
const readinessS3TextCache = new Map();

const getReadinessS3CacheKey = (prefixes, limit) => JSON.stringify({
  prefixes: Array.from(new Set((prefixes || []).map((p) => String(p || '').trim()).filter(Boolean))).sort(),
  limit: Number(limit || 2000),
});

const getReadinessCacheValue = (cache, key, ttlMs) => {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > ttlMs) {
    cache.delete(key);
    return null;
  }
  return entry.value;
};

const setReadinessCacheValue = (cache, key, value) => {
  if (cache.size > 250) cache.clear();
  cache.set(key, { ts: Date.now(), value });
};
const getLocalDateKey = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const addDaysToDateKey = (value, days) => {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  const base = new Date(`${raw}T00:00:00`);
  if (Number.isNaN(base.getTime())) return raw;
  base.setDate(base.getDate() + Number(days || 0));
  const year = base.getFullYear();
  const month = String(base.getMonth() + 1).padStart(2, '0');
  const day = String(base.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const deriveCodeFromPlantName = (value) => {
  const text = String(value || '').trim();
  if (!text) return '';
  const parenCode = text.match(/\(([A-Za-z0-9_-]+)\)/)?.[1];
  if (parenCode) return String(parenCode).toUpperCase();
  const compact = text.replace(/[^A-Za-z0-9_-]/g, '').toUpperCase();
  // Normalize known aliases/typos so S3 prefixes + upload endpoints remain consistent.
  if (compact === 'OSEL' || compact === 'OSEPL') return 'OSEPL';
  if (compact === 'SHRIMOUR' || compact === 'SHROMOUR') return 'SIRMOUR';
  if (compact === 'ANJANGOAN') return 'ANJANGAON';
  if (compact === 'ZETRICSOLARPARK') return 'ZETRIC';
  if (compact === 'ZTRIC') return 'ZETRIC';
  return compact;
};

const normalizeReadinessPlantCode = (value) => {
  const code = String(value || '').trim().toUpperCase();
  if (code === 'ZTRIC' || code === 'MULTIPLE_GENERATOR') return 'ZETRIC';
  return deriveCodeFromPlantName(code);
};

const getSpecialS3PlantFolder = (value) => {
  const code = normalizePlantCode(value);
  if (code === 'ANJANGAON') return 'ANJANGOAN';
  return code;
};

const normalizeDateInput = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  // Handle dd-mm-yyyy -> yyyy-mm-dd
  const match = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (match) {
    const [, dd, mm, yyyy] = match;
    return `${yyyy}-${mm}-${dd}`;
  }
  return raw;
};

export function ScheduleReadinessDashboard({ onNavigate }) {
  const { user: currentUser } = useAuth();
  const workflowGuide = useWorkflowGuide();
  const [statusFilter, setStatusFilter] = useState('All');
  const [scheduleTypeFilter, setScheduleTypeFilter] = useState('ALL'); // ALL | INTRADAY | DAY_AHEAD
  const [selectedPlant, setSelectedPlant] = useState(null);
  const [showActionModal, setShowActionModal] = useState(false);
  const [actionType, setActionType] = useState(null);
  const [actionReason, setActionReason] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [readinessData, setReadinessData] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isBackgroundLoading, setIsBackgroundLoading] = useState(false);
  const [hasLoadedReadiness, setHasLoadedReadiness] = useState(false);
  const [loadRequest, setLoadRequest] = useState(null);
  const [isDownloadingReport, setIsDownloadingReport] = useState(false);
  const [selectedDate, setSelectedDate] = useState(() => getLocalDateKey());
  const todayDateKey = useMemo(() => getLocalDateKey(), []);
  const [generatedPlantCodes, setGeneratedPlantCodes] = useState([]);
  const [generatedDayAheadPlantCodes, setGeneratedDayAheadPlantCodes] = useState([]);
  const [autoRefreshTick, setAutoRefreshTick] = useState(0);
  const [uploadedStateFilter, setUploadedStateFilter] = useState('All');
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
  const [combinedDayAheadTemplateDownloadsBySource, setCombinedDayAheadTemplateDownloadsBySource] = useState(() => {
    try {
      const raw = localStorage.getItem(COMBINED_DAYAHEAD_TEMPLATE_DOWNLOADS_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  });
  const triggerReasonInFlightRef = useRef(new Set());
  const dashboardSummaryLoadedRef = useRef(false);
  const lastAutoLoadKeyRef = useRef('');
  const isAdmin = isAdminUser(currentUser);

  // Autosubmit (system auto-upload) slot logic:
  // - Slot = 90 minutes = 6 blocks
  // - Only 1 autosubmit per slot (per plant/date)
  // - Autosubmit "submission time" = base event time + 4 minutes
  const AUTO_UPLOAD_SLOT_BLOCKS = 6;
  const AUTO_UPLOAD_OFFSET_MINUTES = 4;
  // system_frozen.csv is intentionally not generated from the browser.

  // Ensure Readiness screen shows every plant that has schedules in S3 generated/ prefix,
  // even if it is missing from the DB seed list.
  useEffect(() => {
    if (!hasLoadedReadiness) return undefined;
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (dashboardSummaryLoadedRef.current) return;
      try {
        const dateKey = normalizeDateInput(String(selectedDate || '').trim());
        const resp = await schedulesApi.listPlants({ date: dateKey, type: 'intraday', limit: 800 });
        const items = Array.isArray(resp?.items) ? resp.items : [];
        const codes = items
          .map((r) => String(r?.plant_code || '').trim().toUpperCase())
          .filter(Boolean)
          .map((c) => {
            if (c === 'OSEL') return 'OSEPL';
            if (c === 'SHRIMOUR' || c === 'SHROMOUR') return 'SIRMOUR';
            return c;
          }); // hard-alias safety
        const uniq = Array.from(new Set(codes)).sort();
        if (!cancelled) setGeneratedPlantCodes(uniq);
      } catch {
        if (!cancelled) setGeneratedPlantCodes([]);
      }
    }, 750);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [selectedDate, hasLoadedReadiness]);

  // Day-ahead plant discovery (separate, so DA rows are complete and never mixed with intraday).
  useEffect(() => {
    if (!hasLoadedReadiness) return undefined;
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (dashboardSummaryLoadedRef.current) return;
      try {
        const dateKey = normalizeDateInput(String(selectedDate || '').trim());
        const resp = await schedulesApi.listPlants({ date: dateKey, type: 'dayahead', limit: 800 });
        const items = Array.isArray(resp?.items) ? resp.items : [];
        const codes = items
          .map((r) => String(r?.plant_code || '').trim().toUpperCase())
          .filter(Boolean)
          .map((c) => {
            if (c === 'OSEL') return 'OSEPL';
            if (c === 'SHRIMOUR' || c === 'SHROMOUR') return 'SIRMOUR';
            return c;
          }); // hard-alias safety
        const uniq = Array.from(new Set(codes)).sort();
        if (!cancelled) setGeneratedDayAheadPlantCodes(uniq);
      } catch {
        if (!cancelled) setGeneratedDayAheadPlantCodes([]);
      }
    }, 750);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [selectedDate, hasLoadedReadiness]);

  useEffect(() => {
    if (!generatedPlantCodes.length) return;
    setReadinessData((prev) => {
      const rows = Array.isArray(prev) ? [...prev] : [];
      const existingCodes = new Set(
        rows
          .map((r) => deriveCodeFromPlantName(r?.plant_name || r?.plantName || r?.name || r?.plant_code || r?.plantCode))
          .filter(Boolean)
      );
      let changed = false;
      for (const code of generatedPlantCodes) {
        const normalized = code === 'OSEL' ? 'OSEPL' : code;
        if (!normalized) continue;
        if (existingCodes.has(normalized)) continue;
        changed = true;
        rows.push({
          id: `s3-${normalized}`,
          plant_id: null,
          plant_name: normalized === 'OSEPL' ? 'OSEL' : normalized,
          plant_code: normalized,
          status: 'READY',
          trigger_reason: null,
          importance: '-',
          last_checked: null,
          upload_deadline: null,
          revision_number: 0,
          schedule_date: selectedDate,
          _source: 's3_discovered',
        });
      }
      return changed ? rows : prev;
    });
  }, [generatedPlantCodes, selectedDate]);

  // If the readiness list is later refreshed from the backend (which may not include S3-only plants),
  // ensure we re-merge the generated/S3-discovered plant codes so BHUPALPALLY/SIRMOUR etc stay visible.
  useEffect(() => {
    if (!generatedPlantCodes.length) return;
    const rows = Array.isArray(readinessData) ? readinessData : [];
    const existingCodes = new Set(
      rows
        .map((r) =>
          deriveCodeFromPlantName(
            r?.plant_name || r?.plantName || r?.name || r?.plant_code || r?.plantCode
          )
        )
        .filter(Boolean)
    );
    const missing = generatedPlantCodes.filter((code) => {
      const normalized = code === 'OSEL' ? 'OSEPL' : code;
      return normalized && !existingCodes.has(normalized);
    });
    if (!missing.length) return;

    setReadinessData((prev) => {
      const nextRows = Array.isArray(prev) ? [...prev] : [];
      const nextCodes = new Set(
        nextRows
          .map((r) =>
            deriveCodeFromPlantName(
              r?.plant_name || r?.plantName || r?.name || r?.plant_code || r?.plantCode
            )
          )
          .filter(Boolean)
      );
      let changed = false;
      for (const code of missing) {
        const normalized = code === 'OSEL' ? 'OSEPL' : code;
        if (!normalized) continue;
        if (nextCodes.has(normalized)) continue;
        changed = true;
        nextRows.push({
          id: `s3-${normalized}`,
          plant_id: null,
          plant_name: normalized === 'OSEPL' ? 'OSEL' : normalized,
          plant_code: normalized,
          status: 'READY',
          trigger_reason: null,
          importance: '-',
          last_checked: null,
          upload_deadline: null,
          revision_number: 0,
          schedule_date: selectedDate,
          _source: 's3_discovered',
        });
      }
      return changed ? nextRows : prev;
    });
  }, [generatedPlantCodes, readinessData, selectedDate]);

  const readJsonLocal = (key, fallback) => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed == null ? fallback : parsed;
    } catch {
      return fallback;
    }
  };

  const writeJsonLocal = (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore
    }
  };

  const autoSlotKey = (plantCode, scheduleDate, slotIndex) =>
    `auto_upload_slot_used_v1|${String(plantCode || '').trim().toUpperCase()}|${String(scheduleDate || '').trim()}|${String(slotIndex)}`;

  const autoQueueKey = (plantCode, scheduleDate) =>
    `auto_upload_queue_v1|${String(plantCode || '').trim().toUpperCase()}|${String(scheduleDate || '').trim()}`;

  const addMinutes = (date, minutes) => new Date(date.getTime() + (Number(minutes) || 0) * 60 * 1000);

  const normalizeAutoReason = (rawReason) => {
    const text = String(rawReason || '').trim().toUpperCase();
    if (!text || text === '-') return null;
    if (text.includes('ABRUPT') && text.includes('WEATHER')) return { key: 'ABRUPT_WEATHER', label: 'Abrupt weather change', queueable: false };
    if (text.includes('DYNAMIC START')) return { key: 'DYNAMIC_START', label: 'Dynamic start', queueable: true };
    if (text.includes('DYNAMIC')) return { key: 'DYNAMIC_START', label: 'Dynamic start', queueable: true };
    if (text.includes('PLANT_STATUS_CHANGE') || (text.includes('PLANT') && text.includes('STATUS') && text.includes('CHANGE'))) {
      return { key: 'PLANT_STATUS_CHANGE', label: 'Plant status change', queueable: true };
    }
    if (text.includes('CURTAIL')) return { key: 'CURTAILMENT', label: 'Curtailment', queueable: true };
    return null;
  };

  const getSlotIndexFromTimestamp = (timestampIso) => {
    const submitBlock = getSubmitBlockFromTimestamp(timestampIso);
    if (!Number.isFinite(submitBlock)) return null;
    return Math.floor((Number(submitBlock) - 1) / AUTO_UPLOAD_SLOT_BLOCKS);
  };

  const getSlotStartDate = (scheduleDateKey, slotIndex) => {
    const normalized = String(scheduleDateKey || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
    const slotStartBlock = (Number(slotIndex) * AUTO_UPLOAD_SLOT_BLOCKS) + 1;
    if (!Number.isFinite(slotStartBlock) || slotStartBlock < 1 || slotStartBlock > 96) return null;
    const base = new Date(`${normalized}T00:00:00`);
    if (Number.isNaN(base.getTime())) return null;
    return addMinutes(base, (slotStartBlock - 1) * 15);
  };

  const describeAutoDecision = ({ decision, reasonLabel, note }) => {
    const base = decision || '-';
    const bracket = [reasonLabel, note].filter(Boolean).join(' - ');
    return bracket ? `${base} (${bracket})` : base;
  };

  const reportManualChangeLogCacheRef = useRef(new Map()); // plant|date -> items[]
  const reportManualChangeCountCacheRef = useRef(new Map()); // plant|date|sourceKey -> count
  const reportManualChangeIndexCacheRef = useRef(new Map()); // plant|date -> { byKey: Map, byBase: Map }
  const reportLogoDataUrlRef = useRef(null);

  useEffect(() => {
    if (statusFilter === 'PENDING') setStatusFilter('READY');
  }, [statusFilter]);

  // Keep local workflow/template maps in sync when returning from other screens (Templates/Preparation).
  // Note: `storage` events do not fire in the same tab that wrote localStorage, so we also refresh on focus.
  useEffect(() => {
    const readJsonObject = (key) => {
      try {
        const raw = localStorage.getItem(key);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    };

    const refreshFromStorage = () => {
      setWorkflowByFile(readJsonObject(READINESS_WORKFLOW_STORAGE_KEY));
      setSldcTemplateMapBySource(readJsonObject(SLDC_TEMPLATE_MAP_STORAGE_KEY));
      setCombinedDayAheadTemplateDownloadsBySource(readJsonObject(COMBINED_DAYAHEAD_TEMPLATE_DOWNLOADS_STORAGE_KEY));
    };

    const onFocus = () => refreshFromStorage();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refreshFromStorage();
    };
    const onSldcUploadRefresh = () => {
      refreshFromStorage();
      setAutoRefreshTick((v) => v + 1);
    };

    window.addEventListener('focus', onFocus);
    window.addEventListener(SLDC_UPLOAD_REFRESH_EVENT, onSldcUploadRefresh);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener(SLDC_UPLOAD_REFRESH_EVENT, onSldcUploadRefresh);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const showUploadedByColumn =
    String(currentUser?.username || '').toLowerCase() === 'scheduling_vppl' &&
    statusFilter === 'UPLOADED';

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
    'raw/vedanjay/ANDAD/',
    'raw/vedanjay/BALAKWADA/',
    'raw/vedanjay/GUGARIYAKHEDI/',
    'raw/vedanjay/NANDGAON/',
    'raw/vedanjay/BAMKHAL/',
    'raw/vedanjay/SAWDA/',
    'raw/vedanjay/multiple_generator/ZTRIC/',
    'raw/vedanjay/ANJANGAON/',
    'raw/vedanjay/ANJANGOAN/',
    'raw/vedanjay/SIRMOUR/',
    'raw/vedanjay/SHRIMOUR/',
    'raw/vedanjay/SHROMOUR/',
    'raw/GSNP/gsnp/',
    'raw/Sirmour/sirmour/',
    'raw/Shrimour/shrimour/',
    'raw/Shromour/shromour/',
  ];
  const GENERATED_OUTPUTS_BASE_PREFIXES = [
    'generated/vedanjay/BHUPALPALLY/outputs/',
    'generated/vedanjay/CME/outputs/',
    'generated/vedanjay/GSNP/outputs/',
    'generated/vedanjay/KASIPET/outputs/',
    'generated/vedanjay/KILAJ/outputs/',
    'generated/vedanjay/KOTHAGUDEM/outputs/',
    'generated/vedanjay/OSEPL/outputs/',
    'generated/vedanjay/ANDAD/outputs/',
    'generated/vedanjay/BALAKWADA/outputs/',
    'generated/vedanjay/GUGARIYAKHEDI/outputs/',
    'generated/vedanjay/NANDGAON/outputs/',
    'generated/vedanjay/BAMKHAL/outputs/',
    'generated/vedanjay/SAWDA/outputs/',
    'generated/vedanjay/multiple_generator/ZTRIC/',
    'generated/vedanjay/ANJANGAON/outputs/',
    'generated/vedanjay/ANJANGOAN/outputs/',
    'generated/vedanjay/SIRMOUR/outputs/',
    'generated/vedanjay/SHRIMOUR/outputs/',
    'generated/vedanjay/SHROMOUR/outputs/',
    'generated/GSNP/gsnp/outputs/',
    'generated/Sirmour/sirmour/outputs/',
    'generated/Shrimour/shrimour/outputs/',
    'generated/Shromour/shromour/outputs/',
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
      capacity: 5,
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
      name: 'OSEL',
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
    {
      id: 9,
      code: 'SAWDA',
      name: 'SAWDA',
      state: 'Madhya Pradesh',
      type: 'Solar',
      capacity: 7.5,
      latitude: 21.02138889,
      longitude: 75.60027778,
    },
    {
      id: 16,
      code: 'ZETRIC',
      name: 'ZETRIC',
      state: 'Maharashtra',
      type: 'Solar',
      capacity: 25,
      latitude: 18.557968,
      longitude: 76.859083,
    },
    {
      id: 11,
      code: 'BAMKHAL',
      name: 'BAMKHAL',
      state: 'Madhya Pradesh',
      type: 'Solar',
      capacity: 5,
      latitude: 21.93,
      longitude: 75.671111,
    },
    {
      id: 12,
      code: 'ANDAD',
      name: 'ANDAD',
      state: 'Madhya Pradesh',
      type: 'Solar',
      capacity: 7.5,
      latitude: 21.95972222,
      longitude: 75.80583333,
    },
    {
      id: 13,
      code: 'GUGARIYAKHEDI',
      name: 'GUGARIYAKHEDI',
      state: 'Madhya Pradesh',
      type: 'Solar',
      capacity: 7.5,
      latitude: 21.83944444,
      longitude: 75.71888889,
    },
    {
      id: 14,
      code: 'BALAKWADA',
      name: 'BALAKWADA',
      state: 'Madhya Pradesh',
      type: 'Solar',
      capacity: 7.5,
      latitude: 22.00583333,
      longitude: 75.52333333,
    },
    {
      id: 15,
      code: 'NANDGAON',
      name: 'NANDGAON',
      state: 'Madhya Pradesh',
      type: 'Solar',
      capacity: 7.5,
      latitude: 21.88222222,
      longitude: 75.48027778,
    },
    {
      id: 10,
      code: 'ANJANGAON',
      name: 'ANJANGAON',
      state: 'Madhya Pradesh',
      type: 'Solar',
      capacity: 7.5,
    },
  ];
  const visiblePlants = useMemo(() => filterPlantsForUser(S3_PLANTS, currentUser), [currentUser]);

  // =============================================================================
  // S3 HELPERS
  // =============================================================================
  const parseCsvText = (csvText) => {
    const lines = String(csvText || '').split(/\r?\n/).filter((l) => l.trim() !== '');
    if (!lines.length) return { headers: [], rows: [] };

    const headerIdx = lines.findIndex((l) => /\bblock\b/i.test(l));
    const idx = headerIdx >= 0 ? headerIdx : 0;
    const headers = parseCsvLine(lines[idx] || '').map((h) => h.replace(/^\uFEFF/, '').trim());
    const rows = lines.slice(idx + 1).map((line) => parseCsvLine(line));
    return { headers, rows };
  };

  // Parse both SLDC templates and generated schedule CSVs into block->MW map.
  const parseSldcTemplateScheduleMap = (csvText) => {
    const { headers, rows } = parseCsvText(csvText);
    if (!headers.length) return new Map();

    const normalize = (value) =>
      String(value || '')
        .toLowerCase()
        .replace(/["']/g, '')
        .replace(/[^a-z0-9]+/g, '');

    const normalized = headers.map(normalize);
    const findCol = (needles) => normalized.findIndex((h) => needles.some((n) => h.includes(n)));

    const blockIdx = findCol(['block', 'blk', 'blockno', 'blocknumber']);
    const stationScheduleIdx = findCol(['stationschedule']);
    const scheduleIdx = stationScheduleIdx !== -1 ? stationScheduleIdx : findCol(['schedule']);
    const forecastIdx = findCol(['declaredforecast', 'forecast']);
    const algoIdx = findCol(['algoschedulemw', 'algoschedule', 'algo']);
    const baseIdx = findCol(['base']);

    const valueIdx =
      algoIdx !== -1
        ? algoIdx
        : scheduleIdx !== -1
          ? scheduleIdx
          : baseIdx !== -1
            ? baseIdx
            : (forecastIdx !== -1 ? forecastIdx : Math.max(0, headers.length - 1));

    const toNum = (value) => {
      const cleaned = String(value ?? '').replace(/,/g, '').trim();
      const parsed = Number.parseFloat(cleaned);
      return Number.isFinite(parsed) ? parsed : null;
    };

    const out = new Map();
    rows.forEach((cols, idx) => {
      const blockRaw = blockIdx !== -1 ? cols[blockIdx] : cols[0];
      const block = Number.parseInt(String(blockRaw || '').trim(), 10);
      if (!Number.isFinite(block) || block < 1 || block > 96) return;
      const scheduled = toNum(cols[valueIdx]);
      out.set(block, Number.isFinite(scheduled) ? scheduled : 0);
    });

    for (let block = 1; block <= 96; block += 1) {
      if (!out.has(block)) out.set(block, 0);
    }

    return out;
  };

  const toNumber = (value) => {
    const cleaned = String(value ?? '').replace(/,/g, '').trim();
    const parsed = Number.parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const parseFrozenCsvMeta = (existingCsvText) => {
    const parsed = existingCsvText ? parseCsvText(existingCsvText) : { headers: [], rows: [] };
    const headerNorm = (parsed.headers || []).map((h) => String(h || '').toLowerCase().replace(/\s+/g, ''));
    const blockIdx = headerNorm.findIndex((h) => h.includes('block'));
    const timeIdx = headerNorm.findIndex((h) => h === 'time' || h.includes('time'));
    const scheduledIdx = headerNorm.findIndex((h) => h.includes('scheduled'));
    const actualIdx = headerNorm.findIndex((h) => h.includes('actual'));
    const penaltyIdx = headerNorm.findIndex((h) => h.includes('penalty'));
    const sourceIdx = headerNorm.findIndex((h) => h.includes('source'));

    const timeByBlock = new Map();
    const actualByBlock = new Map();
    const penaltyByBlock = new Map();
    const scheduledByBlock = new Map();
    const sourceByBlock = new Map();

    (parsed.rows || []).forEach((cols) => {
      const block = Number.parseInt(String(blockIdx >= 0 ? cols[blockIdx] : cols?.[0] || '').trim(), 10);
      if (!Number.isFinite(block) || block < 1 || block > 96) return;
      const time = timeIdx >= 0 ? String(cols?.[timeIdx] || '').trim() : '';
      if (time) timeByBlock.set(block, time);
      const actual = actualIdx >= 0 ? toNumber(cols?.[actualIdx]) : null;
      if (Number.isFinite(actual)) actualByBlock.set(block, actual);
      const penalty = penaltyIdx >= 0 ? String(cols?.[penaltyIdx] ?? '').trim() : '';
      if (penalty !== '') penaltyByBlock.set(block, penalty);
      const scheduled = scheduledIdx >= 0 ? toNumber(cols?.[scheduledIdx]) : null;
      if (Number.isFinite(scheduled)) scheduledByBlock.set(block, scheduled);
      const source = sourceIdx >= 0 ? String(cols?.[sourceIdx] ?? '').trim() : '';
      if (source) sourceByBlock.set(block, source);
    });

    return { timeByBlock, actualByBlock, penaltyByBlock, scheduledByBlock, sourceByBlock };
  };

  const blockToInterval = (block) => {
    const clamped = Math.min(Math.max(Number(block) || 1, 1), 96);
    const idx = clamped - 1;
    const startMinutes = idx * 15;
    const endMinutes = startMinutes + 15;
    const pad2 = (n) => String(n).padStart(2, '0');
    const fmt = (mins) => `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;
    return `${fmt(startMinutes)}-${fmt(endMinutes)}`;
  };

  const buildFrozenCsvFromScheduleMaps = ({
    existingCsvText,
    scheduleByBlock,
    sourceByBlock,
    capacityMw,
  }) => {
    const headers = [
      'Block',
      'Time',
      'Scheduled MW',
      'Actual MW',
      'Deviation MW',
      'Deviation %',
      'Penalty Rs',
      'Source Schedule',
    ];

    const safeCapacity = Number.isFinite(Number(capacityMw)) && Number(capacityMw) > 0 ? Number(capacityMw) : null;
    const meta = parseFrozenCsvMeta(existingCsvText);

    const rows = [];
    for (let block = 1; block <= 96; block += 1) {
      const scheduledMw = Number.isFinite(Number(scheduleByBlock?.get?.(block))) ? Number(scheduleByBlock.get(block)) : 0;
      const actualMw = meta.actualByBlock.get(block);
      const deviationMw = Number.isFinite(actualMw) ? (actualMw - scheduledMw) : null;
      const deviationPct =
        safeCapacity && Number.isFinite(deviationMw)
          ? (deviationMw / safeCapacity) * 100
          : null;
      const penalty = meta.penaltyByBlock.get(block) ?? '0';
      const time = meta.timeByBlock.get(block) || blockToInterval(block);
      const source = sourceByBlock?.get?.(block) || meta.sourceByBlock.get(block) || '';

      rows.push([
        block,
        time,
        Number.isFinite(scheduledMw) ? String(scheduledMw) : '',
        Number.isFinite(actualMw) ? String(actualMw) : '',
        Number.isFinite(deviationMw) ? String(deviationMw) : '',
        Number.isFinite(deviationPct) ? String(deviationPct) : '',
        penalty ?? '',
        source,
      ]);
    }

    return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  };

  async function listS3Objects(prefix) {
    const normalizedPrefix = String(prefix || '').trim();
    const cacheKey = getReadinessS3CacheKey([normalizedPrefix], 2000);
    const cached = getReadinessCacheValue(readinessS3ListCache, cacheKey, READINESS_S3_LIST_CACHE_TTL_MS);
    if (cached) return cached;
    try {
      const proxyResp = await fetch('/api/s3/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: [normalizedPrefix], limit: 2000 }),
      });
      if (!proxyResp.ok) throw new Error(`S3 proxy list failed: ${proxyResp.status}`);
      const payload = await proxyResp.json().catch(() => ({}));
      const items = Array.isArray(payload?.items) ? payload.items : [];
      const parsed = items
        .map((item) => ({
          key: String(item?.key || '').trim(),
          lastModified: String(item?.last_modified || item?.lastModified || '').trim(),
        }))
        .filter((item) => item.key);
      setReadinessCacheValue(readinessS3ListCache, cacheKey, parsed);
      return parsed;
    } catch {
      return [];
    }
  }

  const disabledPlantPattern = useMemo(() => getDisabledPlantPattern(currentUser), [currentUser]);

  async function listS3ObjectsAcrossPrefixes(prefixes) {
    const safePrefixes = (prefixes || []).filter(
      (prefix) => prefix && !disabledPlantPattern.test(prefix)
    );
    const uniquePrefixes = Array.from(new Set(safePrefixes.map((prefix) => String(prefix || '').trim()).filter(Boolean)));
    if (!uniquePrefixes.length) return [];
    const settled = [];
    const concurrency = 4;
    const batchSize = 25;
    const batches = [];
    for (let i = 0; i < uniquePrefixes.length; i += batchSize) {
      batches.push(uniquePrefixes.slice(i, i + batchSize));
    }
    const listBatch = async (batch) => {
      const cacheKey = getReadinessS3CacheKey(batch, 2000);
      const cached = getReadinessCacheValue(readinessS3ListCache, cacheKey, READINESS_S3_LIST_CACHE_TTL_MS);
      if (cached) return cached;
      try {
        const proxyResp = await fetch('/api/s3/list', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefixes: batch, limit: 2000 }),
        });
        if (!proxyResp.ok) throw new Error(`S3 proxy list failed: ${proxyResp.status}`);
        const payload = await proxyResp.json().catch(() => ({}));
        const parsed = (Array.isArray(payload?.items) ? payload.items : [])
          .map((item) => ({
            key: String(item?.key || '').trim(),
            lastModified: String(item?.last_modified || item?.lastModified || '').trim(),
          }))
          .filter((item) => item.key);
        setReadinessCacheValue(readinessS3ListCache, cacheKey, parsed);
        return parsed;
      } catch {
        return [];
      }
    };
    for (let i = 0; i < batches.length; i += concurrency) {
      const chunk = batches.slice(i, i + concurrency);
      const chunkSettled = await Promise.allSettled(chunk.map((batch) => listBatch(batch)));
      settled.push(...chunkSettled);
    }
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

  async function listGeneratedSchedules({ plantCode, scheduleDate, scheduleType }) {
    const code = String(plantCode || '').trim().toUpperCase();
    const date = String(scheduleDate || '').trim();
    const type = String(scheduleType || 'intraday').trim().toLowerCase();
    if (!code || !date) return [];
    const params = new URLSearchParams();
    params.set('plant', code);
    params.set('date', date);
    params.set('type', type);
    params.set('limit', '20000');

    const parseItems = (payload) => {
      const items = Array.isArray(payload?.items) ? payload.items : [];
      return items
        .map((item) => ({
          key: String(item?.key || '').trim(),
          lastModified: String(item?.last_modified || item?.lastModified || '').trim(),
        }))
        .filter((item) => item.key);
    };

    // Primary: dedicated backend endpoint (faster, filtered server-side).
    try {
      const resp = await fetch(`/api/schedules/list?${params.toString()}`);
      if (resp.ok) {
        const payload = await resp.json().catch(() => ({}));
        const parsed = parseItems(payload);
        if (parsed.length > 0) return parsed;
      }
    } catch {
      // fall back below
    }

    // Fallback: list directly via S3 proxy prefixes (covers plants not handled by `/api/schedules/list`).
    try {
      const prefixes = (() => {
        const normalizedDate = date;
        const basePrefixes = type === 'dayahead'
          ? getDayAheadPrefixes(normalizedDate)
          : getReportIntradayPrefixes(normalizedDate, code);
        return Array.from(new Set(basePrefixes));
      })();
      const objects = await listS3ObjectsAcrossPrefixes(prefixes);
      return objects.filter((o) => o?.key && String(o.key).toLowerCase().endsWith('.csv'));
    } catch {
      return [];
    }
  }

  function filterBasePrefixesForPlant(basePrefixes, plantCode) {
    const code = String(plantCode || '').trim().toLowerCase();
    if (!code) return [];
    const aliases = code === 'anjangaon' || code === 'anjangoan'
      ? ['anjangaon', 'anjangoan']
      : code === 'zetric'
      ? ['zetric', 'ztric']
      : [code];
    return (Array.isArray(basePrefixes) ? basePrefixes : [])
      .filter((prefix) => aliases.some((alias) => String(prefix || '').toLowerCase().includes(alias)))
      .filter(Boolean);
  }

  function getGeneratedPlantCodeAliases(plantCode) {
    const code = String(plantCode || '').trim().toUpperCase();
    if (code === 'ANJANGAON' || code === 'ANJANGOAN') return ['ANJANGAON', 'ANJANGOAN'];
    return code ? [code] : [];
  }

  function getReportIntradayPrefixes(date, plantCode) {
    if (!date || !plantCode) return [];
    if (String(plantCode || '').trim().toUpperCase() === 'ZETRIC') {
      return [`generated/vedanjay/multiple_generator/ZTRIC/${date}/`];
    }
    // Reports should be fast: only list machine-generated outputs for this plant/date.
    // (Scanning raw prefixes can include many extra files and slows down report creation.)
    const generated = filterBasePrefixesForPlant(GENERATED_OUTPUTS_BASE_PREFIXES, plantCode)
      .map((prefix) => `${prefix}${date}/`);
    // Fallback for plants not present in the static prefix list.
    const code = String(plantCode || '').trim().toUpperCase();
    const direct = getGeneratedPlantCodeAliases(code).map((alias) => `generated/vedanjay/${alias}/outputs/${date}/`);
    return Array.from(new Set([...generated, ...direct]));
  }

  function getReportDayAheadPrefixes(date, plantCode) {
    if (!date || !plantCode) return [];
    const normalizedDate = String(date || '').trim();
    if (String(plantCode || '').trim().toUpperCase() === 'ZETRIC') {
      return [
        `generated/vedanjay/multiple_generator/ZTRIC/${normalizedDate}/Day-ahead/`,
        `raw/vedanjay/multiple_generator/ZTRIC/${normalizedDate}/enercast_data/day_ahead/`,
      ];
    }
    const generated = filterBasePrefixesForPlant(GENERATED_OUTPUTS_BASE_PREFIXES, plantCode)
      .map((prefix) => `${prefix}${normalizedDate}/Day-ahead/`);
    // Fallback for plants not present in the static prefix list.
    const code = String(plantCode || '').trim().toUpperCase();
    const direct = getGeneratedPlantCodeAliases(code).map((alias) => `generated/vedanjay/${alias}/outputs/${normalizedDate}/Day-ahead/`);
    return Array.from(new Set([...generated, ...direct]));
  }

  function getDayAheadPrefixes(date) {
    if (!date) return [];
    const normalizedDate = String(date || '').trim();
    const prefixes = [
      ...GENERATED_OUTPUTS_BASE_PREFIXES.map((prefix) => `${prefix}${normalizedDate}/Day-ahead/`),
    ];
    prefixes.push(`generated/vedanjay/multiple_generator/ZTRIC/${normalizedDate}/Day-ahead/`);
    prefixes.push(`raw/vedanjay/multiple_generator/ZTRIC/${normalizedDate}/enercast_data/day_ahead/`);
    return Array.from(new Set(prefixes));
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
      `uploads/vedanjay/ANJANGAON/${date}/`,
      `uploads/vedanjay/ANJANGOAN/${date}/`,
      `uploads/vedanjay/SIRMOUR/${date}/`,
    ];
  }

  const getKeyBaseName = (value) => {
    const text = String(value || '').trim();
    if (!text) return '';
    const parts = text.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : text;
  };

  const isDayAheadLikeKey = (value) => {
    const text = String(value || '').toLowerCase();
    return (
      text.includes('/day-ahead/')
      || text.includes('/dayahead/')
      || text.includes('/day_ahead/')
      || text.includes('day-ahead')
      || text.includes('dayahead')
      || text.includes('day_ahead')
    );
  };

  const isManualEditedLikeKey = (value) => {
    const text = String(value || '').toLowerCase();
    return (
      text.includes('edited_schedule')
      || text.includes('manual-edits')
      || text.includes('manual_edit')
      || text.includes('/manual-')
    );
  };

  const formatReportDateTime = (value) => {
    const dt = toDateFromIso(value);
    if (!dt) {
      const raw = String(value || '').trim();
      return raw || '-';
    }
    return dt.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  };

  const countChangedBlocks = (aMap, bMap, epsilon = 0.001) => {
    let count = 0;
    for (let block = 1; block <= 96; block += 1) {
      const a = Number(aMap?.get?.(block) ?? 0);
      const b = Number(bMap?.get?.(block) ?? 0);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      if (Math.abs(a - b) > epsilon) count += 1;
    }
    return count;
  };

  const fetchScheduleChangeLogItems = async ({ plantCode, scheduleDate }) => {
    const safePlant = String(plantCode || '').trim().toUpperCase();
    const safeDate = String(scheduleDate || '').trim();
    if (!safePlant || !safeDate) return [];
    const cacheKey = `${safePlant}|${safeDate}`;
    const cached = reportManualChangeLogCacheRef.current.get(cacheKey);
    if (Array.isArray(cached) && cached.length > 0) return cached;

    // Prefer backend endpoint (already used by Dashboard).
    try {
      const resp = await api.schedules.getChangeLog({ plantCode: safePlant, scheduleDate: safeDate });
      const items = Array.isArray(resp?.items) ? resp.items : [];
      if (items.length > 0) reportManualChangeLogCacheRef.current.set(cacheKey, items);
      return items;
    } catch {
      // fall back to direct S3 read below
    }

    const changeKey = safePlant === 'ZETRIC'
      ? `generated/vedanjay/multiple_generator/ZTRIC/${safeDate}/schedule_changes.json`
      : `generated/vedanjay/${safePlant}/outputs/${safeDate}/schedule_changes.json`;
    const parsePayload = (payload) => {
      if (Array.isArray(payload)) return payload;
      if (Array.isArray(payload?.items)) return payload.items;
      return [];
    };

    try {
      const text = await fetchTextFromS3Optional(changeKey).catch(() => null);
      if (!text) return [];
      const payload = JSON.parse(text);
      const items = parsePayload(payload);
      if (items.length > 0) reportManualChangeLogCacheRef.current.set(cacheKey, items);
      return items;
    } catch {
      return [];
    }
  };

  const buildManualChangeIndexForPlantDate = (items) => {
    const byKey = new Map();
    const byBase = new Map();
    (Array.isArray(items) ? items : []).forEach((row) => {
      const source = String(row?.source_file_key || row?.sourceFileKey || '').trim();
      if (!source) return;
      const normalized = source.toLowerCase();
      byKey.set(normalized, (byKey.get(normalized) || 0) + 1);
      const base = normalized.split('/').pop() || normalized;
      byBase.set(base, (byBase.get(base) || 0) + 1);
    });
    return { byKey, byBase };
  };

  const getManualChangeCountForSourceKey = async ({ plantCode, scheduleDate, sourceFileKey }) => {
    const safePlant = String(plantCode || '').trim().toUpperCase();
    const safeDate = String(scheduleDate || '').trim();
    const safeKey = String(sourceFileKey || '').trim();
    if (!safePlant || !safeDate || !safeKey) return 0;

    const cacheKey = `${safePlant}|${safeDate}|${safeKey}`;
    const cached = reportManualChangeCountCacheRef.current.get(cacheKey);
    if (Number.isFinite(cached)) return cached;

    const plantDateKey = `${safePlant}|${safeDate}`;
    let index = reportManualChangeIndexCacheRef.current.get(plantDateKey) || null;
    if (!index) {
      const items = await fetchScheduleChangeLogItems({ plantCode: safePlant, scheduleDate: safeDate });
      if (!Array.isArray(items) || items.length === 0) {
        reportManualChangeCountCacheRef.current.set(cacheKey, 0);
        return 0;
      }
      index = buildManualChangeIndexForPlantDate(items);
      reportManualChangeIndexCacheRef.current.set(plantDateKey, index);
    }

    const normalizedSafeKey = safeKey.toLowerCase();
    const safeBaseName = normalizedSafeKey.split('/').pop() || normalizedSafeKey;
    const count = Math.max(
      Number(index.byKey.get(normalizedSafeKey) || 0),
      Number(index.byBase.get(safeBaseName) || 0)
    );
    reportManualChangeCountCacheRef.current.set(cacheKey, count);
    return count;
  };

  const buildRevisionRowsForReport = async ({ generatedObjects, uploadItems, plantCode, scheduleDate, isDayAhead, uploadOverridesByRev = null }) => {
    const matchesOperatingDate = (item, dateKey) => {
      const safeDate = String(dateKey || '').trim();
      if (!safeDate) return false;
      const scheduleDateField = String(item?.schedule_date || '').trim();
      if (scheduleDateField && scheduleDateField === safeDate) return true;
      const candidates = [
        String(item?.source_file_key || '').trim(),
        String(item?.output_file_key || '').trim(),
        String(item?.template_file_name || '').trim(),
      ].filter(Boolean);
      return candidates.some((c) => extractDateFromKey(c) === safeDate);
    };

    const generatedByRev = new Map();
    (Array.isArray(generatedObjects) ? generatedObjects : []).forEach((obj) => {
      const key = String(obj?.key || '').trim();
      if (!key) return;
      const rev = extractScheduleRevisionToken(key);
      if (!Number.isFinite(rev)) return;
      const existing = generatedByRev.get(rev);
      const nextTs = Date.parse(String(obj?.lastModified || obj?.last_modified || ''));
      const prevTs = Date.parse(String(existing?.lastModified || existing?.last_modified || ''));
      if (!existing || (Number.isFinite(nextTs) && (!Number.isFinite(prevTs) || nextTs > prevTs))) {
        generatedByRev.set(rev, obj);
      }
    });

    const uploadsByRev = new Map();
    (Array.isArray(uploadItems) ? uploadItems : [])
      // schedule_date may reflect the upload day; also derive the operating date from keys/names
      .filter((item) => matchesOperatingDate(item, scheduleDate))
      .forEach((item) => {
      const rev =
        extractScheduleRevisionToken(item?.source_file_key)
        || extractScheduleRevisionToken(item?.template_file_name)
        || extractScheduleRevisionToken(item?.output_file_key);
      if (!Number.isFinite(rev)) return;
      const existing = uploadsByRev.get(rev);
      const nextUploadedAt = String(item?.uploaded_at || '').trim();
      const prevUploadedAt = String(existing?.uploaded_at || '').trim();
      if (!existing || nextUploadedAt.localeCompare(prevUploadedAt) > 0) {
        uploadsByRev.set(rev, item);
      }
    });

    // IMPORTANT: For report clarity, drive the table by machine-generated revisions for the selected date.
    // Upload-history can include older/extra revisions; those should not create phantom rows in the report.
    const revs = (
      generatedByRev.size > 0
        ? Array.from(generatedByRev.keys())
        : Array.from(uploadsByRev.keys())
    )
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);

    const pickBestUploadRecord = (primaryRow, fallbackRow) => {
      const score = (row) => {
        if (!row) return 0;
        let s = 0;
        if (String(row?.requested_by || row?.requestedBy || '').trim()) s += 4;
        if (String(row?.uploaded_by || row?.uploadedBy || '').trim()) s += 4;
        if (String(row?.source_file_key || '').trim()) s += 2;
        if (String(row?.output_file_key || '').trim()) s += 2;
        if (String(row?.template_file_name || '').trim()) s += 1;
        if (String(row?.uploaded_at || '').trim()) s += 1;
        return s;
      };

      const a = primaryRow || null;
      const b = fallbackRow || null;
      const aScore = score(a);
      const bScore = score(b);
      if (bScore > aScore) return b;
      if (aScore > bScore) return a;
      const aTs = Date.parse(String(a?.uploaded_at || ''));
      const bTs = Date.parse(String(b?.uploaded_at || ''));
      if (!Number.isNaN(aTs) && !Number.isNaN(bTs) && bTs !== aTs) return bTs > aTs ? b : a;
      return a || b || null;
    };

    const intradayRunByGeneratedKey = isDayAhead
      ? new Map()
      : computeIntradayRunIndexByKey(
          revs.map((rev) => {
            const generatedObj = generatedByRev.get(rev) || null;
            const key = String(generatedObj?.key || '').trim();
            return { key };
          })
        );

    const detailRows = await Promise.all(revs.map(async (rev) => {
      const generatedObj = generatedByRev.get(rev) || null;
      const generatedKey = String(generatedObj?.key || '').trim();
      const uploadOverrideRow = uploadOverridesByRev instanceof Map ? (uploadOverridesByRev.get(rev) || null) : null;
      const upload = pickBestUploadRecord(uploadOverrideRow, uploadsByRev.get(rev) || null);
      const uploaded = Boolean(upload);
      const uploadKey = String(upload?.output_file_key || upload?.template_s3_key || upload?.template_file_name || '').trim();
      const templateName = getKeyBaseName(uploadKey) || String(upload?.template_file_name || '').trim() || '-';
      const inferredUploadedType = uploaded ? inferTriggerReasonFromRow(upload) : '';
      const normalizeRequester = (value) => {
        const text = String(value || '').trim();
        if (!text) return '';
        const upper = text.toUpperCase();
        if (upper === '-' || upper === 'N/A' || upper === 'NA' || upper === 'UNKNOWN') return '';
        return text;
      };

      const directUploadedBy = normalizeRequester(upload?.uploaded_by || upload?.uploadedBy || '');
      const requestedByRaw = normalizeRequester(upload?.requested_by || upload?.requestedBy || '');
      const sourceFileKeyForUser = String(upload?.source_file_key || generatedKey || '').trim();
      void sourceFileKeyForUser;
      const toDisplayName = (value) => {
        const raw = String(value || '').trim();
        if (!raw) return '';
        const mapped = String(getEmployeeName(raw) || '').trim();
        return mapped || raw;
      };
      const uploadedByDisplay = directUploadedBy
        ? toDisplayName(directUploadedBy)
        : requestedByRaw
          ? toDisplayName(requestedByRaw)
          : '-';
      const uploadedScheduleType = uploaded
        ? (
            inferredUploadedType === 'MANUAL_EDIT'
              ? 'Manual Edited'
              : (isManualEditedLikeKey(upload?.source_file_key) || isManualEditedLikeKey(uploadKey) ? 'Manual Edited' : 'System')
          )
        : '-';

      // Match Dashboard "Manual Changes": count change-log entries for this schedule file even if it wasn't uploaded.
      const manualChangesCount = await (async () => {
        const sourceKey = String(generatedKey || '').trim()
          || String(upload?.source_file_key || '').trim()
          || (() => {
            // Fallback derive from revision when source key is missing.
            const suffix = isDayAhead ? `outputs/${scheduleDate}/Day-ahead/schedule_from_${rev}.csv` : `outputs/${scheduleDate}/schedule_from_${rev}.csv`;
            return plantCode ? `generated/vedanjay/${String(plantCode).toUpperCase()}/${suffix}` : '';
          })();
        if (!sourceKey) return 0;
        const detectedDate = extractDateFromKey(sourceKey) || String(upload?.schedule_date || '').trim() || scheduleDate;
        return getManualChangeCountForSourceKey({ plantCode, scheduleDate: detectedDate, sourceFileKey: sourceKey });
      })();

      return {
        revision: rev,
        generatedCsvName: (() => {
          const effectiveKey = generatedKey || String(upload?.source_file_key || '').trim();
          const baseName = effectiveKey ? (getKeyBaseName(effectiveKey) || '') : '';
          if (!baseName) return '-';
          const detectedDate = extractScheduleDateFromKey(effectiveKey) || String(upload?.schedule_date || '').trim() || scheduleDate;
          const displayName = formatMachineScheduleDisplayName({
            baseName,
            key: effectiveKey,
            plantCodeOrName: plantCode,
            scheduleDate: detectedDate,
            isDayAhead,
            intradayRunIndex: intradayRunByGeneratedKey.get(generatedKey),
          });
          return displayName || baseName;
        })(),
        // Match Dashboard "TIME" for schedule_from_<rev>.csv (block-based time, not S3 lastModified).
        generatedTime: blockToTime(rev, 8) || '-',
        uploaded: uploaded ? 'Yes' : 'No',
        uploadedTemplateName: uploaded ? (templateName || '-') : '-',
        uploadedScheduleType,
        manualChangesCount,
        uploadedTime: uploaded ? formatReportDateTime(upload?.uploaded_at) : '-',
        uploadedBy: uploaded ? uploadedByDisplay : '-',
      };
    }));

    const generatedCount = generatedByRev.size;
    const uploadedDistinctCount = revs.filter((rev) => {
      const override = uploadOverridesByRev instanceof Map ? uploadOverridesByRev.get(rev) : null;
      return Boolean(override) || uploadsByRev.has(rev);
    }).length;
    const notUploadedCount = Math.max(0, generatedCount - uploadedDistinctCount);
    const manualEditedCount = detailRows.filter((r) => r.uploaded === 'Yes' && r.uploadedScheduleType === 'Manual Edited').length;

    return {
      summary: {
        generatedCount,
        uploadedDistinctCount,
        notUploadedCount,
        manualEditedCount,
      },
      detailRows,
    };
  };

  const renderReportSection = ({ doc, title, section, sectionDate, reportDate, plantName, marginX, cursorY }) => {
    let nextY = cursorY;
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(17, 24, 39);
    doc.setFontSize(14);
    doc.text(title, marginX, nextY);
    nextY += 10;

    autoTable(doc, {
      startY: nextY,
      head: [[
        'Plant',
        'Date',
        'Machine Generated',
        'Uploaded to SLDC',
        'Not Uploaded / History',
        'Manual Edited Uploads',
      ]],
      body: [[
        String(plantName || '').trim(),
        String(sectionDate || reportDate),
        String(section?.summary?.generatedCount ?? 0),
        String(section?.summary?.uploadedDistinctCount ?? 0),
        String(section?.summary?.notUploadedCount ?? 0),
        String(section?.summary?.manualEditedCount ?? 0),
      ]],
      theme: 'grid',
      styles: { fontSize: 9, cellPadding: 4, textColor: [31, 41, 55] },
      headStyles: { fillColor: [15, 23, 42], textColor: 255, fontStyle: 'bold' },
      bodyStyles: { fillColor: [248, 250, 252] },
      margin: { left: marginX, right: marginX },
    });
    nextY = (doc.lastAutoTable?.finalY || nextY) + 14;

    const detailRows = Array.isArray(section?.detailRows) && section.detailRows.length
      ? section.detailRows
      : [{
          revision: '-',
          generatedCsvName: 'No records found',
          generatedTime: '-',
          uploaded: '-',
          uploadedScheduleType: '-',
          manualChangesCount: 0,
          uploadedTime: '-',
          uploadedBy: '-',
        }];

    autoTable(doc, {
      startY: nextY,
      head: [[
        'Revision',
        'Generated CSV',
        'Generated Time',
        'Uploaded?',
        'Uploaded Schedule',
        'Manual Changes',
        'Uploaded Time',
        'Uploaded By',
      ]],
      body: detailRows.map((r) => ([
        String(r.revision),
        r.generatedCsvName,
        r.generatedTime,
        r.uploaded,
        r.uploadedScheduleType,
        String(r.manualChangesCount ?? 0),
        r.uploadedTime,
        r.uploadedBy,
      ])),
      theme: 'grid',
      styles: { fontSize: 8, cellPadding: 3, textColor: [31, 41, 55] },
      headStyles: { fillColor: [30, 58, 138], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [241, 245, 249] },
      margin: { left: marginX, right: marginX },
      columnStyles: {
        0: { cellWidth: 55 },
        2: { cellWidth: 80 },
        3: { cellWidth: 60 },
        4: { cellWidth: 90 },
        5: { cellWidth: 80 },
        6: { cellWidth: 140 },
        7: { cellWidth: 120 },
      },
    });
    return (doc.lastAutoTable?.finalY || nextY) + 22;
  };

  const getReportLogoDataUrl = async () => {
    if (typeof reportLogoDataUrlRef.current === 'string') return reportLogoDataUrlRef.current;
    try {
      const resp = await fetch('/vedanjay logo.png', { cache: 'force-cache' });
      if (!resp.ok) {
        reportLogoDataUrlRef.current = '';
        return '';
      }
      const blob = await resp.blob();
      const dataUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(String(reader.result || ''));
        reader.onerror = () => resolve('');
        reader.readAsDataURL(blob);
      });
      reportLogoDataUrlRef.current = dataUrl || '';
      return reportLogoDataUrlRef.current;
    } catch {
      reportLogoDataUrlRef.current = '';
      return '';
    }
  };

  const renderPdfHeader = ({
    doc,
    title,
    subtitle,
    reportDate,
    generatedAtLabel,
    marginX = 40,
    pageWidth,
    logoDataUrl,
  }) => {
    let cursorY = 44;
    const logoSize = 38;
    if (logoDataUrl) {
      try {
        doc.addImage(logoDataUrl, 'PNG', marginX, cursorY - 18, logoSize, logoSize);
      } catch {
        // Ignore logo rendering errors and continue with text-only header.
      }
    }

    const textStartX = marginX + (logoDataUrl ? logoSize + 10 : 0);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(15, 23, 42);
    doc.text('Vedanjay Power Control Dashboard', textStartX, cursorY - 2);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(75, 85, 99);
    doc.text('Energy Operations Center', textStartX, cursorY + 12);

    doc.setDrawColor(209, 213, 219);
    doc.line(marginX, cursorY + 24, pageWidth - marginX, cursorY + 24);

    cursorY += 46;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.setTextColor(17, 24, 39);
    doc.text(title, marginX, cursorY);

    if (subtitle) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(11);
      doc.setTextColor(71, 85, 105);
      cursorY += 15;
      doc.text(subtitle, marginX, cursorY);
    }

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10.5);
    doc.setTextColor(51, 65, 85);
    cursorY += 18;
    doc.text(`Date: ${reportDate}`, marginX, cursorY);
    cursorY += 14;
    doc.text(`Generated: ${generatedAtLabel}`, marginX, cursorY);

    doc.setDrawColor(203, 213, 225);
    cursorY += 12;
    doc.line(marginX, cursorY, pageWidth - marginX, cursorY);
    return cursorY + 14;
  };

  const renderKpiStrip = ({ doc, startY, marginX, pageWidth, items = [] }) => {
    const body = [
      (Array.isArray(items) ? items : []).map((item) => String(item?.label || '').trim()),
      (Array.isArray(items) ? items : []).map((item) => String(item?.value ?? '').trim()),
    ];
    autoTable(doc, {
      startY,
      body,
      theme: 'grid',
      styles: { fontSize: 9, cellPadding: 5, halign: 'center', valign: 'middle' },
      rowStyles: {
        0: { fillColor: [15, 23, 42], textColor: 255, fontStyle: 'bold' },
        1: { fillColor: [240, 253, 244], textColor: [20, 83, 45], fontStyle: 'bold' },
      },
      margin: { left: marginX, right: marginX },
      tableWidth: pageWidth - (marginX * 2),
    });
    return (doc.lastAutoTable?.finalY || startY) + 12;
  };

  const applyPdfFooter = ({ doc, reportDate }) => {
    const pageCount = doc.getNumberOfPages();
    const generatedShort = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    for (let page = 1; page <= pageCount; page += 1) {
      doc.setPage(page);
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      doc.setDrawColor(226, 232, 240);
      doc.line(40, pageHeight - 28, pageWidth - 40, pageHeight - 28);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(71, 85, 105);
      doc.text(`Vedanjay Power Control Dashboard | Confidential | Date ${reportDate}`, 40, pageHeight - 14);
      doc.text(`Generated ${generatedShort}`, pageWidth / 2, pageHeight - 14, { align: 'center' });
      doc.text(`Page ${page} of ${pageCount}`, pageWidth - 40, pageHeight - 14, { align: 'right' });
    }
  };

  const buildPlantReportSections = async ({ plantName, reportDate }) => {
    const safePlantName = String(plantName || '').trim();
    const plantCode = deriveCodeFromPlantName(safePlantName);
    if (!plantCode) {
      throw new Error(`Unable to determine plant code for "${safePlantName || 'Unknown'}".`);
    }

    const safeDate = String(reportDate || '').trim();
    const dayAheadOperatingDate = addDaysToDateKey(safeDate, 1);
    const prevDate = addDaysToDateKey(safeDate, -1);
    const uploadHistoryRequests = [
      scheduleReadinessApi.getUploadHistory({ scheduleDate: safeDate, plantCode, limit: 2000 }),
      ...(prevDate ? [scheduleReadinessApi.getUploadHistory({ scheduleDate: prevDate, plantCode, limit: 2000 })] : []),
      ...(dayAheadOperatingDate ? [scheduleReadinessApi.getUploadHistory({ scheduleDate: dayAheadOperatingDate, plantCode, limit: 2000 })] : []),
    ];

    const [intradayScheduleObjects, dayAheadScheduleObjects, ...uploadHistoryResponses] = await Promise.all([
      listGeneratedSchedules({ plantCode, scheduleDate: safeDate, scheduleType: 'intraday' }),
      listGeneratedSchedules({ plantCode, scheduleDate: dayAheadOperatingDate, scheduleType: 'dayahead' }),
      ...uploadHistoryRequests,
    ]);

    const intradayScheduleObjectsSafe = (Array.isArray(intradayScheduleObjects) ? intradayScheduleObjects : [])
      .filter((o) => o?.key && isScheduleCsvKey(o.key));

    const dayAheadScheduleObjectsSafe = (Array.isArray(dayAheadScheduleObjects) ? dayAheadScheduleObjects : [])
      .filter((o) => o?.key && isDayAheadScheduleCsvKey(o.key));

    const uploadItems = uploadHistoryResponses
      .flatMap((r) => (Array.isArray(r?.items) ? r.items : []));
    const uploadsForPlant = uploadItems
      .filter((item) => String(item?.plant_code || '').trim().toUpperCase() === String(plantCode).toUpperCase())
      .filter((item) => {
        const d = String(item?.schedule_date || '').trim();
        return (
          d === safeDate ||
          (prevDate && d === prevDate) ||
          (dayAheadOperatingDate && d === dayAheadOperatingDate)
        );
      });

    const intradayUploads = uploadsForPlant.filter((item) => {
      const key = String(item?.source_file_key || item?.output_file_key || item?.template_file_name || '').trim();
      return !isDayAheadLikeKey(key);
    });
    const dayAheadUploads = uploadsForPlant.filter((item) => {
      const key = String(item?.source_file_key || item?.output_file_key || item?.template_file_name || '').trim();
      return isDayAheadLikeKey(key);
    });

    const intradayUploadOverridesByRev = new Map();
    (Array.isArray(baseFilteredRows) ? baseFilteredRows : []).forEach((row) => {
      const isUploaded = String(row?.status || '').trim().toUpperCase() === 'UPLOADED';
      if (!isUploaded) return;
      if (Boolean(row?.is_day_ahead)) return;
      const rowCode = String(row?.plant_code || '').trim().toUpperCase();
      if (rowCode && rowCode !== String(plantCode).toUpperCase()) return;
      const rev = Number.isFinite(row?.schedule_revision)
        ? row.schedule_revision
        : extractScheduleRevisionToken(row?.file_key)
          || extractScheduleRevisionToken(row?.file_name)
          || extractScheduleRevisionToken(row?.template_file_name);
      if (!Number.isFinite(rev)) return;
      const prev = intradayUploadOverridesByRev.get(rev) || null;
      const nextUploadedAt = String(row?.uploaded_at || '').trim();
      const prevUploadedAt = String(prev?.uploaded_at || '').trim();
      if (!prev || nextUploadedAt.localeCompare(prevUploadedAt) > 0) {
        intradayUploadOverridesByRev.set(rev, row);
      }
    });

    const [intradaySection, dayAheadSection] = await Promise.all([
      buildRevisionRowsForReport({ generatedObjects: intradayScheduleObjectsSafe, uploadItems: intradayUploads, plantCode, scheduleDate: safeDate, isDayAhead: false, uploadOverridesByRev: intradayUploadOverridesByRev }),
      buildRevisionRowsForReport({ generatedObjects: dayAheadScheduleObjectsSafe, uploadItems: dayAheadUploads, plantCode, scheduleDate: dayAheadOperatingDate, isDayAhead: true }),
    ]);

    return {
      plantName: safePlantName,
      plantCode,
      reportDate: safeDate,
      dayAheadOperatingDate,
      intradaySection,
      dayAheadSection,
    };
  };

  const onDownloadAdminReport = async () => {
    if (!isAdmin) return;
    if (uploadedPlantFilter === 'All') {
      toast.error('Please select a single site (not "All Sites") to download the report.');
      return;
    }
    const reportDate = String(selectedDate || '').trim();
    if (!reportDate) {
      toast.error('Please select a date.');
      return;
    }

    const plantName = String(uploadedPlantFilter || '').trim();
    setIsDownloadingReport(true);
    const toastId = toast.loading('Preparing site-wise PDF report...');
    try {
      const report = await buildPlantReportSections({ plantName, reportDate });
      const logoDataUrl = await getReportLogoDataUrl();
      const generatedAtLabel = formatReportDateTime(new Date().toISOString());
      const filename = `${String(report.plantCode).toUpperCase()}_${reportDate}_Report.pdf`;
      const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const marginX = 40;
      let cursorY = renderPdfHeader({
        doc,
        title: `${String(report.plantName).trim()} Site Report`,
        subtitle: `Plant Code: ${String(report.plantCode).toUpperCase()}`,
        reportDate,
        generatedAtLabel,
        marginX,
        pageWidth,
        logoDataUrl,
      });
      cursorY = renderKpiStrip({
        doc,
        startY: cursorY,
        marginX,
        pageWidth,
        items: [
          { label: 'Intraday Generated', value: String(report?.intradaySection?.summary?.generatedCount ?? 0) },
          { label: 'Intraday Uploaded', value: String(report?.intradaySection?.summary?.uploadedDistinctCount ?? 0) },
          { label: 'Day-ahead Generated', value: String(report?.dayAheadSection?.summary?.generatedCount ?? 0) },
          { label: 'Day-ahead Uploaded', value: String(report?.dayAheadSection?.summary?.uploadedDistinctCount ?? 0) },
          { label: 'Manual Edited', value: String((report?.intradaySection?.summary?.manualEditedCount ?? 0) + (report?.dayAheadSection?.summary?.manualEditedCount ?? 0)) },
        ],
      });

      cursorY = renderReportSection({
        doc,
        title: 'Intraday',
        section: report.intradaySection,
        sectionDate: reportDate,
        reportDate,
        plantName: report.plantName,
        marginX,
        cursorY,
      });
      if (cursorY > pageHeight - 260) {
        doc.addPage();
        cursorY = renderPdfHeader({
          doc,
          title: `${String(report.plantName).trim()} Site Report`,
          subtitle: `Plant Code: ${String(report.plantCode).toUpperCase()}`,
          reportDate,
          generatedAtLabel,
          marginX,
          pageWidth,
          logoDataUrl,
        });
      }
      renderReportSection({
        doc,
        title: 'Day-ahead',
        section: report.dayAheadSection,
        sectionDate: report.dayAheadOperatingDate,
        reportDate,
        plantName: report.plantName,
        marginX,
        cursorY,
      });

      applyPdfFooter({ doc, reportDate });
      doc.save(filename);
      toast.success('Site-wise report downloaded.', { id: toastId });
    } catch (error) {
      toast.error(`Failed to download site-wise report: ${error?.message || 'Unknown error'}`, { id: toastId });
    } finally {
      setIsDownloadingReport(false);
    }
  };

  const onRecomputeFrozenForSelectedPlant = async () => {
    if (!isAdmin) return;
    if (uploadedPlantFilter === 'All') {
      toast.error('Please select a single site (not "All Sites") to recompute frozen.');
      return;
    }
    const reportDate = String(selectedDate || '').trim();
    if (!reportDate) {
      toast.error('Please select a date.');
      return;
    }

    const plantCode = deriveCodeFromPlantName(uploadedPlantFilter);
    if (!plantCode) {
      toast.error('Unable to determine plant code for recompute.');
      return;
    }

    const toastId = toast.loading(`Recomputing edited frozen for ${plantCode} ${reportDate}...`);
    try {
      await recomputeFrozenForPlantDate(plantCode, reportDate);
      toast.success('Recomputed edited frozen successfully.', { id: toastId });
      setAutoRefreshTick((v) => v + 1);
    } catch (error) {
      toast.error(`Recompute failed: ${error?.message || 'Unknown error'}`, { id: toastId });
    }
  };

  const onRecomputeSystemFrozenForSelectedPlant = async () => {
    if (!isAdmin) return;
    if (uploadedPlantFilter === 'All') {
      toast.error('Please select a single site (not "All Sites") to recompute system frozen.');
      return;
    }
    const reportDate = String(selectedDate || '').trim();
    if (!reportDate) {
      toast.error('Please select a date.');
      return;
    }

    const plantCode = deriveCodeFromPlantName(uploadedPlantFilter);
    if (!plantCode) {
      toast.error('Unable to determine plant code for recompute.');
      return;
    }

    const toastId = toast.loading(`Recomputing system frozen for ${plantCode} ${reportDate}...`);
    try {
      await recomputeSystemFrozenForPlantDate(plantCode, reportDate);
      toast.success('Recomputed system frozen successfully.', { id: toastId });
      setAutoRefreshTick((v) => v + 1);
    } catch (error) {
      toast.error(`Recompute failed: ${error?.message || 'Unknown error'}`, { id: toastId });
    }
  };

  const onDownloadAdminDateWiseAllSitesReport = async () => {
    if (!isAdmin) return;
    const reportDate = String(selectedDate || '').trim();
    if (!reportDate) {
      toast.error('Please select a date.');
      return;
    }

    const siteNames = uploadedPlantOptions
      .filter((name) => String(name || '').trim() !== 'All')
      .map((name) => String(name || '').trim())
      .filter(Boolean);

    if (siteNames.length === 0) {
      toast.error('No site data is available for the selected date.');
      return;
    }

    setIsDownloadingReport(true);
    const toastId = toast.loading('Preparing date-wise all-sites PDF report...');
    try {
      const settled = await Promise.allSettled(
        siteNames.map((plantName) => buildPlantReportSections({ plantName, reportDate }))
      );
      const successful = settled
        .filter((item) => item.status === 'fulfilled')
        .map((item) => item.value);
      const failedCount = settled.length - successful.length;
      const logoDataUrl = await getReportLogoDataUrl();
      const generatedAtLabel = formatReportDateTime(new Date().toISOString());

      if (successful.length === 0) {
        throw new Error('No site report data could be prepared.');
      }

      const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const marginX = 40;

      let cursorY = renderPdfHeader({
        doc,
        title: 'Date-wise All Sites Report',
        subtitle: 'Consolidated report for all operational sites',
        reportDate,
        generatedAtLabel,
        marginX,
        pageWidth,
        logoDataUrl,
      });

      autoTable(doc, {
        startY: cursorY,
        head: [[
          'Site',
          'Intraday Generated',
          'Intraday Uploaded',
          'Day-ahead Generated',
          'Day-ahead Uploaded',
          'Manual Edited Uploads',
        ]],
        body: successful.map((report) => ([
          String(report.plantName || '').trim(),
          String(report?.intradaySection?.summary?.generatedCount ?? 0),
          String(report?.intradaySection?.summary?.uploadedDistinctCount ?? 0),
          String(report?.dayAheadSection?.summary?.generatedCount ?? 0),
          String(report?.dayAheadSection?.summary?.uploadedDistinctCount ?? 0),
          String((report?.intradaySection?.summary?.manualEditedCount ?? 0) + (report?.dayAheadSection?.summary?.manualEditedCount ?? 0)),
        ])),
        theme: 'grid',
        styles: { fontSize: 9, cellPadding: 4, textColor: [31, 41, 55] },
        headStyles: { fillColor: [15, 23, 42], textColor: 255, fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [241, 245, 249] },
        margin: { left: marginX, right: marginX },
      });
      cursorY = (doc.lastAutoTable?.finalY || cursorY) + 12;
      cursorY = renderKpiStrip({
        doc,
        startY: cursorY,
        marginX,
        pageWidth,
        items: [
          { label: 'Total Sites', value: String(successful.length) },
          {
            label: 'Total Uploaded',
            value: String(successful.reduce((sum, r) => sum + Number(r?.intradaySection?.summary?.uploadedDistinctCount || 0) + Number(r?.dayAheadSection?.summary?.uploadedDistinctCount || 0), 0)),
          },
          {
            label: 'Total Not Uploaded',
            value: String(successful.reduce((sum, r) => sum + Number(r?.intradaySection?.summary?.notUploadedCount || 0) + Number(r?.dayAheadSection?.summary?.notUploadedCount || 0), 0)),
          },
          {
            label: 'Total Manual Edited',
            value: String(successful.reduce((sum, r) => sum + Number(r?.intradaySection?.summary?.manualEditedCount || 0) + Number(r?.dayAheadSection?.summary?.manualEditedCount || 0), 0)),
          },
        ],
      });

      successful.forEach((report) => {
        doc.addPage();
        let siteCursorY = renderPdfHeader({
          doc,
          title: `${report.plantName} - Detailed View`,
          subtitle: `Plant Code: ${String(report.plantCode).toUpperCase()}`,
          reportDate,
          generatedAtLabel,
          marginX,
          pageWidth,
          logoDataUrl,
        });

        siteCursorY = renderReportSection({
          doc,
          title: 'Intraday',
          section: report.intradaySection,
          sectionDate: reportDate,
          reportDate,
          plantName: report.plantName,
          marginX,
          cursorY: siteCursorY,
        });
        if (siteCursorY > pageHeight - 260) {
          doc.addPage();
          siteCursorY = renderPdfHeader({
            doc,
            title: `${report.plantName} - Detailed View`,
            subtitle: `Plant Code: ${String(report.plantCode).toUpperCase()}`,
            reportDate,
            generatedAtLabel,
            marginX,
            pageWidth,
            logoDataUrl,
          });
        }
        renderReportSection({
          doc,
          title: 'Day-ahead',
          section: report.dayAheadSection,
          sectionDate: report.dayAheadOperatingDate,
          reportDate,
          plantName: report.plantName,
          marginX,
          cursorY: siteCursorY,
        });
      });

      const fileName = `All_Sites_${reportDate}_Report.pdf`;
      applyPdfFooter({ doc, reportDate });
      doc.save(fileName);
      if (failedCount > 0) {
        toast.warning(`Date-wise report downloaded. ${failedCount} site(s) were skipped due to missing data.`, { id: toastId });
      } else {
        toast.success('Date-wise all-sites report downloaded.', { id: toastId });
      }
    } catch (error) {
      toast.error(`Failed to download date-wise all-sites report: ${error?.message || 'Unknown error'}`, { id: toastId });
    } finally {
      setIsDownloadingReport(false);
    }
  };

  function getPlantFromKey(key) {
    const normalized = String(key || '').toLowerCase();
    const multiGeneratorMatch = normalized.match(/\/vedanjay\/multiple_generator\/([^/]+)\//);
    if (multiGeneratorMatch?.[1]) {
      let code = multiGeneratorMatch[1].toUpperCase();
      if (code === 'ZTRIC') code = 'ZETRIC';
      return S3_PLANTS.find((plant) => plant.code === code) || S3_PLANTS[0];
    }
    const vedanjayMatch = normalized.match(/\/vedanjay\/([^/]+)\//);
    if (vedanjayMatch?.[1]) {
      let code = vedanjayMatch[1].toUpperCase();
      if (code === 'SHRIMOUR' || code === 'SHROMOUR') code = 'SIRMOUR';
      if (code === 'ANJANGOAN') code = 'ANJANGAON';
      return S3_PLANTS.find((plant) => plant.code === code) || S3_PLANTS[0];
    }
    const rawVedanjayMatch = normalized.match(/raw\/vedanjay\/([^/]+)\//);
    if (rawVedanjayMatch?.[1]) {
      let code = rawVedanjayMatch[1].toUpperCase();
      if (code === 'SHRIMOUR' || code === 'SHROMOUR') code = 'SIRMOUR';
      if (code === 'ANJANGOAN') code = 'ANJANGAON';
      return S3_PLANTS.find((plant) => plant.code === code) || S3_PLANTS[0];
    }
    if (normalized.includes('/sirmour/sirmour/')) {
      return S3_PLANTS.find((plant) => plant.code === 'SIRMOUR');
    }
    if (normalized.includes('/shrimour/shrimour/') || normalized.includes('/shromour/shromour/')) {
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
      !k.includes('/day-ahead/') &&
      !k.includes('/enercast_data/day_ahead/') &&
      isAnyScheduleCsvKey(k) &&
      !isFrozenScheduleCsvKey(k)
    );
  }

  function isOutputsScheduleKey(key) {
    const k = String(key || '').toLowerCase();
    return k.startsWith('outputs/')
      || k.includes('/outputs/')
      || k.includes('/generated/vedanjay/multiple_generator/ztric/')
      || k.startsWith('generated/vedanjay/multiple_generator/ztric/');
  }

  function isDayAheadScheduleCsvKey(key) {
    const k = String(key || '').toLowerCase();
    if (!k.endsWith('.csv')) return false;
    if (k.includes('/generated/vedanjay/multiple_generator/ztric/')) {
      return /schedule_from_\d+.*\.csv$/i.test(k);
    }
    if (!k.includes('/day-ahead/')) return false;
    if (k.includes('/enercast_data/day_ahead/')) return false;
    return /schedule_from_\d+.*\.csv$/i.test(k);
  }

  function pickNthLatestByTimestamp(items, indexToPick = 0) {
    const list = Array.isArray(items) ? items : [];
    const sorted = [...list].sort((a, b) => {
      const aTime = Date.parse(a?.lastModified || '');
      const bTime = Date.parse(b?.lastModified || '');
      const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
      if (timeDiff !== 0) return timeDiff;
      return String(b?.key || '').localeCompare(String(a?.key || ''));
    });
    if (!sorted.length) return null;
    const safeIndex = Math.max(0, Math.min(sorted.length - 1, Number(indexToPick) || 0));
    return sorted[safeIndex] || null;
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
    const schedMatch = fileName.match(/schedule_(?:free(?:z|ze)_)?from_(\d+)(?:[_-][a-z0-9]+)*\.csv$/i);
    if (schedMatch) return parseInt(schedMatch[1], 10);
    const trailingMatch = fileName.match(/_(\d+)(?=\.[^.]+$)/);
    return trailingMatch ? parseInt(trailingMatch[1], 10) : null;
  }

  function extractScheduleRevisionToken(value) {
    const text = String(value || '');
    const match = text.match(/schedule_(?:free(?:z|ze)_)?from_(\d+)/i);
    if (!match) return null;
    const revision = Number.parseInt(match[1], 10);
    return Number.isFinite(revision) ? revision : null;
  }

  function getPlantCodeFromKey(key) {
    const normalized = String(key || '').toLowerCase();
    const multiGeneratorMatch = normalized.match(/\/vedanjay\/multiple_generator\/([^/]+)\//);
    if (multiGeneratorMatch?.[1]) {
      const code = multiGeneratorMatch[1].toUpperCase();
      return code === 'ZTRIC' ? 'ZETRIC' : code;
    }
    const vedanjayMatch = normalized.match(/\/vedanjay\/([^/]+)\//);
    if (vedanjayMatch?.[1]) {
      const code = vedanjayMatch[1].toUpperCase();
      if (code === 'SHRIMOUR' || code === 'SHROMOUR') return 'SIRMOUR';
      if (code === 'ANJANGOAN') return 'ANJANGAON';
      return code;
    }
    if (
      normalized.includes('/sirmour/')
      || normalized.includes('/shrimour/')
      || normalized.includes('/shromour/')
    ) return 'SIRMOUR';
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

  function inferTriggerReasonFromRow(row) {
    const scheduleDate = String(
      row?.schedule_date
      || extractDateFromKey(row?.source_file_key)
      || extractDateFromKey(row?.file_key)
      || extractDateFromKey(row?.template_s3_key)
      || ''
    ).trim();
    const todayKey = getLocalDateKey();
    if (scheduleDate && todayKey && scheduleDate > todayKey) {
      return 'DAY_AHEAD';
    }

    const haystack = [
      row?.schedule_reason_token,
      row?.source_file_key,
      row?.file_key,
      row?.file_name,
      row?.template_file_name,
      row?.template_s3_key,
    ]
      .map((v) => String(v || '').trim().toLowerCase())
      .filter(Boolean)
      .join(' ');

    if (
      haystack.includes('edited_schedule') ||
      haystack.includes('manual-edits') ||
      haystack.includes('manual_edit') ||
      haystack.includes('/manual-') ||
      haystack.includes('manual-')
    ) {
      return 'MANUAL_EDIT';
    }

    if (row?.is_day_ahead || haystack.includes('day-ahead') || haystack.includes('dayahead') || haystack.includes('day_ahead')) {
      return 'DAY_AHEAD';
    }

    return '';
  }

  const TRIGGER_REASON_NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000;

  function parseTriggerReasonCache(rawValue) {
    if (rawValue == null) return null;
    const text = String(rawValue).trim();
    if (!text) return null;

    if (text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
          const reason = parsed.reason ?? parsed.value ?? parsed.trigger_reason ?? parsed.triggerReason ?? '-';
          const importance = parsed.importance ?? '-';
          const ts = Number(parsed.ts ?? parsed.timestamp ?? 0);
          return { reason, importance, ts: Number.isFinite(ts) ? ts : 0 };
        }
      } catch {
        // Treat as legacy plain string below.
      }
    }

    return { reason: text, importance: '-', ts: 0 };
  }

  function serializeTriggerReasonCache(reason, importance = '-') {
    return JSON.stringify({ reason, importance, ts: Date.now() });
  }

  function getTriggerReasonCacheKey(plantCode, scheduleFile, scheduleDate) {
    const safePlant = String(plantCode || '').trim().toUpperCase();
    const fileToken = String(scheduleFile || '')
      .trim()
      .replace(/\.[^.]+$/, '')
      .replace(/\s+/g, '_');
    const safeDate = String(scheduleDate || '').trim();
    // Cache schema version to invalidate stale reason values after parser fixes.
    return `trigger_reason_v10_${safePlant}_${fileToken}_${safeDate}`;
  }

  function normalizeImportance(value) {
    const text = String(value || '').trim().toUpperCase();
    if (text === 'HIGH' || text === 'MEDIUM' || text === 'LOW') return text;
    return '-';
  }

  async function fetchTextFromS3Key(key) {
    const normalizedKey = String(key || '').trim();
    const cached = getReadinessCacheValue(readinessS3TextCache, normalizedKey, READINESS_S3_TEXT_CACHE_TTL_MS);
    if (cached !== null) return cached;
    const url = getS3ObjectUrl(key);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to load template from S3 (${response.status})`);
      }
      const text = await response.text();
      setReadinessCacheValue(readinessS3TextCache, normalizedKey, text);
      return text;
    } catch (error) {
      // Fallback: proxy via backend to avoid S3 CORS issues when accessed via EC2/IP.
      const proxyUrl = `/api/s3/text?key=${encodeURIComponent(String(key || ''))}`;
      const response = await fetch(proxyUrl);
      if (!response.ok) throw error;
      const text = await response.text();
      setReadinessCacheValue(readinessS3TextCache, normalizedKey, text);
      return text;
    }
  }

  function findMatchingUploadedTemplate(uploadedTemplates, sourceFileName, sourceRevision) {
    if (!Array.isArray(uploadedTemplates) || uploadedTemplates.length === 0) return null;

    const normalizedSourceName = String(sourceFileName || '').replace(/\.csv$/i, '').toLowerCase();
    const revisionTokens = Number.isFinite(sourceRevision)
      ? [`schedule_freeze_from_${sourceRevision}`, `schedule_freez_from_${sourceRevision}`, `schedule_from_${sourceRevision}`]
      : [];
    const byRevision = revisionTokens.length
      ? uploadedTemplates.find((item) => {
          const key = String(item?.key || '').toLowerCase();
          return revisionTokens.some((token) => key.includes(token));
        })
      : null;
    if (byRevision) return byRevision;

    const bySourceName = normalizedSourceName
      ? uploadedTemplates.find((item) => String(item?.key || '').toLowerCase().includes(normalizedSourceName))
      : null;
    if (bySourceName) return bySourceName;

    return null;
  }

  function scoreUploadHistoryRow(row) {
    if (!row) return 0;
    let score = 0;
    if (String(row?.requested_by || row?.requestedBy || '').trim()) score += 8;
    if (String(row?.uploaded_by || row?.uploadedBy || '').trim()) score += 8;
    if (String(row?.source_file_key || '').trim()) score += 3;
    if (String(row?.template_file_name || '').trim()) score += 2;
    if (String(row?.output_file_key || '').trim()) score += 2;
    return score;
  }

  function pickBestUploadHistoryRow(rows) {
    const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
    if (!list.length) return null;
    return [...list].sort((a, b) => {
      const aScore = scoreUploadHistoryRow(a);
      const bScore = scoreUploadHistoryRow(b);
      if (bScore !== aScore) return bScore - aScore;
      const at = Date.parse(String(a?.uploaded_at || ''));
      const bt = Date.parse(String(b?.uploaded_at || ''));
      return (Number.isNaN(bt) ? 0 : bt) - (Number.isNaN(at) ? 0 : at);
    })[0] || null;
  }

  function findMatchingUploadHistory(uploadHistoryItems, fileKey, sourceRevision, plantCode) {
    if (!Array.isArray(uploadHistoryItems) || uploadHistoryItems.length === 0) return null;

    const safeFileKey = String(fileKey || '').trim();
    const sourceFileName = safeFileKey ? (safeFileKey.split('/').pop() || safeFileKey) : '';
    const sourceDate = extractDateFromKey(safeFileKey);
    const isDayAheadKey = /\/day-ahead\/|\/dayahead\/|\/day_ahead\//i.test(safeFileKey);
    const uiDateForDayAhead = isDayAheadKey && sourceDate ? sourceDate : '';
    const isDayAheadHistory = (item) => {
      const outputKey = String(item?.output_file_key || '').trim();
      const templateName = String(item?.template_file_name || '').trim();
      const joined = [outputKey, templateName].filter(Boolean).join(' ');
      return (
        /\/day-ahead\/|\/dayahead\/|\/day_ahead\//i.test(joined) ||
        /_DA0\.csv$/i.test(outputKey) ||
        /_DA0\.csv$/i.test(templateName) ||
        /\bday[-\s_]*ahead\b/i.test(templateName)
      );
    };

    const exactSource = pickBestUploadHistoryRow(
      uploadHistoryItems.filter((item) => String(item?.source_file_key || '').trim() === safeFileKey)
    );
    if (exactSource) return exactSource;

    const plantScoped = uploadHistoryItems.filter(
      (item) => String(item?.plant_code || '').trim().toUpperCase() === String(plantCode || '').trim().toUpperCase()
    );
    if (plantScoped.length === 0) return null;

    const dateScoped = sourceDate
      ? plantScoped.filter((item) => {
          const d = String(item?.schedule_date || '').trim();
          if (d === sourceDate) return true;
          // Day-ahead rows in the UI are shown for the selected date (often U),
          // but the underlying file may be stored under the next-day folder (D).
          return Boolean(uiDateForDayAhead && d === uiDateForDayAhead);
        })
      : plantScoped;
    const typeScoped = dateScoped.filter((item) => {
      const historyIsDayAhead = isDayAheadHistory(item);
      return isDayAheadKey ? historyIsDayAhead : !historyIsDayAhead;
    });

    const bySourceFileName = sourceFileName
      ? typeScoped.filter((item) =>
          String(item?.source_file_key || '').toLowerCase().includes(sourceFileName.toLowerCase())
        )
      : [];
    if (bySourceFileName.length > 0) return pickBestUploadHistoryRow(bySourceFileName);

    const revisionTokens = Number.isFinite(sourceRevision)
      ? [`schedule_freeze_from_${sourceRevision}`, `schedule_freez_from_${sourceRevision}`, `schedule_from_${sourceRevision}`]
      : [];
    if (revisionTokens.length) {
      const byRevision = pickBestUploadHistoryRow(typeScoped.filter((item) =>
        revisionTokens.some((token) =>
          String(item?.source_file_key || '').toLowerCase().includes(token)
          || String(item?.template_file_name || '').toLowerCase().includes(token)
        )
      ));
      if (byRevision) return byRevision;
    }

    return null;
  }

  function findMatchingUploadHistoryByPlantDate(uploadHistoryItems, {
    plantCode = '',
    scheduleDate = '',
    isDayAhead = false,
    scheduleGeneratedAt = null,
  } = {}) {
    if (!Array.isArray(uploadHistoryItems) || uploadHistoryItems.length === 0) return null;

    const code = String(plantCode || '').trim().toUpperCase();
    const dateKey = String(scheduleDate || '').trim();
    if (!code || !dateKey) return null;

    const isDayAheadHistory = (item) => {
      const outputKey = String(item?.output_file_key || '').trim();
      const templateName = String(item?.template_file_name || '').trim();

      // Day-ahead is determined by the uploaded template naming/location, not by the
      // schedule source file. Intraday templates can still be generated from DA sources.
      const joined = [outputKey, templateName].filter(Boolean).join(' ');
      return (
        /\/day-ahead\/|\/dayahead\/|\/day_ahead\//i.test(joined) ||
        /_DA0\.csv$/i.test(outputKey) ||
        /_DA0\.csv$/i.test(templateName) ||
        /\bday[-\s_]*ahead\b/i.test(templateName)
      );
    };

    const candidates = uploadHistoryItems.filter((item) => {
      const itemCode = String(item?.plant_code || '').trim().toUpperCase();
      if (itemCode !== code) return false;
      const itemDate = String(item?.schedule_date || '').trim();
      if (itemDate !== dateKey) return false;
      return isDayAhead ? isDayAheadHistory(item) : !isDayAheadHistory(item);
    });
    if (candidates.length === 0) return null;

    const scheduleTs = scheduleGeneratedAt ? Date.parse(String(scheduleGeneratedAt || '')) : NaN;
    const sorted = [...candidates].sort((a, b) => {
      const aScore = scoreUploadHistoryRow(a);
      const bScore = scoreUploadHistoryRow(b);
      if (bScore !== aScore) return bScore - aScore;
      return String(b?.uploaded_at || '').localeCompare(String(a?.uploaded_at || ''));
    });
    if (Number.isNaN(scheduleTs)) return sorted[0] || null;

    // If a newer schedule revision was generated after the upload, keep it READY.
    const uploadedAfterGenerated = sorted.find((item) => {
      const t = Date.parse(String(item?.uploaded_at || ''));
      return !Number.isNaN(t) && t >= scheduleTs;
    });
    return uploadedAfterGenerated || null;
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
    return dt.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  }

  const formatAutoUploadSlotWindow = (slotIndex) => {
    if (!Number.isFinite(slotIndex)) return '';
    const slotStartBlock = (Number(slotIndex) * AUTO_UPLOAD_SLOT_BLOCKS) + 1;
    if (!Number.isFinite(slotStartBlock) || slotStartBlock < 1 || slotStartBlock > 96) return '';
    const start = blockToTime(slotStartBlock, 0);
    const end = blockToTime(slotStartBlock + AUTO_UPLOAD_SLOT_BLOCKS, 0);
    if (!start || !end) return '';
    return `${start}-${end}`;
  };

  function formatRowClockTime(row) {
    const extractEndingBlockFromScheduleFile = (value) => {
      const text = String(value || '').trim();
      if (!text) return null;
      const match = text.match(/schedule_(?:free(?:z|ze)_)?from_(\d+)\b/i);
      if (!match) return null;
      const block = Number.parseInt(match[1], 10);
      if (!Number.isFinite(block) || block < 1 || block > 96) return null;
      return block;
    };

    const getGeneratedScheduleClockTime = () => {
      const block =
        extractEndingBlockFromScheduleFile(row?.file_key)
        ?? extractEndingBlockFromScheduleFile(row?.file_name)
        ?? extractEndingBlockFromScheduleFile(row?.template_file_name);
      if (!Number.isFinite(block)) return null;
      // System-generated schedule time is (block start time + 8 minutes).
      return blockToTime(block, 8);
    };

    if (String(row?.status || '').toUpperCase() === 'UPLOADED') {
      const uploadedAt = String(row?.uploaded_at || '').trim();
      if (uploadedAt) {
        if (row?.is_day_ahead) {
          const dt = toDateFromIso(uploadedAt);
          if (dt) {
            return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
          }
          return null;
        }
        const explicitSubmit = Number(row?.submit_block);
        const submitBlock = Number.isFinite(explicitSubmit) ? explicitSubmit : getSubmitBlockFromTimestamp(uploadedAt);
        if (Number.isFinite(submitBlock)) {
          const submitLabel = `${blockToTime(submitBlock, 0)}-${blockToTime(submitBlock, 15)}`;
          const explicitEffective = Number(row?.effective_start_block);
          const effectiveBlock = Number.isFinite(explicitEffective)
            ? explicitEffective
            : getEffectiveStartBlock(submitBlock, row?.plant_code || row?.plantCode || row?.site_code || row?.siteCode);
          const effectiveLabel = Number.isFinite(effectiveBlock)
            ? `${blockToTime(effectiveBlock, 0)}-${blockToTime(effectiveBlock, 15)}`
            : '';
          return effectiveLabel
            ? `Submit ${submitLabel} | Effective ${effectiveLabel}`
            : `Submit ${submitLabel}`;
        }
        const dt = toDateFromIso(uploadedAt);
        if (dt) {
          return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
        }
      }
    }

    // Prefer the system-generated schedule time derived from `schedule_from_<block>.csv`
    // when the schedule is not yet uploaded.
    // Example: schedule_from_57.csv => 14:08.
    const generatedClock = getGeneratedScheduleClockTime();
    if (generatedClock) return generatedClock;

    const generatedAt = String(row?.generated_at || '').trim();
    const genDt = generatedAt ? (toDateFromIso(generatedAt) || new Date(generatedAt)) : null;
    if (genDt && !Number.isNaN(genDt.getTime())) {
      return genDt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
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
    return /schedule_(?:free(?:z|ze)_)?from_\d+(?:[_-][a-z0-9]+)*\.csv$/.test(fileName) || /schedule_(?:free(?:z|ze)_)?from_\d+(?:[_-][a-z0-9]+)*\.csv$/.test(fileKey);
  }

  function getRowTimestamp(row) {
    const ts = Date.parse(String(row?.uploaded_at || row?.generated_at || ''));
    return Number.isNaN(ts) ? 0 : ts;
  }

  function getReadinessRowDedupKey(row) {
    const plantCode = String(row?.plant_code || '').trim().toUpperCase();
    const scheduleDate = String(row?.schedule_date || '').trim();
    const isDayAhead = Boolean(row?.is_day_ahead) || /\/day-ahead\//i.test(String(row?.file_key || ''));
    const revision = Number.isFinite(row?.schedule_revision)
      ? row.schedule_revision
      : extractScheduleRevisionToken(row?.file_key)
        || extractScheduleRevisionToken(row?.file_name)
        || extractScheduleRevisionToken(row?.template_file_name);
    if (plantCode && scheduleDate && Number.isFinite(revision)) {
      return `${isDayAhead ? 'da' : 'rev'}|${plantCode}|${scheduleDate}|${revision}`;
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

  const buildReadinessData = (scheduleFiles, uploadedTemplateFiles = [], uploadHistoryItems = [], dayAheadFiles = []) => {
    const operatingDateKey = String(selectedDate || '').trim();
    const normalizedOperatingDateKey = normalizeDateInput(operatingDateKey);
    const normalizedTodayDateKey = normalizeDateInput(todayDateKey);
    const isPastOperatingDate = Boolean(
      normalizedOperatingDateKey
      && normalizedTodayDateKey
      && normalizedOperatingDateKey < normalizedTodayDateKey
    );
    // Day-ahead rows are keyed by the operating date selected in the UI.
    // If the user selects 2026-04-24, the day-ahead row should be for 2026-04-24 (not 2026-04-25).
    const dayAheadDateKey = operatingDateKey;
    const dataDateKey = operatingDateKey;
    const normalizeStatus = (value, fallback) => {
      const text = String(value || '').trim().toUpperCase();
      if (text === 'PENDING') return 'READY';
      if (['READY', 'NO_ACTION', 'UPLOADED'].includes(text)) return text;
      return fallback;
    };

    const isSystemAutoRequester = (value) => {
      const raw = String(value || '').trim();
      if (!raw) return false;
      const upper = raw.toUpperCase();
      return upper === 'SYSTEM_AUTO' || upper.includes('SYSTEM_AUTO');
    };

    // Pre-compute backend system auto-upload signals from upload history so we can:
    // - show auto-upload decisions/time
    // - keep schedule status unaffected (READY stays READY until a user uploads)
    const systemAutoBySourceKey = new Map();
    const systemAutoUsedSlots = new Set(); // `${plant}|${date}|${slotIndex}`
    (Array.isArray(uploadHistoryItems) ? uploadHistoryItems : []).forEach((item) => {
      const requestedBy = String(item?.requested_by || item?.requestedBy || '').trim();
      if (!isSystemAutoRequester(requestedBy)) return;
      const sourceKey = String(item?.source_file_key || '').trim();
      const freezeTime = String(item?.freeze_time || item?.freezeTime || '').trim();
      const plant = String(item?.plant_code || '').trim().toUpperCase() || getPlantCodeFromKey(sourceKey) || getPlantCodeFromKey(String(item?.output_file_key || '').trim());
      const d = String(item?.schedule_date || extractDateFromKey(sourceKey) || extractDateFromKey(String(item?.output_file_key || '').trim()) || operatingDateKey).trim();
      const slotIndex = String(item?.slot_index || item?.slotIndex || '').trim();
      if (plant && d && slotIndex) systemAutoUsedSlots.add(`${plant}|${d}|${slotIndex}`);
      if (sourceKey && freezeTime && !systemAutoBySourceKey.has(sourceKey)) {
        systemAutoBySourceKey.set(sourceKey, {
          freeze_time: freezeTime,
          trigger_reason: String(item?.trigger_reason || item?.triggerReason || '').trim(),
          importance: normalizeImportance(item?.importance || '-'),
          slot_index: slotIndex,
        });
      }
    });

    const findUploadHistoryForTemplateKey = (templateKey) => {
      const targetKey = String(templateKey || '').trim();
      if (!targetKey) return null;
      const items = Array.isArray(uploadHistoryItems) ? uploadHistoryItems : [];
      const normalizeTemplateName = (name) => {
        const raw = String(name || '').trim();
        if (!raw) return '';
        return raw.replace(/^\d{8}T\d{6,}_/, '');
      };
      const exact = pickBestUploadHistoryRow(
        items.filter((item) => String(item?.output_file_key || '').trim() === targetKey)
      );
      if (exact) return exact;

      const targetName = targetKey.split('/').pop() || targetKey;
      const targetNameNormalized = normalizeTemplateName(targetName);
      const targetPlantCode = String(getPlantCodeFromKey(targetKey) || '').trim().toUpperCase();
      const targetScheduleDate = String(extractDateFromKey(targetKey) || '').trim();

      const byName = pickBestUploadHistoryRow(items.filter((item) => {
        const outKey = String(item?.output_file_key || '').trim();
        const outName = outKey.split('/').pop() || outKey;
        const templateName = String(item?.template_file_name || '').trim();
        const outNameNormalized = normalizeTemplateName(outName);
        const templateNameNormalized = normalizeTemplateName(templateName);
        return Boolean(outKey) && (
          outName === targetName
          || templateName === targetName
          || outNameNormalized === targetNameNormalized
          || templateNameNormalized === targetNameNormalized
        );
      }));
      if (byName) return byName;

      // Last fallback: match by plant + schedule_date + normalized template name.
      return pickBestUploadHistoryRow(items.filter((item) => {
        const rowPlantCode = String(item?.plant_code || '').trim().toUpperCase();
        const rowScheduleDate = String(item?.schedule_date || '').trim();
        if (!rowPlantCode || !rowScheduleDate) return false;
        if (targetPlantCode && rowPlantCode !== targetPlantCode) return false;
        if (targetScheduleDate && rowScheduleDate !== targetScheduleDate) return false;

        const outKey = String(item?.output_file_key || '').trim();
        const outName = outKey.split('/').pop() || outKey;
        const templateName = String(item?.template_file_name || '').trim();
        const outNameNormalized = normalizeTemplateName(outName);
        const templateNameNormalized = normalizeTemplateName(templateName);
        return outNameNormalized === targetNameNormalized || templateNameNormalized === targetNameNormalized;
      })) || null;
    };

    const deriveScheduleReasonToken = (...candidates) => {
      const joined = candidates
        .map((v) => String(v || '').trim())
        .filter(Boolean)
        .join(' | ');
      if (!joined) return '';
      const lower = joined.toLowerCase();
      const match =
        lower.match(/schedule_freeze_from_(\d+)/) ||
        lower.match(/schedule_freez_from_(\d+)/) ||
        lower.match(/schedule_from_(\d+)/) ||
        lower.match(/schedule_(\d+)/);
      if (!match?.[0]) return '';
      if (match[0].includes('schedule_freeze_from_') || match[0].includes('schedule_freez_from_')) {
        return `schedule_freeze_from_${match[1]}.csv`;
      }
      if (match[0].includes('schedule_from_')) return `schedule_from_${match[1]}.csv`;
      return `schedule_${match[1]}.csv`;
    };
    const allFilesByPlantCode = scheduleFiles.reduce((acc, file) => {
      const plant = getPlantFromKey(file.key);
      const plantCode = plant?.code || 'GSNP';
      if (!acc[plantCode]) acc[plantCode] = [];
      acc[plantCode].push(file);
      return acc;
    }, {});

    const filesByPlantCode = Object.entries(allFilesByPlantCode).reduce((acc, [plantCode, files]) => {
      const list = Array.isArray(files) ? files : [];
      // Prefer generated/outputs intraday schedules for readiness (S3 source of truth).
      const preferredOutputs = list.filter((file) => isOutputsScheduleKey(file?.key));
      acc[plantCode] = preferredOutputs.length ? preferredOutputs : list;
      return acc;
    }, {});

    const uploadedByPlantCode = uploadedTemplateFiles.reduce((acc, file) => {
      const plantCode = getPlantCodeFromKey(file.key);
      if (!acc[plantCode]) acc[plantCode] = [];
      acc[plantCode].push(file);
      return acc;
    }, {});
    const isForceManualRequestId = (value) => /^force-manual-/i.test(String(value || '').trim());

    const scheduleRows = Object.entries(filesByPlantCode).flatMap(([plantCode, files]) => {
      const plant = S3_PLANTS.find((p) => p.code === plantCode) || S3_PLANTS[0];
      const sorted = sortLatestFirst(files);
      const uploadedTemplates = sortLatestFirst(uploadedByPlantCode[plantCode] || []);
      return sorted.flatMap((file, idx) => {
        if (!file?.key) return [];
        const isLatest = idx === 0;
        const endingBlock = extractTrailingNumber(file.key);
        const uploadedTemplate = findMatchingUploadedTemplate(uploadedTemplates, file.key.split('/').pop(), endingBlock);
        const scheduleDate = extractDateFromKey(file.key) || selectedDate;
        // Intraday status must be revision-specific.
        // Do not use plant+date fallback here, otherwise one uploaded revision
        // can incorrectly mark other non-uploaded revisions as UPLOADED.
        const candidateUploadedHistory =
          findMatchingUploadHistory(uploadHistoryItems, file.key, endingBlock, plantCode);
        const candidateUploadedHistoryForTemplate = uploadedTemplate?.key
          ? findUploadHistoryForTemplateKey(uploadedTemplate.key)
          : null;
        const pickBestUploadHistory = (a, b) => {
          const score = (row) => {
            if (!row) return 0;
            let s = 0;
            if (String(row?.requested_by || row?.requestedBy || '').trim()) s += 4;
            if (String(row?.uploaded_by || row?.uploadedBy || '').trim()) s += 4;
            if (String(row?.trigger_reason || row?.triggerReason || '').trim()) s += 2;
            if (String(row?.source_file_key || '').trim()) s += 2;
            if (String(row?.csv_text || row?.csvText || '').trim()) s += 1;
            if (String(row?.storage_mode || row?.storageMode || '').trim() === 'local') s += 1;
            return s;
          };
          const aScore = score(a);
          const bScore = score(b);
          if (bScore > aScore) return b;
          if (aScore > bScore) return a;
          const aTs = Date.parse(String(a?.uploaded_at || ''));
          const bTs = Date.parse(String(b?.uploaded_at || ''));
          if (!Number.isNaN(aTs) && !Number.isNaN(bTs) && bTs !== aTs) return bTs > aTs ? b : a;
          return a || b || null;
        };
        const bestCandidateUploadedHistory = pickBestUploadHistory(candidateUploadedHistory, candidateUploadedHistoryForTemplate);
        const uploadedHistory = isSystemAutoRequester(bestCandidateUploadedHistory?.requested_by || bestCandidateUploadedHistory?.requestedBy)
          ? null
          : bestCandidateUploadedHistory;
        const workflowEntry = workflowByFile?.[file.key] || {};
        const templateEntry = sldcTemplateMapBySource?.[file.key] || null;
        // Schedules are actionable only for the selected operating date.
        // Past operating dates are "finished": do not keep schedules in READY unless they were uploaded.
        const isOperatingDate = Boolean(!isPastOperatingDate && operatingDateKey && scheduleDate === operatingDateKey);
        const defaultStatus = isOperatingDate ? 'READY' : 'NO_ACTION';
        const workflowStatus = String(workflowEntry?.status || '').toUpperCase();
        // Keep latest system-generated schedule READY on the operating date (do not let stale workflow state force NO_ACTION).
        // A confirmed upload is the only workflow state allowed to override that READY status.
        let statusFromWorkflow = workflowStatus === 'UPLOADED'
          ? 'UPLOADED'
          : (isOperatingDate && isLatest ? 'READY' : normalizeStatus(workflowStatus, defaultStatus));
        // Past operating dates are finished: do not show READY even if workflow/localStorage says READY.
        if (isPastOperatingDate && statusFromWorkflow === 'READY') statusFromWorkflow = 'NO_ACTION';
        // Only treat a schedule as UPLOADED when confirmed upload history is tied to this exact revision.
        // A generated/downloaded template alone must not move the schedule into Uploaded before user confirmation.
        const uploadedForThisRevision = Boolean(
          uploadedHistory && Number.isFinite(endingBlock) && extractScheduleRevisionToken(uploadedHistory?.source_file_key) === endingBlock
        );
        const computedStatus = uploadedForThisRevision ? 'UPLOADED' : statusFromWorkflow;
        const status = computedStatus;
        const isForceUploaded = isForceManualRequestId(uploadedHistory?.manual_request_id);
        const uploadedAt = workflowEntry?.uploaded_at
          || (status === 'UPLOADED'
            ? (
              workflowEntry?.updated_at
              || uploadedHistory?.uploaded_at
              || uploadedTemplate?.lastModified
              || null
            )
            : null);
        const inferredReason = inferTriggerReasonFromRow({
          ...file,
          schedule_date: scheduleDate,
          file_key: file.key,
          file_name: file.key.split('/').pop(),
          template_file_name: templateEntry?.template_file_name || uploadedHistory?.template_file_name || uploadedTemplate?.key?.split('/').pop() || '',
          template_s3_key: templateEntry?.s3_output_file_key || uploadedHistory?.output_file_key || uploadedTemplate?.key || '',
        });
        return [{
          id: `${plantCode}-${file.key}-${isLatest ? 'latest' : `older-${idx}`}`,
          plant_id: plant.id,
          plant_name: plant.name,
          category: plant.type,
          status,
          trigger_reason: isForceUploaded
            ? 'FORCE_SCHEDULE'
            : (String(uploadedHistory?.trigger_reason || uploadedHistory?.triggerReason || '').trim() || inferredReason || '-'),
          importance: normalizeImportance(uploadedHistory?.importance || '-'),
          upload_deadline: uploadedAt || null,
          uploaded_at: uploadedAt || null,
          uploaded_by: getEmployeeName(
            uploadedHistory?.requested_by
            || uploadedHistory?.requestedBy
            || uploadedHistory?.uploaded_by
            || uploadedHistory?.uploadedBy
            || workflowEntry?.requested_by
            || workflowEntry?.requestedBy
            || ''
          ),
          source_file_key: file.key,
          schedule_reason_token: deriveScheduleReasonToken(file.key, file.key.split('/').pop()),
          file_key: file.key,
          file_name: file.key.split('/').pop(),
          plant_code: plantCode,
          schedule_date: scheduleDate,
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
        }];
      });
    });

    // Ensure "latest schedule" is picked deterministically per plant+operating-date.
    // This protects against edge cases where S3 listing order or filename parsing causes the wrong row
    // to be considered latest (which affects READY vs NO_ACTION for the latest revision).
    const latestKeyForPlantDate = new Map(); // `${plant}|${date}` -> file_key
    scheduleRows.forEach((row) => {
      const dateKey = String(row?.schedule_date || '').trim();
      if (!operatingDateKey || dateKey !== operatingDateKey) return;
      const plantCode = String(row?.plant_code || '').trim().toUpperCase();
      const key = `${plantCode}|${dateKey}`;
      const currBestKey = latestKeyForPlantDate.get(key);
      if (!currBestKey) {
        latestKeyForPlantDate.set(key, String(row?.file_key || '').trim());
        return;
      }
      const currBest = scheduleRows.find((r) => String(r?.file_key || '').trim() === currBestKey);
      const aRev = Number(row?.ending_block);
      const bRev = Number(currBest?.ending_block);
      if (Number.isFinite(aRev) && Number.isFinite(bRev) && aRev !== bRev) {
        if (aRev > bRev) latestKeyForPlantDate.set(key, String(row?.file_key || '').trim());
        return;
      }
      const aTs = Date.parse(String(row?.generated_at || ''));
      const bTs = Date.parse(String(currBest?.generated_at || ''));
      if (!Number.isNaN(aTs) && !Number.isNaN(bTs) && aTs !== bTs) {
        if (aTs > bTs) latestKeyForPlantDate.set(key, String(row?.file_key || '').trim());
      }
    });

    const scheduleRowsLatestFixed = latestKeyForPlantDate.size
      ? scheduleRows.map((row) => {
        const dateKey = String(row?.schedule_date || '').trim();
        const plantCode = String(row?.plant_code || '').trim().toUpperCase();
        const key = `${plantCode}|${dateKey}`;
        const bestKey = latestKeyForPlantDate.get(key);
        if (!bestKey) return row;
        const isBest = String(row?.file_key || '').trim() === bestKey;
        if (!isBest) return { ...row, is_latest: false };

        // Latest revision for the operating date should always be READY unless a user uploaded it.
        // Exception: past operating dates should not be READY.
        if (isPastOperatingDate) {
          return { ...row, is_latest: true };
        }
        const hasUserUpload = String(row?.status || '').toUpperCase() === 'UPLOADED';
        return {
          ...row,
          is_latest: true,
          status: hasUserUpload ? row.status : 'READY',
        };
      })
      : scheduleRows;

    const dayAheadFilesByPlantAndDate = (Array.isArray(dayAheadFiles) ? dayAheadFiles : [])
      .reduce((acc, file) => {
        const key = String(file?.key || '').trim();
        if (!key) return acc;
        const folderDateKey = String(extractDateFromKey(key) || '').trim();
        if (!folderDateKey) return acc;
        const plantCode = String(getPlantCodeFromKey(key) || '').trim().toUpperCase();
        if (!plantCode) return acc;

        // Day-ahead files are expected to live under the operating date folder (same as selectedDate).
        // Only bucket under the folder date to avoid shifting the UI to D+2.
        const candidateDates = [folderDateKey]
          .filter(Boolean)
          .filter((candidate) => candidate === dayAheadDateKey);
        if (!candidateDates.length) return acc;

        if (!acc[plantCode]) acc[plantCode] = {};
        candidateDates.forEach((scheduleDateKey) => {
          if (!acc[plantCode][scheduleDateKey]) acc[plantCode][scheduleDateKey] = [];
          acc[plantCode][scheduleDateKey].push({
            ...file,
            __source_date: folderDateKey,
            __target_date: scheduleDateKey,
          });
        });
        return acc;
      }, {});

    const dayAheadRows = visiblePlants.flatMap((plant) => {
      const plantCode = plant?.code || 'GSNP';
      const byDate = dayAheadFilesByPlantAndDate[plantCode] || {};
      const candidates = byDate[dayAheadDateKey] || [];

      const isFutureOperatingDate = (() => {
        const dayKey = normalizeDateInput(dayAheadDateKey);
        const todayKey = normalizeDateInput(todayDateKey);
        return Boolean(dayKey && todayKey && dayKey > todayKey);
      })();
      const dayAheadReadyStatus = isFutureOperatingDate ? 'READY' : 'NO_ACTION';

      // If day-ahead is missing for a plant/date, do not create a placeholder row.
      // Missing day-ahead should not be counted as a separate "site row" in the UI.
      if (!Array.isArray(candidates) || candidates.length === 0) return [];

      const sortedCandidates = sortLatestFirst(candidates);

      return sortedCandidates.flatMap((pickedCandidate, idx) => {
        const endingBlock = extractScheduleRevisionToken(pickedCandidate.key) ?? extractTrailingNumber(pickedCandidate.key);
        const candidateUploadedHistory =
          findMatchingUploadHistory(uploadHistoryItems, pickedCandidate.key, endingBlock, plantCode)
          || findMatchingUploadHistoryByPlantDate(uploadHistoryItems, {
            plantCode,
            scheduleDate: dayAheadDateKey,
            isDayAhead: true,
            scheduleGeneratedAt: pickedCandidate.lastModified,
          });
        const uploadedHistory = isSystemAutoRequester(candidateUploadedHistory?.requested_by || candidateUploadedHistory?.requestedBy)
          ? null
          : candidateUploadedHistory;
        const workflowEntry = workflowByFile?.[pickedCandidate.key] || {};
        const templateEntry = sldcTemplateMapBySource?.[pickedCandidate.key] || null;

        const uploadedAtCandidate =
          workflowEntry?.uploaded_at
          || workflowEntry?.updated_at
          || uploadedHistory?.uploaded_at
          || null;

        const workflowStatus = String(workflowEntry?.status || '').trim().toUpperCase();
        const isConfirmedUploaded = Boolean(uploadedHistory || workflowStatus === 'UPLOADED');
        const isLatestDa = idx === 0;
        const status = isConfirmedUploaded
          ? 'UPLOADED'
          : (isLatestDa ? dayAheadReadyStatus : 'NO_ACTION');
        const uploadedAt = status === 'UPLOADED' ? uploadedAtCandidate : null;

        const baseName = String(pickedCandidate.key || '').split('/').pop() || String(pickedCandidate.key || '');
        const sourceScheduleDate = String(pickedCandidate?.__source_date || '').trim();
        const targetScheduleDate = String(pickedCandidate?.__target_date || '').trim();

        return [{
          id: `dayahead-${dayAheadDateKey}-${plantCode}-${pickedCandidate.key}`,
          plant_id: plant.id,
          plant_name: plant.name,
          category: plant.type,
          status,
          trigger_reason: 'DAY_AHEAD',
          importance: '-',
          upload_deadline: uploadedAt || null,
          uploaded_at: uploadedAt || null,
          uploaded_by: getEmployeeName(
            uploadedHistory?.requested_by
            || uploadedHistory?.requestedBy
            || uploadedHistory?.uploaded_by
            || uploadedHistory?.uploadedBy
            || workflowEntry?.requested_by
            || workflowEntry?.requestedBy
            || ''
          ),
          file_key: pickedCandidate.key,
          file_name: `Day-ahead: ${baseName}`,
          plant_code: plantCode,
          schedule_date: dayAheadDateKey,
          source_schedule_date: sourceScheduleDate || null,
          target_schedule_date: targetScheduleDate || null,
          schedule_revision: Number.isFinite(endingBlock) ? endingBlock : null,
          ending_block: Number.isFinite(endingBlock) ? endingBlock : null,
          ending_block_time: Number.isFinite(endingBlock) ? blockToTime(endingBlock, 8) : '',
          generated_at: pickedCandidate.lastModified,
          is_latest: isLatestDa,
          is_day_ahead: true,
          ui_disable_actions: false,
          state: plant.state,
          capacity: plant.capacity,
          template_file_name: templateEntry?.template_file_name || uploadedHistory?.template_file_name || '',
          template_generated_at: templateEntry?.generated_at || uploadedHistory?.uploaded_at || null,
          template_csv_text: templateEntry?.csv_text || uploadedHistory?.csv_text || '',
          template_s3_key: templateEntry?.s3_output_file_key || uploadedHistory?.output_file_key || null,
          template_s3_url: templateEntry?.s3_output_file_url || uploadedHistory?.output_file_url || null,
        }];
      });
    });

    // Build quick lookup of known day-ahead revisions per plant/date from S3 day-ahead files.
    // This is used as a robust fallback when upload-history metadata lacks source_file_key.
    const dayAheadRevisionIndex = new Set();
    (Array.isArray(dayAheadRows) ? dayAheadRows : []).forEach((row) => {
      const code = String(row?.plant_code || '').trim().toUpperCase();
      const d = String(row?.schedule_date || '').trim();
      const rev = Number.isFinite(row?.schedule_revision)
        ? Number(row.schedule_revision)
        : extractScheduleRevisionToken(row?.file_key)
          || extractScheduleRevisionToken(row?.file_name)
          || extractScheduleRevisionToken(row?.template_file_name);
      if (!code || !d || !Number.isFinite(rev)) return;
      dayAheadRevisionIndex.add(`${code}|${d}|${rev}`);
    });

    const looksLikeDayAheadByRevision = (plantCode, scheduleDate, revision) => {
      const code = String(plantCode || '').trim().toUpperCase();
      const d = String(scheduleDate || '').trim();
      const rev = Number(revision);
      if (!code || !d || !Number.isFinite(rev)) return false;
      return dayAheadRevisionIndex.has(`${code}|${d}|${rev}`);
    };

    const scheduleKeySet = new Set(scheduleRows.map((row) => String(row.file_key || '').trim()).filter(Boolean));
    const uploadedOnlyRows = [];

    uploadHistoryItems.forEach((item, idx) => {
      const sourceKey = String(item?.source_file_key || '').trim();
      if (sourceKey && scheduleKeySet.has(sourceKey)) return;

      const requestedByRaw = String(item?.requested_by || item?.requestedBy || '').trim();
      if (isSystemAutoRequester(requestedByRaw)) return;

      const outputKey = String(item?.output_file_key || '').trim();
      const plantCode = (
        String(item?.plant_code || '').trim().toUpperCase()
        || getPlantCodeFromKey(sourceKey)
        || getPlantCodeFromKey(outputKey)
      );
      const plant = S3_PLANTS.find((p) => p.code === plantCode) || S3_PLANTS[0];
      const resolvedPlantCode = String(plantCode || plant?.code || '').trim().toUpperCase();
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
      const scheduleReasonToken = deriveScheduleReasonToken(item?.source_file_key, sourceKey, outputKey, fileName);
      const isDayAheadUpload = isDayAheadLikeKey(
        sourceKey || outputKey || String(item?.template_file_name || '').trim()
      ) || looksLikeDayAheadByRevision(resolvedPlantCode, scheduleDate, scheduleRevision);
      const isForceUploaded = isForceManualRequestId(item?.manual_request_id);
      const inferredReason = scheduleReasonToken ? '' : inferTriggerReasonFromRow({
        schedule_reason_token: '',
        source_file_key: String(item?.source_file_key || '').trim(),
        file_key: sourceKey || outputKey,
        file_name: fileName,
        template_file_name: String(item?.template_file_name || '').trim(),
        is_day_ahead: isDayAheadUpload,
      });

      uploadedOnlyRows.push({
        id: `uploaded-history-${plantCode}-${idx}-${fileName}`,
        plant_id: plant.id,
        plant_name: plant.name,
        category: plant.type,
        status: 'UPLOADED',
        trigger_reason: isForceUploaded
          ? 'FORCE_SCHEDULE'
          : (String(item?.trigger_reason || item?.triggerReason || '').trim() || inferredReason || '-'),
        importance: normalizeImportance(item?.importance || '-'),
        upload_deadline: uploadedAt,
        uploaded_at: uploadedAt,
        uploaded_by: getEmployeeName(item?.requested_by || item?.requestedBy || item?.uploaded_by || item?.uploadedBy || ''),
        freeze_time: String(item?.freeze_time || item?.freezeTime || '').trim() || null,
        source_file_key: String(item?.source_file_key || '').trim(),
        schedule_reason_token: scheduleReasonToken,
        file_key: sourceKey || outputKey,
        file_name: fileName,
        plant_code: resolvedPlantCode,
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
        is_day_ahead: isDayAheadUpload,
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
        const uploadedHistory = findUploadHistoryForTemplateKey(key);
        if (!uploadedHistory) return null;
        const historyRequestedBy = String(uploadedHistory?.requested_by || uploadedHistory?.requestedBy || '').trim();
        if (isSystemAutoRequester(historyRequestedBy)) return null;
        const sourceFileKey = String(uploadedHistory?.source_file_key || '').trim();
        const scheduleReasonToken = deriveScheduleReasonToken(sourceFileKey, key, uploadedHistory?.template_file_name);
        const isDayAheadUpload = isDayAheadLikeKey(
          sourceFileKey || key || String(uploadedHistory?.template_file_name || '').trim()
        ) || looksLikeDayAheadByRevision(plantCode, scheduleDate, extractScheduleRevisionToken(sourceFileKey) || extractScheduleRevisionToken(key));
        const isForceUploaded = isForceManualRequestId(uploadedHistory?.manual_request_id);
        const workflowRequester = sourceFileKey ? workflowByFile?.[sourceFileKey]?.requested_by : '';
        const uploadedBy = getEmployeeName(
          uploadedHistory?.requested_by
          || uploadedHistory?.requestedBy
          || uploadedHistory?.uploaded_by
          || uploadedHistory?.uploadedBy
          || workflowRequester
          || ''
        );
        const inferredReason = scheduleReasonToken ? '' : inferTriggerReasonFromRow({
          schedule_reason_token: '',
          source_file_key: sourceFileKey,
          file_key: key,
          file_name: key.split('/').pop() || key,
          template_file_name: String(uploadedHistory?.template_file_name || '').trim() || (key.split('/').pop() || ''),
          is_day_ahead: isDayAheadUpload,
        });
        return {
          id: `uploaded-template-${plantCode}-${idx}-${key}`,
          plant_id: plant.id,
          plant_name: plant.name,
          category: plant.type,
          status: 'UPLOADED',
          trigger_reason: isForceUploaded
            ? 'FORCE_SCHEDULE'
            : (String(uploadedHistory?.trigger_reason || uploadedHistory?.triggerReason || '').trim() || inferredReason || '-'),
          importance: normalizeImportance(uploadedHistory?.importance || '-'),
          upload_deadline: item.lastModified || null,
          uploaded_at: item.lastModified || null,
          uploaded_by: uploadedBy,
          freeze_time: String(uploadedHistory?.freeze_time || uploadedHistory?.freezeTime || '').trim() || null,
          source_file_key: sourceFileKey,
          schedule_reason_token: scheduleReasonToken,
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
          is_day_ahead: isDayAheadUpload,
        };
      });

    const scheduleRowsWithSystemAuto = scheduleRowsLatestFixed.map((row) => {
      const fileKey = String(row?.file_key || '').trim();
      const info = fileKey ? systemAutoBySourceKey.get(fileKey) : null;

      const rowPlantCode = String(row?.plant_code || '').trim().toUpperCase();
      const rowScheduleDate = String(row?.schedule_date || '').trim();
      const generatedIso = String(row?.generated_at || '').trim();
      const slotIndex = generatedIso
        ? getSlotIndexFromTimestamp(generatedIso)
        : null;
      const slotKey = rowPlantCode && rowScheduleDate && Number.isFinite(slotIndex)
        ? `${rowPlantCode}|${rowScheduleDate}|${String(slotIndex)}`
        : '';
      const systemSlotUsed = slotKey ? systemAutoUsedSlots.has(slotKey) : false;

      if (!info) {
        return {
          ...row,
          system_slot_used: systemSlotUsed,
        };
      }

      const freezeIso = String(info.freeze_time || '').trim();
      const reason = String(info.trigger_reason || '').trim();
      return {
        ...row,
        system_slot_used: systemSlotUsed,
        freeze_time: freezeIso || row?.freeze_time || null,
        trigger_reason: reason || row?.trigger_reason || '-',
        importance: normalizeImportance(row?.importance || info?.importance || '-'),
        auto_uploaded: true,
      };
    });

    // Do not create placeholder rows when a plant has no schedule/day-ahead for the selected date.
    // Missing schedules should not appear as extra rows or affect READY counts.
    const dataDatePlaceholderRows = [];

    const mergedRows = [...scheduleRowsWithSystemAuto, ...dayAheadRows, ...uploadedOnlyRows, ...uploadedTemplateRows.filter(Boolean), ...dataDatePlaceholderRows];
    const dedupedRows = dedupeReadinessRows(mergedRows);

    const getRowRevision = (row) => (
      Number.isFinite(row?.schedule_revision)
        ? row.schedule_revision
        : extractScheduleRevisionToken(row?.file_key)
          || extractScheduleRevisionToken(row?.file_name)
          || extractScheduleRevisionToken(row?.template_file_name)
    );

    // Keep only the latest intraday revision as READY per plant + date.
    // Any older READY revisions should move to NO_ACTION so action buttons and status sections stay aligned.
    const highestRevisionByPlantDate = new Map();
    dedupedRows.forEach((row) => {
      if (row?.is_day_ahead) return;
      const plantCode = String(row?.plant_code || '').trim().toUpperCase();
      const scheduleDate = String(row?.schedule_date || '').trim();
      const revision = getRowRevision(row);
      if (!plantCode || !scheduleDate || !Number.isFinite(revision)) return;
      const key = `${plantCode}|${scheduleDate}`;
      const prev = highestRevisionByPlantDate.get(key);
      if (!Number.isFinite(prev) || revision > prev) highestRevisionByPlantDate.set(key, revision);
    });

    const readinessRows = dedupedRows.map((row) => {
      if (String(row?.status || '').toUpperCase() !== 'READY') return row;
      if (row?.is_day_ahead) return row;
      const plantCode = String(row?.plant_code || '').trim().toUpperCase();
      const scheduleDate = String(row?.schedule_date || '').trim();
      const revision = getRowRevision(row);
      const latest = highestRevisionByPlantDate.get(`${plantCode}|${scheduleDate}`);
      if (Number.isFinite(revision) && Number.isFinite(latest) && revision < latest) {
        return { ...row, status: 'NO_ACTION' };
      }
      return row;
    });

    // Final safety rule:
    // For the selected operating date, keep the latest intraday revision in READY
    // unless that exact latest revision is already UPLOADED.
    const enforceReadyByPlantDate = new Map();
    readinessRows.forEach((row) => {
      if (row?.is_day_ahead) return;
      const plantCode = String(row?.plant_code || '').trim().toUpperCase();
      const scheduleDate = String(row?.schedule_date || '').trim();
      if (!plantCode || !scheduleDate || scheduleDate !== operatingDateKey) return;
      const revision = getRowRevision(row);
      if (!Number.isFinite(revision)) return;
      const key = `${plantCode}|${scheduleDate}`;
      const prev = enforceReadyByPlantDate.get(key);
      if (!prev || revision > prev.revision) {
        enforceReadyByPlantDate.set(key, {
          revision,
          rowId: row.id,
          status: String(row?.status || '').trim().toUpperCase(),
        });
      }
    });

    const finalRows = readinessRows.map((row) => {
      if (row?.is_day_ahead) return row;
      const plantCode = String(row?.plant_code || '').trim().toUpperCase();
      const scheduleDate = String(row?.schedule_date || '').trim();
      const key = `${plantCode}|${scheduleDate}`;
      const latest = enforceReadyByPlantDate.get(key);
      if (!latest) return row;
      if (row.id !== latest.rowId) return row;
      if (String(row?.status || '').trim().toUpperCase() === 'UPLOADED') return row;
      return { ...row, status: 'READY' };
    });

    return finalRows.sort((a, b) => {
      const aTime = Date.parse(a.uploaded_at || a.generated_at || '');
      const bTime = Date.parse(b.uploaded_at || b.generated_at || '');
      const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
      if (timeDiff !== 0) return timeDiff;
      return String(b.file_key || b.file_name || '').localeCompare(String(a.file_key || a.file_name || ''));
    });
  };

  // Auto refresh once at 01:00 local time (to pick up day-ahead files that arrive around then).
  useEffect(() => {
    if (String(selectedDate || '').trim() !== String(getLocalDateKey() || '').trim()) return undefined;

    const now = new Date();
    const next = new Date(now);
    next.setHours(1, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delay = Math.max(1_000, next.getTime() - now.getTime());

    const timer = setTimeout(() => {
      setAutoRefreshTick((v) => v + 1);
    }, delay);

    return () => clearTimeout(timer);
  }, [selectedDate]);

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
    const normalizedStatus = String(status || '').trim().toUpperCase() === 'PENDING' ? 'READY' : status;
    setWorkflowByFile((prev) => ({
      ...prev,
      [fileKey]: {
        ...(prev[fileKey] || {}),
        ...extra,
        status: normalizedStatus,
        updated_at: new Date().toISOString(),
      },
    }));
  }, []);

  const getPlantCodeFromFilter = useCallback((plantName) => {
    const raw = String(plantName || '').trim();
    if (!raw || raw === 'All') return '';
    const match = (visiblePlants || []).find((plant) =>
      String(plant?.name || '').trim() === raw
      || String(plant?.code || '').trim().toUpperCase() === raw.toUpperCase()
    );
    return normalizeReadinessPlantCode(match?.code || deriveCodeFromPlantName(raw));
  }, [visiblePlants]);

  const handleLoadReadinessData = useCallback(() => {
    const dateKey = normalizeDateInput(String(selectedDate || '').trim());
    const stateKey = String(uploadedStateFilter || 'All').trim() || 'All';
    const plantKey = String(uploadedPlantFilter || 'All').trim() || 'All';
    lastAutoLoadKeyRef.current = `${dateKey}|${stateKey}|${plantKey}`;
    setLoadRequest({
      date: dateKey,
      state: stateKey,
      plant: plantKey,
      background: false,
      nonce: Date.now(),
    });
  }, [selectedDate, uploadedPlantFilter, uploadedStateFilter]);

  useEffect(() => {
    if (!hasLoadedReadiness) return undefined;
    const dateKey = normalizeDateInput(String(selectedDate || '').trim());
    const stateKey = String(uploadedStateFilter || 'All').trim() || 'All';
    const plantKey = String(uploadedPlantFilter || 'All').trim() || 'All';
    const nextKey = `${dateKey}|${stateKey}|${plantKey}`;
    if (lastAutoLoadKeyRef.current === nextKey) return undefined;

    const timer = setTimeout(() => {
      lastAutoLoadKeyRef.current = nextKey;
      setLoadRequest({
        date: dateKey,
        state: stateKey,
        plant: plantKey,
        background: false,
        nonce: Date.now(),
      });
    }, 450);

    return () => clearTimeout(timer);
  }, [hasLoadedReadiness, selectedDate, uploadedPlantFilter, uploadedStateFilter]);

  // Load data on mount
  useEffect(() => {
    if (!loadRequest) return undefined;
    let cancelled = false;
    const loadData = async () => {
      const isBackground = Boolean(loadRequest.background);
      if (isBackground) {
        setIsBackgroundLoading(true);
      } else {
        setIsLoading(true);
      }
      dashboardSummaryLoadedRef.current = false;
      try {
        const currentDate = normalizeDateInput(String(loadRequest.date || selectedDate || '').trim());
        const selectedState = String(loadRequest.state || 'All').trim() || 'All';
        const selectedPlantName = String(loadRequest.plant || 'All').trim() || 'All';
        const selectedPlantCode = getPlantCodeFromFilter(selectedPlantName);
        const isScopedLoad = !isBackground && Boolean(selectedPlantCode || selectedState !== 'All');
        const normalizeSummaryObjects = (items) => (Array.isArray(items) ? items : [])
          .map((item) => ({
            ...item,
            key: String(item?.key || '').trim(),
            lastModified: String(item?.last_modified || item?.lastModified || '').trim(),
          }))
          .filter((item) => item.key);
        let dashboardSummary = null;
        try {
          dashboardSummary = await scheduleReadinessApi.getDashboardSummary({
            date: currentDate,
            plantCode: selectedPlantCode || null,
            state: !selectedPlantCode && selectedState !== 'All' ? selectedState : null,
            limitPerPlant: 20000,
          });
        } catch {
          dashboardSummary = null;
        }
        const hasDashboardSummary = Boolean(
          dashboardSummary
          && Array.isArray(dashboardSummary.schedule_files)
          && Array.isArray(dashboardSummary.day_ahead_files)
          && Array.isArray(dashboardSummary.uploaded_objects)
          && Array.isArray(dashboardSummary.upload_history_items)
        );
        const summaryGeneratedPlantCodes = hasDashboardSummary
          ? (Array.isArray(dashboardSummary.generated_plant_codes) ? dashboardSummary.generated_plant_codes : [])
            .map((code) => normalizeReadinessPlantCode(code))
            .filter(Boolean)
          : [];
        const summaryGeneratedDayAheadPlantCodes = hasDashboardSummary
          ? (Array.isArray(dashboardSummary.generated_day_ahead_plant_codes) ? dashboardSummary.generated_day_ahead_plant_codes : [])
            .map((code) => normalizeReadinessPlantCode(code))
            .filter(Boolean)
          : [];
        if (hasDashboardSummary && !isScopedLoad) {
          dashboardSummaryLoadedRef.current = true;
          setGeneratedPlantCodes((prev) => {
            const next = Array.from(new Set(summaryGeneratedPlantCodes)).sort();
            return JSON.stringify(prev || []) === JSON.stringify(next) ? prev : next;
          });
          setGeneratedDayAheadPlantCodes((prev) => {
            const next = Array.from(new Set(summaryGeneratedDayAheadPlantCodes)).sort();
            return JSON.stringify(prev || []) === JSON.stringify(next) ? prev : next;
          });
        }
        const uploadPrefixes = [
          ...getUploadSearchPrefixes(currentDate),
        ];

        // IMPORTANT: drive intraday readiness from "plants discovered in S3" (via backend)
        // so plants like BHUPALPALLY/SIRMOUR always appear even if seed lists drift.
        // Still respect access control.
        const seedAllowedPlants = filterPlantsForUser(S3_PLANTS, currentUser);
        const seedCodes = (Array.isArray(seedAllowedPlants) ? seedAllowedPlants : [])
          .map((p) => String(p?.code || '').trim().toUpperCase())
          .filter(Boolean);
        const discoveredCodes = (Array.isArray(generatedPlantCodes) ? generatedPlantCodes : [])
          .concat(summaryGeneratedPlantCodes)
          .map((c) => normalizeReadinessPlantCode(c))
          .filter(Boolean);
        const discoveredDayAheadCodes = (Array.isArray(generatedDayAheadPlantCodes) ? generatedDayAheadPlantCodes : [])
          .concat(summaryGeneratedDayAheadPlantCodes)
          .map((c) => normalizeReadinessPlantCode(c))
          .filter(Boolean);

        let allCodes = Array.from(new Set([...seedCodes, ...discoveredCodes, ...discoveredDayAheadCodes]))
          .filter((code) => canUserAccessPlantCode(code, currentUser));
        if (selectedPlantCode) {
          allCodes = allCodes.filter((code) => code === selectedPlantCode);
        } else if (selectedState !== 'All') {
          allCodes = allCodes.filter((code) => {
            const plant = S3_PLANTS.find((p) => String(p?.code || '').trim().toUpperCase() === code);
            return String(plant?.state || '').trim() === selectedState;
          });
        }
        const uploadHistoryRequests = selectedPlantCode
          ? [
              scheduleReadinessApi.getUploadHistory({ scheduleDate: currentDate, plantCode: selectedPlantCode, limit: 500 }).catch(() => ({ items: [] })),
            ]
          : [
              scheduleReadinessApi.getUploadHistory({ scheduleDate: currentDate, limit: 500 }).catch(() => ({ items: [] })),
            ];

        const [scheduleListResults, dayAheadListResults, uploadedFlat, uploadHistoryResults, dayAheadFlat] = hasDashboardSummary
          ? [
              [normalizeSummaryObjects(dashboardSummary.schedule_files)],
              [normalizeSummaryObjects(dashboardSummary.day_ahead_files)],
              normalizeSummaryObjects(dashboardSummary.uploaded_objects),
              [{ items: Array.isArray(dashboardSummary.upload_history_items) ? dashboardSummary.upload_history_items : [] }],
              [],
            ]
          : await (() => {
              const scheduleListRequests = [];
              for (const code of allCodes) {
                scheduleListRequests.push(listGeneratedSchedules({ plantCode: code, scheduleDate: currentDate, scheduleType: 'intraday' }));
              }

              const dayAheadListRequests = [];
              for (const code of allCodes) {
                dayAheadListRequests.push(listGeneratedSchedules({ plantCode: code, scheduleDate: currentDate, scheduleType: 'dayahead' }));
              }

              return Promise.all([
                Promise.all(scheduleListRequests),
                Promise.all(dayAheadListRequests),
                isScopedLoad ? Promise.resolve([]) : listS3ObjectsAcrossPrefixes(uploadPrefixes),
                Promise.all(uploadHistoryRequests),
                Promise.resolve([]),
              ]);
            })();
        const uploadedObjects = Array.from(new Map(uploadedFlat.map((o) => [o.key, o])).values());
        const scheduleFiles = (Array.isArray(scheduleListResults) ? scheduleListResults : [])
          .flatMap((items) => (Array.isArray(items) ? items : []))
          .filter((o) => o?.key && isScheduleCsvKey(o.key));
        const intradayRunByScheduleKey = (() => {
          const byGroup = new Map();
          for (const file of scheduleFiles || []) {
            const key = String(file?.key || '').trim();
            if (!key) continue;
            const baseName = key.split('/').pop() || '';
            if (!/schedule_(?:free(?:z|ze)_)?from_\d+(?:[_-][a-z0-9]+)*\.csv$/i.test(baseName)) continue;
            const scheduleDate = extractScheduleDateFromKey(key) || extractDateFromKey(key);
            const plantCode = getPlantCodeFromKey(key);
            if (!scheduleDate || !plantCode) continue;
            const groupKey = `${plantCode}|${scheduleDate}`;
            if (!byGroup.has(groupKey)) byGroup.set(groupKey, []);
            byGroup.get(groupKey).push({ key });
          }
          const out = new Map();
          for (const [, group] of byGroup.entries()) {
            const runMap = computeIntradayRunIndexByKey(group);
            for (const [k, run] of runMap.entries()) out.set(k, run);
          }
          return out;
        })();

        // Prefer `/api/schedules/list?type=dayahead` results (accurate + avoids prefix mixing).
        // Keep the prefix-based scan as a fallback.
        const dayAheadFromApi = (Array.isArray(dayAheadListResults) ? dayAheadListResults : [])
          .flatMap((items) => (Array.isArray(items) ? items : []))
          .filter((o) => o?.key && isDayAheadScheduleCsvKey(o.key));
        const dayAheadObjects = Array.isArray(dayAheadFlat) ? dayAheadFlat : [];
        const dayAheadFromPrefixes = dayAheadObjects.filter((o) => isDayAheadScheduleCsvKey(o.key));
        const dayAheadFiles = Array.from(
          new Map([...dayAheadFromApi, ...dayAheadFromPrefixes].map((o) => [String(o?.key || '').trim(), o])).values()
        );
        const uploadedTemplates = uploadedObjects.filter((o) => isUploadedTemplateCsvKey(o.key));
        const mergedUploadHistory = (Array.isArray(uploadHistoryResults) ? uploadHistoryResults : [])
          .flatMap((r) => (Array.isArray(r?.items) ? r.items : []));
        const uploadHistoryItems = mergedUploadHistory.filter((item) => {
          const key = String(item?.output_file_key || '').trim().toLowerCase();
          return key.startsWith('uploads/vedanjay/');
        });
        // Ensure S3-discovered plants show up even if they have no parsed scheduleFiles
        // (for example if a key pattern is new and filtered out by `isAnyScheduleCsvKey`).
        const baseRows = buildReadinessData(scheduleFiles, uploadedTemplates, uploadHistoryItems, dayAheadFiles)
          .map((row) => ({
            ...row,
            intraday_run_index: intradayRunByScheduleKey.get(String(row?.file_key || '').trim()) || null,
          }));
        const existingCodes = new Set(
          (Array.isArray(baseRows) ? baseRows : [])
            .map((r) => String(r?.plant_code || deriveCodeFromPlantName(r?.plant_name || '') || '').trim().toUpperCase())
            .filter(Boolean)
        );
        // If schedule listing or key parsing fails for a plant, we still want the plant to be visible
        // (so the operator can see "no schedule found" instead of the plant silently disappearing).
        // This also covers cases where `/api/schedules/plants` misses a plant even though it exists in S3.
        const seedFallbackRows = allCodes
          .map((code) => String(code || '').trim().toUpperCase())
          .filter((code) => code && !existingCodes.has(code))
          .filter((code) => canUserAccessPlantCode(code, currentUser))
          .map((code) => {
            const plant = S3_PLANTS.find((p) => p.code === code) || S3_PLANTS[0];
            return {
              id: `seed-${code}`,
              plant_id: plant?.id ?? null,
              plant_name: code === 'OSEPL' ? 'OSEL' : (plant?.name || code),
              category: plant?.type || '',
              status: 'READY',
              trigger_reason: '-',
              importance: '-',
              upload_deadline: null,
              uploaded_at: null,
              uploaded_by: '',
              source_file_key: '',
              schedule_reason_token: '',
              file_key: '',
              file_name: '',
              plant_code: code,
              schedule_date: currentDate,
              schedule_revision: null,
              ending_block: null,
              ending_block_time: null,
              generated_at: null,
              is_latest: true,
              state: plant?.state || '',
              capacity: plant?.capacity || 0,
              template_file_name: '',
              template_generated_at: null,
              template_csv_text: '',
              template_s3_key: null,
              template_s3_url: null,
              _source: 'seed_fallback',
            };
          });
        const discoveredRows = (Array.isArray(generatedPlantCodes) ? generatedPlantCodes : [])
          .map((code) => String(code || '').trim().toUpperCase())
          .filter((code) => code && !existingCodes.has(code))
          .filter((code) => canUserAccessPlantCode(code, currentUser))
          .map((code) => ({
            id: `s3-${code}`,
            plant_id: null,
            plant_name: code === 'OSEPL' ? 'OSEL' : code,
            plant_code: code,
            status: 'READY',
            trigger_reason: null,
            importance: '-',
            last_checked: null,
            upload_deadline: null,
            revision_number: 0,
            schedule_date: currentDate,
            _source: 's3_discovered',
          }));

        // Also include DA-discovered plants (so they show up in the "Day-ahead" filter even
        // if the intraday seed list is incomplete).
        const existingAfterIntraday = new Set(
          [...existingCodes, ...discoveredRows.map((r) => String(r?.plant_code || '').trim().toUpperCase())].filter(Boolean)
        );
        const discoveredDayAheadRows = (Array.isArray(generatedDayAheadPlantCodes) ? generatedDayAheadPlantCodes : [])
          .map((code) => String(code || '').trim().toUpperCase())
          .filter((code) => code && !existingAfterIntraday.has(code))
          .filter((code) => canUserAccessPlantCode(code, currentUser))
          .map((code) => ({
            id: `s3-da-${code}`,
            plant_id: null,
            plant_name: code === 'OSEPL' ? 'OSEL' : code,
            plant_code: code,
            status: 'NO_ACTION',
            trigger_reason: 'DAY_AHEAD',
            importance: '-',
            last_checked: null,
            upload_deadline: null,
            revision_number: 0,
            schedule_date: currentDate,
            is_day_ahead: true,
            ui_disable_actions: true,
            _source: 's3_discovered_dayahead',
          }));
        const existingUploadedKeys = new Set(
          (Array.isArray(baseRows) ? baseRows : [])
            .filter((row) => String(row?.status || '').trim().toUpperCase() === 'UPLOADED' || isS3UploadsRow(row))
            .flatMap((row) => [
              String(row?.source_file_key || '').trim(),
              String(row?.file_key || '').trim(),
              String(row?.template_file_name || '').trim(),
            ])
            .filter(Boolean)
        );
        const combinedDayAheadDownloadedRows = Object.values(combinedDayAheadTemplateDownloadsBySource || {})
          .filter((item) => item && typeof item === 'object')
          .filter((item) => normalizeDateInput(String(item?.schedule_date || '').trim()) === currentDate)
          .map((item) => ({
            ...item,
            plant_code: String(item?.plant_code || deriveCodeFromPlantName(item?.plant_name || '')).trim().toUpperCase(),
          }))
          .filter((item) => item.plant_code && canUserAccessPlantCode(item.plant_code, currentUser))
          .filter((item) => {
            const markerKeys = [
              String(item?.source_file_key || '').trim(),
              String(item?.file_key || '').trim(),
              String(item?.template_file_name || '').trim(),
            ].filter(Boolean);
            return !markerKeys.some((key) => existingUploadedKeys.has(key));
          })
          .map((item) => {
            const plant = S3_PLANTS.find((p) => p.code === item.plant_code) || {};
            const sourceKey = String(item?.source_file_key || item?.file_key || '').trim();
            return {
              id: String(item?.id || `combined-dayahead-template-download-${item.plant_code}-${currentDate}`),
              plant_id: plant?.id ?? null,
              plant_name: item.plant_code === 'OSEPL' ? 'OSEL' : (plant?.name || item.plant_name || item.plant_code),
              plant_code: item.plant_code,
              category: plant?.type || '',
              status: 'UPLOADED',
              trigger_reason: 'DAY_AHEAD',
              importance: '-',
              upload_deadline: null,
              uploaded_at: String(item?.uploaded_at || item?.template_generated_at || '').trim(),
              uploaded_by: String(item?.uploaded_by || '').trim(),
              source_file_key: sourceKey,
              schedule_reason_token: 'DAY_AHEAD',
              file_key: sourceKey || String(item?.template_file_name || '').trim(),
              file_name: String(item?.file_name || '').trim(),
              schedule_date: currentDate,
              source_schedule_date: currentDate,
              schedule_revision: null,
              ending_block: null,
              ending_block_time: null,
              generated_at: String(item?.template_generated_at || item?.uploaded_at || '').trim(),
              is_latest: true,
              is_day_ahead: true,
              state: plant?.state || '',
              capacity: plant?.capacity || 0,
              template_file_name: String(item?.template_file_name || '').trim(),
              template_generated_at: String(item?.template_generated_at || item?.uploaded_at || '').trim(),
              template_csv_text: String(item?.template_csv_text || ''),
              template_s3_key: null,
              template_s3_url: null,
              ui_disable_actions: true,
              _source: 'combined_dayahead_template_download',
            };
          });

        const initialRows = [
          ...(Array.isArray(baseRows) ? baseRows : []),
          ...combinedDayAheadDownloadedRows,
          ...discoveredRows,
          ...discoveredDayAheadRows,
        ];
        if (cancelled) return;
        if (!seedFallbackRows.length) {
          if (isBackground) {
            setReadinessData(initialRows);
          } else {
            setReadinessData((prev) => {
              if (!isScopedLoad) return initialRows;
              const scopedCodes = new Set(allCodes.map((code) => String(code || '').trim().toUpperCase()).filter(Boolean));
              const outsideScopeRows = (Array.isArray(prev) ? prev : []).filter((row) => {
                const code = String(row?.plant_code || deriveCodeFromPlantName(row?.plant_name || '')).trim().toUpperCase();
                return code && !scopedCodes.has(code);
              });
              return [...outsideScopeRows, ...initialRows];
            });
          }
        } else {
          const existingCodes = new Set(
            initialRows.map((r) => String(r?.plant_code || '').trim().toUpperCase()).filter(Boolean)
          );
          const merged = [
            ...initialRows,
            ...seedFallbackRows.filter((row) => {
              const code = String(row?.plant_code || '').trim().toUpperCase();
              if (!code || existingCodes.has(code)) return false;
              existingCodes.add(code);
              return true;
            }),
          ];
          if (isBackground) {
            setReadinessData(merged);
          } else {
            setReadinessData((prev) => {
              if (!isScopedLoad) return merged;
              const scopedCodes = new Set(allCodes.map((code) => String(code || '').trim().toUpperCase()).filter(Boolean));
              const outsideScopeRows = (Array.isArray(prev) ? prev : []).filter((row) => {
                const code = String(row?.plant_code || deriveCodeFromPlantName(row?.plant_name || '')).trim().toUpperCase();
                return code && !scopedCodes.has(code);
              });
              return [...outsideScopeRows, ...merged];
            });
          }
        }
        if (!isBackground && !cancelled) {
          setHasLoadedReadiness(true);
          if (isScopedLoad) {
            setLoadRequest({
              date: currentDate,
              state: selectedState !== 'All' ? selectedState : 'All',
              plant: 'All',
              background: true,
              nonce: Date.now(),
            });
          }
        }
      } catch (error) {
        console.error('Failed to load readiness data from S3:', error);
        if (!cancelled) {
          if (!isBackground) setReadinessData([]);
          toast.error('Failed to load readiness data from S3');
        }
      } finally {
        if (!cancelled) {
          if (isBackground) setIsBackgroundLoading(false);
          else setIsLoading(false);
        }
      }
    };
    loadData();
    return () => {
      cancelled = true;
    };
  }, [loadRequest, selectedDate, workflowByFile, sldcTemplateMapBySource, combinedDayAheadTemplateDownloadsBySource, currentUser, getPlantCodeFromFilter]);

  useEffect(() => {
    if (!hasLoadedReadiness) return;
    setLoadRequest({
      date: normalizeDateInput(String(selectedDate || '').trim()),
      state: String(uploadedStateFilter || 'All').trim() || 'All',
      plant: String(uploadedPlantFilter || 'All').trim() || 'All',
      background: false,
      nonce: Date.now(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefreshTick]);

  useEffect(() => {
    if (!Array.isArray(readinessData) || readinessData.length === 0) return;
    const selectedKey = normalizeDateInput(selectedDate);
    const isPastSelectedDate = (() => {
      const todayKey = normalizeDateInput(todayDateKey);
      return Boolean(selectedKey && todayKey && selectedKey < todayKey);
    })();

    const maybePromoteTriggeredRowToReady = (rows, rowId, normalizedReason, normalizedImportance = '-') => {
      const reason = normalizeTriggerReason(normalizedReason);
      const importance = normalizeImportance(normalizedImportance);
      if (reason === '-' || reason === 'PLANT_STATUS_CHANGE') {
        return rows.map((item) => (item.id === rowId ? { ...item, trigger_reason: reason, importance } : item));
      }

      if (isPastSelectedDate) {
        return rows.map((item) => (item.id === rowId ? { ...item, trigger_reason: reason, importance } : item));
      }
      const getRowRevision = (item) => {
        if (Number.isFinite(item?.schedule_revision)) return item.schedule_revision;
        return (
          extractScheduleRevisionToken(item?.file_key)
          ?? extractScheduleRevisionToken(item?.file_name)
          ?? extractScheduleRevisionToken(item?.template_file_name)
          ?? extractTrailingNumber(item?.file_key)
          ?? extractTrailingNumber(item?.file_name)
        );
      };

      return rows.map((item) => {
        if (item.id !== rowId) return item;

        const next = { ...item, trigger_reason: reason, importance };
        if (Boolean(next?.is_day_ahead)) return next;
        if (Boolean(next?.ui_disable_actions)) return next;

        const rowDate = String(next?.schedule_date || '').trim();
        if (!selectedKey || rowDate !== selectedKey) return next;

        const status = String(next?.status || '').trim().toUpperCase();
        if (status !== 'NO_ACTION') return next;

        const plantCode = String(next?.plant_code || '').trim().toUpperCase();
        if (!plantCode || !rowDate) return next;

        const siblings = rows.filter((r) =>
          !r?.is_day_ahead
          && String(r?.plant_code || '').trim().toUpperCase() === plantCode
          && String(r?.schedule_date || '').trim() === rowDate
        );

        const revisions = siblings
          .map((r) => getRowRevision(r))
          .filter((rev) => Number.isFinite(rev));
        const maxRevision = revisions.length ? Math.max(...revisions) : null;
        const currentRevision = getRowRevision(next);

        const isLatest =
          (Number.isFinite(currentRevision) && Number.isFinite(maxRevision) && currentRevision === maxRevision)
          || (!Number.isFinite(maxRevision) && Boolean(next?.is_latest));

        if (!isLatest) return next;

        return { ...next, status: 'READY' };
      });
    };

    readinessData.forEach((row) => {
      const currentReason = normalizeTriggerReason(row?.trigger_reason);
      if (currentReason !== '-' && currentReason !== 'PLANT_STATUS_CHANGE') return;

      const plantCode = String(row?.plant_code || getPlantCodeFromKey(row?.file_key) || '').toUpperCase();
      const explicitScheduleReasonToken = String(row?.schedule_reason_token || '').trim();
      const fallbackRevision =
        extractScheduleRevisionToken(row?.file_key)
        || extractScheduleRevisionToken(row?.file_name)
        || extractScheduleRevisionToken(row?.template_file_name)
        || extractTrailingNumber(row?.file_key)
        || extractTrailingNumber(row?.file_name);
      const scheduleReasonToken = explicitScheduleReasonToken
        || (Number.isFinite(fallbackRevision) ? `schedule_from_${Number(fallbackRevision)}.csv` : '');
      if (!scheduleReasonToken) {
        const inferred = inferTriggerReasonFromRow(row);
        if (inferred && normalizeTriggerReason(row?.trigger_reason) === '-') {
          setReadinessData((prev) => maybePromoteTriggeredRowToReady(prev, row.id, inferred));
        }
        return;
      }

      const scheduleFile = scheduleReasonToken.split('/').pop() || '';
      const scheduleDate = extractDateFromKey(row?.file_key) || row?.schedule_date || selectedDate;
      if (!plantCode || !scheduleFile || !scheduleDate) return;

      const cacheKey = getTriggerReasonCacheKey(plantCode, scheduleFile, scheduleDate);
      try {
        const cached = parseTriggerReasonCache(localStorage.getItem(cacheKey));
        if (cached) {
          const cachedReason = normalizeTriggerReason(cached.reason);
          const cachedImportance = normalizeImportance(cached.importance);
          if (cachedReason !== '-' && cachedReason !== 'PLANT_STATUS_CHANGE') {
            setReadinessData((prev) => maybePromoteTriggeredRowToReady(prev, row.id, cachedReason, cachedImportance));
            return;
          }

          const hasTimestamp = Number.isFinite(cached.ts) && cached.ts > 0;
          const ageMs = hasTimestamp ? (Date.now() - cached.ts) : Number.POSITIVE_INFINITY;
          if (cachedReason === '-' && ageMs < TRIGGER_REASON_NEGATIVE_CACHE_TTL_MS) {
            return;
          }
        }
      } catch {
        // Ignore cache read errors.
      }

      if (triggerReasonInFlightRef.current.has(cacheKey)) return;
      triggerReasonInFlightRef.current.add(cacheKey);

      scheduleReadinessApi.getScheduleMetadata({
        plant: plantCode,
        scheduleFile,
        date: scheduleDate,
      })
        .then((meta) => {
          let normalized = normalizeTriggerReason(meta?.trigger_reason || '-');
          const normalizedImportance = normalizeImportance(meta?.importance || '-');
          if (normalized === '-') {
            const inferred = inferTriggerReasonFromRow(row);
            if (inferred) normalized = normalizeTriggerReason(inferred);
          }
          try {
            localStorage.setItem(cacheKey, serializeTriggerReasonCache(normalized, normalizedImportance));
          } catch {
            // Ignore cache write errors.
          }
          setReadinessData((prev) => maybePromoteTriggeredRowToReady(prev, row.id, normalized, normalizedImportance));
        })
        .catch(() => {
          const inferred = inferTriggerReasonFromRow(row);
          setReadinessData((prev) => maybePromoteTriggeredRowToReady(prev, row.id, inferred || '-', row?.importance || '-'));
        })
        .finally(() => {
          triggerReasonInFlightRef.current.delete(cacheKey);
        });
    });
  }, [readinessData, selectedDate, todayDateKey]);

  // Removed: browser-driven autosubmit/system_frozen generation. This is server-side only.

  const baseFilteredRows = useMemo(() => {
    const selectedDateKey = normalizeDateInput(String(selectedDate || '').trim());
    let rows = [...readinessData];
    rows = rows.filter((p) => {
      const rowDate = normalizeDateInput(String(p.schedule_date || '').trim());
      const sourceDate = String(p?.source_schedule_date || '').trim();
      const includeDayAheadForSelectedDate =
        Boolean(p?.is_day_ahead) &&
        Boolean(sourceDate) &&
        normalizeDateInput(sourceDate) === selectedDateKey;
      if (rowDate === selectedDateKey) return true;
      if (includeDayAheadForSelectedDate) return true;
      return false;
    });

    const typeFilter = String(scheduleTypeFilter || 'ALL').trim().toUpperCase();
    if (typeFilter === 'INTRADAY') {
      rows = rows.filter((p) => !Boolean(p?.is_day_ahead));
    } else if (typeFilter === 'DAY_AHEAD') {
      rows = rows.filter((p) => Boolean(p?.is_day_ahead));
    }

    if (uploadedStateFilter !== 'All') {
      rows = rows.filter((p) => {
        const rowState = String(
          p?.state ||
            S3_PLANTS.find((plant) =>
              String(plant?.code || '').trim().toUpperCase() === String(p?.plant_code || deriveCodeFromPlantName(p?.plant_name || '')).trim().toUpperCase()
            )?.state ||
            ''
        ).trim();
        return rowState === uploadedStateFilter;
      });
    }

    if (uploadedPlantFilter !== 'All') {
      rows = rows.filter((p) => String(p.plant_name || '').trim() === uploadedPlantFilter);
    }
    return rows;
  }, [readinessData, selectedDate, uploadedPlantFilter, uploadedStateFilter, scheduleTypeFilter]);

  const normalizeWorkflowStatus = (raw) => {
    const normalized = String(raw || '').trim().toUpperCase().replace(/\s+/g, '_');
    return normalized === 'PENDING' ? 'READY' : normalized;
  };

  const getEffectiveWorkflowStatus = (row) => {
    const status = normalizeWorkflowStatus(row?.status);
    if (status === 'UPLOADED') return 'UPLOADED';
    // Treat uploads folder artifacts as "Uploaded" even if status token differs.
    if (isS3UploadsRow(row)) return 'UPLOADED';
    if (status === 'READY') return 'READY';
    if (status === 'NO_ACTION') return 'NO_ACTION';
    return 'NO_ACTION';
  };

  const isPastSelectedDate = useMemo(() => {
    const selectedKey = normalizeDateInput(selectedDate);
    const todayKey = normalizeDateInput(todayDateKey);
    return Boolean(selectedKey && todayKey && selectedKey < todayKey);
  }, [selectedDate, todayDateKey]);

  const getEffectiveUiStatus = useCallback((row) => {
    const base = getEffectiveWorkflowStatus(row);
    if (!isPastSelectedDate) return base;
    if (base === 'READY') return 'NO_ACTION';
    return base;
  }, [getEffectiveWorkflowStatus, isPastSelectedDate]);

  const getLocalDateKeyFromDate = (value) => {
    const dateObj = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(dateObj.getTime())) return '';
    const year = dateObj.getFullYear();
    const month = String(dateObj.getMonth() + 1).padStart(2, '0');
    const day = String(dateObj.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const getUploadedAtDateKey = (row) => {
    const raw =
      row?.uploaded_at
      || row?.template_uploaded_at
      || row?.template_generated_at
      || row?.generated_at
      || '';
    if (!raw) return '';
    return getLocalDateKeyFromDate(raw);
  };

  const getTriggerReasonToken = (row) => {
    const raw =
      row?.trigger_reason
      || row?.triggerReason
      || row?.schedule_reason
      || row?.schedule_reason_token
      || row?.scheduleReasonToken
      || '';
    const normalized = normalizeTriggerReason(raw);
    if (normalized && normalized !== '-') return normalized;
    return normalizeTriggerReason(inferTriggerReasonFromRow(row));
  };

  const isDayAheadTrigger = (row) => {
    if (Boolean(row?.is_day_ahead)) return true;
    return getTriggerReasonToken(row) === 'DAY_AHEAD';
  };

  const getFirstDateFromRowFields = (row, fields) => {
    for (const field of fields) {
      const value = String(row?.[field] || '').trim();
      const dateKey = normalizeDateInput(extractDateFromKey(value));
      if (dateKey) return dateKey;
    }
    return '';
  };

  const isUploadedRowForSelectedDate = (row, selectedKey) => {
    if (!selectedKey) return false;

    const rowScheduleDate = normalizeDateInput(String(row?.schedule_date || '').trim());
    const uploadedDateKey = getUploadedAtDateKey(row);
    const allowedYesterdayKey = addDaysToDateKey(selectedKey, -1);

    if (isDayAheadTrigger(row)) {
      if (rowScheduleDate === selectedKey) return true;
      if (uploadedDateKey === selectedKey) return true;
      if (allowedYesterdayKey && uploadedDateKey === allowedYesterdayKey) return true;
      return false;
    }

    const uploadedTemplateDate = getFirstDateFromRowFields(row, [
      'template_s3_key',
      'template_s3_url',
      'template_file_name',
    ]);
    if (uploadedTemplateDate) return uploadedTemplateDate === selectedKey;

    const uploadedSourceDate = getFirstDateFromRowFields(row, [
      'source_file_key',
      'file_key',
      'file_name',
    ]);
    if (uploadedSourceDate) return uploadedSourceDate === selectedKey;

    if (rowScheduleDate) return rowScheduleDate === selectedKey;
    return uploadedDateKey === selectedKey;
  };

  const accessFilteredRows = useMemo(() => {
    return baseFilteredRows.filter((row) =>
      canUserAccessPlantCode(
        String(row?.plant_code || deriveCodeFromPlantName(row?.plant_name || '')),
        currentUser
      )
    );
  }, [baseFilteredRows, currentUser]);

  const distinctSiteCount = useMemo(() => {
    // Total sites should represent monitored plants available to the user,
    // not "rows currently visible" (which can be only day-ahead and show 0).
    const accessiblePlants = (visiblePlants || []).filter((plant) =>
      canUserAccessPlantCode(String(plant?.code || ''), currentUser)
    );
    const stateFilteredPlants = uploadedStateFilter === 'All'
      ? accessiblePlants
      : accessiblePlants.filter((plant) => String(plant?.state || '').trim() === uploadedStateFilter);

    if (uploadedPlantFilter !== 'All') {
      const selectedKey = String(uploadedPlantFilter || '').trim().toLowerCase();
      const match = stateFilteredPlants.find((p) =>
        String(p?.code || '').trim().toLowerCase() === selectedKey
        || String(p?.name || '').trim().toLowerCase() === selectedKey
      );
      return match ? 1 : 0;
    }

    return stateFilteredPlants.length;
  }, [visiblePlants, currentUser, uploadedPlantFilter, uploadedStateFilter]);

  const getFilteredRowsForStatus = useCallback((targetStatus) => {
    const normalizedTarget = String(targetStatus || 'All').trim();
    let rows = [...accessFilteredRows];

    if (normalizedTarget !== 'All') {
      rows = rows.filter((row) => getEffectiveUiStatus(row) === normalizedTarget);
    }

    if (normalizedTarget === 'All') {
      const selectedKey = normalizeDateInput(String(selectedDate || '').trim());
      // In All Sites view, still enforce the same date rules for UPLOADED rows as the Uploaded tab.
      rows = rows.filter((row) => {
        if (getEffectiveUiStatus(row) !== 'UPLOADED') return true;
        return isUploadedRowForSelectedDate(row, selectedKey);
      });
    }

    if (normalizedTarget === 'UPLOADED') {
      const selectedKey = normalizeDateInput(String(selectedDate || '').trim());
      // Uploaded tab should show only:
      // - intraday rows whose uploaded template/source date matches the selected date
      // - rows whose operating date matches selected date when artifact date is missing
      // - uploads done "today" (uploaded_at date == selected operating date) when schedule_date is missing
      // - exception: uploads done yesterday only when trigger is DAY_AHEAD
      rows = rows.filter((row) => isUploadedRowForSelectedDate(row, selectedKey));

      const seen = new Set();
      rows = rows.filter((p) => {
        const key = String(p.template_s3_key || p.template_s3_url || p.file_key || p.file_name || p.id || '').trim();
        if (!key) return false;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return rows;
    }

    // When something is uploaded, do not show its READY duplicate row in other filters (All/READY/NO_ACTION).
    const uploadedScopes = new Set();
    const uploadedFileKeys = new Set();
    accessFilteredRows.forEach((p) => {
      const isUploaded = getEffectiveUiStatus(p) === 'UPLOADED';
      if (!isUploaded) return;
      const plantCode = String(p?.plant_code || '').trim().toUpperCase();
      const scheduleDate = String(p?.schedule_date || '').trim();
      const revision = Number.isFinite(p?.schedule_revision)
        ? p.schedule_revision
        : extractScheduleRevisionToken(p?.file_key)
          || extractScheduleRevisionToken(p?.file_name)
          || extractScheduleRevisionToken(p?.template_file_name);
      if (plantCode && scheduleDate && Number.isFinite(revision)) {
        uploadedScopes.add(`${plantCode}|${scheduleDate}|${revision}`);
      }
      const fileKey = String(p?.file_key || '').trim();
      if (fileKey) uploadedFileKeys.add(fileKey);
    });

    rows = rows.filter((p) => {
      if (getEffectiveUiStatus(p) !== 'READY') return true;
      const plantCode = String(p?.plant_code || '').trim().toUpperCase();
      const scheduleDate = String(p?.schedule_date || '').trim();
      const revision = Number.isFinite(p?.schedule_revision)
        ? p.schedule_revision
        : extractScheduleRevisionToken(p?.file_key)
          || extractScheduleRevisionToken(p?.file_name)
          || extractScheduleRevisionToken(p?.template_file_name);
      const scopeKey = plantCode && scheduleDate && Number.isFinite(revision)
        ? `${plantCode}|${scheduleDate}|${revision}`
        : '';
      const fileKey = String(p?.file_key || '').trim();
      if (fileKey && uploadedFileKeys.has(fileKey)) return false;
      if (scopeKey && uploadedScopes.has(scopeKey)) return false;
      return true;
    });

    return rows;
  }, [accessFilteredRows, selectedDate, getEffectiveUiStatus]);

  const statusCounts = useMemo(() => {
    const readyRows = getFilteredRowsForStatus('READY');
    const uploadedRows = getFilteredRowsForStatus('UPLOADED');
    const noActionRows = getFilteredRowsForStatus('NO_ACTION');
    const readyCount = readyRows.length;
    const uploadedCount = uploadedRows.length;
    const noActionCount = noActionRows.length;
    const totalCount = readyCount + uploadedCount + noActionCount;
    return {
      sites: distinctSiteCount,
      all: totalCount,
      ready: readyCount,
      uploaded: uploadedCount,
      no_action: noActionCount,
    };
  }, [getFilteredRowsForStatus, distinctSiteCount]);

  const uploadedPlantOptions = useMemo(() => {
    const namesByCode = new Map();
    (visiblePlants || [])
      .filter((plant) => canUserAccessPlantCode(String(plant?.code || ''), currentUser))
      .filter((plant) => uploadedStateFilter === 'All' || String(plant?.state || '').trim() === uploadedStateFilter)
      .forEach((plant) => {
        const code = normalizeReadinessPlantCode(plant?.code);
        const name = String(plant?.name || '').trim();
        if (code && name) namesByCode.set(code, name);
      });

    readinessData
      .filter((p) => {
        const rowDate = String(p.schedule_date || '').trim();
        if (rowDate === selectedDate) return true;
        return false;
      })
      .filter((p) => {
        if (uploadedStateFilter === 'All') return true;
        const plantCode = String(p?.plant_code || deriveCodeFromPlantName(p?.plant_name || '')).trim().toUpperCase();
        const rowState = String(
          p?.state ||
            S3_PLANTS.find((plant) => String(plant?.code || '').trim().toUpperCase() === plantCode)?.state ||
            ''
        ).trim();
        return rowState === uploadedStateFilter;
      })
      .forEach((p) => {
        const code = normalizeReadinessPlantCode(p?.plant_code || deriveCodeFromPlantName(p?.plant_name || ''));
        const name = String(p.plant_name || '').trim();
        if (code && name && canUserAccessPlantCode(code, currentUser)) namesByCode.set(code, name);
      });

    const names = Array.from(namesByCode.values()).sort((a, b) => a.localeCompare(b));
    return ['All', ...names];
  }, [readinessData, selectedDate, currentUser, uploadedStateFilter, visiblePlants]);

  const uploadedStateOptions = useMemo(() => {
    const states = Array.from(
      new Set(
        (visiblePlants || [])
          .filter((plant) => canUserAccessPlantCode(String(plant?.code || ''), currentUser))
          .map((plant) => String(plant?.state || '').trim())
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b));
    return ['All', ...states];
  }, [visiblePlants, currentUser]);

  useEffect(() => {
    if (uploadedPlantFilter === 'All') return;
    if (!uploadedPlantOptions.includes(uploadedPlantFilter)) {
      setUploadedPlantFilter('All');
    }
  }, [uploadedPlantFilter, uploadedPlantOptions]);

  // (debug lines removed)

  const filteredPlants = useMemo(() => {
    return getFilteredRowsForStatus(statusFilter);
  }, [getFilteredRowsForStatus, statusFilter]);

  const getStatusConfig = (status) => {
    const configs = {
      READY: {
        color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
        iconColor: 'text-emerald-400',
        label: 'Ready'
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
    if (String(status || '').toUpperCase() === 'PENDING') return configs.READY;
    return configs[status] || configs.NO_ACTION;
  };

  const navigateToTemplatesForFile = useCallback((plant, options = {}) => {
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
      if (text.includes('ANJANGAON')) return 'ANJANGAON';
      if (text.includes('CME')) return 'CME';
      return text;
    };
    const explicitCode = normalizeCode(plant?.plant_code);
    const sourceKey = String(plant?.file_key || plant?.template_s3_key || '').trim();
    const originSourceKey = String(plant?.file_key || '').trim();
    const keyMatch = sourceKey.match(/\/vedanjay\/([^/]+)\//i);
    const codeFromKey = keyMatch?.[1] ? normalizeCode(keyMatch[1]) : '';
    const nameCode = normalizeCode(plant?.plant_name);
    const derivedCode = codeFromKey || explicitCode || nameCode;
    if (!sourceKey) return;

    const scheduleDateParam = String(plant?.schedule_date || selectedDate || '').trim();
    const params = new URLSearchParams();
    if (plant?.plant_id) params.set('plantId', String(plant.plant_id));
    if (plant?.plant_name) params.set('plantName', String(plant.plant_name));
    if (derivedCode) params.set('plantCode', derivedCode);
    params.set('sourceFileKey', sourceKey);
    if (originSourceKey && originSourceKey !== sourceKey) params.set('originSourceKey', originSourceKey);
    if (scheduleDateParam) params.set('scheduleDate', scheduleDateParam);
    params.set('fromReadiness', '1');
    if (options?.autoPreview) params.set('autoPreview', '1');
    if (options?.autoGenerate) params.set('autoGenerate', '1');
    if (options?.autoConfirmUpload) params.set('autoConfirmUpload', '1');
    if (options?.isDayAhead) params.set('isDayAhead', '1');

    const url = `/templates?${params.toString()}`;
    window.history.replaceState({}, '', url);
    onNavigate('templates', {
      fromReadiness: true,
      autoPreview: Boolean(options?.autoPreview),
      autoGenerate: Boolean(options?.autoGenerate),
      autoConfirmUpload: Boolean(options?.autoConfirmUpload),
      isDayAhead: Boolean(options?.isDayAhead),
      plantId: plant.plant_id,
      plantName: plant.plant_name,
      plantCode: derivedCode,
      sourceFileKey: sourceKey || undefined,
      originSourceKey: (originSourceKey && originSourceKey !== sourceKey) ? originSourceKey : undefined,
      scheduleDate: scheduleDateParam,
    });
  }, [onNavigate, selectedDate]);

  const navigateToPreparationForPlant = useCallback((plant, options = {}) => {
    if (!plant) return;

    const plantName = String(plant?.plant_name || plant?.plantName || '').trim();
    const rawScheduleDate = normalizeDateInput(plant?.schedule_date || '');
    const sourceKeyDate = extractDateFromKey(String(plant?.file_key || '').trim());
    const inferredDayAhead =
      Boolean(options?.isDayAhead) ||
      Boolean(plant?.is_day_ahead) ||
      /\/day-ahead\/|\/dayahead\/|\/day_ahead\//i.test(String(plant?.file_key || ''));
    const scheduleDateParam = String(
      inferredDayAhead
        ? (sourceKeyDate || rawScheduleDate || addDaysToDateKey(selectedDate, 1) || selectedDate || '')
        : (rawScheduleDate || selectedDate || '')
    ).trim();
    if (!plantName) return;

    const params = new URLSearchParams();
    params.set('plantName', plantName);
    if (scheduleDateParam) params.set('scheduleDate', scheduleDateParam);
    params.set('fromReadiness', '1');
    if (inferredDayAhead) params.set('isDayAhead', '1');
    const url = `/schedule?${params.toString()}`;
    window.history.replaceState({}, '', url);

    onNavigate('schedule', {
      fromReadiness: true,
      plantName,
      plant: plantName,
      scheduleDate: scheduleDateParam,
      plant_id: plant?.plant_id,
      plantCode: plant?.plant_code,
      sourceFileKey: plant?.file_key,
      isDayAhead: Boolean(inferredDayAhead),
    });
  }, [onNavigate, selectedDate]);

  const handleReadyUpload = async (plant) => {
    if (!plant) return;
    setIsRefreshing(true);
    try {
      const isDayAhead =
        Boolean(plant?.is_day_ahead) ||
        /\/day-ahead\/|\/dayahead\/|\/day_ahead\//i.test(String(plant?.file_key || ''));
      const displayName = replaceMachineScheduleNamesInText({
        text: plant.file_name,
        key: plant?.file_key,
        plantCodeOrName: plant?.plant_code || plant?.plant_name,
        scheduleDate: extractScheduleDateFromKey(plant?.file_key) || plant?.schedule_date || selectedDate,
        isDayAhead,
        intradayRunIndex: plant?.intraday_run_index,
      });
      toast.success(`Opened Schedule Preparation: ${displayName}`);
      setTimeout(() => {
        navigateToPreparationForPlant(plant, { isDayAhead });
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
      if (keyMatch?.[1]) {
        const code = keyMatch[1].toUpperCase();
        return code === 'ANJANGOAN' ? 'ANJANGAON' : code;
      }
      const rawMatch = fromKey.match(/raw\/vedanjay\/([^/]+)\//);
      if (rawMatch?.[1]) {
        const code = rawMatch[1].toUpperCase();
        return code === 'ANJANGOAN' ? 'ANJANGAON' : code;
      }

      const fromName = String(plant?.plant_name || plant?.name || '').toLowerCase();
      if (fromName.includes('bhupalpally')) return 'BHUPALPALLY';
      if (fromName.includes('kasipet')) return 'KASIPET';
      if (fromName.includes('kilaj')) return 'KILAJ';
      if (fromName.includes('kothagudem')) return 'KOTHAGUDEM';
      if (fromName.includes('osepl')) return 'OSEPL';
      if (fromName.includes('anjangaon') || fromName.includes('anjangoan')) return 'ANJANGAON';
      if (fromName.includes('cme')) return 'CME';
      if (fromName.includes('gsnp') || fromName.includes('globus steel')) return 'GSNP';
      if (fromName.includes('sirmour') || fromName.includes('shrimour') || fromName.includes('shromour')) return 'SIRMOUR';
      return 'GSNP';
    };

    try {
      if (actionType === 'revise') {
        updateRowStatus('READY', { revision_number: (selectedPlant.revision_number || 0) + 1 });
        if (selectedPlant?.file_key) {
          setWorkflowStatus(selectedPlant.file_key, 'READY', {
            plant_id: selectedPlant.plant_id,
            plant_name: selectedPlant.plant_name,
            file_name: selectedPlant.file_name,
          });
        }
        toast.success(`Opened Schedule Preparation: ${replaceMachineScheduleNamesInText({
          text: selectedPlant.file_name,
          key: selectedPlant?.file_key,
          plantCodeOrName: selectedPlant?.plant_code || selectedPlant?.plant_name,
          scheduleDate: extractScheduleDateFromKey(selectedPlant?.file_key) || selectedPlant?.schedule_date || selectedDate,
          isDayAhead: Boolean(selectedPlant?.is_day_ahead),
          intradayRunIndex: selectedPlant?.intraday_run_index,
        })}`);
        setTimeout(() => {
          navigateToPreparationForPlant(selectedPlant);
        }, 300);
      } else if (actionType === 'continue') {
        updateRowStatus('NO_ACTION', { trigger_reason: null });
        if (selectedPlant?.file_key) {
          setWorkflowStatus(selectedPlant.file_key, 'NO_ACTION', { uploaded_at: null });
        }
        toast.info(`Schedule continued for ${selectedPlant.plant_name}`);
      } else if (actionType === 'confirmUploaded') {
        const csvText = String(selectedPlant?.template_csv_text || '').trim();
        if (!csvText) {
          toast.error('Converted template content not found. Open Schedule Templates and regenerate.');
          return;
        }

        const plantCode = inferPlantCode(selectedPlant);
        const isDayAhead =
          Boolean(selectedPlant?.is_day_ahead) ||
          /\/day-ahead\/|\/dayahead\/|\/day_ahead\//i.test(String(selectedPlant?.file_key || ''));
        const sourceKeyDate = extractDateFromKey(String(selectedPlant?.file_key || '').trim());
        const scheduleDateForUpload = isDayAhead
          ? (sourceKeyDate || selectedDate)
          : (sourceKeyDate || String(selectedPlant?.schedule_date || selectedDate).trim() || selectedDate);
        const templateFileName = String(selectedPlant?.template_file_name || '').trim()
          || `${plantCode}_${scheduleDateForUpload}_sldc_template.csv`;

        const requestedByRaw =
          currentUser?.empId
          || currentUser?.username
          || currentUser?.email
          || currentUser?.name
          || currentUser?.displayName;

        const uploadResult = await scheduleReadinessApi.uploadConfirmedTemplate({
          plant_code: plantCode,
          schedule_date: scheduleDateForUpload,
          template_file_name: templateFileName,
          csv_text: csvText,
          // Prefer the underlying schedule_from_* key so upload-history can be matched reliably later.
          source_file_key: selectedPlant?.source_file_key || selectedPlant?.file_key || null,
          requested_by: getEmployeeName(requestedByRaw),
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

        // Persist/update the plant-specific frozen schedule CSV in S3 so downloads reflect the latest confirmed SLDC schedule.
        try {
          const capacityMw = selectedPlant?.capacity ?? S3_PLANTS.find((p) => p.code === plantCode)?.capacity ?? 0;

          const frozenKey = `frozenschedules/vedanjay/${getSpecialS3PlantFolder(plantCode)}/${scheduleDateForUpload}/edited_frozen.csv`;
          let existingFrozenText = '';
          try {
            existingFrozenText = await fetchTextFromS3Key(frozenKey);
          } catch {
            existingFrozenText = '';
          }

          const historyResult = await scheduleReadinessApi.getUploadHistory({
            scheduleDate: scheduleDateForUpload,
            plantCode,
            limit: 2000,
          });
          const historyItems = Array.isArray(historyResult?.items) ? historyResult.items : [];
          const isDayAheadHistory = (item) => {
            const outputKey = String(item?.output_file_key || '').trim();
            const templateName = String(item?.template_file_name || '').trim();

            // Primary signals: explicit day-ahead folder/naming on the *uploaded template itself*.
            // Do NOT rely on `source_file_key` suffix `_DA0.csv` because intraday templates can be
            // generated from a day-ahead schedule source file.
            const joined = [outputKey, templateName].filter(Boolean).join(' ');
            return (
              /\/day-ahead\/|\/dayahead\/|\/day_ahead\//i.test(joined) ||
              /_DA0\.csv$/i.test(outputKey) ||
              /_DA0\.csv$/i.test(templateName) ||
              /\bday[-\s_]*ahead\b/i.test(templateName)
            );
          };

          const historyCsvCache = new Map();
          const resolveHistoryCsvText = async (item) => {
            const inlineText = String(item?.csv_text || '').trim();
            if (inlineText) return inlineText;
            const outputKey = String(item?.output_file_key || '').trim();
            if (!outputKey || outputKey.startsWith('local/')) return '';
            if (historyCsvCache.has(outputKey)) return historyCsvCache.get(outputKey) || '';
            try {
              const fetched = String(await fetchTextFromS3Key(outputKey)).trim();
              historyCsvCache.set(outputKey, fetched);
              return fetched;
            } catch {
              historyCsvCache.set(outputKey, '');
              return '';
            }
          };

          const latestDayAhead = historyItems
            .filter((item) => isDayAheadHistory(item))
            .sort((a, b) => String(b?.uploaded_at || '').localeCompare(String(a?.uploaded_at || '')))[0] || null;

          const scheduleByBlock = new Map();
          const sourceByBlock = new Map();
          const systemScheduleByBlock = new Map();
          const systemSourceByBlock = new Map();

          // Baseline must always come from Day-Ahead:
          // - prefer uploaded Day-Ahead template (history)
          // - else fall back to latest generated Day-Ahead schedule under outputs/<date>/Day-ahead/
          let dayAheadBaselineMap = null;
          let dayAheadBaselineName = '';

          if (latestDayAhead) {
            const dayAheadText = await resolveHistoryCsvText(latestDayAhead);
            dayAheadBaselineMap = parseSldcTemplateScheduleMap(dayAheadText);
            dayAheadBaselineName =
              String(latestDayAhead?.source_file_key || '').split('/').pop()
              || String(latestDayAhead?.template_file_name || '').trim()
              || '';
          } else {
            try {
              const daPrefixes = getReportDayAheadPrefixes(scheduleDateForUpload, plantCode);
              const daObjectsFlat = await listS3ObjectsAcrossPrefixes(daPrefixes);
              const daObjects = mergeUniqueObjects([daObjectsFlat]);
              const daCandidates = daObjects
                .filter((o) => String(o?.key || '').toLowerCase().endsWith('.csv'))
                .filter((o) => /schedule_from_\d+.*\.csv$/i.test(String(o?.key || '')));
              const pickedDa = sortLatestFirst(daCandidates)[0] || null;
              if (pickedDa?.key) {
                const daText = await fetchTextFromS3Key(pickedDa.key);
                dayAheadBaselineMap = parseSldcTemplateScheduleMap(daText);
                dayAheadBaselineName = String(pickedDa.key).split('/').pop() || '';
              }
            } catch {
              // Keep baseline fallback to zeros below.
            }
          }

          const baselineLabel = `DA|${dayAheadBaselineName || 'day_ahead.csv'}`;
          for (let block = 1; block <= 96; block += 1) {
            scheduleByBlock.set(block, Number(dayAheadBaselineMap?.get?.(block) ?? 0));
            sourceByBlock.set(block, baselineLabel);
            systemScheduleByBlock.set(block, Number(dayAheadBaselineMap?.get?.(block) ?? 0));
            systemSourceByBlock.set(block, baselineLabel);
          }

          const intradayItems = historyItems
            .filter((item) => !isDayAheadHistory(item))
            .sort((a, b) => String(a?.uploaded_at || '').localeCompare(String(b?.uploaded_at || '')));

          let intradayCounter = 0;
          for (const item of intradayItems) {
            const csvText = await resolveHistoryCsvText(item);
            if (!csvText) continue;
            const uploadedAt = String(item?.uploaded_at || '').trim();
            const explicitSubmit = Number(item?.submit_block);
            const submitBlock = Number.isFinite(explicitSubmit) ? explicitSubmit : getSubmitBlockFromTimestamp(uploadedAt);
            const explicitEffective = Number(item?.effective_start_block);
            const effectiveStart = Number.isFinite(explicitEffective) ? explicitEffective : getEffectiveStartBlock(submitBlock, plantCode);
            if (!Number.isFinite(effectiveStart)) continue;
            const start = Math.max(1, Math.min(96, Number(effectiveStart)));

            const map = parseSldcTemplateScheduleMap(csvText);
            intradayCounter += 1;
            const srcName = String(item?.source_file_key || '').split('/').pop()
              || String(item?.template_file_name || '').trim()
              || `Intraday ${intradayCounter}`;
            // Freeze CSV "Source Schedule" format:
            // - Day-ahead: DA|schedule_from_XX.csv
            // - Intraday:  ID-N|schedule_from_YY.csv
            const label = `ID-${intradayCounter}|${srcName}`;
            let systemMap = map;
            let systemLabel = label;
            const sourceFileKey = String(item?.source_file_key || '').trim();
            if (/\/manual-edits\//i.test(sourceFileKey) && /\/edited_schedule\.csv$/i.test(sourceFileKey)) {
              const systemKey = sourceFileKey.replace(/\/edited_schedule\.csv$/i, '/system_schedule.csv');
              try {
                const systemCsvText = String(await fetchTextFromS3Key(systemKey)).trim();
                if (systemCsvText) {
                  const parsedSystemMap = parseSldcTemplateScheduleMap(systemCsvText);
                  if (parsedSystemMap.size > 0) {
                    systemMap = parsedSystemMap;
                    const systemName = String(systemKey).split('/').pop() || 'system_schedule.csv';
                    systemLabel = `ID-${intradayCounter}|${systemName}`;
                  }
                }
              } catch {
                // Fallback to edited map if system CSV is not reachable.
              }
            }

            for (let block = start; block <= 96; block += 1) {
              scheduleByBlock.set(block, Number(map.get(block) ?? 0));
              sourceByBlock.set(block, label);
              systemScheduleByBlock.set(block, Number(systemMap.get(block) ?? 0));
              systemSourceByBlock.set(block, systemLabel);
            }
          }

          const frozenCsvText = buildFrozenCsvFromScheduleMaps({
            existingCsvText: existingFrozenText,
            scheduleByBlock,
            sourceByBlock,
            capacityMw,
          });

          const backendSubmitBlock = Number(uploadResult?.submit_block);
          const backendEffectiveStartBlock = Number(uploadResult?.effective_start_block);
          const submitBlockForLog = isDayAhead
            ? 1
            : (Number.isFinite(backendSubmitBlock) ? backendSubmitBlock : (getSubmitBlockFromTimestamp(confirmedAt) ?? 1));
          const effectiveStartForLog = isDayAhead
            ? 1
            : (Number.isFinite(backendEffectiveStartBlock)
              ? backendEffectiveStartBlock
              : (getEffectiveStartBlock(submitBlockForLog, plantCode) ?? submitBlockForLog ?? 1));
          const startBlockForLog = Math.max(1, Math.min(96, Number(effectiveStartForLog) || 1));

          const frozenPersistResult = await frozenScheduleApi.persistAutoFreeze({
            plant_code: plantCode,
            schedule_date: scheduleDateForUpload,
            block: startBlockForLog,
            status: 'uploaded',
            source_schedule_key: selectedPlant?.file_key || null,
            freeze_time: confirmedAt,
            reason: isDayAhead ? 'DAYAHEAD_SLDC_CONFIRMED' : 'INTRADAY_SLDC_CONFIRMED',
            edited_schedule_csv: frozenCsvText,
            // Do not overwrite `system_frozen.csv` from the browser.
            // System frozen must be generated by the backend auto-upload worker at autosubmit time.
            write_system_frozen: false,
            summary: {
              selected_date: selectedDate,
              is_day_ahead: isDayAhead,
              submit_block: submitBlockForLog,
              effective_start_block: startBlockForLog,
              source_file_key: selectedPlant?.file_key || null,
              template_file_name: templateFileName,
            },
          });

          const storageMode = String(frozenPersistResult?.storage_mode || '').trim().toLowerCase();
          const persistedKey = String(frozenPersistResult?.schedule_key || '').trim();
          const persistedBucket = String(frozenPersistResult?.bucket || '').trim();
          const persistedToS3 = storageMode === 's3' && Boolean(persistedKey);
          if (!persistedToS3) {
            const err = String(frozenPersistResult?.error || '').trim();
            toast.error(
              `Frozen schedule not saved to S3.${persistedBucket ? ` Bucket=${persistedBucket}.` : ''}${err ? ` ${err}` : ''}`
            );
            return;
          }
          toast.success(`Frozen schedule saved: ${persistedKey}`);
        } catch (persistError) {
          toast.error(`Frozen schedule update failed: ${persistError?.message || 'Unable to persist frozen CSV'}`);
          return;
        }

        // Only mark as UPLOADED after we have persisted the frozen artifacts to S3.
        updateRowStatus('UPLOADED', {
          uploaded_at: confirmedAt,
          uploaded_by: getEmployeeName(currentUser?.empId || currentUser?.username),
        });
        if (selectedPlant?.file_key) {
          setWorkflowStatus(selectedPlant.file_key, 'UPLOADED', {
            plant_id: selectedPlant.plant_id,
            plant_name: selectedPlant.plant_name,
            file_name: selectedPlant.file_name,
            uploaded_at: confirmedAt,
            requested_by: getEmployeeName(currentUser?.empId || currentUser?.username),
            s3_output_file_key: uploadResult?.output_file_key || null,
            s3_output_file_url: uploadResult?.output_file_url || null,
          });
        }
        // Also key workflow status by the uploaded output key so later UI lookups can still resolve "Uploaded By"
        // even when backend upload-history rows omit/alter source_file_key.
        if (uploadResult?.output_file_key) {
          setWorkflowStatus(String(uploadResult.output_file_key), 'UPLOADED', {
            plant_id: selectedPlant?.plant_id,
            plant_name: selectedPlant?.plant_name,
            file_name: templateFileName,
            uploaded_at: confirmedAt,
            requested_by: getEmployeeName(currentUser?.empId || currentUser?.username),
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
    if (actionType === 'confirmUploaded') return 'Yes, Uploaded';
    return 'Confirm';
  };

  const handleHistoryClick = (plant) => {
    toast.info(`Opening history: ${replaceMachineScheduleNamesInText({
      text: plant.file_name,
      key: plant?.file_key,
      plantCodeOrName: plant?.plant_code || plant?.plant_name,
      scheduleDate: extractScheduleDateFromKey(plant?.file_key) || plant?.schedule_date || selectedDate,
      isDayAhead: Boolean(plant?.is_day_ahead),
      intradayRunIndex: plant?.intraday_run_index,
    })}`);
    const operatingDate = String(plant?.schedule_date || selectedDate || '').trim() || selectedDate;
    const historyPlantCode = String(plant?.plant_code || '').trim().toUpperCase();
    onNavigate('schedule', {
      plant: plant.plant_name,
      category: plant.category,
      type: 'Day-Ahead',
      date: operatingDate,
      fromReadiness: true,
      plantCode: historyPlantCode,
      sourceFileKey: plant?.file_key || '',
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
              
              <div className="w-full xl:w-[940px] rounded-2xl border border-slate-700/60 bg-slate-900/50 backdrop-blur-md p-3.5 sm:p-4.5">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-2.5 sm:gap-3">
                  <label className="block">
                    <span className="text-[11px] uppercase tracking-wider font-semibold text-slate-400 mb-1.5 block">
                      State
                    </span>
                    <select
                      value={uploadedStateFilter}
                      onChange={(e) => setUploadedStateFilter(e.target.value)}
                      className="w-full px-3 py-2 sm:px-3.5 rounded-xl bg-white border border-slate-300 text-slate-900 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      {uploadedStateOptions.map((state) => (
                        <option key={`uploaded-state-header-${state}`} value={state}>
                          {state === 'All' ? 'Select State' : state}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block">
                    <span className="text-[11px] uppercase tracking-wider font-semibold text-slate-400 mb-1.5 block">
                      Plant / Site
                    </span>
                    <select
                      value={uploadedPlantFilter}
                      onChange={(e) => setUploadedPlantFilter(e.target.value)}
                      className="w-full px-3 py-2 sm:px-3.5 rounded-xl bg-white border border-slate-300 text-slate-900 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      {uploadedPlantOptions.map((name) => (
                        <option key={`uploaded-site-header-${name}`} value={name}>
                          {name === 'All' ? 'Select Plant' : name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block">
                    <span className="text-[11px] uppercase tracking-wider font-semibold text-slate-400 mb-1.5 block">
                      Operating Date
                    </span>
                    <input
                      type="date"
                      value={selectedDate}
                      onChange={(e) => setSelectedDate(normalizeDateInput(e.target.value))}
                      className="w-full px-3 py-2 sm:px-3.5 rounded-xl bg-white border border-slate-300 text-slate-900 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </label>

                  <div className="flex flex-col justify-end">
                    <button
                      type="button"
                      onClick={handleLoadReadinessData}
                      disabled={isLoading}
                      className="w-full h-[42px] inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white text-sm font-semibold shadow-lg shadow-indigo-500/25 hover:from-indigo-500 hover:to-purple-500 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      {isLoading ? 'Loading...' : 'Load'}
                    </button>
                  </div>
                </div>

                {isAdmin && (
                  <div className="mt-3.5 pt-3.5 border-t border-slate-700/60">
                    <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider font-semibold text-slate-400 mb-2.5">
                      <FileText className="w-3.5 h-3.5" />
                      Reports
                    </div>
                    <div className="flex flex-col sm:flex-row gap-2.5">
                      <button
                        type="button"
                        onClick={onDownloadAdminReport}
                        disabled={isDownloadingReport || uploadedPlantFilter === 'All'}
                        className="w-full sm:flex-1 inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-xl bg-gradient-to-r from-emerald-500 to-green-400 text-white text-sm font-semibold shadow-lg shadow-emerald-500/30 hover:from-emerald-400 hover:to-green-300 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                        title={uploadedPlantFilter === 'All' ? 'Select a single site for site-wise report' : 'Download site-wise PDF report'}
                      >
                        <Download className="w-4 h-4" />
                        {isDownloadingReport ? 'Preparing...' : 'Site-wise report'}
                      </button>
                      <button
                        type="button"
                        onClick={onRecomputeFrozenForSelectedPlant}
                        disabled={isDownloadingReport || uploadedPlantFilter === 'All'}
                        className="w-full sm:flex-1 inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-500 text-white text-sm font-semibold shadow-lg shadow-indigo-500/30 hover:from-indigo-400 hover:to-purple-400 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                        title={uploadedPlantFilter === 'All' ? 'Select a single site to recompute edited frozen' : 'Recompute edited_frozen.csv from upload history'}
                      >
                        <TrendingUp className="w-4 h-4" />
                        Recompute Edited Frozen
                      </button>
                      <button
                        type="button"
                        onClick={onRecomputeSystemFrozenForSelectedPlant}
                        disabled={isDownloadingReport || uploadedPlantFilter === 'All'}
                        className="w-full sm:flex-1 inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 text-white text-sm font-semibold shadow-lg shadow-amber-500/30 hover:from-amber-400 hover:to-orange-400 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                        title={uploadedPlantFilter === 'All' ? 'Select a single site to recompute system frozen' : 'Recompute system_frozen.csv using slot rules (day-ahead baseline + system schedules)'}
                      >
                        <TrendingUp className="w-4 h-4" />
                        Recompute System Frozen
                      </button>
                      <button
                        type="button"
                        onClick={onDownloadAdminDateWiseAllSitesReport}
                        disabled={isDownloadingReport}
                        className="w-full sm:flex-1 inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-xl bg-gradient-to-r from-emerald-500 to-green-400 text-white text-sm font-semibold shadow-lg shadow-emerald-500/30 hover:from-emerald-400 hover:to-green-300 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                        title="Download one PDF for all sites for selected date"
                      >
                        <Download className="w-4 h-4" />
                        {isDownloadingReport ? 'Preparing...' : 'Date-wise report (all sites)'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 sm:gap-6">
            {[
              { label: 'Total Sites', value: statusCounts.sites, subtext: 'Active monitoring', icon: null, color: 'blue', gradient: 'from-slate-600 to-slate-700', glow: 'bg-slate-500/20' },
              { label: 'Ready', value: statusCounts.ready, subtext: 'Schedules ready for upload', icon: null, color: 'emerald', gradient: 'from-emerald-600 to-teal-600', glow: 'bg-emerald-500/20' },
              { label: 'Uploaded', value: statusCounts.uploaded, subtext: 'Confirmed at SLDC', icon: null, gradient: 'from-blue-600 to-cyan-600', glow: 'bg-blue-500/20' },
              { label: 'No Action', value: statusCounts.no_action, subtext: 'Continuing existing', icon: null, gradient: 'from-slate-500 to-slate-600', glow: 'bg-slate-500/20' }
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
                  {stat.icon && (
                    <div className={`p-3 rounded-xl bg-gradient-to-br ${stat.glow} group-hover:scale-110 transition-transform duration-300`}>
                      <stat.icon className={`w-5 h-5 sm:w-6 sm:h-6 text-${stat.color}-400`} />
                    </div>
                  )}
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
            {['All', 'READY', 'UPLOADED', 'NO_ACTION'].map((status) => {
              const readyCount = Number(statusCounts.ready) || 0;
              const uploadedCount = Number(statusCounts.uploaded) || 0;
              const noActionCount = Number(statusCounts.no_action) || 0;
              const totalCount = readyCount + uploadedCount + noActionCount;
              const count = status === 'All'
                ? totalCount
                : status === 'READY'
                  ? statusCounts.ready
                  : status === 'UPLOADED'
                    ? statusCounts.uploaded
                    : statusCounts.no_action;
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
                    {status === 'All' ? ` (${statusCounts.sites} Site${statusCounts.sites === 1 ? '' : 's'})` : ''}
                    <span className={`px-2 py-0.5 rounded-full text-xs ${isActive ? 'bg-white/20' : 'bg-slate-800'}`}>
                      {count}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2 text-slate-400 xl:ml-auto">
            <Layers className="w-5 h-5" />
            <span className="text-sm font-medium">Schedule Type:</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {[
              { key: 'ALL', label: 'All' },
              { key: 'INTRADAY', label: 'Intraday' },
              { key: 'DAY_AHEAD', label: 'Day-ahead' },
            ].map((opt) => {
              const active = String(scheduleTypeFilter || 'ALL').toUpperCase() === opt.key;
              return (
                <button
                  key={`type-${opt.key}`}
                  onClick={() => setScheduleTypeFilter(opt.key)}
                  className={`relative px-4 sm:px-5 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-300 ${
                    active
                      ? 'text-white'
                      : 'text-slate-400 hover:text-white hover:bg-slate-800'
                  }`}
                >
                  {active && (
                    <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 shadow-lg shadow-indigo-500/25" />
                  )}
                  <span className="relative z-10">{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="text-xs sm:text-sm text-slate-400">
          Showing <span className="text-white font-semibold">{filteredPlants.length}</span> record(s)
          {isBackgroundLoading && (
            <span className="ml-2 text-indigo-300">Preparing other sites in background...</span>
          )}
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
                  <th className="px-4 sm:px-6 py-3 sm:py-4 text-left text-xs font-semibold text-white dark:text-white uppercase tracking-wider">Site</th>
                  <th className="px-4 sm:px-6 py-3 sm:py-4 text-left text-xs font-semibold text-white dark:text-white uppercase tracking-wider">Status</th>
                  <th className="px-4 sm:px-6 py-3 sm:py-4 text-left text-xs font-semibold text-white dark:text-white uppercase tracking-wider">Trigger Reason</th>
                  <th className="px-4 sm:px-6 py-3 sm:py-4 text-left text-xs font-semibold text-white dark:text-white uppercase tracking-wider">Importance</th>
                  {isAdmin && (
                    <>
                      <th className="px-4 sm:px-6 py-3 sm:py-4 text-left text-xs font-semibold text-white dark:text-white uppercase tracking-wider">System Schedule Upload Time</th>
                      <th className="px-4 sm:px-6 py-3 sm:py-4 text-left text-xs font-semibold text-white dark:text-white uppercase tracking-wider">System Schedule Upload/Not</th>
                    </>
                  )}
                  <th className="px-4 sm:px-6 py-3 sm:py-4 text-left text-xs font-semibold text-white dark:text-white uppercase tracking-wider">Uploaded Time</th>
                  {showUploadedByColumn && (
                    <th className="px-4 sm:px-6 py-3 sm:py-4 text-left text-xs font-semibold text-white dark:text-white uppercase tracking-wider">Uploaded By</th>
                  )}
                  <th className="px-4 sm:px-6 py-3 sm:py-4 text-left text-xs font-semibold text-white dark:text-white uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {isLoading ? (
                  <tr>
                    <td colSpan={(showUploadedByColumn ? 7 : 6) + (isAdmin ? 2 : 0)} className="px-6 py-16 sm:py-20 text-center">
                      <div className="flex flex-col items-center gap-4">
                        <LoadingSpinner size="lg" />
                        <div>
                          <p className="text-base sm:text-lg font-semibold text-slate-300">Loading selected schedule data</p>
                          <p className="text-xs sm:text-sm text-slate-500 mt-1">Fetching the selected plant/date first</p>
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : !hasLoadedReadiness ? (
                  <tr>
                    <td colSpan={(showUploadedByColumn ? 7 : 6) + (isAdmin ? 2 : 0)} className="px-6 py-16 sm:py-20 text-center">
                      <div className="flex flex-col items-center gap-4">
                        <div className="p-4 rounded-full bg-slate-800/50">
                          <FileText className="w-10 h-10 text-slate-600" />
                        </div>
                        <div>
                          <p className="text-base sm:text-lg font-semibold text-slate-400">Select filters and load data</p>
                          <p className="text-xs sm:text-sm text-slate-500 mt-1">Choose state, site, and operating date, then click Load</p>
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : filteredPlants.length === 0 ? (
                  <tr>
                    <td colSpan={(showUploadedByColumn ? 7 : 6) + (isAdmin ? 2 : 0)} className="px-6 py-16 sm:py-20 text-center">
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
                  const effectiveStatus = getEffectiveUiStatus(plant);
                  const sc = getStatusConfig(effectiveStatus);
                  const StatusIcon = statusIcons[effectiveStatus] || MinusCircle;
                  const PlantIcon = getPlantIcon(plant.plant_name);
                  const isSolar = plant.category === 'Solar';
                  const plantCode = String(plant?.plant_code || '').trim().toUpperCase();
                  const scheduleDate = String(plant?.schedule_date || '').trim();
                  const deriveGeneratedDateFromRevision = () => {
                    const dateKey = String(scheduleDate || '').trim();
                    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return null;
                    const rev = extractScheduleRevisionToken(plant?.file_key)
                      || extractScheduleRevisionToken(plant?.file_name)
                      || extractScheduleRevisionToken(plant?.template_file_name);
                    if (!Number.isFinite(rev)) return null;
                    // Generated time shown in UI is (block start + 8 min) in IST.
                    const hhmm = blockToTime(Number(rev), 8);
                    if (!hhmm) return null;
                    const [hh, mm] = String(hhmm).split(':').map((v) => String(v).padStart(2, '0'));
                    const dt = new Date(`${dateKey}T${hh}:${mm}:00+05:30`);
                    return Number.isNaN(dt.getTime()) ? null : dt;
                  };
                  const normalizedTriggerReason = normalizeTriggerReason(plant?.trigger_reason);
                  const inferredTriggerReason = normalizeTriggerReason(inferTriggerReasonFromRow(plant));
                  const displayTriggerReason = normalizedTriggerReason !== '-' ? normalizedTriggerReason : inferredTriggerReason;
                  const autoReasonInfo = normalizeAutoReason(displayTriggerReason);
                  let autoUploadText = '-';
                  let autoSubmitTimeText = '-';
                  let systemScheduleUploadTimeText = '-';
                  let systemScheduleUploadDecisionText = '-';
                  if (isAdmin && !plant?.is_day_ahead) {
                    const generatedFromRevision = deriveGeneratedDateFromRevision();
                    if (generatedFromRevision) {
                      systemScheduleUploadTimeText = generatedFromRevision
                        ? addMinutes(generatedFromRevision, AUTO_UPLOAD_OFFSET_MINUTES).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
                        : '-';
                    }
                  }
                  if (isAdmin && autoReasonInfo) {
                    const scheduleKey = String(plant?.file_key || plant?.source_file_key || '').trim();

                    const baseTimeIso = effectiveStatus === 'UPLOADED'
                      ? String(plant?.generated_at || plant?.template_generated_at || plant?.uploaded_at || '').trim()
                      : String(plant?.generated_at || '').trim();
                    const baseDate = baseTimeIso
                      ? (toDateFromIso(baseTimeIso) || new Date(baseTimeIso))
                      : (deriveGeneratedDateFromRevision() || null);
                    const slotIndex = baseDate && !Number.isNaN(baseDate.getTime())
                      ? getSlotIndexFromTimestamp(baseDate.toISOString())
                      : null;

                    if ((effectiveStatus === 'READY' || effectiveStatus === 'UPLOADED' || effectiveStatus === 'NO_ACTION') && Number.isFinite(slotIndex)) {
                      // When auto-upload is performed by backend worker, we may not have local slot records.
                      // In that case, prefer backend-provided `freeze_time` for submit-time display and treat it as auto-uploaded.
                      const backendFreezeIso = String(plant?.freeze_time || '').trim();
                      const backendFreezeDt = backendFreezeIso ? toDateFromIso(backendFreezeIso) : null;
                      const isBackendAuto = Boolean(plant?.auto_uploaded) && backendFreezeDt;
                      const slotKey = `${plantCode}|${scheduleDate}|${String(slotIndex)}`;
                      const slotUsedBySystem = Boolean(plant?.system_slot_used);
                      const slotRecord = readJsonLocal(autoSlotKey(plantCode, scheduleDate, slotIndex), null);
                      const slotKeyMatch = slotRecord && scheduleKey && String(slotRecord?.schedule_key || '').trim() === scheduleKey;
                      const slotWindow = formatAutoUploadSlotWindow(slotIndex);
                      const slotNote = slotWindow ? `slot ${slotWindow}` : '';

                      const formatAutoSubmitClock = (dt) => (
                        dt && !Number.isNaN(dt.getTime())
                          ? dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
                          : '-'
                      );

                      if (isBackendAuto) {
                        autoUploadText = describeAutoDecision({ decision: 'Auto-uploaded', reasonLabel: autoReasonInfo.label, note: slotNote });
                        autoSubmitTimeText = formatAutoSubmitClock(backendFreezeDt);
                      } else if (effectiveStatus !== 'UPLOADED') {
                        // For generated (READY/NO_ACTION) schedules, show whether system auto-upload can/has acted in this slot.
                        if (slotUsedBySystem) {
                          autoUploadText = describeAutoDecision({ decision: 'Not uploaded', reasonLabel: autoReasonInfo.label, note: [slotNote, 'slot used'].filter(Boolean).join(', ') });
                          autoSubmitTimeText = '-';
                        } else {
                          autoUploadText = describeAutoDecision({ decision: 'Auto-upload', reasonLabel: autoReasonInfo.label, note: [slotNote, 'slot available'].filter(Boolean).join(', ') });
                          autoSubmitTimeText = formatAutoSubmitClock(addMinutes(baseDate, AUTO_UPLOAD_OFFSET_MINUTES));
                        }
                      } else if (effectiveStatus === 'UPLOADED') {
                        const backendLooksAuto = backendFreezeDt && String(plant?.uploaded_by || '').toUpperCase().includes('SYSTEM');
                        if (backendLooksAuto) {
                          autoUploadText = describeAutoDecision({ decision: 'Auto-uploaded', reasonLabel: autoReasonInfo.label, note: slotNote });
                          autoSubmitTimeText = formatAutoSubmitClock(backendFreezeDt);
                        } else {
                        // For user-uploaded rows, do not label them as manual/system here; auto-upload column is about system automation only.
                        autoUploadText = slotKeyMatch
                          ? describeAutoDecision({ decision: 'Auto-uploaded', reasonLabel: autoReasonInfo.label, note: slotNote })
                          : '-';

                        if (slotKeyMatch) {
                          const freezeIso = String(slotRecord?.freeze_time || '').trim();
                          const freezeDt = freezeIso ? toDateFromIso(freezeIso) : null;
                          autoSubmitTimeText = freezeDt
                            ? formatAutoSubmitClock(freezeDt)
                            : formatAutoSubmitClock(addMinutes(baseDate, AUTO_UPLOAD_OFFSET_MINUTES));
                        }
                        }
                      } else {
                        const queue = readJsonLocal(autoQueueKey(plantCode, scheduleDate), []);
                        const queued = Array.isArray(queue) && queue.some((q) => String(q?.schedule_key || '').trim() === scheduleKey);
                        if (slotKeyMatch) {
                          autoUploadText = describeAutoDecision({ decision: 'Auto-uploaded', reasonLabel: autoReasonInfo.label, note: slotNote });
                          autoSubmitTimeText = formatAutoSubmitClock(addMinutes(baseDate, AUTO_UPLOAD_OFFSET_MINUTES));
                        } else if (slotRecord) {
                          autoUploadText = autoReasonInfo.queueable
                            ? describeAutoDecision({ decision: queued ? 'Queued' : 'Queued', reasonLabel: autoReasonInfo.label, note: [slotNote, 'slot used'].filter(Boolean).join(', ') })
                            : describeAutoDecision({ decision: 'Not uploaded', reasonLabel: autoReasonInfo.label, note: [slotNote, 'slot used'].filter(Boolean).join(', ') });
                        } else {
                          autoUploadText = describeAutoDecision({ decision: 'Auto-upload', reasonLabel: autoReasonInfo.label, note: [slotNote, 'slot available'].filter(Boolean).join(', ') });
                          autoSubmitTimeText = formatAutoSubmitClock(addMinutes(baseDate, AUTO_UPLOAD_OFFSET_MINUTES));
                        }
                      }
                    }
                  }
                  const deriveRevision = (row) => (
                    Number.isFinite(row?.schedule_revision)
                      ? row.schedule_revision
                      : extractScheduleRevisionToken(row?.file_key)
                        || extractScheduleRevisionToken(row?.file_name)
                        || extractScheduleRevisionToken(row?.template_file_name)
                  );
                  const samePlantDateRows = baseFilteredRows.filter((row) => (
                    String(row?.plant_code || '').trim().toUpperCase() === plantCode
                    && String(row?.schedule_date || '').trim() === scheduleDate
                    && !row?.is_day_ahead
                  ));
                  if (isAdmin && !plant?.is_day_ahead) {
                    const getSlotIndexFromSubmitBlock = (submitBlock) => {
                      const b = Number(submitBlock);
                      if (!Number.isFinite(b)) return null;
                      return Math.floor((Math.max(1, Math.min(96, Math.round(b))) - 1) / AUTO_UPLOAD_SLOT_BLOCKS);
                    };

                    const queueableByReason = (reason) => {
                      const r = String(reason || '').trim().toUpperCase();
                      // Rule: if a second schedule arrives in the same slot and its reason is ABRUPT_WEATHER,
                      // it should NOT be uploaded and should NOT be queued.
                      return r === 'CURTAILMENT' || r === 'PLANT_STATUS_CHANGE' || r === 'DYNAMIC_START';
                    };

                    const rowsForSlot = samePlantDateRows
                      .filter((r) => r?.file_key)
                      .map((r) => {
                        const rev = deriveRevision(r);
                        const slot = Number.isFinite(rev) ? getSlotIndexFromSubmitBlock(rev) : null;
                        const trig = normalizeTriggerReason(r?.trigger_reason) !== '-'
                          ? normalizeTriggerReason(r?.trigger_reason)
                          : normalizeTriggerReason(inferTriggerReasonFromRow(r));
                        return {
                          id: r.id,
                          key: String(r.file_key || '').trim(),
                          revision: Number.isFinite(rev) ? Number(rev) : null,
                          slotIndex: Number.isFinite(slot) ? Number(slot) : null,
                          trigger: trig,
                        };
                      })
                      .filter((r) => Number.isFinite(r.revision) && Number.isFinite(r.slotIndex))
                      .sort((a, b) => (a.revision - b.revision) || a.key.localeCompare(b.key));

                    const usedSlots = new Set();
                    const decisionByKey = new Map();
                    for (const r of rowsForSlot) {
                      const slot = r.slotIndex;
                      if (!usedSlots.has(slot)) {
                        usedSlots.add(slot);
                        decisionByKey.set(r.key, `UPLOAD (slot ${formatAutoUploadSlotWindow(slot) || slot})`);
                        continue;
                      }
                      if (!queueableByReason(r.trigger)) {
                        decisionByKey.set(r.key, `NOT UPLOAD (slot used: ${formatAutoUploadSlotWindow(slot) || slot})`);
                        continue;
                      }
                      // Queue to next available slot's first block.
                      let nextSlot = slot + 1;
                      while (usedSlots.has(nextSlot) && nextSlot <= 30) nextSlot += 1;
                      if (nextSlot > 30) {
                        decisionByKey.set(r.key, 'NOT UPLOAD (no slots left)');
                        continue;
                      }
                      usedSlots.add(nextSlot);
                      decisionByKey.set(r.key, `QUEUED → ${formatAutoUploadSlotWindow(nextSlot) || `slot ${nextSlot}`}`);
                    }
                    systemScheduleUploadDecisionText = decisionByKey.get(String(plant?.file_key || '').trim()) || '-';
                  }
                  const revisions = samePlantDateRows
                    .map((row) => deriveRevision(row))
                    .filter((rev) => Number.isFinite(rev));
                  const highestRevision = revisions.length ? Math.max(...revisions) : null;
                  const currentRevision = deriveRevision(plant);
                  const isLatestForActions = plant?.is_day_ahead
                    ? Boolean(plant?.is_latest)
                    : (
                      Number.isFinite(currentRevision) && Number.isFinite(highestRevision)
                        ? currentRevision === highestRevision
                        : Boolean(plant?.is_latest)
                    );
                  const scheduleDisplayLabel = replaceMachineScheduleNamesInText({
                    text: plant.file_name || getKeyBaseName(plant?.file_key || plant?.source_file_key || ''),
                    key: plant?.file_key || plant?.source_file_key,
                    plantCodeOrName: plant?.plant_code || plant?.plant_name,
                    scheduleDate: extractScheduleDateFromKey(plant?.file_key || plant?.source_file_key) || plant?.schedule_date || selectedDate,
                    isDayAhead: Boolean(plant?.is_day_ahead),
                    intradayRunIndex: plant?.intraday_run_index,
                  });
                  
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
                            <p className="text-sm sm:text-base font-semibold text-white group-hover:text-indigo-400 transition-colors">{toPlantDisplayName(plant.plant_name)}</p>
                            <p className="text-xs sm:text-sm text-slate-500">
                              {plant?.is_day_ahead
                                ? (plant?.file_key
                                  ? `Day-ahead schedule for ${plant?.schedule_date || ''}`.trim()
                                  : `Day-ahead missing for ${plant?.schedule_date || ''}`.trim())
                                : (scheduleDisplayLabel || (isLatestForActions ? 'Latest schedule available' : 'Older schedule'))}
                            </p>
                            {scheduleDisplayLabel && plant?.is_day_ahead ? (
                              <p className="text-xs text-slate-500 mt-1">{scheduleDisplayLabel}</p>
                            ) : null}
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
                        {displayTriggerReason !== '-' ? (
                          <div className="flex items-center gap-2">
                            <AlertTriangle className="w-5 h-5 text-amber-400" />
                            <span className="text-xs sm:text-sm font-medium text-amber-400">{displayTriggerReason}</span>
                          </div>
                        ) : (
                          <span className="text-xs sm:text-sm text-slate-500">-</span>
                        )}
                      </td>
                      <td className="px-4 sm:px-6 py-4 sm:py-5">
                        <span className="text-xs sm:text-sm text-slate-300">
                          {normalizeImportance(plant?.importance)}
                        </span>
                      </td>
                      {isAdmin && (
                        <>
                          <td className="px-4 sm:px-6 py-4 sm:py-5">
                            <span className="text-xs sm:text-sm text-slate-300">
                              {plant?.is_day_ahead ? '-' : systemScheduleUploadTimeText}
                            </span>
                          </td>
                          <td className="px-4 sm:px-6 py-4 sm:py-5">
                            <span className="text-xs sm:text-sm text-slate-300 whitespace-nowrap">
                              {plant?.is_day_ahead ? '-' : systemScheduleUploadDecisionText}
                            </span>
                          </td>
                        </>
                      )}
                      <td className="px-4 sm:px-6 py-4 sm:py-5">
                        <span className="text-xs sm:text-sm text-slate-300">
                          {effectiveStatus === 'UPLOADED' ? formatUploadedTime(plant.uploaded_at) : '-'}
                        </span>
                      </td>
                      {showUploadedByColumn && (
                        <td className="px-4 sm:px-6 py-4 sm:py-5">
                          <span className="text-xs sm:text-sm text-slate-300">
                            {(() => {
                              const raw = String(plant?.uploaded_by || '').trim();
                              const isSystemAuto = raw.toUpperCase() === 'SYSTEM_AUTO' || raw.toUpperCase() === 'SYSTEM AUTO' || raw.toUpperCase().includes('SYSTEM');
                              if (effectiveStatus !== 'UPLOADED') return '-';
                              // "Uploaded By" is a user-workflow field (who confirmed/uploaded to SLDC).
                              // Do not display system/automation markers here.
                              if (isSystemAuto) return '-';
                              if (!raw || raw.toLowerCase() === 'unknown') return '-';
                              return raw;
                            })()}
                          </span>
                        </td>
                      )}
                      <td className="px-4 sm:px-6 py-4 sm:py-5">
                        {plant?.ui_disable_actions ? (
                          <span className="text-xs sm:text-sm text-slate-500">-</span>
                        ) : (
                        <div className="flex flex-col sm:flex-row gap-2">
                          {plant?.is_day_ahead && effectiveStatus === 'NO_ACTION' && isLatestForActions && (
                            <button
                              onClick={() => handleHistoryClick(plant)}
                              className="w-full sm:w-auto px-3 sm:px-4 py-2 rounded-lg bg-slate-800 text-slate-200 text-xs sm:text-sm font-semibold hover:bg-slate-700 transition-all duration-300 flex items-center justify-center gap-2 border border-slate-700"
                            >
                              <Clock className="w-4 h-4" />
                              History
                            </button>
                          )}
                          {effectiveStatus === 'NO_ACTION' && isLatestForActions && !plant?.is_day_ahead && !isPastSelectedDate && (
                            <button 
                              onClick={() => handleActionClick(plant, 'revise')}
                              className="w-full sm:w-auto px-3 sm:px-4 py-2 rounded-lg bg-slate-800 text-white text-xs sm:text-sm font-semibold hover:bg-slate-700 transition-all duration-300 flex items-center justify-center gap-2 border border-slate-700"
                            >
                              <Upload className="w-4 h-4" />
                              Revise
                            </button>
                          )}
                          {effectiveStatus === 'READY' && isLatestForActions && !isPastSelectedDate && (
                            <>
                              <button 
                                data-guide-id="readiness-upload"
                                onClick={() => {
                                  workflowGuide?.start?.('prep_edit');
                                  handleReadyUpload(plant);
                                }}
                                className="w-full sm:w-auto px-3 sm:px-4 py-2 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 text-white text-xs sm:text-sm font-semibold hover:from-emerald-500 hover:to-teal-500 transition-all duration-300 flex items-center justify-center gap-2"
                              >
                                <Upload className="w-4 h-4" />
                                Upload
                              </button>
                            </>
                          )}
                          {effectiveStatus === 'UPLOADED' && (
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
                        </div>
                        )}
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
                  'bg-emerald-500/10'
                }`}>
                  {actionType === 'revise' && <Upload className="w-5 h-5 sm:w-6 sm:h-6 text-indigo-400" />}
                  {actionType === 'continue' && <ArrowRight className="w-5 h-5 sm:w-6 sm:h-6 text-amber-400" />}
                  {actionType === 'confirmUploaded' && <CheckCircle className="w-5 h-5 sm:w-6 sm:h-6 text-blue-400" />}
                </div>
                <div>
                  <h2 className={`text-lg sm:text-xl font-bold ${
                    actionType === 'confirmUploaded'
                      ? 'text-slate-900'
                      : 'text-white'
                  }`}>
                    {actionType === 'revise' && 'Trigger Schedule Revision'}
                    {actionType === 'continue' && 'Continue Existing Schedule'}
                    {actionType === 'confirmUploaded' && 'Upload Confirmation'}
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
              {actionType === 'confirmUploaded' && (
                <div className="p-4 bg-blue-500/10 border border-blue-500/20 rounded-xl">
                  <div className="flex items-start gap-3">
                    <CheckCircle className="w-6 h-6 text-blue-400 shrink-0" />
                    <div>
                      <p className="text-sm font-semibold text-black">Is this schedule uploaded to SLDC?</p>
                      <p className="text-xs sm:text-sm text-slate-300 mt-1">Select Yes to move this file from Ready to Uploaded section in Schedule Readiness.</p>
                    </div>
                  </div>
                </div>
              )}

            </div>
            <div className="p-4 sm:p-6 border-t border-slate-700 flex flex-col sm:flex-row gap-3">
              <button 
                onClick={() => setShowActionModal(false)}
                className={`w-full sm:flex-1 px-4 py-3 rounded-lg font-semibold transition-all duration-300 ${
                  actionType === 'confirmUploaded'
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
                        <th className="px-3 py-2 text-left font-semibold text-white dark:text-white whitespace-nowrap">Block</th>
                        <th className="px-3 py-2 text-left font-semibold text-white dark:text-white whitespace-nowrap">Block Interval</th>
                        <th className="px-3 py-2 text-left font-semibold text-white dark:text-white whitespace-nowrap">Availability</th>
                        <th className="px-3 py-2 text-left font-semibold text-white dark:text-white whitespace-nowrap">Forecast</th>
                        {isTelanganaStationSchedule && (
                          <th className="px-3 py-2 text-left font-semibold text-white dark:text-white whitespace-nowrap">Station Schedule</th>
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
