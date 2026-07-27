import { API_BASE_URL, S3_BASE_URL } from '@/config/appConfig';
import { filterPrefixesForUser, getCurrentUserFromStorage } from '@/utils/plantAccess';

const S3_LIST_LIMIT = 2000;
const S3_LIST_CONCURRENCY = 4;
const S3_LIST_TIMEOUT_MS = 7000;

async function mapWithConcurrency(items, mapper, concurrency = S3_LIST_CONCURRENCY) {
  const safeItems = Array.isArray(items) ? items : [];
  const results = [];
  let index = 0;

  async function worker() {
    while (index < safeItems.length) {
      const currentIndex = index;
      index += 1;
      try {
        results[currentIndex] = { status: 'fulfilled', value: await mapper(safeItems[currentIndex]) };
      } catch (reason) {
        results[currentIndex] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, safeItems.length) }, () => worker())
  );
  return results;
}

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
  const normalizedPrefix = String(prefix || '').trim();
  // Always use backend proxy to avoid public S3 ListBucket/CORS/403 issues in browsers.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), S3_LIST_TIMEOUT_MS);
  let proxyResp;
  try {
    proxyResp = await fetch(`${API_BASE_URL}/s3/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [normalizedPrefix], limit: S3_LIST_LIMIT }),
      signal: controller.signal,
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
  if (!proxyResp.ok) return [];
  const payload = await proxyResp.json().catch(() => ({}));
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return items
    .map((item) => ({
      key: String(item?.key || '').trim(),
      lastModified: String(item?.last_modified || item?.lastModified || '').trim(),
    }))
    .filter((item) => item.key);
}

export async function listS3ObjectsAcrossPrefixes(prefixes, baseUrl = S3_BASE_URL, options = {}) {
  const user = options?.user || options?.userOrRole || getCurrentUserFromStorage();
  const safePrefixes = filterPrefixesForUser(prefixes || [], user);
  const settled = await mapWithConcurrency(
    safePrefixes,
    (prefix) => listS3Objects(prefix, baseUrl),
    options?.concurrency || S3_LIST_CONCURRENCY
  );
  return settled
    .filter((result) => result.status === 'fulfilled')
    .flatMap((result) => result.value || []);
}

export function mergeUniqueS3Objects(objectSets) {
  return Array.from(new Map(objectSets.flat().map((obj) => [obj.key, obj])).values());
}

export async function fetchTextFromS3(key, baseUrl = S3_BASE_URL) {
  const normalizedKey = String(key || '').trim();
  // Prefer proxy for manual-edits (often blocked by browser CORS in some deployments).
  // For frozenschedules logs, try direct S3 first so missing logs (404) don't spam the proxy endpoint.
  const preferProxy = /^manual-edits\//i.test(normalizedKey);
  if (preferProxy) {
    const proxyUrl = `${API_BASE_URL}/s3/text?key=${encodeURIComponent(normalizedKey)}`;
    const resp = await fetch(proxyUrl);
    if (!resp.ok) {
      const err = new Error(`Proxy fetch failed: ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    return resp.text();
  }
  const url = getS3ObjectUrl(key, baseUrl);
  try {
    const resp = await fetch(url);
    // Avoid proxy fallback when the object simply does not exist; this prevents double 404s in console.
    if (!resp.ok) {
      const err = new Error(`S3 fetch failed: ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    const text = await resp.text();
    if (/AccessDenied/i.test(text) || /<\s*Error\b/i.test(text)) {
      throw new Error('S3 text blocked');
    }
    return text;
  } catch (error) {
    if (Number(error?.status) === 404) {
      throw error;
    }
    const proxyUrl = `${API_BASE_URL}/s3/text?key=${encodeURIComponent(String(key || ''))}`;
    const resp = await fetch(proxyUrl);
    if (!resp.ok) {
      const err = new Error(`Proxy fetch failed: ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    return resp.text();
  }
}

export async function fetchBytesFromS3(key) {
  const normalizedKey = String(key || '').trim();
  const resp = await fetch(`${API_BASE_URL}/s3/bytes?key=${encodeURIComponent(normalizedKey)}`);
  if (!resp.ok) {
    const err = new Error(`Proxy byte fetch failed: ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  return resp.arrayBuffer();
}

const missingTextCache = new Map();
const MISSING_TEXT_CACHE_TTL_MS = 5 * 60_000;

function isKnownMissingText(key) {
  const normalized = String(key || '').trim();
  if (!normalized) return false;
  const entry = missingTextCache.get(normalized);
  if (!entry) return false;
  if (Date.now() - entry.ts > MISSING_TEXT_CACHE_TTL_MS) {
    missingTextCache.delete(normalized);
    return false;
  }
  return true;
}

function setKnownMissingText(key) {
  const normalized = String(key || '').trim();
  if (!normalized) return;
  missingTextCache.set(normalized, { ts: Date.now() });
}

function shouldPreflightExistence(key) {
  const normalized = String(key || '').trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.endsWith('/latest.json')) return true;
  if (normalized.endsWith('/schedule_changes.json')) return true;
  if (normalized.endsWith('/edited_schedule.csv')) return true;
  if (normalized.endsWith('/system_schedule.csv')) return true;
  if (normalized.endsWith('_frozen.log')) return true;
  if (/\/schedule_free(?:z|ze)_from_\d+\.log$/i.test(normalized)) return true;
  return false;
}

async function preflightExists(key) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return null;
  try {
    const resp = await fetch(`${API_BASE_URL}/s3/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [normalizedKey], limit: 1 }),
    });
    if (!resp.ok) return null;
    const payload = await resp.json().catch(() => ({}));
    const items = Array.isArray(payload?.items) ? payload.items : [];
    return items.length > 0;
  } catch {
    return null;
  }
}

