// Shared freeze logic extracted from the FrozenSchedule UI so it can run in Node or browser.
// NOTE: Keep constants in sync with the UI; adjust here first if freeze rules change.

const TOTAL_BLOCKS = 96;
const BLOCK_MINUTES = 15;
const SLOT_BLOCKS = 6;
const EFFECTIVE_WINDOW_BLOCKS = 3; // 45 min / 15-min blocks
const MADHYA_PRADESH_EFFECTIVE_DELAY_PLANTS = new Set([
  'ANJANGAON',
  'ANDAD',
  'BALAKWADA',
  'BAMKHAL',
  'GSNP',
  'GUGARIYAKHEDI',
  'NANDGAON',
  'SAWDA',
  'SIRMOUR',
]);
const DSM_BLOCK_DURATION_HOURS = 0.25;
const KWH_PER_MWH = 1000;
const EPSILON = 1e-6;
const DEFAULT_ALLOWED_BAND_PERCENT = 10;

export function blockToTime(block) {
  const idx = Math.max(0, parseInt(block, 10) - 1);
  const startMinutes = idx * BLOCK_MINUTES;
  const endMinutes = startMinutes + BLOCK_MINUTES;
  const formatTime = (mins) => {
    const hh = Math.floor(mins / 60);
    const mm = mins % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };
  return `${formatTime(startMinutes)}-${formatTime(endMinutes)}`;
}

/**
 * Converts a timestamp (ISO string or number) to a Date object, 
 * assuming UTC if no timezone is present to prevent local-time drift.
 */
