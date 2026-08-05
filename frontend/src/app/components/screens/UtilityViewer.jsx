import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarDays,
  Copy,
  Download,
  FileArchive,
  FileDown,
  FileSearch,
  FolderSearch,
  RefreshCcw,
  Search,
  Sigma,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/app/appContexts';
import { API_BASE_URL } from '@/config/appConfig';
import { useWhatsAppNotifications } from '@/app/components/common/WhatsAppNotificationProvider';
import { isAdminUser } from '@/utils/plantAccess';

const endpoint = (path) => `${API_BASE_URL}/utility-viewer${path}`;
const WBES_NOTIFICATION_SOUND = '/wbes-notification.mp3';
const WBES_NOTIFICATION_OFFSET_MINUTES = 6;
const WBES_AS_STORAGE_KEY = 'vedanjay-wbes-as-by-block';
const WBES_NOTIFICATION_LOG_STORAGE_KEY = 'vedanjay-wbes-notification-logs';
const WBES_NOTIFICATION_SENT_STORAGE_KEY = 'vedanjay-wbes-notification-sent';
const MAX_WBES_NOTIFICATION_LOGS = 60;
const WBES_NOTIFICATION_UTILITIES = ['Arinsun_RUMS', 'MSRPL_REWA_RUMS_S'];

const formatDateTime = (value) => {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleString('en-IN', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(value);
  }
};