export async function fetchTextFromS3Optional(key, baseUrl = S3_BASE_URL) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return null;
  if (isKnownMissingText(normalizedKey)) return null;

  if (shouldPreflightExistence(normalizedKey)) {
    const exists = await preflightExists(normalizedKey);
    if (exists === false) {
      setKnownMissingText(normalizedKey);
      return null;
    }
  }
  try {
    return await fetchTextFromS3(normalizedKey, baseUrl);
  } catch (error) {
    const status = Number(error?.status) || 0;
    if (status === 404) {
      setKnownMissingText(normalizedKey);
      return null;
    }
    // For proxy failures, status is attached above; treat 404 as missing even if message-only.
    if (/Proxy fetch failed:\s*404\b/.test(String(error?.message || ''))) {
      setKnownMissingText(normalizedKey);
      return null;
    }
    if (/S3 fetch failed:\s*404\b/.test(String(error?.message || ''))) {
      setKnownMissingText(normalizedKey);
      return null;
    }
    throw error;
  }
}

const freezeLogCache = new Map();
const FREEZE_LOG_CACHE_TTL_MS = 60_000;
const missingFreezeLogCache = new Map();
const MISSING_FREEZE_LOG_CACHE_TTL_MS = 5 * 60_000;
const freezeLogInFlight = new Map();

function getCachedFreezeLog(logKey) {
  const entry = freezeLogCache.get(logKey);
  if (!entry) return null;
  if (Date.now() - entry.ts > FREEZE_LOG_CACHE_TTL_MS) {
    freezeLogCache.delete(logKey);
    return null;
  }
  return entry.value;
}

function setCachedFreezeLog(logKey, value) {
  freezeLogCache.set(logKey, { ts: Date.now(), value });
}

function isKnownMissingFreezeLog(logKey) {
  const entry = missingFreezeLogCache.get(logKey);
  if (!entry) return false;
  if (Date.now() - entry.ts > MISSING_FREEZE_LOG_CACHE_TTL_MS) {
    missingFreezeLogCache.delete(logKey);
    return false;
  }
  return true;
}

function setMissingFreezeLog(logKey) {
  missingFreezeLogCache.set(logKey, { ts: Date.now() });
}

export async function fetchCsvFromS3(key, baseUrl = S3_BASE_URL) {
  const url = getS3ObjectUrl(key, baseUrl);
  const text = await fetch(url).then((r) => r.text());
  return { url, text };
}

export function isFrozenScheduleCsvKey(key) {
  const text = String(key || '');
  return /schedule_free(?:z|ze)_from_\d+(?:[_-][a-z0-9]+)*\.csv$/i.test(text) || /_frozen\.csv$/i.test(text);
}

