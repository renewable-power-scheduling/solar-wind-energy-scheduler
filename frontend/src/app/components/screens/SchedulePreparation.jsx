
import { useState, useMemo, useEffect } from 'react';
import { 
  Save, 
  Download, 
  CheckCircle, 
  AlertTriangle, 
  Edit3, 
  Calendar, 
  Wind,
  Sun,
  TrendingUp,
  Clock,
  FileText,
  X,
  RefreshCw,
  Upload,
  Trash2,
  AlertCircle,
  Layers,
  TrendingUp as TrendingUpIcon,
  Activity
} from 'lucide-react';
import { api } from '@/services/api';
import { useApi } from '@/hooks/useApi';
import { LoadingSpinner } from '@/app/components/common/LoadingSpinner';
import { ErrorMessage } from '@/app/components/common/ErrorMessage';
import { PLANTS, generateScheduleData } from '@/services/mockDataService';
import { toast } from 'sonner';

export function SchedulePreparation({ onNavigate, context, filters }) {
  const [showExportModal, setShowExportModal] = useState(false);
  const [showValidationModal, setShowValidationModal] = useState(false);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [editingCell, setEditingCell] = useState(null);
  const [scheduleData, setScheduleData] = useState([]);
  const [currentScheduleId, setCurrentScheduleId] = useState(null);
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadError, setUploadError] = useState(null);
  const [validationErrors, setValidationErrors] = useState([]);

  const [changes, setChanges] = useState([]);

  // Filter states for loading schedule data
  const [selectedState, setSelectedState] = useState(filters?.state || 'Select State');
  const [selectedPlant, setSelectedPlant] = useState(filters?.plant || 'Select Plant');
  const [selectedDate, setSelectedDate] = useState(filters?.date || new Date().toISOString().split('T')[0]);
  const [selectedType, setSelectedType] = useState('Day-Ahead');
  const [isDataLoaded, setIsDataLoaded] = useState(false);
  const [loadedScheduleInfo, setLoadedScheduleInfo] = useState(null);

  // Fetch plants for dropdown
  const { data: plantsData } = useApi(
    () => api.plants.getAll({ state: selectedState !== 'Select State' ? selectedState : undefined }),
    { immediate: true, initialData: { plants: [], total: 0, stats: {} } }
  );

  // Fetch schedules
  const {
    data: schedulesData,
    loading: schedulesLoading,
    error: schedulesError,
    execute: fetchSchedules
  } = useApi(
    () => api.schedules.getAll({
      plant: selectedPlant !== 'Select Plant' ? selectedPlant : undefined,
      type: selectedType,
      startDate: selectedDate
    }),
    { immediate: false, initialData: { schedules: [], total: 0 } }
  );

  // API hooks for CRUD operations
  const {
    loading: createLoading,
    execute: createSchedule
  } = useApi(api.schedules.create, {
    onSuccess: () => {
      setShowSaveModal(false);
      fetchSchedules();
      alert('Schedule saved successfully!');
    },
    onError: (error) => {
      alert(`Error saving schedule: ${error.message}`);
    }
  });

  const {
    loading: updateLoading,
    execute: updateSchedule
  } = useApi(api.schedules.update, {
    onSuccess: () => {
      setShowEditModal(false);
      fetchSchedules();
      alert('Schedule updated successfully!');
    },
    onError: (error) => {
      alert(`Error updating schedule: ${error.message}`);
    }
  });

  const {
    loading: deleteLoading,
    execute: deleteSchedule
  } = useApi(api.schedules.delete, {
    onSuccess: () => {
      setShowDeleteModal(false);
      setScheduleData([]);
      setIsDataLoaded(false);
      fetchSchedules();
      alert('Schedule deleted successfully!');
    },
    onError: (error) => {
      alert(`Error deleting schedule: ${error.message}`);
    }
  });

  // Submit schedule to database
  const {
    loading: submitLoading,
    execute: submitScheduleData
  } = useApi(api.schedules.submit, {
    onSuccess: () => {
      setShowSubmitModal(false);
      alert('Schedule submitted successfully to the database!');
      // Navigate back to dashboard
      onNavigate('dashboard');
    },
    onError: (error) => {
      alert(`Error submitting schedule: ${error.message}`);
    }
  });

  // Handle actual submit action
  const handleSubmitToDatabase = async () => {
    // Calculate totals
    const totalScheduled = scheduleData.reduce((sum, row) => sum + parseFloat(row.scheduled || 0), 0);
    const totalForecasted = scheduleData.reduce((sum, row) => sum + parseFloat(row.forecast || 0), 0);
    const totalActual = scheduleData.reduce((sum, row) => sum + parseFloat(row.actual || 0), 0);

    const submitPayload = {
      plantName: context?.plant || loadedScheduleInfo?.plant,
      type: context?.type || selectedType,
      scheduleDate: selectedDate,
      capacity: totalScheduled,
      forecasted: totalForecasted,
      actual: totalActual,
      status: 'Submitted',
      scheduleData: scheduleData
    };

    await submitScheduleData(submitPayload);
  };

