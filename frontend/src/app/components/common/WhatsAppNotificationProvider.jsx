import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api, scheduleReadinessApi, schedulesApi } from '@/services/api';
import {
  extractScheduleDateFromKey,
  formatMachineScheduleDisplayName,
} from '@/utils/machineScheduleDisplay';

const WhatsAppNotificationContext = createContext(null);

const STORAGE_KEY = 'vedanjay-whatsapp-notifications';
const LAST_SEEN_TS_KEY = 'vedanjay-whatsapp-last-seen-ts';
const LAST_BACKEND_TS_KEY = 'vedanjay-backend-notification-last-seen-ts';
const BROADCAST_KEY = 'vedanjay-live-notification-broadcast';
const CHANNEL_NAME = 'vedanjay-live-notifications';
const POLL_INTERVAL_MS = 30000;
const TAB_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

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

const getIstDateKey = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

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
  const hasInitializedRef = useRef(false);
  const lastSeenTsRef = useRef(0);
  const lastBackendTsRef = useRef(0);
  const pollInFlightRef = useRef(false);
  const channelRef = useRef(null);
  const audioRef = useRef(null);
  const isAudioUnlockedRef = useRef(false);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    const savedTs = localStorage.getItem(LAST_SEEN_TS_KEY);
    const savedBackendTs = localStorage.getItem(LAST_BACKEND_TS_KEY);
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

  const playAlertSound = () => {
    try {
      if (!isAudioUnlockedRef.current) return;
      if (!audioRef.current) {
        audioRef.current = new Audio('/notification.mp3');
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
      } else {
        const title = n.plant ? `WhatsApp updated: ${n.plant}` : 'WhatsApp updated';
        toast.info(title, {
          description: n.message ? String(n.message).slice(0, 140) : undefined,
          className: 'text-white',
          descriptionClassName: 'text-slate-100',
        });
      }
    });
    playAlertSound();
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
        const result = await api.whatsappInstant.listUpdates(baselineTs);
        const backendResult = await scheduleReadinessApi.getNotifications(false, null, 100);
        const intradayPlantsResult = await schedulesApi.listPlants({
          date: getIstDateKey(),
          type: 'intraday',
          limit: 800,
        }).catch(() => ({ items: [] }));
        const items = Array.isArray(result) ? result : [];
        const backendItemsRaw = Array.isArray(backendResult?.notifications)
          ? backendResult.notifications
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

        if (!hasInitializedRef.current) {
          hasInitializedRef.current = true;
          setNotifications((prev) => mergeNotificationsById(prev, [...parsedIntradayScheduleItems, ...parsedBackendItems, ...parsedWhatsAppItems]));
          return;
        }

        setNotifications((prev) => {
          const existingIds = new Set(prev.map((n) => n.id));
          const incoming = [...parsedWhatsAppItems, ...parsedBackendItems, ...parsedIntradayScheduleItems];
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

  const markAllSeen = () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, seen: true })));
  };

  const markSeen = (id) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, seen: true } : n)));
  };

  const clearAll = () => {
    setNotifications([]);
  };

  const value = useMemo(
    () => ({
      notifications,
      markAllSeen,
      markSeen,
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
    clearAll: () => {},
    playSound: () => {},
  };
}
