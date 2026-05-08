const PPA_RATE = 9.27;

// Bands are applied piecewise by error%:
// - For each band, charge only the "span" of error% that falls inside that band.
// - UNDER => payable uses underRate
// - OVER  => receivable uses overRate
const DSM_BANDS_REGULATORY = [
  { maxErrorPercent: 10.0, underRate: 9.27, overRate: 9.27 },
  { maxErrorPercent: 12.0, underRate: 10.197, overRate: 8.343 },
  { maxErrorPercent: 15.0, underRate: 11.124, overRate: 7.416 },
  { maxErrorPercent: Number.POSITIVE_INFINITY, underRate: 13.905, overRate: 0.0 },
];

// Office daily reports for OSEPL/ESSEL show "Payable/Receivable" using a slightly
// different convention than the generator-end DSM penalty:
// - Negative actual MW is clamped to 0 (no export).
// - Under-injection beyond 15% uses the same rate as the 12–15% band.
// DSM penalty is still computed from the regulatory slabs + final formula.
const DSM_BANDS_OFFICE_PAYABLE = [
  { maxErrorPercent: 10.0, underRate: 9.27, overRate: 9.27 },
  { maxErrorPercent: 12.0, underRate: 10.197, overRate: 8.343 },
  { maxErrorPercent: 15.0, underRate: 11.124, overRate: 7.416 },
  { maxErrorPercent: Number.POSITIVE_INFINITY, underRate: 11.124, overRate: 0.0 },
];

const BLOCK_HOURS = 0.25;
const KWH_PER_MWH = 1000;

const mwToBlockEnergyKwh = (mw) => mw * BLOCK_HOURS * KWH_PER_MWH;

function calculatePayableReceivableByBands({ deviationKwh, avcKwh, bands }) {
  const errorPctSigned = (deviationKwh / avcKwh) * 100;
  const errorPct = Math.abs(errorPctSigned);

  const direction =
    deviationKwh < 0 ? 'UNDER' : deviationKwh > 0 ? 'OVER' : 'NONE';

  let payableRs = 0;
  let receivableRs = 0;

  let bandMin = 0;
  for (const band of bands) {
    const bandMax = band.maxErrorPercent;
    const clampedUpper = Math.min(errorPct, bandMax);
    const span = clampedUpper - bandMin;
    if (span > 0) {
      const energySliceKwh = avcKwh * (span / 100);
      if (direction === 'UNDER') {
        payableRs += energySliceKwh * band.underRate;
      } else if (direction === 'OVER') {
        receivableRs += energySliceKwh * band.overRate;
      }
    }
    bandMin = bandMax;
    if (errorPct <= bandMax) break;
  }

  return {
    errorPctSigned,
    errorPct,
    direction,
    payableRs,
    receivableRs,
  };
}

/**
 * OSEPL slab settlement/penalty calculation (ESSEL style).
 *
 * Key rule:
 * - error% = 100 * (ActualKwh - ScheduledKwh) / AvCkwh  (AvCkwh == "ABC", e.g. 20 MW => 5000 kWh per block)
 * - Slab energy slices are also computed on AvCkwh (not on ScheduledKwh).
 */
export function calculateOseplSettlement(scheduledMw, actualMw, capacityMw) {
  const scheduled = Number(scheduledMw);
  const actual = Number(actualMw);
  const capacity = Number(capacityMw);
  if (!Number.isFinite(scheduled) || !Number.isFinite(actual) || !Number.isFinite(capacity)) return null;

  const scheduledEnergyKwh = mwToBlockEnergyKwh(scheduled);
  const actualEnergyKwh = mwToBlockEnergyKwh(actual);
  const deviationKwh = actualEnergyKwh - scheduledEnergyKwh;

  const avcKwh = mwToBlockEnergyKwh(capacity);
  if (!(avcKwh > 0)) return null;

  const {
    errorPctSigned,
    errorPct,
    direction,
    payableRs,
    receivableRs,
  } = calculatePayableReceivableByBands({
    deviationKwh,
    avcKwh,
    bands: DSM_BANDS_REGULATORY,
  });

  const scheduleValueRs = scheduledEnergyKwh * PPA_RATE;
  const actualValueRs = actualEnergyKwh * PPA_RATE;
  const finalPenaltyRs = actualValueRs - (scheduleValueRs + receivableRs - payableRs);

  return {
    scheduledEnergyKwh,
    actualEnergyKwh,
    avcKwh,
    deviationKwh,
    errorPctSigned,
    errorPct,
    direction,
    payableRs,
    receivableRs,
    finalPenaltyRs,
  };
}

export function calculateOseplOfficePayableReceivable(scheduledMw, actualMw, capacityMw) {
  const scheduled = Number(scheduledMw);
  const actual = Math.max(0, Number(actualMw));
  const capacity = Number(capacityMw);
  if (!Number.isFinite(scheduled) || !Number.isFinite(actual) || !Number.isFinite(capacity)) return null;

  const scheduledEnergyKwh = mwToBlockEnergyKwh(scheduled);
  const actualEnergyKwh = mwToBlockEnergyKwh(actual);
  const deviationKwh = actualEnergyKwh - scheduledEnergyKwh;

  const avcKwh = mwToBlockEnergyKwh(capacity);
  if (!(avcKwh > 0)) return null;

  const { payableRs, receivableRs } = calculatePayableReceivableByBands({
    deviationKwh,
    avcKwh,
    bands: DSM_BANDS_OFFICE_PAYABLE,
  });

  return { payableRs, receivableRs };
}
