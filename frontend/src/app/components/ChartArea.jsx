import { TrendingUp, TrendingDown, Info, RefreshCw } from 'lucide-react';

export function ChartArea({ 
  forecastData = [], 
  actualData = [],
  isLoading = false,
  onRefresh = () => {}
}) {
  // Default data if none provided
  const defaultForecast = [45, 48, 52, 55, 58, 62, 65, 68, 70, 72, 75, 78, 80, 82, 85, 88, 90, 92, 94, 96, 98, 95, 92, 88];
  const defaultActual = [42, 46, 50, 53, 56, 60, 63, 66, 68, 70, 73, 76, 78, 80, 83, 86, 88, 90, 92, 94, 96, 93, 90, 86];
  
  const forecast = forecastData.length > 0 ? forecastData : defaultForecast;
  const actual = actualData.length > 0 ? actualData : defaultActual;
  
  const maxValue = Math.max(...forecast, ...actual, 100);
  
  // Generate SVG path for forecast line (dashed)
  const forecastPoints = forecast.map((value, i) => {
    const x = (i / (forecast.length - 1)) * 100;
    const y = 100 - ((value / maxValue) * 100);
    return `${x},${y}`;
  }).join(' ');
  
  // Generate SVG path for actual line (solid)
  const actualPoints = actual.map((value, i) => {
    const x = (i / (actual.length - 1)) * 100;
    const y = 100 - ((value / maxValue) * 100);
    return `${x},${y}`;
  }).join(' ');
  
  // Generate area fill path
  const areaPath = `0,100 ${actualPoints} 100,100`;

  return (
    <div className="bg-card rounded-lg border border-border shadow-sm overflow-hidden animate-fade-in">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-5 h-5 text-primary" />
          <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">
            Forecast vs Actual
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <button 
            onClick={onRefresh}
            className="p-1.5 rounded hover:bg-accent transition-colors"
            title="Refresh data"
          >
            <RefreshCw className="w-4 h-4 text-muted-foreground" />
          </button>
          <div className="relative group">
            <Info className="w-4 h-4 text-muted-foreground cursor-help" />
            <div className="absolute right-0 top-full mt-1 w-48 bg-popover border border-border rounded-md shadow-lg p-2 text-xs text-popover-foreground opacity-0 group-hover:opacity-100 transition-opacity z-10">
              Real-time comparison of forecast and actual power generation
            </div>
          </div>
        </div>
      </div>

      {/* Chart Container */}
      <div className="p-4">
        {isLoading ? (
          <div className="h-64 flex items-center justify-center bg-muted/30 rounded-lg border border-border">
            <div className="flex flex-col items-center gap-2">
              <RefreshCw className="w-6 h-6 text-primary animate-spin" />
              <span className="text-sm text-muted-foreground">Loading chart data...</span>
            </div>
          </div>
        ) : (
          <div className="relative h-64 bg-muted/20 rounded-lg border border-border p-4">
            {/* Y-axis labels */}
            <div className="absolute left-1 top-1 bottom-6 flex flex-col justify-between text-xs text-muted-foreground px-2">
              <span>{maxValue.toFixed(0)} MW</span>
              <span>{(maxValue * 0.75).toFixed(0)} MW</span>
              <span>{(maxValue * 0.5).toFixed(0)} MW</span>
              <span>{(maxValue * 0.25).toFixed(0)} MW</span>
              <span>0 MW</span>
            </div>

            {/* Chart area */}
            <div className="absolute inset-4 left-8 right-2 bottom-6">
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
                    strokeWidth="0.5" 
                  />
                ))}

                {/* Area fill with gradient */}
                <defs>
                  <linearGradient id="actualGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stopColor="#059669" stopOpacity="0.2" />
                    <stop offset="100%" stopColor="#059669" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <polygon
                  points={areaPath}
                  fill="url(#actualGradient)"
                />

                {/* Forecast line - dashed */}
                <polyline
                  points={forecastPoints}
                  fill="none"
                  stroke="#1e40af"
                  strokeWidth="1"
                  strokeDasharray="3 2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="opacity-70"
                />

                {/* Actual line - solid */}
                <polyline
                  points={actualPoints}
                  fill="none"
                  stroke="#059669"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>

            {/* X-axis labels */}
            <div className="absolute bottom-1 left-8 right-2 flex justify-between text-xs text-muted-foreground">
              <span>00:00</span>
              <span>06:00</span>
              <span>12:00</span>
              <span>18:00</span>
              <span>24:00</span>
            </div>
          </div>
        )}

        {/* Legend */}
        <div className="flex items-center justify-center gap-6 mt-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-0.5 bg-primary border-t border-dashed border-primary"></div>
            <span className="text-xs text-muted-foreground">Forecast</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-8 h-0.5 bg-success"></div>
            <span className="text-xs text-muted-foreground">Actual</span>
          </div>
        </div>

        {/* Stats Summary */}
        <div className="grid grid-cols-3 gap-4 mt-4">
          <div className="bg-muted/30 rounded-lg border border-border p-3">
            <div className="flex items-center gap-2 mb-1">
              <TrendingUp className="w-4 h-4 text-primary" />
              <span className="text-xs text-muted-foreground">Max Forecast</span>
            </div>
            <p className="text-lg font-bold text-foreground">
              {Math.max(...forecast).toFixed(1)} MW
            </p>
          </div>
          <div className="bg-muted/30 rounded-lg border border-border p-3">
            <div className="flex items-center gap-2 mb-1">
              <TrendingDown className="w-4 h-4 text-success" />
              <span className="text-xs text-muted-foreground">Max Actual</span>
            </div>
            <p className="text-lg font-bold text-foreground">
              {Math.max(...actual).toFixed(1)} MW
            </p>
          </div>
          <div className="bg-muted/30 rounded-lg border border-border p-3">
            <div className="flex items-center gap-2 mb-1">
              <TrendingUp className="w-4 h-4 text-chart-3" />
              <span className="text-xs text-muted-foreground">Avg Deviation</span>
            </div>
            <p className="text-lg font-bold text-chart-3">
              {((forecast.reduce((a, b) => a + b, 0) / forecast.length) - (actual.reduce((a, b) => a + b, 0) / actual.length)).toFixed(1)} MW
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
