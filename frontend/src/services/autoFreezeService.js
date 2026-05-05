import { normalizeIntraday } from '@/shared/freezeRules';
import { getTemplateScheduledMwPreferredColumns } from '@/shared/scheduleColumnPreferences';
import { listS3ObjectsAcrossPrefixes, fetchTextFromS3, fetchTextFromS3Optional } from '@/services/s3Utils';
import { frozenScheduleApi, scheduleReadinessApi } from '@/services/api';
import { parseBlockFromTimestamp } from '@/utils/meterTime';
import { getSubmitBlockFromTimestamp, getEffectiveStartBlock } from '@/shared/freezeRules';
import { DISABLE_S3_META, HIDE_METADATA } from '@/config/appConfig';

const TOTAL_BLOCKS = 96;
const DAY_AHEAD_SUFFIX = /_DA0\.csv$/i;

function parseCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return { headers: [], rows: [] };
  const parseLine = (line) => {
    const out = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"') {
        const peek = line[i + 1];
        if (inQuotes && peek === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        out.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    out.push(current);
    return out.map((c) => c.trim());
  };
  const headers = parseLine(lines[0]).map((h) => h.replace(/^\uFEFF/, '').trim());
  const rows = lines.slice(1).map(parseLine);
  return { headers, rows };
}

function parseScheduleCsv(text, options = {}) {
  const normalizeHeaderToken = (value) =>
    String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');

  const { headers, rows } = parseCsvWithHeaderDetection(text);
  if (!headers.length) return [];

  const headerTokens = headers.map(normalizeHeaderToken);
  const blockIdx = headerTokens.findIndex((h) => h === 'block' || h === 'blk' || h.includes('block'));

  const preferredColumnsRaw = Array.isArray(options.preferredColumns) ? options.preferredColumns : null;
  const preferredColumns =
    preferredColumnsRaw && preferredColumnsRaw.length
      ? preferredColumnsRaw.filter(Boolean)
      : getTemplateScheduledMwPreferredColumns(options.plantCode);

  const preferredIdx = (preferredColumns || []).reduce((found, col) => {
    if (found >= 0) return found;
    const pref = normalizeHeaderToken(col);
    if (!pref) return -1;
    const idx = headerTokens.findIndex((h) => h === pref || h.includes(pref) || pref.includes(h));
    return idx >= 0 ? idx : -1;
  }, -1);

  const pickIndex = (...predicates) => {
    for (const predicate of predicates) {
      const idx = headerTokens.findIndex((h) => predicate(h));
      if (idx >= 0) return idx;
    }
    return -1;
  };

  // Manual-edits CSVs carry the canonical schedule in `algo_schedule_mw`.
  // Prefer it explicitly so we don't accidentally match `IntradayForecast_mw`
  // via generic "forecast" heuristics.
  const algoScheduleIdx = pickIndex(
    (h) => h === 'algoschedulemw',
    (h) => h.includes('algoschedulemw')
  );

  const mwIdx =
    algoScheduleIdx >= 0
      ? algoScheduleIdx
      : preferredIdx >= 0
      ? preferredIdx
      : pickIndex(
          (h) => h.includes('stationschedule') || h.includes('stationsch'),
          (h) => (h.includes('scheduled') && h.includes('mw')) || h === 'scheduledmw' || h === 'schedulemw',
          (h) => h === 'schedule' || (h.includes('schedule') && !h.includes('forecast') && !h.includes('avail')),
          (h) => h.includes('mw') && !h.includes('actual') && !h.includes('meter') && !h.includes('avail'),
          (h) => h.includes('forecast') && !h.includes('actual'),
          () => true
        );

  return rows
    .map((row) => {
      const blockCell = row[blockIdx >= 0 ? blockIdx : 0];
      const block = Number.parseInt(String(blockCell ?? '').trim(), 10);
      const cell = row[mwIdx >= 0 ? mwIdx : 1];
      const scheduledMw = Number.parseFloat(String(cell ?? '').replace(/,/g, '').trim());
      if (!Number.isFinite(block) || !Number.isFinite(scheduledMw)) return null;
      return { block, time: '', scheduledMw };
    })
    .filter(Boolean);
}

function toScheduleMap(rows) {
  const map = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const block = Number(row?.block);
    const value = Number(row?.scheduledMw);
    if (!Number.isFinite(block) || block < 1 || block > TOTAL_BLOCKS) return;
    if (!Number.isFinite(value)) return;
    map.set(block, value);
  });
  return map;
}

function parseFrozenScheduleCsvWithSource(text) {
  const { headers, rows } = parseCsv(text);
  if (!headers.length) return { rows: [], sourceMap: new Map() };
  const normalize = (value) =>
    String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  const headerTokens = headers.map(normalize);
  const blockIdx = headerTokens.findIndex((h) => h === 'block' || h.includes('block'));
  const mwIdx = headerTokens.findIndex(
    (h) => h === 'scheduledmw' || h === 'schedulemw' || (h.includes('scheduled') && h.includes('mw'))
  );
  const sourceIdx = headerTokens.findIndex((h) => h === 'sourceschedule' || (h.includes('source') && h.includes('schedule')));

  const parsedRows = [];
  const sourceMap = new Map();
  (rows || []).forEach((row) => {
    const block = Number.parseInt(String(row?.[blockIdx >= 0 ? blockIdx : 0] ?? '').trim(), 10);
    const scheduledMw = Number.parseFloat(String(row?.[mwIdx >= 0 ? mwIdx : 2] ?? '').replace(/,/g, '').trim());
    if (!Number.isFinite(block) || block < 1 || block > TOTAL_BLOCKS || !Number.isFinite(scheduledMw)) return;
    parsedRows.push({ block, time: '', scheduledMw });
    if (sourceIdx >= 0) {
      sourceMap.set(block, String(row?.[sourceIdx] || '').trim());
    }
  });
  return { rows: parsedRows, sourceMap };
}

function extractManualRequestId(...values) {
  for (const value of values) {
    const match = String(value || '').match(/(manual-\d+-[A-Za-z0-9]+)/i);
    if (match?.[1]) return match[1];
  }
  return '';
}

function manualRequestEpoch(requestId) {
  const match = String(requestId || '').match(/^manual-(\d+)-/i);
  const epoch = Number(match?.[1]);
  return Number.isFinite(epoch) ? epoch : null;
}

function buildManualEditedScheduleKey({ plantCode, scheduleDate, requestId }) {
  const code = String(plantCode || '').trim().toUpperCase();
  const dateKey = normalizeDateKey(scheduleDate);
  const req = String(requestId || '').trim();
  if (!code || !dateKey || !req) return '';
  return `manual-edits/vedanjay/${code}/${dateKey}/INTRADAY/${req}/edited_schedule.csv`;
}

function buildManualSystemScheduleKey({ plantCode, scheduleDate, requestId }) {
  const code = String(plantCode || '').trim().toUpperCase();
  const dateKey = normalizeDateKey(scheduleDate);
  const req = String(requestId || '').trim();
  if (!code || !dateKey || !req) return '';
  return `manual-edits/vedanjay/${code}/${dateKey}/INTRADAY/${req}/system_schedule.csv`;
}

function normalizeEditedSourceLabel(sourceText, dayAheadFileName) {
  const text = String(sourceText || '').trim();
  if (!text) return `DA|${dayAheadFileName}`;
  if (/^DA\|/i.test(text)) return text;
  const editedRevMatch = text.match(/EDITED_REV_(\d+)/i);
  if (editedRevMatch?.[1]) return `EDITED_REV_${editedRevMatch[1]}|edited_schedule.csv`;
  const manualRevMatch = text.match(/MANUAL_REV_(\d+)/i) || text.match(/man_rev=(\d+)/i);
  if (manualRevMatch?.[1]) return `EDITED_REV_${manualRevMatch[1]}|edited_schedule.csv`;
  return `DA|${dayAheadFileName}`;
}

function normalizeSystemSourceLabel(sourceText, dayAheadFileName) {
  const text = String(sourceText || '').trim();
  if (!text) return `DA|${dayAheadFileName}`;
  if (/^DA\|/i.test(text)) return text;
  const systemRevMatch = text.match(/SYSTEM_REV_(\d+)/i) || text.match(/sys_rev=(\d+)/i);
  if (systemRevMatch?.[1]) return `SYSTEM_REV_${systemRevMatch[1]}|system_schedule.csv`;
  return `DA|${dayAheadFileName}`;
}

function parseSourceMetaField(metaText, key) {
  const text = String(metaText || '').trim();
  if (!text) return '';
  const needle = `${String(key || '').trim()}=`;
  if (!needle || needle === '=') return '';
  const parts = text.split('|');
  for (const part of parts) {
    const piece = String(part || '').trim();
    if (!piece.toLowerCase().startsWith(needle.toLowerCase())) continue;
    return piece.slice(needle.length);
  }
  return '';
}

