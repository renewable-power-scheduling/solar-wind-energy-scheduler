import { useState, useEffect, useRef, useMemo } from 'react';
import {
  User,
  LogOut,
  Settings,
  Bell,
  ChevronDown,
  Menu,
} from 'lucide-react';
import { toast } from 'sonner';
import { S3_BASE_URL } from '@/config/appConfig';
import { useWhatsAppNotifications } from '@/app/components/common/WhatsAppNotificationProvider';
import {
  filterVisibleScheduleObjects,
  isAllowedNonFrozenReason,
  isAnyScheduleCsvKey,
  isFrozenScheduleCsvKey,
  isNonFrozenScheduleCsvKey,
} from '@/services/s3Utils';
import { getEmployeeName } from '@/utils/getEmployeeName.js';
import { getCurrentUserFromStorage, getDisabledPlantPattern } from '@/utils/plantAccess';
import { displayPlantName } from '@/utils/plantDisplay';
import {
  computeIntradayRunIndexByKey,
  extractScheduleDateFromKey,
  formatMachineScheduleDisplayName,
  replaceMachineScheduleNamesInText,
  slugifyPlant,
} from '@/utils/machineScheduleDisplay';

// =============================================================================
// S3 NOTIFICATIONS CONFIG
// =============================================================================
const RAW_BASE_PREFIXES = [
  'raw/vedanjay/BHUPALPALLY/',
  'raw/vedanjay/CME/',
  'raw/vedanjay/GSNP/',
  'raw/vedanjay/KASIPET/',
  'raw/vedanjay/KILAJ/',
  'raw/vedanjay/KOTHAGUDEM/',
  'raw/vedanjay/OSEPL/',
  'raw/vedanjay/ANJANGAON/',
  'raw/vedanjay/ANJANGOAN/',
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
  'generated/vedanjay/ANJANGAON/outputs/',
  'generated/vedanjay/SIRMOUR/outputs/',
  'generated/GSNP/gsnp/outputs/',
  'generated/Sirmour/sirmour/outputs/',
];
const LEGACY_OUTPUTS_BASE_PREFIX = 'outputs/';
const NOTIF_STORAGE_KEY = 'vedanjay-s3-schedule-notifications';
const KNOWN_KEYS_STORAGE_KEY = 'vedanjay-s3-known-schedule-keys';
const KNOWN_FREEZE_LOG_KEYS_STORAGE_KEY = 'vedanjay-s3-known-freeze-log-keys';

async function listS3Objects(prefix) {
  try {
    const proxyResp = await fetch('/api/s3/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [prefix], limit: 1500 }),
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

async function listS3ObjectsAcrossPrefixes(prefixes, disabledPattern = null) {
  const pattern = disabledPattern || getDisabledPlantPattern(getCurrentUserFromStorage());
  const safePrefixes = (prefixes || []).filter((prefix) => prefix && !pattern.test(prefix));
  if (safePrefixes.length === 0) return [];

  const concurrency = 4;
  const results = [];
  for (let i = 0; i < safePrefixes.length; i += concurrency) {
    const chunk = safePrefixes.slice(i, i + concurrency);
    const settled = await Promise.allSettled(chunk.map((prefix) => listS3Objects(prefix)));
    for (const r of settled) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) results.push(...r.value);
    }
  }
  return results;
}

function getTodayPrefixes(disabledPattern = null) {
  const pattern = disabledPattern || getDisabledPlantPattern(getCurrentUserFromStorage());
  const toLocalYmd = (value) => {
    const dt = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(dt.getTime())) return '';
    const yyyy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  };

  const addDays = (date, days) => {
    const dt = date instanceof Date ? new Date(date) : new Date(date);
    if (Number.isNaN(dt.getTime())) return new Date();
    dt.setDate(dt.getDate() + Number(days || 0));
    return dt;
  };

  // Notifications are shown for "today" (local date). Day-ahead schedules are stored under
  // the next operating date folder, so include Day-ahead prefixes for tomorrow.
  const today = toLocalYmd(new Date());
  const tomorrow = toLocalYmd(addDays(new Date(), 1));
  return [
    ...RAW_BASE_PREFIXES.filter((prefix) => prefix && !pattern.test(prefix)).map((prefix) => `${prefix}${today}/`),
    ...GENERATED_OUTPUTS_BASE_PREFIXES.filter((prefix) => prefix && !pattern.test(prefix)).map((prefix) => `${prefix}${today}/`),
    `${LEGACY_OUTPUTS_BASE_PREFIX}${today}/`,
    // Day-ahead schedules for tomorrow's operating day.
    ...GENERATED_OUTPUTS_BASE_PREFIXES.filter((prefix) => prefix && !pattern.test(prefix)).map((prefix) => `${prefix}${tomorrow}/Day-ahead/`),
    `${LEGACY_OUTPUTS_BASE_PREFIX}${tomorrow}/Day-ahead/`,
  ];
}

