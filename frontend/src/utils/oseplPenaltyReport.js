const BLOCK_HOURS = 0.25;
const KWH_PER_MWH = 1000;

const mwToBlockEnergyKwh = (mw) => mw * BLOCK_HOURS * KWH_PER_MWH;

/**
 * OSEPL "ESSEL sheet" settlement/penalty calculation.
 *
 * Mirrors the XLSX logic:
 * - ForecastKwh = forecastMw * 0.25h * 1000
 * - ActualKwh = actualMw * 0.25h * 1000
 * - AvCkwh = capacityMw * 0.25h * 1000 (or any provided AVC energy basis)
 * - Signed error% = 100*(ActualKwh - ForecastKwh)/AvCkwh
 * - Payable/Receivable slabs integrate over |error%| using AvCkwh as energy basis
 * - Total = ScheduledUnit*PPA + Receivable - Payable
 * - Generator-end penalty = ActualUnit*PPA - Total
 */
export function calculateOseplReportSettlement({
  forecastMw,
  actualMw,
  capacityMw,
  ppaRateRsPerKwh = 9.27,
}) {
  if (actualMw == null || actualMw === '') return null;
  if (forecastMw == null || forecastMw === '') return null;

  const forecast = Number(forecastMw);
  const actual = Number(actualMw);
  const capacity = Number(capacityMw);

  if (!Number.isFinite(actual)) return null;
  if (!Number.isFinite(forecast)) return null;
  if (!Number.isFinite(capacity) || !(capacity > 0)) return null;
  if (!Number.isFinite(ppaRateRsPerKwh) || !(ppaRateRsPerKwh > 0)) return null;

  const forecastKwh = mwToBlockEnergyKwh(forecast);
  const actualKwh = mwToBlockEnergyKwh(actual);
  const avcKwh = mwToBlockEnergyKwh(capacity);
  if (!(avcKwh > 0)) return null;

  const deviationKwh = actualKwh - forecastKwh;
  const errorPctSigned = (deviationKwh / avcKwh) * 100;
  const errorPctAbs = Math.abs(errorPctSigned);

  const direction = deviationKwh < 0 ? 'UNDER' : deviationKwh > 0 ? 'OVER' : 'NONE';

  // Rates are derived from base PPA rate (matches ESSEL sheet).
  const bands = [
    { min: 0, max: 10, underRate: ppaRateRsPerKwh, overRate: ppaRateRsPerKwh },
    { min: 10, max: 12, underRate: ppaRateRsPerKwh * 1.1, overRate: ppaRateRsPerKwh * 0.9 },
    { min: 12, max: 15, underRate: ppaRateRsPerKwh * 1.2, overRate: ppaRateRsPerKwh * 0.8 },
    { min: 15, max: Number.POSITIVE_INFINITY, underRate: ppaRateRsPerKwh * 1.5, overRate: 0 },
  ];

  let payableRs = 0;
  let receivableRs = 0;

  for (const band of bands) {
    const bandSpanPct = Math.min(errorPctAbs, band.max) - band.min;
    if (!(bandSpanPct > 0)) continue;
    const bandEnergyKwh = avcKwh * (bandSpanPct / 100);

    if (direction === 'UNDER') payableRs += bandEnergyKwh * band.underRate;
    if (direction === 'OVER') receivableRs += bandEnergyKwh * band.overRate;
  }

  const scheduledValueRs = forecastKwh * ppaRateRsPerKwh;
  const totalRs = scheduledValueRs + receivableRs - payableRs;

  // ESSEL sheet sets generator-end penalty to 0 when actual is negative.
  const generatorEndPenaltyRs = actualKwh < 0 ? 0 : (actualKwh * ppaRateRsPerKwh) - totalRs;

  return {
    forecastKwh,
    actualKwh,
    avcKwh,
    deviationKwh,
    errorPctSigned,
    errorPct: errorPctAbs,
    direction,
    payableRs,
    receivableRs,
    netDsmRs: receivableRs - payableRs,
    scheduledValueRs,
    generatorEndPenaltyRs,
  };
}

