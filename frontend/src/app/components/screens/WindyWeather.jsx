import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Cloud,
  CloudRain,
  Download,
  Droplets,
  Loader2,
  MapPin,
  Navigation,
  RefreshCw,
  Thermometer,
  Wind,
} from 'lucide-react';
import { WINDY_MAP_API_KEY, WINDY_POINT_FORECAST_API_KEY } from '@/config/appConfig';
import { api } from '@/services/api';
import { useApi } from '@/hooks/useApi';
import { buildWindyForecastCsv, fetchWindyPointForecast } from '@/services/windyWeatherService';

const WINDY_CONTAINER_ID = 'windy';
const DEFAULT_ZOOM = 10;

const LAYER_OPTIONS = [
  { id: 'wind', label: 'Wind', icon: Wind },
  { id: 'rain', label: 'Rain', icon: CloudRain },
  { id: 'clouds', label: 'Clouds', icon: Cloud },
  { id: 'temp', label: 'Temperature', icon: Thermometer },
];

const loadStylesheet = (href) =>
  new Promise((resolve, reject) => {
    const existing = document.querySelector(`link[href="${href}"]`);
    if (existing) {
      resolve();
      return;
    }

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = () => resolve();
    link.onerror = () => reject(new Error(`Failed to load ${href}`));
    document.head.appendChild(link);
  });

const loadScript = (src, globalCheck) =>
  new Promise((resolve, reject) => {
    if (globalCheck?.()) {
      resolve();
      return;
    }

    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });

const hasValidCoordinates = (plant) => {
  const lat = Number(plant?.latitude);
  const lon = Number(plant?.longitude);
  return Number.isFinite(lat) && Number.isFinite(lon);
};

const toWindyPlant = (plant) => ({
  ...plant,
  lat: Number(plant.latitude),
  lon: Number(plant.longitude),
});

const formatCoordinate = (value) =>
  Number.isFinite(Number(value)) ? Number(value).toFixed(5) : 'Not set';

const formatMetric = (value, suffix = '') =>
  Number.isFinite(Number(value)) ? `${value}${suffix}` : '-';

const refreshWindyMapSize = (windyAPI) => {
  window.setTimeout(() => {
    try {
      windyAPI?.map?.invalidateSize?.();
    } catch {
      // Windy/Leaflet can be mid-render while layers load; ignore transient sizing errors.
    }
  }, 150);
};

function MetricCard({ label, value, unit, icon: Icon }) {
  return (
    <div className="bg-card rounded-lg border border-border p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <p className="mt-2 text-2xl font-bold text-foreground">
            {value}
            {unit && <span className="ml-1 text-sm font-medium text-muted-foreground">{unit}</span>}
          </p>
        </div>
        <div className="p-2 rounded-md bg-primary/10">
          <Icon className="w-5 h-5 text-primary" />
        </div>
      </div>
    </div>
  );
}

