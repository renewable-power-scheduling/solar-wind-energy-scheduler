import { API_BASE_URL, API_ORIGIN } from '@/config/appConfig';

const BASE_URL = `${API_BASE_URL}/all-plant-penalty`;

async function parseResponse(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof body?.detail === 'string' ? body.detail : body?.message;
    throw new Error(detail || `Request failed with HTTP ${response.status}`);
  }
  return body;
}

export const resolvePenaltyDownloadUrl = (path) => {
  const value = String(path || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  return `${API_ORIGIN || ''}${value.startsWith('/') ? value : `/${value}`}`;
};

export const allPlantPenaltyApi = {
  uploadVedanjay: async ({ plantCode, scheduleDate, file, uploader }) => {
    const body = new FormData();
    body.append('plant_code', plantCode);
    body.append('schedule_date', scheduleDate);
    body.append('uploader', uploader || 'Unknown');
    body.append('file', file);
    const response = await fetch(`${BASE_URL}/vedanjay-upload`, {
      method: 'POST',
      headers: { 'X-User-Name': uploader || 'Unknown' },
      body,
    });
    return parseResponse(response);
  },

  getDailyResult: async ({ plantCode, scheduleDate, source = 'VEDANJAY' }) => {
    const params = new URLSearchParams({
      plant_code: plantCode,
      schedule_date: scheduleDate,
      source,
    });
    const response = await fetch(`${BASE_URL}/daily-result?${params}`);
    if (response.status === 404) return null;
    return parseResponse(response);
  },

  getActiveVedanjaySchedule: async ({ plantCode, scheduleDate }) => {
    const params = new URLSearchParams({
      plant_code: plantCode,
      schedule_date: scheduleDate,
    });
    const response = await fetch(`${BASE_URL}/active-vedanjay-schedule?${params}`);
    if (response.status === 404) return null;
    return parseResponse(response);
  },

  storeComparisonResults: async (payload) => {
    const response = await fetch(`${BASE_URL}/comparison-results`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return parseResponse(response);
  },

  getReadiness: async ({ startDate, endDate }) => {
    const params = new URLSearchParams({
      start_date: startDate,
      end_date: endDate || startDate,
    });
    const response = await fetch(`${BASE_URL}/readiness?${params}`);
    return parseResponse(response);
  },

  recalculate: async ({ plantCode, scheduleDate, sources = ['VEDANJAY'] }) => {
    const response = await fetch(`${BASE_URL}/recalculate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plant_code: plantCode,
        schedule_date: scheduleDate,
        sources,
      }),
    });
    return parseResponse(response);
  },

  generateReport: async (payload) => {
    const response = await fetch(`${BASE_URL}/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return parseResponse(response);
  },
};
