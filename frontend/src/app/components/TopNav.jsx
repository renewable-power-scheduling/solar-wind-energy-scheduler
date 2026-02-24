import { useState, useEffect, useRef, useMemo } from 'react';
import {
  User,
  LogOut,
  Settings,
  Bell,
  ChevronDown,
  Menu,
  Moon,
  Sun,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { toast } from 'sonner';
import { S3_BASE_URL } from '@/config/appConfig';

// =============================================================================
// S3 NOTIFICATIONS CONFIG
// =============================================================================
const RAW_BASE_PREFIX = 'raw/vedanjay/GSNP/';
const GENERATED_OUTPUTS_BASE_PREFIX = 'generated/vedanjay/GSNP/outputs/';
const LEGACY_OUTPUTS_BASE_PREFIX = 'outputs/';
const NOTIF_STORAGE_KEY = 'vedanjay-s3-schedule-notifications';
const KNOWN_KEYS_STORAGE_KEY = 'vedanjay-s3-known-schedule-keys';

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

function getTodayPrefixes() {
  const today = new Date().toISOString().split('T')[0];
  return [
    `${RAW_BASE_PREFIX}${today}/`,
    `${GENERATED_OUTPUTS_BASE_PREFIX}${today}/`,
    `${LEGACY_OUTPUTS_BASE_PREFIX}${today}/`,
  ];
}

function isScheduleCsvKey(key) {
  const k = String(key || '').toLowerCase();
  const fileName = k.split('/').pop() || '';
  return (
    k.endsWith('.csv') &&
    !k.includes('/intraday/') &&
    (k.includes('schedule_from_') || fileName.startsWith('gsnp_dc_reg_'))
  );
}

export function TopNav({
  onToggleSidebar,
  isSidebarCollapsed,
  onLogout,
  user,
  isDarkMode,
  onToggleTheme,
}) {
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [knownKeys, setKnownKeys] = useState([]);
  const menuRef = useRef(null);
  const notifRef = useRef(null);

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
    if (savedNotifs) {
      try {
        setNotifications(JSON.parse(savedNotifs));
      } catch {
        setNotifications([]);
      }
    }
    if (savedKeys) {
      try {
        setKnownKeys(JSON.parse(savedKeys));
      } catch {
        setKnownKeys([]);
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(NOTIF_STORAGE_KEY, JSON.stringify(notifications));
  }, [notifications]);

  useEffect(() => {
    localStorage.setItem(KNOWN_KEYS_STORAGE_KEY, JSON.stringify(knownKeys));
  }, [knownKeys]);

  useEffect(() => {
    let timer = null;
    let isMounted = true;

    const poll = async () => {
      try {
        const prefixes = getTodayPrefixes();
        const objects = await listS3ObjectsAcrossPrefixes(prefixes);
        const uniqueObjects = Array.from(new Map(objects.map((o) => [o.key, o])).values());
        const scheduleFiles = uniqueObjects.filter((o) => isScheduleCsvKey(o.key));

        if (!isMounted) return;

        if (knownKeys.length === 0) {
          const initialKeys = scheduleFiles.map((o) => o.key);
          setKnownKeys(initialKeys);
          return;
        }

        const newFiles = scheduleFiles.filter((o) => !knownKeys.includes(o.key));
        if (newFiles.length > 0) {
          const now = new Date().toISOString();
          const newNotifs = newFiles.map((f) => ({
            id: `${f.key}::${f.lastModified || now}`,
            key: f.key,
            fileName: f.key.split('/').pop() || f.key,
            createdAt: f.lastModified || now,
            seen: false,
          }));
          setNotifications((prev) => [...newNotifs, ...prev]);
          setKnownKeys((prev) => [...prev, ...newFiles.map((f) => f.key)]);
          newNotifs.forEach((n) => {
            toast.info(`New schedule generated: ${n.fileName}`);
          });
        }
      } catch {
        // Silent fail: S3 may be unavailable or blocked by CORS
      }
    };

    poll();
    timer = setInterval(poll, 60000);
    return () => {
      isMounted = false;
      if (timer) clearInterval(timer);
    };
  }, [knownKeys]);

  const unseenCount = useMemo(
    () => notifications.filter((n) => !n.seen).length,
    [notifications]
  );

  const markAllSeen = () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, seen: true })));
  };

  const markSeen = (id) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, seen: true } : n)));
  };

  return (
    <header className="h-16 bg-card/95 backdrop-blur border-b border-border flex items-center justify-between px-4 md:px-6 sticky top-0 z-50 shadow-sm">
      <div className="flex items-center gap-3 flex-shrink-0">
        <button
          onClick={onToggleSidebar}
          className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-all"
          aria-label="Toggle navigation"
        >
          <Menu className="w-5 h-5 md:hidden" />
          {isSidebarCollapsed ? (
            <PanelLeftOpen className="w-5 h-5 hidden md:block" />
          ) : (
            <PanelLeftClose className="w-5 h-5 hidden md:block" />
          )}
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

      <div className="flex items-center gap-2 md:gap-3">
        <button
          onClick={onToggleTheme}
          className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-all"
          aria-label="Toggle theme"
          title={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {isDarkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
        </button>

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
                <div className="text-xs text-muted-foreground">Schedule files from S3</div>
              </div>
              <button
                onClick={() => setNotifications([])}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Clear all
              </button>
            </div>

            <div className="max-h-80 overflow-auto">
              {notifications.length === 0 ? (
                <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No notifications yet.
                </div>
              ) : (
                notifications.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => markSeen(n.id)}
                    className={`w-full text-left px-4 py-3 border-b border-border/60 hover:bg-accent/50 transition-colors ${
                      n.seen ? 'bg-transparent' : 'bg-primary/5'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 w-2 h-2 rounded-full bg-primary/80" />
                      <div className="flex-1">
                        <div className="text-sm font-medium text-foreground">
                          New schedule generated
                        </div>
                        <div className="text-xs text-muted-foreground break-all">
                          {n.fileName}
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-1">
                          {new Date(n.createdAt).toLocaleString()}
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
            className="flex items-center gap-2 md:gap-3 pl-3 md:pl-4 border-l border-border hover:border-primary/50 transition-colors"
          >
            <div className="hidden lg:block text-right">
              <div className="text-sm font-medium text-foreground">{user?.name || 'Admin'}</div>
              <div className="text-xs text-muted-foreground">Administrator</div>
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
                  <div className="text-sm font-medium text-foreground">{user?.name || 'Admin'}</div>
                  <div className="text-xs text-muted-foreground">{user?.email || 'admin@vedanjay.com'}</div>
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
