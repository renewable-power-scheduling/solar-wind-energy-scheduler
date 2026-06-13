import { useEffect, useMemo, useState } from 'react';
import { Download, FileText, Loader2, X } from 'lucide-react';
import { allPlantPenaltyApi, resolvePenaltyDownloadUrl } from '@/services/allPlantPenaltyApi';

const today = () => new Date().toISOString().slice(0, 10);

export default function AllPlantPenaltyReportDialog({ open, onClose, currentUser, defaultDate }) {
  const [reportType, setReportType] = useState('Daily');
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [format, setFormat] = useState('Both');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!open) return;
    setError('');
    setResult(null);
    if (defaultDate) {
      setStartDate(defaultDate);
      setEndDate(defaultDate);
    }
  }, [defaultDate, open]);

  useEffect(() => {
    if (!startDate || reportType === 'Daily') {
      setEndDate(startDate);
      return;
    }
    const start = new Date(`${startDate}T00:00:00`);
    if (reportType === 'Weekly') {
      start.setDate(start.getDate() + 6);
    } else {
      start.setMonth(start.getMonth() + 1, 0);
    }
    setEndDate(start.toISOString().slice(0, 10));
  }, [reportType, startDate]);

  const effectiveEndDate = useMemo(
    () => (reportType === 'Daily' ? startDate : endDate),
    [endDate, reportType, startDate]
  );

  if (!open) return null;

  const handleGenerate = async () => {
    setError('');
    setResult(null);
    if (!startDate || !effectiveEndDate) {
      setError('Select a valid report date range.');
      return;
    }
    if (effectiveEndDate < startDate) {
      setError('End date must be on or after start date.');
      return;
    }
    setIsGenerating(true);
    try {
      const formats = format === 'Both' ? ['WORD', 'PDF'] : [format.toUpperCase()];
      const response = await allPlantPenaltyApi.generateReport({
        report_type: reportType,
        start_date: startDate,
        end_date: effectiveEndDate,
        formats,
        include_block_details: false,
        requested_by: currentUser?.empId || currentUser?.username || currentUser?.name || 'Unknown',
      });
      setResult(response);
    } catch (generationError) {
      setError(generationError?.message || 'Report generation failed.');
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-4">
      <div className="w-full max-w-xl rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Generate All Plant Penalty Report</h2>
            <p className="text-xs text-muted-foreground">Uses penalty values already saved from the Comparison screen.</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-foreground">Report type</span>
            <select value={reportType} onChange={(event) => setReportType(event.target.value)} className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-foreground">
              <option>Daily</option>
              <option>Weekly</option>
              <option>Monthly</option>
            </select>
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-foreground">{reportType === 'Daily' ? 'Date' : 'Start date'}</span>
              <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-foreground" />
            </label>
            {reportType !== 'Daily' && (
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-foreground">End date</span>
                <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-foreground" />
              </label>
            )}
          </div>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-foreground">Format</span>
            <select value={format} onChange={(event) => setFormat(event.target.value)} className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-foreground">
              <option>Word</option>
              <option>PDF</option>
              <option>Both</option>
            </select>
          </label>

          {error && <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

          {result?.status === 'Ready' && (
            <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-emerald-800">
                <FileText className="h-4 w-4" />
                Report generated and stored in PostgreSQL
              </div>
              <div className="flex flex-wrap gap-2">
                {result.downloads?.word && (
                  <a href={resolvePenaltyDownloadUrl(result.downloads.word)} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500">
                    <Download className="h-4 w-4" /> Download Word
                  </a>
                )}
                {result.downloads?.pdf && (
                  <a href={resolvePenaltyDownloadUrl(result.downloads.pdf)} className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-500">
                    <Download className="h-4 w-4" /> Download PDF
                  </a>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 border-t border-border px-5 py-4">
          <button onClick={onClose} className="rounded-xl border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted">Close</button>
          <button onClick={handleGenerate} disabled={isGenerating} className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
            {isGenerating && <Loader2 className="h-4 w-4 animate-spin" />}
            {isGenerating ? 'Generating...' : 'Generate Report'}
          </button>
        </div>
      </div>
    </div>
  );
}