function buildEditedSourceMapFromSystemState(systemSourceMap, dayAheadFileName) {
  const out = new Map();
  for (let block = 1; block <= TOTAL_BLOCKS; block += 1) {
    const meta = systemSourceMap?.get?.(block) || '';
    const rev = parseSourceMetaField(meta, 'rev');
    const fileName = parseSourceMetaField(meta, 'file') || dayAheadFileName;
    if (/^SYSTEM_REV_\d+/i.test(rev)) {
      out.set(block, `${rev.toUpperCase()}|system_schedule.csv`);
      continue;
    }
    if (/^MANUAL_REV_\d+/i.test(rev)) {
      const manualNum = rev.match(/MANUAL_REV_(\d+)/i)?.[1];
      out.set(block, `EDITED_REV_${manualNum || 1}|edited_schedule.csv`);
      continue;
    }
    out.set(block, `DA|${fileName || dayAheadFileName}`);
  }
  return out;
}

function overlayExistingEditedManualBlocks({
  baseScheduleMap,
  baseSourceMap,
  existingEditedBase,
  dayAheadFileName,
}) {
  const scheduleMap = new Map(baseScheduleMap);
  const sourceMap = new Map(baseSourceMap);
  const existingMap = toScheduleMap(existingEditedBase?.rows || []);

  for (let block = 1; block <= TOTAL_BLOCKS; block += 1) {
    const rawSource = existingEditedBase?.sourceMap?.get?.(block) || '';
    const normalized = normalizeEditedSourceLabel(rawSource, dayAheadFileName);
    if (!/^EDITED_REV_/i.test(normalized)) continue;
    if (!existingMap.has(block)) continue;
    scheduleMap.set(block, existingMap.get(block));
    sourceMap.set(block, normalized);
  }

  return { scheduleMap, sourceMap };
}

async function overlayManualLayersOnBase({
  plantCode,
  scheduleDate,
  baseScheduleMap,
  baseSourceMap,
  manualLayers,
  scheduleType,
}) {
  const scheduleMap = new Map(baseScheduleMap);
  const sourceMap = new Map(baseSourceMap);

  for (const layer of manualLayers || []) {
    const manualRows = await loadManualRowsForLayer({
      plantCode,
      scheduleDate,
      layer,
      scheduleType,
    });
    const manualMap = toScheduleMap(manualRows);
    const effectiveBlock = Math.max(1, Math.min(TOTAL_BLOCKS, Number(layer?.effectiveBlock)));
    const revision = Math.max(1, Number(layer?.revisionNumber) || 1);
    const sourceLabel =
      scheduleType === 'system'
        ? `SYSTEM_REV_${revision}|system_schedule.csv`
        : `EDITED_REV_${revision}|edited_schedule.csv`;

    for (let block = effectiveBlock; block <= TOTAL_BLOCKS; block += 1) {
      if (!manualMap.has(block)) continue;
      scheduleMap.set(block, manualMap.get(block));
      sourceMap.set(block, sourceLabel);
    }
  }

  return { scheduleMap, sourceMap };
}

function getLayerFileName(layer) {
  const sourceKey = String(layer?.sourceKey || '').trim();
  const outputKey = String(layer?.outputKey || '').trim();
  const templateName = String(layer?.templateFileName || '').trim();
  return getBasename(sourceKey) || getBasename(outputKey) || getBasename(templateName) || getBasename(layer?.name);
}

function isManualLayer(layer) {
  const blob = [
    layer?.sourceKey,
    layer?.outputKey,
    layer?.templateFileName,
    layer?.name,
  ]
    .map((v) => String(v || '').toLowerCase())
    .join(' ');
  return (
    blob.includes('manual-edits')
    || blob.includes('edited_schedule')
    || blob.includes('_edited_')
    || blob.includes('manual')
  );
}

function formatSourceMeta(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const parts = [];
  Object.entries(meta).forEach(([key, value]) => {
    if (value === null || value === undefined || value === '') return;
    parts.push(`${key}=${String(value).replace(/\|/g, '/')}`);
  });
  return parts.join('|');
}

function buildLayerMeta({ layer, kind, sysRev, manRev, priorRevId }) {
  const revisionId = kind === 'manual' ? `MANUAL_REV_${manRev}` : `SYSTEM_REV_${sysRev}`;
  return {
    type: kind.toUpperCase(),
    rev: revisionId,
    sys_rev: Number.isFinite(sysRev) ? sysRev : 0,
    man_rev: Number.isFinite(manRev) ? manRev : 0,
    file: getLayerFileName(layer),
    submit_block: Number.isFinite(Number(layer?.submitBlock)) ? Number(layer.submitBlock) : '',
    effective_block: Number.isFinite(Number(layer?.effectiveBlock)) ? Number(layer.effectiveBlock) : '',
    submitted_at: String(layer?.freezeTime || ''),
    derived_from: priorRevId || 'DA_REV_1',
  };
}

function buildRowsFromFinalMap({
  scheduleMap,
  sourceMap,
  actualRows,
}) {
  const actualByBlock = new Map((actualRows || []).map((r) => [r.block, r.actualMw]));
  const rows = [];
  for (let block = 1; block <= TOTAL_BLOCKS; block += 1) {
    const scheduledMw = Number.isFinite(scheduleMap.get(block)) ? scheduleMap.get(block) : 0;
    const actualMw = actualByBlock.has(block) ? actualByBlock.get(block) : null;
    const deviationMw = Number.isFinite(actualMw) ? actualMw - scheduledMw : null;
    rows.push({
      block,
      time: `${String(Math.floor(((block - 1) * 15) / 60)).padStart(2, '0')}:${String(((block - 1) * 15) % 60).padStart(2, '0')}-${String(Math.floor((block * 15) / 60)).padStart(2, '0')}:${String((block * 15) % 60).padStart(2, '0')}`,
      scheduledMw,
      actualMw,
      deviationMw,
      deviationPct: null,
      penaltyRs: null,
      source: sourceMap.get(block) || '',
    });
  }
  return rows;
}

function applyLayersOnBaseWithLineage({
  baseRows,
  baseFileName,
  baseSubmittedAt,
  layers,
  includeManualLayers,
}) {
  const scheduleMap = toScheduleMap(baseRows);
  const sourceMap = new Map();
  const baseMeta = {
    type: 'DA',
    rev: 'DA_REV_1',
    file: baseFileName || 'schedule_from_DA.csv',
    submitted_at: String(baseSubmittedAt || ''),
    origin: 'DA',
  };
  for (let block = 1; block <= TOTAL_BLOCKS; block += 1) {
    sourceMap.set(block, formatSourceMeta(baseMeta));
    if (!scheduleMap.has(block)) scheduleMap.set(block, 0);
  }

  const normalizedLayers = (Array.isArray(layers) ? layers : [])
    .filter((layer) => Number.isFinite(Number(layer?.effectiveBlock)))
    .filter((layer) => includeManualLayers || !isManualLayer(layer))
    .sort((a, b) => {
      const aEff = Number(a?.effectiveBlock);
      const bEff = Number(b?.effectiveBlock);
      if (aEff !== bEff) return aEff - bEff;
      return Date.parse(String(a?.freezeTime || '')) - Date.parse(String(b?.freezeTime || ''));
    });

  let systemRevision = 0;
  let manualRevision = 0;
  let lastRevisionId = 'DA_REV_1';

  normalizedLayers.forEach((layer) => {
    const manual = isManualLayer(layer);
    if (manual) {
      manualRevision += 1;
    } else {
      systemRevision += 1;
    }
    const layerMeta = buildLayerMeta({
      layer,
      kind: manual ? 'manual' : 'system',
      sysRev: systemRevision,
      manRev: manualRevision,
      priorRevId: lastRevisionId,
    });

    const effectiveBlock = Math.max(1, Math.min(TOTAL_BLOCKS, Number(layer.effectiveBlock)));
    const layerMap = toScheduleMap(layer.rows || []);
    for (let block = effectiveBlock; block <= TOTAL_BLOCKS; block += 1) {
      if (!layerMap.has(block)) continue;
      const previous = Number(scheduleMap.get(block));
      const next = Number(layerMap.get(block));
      const changed = !Number.isFinite(previous) || Math.abs(next - previous) > 1e-9;
      scheduleMap.set(block, next);
      sourceMap.set(
        block,
        formatSourceMeta({
          ...layerMeta,
          origin: manual ? (changed ? 'MANUAL_EDITED' : 'MANUAL_UNCHANGED') : 'SYSTEM',
        })
      );
    }
    lastRevisionId = layerMeta.rev;
  });

  return { scheduleMap, sourceMap };
}