export function parseTimestampToUtc(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value < 1e12 ? value * 1000 : value);
  let raw = String(value).trim();
  if (!raw) return null;
  const hasTimezone = /[zZ]|[+-]\d{2}:\d{2}$/.test(raw);
  const looksIso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw);
  if (looksIso && !hasTimezone) raw += 'Z';
  const dt = new Date(raw.replace(/\s+/, 'T'));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function getAllowedLimitPercent(plantState, plantType, penaltyConfigByState, defaultPenaltyConfig) {
  const normalizeStateName = (raw) =>
    String(raw || '')
      .trim()
      .split(/\s+/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(' ');

  const config =
    penaltyConfigByState?.[normalizeStateName(plantState)] || defaultPenaltyConfig || {};
  const typeConfig = config.byType?.[plantType] || config.byType?.Solar;
  return typeConfig?.baseBand ?? DEFAULT_ALLOWED_BAND_PERCENT;
}

function getPenaltyConfig(plantState, plantType, penaltyConfigByState, defaultPenaltyConfig) {
  const normalizeStateName = (raw) =>
    String(raw || '')
      .trim()
      .split(/\s+/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(' ');

  const config =
    penaltyConfigByState?.[normalizeStateName(plantState)] || defaultPenaltyConfig || { bands: [] };
  return config.byType?.[plantType] || config.byType?.Solar || { bands: [] };
}

export function calculatePenaltyRs({
  scheduledMw,
  actualMw,
  capacityMw,
  plantState,
  plantType,
  penaltyConfigByState,
  defaultPenaltyConfig,
}) {
  if (!Number.isFinite(scheduledMw) || !Number.isFinite(actualMw)) return null;
  const capacity = Math.max(Math.abs(Number(capacityMw) || 0), EPSILON);
  const deviation = actualMw - scheduledMw;
  const percentage = (deviation / capacity) * 100;
  const absDeviationPercent = Math.abs(percentage);
  if (!Number.isFinite(absDeviationPercent) || absDeviationPercent <= 0) return 0;

  const bandPercent = getAllowedLimitPercent(
    plantState,
    plantType,
    penaltyConfigByState,
    defaultPenaltyConfig
  );
  const allowedMw = (capacity * bandPercent) / 100;
  if (Math.abs(deviation) <= allowedMw + 1e-9) return 0;
  const lowerLimitMw = scheduledMw - allowedMw;
  const upperLimitMw = scheduledMw + allowedMw;
  const underGenerationMw = actualMw < lowerLimitMw ? lowerLimitMw - actualMw : 0;
  const overGenerationMw = actualMw > upperLimitMw ? actualMw - upperLimitMw : 0;
  const excessDeviationMw = Math.max(underGenerationMw, overGenerationMw, 0);
  if (excessDeviationMw <= EPSILON) return 0;

  const deviationEnergyKwh = Math.abs(deviation) * DSM_BLOCK_DURATION_HOURS * KWH_PER_MWH;
  const penaltyBands = getPenaltyConfig(
    plantState,
    plantType,
    penaltyConfigByState,
    defaultPenaltyConfig
  ).bands;
  return (penaltyBands || []).reduce((sum, band) => {
    const bandSpan = Math.min(absDeviationPercent, band.max) - band.min;
    if (bandSpan <= 0) return sum;
    const bandEnergyKwh = deviationEnergyKwh * (bandSpan / absDeviationPercent);
    return sum + bandEnergyKwh * band.rate;
  }, 0);
}

function buildScheduleArray(rows) {
  const values = Array(TOTAL_BLOCKS + 1).fill(null);
  rows.forEach((row) => {
    if (row.block >= 1 && row.block <= TOTAL_BLOCKS) {
      if (Number.isFinite(row.scheduledMw)) {
        values[row.block] = row.scheduledMw;
      }
    }
  });
  return values;
}

function getSlotIndex(block) {
  return Math.floor(Math.max(block - 1, 0) / SLOT_BLOCKS);
}

function getSlotEndBlock(block) {
  const slotIndex = getSlotIndex(block);
  return Math.min(TOTAL_BLOCKS, (slotIndex + 1) * SLOT_BLOCKS);
}

export function getSubmitBlockFromTimestamp(timestamp) {
  const dt = parseTimestampToUtc(timestamp);
  if (!dt) return null;
  if (Number.isNaN(dt.getTime())) return null;
  // Compute submit block in IST (Asia/Kolkata), independent of browser/server timezone.
  // `dt` is an absolute instant; we project it into IST clock time.
  const istText = dt.toLocaleString('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  const [hh, mm] = String(istText || '').split(':').map((v) => Number.parseInt(v, 10));
  const hours = Number.isFinite(hh) ? hh : dt.getHours();
  const minutes = Number.isFinite(mm) ? mm : dt.getMinutes();
  const totalMinutes = (hours * 60) + minutes;
  const blockStart = Math.floor(totalMinutes / BLOCK_MINUTES) * BLOCK_MINUTES;
  const submitBlock = Math.floor(blockStart / BLOCK_MINUTES) + 1;
  if (!Number.isFinite(submitBlock)) return null;
  if (submitBlock < 1) return 1;
  if (submitBlock > TOTAL_BLOCKS) return TOTAL_BLOCKS;
  return submitBlock;
}

function normalizePlantCodeForEffectiveDelay(value) {
  const code = String(value || '').trim().toUpperCase();
  if (code === 'ANJANGOAN') return 'ANJANGAON';
  if (code === 'SHRIMOUR' || code === 'SHROMOUR') return 'SIRMOUR';
  if (code === 'OSEL') return 'OSEPL';
  return code;
}

export function getEffectiveDelayBlocks(plantCode = '') {
  return MADHYA_PRADESH_EFFECTIVE_DELAY_PLANTS.has(normalizePlantCodeForEffectiveDelay(plantCode)) ? 6 : EFFECTIVE_WINDOW_BLOCKS;
}

export function getEffectiveStartBlock(uploadBlock, plantCode = '') {
  if (!Number.isFinite(uploadBlock)) return null;
  const activation = uploadBlock + getEffectiveDelayBlocks(plantCode);
  // Always apply the full state-specific delay after submission (no slot-boundary shortcut).
  return activation <= TOTAL_BLOCKS ? activation : null;
}

export function normalizeIntraday(intradayFiles = [], options = {}) {
  const selectedItems = Array.isArray(intradayFiles) ? [...intradayFiles] : [];
  if (!selectedItems.length) return [];

  // Override policy:
  // - Do NOT discard intraday schedules because a day-ahead schedule exists in the same slot.
  // - Do NOT discard later intraday uploads in the same slot; later uploads override earlier ones
  //   starting at their own effective block (45-min delay).
  //
  // This normalization only decides (submitBlock, effectiveBlock, status). The actual override is applied
  // when building the frozen schedule by layering intraday files in effective-time order.

  const toFiniteBlock = (value) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    const rounded = Math.round(num);
    if (!Number.isFinite(rounded)) return null;
    return Math.min(TOTAL_BLOCKS, Math.max(1, rounded));
  };

  const toMillis = (value) => {
    const parsed = Date.parse(String(value || ''));
    return Number.isNaN(parsed) ? null : parsed;
  };

  const normalized = selectedItems.map((item) => {
    const generatedBlock = Number.isFinite(item?.generatedBlock)
      ? Math.min(TOTAL_BLOCKS, Math.max(1, Math.round(item.generatedBlock)))
      : null;

    const explicitSubmitBlock = toFiniteBlock(
      item?.submitBlockCandidate ?? item?.submitBlock ?? item?.submit_block
    );
    const submitBlock =
      explicitSubmitBlock
      ?? getSubmitBlockFromTimestamp(item?.freezeTime)
      ?? generatedBlock;

    const explicitEffectiveBlock = toFiniteBlock(
      item?.effectiveStartBlock ?? item?.effective_start_block ?? item?.effective_start ?? item?.effectiveBlock
    );
    const effectiveBlock =
      explicitEffectiveBlock ?? (Number.isFinite(submitBlock) ? getEffectiveStartBlock(submitBlock, item?.plantCode || item?.plant_code || options?.plantCode) : null);

    const hasScheduleRows =
      Array.isArray(item?.rows) && item.rows.some((r) => Number.isFinite(r?.scheduledMw));

    if (!hasScheduleRows) {
      return {
        ...item,
        generatedBlock,
        submitBlock: Number.isFinite(submitBlock) ? submitBlock : null,
        effectiveBlock: null,
        status: 'Discarded (Empty/invalid schedule file)',
      };
    }

    if (!Number.isFinite(effectiveBlock) || effectiveBlock > TOTAL_BLOCKS) {
      return {
        ...item,
        generatedBlock,
        submitBlock: Number.isFinite(submitBlock) ? submitBlock : null,
        effectiveBlock: null,
        status: 'Discarded (No effective block)',
      };
    }

    return {
      ...item,
      generatedBlock,
      submitBlock: Number.isFinite(submitBlock) ? submitBlock : null,
      effectiveBlock,
      status: 'Uploaded',
    };
  });

  return normalized.sort((a, b) => {
    const aEff = Number.isFinite(a?.effectiveBlock) ? a.effectiveBlock : TOTAL_BLOCKS + 1;
    const bEff = Number.isFinite(b?.effectiveBlock) ? b.effectiveBlock : TOTAL_BLOCKS + 1;
    if (aEff !== bEff) return aEff - bEff;
    const aTime = toMillis(a?.freezeTime);
    const bTime = toMillis(b?.freezeTime);
    if (aTime !== null && bTime !== null && aTime !== bTime) return aTime - bTime;
    if (aTime !== null && bTime === null) return -1;
    if (aTime === null && bTime !== null) return 1;
    const aGen = Number.isFinite(a?.generatedBlock) ? a.generatedBlock : TOTAL_BLOCKS + 1;
    const bGen = Number.isFinite(b?.generatedBlock) ? b.generatedBlock : TOTAL_BLOCKS + 1;
    if (aGen !== bGen) return aGen - bGen;
    return String(a?.name || '').localeCompare(String(b?.name || ''));
  });
}

export function buildFrozenSchedule({
  dayAheadRows,        // Backward compatibility
  dayAheadLayers = [], // New override logic
  intradayLayers,
  actualRows,
  plantCapacity,
  plantState,
  plantType,
  penaltyConfigByState,
  defaultPenaltyConfig,
}) {
  // If dayAheadRows is provided but layers is empty, wrap rows into a baseline layer.
  let activeDaLayers = Array.isArray(dayAheadLayers) ? [...dayAheadLayers] : [];
  if (activeDaLayers.length === 0 && Array.isArray(dayAheadRows) && dayAheadRows.length > 0) {
    activeDaLayers.push({
      rows: dayAheadRows,
      name: 'Current Baseline',
      freezeTime: new Date(0).toISOString(), // Force as earliest baseline
    });
  }

  // 1. Identify valid Intraday layers.
  const scheduleLayers = (intradayLayers || [])
    .filter((item) => Number.isFinite(item.effectiveBlock))
    .sort((a, b) => {
      const aEff = a.effectiveBlock;
      const bEff = b.effectiveBlock;
      if (aEff !== bEff) return aEff - bEff;
      return (parseTimestampToUtc(a?.freezeTime)?.getTime() || 0) - (parseTimestampToUtc(b?.freezeTime)?.getTime() || 0);
    });

  const earliestIntraday = scheduleLayers[0];
  const firstIntradayTime = earliestIntraday ? parseTimestampToUtc(earliestIntraday.freezeTime)?.getTime() : Infinity;
  const earliestIntradayBlock = earliestIntraday ? earliestIntraday.effectiveBlock : TOTAL_BLOCKS + 1;

  // 2. Select latest Day-Ahead BEFORE first Intraday.
  const dayAheadCandidates = activeDaLayers
    .map(da => ({ ...da, timestamp: parseTimestampToUtc(da.freezeTime || da.uploadedAt)?.getTime() || 0 }))
    .filter(da => da.timestamp < firstIntradayTime)
    .sort((a, b) => b.timestamp - a.timestamp);

  const selectedDayAhead = dayAheadCandidates[0];
  
  // Fallback: If no Day-Ahead found before intraday, and no intraday exists, use latest available Day-Ahead.
  const baseDayAhead = selectedDayAhead || (activeDaLayers.length > 0 ? 
    [...activeDaLayers].sort((a, b) => 
      (parseTimestampToUtc(b.freezeTime || b.uploadedAt)?.getTime() || 0) - 
      (parseTimestampToUtc(a.freezeTime || a.uploadedAt)?.getTime() || 0)
    )[0] : null);

  if (!baseDayAhead && !earliestIntraday) {
    // Return empty schedule instead of crashing if no data available yet.
    return { rows: [], summary: { totalPenalty: 0, hasActuals: false } };
  }

  // 3. Initialize base values (Rule 2: DA must never override ID).
  const baseValues = Array(TOTAL_BLOCKS + 1).fill(0);
  const timeline = Array(TOTAL_BLOCKS + 1).fill('None');
  
  if (baseDayAhead) {
    const daRows = buildScheduleArray(baseDayAhead.rows || []);
    const daLabel = `Day-Ahead (${baseDayAhead.name || 'Latest'})`;
    
    for (let block = 1; block <= TOTAL_BLOCKS; block += 1) {
      // Use Day-Ahead only for blocks before the first Intraday becomes effective (Rule 2 & 6).
      if (block < earliestIntradayBlock) {
        baseValues[block] = Number.isFinite(daRows[block]) ? daRows[block] : 0;
        timeline[block] = daLabel;
      } else if (!earliestIntraday) {
        // If no intraday exists, use selected day-ahead for the whole day.
        baseValues[block] = Number.isFinite(daRows[block]) ? daRows[block] : 0;
        timeline[block] = daLabel;
      }
    }
  }

  // 4. Overlay Intraday layers following the effective rule (Rule 1, 3, 5).
  scheduleLayers.forEach((item, idx) => {
    const effective = item.effectiveBlock;
    if (!Number.isFinite(effective) || effective > TOTAL_BLOCKS) return;
    const nextEffective = scheduleLayers[idx + 1]?.effectiveBlock;
    const endBlock = Number.isFinite(nextEffective)
      ? Math.min(TOTAL_BLOCKS, Math.max(effective, nextEffective - 1))
      : TOTAL_BLOCKS;
    const values = buildScheduleArray(item.rows || []);
    for (let block = effective; block <= endBlock; block += 1) {
      if (Number.isFinite(values[block])) {
        baseValues[block] = values[block];
        timeline[block] = `ID-${idx + 1} (${item.name})`;
      }
    }
  });

  const actualByBlock = new Map((actualRows || []).map((r) => [r.block, r.actualMw]));
  const rows = [];
  for (let block = 1; block <= TOTAL_BLOCKS; block += 1) {
    const scheduledMw = Number.isFinite(baseValues[block]) ? baseValues[block] : 0;
    const actualMw = actualByBlock.has(block) ? actualByBlock.get(block) : null;
    const deviationMw = Number.isFinite(actualMw) ? actualMw - scheduledMw : null;
    const deviationPct =
      Number.isFinite(actualMw) && plantCapacity
        ? ((actualMw - scheduledMw) / plantCapacity) * 100
        : null;
    const penaltyRs = Number.isFinite(actualMw)
      ? calculatePenaltyRs({
          scheduledMw,
          actualMw,
          capacityMw: plantCapacity,
          plantState,
          plantType,
          penaltyConfigByState,
          defaultPenaltyConfig,
        })
      : null;
    rows.push({
      block,
      time: blockToTime(block),
      scheduledMw,
      actualMw,
      deviationMw,
      deviationPct,
      penaltyRs,
      source: timeline[block],
    });
  }

  const totalPenalty = rows.reduce((sum, r) => sum + (r.penaltyRs || 0), 0);
  return {
    rows,
    summary: {
      totalPenalty,
      hasActuals: (actualRows || []).length > 0,
    },
  };
}

export const FREEZE_CONSTANTS = {
  TOTAL_BLOCKS,
  BLOCK_MINUTES,
  SLOT_BLOCKS,
  EFFECTIVE_WINDOW_BLOCKS,
  MADHYA_PRADESH_EFFECTIVE_DELAY_BLOCKS: 6,
};
