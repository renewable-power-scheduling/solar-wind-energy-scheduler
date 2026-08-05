export const EURO_RATE_PER_MW = 1;
export const EURO_ROW_TYPES = ['Normal', 'Extend', 'Reduce'];

export const normalizeEuroRowType = (value) => {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'extend') return 'Extend';
  if (text === 'reduce') return 'Reduce';
  return 'Normal';
};

export const toEuroCalculationNumber = (value) => {
  const numeric = Number(String(value ?? '').trim());
  return Number.isFinite(numeric) ? numeric : 0;
};

export const normalizeEuroRatePerMw = (value) => {
  const numeric = toEuroCalculationNumber(value);
  return numeric > 0 ? numeric : EURO_RATE_PER_MW;
};

export const getEuroMonthKey = (dateValue) => {
  const text = String(dateValue || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text.slice(0, 7) : '';
};

export const getDaysInEuroMonth = (dateValue) => {
  const monthKey = getEuroMonthKey(dateValue);
  if (!monthKey) return 30;
  const [year, month] = monthKey.split('-').map((part) => Number(part));
  const days = new Date(year, month, 0).getDate();
  return Number.isFinite(days) && days > 0 ? days : 30;
};

export const calculateEffectiveCapacityMw = (row) => {
  const type = normalizeEuroRowType(row?.type);
  const capacityMw = toEuroCalculationNumber(row?.capacityMw);
  const baseCapacityMw = toEuroCalculationNumber(row?.baseCapacityMw || row?.capacityMw);

  if (type === 'Extend') return baseCapacityMw + capacityMw;
  if (type === 'Reduce') return baseCapacityMw - capacityMw;
  return baseCapacityMw;
};

export const calculateDailyEuroAmount = (rowOrCapacityMw, ratePerMw = EURO_RATE_PER_MW) => {
  const rate = normalizeEuroRatePerMw(ratePerMw);
  if (rowOrCapacityMw && typeof rowOrCapacityMw === 'object') {
    return calculateEffectiveCapacityMw(rowOrCapacityMw) * rate / getDaysInEuroMonth(rowOrCapacityMw?.date);
  }
  return toEuroCalculationNumber(rowOrCapacityMw) * rate / 30;
};

export const calculateEuroRows = (rows, ratePerMw = EURO_RATE_PER_MW) =>
  (Array.isArray(rows) ? rows : []).map((row) => {
    const rate = normalizeEuroRatePerMw(ratePerMw);
    const capacityMw = toEuroCalculationNumber(row?.capacityMw);
    const baseCapacityMw = toEuroCalculationNumber(row?.baseCapacityMw || row?.capacityMw);
    const type = normalizeEuroRowType(row?.type);
    const effectiveCapacityMw = calculateEffectiveCapacityMw({ ...row, type, capacityMw, baseCapacityMw });
    return {
      ...row,
      type,
      capacityMw,
      baseCapacityMw,
      effectiveCapacityMw,
      ratePerMw: rate,
      dailyRatePerMw: rate / getDaysInEuroMonth(row?.date),
      dailyAmountEur: calculateDailyEuroAmount({ ...row, type, capacityMw, baseCapacityMw }, rate),
      month: getEuroMonthKey(row?.date),
    };
  });

export const calculateMonthlyEuroSummary = (rows, ratePerMw = EURO_RATE_PER_MW) => {
  const calculatedRows = calculateEuroRows(rows, ratePerMw).filter((row) => row.month);
  const byMonth = new Map();

  calculatedRows.forEach((row) => {
    if (!byMonth.has(row.month)) {
      byMonth.set(row.month, {
        month: row.month,
        fromDate: row.date,
        toDate: row.date,
        totalDays: 0,
        totalMw: 0,
        normalMw: 0,
        extendedMw: 0,
        reducedMw: 0,
        monthlyAmountEur: 0,
      });
    }

    const summary = byMonth.get(row.month);
    summary.totalDays += 1;
    if (!summary.fromDate || row.date < summary.fromDate) summary.fromDate = row.date;
    if (!summary.toDate || row.date > summary.toDate) summary.toDate = row.date;
    summary.monthlyAmountEur += row.dailyAmountEur;

    summary.normalMw = Math.max(summary.normalMw, row.effectiveCapacityMw);
    if (row.type === 'Extend') summary.extendedMw = Math.max(summary.extendedMw, row.capacityMw);
    else if (row.type === 'Reduce') summary.reducedMw = Math.max(summary.reducedMw, row.capacityMw);
    summary.totalMw = Math.max(summary.totalMw, row.effectiveCapacityMw);
  });

  return Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month));
};
