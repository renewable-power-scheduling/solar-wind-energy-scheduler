import {
  useState,
  createContext,
  useContext,
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

export const FilterContext = createContext();
export const DataContext = createContext();
export const ThemeContext = createContext();
export const AuthContext = createContext();

const AUTH_USER_KEY = 'vedanjay-user';
const AUTH_TOKEN_KEY = 'vedanjay-token';
const AUTH_DAY_KEY = 'vedanjay-auth-day'; // Require re-login once per IST day.
const THEME_KEY = 'vedanjay-theme';
const ACTIVE_SCREEN_KEY = 'vedanjay-active-screen';
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

export function useFilters() {
  return useContext(FilterContext);
}

export function useData() {
  return useContext(DataContext);
}

export function useTheme() {
  return useContext(ThemeContext);
}

export function useAuth() {
  return useContext(AuthContext);
}

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
      if (VALID_SCREENS.has(activeScreen)) next.add(activeScreen);
      return next;
    });
  }, [activeScreen]);

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
    setActiveScreen(screen);
    setScreenContext(context || null);
    setIsMobileMenuOpen(false);
    try {
      if (VALID_SCREENS.has(screen)) {
        localStorage.setItem(ACTIVE_SCREEN_KEY, screen);
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
                      onNavigate={(screen) => handleNavigate(screen)}
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
                        onNavigate={(screen) => handleNavigate(screen)}
                        onToggleCollapse={() => setIsMobileMenuOpen(false)}
                      />
                    </div>
                  </div>
                )}
              </div>
              <Toaster />
            </WhatsAppNotificationProvider>
          </DataContext.Provider>
        </FilterContext.Provider>
      </AuthContext.Provider>
    </ThemeContext.Provider>
  );
}
