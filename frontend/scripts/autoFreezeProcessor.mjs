/**
 * Auto-freeze processor (Node-friendly).
 * Listens for "new schedule generated" events, fetches required inputs from S3,
 * applies freeze rules, uploads the frozen schedule CSV, and writes a log
 * alongside it using the shared naming convention.
 *
 * This is a callable module; wire it to your event source (queue/webhook/cron).
 */

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { buildFrozenSchedule } from '../src/shared/freezeRules.js';
import { buildFrozenScheduleKey, buildFrozenLogKey } from '../src/shared/freezeNaming.js';

const DEFAULT_REGION = process.env.AWS_REGION || 'ap-south-1';
const DEFAULT_BUCKET = process.env.S3_BUCKET || 'vedanjay-schedules-test-218708247175';

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

async function fetchCsvAsRows({ s3, bucket, key, parser }) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const text = await streamToString(res.Body);
  return parser(text);
}

// Minimal CSV parser: expects first column = block, second (or named) = MW.
function parseScheduleCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return [];
  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const blockIdx = headers.findIndex((h) => h.includes('block') || h === 'blk' || h === 'sno' || h === 's.no');
  const mwIdx = headers.findIndex((h) => /mw|power|gen/.test(h));
  return lines.slice(1).map((line) => {
    const cells = line.split(',').map((c) => c.trim());
    const block = parseInt(cells[blockIdx >= 0 ? blockIdx : 0], 10);
    const scheduledMw = Number.parseFloat(cells[mwIdx >= 0 ? mwIdx : 1] || 0);
    return { block, scheduledMw };
  });
}

function parseActualCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return [];
  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const blockIdx = headers.findIndex((h) => h.includes('block') || h.includes('slot'));
  const mwIdx = headers.findIndex((h) => /mw|actual|metered/.test(h));
  return lines.slice(1).map((line) => {
    const cells = line.split(',').map((c) => c.trim());
    const block = parseInt(cells[blockIdx >= 0 ? blockIdx : 0], 10);
    const actualMw = Number.parseFloat(cells[mwIdx >= 0 ? mwIdx : 1] || 0);
    return { block, actualMw };
  });
}

export async function processNewScheduleEvent({
  plantCode,
  date,
  block,
  dayAheadKey,
  meterKey,
  intradayKey,
  bucket = DEFAULT_BUCKET,
  region = DEFAULT_REGION,
  penaltyConfigByState,
  defaultPenaltyConfig,
  plantCapacity,
  plantState,
  plantType,
}) {
  const s3 = new S3Client({ region });
  const log = { plantCode, date, block, startedAt: new Date().toISOString() };

  try {
    const [dayAheadRows, intradayRows, actualRows] = await Promise.all([
      fetchCsvAsRows({ s3, bucket, key: dayAheadKey, parser: parseScheduleCsv }),
      fetchCsvAsRows({ s3, bucket, key: intradayKey, parser: parseScheduleCsv }),
      meterKey ? fetchCsvAsRows({ s3, bucket, key: meterKey, parser: parseActualCsv }) : Promise.resolve([]),
    ]);

    const { rows, summary } = buildFrozenSchedule({
      dayAheadRows,
      intradayLayers: [{ name: intradayKey.split('/').pop(), rows: intradayRows, effectiveBlock: block }],
      actualRows,
      plantCapacity,
      plantState,
      plantType,
      penaltyConfigByState,
      defaultPenaltyConfig,
    });

    const outputKey = buildFrozenScheduleKey({ plantCode, date, block });
    const csv = [
      'Block,Time,Scheduled MW,Actual MW,Deviation MW,Deviation %,Penalty Rs,Source Schedule',
      ...rows.map((r) =>
        [
          r.block,
          r.time,
          r.scheduledMw ?? '',
          Number.isFinite(r.actualMw) ? r.actualMw : '',
          Number.isFinite(r.deviationMw) ? r.deviationMw : '',
          Number.isFinite(r.deviationPct) ? r.deviationPct : '',
          Number.isFinite(r.penaltyRs) ? r.penaltyRs : '',
          r.source,
        ].join(',')
      ),
    ].join('\n');

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: outputKey,
        Body: csv,
        ContentType: 'text/csv',
      })
    );

    log.status = 'uploaded';
    log.outputKey = outputKey;
    log.summary = summary;
  } catch (error) {
    log.status = 'failed';
    log.error = error?.message || String(error);
  } finally {
    const logKey = buildFrozenLogKey({ plantCode, date, block });
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: logKey,
        Body: JSON.stringify(log, null, 2),
        ContentType: 'application/json',
      })
    );
  }

  return log;
}

// Quick CLI hook for manual testing:
// node scripts/autoFreezeProcessor.mjs PLANT YYYY-MM-DD BLOCK DAY_AHEAD_KEY METER_KEY INTRADAY_KEY
if (import.meta.url === `file://${process.argv[1]}` && process.argv.length >= 6) {
  const [, , plantCode, date, block, dayAheadKey, meterKey, intradayKey] = process.argv;
  processNewScheduleEvent({
    plantCode,
    date,
    block: Number(block),
    dayAheadKey,
    meterKey,
    intradayKey,
  })
    .then((result) => {
      console.log('Auto-freeze complete:', result);
    })
    .catch((err) => {
      console.error('Auto-freeze failed:', err);
      process.exitCode = 1;
    });
}
