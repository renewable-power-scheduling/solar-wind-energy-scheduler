import { Filter, ChevronDown, Plus, X, Trash2, Trash, Layers, TrendingUp, FileText, Download, RefreshCw, CheckCircle, MinusCircle, Clock } from 'lucide-react';
import { useState, useMemo, useEffect } from 'react';
import { Activity, AlertCircle, Eye, Edit, MoreHorizontal, X as XIcon, Wind, Sun, Zap, Upload, ArrowRight, AlertTriangle } from 'lucide-react';
import { api } from '@/services/api';
import { useApi } from '@/hooks/useApi';
import { LoadingSpinner, SkeletonLoader } from '@/app/components/common/LoadingSpinner';
import { ErrorMessage } from '@/app/components/common/ErrorMessage';
import { generateDashboardSchedules, generateDashboardStats } from '@/services/mockDataService';
import { PlantForm } from '@/app/components/ui/PlantForm';
import { toast } from 'sonner';


// Helper function to export data as CSV
const exportToCSV = (data, filename = 'dashboard-report.csv') => {
  const headers = ['Time', 'Plant', 'Category', 'Type', 'Status', 'Manual Changes'];
  const csvContent = [
    headers.join(','),
    ...data.map(row => [
      row.time,
      row.plant,
      row.category,
      row.type,
      row.status,
      row.changes
    ].join(','))
  ].join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

// Normalize status values for filter & table consistency
const normalizeStatus = (status) => {
  if (!status) return '';

  switch (status.toLowerCase()) {
    case 'approved':
    case 'revised':
    case 'submitted':
      return 'Completed';
    case 'draft':
      return 'Draft';
    case 'pending':
      return 'Pending';
    default:
      return status;
  }
};

export function Dashboard({ onNavigate }) {
  // Filter states
  const [statusFilter, setStatusFilter] = useState('All');
  const [typeFilter, setTypeFilter] = useState('All');
  const [categoryFilter, setCategoryFilter] = useState('All');
  const [plantFilter, setPlantFilter] = useState('Select Plant');
  const [timeRangeFilter, setTimeRangeFilter] = useState('Last 24hr');
  const [timePeriodFilter, setTimePeriodFilter] = useState('Today');

  // Modal states
  const [showViewModal, setShowViewModal] = useState(false);
  const [showMoreModal, setShowMoreModal] = useState(false);
  const [selectedSchedule, setSelectedSchedule] = useState(null);
  const [showPlantForm, setShowPlantForm] = useState(false);
  
  // Remove plant modal states
  const [showRemovePlantModal, setShowRemovePlantModal] = useState(false);
  const [plantToRemove, setPlantToRemove] = useState(null);
  const [removingPlant, setRemovingPlant] = useState(false);

  // Live clock
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // API hooks
  // Use mock data directly to ensure consistent stats
  const statsData = useMemo(() => {
    return generateDashboardStats();
  }, []);

  const {
    data: plantsData,
    loading: plantsLoading,
    execute: fetchPlants
  } = useApi(() => api.plants.getAll({}), {
    immediate: false,
    initialData: { plants: [], total: 0 }
  });

  // Fetch plants when remove modal opens
  const handleRemovePlantClick = async () => {
    await fetchPlants();
    setShowRemovePlantModal(true);
  };

  const {
    data: schedulesData,
    loading: schedulesLoading,
    error: schedulesError,
    execute: fetchSchedules
  } = useApi(() => api.schedules.getAll({ limit: 10 }), {
    immediate: true,
    initialData: { schedules: [], total: 0 }
  });

  // Always use mock data for diverse demo - backend may return limited/single-type data
  // Using centralized mock data service for consistent data across all pages
  const allSchedules = useMemo(() => generateDashboardSchedules(), []);
  
  // State to track if user wants to see all schedules
  const [showAllSchedules, setShowAllSchedules] = useState(false);
  
  // Show all schedules or limited to 10 based on showAllSchedules state
  const schedules = showAllSchedules ? allSchedules : allSchedules.slice(0, 10);
  
  // parse "hh:mm AM/PM" into Date (assumes schedule time is today)
  const parseTimeToDate = (timeStr) => {
    const m = String(timeStr || '').trim().match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!m) return null;
    let hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    const ap = m[3].toUpperCase();
    if (ap === 'PM' && hh !== 12) hh += 12;
    if (ap === 'AM' && hh === 12) hh = 0;
    const d = new Date();
    d.setHours(hh, mm, 0, 0);
    return d;
  };

  // Filter schedules based on all active filters
  const filteredSchedules = useMemo(() => {
    return schedules.filter(schedule => {
      const matchesStatus = statusFilter === 'All' || normalizeStatus(schedule.status) === statusFilter;
      const matchesType = typeFilter === 'All' || schedule.type === typeFilter;
      const matchesCategory =
        categoryFilter === 'All' ||
        (categoryFilter === 'Wind Plants' && schedule.category === 'Wind') ||
        (categoryFilter === 'Solar Plants' && schedule.category === 'Solar');
      const matchesPlant = plantFilter === 'Select Plant' || schedule.plant === plantFilter;

      // time-range filtering: for mock data, assume all times are today
      // Only reject if explicitly outside range
      let matchesTimeRange = true;
      if (timeRangeFilter === 'Last 24hr') {
        matchesTimeRange = true; // all mock times are today
      } else if (timeRangeFilter === 'Last 1hr') {
        // For mock data: only show times within last hour from now
        const timeDate = parseTimeToDate(schedule.time);
        matchesTimeRange = timeDate ? ((Date.now() - timeDate.getTime()) <= 60 * 60 * 1000) : false;
      } else if (timeRangeFilter === 'Last Week') {
        matchesTimeRange = true; // all mock times are within last week
      }

      // time-period (Today / This Week) — with mock times (no date) assume Today matches; This Week matches all mock items
      const matchesTimePeriod = timePeriodFilter === 'Today' || timePeriodFilter === 'This Week';
      
      return matchesStatus && matchesType && matchesCategory && matchesPlant && matchesTimeRange && matchesTimePeriod;
    });
  }, [schedules, statusFilter, typeFilter, categoryFilter, plantFilter, timeRangeFilter, timePeriodFilter]);

  // Get unique plant names for dropdown
  const plantNames = useMemo(() => {
    return ['Select Plant', ...new Set(schedules.map(s => s.plant))];
  }, [schedules]);

  // Handler to export report
  const handleExportReport = () => {
    const dataToExport = filteredSchedules.length > 0 ? filteredSchedules : schedules;
    exportToCSV(dataToExport, `dashboard-report-${new Date().toISOString().split('T')[0]}.csv`);
  };

  // Handler to refresh all data
  const handleRefresh = async () => {
    setStatusFilter('All');
    setTypeFilter('All');
    setCategoryFilter('All');
    setPlantFilter('Select Plant');
    setTimeRangeFilter('Last 24hr');
    setTimePeriodFilter('Today');
    
    await fetchSchedules();
    toast.success('Dashboard data refreshed');
  };

  // Handlers for schedule actions
  const handleViewSchedule = (schedule) => {
    setSelectedSchedule(schedule);
    setShowViewModal(true);
  };

  const handleEditSchedule = (schedule) => {
    onNavigate('schedule', { 
      fromDashboard: true, 
      plant: schedule.plant, 
      category: schedule.category,
      type: schedule.type 
    });
  };

  // Handler to confirm and execute plant removal
  const handleConfirmRemovePlant = async () => {
    if (!plantToRemove) return;
    
    setRemovingPlant(true);
    try {
      await api.plants.delete(plantToRemove.id);
      setShowRemovePlantModal(false);
      setPlantToRemove(null);
      toast.success('Plant removed successfully');
    } catch (error) {
      console.error('Error removing plant:', error);
      toast.error('Failed to remove plant');
    } finally {
      setRemovingPlant(false);
    }
  };

  // Loading state - only show if plants are loading
  if (plantsLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-950">
        <div className="flex flex-col items-center gap-6">
          <div className="relative">
            <div className="w-20 h-20 rounded-full border-4 border-slate-800 border-t-indigo-500 animate-spin" />
            <div className="absolute inset-0 w-20 h-20 rounded-full border-4 border-transparent border-b-purple-500 animate-spin" style={{ animationDirection: 'reverse', animationDuration: '1.5s' }} />
          </div>
          <div className="flex flex-col items-center gap-2">
            <p className="text-lg font-semibold text-white">Loading Dashboard</p>
            <p className="text-sm text-slate-400">Fetching plants data...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      {showPlantForm && (
        <PlantForm 
          onClose={() => setShowPlantForm(false)}
          onPlantAdded={() => setShowPlantForm(false)}
        />
      )}
      
      <div className="flex-1 overflow-auto bg-slate-950 min-h-0">
        {/* Animated background elements */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-0 left-1/4 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl animate-pulse" />
          <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />
        </div>

        <div className="p-8 space-y-8 max-w-[1600px] mx-auto relative z-10">
          {/* Premium Page Header */}
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 border border-slate-700/50 shadow-2xl">
            <div className="absolute inset-0 bg-gradient-to-r from-indigo-500/5 via-transparent to-purple-500/5" />
            <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-bl from-indigo-500/10 to-transparent rounded-full blur-2xl" />
            
            <div className="relative p-8">
              <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-6">
                <div className="flex items-start gap-5">
                  <div className="relative">
                    <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/25">
                      <Activity className="w-7 h-7 text-white" />
                    </div>
                    <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-emerald-500 rounded-full border-2 border-slate-900 animate-ping" />
                  </div>
                  <div>
                    <h1 className="text-3xl font-bold text-white mb-2 tracking-tight">
                      Dashboard Overview
                    </h1>
                    <div className="flex items-center gap-4 text-slate-400">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
                        <span className="text-sm font-medium">Live Monitoring</span>
                      </div>
                      <span className="text-slate-600">•</span>
                      <span className="text-sm font-mono">{currentTime.toLocaleTimeString()}</span>
                      <span className="text-slate-600">•</span>
                      <span className="text-sm">{currentTime.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</span>
                    </div>
                  </div>
                </div>
                
                <div className="flex gap-4">
                  <button 
                    onClick={handleRefresh}
                    disabled={schedulesLoading}
                    className="group relative px-6 py-3 rounded-xl bg-slate-800/50 hover:bg-slate-700/50 border border-slate-700/50 hover:border-slate-600 transition-all duration-300 flex items-center gap-3 disabled:opacity-50"
                  >
                    <RefreshCw className={`w-5 h-5 text-indigo-400 ${schedulesLoading ? 'animate-spin' : 'group-hover:rotate-180 transition-transform duration-500'}`} />
                    <div className="text-left">
                      <p className="text-sm font-semibold text-white">Refresh</p>
                      <p className="text-xs text-slate-400">Update data</p>
                    </div>
                  </button>
                  <button 
                    onClick={handleExportReport}
                    disabled={schedulesLoading}
                    className="group relative px-6 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white shadow-lg shadow-indigo-500/25 hover:shadow-indigo-500/40 transition-all duration-300 flex items-center gap-3 disabled:opacity-70"
                  >
                    <Download className="w-5 h-5" />
                    <div className="text-left">
                      <p className="text-sm font-semibold">Export Report</p>
                      <p className="text-xs text-indigo-200">Download CSV</p>
                    </div>
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Premium Stats Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
            {[
              { label: 'Active Plants', value: statsData.activePlants, subtext: 'Currently operational', icon: Activity, gradient: 'from-emerald-600 to-teal-600', glow: 'bg-emerald-500/20' },
              { label: 'Total Capacity', value: `${statsData.totalCapacity} MW`, subtext: 'Installed capacity', icon: Zap, gradient: 'from-blue-600 to-cyan-600', glow: 'bg-blue-500/20' },
              { label: 'Current Generation', value: `${statsData.currentGeneration} MW`, subtext: 'Real-time output', icon: TrendingUp, gradient: 'from-amber-600 to-orange-600', glow: 'bg-amber-500/20' },
              { label: 'Efficiency', value: `${statsData.efficiency}%`, subtext: 'Overall performance', icon: Layers, gradient: 'from-purple-600 to-pink-600', glow: 'bg-purple-500/20' }
            ].map((stat, i) => (
              <div 
                key={i}
                className="group relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 to-slate-800 border border-slate-700/50 hover:border-slate-600 transition-all duration-500 hover:-translate-y-1 hover:shadow-2xl cursor-pointer"
              >
                <div className={`absolute inset-0 bg-gradient-to-r ${stat.glow} opacity-0 group-hover:opacity-100 transition-opacity duration-500`} />
                <div className={`absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl ${stat.glow} rounded-full blur-3xl opacity-50 group-hover:opacity-75 transition-opacity duration-500`} />
                
                <div className="relative p-6">
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <p className="text-sm font-medium text-slate-400 uppercase tracking-wider">{stat.label}</p>
                      <div className={`text-5xl font-bold mt-2 bg-gradient-to-r ${stat.gradient} bg-clip-text text-transparent`}>
                        {stat.value}
                      </div>
                    </div>
                    <div className={`p-3 rounded-xl bg-gradient-to-br ${stat.glow} group-hover:scale-110 transition-transform duration-300`}>
                      <stat.icon className="w-6 h-6 text-white" />
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-slate-400 group-hover:text-slate-300 transition-colors">
                    <TrendingUp className="w-4 h-4 text-indigo-400" />
                    {stat.subtext}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Premium Filters */}
          <div className="flex flex-wrap items-center gap-4 p-4 rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm">
            <div className="flex items-center gap-2 text-slate-400">
              <Filter className="w-5 h-5" />
              <span className="text-sm font-medium">Filters:</span>
            </div>
            
            <div className="flex flex-wrap gap-3">
              {/* Status Filter */}
              <div className="relative">
                <select 
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="px-4 py-2.5 rounded-xl bg-slate-800/50 border border-slate-700/50 text-slate-300 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all cursor-pointer appearance-none pr-10 hover:bg-slate-800 hover:border-slate-600"
                >
                  <option value="All">Status: All</option>
                  <option value="Completed">Status: Completed</option>
                  <option value="Draft">Status: Draft</option>
                  <option value="Pending">Status: Pending</option>
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
              </div>

              {/* Type Filter */}
              <div className="relative">
                <select 
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                  className="px-4 py-2.5 rounded-xl bg-slate-800/50 border border-slate-700/50 text-slate-300 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all cursor-pointer appearance-none pr-10 hover:bg-slate-800 hover:border-slate-600"
                >
                  <option value="All">Type: All</option>
                  <option value="Day-Ahead">Day-Ahead</option>
                  <option value="Intraday">Intraday</option>
                  <option value="Real-Time">Real-Time</option>
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
              </div>

              {/* Category Filter */}
              <div className="relative">
                <select 
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  className="px-4 py-2.5 rounded-xl bg-slate-800/50 border border-slate-700/50 text-slate-300 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all cursor-pointer appearance-none pr-10 hover:bg-slate-800 hover:border-slate-600"
                >
                  <option value="All">Category: All</option>
                  <option value="Wind Plants">Wind Plants</option>
                  <option value="Solar Plants">Solar Plants</option>
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
              </div>

              {/* Plant Filter */}
              <div className="relative">
                <select 
                  value={plantFilter}
                  onChange={(e) => setPlantFilter(e.target.value)}
                  className="px-4 py-2.5 rounded-xl bg-slate-800/50 border border-slate-700/50 text-slate-300 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all cursor-pointer appearance-none pr-10 hover:bg-slate-800 hover:border-slate-600 max-w-[200px]"
                >
                  {plantNames.map(name => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
              </div>

              {/* Time Range Filter */}
              <div className="relative">
                <select 
                  value={timeRangeFilter}
                  onChange={(e) => setTimeRangeFilter(e.target.value)}
                  className="px-4 py-2.5 rounded-xl bg-slate-800/50 border border-slate-700/50 text-slate-300 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all cursor-pointer appearance-none pr-10 hover:bg-slate-800 hover:border-slate-600"
                >
                  <option>Last 24hr</option>
                  <option>Last 1hr</option>
                  <option>Last Week</option>
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
              </div>

              {/* Clear Filters Button */}
              {(statusFilter !== 'All' || typeFilter !== 'All' || categoryFilter !== 'All' || plantFilter !== 'Select Plant') && (
                <button
                  onClick={() => {
                    setStatusFilter('All');
                    setTypeFilter('All');
                    setCategoryFilter('All');
                    setPlantFilter('Select Plant');
                  }}
                  className="px-4 py-2.5 rounded-xl bg-slate-800/50 border border-slate-700/50 text-slate-400 text-sm font-medium hover:text-white hover:bg-slate-700/50 transition-all"
                >
                  Clear Filters
                </button>
              )}
            </div>

            <div className="ml-auto flex gap-3">
              <button
                onClick={() => setShowPlantForm(true)}
                className="px-4 py-2.5 rounded-xl bg-slate-800/50 hover:bg-slate-700/50 border border-slate-700/50 text-slate-300 text-sm font-medium transition-all duration-300 flex items-center gap-2 hover:text-white"
              >
                <Plus className="w-4 h-4" />
                Add Plant
              </button>
              <button
                onClick={handleRemovePlantClick}
                className="px-4 py-2.5 rounded-xl bg-slate-800/50 hover:bg-red-900/30 border border-slate-700/50 text-red-400 text-sm font-medium transition-all duration-300 flex items-center gap-2 hover:border-red-700/50"
              >
                <Trash className="w-4 h-4" />
                Remove Plant
              </button>
            </div>
          </div>

          {/* Premium Activity Table */}
          <div className="rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm overflow-hidden">
            <div className="p-6 border-b border-slate-700/50 bg-gradient-to-r from-slate-800/50 to-transparent">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-xl bg-indigo-500/10">
                    <FileText className="w-6 h-6 text-indigo-400" />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-white">Recent Schedule Activity</h3>
                    <p className="text-sm text-slate-400 mt-1">Latest updates and actions</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button 
                    onClick={() => setTimePeriodFilter('Today')}
                    className={`relative px-4 py-2 text-sm font-semibold rounded-xl transition-all duration-300 ${
                      timePeriodFilter === 'Today' 
                        ? 'text-white' 
                        : 'text-slate-400 hover:text-white hover:bg-slate-800'
                    }`}
                  >
                    {timePeriodFilter === 'Today' && (
                      <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 shadow-lg shadow-indigo-500/25" />
                    )}
                    <span className="relative z-10">Today</span>
                  </button>
                  <button 
                    onClick={() => setTimePeriodFilter('This Week')}
                    className={`relative px-4 py-2 text-sm font-semibold rounded-xl transition-all duration-300 ${
                      timePeriodFilter === 'This Week' 
                        ? 'text-white' 
                        : 'text-slate-400 hover:text-white hover:bg-slate-800'
                    }`}
                  >
                    {timePeriodFilter === 'This Week' && (
                      <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 shadow-lg shadow-indigo-500/25" />
                    )}
                    <span className="relative z-10">This Week</span>
                  </button>
                </div>
              </div>
            </div>
            
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-800/50 backdrop-blur-sm">
                  <tr>
                    {['Time', 'Plant', 'Category', 'Type', 'Status', 'Manual Changes', 'Action'].map(header => (
                      <th key={header} className="px-6 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {filteredSchedules.length > 0 ? (
                    filteredSchedules.map((item) => {
                      const iconMap = { Wind, Sun };
                      const Icon = iconMap[item.icon] || (item.category === 'Wind' ? Wind : Sun);
                      const isSolar = item.category === 'Solar';
                      const status = normalizeStatus(item.status);
                      
                      return (
                        <tr key={`schedule-${item.id || item.time}-${item.plant}`} className="group hover:bg-slate-800/30 transition-all duration-300">
                          <td className="px-6 py-5 whitespace-nowrap text-sm text-slate-300">{item.time}</td>
                          <td className="px-6 py-5 whitespace-nowrap">
                            <div className="flex items-center gap-3">
                              <div className={`p-2 rounded-lg ${
                                isSolar 
                                  ? 'bg-gradient-to-br from-amber-500/20 to-orange-500/20' 
                                  : 'bg-gradient-to-br from-blue-500/20 to-cyan-500/20'
                              }`}>
                                <Icon className={`w-4 h-4 ${isSolar ? 'text-amber-400' : 'text-blue-400'}`} />
                              </div>
                              <span className="text-sm font-medium text-white group-hover:text-indigo-400 transition-colors">{item.plant}</span>
                            </div>
                          </td>
                          <td className="px-6 py-5 whitespace-nowrap">
                            <span className={`inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-semibold border ${
                              isSolar
                                ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                                : 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                            }`}>
                              {item.category}
                            </span>
                          </td>
                          <td className="px-6 py-5 whitespace-nowrap text-sm text-slate-300">{item.type}</td>
                          <td className="px-6 py-5 whitespace-nowrap">
                            <span className={`inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-semibold border ${
                              status === 'Completed'
                                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                                : status === 'Pending'
                                ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                                : status === 'Draft'
                                ? 'bg-red-500/10 text-red-400 border-red-500/20'
                                : 'bg-slate-500/10 text-slate-400 border-slate-500/20'
                            }`}>
                              {status === 'Completed' && <CheckCircle className="w-3.5 h-3.5 mr-1.5" />}
                              {status === 'Pending' && <Clock className="w-3.5 h-3.5 mr-1.5" />}
                              {status === 'Draft' && <MinusCircle className="w-3.5 h-3.5 mr-1.5" />}
                              {status}
                            </span>
                          </td>
                          <td className="px-6 py-5 whitespace-nowrap text-sm text-slate-400">{item.changes}</td>
                          <td className="px-6 py-5 whitespace-nowrap">
                            <div className="flex gap-2">
                              {status === 'Pending' && (
                                <>
                                  <button 
                                    onClick={() => handleViewSchedule(item)}
                                    className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 text-sm font-semibold hover:bg-slate-700 hover:text-white transition-all duration-300 flex items-center gap-2 border border-slate-700"
                                  >
                                    <Eye className="w-4 h-4" />
                                    View
                                  </button>
                                  <button 
                                    onClick={() => handleEditSchedule(item)}
                                    className="px-4 py-2 rounded-lg bg-gradient-to-r from-indigo-600 to-purple-600 text-white text-sm font-semibold hover:from-indigo-500 hover:to-purple-500 transition-all duration-300 flex items-center gap-2"
                                  >
                                    <Edit className="w-4 h-4" />
                                    Edit
                                  </button>
                                </>
                              )}
                              {status === 'Completed' && (
                                <button 
                                  onClick={() => handleViewSchedule(item)}
                                  className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 text-sm font-semibold hover:bg-slate-700 hover:text-white transition-all duration-300 flex items-center gap-2 border border-slate-700"
                                >
                                  <Eye className="w-4 h-4" />
                                  View
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan="7" className="px-6 py-20 text-center">
                        <div className="flex flex-col items-center gap-4">
                          <div className="p-4 rounded-full bg-slate-800/50">
                            <Filter className="w-10 h-10 text-slate-600" />
                          </div>
                          <div>
                            <p className="text-lg font-semibold text-slate-400">No schedules match your filters</p>
                            <p className="text-sm text-slate-500 mt-1">Try adjusting your filter criteria</p>
                          </div>
                          <button
                            onClick={() => {
                              setStatusFilter('All');
                              setTypeFilter('All');
                              setCategoryFilter('All');
                              setPlantFilter('Select Plant');
                            }}
                            className="px-4 py-2 rounded-lg bg-indigo-600/10 text-indigo-400 text-sm font-semibold hover:bg-indigo-600/20 transition-all duration-300"
                          >
                            Clear all filters
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="p-4 border-t border-slate-700/50 bg-slate-800/30 flex items-center justify-between">
              <p className="text-sm text-slate-400">
                Showing {filteredSchedules.length} of {showAllSchedules ? allSchedules.length : 10} schedules
              </p>
              <button 
                onClick={() => setShowAllSchedules(!showAllSchedules)}
                className="px-4 py-2 rounded-lg bg-slate-800/50 text-slate-300 text-sm font-semibold hover:bg-slate-700 hover:text-white transition-all duration-300"
              >
                {showAllSchedules ? 'Show less ↑' : 'View all schedules →'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Premium View Modal */}
      {showViewModal && selectedSchedule && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[85vh] flex flex-col border border-slate-700">
            <div className="px-6 py-5 border-b border-slate-700 flex-shrink-0 flex items-center justify-between bg-gradient-to-r from-slate-800/50 to-transparent">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-indigo-500/10">
                  <FileText className="w-6 h-6 text-indigo-400" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-white">Schedule Details</h2>
                  <p className="text-sm text-slate-400 mt-1">Read-only view of submitted schedule</p>
                </div>
              </div>
              <button 
                onClick={() => setShowViewModal(false)}
                className="p-2 hover:bg-slate-800 rounded-lg transition-colors"
              >
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-6 space-y-6 scrollbar-thin">
              <div className="grid grid-cols-2 gap-4 p-5 rounded-xl bg-slate-800/50 border border-slate-700/50">
                {[
                  { label: 'Plant', value: selectedSchedule.plant },
                  { label: 'Category', value: selectedSchedule.category },
                  { label: 'Type', value: selectedSchedule.type },
                  { label: 'Manual Changes', value: selectedSchedule.changes }
                ].map((field, idx) => (
                  <div key={idx}>
                    <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                      {field.label}
                    </label>
                    <p className="text-base font-semibold text-white mt-2">{field.value}</p>
                  </div>
                ))}
              </div>

              <div className="border border-slate-700/50 rounded-xl overflow-hidden">
                <div className="px-6 py-4 bg-slate-800/50 border-b border-slate-700/50 flex-shrink-0">
                  <h3 className="text-sm font-semibold text-white">Schedule Data Preview</h3>
                </div>
                <div className="max-h-80 overflow-auto scrollbar-thin">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-slate-800">
                      <tr>
                        {['Time', 'Forecast (MW)', 'Actual (MW)', 'Scheduled (MW)'].map(header => (
                          <th key={header} className="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase">
                            {header}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {Array.from({ length: 12 }, (_, i) => (
                        <tr key={i} className="hover:bg-slate-800/30 transition-colors">
                          <td className="px-4 py-3 font-medium text-white">0{i}:00</td>
                          <td className="px-4 py-3 text-slate-400">45.2</td>
                          <td className="px-4 py-3 text-slate-400">46.1</td>
                          <td className="px-4 py-3 font-semibold text-indigo-400">45.8</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div className="px-6 py-5 border-t border-slate-700 bg-slate-800/30 flex-shrink-0 flex gap-3">
              <button 
                onClick={() => setShowViewModal(false)}
                className="flex-1 px-4 py-3 rounded-xl bg-slate-800 text-slate-300 font-semibold hover:bg-slate-700 transition-all duration-300"
              >
                Close
              </button>
              <button 
                onClick={() => {
                  const dataToExport = [
                    { time: '00:00', forecast: '45.2', actual: '46.1', scheduled: '45.8' },
                    { time: '01:00', forecast: '48.5', actual: '47.2', scheduled: '48.0' },
                    { time: '02:00', forecast: '42.1', actual: '43.5', scheduled: '42.8' },
                  ];
                  exportToCSV(dataToExport, `schedule-${selectedSchedule.plant}-${new Date().toISOString().split('T')[0]}.csv`);
                }}
                className="flex-1 px-4 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white font-semibold hover:from-indigo-500 hover:to-purple-500 transition-all duration-300 flex items-center justify-center gap-2"
              >
                <Download className="w-4 h-4" />
                Export Schedule
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Premium More Modal */}
      {showMoreModal && selectedSchedule && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 rounded-2xl shadow-2xl w-full max-w-lg border border-slate-700">
            <div className="px-6 py-5 border-b border-slate-700 bg-gradient-to-r from-slate-800/50 to-transparent">
              <h2 className="text-xl font-bold text-white">Pending Schedule Actions</h2>
              <p className="text-sm text-slate-400 mt-1">Choose an action for this pending schedule</p>
            </div>
            
            <div className="p-6 space-y-4">
              <div className="p-5 rounded-xl bg-slate-800/50 border border-slate-700/50 grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Plant</label>
                  <p className="text-base font-semibold text-white mt-2">{selectedSchedule.plant}</p>
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Type</label>
                  <p className="text-base font-semibold text-white mt-2">{selectedSchedule.type}</p>
                </div>
              </div>

              <div className="space-y-3">
                <button className="w-full px-6 py-4 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 text-white hover:from-emerald-500 hover:to-teal-500 transition-all duration-300 font-semibold text-left flex items-center gap-3 shadow-lg shadow-emerald-500/25">
                  <ArrowRight className="w-5 h-5" />
                  <span>Continue with Pending (Proceed to Submit)</span>
                </button>
                <button className="w-full px-6 py-4 rounded-xl bg-slate-800 text-slate-300 hover:bg-slate-700 transition-all duration-300 font-semibold text-left flex items-center gap-3 border border-slate-700">
                  <Upload className="w-5 h-5" />
                  <span>Revoke to Draft (Edit Schedule)</span>
                </button>
              </div>

              <div className="p-4 bg-indigo-500/10 border border-indigo-500/20 rounded-xl flex gap-3">
                <AlertTriangle className="w-5 h-5 text-indigo-400 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-slate-300">
                  <span className="font-semibold text-white">Note:</span> Continue will proceed to final submission. Revoke will allow editing the schedule.
                </p>
              </div>
            </div>

            <div className="px-6 py-5 border-t border-slate-700 bg-slate-800/30">
              <button 
                onClick={() => setShowMoreModal(false)}
                className="w-full px-4 py-3 rounded-xl bg-slate-800 text-slate-300 font-semibold hover:bg-slate-700 transition-all duration-300"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Premium Remove Plant Modal */}
      {showRemovePlantModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 rounded-2xl shadow-2xl w-full max-w-md border border-slate-700">
            <div className="px-6 py-5 border-b border-slate-700 bg-gradient-to-r from-red-900/20 to-transparent">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-red-500/10">
                  <Trash className="w-6 h-6 text-red-400" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-white">Remove Plant</h2>
                  <p className="text-sm text-slate-400">This action cannot be undone</p>
                </div>
              </div>
            </div>
            
            <div className="p-6">
              <p className="text-slate-300 mb-4">
                Are you sure you want to remove this plant? All associated schedules and data will also be removed from the database.
              </p>
              <div className="p-5 rounded-xl bg-slate-800/50 border border-slate-700/50">
                <p className="text-sm font-medium text-slate-400 mb-2">Select a plant to remove:</p>
                <select 
                  className="w-full px-4 py-3 rounded-xl bg-slate-900 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                  onChange={(e) => {
                    const plantId = e.target.value;
                    if (plantId) {
                      const plant = plantsData?.plants?.find(p => p.id === parseInt(plantId));
                      setPlantToRemove(plant || { id: plantId, name: plantId });
                    } else {
                      setPlantToRemove(null);
                    }
                  }}
                  defaultValue=""
                >
                  <option value="">-- Select Plant --</option>
                  {plantsLoading ? (
                    <option disabled>Loading plants...</option>
                  ) : (
                    plantsData?.plants?.map(plant => (
                      <option key={plant.id} value={plant.id}>
                        {plant.name} ({plant.type} - {plant.state})
                      </option>
                    ))
                  )}
                </select>
              </div>
              
              {plantToRemove && (
                <div className="mt-4 p-4 bg-red-500/10 border border-red-500/20 rounded-xl">
                  <p className="text-sm font-semibold text-red-400">Plant to be removed:</p>
                  <p className="text-white font-semibold">{plantToRemove.name || plantToRemove.id}</p>
                </div>
              )}
            </div>

            <div className="px-6 py-5 border-t border-slate-700 bg-slate-800/30 flex gap-3">
              <button 
                onClick={() => {
                  setShowRemovePlantModal(false);
                  setPlantToRemove(null);
                }}
                className="flex-1 px-4 py-3 rounded-xl bg-slate-800 text-slate-300 font-semibold hover:bg-slate-700 transition-all duration-300"
              >
                Cancel
              </button>
              <button 
                onClick={handleConfirmRemovePlant}
                disabled={!plantToRemove || removingPlant}
                className="flex-1 px-4 py-3 rounded-xl bg-gradient-to-r from-red-600 to-rose-600 text-white font-semibold hover:from-red-500 hover:to-rose-500 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {removingPlant ? (
                  <LoadingSpinner className="w-4 h-4" />
                ) : (
                  <Trash className="w-4 h-4" />
                )}
                Remove Plant
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
