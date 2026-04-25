import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/services/api';

const WhatsAppNotificationContext = createContext(null);

const STORAGE_KEY = 'vedanjay-whatsapp-notifications';
const LAST_SEEN_TS_KEY = 'vedanjay-whatsapp-last-seen-ts';
const POLL_INTERVAL_MS = 30000;

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

export function WhatsAppNotificationProvider({ children }) {
  const [notifications, setNotifications] = useState([]);
  const [lastSeenTs, setLastSeenTs] = useState(0);
  const hasInitializedRef = useRef(false);
  const lastSeenTsRef = useRef(0);
  const pollInFlightRef = useRef(false);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    const savedTs = localStorage.getItem(LAST_SEEN_TS_KEY);
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
    let timer = null;
    let isMounted = true;

    const poll = async () => {
      if (pollInFlightRef.current) return;
      pollInFlightRef.current = true;
      try {
        const baselineTs = Number(lastSeenTsRef.current) || 0;
        const result = await api.whatsappInstant.listUpdates(baselineTs);
        const items = Array.isArray(result) ? result : [];
        if (!isMounted || items.length === 0) {
          if (!hasInitializedRef.current) hasInitializedRef.current = true;
          return;
        }

        const parsedItems = items
          .map((item) => ({
            id: String(item.id || ''),
            plant: item.plant || '',
            message: item.message || '',
            templateType: item.templateType || 'whatsapp',
            timestamp: item.timestamp || '',
            timestampMs: normalizeTimestampMs(item.timestamp_ms || item.timestamp) || 0,
            seen: false,
            source: 'whatsapp',
          }))
          .filter((item) => item.id);

        if (!parsedItems.length) {
          if (!hasInitializedRef.current) hasInitializedRef.current = true;
          return;
        }

        const maxTs = Math.max(...parsedItems.map((i) => i.timestampMs || 0), baselineTs);
        if (maxTs > baselineTs) {
          lastSeenTsRef.current = maxTs;
          setLastSeenTs(maxTs);
        }

        if (!hasInitializedRef.current) {
          hasInitializedRef.current = true;
          return;
        }

        setNotifications((prev) => {
          const existingIds = new Set(prev.map((n) => n.id));
          const fresh = parsedItems.filter((n) => !existingIds.has(n.id));
          if (!fresh.length) return prev;
          fresh.forEach((n) => {
            const title = n.plant ? `WhatsApp updated: ${n.plant}` : 'WhatsApp updated';
            toast.info(title, {
              description: n.message ? String(n.message).slice(0, 140) : undefined,
              className: 'text-white',
              descriptionClassName: 'text-slate-100',
            });
          });
          return [...fresh, ...prev];
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
  };
}
