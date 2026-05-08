import {
  useState,
  useMemo,
  useEffect,
  memo,
  lazy,
  Suspense,
} from 'react';
import { TopNav } from './components/TopNav';
import { Sidebar } from './components/Sidebar';
import Login from './components/screens/Login';
import { Toaster } from '@/app/components/ui/sonner';
import { LoadingSpinner } from './components/common/LoadingSpinner';
import { WhatsAppNotificationProvider } from '@/app/components/common/WhatsAppNotificationProvider';
import { isAdminUser } from '@/utils/plantAccess';
import { toast } from 'sonner';
import {
  FilterContext,
  DataContext,
  ThemeContext,
  AuthContext,
  WorkflowGuideContext,
} from './appContexts';

const Dashboard = lazy(() =>
  import('./components/screens/Dashboard').then((module) => ({ default: module.Dashboard }))
);
const SchedulePreparation = lazy(() =>
  import('./components/screens/SchedulePreparation').then((module) => ({
    default: module.SchedulePreparation,
  }))
);
const ScheduleReadinessDashboard = lazy(() =>
  import('./components/screens/ScheduleReadinessDashboard').then((module) => ({
    default: module.ScheduleReadinessDashboard,
  }))
);
const DataInputs = lazy(() =>
  import('./components/screens/DataInputs').then((module) => ({ default: module.DataInputs }))
);
const ForecastView = lazy(() =>
  import('./components/screens/ForecastView').then((module) => ({ default: module.ForecastView }))
);
const WeatherView = lazy(() =>
  import('./components/screens/WeatherView').then((module) => ({ default: module.WeatherView }))
);
const DeviationDSM = lazy(() =>
  import('./components/screens/DeviationDSM').then((module) => ({ default: module.DeviationDSM }))
);
const ScheduleTemplates = lazy(() =>
  import('./components/screens/ScheduleTemplates').then((module) => ({
    default: module.ScheduleTemplates,
  }))
);
const ScheduleComparison = lazy(() => import('./components/screens/ScheduleComparison'));
const FrozenSchedule = lazy(() =>
  import('./components/screens/FrozenSchedule').then((module) => ({ default: module.FrozenSchedule }))
);

const AUTH_USER_KEY = 'vedanjay-user';
const AUTH_TOKEN_KEY = 'vedanjay-token';
const AUTH_DAY_KEY = 'vedanjay-auth-day'; // Require re-login once per IST day.
const THEME_KEY = 'vedanjay-theme';
const ACTIVE_SCREEN_KEY = 'vedanjay-active-screen';
const EMPLOYEE_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const EMPLOYEE_IDLE_WARNING_MS = 28 * 60 * 1000;
const VALID_SCREENS = new Set([
  'dashboard',
  'schedule',
  'schedule-readiness',
  'data-inputs',
  'forecast',
  'weather',
  'deviation',
  'schedule-comparison',
  'frozen-schedule',
  'templates',
]);
const SCREEN_ORDER = [
  'dashboard',
  'schedule',
  'schedule-readiness',
  'data-inputs',
  'forecast',
  'weather',
  'deviation',
  'schedule-comparison',
  'frozen-schedule',
  'templates',
];

const ScreenSlot = memo(
  function ScreenSlot({ screenId, isActive, screenContext, globalFilters, sharedData, updateSharedData, clearSharedData, onNavigate }) {
    const props = {
      onNavigate,
      context: screenContext,
      filters: globalFilters,
      sharedData,
      updateSharedData,
      clearSharedData,
      isActive,
    };

    switch (screenId) {
      case 'dashboard':
        return <Dashboard {...props} />;
      case 'schedule':
        return <SchedulePreparation {...props} />;
      case 'schedule-readiness':
        return <ScheduleReadinessDashboard {...props} />;
      case 'data-inputs':
        return <DataInputs {...props} />;
      case 'forecast':
        return <ForecastView {...props} />;
      case 'weather':
        return <WeatherView {...props} filters={globalFilters} />;
      case 'deviation':
        return <DeviationDSM {...props} />;
      case 'schedule-comparison':
        return <ScheduleComparison {...props} />;
      case 'frozen-schedule':
        return <FrozenSchedule {...props} />;
      case 'templates':
        return <ScheduleTemplates {...props} filters={globalFilters} />;
      default:
        return null;
    }
  },
  (prev, next) => {
    // If a screen stays inactive, skip rerender even if global props change.
    if (!prev.isActive && !next.isActive && prev.screenId === next.screenId) return true;
    return false;
  }
);