export function isNonFrozenScheduleCsvKey(key) {
  return /schedule_from_\d+(?:[_-][a-z0-9]+)*\.csv$/i.test(String(key || ''));
}

export function isAnyScheduleCsvKey(key) {
  return isFrozenScheduleCsvKey(key) || isNonFrozenScheduleCsvKey(key);
}

function isExcludedScheduleKeyByPath(key) {
  const normalized = String(key || '').toLowerCase();
  if (!normalized) return true;
  // Never treat day-ahead source folders as machine schedule candidates.
  if (normalized.includes('/day-ahead/')) return true;
  if (normalized.includes('/enercast_data/day_ahead/')) return true;
  return false;
}

export function extractScheduleBlockFromKey(key) {
  const match = String(key || '').trim().match(/schedule_(?:free(?:z|ze)_)?from_(\d+)(?:[_-][a-z0-9]+)*\.csv$/i);
  if (!match) return null;
  const block = Number.parseInt(match[1], 10);
  return Number.isFinite(block) ? block : null;
}

function getScheduleScopeKey(scheduleKey) {
  const key = String(scheduleKey || '').trim();
  if (!key) return '';
  const block = extractScheduleBlockFromKey(key);
  if (!Number.isFinite(block)) return '';
  const slashIdx = key.lastIndexOf('/');
  const dir = slashIdx >= 0 ? key.slice(0, slashIdx + 1) : '';
  return `${dir}#${String(block).padStart(2, '0')}`;
}

