import { useState, useEffect, useMemo } from 'react';
import {
  CheckCircle, Clock, MinusCircle, AlertCircle, RefreshCw,
  FileText, AlertTriangle, Wind, Sun, Upload, ArrowRight,
  Activity, Layers, TrendingUp, X
} from 'lucide-react';
import { LoadingSpinner } from '@/app/components/common/LoadingSpinner';
import { toast } from 'sonner';
import { S3_BASE_URL } from '@/config/appConfig';

const statusIcons = { READY: CheckCircle, PENDING: Clock, NO_ACTION: MinusCircle };

export function ScheduleReadinessDashboard({ onNavigate }) {
  const [statusFilter, setStatusFilter] = useState('All');
  const [selectedPlant, setSelectedPlant] = useState(null);
  const [showActionModal, setShowActionModal] = useState(false);
  const [actionType, setActionType] = useState(null);
  const [actionReason, setActionReason] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [readinessData, setReadinessData] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedDate] = useState(new Date().toISOString().split('T')[0]);

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
    capacity: 20
  };

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

  function extractTrailingNumber(key) {
    const fileName = (key || '').split('/').pop() || '';
    const schedMatch = fileName.match(/schedule_from_(\d+)\.csv$/i);
    if (schedMatch) return parseInt(schedMatch[1], 10);
    const trailingMatch = fileName.match(/_(\d+)(?=\.[^.]+$)/);
    return trailingMatch ? parseInt(trailingMatch[1], 10) : null;
  }

  function sortLatestFirst(items) {
    return [...items].sort((a, b) => {
      const aSeq = extractTrailingNumber(a.key);
      const bSeq = extractTrailingNumber(b.key);
      if (aSeq !== null && bSeq !== null && bSeq !== aSeq) return bSeq - aSeq;

      const aTime = Date.parse(a.lastModified || '');
      const bTime = Date.parse(b.lastModified || '');
      const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
      if (timeDiff !== 0) return timeDiff;

      return (b.key || '').localeCompare(a.key || '');
    });
  }

  function sortOldestFirst(items) {
    return [...items].sort((a, b) => {
      const aSeq = extractTrailingNumber(a.key);
      const bSeq = extractTrailingNumber(b.key);
      if (aSeq !== null && bSeq !== null && aSeq !== bSeq) return aSeq - bSeq;

      const aTime = Date.parse(a.lastModified || '');
      const bTime = Date.parse(b.lastModified || '');
      const timeDiff = (Number.isNaN(aTime) ? 0 : aTime) - (Number.isNaN(bTime) ? 0 : bTime);
      if (timeDiff !== 0) return timeDiff;

      return (a.key || '').localeCompare(b.key || '');
    });
  }

  const buildReadinessData = (scheduleFiles) => {
    const oldestFileKey = sortOldestFirst(scheduleFiles)[0]?.key;
    const sorted = sortLatestFirst(scheduleFiles);
    return sorted.map((file, index) => {
      const isLatest = index === 0;
      return {
        id: `${file.key}-${index}`,
        plant_id: S3_ONLY_PLANT.id,
        plant_name: S3_ONLY_PLANT.name,
        category: S3_ONLY_PLANT.type,
        status: isLatest ? 'READY' : 'NO_ACTION',
        trigger_reason: file.key === oldestFileKey ? 'Dynamic start' : 'Abrupt weather',
        upload_deadline: null,
        file_name: file.key.split('/').pop(),
        generated_at: file.lastModified,
        is_latest: isLatest,
        state: S3_ONLY_PLANT.state,
        capacity: S3_ONLY_PLANT.capacity
      };
    });
  };

  // Load data on mount
  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      try {
        const datePrefixes = getDateSearchPrefixes(selectedDate);
        const objectsFlat = await listS3ObjectsAcrossPrefixes(datePrefixes);
        const objects = Array.from(new Map(objectsFlat.map((o) => [o.key, o])).values());
        const scheduleFiles = objects.filter((o) => isScheduleCsvKey(o.key));
        setReadinessData(buildReadinessData(scheduleFiles));
      } catch (error) {
        console.error('Failed to load readiness data from S3:', error);
        setReadinessData([]);
        toast.error('Failed to load readiness data from S3');
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, [selectedDate]);

  // Update time every second for live clock
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Calculate summary from data
  const summary = useMemo(() => {
    return {
      total: 1,
      ready: readinessData.filter(p => p.status === 'READY').length,
      pending: readinessData.filter(p => p.status === 'PENDING').length,
      no_action: readinessData.filter(p => p.status === 'NO_ACTION').length
    };
  }, [readinessData]);

  const filteredPlants = readinessData.filter(p => statusFilter === 'All' || p.status === statusFilter);

  const getStatusConfig = (status) => {
    const configs = {
      READY: {
        color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
        iconColor: 'text-emerald-400',
        label: 'Ready'
      },
      PENDING: {
        color: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
        iconColor: 'text-amber-400',
        label: 'Pending'
      },
      NO_ACTION: {
        color: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
        iconColor: 'text-slate-400',
        label: 'No Action'
      }
    };
    return configs[status] || configs.NO_ACTION;
  };

  const handleActionClick = (plant, action) => {
    setSelectedPlant(plant);
    setActionType(action);
    setActionReason('');
    setShowActionModal(true);
  };

  const executeAction = async () => {
    if (!selectedPlant || !actionType) return;
    
    setShowActionModal(false);
    setIsRefreshing(true);
    
    // Simulate API call
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Update local data based on action
    const updatedData = readinessData.map(plant => {
      if (plant.id === selectedPlant.id) {
        if (actionType === 'revise') {
          return { ...plant, status: 'PENDING', revision_number: (plant.revision_number || 0) + 1 };
        } else if (actionType === 'continue') {
          return { ...plant, status: 'NO_ACTION', trigger_reason: null };
        } else if (actionType === 'markReady') {
          return { ...plant, status: 'READY' };
        }
      }
      return plant;
    });
    
    setReadinessData(updatedData);
    setIsRefreshing(false);
    
    // Show success toast
    if (actionType === 'revise') {
      toast.success(`Revision triggered for ${selectedPlant.plant_name}`);
      // Navigate to Schedule Preparation for editing
      setTimeout(() => {
        onNavigate('schedule', { 
          plant: selectedPlant.plant_name, 
          category: selectedPlant.category,
          type: 'Day-Ahead',
          revision: true
        });
      }, 500);
    } else if (actionType === 'continue') {
      toast.info(`Schedule continued for ${selectedPlant.plant_name}`);
    } else if (actionType === 'markReady') {
      toast.success(`Latest schedule selected for upload: ${selectedPlant.file_name}`);
      // Navigate to Reports or Templates for upload
      setTimeout(() => {
        onNavigate('templates');
      }, 500);
    }
    
    setSelectedPlant(null);
    setActionType(null);
  };

  const getPlantIcon = (name) => name.toLowerCase().includes('solar') ? Sun : Wind;

  const getActionButtonText = () => {
    if (actionType === 'revise') return 'Trigger Revision';
    if (actionType === 'continue') return 'Continue Schedule';
    if (actionType === 'markReady') return 'Mark Ready';
    return 'Confirm';
  };

  const handleHistoryClick = (plant) => {
    toast.info(`Opening history: ${plant.file_name}`);
    onNavigate('schedule', {
      plant: plant.plant_name,
      category: plant.category,
      type: 'Day-Ahead',
      date: selectedDate,
      fileName: plant.file_name,
      fromReadinessHistory: true,
    });
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      const datePrefixes = getDateSearchPrefixes(selectedDate);
      const objectsFlat = await listS3ObjectsAcrossPrefixes(datePrefixes);
      const objects = Array.from(new Map(objectsFlat.map((o) => [o.key, o])).values());
      const scheduleFiles = objects.filter((o) => isScheduleCsvKey(o.key));
      setReadinessData(buildReadinessData(scheduleFiles));
    } catch (error) {
      console.error('Failed to refresh readiness data from S3:', error);
      toast.error('Failed to refresh readiness data');
    }
    setIsRefreshing(false);
  };

  const handleCheckTriggers = async () => {
    setIsRefreshing(true);
    try {
      const datePrefixes = getDateSearchPrefixes(selectedDate);
      const objectsFlat = await listS3ObjectsAcrossPrefixes(datePrefixes);
      const objects = Array.from(new Map(objectsFlat.map((o) => [o.key, o])).values());
      const scheduleFiles = objects.filter((o) => isScheduleCsvKey(o.key));
      setReadinessData(buildReadinessData(scheduleFiles));
      toast.success('Today schedule files scanned for triggers');
    } catch (error) {
      console.error('Failed to scan triggers from S3:', error);
      toast.error('Failed to scan triggers');
    }
    setIsRefreshing(false);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-950">
        <div className="flex flex-col items-center gap-6">
          <div className="relative">
            <div className="w-20 h-20 rounded-full border-4 border-slate-800 border-t-indigo-500 animate-spin" />
            <div className="absolute inset-0 w-20 h-20 rounded-full border-4 border-transparent border-b-purple-500 animate-spin" style={{ animationDirection: 'reverse', animationDuration: '1.5s' }} />
          </div>
          <div className="flex flex-col items-center gap-2">
            <p className="text-lg font-semibold text-white">Loading Dashboard</p>
            <p className="text-sm text-slate-400">Fetching schedule readiness data...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto bg-slate-950 min-h-0">
      {/* Animated background elements */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />
      </div>

      <div className="p-4 sm:p-6 lg:p-8 space-y-8 max-w-[2000px] mx-auto relative z-10">
        {/* Premium Header */}
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
                    Schedule Readiness
                    <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-purple-400"> Dashboard</span>
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
                  onClick={handleCheckTriggers}
                  disabled={isRefreshing}
                  className="group relative px-6 py-3 rounded-xl bg-slate-800/50 hover:bg-slate-700/50 border border-slate-700/50 hover:border-slate-600 transition-all duration-300 flex items-center gap-3 disabled:opacity-50"
                >
                  <div className="relative">
                    <RefreshCw className={`w-5 h-5 text-indigo-400 ${isRefreshing ? 'animate-spin' : 'group-hover:rotate-180 transition-transform duration-500'}`} />
                  </div>
                  <div className="text-left">
                    <p className="text-sm font-semibold text-white">Check Triggers</p>
                    <p className="text-xs text-slate-400">Scan today schedules</p>
                  </div>
                </button>
                <button 
                  onClick={handleRefresh}
                  disabled={isRefreshing}
                  className="group relative px-6 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white shadow-lg shadow-indigo-500/25 hover:shadow-indigo-500/40 transition-all duration-300 flex items-center gap-3 disabled:opacity-70"
                >
                  <RefreshCw className={`w-5 h-5 ${isRefreshing ? 'animate-spin' : 'group-hover:rotate-180 transition-transform duration-500'}`} />
                  <div className="text-left">
                    <p className="text-sm font-semibold">Refresh</p>
                    <p className="text-xs text-indigo-200">Update data</p>
                  </div>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
          {[
            { label: 'Total Sites', value: summary.total, subtext: 'Active monitoring', icon: Layers, color: 'blue', gradient: 'from-slate-600 to-slate-700', glow: 'bg-slate-500/20' },
            { label: 'Ready', value: summary.ready, subtext: 'Schedules ready for upload', icon: CheckCircle, color: 'emerald', gradient: 'from-emerald-600 to-teal-600', glow: 'bg-emerald-500/20' },
            { label: 'Pending', value: summary.pending, subtext: 'Require action', icon: Clock, gradient: 'from-amber-600 to-orange-600', glow: 'bg-amber-500/20' },
            { label: 'No Action', value: summary.no_action, subtext: 'Continuing existing', icon: MinusCircle, gradient: 'from-slate-500 to-slate-600', glow: 'bg-slate-500/20' }
          ].map((stat, i) => (
            <div 
              key={i}
              className="group relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 to-slate-800 border border-slate-700/50 hover:border-slate-600 transition-all duration-500 hover:-translate-y-1 hover:shadow-2xl cursor-pointer"
              onClick={() => setStatusFilter(stat.label === 'Total Sites' ? 'All' : stat.label.toUpperCase().replace(' ', '_'))}
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
                    <stat.icon className={`w-6 h-6 text-${stat.color}-400`} />
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

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-4 p-4 rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm">
          <div className="flex items-center gap-2 text-slate-400">
            <Layers className="w-5 h-5" />
            <span className="text-sm font-medium">Filter by Status:</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {['All', 'READY', 'PENDING', 'NO_ACTION'].map((status) => {
              const count = status === 'All' ? summary.total : status === 'READY' ? summary.ready : status === 'PENDING' ? summary.pending : summary.no_action;
              const isActive = statusFilter === status;
              
              return (
                <button
                  key={status}
                  onClick={() => setStatusFilter(status)}
                  className={`relative px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-300 ${
                    isActive 
                      ? 'text-white' 
                      : 'text-slate-400 hover:text-white hover:bg-slate-800'
                  }`}
                >
                  {isActive && (
                    <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 shadow-lg shadow-indigo-500/25" />
                  )}
                  <span className="relative z-10 flex items-center gap-2">
                    {status === 'All' ? 'All Sites' : status}
                    {status === 'All' ? ' (1 Site)' : ''}
                    <span className={`px-2 py-0.5 rounded-full text-xs ${isActive ? 'bg-white/20' : 'bg-slate-800'}`}>
                      {count}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Main Table */}
        <div className="rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm overflow-hidden">
          <div className="p-6 border-b border-slate-700/50 bg-gradient-to-r from-slate-800/50 to-transparent">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-xl bg-indigo-500/10">
                <FileText className="w-6 h-6 text-indigo-400" />
              </div>
              <div>
                <h3 className="text-xl font-bold text-white">Site Schedule Status</h3>
                <p className="text-sm text-slate-400">Individual site readiness and action management</p>
              </div>
            </div>
          </div>
          
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-slate-800/50 backdrop-blur-sm">
                  <th className="px-6 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">Site</th>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">Status</th>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">Trigger Reason</th>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">Upload Deadline</th>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {filteredPlants.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-20 text-center">
                      <div className="flex flex-col items-center gap-4">
                        <div className="p-4 rounded-full bg-slate-800/50">
                          <FileText className="w-10 h-10 text-slate-600" />
                        </div>
                        <div>
                          <p className="text-lg font-semibold text-slate-400">No sites match the current filter</p>
                          <p className="text-sm text-slate-500 mt-1">Try adjusting your filter criteria</p>
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : filteredPlants.map((plant) => {
                  const sc = getStatusConfig(plant.status);
                  const StatusIcon = statusIcons[plant.status] || MinusCircle;
                  const PlantIcon = getPlantIcon(plant.plant_name);
                  const isSolar = plant.category === 'Solar';
                  
                  return (
                    <tr 
                      key={plant.id}
                      className="group hover:bg-slate-800/30 transition-all duration-300"
                    >
                      <td className="px-6 py-5">
                        <div className="flex items-center gap-4">
                          <div className={`relative p-3 rounded-xl transition-transform duration-300 group-hover:scale-110 ${
                            isSolar 
                              ? 'bg-gradient-to-br from-amber-500/20 to-orange-500/20' 
                              : 'bg-gradient-to-br from-blue-500/20 to-cyan-500/20'
                          }`}>
                            <PlantIcon className={`w-6 h-6 ${isSolar ? 'text-amber-400' : 'text-blue-400'}`} />
                          </div>
                          <div>
                            <p className="text-base font-semibold text-white group-hover:text-indigo-400 transition-colors">{plant.plant_name}</p>
                            <p className="text-sm text-slate-500">{plant.is_latest ? 'Latest schedule available' : 'Older schedule'}</p>
                            <p className="text-xs text-slate-500 mt-1">{plant.file_name}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-5">
                        <span className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border ${sc.color}`}>
                          <StatusIcon className={`w-4 h-4 ${sc.iconColor}`} />
                          {sc.label}
                        </span>
                      </td>
                      <td className="px-6 py-5">
                        {plant.trigger_reason ? (
                          <div className="flex items-center gap-2">
                            <AlertTriangle className="w-5 h-5 text-amber-400" />
                            <span className="text-sm font-medium text-amber-400">{plant.trigger_reason}</span>
                          </div>
                        ) : (
                          <span className="text-sm text-slate-500">-</span>
                        )}
                      </td>
                      <td className="px-6 py-5">
                        {plant.upload_deadline ? (
                          <div className="flex flex-col">
                            <p className="text-sm font-semibold text-white">{new Date(plant.upload_deadline).toLocaleDateString()}</p>
                            <p className="text-xs text-slate-500">{new Date(plant.upload_deadline).toLocaleTimeString()}</p>
                          </div>
                        ) : (
                          <span className="text-sm text-slate-500">-</span>
                        )}
                      </td>
                      <td className="px-6 py-5">
                        <div className="flex gap-2">
                          {plant.status === 'PENDING' && (
                            <>
                              <button 
                                onClick={() => handleActionClick(plant, 'revise')}
                                className="px-4 py-2 rounded-lg bg-gradient-to-r from-indigo-600 to-purple-600 text-white text-sm font-semibold hover:from-indigo-500 hover:to-purple-500 transition-all duration-300 flex items-center gap-2"
                              >
                                <Upload className="w-4 h-4" />
                                Revise
                              </button>
                              <button 
                                onClick={() => handleActionClick(plant, 'continue')}
                                className="px-4 py-2 rounded-lg bg-slate-800 text-white text-sm font-semibold hover:bg-slate-700 transition-all duration-300 flex items-center gap-2 border border-slate-700"
                              >
                                <ArrowRight className="w-4 h-4" />
                                Continue
                              </button>
                            </>
                          )}
                          {plant.status === 'NO_ACTION' && plant.is_latest && (
                            <button 
                              onClick={() => handleActionClick(plant, 'revise')}
                              className="px-4 py-2 rounded-lg bg-slate-800 text-white text-sm font-semibold hover:bg-slate-700 transition-all duration-300 flex items-center gap-2 border border-slate-700"
                            >
                              <Upload className="w-4 h-4" />
                              Revise
                            </button>
                          )}
                          {plant.status === 'READY' && plant.is_latest && (
                            <button 
                              onClick={() => handleActionClick(plant, 'markReady')}
                              className="px-4 py-2 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 text-white text-sm font-semibold hover:from-emerald-500 hover:to-teal-500 transition-all duration-300 flex items-center gap-2"
                            >
                              <Upload className="w-4 h-4" />
                              Upload
                            </button>
                          )}
                          {!plant.is_latest && (
                            <button
                              onClick={() => handleHistoryClick(plant)}
                              className="px-4 py-2 rounded-lg bg-slate-800 text-slate-200 text-sm font-semibold hover:bg-slate-700 transition-all duration-300 flex items-center gap-2 border border-slate-700"
                            >
                              <Clock className="w-4 h-4" />
                              History
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Action Modal */}
      {showActionModal && selectedPlant && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 rounded-2xl shadow-2xl w-full max-w-md border border-slate-700">
            <div className="p-6 border-b border-slate-700 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className={`p-3 rounded-xl ${
                  actionType === 'revise' ? 'bg-indigo-500/10' : 
                  actionType === 'continue' ? 'bg-amber-500/10' : 'bg-emerald-500/10'
                }`}>
                  {actionType === 'revise' && <Upload className="w-6 h-6 text-indigo-400" />}
                  {actionType === 'continue' && <ArrowRight className="w-6 h-6 text-amber-400" />}
                  {actionType === 'markReady' && <CheckCircle className="w-6 h-6 text-emerald-400" />}
                </div>
                <div>
                  <h2 className="text-xl font-bold text-white">
                    {actionType === 'revise' && 'Trigger Schedule Revision'}
                    {actionType === 'continue' && 'Continue Existing Schedule'}
                    {actionType === 'markReady' && 'Upload Schedule'}
                  </h2>
                  <p className="text-sm text-slate-400">{selectedPlant.plant_name}</p>
                </div>
              </div>
              <button 
                onClick={() => setShowActionModal(false)}
                className="p-2 hover:bg-slate-800 rounded-lg transition-colors"
              >
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              {actionType === 'revise' && (
                <div>
                  <label className="text-sm font-medium text-slate-300 mb-2 block">Reason for Revision</label>
                  <select 
                    value={actionReason} 
                    onChange={(e) => setActionReason(e.target.value)}
                    className="w-full px-4 py-3 rounded-lg bg-slate-800 border border-slate-700 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="">Select a reason...</option>
                    <option value="Weather forecast change">Weather forecast change</option>
                    <option value="Curtailment signal received">Curtailment signal received</option>
                    <option value="Meter deviation detected">Meter deviation detected</option>
                    <option value="Manual trigger from dashboard">Manual trigger from dashboard</option>
                    <option value="Other">Other</option>
                  </select>
                  <p className="text-xs text-slate-500 mt-2">
                    This will trigger a new revision and navigate you to Schedule Preparation to edit the schedule.
                  </p>
                </div>
              )}
              {actionType === 'continue' && (
                <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="w-6 h-6 text-amber-400 shrink-0" />
                    <div>
                      <p className="text-sm font-semibold text-amber-400">Continue with Existing Schedule</p>
                      <p className="text-sm text-slate-300 mt-1">This will clear all pending triggers and continue with the existing day-ahead schedule.</p>
                    </div>
                  </div>
                </div>
              )}
              {actionType === 'markReady' && (
                <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl">
                  <div className="flex items-start gap-3">
                    <CheckCircle className="w-6 h-6 text-emerald-400 shrink-0" />
                    <div>
                      <p className="text-sm font-semibold text-emerald-400">Upload Schedule</p>
                      <p className="text-sm text-slate-300 mt-1">This will mark the schedule as ready and navigate you to upload/report generation.</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div className="p-6 border-t border-slate-700 flex gap-3">
              <button 
                onClick={() => setShowActionModal(false)}
                className="flex-1 px-4 py-3 rounded-lg bg-slate-800 text-white font-semibold hover:bg-slate-700 transition-all duration-300"
              >
                Cancel
              </button>
              <button 
                onClick={executeAction}
                disabled={(actionType === 'revise' && !actionReason) || isRefreshing}
                className={`flex-1 px-4 py-3 rounded-lg font-semibold transition-all duration-300 disabled:opacity-50 flex items-center justify-center gap-2 ${
                  actionType === 'continue' 
                    ? 'bg-gradient-to-r from-amber-600 to-orange-600 text-white' 
                    : actionType === 'markReady'
                    ? 'bg-gradient-to-r from-emerald-600 to-teal-600 text-white'
                    : 'bg-gradient-to-r from-indigo-600 to-purple-600 text-white'
                }`}
              >
                {isRefreshing ? (
                  <>
                    <LoadingSpinner size="sm" />
                    <span>Processing...</span>
                  </>
                ) : (
                  getActionButtonText()
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}




