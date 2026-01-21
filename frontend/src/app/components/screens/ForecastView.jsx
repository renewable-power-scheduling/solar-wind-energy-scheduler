
import { useState, useMemo, useRef, useEffect } from 'react';
import {
  Cloud,
  Wind,
  Sun,
  Eye,
  TrendingUp,
  TrendingDown,
  Clock,
  Zap,
  ArrowUp,
  ArrowDown,
  Layers,
  TrendingUp as TrendingUpIcon,
  Activity,
  FileText,
  ArrowLeft
} from 'lucide-react';
import { PLANTS, generateScheduleData } from '@/services/mockDataService';

export function ForecastView({ onNavigate, context }) {
  const plantCategory = context?.category || 'Wind';
  const plantName = context?.plant || (plantCategory === 'Wind' ? 'Wind Farm A' : 'Solar Park A');
  
  // Find the plant from PLANTS array
  const plant = useMemo(() => {
    return PLANTS.find(p => p.name === plantName) || PLANTS[0];
  }, [plantName]);

  // Generate 96 time blocks for 24 hours with consistent data
  const timeBlocks = useMemo(() => {
    return generateScheduleData(plant.id, new Date().toISOString().split('T')[0], 'Day-Ahead');
  }, [plant]);

  // Filter for solar (only 7 AM to 6 PM = blocks 28 to 72)
  const filteredBlocks = useMemo(() => {
    if (plantCategory === 'Wind') return timeBlocks;
    return timeBlocks.filter(block => block.hour >= 7 && block.hour <= 18);
  }, [timeBlocks, plantCategory]);

  // Find max value for Y-axis scaling
  const maxValue = useMemo(() => {
    const allValues = filteredBlocks.flatMap(b => [
      parseFloat(b.forecast),
      parseFloat(b.actual),
      parseFloat(b.scheduled)
    ]);
    return Math.max(...allValues, 10) * 1.1;
  }, [filteredBlocks]);

  // Hover state
  const [hoveredBlock, setHoveredBlock] = useState(null);
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });
  const chartRef = useRef(null);

  // Handle mouse move on chart
  const handleMouseMove = (e) => {
    if (!chartRef.current) return;
    
    const rect = chartRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    // Calculate which block is being hovered based on x position
    const chartWidth = rect.width - 48; // Account for padding
    const chartLeft = rect.left + 24;
    const relativeX = e.clientX - chartLeft;
    
    if (relativeX >= 0 && relativeX <= chartWidth) {
      const blockIndex = Math.floor((relativeX / chartWidth) * (filteredBlocks.length - 1));
      const block = filteredBlocks[Math.min(blockIndex, filteredBlocks.length - 1)];
      setHoveredBlock(block);
    }
    
    setMousePosition({ x, y });
  };

  // Generate smooth curved path using cubic Bézier curves
  const generateSmoothPath = (getValue, blocks) => {
    if (blocks.length === 0) return '';
    
    const points = blocks.map((block, i) => {
      const x = (i / (blocks.length - 1)) * 100;
      const y = 100 - (getValue(block) / maxValue * 100);
      return { x, y };
    });
    
    // Create smooth curve using Catmull-Rom to Bézier conversion
    let path = `M ${points[0].x},${points[0].y}`;
    
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[Math.max(i - 1, 0)];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[Math.min(i + 2, points.length - 1)];
      
      // Calculate control points
      const tension = 0.3;
      const cp1x = p1.x + (p2.x - p0.x) * tension;
      const cp1y = p1.y + (p2.y - p0.y) * tension;
      const cp2x = p2.x - (p3.x - p1.x) * tension;
      const cp2y = p2.y - (p3.y - p1.y) * tension;
      
      path += ` C ${cp1x},${cp1y} ${cp2x},${cp2y} ${p2.x},${p2.y}`;
    }
    
    return path;
  };

  // Generate SVG area path (for gradient fill)
  const generateAreaPath = (getValue, blocks) => {
    if (blocks.length === 0) return '';
    
    const linePath = generateSmoothPath(getValue, blocks);
    // Extract points from path to close the area
    const points = blocks.map((block, i) => {
      const x = (i / (blocks.length - 1)) * 100;
      const y = 100 - (getValue(block) / maxValue * 100);
      return `${x},${y}`;
    });
    
    return `0,100 ${points.join(' ')} 100,100`;
  };

  // Colors
  const colors = {
    forecast: '#3b82f6',  // Blue
    actual: '#22c55e',    // Green
    scheduled: '#f59e0b'  // Amber/Orange
  };

  // Get time label for X-axis
  const getTimeLabels = () => {
    if (filteredBlocks.length <= 10) {
      return filteredBlocks.map(b => b.time);
    }
    // Show fewer labels for larger datasets
    const step = Math.ceil(filteredBlocks.length / 10);
    const labels = [];
    for (let i = 0; i < filteredBlocks.length; i += step) {
      labels.push(filteredBlocks[i].time);
    }
    return labels;
  };

  // Calculate hover X position for vertical line
  const getHoverX = () => {
    if (!hoveredBlock) return -100;
    const blockIndex = filteredBlocks.findIndex(b => b.time === hoveredBlock.time);
    return (blockIndex / (filteredBlocks.length - 1)) * 100;
  };

  return (
    <div className="flex-1 overflow-auto bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
      {/* Animated Background Elements */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 right-0 w-[600px] h-[600px] bg-indigo-500/5 rounded-full blur-3xl" />
        <div className="absolute bottom-0 left-0 w-[600px] h-[600px] bg-purple-500/5 rounded-full blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-blue-500/3 rounded-full blur-3xl" />
      </div>

      <div className="relative z-10 p-6 space-y-6 max-w-[1600px] mx-auto">
        {/* Header */}
        <div className="bg-gradient-to-br from-slate-800/50 to-slate-900/50 rounded-2xl p-6 border border-slate-700/50 backdrop-blur-sm">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => onNavigate('dashboard')}
                  className="px-4 py-2 rounded-lg bg-slate-800/50 hover:bg-slate-700/50 border border-slate-700/50 transition-all text-sm font-medium text-slate-300 hover:text-white flex items-center gap-2"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Back
                </button>
                <h1 className="text-2xl font-bold text-white">
                  {plantName} - Forecast View
                </h1>
                <span className={`px-3 py-1 rounded-lg text-sm font-semibold ${
                  plantCategory === 'Wind'
                    ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30'
                    : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                }`}>
                  {plantCategory} Plant
                </span>
              </div>
              <p className="text-sm text-slate-400 mt-2 flex items-center gap-2">
                <Eye className="w-4 h-4" />
                Forecast vs Actual vs Schedule - {plantCategory === 'Wind' ? '24 Hour' : 'Daylight Hours (7 AM - 6 PM)'} Analysis
              </p>
            </div>
            <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-500/20 border border-emerald-500/30 shadow-lg shadow-emerald-500/10">
              <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
              <span className="text-sm font-semibold text-emerald-400">Live Data</span>
            </div>
          </div>
        </div>

        {/* Legend */}
        <div className="flex items-center justify-center gap-8 py-4">
          <div className="flex items-center gap-3 px-4 py-2 rounded-lg bg-slate-800/50 border border-slate-700/50">
            <div className="w-12 h-1 rounded-full" style={{ backgroundColor: colors.forecast }}></div>
            <span className="text-sm font-semibold" style={{ color: colors.forecast }}>Forecast</span>
          </div>
          <div className="flex items-center gap-3 px-4 py-2 rounded-lg bg-slate-800/50 border border-slate-700/50">
            <div className="w-12 h-1 rounded-full" style={{ backgroundColor: colors.actual }}></div>
            <span className="text-sm font-semibold" style={{ color: colors.actual }}>Actual</span>
          </div>
          <div className="flex items-center gap-3 px-4 py-2 rounded-lg bg-slate-800/50 border border-slate-700/50">
            <div className="w-12 h-1 rounded-full" style={{ backgroundColor: colors.scheduled }}></div>
            <span className="text-sm font-semibold" style={{ color: colors.scheduled }}>Schedule</span>
          </div>
        </div>

        {/* Main Chart */}
        <div className="bg-gradient-to-br from-slate-800/50 to-slate-900/50 rounded-2xl border border-slate-700/50 shadow-2xl overflow-hidden backdrop-blur-sm">
          <div className="p-6 border-b border-slate-700/50">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-white">
                {plantCategory === 'Wind' ? '24-Hour Power Generation' : 'Daylight Power Generation'}
              </h3>
              <div className="px-3 py-1.5 rounded-lg bg-slate-700/50 text-sm text-slate-400">
                {filteredBlocks.length} × 15-min intervals
              </div>
            </div>
          </div>

          <div className="p-6">
            <div
              ref={chartRef}
              className="h-96 bg-slate-950/50 rounded-xl border border-slate-700/50 p-4 relative cursor-crosshair"
              onMouseMove={handleMouseMove}
              onMouseLeave={() => setHoveredBlock(null)}
            >
              <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
                {/* Grid lines */}
                {[0, 25, 50, 75, 100].map(y => (
                  <line
                    key={y}
                    x1="0"
                    y1={y}
                    x2="100"
                    y2={y}
                    stroke="#334155"
                    strokeWidth="0.2"
                  />
                ))}

                {/* Y-axis labels */}
                {[
                  { y: 0, value: '0 MW' },
                  { y: 25, value: `${(maxValue * 0.25).toFixed(0)} MW` },
                  { y: 50, value: `${(maxValue * 0.5).toFixed(0)} MW` },
                  { y: 75, value: `${(maxValue * 0.75).toFixed(0)} MW` },
                  { y: 100, value: `${maxValue.toFixed(0)} MW` }
                ].map((label, i) => (
                  <text
                    key={i}
                    x="-2"
                    y={label.y}
                    textAnchor="end"
                    className="text-[3px] fill-slate-400"
                    dominantBaseline="middle"
                  >
                    {label.value}
                  </text>
                ))}

                {/* Forecast area with gradient */}
                <polygon
                  points={generateAreaPath(b => parseFloat(b.forecast), filteredBlocks)}
                  fill={`url(#forecastGradient)`}
                  opacity="0.2"
                />
                
                {/* Actual area with gradient */}
                <polygon
                  points={generateAreaPath(b => parseFloat(b.actual), filteredBlocks)}
                  fill={`url(#actualGradient)`}
                  opacity="0.2"
                />

                {/* Forecast line - smooth curve */}
                <path
                  d={generateSmoothPath(b => parseFloat(b.forecast), filteredBlocks)}
                  fill="none"
                  stroke={colors.forecast}
                  strokeWidth="0.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="transition-all duration-300 drop-shadow-lg"
                />

                {/* Actual line - smooth curve */}
                <path
                  d={generateSmoothPath(b => parseFloat(b.actual), filteredBlocks)}
                  fill="none"
                  stroke={colors.actual}
                  strokeWidth="0.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="transition-all duration-300 drop-shadow-lg"
                />

                {/* Scheduled line - smooth curve */}
                <path
                  d={generateSmoothPath(b => parseFloat(b.scheduled), filteredBlocks)}
                  fill="none"
                  stroke={colors.scheduled}
                  strokeWidth="0.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray="2 1"
                  className="transition-all duration-300 drop-shadow-lg"
                />

                {/* Gradients */}
                <defs>
                  <linearGradient id="forecastGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stopColor={colors.forecast} stopOpacity="0.4" />
                    <stop offset="100%" stopColor={colors.forecast} stopOpacity="0" />
                  </linearGradient>
                  <linearGradient id="actualGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stopColor={colors.actual} stopOpacity="0.4" />
                    <stop offset="100%" stopColor={colors.actual} stopOpacity="0" />
                  </linearGradient>
                </defs>

                {/* Hover vertical line */}
                {hoveredBlock && (
                  <line
                    x1={getHoverX()}
                    y1="0"
                    x2={getHoverX()}
                    y2="100"
                    stroke="#64748b"
                    strokeWidth="0.5"
                    strokeDasharray="1 1"
                    className="pointer-events-none"
                  />
                )}
              </svg>

              {/* X-axis labels */}
              <div className="absolute bottom-2 left-4 right-4 flex justify-between text-xs text-slate-500">
                {getTimeLabels().map((time, i) => (
                  <span key={i}>{time}</span>
                ))}
              </div>

              {/* Hover data points */}
              {hoveredBlock && (
                <>
                  {/* Forecast point */}
                  <div
                    className="absolute w-3 h-3 rounded-full border-2 border-slate-900 shadow-lg pointer-events-none transform -translate-x-1.5 -translate-y-1.5 transition-all duration-75"
                    style={{
                      backgroundColor: colors.forecast,
                      left: `calc(${getHoverX()}% - 12px)`,
                      top: `calc(${100 - (parseFloat(hoveredBlock.forecast) / maxValue * 100)}% - 12px)`
                    }}
                  />
                  {/* Actual point */}
                  <div
                    className="absolute w-3 h-3 rounded-full border-2 border-slate-900 shadow-lg pointer-events-none transform -translate-x-1.5 -translate-y-1.5 transition-all duration-75"
                    style={{
                      backgroundColor: colors.actual,
                      left: `calc(${getHoverX()}% - 12px)`,
                      top: `calc(${100 - (parseFloat(hoveredBlock.actual) / maxValue * 100)}% - 12px)`
                    }}
                  />
                  {/* Scheduled point */}
                  <div
                    className="absolute w-3 h-3 rounded-full border-2 border-slate-900 shadow-lg pointer-events-none transform -translate-x-1.5 -translate-y-1.5 transition-all duration-75"
                    style={{
                      backgroundColor: colors.scheduled,
                      left: `calc(${getHoverX()}% - 12px)`,
                      top: `calc(${100 - (parseFloat(hoveredBlock.scheduled) / maxValue * 100)}% - 12px)`
                    }}
                  />
                </>
              )}

              {/* Hover tooltip card */}
              {hoveredBlock && (
                <div
                  className="absolute z-10 bg-slate-800/95 backdrop-blur-xl border border-slate-700 rounded-xl shadow-2xl p-4 pointer-events-none transform transition-all duration-75"
                  style={{
                    left: Math.min(mousePosition.x + 15, 280),
                    top: Math.max(mousePosition.y - 100, 10),
                    animation: 'fadeIn 0.15s ease-out'
                  }}
                >
                  <style>{`
                    @keyframes fadeIn {
                      from { opacity: 0; transform: translateY(5px); }
                      to { opacity: 1; transform: translateY(0); }
                    }
                  `}</style>
                  <div className="flex items-center gap-2 mb-3 pb-2 border-b border-slate-700">
                    <Clock className="w-4 h-4 text-slate-400" />
                    <span className="font-bold text-white">{hoveredBlock.time}</span>
                  </div>
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between gap-4 min-w-[140px]">
                      <div className="flex items-center gap-2">
                        <div className="w-4 h-0.5 rounded" style={{ backgroundColor: colors.forecast }}></div>
                        <span className="text-sm text-slate-400">Forecast</span>
                      </div>
                      <span className="text-sm font-bold" style={{ color: colors.forecast }}>
                        {hoveredBlock.forecast} MW
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-2">
                        <div className="w-4 h-0.5 rounded" style={{ backgroundColor: colors.actual }}></div>
                        <span className="text-sm text-slate-400">Actual</span>
                      </div>
                      <span className="text-sm font-bold" style={{ color: colors.actual }}>
                        {hoveredBlock.actual} MW
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-2">
                        <div className="w-4 h-0.5 rounded" style={{ backgroundColor: colors.scheduled }}></div>
                        <span className="text-sm text-slate-400">Schedule</span>
                      </div>
                      <span className="text-sm font-bold" style={{ color: colors.scheduled }}>
                        {hoveredBlock.scheduled} MW
                      </span>
                    </div>
                    <div className="pt-2 mt-2 border-t border-slate-700">
                      <div className="flex items-center justify-between gap-4">
                        <span className="text-sm text-slate-400">Deviation</span>
                        <span className={`text-sm font-bold flex items-center gap-1 ${
                          parseFloat(hoveredBlock.actual) >= parseFloat(hoveredBlock.forecast) 
                            ? 'text-emerald-400' 
                            : 'text-red-400'
                        }`}>
                          {parseFloat(hoveredBlock.actual) >= parseFloat(hoveredBlock.forecast) 
                            ? <ArrowUp className="w-3 h-3" />
                            : <ArrowDown className="w-3 h-3" />
                          }
                          {(parseFloat(hoveredBlock.actual) - parseFloat(hoveredBlock.forecast)).toFixed(1)} MW
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Stats Summary */}
        <div className="grid grid-cols-3 gap-6">
          <div className="bg-gradient-to-br from-slate-800/50 to-slate-900/50 rounded-2xl border border-slate-700/50 p-6 backdrop-blur-sm hover:border-indigo-500/50 transition-all group">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-medium text-slate-400">Total Forecast</span>
              <div className="p-2 bg-indigo-500/20 rounded-lg group-hover:bg-indigo-500/30 transition-colors">
                <Zap className="w-5 h-5 text-indigo-400" />
              </div>
            </div>
            <div className="text-3xl font-bold text-white mb-2">
              {filteredBlocks.reduce((sum, b) => sum + parseFloat(b.forecast), 0).toFixed(1)} MW
            </div>
            <div className="text-sm text-slate-500">
              Sum of all intervals
            </div>
          </div>

          <div className="bg-gradient-to-br from-slate-800/50 to-slate-900/50 rounded-2xl border border-slate-700/50 p-6 backdrop-blur-sm hover:border-emerald-500/50 transition-all group">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-medium text-slate-400">Total Actual</span>
              <div className="p-2 bg-emerald-500/20 rounded-lg group-hover:bg-emerald-500/30 transition-colors">
                <TrendingUp className="w-5 h-5 text-emerald-400" />
              </div>
            </div>
            <div className="text-3xl font-bold text-white mb-2">
              {filteredBlocks.reduce((sum, b) => sum + parseFloat(b.actual), 0).toFixed(1)} MW
            </div>
            <div className="text-sm text-slate-500">
              Sum of all intervals
            </div>
          </div>

          <div className="bg-gradient-to-br from-slate-800/50 to-slate-900/50 rounded-2xl border border-slate-700/50 p-6 backdrop-blur-sm hover:border-purple-500/50 transition-all group">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-medium text-slate-400">Net Deviation</span>
              <div className={`p-2 rounded-lg transition-colors ${
                filteredBlocks.reduce((sum, b) => sum + parseFloat(b.actual), 0) >=
                 filteredBlocks.reduce((sum, b) => sum + parseFloat(b.forecast), 0)
                  ? 'bg-emerald-500/20 group-hover:bg-emerald-500/30'
                  : 'bg-red-500/20 group-hover:bg-red-500/30'
              }`}>
                {filteredBlocks.reduce((sum, b) => sum + parseFloat(b.actual), 0) >=
                 filteredBlocks.reduce((sum, b) => sum + parseFloat(b.forecast), 0)
                  ? <TrendingUp className="w-5 h-5 text-emerald-400" />
                  : <TrendingDown className="w-5 h-5 text-red-400" />
                }
              </div>
            </div>
            <div className="text-3xl font-bold text-white mb-2">
              {((filteredBlocks.reduce((sum, b) => sum + parseFloat(b.actual), 0) -
                 filteredBlocks.reduce((sum, b) => sum + parseFloat(b.forecast), 0))).toFixed(1)} MW
            </div>
            <div className={`text-sm ${
              filteredBlocks.reduce((sum, b) => sum + parseFloat(b.actual), 0) >=
              filteredBlocks.reduce((sum, b) => sum + parseFloat(b.forecast), 0)
                ? 'text-emerald-400'
                : 'text-red-400'
            }`}>
              {filteredBlocks.reduce((sum, b) => sum + parseFloat(b.actual), 0) >=
               filteredBlocks.reduce((sum, b) => sum + parseFloat(b.forecast), 0)
                ? '↑ Above forecast'
                : '↓ Below forecast'}
            </div>
          </div>
        </div>

        {/* Data Table */}
        <div className="bg-gradient-to-br from-slate-800/50 to-slate-900/50 rounded-2xl border border-slate-700/50 overflow-hidden backdrop-blur-sm">
          <div className="p-6 border-b border-slate-700/50">
            <h3 className="text-base font-semibold text-white">
              {plantCategory === 'Wind' ? '24-Hour' : 'Daylight Hours'} Schedule Data
            </h3>
            <p className="text-sm text-slate-500 mt-1">
              Detailed {plantCategory === 'Wind' ? '24-hour' : '7 AM - 6 PM'} data with 15-minute intervals
            </p>
          </div>

          <div className="overflow-x-auto max-h-80">
            <table className="w-full">
              <thead className="sticky top-0 bg-slate-900/80 backdrop-blur-sm">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Time
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: colors.forecast }}>
                    Forecast (MW)
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: colors.actual }}>
                    Actual (MW)
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: colors.scheduled }}>
                    Schedule (MW)
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Deviation
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {filteredBlocks.map((block, i) => {
                  const deviation = (parseFloat(block.actual) - parseFloat(block.forecast)).toFixed(1);
                  return (
                    <tr
                      key={i}
                      className={`hover:bg-slate-700/30 transition-all cursor-pointer ${
                        hoveredBlock?.time === block.time ? 'bg-slate-700/40' : ''
                      }`}
                      onMouseEnter={() => setHoveredBlock(block)}
                    >
                      <td className="px-6 py-3 text-sm font-medium text-slate-300">
                        {block.time}
                      </td>
                      <td className="px-6 py-3 text-sm font-semibold" style={{ color: colors.forecast }}>
                        {block.forecast}
                      </td>
                      <td className="px-6 py-3 text-sm font-semibold" style={{ color: colors.actual }}>
                        {block.actual}
                      </td>
                      <td className="px-6 py-3 text-sm font-semibold" style={{ color: colors.scheduled }}>
                        {block.scheduled}
                      </td>
                      <td className="px-6 py-3 text-sm">
                        <span className={`font-bold ${
                          parseFloat(deviation) >= 0 ? 'text-emerald-400' : 'text-red-400'
                        }`}>
                          {parseFloat(deviation) >= 0 ? '+' : ''}{deviation}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

