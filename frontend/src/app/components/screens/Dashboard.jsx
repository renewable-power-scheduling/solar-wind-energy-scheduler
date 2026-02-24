import { Filter, ChevronDown, Plus, X, Layers, TrendingUp, FileText, Download, RefreshCw } from 'lucide-react';
import { useState, useMemo, useEffect } from 'react';
import { Activity, AlertCircle, Eye, MoreHorizontal, X as XIcon, Wind, Sun, Zap, Upload, ArrowRight, AlertTriangle } from 'lucide-react';
import { api } from '@/services/api';
import { useApi } from '@/hooks/useApi';
import { LoadingSpinner, SkeletonLoader } from '@/app/components/common/LoadingSpinner';
import { ErrorMessage } from '@/app/components/common/ErrorMessage';
import { PlantForm } from '@/app/components/ui/PlantForm';
import { toast } from 'sonner';
import { S3_BASE_URL } from '@/config/appConfig';

// =============================================================================
// S3 CONFIG
// =============================================================================
const RAW_BASE_PREFIX = 'raw/vedanjay/GSNP/';
const GENERATED_OUTPUTS_BASE_PREFIX = 'generated/vedanjay/GSNP/outputs/';
const LEGACY_OUTPUTS_BASE_PREFIX = 'outputs/';

const S3_ONLY_PLANT = {
  id: 1,
  name: 'Globus Steel N Power (GSNP)',
  state: 'Madhya Pradesh',
  type: 'Solar',
};

const DASHBOARD_PLANT_OPTIONS = [
  { name: 'Select Plant', type: 'All' },
  { name: 'Globus Steel N Power (GSNP)', type: 'Solar' },
];

// =============================================================================
// S3 HELPERS
// =============================================================================
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

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = lines[0].split(',').map((h) => h.trim());
  const rows = lines.slice(1).map((line) => line.split(',').map((v) => v.trim()));
  return { headers, rows };
}

function parseMeterCsv(text) {
  const { headers, rows } = parseCsv(text);
  const timeIdx = headers.indexOf('Timestamp');
  const powerIdx = headers.indexOf('Active Power-avg MFM-OUT(Meter Power) (kW)');
  if (timeIdx === -1 || powerIdx === -1) {
    return { dataPoints: [] };
  }
  const dataPoints = rows.map((cols) => ({
    time: cols[timeIdx],
    generation: parseFloat(cols[powerIdx]) || 0,
  })).filter((d) => d.time);
  return { dataPoints };
}

async function fetchCsvFromS3(key) {
  const url = `${S3_BASE_URL}/${String(key || '').split('/').map((s) => encodeURIComponent(s)).join('/')}`;
  const text = await fetch(url).then((r) => r.text());
  return { url, text };
}

