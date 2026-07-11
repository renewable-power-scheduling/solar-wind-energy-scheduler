const env = import.meta.env || {};

const normalizeApiBase = (value) => {
  const raw = String(value || '').trim();
  if (!raw) {
    // Dev convenience: when frontend runs on localhost but backend runs on a different port
    // (commonly `3001`), default there to avoid confusing 500s from hitting the wrong origin.
    try {
      if (env.DEV && typeof window !== 'undefined') {
        const host = window.location?.hostname || '';
        if (host === 'localhost' || host === '127.0.0.1') {
          return 'http://localhost:3001/api';
        }
      }
    } catch {
      // ignore
    }
    return '/api';
  }
  return raw.replace(/\/+$/, '');
};

const normalizeOptionalUrl = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.replace(/\/+$/, '');
};

export const API_BASE_URL = normalizeApiBase(env.VITE_API_BASE_URL);
export const API_ORIGIN = API_BASE_URL.startsWith('http')
  ? API_BASE_URL.replace(/\/api$/i, '')
  : '';
// Manual changes endpoint used by Schedule Preparation "Submit Changes".
// If not explicitly configured, fall back to the backend's local endpoint.
export const MANUAL_CHANGES_API_URL = normalizeOptionalUrl(
  env.VITE_MANUAL_CHANGES_API_URL || `${API_ORIGIN || ''}/api/manual-changes`
);
export const MANUAL_CHANGES_API_KEY = String(env.VITE_MANUAL_CHANGES_API_KEY || '').trim();
export const MANUAL_CHANGES_AUTHORIZATION = String(env.VITE_MANUAL_CHANGES_AUTHORIZATION || '').trim();

export const S3_BUCKET = env.VITE_S3_BUCKET || 'vedanjay-schedules1';
export const S3_REGION = env.VITE_S3_REGION || 'ap-south-1';
export const S3_BASE_URL =
  env.VITE_S3_BASE_URL || `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com`;

export const WINDY_MAP_API_KEY = String(env.VITE_WINDY_MAP_API_KEY || '').trim();
export const WINDY_POINT_FORECAST_API_KEY = String(env.VITE_WINDY_POINT_FORECAST_API_KEY || '').trim();
export const WINDY_POINT_FORECAST_URL =
  normalizeOptionalUrl(env.VITE_WINDY_POINT_FORECAST_URL) || 'https://api.windy.com/api/point-forecast/v2';
export const WINDY_FORECAST_MODEL = String(env.VITE_WINDY_FORECAST_MODEL || 'gfs').trim();

// UI/behavior flags (build-time)
const IS_PROD = Boolean(env.PROD);
const hideMetaFallback = IS_PROD ? 'true' : '';
const disableS3MetaFallback = IS_PROD ? 'true' : '';

export const HIDE_METADATA = String(env.VITE_HIDE_METADATA ?? hideMetaFallback).toLowerCase() === 'true';
export const DISABLE_S3_META = String(env.VITE_DISABLE_S3_META ?? disableS3MetaFallback).toLowerCase() === 'true';
