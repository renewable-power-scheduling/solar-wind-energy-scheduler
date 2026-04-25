const PPA_RATE = 9.27;

// Bands are applied piecewise by error%:
// - For each band, charge only the "span" of error% that falls inside that band.
// - UNDER => payable uses underRate
// - OVER  => receivable uses overRate
const DSM_BANDS = [
  { maxErrorPercent: 10.0, underRate: 9.27, overRate: 9.27 },
  { maxErrorPercent: 12.0, underRate: 10.197, overRate: 8.343 },
  { maxErrorPercent: 15.0, underRate: 11.124, overRate: 7.416 },
  { maxErrorPercent: Number.POSITIVE_INFINITY, underRate: 13.905, overRate: 0.0 },
];

const BLOCK_HOURS = 0.25;
const KWH_PER_MWH = 1000;

const mwToBlockEnergyKwh = (mw) => mw * BLOCK_HOURS * KWH_PER_MWH;

export function calculateOseplSettlement(scheduledMw, actualMw) {
  const scheduled = Number(scheduledMw);
  const actual = Number(actualMw);
  if (!Number.isFinite(scheduled) || !Number.isFinite(actual)) return null;

  const scheduledEnergyKwh = mwToBlockEnergyKwh(scheduled);
  if (!(scheduledEnergyKwh > 0)) return null;

  const actualEnergyKwh = mwToBlockEnergyKwh(actual);
  const deviationKwh = actualEnergyKwh - scheduledEnergyKwh;
  const errorPctSigned = (deviationKwh / scheduledEnergyKwh) * 100;
  const errorPct = Math.abs(errorPctSigned);

  const direction =
    deviationKwh < 0 ? 'UNDER' : deviationKwh > 0 ? 'OVER' : 'NONE';

  let payableRs = 0;
  let receivableRs = 0;

  let bandMin = 0;
  for (const band of DSM_BANDS) {
    const bandMax = band.maxErrorPercent;
    const clampedUpper = Math.min(errorPct, bandMax);
    const span = clampedUpper - bandMin;
    if (span > 0) {
      const energySliceKwh = scheduledEnergyKwh * (span / 100);
      if (direction === 'UNDER') {
        payableRs += energySliceKwh * band.underRate;
      } else if (direction === 'OVER') {
        receivableRs += energySliceKwh * band.overRate;
      }
    }
    bandMin = bandMax;
    if (errorPct <= bandMax) break;
  }

  const scheduleValueRs = scheduledEnergyKwh * PPA_RATE;
  const actualValueRs = actualEnergyKwh * PPA_RATE;
  const finalPenaltyRs = actualValueRs - (scheduleValueRs + receivableRs - payableRs);

  return {
    scheduledEnergyKwh,
    actualEnergyKwh,
    deviationKwh,
    errorPctSigned,
    errorPct,
    direction,
    payableRs,
    receivableRs,
    finalPenaltyRs,
  };
}