export default function App() {
  const getIstDateKey = () =>
    new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  // First visit defaults to dashboard; subsequent refreshes restore last screen.
  const [activeScreen, setActiveScreen] = useState(() => {
    try {
      const saved = localStorage.getItem(ACTIVE_SCREEN_KEY);
      return VALID_SCREENS.has(saved) ? saved : 'dashboard';
    } catch {
      return 'dashboard';
    }
  });
  const [screenContext, setScreenContext] = useState(null);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'light');
  const [currentUser, setCurrentUser] = useState(() => {
    try {
      const user = localStorage.getItem(AUTH_USER_KEY);
      return user ? JSON.parse(user) : null;
    } catch {
      return null;
    }
  });

  const isAdmin = isAdminUser(currentUser);

  // All screens are always active for both admin and employee.
  const allowedScreens = useMemo(() => new Set(Array.from(VALID_SCREENS)), []);

  const [globalFilters, setGlobalFilters] = useState({
    search: '',
    date: '',
    state: 'All States',
    plant: 'All Plants',
  });

  const [sharedData, setSharedData] = useState({
    forecastData: null,
    meterData: null,
    selectedPlant: null,
    dateRange: null,
  });

  // Keep visited screens mounted so navigating back doesn't "reload" everything.
  // This reduces repeat S3 listing + parsing work caused by unmount/remount.
  const [mountedScreens, setMountedScreens] = useState(() => new Set(['dashboard']));
  useEffect(() => {
    setMountedScreens((prev) => {
      const next = new Set(prev);
      if (VALID_SCREENS.has(activeScreen) && (isAdmin || activeScreen !== 'frozen-schedule')) {
        next.add(activeScreen);
      }
      return next;
    });
  }, [activeScreen, isAdmin]);

  useEffect(() => {
    if (isAdmin) return;
    if (activeScreen !== 'frozen-schedule') return;
    setActiveScreen('dashboard');
    setScreenContext(null);
    try {
      localStorage.setItem(ACTIVE_SCREEN_KEY, 'dashboard');
    } catch {
      // ignore storage errors
    }
  }, [activeScreen, isAdmin]);

  const isAuthenticated = Boolean(
    currentUser &&
      localStorage.getItem(AUTH_TOKEN_KEY) &&
      localStorage.getItem(AUTH_DAY_KEY) === getIstDateKey()
  );

  useEffect(() => {
    // Enforce "login once per day" in IST. If the day changed, clear auth and show login screen.
    try {
      const storedDay = localStorage.getItem(AUTH_DAY_KEY);
      const todayIst = getIstDateKey();
      if (storedDay && storedDay !== todayIst) {
        localStorage.removeItem(AUTH_USER_KEY);
        localStorage.removeItem(AUTH_TOKEN_KEY);
        localStorage.removeItem(AUTH_DAY_KEY);
        localStorage.removeItem(ACTIVE_SCREEN_KEY);
        setCurrentUser(null);
        setActiveScreen('dashboard');
        setScreenContext(null);
      }
    } catch {
      // Ignore storage errors.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.title = 'Vedanjay Power Control Dashboard';
  }, []);

  useEffect(() => {
    const normalizedTheme = theme === 'dark' ? 'dark' : 'light';
    localStorage.setItem(THEME_KEY, normalizedTheme);

    document.documentElement.classList.remove('dark', 'light');
    document.body.classList.remove('theme-dark', 'theme-light');

    document.documentElement.classList.add(normalizedTheme);
    document.body.classList.add(`theme-${normalizedTheme}`);
    document.body.setAttribute('data-theme', normalizedTheme);
  }, [theme]);

  const handleNavigate = (screen, context) => {
    const safeScreen =
      !isAdmin && screen === 'frozen-schedule' ? 'dashboard' : screen;

    setActiveScreen(safeScreen);
    setScreenContext(safeScreen === screen ? (context || null) : null);
    setIsMobileMenuOpen(false);
    try {
      if (VALID_SCREENS.has(safeScreen)) {
        localStorage.setItem(ACTIVE_SCREEN_KEY, safeScreen);
      }
    } catch {
      // Ignore storage errors.
    }
  };

  const updateFilters = (newFilters) => {
    setGlobalFilters((prev) => ({ ...prev, ...newFilters }));
  };

  const updateSharedData = (newData) => {
    setSharedData((prev) => ({ ...prev, ...newData }));
  };

  const clearSharedData = () => {
    setSharedData({
      forecastData: null,
      meterData: null,
      selectedPlant: null,
      dateRange: null,
    });
  };

  const handleLogin = (userData) => {
    setCurrentUser(userData);
    setActiveScreen('dashboard');
    try {
      localStorage.setItem(ACTIVE_SCREEN_KEY, 'dashboard');
    } catch {
      // Ignore storage errors.
    }
  };

  const handleLogout = () => {
    localStorage.removeItem(AUTH_USER_KEY);
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_DAY_KEY);
    localStorage.removeItem(ACTIVE_SCREEN_KEY);
    setCurrentUser(null);
    setActiveScreen('dashboard');
    setScreenContext(null);
  };

  const workflowGuideValue = useMemo(() => {
    const STEP_KEY = 'vedanjay-ui-workflow-guide-step-v1';

    const steps = {
      readiness_upload: {
        title: 'Start Upload Workflow',
        message: 'Click Upload in Schedule Readiness to begin.',
        targets: ['[data-guide-id="readiness-upload"]'],
        next: 'prep_edit',
      },
      prep_edit: {
        title: 'Edit or Submit',
        message: 'Optional: click Edit to modify blocks. If no changes are needed, click Submit Changes.',
        targets: ['[data-guide-id="prep-edit"]', '[data-guide-id="prep-submit"]'],
        next: 'prep_save',
      },
      prep_save: {
        title: 'Save Changes',
        message: 'Click Save (READY flow) or Force Save (manual) before submitting.',
        targets: ['[data-guide-id="prep-save"]', '[data-guide-id="prep-force-save"]'],
        next: 'prep_submit',
      },
      prep_save_ready: {
        title: 'Save Changes',
        message: 'This schedule is in READY flow. Click Save, then submit.',
        targets: ['[data-guide-id="prep-save"]'],
        next: 'prep_submit',
      },
      prep_force_save: {
        title: 'Force Save Changes',
        message: 'Click Force Save to save your changes (direct/manual flow), then submit.',
        targets: ['[data-guide-id="prep-force-save"]'],
        next: 'prep_submit',
      },
      prep_submit: {
        title: 'Submit Changes',
        message: 'Now click Submit Changes to proceed to Templates.',
        targets: ['[data-guide-id="prep-submit"]'],
        next: 'tmpl_convert',
      },
      tmpl_convert: {
        title: 'Convert to SLDC',
        message: 'Click Convert to SLDC (Preview) to generate the preview.',
        targets: ['[data-guide-id="tmpl-convert"]'],
        next: 'tmpl_download',
      },
      tmpl_download: {
        title: 'Download Template',
        message: 'Click Download to choose format and download the SLDC template.',
        targets: ['[data-guide-id="tmpl-download"]'],
        next: 'tmpl_download_format',
      },
      tmpl_download_format: {
        title: 'Select XLSX Format',
        message: 'Select Excel (.xlsx) format.',
        targets: ['[data-guide-id="download-format-xlsx"]'],
        next: 'tmpl_download_confirm',
      },
      tmpl_download_confirm: {
        title: 'Download File',
        message: 'Click Download to save the file.',
        targets: ['[data-guide-id="download-format-download"]'],
        next: 'tmpl_upload',
      },
      tmpl_upload: {
        title: 'Upload to SLDC',
        message: 'Click Upload to SLDC to open the portal, then confirm upload.',
        targets: ['[data-guide-id="tmpl-upload"]'],
        next: 'tmpl_confirm',
      },
      tmpl_confirm: {
        title: 'Confirm Upload',
        message: 'After uploading on SLDC portal, click Confirm Uploaded.',
        targets: ['[data-guide-id="tmpl-confirm"]'],
        next: null,
      },
    };

    const readStep = () => {
      try {
        const raw = localStorage.getItem(STEP_KEY);
        const value = String(raw || '').trim();
        return value && steps[value] ? value : null;
      } catch {
        return null;
      }
    };

    const writeStep = (step) => {
      try {
        if (!step) localStorage.removeItem(STEP_KEY);
        else localStorage.setItem(STEP_KEY, step);
      } catch {
        // ignore storage errors
      }
    };

    return {
      steps,
      readStep,
      writeStep,
    };
  }, []);

  const [guideStep, setGuideStep] = useState(() => workflowGuideValue.readStep());
  const [guideActive, setGuideActive] = useState(() => Boolean(workflowGuideValue.readStep()));

  useEffect(() => {
    // Keep storage in sync.
    if (!guideActive) {
      workflowGuideValue.writeStep(null);
      if (guideStep !== null) setGuideStep(null);
      return;
    }
    workflowGuideValue.writeStep(guideStep);
  }, [guideActive, guideStep, workflowGuideValue]);

  const workflowGuide = useMemo(() => {
    const getCurrent = () => (guideStep ? workflowGuideValue.steps[guideStep] : null);
    const start = (step = 'readiness_upload') => {
      const safe = workflowGuideValue.steps[step] ? step : 'readiness_upload';
      setGuideActive(true);
      setGuideStep(safe);
    };
    const stop = () => {
      setGuideActive(false);
      setGuideStep(null);
    };
    const setStep = (step) => {
      if (!step) {
        stop();
        return;
      }
      if (!workflowGuideValue.steps[step]) return;
      setGuideActive(true);
      setGuideStep(step);
    };
    const next = () => {
      const current = getCurrent();
      const nextStep = current?.next || null;
      if (!nextStep) {
        stop();
        return;
      }
      setStep(nextStep);
    };
    const isStep = (step) => guideActive && guideStep === step;
    const toastExpected = (fallback = 'Please follow the workflow steps in order.') => {
      const current = getCurrent();
      toast.info(current?.message || fallback);
    };
    return {
      active: guideActive,
      step: guideStep,
      current: getCurrent(),
      start,
      stop,
      setStep,
      next,
      isStep,
      toastExpected,
    };
  }, [guideActive, guideStep, workflowGuideValue]);

  const WorkflowGuideOverlay = () => {
    const [rects, setRects] = useState([]);
    const [unionRect, setUnionRect] = useState(null);

    useEffect(() => {
      if (!workflowGuide.active || !workflowGuide.current) {
        setRects([]);
        setUnionRect(null);
        return;
      }

      const findTargets = () => {
        const selectors = workflowGuide.current?.targets || [];
        const results = [];
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (el) results.push(el);
        }
        return results;
      };

      const compute = () => {
        const targets = findTargets();
        if (!targets.length) {
          setRects([]);
          setUnionRect(null);
          return;
        }

        const boxes = targets
          .map((el) => el.getBoundingClientRect())
          .filter((box) => box && Number.isFinite(box.width) && Number.isFinite(box.height) && box.width > 0 && box.height > 0);

        if (!boxes.length) {
          setRects([]);
          setUnionRect(null);
          return;
        }

        const nextRects = boxes.map((box) => ({
          top: Math.max(0, box.top),
          left: Math.max(0, box.left),
          width: Math.max(0, box.width),
          height: Math.max(0, box.height),
        }));

        const top = Math.min(...nextRects.map((r) => r.top));
        const left = Math.min(...nextRects.map((r) => r.left));
        const right = Math.max(...nextRects.map((r) => r.left + r.width));
        const bottom = Math.max(...nextRects.map((r) => r.top + r.height));
        const nextUnion = {
          top,
          left,
          width: Math.max(0, right - left),
          height: Math.max(0, bottom - top),
        };

        setRects(nextRects);
        setUnionRect(nextUnion);
      };

      compute();
      const onScroll = () => compute();
      const onResize = () => compute();
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', onResize);
      const id = window.setInterval(compute, 700);

      return () => {
        window.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', onResize);
        window.clearInterval(id);
      };
    }, [workflowGuide.active, workflowGuide.step]);

    if (!workflowGuide.active || !workflowGuide.current) return null;

    const title = workflowGuide.current.title || 'Workflow';
    const message = workflowGuide.current.message || '';

    return (
      <div className="fixed inset-0 z-[60] pointer-events-none">
        <div className="absolute inset-0 bg-black/40" />
        {unionRect && (
          <div
            className="absolute rounded-lg border-2 border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.4)]"
            style={{
              top: unionRect.top - 6,
              left: unionRect.left - 6,
              width: unionRect.width + 12,
              height: unionRect.height + 12,
            }}
          />
        )}
        {rects.map((rect, idx) => (
          <div
            // eslint-disable-next-line react/no-array-index-key
            key={idx}
            className="absolute rounded-lg border-2 border-white/70 shadow-[0_0_18px_rgba(255,255,255,0.25)]"
            style={{
              top: rect.top - 6,
              left: rect.left - 6,
              width: rect.width + 12,
              height: rect.height + 12,
            }}
          />
        ))}
        <div className="absolute bottom-4 left-4 right-4 sm:left-6 sm:right-auto sm:w-[520px] pointer-events-auto">
          <div className="rounded-xl border border-border bg-card/95 backdrop-blur px-4 py-3 shadow-lg">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-foreground">{title}</div>
                <div className="text-xs text-muted-foreground mt-1">{message}</div>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => workflowGuide.stop()}
                  className="pointer-events-auto px-3 py-1.5 rounded-lg text-xs font-semibold bg-muted hover:bg-accent text-foreground transition"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  useEffect(() => {
    // Employee-only idle timeout: if no activity for 30 minutes, log out.
    if (!isAuthenticated) return;
    if (isAdmin) return;

    let warningTimer = null;
    let logoutTimer = null;

    const clearTimers = () => {
      if (warningTimer) clearTimeout(warningTimer);
      if (logoutTimer) clearTimeout(logoutTimer);
      warningTimer = null;
      logoutTimer = null;
    };

    const scheduleTimers = () => {
      clearTimers();
      warningTimer = setTimeout(() => {
        toast.warning('Session will expire in 2 minutes due to inactivity.');
      }, EMPLOYEE_IDLE_WARNING_MS);
      logoutTimer = setTimeout(() => {
        toast.info('Session expired due to inactivity. Please login again.');
        handleLogout();
      }, EMPLOYEE_IDLE_TIMEOUT_MS);
    };

    const handleActivity = () => {
      scheduleTimers();
    };

    scheduleTimers();

    const events = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'];
    events.forEach((eventName) =>
      window.addEventListener(eventName, handleActivity, { passive: true })
    );

    return () => {
      events.forEach((eventName) => window.removeEventListener(eventName, handleActivity));
      clearTimers();
    };
  }, [isAuthenticated, isAdmin]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  const toggleSidebar = () => {
    if (window.innerWidth < 768) {
      setIsMobileMenuOpen((prev) => !prev);
      return;
    }
    setIsSidebarCollapsed((prev) => !prev);
  };

  const themeContextValue = useMemo(
    () => ({
      theme,
      setTheme,
      toggleTheme,
      isDarkMode: theme === 'dark',
    }),
    [theme]
  );

  const authContextValue = useMemo(
    () => ({
      user: currentUser,
      isAuthenticated,
      login: handleLogin,
      logout: handleLogout,
    }),
    [currentUser, isAuthenticated]
  );

  const renderMountedScreens = () =>
    SCREEN_ORDER.map((screenId) => {
      if (!mountedScreens.has(screenId)) return null;
      const isActive = activeScreen === screenId;
      return (
        <div
          key={screenId}
          style={{ display: isActive ? 'block' : 'none' }}
          className="flex-1 min-h-0 min-w-0"
        >
          <ScreenSlot
            screenId={screenId}
            isActive={isActive}
            screenContext={screenContext}
            globalFilters={globalFilters}
            sharedData={sharedData}
            updateSharedData={updateSharedData}
            clearSharedData={clearSharedData}
            onNavigate={handleNavigate}
          />
        </div>
      );
    });

  if (!isAuthenticated) {
    return (
      <ThemeContext.Provider value={themeContextValue}>
        <AuthContext.Provider value={authContextValue}>
          <Login onLogin={handleLogin} isDarkMode={theme === 'dark'} toggleTheme={toggleTheme} />
          <Toaster />
        </AuthContext.Provider>
      </ThemeContext.Provider>
    );
  }

  return (
    <ThemeContext.Provider value={themeContextValue}>
      <AuthContext.Provider value={authContextValue}>
        <FilterContext.Provider value={{ filters: globalFilters, updateFilters }}>
          <DataContext.Provider value={{ sharedData, updateSharedData, clearSharedData }}>
            <WorkflowGuideContext.Provider value={workflowGuide}>
              <WhatsAppNotificationProvider>
                <div className="h-screen flex flex-col bg-background overflow-y-auto overflow-x-visible transition-colors duration-300 min-w-0">
                  <TopNav
                    user={currentUser}
                    onLogout={handleLogout}
                    onToggleSidebar={toggleSidebar}
                    isSidebarCollapsed={isSidebarCollapsed}
                    isDarkMode={theme === 'dark'}
                    onToggleTheme={toggleTheme}
                  />

                <div className="flex flex-1 min-h-0 min-w-0">
                  <div className="hidden md:block">
                    <Sidebar
                      activeScreen={activeScreen}
                      allowedScreens={allowedScreens}
                      onNavigate={(screen) => handleNavigate(screen)}
                      user={currentUser}
                      collapsed={isSidebarCollapsed}
                      onToggleCollapse={() => setIsSidebarCollapsed((prev) => !prev)}
                    />
                  </div>

                  <div className="flex-1 flex flex-col min-h-0 min-w-0">
                    <Suspense
                      fallback={
                        <div className="flex-1 flex items-center justify-center bg-background">
                          <LoadingSpinner size="lg" message="Loading module..." />
                        </div>
                      }
                    >
                      {renderMountedScreens()}
                    </Suspense>
                  </div>
                </div>

                {isMobileMenuOpen && (
                  <div className="md:hidden fixed inset-0 z-40">
                    <button
                      onClick={() => setIsMobileMenuOpen(false)}
                      className="absolute inset-0 bg-black/60"
                      aria-label="Close menu"
                    />
                    <div className="absolute left-0 top-16 bottom-0">
                      <Sidebar
                        activeScreen={activeScreen}
                        allowedScreens={allowedScreens}
                        onNavigate={(screen) => handleNavigate(screen)}
                        user={currentUser}
                        onToggleCollapse={() => setIsMobileMenuOpen(false)}
                      />
                    </div>
                  </div>
                )}
                </div>
                <WorkflowGuideOverlay />
                <Toaster />
              </WhatsAppNotificationProvider>
            </WorkflowGuideContext.Provider>
          </DataContext.Provider>
        </FilterContext.Provider>
      </AuthContext.Provider>
    </ThemeContext.Provider>
  );
}
