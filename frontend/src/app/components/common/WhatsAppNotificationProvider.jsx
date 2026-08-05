import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api, scheduleReadinessApi, schedulesApi } from '@/services/api';
import { API_BASE_URL } from '@/config/appConfig';
import {
  extractScheduleDateFromKey,
  formatMachineScheduleDisplayName,
} from '@/utils/machineScheduleDisplay';

const WhatsAppNotificationContext = createContext(null);

const STORAGE_KEY = 'vedanjay-whatsapp-notifications';
const LAST_SEEN_TS_KEY = 'vedanjay-whatsapp-last-seen-ts';
const LAST_BACKEND_TS_KEY = 'vedanjay-backend-notification-last-seen-ts';
const LAST_WBES_TS_KEY = 'vedanjay-wbes-notification-last-seen-ts';
const BROADCAST_KEY = 'vedanjay-live-notification-broadcast';
const CHANNEL_NAME = 'vedanjay-live-notifications';
const POLL_INTERVAL_MS = 30000;
const TAB_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const WBES_NOTIFICATION_SOUND = '/wbes-notification.mp3';
const WBES_NOTIFICATION_OFFSET_MINUTES = 6;
const WBES_AS_STORAGE_KEY = 'vedanjay-wbes-as-by-block';
const WBES_NOTIFICATION_SENT_STORAGE_KEY = 'vedanjay-wbes-notification-sent';
const WBES_NOTIFICATION_UTILITIES = ['Arinsun_RUMS', 'MSRPL_REWA_RUMS_S'];

const wbesEndpoint = (path) => `${API_BASE_URL}/utility-viewer${path}`;

const normalizeTimestampMs = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d{10,}$/.test(text)) {
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
};

const normalizeBackendTs = (item) =>
  normalizeTimestampMs(item?.created_at || item?.deadline || item?.createdAt) || Date.now();

const normalizeWbesTs = (item) =>
  normalizeTimestampMs(item?.createdAt || item?.created_at) || Date.now();

const getIstDateKey = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

const normalizeNumber = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const formatNumber = (value) => {
  const numeric = normalizeNumber(value);
  if (numeric === null) return '-';
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(2).replace(/\.?0+$/, '');
};

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