function parseCsvWithHeaderDetection(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return { headers: [], rows: [] };
  const delimiterCandidates = [',', ';', '\t'];

  const scoreHeaderLine = (line) => {
    const lowered = String(line || '').toLowerCase();
    if (!delimiterCandidates.some((d) => lowered.includes(d))) return -1;
    let score = 0;
    if (/\bblock\b|\bblk\b|\bs\.?\s*no\b|\bsno\b/.test(lowered)) score += 5;
    if (/\btime\b|\btimestamp\b|\bdate\b/.test(lowered)) score += 4;
    if (/mw|kw|power|generation|meter/.test(lowered)) score += 6;
    return score;
  };

  let start = 0;
  let best = { idx: 0, score: -1 };
  const scanLimit = Math.min(lines.length, 25);
  for (let i = 0; i < scanLimit; i += 1) {
    const score = scoreHeaderLine(lines[i]);
    if (score > best.score) best = { idx: i, score };
  }
  if (best.score >= 0) start = best.idx;

  const headerSample = lines[start] || lines[0] || '';
  const delimiter = delimiterCandidates.reduce(
    (bestDelim, candidate) => {
      const count = headerSample.split(candidate).length - 1;
      return count > bestDelim.count ? { value: candidate, count } : bestDelim;
    },
    { value: ',', count: -1 }
  ).value;

  const parseLine = (line) => {
    const cells = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === delimiter && !inQuotes) {
        cells.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    cells.push(current.trim());
    return cells;
  };

  const header1 = parseLine(lines[start]).map((h) => h.trim());
  const maybeHeader2 = lines[start + 1] ? parseLine(lines[start + 1]).map((h) => h.trim()) : [];
  const useSecondHeader = maybeHeader2.some((h) => /forecast|availability/i.test(h));

  const maxCols = Math.max(header1.length, maybeHeader2.length);
  const headers = Array.from({ length: maxCols }, (_, i) => {
    const h1 = header1[i] || '';
    const h2 = useSecondHeader ? (maybeHeader2[i] || '') : '';
    if (h1 && h2) return `${h1} ${h2}`.trim();
    return h1 || h2;
  });

  const dataStart = start + (useSecondHeader ? 2 : 1);
  const rows = lines.slice(dataStart).map((line) => parseLine(line).map((v) => v.trim()));
  return { headers, rows };
}