function extractPlantCodeFromKey(key) {
  const text = String(key || '');
  const frozenMatch = text.match(/frozenschedules\/vedanjay\/([^/]+)\//i);
  if (frozenMatch?.[1]) {
    const code = frozenMatch[1].toUpperCase();
    return code === 'OSEL' ? 'OSEPL' : code;
  }
  const generatedMatch = text.match(/generated\/vedanjay\/([^/]+)\/outputs\//i);
  if (generatedMatch?.[1]) {
    const code = generatedMatch[1].toUpperCase();
    return code === 'OSEL' ? 'OSEPL' : code;
  }
  const multiGeneratorMatch = text.match(/(?:raw|generated)\/vedanjay\/multiple_generator\/([^/]+)\//i);
  if (multiGeneratorMatch?.[1]) {
    const code = multiGeneratorMatch[1].toUpperCase();
    return code === 'ZTRIC' ? 'ZETRIC' : code;
  }
  return '';
}

function extractScheduleDateFromKey(key) {
  const text = String(key || '');
  const frozenMatch = text.match(/frozenschedules\/vedanjay\/[^/]+\/(\d{4}-\d{2}-\d{2})\//i);
  if (frozenMatch?.[1]) return frozenMatch[1];
  const outputsMatch = text.match(/\/outputs\/(\d{4}-\d{2}-\d{2})\//i);
  if (outputsMatch?.[1]) return outputsMatch[1];
  const multiGeneratorMatch = text.match(/\/multiple_generator\/[^/]+\/(\d{4}-\d{2}-\d{2})\//i);
  if (multiGeneratorMatch?.[1]) return multiGeneratorMatch[1];
  return '';
}

export function getFreezeLogKeyForScheduleKey(scheduleKey) {
  const key = String(scheduleKey || '').trim();
  const match = key.match(/schedule_(?:free(?:z|ze)_)?from_(\d+)(?:[_-][a-z0-9]+)*\.csv$/i);
  if (!match) return '';
  const block = String(match[1]).padStart(2, '0');

  // New convention (preferred): frozenschedules/vedanjay/<PLANT>/<DATE>/<PLANT>_frozen.log
  const plantCodeNew = extractPlantCodeFromKey(key);
  const scheduleDateNew = extractScheduleDateFromKey(key);
  if (plantCodeNew && scheduleDateNew) {
    return `frozenschedules/vedanjay/${plantCodeNew}/${scheduleDateNew}/${plantCodeNew}_frozen.log`;
  }

  // For non-frozen schedules, logs are stored under .../outputs/<date>/frozen/.
  if (/schedule_from_\d+(?:[_-][a-z0-9]+)*\.csv$/i.test(key)) {
    const dir = key.slice(0, key.lastIndexOf('/') + 1);
    const plantCode = extractPlantCodeFromKey(key);
    if (plantCode) return `${dir}frozen/${plantCode}_frozen.log`;
    return `${dir}frozen/schedule_freeze_from_${block}.log`;
  }
  // For frozen schedules, keep within the same frozen folder.
  const plantCode = extractPlantCodeFromKey(key);
  if (plantCode) {
    const dir = key.slice(0, key.lastIndexOf('/') + 1);
    return `${dir}${plantCode}_frozen.log`;
  }
  return key.replace(/schedule_(?:free(?:z|ze)_)?from_\d+(?:[_-][a-z0-9]+)*\.csv$/i, `schedule_freeze_from_${block}.log`);
}

function getFreezeLogKeyCandidates(scheduleKey) {
  const key = String(scheduleKey || '').trim();
  if (!key) return [];
  const match = key.match(/schedule_(?:free(?:z|ze)_)?from_(\d+)(?:[_-][a-z0-9]+)*\.csv$/i);
  if (!match) return [];

  const primary = getFreezeLogKeyForScheduleKey(key);
  const candidates = new Set(primary ? [primary] : []);

  // If we can derive the canonical frozenschedules log key, do not probe legacy output paths.
  // Probing multiple candidates causes noisy 404s and isn't needed for current deployments.
  if (primary && /^frozenschedules\//i.test(String(primary))) {
    return [primary];
  }

  // Backward compatibility (limited): allow old consolidated plant log paths only.
  // Do NOT probe per-block legacy log names; those cause noisy 404s and are deprecated.
  if (/schedule_from_\d+(?:[_-][a-z0-9]+)*\.csv$/i.test(key)) {
    const dir = key.slice(0, key.lastIndexOf('/') + 1);
    const plantCode = extractPlantCodeFromKey(key);
    if (plantCode) {
      candidates.add(`${dir}frozen/${plantCode}_frozen.log`);
      candidates.add(`${dir}${plantCode}_frozen.log`);
    }
  } else {
    const sameDir = key.slice(0, key.lastIndexOf('/') + 1);
    const plantCode = extractPlantCodeFromKey(key);
    if (plantCode) {
      candidates.add(`${sameDir}${plantCode}_frozen.log`);
    }
  }
  return Array.from(candidates).filter(Boolean);
}

async function getFreezeLogPayloadForScheduleKey(scheduleKey, baseUrl = S3_BASE_URL) {
  const candidates = getFreezeLogKeyCandidates(scheduleKey);
  if (!candidates.length) return { status: '', reason: '', logKey: '' };

  const primaryCacheKey = String(candidates[0] || '').trim();
  if (primaryCacheKey) {
    const cached = getCachedFreezeLog(primaryCacheKey);
    if (cached) return cached;
  }

  if (primaryCacheKey && freezeLogInFlight.has(primaryCacheKey)) {
    try {
      return await freezeLogInFlight.get(primaryCacheKey);
    } catch {
      // ignore and fall through to a fresh attempt below
    }
  }

  const run = (async () => {
  for (const logKey of candidates) {
    if (isKnownMissingFreezeLog(logKey)) continue;
    try {
      const text = await fetchTextFromS3Optional(logKey, baseUrl);
      if (!text) {
        setMissingFreezeLog(logKey);
        continue;
      }
      const trimmed = String(text || '').trim();
      if (!trimmed) continue;
      try {
        const payload = JSON.parse(trimmed);
        const resolved = {
          status: String(payload?.status || '').trim(),
          reason: String(payload?.reason || '').trim(),
          logKey,
        };
        if (primaryCacheKey) setCachedFreezeLog(primaryCacheKey, resolved);
        return resolved;
      } catch {
        const resolved = (() => {
          if (/discarded/i.test(trimmed)) return { status: 'Discarded', reason: trimmed, logKey };
          if (/uploaded|frozen/i.test(trimmed)) return { status: 'Uploaded', reason: trimmed, logKey };
          return { status: '', reason: trimmed, logKey };
        })();
        if (primaryCacheKey) setCachedFreezeLog(primaryCacheKey, resolved);
        return resolved;
      }
    } catch {
      setMissingFreezeLog(logKey);
      // try next candidate
    }
  }

  const resolved = { status: '', reason: '', logKey: '' };
  if (primaryCacheKey) setCachedFreezeLog(primaryCacheKey, resolved);
  return resolved;
  })();

  if (primaryCacheKey) freezeLogInFlight.set(primaryCacheKey, run);
  try {
    return await run;
  } finally {
    if (primaryCacheKey) freezeLogInFlight.delete(primaryCacheKey);
  }
}

export function isAllowedNonFrozenReason(reason) {
  const normalized = String(reason || '').toLowerCase();
  if (!normalized) return false;
  return normalized.includes('first schedule') || normalized.includes('dynamic start');
}

export async function getFreezeStatusForScheduleKey(scheduleKey, baseUrl = S3_BASE_URL) {
  const payload = await getFreezeLogPayloadForScheduleKey(scheduleKey, baseUrl);
  return payload.status;
}

export async function filterVisibleScheduleObjects(objects, baseUrl = S3_BASE_URL) {
  const items = Array.isArray(objects) ? objects : [];
  const scheduleItems = items.filter((obj) => isAnyScheduleCsvKey(obj?.key) && !isExcludedScheduleKeyByPath(obj?.key));
  if (!scheduleItems.length) return [];

  const frozenByScope = new Set(
    scheduleItems
      .filter((obj) => isFrozenScheduleCsvKey(obj?.key))
      .map((obj) => getScheduleScopeKey(obj?.key))
      .filter(Boolean)
  );

  const freezeMetaByLogKey = new Map();
  const resolved = await Promise.all(
    scheduleItems.map(async (obj) => {
      const key = String(obj?.key || '');
      const type = isFrozenScheduleCsvKey(key) ? 'frozen' : (isNonFrozenScheduleCsvKey(key) ? 'non_frozen' : 'other');
      if (type === 'frozen') {
        return {
          ...obj,
          schedule_type: type,
          freeze_status: 'Uploaded',
          freeze_reason: 'Frozen schedule',
        };
      }

      if (type !== 'non_frozen') return null;
      const scopeKey = getScheduleScopeKey(key);
      if (scopeKey && frozenByScope.has(scopeKey)) {
        return {
          ...obj,
          schedule_type: type,
          freeze_status: 'ReplacedByFrozen',
          freeze_reason: 'Frozen schedule exists for this block',
          hidden_by_rule: true,
        };
      }

      const payload = await getFreezeLogPayloadForScheduleKey(key, baseUrl);
      if (payload.logKey) {
        freezeMetaByLogKey.set(payload.logKey, {
          status: payload.status,
          reason: payload.reason,
          sourceKey: key,
        });
      }
      const status = String(payload.status || '').trim();
      const reason = String(payload.reason || '').trim();
      const lowerStatus = status.toLowerCase();

      const isDiscarded = lowerStatus === 'discarded' || /discarded/i.test(reason);
      const allowedReason = isAllowedNonFrozenReason(reason);
      const visible = reason ? (!isDiscarded && allowedReason) : true;

      return {
        ...obj,
        schedule_type: type,
        freeze_status: status,
        freeze_reason: reason,
        hidden_by_rule: !visible,
      };
    })
  );

  return resolved
    .filter(Boolean)
    .filter((obj) => !obj.hidden_by_rule)
    .map((obj) => {
      const logKey = getFreezeLogKeyForScheduleKey(obj.key);
      const meta = logKey ? freezeMetaByLogKey.get(logKey) : null;
      return {
        ...obj,
        freeze_status: obj.freeze_status || meta?.status || '',
        freeze_reason: obj.freeze_reason || meta?.reason || '',
      };
    });
}

export async function filterDiscardedScheduleObjects(objects, baseUrl = S3_BASE_URL) {
  const visible = await filterVisibleScheduleObjects(objects, baseUrl);
  return visible.filter((obj) => {
    if (isFrozenScheduleCsvKey(obj?.key)) return true;
    return isNonFrozenScheduleCsvKey(obj?.key);
  });
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
  const scheduleMatch = fileName.match(/schedule_(?:free(?:z|ze)_)?from_(\d+)(?:[_-][a-z0-9]+)*\.csv$/i);
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