function WindyMap({ plant, layer }) {
  const windyApiRef = useRef(null);
  const markerRef = useRef(null);
  const mapHostRef = useRef(null);
  const fallbackTimerRef = useRef(null);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [showEmbedFallback, setShowEmbedFallback] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const initializeWindy = async () => {
      if (!plant || !WINDY_MAP_API_KEY) return;
      setStatus('loading');
      setError('');
      setShowEmbedFallback(false);

      try {
        await loadStylesheet('https://unpkg.com/leaflet@1.4.0/dist/leaflet.css');
        await loadScript('https://unpkg.com/leaflet@1.4.0/dist/leaflet.js', () => Boolean(window.L));
        await loadScript('https://api.windy.com/assets/map-forecast/libBoot.js', () => Boolean(window.windyInit));

        if (cancelled) return;

        if (windyApiRef.current) {
          refreshWindyMapSize(windyApiRef.current);
          setStatus('ready');
          return;
        }

        const options = {
          key: WINDY_MAP_API_KEY,
          lat: plant.lat,
          lon: plant.lon,
          zoom: DEFAULT_ZOOM,
          overlay: layer,
        };

        // Windy exposes a global initializer. Keep the API object in a ref so
        // React state changes can recenter the Leaflet map without reloading it.
        window.windyInit(options, (windyAPI) => {
          if (cancelled) return;
          windyApiRef.current = windyAPI;
          windyAPI.store.set('overlay', layer);
          windyAPI.map.setView([plant.lat, plant.lon], DEFAULT_ZOOM);
          refreshWindyMapSize(windyAPI);
          setStatus('ready');
          window.clearTimeout(fallbackTimerRef.current);
          fallbackTimerRef.current = window.setTimeout(() => {
            setShowEmbedFallback(true);
          }, 3500);
        });
      } catch (err) {
        if (!cancelled) {
          setStatus('error');
          setError(err?.message || 'Unable to load Windy map.');
        }
      }
    };

    initializeWindy();

    return () => {
      cancelled = true;
      window.clearTimeout(fallbackTimerRef.current);
    };
  }, [plant, layer]);

  useEffect(() => {
    const windyAPI = windyApiRef.current;
    if (!windyAPI || !plant) return;

    windyAPI.map.setView([plant.lat, plant.lon], DEFAULT_ZOOM);
    refreshWindyMapSize(windyAPI);

    if (window.L) {
      if (!markerRef.current) {
        markerRef.current = window.L.marker([plant.lat, plant.lon]).addTo(windyAPI.map);
      } else {
        markerRef.current.setLatLng([plant.lat, plant.lon]);
      }
      markerRef.current.bindPopup(plant.name || 'Selected plant');
    }
  }, [plant]);

  useEffect(() => {
    const windyAPI = windyApiRef.current;
    if (!windyAPI || !layer) return;
    setShowEmbedFallback(false);
    windyAPI.store.set('overlay', layer);
    refreshWindyMapSize(windyAPI);
  }, [layer]);

  const embedUrl = useMemo(() => {
    const overlay = layer === 'temp' ? 'temp' : layer;
    return `https://embed.windy.com/embed2.html?lat=${plant.lat}&lon=${plant.lon}&zoom=${DEFAULT_ZOOM}&level=surface&overlay=${overlay}&menu=&message=&marker=true&calendar=&pressure=&type=map&location=coordinates&detail=&detailLat=${plant.lat}&detailLon=${plant.lon}&metricWind=default&metricTemp=default&radarRange=-1`;
  }, [plant, layer]);

  if (!WINDY_MAP_API_KEY) {
    return (
      <div className="h-[600px] bg-muted/30 border border-dashed border-border rounded-lg flex items-center justify-center p-6">
        <div className="max-w-md text-center">
          <AlertCircle className="w-10 h-10 mx-auto text-warning mb-3" />
          <h3 className="text-base font-semibold text-foreground">Windy map is not configured</h3>
          <p className="text-sm text-muted-foreground mt-2">
            Add `VITE_WINDY_MAP_API_KEY` to the frontend environment and rebuild the app.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-[600px] bg-muted/20 rounded-lg overflow-hidden border border-border">
      <div id={WINDY_CONTAINER_ID} ref={mapHostRef} className="absolute inset-0" />
      {showEmbedFallback && (
        <iframe
          key={`${plant.id || plant.name}-${layer}`}
          src={embedUrl}
          title={`Windy map for ${plant.name || 'selected plant'}`}
          width="100%"
          height="100%"
          className="absolute inset-0 border-0 bg-background"
        />
      )}
      {status === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80">
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin text-primary" />
            Loading Windy map...
          </div>
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/90 p-6">
          <div className="max-w-md text-center">
            <AlertCircle className="w-10 h-10 mx-auto text-destructive mb-3" />
            <h3 className="text-base font-semibold text-foreground">Unable to load Windy map</h3>
            <p className="text-sm text-muted-foreground mt-2">{error}</p>
          </div>
        </div>
      )}
    </div>
  );
}