const getNextWbesBlockInfo = (now = new Date()) => {
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

const getWbesRowBlock = (row, columns, fallbackIndex) => {
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

const buildWbesTargetTotal = (data, targetBlockInfo) => {
  const columns = data?.columns || [];
  const rows = data?.rows || [];
  const oaColumn = findColumn(columns, ['OA_REMC', 'OA REMC', 'OA-REMC', 'OAREMC']);
  const asColumn = findColumn(columns, ['AS']);
  const targetRow = rows.find((row, idx) => getWbesRowBlock(row, columns, idx) === targetBlockInfo.block);
  const oaRemc = normalizeNumber(targetRow?.[oaColumn]);
  const asValue = normalizeNumber(targetRow?.[asColumn]);
  return {
    block: targetBlockInfo.block,
    interval: targetBlockInfo.interval,
    oa_remc: oaRemc,
    as: asValue,
    total: (oaRemc || 0) + (asValue || 0),
  };
};

const parseScheduleKeyTimestampMs = (key, fallback) => {
  const text = String(key || '');
  const match = text.match(/schedule_from_\d+_(\d{8})t(\d{6})\.csv$/i);
  if (!match) return normalizeTimestampMs(fallback) || Date.now();
  const [, day, time] = match;
  const iso = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}+05:30`;
  return normalizeTimestampMs(iso) || normalizeTimestampMs(fallback) || Date.now();
};

const toFinitePositiveNumber = (value, fallback = null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const mergeNotificationsById = (existing, incoming) => {
  const merged = [...(incoming || []), ...(existing || [])];
  const deduped = [];
  const seen = new Set();
  for (const item of merged) {
    const id = String(item?.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push(item);
  }
  return deduped.sort((a, b) => {
    const aTs = normalizeTimestampMs(a?.createdAt || a?.timestamp || 0) || 0;
    const bTs = normalizeTimestampMs(b?.createdAt || b?.timestamp || 0) || 0;
    return bTs - aTs;
  });
};

export function WhatsAppNotificationProvider({ children }) {
  const [notifications, setNotifications] = useState([]);
  const [lastSeenTs, setLastSeenTs] = useState(0);
  const [lastBackendTs, setLastBackendTs] = useState(0);
  const [lastWbesTs, setLastWbesTs] = useState(0);
  const hasInitializedRef = useRef(false);
  const lastSeenTsRef = useRef(0);
  const lastBackendTsRef = useRef(0);
  const lastWbesTsRef = useRef(0);
  const wbesNotificationSentRef = useRef({});
  const pollInFlightRef = useRef(false);
  const channelRef = useRef(null);
  const audioRef = useRef(null);
  const isAudioUnlockedRef = useRef(false);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    const savedTs = localStorage.getItem(LAST_SEEN_TS_KEY);
    const savedBackendTs = localStorage.getItem(LAST_BACKEND_TS_KEY);
    const savedWbesTs = localStorage.getItem(LAST_WBES_TS_KEY);
    const savedWbesSent = localStorage.getItem(WBES_NOTIFICATION_SENT_STORAGE_KEY);
    if (saved) {
      try {
        setNotifications(JSON.parse(saved) || []);
      } catch {
        setNotifications([]);
      }
    }
    if (savedTs) {
      const n = Number(savedTs);
      if (Number.isFinite(n)) {
        lastSeenTsRef.current = n;
        setLastSeenTs(n);
      }
    }
    if (savedBackendTs) {
      const n = Number(savedBackendTs);
      if (Number.isFinite(n)) {
        lastBackendTsRef.current = n;
        setLastBackendTs(n);
      }
    }
    if (savedWbesTs) {
      const n = Number(savedWbesTs);
      if (Number.isFinite(n)) {
        lastWbesTsRef.current = n;
        setLastWbesTs(n);
      }
    }
    if (savedWbesSent) {
      try {
        const parsed = JSON.parse(savedWbesSent);
        wbesNotificationSentRef.current = parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        wbesNotificationSentRef.current = {};
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notifications));
  }, [notifications]);

  useEffect(() => {
    if (Number.isFinite(lastSeenTs) && lastSeenTs > 0) {
      localStorage.setItem(LAST_SEEN_TS_KEY, String(lastSeenTs));
    }
  }, [lastSeenTs]);

  useEffect(() => {
    if (Number.isFinite(lastBackendTs) && lastBackendTs > 0) {
      localStorage.setItem(LAST_BACKEND_TS_KEY, String(lastBackendTs));
    }
  }, [lastBackendTs]);

  useEffect(() => {
    if (Number.isFinite(lastWbesTs) && lastWbesTs > 0) {
      localStorage.setItem(LAST_WBES_TS_KEY, String(lastWbesTs));
    }
  }, [lastWbesTs]);

  const playAlertSound = (soundPath = '/notification.mp3') => {
    try {
      if (!isAudioUnlockedRef.current) return;
      const nextSoundPath = soundPath || '/notification.mp3';
      if (!audioRef.current || audioRef.current.getAttribute('src') !== nextSoundPath) {
        audioRef.current = new Audio(nextSoundPath);
        audioRef.current.preload = 'auto';
      }
      audioRef.current.currentTime = 0;
      void audioRef.current.play().catch(() => {
        try {
          const AudioCtx = window.AudioContext || window.webkitAudioContext;
          if (!AudioCtx) return;
          const ctx = new AudioCtx();
          const oscillator = ctx.createOscillator();
          const gain = ctx.createGain();
          oscillator.type = 'sine';
          oscillator.frequency.value = 880;
          gain.gain.value = 0.03;
          oscillator.connect(gain);
          gain.connect(ctx.destination);
          oscillator.start();
          setTimeout(() => {
            oscillator.stop();
            ctx.close().catch(() => {});
          }, 160);
        } catch {
          // Ignore audio fallback failures.
        }
      });
    } catch {
      // Ignore sound failures.
    }
  };

  const notifyAndBroadcast = (freshItems) => {
    if (!Array.isArray(freshItems) || freshItems.length === 0) return;
    freshItems.forEach((n) => {
      if (n.source === 'backend') {
        const title = n.title || 'Schedule alert';
        toast.info(title, {
          description: n.message ? String(n.message).slice(0, 180) : undefined,
        });
      } else if (n.source === 'wbes') {
        const title = n.title || 'WBES transdown alert';
        toast.info(title, {
          description: n.message ? String(n.message).slice(0, 180) : undefined,
        });
      } else {
        const title = n.plant ? `WhatsApp updated: ${n.plant}` : 'WhatsApp updated';
        toast.info(title, {
          description: n.message ? String(n.message).slice(0, 140) : undefined,
          className: 'text-white',
          descriptionClassName: 'text-slate-100',
        });
      }
    });
    playAlertSound(freshItems.some((n) => n.source === 'wbes') ? WBES_NOTIFICATION_SOUND : undefined);
    const payload = JSON.stringify({
      tabId: TAB_ID,
      timestamp: Date.now(),
      notifications: freshItems,
    });
    localStorage.setItem(BROADCAST_KEY, payload);
    if (channelRef.current) {
      channelRef.current.postMessage(payload);
    }
  };

  const runWbesNotificationFetch = async ({ targetBlockInfo, scheduledAt } = {}) => {
    const selectedDate = getIstDateKey();
    const freshItems = [];
    await Promise.allSettled(
      WBES_NOTIFICATION_UTILITIES.map(async (utility) => {
        const response = await fetch(
          wbesEndpoint(`/latest?utility=${encodeURIComponent(utility)}&date=${encodeURIComponent(selectedDate)}`)
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data?.file) return;

        const totalInfo = targetBlockInfo
          ? buildWbesTargetTotal(data, targetBlockInfo)
          : data?.total || {};
        const block = totalInfo.block;
        const nextAs = normalizeNumber(totalInfo.as);
        if (!block) return;

        const notificationKey = [
          utility,
          selectedDate,
          block,
          totalInfo.interval || '',
          data?.file?.modified_at || data?.file?.name || '',
          scheduledAt || '',
        ].join('|');
        if (wbesNotificationSentRef.current?.[notificationKey]) return;

        wbesNotificationSentRef.current = {
          ...wbesNotificationSentRef.current,
          [notificationKey]: true,
        };
        try {
          localStorage.setItem(WBES_NOTIFICATION_SENT_STORAGE_KEY, JSON.stringify(wbesNotificationSentRef.current));
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
        const nowIso = new Date().toISOString();
        const item = {
          id: `wbes:${notificationKey}`,
          source: 'wbes',
          title: `${utility} ${statusText}`,
          message,
          plant: utility,
          createdAt: nowIso,
          timestamp: nowIso,
          timestampMs: Date.now(),
          seen: false,
        };
        freshItems.push(item);

        try {
          void fetch(`${API_BASE_URL}/wbes-notification-logs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: notificationKey,
              createdAt: nowIso,
              utility,
              date: selectedDate,
              block,
              interval: totalInfo.interval || '',
              oa_remc: totalInfo.oa_remc,
              as: nextAs,
              total: totalInfo.total,
              status: statusText,
              fileName: data?.file?.name || '',
              message,
            }),
          }).catch(() => {});
        } catch {
          // Keep notification display independent from audit-log persistence.
        }
      })
    );

    if (!freshItems.length) return;
    setNotifications((prev) => {
      const existingIds = new Set((prev || []).map((n) => n.id));
      const fresh = freshItems.filter((n) => !existingIds.has(n.id));
      if (!fresh.length) return prev;
      notifyAndBroadcast(fresh);
      return mergeNotificationsById(prev, fresh);
    });
  };

  useEffect(() => {
    const unlockAudio = () => {
      if (isAudioUnlockedRef.current) return;
      isAudioUnlockedRef.current = true;
      try {
        if (!audioRef.current) {
          audioRef.current = new Audio('/notification.mp3');
          audioRef.current.preload = 'auto';
        }
        // Warm-up playback in a user gesture so future notifications can play reliably.
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
        } else {
          audio.pause();
          audio.currentTime = 0;
          audio.volume = Number.isFinite(previousVolume) ? previousVolume : 1;
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
    if (typeof BroadcastChannel !== 'undefined') {
      channelRef.current = new BroadcastChannel(CHANNEL_NAME);
    }

    const consumeBroadcast = (raw) => {
      try {
        const parsed = JSON.parse(raw || '{}');
        if (!parsed || parsed.tabId === TAB_ID) return;
        const incoming = Array.isArray(parsed.notifications) ? parsed.notifications : [];
        if (!incoming.length) return;
        setNotifications((prev) => mergeNotificationsById(prev, incoming));
        playAlertSound();
      } catch {
        // Ignore malformed payloads.
      }
    };

    const onStorage = (event) => {
      if (event.key === STORAGE_KEY && event.newValue) {
        try {
          const parsed = JSON.parse(event.newValue);
          setNotifications(Array.isArray(parsed) ? parsed : []);
        } catch {
          // Ignore malformed storage data.
        }
        return;
      }
      if (event.key === BROADCAST_KEY && event.newValue) {
        consumeBroadcast(event.newValue);
      }
    };

    const onMessage = (event) => {
      consumeBroadcast(event?.data);
    };

    window.addEventListener('storage', onStorage);
    if (channelRef.current) channelRef.current.onmessage = onMessage;
    return () => {
      window.removeEventListener('storage', onStorage);
      if (channelRef.current) {
        channelRef.current.close();
      }
    };
  }, []);

  useEffect(() => {
    let timer = null;
    let isMounted = true;

    const poll = async () => {
      if (pollInFlightRef.current) return;
      pollInFlightRef.current = true;
      try {
        const baselineTs = Number(lastSeenTsRef.current) || 0;
        const baselineBackendTs = Number(lastBackendTsRef.current) || 0;
        const baselineWbesTs = Number(lastWbesTsRef.current) || 0;
        const result = await api.whatsappInstant.listUpdates(baselineTs);
        const backendResult = await scheduleReadinessApi.getNotifications(false, null, 100);
        const wbesResult = await fetch(`${API_BASE_URL}/wbes-notification-logs?limit=100`)
          .then((response) => (response.ok ? response.json() : { items: [] }))
          .catch(() => ({ items: [] }));
        const intradayPlantsResult = await schedulesApi.listPlants({
          date: getIstDateKey(),
          type: 'intraday',
          limit: 800,
        }).catch(() => ({ items: [] }));
        const items = Array.isArray(result) ? result : [];
        const backendItemsRaw = Array.isArray(backendResult?.notifications)
          ? backendResult.notifications
          : [];
        const wbesItemsRaw = Array.isArray(wbesResult?.items)
          ? wbesResult.items
          : [];
        const intradayPlantItems = Array.isArray(intradayPlantsResult?.items)
          ? intradayPlantsResult.items
          : [];
        if (!isMounted) {
          if (!hasInitializedRef.current) hasInitializedRef.current = true;
          return;
        }

        const parsedWhatsAppItems = items
          .map((item) => ({
            id: `wa:${String(item.id || '')}`,
            plant: item.plant || '',
            message: item.message || '',
            templateType: item.templateType || 'whatsapp',
            timestamp: item.timestamp || '',
            timestampMs: normalizeTimestampMs(item.timestamp_ms || item.timestamp) || 0,
            seen: false,
            source: 'whatsapp',
          }))
          .filter((item) => item.id);

        const parsedBackendItems = backendItemsRaw
          .map((item) => {
            const ts = normalizeBackendTs(item);
            return {
              id: `srn:${String(item.id || '')}`,
              plant: item.plant_name || '',
              message: item.message || '',
              title: item.title || 'Schedule alert',
              notificationType: item.notification_type || 'Schedule Alert',
              priority: item.priority || 'NORMAL',
              timestamp: item.created_at || '',
              timestampMs: ts,
              seen: Boolean(item.read),
              source: 'backend',
            };
          })
          .filter((item) => item.id && item.timestampMs > baselineBackendTs);

        const parsedWbesItems = wbesItemsRaw
          .map((item) => {
            const ts = normalizeWbesTs(item);
            const utility = String(item?.utility || '').trim();
            const status = String(item?.status || '').trim();
            const key = String(item?.notification_key || item?.id || '').trim();
            return {
              id: `wbes:${key || `${utility}:${item?.date || ''}:${item?.block || ''}:${ts}`}`,
              plant: utility,
              message: item.message || '',
              title: status ? `${utility} ${status}` : `${utility || 'WBES'} transdown alert`,
              notificationType: 'WBES transdown alert',
              timestamp: item.createdAt || item.created_at || '',
              timestampMs: ts,
              seen: false,
              source: 'wbes',
            };
          })
          .filter((item) => item.id && item.timestampMs > baselineWbesTs);

        const parsedIntradayScheduleItems = intradayPlantItems
          .map((item) => {
            const key = String(item?.latest_key || item?.key || '').trim();
            const plant = String(item?.plant_code || item?.plant || '').trim();
            if (!key || !plant) return null;
            const revision = Number(item?.revision);
            const ts = parseScheduleKeyTimestampMs(key, item?.last_modified);
            const baseName = key.split('/').pop() || key;
            const displayName = formatMachineScheduleDisplayName({
              baseName,
              key,
              plantCodeOrName: plant,
              scheduleDate: extractScheduleDateFromKey(key) || getIstDateKey(),
              isDayAhead: false,
              intradayRunIndex: toFinitePositiveNumber(
                item?.intraday_run_index || item?.run_index || item?.revision_rank,
                1
              ),
            });
            return {
              id: `s3:intraday:${plant}:${key}`,
              plant,
              message: displayName || (Number.isFinite(revision) ? `schedule_from_${revision}.csv` : baseName),
              title: 'Algo schedule generated',
              notificationType: 'Intraday Schedule Ready',
              priority: 'URGENT',
              timestamp: new Date(ts).toISOString(),
              timestampMs: ts,
              seen: false,
              source: 'backend',
            };
          })
          .filter(Boolean);

        const maxWaTs = parsedWhatsAppItems.length
          ? Math.max(...parsedWhatsAppItems.map((i) => i.timestampMs || 0), baselineTs)
          : baselineTs;
        if (maxWaTs > baselineTs) {
          lastSeenTsRef.current = maxWaTs;
          setLastSeenTs(maxWaTs);
        }

        const maxBackendTs = parsedBackendItems.length
          ? Math.max(...parsedBackendItems.map((i) => i.timestampMs || 0), baselineBackendTs)
          : baselineBackendTs;
        if (maxBackendTs > baselineBackendTs) {
          lastBackendTsRef.current = maxBackendTs;
          setLastBackendTs(maxBackendTs);
        }

        const maxWbesTs = parsedWbesItems.length
          ? Math.max(...parsedWbesItems.map((i) => i.timestampMs || 0), baselineWbesTs)
          : baselineWbesTs;
        if (maxWbesTs > baselineWbesTs) {
          lastWbesTsRef.current = maxWbesTs;
          setLastWbesTs(maxWbesTs);
        }

        if (!hasInitializedRef.current) {
          hasInitializedRef.current = true;
          setNotifications((prev) => mergeNotificationsById(prev, [...parsedIntradayScheduleItems, ...parsedBackendItems, ...parsedWbesItems, ...parsedWhatsAppItems]));
          return;
        }

        setNotifications((prev) => {
          const existingIds = new Set(prev.map((n) => n.id));
          const incoming = [...parsedWhatsAppItems, ...parsedBackendItems, ...parsedWbesItems, ...parsedIntradayScheduleItems];
          const fresh = incoming.filter((n) => !existingIds.has(n.id));
          if (!fresh.length) return prev;
          notifyAndBroadcast(fresh);
          return mergeNotificationsById(prev, fresh);
        });
      } catch {
        if (!hasInitializedRef.current) hasInitializedRef.current = true;
      } finally {
        pollInFlightRef.current = false;
      }
    };

    poll();
    timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      isMounted = false;
      if (timer) clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    const runNotificationFetch = () => {
      if (cancelled) return;
      const now = new Date();
      void runWbesNotificationFetch({
        targetBlockInfo: getNextWbesBlockInfo(now),
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
  }, []);

  const markAllSeen = () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, seen: true })));
  };

  const markSeen = (id) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, seen: true } : n)));
  };

  const addNotification = (notification) => {
    const nowIso = new Date().toISOString();
    const item = {
      id: notification?.id || `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source: notification?.source || 'local',
      title: notification?.title || 'Notification',
      message: notification?.message || '',
      plant: notification?.plant || '',
      createdAt: notification?.createdAt || nowIso,
      timestamp: notification?.timestamp || notification?.createdAt || nowIso,
      seen: false,
      ...notification,
    };
    setNotifications((prev) => mergeNotificationsById(prev, [item]));
  };

  const clearAll = () => {
    setNotifications([]);
  };

  const value = useMemo(
    () => ({
      notifications,
      markAllSeen,
      markSeen,
      addNotification,
      clearAll,
      playSound: playAlertSound,
    }),
    [notifications]
  );

  return (
    <WhatsAppNotificationContext.Provider value={value}>
      {children}
    </WhatsAppNotificationContext.Provider>
  );
}

export function useWhatsAppNotifications() {
  return useContext(WhatsAppNotificationContext) || {
    notifications: [],
    markAllSeen: () => {},
    markSeen: () => {},
    addNotification: () => {},
    clearAll: () => {},
    playSound: () => {},
  };
}