const formatBytes = (value) => {
  const size = Number(value || 0);
  if (!Number.isFinite(size) || size <= 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let next = size;
  let unitIndex = 0;
  while (next >= 1024 && unitIndex < units.length - 1) {
    next /= 1024;
    unitIndex += 1;
  }
  return `${next.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
};

const getFileType = (fileName) => {
  const match = String(fileName || '').trim().match(/\.([A-Za-z0-9]+)$/);
  return match ? match[1].toUpperCase() : '-';
};

const csvEscape = (value) => {
  const text = String(value ?? '');
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
};

const downloadBlob = (blob, fileName) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

const normalizeNumber = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const formatNumber = (value) => {
  const numeric = normalizeNumber(value);
  if (numeric === null) return '-';
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(2).replace(/\.?0+$/, '');
};

const makeAsStorageKey = ({ utility, date, block }) =>
  [utility, date, block].map((value) => String(value || '').trim()).join('|');

const normalizeHeader = (value) =>
  String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');

const findColumn = (columns, candidates) => {
  const normalized = (Array.isArray(columns) ? columns : []).map((column) => normalizeHeader(column));
  const candidateTokens = candidates.map((candidate) => normalizeHeader(candidate));
  for (const needle of candidateTokens) {
    const exactIdx = normalized.findIndex((token) => token === needle);
    if (exactIdx >= 0) return columns[exactIdx];
  }
  for (const needle of candidateTokens) {
    const containsIdx = normalized.findIndex((token) => needle && token.includes(needle));
    if (containsIdx >= 0) return columns[containsIdx];
  }
  return '';
};

const getNextBlockInfo = (now = new Date()) => {
  const totalMinutes = (now.getHours() * 60) + now.getMinutes();
  const quarterStart = Math.floor(totalMinutes / 15) * 15;
  const start = (quarterStart + 15) % (24 * 60);
  const end = (start + 15) % (24 * 60);
  return {
    block: Math.floor(start / 15) + 1,
    interval: `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}-${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`,
  };
};

const getMsUntilNextWbesNotificationRun = (now = new Date()) => {
  const current = new Date(now);
  const totalMinutes = (current.getHours() * 60) + current.getMinutes();
  const currentQuarter = Math.floor(totalMinutes / 15) * 15;
  let runMinutes = currentQuarter + WBES_NOTIFICATION_OFFSET_MINUTES;
  if (totalMinutes > runMinutes || (totalMinutes === runMinutes && current.getSeconds() > 0)) {
    runMinutes += 15;
  }
  const nextRun = new Date(current);
  nextRun.setHours(Math.floor(runMinutes / 60) % 24, runMinutes % 60, 0, 0);
  if (runMinutes >= 24 * 60) {
    nextRun.setDate(nextRun.getDate() + 1);
  }
  return Math.max(0, nextRun.getTime() - current.getTime());
};

const getRowBlock = (row, columns, fallbackIndex) => {
  const blockColumn = findColumn(columns, ['block', 'block no', 'block number']);
  const blockValue = normalizeNumber(row?.[blockColumn]);
  if (blockValue !== null && blockValue >= 1 && blockValue <= 96) return Math.trunc(blockValue);

  const timeColumn = findColumn(columns, ['time', 'time slot', 'timeslot', 'block interval']);
  const match = String(row?.[timeColumn] || '').match(/(\d{1,2}):(\d{2})/);
  if (match) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const block = Math.floor(((hour * 60) + minute) / 15) + 1;
    if (block >= 1 && block <= 96) return block;
  }

  const fallbackBlock = fallbackIndex + 1;
  return fallbackBlock >= 1 && fallbackBlock <= 96 ? fallbackBlock : null;
};

const buildTargetTotal = (data, targetBlockInfo) => {
  const columns = data?.columns || [];
  const rows = data?.rows || [];
  const oaColumn = findColumn(columns, ['OA_REMC', 'OA REMC', 'OA-REMC', 'OAREMC']);
  const asColumn = findColumn(columns, ['AS']);
  const targetRow = rows.find((row, idx) => getRowBlock(row, columns, idx) === targetBlockInfo.block);
  const oaRemc = normalizeNumber(targetRow?.[oaColumn]);
  const asValue = normalizeNumber(targetRow?.[asColumn]);
  return {
    block: targetBlockInfo.block,
    interval: targetBlockInfo.interval,
    oa_remc: oaRemc,
    as: asValue,
    total: (oaRemc || 0) + (asValue || 0),
    oa_remc_column: oaColumn,
    as_column: asColumn,
  };
};

export function UtilityViewer() {
  const { user: currentUser } = useAuth() || {};
  const { addNotification, playSound } = useWhatsAppNotifications();
  const isAdmin = isAdminUser(currentUser);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const [utilities, setUtilities] = useState([]);
  const [dates, setDates] = useState([]);
  const [utility, setUtility] = useState('');
  const [date, setDate] = useState(today);
  const [latest, setLatest] = useState(null);
  const [loading, setLoading] = useState(false);
  const [metaLoading, setMetaLoading] = useState(false);
  const [rangeFrom, setRangeFrom] = useState(today);
  const [rangeTo, setRangeTo] = useState(today);
  const asSnapshotRef = useRef({});
  const notificationSentRef = useRef({});
  const audioRef = useRef(null);
  const audioUnlockedRef = useRef(false);
  const latestPollInFlightRef = useRef(false);
  const [wbesNotificationLogs, setWbesNotificationLogs] = useState([]);

  const columns = latest?.columns || [];
  const rows = latest?.rows || [];
  const scan = latest?.scan || [];
  const total = latest?.total || {};

  const latestFile = latest?.file || null;
  const latestFileLabel = latestFile?.name || 'No file loaded';
  const latestFileType = latestFile ? getFileType(latestFile.name) : '-';
  const latestFileSize = latestFile ? formatBytes(latestFile.size) : '-';
  const scanCount = scan.length;
  const previewMessage = loading
    ? 'Scanning folder and loading preview...'
    : latest?.file
      ? `${latest.file.name} • ${rows.length} preview rows${latest.row_count ? ` of ${latest.row_count}` : ''}`
      : 'Select utility and date to load latest file';

  const fetchJson = async (url) => {
    const response = await fetch(url);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = typeof data?.detail === 'string' ? data.detail : 'Request failed';
      throw new Error(detail);
    }
    return data;
  };

  const playWbesNotificationSound = () => {
    if (!isAdmin) return;
    try {
      if (!audioRef.current) {
        audioRef.current = new Audio(WBES_NOTIFICATION_SOUND);
        audioRef.current.preload = 'auto';
      }
      audioRef.current.currentTime = 0;
      void audioRef.current.play().catch(() => {});
    } catch {
      // Ignore browser audio failures.
    }
  };

  const persistWbesNotificationLog = (log) => {
    try {
      const userName = String(currentUser?.username || currentUser?.empId || '').trim();
      const role = String(currentUser?.role || '').trim();
      void fetch(`${API_BASE_URL}/wbes-notification-logs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Name': userName,
          'X-User-Role': role,
        },
        body: JSON.stringify(log),
      }).catch(() => {});
    } catch {
      // Keep WBES notification flow independent from audit-log persistence.
    }
  };

  const addWbesNotificationLog = (log) => {
    setWbesNotificationLogs((prev) => {
      const next = [log, ...prev].slice(0, MAX_WBES_NOTIFICATION_LOGS);
      try {
        localStorage.setItem(WBES_NOTIFICATION_LOG_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage failures.
      }
      return next;
    });
    persistWbesNotificationLog(log);
  };

  const inspectTransdownChange = (data, selectedUtility, selectedDate, options = {}) => {
    const totalInfo = data?.total || {};
    const block = totalInfo.block;
    const nextAs = normalizeNumber(totalInfo.as);
    if (!selectedUtility || !selectedDate || !block) return;

    const storageKey = makeAsStorageKey({ utility: selectedUtility, date: selectedDate, block });
    asSnapshotRef.current = {
      ...asSnapshotRef.current,
      [storageKey]: nextAs,
    };
    try {
      localStorage.setItem(WBES_AS_STORAGE_KEY, JSON.stringify(asSnapshotRef.current));
    } catch {
      // Ignore storage failures.
    }

    const notificationKey = [
      selectedUtility,
      selectedDate,
      block,
      totalInfo.interval || '',
      data?.file?.modified_at || data?.file?.name || '',
      options.scheduledAt || '',
    ].join('|');
    if (notificationSentRef.current?.[notificationKey]) return;
    notificationSentRef.current = {
      ...notificationSentRef.current,
      [notificationKey]: true,
    };
    try {
      localStorage.setItem(WBES_NOTIFICATION_SENT_STORAGE_KEY, JSON.stringify(notificationSentRef.current));
    } catch {
      // Ignore storage failures.
    }

    const statusText = nextAs === null
      ? 'AS value unavailable'
      : nextAs > 0
        ? 'Transdown applied'
        : nextAs === 0
          ? 'Transdown zero'
          : 'Transdown removed';
    const message = `Block ${block}${totalInfo.interval ? ` (${totalInfo.interval})` : ''}: OA_REMC = ${formatNumber(
      totalInfo.oa_remc
    )}, AS = ${formatNumber(nextAs)}, Total = ${formatNumber(totalInfo.total)}, ${statusText}`;

    addNotification?.({
      id: `wbes:${notificationKey}`,
      source: 'wbes',
      title: `${selectedUtility} ${statusText}`,
      message,
      plant: selectedUtility,
      createdAt: new Date().toISOString(),
      timestamp: new Date().toISOString(),
      seen: false,
    });
    toast.info(message);
    if (isAdmin) {
      playSound?.(WBES_NOTIFICATION_SOUND);
    }
    playWbesNotificationSound();
    addWbesNotificationLog({
      id: notificationKey,
      createdAt: new Date().toISOString(),
      utility: selectedUtility,
      date: selectedDate,
      block,
      interval: totalInfo.interval || '',
      oa_remc: totalInfo.oa_remc,
      as: nextAs,
      total: totalInfo.total,
      status: statusText,
      fileName: data?.file?.name || '',
      message,
    });
  };

  const loadUtilities = async () => {
    setMetaLoading(true);
    try {
      const data = await fetchJson(endpoint('/utilities'));
      const items = Array.isArray(data.items) ? data.items : [];
      setUtilities(items);
      if (!utility && items[0]?.name) setUtility(items[0].name);
    } catch (error) {
      toast.error(error.message || 'Failed to load utilities');
    } finally {
      setMetaLoading(false);
    }
  };

  const loadDates = async (selectedUtility) => {
    if (!selectedUtility) return;
    setMetaLoading(true);
    try {
      const data = await fetchJson(endpoint(`/dates?utility=${encodeURIComponent(selectedUtility)}`));
      const items = Array.isArray(data.items) ? data.items : [];
      setDates(items);
      if (items.length && !items.some((item) => item.date === date)) {
        setDate(items[0].date);
        setRangeFrom(items[0].date);
        setRangeTo(items[0].date);
      }
    } catch (error) {
      toast.error(error.message || 'Failed to load date folders');
      setDates([]);
    } finally {
      setMetaLoading(false);
    }
  };

  const loadLatest = async ({ silent = false, notificationRun = false, targetBlockInfo = null, scheduledAt = '' } = {}) => {
    if (!utility || !date) {
      if (!silent) toast.error('Select utility and date');
      return;
    }
    if (latestPollInFlightRef.current) return;
    latestPollInFlightRef.current = true;
    if (!silent) setLoading(true);
    try {
      const data = await fetchJson(
        endpoint(`/latest?utility=${encodeURIComponent(utility)}&date=${encodeURIComponent(date)}`)
      );
      const nextData = notificationRun && targetBlockInfo
        ? { ...data, total: buildTargetTotal(data, targetBlockInfo) }
        : data;
      setLatest(nextData);
      if (notificationRun) {
        inspectTransdownChange(nextData, utility, date, { scheduledAt });
      }
      if (!silent && !data.file) toast.warning('No supported file found for selected utility/date');
    } catch (error) {
      if (!silent) {
        toast.error(error.message || 'Failed to load latest file');
        setLatest(null);
      }
    } finally {
      latestPollInFlightRef.current = false;
      if (!silent) setLoading(false);
    }
  };

  const runUtilityNotificationFetch = async ({ targetBlockInfo, scheduledAt } = {}) => {
    const selectedDate = String(date || '').trim();
    if (!selectedDate) return;
    const configured = new Set(WBES_NOTIFICATION_UTILITIES.map((name) => String(name || '').trim()).filter(Boolean));
    const available = (utilities || [])
      .map((item) => String(item?.name || '').trim())
      .filter((name) => configured.has(name));
    const utilityNames = available.length ? available : Array.from(configured);
    await Promise.allSettled(
      utilityNames.map(async (utilityName) => {
        const data = await fetchJson(
          endpoint(`/latest?utility=${encodeURIComponent(utilityName)}&date=${encodeURIComponent(selectedDate)}`)
        );
        const nextData = targetBlockInfo
          ? { ...data, total: buildTargetTotal(data, targetBlockInfo) }
          : data;
        inspectTransdownChange(nextData, utilityName, selectedDate, { scheduledAt });
      })
    );
  };

  useEffect(() => {
    loadUtilities();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(WBES_AS_STORAGE_KEY) || '{}');
      asSnapshotRef.current = saved && typeof saved === 'object' ? saved : {};
    } catch {
      asSnapshotRef.current = {};
    }
    try {
      const logs = JSON.parse(localStorage.getItem(WBES_NOTIFICATION_LOG_STORAGE_KEY) || '[]');
      setWbesNotificationLogs(Array.isArray(logs) ? logs.slice(0, MAX_WBES_NOTIFICATION_LOGS) : []);
    } catch {
      setWbesNotificationLogs([]);
    }
    try {
      const sent = JSON.parse(localStorage.getItem(WBES_NOTIFICATION_SENT_STORAGE_KEY) || '{}');
      notificationSentRef.current = sent && typeof sent === 'object' ? sent : {};
    } catch {
      notificationSentRef.current = {};
    }
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin) return undefined;
    const unlockAudio = () => {
      if (audioUnlockedRef.current) return;
      audioUnlockedRef.current = true;
      try {
        if (!audioRef.current) {
          audioRef.current = new Audio(WBES_NOTIFICATION_SOUND);
          audioRef.current.preload = 'auto';
        }
        const audio = audioRef.current;
        const previousVolume = Number(audio.volume);
        audio.volume = 0;
        audio.currentTime = 0;
        const playPromise = audio.play();
        if (playPromise && typeof playPromise.then === 'function') {
          playPromise
            .then(() => {
              audio.pause();
              audio.currentTime = 0;
              audio.volume = Number.isFinite(previousVolume) ? previousVolume : 1;
            })
            .catch(() => {
              audio.volume = Number.isFinite(previousVolume) ? previousVolume : 1;
            });
        }
      } catch {
        // Ignore warm-up failures.
      }
    };
    window.addEventListener('click', unlockAudio, { once: true });
    window.addEventListener('keydown', unlockAudio, { once: true });
    window.addEventListener('touchstart', unlockAudio, { once: true, passive: true });
    return () => {
      window.removeEventListener('click', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
      window.removeEventListener('touchstart', unlockAudio);
    };
  }, []);

  useEffect(() => {
    if (!date) return undefined;
    let cancelled = false;
    let timer = null;

    const runNotificationFetch = () => {
      if (cancelled) return;
      const now = new Date();
      const targetBlockInfo = getNextBlockInfo(now);
      void runUtilityNotificationFetch({
        targetBlockInfo,
        scheduledAt: now.toISOString(),
      });
    };

    const scheduleNext = (skipCurrentWindow = false) => {
      if (cancelled) return;
      let delay = getMsUntilNextWbesNotificationRun();
      if (skipCurrentWindow && delay < 60 * 1000) {
        delay += 15 * 60 * 1000;
      }
      timer = window.setTimeout(() => {
        runNotificationFetch();
        scheduleNext(true);
      }, delay);
    };

    const now = new Date();
    const runImmediately = now.getMinutes() % 15 === WBES_NOTIFICATION_OFFSET_MINUTES;
    if (runImmediately) {
      runNotificationFetch();
    }
    scheduleNext(runImmediately);

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, utilities]);

  useEffect(() => {
    if (utility) loadDates(utility);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [utility]);

  const dateChips = useMemo(() => dates.slice(0, 12), [dates]);

  const exportCsv = () => {
    if (!columns.length) return;
    const lines = [
      columns.map(csvEscape).join(','),
      ...rows.map((row) => columns.map((column) => csvEscape(row?.[column])).join(',')),
    ];
    downloadBlob(
      new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' }),
      `${utility || 'WBES'}_${date || 'latest'}.csv`
    );
  };

  const exportXlsx = async () => {
    if (!columns.length) return;
    const XLSX = await import('xlsx');
    const worksheet = XLSX.utils.json_to_sheet(rows, { header: columns });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Preview');
    const data = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
    downloadBlob(
      new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      `${utility || 'WBES'}_${date || 'latest'}.xlsx`
    );
  };

  const exportRange = async () => {
    if (!utility || !rangeFrom || !rangeTo) {
      toast.error('Select utility and date range');
      return;
    }
    try {
      const response = await fetch(
        endpoint(
          `/export-range?utility=${encodeURIComponent(utility)}&from_date=${encodeURIComponent(
            rangeFrom
          )}&to_date=${encodeURIComponent(rangeTo)}`
        )
      );
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(typeof data?.detail === 'string' ? data.detail : 'ZIP export failed');
      }
      const blob = await response.blob();
      downloadBlob(blob, `WBES_Portal_${utility}_${rangeFrom}_to_${rangeTo}.zip`.replace(/[^A-Za-z0-9._-]+/g, '_'));
    } catch (error) {
      toast.error(error.message || 'Failed to export ZIP');
    }
  };

  return (
    <div className="min-h-full bg-background p-4 sm:p-6 space-y-5">
      <section className="bg-card border border-border rounded-lg p-5 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="h-11 w-11 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
              <FileSearch className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-foreground">WBES Portal</h1>
              <p className="text-sm text-muted-foreground">Folder scan, latest file preview, and utility-wise export.</p>
            </div>
          </div>
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
              {utilities.length || 0} utilities • {dates.length || 0} dates
            </div>
            <button
              onClick={loadUtilities}
              disabled={metaLoading}
              className="inline-flex items-center justify-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm hover:bg-accent disabled:opacity-60"
            >
              <RefreshCcw className={`h-4 w-4 ${metaLoading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>
      </section>

      <section className="bg-card border border-border rounded-lg p-4">
        <div className="grid grid-cols-1 lg:grid-cols-[1.15fr_0.85fr_auto] gap-3 items-end">
          <label className="space-y-1">
            <span className="text-sm font-medium text-muted-foreground">Utility</span>
            <select
              value={utility}
              onChange={(event) => setUtility(event.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Select utility</option>
              {utilities.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium text-muted-foreground">Date</span>
            <div className="relative">
              <CalendarDays className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <input
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                className="w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm"
              />
            </div>
          </label>
          <button
            onClick={loadLatest}
            disabled={loading}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            <Search className={`h-4 w-4 ${loading ? 'animate-pulse' : ''}`} />
            {loading ? 'Loading...' : 'Fetch Latest File'}
          </button>
        </div>
        {dateChips.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {dateChips.map((item) => (
              <button
                key={item.date}
                onClick={() => setDate(item.date)}
                className={`rounded-full border px-3 py-1 text-xs ${
                  date === item.date
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:bg-accent'
                }`}
              >
                {item.date}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Date</div>
          <div className="mt-2 text-xl font-semibold text-foreground">{date || '-'}</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Utility</div>
          <div className="mt-2 text-xl font-semibold text-foreground truncate">{utility || '-'}</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Latest file</div>
          <div className="mt-2 flex items-start justify-between gap-2">
            <div className="min-w-0 text-sm font-semibold text-foreground break-all whitespace-normal" title={latestFileLabel}>
              {latestFileLabel}
            </div>
            {latestFile?.name && (
              <button
                type="button"
                onClick={() => navigator.clipboard?.writeText(latestFile.name).then(() => toast.success('Filename copied')).catch(() => toast.error('Copy failed'))}
                className="shrink-0 rounded-md border border-border p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                title="Copy filename"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <span className="rounded-md border border-border bg-background px-2 py-1 text-muted-foreground">{latestFileType}</span>
            <span className="rounded-md border border-border bg-background px-2 py-1 text-muted-foreground">{latestFileSize}</span>
            <span className="rounded-md border border-border bg-background px-2 py-1 text-muted-foreground">{scanCount} files scanned</span>
          </div>
        </div>
      </section>

      <section className="bg-card border border-border rounded-lg p-4">
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
            <Sigma className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <div className="text-sm text-muted-foreground">Total = OA_REMC + AS</div>
            <div className="mt-1 text-2xl font-semibold text-foreground">{Number(total.total || 0).toFixed(2)}</div>
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm text-muted-foreground">
              <span>OA_REMC: {total.oa_remc ?? '-'}</span>
              <span>AS: {total.as ?? '-'}</span>
              <span>
                Block {total.block ?? '-'} {total.interval ? `(${total.interval})` : ''}
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="p-4 border-b border-border flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-base font-semibold text-foreground">Data Preview</h2>
            <p className="text-sm text-muted-foreground">
              {previewMessage}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={exportCsv}
              disabled={!columns.length}
              className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50"
            >
              <FileDown className="h-4 w-4" />
              CSV
            </button>
            <button
              onClick={exportXlsx}
              disabled={!columns.length}
              className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50"
            >
              <Download className="h-4 w-4" />
              XLSX
            </button>
          </div>
        </div>
        <div className="max-h-[520px] overflow-auto">
          {loading ? (
            <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">
              Scanning folder and preparing preview...
            </div>
          ) : (
            <table className="min-w-full border-separate border-spacing-0 text-sm">
              <thead className="sticky top-0 z-10 bg-muted">
                <tr>
                  {columns.length ? (
                    columns.map((column) => (
                      <th key={column} className="border-b border-r border-border px-3 py-2 text-left font-semibold whitespace-nowrap">
                        {column}
                      </th>
                    ))
                  ) : (
                    <th className="px-3 py-8 text-center text-muted-foreground">
                      {latest ? 'No preview rows found in the latest file' : 'Load a utility/date to preview data'}
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => (
                  <tr key={idx} className="odd:bg-background even:bg-muted/30">
                    {columns.map((column) => (
                      <td key={column} className="border-b border-r border-border px-3 py-2 whitespace-nowrap">
                        {row?.[column] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="bg-card border border-border rounded-lg p-4">
        <div className="flex items-center gap-2 mb-3">
          <FileArchive className="h-5 w-5 text-primary" />
          <h2 className="text-base font-semibold text-foreground">Date Range ZIP Download</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-3 items-end">
          <label className="space-y-1">
            <span className="text-sm text-muted-foreground">From</span>
            <input
              type="date"
              value={rangeFrom}
              onChange={(event) => setRangeFrom(event.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="space-y-1">
            <span className="text-sm text-muted-foreground">To</span>
            <input
              type="date"
              value={rangeTo}
              onChange={(event) => setRangeTo(event.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </label>
          <button
            onClick={exportRange}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <FileArchive className="h-4 w-4" />
            Download ZIP
          </button>
        </div>
      </section>

      <section className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="p-4 border-b border-border flex items-center gap-2">
          <FolderSearch className="h-5 w-5 text-primary" />
          <div>
            <h2 className="text-base font-semibold text-foreground">WBES Portal Folder Scan</h2>
            <p className="text-sm text-muted-foreground">{latest?.folder || 'Latest file folder scan appears here after preview loads'}</p>
          </div>
        </div>
        <div className="max-h-80 overflow-auto">
          <table className="min-w-full text-sm">
            <thead className="sticky top-0 bg-muted">
              <tr>
                <th className="px-3 py-2 text-left border-b border-border">File</th>
                <th className="px-3 py-2 text-left border-b border-border">Modified</th>
                <th className="px-3 py-2 text-left border-b border-border">Size</th>
              </tr>
            </thead>
            <tbody>
              {scan.length ? (
                scan.map((item) => (
                  <tr key={item.path} className="odd:bg-background even:bg-muted/30">
                    <td className="px-3 py-2 border-b border-border break-all">{item.name}</td>
                    <td className="px-3 py-2 border-b border-border">{formatDateTime(item.modified_at)}</td>
                    <td className="px-3 py-2 border-b border-border whitespace-nowrap">{formatBytes(item.size)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={3} className="px-3 py-8 text-center text-muted-foreground">
                    {loading ? 'Scanning folder...' : 'No folder scan loaded'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="border-t border-border p-4">
          <h3 className="text-sm font-semibold text-foreground">WBES Notification Log</h3>
          <div className="mt-3 max-h-72 overflow-auto rounded-md border border-border">
            <table className="min-w-full text-sm">
              <thead className="sticky top-0 bg-muted">
                <tr>
                  <th className="px-3 py-2 text-left border-b border-border">Time</th>
                  <th className="px-3 py-2 text-left border-b border-border">Block</th>
                  <th className="px-3 py-2 text-left border-b border-border">OA_REMC</th>
                  <th className="px-3 py-2 text-left border-b border-border">AS</th>
                  <th className="px-3 py-2 text-left border-b border-border">Total</th>
                  <th className="px-3 py-2 text-left border-b border-border">Status</th>
                  <th className="px-3 py-2 text-left border-b border-border">Latest File</th>
                </tr>
              </thead>
              <tbody>
                {wbesNotificationLogs.length ? (
                  wbesNotificationLogs.map((item) => (
                    <tr key={item.id || `${item.createdAt}-${item.block}`} className="odd:bg-background even:bg-muted/30">
                      <td className="px-3 py-2 border-b border-border whitespace-nowrap">{formatDateTime(item.createdAt)}</td>
                      <td className="px-3 py-2 border-b border-border whitespace-nowrap">
                        {item.block || '-'} {item.interval ? `(${item.interval})` : ''}
                      </td>
                      <td className="px-3 py-2 border-b border-border whitespace-nowrap">{formatNumber(item.oa_remc)}</td>
                      <td className="px-3 py-2 border-b border-border whitespace-nowrap">{formatNumber(item.as)}</td>
                      <td className="px-3 py-2 border-b border-border whitespace-nowrap">{formatNumber(item.total)}</td>
                      <td className="px-3 py-2 border-b border-border whitespace-nowrap">{item.status || '-'}</td>
                      <td className="px-3 py-2 border-b border-border break-all">{item.fileName || '-'}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">
                      No WBES notifications generated yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}

export default UtilityViewer;