export function WindyWeather() {
  const [selectedPlantId, setSelectedPlantId] = useState('');
  const [selectedLayer, setSelectedLayer] = useState('wind');
  const [forecast, setForecast] = useState(null);
  const [forecastLoading, setForecastLoading] = useState(false);
  const [forecastError, setForecastError] = useState('');

  const {
    data: plantsData,
    loading,
    error,
  } = useApi(
    () => api.plants.getAll({ noMock: true }),
    { immediate: true, initialData: { plants: [], total: 0, stats: {} } }
  );

  const plantsWithCoordinates = useMemo(() => {
    return (plantsData?.plants || [])
      .filter(hasValidCoordinates)
      .map(toWindyPlant)
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  }, [plantsData]);

  const selectedPlant = useMemo(() => {
    if (!plantsWithCoordinates.length) return null;
    return (
      plantsWithCoordinates.find((plant) => String(plant.id) === String(selectedPlantId)) ||
      plantsWithCoordinates[0]
    );
  }, [plantsWithCoordinates, selectedPlantId]);

  useEffect(() => {
    if (selectedPlantId || !plantsWithCoordinates.length) return;
    setSelectedPlantId(String(plantsWithCoordinates[0].id));
  }, [plantsWithCoordinates, selectedPlantId]);

  const selectedLayerMeta = LAYER_OPTIONS.find((item) => item.id === selectedLayer) || LAYER_OPTIONS[0];
  const SelectedLayerIcon = selectedLayerMeta.icon;

  const loadForecast = async () => {
    if (!selectedPlant) return;
    setForecastLoading(true);
    setForecastError('');
    try {
      const result = await fetchWindyPointForecast({
        lat: selectedPlant.lat,
        lon: selectedPlant.lon,
      });
      setForecast(result);
    } catch (err) {
      setForecast(null);
      setForecastError(err?.message || 'Unable to load Windy point forecast.');
    } finally {
      setForecastLoading(false);
    }
  };

  useEffect(() => {
    if (!selectedPlant) return;
    loadForecast();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPlant?.id]);

  const handleExport = () => {
    if (!selectedPlant || !forecast?.daily?.length) return;
    const csv = buildWindyForecastCsv({ plant: selectedPlant, forecast });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const plantName = String(selectedPlant.name || 'plant').replace(/[^a-z0-9_-]+/gi, '-');
    link.href = url;
    link.download = `${plantName}-windy-forecast.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const current = forecast?.current;

  return (
    <div className="flex-1 overflow-auto bg-background relative overflow-x-hidden">
      <div className="w-full p-4 sm:p-6 space-y-6 max-w-[1600px] mx-auto">
        <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-foreground">Windy Weather</h1>
            <p className="text-xs sm:text-sm text-muted-foreground mt-1 flex items-center gap-2">
              <MapPin className="w-4 h-4" />
              Plant-centered Windy map for operational weather checks
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Plant</span>
              <select
                value={selectedPlant?.id || ''}
                onChange={(event) => setSelectedPlantId(event.target.value)}
                disabled={loading || plantsWithCoordinates.length === 0}
                className="h-10 min-w-[240px] rounded-md border border-border bg-card px-3 text-sm text-foreground shadow-sm outline-none focus:border-primary"
              >
                {plantsWithCoordinates.map((plant) => (
                  <option key={plant.id} value={plant.id}>
                    {plant.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Layer</span>
              <select
                value={selectedLayer}
                onChange={(event) => setSelectedLayer(event.target.value)}
                className="h-10 min-w-[180px] rounded-md border border-border bg-card px-3 text-sm text-foreground shadow-sm outline-none focus:border-primary"
              >
                {LAYER_OPTIONS.map((layer) => (
                  <option key={layer.id} value={layer.id}>
                    {layer.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
            {error.message || 'Unable to load plants.'}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-6 gap-4">
          <MetricCard
            label="Temperature"
            value={formatMetric(current?.temperature)}
            unit="°C"
            icon={Thermometer}
          />
          <MetricCard
            label="Humidity"
            value={formatMetric(current?.humidity)}
            unit="%"
            icon={Droplets}
          />
          <MetricCard
            label="Wind Speed"
            value={formatMetric(current?.windSpeed)}
            unit="m/s"
            icon={Wind}
          />
          <MetricCard
            label="Wind Direction"
            value={current?.windDirectionLabel || '-'}
            unit={Number.isFinite(Number(current?.windDirection)) ? `${current.windDirection}°` : ''}
            icon={Navigation}
          />
          <MetricCard
            label="Rain"
            value={formatMetric(current?.rainAmount)}
            unit="mm/3h"
            icon={CloudRain}
          />
          <MetricCard
            label="Cloud Cover"
            value={formatMetric(current?.cloudCover)}
            unit="%"
            icon={Cloud}
          />
        </div>

        <div className="bg-card rounded-lg border border-border shadow-sm p-4 sm:p-5">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-foreground">Windy Point Forecast</h2>
              <p className="text-xs sm:text-sm text-muted-foreground mt-1">
                7-day plant forecast from Windy Point Forecast API
                {forecast?.model ? ` using ${forecast.model.toUpperCase()} model` : ''}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={loadForecast}
                disabled={!selectedPlant || forecastLoading}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-background text-sm text-foreground hover:bg-accent disabled:opacity-60"
              >
                <RefreshCw className={`w-4 h-4 ${forecastLoading ? 'animate-spin' : ''}`} />
                Refresh
              </button>
              <button
                type="button"
                onClick={handleExport}
                disabled={!forecast?.daily?.length}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-primary text-primary-foreground text-sm hover:bg-primary/90 disabled:opacity-60"
              >
                <Download className="w-4 h-4" />
                Export CSV
              </button>
            </div>
          </div>

          {!WINDY_POINT_FORECAST_API_KEY && (
            <div className="mt-4 rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
              Add `VITE_WINDY_POINT_FORECAST_API_KEY` to enable weather cards, table, and export.
            </div>
          )}

          {forecastError && WINDY_POINT_FORECAST_API_KEY && (
            <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
              {forecastError}
            </div>
          )}

          <div className="mt-4 overflow-x-auto">
            <table className="min-w-[760px] w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-3 pr-4 font-semibold">Date</th>
                  <th className="py-3 pr-4 font-semibold">Temp</th>
                  <th className="py-3 pr-4 font-semibold">Humidity</th>
                  <th className="py-3 pr-4 font-semibold">Wind</th>
                  <th className="py-3 pr-4 font-semibold">Direction</th>
                  <th className="py-3 pr-4 font-semibold">Rain</th>
                  <th className="py-3 pr-4 font-semibold">Clouds</th>
                </tr>
              </thead>
              <tbody>
                {forecastLoading ? (
                  <tr>
                    <td colSpan="7" className="py-8 text-center text-muted-foreground">
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin text-primary" />
                        Loading Windy forecast...
                      </span>
                    </td>
                  </tr>
                ) : forecast?.daily?.length ? (
                  forecast.daily.map((row) => (
                    <tr key={row.date} className="border-b border-border/70 last:border-0">
                      <td className="py-3 pr-4 font-medium text-foreground">{row.date}</td>
                      <td className="py-3 pr-4 text-muted-foreground">
                        {formatMetric(row.minTemp, '°')} / {formatMetric(row.maxTemp, '°')}
                      </td>
                      <td className="py-3 pr-4 text-muted-foreground">{formatMetric(row.avgHumidity, '%')}</td>
                      <td className="py-3 pr-4 text-muted-foreground">{formatMetric(row.avgWindSpeed, ' m/s')}</td>
                      <td className="py-3 pr-4 text-muted-foreground">
                        {row.windDirectionLabel}
                        {Number.isFinite(Number(row.windDirection)) ? ` (${row.windDirection}°)` : ''}
                      </td>
                      <td className="py-3 pr-4 text-muted-foreground">{formatMetric(row.rainAmount, ' mm')}</td>
                      <td className="py-3 pr-4 text-muted-foreground">{formatMetric(row.avgCloudCover, '%')}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan="7" className="py-8 text-center text-muted-foreground">
                      Forecast data will appear after the Point Forecast API is configured.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_280px] gap-4">
          <div className="bg-card rounded-lg border border-border shadow-sm overflow-hidden">
            <div className="p-4 sm:p-5 border-b border-border bg-muted/30">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-foreground">Interactive Windy Map</h2>
                  <p className="text-xs sm:text-sm text-muted-foreground mt-1">
                    {selectedPlant
                      ? `Centered on ${selectedPlant.name} at ${formatCoordinate(selectedPlant.lat)}, ${formatCoordinate(selectedPlant.lon)}`
                      : 'Select a plant with coordinates to display the map.'}
                  </p>
                </div>
                <div className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground w-fit">
                  <SelectedLayerIcon className="w-4 h-4 text-primary" />
                  {selectedLayerMeta.label}
                </div>
              </div>
              <div className="flex flex-wrap gap-2 mt-4">
                {LAYER_OPTIONS.map((layer) => {
                  const Icon = layer.icon;
                  const active = selectedLayer === layer.id;
                  return (
                    <button
                      key={layer.id}
                      type="button"
                      onClick={() => setSelectedLayer(layer.id)}
                      className={`inline-flex items-center gap-2 px-3 py-2 rounded-md text-sm border transition-colors ${
                        active
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-background text-muted-foreground border-border hover:bg-accent hover:text-foreground'
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                      {layer.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="p-3 sm:p-4">
              {loading ? (
                <div className="h-[600px] rounded-lg border border-border bg-muted/20 flex items-center justify-center">
                  <div className="flex items-center gap-3 text-sm text-muted-foreground">
                    <Loader2 className="w-5 h-5 animate-spin text-primary" />
                    Loading plants...
                  </div>
                </div>
              ) : selectedPlant ? (
                <WindyMap plant={selectedPlant} layer={selectedLayer} />
              ) : (
                <div className="h-[600px] rounded-lg border border-dashed border-border bg-muted/20 flex items-center justify-center p-6">
                  <div className="max-w-md text-center">
                    <MapPin className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
                    <h3 className="text-base font-semibold text-foreground">No plant coordinates available</h3>
                    <p className="text-sm text-muted-foreground mt-2">
                      Add latitude and longitude to plant records to view them on Windy.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

          <aside className="bg-card rounded-lg border border-border shadow-sm p-4 sm:p-5 h-fit">
            <h2 className="text-base font-semibold text-foreground">Selected Plant</h2>
            {selectedPlant ? (
              <div className="mt-4 space-y-4">
                <div>
                  <p className="text-lg font-bold text-foreground">{selectedPlant.name}</p>
                  <p className="text-sm text-muted-foreground">{selectedPlant.location_name || selectedPlant.state || 'Location not set'}</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-md bg-muted/40 border border-border p-3">
                    <p className="text-xs text-muted-foreground">Type</p>
                    <p className="text-sm font-semibold text-foreground">{selectedPlant.type || 'Not set'}</p>
                  </div>
                  <div className="rounded-md bg-muted/40 border border-border p-3">
                    <p className="text-xs text-muted-foreground">Capacity</p>
                    <p className="text-sm font-semibold text-foreground">{selectedPlant.capacity || 0} MW</p>
                  </div>
                  <div className="rounded-md bg-muted/40 border border-border p-3">
                    <p className="text-xs text-muted-foreground">Latitude</p>
                    <p className="text-sm font-semibold text-foreground">{formatCoordinate(selectedPlant.lat)}</p>
                  </div>
                  <div className="rounded-md bg-muted/40 border border-border p-3">
                    <p className="text-xs text-muted-foreground">Longitude</p>
                    <p className="text-sm font-semibold text-foreground">{formatCoordinate(selectedPlant.lon)}</p>
                  </div>
                </div>
                <div className="rounded-md bg-primary/10 border border-primary/20 p-3">
                  <div className="flex items-start gap-2">
                    <Navigation className="w-4 h-4 text-primary mt-0.5" />
                    <p className="text-xs text-primary">
                      Changing the plant recenters the map automatically. Changing the layer keeps the same plant location.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">
                Plant details appear after a plant with coordinates is available.
              </p>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
