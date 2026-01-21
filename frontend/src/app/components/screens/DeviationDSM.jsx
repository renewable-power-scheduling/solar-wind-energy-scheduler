import { useState, useMemo, useEffect } from 'react';
import { 
  TrendingDown, 
  TrendingUp, 
  AlertTriangle, 
  Calendar,
  Download,
  Filter,
  BarChart3,
  Activity,
  Wind,
  Sun,
  Clock,
  CalendarDays,
  TrendingUp as TrendingUpIcon
} from 'lucide-react';
import { api } from '../../../services/api';
import { generateDeviationData, PLANTS } from '@/services/mockDataService';

export function DeviationDSM() {
  const [selectedPeriod, setSelectedPeriod] = useState('hourly');
  const [loading, setLoading] = useState(true);
  const [deviationData, setDeviationData] = useState(null);
  const [showFilterModal, setShowFilterModal] = useState(false);
  const [plantFilter, setPlantFilter] = useState('All Plants');
  const [typeFilter, setTypeFilter] = useState('All Types');
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const fetchDeviationData = async () => {
      setLoading(true);
      try {
        let limit = 24;
        if (selectedPeriod === 'daily') limit = 30;
        if (selectedPeriod === 'weekly') limit = 12;
        
        const response = await api.deviations.getByPeriod(selectedPeriod, limit);
        setDeviationData(response);
      } catch (error) {
        console.error('Error fetching deviation data:', error);
        setDeviationData(generateDeviationData(selectedPeriod, limit));
      } finally {
        setLoading(false);
      }
    };

    fetchDeviationData();
  }, [selectedPeriod]);

  const filteredDeviations = useMemo(() => {
    if (!deviationData?.deviations) return [];
    return deviationData.deviations.filter(d => {
      const matchesPlant = plantFilter === 'All Plants' || d.plant === plantFilter;
      const matchesType = typeFilter === 'All Types' || d.type === typeFilter;
      return matchesPlant && matchesType;
    });
  }, [deviationData, plantFilter, typeFilter]);

  const filteredStats = useMemo(() => {
    if (filteredDeviations.length === 0) {
      return { avgDeviation: '0.00', maxDeviation: '0.0', withinLimit: '0%', dsmEvents: 0 };
    }
    const totalDeviation = filteredDeviations.reduce((sum, d) => sum + Math.abs(d.deviation || 0), 0);
    const avgPercentage = filteredDeviations.reduce((sum, d) => sum + Math.abs(parseFloat(d.percentage) || 0), 0) / filteredDeviations.length;
    const highDeviations = filteredDeviations.filter(d => Math.abs(parseFloat(d.percentage) || 0) > 10).length;
    const withinLimit = Math.round(((filteredDeviations.length - highDeviations) / filteredDeviations.length) * 100);
    return {
      avgDeviation: (totalDeviation / filteredDeviations.length).toFixed(2),
      maxDeviation: Math.max(...filteredDeviations.map(d => parseFloat(d.percentage) || 0)).toFixed(1),
      withinLimit: `${withinLimit}%`,
      dsmEvents: highDeviations
    };
  }, [filteredDeviations]);

  const handleExportReport = () => {
    const headers = ['Time', 'Plant', 'Scheduled (MW)', 'Actual (MW)', 'Deviation (MW)', 'Percentage (%)', 'Status'];
    const csvContent = [
      headers.join(','),
      ...filteredDeviations.map(row => [
        row.time, row.plant,
        row.scheduled?.toFixed(1) || '0.0',
        row.actual?.toFixed(1) || '0.0',
        row.deviation?.toFixed(1) || '0.0',
        row.percentage?.toFixed(1) || '0.0',
        Math.abs(row.percentage) > 10 ? 'High' : 'Normal'
      ].join(','))
    ].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `deviation-report-${selectedPeriod}-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
  };

  const chartData = useMemo(() => {
    return filteredDeviations.map((d, i) => ({
      ...d,
      index: i,
      value: parseFloat(d.percentage) || 0,
      positive: (parseFloat(d.percentage) || 0) > 0
    }));
  }, [filteredDeviations]);

  const getTimeLabel = (period) => {
    switch (period) {
      case 'hourly': return 'Hour of Day';
      case 'daily': return 'Day';
      case 'weekly': return 'Week';
      default: return 'Time';
    }
  };

  return (
    <div className="flex-1 h-full overflow-auto bg-slate-950 relative pb-8">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-red-500/5 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-amber-500/5 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />
        <div className="absolute top-1/2 left-1/2 w-64 h-64 bg-emerald-500/5 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '2s' }} />
      </div>

      <div className="p-8 space-y-8 max-w-[2000px] mx-auto relative z-10">
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 border border-slate-700/50 shadow-2xl">
          <div className="absolute inset-0 bg-gradient-to-r from-red-500/5 via-transparent to-amber-500/5" />
          <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-bl from-red-500/10 to-transparent rounded-full blur-2xl" />
          
          <div className="relative p-8">
            <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-6">
              <div className="flex items-start gap-5">
                <div className="relative">
                  <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/25">
                    <TrendingDown className="w-7 h-7 text-white" />
                  </div>
                  <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-emerald-500 rounded-full border-2 border-slate-900 animate-ping" />
                </div>
                <div>
                  <h1 className="text-3xl font-bold text-white mb-2 tracking-tight">
                    Deviation & DSM
                    <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-purple-400"> Analysis</span>
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
                <div className="flex items-center gap-1 p-1.5 rounded-xl bg-slate-800/50 border border-slate-700/50">
                  {[
                    { id: 'hourly', label: 'Hourly', icon: Clock },
                    { id: 'daily', label: 'Daily', icon: Calendar },
                    { id: 'weekly', label: 'Weekly', icon: CalendarDays }
                  ].map((period) => (
                    <button
                      key={period.id}
                      onClick={() => setSelectedPeriod(period.id)}
                      className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-300 flex items-center gap-2 ${
                        selectedPeriod === period.id
                          ? 'bg-gradient-to-r from-indigo-600 to-purple-600 text-white shadow-lg'
                          : 'text-slate-400 hover:text-white hover:bg-slate-700/50'
                      }`}
                    >
                      <period.icon className="w-4 h-4" />
                      {period.label}
                    </button>
                  ))}
                </div>
                <button 
                  onClick={handleExportReport}
                  className="group relative px-6 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white shadow-lg shadow-indigo-500/25 hover:shadow-indigo-500/40 transition-all duration-300 flex items-center gap-3"
                >
                  <Download className="w-5 h-5 group-hover:animate-bounce" />
                  <div className="text-left">
                    <p className="text-sm font-semibold">Export Report</p>
                    <p className="text-xs text-indigo-200">Download CSV</p>
                  </div>
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
          {[
            { label: 'Avg Deviation', value: `${filteredStats.avgDeviation}%`, subtext: 'Average deviation', icon: TrendingDown, gradient: 'from-red-600 to-rose-600', glow: 'bg-red-500/20' },
            { label: 'Max Deviation', value: `${filteredStats.maxDeviation}%`, subtext: selectedPeriod === 'hourly' ? 'Peak today' : selectedPeriod === 'daily' ? 'Peak this week' : 'Peak this month', icon: AlertTriangle, gradient: 'from-amber-600 to-orange-600', glow: 'bg-amber-500/20' },
            { label: 'Within Limit', value: filteredStats.withinLimit, subtext: 'Deviations under 10%', icon: Activity, gradient: 'from-emerald-600 to-teal-600', glow: 'bg-emerald-500/20' },
            { label: 'DSM Events', value: filteredStats.dsmEvents, subtext: selectedPeriod === 'hourly' ? "Today's interventions" : selectedPeriod === 'daily' ? 'This week' : 'This month', icon: BarChart3, gradient: 'from-violet-600 to-purple-600', glow: 'bg-violet-500/20' }
          ].map((stat, i) => (
            <div key={i} className="group relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 to-slate-800 border border-slate-700/50 hover:border-slate-600 transition-all duration-500 hover:-translate-y-1 hover:shadow-2xl">
              <div className={`absolute inset-0 bg-gradient-to-r ${stat.glow} opacity-0 group-hover:opacity-100 transition-opacity duration-500`} />
              <div className={`absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl ${stat.glow} rounded-full blur-3xl opacity-50 group-hover:opacity-75 transition-opacity duration-500`} />
              <div className="relative p-6">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <p className="text-sm font-medium text-slate-400 uppercase tracking-wider">{stat.label}</p>
                    <div className={`text-5xl font-bold mt-2 bg-gradient-to-r ${stat.gradient} bg-clip-text text-transparent`}>{stat.value}</div>
                  </div>
                  <div className={`p-3 rounded-xl bg-gradient-to-br ${stat.glow} group-hover:scale-110 transition-transform duration-300`}>
                    <stat.icon className={`w-6 h-6 ${i === 0 ? 'text-red' : i === 1 ? 'text-amber' : i === 2 ? 'text-emerald' : 'text-violet'}-400`} />
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

        <div className="rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm overflow-hidden">
          <div className="p-6 border-b border-slate-700/50 bg-gradient-to-r from-slate-800/50 to-transparent">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-red-500/10">
                  <BarChart3 className="w-6 h-6 text-red-400" />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-white">Deviation Trend Analysis</h3>
                  <p className="text-sm text-slate-400">
                    {selectedPeriod === 'hourly' ? 'Hourly deviation patterns - Today' : selectedPeriod === 'daily' ? 'Daily deviation patterns - Last 30 days' : 'Weekly deviation patterns - Last 12 weeks'}
                  </p>
                </div>
              </div>
              <div className="flex gap-4 text-sm text-slate-400">
                <span className="px-3 py-1 rounded-lg bg-slate-800/50">Range: {deviationData?.summary?.minDeviation || '0'}% to {deviationData?.summary?.maxDeviation || '0'}%</span>
              </div>
            </div>
          </div>
          
          {loading ? (
            <div className="h-80 bg-slate-800/30 rounded border border-slate-700/50 flex items-center justify-center">
              <div className="flex flex-col items-center gap-4">
                <div className="relative">
                  <div className="w-16 h-16 rounded-full border-4 border-slate-700 border-t-red-500 animate-spin" />
                  <div className="absolute inset-0 w-16 h-16 rounded-full border-4 border-transparent border-b-amber-500 animate-spin" style={{ animationDirection: 'reverse', animationDuration: '1.5s' }} />
                </div>
                <span className="text-sm text-slate-400 animate-pulse">Loading {selectedPeriod} data...</span>
              </div>
            </div>
          ) : (
            <div className="h-80 bg-slate-800/30 rounded border border-slate-700/50 p-6 relative">
              <div className="absolute left-0 top-6 bottom-6 flex flex-col justify-between text-xs text-slate-500 px-2">
                {['+20%', '+10%', '0%', '-10%', '-20%'].map(label => (<span key={label}>{label}</span>))}
              </div>
              
              <div className="absolute inset-6 left-8 right-2">
                <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
                  <line x1="0" y1="25" x2="100" y2="25" stroke="#374151" strokeWidth="0.5" />
                  <line x1="0" y1="50" x2="100" y2="50" stroke="#374151" strokeWidth="1" />
                  <line x1="0" y1="75" x2="100" y2="75" stroke="#374151" strokeWidth="0.5" />
                  {chartData.map((d, i) => {
                    const x = (i / Math.max(chartData.length - 1, 1)) * 100;
                    const maxHeight = 40;
                    const height = Math.min(Math.abs(d.value) * 2, maxHeight);
                    const y = d.value > 0 ? 50 - height : 50;
                    const color = d.value > 10 ? '#ef4444' : d.value > 0 ? '#f97316' : d.value < -10 ? '#3b82f6' : '#10b981';
                    return (
                      <g key={i}>
                        <title>{`${d.time}: ${d.percentage}% deviation (${d.plant})`}</title>
                        <rect x={x - (chartData.length > 15 ? 2 : chartData.length > 10 ? 3 : 4)} y={y} width={chartData.length > 15 ? 4 : chartData.length > 10 ? 6 : 8} height={height} fill={color} opacity="0.8" rx="0.5" className="hover:opacity-100 transition-all cursor-pointer" />
                      </g>
                    );
                  })}
                </svg>
              </div>
              
              <div className="absolute bottom-1 left-8 right-2 flex justify-between text-xs text-slate-500">
                {chartData.filter((_, i) => chartData.length <= 12 || i % Math.ceil(chartData.length / 12) === 0).map((d, i) => (<span key={i} className="truncate" style={{ maxWidth: '60px' }}>{d.time}</span>))}
              </div>
              
              <div className="absolute top-2 right-2 flex gap-4 text-xs">
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded-sm bg-red-500" />
                  <span className="text-slate-400">High</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded-sm bg-orange-500" />
                  <span className="text-slate-400">Medium</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded-sm bg-emerald-500" />
                  <span className="text-slate-400">Normal</span>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm overflow-hidden">
          <div className="p-6 border-b border-slate-700/50 bg-gradient-to-r from-slate-800/50 to-transparent">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-amber-500/10">
                  <Filter className="w-6 h-6 text-amber-400" />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-white">Deviation Details</h3>
                  <p className="text-sm text-slate-400">
                    {selectedPeriod === 'hourly' ? 'Block-by-block analysis' : selectedPeriod === 'daily' ? 'Day-by-day analysis' : 'Week-by-week analysis'}
                  </p>
                </div>
              </div>
              <div className="flex gap-3">
                <div className="flex items-center gap-2">
                  <button 
                    onClick={() => {
                      if (typeFilter === 'All Types') setTypeFilter('Wind');
                      else if (typeFilter === 'Wind') setTypeFilter('Solar');
                      else setTypeFilter('All Types');
                    }}
                    className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-300 ${
                      typeFilter !== 'All Types' ? 'bg-gradient-to-r from-indigo-600 to-purple-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white border border-slate-700'
                    }`}
                  >
                    {typeFilter === 'All Types' ? 'All Types' : typeFilter}
                  </button>
                </div>
                <button 
                  onClick={() => setShowFilterModal(true)}
                  className="px-4 py-2 rounded-lg bg-slate-800 text-white text-sm font-semibold hover:bg-slate-700 transition-all duration-300 flex items-center gap-2 border border-slate-700"
                >
                  <Filter className="w-4 h-4" />
                  More Filters
                </button>
              </div>
            </div>
          </div>
          
          <div className="overflow-x-auto max-h-96">
            <table className="w-full">
              <thead className="sticky top-0 bg-slate-800/80 backdrop-blur-sm z-10">
                <tr>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">{getTimeLabel(selectedPeriod)}</th>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">Plant</th>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">Scheduled</th>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">Actual</th>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">Deviation</th>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">Percentage</th>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {filteredDeviations.map((item, i) => {
                  const Icon = item.type === 'Wind' ? Wind : Sun;
                  const isHighDeviation = Math.abs(parseFloat(item.percentage)) > 10;
                  return (
                    <tr key={i} className="group hover:bg-slate-800/30 transition-all duration-300">
                      <td className="px-6 py-4 text-sm font-semibold text-white">{item.time}</td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className={`p-2 rounded-xl transition-transform duration-300 group-hover:scale-110 ${
                            item.type === 'Wind' ? 'bg-gradient-to-br from-blue-500/20 to-cyan-500/20' : 'bg-gradient-to-br from-amber-500/20 to-orange-500/20'
                          }`}>
                            <Icon className={`w-5 h-5 ${item.type === 'Wind' ? 'text-blue-400' : 'text-amber-400'}`} />
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-white group-hover:text-indigo-400 transition-colors">{item.plant}</p>
                            <p className="text-xs text-slate-500">{item.type}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-400">
                        {selectedPeriod === 'hourly' ? `${item.scheduled?.toFixed(1) || 0} MW` : `${item.scheduled?.toFixed(0) || 0} MWh`}
                      </td>
                      <td className="px-6 py-4 text-sm font-bold text-white">
                        {selectedPeriod === 'hourly' ? `${item.actual?.toFixed(1) || 0} MW` : `${item.actual?.toFixed(0) || 0} MWh`}
                      </td>
                      <td className="px-6 py-4">
                        <span className={`text-sm font-bold ${(item.deviation || 0) > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                          {(item.deviation || 0) > 0 ? '+' : ''}{item.deviation?.toFixed(1) || 0} {selectedPeriod === 'hourly' ? 'MW' : 'MWh'}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          {(parseFloat(item.percentage) || 0) > 0 ? (
                            <TrendingUpIcon className="w-4 h-4 text-red-400" />
                          ) : (
                            <TrendingUpIcon className="w-4 h-4 text-emerald-400 rotate-180" />
                          )}
                          <span className={`text-sm font-bold ${(parseFloat(item.percentage) || 0) > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                            {(parseFloat(item.percentage) || 0) > 0 ? '+' : ''}{item.percentage || 0}%
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        {isHighDeviation ? (
                          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-red-500/20 text-red-400 border border-red-500/30">
                            <AlertTriangle className="w-3 h-3" />
                            High
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                            Normal
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="p-4 border-t border-slate-700/50 bg-slate-800/30 flex items-center justify-between">
            <p className="text-sm text-slate-400">
              Showing <span className="text-white font-semibold">{filteredDeviations.length}</span> of <span className="text-white font-semibold">{deviationData?.deviations?.length || 0}</span> {selectedPeriod} records
            </p>
            <div className="flex gap-3">
              <button onClick={() => { setPlantFilter('All Plants'); setTypeFilter('All Types'); }} className="text-sm text-slate-400 hover:text-white transition-colors">Clear Filters</button>
              <span className="text-slate-600">|</span>
              <button className="text-sm text-red-400 hover:text-red-300 font-semibold transition-colors">View all deviations</button>
            </div>
          </div>
        </div>

      </div>

      {showFilterModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 rounded-2xl shadow-2xl w-full max-w-md border border-slate-700">
            <div className="p-6 border-b border-slate-700 bg-gradient-to-r from-slate-800/50 to-transparent">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-amber-500/10">
                  <Filter className="w-6 h-6 text-amber-400" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-white">Filter Deviations</h2>
                  <p className="text-sm text-slate-400">Filter deviation data by plant and type</p>
                </div>
              </div>
            </div>
            
            <div className="p-6 space-y-4">
              <div>
                <label className="text-sm font-medium text-slate-300 mb-2.5 flex items-center gap-2">
                  <Wind className="w-4 h-4 text-blue-400" />
                  Plant
                </label>
                <select 
                  value={plantFilter}
                  onChange={(e) => setPlantFilter(e.target.value)}
                  className="w-full px-4 py-3 rounded-lg bg-slate-800 border border-slate-700 text-white focus:outline-none focus:ring-2 focus:ring-red-500"
                >
                  <option value="All Plants">All Plants</option>
                  {PLANTS.map(plant => (<option key={plant.id} value={plant.name}>{plant.name}</option>))}
                </select>
              </div>

              <div>
                <label className="text-sm font-medium text-slate-300 mb-2.5 flex items-center gap-2">
                  {typeFilter === 'Solar' ? <Sun className="w-4 h-4 text-amber-400" /> : <Wind className="w-4 h-4 text-blue-400" />}
                  Type
                </label>
                <select 
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                  className="w-full px-4 py-3 rounded-lg bg-slate-800 border border-slate-700 text-white focus:outline-none focus:ring-2 focus:ring-red-500"
                >
                  <option value="All Types">All Types</option>
                  <option value="Wind">Wind</option>
                  <option value="Solar">Solar</option>
                </select>
              </div>
            </div>

            <div className="p-6 border-t border-slate-700 flex gap-3">
              <button 
                onClick={() => { setPlantFilter('All Plants'); setTypeFilter('All Types'); }}
                className="flex-1 px-4 py-3 rounded-lg bg-slate-800 text-white font-semibold hover:bg-slate-700 transition-all duration-300 border border-slate-700"
              >
                Clear Filters
              </button>
              <button 
                onClick={() => setShowFilterModal(false)}
                className="flex-1 px-4 py-3 rounded-lg bg-gradient-to-r from-indigo-600 to-purple-600 text-white font-semibold hover:shadow-lg transition-all duration-300"
              >
                Apply Filters
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default DeviationDSM;

