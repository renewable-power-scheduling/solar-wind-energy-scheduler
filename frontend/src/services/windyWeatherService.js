import {
  WINDY_FORECAST_MODEL,
  WINDY_POINT_FORECAST_API_KEY,
  WINDY_POINT_FORECAST_URL,
} from '@/config/appConfig';

const FORECAST_PARAMETERS = ['temp', 'wind', 'rh', 'precip', 'lclouds', 'mclouds', 'hclouds'];

const valueAt = (data, key, index) => {
  const values = data?.[key];
  if (!Array.isArray(values)) return null;
  const value = values[index];
  return Number.isFinite(Number(value)) ? Number(value) : null;
};

const round = (value, digits = 0) => {
  if (!Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
};

const normalizeTemperature = (value, unit) => {
  if (!Number.isFinite(Number(value))) return null;
  if (String(unit || '').toUpperCase() === 'K' || Number(value) > 170) {
    return Number(value) - 273.15;
  }
  return Number(value);
};

const windFromDirection = (u, v) => {
  if (!Number.isFinite(Number(u)) || !Number.isFinite(Number(v))) return null;
  return (Math.atan2(Number(u), Number(v)) * (180 / Math.PI) + 180 + 360) % 360;
};

const directionLabel = (degrees) => {
  if (!Number.isFinite(Number(degrees))) return '-';
  const labels = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return labels[Math.round(Number(degrees) / 45) % 8];
};

const average = (values) => {
  const valid = values.filter((value) => Number.isFinite(Number(value)));
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + Number(value), 0) / valid.length;
};

const normalizePoint = (data, index) => {
  const units = data?.units || {};
  const temp = normalizeTemperature(valueAt(data, 'temp-surface', index), units['temp-surface']);
  const humidity = valueAt(data, 'rh-surface', index);
  const windU = valueAt(data, 'wind_u-surface', index);
  const windV = valueAt(data, 'wind_v-surface', index);
  const windSpeed = Number.isFinite(windU) && Number.isFinite(windV)
    ? Math.sqrt(windU * windU + windV * windV)
    : null;
  const windDirection = windFromDirection(windU, windV);
  const precip = valueAt(data, 'past3hprecip-surface', index);
  const cloudCover = average([
    valueAt(data, 'lclouds-surface', index),
    valueAt(data, 'mclouds-surface', index),
    valueAt(data, 'hclouds-surface', index),
  ]);

  return {
    timestamp: data.ts[index],
    dateTime: new Date(data.ts[index]),
    temperature: round(temp, 1),
    humidity: round(humidity),
    windSpeed: round(windSpeed, 1),
    windDirection: round(windDirection),
    windDirectionLabel: directionLabel(windDirection),
    rainAmount: round(precip, 2),
    cloudCover: round(cloudCover),
  };
};

const summarizeDaily = (points) => {
  const grouped = new Map();
  points.forEach((point) => {
    const key = point.dateTime.toLocaleDateString('en-CA');
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(point);
  });

  return Array.from(grouped.entries()).slice(0, 7).map(([date, rows]) => {
    const temps = rows.map((row) => row.temperature).filter(Number.isFinite);
    const windSpeeds = rows.map((row) => row.windSpeed).filter(Number.isFinite);
    const rainAmounts = rows.map((row) => row.rainAmount).filter(Number.isFinite);
    const cloudValues = rows.map((row) => row.cloudCover).filter(Number.isFinite);
    const humidityValues = rows.map((row) => row.humidity).filter(Number.isFinite);
    const strongestWind = rows.reduce((best, row) => {
      if (!best) return row;
      return Number(row.windSpeed || 0) > Number(best.windSpeed || 0) ? row : best;
    }, null);

    return {
      date,
      minTemp: temps.length ? round(Math.min(...temps), 1) : null,
      maxTemp: temps.length ? round(Math.max(...temps), 1) : null,
      avgHumidity: round(average(humidityValues)),
      avgWindSpeed: round(average(windSpeeds), 1),
      windDirection: strongestWind?.windDirection ?? null,
      windDirectionLabel: strongestWind?.windDirectionLabel || '-',
      rainAmount: rainAmounts.length ? round(rainAmounts.reduce((sum, value) => sum + value, 0), 2) : null,
      avgCloudCover: round(average(cloudValues)),
    };
  });
};

export async function fetchWindyPointForecast({ lat, lon }) {
  if (!WINDY_POINT_FORECAST_API_KEY) {
    throw new Error('Windy Point Forecast API key is not configured.');
  }

  const response = await fetch(WINDY_POINT_FORECAST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lat,
      lon,
      model: WINDY_FORECAST_MODEL,
      parameters: FORECAST_PARAMETERS,
      levels: ['surface'],
      key: WINDY_POINT_FORECAST_API_KEY,
    }),
  });

  if (!response.ok) {
    throw new Error(`Windy forecast request failed with HTTP ${response.status}.`);
  }

  const raw = await response.json();
  const points = Array.isArray(raw?.ts)
    ? raw.ts.map((_, index) => normalizePoint(raw, index))
    : [];
  const now = Date.now();
  const current = points.find((point) => point.timestamp >= now) || points[0] || null;

  return {
    current,
    daily: summarizeDaily(points),
    points,
    model: WINDY_FORECAST_MODEL,
  };
}

export function buildWindyForecastCsv({ plant, forecast }) {
  const rows = [
    ['Plant', plant?.name || ''],
    ['Latitude', plant?.lat ?? ''],
    ['Longitude', plant?.lon ?? ''],
    ['Model', forecast?.model || ''],
    [],
    ['Date', 'Min Temp C', 'Max Temp C', 'Humidity %', 'Wind m/s', 'Wind Direction', 'Rain mm', 'Cloud %'],
    ...(forecast?.daily || []).map((row) => [
      row.date,
      row.minTemp ?? '',
      row.maxTemp ?? '',
      row.avgHumidity ?? '',
      row.avgWindSpeed ?? '',
      row.windDirectionLabel,
      row.rainAmount ?? '',
      row.avgCloudCover ?? '',
    ]),
  ];

  return rows
    .map((row) =>
      row
        .map((cell) => {
          const text = String(cell ?? '');
          return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        })
        .join(',')
    )
    .join('\n');
}
