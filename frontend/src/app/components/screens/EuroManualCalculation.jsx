import { useMemo, useState } from 'react';
import { CalendarDays, Euro, RotateCcw, Save, Trash2 } from 'lucide-react';
import {
  EURO_RATE_PER_MW,
  EURO_ROW_TYPES,
  calculateDailyEuroAmount,
  calculateEuroRows,
  calculateMonthlyEuroSummary,
  getEuroMonthKey,
  normalizeEuroRatePerMw,
  toEuroCalculationNumber,
} from '@/utils/euroManualCalculation';

const createRowForDate = (date, capacityMw, rangeId, options = {}) => ({
  id: `${date}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  rangeId,
  date,
  type: options.type || 'Normal',
  capacityMw,
  baseCapacityMw: options.baseCapacityMw ?? capacityMw,
});

const formatNumber = (value, decimals = 2) => {
  const numeric = toEuroCalculationNumber(value);
  if (Math.abs(numeric - Math.trunc(numeric)) < 1e-9) return String(Math.trunc(numeric));
  return numeric.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '');
};

const formatMonth = (monthKey) => {
  if (!monthKey) return '-';
  const [year, month] = String(monthKey).split('-');
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
};

const formatDate = (dateValue) => {
  const text = String(dateValue || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '-';
  const [year, month, day] = text.split('-');
  return `${day}-${month}-${year}`;
};

const formatSummaryRange = (summary) => {
  if (!summary?.fromDate || !summary?.toDate) return '-';
  if (summary.fromDate === summary.toDate) return formatDate(summary.fromDate);
  return `${formatDate(summary.fromDate)} to ${formatDate(summary.toDate)}`;
};

const dateRange = (fromDate, toDate) => {
  if (!fromDate || !toDate) return [];
  const start = new Date(`${fromDate}T00:00:00`);
  const end = new Date(`${toDate}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return [];

  const dates = [];
  const current = new Date(start);
  while (current <= end) {
    dates.push(current.toLocaleDateString('en-CA'));
    current.setDate(current.getDate() + 1);
  }
  return dates;
};

export function EuroManualCalculation() {
  const [rows, setRows] = useState([]);
  const [entryRanges, setEntryRanges] = useState([]);
  const [entryForm, setEntryForm] = useState(() => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    return {
      fromDate: today,
      toDate: today,
      capacityMw: '',
    };
  });
  const [formError, setFormError] = useState('');
  const [ratePerMw, setRatePerMw] = useState(String(EURO_RATE_PER_MW));
  const [selectedRowIds, setSelectedRowIds] = useState([]);
  const effectiveRatePerMw = normalizeEuroRatePerMw(ratePerMw);

  const calculatedRows = useMemo(() => calculateEuroRows(rows, effectiveRatePerMw), [rows, effectiveRatePerMw]);
  const monthlySummary = useMemo(() => calculateMonthlyEuroSummary(rows, effectiveRatePerMw), [rows, effectiveRatePerMw]);
  const rangeSummary = useMemo(() => entryRanges.map((range) => {
    const rangeRows = calculatedRows.filter((row) => row.rangeId === range.id);
    if (!rangeRows.length) return null;
    return rangeRows.reduce((summary, row) => {
      summary.totalDays += 1;
      summary.monthlyAmountEur += toEuroCalculationNumber(row.dailyAmountEur);
      summary.normalMw = Math.max(summary.normalMw, row.effectiveCapacityMw);
      if (row.type === 'Extend') summary.extendedMw = Math.max(summary.extendedMw, row.capacityMw);
      else if (row.type === 'Reduce') summary.reducedMw = Math.max(summary.reducedMw, row.capacityMw);
      summary.totalMw = Math.max(summary.totalMw, row.effectiveCapacityMw);
      if (!summary.fromDate || row.date < summary.fromDate) summary.fromDate = row.date;
      if (!summary.toDate || row.date > summary.toDate) summary.toDate = row.date;
      return summary;
    }, {
      rangeId: range.id,
      fromDate: range.fromDate,
      toDate: range.toDate,
      totalDays: 0,
      totalMw: 0,
      normalMw: 0,
      extendedMw: 0,
      reducedMw: 0,
      monthlyAmountEur: 0,
    });
  }).filter(Boolean), [calculatedRows, entryRanges]);
  const rangeSummaryTotalEur = useMemo(
    () => rangeSummary.reduce((sum, summary) => sum + toEuroCalculationNumber(summary.monthlyAmountEur), 0),
    [rangeSummary]
  );
  const [selectedMonth, setSelectedMonth] = useState('');
  const [selectedRangeId, setSelectedRangeId] = useState('');

  const activeMonth = selectedRangeId ? '' : (selectedMonth || monthlySummary[0]?.month || '');
  const visibleRows = calculatedRows.filter((row) => {
    if (selectedRangeId) return row.rangeId === selectedRangeId;
    return !activeMonth || row.month === activeMonth;
  });
  const selectedSummary = useMemo(() => {
    if (!selectedRangeId) {
      return monthlySummary.find((item) => item.month === activeMonth) || null;
    }
    return visibleRows.reduce((summary, row) => {
      summary.totalDays += 1;
      summary.monthlyAmountEur += toEuroCalculationNumber(row.dailyAmountEur);
      summary.normalMw = Math.max(summary.normalMw, row.effectiveCapacityMw);
      if (row.type === 'Extend') summary.extendedMw = Math.max(summary.extendedMw, row.capacityMw);
      else if (row.type === 'Reduce') summary.reducedMw = Math.max(summary.reducedMw, row.capacityMw);
      summary.totalMw = Math.max(summary.totalMw, row.effectiveCapacityMw);
      return summary;
    }, {
      totalDays: 0,
      totalMw: 0,
      normalMw: 0,
      extendedMw: 0,
      reducedMw: 0,
      monthlyAmountEur: 0,
    });
  }, [activeMonth, monthlySummary, selectedRangeId, visibleRows]) || {
    totalDays: 0,
    totalMw: 0,
    normalMw: 0,
    extendedMw: 0,
    reducedMw: 0,
    monthlyAmountEur: 0,
  };

  const monthOptions = monthlySummary.map((item) => item.month);
  const selectedFilterValue = selectedRangeId ? `range:${selectedRangeId}` : activeMonth;
  const visibleRowIds = visibleRows.map((row) => row.id);
  const allVisibleSelected = visibleRowIds.length > 0 && visibleRowIds.every((id) => selectedRowIds.includes(id));

  const toggleRowSelected = (id) => {
    setSelectedRowIds((prev) => (
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    ));
  };

  const toggleAllVisibleRows = () => {
    setSelectedRowIds((prev) => {
      if (allVisibleSelected) return prev.filter((id) => !visibleRowIds.includes(id));
      return Array.from(new Set([...prev, ...visibleRowIds]));
    });
  };

  const updateRow = (id, field, value) => {
    const selectedSet = new Set(selectedRowIds);
    const shouldApplyToSelected = selectedSet.has(id) && selectedSet.size > 1 && (field === 'type' || field === 'capacityMw');
    setRows((prev) =>
      prev.map((row) => {
        if (shouldApplyToSelected ? !selectedSet.has(row.id) : row.id !== id) return row;
        const next = { ...row, [field]: value };
        if (field === 'capacityMw' && row.type === 'Normal') {
          next.baseCapacityMw = value;
        }
        if (field === 'type') {
          if (value === 'Normal') {
            next.capacityMw = row.baseCapacityMw || row.capacityMw;
            next.baseCapacityMw = row.baseCapacityMw || row.capacityMw;
          } else if (row.type === 'Normal') {
            next.baseCapacityMw = row.capacityMw;
            next.capacityMw = '';
          }
        }
        return next;
      })
    );
  };

  const saveEntryRange = () => {
    setFormError('');
    const capacityMw = String(entryForm.capacityMw || '').trim();
    const numericCapacity = toEuroCalculationNumber(capacityMw);
    if (!entryForm.fromDate || !entryForm.toDate) {
      setFormError('Select from date and to date.');
      return;
    }
    if (!capacityMw || numericCapacity <= 0) {
      setFormError('Enter capacity MW greater than 0.');
      return;
    }
    const dates = dateRange(entryForm.fromDate, entryForm.toDate);
    if (!dates.length) {
      setFormError('To date must be on or after from date.');
      return;
    }

    const previousRow = calculatedRows
      .filter((row) => row.date < entryForm.fromDate)
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    const previousCapacityMw = toEuroCalculationNumber(previousRow?.effectiveCapacityMw);
    const hasPreviousCapacity = previousRow && previousCapacityMw > 0;
    const capacityDifferenceMw = numericCapacity - previousCapacityMw;
    const adjustmentType = hasPreviousCapacity && capacityDifferenceMw > 0
      ? 'Extend'
      : hasPreviousCapacity && capacityDifferenceMw < 0
        ? 'Reduce'
        : 'Normal';
    const rowCapacityMw = adjustmentType === 'Normal'
      ? capacityMw
      : String(Math.abs(capacityDifferenceMw));
    const rowBaseCapacityMw = adjustmentType === 'Normal'
      ? capacityMw
      : String(previousCapacityMw);

    const rangeId = `${entryForm.fromDate}-${entryForm.toDate}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const nextRows = dates.map((date) => createRowForDate(date, rowCapacityMw, rangeId, {
      type: adjustmentType,
      baseCapacityMw: rowBaseCapacityMw,
    }));
    setEntryRanges((prev) => [
      ...prev,
      {
        id: rangeId,
        fromDate: entryForm.fromDate,
        toDate: entryForm.toDate,
      },
    ]);
    setRows((prev) => [...prev, ...nextRows]);
    setSelectedRangeId(rangeId);
    setSelectedMonth('');
  };

  const deleteRow = (id) => {
    setRows((prev) => prev.filter((row) => row.id !== id));
    setSelectedRowIds((prev) => prev.filter((rowId) => rowId !== id));
  };

  const clearAllData = () => {
    setRows([]);
    setEntryRanges([]);
    setSelectedRowIds([]);
    setSelectedMonth('');
    setSelectedRangeId('');
    setFormError('');
  };

  return (
    <div className="min-h-full bg-background p-4 sm:p-6 space-y-5">
      <section className="bg-card border border-border rounded-lg p-5 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="h-11 w-11 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
              <Euro className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-foreground">Capacity Adjustment Billing</h1>
            </div>
          </div>
          <button
            type="button"
            onClick={clearAllData}
            disabled={!rows.length}
            className="inline-flex items-center justify-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RotateCcw className="h-4 w-4" />
            Clear
          </button>
        </div>
      </section>

      <section className="bg-card border border-border rounded-lg p-4">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_1fr_1fr_auto] gap-3 items-end">
          <label className="space-y-1">
            <span className="text-sm font-medium text-muted-foreground">From Date</span>
            <div className="relative">
              <CalendarDays className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <input
                type="date"
                value={entryForm.fromDate}
                onChange={(event) =>
                  setEntryForm((prev) => ({
                    ...prev,
                    fromDate: event.target.value,
                    toDate: prev.toDate && prev.toDate < event.target.value ? event.target.value : prev.toDate,
                  }))
                }
                className="w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm"
              />
            </div>
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium text-muted-foreground">To Date</span>
            <div className="relative">
              <CalendarDays className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <input
                type="date"
                value={entryForm.toDate}
                onChange={(event) => setEntryForm((prev) => ({ ...prev, toDate: event.target.value }))}
                className="w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm"
              />
            </div>
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium text-muted-foreground">Base Capacity MW</span>
            <input
              type="number"
              min="0"
              step="0.001"
              value={entryForm.capacityMw}
              onChange={(event) => setEntryForm((prev) => ({ ...prev, capacityMw: event.target.value }))}
              placeholder="Enter MW"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium text-muted-foreground">Monthly Euro Value</span>
            <input
              type="number"
              min="0"
              step="0.001"
              value={ratePerMw}
              onChange={(event) => setRatePerMw(event.target.value)}
              placeholder="Enter monthly EUR"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </label>
          <button
            type="button"
            onClick={saveEntryRange}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Save className="h-4 w-4" />
            Save
          </button>
        </div>
        {formError && (
          <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-300">
            {formError}
          </div>
        )}
        <div className="mt-4 grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-end">
          <label className="space-y-1">
            <span className="text-sm font-medium text-muted-foreground">Selected Month</span>
            <select
              value={selectedFilterValue}
              onChange={(event) => {
                const value = event.target.value;
                if (value.startsWith('range:')) {
                  setSelectedRangeId(value.slice('range:'.length));
                  setSelectedMonth('');
                  return;
                }
                setSelectedRangeId('');
                setSelectedMonth(value);
              }}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {entryRanges.length || monthOptions.length ? (
                <>
                  {entryRanges.map((range) => (
                    <option key={range.id} value={`range:${range.id}`}>
                      {formatDate(range.fromDate)} to {formatDate(range.toDate)}
                    </option>
                  ))}
                  {monthOptions.map((month) => (
                    <option key={month} value={month}>
                      {formatMonth(month)}
                    </option>
                  ))}
                </>
              ) : (
                <option value="">No month available</option>
              )}
            </select>
          </label>
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            Monthly EUR: {formatNumber(effectiveRatePerMw)}
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Total Days Entered</div>
          <div className="mt-2 text-2xl font-semibold text-foreground">{selectedSummary.totalDays}</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Total MW</div>
          <div className="mt-2 text-2xl font-semibold text-foreground">{formatNumber(selectedSummary.totalMw)}</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Extended MW</div>
          <div className="mt-2 text-2xl font-semibold text-foreground">{formatNumber(selectedSummary.extendedMw)}</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Reduced MW</div>
          <div className="mt-2 text-2xl font-semibold text-foreground">{formatNumber(selectedSummary.reducedMw)}</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Monthly Amount EUR</div>
          <div className="mt-2 text-2xl font-semibold text-foreground">{formatNumber(selectedSummary.monthlyAmountEur)} EUR</div>
        </div>
      </section>

      <section className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="p-4 border-b border-border">
          <h2 className="text-base font-semibold text-foreground">Date-wise Entries</h2>
        </div>
        <div className="overflow-auto">
          <table className="min-w-full border-separate border-spacing-0 text-sm">
            <thead className="sticky top-0 z-10 bg-muted">
              <tr>
                <th className="border-b border-r border-border px-3 py-2 text-left font-semibold">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAllVisibleRows}
                    className="h-4 w-4"
                    title="Select visible rows"
                  />
                </th>
                <th className="border-b border-r border-border px-3 py-2 text-left font-semibold">Date</th>
                <th className="border-b border-r border-border px-3 py-2 text-left font-semibold">Type</th>
                <th className="border-b border-r border-border px-3 py-2 text-left font-semibold">Capacity MW</th>
                <th className="border-b border-r border-border px-3 py-2 text-left font-semibold">Total Capacity MW</th>
                <th className="border-b border-r border-border px-3 py-2 text-left font-semibold">Monthly Euro</th>
                <th className="border-b border-r border-border px-3 py-2 text-left font-semibold">Recurring Revenue in EUR</th>
                <th className="border-b border-border px-3 py-2 text-left font-semibold">Action</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.length ? (
                visibleRows.map((row) => (
                  <tr key={row.id} className="odd:bg-background even:bg-muted/30">
                    <td className="border-b border-r border-border px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selectedRowIds.includes(row.id)}
                        onChange={() => toggleRowSelected(row.id)}
                        className="h-4 w-4"
                      />
                    </td>
                    <td className="border-b border-r border-border px-3 py-2">
                      <input
                        type="date"
                        value={row.date || ''}
                        onChange={(event) => {
                          updateRow(row.id, 'date', event.target.value);
                          const month = getEuroMonthKey(event.target.value);
                          if (month) setSelectedMonth(month);
                        }}
                        className="w-full min-w-36 rounded-md border border-input bg-background px-2 py-1.5"
                      />
                    </td>
                    <td className="border-b border-r border-border px-3 py-2">
                      <select
                        value={row.type}
                        onChange={(event) => updateRow(row.id, 'type', event.target.value)}
                        className="w-full min-w-32 rounded-md border border-input bg-background px-2 py-1.5"
                      >
                        {EURO_ROW_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {type}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="border-b border-r border-border px-3 py-2">
                      <input
                        type="number"
                        min="0"
                        step="0.001"
                        value={rows.find((item) => item.id === row.id)?.capacityMw ?? ''}
                        onChange={(event) => updateRow(row.id, 'capacityMw', event.target.value)}
                        className="w-full min-w-28 rounded-md border border-input bg-background px-2 py-1.5"
                      />
                    </td>
                    <td className="border-b border-r border-border px-3 py-2 whitespace-nowrap">
                      {formatNumber(row.effectiveCapacityMw)} MW
                    </td>
                    <td className="border-b border-r border-border px-3 py-2 whitespace-nowrap">
                      {formatNumber(effectiveRatePerMw)} EUR/month
                    </td>
                    <td className="border-b border-r border-border px-3 py-2 whitespace-nowrap">
                      {formatNumber(calculateDailyEuroAmount(row, effectiveRatePerMw))} EUR
                    </td>
                    <td className="border-b border-border px-3 py-2">
                      <button
                        type="button"
                        onClick={() => deleteRow(row.id)}
                        className="inline-flex items-center justify-center rounded-md border border-border p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
                        title="Delete row"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                    No rows added for selected month
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="p-4 border-b border-border">
          <h2 className="text-base font-semibold text-foreground">Range-wise Summary</h2>
        </div>
        <div className="overflow-auto">
          <table className="min-w-full border-separate border-spacing-0 text-sm">
            <thead className="sticky top-0 z-10 bg-muted">
              <tr>
                <th className="border-b border-r border-border px-3 py-2 text-left font-semibold">Range</th>
                <th className="border-b border-r border-border px-3 py-2 text-left font-semibold">Days</th>
                <th className="border-b border-r border-border px-3 py-2 text-left font-semibold">Normal MW</th>
                <th className="border-b border-r border-border px-3 py-2 text-left font-semibold">Extended MW</th>
                <th className="border-b border-r border-border px-3 py-2 text-left font-semibold">Reduced MW</th>
                <th className="border-b border-r border-border px-3 py-2 text-left font-semibold">Total MW</th>
                <th className="border-b border-border px-3 py-2 text-left font-semibold">Total EUR</th>
              </tr>
            </thead>
            <tbody>
              {rangeSummary.length ? (
                <>
                  {rangeSummary.map((summary) => (
                    <tr key={summary.rangeId} className="odd:bg-background even:bg-muted/30">
                      <td className="border-b border-r border-border px-3 py-2 whitespace-nowrap">{formatSummaryRange(summary)}</td>
                      <td className="border-b border-r border-border px-3 py-2">{summary.totalDays}</td>
                      <td className="border-b border-r border-border px-3 py-2">{formatNumber(summary.normalMw)}</td>
                      <td className="border-b border-r border-border px-3 py-2">{formatNumber(summary.extendedMw)}</td>
                      <td className="border-b border-r border-border px-3 py-2">{formatNumber(summary.reducedMw)}</td>
                      <td className="border-b border-r border-border px-3 py-2">{formatNumber(summary.totalMw)}</td>
                      <td className="border-b border-border px-3 py-2">{formatNumber(summary.monthlyAmountEur)} EUR</td>
                    </tr>
                  ))}
                  <tr className="bg-muted/60 font-semibold text-foreground">
                    <td className="border-b border-r border-border px-3 py-2">Total</td>
                    <td className="border-b border-r border-border px-3 py-2" />
                    <td className="border-b border-r border-border px-3 py-2" />
                    <td className="border-b border-r border-border px-3 py-2" />
                    <td className="border-b border-r border-border px-3 py-2" />
                    <td className="border-b border-r border-border px-3 py-2" />
                    <td className="border-b border-border px-3 py-2">{formatNumber(rangeSummaryTotalEur)} EUR</td>
                  </tr>
                </>
              ) : (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                    No monthly summary available
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export default EuroManualCalculation;