function parseActualCsv(text) {
  const { headers, rows } = parseCsvWithHeaderDetection(text);
  if (!headers.length) return [];
  const normalizedHeaders = headers.map((h) => String(h || '').toLowerCase().trim());
  const compactHeaders = headers.map((h) =>
    String(h || '')
      .toLowerCase()
      .replace(/["']/g, '')
      .replace(/[^a-z0-9]+/g, '')
  );

  const blockIdx = compactHeaders.findIndex((h) =>
    h === 'block' || h === 'blk' || h === 'blockno' || h === 'blocknumber'
  );
  const endIdx = normalizedHeaders.findIndex((h) => h.includes('end'));
  const startIdx = normalizedHeaders.findIndex((h) => h.includes('start'));
  const timeIdx = endIdx !== -1
    ? endIdx
    : (startIdx !== -1
      ? startIdx
      : compactHeaders.findIndex((h) =>
          h.includes('time') || h.includes('timestamp') || h.includes('datetime')
        ));
  let powerIdx = compactHeaders.findIndex((h) =>
    h === 'mw' ||
    h.endsWith('mw') ||
    h.includes('meterpower') ||
    h.includes('activepower') ||
    h.includes('generation') ||
    h.includes('power') ||
    h.includes('kw')
  );
  if (powerIdx === -1) {
    powerIdx = normalizedHeaders.findIndex((h) =>
      h.includes('active power-avg mfm-out(meter power)') ||
      h.includes('meter power') ||
      h.includes('active power') ||
      h.includes('generation') ||
      h === 'mw' ||
      h.endsWith('(kw)') ||
      h.includes('kw')
    );
  }
  if (powerIdx === -1) return [];

  const getBlockFromTimeText = (raw) => {
    const value = String(raw ?? '').trim();
    if (!value) return null;
    const rangeMatch = value.match(/(\d{1,2}:\d{2})(?:\s*[-–]\s*)(\d{1,2}:\d{2})/);
    if (rangeMatch) return parseBlockFromTimestamp(rangeMatch[2], { totalBlocks: 96 });
    return parseBlockFromTimestamp(value, { totalBlocks: 96 });
  };

  const powerHeader = (normalizedHeaders[powerIdx] || '').trim();
  const explicitKw = powerHeader.includes('(kw)') || powerHeader.includes(' kw') || powerHeader === 'kw';
  const explicitMw =
    powerHeader.includes('(mw)') ||
    powerHeader.includes(' mw') ||
    powerHeader === 'mw' ||
    powerHeader.endsWith('mw');
  const isStartOnly = timeIdx === startIdx && endIdx === -1;

  const parsed = rows
    .map((cols, idx) => {
      const blockFromCol = blockIdx !== -1 ? parseInt(cols[blockIdx], 10) : null;
      const timeRaw = timeIdx !== -1 ? cols[timeIdx] : null;
      const hasTimeColumn = timeIdx !== -1;
      const blockFromTime = hasTimeColumn ? getBlockFromTimeText(timeRaw) : null;
      const adjustedBlockFromTime = (Number.isFinite(blockFromTime) && isStartOnly)
        ? Math.min(blockFromTime + 1, TOTAL_BLOCKS)
        : blockFromTime;
      let block = null;
      if (Number.isFinite(blockFromCol) && blockFromCol >= 1 && blockFromCol <= 96) {
        block = blockFromCol;
      } else if (Number.isFinite(adjustedBlockFromTime)) {
        block = adjustedBlockFromTime;
      } else if (!hasTimeColumn) {
        const fallbackBlock = idx + 1;
        if (fallbackBlock >= 1 && fallbackBlock <= 96) block = fallbackBlock;
      }
      const power = Number.parseFloat(String(cols[powerIdx] ?? '').replace(/,/g, '').trim());
      if (!Number.isFinite(block) || block < 1 || block > 96 || !Number.isFinite(power)) return null;
      return { block, generationValue: power };
    })
    .filter(Boolean);

  const nonZero = parsed.map((x) => x.generationValue).filter((v) => Number.isFinite(v) && v > 0);
  const avg = nonZero.length ? (nonZero.reduce((a, b) => a + b, 0) / nonZero.length) : 0;
  const assumeKw = explicitKw || (!explicitMw && avg > 200);
  const factor = assumeKw ? 1 / 1000 : 1;

  const deduped = new Map();
  parsed.forEach((row) => deduped.set(row.block, { block: row.block, actualMw: row.generationValue * factor }));
  return Array.from(deduped.values()).sort((a, b) => a.block - b.block);
}

function deriveEndingBlockFromName(name) {
  const text = String(name || '').trim();
  if (!text) return null;

  // Intraday / regular schedule snapshots.
  const fromMatch = text.match(/schedule_(?:free(?:z|ze)_)?from_(\d+)\.csv$/i);
  if (fromMatch) {
    const block = Number.parseInt(fromMatch[1], 10);
    return Number.isFinite(block) ? block : null;
  }

  // Day-ahead convention used by some plants/files.
  if (/_da0\.csv$/i.test(text)) {
    return 1;
  }

  return null;
}

function pickFirstCsv(objects, preferDa0 = false) {
  const csvs = objects.filter((o) => o.key.toLowerCase().endsWith('.csv'));
  if (!csvs.length) return null;
  const sortLatestFirst = (items) => [...items].sort((a, b) => {
    const aTime = Date.parse(a.lastModified || '');
    const bTime = Date.parse(b.lastModified || '');
    const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
    if (timeDiff !== 0) return timeDiff;
    return String(b.key || '').localeCompare(String(a.key || ''));
  });
  if (preferDa0) {
    const da0 = sortLatestFirst(csvs.filter((o) => DAY_AHEAD_SUFFIX.test(o.key)))[0];
    if (da0) return da0;
  }
  return sortLatestFirst(csvs)[0];
}

function buildDayAheadPrefixes(dayAheadDate, plantCode) {
  const code = String(plantCode || '').toUpperCase();
  return [`generated/vedanjay/${code}/outputs/${dayAheadDate}/Day-ahead/`];
}

function buildMeterPrefixes(scheduleDate, plantCode) {
  const code = String(plantCode || '').toUpperCase();
  const prefixes = [
    `raw/vedanjay/${code}/${scheduleDate}/metered_data/`,
    `generated/vedanjay/${code}/outputs/${scheduleDate}/meter/`,
  ];
  if (code === 'GSNP') prefixes.push(`raw/GSNP/gsnp/${scheduleDate}/metered_data/`, `generated/GSNP/gsnp/outputs/${scheduleDate}/meter/`);
  if (code === 'SIRMOUR') prefixes.push(`raw/Sirmour/sirmour/${scheduleDate}/metered_data/`, `generated/Sirmour/sirmour/outputs/${scheduleDate}/meter/`);
  return Array.from(new Set(prefixes));
}

function toYmdFromKey(key) {
  const match = String(key || '').match(/outputs\/(\d{4}-\d{2}-\d{2})\//i);
  return match?.[1] || '';
}

function toPlantFromKey(key) {
  const text = String(key || '').trim();
  if (!text) return '';

  const patterns = [
    /generated\/vedanjay\/([^/]+)\/outputs\//i,
    /uploads\/vedanjay\/([^/]+)\//i,
    /local\/readiness\/([^/]+)\//i,
    /raw\/vedanjay\/([^/]+)\//i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const code = String(match?.[1] || '').trim().toUpperCase();
    if (code) return code;
  }

  return '';
}

function isDayAheadScheduleKey(key) {
  const normalized = String(key || '').toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes('/day-ahead/') ||
    normalized.includes('/dayahead/') ||
    normalized.includes('/day_ahead/') ||
    /_da0\.csv$/i.test(normalized)
  );
}

function mapMetaToTriggerReason(metaJson = {}) {
  const scheduleReasonRaw = String(metaJson?.schedule_reason || '').trim();
  const plantStatusRaw = String(metaJson?.plant_status || '').trim();
  const plantStatusUpper = plantStatusRaw.toUpperCase();
  const scheduleReasonLower = scheduleReasonRaw.toLowerCase();

  if (plantStatusUpper && plantStatusUpper !== 'NORMAL') {
    return 'Plant Status Change';
  }
  if (scheduleReasonLower.includes('plant_status')) {
    return 'Plant Status Change';
  }
  if (scheduleReasonLower.includes('curtail') || plantStatusUpper === 'CURTAILMENT') {
    if (scheduleReasonLower.includes('abrupt')) return 'Abrupt Curtailment';
    if (scheduleReasonLower.includes('dynamic')) return 'Dynamic Curtailment';
    return 'Curtailment';
  }
  // Treat abrupt weather changes as dynamic schedules for slot handling.
  if (scheduleReasonLower.includes('abrupt') && scheduleReasonLower.includes('weather')) return 'Dynamic';
  if (scheduleReasonLower.includes('dynamic')) return 'Dynamic';
  if (
    scheduleReasonLower.includes('day_ahead') ||
    scheduleReasonLower.includes('day-ahead') ||
    (scheduleReasonLower.includes('day') && scheduleReasonLower.includes('ahead'))
  ) {
    return 'Day-Ahead';
  }
  return '';
}

async function fetchScheduleTriggerReason(scheduleKey, plantCode, scheduleDate) {
  if (DISABLE_S3_META || HIDE_METADATA) return '';
  const key = String(scheduleKey || '').trim();
  if (!key) return '';
  const fileName = key.split('/').pop() || '';
  const metaFileName = fileName.replace(/\.csv$/i, '.meta.json');
  const candidates = [
    key.replace(/\.csv$/i, '.meta.json'),
    `generated/vedanjay/${String(plantCode || '').toUpperCase()}/outputs/${scheduleDate}/${metaFileName}`,
  ];

  for (const candidate of Array.from(new Set(candidates.filter(Boolean)))) {
    try {
      const text = await fetchTextFromS3(candidate);
      const parsed = JSON.parse(text);
      const reason = mapMetaToTriggerReason(parsed);
      if (reason) return reason;
    } catch {
      // try next candidate
    }
  }
  return '';
}

function getBasename(pathLike) {
  const text = String(pathLike || '').trim();
  if (!text) return '';
  const parts = text.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : text;
}

function getRowTimestamp(row) {
  return String(row?.uploaded_at || row?.updated_at || row?.created_at || '').trim();
}

function getHistoryRowKey(row) {
  const sourceKey = String(row?.source_file_key || '').trim();
  const outputKey = String(row?.output_file_key || '').trim();
  const templateName = String(row?.template_file_name || '').trim();
  const timestamp = getRowTimestamp(row);
  return [sourceKey || '-', outputKey || '-', templateName || '-', timestamp || '-'].join('|');
}

function compareHistoryRows(a, b) {
  const aEffective = Number.isFinite(Number(a?.effective_start_block)) ? Number(a.effective_start_block) : null;
  const bEffective = Number.isFinite(Number(b?.effective_start_block)) ? Number(b.effective_start_block) : null;
  if (aEffective !== null && bEffective !== null && aEffective !== bEffective) {
    return aEffective - bEffective;
  }

  const aSubmit = Number.isFinite(Number(a?.submit_block)) ? Number(a.submit_block) : null;
  const bSubmit = Number.isFinite(Number(b?.submit_block)) ? Number(b.submit_block) : null;
  if (aSubmit !== null && bSubmit !== null && aSubmit !== bSubmit) {
    return aSubmit - bSubmit;
  }

  const aTime = Date.parse(getRowTimestamp(a) || '');
  const bTime = Date.parse(getRowTimestamp(b) || '');
  if (!Number.isNaN(aTime) && !Number.isNaN(bTime) && aTime !== bTime) {
    return aTime - bTime;
  }

  const aId = String(a?.source_file_key || a?.output_file_key || a?.template_file_name || '');
  const bId = String(b?.source_file_key || b?.output_file_key || b?.template_file_name || '');
  return aId.localeCompare(bId);
}

async function loadCsvTextFromHistoryRow(row) {
  const inlineText = String(row?.csv_text || '');
  if (inlineText.trim()) return inlineText;

  const sourceKey = String(row?.source_file_key || '').trim();
  if (sourceKey && !sourceKey.startsWith('local/')) {
    try {
      return await fetchTextFromS3(sourceKey);
    } catch {
      // try next fallback
    }
  }

  const outputKey = String(row?.output_file_key || '').trim();
  if (outputKey && !outputKey.startsWith('local/')) {
    try {
      return await fetchTextFromS3(outputKey);
    } catch {
      // ignore
    }
  }

  return '';
}

function toDaSourceMap(dayAheadFileName) {
  const sourceMap = new Map();
  for (let block = 1; block <= TOTAL_BLOCKS; block += 1) {
    sourceMap.set(block, `DA|${dayAheadFileName}`);
  }
  return sourceMap;
}

async function loadExistingEditedFrozenBase({ plantCode, scheduleDate }) {
  const key = `frozenschedules/vedanjay/${String(plantCode || '').trim().toUpperCase()}/${normalizeDateKey(scheduleDate)}/edited_frozen.csv`;
  try {
    const text = await fetchTextFromS3(key);
    const parsed = parseFrozenScheduleCsvWithSource(text);
    if (!parsed.rows.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function loadExistingSystemFrozenBase({ plantCode, scheduleDate }) {
  const key = `frozenschedules/vedanjay/${String(plantCode || '').trim().toUpperCase()}/${normalizeDateKey(scheduleDate)}/system_frozen.csv`;
  try {
    const text = await fetchTextFromS3(key);
    const parsed = parseFrozenScheduleCsvWithSource(text);
    if (!parsed.rows.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

function resolveLatestManualLayer(layers = []) {
  const ordered = resolveManualLayersOrdered(layers);
  const latestLayer = ordered[ordered.length - 1] || null;
  return {
    latestLayer,
    latestRevisionNumber: ordered.length,
    orderedLayers: ordered,
  };
}

function resolveManualLayersOrdered(layers = []) {
  const manualRows = (Array.isArray(layers) ? layers : [])
    .map((layer) => {
      const requestId =
        String(layer?.manualRequestId || '').trim()
        || extractManualRequestId(layer?.sourceKey, layer?.outputKey, layer?.templateFileName, layer?.name);
      if (!requestId) return null;
      const effectiveBlock = Number(layer?.effectiveBlock);
      if (!Number.isFinite(effectiveBlock)) return null;
      const freezeTimeMs = Date.parse(String(layer?.freezeTime || ''));
      return {
        ...layer,
        requestId,
        effectiveBlock,
        requestEpoch: manualRequestEpoch(requestId),
        freezeTimeMs: Number.isNaN(freezeTimeMs) ? -1 : freezeTimeMs,
      };
    })
    .filter(Boolean);

  if (!manualRows.length) return [];

  const uniqueByRequestId = new Map();
  manualRows.forEach((item) => {
    const prev = uniqueByRequestId.get(item.requestId);
    if (!prev || item.effectiveBlock > prev.effectiveBlock || item.freezeTimeMs > prev.freezeTimeMs) {
      uniqueByRequestId.set(item.requestId, item);
    }
  });

  const ordered = Array.from(uniqueByRequestId.values()).sort((a, b) => {
    const aEpoch = Number.isFinite(a.requestEpoch) ? a.requestEpoch : null;
    const bEpoch = Number.isFinite(b.requestEpoch) ? b.requestEpoch : null;
    if (aEpoch !== null && bEpoch !== null && aEpoch !== bEpoch) return aEpoch - bEpoch;
    if (aEpoch !== null && bEpoch === null) return -1;
    if (aEpoch === null && bEpoch !== null) return 1;
    if (a.freezeTimeMs !== b.freezeTimeMs) return a.freezeTimeMs - b.freezeTimeMs;
    return String(a.requestId).localeCompare(String(b.requestId));
  });

  return ordered.map((item, idx) => ({ ...item, revisionNumber: idx + 1 }));
}

async function loadManualRowsForLayer({ plantCode, scheduleDate, layer, scheduleType }) {
  const requestId = String(layer?.requestId || '').trim();
  if (!requestId) return Array.isArray(layer?.rows) ? layer.rows : [];

  const key =
    scheduleType === 'system'
      ? buildManualSystemScheduleKey({ plantCode, scheduleDate, requestId })
      : buildManualEditedScheduleKey({ plantCode, scheduleDate, requestId });

  if (key) {
    try {
      const manualText = await fetchTextFromS3(key);
      const parsedRows = parseScheduleCsv(manualText, { plantCode });
      if (parsedRows.length) return parsedRows;
    } catch {
      // Fall back to upload-history rows below.
    }
  }

  return Array.isArray(layer?.rows) ? layer.rows : [];
}

async function buildManualFrozenFromLayers({
  plantCode,
  scheduleDate,
  dayAheadRows,
  dayAheadFileName,
  manualLayers,
  scheduleType,
}) {
  const scheduleMap = toScheduleMap(dayAheadRows);
  const sourceMap = toDaSourceMap(dayAheadFileName);

  for (let block = 1; block <= TOTAL_BLOCKS; block += 1) {
    if (!scheduleMap.has(block)) scheduleMap.set(block, 0);
  }

  for (const layer of manualLayers) {
    const manualRows = await loadManualRowsForLayer({
      plantCode,
      scheduleDate,
      layer,
      scheduleType,
    });
    const manualMap = toScheduleMap(manualRows);
    const effectiveBlock = Math.max(1, Math.min(TOTAL_BLOCKS, Number(layer?.effectiveBlock)));
    const revision = Math.max(1, Number(layer?.revisionNumber) || 1);
    const sourceLabel =
      scheduleType === 'system'
        ? `SYSTEM_REV_${revision}|system_schedule.csv`
        : `EDITED_REV_${revision}|edited_schedule.csv`;

    for (let block = effectiveBlock; block <= TOTAL_BLOCKS; block += 1) {
      if (!manualMap.has(block)) continue;
      scheduleMap.set(block, manualMap.get(block));
      sourceMap.set(block, sourceLabel);
    }
  }

  return { scheduleMap, sourceMap };
}

async function loadConfirmedIntradayLayers({ plantCode, operatingDate, excludedKeys }) {
  const code = String(plantCode || '').trim().toUpperCase();
  const dateKey = normalizeDateKey(operatingDate);
  if (!code || !dateKey) return [];

  let historyItems = [];
  try {
    const resp = await scheduleReadinessApi.getUploadHistory({
      plantCode: code,
      scheduleDate: dateKey,
      // Keep this bounded so confirmation doesn't block on very large historical scans.
      limit: 500,
    });
    historyItems = Array.isArray(resp?.items) ? resp.items : [];
  } catch {
    historyItems = [];
  }

  const relevantRows = historyItems.filter((row) => {
    const sourceKey = String(row?.source_file_key || '').trim();
    const outputKey = String(row?.output_file_key || '').trim();
    const templateName = String(row?.template_file_name || '').trim();
    const inlineText = String(row?.csv_text || '').trim();

    // Upload history rows can come from local persisted history (csv_text populated) or S3 discovery
    // (csv_text often empty but output_file_key present). Don't require source_file_key.
    if (!sourceKey && !outputKey && !templateName && !inlineText) return false;

    // A confirmed SLDC template upload may be based on a Day-Ahead schedule (source_file_key may contain /Day-ahead/).
    // Only skip rows that *themselves* look like day-ahead artifacts.
    if (isDayAheadScheduleKey(outputKey) || isDayAheadScheduleKey(templateName)) return false;

    if (excludedKeys?.has?.(outputKey) || excludedKeys?.has?.(sourceKey)) return false;
    const derivedPlant =
      toPlantFromKey(sourceKey) ||
      toPlantFromKey(outputKey) ||
      (() => {
        const upperName = templateName.toUpperCase();
        return upperName.startsWith(`${code}_`) ? code : '';
      })();

    if (derivedPlant && derivedPlant !== code) return false;
    return true;
  });

  relevantRows.sort(compareHistoryRows);
  const seen = new Set();
  const uniqueRows = [];
  for (const row of relevantRows) {
    const rowKey = getHistoryRowKey(row);
    if (seen.has(rowKey)) continue;
    seen.add(rowKey);
    uniqueRows.push(row);
  }

  // Trim very old rows; freeze only needs a bounded number of the most recent uploads.
  // IMPORTANT: trimming must be based on time, not effective-block ordering, otherwise early-day
  // intraday layers can be dropped when there are many later uploads.
  const MAX_ROWS_FOR_FREEZE = 200;
  const recentRows = [...uniqueRows]
    .sort((a, b) => {
      const aTime = Date.parse(getRowTimestamp(a) || '');
      const bTime = Date.parse(getRowTimestamp(b) || '');
      if (!Number.isNaN(aTime) && !Number.isNaN(bTime) && aTime !== bTime) return aTime - bTime;
      if (!Number.isNaN(aTime) && Number.isNaN(bTime)) return -1;
      if (Number.isNaN(aTime) && !Number.isNaN(bTime)) return 1;
      return getHistoryRowKey(a).localeCompare(getHistoryRowKey(b));
    })
    .slice(-MAX_ROWS_FOR_FREEZE)
    .sort(compareHistoryRows);
  const csvCache = new Map();

  const layers = await Promise.all(
    recentRows.map(async (row) => {
      const rowKey = getHistoryRowKey(row);
      const sourceKey = String(row?.source_file_key || '').trim();
      const outputKey = String(row?.output_file_key || '').trim();
      const templateFileName = String(row?.template_file_name || '').trim();
      const manualRequestId = String(row?.manual_request_id || '').trim();
      let csvText = csvCache.get(rowKey);
      if (csvText === undefined) {
        csvText = await loadCsvTextFromHistoryRow(row);
        csvCache.set(rowKey, csvText);
      }
      const parsedRows = parseScheduleCsv(csvText, { plantCode: code });
      const freezeTime = getRowTimestamp(row) || new Date().toISOString();
      const submitBlock = Number.isFinite(Number(row?.submit_block)) ? Number(row.submit_block) : null;
      const effectiveStartBlock = Number.isFinite(Number(row?.effective_start_block))
        ? Number(row.effective_start_block)
        : null;

      return {
        id: rowKey,
        sourceKey,
        outputKey,
        templateFileName,
        manualRequestId,
        name: getBasename(sourceKey) || getBasename(outputKey) || getBasename(templateFileName),
        rows: parsedRows,
        generatedBlock: deriveEndingBlockFromName(sourceKey),
        freezeTime,
        submitBlock,
        effectiveStartBlock,
      };
    })
  );

  return layers.filter(Boolean);
}

function buildFrozenCsv(rows) {
  const headers = ['Block', 'Time', 'Scheduled MW', 'Actual MW', 'Deviation MW', 'Deviation %', 'Penalty Rs', 'Source Schedule'];
  const body = rows.map((r) => [
    r.block,
    r.time,
    r.scheduledMw ?? '',
    Number.isFinite(r.actualMw) ? r.actualMw : '',
    Number.isFinite(r.deviationMw) ? r.deviationMw : '',
    Number.isFinite(r.deviationPct) ? r.deviationPct : '',
    Number.isFinite(r.penaltyRs) ? r.penaltyRs : '',
    r.source || '',
  ]);
  return [headers, ...body].map((line) => line.join(',')).join('\n');
}

function normalizeDateKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{2}-\d{2}-\d{4}$/.test(raw)) {
    const [day, month, year] = raw.split('-');
    return `${year}-${month}-${day}`;
  }
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) {
    const [day, month, year] = raw.split('/');
    return `${year}-${month}-${day}`;
  }
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().split('T')[0];
  return raw;
}

function getNextDateKey(dateKey) {
  const normalized = normalizeDateKey(dateKey);
  if (!normalized) return '';
  const base = new Date(`${normalized}T00:00:00`);
  if (Number.isNaN(base.getTime())) return normalized;
  base.setDate(base.getDate() + 1);
  return base.toISOString().split('T')[0];
}

function getPrevDateKey(dateKey) {
  const normalized = normalizeDateKey(dateKey);
  if (!normalized) return '';
  const base = new Date(`${normalized}T00:00:00`);
  if (Number.isNaN(base.getTime())) return normalized;
  base.setDate(base.getDate() - 1);
  return base.toISOString().split('T')[0];
}

function assertS3Persist(result, contextLabel = 'Frozen schedule persist failed') {
  const storageMode = String(result?.storage_mode || '').trim().toLowerCase();
  const scheduleKey = String(result?.schedule_key || '').trim();
  const statusText = String(result?.status || '').trim();
  const errorText = String(result?.error || '').trim();

  // Uploaded/Frozen must be present in S3 for downstream UI/downloads to work.
  if (
    storageMode !== 's3' &&
    (statusText.toLowerCase() === 'uploaded' || statusText.toLowerCase() === 'frozen')
  ) {
    throw new Error(
      `${contextLabel}: storage_mode=${storageMode || 'unknown'}${scheduleKey ? ` schedule_key=${scheduleKey}` : ''}${errorText ? ` error=${errorText}` : ''}`
    );
  }
}

export async function autoFreezeFromScheduleKey(
  scheduleKey,
  lastModified = null,
  scheduleDateOverride = null,
  plantCodeOverride = null
) {
  const scheduleKeyText = String(scheduleKey || '').trim();
  const isDayAheadSchedule = isDayAheadScheduleKey(scheduleKeyText);
  const plantCode = String(plantCodeOverride || '').trim().toUpperCase() || toPlantFromKey(scheduleKeyText);
  const derivedDate = toYmdFromKey(scheduleKeyText);
  const parsedBlock = deriveEndingBlockFromName(scheduleKeyText);
  // Block is used for audit/log context. Do not fail freeze just because filename doesn't include block suffix.
  const block = Number.isFinite(parsedBlock) ? parsedBlock : 1;

  // operatingDate (D): the date the frozen schedule belongs to.
  // - For intraday/dynamic schedules, the key lives under outputs/D/..., so derivedDate = D.
  // - For day-ahead uploads, the key lives under outputs/U/Day-ahead/..., but it applies to D=U+1.
  // - If caller provides scheduleDateOverride, treat it as the operating date D.
  const operatingDate =
    normalizeDateKey(scheduleDateOverride)
    || (isDayAheadSchedule ? getNextDateKey(derivedDate) : derivedDate)
    || normalizeDateKey(new Date().toISOString().split('T')[0]);

  if (!plantCode || !operatingDate) {
    const missing = [];
    if (!plantCode) missing.push('plant_code');
    if (!operatingDate) missing.push('operating_date');
    return { success: false, skipped: true, reason: `unsupported_schedule_key:${missing.join(',') || 'unknown'}` };
  }

  let excludedKeys = new Set();
  try {
    const resp = await frozenScheduleApi.getExclusions({ plant_code: plantCode, schedule_date: operatingDate });
    const items = Array.isArray(resp?.items) ? resp.items : [];
    excludedKeys = new Set(items.map((k) => String(k || '').trim()).filter(Boolean));
  } catch {
    excludedKeys = new Set();
  }

  if (scheduleKeyText && excludedKeys.has(scheduleKeyText)) {
    const persistResult = await frozenScheduleApi.persistAutoFreeze({
      plant_code: plantCode,
      schedule_date: operatingDate,
      block,
      status: 'Discarded',
      source_schedule_key: scheduleKeyText,
      freeze_time: lastModified || new Date().toISOString(),
      reason: 'Excluded by operator (undo freeze)',
      summary: {},
    });
    assertS3Persist(persistResult, 'Excluded schedule freeze-log persist failed');
    return { success: true, status: 'Discarded', block, scheduleDate: operatingDate, plantCode };
  }

  // Strict baseline lookup: only same operating date path.
  const daPrefixes = [...buildDayAheadPrefixes(operatingDate, plantCode)];

  const [dayAheadObjectsFlat, meterObjects, confirmedLayers] = await Promise.all([
    listS3ObjectsAcrossPrefixes(daPrefixes).catch(() => []),
    listS3ObjectsAcrossPrefixes(buildMeterPrefixes(operatingDate, plantCode)).catch(() => []),
    loadConfirmedIntradayLayers({ plantCode, operatingDate, excludedKeys }).catch(() => []),
  ]);

  const dayAheadObjects = Array.from(new Map(dayAheadObjectsFlat.map(o => [o.key, o])).values());
  let dayAheadCandidates = dayAheadObjects;
  if (
    isDayAheadSchedule &&
    scheduleKeyText &&
    !dayAheadCandidates.some((o) => String(o.key || '').trim() === scheduleKeyText)
  ) {
    dayAheadCandidates = [{ key: scheduleKeyText, lastModified: lastModified || '' }, ...dayAheadCandidates];
  }

  const dayAheadPick = pickFirstCsv(dayAheadCandidates, true);
  if (!dayAheadPick) {
    return { success: false, skipped: true, reason: 'day_ahead_missing' };
  }

  if (!isDayAheadSchedule && scheduleKeyText) {
    const isConfirmed = confirmedLayers.some((item) => String(item?.sourceKey || item?.id || '').trim() === scheduleKeyText);
    if (!isConfirmed) {
      // Discarding/freezing is driven by SLDC confirmation (Uploaded section), not by S3 presence.
      return { success: false, skipped: true, reason: 'not_confirmed_to_sldc' };
    }
  }

  const normalized = normalizeIntraday(
    confirmedLayers,
    isDayAheadSchedule
      ? {
          baselineSlotSeed: {
            timestamp: lastModified || new Date().toISOString(),
            reason: 'Day-Ahead',
            id: scheduleKeyText || 'day-ahead',
          },
        }
      : undefined
  );
  if (!isDayAheadSchedule) {
    const current = normalized.find((item) => item.sourceKey === scheduleKey || item.id === scheduleKey);
    const currentStatus = current?.status || 'Discarded (No freeze rule match)';
    const isDiscarded = String(currentStatus).toLowerCase().includes('discarded') || !current?.effectiveBlock;

    if (isDiscarded) {
      const persistResult = await frozenScheduleApi.persistAutoFreeze({
        plant_code: plantCode,
        schedule_date: operatingDate,
        block,
        status: 'Discarded',
        source_schedule_key: scheduleKey,
        freeze_time: lastModified || new Date().toISOString(),
        reason: currentStatus,
        summary: {},
      });
      assertS3Persist(persistResult, 'Discarded schedule freeze-log persist failed');
      return { success: true, status: 'Discarded', block, scheduleDate: operatingDate, plantCode };
    }
  }

  const [dayAheadText, meterText] = await Promise.all([
    fetchTextFromS3(dayAheadPick.key),
    (async () => {
      const meterPick = pickFirstCsv(meterObjects, false);
      if (!meterPick) return '';
      return fetchTextFromS3(meterPick.key);
    })(),
  ]);

  const dayAheadRows = parseScheduleCsv(dayAheadText, { plantCode });
  const actualRows = meterText ? parseActualCsv(meterText) : [];

  const uploadedLayers = normalized.filter((item) => String(item.status || '').startsWith('Uploaded'));
  const baseFileName = (dayAheadPick.key || '').split('/').pop() || 'schedule_from_DA.csv';

  const systemState = applyLayersOnBaseWithLineage({
    baseRows: dayAheadRows,
    baseFileName,
    baseSubmittedAt: dayAheadPick.lastModified || '',
    layers: uploadedLayers,
    includeManualLayers: false,
  });
  const { orderedLayers: orderedManualLayers } = resolveLatestManualLayer(uploadedLayers);

  let systemScheduleMap = new Map(systemState.scheduleMap);
  let systemSourceMap = new Map(systemState.sourceMap);
  if (orderedManualLayers.length) {
    const built = await overlayManualLayersOnBase({
      plantCode,
      scheduleDate: operatingDate,
      baseScheduleMap: systemScheduleMap,
      baseSourceMap: systemSourceMap,
      manualLayers: orderedManualLayers,
      scheduleType: 'system',
    });
    systemScheduleMap = built.scheduleMap;
    systemSourceMap = built.sourceMap;
  }

  let editedScheduleMap = new Map(systemState.scheduleMap);
  let editedSourceMap = buildEditedSourceMapFromSystemState(systemState.sourceMap, baseFileName);
  if (orderedManualLayers.length) {
    const built = await overlayManualLayersOnBase({
      plantCode,
      scheduleDate: operatingDate,
      baseScheduleMap: editedScheduleMap,
      baseSourceMap: editedSourceMap,
      manualLayers: orderedManualLayers,
      scheduleType: 'edited',
    });
    editedScheduleMap = built.scheduleMap;
    editedSourceMap = built.sourceMap;
  } else {
    const existingEditedBase = await loadExistingEditedFrozenBase({ plantCode, scheduleDate: operatingDate });
    if (existingEditedBase?.rows?.length) {
      const overlaid = overlayExistingEditedManualBlocks({
        baseScheduleMap: editedScheduleMap,
        baseSourceMap: editedSourceMap,
        existingEditedBase,
        dayAheadFileName: baseFileName,
      });
      editedScheduleMap = overlaid.scheduleMap;
      editedSourceMap = overlaid.sourceMap;
    }
  }

  const editedRows = buildRowsFromFinalMap({
    scheduleMap: editedScheduleMap,
    sourceMap: editedSourceMap,
    actualRows,
  });
  const systemRows = buildRowsFromFinalMap({
    scheduleMap: systemScheduleMap,
    sourceMap: systemSourceMap,
    actualRows,
  });
  const summary = {
    totalPenalty: 0,
    hasActuals: (actualRows || []).length > 0,
  };

  const persistResult = await frozenScheduleApi.persistAutoFreeze({
    plant_code: plantCode,
    schedule_date: operatingDate,
    block,
    status: 'Uploaded',
    source_schedule_key: scheduleKey,
    freeze_time: lastModified || new Date().toISOString(),
    reason: isDayAheadSchedule
      ? 'Auto-frozen from new day-ahead schedule notification'
      : 'Auto-frozen from new schedule notification',
    edited_schedule_csv: buildFrozenCsv(editedRows),
    system_schedule_csv: buildFrozenCsv(systemRows),
    summary,
  });
  assertS3Persist(persistResult);

  return { success: true, status: 'Uploaded', block, scheduleDate: operatingDate, plantCode };
}

export async function recomputeFrozenForPlantDate(plantCode, scheduleDate) {
  const code = String(plantCode || '').trim().toUpperCase();
  const dateKey = normalizeDateKey(scheduleDate);
  if (!code || !dateKey) {
    return { success: false, skipped: true, reason: 'missing_plant_or_date' };
  }

  let excludedKeys = new Set();
  try {
    const resp = await frozenScheduleApi.getExclusions({ plant_code: code, schedule_date: dateKey });
    const items = Array.isArray(resp?.items) ? resp.items : [];
    excludedKeys = new Set(items.map((k) => String(k || '').trim()).filter(Boolean));
  } catch {
    excludedKeys = new Set();
  }

  const nowIso = new Date().toISOString();

  const dayAheadPrefixes = [
    `generated/vedanjay/${code}/outputs/${dateKey}/Day-ahead/`,
  ];

  const [dayAheadObjects, meterObjects, confirmedLayers] = await Promise.all([
    listS3ObjectsAcrossPrefixes(dayAheadPrefixes).catch(() => []),
    listS3ObjectsAcrossPrefixes(buildMeterPrefixes(dateKey, code)).catch(() => []),
    loadConfirmedIntradayLayers({ plantCode: code, operatingDate: dateKey, excludedKeys }).catch(() => []),
  ]);

  const dayAheadPick = pickFirstCsv(dayAheadObjects, true);
  if (!dayAheadPick) {
    return { success: false, skipped: true, reason: 'day_ahead_missing' };
  }

  const normalized = normalizeIntraday(confirmedLayers);
  const uploadedLayers = normalized.filter((item) => String(item.status || '').startsWith('Uploaded'));

  const [dayAheadText, meterText] = await Promise.all([
    fetchTextFromS3(dayAheadPick.key),
    (async () => {
      const meterPick = pickFirstCsv(meterObjects, false);
      if (!meterPick) return '';
      return fetchTextFromS3(meterPick.key);
    })(),
  ]);

  const dayAheadRows = parseScheduleCsv(dayAheadText, { plantCode: code });
  const actualRows = meterText ? parseActualCsv(meterText) : [];

  const baseFileName = (dayAheadPick.key || '').split('/').pop() || 'schedule_from_DA.csv';

  const systemState = applyLayersOnBaseWithLineage({
    baseRows: dayAheadRows,
    baseFileName,
    baseSubmittedAt: dayAheadPick.lastModified || '',
    layers: uploadedLayers,
    includeManualLayers: false,
  });
  const { orderedLayers: orderedManualLayers } = resolveLatestManualLayer(uploadedLayers);

  let systemScheduleMap = new Map(systemState.scheduleMap);
  let systemSourceMap = new Map(systemState.sourceMap);
  if (orderedManualLayers.length) {
    const built = await overlayManualLayersOnBase({
      plantCode: code,
      scheduleDate: dateKey,
      baseScheduleMap: systemScheduleMap,
      baseSourceMap: systemSourceMap,
      manualLayers: orderedManualLayers,
      scheduleType: 'system',
    });
    systemScheduleMap = built.scheduleMap;
    systemSourceMap = built.sourceMap;
  }

  let editedScheduleMap = new Map(systemState.scheduleMap);
  let editedSourceMap = buildEditedSourceMapFromSystemState(systemState.sourceMap, baseFileName);
  if (orderedManualLayers.length) {
    const built = await overlayManualLayersOnBase({
      plantCode: code,
      scheduleDate: dateKey,
      baseScheduleMap: editedScheduleMap,
      baseSourceMap: editedSourceMap,
      manualLayers: orderedManualLayers,
      scheduleType: 'edited',
    });
    editedScheduleMap = built.scheduleMap;
    editedSourceMap = built.sourceMap;
  } else {
    const existingEditedBase = await loadExistingEditedFrozenBase({ plantCode: code, scheduleDate: dateKey });
    if (existingEditedBase?.rows?.length) {
      const overlaid = overlayExistingEditedManualBlocks({
        baseScheduleMap: editedScheduleMap,
        baseSourceMap: editedSourceMap,
        existingEditedBase,
        dayAheadFileName: baseFileName,
      });
      editedScheduleMap = overlaid.scheduleMap;
      editedSourceMap = overlaid.sourceMap;
    }
  }

  const editedRows = buildRowsFromFinalMap({
    scheduleMap: editedScheduleMap,
    sourceMap: editedSourceMap,
    actualRows,
  });
  const systemRows = buildRowsFromFinalMap({
    scheduleMap: systemScheduleMap,
    sourceMap: systemSourceMap,
    actualRows,
  });
  const summary = {
    totalPenalty: 0,
    hasActuals: (actualRows || []).length > 0,
  };

  const persistResult = await frozenScheduleApi.persistAutoFreeze({
    plant_code: code,
    schedule_date: dateKey,
    block: 1,
    status: 'Uploaded',
    source_schedule_key: `recompute:${code}:${dateKey}`,
    freeze_time: nowIso,
    reason: 'Recomputed from SLDC upload history',
    schedule_csv: buildFrozenCsv(editedRows),
    edited_schedule_csv: buildFrozenCsv(editedRows),
    system_schedule_csv: buildFrozenCsv(systemRows),
    summary,
  });
  assertS3Persist(persistResult, 'Frozen schedule recompute persist failed');

  return { success: true, status: 'Uploaded', block: 1, scheduleDate: dateKey, plantCode: code };
}

function buildSystemUploadTimeIsoFromSubmitBlock(scheduleDate, submitBlock) {
  const dateKey = normalizeDateKey(scheduleDate);
  if (!dateKey || !Number.isFinite(Number(submitBlock))) return '';
  const block = Math.max(1, Math.min(TOTAL_BLOCKS, Math.round(Number(submitBlock))));
  // System schedule upload time rule:
  // - schedule revision block start + 8 min (generated)
  // - + 4 min (upload) => block start + 12 min (IST)
  const minutes = ((block - 1) * 15) + 12;
  const base = new Date(`${dateKey}T00:00:00+05:30`);
  if (Number.isNaN(base.getTime())) return '';
  base.setMinutes(base.getMinutes() + minutes);
  return base.toISOString();
}

function buildSystemUploadTimeIsoFromRevision(scheduleDate, revisionBlock) {
  return buildSystemUploadTimeIsoFromSubmitBlock(scheduleDate, revisionBlock);
}

function normalizeSystemTriggerReason(reasonText) {
  const raw = String(reasonText || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (!raw || raw === '-') return '';
  if (raw.includes('CURTAIL')) return 'CURTAILMENT';
  if (raw.includes('PLANT') && raw.includes('STATUS')) return 'PLANT_STATUS_CHANGE';
  if (raw.includes('DYNAMIC')) return 'DYNAMIC_START';
  if (raw.includes('ABRUPT') && raw.includes('WEATHER')) return 'ABRUPT_WEATHER';
  return raw;
}

async function listIntradayScheduleKeysForPlantDate({ plantCode, scheduleDate }) {
  const code = String(plantCode || '').trim().toUpperCase();
  const dateKey = normalizeDateKey(scheduleDate);
  if (!code || !dateKey) return [];
  const prefixes = [`generated/vedanjay/${code}/outputs/${dateKey}/`];
  const objects = await listS3ObjectsAcrossPrefixes(prefixes).catch(() => []);
  return (Array.isArray(objects) ? objects : [])
    .map((o) => ({
      key: String(o?.key || '').trim(),
      lastModified: String(o?.lastModified || o?.last_modified || '').trim(),
    }))
    .filter((o) => o.key)
    .filter((o) => /schedule_from_\d+\.csv$/i.test(o.key))
    .filter((o) => !isDayAheadScheduleKey(o.key))
    .filter((o) => !/\/frozenschedules\//i.test(o.key));
}

function extractRevisionFromScheduleKey(scheduleKey) {
  const match = String(scheduleKey || '').match(/schedule_from_(\d+)\.csv$/i);
  if (!match?.[1]) return null;
  const block = Number.parseInt(match[1], 10);
  return Number.isFinite(block) ? block : null;
}

function getSlotIndexFromSubmitBlock(submitBlock, slotBlocks = 6) {
  const b = Number(submitBlock);
  if (!Number.isFinite(b)) return null;
  return Math.floor((Math.max(1, Math.min(TOTAL_BLOCKS, Math.round(b))) - 1) / Math.max(1, slotBlocks));
}

function getSlotStartBlock(slotIndex, slotBlocks = 6) {
  const idx = Number(slotIndex);
  if (!Number.isFinite(idx) || idx < 0) return null;
  const start = (Math.floor(idx) * Math.max(1, slotBlocks)) + 1;
  return start <= TOTAL_BLOCKS ? start : null;
}

export async function recomputeSystemFrozenForPlantDate(plantCode, scheduleDate) {
  const code = String(plantCode || '').trim().toUpperCase();
  const dateKey = normalizeDateKey(scheduleDate);
  if (!code || !dateKey) {
    return { success: false, skipped: true, reason: 'missing_plant_or_date' };
  }

  // Baseline: always Day-ahead.
  // Prefer "uploaded/confirmed day-ahead" (from upload history metadata), else latest generated day-ahead.
  let dayAheadKey = '';
  try {
    const resp = await scheduleReadinessApi.getUploadHistory({ scheduleDate: dateKey, plantCode: code, limit: 2000 });
    const items = Array.isArray(resp?.items) ? resp.items : [];
    const picks = items
      .filter((it) => String(it?.plant_code || '').trim().toUpperCase() === code)
      .filter((it) => String(it?.schedule_date || '').trim() === dateKey)
      .filter((it) => {
        const tr = String(it?.trigger_reason || it?.triggerReason || '').trim().toUpperCase();
        const src = String(it?.source_file_key || '').toLowerCase();
        return tr === 'DAY_AHEAD' || src.includes('/day-ahead/') || src.includes('/dayahead/') || src.includes('/day_ahead/');
      })
      .sort((a, b) => String(b?.uploaded_at || '').localeCompare(String(a?.uploaded_at || '')))
      .map((it) => String(it?.source_file_key || '').trim())
      .filter(Boolean);
    if (picks.length) dayAheadKey = picks[0];
  } catch {
    dayAheadKey = '';
  }

  const dayAheadPickFallback = (() => {
    const key = String(dayAheadKey || '').trim();
    return key ? { key, lastModified: '' } : null;
  })();

  const dayAheadObjects = dayAheadPickFallback
    ? [dayAheadPickFallback]
    : await listS3ObjectsAcrossPrefixes(buildDayAheadPrefixes(dateKey, code)).catch(() => []);
  const dayAheadPick = dayAheadPickFallback || pickFirstCsv(dayAheadObjects, true);
  if (!dayAheadPick?.key) return { success: false, skipped: true, reason: 'day_ahead_missing' };

  const [dayAheadText, meterText] = await Promise.all([
    fetchTextFromS3(dayAheadPick.key),
    (async () => {
      const meterObjects = await listS3ObjectsAcrossPrefixes(buildMeterPrefixes(dateKey, code)).catch(() => []);
      const meterPick = pickFirstCsv(meterObjects, false);
      if (!meterPick?.key) return '';
      return fetchTextFromS3(meterPick.key);
    })(),
  ]);

  const dayAheadRows = parseScheduleCsv(dayAheadText, { plantCode: code });
  const actualRows = meterText ? parseActualCsv(meterText) : [];

  const baseFileName = (dayAheadPick.key || '').split('/').pop() || 'schedule_from_DA.csv';
  let systemScheduleMap = toScheduleMap(dayAheadRows);
  let systemSourceMap = new Map();
  for (let block = 1; block <= TOTAL_BLOCKS; block += 1) {
    if (!systemScheduleMap.has(block)) systemScheduleMap.set(block, 0);
    systemSourceMap.set(block, `DA|${baseFileName}`);
  }

  // Collect candidate system schedules (intraday schedule_from_*.csv).
  const scheduleObjects = await listIntradayScheduleKeysForPlantDate({ plantCode: code, scheduleDate: dateKey });
  const candidates = await Promise.all(
    scheduleObjects.map(async (obj) => {
      const revision = extractRevisionFromScheduleKey(obj.key);
      if (!Number.isFinite(revision)) return null;
      const uploadIso = buildSystemUploadTimeIsoFromRevision(dateKey, revision);
      const submitBlock = getSubmitBlockFromTimestamp(uploadIso) ?? revision;
      const effectiveBlock = getEffectiveStartBlock(submitBlock);
      const slotIndex = getSlotIndexFromSubmitBlock(submitBlock, 6);
      const rawReason = await fetchScheduleTriggerReason(obj.key, code, dateKey).catch(() => '');
      const reason = normalizeSystemTriggerReason(rawReason);
      return {
        key: obj.key,
        revision,
        uploadIso,
        submitBlock,
        effectiveBlock,
        slotIndex,
        triggerReason: reason,
      };
    })
  );

  const events = candidates
    .filter(Boolean)
    .filter((e) => Number.isFinite(e.submitBlock) && Number.isFinite(e.effectiveBlock) && Number.isFinite(e.slotIndex))
    .sort((a, b) => String(a.uploadIso || '').localeCompare(String(b.uploadIso || '')));

  // Slot rule: 6 blocks = 90 minutes, only one submission per slot.
  // If another schedule lands in the same slot, queue it to the next available slot's first block.
  const slotUsed = new Set();
  const accepted = [];

  for (const ev of events) {
    const slotIndex = ev.slotIndex;
    if (!Number.isFinite(slotIndex)) continue;
    if (!slotUsed.has(slotIndex)) {
      slotUsed.add(slotIndex);
      accepted.push({ ...ev, isQueued: false });
      continue;
    }

    const reason = String(ev.triggerReason || '').trim().toUpperCase();
    // Rule: ABRUPT_WEATHER is never queued; if the slot is already used, it is simply not uploaded.
    const queueable = reason === 'CURTAILMENT' || reason === 'PLANT_STATUS_CHANGE' || reason === 'DYNAMIC_START';
    if (!queueable) continue;

    let nextSlot = slotIndex + 1;
    while (nextSlot <= 30 && slotUsed.has(nextSlot)) nextSlot += 1;
    const startBlock = getSlotStartBlock(nextSlot, 6);
    if (!Number.isFinite(startBlock)) continue;
    const queuedUploadIso = buildSystemUploadTimeIsoFromSubmitBlock(dateKey, startBlock);
    const queuedSubmit = startBlock;
    const queuedEffective = getEffectiveStartBlock(queuedSubmit);
    slotUsed.add(nextSlot);
    accepted.push({
      ...ev,
      isQueued: true,
      queuedFromSlot: slotIndex,
      slotIndex: nextSlot,
      submitBlock: queuedSubmit,
      effectiveBlock: queuedEffective,
      uploadIso: queuedUploadIso,
    });
  }

  // Apply layers in chronological (uploadIso) order.
  accepted.sort((a, b) => String(a.uploadIso || '').localeCompare(String(b.uploadIso || '')));

  for (const layer of accepted) {
    const eff = Number(layer.effectiveBlock);
    if (!Number.isFinite(eff) || eff < 1 || eff > TOTAL_BLOCKS) continue;
    const scheduleText = await fetchTextFromS3(layer.key);
    const scheduleRows = parseScheduleCsv(scheduleText, { plantCode: code });
    const scheduleMap = toScheduleMap(scheduleRows);
    const fileName = getBasename(layer.key) || 'schedule_from.csv';
    for (let block = Math.max(1, Math.min(TOTAL_BLOCKS, Math.round(eff))); block <= TOTAL_BLOCKS; block += 1) {
      const val = scheduleMap.get(block);
      if (Number.isFinite(val)) {
        systemScheduleMap.set(block, val);
        systemSourceMap.set(block, `SYS|${fileName}`);
      }
    }
  }

  const systemRows = buildRowsFromFinalMap({
    scheduleMap: systemScheduleMap,
    sourceMap: systemSourceMap,
    actualRows,
  });

  const nowIso = new Date().toISOString();
  const persistResult = await frozenScheduleApi.persistAutoFreeze({
    plant_code: code,
    schedule_date: dateKey,
    block: 1,
    status: 'Uploaded',
    source_schedule_key: `recompute_system:${code}:${dateKey}`,
    freeze_time: nowIso,
    reason: 'Recomputed system frozen (slot rules)',
    write_system_frozen: true,
    system_schedule_csv: buildFrozenCsv(systemRows),
    summary: {
      mode: 'recompute_system_slot_rules',
      slots_used: accepted.length,
    },
  });
  assertS3Persist(persistResult, 'System frozen recompute persist failed');
  return { success: true, status: 'Uploaded', block: 1, scheduleDate: dateKey, plantCode: code };
}
