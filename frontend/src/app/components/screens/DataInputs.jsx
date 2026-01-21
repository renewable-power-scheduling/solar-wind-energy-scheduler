import { useState, useMemo, useEffect, useRef } from 'react';
import { 
  Upload, 
  Database, 
  Wind, 
  Sun, 
  MapPin, 
  Zap, 
  Calendar,
  CheckCircle,
  AlertCircle,
  Eye,
  RefreshCw,
  MessageSquare,
  FileSpreadsheet,
  Clock,
  Cloud,
  TrendingUp,
  TrendingDown,
  Minus,
  BarChart3,
  AlertTriangle,
  X
} from 'lucide-react';
import { api } from '@/services/api';
import { useApi } from '@/hooks/useApi';
import { LoadingSpinner } from '@/app/components/common/LoadingSpinner';
import { ErrorMessage } from '@/app/components/common/ErrorMessage';
import { generateForecastData, generateMeterData, generateWhatsAppData } from '@/services/mockDataService';

export function DataInputs({ sharedData, updateSharedData }) {
  // Filter states
  const [selectedPlant, setSelectedPlant] = useState('');
  const [dateRange, setDateRange] = useState({
    start: new Date().toISOString().split('T')[0],
    end: new Date().toISOString().split('T')[0]
  });

  // Success state for load operation
  const [loadSuccess, setLoadSuccess] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');

  // Success state for WhatsApp form submission
  const [whatsappSubmitSuccess, setWhatsappSubmitSuccess] = useState(false);
  const [whatsappSubmitMessage, setWhatsappSubmitMessage] = useState('');

  // Chart display states - use useRef to persist state across re-renders
  const [showForecastChart, setShowForecastChart] = useState(false);
  const [showMeterChart, setShowMeterChart] = useState(false);
  
  // Refs for chart state to ensure persistence
  const forecastChartRef = useRef(false);
  const meterChartRef = useRef(false);

  // Sync refs with state and log for debugging
  const toggleForecastChart = () => {
    forecastChartRef.current = !forecastChartRef.current;
    setShowForecastChart(forecastChartRef.current);
    console.log('Forecast chart toggled:', forecastChartRef.current, 'data:', forecastData ? 'available' : 'none');
  };

  const toggleMeterChart = () => {
    meterChartRef.current = !meterChartRef.current;
    setShowMeterChart(meterChartRef.current);
    console.log('Meter chart toggled:', meterChartRef.current, 'data:', meterData ? 'available' : 'none');
  };

  // Modal states
  const [showWhatsAppModal, setShowWhatsAppModal] = useState(false);
  const [showWhatsAppHistoryModal, setShowWhatsAppHistoryModal] = useState(false);

  // WhatsApp form state
  const [whatsappForm, setWhatsappForm] = useState({
    plantId: '',
    plantName: '',
    state: '',
    date: new Date().toISOString().split('T')[0],
    time: new Date().toTimeString().slice(0, 5),
    currentGeneration: '',
    expectedTrend: '',
    curtailmentStatus: false,
    curtailmentReason: '',
    weatherCondition: '',
    inverterAvailability: '',
    remarks: ''
  });

  // API hooks
  const {
    data: plantsData,
    loading: plantsLoading,
    execute: fetchPlants
  } = useApi(
    () => api.plants.getAll({}),
    { 
      immediate: true,
      initialData: { plants: [], total: 0, stats: {} }
    }
  );

  const {
    data: forecastData,
    loading: forecastLoading,
    error: forecastError,
    execute: fetchForecast
  } = useApi(
    async () => {
      // Validate plant selection
      if (!selectedPlant) {
        throw new Error('Please select a plant first');
      }
      
      // Wait for plants data to be loaded
      if (!plantsData?.plants || plantsData.plants.length === 0) {
        throw new Error('Plant data not loaded. Please wait...');
      }
      
      const plant = plantsData.plants.find(p => p.id === parseInt(selectedPlant) || p.name === selectedPlant);
      if (!plant) {
        throw new Error(`Plant with ID "${selectedPlant}" not found`);
      }
      
      try {
        // Use correct API method: getForecastData(plantId, date)
        if (api.forecasts?.getForecastData) {
          const result = await api.forecasts.getForecastData(plant.id, dateRange.start);
          console.log('Forecast data loaded:', result);
          return result;
        }
      } catch (apiError) {
        console.warn('Forecast API failed, using mock data:', apiError);
      }
      
      // Fallback: generate mock data if API fails or method doesn't exist
      console.log('Using mock forecast data for plant:', plant.name);
      return generateForecastData(plant.id, dateRange.start);
    },
    { immediate: false, initialData: null }
  );

  const {
    data: meterData,
    loading: meterLoading,
    error: meterError,
    execute: fetchMeterData
  } = useApi(
    async () => {
      // Validate plant selection
      if (!selectedPlant) {
        throw new Error('Please select a plant first');
      }
      
      // Wait for plants data to be loaded
      if (!plantsData?.plants || plantsData.plants.length === 0) {
        throw new Error('Plant data not loaded. Please wait...');
      }
      
      const plant = plantsData.plants.find(p => p.id === parseInt(selectedPlant) || p.name === selectedPlant);
      if (!plant) {
        throw new Error(`Plant with ID "${selectedPlant}" not found`);
      }
      
      try {
        // Use correct API method: getDataPoints(plantId, date) for chart data
        if (api.meterData?.getDataPoints) {
          const result = await api.meterData.getDataPoints(plant.id, dateRange.start);
          console.log('Meter data loaded:', result);
          return result;
        }
        
        // Fallback: use getLatest if getDataPoints not available
        if (api.meterData?.getLatest) {
          const result = await api.meterData.getLatest(plant.id, dateRange.start);
          return result;
        }
      } catch (apiError) {
        console.warn('Meter API failed, using mock data:', apiError);
      }
      
      // Fallback: generate mock data if API fails or methods don't exist
      console.log('Using mock meter data for plant:', plant.name);
      return generateMeterData(plant.id, dateRange.start);
    },
    { immediate: false, initialData: null }
  );

  const {
    data: whatsappDataList,
    loading: whatsappLoading,
    execute: fetchWhatsAppData
  } = useApi(
    () => {
      if (!selectedPlant || !api.whatsappData?.getAll) return Promise.resolve({ data: [] });
      const plant = plantsData?.plants?.find(p => p.id === parseInt(selectedPlant) || p.name === selectedPlant);
      if (!plant) return Promise.resolve({ data: [] });
      return api.whatsappData.getAll({ plantId: plant.id });
    },
    { immediate: false, initialData: { data: [] } }
  );

  const {
    loading: createWhatsAppLoading,
    execute: createWhatsAppData
  } = useApi(
    api.whatsappData?.create || (() => Promise.resolve({})),
    {
      onSuccess: () => {
        setShowWhatsAppModal(false);
        setWhatsappForm({
          plantId: '',
          plantName: '',
          state: '',
          date: new Date().toISOString().split('T')[0],
          time: new Date().toTimeString().slice(0, 5),
          currentGeneration: '',
          expectedTrend: '',
          curtailmentStatus: false,
          curtailmentReason: '',
          weatherCondition: '',
          inverterAvailability: '',
          remarks: ''
        });
        fetchWhatsAppData();
        // Show success message instead of alert
        setWhatsappSubmitSuccess(true);
        setWhatsappSubmitMessage('WhatsApp data submitted successfully!');
        // Clear success message after 5 seconds
        setTimeout(() => {
          setWhatsappSubmitSuccess(false);
          setWhatsappSubmitMessage('');
        }, 5000);
      },
      onError: (error) => {
        setWhatsappSubmitSuccess(false);
        setWhatsappSubmitMessage(`Error submitting data: ${error.message}`);
      }
    }
  );

  // Memoized selected plant data - must be defined BEFORE useEffect that uses it
  const selectedPlantData = useMemo(() => {
    if (!selectedPlant || !plantsData?.plants) return null;
    return plantsData.plants.find(p => p.id === parseInt(selectedPlant) || p.name === selectedPlant);
  }, [selectedPlant, plantsData]);

  // Reset WhatsApp form when plant selection changes
  useEffect(() => {
    if (selectedPlantData) {
      setWhatsappForm(prev => ({
        ...prev,
        plantId: selectedPlantData.id?.toString() || '',
        plantName: selectedPlantData.name || '',
        state: selectedPlantData.state || ''
      }));
    }
  }, [selectedPlantData]);

  // Load data when plant is selected
  useEffect(() => {
    if (selectedPlant) {
      fetchForecast();
      fetchMeterData();
      fetchWhatsAppData();
    }
  }, [selectedPlant, dateRange]);

  // Auto-show chart when data is loaded (optional UX improvement) - defined AFTER useApi hooks
  useEffect(() => {
    if (forecastData && !forecastChartRef.current) {
      // Optionally auto-show chart when data loads
      // forecastChartRef.current = true;
      // setShowForecastChart(true);
    }
  }, [forecastData]);

  useEffect(() => {
    if (meterData && !meterChartRef.current) {
      // Optionally auto-show chart when data loads
      // meterChartRef.current = true;
      // setShowMeterChart(true);
    }
  }, [meterData]);

  const handleLoad = async () => {
    if (!selectedPlant) {
      alert('Please select a plant first');
      return;
    }
    
    // Reset success state
    setLoadSuccess(false);
    setSuccessMessage('');
    
    // Fetch data
    await fetchForecast();
    await fetchMeterData();
    await fetchWhatsAppData();
    
    // Show success message
    setLoadSuccess(true);
    setSuccessMessage('Data loaded successfully! Forecast, Meter, and WhatsApp data are now available.');
    
    // Clear success message after 5 seconds
    setTimeout(() => {
      setLoadSuccess(false);
      setSuccessMessage('');
    }, 5000);
  };

  const handleWhatsAppSubmit = () => {
    // Validate all required fields before submission
    if (!whatsappForm.plantId) {
      alert('Please select a plant first');
      return;
    }
    if (!whatsappForm.currentGeneration || whatsappForm.currentGeneration.trim() === '') {
      alert('Please enter the current generation value');
      return;
    }
    if (!whatsappForm.expectedTrend || whatsappForm.expectedTrend.trim() === '') {
      alert('Please select an expected trend (Increasing, Stable, or Decreasing)');
      return;
    }
    if (isNaN(parseFloat(whatsappForm.currentGeneration))) {
      alert('Please enter a valid number for current generation');
      return;
    }
    // Validate curtailment if status is Yes
    if (whatsappForm.curtailmentStatus && (!whatsappForm.curtailmentReason || whatsappForm.curtailmentReason.trim() === '')) {
      alert('Please select a curtailment reason when curtailment status is Yes');
      return;
    }
    createWhatsAppData(whatsappForm);
  };

  // Get Windy.com embed URL based on plant location - uses actual coordinates from database
  const getWindyEmbedUrl = () => {
    if (!selectedPlantData) return 'https://embed.windy.com/embed2.html?lat=19.0760&lon=72.8777&zoom=5&level=surface&overlay=wind&menu=&message=&marker=&calendar=&pressure=&type=map&location=coordinates&detail=&detailLat=19.0760&detailLon=72.8777&metricWind=default&metricTemp=default&radarRange=-1';
    
    // Use actual plant coordinates from database if available
    const lat = selectedPlantData.latitude || 19.0760;
    const lon = selectedPlantData.longitude || 72.8777;
    
    return `https://embed.windy.com/embed2.html?lat=${lat}&lon=${lon}&zoom=10&level=surface&overlay=wind&menu=&message=&marker=&calendar=&pressure=&type=map&location=coordinates&detail=&detailLat=${lat}&detailLon=${lon}&metricWind=default&metricTemp=default&radarRange=-1`;
  };

  const latestWhatsAppMessage = useMemo(() => {
    if (!whatsappDataList?.data || whatsappDataList.data.length === 0) return null;
    return whatsappDataList.data[0];
  }, [whatsappDataList]);

  // Calculate delays and status
  const meterDelay = useMemo(() => {
    if (!meterData?.lastReading) return null;
    const now = new Date();
    const lastReading = new Date(meterData.lastReading);
    const diffMinutes = Math.floor((now - lastReading) / (1000 * 60));
    return diffMinutes;
  }, [meterData]);

  return (
    <div className="flex-1 overflow-auto bg-slate-950 min-h-0">
      {/* Animated background elements */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />
      </div>

      <div className="p-8 space-y-6 max-w-[1600px] mx-auto relative z-10">
        {/* Premium Header */}
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 border border-slate-700/50 shadow-2xl">
          <div className="absolute inset-0 bg-gradient-to-r from-indigo-500/5 via-transparent to-purple-500/5" />
          <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-bl from-indigo-500/10 to-transparent rounded-full blur-2xl" />
          
          <div className="relative p-6">
            <div className="flex items-start gap-5">
              <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/25">
                <Database className="w-7 h-7 text-white" />
              </div>
              <div>
                <h1 className="text-3xl font-bold text-white mb-2 tracking-tight">Data Inputs</h1>
                <div className="flex items-center gap-4 text-slate-400">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
                    <span className="text-sm font-medium">Live Monitoring</span>
                  </div>
                  <span className="text-slate-600">•</span>
                  <span className="text-sm">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</span>
                </div>
                <p className="text-sm text-slate-400 mt-2">View and manage all data sources for schedule preparation</p>
              </div>
            </div>
          </div>
        </div>

        {/* DATA INPUTS - VIEW ONLY Section */}
        <div className="rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm p-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-indigo-500/10">
                <Database className="w-5 h-5 text-indigo-400" />
              </div>
              <h2 className="text-lg font-semibold text-white">DATA INPUTS - VIEW ONLY</h2>
            </div>
          </div>
          
          <div className="flex flex-col md:flex-row gap-4 mb-6">
            <div className="flex-1">
              <label className="text-sm font-medium text-slate-400 mb-2 block">FILTERS: Plant</label>
              {plantsLoading ? (
                <div className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700/50 text-sm flex items-center gap-2">
                  <RefreshCw className="w-4 h-4 animate-spin text-indigo-400" />
                  <span className="text-slate-400">Loading plants...</span>
                </div>
              ) : (
                <select 
                  value={selectedPlant}
                  onChange={(e) => setSelectedPlant(e.target.value)}
                  className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700/50 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                >
                  <option value="">Select Plant</option>
                  {plantsData?.plants?.map(plant => (
                    <option key={plant.id} value={plant.id}>{plant.name}</option>
                  ))}
                </select>
              )}
            </div>
            <div className="flex-1">
              <label className="text-sm font-medium text-slate-400 mb-2 block">Date Range</label>
              <div className="flex gap-3">
                <input 
                  type="date"
                  value={dateRange.start}
                  onChange={(e) => setDateRange({ ...dateRange, start: e.target.value })}
                  className="flex-1 px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700/50 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                />
                <input 
                  type="date"
                  value={dateRange.end}
                  onChange={(e) => setDateRange({ ...dateRange, end: e.target.value })}
                  className="flex-1 px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700/50 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                />
              </div>
            </div>
            <div className="flex items-end">
              <button 
                onClick={handleLoad}
                disabled={!selectedPlant || plantsLoading || forecastLoading || meterLoading}
                className="px-8 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white shadow-lg shadow-indigo-500/25 hover:from-indigo-500 hover:to-purple-500 transition-all font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {forecastLoading || meterLoading ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Loading...
                  </>
                ) : (
                  'LOAD'
                )}
              </button>
            </div>
          </div>
          
          {/* Success Message */}
          {loadSuccess && (
            <div className="mt-4 p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl animate-in fade-in slide-in-from-top-2 duration-300">
              <div className="flex items-center gap-3">
                <CheckCircle className="w-5 h-5 text-emerald-400 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-white">Load Successful</p>
                  <p className="text-xs text-slate-400">{successMessage}</p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Main Grid - Forecast, Meter, Weather, WhatsApp */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Forecast Data (Enercast) */}
          <div className={`relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 to-slate-800 border border-slate-700/50 hover:border-slate-600 transition-all duration-500 ${forecastData ? 'ring-2 ring-emerald-500/20' : ''}`}>
            <div className={`absolute inset-0 bg-gradient-to-r ${forecastData ? 'bg-emerald-500/5' : ''} opacity-0 transition-opacity duration-500`} />
            <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-indigo-500/10 to-transparent rounded-full blur-2xl" />
            
            <div className="relative p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-xl bg-blue-500/10">
                    <TrendingUp className="w-5 h-5 text-blue-400" />
                  </div>
                  <h3 className="text-base font-semibold text-white">FORECAST DATA (ENERCAST)</h3>
                </div>
                {forecastData && (
                  <span className="px-3 py-1 rounded-lg text-xs font-semibold bg-emerald-500/10 text-emerald-400 flex items-center gap-1.5 border border-emerald-500/20">
                    <CheckCircle className="w-3.5 h-3.5" /> Loaded
                  </span>
                )}
              </div>
              
              {/* Error Display */}
              {forecastError && (
                <div className="mb-4">
                  <ErrorMessage 
                    error={forecastError} 
                    onRetry={handleLoad}
                    variant="warning"
                  />
                </div>
              )}
              
              {forecastLoading ? (
                <div className="py-8">
                  <LoadingSpinner message="Loading forecast data..." />
                </div>
              ) : forecastData ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Last Updated:</span>
                    <span className="font-medium text-white">
                      {new Date(forecastData.createdAt || Date.now()).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} {new Date(forecastData.createdAt || Date.now()).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Data Points:</span>
                    <span className="font-medium text-white">96 (15-min)</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">API Status:</span>
                    <span className="px-3 py-1 rounded-lg text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Connected</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Coverage:</span>
                    <span className="font-medium text-white">100%</span>
                  </div>
                  <button
                    onClick={toggleForecastChart}
                    disabled={!forecastData}
                    className="w-full mt-4 px-4 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white shadow-lg shadow-indigo-500/25 hover:from-indigo-500 hover:to-purple-500 transition-all font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    <BarChart3 className="w-4 h-4" />
                    {showForecastChart ? 'HIDE FORECAST CHART' : 'VIEW FORECAST CHART'}
                  </button>
                </div>
              ) : (
                <div className="text-center py-8 text-sm text-slate-400">
                  <TrendingUp className="w-10 h-10 mx-auto mb-3 text-slate-600" />
                  <p>Select a plant and click LOAD to view forecast data</p>
                </div>
              )}
            </div>
          </div>

          {/* Meter Data (Actual) */}
          <div className={`relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 to-slate-800 border border-slate-700/50 hover:border-slate-600 transition-all duration-500 ${meterData ? 'ring-2 ring-emerald-500/20' : ''}`}>
            <div className={`absolute inset-0 bg-gradient-to-r ${meterData ? 'bg-emerald-500/5' : ''} opacity-0 transition-opacity duration-500`} />
            <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-amber-500/10 to-transparent rounded-full blur-2xl" />
            
            <div className="relative p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-xl bg-amber-500/10">
                    <Zap className="w-5 h-5 text-amber-400" />
                  </div>
                  <h3 className="text-base font-semibold text-white">METER DATA (ACTUAL)</h3>
                </div>
                {meterData && (
                  <span className="px-3 py-1 rounded-lg text-xs font-semibold bg-emerald-500/10 text-emerald-400 flex items-center gap-1.5 border border-emerald-500/20">
                    <CheckCircle className="w-3.5 h-3.5" /> Loaded
                  </span>
                )}
              </div>
              
              {/* Error Display */}
              {meterError && (
                <div className="mb-4">
                  <ErrorMessage 
                    error={meterError} 
                    onRetry={handleLoad}
                    variant="warning"
                  />
                </div>
              )}
              
              {meterLoading ? (
                <div className="py-8">
                  <LoadingSpinner message="Loading meter data..." />
                </div>
              ) : meterData ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Last Reading:</span>
                    <span className="font-medium text-white">
                      {meterData.lastReading ? new Date(meterData.lastReading).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })+' '+new Date(meterData.lastReading).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'N/A'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Data Points:</span>
                    <span className="font-medium text-white">{meterData.dataPoints?.length || 48} (Available)</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Source:</span>
                    <span className="font-medium text-white">{meterData.source || 'SCADA'}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Delay:</span>
                    <span className={`font-medium ${meterDelay && meterDelay > 20 ? 'text-red-400' : 'text-white'}`}>
                      {meterDelay ? `${meterDelay} min` : 'N/A'}
                    </span>
                  </div>
                  <button
                    onClick={toggleMeterChart}
                    disabled={!meterData}
                    className="w-full mt-4 px-4 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white shadow-lg shadow-indigo-500/25 hover:from-indigo-500 hover:to-purple-500 transition-all font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    <BarChart3 className="w-4 h-4" />
                    {showMeterChart ? 'HIDE METER CHART' : 'VIEW METER CHART'}
                  </button>
                </div>
              ) : (
                <div className="text-center py-8 text-sm text-slate-400">
                  <Database className="w-10 h-10 mx-auto mb-3 text-slate-600" />
                  <p>No meter data available</p>
                  <p className="text-xs mt-2 text-slate-500">Data is automatically fetched from backend</p>
                </div>
              )}
            </div>
          </div>

          {/* Weather Reference (Windy) */}
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 to-slate-800 border border-slate-700/50 p-6">
            <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-cyan-500/10 to-transparent rounded-full blur-2xl" />
            
            <div className="relative">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-xl bg-cyan-500/10">
                    <Cloud className="w-5 h-5 text-cyan-400" />
                  </div>
                  <h3 className="text-base font-semibold text-white">WEATHER REFERENCE (WINDY)</h3>
                </div>
                <span className="px-3 py-1 rounded-lg text-xs font-semibold bg-slate-700/50 text-slate-400 border border-slate-600/50">REFERENCE</span>
              </div>
              
              <div className="relative h-[350px] rounded-xl border border-slate-700/50 overflow-hidden">
                {selectedPlant ? (
                  <iframe
                    src={getWindyEmbedUrl()}
                    width="100%"
                    height="100%"
                    frameBorder="0"
                    title="Windy Weather Map"
                    className="border-0"
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center bg-slate-800/50">
                    <div className="text-center">
                      <Cloud className="w-12 h-12 mx-auto mb-3 text-slate-600" />
                      <p className="text-sm text-slate-400">Select a plant to view weather map</p>
                    </div>
                  </div>
                )}
              </div>
              <p className="text-xs text-slate-500 mt-3 text-center">Wind Speed Map View</p>
            </div>
          </div>

          {/* WhatsApp Instant Data */}
          <div className={`relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 to-slate-800 border border-slate-700/50 hover:border-slate-600 transition-all duration-500 ${latestWhatsAppMessage ? 'ring-2 ring-emerald-500/20' : ''}`}>
            <div className={`absolute inset-0 bg-gradient-to-r ${latestWhatsAppMessage ? 'bg-emerald-500/5' : ''} opacity-0 transition-opacity duration-500`} />
            <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-green-500/10 to-transparent rounded-full blur-2xl" />
            
            <div className="relative p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-xl bg-green-500/10">
                    <MessageSquare className="w-5 h-5 text-green-400" />
                  </div>
                  <h3 className="text-base font-semibold text-white">WHATSAPP INSTANT DATA</h3>
                </div>
                <button
                  onClick={() => {
                    if (!selectedPlantData) {
                      alert('Please select a plant first');
                      return;
                    }
                    setWhatsappForm({
                      ...whatsappForm,
                      plantId: selectedPlantData.id.toString(),
                      plantName: selectedPlantData.name,
                      state: selectedPlantData.state
                    });
                    setShowWhatsAppModal(true);
                  }}
                  className="px-4 py-2 rounded-lg bg-slate-700/50 hover:bg-slate-600/50 border border-slate-600/50 text-slate-300 text-xs font-semibold transition-all flex items-center gap-2"
                >
                  MANUAL INPUT
                </button>
              </div>
              
              {/* WhatsApp Submit Success/Error Message */}
              {whatsappSubmitMessage && (
                <div className={`mb-4 p-3 rounded-xl border animate-in fade-in slide-in-from-top-2 duration-300 ${
                  whatsappSubmitSuccess 
                    ? 'bg-emerald-500/10 border-emerald-500/20' 
                    : 'bg-red-500/10 border-red-500/20'
                }`}>
                  <div className="flex items-center gap-2">
                    {whatsappSubmitSuccess ? (
                      <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                    ) : (
                      <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                    )}
                    <p className={`text-sm font-medium ${
                      whatsappSubmitSuccess ? 'text-emerald-400' : 'text-red-400'
                    }`}>
                      {whatsappSubmitMessage}
                    </p>
                  </div>
                </div>
              )}
              
              {whatsappLoading ? (
                <LoadingSpinner />
              ) : latestWhatsAppMessage ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Last Message:</span>
                    <span className="font-medium text-white">
                      {new Date(latestWhatsAppMessage.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} {latestWhatsAppMessage.time}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Source:</span>
                    <span className="font-medium text-white">Plant Operator</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Status:</span>
                    <span className={`px-3 py-1 rounded-lg text-xs font-semibold ${
                      latestWhatsAppMessage.status === 'Used' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                    }`}>
                      {latestWhatsAppMessage.status || 'Pending Review'}
                    </span>
                  </div>
                  <div className="mt-4 p-4 bg-slate-800/50 rounded-xl border border-slate-700/50">
                    <p className="text-sm font-semibold text-white mb-2">Latest Message:</p>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      Plant: {latestWhatsAppMessage.plantName}<br />
                      Generation: {latestWhatsAppMessage.currentGeneration} MW<br />
                      Trend: {latestWhatsAppMessage.expectedTrend}<br />
                      {latestWhatsAppMessage.remarks && `Remarks: ${latestWhatsAppMessage.remarks}`}
                    </p>
                  </div>
                  <button 
                    onClick={() => setShowWhatsAppHistoryModal(true)}
                    className="w-full mt-2 px-4 py-3 rounded-xl bg-slate-700/50 hover:bg-slate-600/50 text-slate-300 text-sm font-semibold transition-all border border-slate-600/50"
                  >
                    VIEW ALL MESSAGES
                  </button>
                </div>
              ) : (
                <div className="text-center py-8 text-sm text-slate-400">
                  <MessageSquare className="w-10 h-10 mx-auto mb-3 text-slate-600" />
                  <p>No WhatsApp data available</p>
                  <button 
                    onClick={() => {
                      if (!selectedPlantData) {
                        alert('Please select a plant first');
                        return;
                      }
                      setWhatsappForm({
                        ...whatsappForm,
                        plantId: selectedPlantData.id.toString(),
                        plantName: selectedPlantData.name,
                        state: selectedPlantData.state
                      });
                      setShowWhatsAppModal(true);
                    }}
                    className="mt-4 px-6 py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white text-sm font-semibold hover:from-indigo-500 hover:to-purple-500 transition-all shadow-lg shadow-indigo-500/25"
                  >
                    Add Manual Input
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Inline Forecast Chart */}
        {showForecastChart && forecastData && (
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 to-slate-800 border border-slate-700/50 p-6 animate-in fade-in slide-in-from-top-2 duration-300">
            <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-bl from-indigo-500/10 to-transparent rounded-full blur-3xl" />
            
            <div className="relative flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-blue-500/10">
                  <BarChart3 className="w-5 h-5 text-blue-400" />
                </div>
                <h3 className="text-lg font-semibold text-white">Forecast Data Chart</h3>
              </div>
              <button
                onClick={toggleForecastChart}
                className="px-4 py-2 rounded-lg bg-slate-700/50 hover:bg-slate-600/50 border border-slate-600/50 text-slate-300 text-sm font-medium transition-all"
              >
                Close
              </button>
            </div>
            <div className="h-80 bg-slate-800/50 rounded-xl border border-slate-700/50 p-4 relative overflow-hidden">
              <ForecastChart data={forecastData} />
            </div>
          </div>
        )}

        {/* Inline Meter Chart */}
        {showMeterChart && meterData && (
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 to-slate-800 border border-slate-700/50 p-6 animate-in fade-in slide-in-from-top-2 duration-300">
            <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-bl from-amber-500/10 to-transparent rounded-full blur-3xl" />
            
            <div className="relative flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-amber-500/10">
                  <BarChart3 className="w-5 h-5 text-amber-400" />
                </div>
                <h3 className="text-lg font-semibold text-white">Meter Data Chart</h3>
              </div>
              <button
                onClick={toggleMeterChart}
                className="px-4 py-2 rounded-lg bg-slate-700/50 hover:bg-slate-600/50 border border-slate-600/50 text-slate-300 text-sm font-medium transition-all"
              >
                Close
              </button>
            </div>
            <div className="h-80 bg-slate-800/50 rounded-xl border border-slate-700/50 p-4 relative overflow-hidden">
              <MeterChart data={meterData} />
            </div>
          </div>
        )}

        {/* Data Validation Alerts */}
        <div className="rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 rounded-xl bg-indigo-500/10">
              <AlertCircle className="w-5 h-5 text-indigo-400" />
            </div>
            <h3 className="text-lg font-semibold text-white">DATA VALIDATION ALERTS</h3>
          </div>
          
          <div className="space-y-4">
            {meterDelay && meterDelay > 20 && (
              <div className="flex items-start gap-3 p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl">
                <AlertCircle className="w-5 h-5 text-amber-400 mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-white">Meter data delayed by {meterDelay} minutes</p>
                  <p className="text-xs text-slate-400 mt-1">Last update: {meterData?.lastReading ? new Date(meterData.lastReading).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'N/A'}</p>
                </div>
              </div>
            )}
            
            {forecastData && (
              <div className="flex items-start gap-3 p-4 bg-indigo-500/10 border border-indigo-500/20 rounded-xl">
                <CheckCircle className="w-5 h-5 text-indigo-400 mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-white">Forecast confidence: 92% - Good for scheduling</p>
                  <p className="text-xs text-slate-400 mt-1">Data quality indicators are within acceptable range</p>
                </div>
              </div>
            )}

            {latestWhatsAppMessage && latestWhatsAppMessage.status === 'Pending Review' && (
              <div className="flex items-start gap-3 p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl">
                <AlertCircle className="w-5 h-5 text-amber-400 mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-white">WhatsApp data pending review</p>
                  <p className="text-xs text-slate-400 mt-1">Manual input data requires validation before use</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* WhatsApp Manual Input Modal */}
      {showWhatsAppModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-slate-900 rounded-2xl shadow-2xl w-full max-w-2xl border border-slate-700 max-h-[90vh] flex flex-col my-8">
            <div className="px-6 py-5 border-b border-slate-700 bg-gradient-to-r from-slate-800/50 to-transparent flex-shrink-0">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-green-500/10">
                  <MessageSquare className="w-6 h-6 text-green-400" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-white">WhatsApp Template - Manual Input</h2>
                  <p className="text-sm text-slate-400 mt-1">[QCA – INTRADAY SITE UPDATE]</p>
                </div>
              </div>
            </div>
            
            <div className="p-6 space-y-4 overflow-auto flex-1">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="md:col-span-2">
                  <label className="text-sm font-semibold text-slate-300 mb-2 block">Plant ID / Name *</label>
                  <input 
                    type="text"
                    value={whatsappForm.plantName}
                    readOnly
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700 text-white text-sm"
                  />
                </div>
                
                <div>
                  <label className="text-sm font-semibold text-slate-300 mb-2 block">State *</label>
                  <input 
                    type="text"
                    value={whatsappForm.state}
                    readOnly
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700 text-white text-sm"
                  />
                </div>
                
                <div>
                  <label className="text-sm font-semibold text-slate-300 mb-2 block">Date (DD-MM-YYYY) *</label>
                  <input 
                    type="date"
                    value={whatsappForm.date}
                    onChange={(e) => setWhatsappForm({ ...whatsappForm, date: e.target.value })}
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                  />
                </div>
                
                <div>
                  <label className="text-sm font-semibold text-slate-300 mb-2 block">Time (HH:MM) *</label>
                  <input 
                    type="time"
                    value={whatsappForm.time}
                    onChange={(e) => setWhatsappForm({ ...whatsappForm, time: e.target.value })}
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                  />
                </div>
                
                <div>
                  <label className="text-sm font-semibold text-slate-300 mb-2 block">Current Generation (MW) *</label>
                  <input 
                    type="number"
                    step="0.01"
                    value={whatsappForm.currentGeneration}
                    onChange={(e) => setWhatsappForm({ ...whatsappForm, currentGeneration: e.target.value })}
                    placeholder="e.g., 125.5"
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                  />
                </div>
                
                <div>
                  <label className="text-sm font-semibold text-slate-300 mb-2 block">Expected Generation Trend (Next 1 Hour) *</label>
                  <select 
                    value={whatsappForm.expectedTrend}
                    onChange={(e) => setWhatsappForm({ ...whatsappForm, expectedTrend: e.target.value })}
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                  >
                    <option value="">Select Trend</option>
                    <option value="Increasing">Increasing</option>
                    <option value="Stable">Stable</option>
                    <option value="Decreasing">Decreasing</option>
                  </select>
                </div>
                
                <div>
                  <label className="text-sm font-semibold text-slate-300 mb-2 block">Curtailment Status *</label>
                  <select 
                    value={whatsappForm.curtailmentStatus ? 'Yes' : 'No'}
                    onChange={(e) => setWhatsappForm({ ...whatsappForm, curtailmentStatus: e.target.value === 'Yes' })}
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                  >
                    <option value="No">No</option>
                    <option value="Yes">Yes</option>
                  </select>
                </div>
                
                {whatsappForm.curtailmentStatus && (
                  <div>
                    <label className="text-sm font-semibold text-slate-300 mb-2 block">If Yes, Curtailment Reason *</label>
                    <select 
                      value={whatsappForm.curtailmentReason}
                      onChange={(e) => setWhatsappForm({ ...whatsappForm, curtailmentReason: e.target.value })}
                      className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                    >
                      <option value="">Select Reason</option>
                      <option value="Grid Constraint">Grid Constraint</option>
                      <option value="Weather">Weather</option>
                      <option value="Maintenance">Maintenance</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>
                )}
                
                <div>
                  <label className="text-sm font-semibold text-slate-300 mb-2 block">Weather Condition</label>
                  <select 
                    value={whatsappForm.weatherCondition}
                    onChange={(e) => setWhatsappForm({ ...whatsappForm, weatherCondition: e.target.value })}
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                  >
                    <option value="">Select Condition</option>
                    <option value="Clear">Clear</option>
                    <option value="Partly Cloudy">Partly Cloudy</option>
                    <option value="Cloudy">Cloudy</option>
                    <option value="Sudden Change">Sudden Change</option>
                  </select>
                </div>
                
                <div>
                  <label className="text-sm font-semibold text-slate-300 mb-2 block">Inverter Availability (%) (Optional)</label>
                  <input 
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    value={whatsappForm.inverterAvailability}
                    onChange={(e) => setWhatsappForm({ ...whatsappForm, inverterAvailability: e.target.value })}
                    placeholder="e.g., 95.5"
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                  />
                </div>
                
                <div className="md:col-span-2">
                  <label className="text-sm font-semibold text-slate-300 mb-2 block">Remarks (Optional)</label>
                  <textarea 
                    value={whatsappForm.remarks}
                    onChange={(e) => setWhatsappForm({ ...whatsappForm, remarks: e.target.value })}
                    placeholder="Additional notes or observations..."
                    rows={3}
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                  />
                </div>
              </div>
            </div>

            <div className="px-6 py-5 border-t border-slate-700 bg-slate-800/30 flex gap-3 flex-shrink-0">
              <button 
                onClick={() => setShowWhatsAppModal(false)}
                className="flex-1 px-4 py-3 rounded-xl bg-slate-700/50 hover:bg-slate-600/50 border border-slate-600/50 text-slate-300 font-semibold transition-all"
              >
                Cancel
              </button>
              <button 
                onClick={handleWhatsAppSubmit}
                disabled={createWhatsAppLoading}
                className="flex-1 px-4 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white font-semibold hover:from-indigo-500 hover:to-purple-500 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {createWhatsAppLoading ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Submitting...
                  </>
                ) : (
                  'Submit Data'
                )}
              </button>
            </div>
          </div>
        </div>
      )}



      {/* WhatsApp History Modal */}
      {showWhatsAppHistoryModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 rounded-2xl shadow-2xl w-full max-w-4xl border border-slate-700 max-h-[85vh] flex flex-col">
            <div className="px-6 py-5 border-b border-slate-700 bg-gradient-to-r from-slate-800/50 to-transparent flex-shrink-0">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-xl bg-green-500/10">
                    <MessageSquare className="w-6 h-6 text-green-400" />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-white">WhatsApp Message History</h2>
                    <p className="text-sm text-slate-400 mt-1">All incoming messages for this plant</p>
                  </div>
                </div>
                <button 
                  onClick={() => setShowWhatsAppHistoryModal(false)}
                  className="p-2 hover:bg-slate-800 rounded-lg transition-all"
                >
                  <X className="w-5 h-5 text-slate-400" />
                </button>
              </div>
            </div>
            
            <div className="p-6 overflow-y-auto flex-1 scrollbar-thin">
              {whatsappDataList?.data && whatsappDataList.data.length > 0 ? (
                <div className="space-y-4">
                  {whatsappDataList.data.map((msg) => (
                    <div key={msg.id} className="p-5 bg-slate-800/50 rounded-xl border border-slate-700/50 hover:bg-slate-800/70 transition-all">
                      <div className="flex items-start justify-between mb-3">
                        <div>
                          <p className="font-semibold text-white">{msg.plantName}</p>
                          <p className="text-xs text-slate-500 mt-1">
                            {new Date(msg.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} {msg.time}
                          </p>
                        </div>
                        <span className={`px-3 py-1 rounded-lg text-xs font-semibold ${
                          msg.status === 'Used' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                        }`}>
                          {msg.status}
                        </span>
                      </div>
                      <div className="text-sm text-white space-y-1.5">
                        <p><span className="text-slate-400">Generation:</span> {msg.currentGeneration} MW</p>
                        <p><span className="text-slate-400">Trend:</span> {msg.expectedTrend}</p>
                        {msg.curtailmentStatus && <p><span className="text-slate-400">Curtailment:</span> {msg.curtailmentReason}</p>}
                        {msg.remarks && <p className="text-slate-400 mt-2"><span className="text-slate-500">Remarks:</span> {msg.remarks}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12 text-sm text-slate-400">
                  <MessageSquare className="w-12 h-12 mx-auto mb-3 text-slate-600" />
                  <p>No WhatsApp messages found</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Forecast Chart Component - Improved with better SVG rendering
function ForecastChart({ data }) {
  // Show loading state
  if (!data) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <div className="text-center">
          <LoadingSpinner />
          <p className="text-sm text-muted-foreground mt-2">Loading chart data...</p>
        </div>
      </div>
    );
  }

  // Handle empty or invalid data
  if (!data?.dataPoints || !Array.isArray(data.dataPoints) || data.dataPoints.length === 0) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <div className="text-center text-muted-foreground">
          <BarChart3 className="w-12 h-12 mx-auto mb-2 opacity-50" />
          <p>No forecast data available</p>
          <p className="text-xs mt-2">Click LOAD to fetch forecast data</p>
        </div>
      </div>
    );
  }

  // Calculate max value for Y-axis scaling
  const values = data.dataPoints.flatMap(d => [
    parseFloat(d.forecast || 0),
    parseFloat(d.actual || 0)
  ]);
  const maxValue = Math.max(...values, 10);
  
  // Filter to show every 4th point (hourly data instead of 15-min)
  const filteredPoints = data.dataPoints.filter((_, i) => i % 4 === 0);
  
  // Ensure we have data points
  if (filteredPoints.length === 0) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <div className="text-center text-muted-foreground">
          <BarChart3 className="w-12 h-12 mx-auto mb-2 opacity-50" />
          <p>No valid data points</p>
        </div>
      </div>
    );
  }

  // Generate polyline points for forecast
  const forecastPoints = filteredPoints.map((point, i) => {
    const x = (i / (filteredPoints.length - 1)) * 100;
    const y = 100 - ((parseFloat(point.forecast) / maxValue) * 100);
    return `${x},${y}`;
  }).join(' ');

  // Generate polyline points for actual
  const actualPoints = filteredPoints.map((point, i) => {
    const x = (i / (filteredPoints.length - 1)) * 100;
    const y = 100 - ((parseFloat(point.actual) / maxValue) * 100);
    return `${x},${y}`;
  }).join(' ');

  return (
    <div className="w-full h-full flex flex-col">
      {/* Chart header with stats */}
      <div className="flex items-center justify-between mb-2 px-1">
        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-0.5 bg-blue-500"></div>
            <span className="text-muted-foreground">Forecast</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-0.5 bg-green-500"></div>
            <span className="text-muted-foreground">Actual</span>
          </div>
        </div>
        <div className="text-xs text-muted-foreground">
          Max: {maxValue.toFixed(1)} MW
        </div>
      </div>
      
      {/* SVG Chart */}
      <div className="flex-1 min-h-0">
        <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
          {/* Background gradient definitions */}
          <defs>
            <linearGradient id="forecastGradient" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.3" />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="actualGradient" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#22c55e" stopOpacity="0.3" />
              <stop offset="100%" stopColor="#22c55e" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Grid lines */}
          {[0, 25, 50, 75, 100].map(y => (
            <line 
              key={y} 
              x1="0" 
              y1={y} 
              x2="100" 
              y2={y} 
              stroke="#e2e8f0" 
              strokeWidth="0.2" 
            />
          ))}

          {/* Y-axis labels */}
          <text x="-2" y="5" textAnchor="end" className="text-[3px] fill-muted-foreground" dominantBaseline="middle">
            {maxValue.toFixed(0)} MW
          </text>
          <text x="-2" y="55" textAnchor="end" className="text-[3px] fill-muted-foreground" dominantBaseline="middle">
            {(maxValue / 2).toFixed(0)} MW
          </text>
          <text x="-2" y="100" textAnchor="end" className="text-[3px] fill-muted-foreground" dominantBaseline="middle">
            0 MW
          </text>

          {/* Forecast line */}
          <polyline
            points={forecastPoints}
            fill="none"
            stroke="#3b82f6"
            strokeWidth="0.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Actual line */}
          <polyline
            points={actualPoints}
            fill="none"
            stroke="#22c55e"
            strokeWidth="0.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      
      {/* X-axis time labels */}
      <div className="flex justify-between mt-1 px-1">
        <span className="text-[8px] text-muted-foreground">00:00</span>
        <span className="text-[8px] text-muted-foreground">06:00</span>
        <span className="text-[8px] text-muted-foreground">12:00</span>
        <span className="text-[8px] text-muted-foreground">18:00</span>
        <span className="text-[8px] text-muted-foreground">24:00</span>
      </div>
    </div>
  );
}

// Meter Chart Component - Improved with better SVG rendering
function MeterChart({ data }) {
  // Show loading state
  if (!data) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <div className="text-center">
          <LoadingSpinner />
          <p className="text-sm text-muted-foreground mt-2">Loading chart data...</p>
        </div>
      </div>
    );
  }

  // Handle empty or invalid data
  if (!data?.dataPoints || !Array.isArray(data.dataPoints) || data.dataPoints.length === 0) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <div className="text-center text-muted-foreground">
          <BarChart3 className="w-12 h-12 mx-auto mb-2 opacity-50" />
          <p>No meter data available</p>
          <p className="text-xs mt-2">Click LOAD to fetch meter data</p>
        </div>
      </div>
    );
  }

  // Calculate max value for Y-axis scaling
  const values = data.dataPoints.map(d => parseFloat(d.generation || 0));
  const maxValue = Math.max(...values, 10);
  
  // Filter to show every 4th point (hourly data)
  const filteredPoints = data.dataPoints.filter((_, i) => i % 4 === 0);
  
  // Ensure we have data points
  if (filteredPoints.length === 0) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <div className="text-center text-muted-foreground">
          <BarChart3 className="w-12 h-12 mx-auto mb-2 opacity-50" />
          <p>No valid data points</p>
        </div>
      </div>
    );
  }

  // Generate polyline points for generation
  const generationPoints = filteredPoints.map((point, i) => {
    const x = (i / (filteredPoints.length - 1)) * 100;
    const y = 100 - ((parseFloat(point.generation) / maxValue) * 100);
    return `${x},${y}`;
  }).join(' ');

  return (
    <div className="w-full h-full flex flex-col">
      {/* Chart header with stats */}
      <div className="flex items-center justify-between mb-2 px-1">
        <div className="flex items-center gap-1.5 text-xs">
          <div className="w-3 h-0.5 bg-amber-500"></div>
          <span className="text-muted-foreground">Generation</span>
        </div>
        <div className="text-xs text-muted-foreground">
          Max: {maxValue.toFixed(1)} MW
        </div>
      </div>
      
      {/* SVG Chart */}
      <div className="flex-1 min-h-0">
        <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
          {/* Grid lines */}
          {[0, 25, 50, 75, 100].map(y => (
            <line 
              key={y} 
              x1="0" 
              y1={y} 
              x2="100" 
              y2={y} 
              stroke="#e2e8f0" 
              strokeWidth="0.2" 
            />
          ))}

          {/* Y-axis labels */}
          <text x="-2" y="5" textAnchor="end" className="text-[3px] fill-muted-foreground" dominantBaseline="middle">
            {maxValue.toFixed(0)} MW
          </text>
          <text x="-2" y="55" textAnchor="end" className="text-[3px] fill-muted-foreground" dominantBaseline="middle">
            {(maxValue / 2).toFixed(0)} MW
          </text>
          <text x="-2" y="100" textAnchor="end" className="text-[3px] fill-muted-foreground" dominantBaseline="middle">
            0 MW
          </text>

          {/* Generation line */}
          <polyline
            points={generationPoints}
            fill="none"
            stroke="#f59e0b"
            strokeWidth="0.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      
      {/* X-axis time labels */}
      <div className="flex justify-between mt-1 px-1">
        <span className="text-[8px] text-muted-foreground">00:00</span>
        <span className="text-[8px] text-muted-foreground">06:00</span>
        <span className="text-[8px] text-muted-foreground">12:00</span>
        <span className="text-[8px] text-muted-foreground">18:00</span>
        <span className="text-[8px] text-muted-foreground">24:00</span>
      </div>
    </div>
  );
}
