const MACHINE_SCHEDULE_BASENAME_RE = /^schedule_(?:free(?:z|ze)_)?from_(\d+)\.csv$/i;
const MACHINE_SCHEDULE_TOKEN_RE = /schedule_(?:free(?:z|ze)_)?from_(\d+)\.csv/ig;
const OUTPUTS_DATE_RE = /\/outputs\/(\d{4}-\d{2}-\d{2})\//i;
const DAY_AHEAD_RE = /\/day-ahead\/|\/dayahead\/|\/day_ahead\//i;

export function isMachineScheduleBaseName(value) {
  return MACHINE_SCHEDULE_BASENAME_RE.test(String(value || '').trim());
}

export function extractMachineScheduleBlock(value) {
  const match = String(value || '').trim().match(MACHINE_SCHEDULE_BASENAME_RE);
  if (!match?.[1]) return null;
  const block = Number(match[1]);
  return Number.isFinite(block) ? block : null;
}

export function slugifyPlant(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  return raw.replace(/[^a-z0-9]+/g, '');
}

export function extractScheduleDateFromKey(key) {
  const match = String(key || '').match(OUTPUTS_DATE_RE);
  return match?.[1] ? String(match[1]).trim() : '';
}

export function isDayAheadScheduleContext({ key, isDayAhead } = {}) {
  if (typeof isDayAhead === 'boolean') return isDayAhead;
  return DAY_AHEAD_RE.test(String(key || ''));
}

export function toDdMmYyyy(value) {
  const text = String(value || '').trim();
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  return `${m[3]}-${m[2]}-${m[1]}`;
}

export function computeIntradayRunIndexByKey(items) {
  const normalized = (Array.isArray(items) ? items : [])
    .map((item) => {
      const key = String(item?.key || item?.id || '').trim();
      const baseName = String(item?.baseName || item?.fileName || item?.name || '').trim()
        || (key ? String(key).split('/').pop() : '');
      const block = extractMachineScheduleBlock(baseName);
      return { key, baseName, block };
    })
    .filter((row) => row.key && isMachineScheduleBaseName(row.baseName) && Number.isFinite(row.block));

  normalized.sort((a, b) => {
    if (a.block !== b.block) return a.block - b.block;
    return a.key.localeCompare(b.key);
  });

  const runByKey = new Map();
  let run = 0;
  for (const row of normalized) {
    run += 1;
    runByKey.set(row.key, run);
  }
  return runByKey;
}

export function formatMachineScheduleDisplayName({
  baseName,
  key,
  plantCodeOrName,
  scheduleDate,
  isDayAhead,
  intradayRunIndex,
} = {}) {
  const rawBase = String(baseName || '').trim();
  if (!isMachineScheduleBaseName(rawBase)) return rawBase;

  const plantSlug = slugifyPlant(plantCodeOrName);
  const dateYmd = String(scheduleDate || '').trim();
  const ddmmyyyy = toDdMmYyyy(dateYmd);
  const block = extractMachineScheduleBlock(rawBase);

  if (!plantSlug || !ddmmyyyy || !Number.isFinite(block)) return rawBase;

  const dayAhead = isDayAheadScheduleContext({ key, isDayAhead });
  if (dayAhead) {
    const variant = block >= 88 ? 1 : 0;
    const daBlock = block >= 88 ? 88 : 22;
    return `${plantSlug}_${ddmmyyyy}_${daBlock}_DA${variant}`;
  }

  const run = Number(intradayRunIndex);
  if (!Number.isFinite(run) || run <= 0) return rawBase;
  return `${plantSlug}_${ddmmyyyy}_${block}_ID_R${run}`;
}

export function replaceMachineScheduleNamesInText({
  text,
  key,
  plantCodeOrName,
  scheduleDate,
  isDayAhead,
  intradayRunIndex,
} = {}) {
  const raw = String(text || '');
  if (!raw) return raw;

  return raw.replace(MACHINE_SCHEDULE_TOKEN_RE, (match) =>
    formatMachineScheduleDisplayName({
      baseName: match,
      key,
      plantCodeOrName,
      scheduleDate,
      isDayAhead,
      intradayRunIndex,
    })
  );
}
