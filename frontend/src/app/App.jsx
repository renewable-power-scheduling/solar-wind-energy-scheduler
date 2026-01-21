import { useState, createContext, useContext } from 'react';
import { TopNav } from './components/TopNav';
import { Sidebar } from './components/Sidebar';
import { Dashboard } from './components/screens/Dashboard';
import { SchedulePreparation } from './components/screens/SchedulePreparation';
import { ScheduleReadinessDashboard } from './components/screens/ScheduleReadinessDashboard';
import { DataInputs } from './components/screens/DataInputs';
import { ForecastView } from './components/screens/ForecastView';
import { WeatherView } from './components/screens/WeatherView';
import { DeviationDSM } from './components/screens/DeviationDSM';
import { ScheduleTemplates } from './components/screens/ScheduleTemplates';
import { Reports } from './components/screens/Reports';
import { Toaster } from '@/app/components/ui/sonner';

// Create global filter context
export const FilterContext = createContext();

// Create data context for sharing loaded data between screens
export const DataContext = createContext();

export function useFilters() {
  return useContext(FilterContext);
}

export function useData() {
  return useContext(DataContext);
}

export default function App() {
  const [activeScreen, setActiveScreen] = useState('dashboard');
  const [screenContext, setScreenContext] = useState(null);
  
  // Global filter state
  const [globalFilters, setGlobalFilters] = useState({
    search: '',
    date: '',
    state: 'All States',
    plant: 'All Plants'
  });

  // Shared data state for DataInputs → ForecastView/Meter charts
  const [sharedData, setSharedData] = useState({
    forecastData: null,
    meterData: null,
    selectedPlant: null,
    dateRange: null
  });

  const handleNavigate = (screen, context) => {
    setActiveScreen(screen);
    setScreenContext(context || null);
  };

  const updateFilters = (newFilters) => {
    setGlobalFilters(prev => ({ ...prev, ...newFilters }));
  };

  const updateSharedData = (newData) => {
    setSharedData(prev => ({ ...prev, ...newData }));
  };

  const clearSharedData = () => {
    setSharedData({
      forecastData: null,
      meterData: null,
      selectedPlant: null,
      dateRange: null
    });
  };

  const renderScreen = () => {
    const screenProps = {
      onNavigate: handleNavigate,
      context: screenContext,
      filters: globalFilters,
      sharedData,
      updateSharedData,
      clearSharedData
    };

    switch (activeScreen) {
      case 'dashboard':
        return <Dashboard {...screenProps} />;
      case 'schedule':
        return <SchedulePreparation {...screenProps} />;
      case 'schedule-readiness':
        return <ScheduleReadinessDashboard {...screenProps} />;
      case 'data-inputs':
        return <DataInputs {...screenProps} />;
      case 'forecast':
        return <ForecastView {...screenProps} />;
      case 'weather':
        return <WeatherView {...screenProps} filters={globalFilters} />;
      case 'deviation':
        return <DeviationDSM {...screenProps} />;
      case 'templates':
        return <ScheduleTemplates {...screenProps} filters={globalFilters} />;
      case 'reports':
        return <Reports {...screenProps} />;
      default:
        return <Dashboard {...screenProps} />;
    }
  };

  return (
    <FilterContext.Provider value={{ filters: globalFilters, updateFilters }}>
      <DataContext.Provider value={{ sharedData, updateSharedData, clearSharedData }}>
        <div className="h-screen flex flex-col bg-background overflow-hidden dark">
          {/* Top Navigation */}
          <TopNav />

          {/* Main Layout */}
          <div className="flex flex-1 min-h-0">
            {/* Sidebar */}
            <Sidebar activeScreen={activeScreen} onNavigate={(screen) => handleNavigate(screen)} />

            {/* Main Content Area */}
            <div className="flex-1 flex flex-col min-h-0">
              {renderScreen()}
            </div>
          </div>
        </div>
        {/* Toast Notifications */}
        <Toaster />
      </DataContext.Provider>
    </FilterContext.Provider>
  );
}

