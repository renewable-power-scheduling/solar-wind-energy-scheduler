import { useMemo, useContext } from 'react';
import { MapPin, Wind, Cloud, Droplets, Thermometer, Eye, Compass } from 'lucide-react';
import { FilterContext } from '@/app/appContexts';
import { api } from '@/services/api';
import { useApi } from '@/hooks/useApi';

export function WeatherView({ filters: propFilters }) {
  // Use centralized filter context
  const contextFilters = useContext(FilterContext);
  const filters = propFilters || contextFilters?.filters || { plant: 'All Plants', state: 'All States' };

  // Fetch plants for coordinates - using useApi hook
  const { data: plantsData } = useApi(
    () => api.plants.getAll({}),
    { immediate: true, initialData: { plants: [], total: 0, stats: {} } }
  );

  const { data: weatherCurrent } = useApi(
    () => api.weather.getCurrent(),
    {
      immediate: true,
      initialData: {
        temperature: 0,
        windSpeed: 0,
        humidity: 0,
        cloudCover: 0,
        pressure: 0,
        visibility: 0,
      },
    }
  );

  // Filter plants based on selected filters
  const filteredPlants = useMemo(() => {
    const baseWind = Number(weatherCurrent?.windSpeed || 0);
    const baseTemp = Number(weatherCurrent?.temperature || 0);
    const baseCloud = Number(weatherCurrent?.cloudCover || 0);
    const irrBase = Math.max(0, Math.round(900 - baseCloud * 5));

    const allPlants = (plantsData?.plants || []).map((plant) => ({
      name: plant.name,
      location: plant.state,
      wind: plant.type === 'Wind' ? `${baseWind.toFixed(1)} m/s` : undefined,
      temp: `${Math.round(baseTemp)}°C`,
      cloud: plant.type === 'Solar' ? `${Math.round(baseCloud)}%` : undefined,
      irr: plant.type === 'Solar' ? `${irrBase} W/m²` : undefined,
      status: plant.status === 'Active' ? 'Optimal' : 'Maintenance',
      type: String(plant.type || '').toLowerCase(),
      lat: plant.latitude || 19.0760,
      lng: plant.longitude || 72.8777,
      location_name: plant.location_name || plant.state,
    }));

    let filtered = allPlants;

    // Filter by plant name if specific plant is selected
    if (filters?.plant && filters.plant !== 'All Plants') {
      filtered = allPlants.filter((p) => p.name === filters.plant);
    }

    // Filter by state if specific state is selected
    if (filters?.state && filters.state !== 'All States') {
      filtered = filtered.filter((p) => p.location === filters.state);
    }

    return filtered;
  }, [filters, plantsData, weatherCurrent]);

  // Get current conditions for the filtered plants
  const currentConditions = useMemo(() => {
    const hasWeather =
      Number.isFinite(Number(weatherCurrent?.windSpeed)) ||
      Number.isFinite(Number(weatherCurrent?.temperature)) ||
      Number.isFinite(Number(weatherCurrent?.cloudCover));

    if (hasWeather) {
      return {
        windSpeed: Number(weatherCurrent?.windSpeed || 0).toFixed(1),
        direction: 225,
        cloudCover: Math.round(Number(weatherCurrent?.cloudCover || 0)),
        temperature: Math.round(Number(weatherCurrent?.temperature || 0)),
        humidity: Math.round(Number(weatherCurrent?.humidity || 0)),
      };
    }

    if (filteredPlants.length === 0) {
      return { windSpeed: 0, direction: 225, cloudCover: 0, temperature: 0, humidity: 0 };
    }

    const windFarms = filteredPlants.filter((p) => p.type === 'wind');
    const solarFarms = filteredPlants.filter((p) => p.type === 'solar');

    const avgWindSpeed = windFarms.length > 0
      ? windFarms.reduce((sum, p) => sum + parseFloat(p.wind || 0), 0) / windFarms.length
      : 0;

    const avgCloudCover = solarFarms.length > 0
      ? solarFarms.reduce((sum, p) => sum + parseInt(p.cloud || 0, 10), 0) / solarFarms.length
      : 0;

    const avgTemp = filteredPlants.reduce((sum, p) => sum + (p.temp ? parseFloat(p.temp) : 0), 0) / filteredPlants.length;

    return {
      windSpeed: avgWindSpeed.toFixed(1),
      direction: 225,
      cloudCover: Math.round(avgCloudCover),
      temperature: Math.round(avgTemp),
      humidity: 0,
    };
  }, [filteredPlants, weatherCurrent]);
// Get map center based on filtered plants or use default
  const mapCenter = useMemo(() => {
    if (filteredPlants.length === 0) {
      return { lat: 19.0760, lng: 72.8777 };
    }
    // Calculate center from filtered plants
    const avgLat = filteredPlants.reduce((sum, p) => sum + (p.lat || 19.0760), 0) / filteredPlants.length;
    const avgLng = filteredPlants.reduce((sum, p) => sum + (p.lng || 72.8777), 0) / filteredPlants.length;
    return { lat: avgLat, lng: avgLng };
  }, [filteredPlants]);

  // Get Windy embed URL - shows 13km x 13km area when specific plant is selected
  const getWindyEmbedUrl = () => {
    const lat = mapCenter.lat;
    const lng = mapCenter.lng;
    // Use zoom=10 (13km x 13km area) when a specific plant is selected
    // Use zoom=6 (larger area) when showing all plants or default view
    const isSpecificPlantSelected = filters?.plant && filters.plant !== 'All Plants';
    const zoomLevel = isSpecificPlantSelected ? 10 : 6;
    return `https://embed.windy.com/embed2.html?lat=${lat}&lon=${lng}&zoom=${zoomLevel}&level=surface&overlay=wind&menu=&message=&marker=&calendar=&pressure=&type=map&location=coordinates&detail=&detailLat=${lat}&detailLon=${lng}&metricWind=default&metricTemp=default&radarRange=-1`;
  };
  
  return (
    <div className="flex-1 overflow-auto bg-background relative overflow-x-hidden">
      <div className="w-full p-4 sm:p-6 space-y-6 max-w-[1600px] mx-auto">
        {/* Header */}
        <div>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-foreground">
                Weather Reference (Windy)
              </h1>
              <p className="text-xs sm:text-sm text-muted-foreground mt-1 flex items-center gap-2">
                <MapPin className="w-4 h-4" />
                Interactive weather map and wind patterns
                {filters?.plant && filters.plant !== 'All Plants' && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-primary/10 text-primary ml-2">
                    Showing: {filters.plant}
                  </span>
                )}
              </p>
            </div>
            <div className="flex gap-2">
              <div className="w-full sm:w-auto px-4 py-2 rounded bg-success text-white shadow-sm text-center">
                <span className="text-sm font-semibold">Live Radar</span>
              </div>
            </div>
          </div>
        </div>

        {/* Current Conditions */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 sm:gap-6">
          <div className="bg-card rounded-lg border border-border p-4 sm:p-6 shadow-sm hover:shadow-md transition-all">
            <div className="p-2 bg-primary/10 rounded w-fit mb-3">
              <Wind className="w-6 h-6 text-primary" />
            </div>
            <p className="text-xs font-medium text-muted-foreground mb-1">Wind Speed</p>
            <p className="text-2xl font-bold text-foreground">{currentConditions.windSpeed}</p>
            <p className="text-sm text-muted-foreground">m/s</p>
          </div>

          <div className="bg-card rounded-lg border border-border p-4 sm:p-6 shadow-sm hover:shadow-md transition-all">
            <div className="p-2 bg-secondary/10 rounded w-fit mb-3">
              <Compass className="w-6 h-6 text-secondary" />
            </div>
            <p className="text-xs font-medium text-muted-foreground mb-1">Direction</p>
            <p className="text-2xl font-bold text-foreground">{currentConditions.direction}°</p>
            <p className="text-sm text-muted-foreground">SW</p>
          </div>

          <div className="bg-card rounded-lg border border-border p-4 sm:p-6 shadow-sm hover:shadow-md transition-all">
            <div className="p-2 bg-secondary/10 rounded w-fit mb-3">
              <Cloud className="w-6 h-6 text-secondary" />
            </div>
            <p className="text-xs font-medium text-muted-foreground mb-1">Cloud Cover</p>
            <p className="text-2xl font-bold text-foreground">{currentConditions.cloudCover}</p>
            <p className="text-sm text-muted-foreground">%</p>
          </div>

          <div className="bg-card rounded-lg border border-border p-4 sm:p-6 shadow-sm hover:shadow-md transition-all">
            <div className="p-2 bg-warning/10 rounded w-fit mb-3">
              <Thermometer className="w-6 h-6 text-warning" />
            </div>
            <p className="text-xs font-medium text-muted-foreground mb-1">Temperature</p>
            <p className="text-2xl font-bold text-foreground">{currentConditions.temperature}</p>
            <p className="text-sm text-muted-foreground">°C</p>
          </div>

          <div className="bg-card rounded-lg border border-border p-4 sm:p-6 shadow-sm hover:shadow-md transition-all">
            <div className="p-2 bg-success/10 rounded w-fit mb-3">
              <Droplets className="w-6 h-6 text-success" />
            </div>
            <p className="text-xs font-medium text-muted-foreground mb-1">Humidity</p>
            <p className="text-2xl font-bold text-foreground">{currentConditions.humidity}</p>
            <p className="text-sm text-muted-foreground">%</p>
          </div>
        </div>

        {/* Interactive Map */}
        <div className="bg-card rounded-lg border border-border shadow-sm overflow-hidden">
          <div className="p-4 sm:p-6 border-b border-border bg-muted/30">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-foreground">Interactive Weather Map</h3>
                <p className="text-xs sm:text-sm text-muted-foreground mt-1">
                  {filters?.plant && filters.plant !== 'All Plants' 
                    ? `Real-time weather for ${filters.plant}`
                    : 'Real-time wind and weather visualization for all plant locations'}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="px-3 py-1.5 text-xs sm:text-sm rounded bg-primary text-primary-foreground">
                  Wind
                </button>
                <button className="px-3 py-1.5 text-xs sm:text-sm rounded border border-border hover:bg-accent transition-all">
                  Rain
                </button>
                <button className="px-3 py-1.5 text-xs sm:text-sm rounded border border-border hover:bg-accent transition-all">
                  Clouds
                </button>
                <button className="px-3 py-1.5 text-xs sm:text-sm rounded border border-border hover:bg-accent transition-all">
                  Temperature
                </button>
              </div>
            </div>
          </div>
          
          <div className="relative h-[360px] sm:h-[600px] bg-muted/20">
            {/* Interactive Windy Map - Shows actual weather map */}
            {filteredPlants.length > 0 ? (
              <iframe
                src={getWindyEmbedUrl()}
                width="100%"
                height="100%"
                frameBorder="0"
                title="Windy Weather Map"
                className="border-0"
              />
            ) : (
              /* Fallback when no plants */
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="text-center p-8">
                  <MapPin className="w-20 h-20 text-primary mx-auto mb-6" />
                  <h3 className="text-xl font-bold text-foreground mb-2">
                    Weather Map Visualization
                  </h3>
                  <p className="text-muted-foreground max-w-md mb-8">
                    Select a plant or state to view weather at that location.
                  </p>
                </div>
              </div>
            )}

            {/* Map Controls */}
            <div className="absolute top-4 right-4 space-y-2">
              <button className="w-10 h-10 rounded bg-card border border-border shadow-sm hover:bg-accent transition-all flex items-center justify-center">
                <span className="text-xl">+</span>
              </button>
              <button className="w-10 h-10 rounded bg-card border border-border shadow-sm hover:bg-accent transition-all flex items-center justify-center">
                <span className="text-xl">-</span>
              </button>
            </div>

            {/* Plant Location Cards Overlay */}
            <div className="absolute bottom-4 left-4 space-y-2 max-w-[70vw] sm:max-w-xs">
              {filteredPlants.slice(0, 3).map(plant => (
                <div key={plant.name} className="bg-card/90 backdrop-blur rounded-lg border border-border shadow-sm p-3 animate-in slide-in-from-bottom-2">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${plant.type === 'wind' ? 'bg-primary' : 'bg-warning'} animate-pulse`}></div>
                    <div>
                      <p className="text-xs font-semibold text-foreground">{plant.name}</p>
                      <p className="text-[10px] text-muted-foreground">{plant.location_name || plant.location}</p>
                    </div>
                  </div>
                  <div className="mt-1 flex gap-2 text-[10px]">
                    <span className="text-muted-foreground">Lat: {plant.lat?.toFixed(2)}</span>
                    <span className="text-muted-foreground">Lng: {plant.lng?.toFixed(2)}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Legend */}
            <div className="absolute bottom-4 right-4 bg-card rounded-lg border border-border shadow-sm p-4">
              <p className="text-xs font-semibold text-foreground mb-2">Wind Speed (m/s)</p>
              <div className="flex items-center gap-2">
                <div className="flex gap-0.5">
                  {['#3b82f6', '#60a5fa', '#93c5fd', '#dbeafe'].map((color, i) => (
                    <div key={i} className="w-6 h-3 rounded" style={{ backgroundColor: color }}></div>
                  ))}
                </div>
                <div className="flex justify-between text-[10px] text-muted-foreground w-20">
                  <span>0</span>
                  <span>10</span>
                  <span>15+</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Location-wise Weather - Filtered */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
          {/* Wind Farms Weather */}
          <div className="bg-card rounded-lg border border-border shadow-sm p-4 sm:p-6">
            <div className="flex items-center justify-between mb-4 sm:mb-6">
              <div>
                <h3 className="text-base font-semibold text-foreground">Wind Farms Weather</h3>
                <p className="text-xs sm:text-sm text-muted-foreground mt-1">
                  {filters?.plant && filters.plant !== 'All Plants' 
                    ? 'Current conditions' 
                    : 'Showing all wind farms'}
                </p>
              </div>
              <div className="p-2 bg-primary/10 rounded">
                <Wind className="w-6 h-6 text-primary" />
              </div>
            </div>
            
            <div className="space-y-4">
              {filteredPlants
                .filter(p => p.type === 'wind')
                .map(farm => (
                <div key={farm.name} className="p-4 bg-muted/30 rounded-lg border border-border hover:border-primary/30 transition-all">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div>
                      <p className="font-semibold text-foreground">{farm.name}</p>
                      <p className="text-xs sm:text-sm text-muted-foreground">{farm.location}</p>
                    </div>
                    <div className="text-left sm:text-right">
                      <p className="text-base font-bold text-primary">{farm.wind}</p>
                      <p className="text-xs sm:text-sm text-muted-foreground">{farm.temp}</p>
                    </div>
                  </div>
                    <div className="mt-2">
                      <span className={`inline-flex items-center px-2.5 py-1 rounded text-xs font-medium ${
                        farm.status === 'Excellent' ? 'bg-success/10 text-success' : 
                        farm.status === 'Optimal' ? 'bg-primary/10 text-primary' : 
                        'bg-muted text-muted-foreground'
                      }`}>
                        {farm.status} Conditions
                      </span>
                    </div>
                  </div>
                ))}
              {filteredPlants.filter(p => p.type === 'wind').length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">No wind farms match the current filters</p>
              )}
            </div>
          </div>

          {/* Solar Plants Weather */}
          <div className="bg-card rounded-lg border border-border shadow-sm p-4 sm:p-6">
            <div className="flex items-center justify-between mb-4 sm:mb-6">
              <div>
                <h3 className="text-base font-semibold text-foreground">Solar Plants Weather</h3>
                <p className="text-xs sm:text-sm text-muted-foreground mt-1">
                  {filters?.plant && filters.plant !== 'All Plants' 
                    ? 'Current conditions' 
                    : 'Showing all solar plants'}
                </p>
              </div>
              <div className="p-2 bg-warning/10 rounded">
                <Cloud className="w-6 h-6 text-warning" />
              </div>
            </div>
            
            <div className="space-y-4">
              {filteredPlants
                .filter(p => p.type === 'solar')
                .map(plant => (
                <div key={plant.name} className="p-4 bg-muted/30 rounded-lg border border-border hover:border-warning/30 transition-all">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div>
                      <p className="font-semibold text-foreground">{plant.name}</p>
                      <p className="text-xs sm:text-sm text-muted-foreground">{plant.location}</p>
                    </div>
                    <div className="text-left sm:text-right">
                      <p className="text-base font-bold text-warning">{plant.irr}</p>
                      <p className="text-xs sm:text-sm text-muted-foreground">{plant.cloud} clouds</p>
                    </div>
                  </div>
                    <div className="mt-2">
                      <span className={`inline-flex items-center px-2.5 py-1 rounded text-xs font-medium ${
                        plant.status === 'Excellent' ? 'bg-success/10 text-success' : 
                        plant.status === 'Optimal' ? 'bg-warning/10 text-warning' : 
                        'bg-muted text-muted-foreground'
                      }`}>
                        {plant.status} Conditions
                      </span>
                    </div>
                  </div>
                ))}
              {filteredPlants.filter(p => p.type === 'solar').length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">No solar plants match the current filters</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}





