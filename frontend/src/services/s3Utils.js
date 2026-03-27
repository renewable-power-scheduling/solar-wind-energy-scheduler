import { S3_BASE_URL } from '@/config/appConfig';

export function parseS3ListXml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  return Array.from(doc.getElementsByTagName('Contents'))
    .map((node) => ({
      key: node.getElementsByTagName('Key')[0]?.textContent || '',
      lastModified: node.getElementsByTagName('LastModified')[0]?.textContent || '',
    }))
    .filter((item) => item.key);
}

export function getS3ObjectUrl(key, baseUrl = S3_BASE_URL) {
  const encodedKey = String(key || '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${baseUrl}/${encodedKey}`;
}

export async function listS3Objects(prefix, baseUrl = S3_BASE_URL) {
  const url = `${baseUrl}/?list-type=2&prefix=${encodeURIComponent(prefix)}`;
  const xml = await fetch(url).then((r) => r.text());
  return parseS3ListXml(xml);
}

export async function listS3ObjectsAcrossPrefixes(prefixes, baseUrl = S3_BASE_URL) {
  const settled = await Promise.allSettled(prefixes.map((prefix) => listS3Objects(prefix, baseUrl)));
  return settled
    .filter((result) => result.status === 'fulfilled')
    .flatMap((result) => result.value || []);
}

export function mergeUniqueS3Objects(objectSets) {
  return Array.from(new Map(objectSets.flat().map((obj) => [obj.key, obj])).values());
}

export async function fetchTextFromS3(key, baseUrl = S3_BASE_URL) {
  return fetch(getS3ObjectUrl(key, baseUrl)).then((r) => r.text());
}

export async function fetchCsvFromS3(key, baseUrl = S3_BASE_URL) {
  const url = getS3ObjectUrl(key, baseUrl);
  const text = await fetch(url).then((r) => r.text());
  return { url, text };
}

export function parseSimpleCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = lines[0].split(',').map((h) => h.trim());
  const rows = lines.slice(1).map((line) => line.split(',').map((value) => value.trim()));
  return { headers, rows };
}

export function extractTrailingNumber(key) {
  const fileName = (key || '').split('/').pop() || '';
  const scheduleMatch = fileName.match(/schedule_from_(\d+)\.csv$/i);
  if (scheduleMatch) return parseInt(scheduleMatch[1], 10);
  const trailingMatch = fileName.match(/_(\d+)(?=\.[^.]+$)/);
  return trailingMatch ? parseInt(trailingMatch[1], 10) : null;
}

function compareNewestObjects(a, b, options = {}) {
  const { preferGenerated = false } = options;
  const aRev = extractTrailingNumber(a.key);
  const bRev = extractTrailingNumber(b.key);
  if (aRev !== null && bRev !== null && bRev !== aRev) return bRev - aRev;

  const aTime = Date.parse(a.lastModified || '');
  const bTime = Date.parse(b.lastModified || '');
  const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
  if (timeDiff !== 0) return timeDiff;

  if (preferGenerated) {
    const aGenerated = String(a.key || '').toLowerCase().includes('/generated/');
    const bGenerated = String(b.key || '').toLowerCase().includes('/generated/');
    if (aGenerated !== bGenerated) return bGenerated ? 1 : -1;
  }

  return String(b.key || '').localeCompare(String(a.key || ''));
}

export function sortS3ObjectsNewestFirst(items, options = {}) {
  return [...items].sort((a, b) => compareNewestObjects(a, b, options));
}

export function getLatestS3Object(objects, matcher, options = {}) {
  return sortS3ObjectsNewestFirst(objects.filter((obj) => matcher(obj.key)), options)[0] || null;
}