function isScheduleCsvKey(key) {
  const k = String(key || '').toLowerCase();
  return (
    k.endsWith('.csv') &&
    !k.includes('/intraday/') &&
    isAnyScheduleCsvKey(k)
  );
}

function isAlgoScheduleOutputKey(key) {
  const k = String(key || '').toLowerCase();
  return k.includes('/outputs/') && /schedule_from_\d+\.csv$/i.test(k);
}

function isDayAheadKey(key) {
  const k = String(key || '').toLowerCase();
  if (!k.endsWith('.csv')) return false;
  if (k.includes('/enercast_data/day_ahead/')) return false;
  return k.includes('/day-ahead/') || k.includes('/day_ahead/') || k.includes('/dayahead/');
}

function isFrozenLogKey(key) {
  const text = String(key || '');
  return /schedule_free(?:z|ze)_from_\d+\.log$/i.test(text) || /_frozen\.log$/i.test(text);
}

function getPlantNameFromKey(key) {
  const normalized = String(key || '').toLowerCase();
  const vedanjayMatch = normalized.match(/\/vedanjay\/([^/]+)\//);
  if (vedanjayMatch?.[1]) return displayPlantName(vedanjayMatch[1].toUpperCase());
  if (normalized.includes('/sirmour/')) return displayPlantName('SIRMOUR');
  if (normalized.includes('/gsnp/')) return displayPlantName('Globus Steel N Power (GSNP)');
  return displayPlantName('Unknown Plant');
}

function extractPlantCodeFromKey(key) {
  const normalized = String(key || '');
  const vedanjayMatch = normalized.match(/\/vedanjay\/([^/]+)\//i);
  if (vedanjayMatch?.[1]) return String(vedanjayMatch[1]).trim().toUpperCase();
  if (/\/sirmour\//i.test(normalized)) return 'SIRMOUR';
  if (/\/gsnp\//i.test(normalized)) return 'GSNP';
  return '';
}

function computeIntradayRunByKeyForNotifications(candidates) {
  const byGroup = new Map();
  for (const obj of candidates || []) {
    const key = String(obj?.key || '').trim();
    if (!key) continue;
    if (isDayAheadKey(key)) continue;
    const baseName = key.split('/').pop() || '';
    if (!/schedule_(?:free(?:z|ze)_)?from_\d+\.csv$/i.test(baseName)) continue;

    const scheduleDate = extractScheduleDateFromKey(key);
    const plantCode = extractPlantCodeFromKey(key);
    const plantSlug = slugifyPlant(plantCode);
    if (!scheduleDate || !plantSlug) continue;

    const groupKey = `${plantSlug}|${scheduleDate}`;
    if (!byGroup.has(groupKey)) byGroup.set(groupKey, []);
    byGroup.get(groupKey).push({ key });
  }

  const out = new Map();
  for (const [, group] of byGroup.entries()) {
    const runMap = computeIntradayRunIndexByKey(group);
    for (const [key, run] of runMap.entries()) out.set(key, run);
  }
  return out;
}

const isSameDay = (value, referenceDate = new Date()) => {
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return false;
  return dt.toLocaleDateString() === referenceDate.toLocaleDateString();
};

function shouldShowScheduleNotification(fileObj) {
  if (isFrozenScheduleCsvKey(fileObj?.key)) {
    const normalized = String(fileObj?.key || '').toLowerCase();
    return normalized.includes('/frozen/');
  }
  if (isAlgoScheduleOutputKey(fileObj?.key)) return true;
  if (isDayAheadKey(fileObj?.key)) return true;
  if (!isNonFrozenScheduleCsvKey(fileObj?.key)) return false;
  const reason = String(fileObj?.freeze_reason || '');
  return isAllowedNonFrozenReason(reason);
}

function shouldShowNotificationItem(item) {
  const kind = String(item?.kind || '').toLowerCase();
  if (kind === 'freeze') {
    return String(item?.freezeStatus || '').toLowerCase() !== 'discarded';
  }
  if (kind === 'frozen_csv') {
    return true;
  }
  if (kind === 'algo_output' || kind === 'day_ahead') {
    return true;
  }
  if (isNonFrozenScheduleCsvKey(item?.key)) {
    return isAllowedNonFrozenReason(String(item?.freezeReason || ''));
  }
  return false;
}

export function TopNav({
  onToggleSidebar,
  isSidebarCollapsed,
  onLogout,
  user,
}) {
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [knownKeys, setKnownKeys] = useState([]);
  const [knownFreezeLogKeys, setKnownFreezeLogKeys] = useState([]);
  const knownKeysRef = useRef([]);
  const knownFreezeLogKeysRef = useRef([]);
  const pollInFlightRef = useRef(false);
  const menuRef = useRef(null);
  const notifRef = useRef(null);
  const {
    notifications: whatsappNotifications,
    markAllSeen: markAllWhatsAppSeen,
    markSeen: markWhatsAppSeen,
    clearAll: clearWhatsAppNotifications,
    playSound: playNotificationSound,
  } = useWhatsAppNotifications();

  const disabledPlantPattern = useMemo(() => getDisabledPlantPattern(user), [user]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setShowUserMenu(false);
      }
      if (notifRef.current && !notifRef.current.contains(event.target)) {
        setShowNotifications(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    const savedNotifs = localStorage.getItem(NOTIF_STORAGE_KEY);
    const savedKeys = localStorage.getItem(KNOWN_KEYS_STORAGE_KEY);
    const savedKnownFreezeLogKeys = localStorage.getItem(KNOWN_FREEZE_LOG_KEYS_STORAGE_KEY);
    if (savedNotifs) {
      try {
        const today = new Date();
        const parsed = JSON.parse(savedNotifs);
        const filtered = Array.isArray(parsed)
          ? parsed
            .map((n) => {
              const item = { ...n };
              if (String(item?.kind || '').toLowerCase() === 'freeze') {
                item.fileName = String(item.fileName || '').replace(/\.log(\b|$)/i, '.csv$1');
              }
              return item;
            })
            .filter((n) => isSameDay(n.createdAt || n.timestamp, today) && shouldShowNotificationItem(n))
          : [];
        setNotifications(filtered);
      } catch {
        setNotifications([]);
      }
    }
    if (savedKeys) {
      try {
        const parsed = JSON.parse(savedKeys);
        knownKeysRef.current = Array.isArray(parsed) ? parsed : [];
        setKnownKeys(knownKeysRef.current);
      } catch {
        knownKeysRef.current = [];
        setKnownKeys([]);
      }
    }
    if (savedKnownFreezeLogKeys) {
      try {
        const parsed = JSON.parse(savedKnownFreezeLogKeys);
        knownFreezeLogKeysRef.current = Array.isArray(parsed) ? parsed : [];
        setKnownFreezeLogKeys(knownFreezeLogKeysRef.current);
      } catch {
        knownFreezeLogKeysRef.current = [];
        setKnownFreezeLogKeys([]);
      }
    }
  }, []);

  useEffect(() => {
    knownKeysRef.current = Array.isArray(knownKeys) ? knownKeys : [];
  }, [knownKeys]);

  useEffect(() => {
    knownFreezeLogKeysRef.current = Array.isArray(knownFreezeLogKeys) ? knownFreezeLogKeys : [];
  }, [knownFreezeLogKeys]);

  useEffect(() => {
    localStorage.setItem(NOTIF_STORAGE_KEY, JSON.stringify(notifications));
  }, [notifications]);

  useEffect(() => {
    localStorage.setItem(KNOWN_KEYS_STORAGE_KEY, JSON.stringify(knownKeys));
  }, [knownKeys]);

  useEffect(() => {
    localStorage.setItem(KNOWN_FREEZE_LOG_KEYS_STORAGE_KEY, JSON.stringify(knownFreezeLogKeys));
  }, [knownFreezeLogKeys]);

  useEffect(() => {
    let timer = null;
    let isMounted = true;

    const poll = async () => {
      if (pollInFlightRef.current) return;
      pollInFlightRef.current = true;
      try {
        const prefixes = getTodayPrefixes(disabledPlantPattern);
        const objects = await listS3ObjectsAcrossPrefixes(prefixes, disabledPlantPattern);
        const uniqueObjects = Array.from(new Map(objects.map((o) => [o.key, o])).values());
        const scheduleCandidates = uniqueObjects.filter((o) => isScheduleCsvKey(o.key));
        const scheduleFiles = await filterVisibleScheduleObjects(scheduleCandidates);
        const algoOutputFiles = uniqueObjects.filter((o) => isAlgoScheduleOutputKey(o.key));
        const dayAheadFiles = uniqueObjects.filter((o) => isDayAheadKey(o.key));
        const combinedCandidates = Array.from(
          new Map(
            [...scheduleFiles, ...algoOutputFiles, ...dayAheadFiles].map((o) => [o.key, o])
          ).values()
        );
        const freezeLogFiles = uniqueObjects.filter((o) => isFrozenLogKey(o.key));

        if (!isMounted) return;

        let initialized = false;
        if ((knownKeysRef.current || []).length === 0) {
          const initialKeys = combinedCandidates.map((o) => o.key);
          knownKeysRef.current = initialKeys;
          setKnownKeys(initialKeys);
          initialized = true;
        }
        if ((knownFreezeLogKeysRef.current || []).length === 0) {
          const initialFreezeKeys = freezeLogFiles.map((o) => o.key);
          knownFreezeLogKeysRef.current = initialFreezeKeys;
          setKnownFreezeLogKeys(initialFreezeKeys);
          initialized = true;
        }
        const today = new Date();
        const currentKnownKeys = knownKeysRef.current || [];
        const currentKnownFreezeKeys = knownFreezeLogKeysRef.current || [];
        const newFiles = combinedCandidates.filter((o) => !currentKnownKeys.includes(o.key));
        const newScheduleFiles = newFiles.filter((o) => shouldShowScheduleNotification(o));
        const newFreezeLogs = freezeLogFiles.filter((o) => !currentKnownFreezeKeys.includes(o.key));
        if (newFiles.length > 0) {
          const updated = [...currentKnownKeys, ...newFiles.map((f) => f.key)];
          knownKeysRef.current = updated;
          setKnownKeys(updated);
        }
        if (newScheduleFiles.length > 0) {
          const now = new Date().toISOString();
          const intradayRunByKey = computeIntradayRunByKeyForNotifications(combinedCandidates);
          const newNotifs = newScheduleFiles.map((f) => ({
            id: `${f.key}::${f.lastModified || now}`,
            key: f.key,
            fileName: f.key.split('/').pop() || f.key,
            displayFileName: (() => {
              const key = String(f?.key || '').trim();
              const baseName = key.split('/').pop() || key;
              const scheduleDate = extractScheduleDateFromKey(key);
              const plantCode = extractPlantCodeFromKey(key);
              return formatMachineScheduleDisplayName({
                baseName,
                key,
                plantCodeOrName: plantCode || getPlantNameFromKey(key),
                scheduleDate,
                isDayAhead: isDayAheadKey(key),
                intradayRunIndex: intradayRunByKey.get(key),
              });
            })(),
            plantName: getPlantNameFromKey(f.key),
            createdAt: f.lastModified || now,
            seen: false,
            freezeReason: String(f.freeze_reason || ''),
            kind: isFrozenScheduleCsvKey(f.key)
              ? 'frozen_csv'
              : isDayAheadKey(f.key)
                ? 'day_ahead'
                : isAlgoScheduleOutputKey(f.key)
                  ? 'algo_output'
                  : undefined,
          }));
          setNotifications((prev) => {
            const filteredPrev = (prev || []).filter((n) => isSameDay(n.createdAt || n.timestamp, today));
            return [...newNotifs, ...filteredPrev];
          });
          newNotifs.forEach((n) => {
            const displayName = String(n.displayFileName || n.fileName || '').trim() || n.fileName;
            if (String(n.kind || '').toLowerCase() === 'frozen_csv') {
              toast.success(`Frozen schedule generated: ${displayName}`);
            } else if (String(n.kind || '').toLowerCase() === 'day_ahead') {
              toast.info(`Day-ahead schedule received: ${displayName}`);
            } else if (String(n.kind || '').toLowerCase() === 'algo_output') {
              toast.success(`Algo schedule generated: ${displayName}`);
            } else {
              toast.info(`New schedule generated: ${displayName}`);
            }
          });
          try { playNotificationSound?.(); } catch {}
        }

        const now = new Date().toISOString();
        // Auto-freeze disabled; freezes happen only on SLDC confirmation.
        if (newFreezeLogs.length > 0) {
          const intradayRunByKey = computeIntradayRunByKeyForNotifications(combinedCandidates);
          const freezeNotifications = await Promise.all(
            newFreezeLogs.map(async (f) => {
              let status = 'Frozen';
              let reason = '';
              const logName = f.key.split('/').pop() || f.key;
              let freezeCsvName = logName.replace(/\.log$/i, '.csv');
              let storedScheduleKey = '';
              try {
                const encodedLogKey = String(f.key || '').split('/').map((segment) => encodeURIComponent(segment)).join('/');
                const logUrl = `${S3_BASE_URL}/${encodedLogKey}`;
                const payload = await fetch(logUrl).then((r) => (r.ok ? r.json() : null));
                const parsedStatus = String(payload?.status || '').trim();
                if (parsedStatus) status = parsedStatus;
                reason = String(payload?.reason || '').trim();
                if (payload?.stored_schedule_key) {
                  storedScheduleKey = String(payload.stored_schedule_key || '').trim();
                  const storedName = storedScheduleKey.split('/').pop();
                  if (storedName) freezeCsvName = storedName;
                }
              } catch {
                // Keep notification resilient even if log parsing fails.
              }
              const now = new Date().toISOString();
              const scheduleKeyForMeta = storedScheduleKey || String(f?.key || '').trim();
              const metaPlantCode = extractPlantCodeFromKey(scheduleKeyForMeta) || extractPlantCodeFromKey(f.key);
              const metaDate = extractScheduleDateFromKey(scheduleKeyForMeta) || extractScheduleDateFromKey(f.key);
              const displayFreezeName = replaceMachineScheduleNamesInText({
                text: `${freezeCsvName}${reason ? ` - ${reason}` : ''}`,
                key: scheduleKeyForMeta,
                plantCodeOrName: metaPlantCode || getPlantNameFromKey(scheduleKeyForMeta),
                scheduleDate: metaDate,
                isDayAhead: isDayAheadKey(scheduleKeyForMeta),
                intradayRunIndex: intradayRunByKey.get(storedScheduleKey || ''),
              });
              return {
                id: `${f.key}::${f.lastModified || now}`,
                key: f.key,
                fileName: `${freezeCsvName}${reason ? ` - ${reason}` : ''}`,
                displayFileName: displayFreezeName,
                plantName: getPlantNameFromKey(f.key),
                createdAt: f.lastModified || now,
                seen: false,
                kind: 'freeze',
                freezeStatus: status,
              };
            })
          );
          const visibleFreezeNotifications = freezeNotifications.filter(
            (n) => String(n?.freezeStatus || '').toLowerCase() !== 'discarded'
          );
          setNotifications((prev) => {
            const filteredPrev = (prev || []).filter((n) => isSameDay(n.createdAt || n.timestamp, today));
            return [...visibleFreezeNotifications, ...filteredPrev];
          });
          const updatedFreeze = [...currentKnownFreezeKeys, ...newFreezeLogs.map((f) => f.key)];
          knownFreezeLogKeysRef.current = updatedFreeze;
          setKnownFreezeLogKeys(updatedFreeze);
          visibleFreezeNotifications.forEach((n) => {
            const statusText = String(n.freezeStatus || '').toLowerCase();
            const displayName = String(n.displayFileName || n.fileName || '').trim() || n.fileName;
            if (statusText === 'discarded') {
              toast.info(`Auto-freeze discarded: ${displayName}`);
            } else {
              toast.success(`Frozen schedule generated: ${displayName}`);
            }
          });
        }
      } catch {
        // Silent fail: S3 may be unavailable or blocked by CORS
      } finally {
        pollInFlightRef.current = false;
      }
    };

    poll();
    timer = setInterval(poll, 60000);
    return () => {
      isMounted = false;
      if (timer) clearInterval(timer);
    };
  }, []);

  const combinedNotifications = useMemo(() => {
    const today = new Date();
    const s3NotifsRaw = notifications.map((n) => ({ ...n, source: 's3' }));
    const intradayRunByKey = computeIntradayRunByKeyForNotifications(s3NotifsRaw);
    const s3Notifs = s3NotifsRaw.map((n) => {
      if (n.displayFileName) return n;
      const key = String(n?.key || '').trim();
      const baseName = String(n?.fileName || '').trim();
      const scheduleDate = extractScheduleDateFromKey(key);
      const plantCode = extractPlantCodeFromKey(key);
      const display = replaceMachineScheduleNamesInText({
        text: baseName,
        key,
        plantCodeOrName: plantCode || getPlantNameFromKey(key),
        scheduleDate,
        isDayAhead: isDayAheadKey(key),
        intradayRunIndex: intradayRunByKey.get(key),
      });
      return { ...n, displayFileName: display };
    });
    const waNotifs = (whatsappNotifications || []).map((n) => ({
      ...n,
      source: 'whatsapp',
      createdAt: n.timestamp || n.createdAt,
    }));
    const todayOnly = [...waNotifs, ...s3Notifs].filter((n) => isSameDay(n.createdAt || n.timestamp, today));
    return todayOnly.sort((a, b) => {
      const aTime = Date.parse(a.createdAt || a.timestamp || '') || 0;
      const bTime = Date.parse(b.createdAt || b.timestamp || '') || 0;
      return bTime - aTime;
    });
  }, [notifications, whatsappNotifications]);

  const unseenCount = useMemo(
    () => combinedNotifications.filter((n) => !n.seen).length,
    [combinedNotifications]
  );

  const markAllSeen = () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, seen: true })));
    markAllWhatsAppSeen();
  };

  const markSeen = (id, source) => {
    if (source === 'whatsapp') {
      markWhatsAppSeen(id);
      return;
    }
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, seen: true } : n)));
  };

  return (
    <header className="h-16 bg-card/95 backdrop-blur border-b border-border flex items-center justify-between px-3 sm:px-4 md:px-6 sticky top-0 z-50 shadow-sm w-full min-w-0">
      <div className="flex items-center gap-3 min-w-0">
        <button
          onClick={onToggleSidebar}
          className="md:hidden p-2 rounded-lg border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-accent transition-all"
          aria-label="Open menu"
        >
          <Menu className="w-5 h-5" />
        </button>
        <div className="relative group flex items-center gap-3">
          <img
            src="/vedanjay logo.png"
            alt="Vedanjay logo"
            className="w-9 h-9 md:w-10 md:h-10 rounded-xl object-cover shadow-md transition-transform group-hover:scale-105"
          />
          <div className="hidden sm:block">
            <h1 className="text-sm md:text-base font-bold text-foreground tracking-tight">
              Vedanjay Power Control Dashboard
            </h1>
            <p className="text-xs text-muted-foreground font-medium">Energy Operations Center</p>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5 sm:gap-2 md:gap-3 min-w-0">
        <div ref={notifRef} className="relative">
          <button
            onClick={() => {
              const next = !showNotifications;
              setShowNotifications(next);
              if (next) markAllSeen();
            }}
            className="relative p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-all"
            aria-label="Notifications"
          >
            <Bell className="w-5 h-5" />
            {unseenCount > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-[10px] font-bold text-primary-foreground flex items-center justify-center">
                {unseenCount > 99 ? '99+' : unseenCount}
              </span>
            )}
          </button>

          <div
            className={`absolute right-0 top-full mt-2 w-96 max-w-[90vw] bg-card rounded-xl shadow-xl border border-border z-50 overflow-hidden transition-all duration-200 ${
              showNotifications ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none'
            }`}
          >
            <div className="px-4 py-3 border-b border-border bg-muted/40 flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-foreground">Notifications</div>
                  <div className="text-xs text-muted-foreground">Schedule and frozen files from S3</div>
                </div>
              <button
                onClick={() => {
                  setNotifications([]);
                  clearWhatsAppNotifications();
                }}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Clear all
              </button>
            </div>

            <div className="max-h-80 overflow-auto">
              {combinedNotifications.length === 0 ? (
                <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No notifications yet.
                </div>
              ) : (
                combinedNotifications.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => markSeen(n.id, n.source)}
                    className={`w-full text-left px-4 py-3 border-b border-border/60 hover:bg-accent/50 transition-colors ${
                      n.seen ? 'bg-transparent' : 'bg-primary/5'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 w-2 h-2 rounded-full bg-primary/80" />
                      <div className="flex-1">
                        <div className={`text-sm font-medium ${n.source === 'whatsapp' ? 'text-foreground' : 'text-foreground'}`}>
                          {n.source === 'whatsapp'
                            ? 'WhatsApp updated'
                            : n.source === 'backend'
                              ? (n.title || n.notificationType || 'Schedule alert')
                            : n.kind === 'freeze'
                              ? (String(n.freezeStatus || '').toLowerCase() === 'discarded' ? 'Auto-freeze discarded' : 'Frozen schedule generated')
                              : n.kind === 'frozen_csv'
                                ? 'Frozen schedule generated'
                                : n.kind === 'day_ahead'
                                  ? 'Day-ahead schedule received'
                                  : n.kind === 'algo_output'
                                    ? 'Algo schedule generated'
                                : 'New schedule generated'}
                        </div>
                        <div className={`text-xs break-all ${n.source === 'whatsapp' ? 'text-slate-100' : 'text-muted-foreground'}`}>
                          {n.source === 'whatsapp' || n.source === 'backend'
                            ? (n.message || 'New message received')
                            : (n.displayFileName || n.fileName)}
                        </div>
                        <div className={`text-xs mt-1 ${n.source === 'whatsapp' ? 'text-slate-100' : 'text-muted-foreground'}`}>
                          Plant: {n.plant || n.plantName || getPlantNameFromKey(n.key)}
                        </div>
                        <div className={`text-[10px] mt-1 ${n.source === 'whatsapp' ? 'text-slate-200' : 'text-muted-foreground'}`}>
                          {new Date(n.createdAt || n.timestamp || Date.now()).toLocaleString()}
                        </div>
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>

        <div ref={menuRef} className="user-menu-container relative">
          <button
            onClick={() => setShowUserMenu(!showUserMenu)}
            className="flex items-center gap-2 md:gap-3 pl-2 sm:pl-3 md:pl-4 border-l border-border hover:border-primary/50 transition-colors"
          >
            <div className="hidden lg:block text-right">
              <div className="text-sm font-medium text-foreground">{user?.name || 'Admin'}</div>
              <div className="text-xs text-muted-foreground">{user?.title || 'Administrator'}</div>
            </div>
            <div className="relative">
              <div className="w-8 h-8 md:w-9 md:h-9 rounded-full bg-primary/15 flex items-center justify-center transition-transform hover:scale-105">
                <User className="w-4 h-4 md:w-5 md:h-5 text-primary" />
              </div>
            </div>
            <ChevronDown
              className={`w-4 h-4 text-muted-foreground transition-transform ${showUserMenu ? 'rotate-180' : ''}`}
            />
          </button>

          <div
            className={`absolute right-0 top-full mt-2 w-56 bg-card rounded-xl shadow-xl border border-border py-2 z-50 overflow-hidden transition-all duration-200 ${
              showUserMenu ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none'
            }`}
          >
            <div className="px-4 py-3 border-b border-border bg-muted/40">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-primary/15 flex items-center justify-center">
                  <User className="w-5 h-5 text-primary" />
                </div>
              <div>
                  <div className="text-sm font-medium text-foreground">{getEmployeeName(user?.empId)}</div>
                  <div className="text-xs text-muted-foreground">{user?.title || 'Administrator'}</div>
                </div>
              </div>
            </div>

            <div className="py-1">
              <button
                onClick={() => setShowUserMenu(false)}
                className="w-full px-4 py-2.5 text-left text-sm text-muted-foreground hover:text-foreground hover:bg-accent flex items-center gap-3 transition-all"
              >
                <Settings className="w-4 h-4" />
                <span>Settings</span>
              </button>
              <button
                onClick={() => {
                  setShowUserMenu(false);
                  onLogout?.();
                }}
                className="w-full px-4 py-2.5 text-left text-sm text-red-500 hover:text-red-600 hover:bg-red-500/10 flex items-center gap-3 transition-all"
              >
                <LogOut className="w-4 h-4" />
                <span>Logout</span>
              </button>
            </div>

            <div className="px-4 py-2 border-t border-border bg-muted/30">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Version 2.0.0</span>
                <span>|</span>
                <span>Vedanjay Energy</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}