function formatTimeFromIso(iso) {
  if (!iso) return '';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function getDateList(endDate, days) {
  const dates = [];
  const end = new Date(endDate);
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(end);
    d.setDate(end.getDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}

function getDateSearchPrefixes(date) {
  return [
    `${RAW_BASE_PREFIX}${date}/`,
    `${GENERATED_OUTPUTS_BASE_PREFIX}${date}/`,
    `${LEGACY_OUTPUTS_BASE_PREFIX}${date}/`,
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

// Helper function to export data as CSV
const exportToCSV = (data, filename = 'dashboard-report.csv') => {
  const headers = ['Plant', 'Category', 'Type', 'Status', 'Manual Changes'];
  const csvContent = [
    headers.join(','),
    ...data.map(row => [
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


export function Dashboard({ onNavigate }) {
  // Filter states
  const [categoryFilter, setCategoryFilter] = useState('Solar Plants');
  const [plantFilter, setPlantFilter] = useState('Select Plant');
  const [timePeriodFilter, setTimePeriodFilter] = useState('Today');
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);

  // Modal states
  const [showViewModal, setShowViewModal] = useState(false);
  const [showMoreModal, setShowMoreModal] = useState(false);
  const [selectedSchedule, setSelectedSchedule] = useState(null);
  const [showPlantForm, setShowPlantForm] = useState(false);

  // Live clock
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // API hooks
  const [currentGenerationMw, setCurrentGenerationMw] = useState(0);
  const [meterLoading, setMeterLoading] = useState(false);

  const {
    data: schedulesData,
    loading: schedulesLoading,
    error: schedulesError,
    execute: fetchSchedules
  } = useApi(() => api.schedules.getAll({ limit: 10 }), {
    immediate: true,
    initialData: { schedules: [], total: 0 }
  });

  const [s3Schedules, setS3Schedules] = useState([]);
  const [s3SchedulesLoading, setS3SchedulesLoading] = useState(false);

  const allSchedules = s3Schedules;
  
  // State to track if user wants to see all schedules
  const [showAllSchedules, setShowAllSchedules] = useState(false);
  
  // Show all schedules or limited to 10 based on showAllSchedules state
  const schedules = showAllSchedules ? allSchedules : allSchedules.slice(0, 10);
  
  // Load schedule CSVs from S3 based on date filter
  useEffect(() => {
    const loadSchedules = async () => {
      setS3SchedulesLoading(true);
      try {
        const dates =
          [selectedDate];

        const dateResults = await Promise.all(
          dates.map(async (date) => {
            const datePrefixes = getDateSearchPrefixes(date);
            const objectsFlat = await listS3ObjectsAcrossPrefixes(datePrefixes);
            const objects = Array.from(new Map(objectsFlat.map((o) => [o.key, o])).values());
            const scheduleFiles = objects.filter((o) => isScheduleCsvKey(o.key));
            return scheduleFiles.map((file) => ({
              id: file.key,
              time: formatTimeFromIso(file.lastModified),
              plant: S3_ONLY_PLANT.name,
              category: 'Solar',
              type: 'Day-Ahead',
              status: 'Pending',
              changes: 0,
              icon: S3_ONLY_PLANT.type === 'Wind' ? 'Wind' : 'Sun',
              fileName: file.key.split('/').pop(),
              fileUrl: `${S3_BASE_URL}/${String(file.key || '').split('/').map((s) => encodeURIComponent(s)).join('/')}`,
            }));
          })
        );

        const flattened = dateResults.flat();
        setS3Schedules(flattened);
      } catch (error) {
        console.error('Failed to load schedules from S3:', error);
        setS3Schedules([]);
        toast.error('Failed to load schedule CSVs from S3');
      } finally {
        setS3SchedulesLoading(false);
      }
    };

    loadSchedules();
  }, [selectedDate, timePeriodFilter]);

  // Load latest meter data for current generation (MW)
  useEffect(() => {
    const loadMeter = async () => {
      setMeterLoading(true);
      try {
        const meterPrefixes = [
          `${RAW_BASE_PREFIX}${selectedDate}/metered_data/`,
          `${GENERATED_OUTPUTS_BASE_PREFIX}${selectedDate}/meter/`,
          `${LEGACY_OUTPUTS_BASE_PREFIX}${selectedDate}/meter/`,
          `${selectedDate}/meter/`,
        ];
        const meterObjectsFlat = await listS3ObjectsAcrossPrefixes(meterPrefixes);
        const meterCandidates = meterObjectsFlat
          .filter((o) => o.key.toLowerCase().endsWith('.csv'))
          .sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
        if (!meterCandidates.length) {
          throw new Error(`No meter CSV found for ${selectedDate}`);
        }
        const { text } = await fetchCsvFromS3(meterCandidates[0].key);
        const parsed = parseMeterCsv(text);
        const lastPoint = parsed.dataPoints[parsed.dataPoints.length - 1];
        const mw = lastPoint ? (lastPoint.generation / 1000) : 0;
        setCurrentGenerationMw(mw);
      } catch (error) {
        console.error('Failed to load meter CSV:', error);
        setCurrentGenerationMw(0);
      } finally {
        setMeterLoading(false);
      }
    };

    loadMeter();
  }, [selectedDate]);

  const statsData = useMemo(() => {
    const activePlants = 1;
    const totalCapacity = 20;
    const efficiency = totalCapacity > 0 ? (currentGenerationMw / totalCapacity) * 100 : 0;
    return {
      activePlants,
      totalCapacity: totalCapacity.toFixed(0),
      currentGeneration: currentGenerationMw.toFixed(2),
      efficiency: efficiency.toFixed(1),
    };
  }, [currentGenerationMw]);


  // Filter schedules based on all active filters
  const filteredSchedules = useMemo(() => {
    if (plantFilter === 'Select Plant') {
      return [];
    }

    return schedules.filter(schedule => {
      const matchesCategory =
        categoryFilter === 'All' ||
        (categoryFilter === 'Wind Plants' && schedule.category === 'Wind') ||
        (categoryFilter === 'Solar Plants' && schedule.category === 'Solar');
      const matchesPlant = schedule.plant === plantFilter;

      const matchesTimePeriod = timePeriodFilter === 'Today';
      
      return matchesCategory && matchesPlant && matchesTimePeriod;
    });
  }, [schedules, categoryFilter, plantFilter, timePeriodFilter]);

  // Hardcoded plant options for filter dropdown (independent of loaded data/date)
  const plantNames = useMemo(() => {
    if (categoryFilter === 'Wind Plants') {
      return DASHBOARD_PLANT_OPTIONS.filter((p) => p.type === 'Wind' || p.type === 'All');
    }
    if (categoryFilter === 'Solar Plants') {
      return DASHBOARD_PLANT_OPTIONS.filter((p) => p.type === 'Solar' || p.type === 'All');
    }
    if (categoryFilter === 'All') {
      return DASHBOARD_PLANT_OPTIONS;
    }
    return DASHBOARD_PLANT_OPTIONS;
  }, [categoryFilter]);

  // Handler to export report
  const handleExportReport = () => {
    if (!filteredSchedules.length) {
      toast.info('Select a plant to export schedule files.');
      return;
    }
    exportToCSV(filteredSchedules, `dashboard-report-${new Date().toISOString().split('T')[0]}.csv`);
  };

  // Handler to refresh all data
  const handleRefresh = async () => {
    setCategoryFilter('All');
    setPlantFilter('Select Plant');
    setTimePeriodFilter('Today');
    setSelectedDate(new Date().toISOString().split('T')[0]);
    
    await fetchSchedules();
    toast.success('Dashboard data refreshed');
  };

  // Handlers for schedule actions
  const handleViewSchedule = (schedule) => {
    if (schedule?.fileUrl) {
      window.open(schedule.fileUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    setSelectedSchedule(schedule);
    setShowViewModal(true);
  };

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

        <div className="p-4 sm:p-6 lg:p-8 space-y-8 max-w-[1600px] mx-auto relative z-10">
          {/* Premium Page Header */}
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 border border-slate-700/50 shadow-2xl">
            <div className="absolute inset-0 bg-gradient-to-r from-indigo-500/5 via-transparent to-purple-500/5" />
            <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-bl from-indigo-500/10 to-transparent rounded-full blur-2xl" />
            
            <div className="relative p-4 sm:p-6 lg:p-8">
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

              {/* Date Filter */}
              <div className="relative">
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  className="px-4 py-2.5 rounded-xl bg-slate-800/50 border border-slate-700/50 text-slate-300 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all cursor-pointer hover:bg-slate-800 hover:border-slate-600"
                />
              </div>

              {/* Plant Filter */}
              <div className="relative">
                <select 
                  value={plantFilter}
                  onChange={(e) => setPlantFilter(e.target.value)}
                  className="px-4 py-2.5 rounded-xl bg-slate-800/50 border border-slate-700/50 text-slate-300 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all cursor-pointer appearance-none pr-10 hover:bg-slate-800 hover:border-slate-600 max-w-[200px]"
                >
                  {plantNames.map((p) => (
                    <option key={p.name} value={p.name}>{p.name}</option>
                  ))}
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
              </div>

              {/* Clear Filters Button */}
              {(categoryFilter !== 'All' || plantFilter !== 'Select Plant' || timePeriodFilter !== 'Today') && (
                <button
                  onClick={() => {
                    setCategoryFilter('All');
                    setPlantFilter('Select Plant');
                    setTimePeriodFilter('Today');
                    setSelectedDate(new Date().toISOString().split('T')[0]);
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
                </div>
              </div>
            </div>
            
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-800/50 backdrop-blur-sm">
                  <tr>
                    {['Plant', 'Category', 'CSV File', 'Manual Changes', 'Action'].map(header => (
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
                      return (
                        <tr key={`schedule-${item.id || item.fileName}-${item.plant}`} className="group hover:bg-slate-800/30 transition-all duration-300">
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
                          <td className="px-6 py-5 whitespace-nowrap text-sm text-slate-300">
                            {item.fileName || '-'}
                          </td>
                          <td className="px-6 py-5 whitespace-nowrap text-sm text-slate-400">{item.changes}</td>
                          <td className="px-6 py-5 whitespace-nowrap">
                            <div className="flex gap-2">
                              <button 
                                onClick={() => handleViewSchedule(item)}
                                className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 text-sm font-semibold hover:bg-slate-700 hover:text-white transition-all duration-300 flex items-center gap-2 border border-slate-700"
                              >
                                <Eye className="w-4 h-4" />
                                View
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan="5" className="px-6 py-20 text-center">
                        <div className="flex flex-col items-center gap-4">
                          <div className="p-4 rounded-full bg-slate-800/50">
                            <Filter className="w-10 h-10 text-slate-600" />
                          </div>
                          <div>
                            <p className="text-lg font-semibold text-slate-400">
                              {plantFilter === 'Select Plant' ? 'Select a plant to view schedule files' : 'No schedules match your filters'}
                            </p>
                            <p className="text-sm text-slate-500 mt-1">
                              {plantFilter === 'Select Plant' ? 'Data stays empty until plant selection' : 'Try adjusting your filter criteria'}
                            </p>
                          </div>
                          <button
                            onClick={() => {
                              setCategoryFilter('All');
                              setPlantFilter('Select Plant');
                              setTimePeriodFilter('Today');
                              setSelectedDate(new Date().toISOString().split('T')[0]);
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
                  { label: 'CSV File', value: selectedSchedule.fileName || '-' },
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
                      <tr>
                        <td colSpan="4" className="px-4 py-10 text-center text-sm text-slate-400">
                          No inline preview data available. Open the CSV using View to inspect real records.
                        </td>
                      </tr>
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
                onClick={() => toast.info('No inline schedule rows to export from preview modal.')}
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

    </>
  );
}








