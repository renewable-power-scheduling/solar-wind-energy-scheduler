const env = import.meta.env || {};

const normalizeApiBase = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '/api';
  return raw.replace(/\/+$/, '');
};

export const API_BASE_URL = normalizeApiBase(env.VITE_API_BASE_URL);
export const API_ORIGIN = API_BASE_URL.startsWith('http')
  ? API_BASE_URL.replace(/\/api$/i, '')
  : '';

export const S3_BUCKET = env.VITE_S3_BUCKET || 'vedanjay-solar-prod-989625237479';
export const S3_REGION = env.VITE_S3_REGION || 'ap-south-1';
export const S3_BASE_URL =
  env.VITE_S3_BASE_URL || `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com`;

// UI/behavior flags (build-time)
const IS_PROD = Boolean(env.PROD);
const hideMetaFallback = IS_PROD ? 'true' : '';
const disableS3MetaFallback = IS_PROD ? 'true' : '';

export const HIDE_METADATA = String(env.VITE_HIDE_METADATA ?? hideMetaFallback).toLowerCase() === 'true';
export const DISABLE_S3_META = String(env.VITE_DISABLE_S3_META ?? disableS3MetaFallback).toLowerCase() === 'true';