const {
    loading: uploadLoading,
    execute: bulkUpload
  } = useApi(api.schedules.bulkUpload, {
    onSuccess: (data) => {
      setShowUploadModal(false);
      setUploadFile(null);
      setUploadError(null);
      alert(`Successfully imported ${data.imported} schedules. ${data.failed > 0 ? `${data.failed} failed.` : ''}`);
      // Refresh schedules list immediately
      fetchSchedules();
      // Also reload current schedule if filters match
      if (selectedState !== 'Select State' && selectedPlant !== 'Select Plant') {
        setTimeout(() => {
          handleLoadData();
        }, 1000);
      } else {
        // If no filters selected, just refresh the schedules list
        // Force a re-render by updating state
        setIsDataLoaded(false);
        setScheduleData([]);
      }
    },
    onError: (error) => {
      setUploadError(error.message || 'Upload failed. Please check the CSV format.');
    }
  });

  // New hook for 96-block upload
  const {
    loading: upload96Loading,
    execute: upload96Blocks
  } = useApi(api.schedules.upload96Blocks, {
    onSuccess: (data) => {
      if (data.success) {
        alert(`Schedule uploaded successfully with ${data.totalBlocks} time blocks!\nPlant: ${data.plantName}\nDeviation: ${data.deviation}%`);
        
        // Load the schedule data
        const scheduleDataResult = convertBlockDataToSchedule(data.blockData || generateMockBlockData());
        setScheduleData(scheduleDataResult);
        setIsDataLoaded(true);
        setCurrentScheduleId(data.scheduleId);
        setLoadedScheduleInfo({
          state: selectedState,
          plant: selectedPlant,
          date: selectedDate,
          type: selectedType,
          scheduleId: data.scheduleId,
          totalBlocks: data.totalBlocks,
          totalForecasted: data.totalForecasted,
          totalActual: data.totalActual,
          deviation: data.deviation
        });
        
        setShowUploadModal(false);
        setUploadFile(null);
        setUploadError(null);
      } else {
        setUploadError(data.message || 'Upload failed');
      }
    },
    onError: (error) => {
      setUploadError(error.message || 'Upload failed. Please check the CSV format.');
    }
  });

  // Helper function to convert block data to schedule table format
  const convertBlockDataToSchedule = (blockData) => {
    if (!blockData || Object.keys(blockData).length === 0) {
      // Return mock data if no block data
      return Array.from({ length: 96 }, (_, i) => {
        const hour = Math.floor(i / 4);
        const minute = (i % 4) * 15;
        const forecastValue = (45 + Math.random() * 10).toFixed(1);
        
        return {
          time: `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`,
          forecast: forecastValue,
          actual: (46 + Math.random() * 10).toFixed(1),
          scheduled: forecastValue,
        };
      });
    }
    
    // Convert block data to array format
    return Object.values(blockData).map(block => ({
      time: block.time,
      forecast: block.forecasted?.toFixed(1) || '0.0',
      actual: block.actual?.toFixed(1) || '0.0',
      scheduled: block.scheduled?.toFixed(1) || block.forecasted?.toFixed(1) || '0.0',
    }));
  };

  // Available plants based on selected state
  const availablePlants = useMemo(() => {
    if (!plantsData?.plants) return ['Select Plant'];
    if (selectedState === 'Select State') {
      return ['Select Plant'];
    }
    const filtered = plantsData.plants.filter(p => p.state === selectedState);
    return ['Select Plant', ...filtered.map(p => p.name)];
  }, [plantsData, selectedState]);

  // Handle state change - reset plant selection
  const handleStateChange = (state) => {
    setSelectedState(state);
    setSelectedPlant('Select Plant');
  };

  // Handle file upload for 96 blocks
  const handle96BlockUpload = async () => {
    if (!uploadFile) {
      setUploadError('Please select a file');
      return;
    }

    if (!uploadFile.name.endsWith('.csv')) {
      setUploadError('Only CSV files are supported');
      return;
    }

    if (selectedPlant === 'Select Plant') {
      setUploadError('Please select a plant first');
      return;
    }

    setUploadError(null);
    await upload96Blocks(uploadFile, selectedPlant, selectedType, selectedDate);
  };

  // Handle load data button click - fetch from API
  const handleLoadData = async () => {
    if (selectedState === 'Select State' || selectedPlant === 'Select Plant') {
      alert('Please select both State and Plant to load data');
      return;
    }

    try {
      await fetchSchedules();
      
      // If schedule exists, load it; otherwise create empty schedule
      if (schedulesData?.schedules && schedulesData.schedules.length > 0) {
        const schedule = schedulesData.schedules[0];
        setCurrentScheduleId(schedule.id);
        
        // Generate 96 time blocks from schedule data
        const data = Array.from({ length: 96 }, (_, i) => {
          const hour = Math.floor(i / 4);
          const minute = (i % 4) * 15;
          const forecastValue = schedule.forecasted || (45 + Math.random() * 10).toFixed(1);
          
          return {
            time: `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`,
            forecast: forecastValue,
            actual: schedule.actual || (46 + Math.random() * 10).toFixed(1),
            scheduled: forecastValue,
          };
        });
        
        setScheduleData(data);
        setIsDataLoaded(true);
        setLoadedScheduleInfo({
          state: selectedState,
          plant: selectedPlant,
          date: selectedDate,
          type: selectedType,
          scheduleId: schedule.id
        });
      } else {
        // No existing schedule, create empty one
        const data = Array.from({ length: 96 }, (_, i) => {
          const hour = Math.floor(i / 4);
          const minute = (i % 4) * 15;
          const forecastValue = (45 + Math.random() * 10).toFixed(1);
          
          return {
            time: `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`,
            forecast: forecastValue,
            actual: (46 + Math.random() * 10).toFixed(1),
            scheduled: forecastValue,
          };
        });
        
        setScheduleData(data);
        setIsDataLoaded(true);
        setLoadedScheduleInfo({
          state: selectedState,
          plant: selectedPlant,
          date: selectedDate,
          type: selectedType
        });
      }
    } catch (error) {
      alert(`Error loading schedule: ${error.message}`);
    }
  };

  // Handle file upload (legacy bulk upload)
  const handleFileUpload = async () => {
    if (!uploadFile) {
      setUploadError('Please select a file');
      return;
    }

    if (!uploadFile.name.endsWith('.csv')) {
      setUploadError('Only CSV files are supported');
      return;
    }

    setUploadError(null);
    await bulkUpload(uploadFile);
  };

  // Handle save schedule
  const handleSaveSchedule = async () => {
    // Validate schedule data
    const errors = validateScheduleData();
    if (errors.length > 0) {
      setValidationErrors(errors);
      setShowValidationModal(true);
      return;
    }

    // Calculate totals
    const totalScheduled = scheduleData.reduce((sum, row) => sum + parseFloat(row.scheduled || 0), 0);
    const totalForecasted = scheduleData.reduce((sum, row) => sum + parseFloat(row.forecast || 0), 0);
    const totalActual = scheduleData.reduce((sum, row) => sum + parseFloat(row.actual || 0), 0);

    // Build block data
    const blockData = {};
    scheduleData.forEach((row, i) => {
      const hour = Math.floor(i / 4);
      const minute = (i % 4) * 15;
      blockData[`block_${i + 1}`] = {
        block: i + 1,
        time: row.time,
        forecasted: parseFloat(row.forecast) || 0,
        actual: parseFloat(row.actual) || 0,
        scheduled: parseFloat(row.scheduled) || 0
      };
    });

    const schedulePayload = {
      plantName: selectedPlant,
      type: selectedType,
      scheduleDate: selectedDate,
      capacity: parseFloat((totalScheduled / 96).toFixed(2)),
      forecasted: parseFloat(totalForecasted.toFixed(2)),
      actual: parseFloat(totalActual.toFixed(2)),
      status: 'Pending',
      blockData: blockData
    };

    if (currentScheduleId) {
      await updateSchedule(currentScheduleId, schedulePayload);
    } else {
      await createSchedule(schedulePayload);
    }
  };

  // Validate schedule data
  const validateScheduleData = () => {
    const errors = [];
    
    if (scheduleData.length !== 96) {
      errors.push('Schedule must contain exactly 96 time blocks');
    }

    scheduleData.forEach((row, index) => {
      const scheduled = parseFloat(row.scheduled);
      if (isNaN(scheduled) || scheduled < 0) {
        errors.push(`Invalid scheduled value at ${row.time}`);
      }
      if (scheduled > 1000) {
        errors.push(`Scheduled value too high at ${row.time} (max 1000 MW)`);
      }
    });

    return errors;
  };

  // Handle delete schedule
  const handleDeleteSchedule = async () => {
    if (currentScheduleId) {
      await deleteSchedule(currentScheduleId);
    } else {
      setScheduleData([]);
      setIsDataLoaded(false);
      setShowDeleteModal(false);
    }
  };


  const fromDashboard = context?.fromDashboard;

  // Auto-load schedule data when navigated from Dashboard
  useEffect(() => {
    if (fromDashboard && context?.plant && context?.type) {
      // Set the context values as initial state
      setSelectedPlant(context.plant);
      setSelectedType(context.type);
      // Generate the schedule data automatically
      handleLoadDataFromDashboard();
    }
  }, [fromDashboard, context?.plant, context?.type, context?.category]);

  // Handle load data from Dashboard context
  const handleLoadDataFromDashboard = () => {
    // Find the plant from PLANTS array
    const plant = PLANTS.find(p => p.name === context?.plant) || PLANTS[0];
    
    // Use centralized mock data service for consistent data
    const scheduleDataResult = generateScheduleData(plant.id, selectedDate, context?.type || 'Day-Ahead');
    
    setScheduleData(scheduleDataResult);
    setIsDataLoaded(true);
    setLoadedScheduleInfo({
      plant: context.plant,
      category: context.category || plant.category,
      type: context.type,
      date: selectedDate,
      scheduleId: null
    });
  };

  // Loading state
  if (schedulesLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-950">
        <div className="flex flex-col items-center gap-6">
          <div className="relative">
            <div className="w-20 h-20 rounded-full border-4 border-slate-800 border-t-indigo-500 animate-spin" />
            <div className="absolute inset-0 w-20 h-20 rounded-full border-4 border-transparent border-b-purple-500 animate-spin" style={{ animationDirection: 'reverse', animationDuration: '1.5s' }} />
          </div>
          <div className="flex flex-col items-center gap-2">
            <p className="text-lg font-semibold text-white">Loading Schedule</p>
            <p className="text-sm text-slate-400">Fetching schedule data...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="flex-1 overflow-auto bg-slate-950 min-h-0">
        {/* Animated background elements */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-0 left-1/4 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl animate-pulse" />
          <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />
        </div>

        <div className="p-8 space-y-8 max-w-[1800px] mx-auto relative z-10">
          {/* Premium Page Header */}
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 border border-slate-700/50 shadow-2xl">
            <div className="absolute inset-0 bg-gradient-to-r from-indigo-500/5 via-transparent to-purple-500/5" />
            <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-bl from-indigo-500/10 to-transparent rounded-full blur-2xl" />
            
            <div className="relative p-8">
              <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-6">
                <div className="flex items-start gap-5">
                  <div className="relative">
                    <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/25">
                      <Calendar className="w-7 h-7 text-white" />
                    </div>
                    <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-emerald-500 rounded-full border-2 border-slate-900 animate-ping" />
                  </div>
                  <div>
                    <h1 className="text-3xl font-bold text-white mb-2 tracking-tight">
                      Schedule Preparation
                    </h1>
                    <div className="flex items-center gap-4 text-slate-400">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
                        <span className="text-sm font-medium">Ready</span>
                      </div>
                      <span className="text-slate-600">•</span>
                      <span className="text-sm">Create & Manage Schedules</span>
                    </div>
                  </div>
                </div>
                
                <div className="flex gap-4">
                  {!fromDashboard && (
                    <button 
                      onClick={() => setShowUploadModal(true)}
                      className="group relative px-6 py-3 rounded-xl bg-slate-800/50 hover:bg-slate-700/50 border border-slate-700/50 hover:border-slate-600 transition-all duration-300 flex items-center gap-3"
                    >
                      <Upload className="w-5 h-5 text-indigo-400" />
                      <div className="text-left">
                        <p className="text-sm font-semibold text-white">Upload CSV</p>
                        <p className="text-xs text-slate-400">Import schedule</p>
                      </div>
                    </button>
                  )}
                  <button 
                    onClick={handleSaveSchedule}
                    disabled={createLoading || updateLoading}
                    className="group relative px-6 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white shadow-lg shadow-indigo-500/25 hover:shadow-indigo-500/40 transition-all duration-300 flex items-center gap-3 disabled:opacity-70"
                  >
                    <Save className="w-5 h-5" />
                    <div className="text-left">
                      <p className="text-sm font-semibold">{createLoading || updateLoading ? 'Saving...' : 'Save Draft'}</p>
                      <p className="text-xs text-indigo-200">Keep progress</p>
                    </div>
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Premium Filters */}
          {!fromDashboard && (
            <div className="rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm p-6">
              <div className="flex items-center gap-3 mb-6">
                <div className="p-3 rounded-xl bg-indigo-500/10">
                  <Layers className="w-6 h-6 text-indigo-400" />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-white">Load Schedule Data</h3>
                  <p className="text-sm text-slate-400">Select parameters to load schedule data</p>
                </div>
              </div>
              
              <div className="grid grid-cols-5 gap-4">
                <div className="relative">
                  <label className="text-xs font-medium text-slate-400 mb-2 block">State</label>
                  <select 
                    value={selectedState}
                    onChange={(e) => handleStateChange(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700/50 text-slate-300 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all cursor-pointer appearance-none"
                  >
                    <option>Select State</option>
                    <option>Maharashtra</option>
                    <option>Gujarat</option>
                    <option>Rajasthan</option>
                  </select>
                </div>
                <div className="relative">
                  <label className="text-xs font-medium text-slate-400 mb-2 block">Plant</label>
                  <select 
                    value={selectedPlant}
                    onChange={(e) => setSelectedPlant(e.target.value)}
                    disabled={selectedState === 'Select State'}
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700/50 text-slate-300 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all cursor-pointer appearance-none disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {availablePlants.map(plant => (
                      <option key={plant}>{plant}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-400 mb-2 block">Date</label>
                  <input 
                    type="date" 
                    value={selectedDate}
                    onChange={(e) => setSelectedDate(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700/50 text-slate-300 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                  />
                </div>
                <div className="relative">
                  <label className="text-xs font-medium text-slate-400 mb-2 block">Type</label>
                  <select 
                    value={selectedType}
                    onChange={(e) => setSelectedType(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700/50 text-slate-300 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all cursor-pointer appearance-none"
                  >
                    <option>Day-Ahead</option>
                    <option>Intraday</option>
                  </select>
                </div>
                <div className="flex items-end">
                  <button 
                    onClick={handleLoadData}
                    className="w-full px-6 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white font-semibold hover:from-indigo-500 hover:to-purple-500 transition-all duration-300 shadow-lg shadow-indigo-500/25"
                  >
                    Load Data
                  </button>
                </div>
              </div>
              {isDataLoaded && (
                <div className="mt-6 p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl flex items-center gap-3">
                  <CheckCircle className="w-5 h-5 text-emerald-400" />
                  <span className="text-sm font-semibold text-emerald-400">
                    Schedule data loaded successfully for {loadedScheduleInfo.plant}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Premium Chart and Status Panel */}
          {(isDataLoaded || fromDashboard) && (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Premium Chart */}
                <div className="rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm p-6">
                  <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-3">
                      <div className="p-3 rounded-xl bg-indigo-500/10">
                        <TrendingUpIcon className="w-6 h-6 text-indigo-400" />
                      </div>
                      <div>
                        <h3 className="text-xl font-bold text-white">Forecast vs Actual vs Schedule</h3>
                        <p className="text-sm text-slate-400">Real-time comparison</p>
                      </div>
                    </div>
                    <button
                      onClick={() => onNavigate('forecast', {
                        plant: fromDashboard ? context.plant : loadedScheduleInfo?.plant,
                        category: fromDashboard ? context.category : loadedScheduleInfo?.category
                      })}
                      className="px-4 py-2 rounded-xl bg-slate-800/50 text-slate-300 text-sm font-semibold hover:bg-slate-700 hover:text-white transition-all duration-300 border border-slate-700"
                    >
                      View Full →
                    </button>
                  </div>
                  
                  <div className="h-56 bg-slate-800/30 rounded-xl border border-slate-700/50 p-4 relative overflow-hidden">
                    <div className="absolute inset-4">
                      <svg className="w-full h-full">
                        {[0, 25, 50, 75, 100].map(y => (
                          <line 
                            key={y}
                            x1="0" 
                            y1={`${y}%`} 
                            x2="100%" 
                            y2={`${y}%`} 
                            stroke="#334155" 
                            strokeWidth="1"
                            strokeDasharray="4 4"
                          />
                        ))}
                        
                        <polyline 
                          points="0,40 15,38 30,35 45,33 60,35 75,38 90,40 100,42" 
                          fill="none" 
                          stroke="#818cf8" 
                          strokeWidth="3"
                        />
                        
                        <polyline 
                          points="0,45 15,42 30,38 45,36 60,38 75,41 90,44 100,46" 
                          fill="none" 
                          stroke="#34d399" 
                          strokeWidth="3"
                        />
                        
                        <polyline 
                          points="0,42 15,40 30,37 45,35 60,37 75,40 90,43 100,45" 
                          fill="none" 
                          stroke="#94a3b8" 
                          strokeWidth="3"
                        />
                      </svg>
                    </div>
                    
                    <div className="absolute bottom-3 left-4 flex gap-4 bg-slate-900/80 px-4 py-2 rounded-lg border border-slate-700 text-xs">
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full bg-indigo-400"></div>
                        <span className="text-slate-300">Forecast</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full bg-emerald-400"></div>
                        <span className="text-slate-300">Actual</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full bg-slate-400"></div>
                        <span className="text-slate-300">Schedule</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Premium Status Panel */}
                <div className="rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm p-6">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="p-3 rounded-xl bg-emerald-500/10">
                      <Activity className="w-6 h-6 text-emerald-400" />
                    </div>
                    <div>
                      <h3 className="text-xl font-bold text-white">Schedule Status</h3>
                      <p className="text-sm text-slate-400">Overview of current schedule</p>
                    </div>
                  </div>
                  
                  <div className="space-y-4">
                    <div className="p-5 bg-slate-800/50 rounded-xl border border-slate-700/50">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className={`p-3 rounded-xl ${
                            (fromDashboard ? context.category : loadedScheduleInfo?.category) === 'Wind' 
                              ? 'bg-gradient-to-br from-blue-500/20 to-cyan-500/20' 
                              : 'bg-gradient-to-br from-amber-500/20 to-orange-500/20'
                          }`}>
                            <Wind className={`w-6 h-6 ${(fromDashboard ? context.category : loadedScheduleInfo?.category) === 'Wind' ? 'text-blue-400' : 'text-amber-400'}`} />
                          </div>
                          <div>
                            <p className="text-base font-semibold text-white">
                              {fromDashboard ? context.plant : isDataLoaded ? loadedScheduleInfo.plant : 'Wind Farm A'}
                            </p>
                            <p className="text-xs text-slate-400">
                              {fromDashboard ? context.type : isDataLoaded ? loadedScheduleInfo.type : 'Day-Ahead'} Schedule
                            </p>
                          </div>
                        </div>
                        <div className="px-3 py-1.5 bg-emerald-500/10 text-emerald-400 text-xs font-semibold rounded-lg border border-emerald-500/20">
                          Active
                        </div>
                      </div>
                    </div>

                    {/* Plant Category Badge */}
                    <div className="p-5 bg-slate-800/50 rounded-xl border border-slate-700/50">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-xs font-medium text-slate-400 mb-1">Plant Category</p>
                          <p className="text-sm font-semibold text-white">
                            {fromDashboard ? context.category : loadedScheduleInfo?.category}
                          </p>
                        </div>
                        <div className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${
                          (fromDashboard ? context.category : loadedScheduleInfo?.category) === 'Wind' 
                            ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20' 
                            : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                        }`}>
                          {fromDashboard ? context.category : loadedScheduleInfo?.category}
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="p-5 bg-slate-800/50 rounded-xl border border-slate-700/50">
                        <div className="flex items-center gap-2 mb-2">
                          <CheckCircle className="w-4 h-4 text-emerald-400" />
                          <span className="text-xs font-medium text-slate-400">Total Blocks</span>
                        </div>
                        <p className="text-3xl font-bold text-white bg-gradient-to-r from-emerald-400 to-teal-400 bg-clip-text text-transparent">96</p>
                      </div>
                      
                      <div className="p-5 bg-slate-800/50 rounded-xl border border-slate-700/50">
                        <div className="flex items-center gap-2 mb-2">
                          <Edit3 className="w-4 h-4 text-amber-400" />
                          <span className="text-xs font-medium text-slate-400">Modified</span>
                        </div>
                        <p className="text-3xl font-bold text-white bg-gradient-to-r from-amber-400 to-orange-400 bg-clip-text text-transparent">{changes.length}</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

          {/* Premium Manual Changes Log */}
          <div className="rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm p-6">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-xl bg-amber-500/10">
                  <Clock className="w-6 h-6 text-amber-400" />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-white">Manual Changes Log</h3>
                  <p className="text-sm text-slate-400">Track all modifications made to the schedule</p>
                </div>
              </div>
              <div className="px-4 py-2 bg-amber-500/10 text-amber-400 text-sm font-semibold rounded-xl border border-amber-500/20">
                {changes.length} Changes
              </div>
            </div>
            
            <div className="space-y-3">
              {changes.map((change, i) => (
                <div key={i} className="p-5 bg-slate-800/50 rounded-xl border border-slate-700/50 flex items-center justify-between hover:bg-slate-800/70 transition-all duration-300 group">
                  <div className="flex items-center gap-4">
                    <div className="p-3 bg-amber-500/10 rounded-xl group-hover:bg-amber-500/20 transition-colors">
                      <Clock className="w-5 h-5 text-amber-400" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-white">Time Block: {change.time}</p>
                      <p className="text-xs text-slate-400 mt-1">
                        Changed from <span className="font-semibold text-red-400">{change.oldValue} MW</span> to{' '}
                        <span className="font-semibold text-emerald-400">{change.newValue} MW</span>
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-emerald-400">+{((parseFloat(change.newValue) - parseFloat(change.oldValue)) / parseFloat(change.oldValue) * 100).toFixed(1)}%</span>
                    <TrendingUpIcon className="w-5 h-5 text-emerald-400" />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Premium Schedule Data Table */}
          <div className="rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm overflow-hidden">
            <div className="p-6 border-b border-slate-700/50 bg-gradient-to-r from-slate-800/50 to-transparent">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-3 rounded-xl bg-indigo-500/10">
                    <FileText className="w-6 h-6 text-indigo-400" />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-white">15-Minute Schedule Blocks</h3>
                    <p className="text-sm text-slate-400">96 blocks for 24-hour period</p>
                  </div>
                </div>
                <button 
                  onClick={() => setShowExportModal(true)}
                  className="px-6 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white font-semibold hover:from-indigo-500 hover:to-purple-500 transition-all duration-300 flex items-center gap-2 shadow-lg shadow-indigo-500/25"
                >
                  <Download className="w-5 h-5" />
                  Export CSV
                </button>
              </div>
            </div>
            
            <div className="overflow-auto max-h-96">
              <table className="w-full">
                <thead className="bg-slate-800/50 backdrop-blur-sm sticky top-0 z-10">
                  <tr>
                    {['Time Block', 'Forecast (MW)', 'Actual (MW)', 'Scheduled (MW)', 'Status', 'Action'].map(header => (
                      <th key={header} className="px-6 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {scheduleData.map((row, i) => {
                    const hour = Math.floor(i / 4);
                    const minute = (i % 4) * 15;
                    const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
                    const hasChange = changes.some(c => c.time === timeStr);
                    
                    return (
                      <tr key={i} className={`group hover:bg-slate-800/30 transition-all duration-300 ${hasChange ? 'bg-amber-500/5' : ''}`}>
                        <td className="px-6 py-5">
                          <div className="flex items-center gap-3">
                            <div className="p-2 bg-slate-800 rounded-lg group-hover:bg-slate-700 transition-colors">
                              <Clock className="w-4 h-4 text-slate-400" />
                            </div>
                            <span className="text-sm font-semibold text-white">{timeStr}</span>
                          </div>
                        </td>
                        <td className="px-6 py-5 text-sm text-slate-400">
                         {row.forecast}
                        </td>
                        <td className="px-6 py-5 text-sm text-slate-400">
                         {row.actual}
                        </td>
                        <td className="px-6 py-5">
                          {editingCell?.row === i ? (
                            <input
                              type="number"
                              step="0.1"
                              defaultValue={row.scheduled || row.forecast}
                              onBlur={(e) => {
                                const newValue = e.target.value;
                                const updatedData = [...scheduleData];
                                updatedData[i].scheduled = newValue;
                                setScheduleData(updatedData);
                                
                                // Track change in changes log
                                const timeStr = `${Math.floor(i / 4).toString().padStart(2, '0')}:${((i % 4) * 15).toString().padStart(2, '0')}`;
                                const existingChange = changes.find(c => c.time === timeStr);
                                if (existingChange) {
                                  setChanges(changes.map(c => 
                                    c.time === timeStr 
                                      ? { ...c, newValue }
                                      : c
                                  ));
                                } else {
                                  setChanges([...changes, {
                                    time: timeStr,
                                    oldValue: row.forecast,
                                    newValue: newValue
                                  }]);
                                }
                                
                                setEditingCell(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.target.blur();
                                } else if (e.key === 'Escape') {
                                  setEditingCell(null);
                                }
                              }}
                              className="w-24 px-3 py-2 rounded-xl bg-slate-800 border border-indigo-500/50 text-sm font-semibold text-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                              autoFocus
                            />
                          ) : (
                            <span className="text-sm font-semibold text-indigo-400">
                              {row.scheduled || row.forecast}
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-5">
                          {hasChange ? (
                            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                              <Edit3 className="w-3 h-3" />
                              Modified
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                              <CheckCircle className="w-3 h-3" />
                              Original
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-5">
                          <button 
                            onClick={() => setEditingCell({ row: i })}
                            className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300 text-sm font-semibold hover:bg-slate-700 hover:text-white transition-all duration-300 border border-slate-700"
                          >
                            {editingCell?.row === i ? 'Cancel' : 'Edit'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          </>
        )}
        </div>
      </div>

      {/* Export Modal */}
      {showExportModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-lg shadow-xl w-full max-w-md border border-border">
            <div className="px-6 py-4 border-b border-border bg-muted/20">
              <h2 className="text-lg font-semibold text-foreground">Export Schedule</h2>
              <p className="text-sm text-muted-foreground mt-1">Download schedule in CSV format</p>
            </div>
            
            <div className="p-6 space-y-4">
              <div className="p-4 bg-primary/5 border border-primary/20 rounded">
                <p className="text-sm text-foreground">
                  This will export all 96 time blocks with forecast, actual, and scheduled values.
                </p>
              </div>
              
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">File Name</label>
                <input 
                  type="text"
                  defaultValue="schedule_2026-01-15.csv"
                  className="w-full px-3 py-2 rounded border border-border bg-input-background focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>

            <div className="px-6 py-4 border-t border-border bg-muted/20 flex gap-3">
              <button 
                onClick={() => setShowExportModal(false)}
                className="flex-1 px-4 py-2 rounded border border-border hover:bg-accent transition-all font-medium"
              >
                Cancel
              </button>
              <button 
                onClick={() => {
                  if (scheduleData.length === 0) {
                    alert('No schedule data to export. Please load data first.');
                    return;
                  }
                  const headers = ['Time Block', 'Forecast (MW)', 'Actual (MW)', 'Scheduled (MW)'];
                  const csvContent = [
                    headers.join(','),
                    ...scheduleData.map(row => [
                      row.time,
                      row.forecast,
                      row.actual,
                      row.scheduled || row.forecast
                    ].join(','))
                  ].join('\n');

                  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
                  const link = document.createElement('a');
                  const url = URL.createObjectURL(blob);
                  link.setAttribute('href', url);
                  const filename = `schedule-${loadedScheduleInfo?.plant || 'export'}-${loadedScheduleInfo?.date || new Date().toISOString().split('T')[0]}.csv`;
                  link.setAttribute('download', filename);
                  link.style.visibility = 'hidden';
                  document.body.appendChild(link);
                  link.click();
                  document.body.removeChild(link);
                  setShowExportModal(false);
                }}
                className="flex-1 px-4 py-2 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-all font-medium flex items-center justify-center gap-2"
              >
                <Download className="w-4 h-4" />
                Download
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Validation Modal */}
      {showValidationModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-lg shadow-xl w-full max-w-lg border border-border">
            <div className="px-6 py-4 border-b border-border bg-muted/20">
              <h2 className="text-lg font-semibold text-foreground">Validation Results</h2>
              <p className="text-sm text-muted-foreground mt-1">Schedule validation check</p>
            </div>
            
            <div className="p-6 space-y-4">
              <div className="p-5 bg-success/5 border border-success/20 rounded flex items-start gap-3">
                <CheckCircle className="w-6 h-6 text-success flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold text-success">Validation Passed</p>
                  <p className="text-sm text-foreground mt-1">All 96 time blocks are valid and ready for submission.</p>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between p-3 bg-muted/30 rounded">
                  <span className="text-sm text-muted-foreground">Total Blocks</span>
                  <span className="text-sm font-semibold">96</span>
                </div>
                <div className="flex items-center justify-between p-3 bg-muted/30 rounded">
                  <span className="text-sm text-muted-foreground">Valid Blocks</span>
                  <span className="text-sm font-semibold text-success">96</span>
                </div>
                <div className="flex items-center justify-between p-3 bg-muted/30 rounded">
                  <span className="text-sm text-muted-foreground">Modified Blocks</span>
                  <span className="text-sm font-semibold text-warning">{changes.length}</span>
                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-border bg-muted/20">
              <button 
                onClick={() => setShowValidationModal(false)}
                className="w-full px-4 py-2 rounded bg-success text-white hover:bg-success/90 transition-all font-medium"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}

{/* Upload Modal */}
      {showUploadModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-lg shadow-xl w-full max-w-lg border border-border">
            <div className="px-6 py-4 border-b border-border bg-muted/30">
              <h2 className="text-lg font-semibold text-foreground">Upload Schedule CSV</h2>
              <p className="text-sm text-muted-foreground mt-1">Upload schedule data with 96 time blocks (15-min intervals)</p>
            </div>
            
            <div className="p-6 space-y-4">
              <div className="p-4 bg-primary/10 border border-primary/20 rounded-lg">
                <p className="text-sm font-medium text-foreground mb-2">CSV Format for 96-Block Upload:</p>
                <p className="text-xs text-muted-foreground font-mono">
                  block,time,forecasted,actual,scheduled<br />
                  1,00:00,45.2,48.5,45.2<br />
                  2,00:15,46.1,47.8,46.1<br />
                  ...<br />
                  96,23:45,44.8,46.2,44.8
                </p>
              </div>

              <div className="border-2 border-dashed border-border rounded-lg p-8 text-center hover:border-primary transition-all cursor-pointer group">
                <input 
                  type="file"
                  accept=".csv"
                  onChange={(e) => {
                    setUploadFile(e.target.files?.[0] || null);
                    setUploadError(null);
                  }}
                  className="hidden"
                  id="csv-upload"
                />
                <label htmlFor="csv-upload" className="cursor-pointer">
                  <Upload className="w-12 h-12 text-muted-foreground mx-auto mb-3 group-hover:text-primary transition-colors" />
                  <p className="text-sm font-medium text-foreground mb-1">Drop CSV file here or click to browse</p>
                  <p className="text-xs text-muted-foreground">Maximum file size: 10MB</p>
                  {uploadFile && (
                    <p className="text-xs text-primary mt-2 font-medium">Selected: {uploadFile.name}</p>
                  )}
                </label>
              </div>

              {uploadError && (
                <div className="p-3 bg-destructive/10 border border-destructive/20 rounded flex items-start gap-2">
                  <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-destructive">{uploadError}</p>
                </div>
              )}

              <div className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  id="use96Blocks"
                  checked={true}
                  readOnly
                  className="w-4 h-4 rounded border-border text-primary"
                />
                <label htmlFor="use96Blocks" className="text-foreground">
                  Use 96-block format (recommended for schedule preparation)
                </label>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-border bg-muted/20 flex gap-3">
              <button 
                onClick={() => {
                  setShowUploadModal(false);
                  setUploadFile(null);
                  setUploadError(null);
                }}
                className="flex-1 px-4 py-2 rounded border border-border hover:bg-accent transition-all font-medium"
              >
                Cancel
              </button>
              <button 
                onClick={handle96BlockUpload}
                disabled={!uploadFile || upload96Loading}
                className="flex-1 px-4 py-2 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-all font-medium disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {upload96Loading ? (
                  <>
                    <LoadingSpinner size="sm" />
                    Uploading...
                  </>
                ) : (
                  <>
                    <Upload className="w-4 h-4" />
                    Upload 96 Blocks
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-lg shadow-xl w-full max-w-md border border-border">
            <div className="px-6 py-4 border-b border-border bg-destructive/10">
              <h2 className="text-lg font-semibold text-foreground">Delete Schedule</h2>
              <p className="text-sm text-muted-foreground mt-1">This action cannot be undone</p>
            </div>
            
            <div className="p-6 space-y-4">
              <div className="p-4 bg-destructive/10 border border-destructive/20 rounded flex items-start gap-3">
                <AlertTriangle className="w-6 h-6 text-destructive flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold text-destructive">Warning</p>
                  <p className="text-sm text-foreground mt-1">
                    Are you sure you want to delete this schedule? All schedule data will be permanently removed.
                  </p>
                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-border bg-muted/20 flex gap-3">
              <button 
                onClick={() => setShowDeleteModal(false)}
                className="flex-1 px-4 py-2 rounded border border-border hover:bg-accent transition-all font-medium"
              >
                Cancel
              </button>
              <button 
                onClick={handleDeleteSchedule}
                disabled={deleteLoading}
                className="flex-1 px-4 py-2 rounded bg-destructive text-white hover:bg-destructive/90 transition-all font-medium disabled:opacity-50"
              >
                {deleteLoading ? 'Deleting...' : 'Delete Schedule'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {showEditModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-lg shadow-xl w-full max-w-md border border-border">
            <div className="px-6 py-4 border-b border-border bg-muted/20">
              <h2 className="text-lg font-semibold text-foreground">Edit Schedule</h2>
              <p className="text-sm text-muted-foreground mt-1">Update schedule information</p>
            </div>
            
            <div className="p-6 space-y-4">
              <div>
                <label className="text-sm font-medium text-foreground mb-2 block">Schedule Type</label>
                <select 
                  value={selectedType}
                  onChange={(e) => setSelectedType(e.target.value)}
                  className="w-full px-3 py-2 rounded border border-border bg-input-background focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option>Day-Ahead</option>
                  <option>Intraday</option>
                </select>
              </div>
              <div>
                <label className="text-sm font-medium text-foreground mb-2 block">Schedule Date</label>
                <input 
                  type="date"
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  className="w-full px-3 py-2 rounded border border-border bg-input-background focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>

            <div className="px-6 py-4 border-t border-border bg-muted/20 flex gap-3">
              <button 
                onClick={() => setShowEditModal(false)}
                className="flex-1 px-4 py-2 rounded border border-border hover:bg-accent transition-all font-medium"
              >
                Cancel
              </button>
              <button 
                onClick={() => {
                  handleSaveSchedule();
                  setShowEditModal(false);
                }}
                disabled={updateLoading}
                className="flex-1 px-4 py-2 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-all font-medium disabled:opacity-50"
              >
                {updateLoading ? 'Updating...' : 'Update Schedule'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Submit Confirmation Modal */}
      {showSubmitModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-lg shadow-xl w-full max-w-md border border-border">
            <div className="px-6 py-4 border-b border-border bg-success/10">
              <h2 className="text-lg font-semibold text-foreground">Submit Schedule</h2>
              <p className="text-sm text-muted-foreground mt-1">Confirm submission to database</p>
            </div>
            
            <div className="p-6 space-y-4">
              <div className="p-4 bg-success/10 border border-success/20 rounded flex items-start gap-3">
                <CheckCircle className="w-6 h-6 text-success flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold text-foreground">Ready to Submit</p>
                  <p className="text-sm text-foreground mt-1">
                    Are you sure you want to submit this schedule to the database? 
                    This will make the schedule available for processing.
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between p-3 bg-muted/30 rounded">
                  <span className="text-sm text-muted-foreground">Plant</span>
                  <span className="text-sm font-semibold">{context?.plant || loadedScheduleInfo?.plant}</span>
                </div>
                <div className="flex items-center justify-between p-3 bg-muted/30 rounded">
                  <span className="text-sm text-muted-foreground">Type</span>
                  <span className="text-sm font-semibold">{context?.type || selectedType}</span>
                </div>
                <div className="flex items-center justify-between p-3 bg-muted/30 rounded">
                  <span className="text-sm text-muted-foreground">Modified Blocks</span>
                  <span className="text-sm font-semibold text-warning">{changes.length}</span>
                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-border bg-muted/20 flex gap-3">
              <button 
                onClick={() => setShowSubmitModal(false)}
                className="flex-1 px-4 py-2 rounded border border-border hover:bg-accent transition-all font-medium"
              >
                No, Cancel
              </button>
              <button 
                onClick={handleSubmitToDatabase}
                disabled={submitLoading}
                className="flex-1 px-4 py-2 rounded bg-success text-white hover:bg-success/90 transition-all font-medium disabled:opacity-50"
              >
                {submitLoading ? 'Submitting...' : 'Yes, Submit'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Validation Modal - Updated */}
      {showValidationModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-lg shadow-xl w-full max-w-lg border border-border">
            <div className="px-6 py-4 border-b border-border bg-muted/20">
              <h2 className="text-lg font-semibold text-foreground">Validation Results</h2>
              <p className="text-sm text-muted-foreground mt-1">Schedule validation check</p>
            </div>
            
            <div className="p-6 space-y-4">
              {validationErrors.length === 0 ? (
                <div className="p-5 bg-success/5 border border-success/20 rounded flex items-start gap-3">
                  <CheckCircle className="w-6 h-6 text-success flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold text-success">Validation Passed</p>
                    <p className="text-sm text-foreground mt-1">All 96 time blocks are valid and ready for submission.</p>
                  </div>
                </div>
              ) : (
                <div className="p-5 bg-destructive/5 border border-destructive/20 rounded flex items-start gap-3">
                  <AlertTriangle className="w-6 h-6 text-destructive flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold text-destructive">Validation Failed</p>
                    <ul className="text-sm text-foreground mt-1 list-disc list-inside">
                      {validationErrors.map((error, i) => (
                        <li key={i}>{error}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <div className="flex items-center justify-between p-3 bg-muted/30 rounded">
                  <span className="text-sm text-muted-foreground">Total Blocks</span>
                  <span className="text-sm font-semibold">{scheduleData.length}</span>
                </div>
                <div className="flex items-center justify-between p-3 bg-muted/30 rounded">
                  <span className="text-sm text-muted-foreground">Valid Blocks</span>
                  <span className="text-sm font-semibold text-success">{scheduleData.length - validationErrors.length}</span>
                </div>
                <div className="flex items-center justify-between p-3 bg-muted/30 rounded">
                  <span className="text-sm text-muted-foreground">Modified Blocks</span>
                  <span className="text-sm font-semibold text-warning">{changes.length}</span>
                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-border bg-muted/20">
              <button 
                onClick={() => setShowValidationModal(false)}
                className={`w-full px-4 py-2 rounded transition-all font-medium ${
                  validationErrors.length === 0
                    ? 'bg-success text-white hover:bg-success/90'
                    : 'border border-border hover:bg-accent'
                }`}
              >
                {validationErrors.length === 0 ? 'Continue' : 'Close'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}