import { useEffect, useMemo, useRef, useState } from 'react';
import { Filter, ChevronDown, Upload, X, FileText, Download, BarChart3, Table, CheckCircle, Clock, Maximize2, Minimize2 } from 'lucide-react';
import createPlotlyComponent from 'react-plotly.js/factory';
import Plotly from 'plotly.js-dist-min';
import { toast } from 'sonner';
import { useTheme } from '@/app/App';
import { S3_BASE_URL } from '@/config/appConfig';

const Plot = createPlotlyComponent(Plotly);

const RAW_BASE_PREFIX = 'raw/vedanjay/GSNP/';
const GENERATED_OUTPUTS_BASE_PREFIX = 'generated/vedanjay/GSNP/outputs/';
const LEGACY_OUTPUTS_BASE_PREFIX = 'outputs/';
const GSNP_NAME = 'Globus Steel N Power (GSNP)';
const TOTAL_BLOCKS = 96;
const GSNP_INTRADAY_PREFIX = 'gsnp_dc_reg_';

function getSchedulePrefixes(date) {
  return [
    `${RAW_BASE_PREFIX}${date}/`,
    `${GENERATED_OUTPUTS_BASE_PREFIX}${date}/`,
    `${LEGACY_OUTPUTS_BASE_PREFIX}${date}/`,
  ];
}

function getIntradayPrefixes(date) {
  return [
    `${RAW_BASE_PREFIX}${date}/enercast_data/intraday/`,
    `${GENERATED_OUTPUTS_BASE_PREFIX}${date}/intraday/`,
    `${LEGACY_OUTPUTS_BASE_PREFIX}${date}/intraday/`,
    `${date}/intraday/`,
  ];
}

function getMeterPrefixes(date) {
  return [
    `${RAW_BASE_PREFIX}${date}/metered_data/`,
    `${GENERATED_OUTPUTS_BASE_PREFIX}${date}/meter/`,
    `${LEGACY_OUTPUTS_BASE_PREFIX}${date}/meter/`,
    `${date}/meter/`,
  ];
}

function isScheduleCsvKey(key) {
  const k = String(key || '').toLowerCase();
  const fileName = k.split('/').pop() || '';
  return (
    k.endsWith('.csv') &&
    !k.includes('/intraday/') &&
    (k.includes('schedule_from_') || fileName.startsWith('gsnp_dc_reg_'))
  );
}

function parseS3ListXml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  return Array.from(doc.getElementsByTagName('Contents'))
    .map((node) => ({
      key: node.getElementsByTagName('Key')[0]?.textContent || '',
      lastModified: node.getElementsByTagName('LastModified')[0]?.textContent || '',
    }))
    .filter((item) => item.key);
}

async function listS3Objects(prefix) {
  const url = `${S3_BASE_URL}/?list-type=2&prefix=${encodeURIComponent(prefix)}`;
  const xml = await fetch(url).then((r) => r.text());
  return parseS3ListXml(xml);
}

async function listS3ObjectsAcrossPrefixes(prefixes) {
  const settled = await Promise.allSettled(prefixes.map((prefix) => listS3Objects(prefix)));
  return settled
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value || []);
}

async function fetchTextFromS3(key) {
  const encodedKey = String(key || '').split('/').map((s) => encodeURIComponent(s)).join('/');
  return fetch(`${S3_BASE_URL}/${encodedKey}`).then((r) => r.text());
}

function toHeaderKey(v) {
  return String(v || '').toLowerCase().replace(/["']/g, '').replace(/[\s_-]+/g, '');
}

function parseCsvWithHeaderDetection(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return { headers: [], rows: [] };
  const headerIdx = lines.findIndex((l) => /block/i.test(l) && l.includes(','));
  const start = headerIdx >= 0 ? headerIdx : 0;

  const header1 = lines[start].split(',').map((h) => h.trim());
  const maybeHeader2 = lines[start + 1] ? lines[start + 1].split(',').map((h) => h.trim()) : [];
  const useSecondHeader = maybeHeader2.some((h) => /forecast|availability/i.test(h));

  const maxCols = Math.max(header1.length, maybeHeader2.length);
  const headers = Array.from({ length: maxCols }, (_, i) => {
    const h1 = header1[i] || '';
    const h2 = useSecondHeader ? (maybeHeader2[i] || '') : '';
    if (h1 && h2) return `${h1} ${h2}`.trim();
    return h1 || h2;
  });

  const dataStart = start + (useSecondHeader ? 2 : 1);
  const rows = lines.slice(dataStart).map((line) => line.split(',').map((v) => v.trim()));
  return { headers, rows };
}

function buildTime(block) {
  const idx = Math.max(0, Number(block) - 1);
  const hh = Math.floor((idx * 15) / 60);
  const mm = (idx * 15) % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function getCurrentIstBlock() {
  const now = new Date();
  const istNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const totalMinutes = (istNow.getHours() * 60) + istNow.getMinutes();
  const block = Math.floor(totalMinutes / 15) + 1;
  return Math.min(Math.max(block, 1), TOTAL_BLOCKS);
}

function parseSeriesMap(text, mode) {
  const { headers, rows } = parseCsvWithHeaderDetection(text);
  const normalized = headers.map(toHeaderKey);
  const blockIdx = normalized.findIndex((h) => h.includes('block'));
  const timeIdx = normalized.findIndex((h) => h.includes('time'));

  let valueIdx = -1;
  if (mode === 's3_schedule') {
    valueIdx = normalized.findIndex((h) => h.includes('algoschedule') || h.includes('scheduledmw') || h.includes('schedule'));
    if (valueIdx === -1) {
      valueIdx = normalized.findIndex((h) => h.includes('forecast'));
    }
  } else if (mode === 'intraday') {
    // Intraday must use Forecast column.
    valueIdx = normalized.findIndex((h) => h === 'forecast' || h.endsWith('forecast') || h.includes(' forecast'));
    if (valueIdx === -1) valueIdx = normalized.findIndex((h) => h.includes('intradayforecast'));
  } else {
    // Uploaded Vedanjay file also must use Forecast column.
    valueIdx = normalized.findIndex((h) => h === 'forecast' || h.endsWith('forecast') || h.includes(' forecast'));
  }

  if (valueIdx === -1 && mode === 's3_schedule') {
    valueIdx = normalized.findIndex((h, i) => i !== blockIdx && i !== timeIdx);
  }
  if (valueIdx === -1) return new Map();

  const map = new Map();
  rows.forEach((cols, i) => {
    const block = blockIdx !== -1 ? parseInt(cols[blockIdx], 10) : i + 1;
    if (!Number.isFinite(block) || block < 1 || block > TOTAL_BLOCKS) return;
    const value = parseFloat(cols[valueIdx]);
    if (!Number.isFinite(value)) return;
    map.set(block, value);
  });

  return map;
}

function parseMeterSeriesMap(text) {
  const { headers, rows } = parseCsvWithHeaderDetection(text);
  const normalized = headers.map((h) => String(h || '').toLowerCase());

  const powerIdx = normalized.findIndex((h) =>
    h.includes('active power') || h.includes('meter power') || h.includes('generation') || h.includes('kw') || h.includes('mw')
  );
  if (powerIdx === -1) return new Map();

  const powerHeader = normalized[powerIdx] || '';
  const explicitKw = powerHeader.includes('(kw)') || powerHeader.includes(' kw');
  const explicitMw = powerHeader.includes('(mw)') || powerHeader.includes(' mw');

  const parsedRaw = rows.slice(0, TOTAL_BLOCKS).map((cols) => parseFloat(cols[powerIdx]) || 0);
  const nonZero = parsedRaw.filter((v) => v > 0);
  const avg = nonZero.length ? (nonZero.reduce((a, b) => a + b, 0) / nonZero.length) : 0;
  const assumeKw = explicitKw || (!explicitMw && avg > 200);
  const factor = assumeKw ? 1 / 1000 : 1;

  const map = new Map();
  parsedRaw.forEach((v, idx) => {
    map.set(idx + 1, v * factor);
  });
  return map;
}

function formatUploadTime(date) {
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

function sortLatestFirst(items) {
  const extractRevisionNumber = (key) => {
    const fileName = (key || '').split('/').pop() || '';
    const schedMatch = fileName.match(/schedule_from_(\d+)\.csv$/i);
    if (schedMatch) return parseInt(schedMatch[1], 10);
    const trailingMatch = fileName.match(/_(\d+)(?=\.[^.]+$)/);
    return trailingMatch ? parseInt(trailingMatch[1], 10) : null;
  };

  return [...items].sort((a, b) => {
    const aRev = extractRevisionNumber(a.key);
    const bRev = extractRevisionNumber(b.key);
    if (aRev !== null && bRev !== null && bRev !== aRev) return bRev - aRev;

    const aTime = Date.parse(a.lastModified || '');
    const bTime = Date.parse(b.lastModified || '');
    const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
    if (timeDiff !== 0) return timeDiff;

    const aGenerated = String(a.key || '').toLowerCase().includes('/generated/');
    const bGenerated = String(b.key || '').toLowerCase().includes('/generated/');
    if (aGenerated !== bGenerated) return bGenerated ? 1 : -1;

    return (b.key || '').localeCompare(a.key || '');
  });
}

function pickLatestIntradayForDate(objects) {
  const csvs = objects.filter((o) => o.key.toLowerCase().endsWith('.csv'));
  if (!csvs.length) return null;

  const prioritized = csvs.filter((o) => {
    const fileName = o.key.split('/').pop()?.toLowerCase() || '';
    return fileName.startsWith(GSNP_INTRADAY_PREFIX);
  });

  return sortLatestFirst(prioritized.length ? prioritized : csvs)[0] || null;
}

export default function ScheduleComparison() {
  const { isDarkMode } = useTheme();
  const [selectedSite, setSelectedSite] = useState('');
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [showGraph, setShowGraph] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [uploadTime, setUploadTime] = useState(null);
  const [fileName, setFileName] = useState('');
  const [isGraphFullscreen, setIsGraphFullscreen] = useState(false);
  const chartContainerRef = useRef(null);

  useEffect(() => {
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement) {
        setIsGraphFullscreen(false);
      }
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const [s3ScheduleMap, setS3ScheduleMap] = useState(null);
  const [intradayMap, setIntradayMap] = useState(null);
  const [meterMap, setMeterMap] = useState(null);
  const [uploadedMap, setUploadedMap] = useState(null);

  const [s3ScheduleMeta, setS3ScheduleMeta] = useState(null);
  const [intradayMeta, setIntradayMeta] = useState(null);
  const [meterMeta, setMeterMeta] = useState(null);

  const siteOptions = ['', GSNP_NAME];

  const handleLoadData = async () => {
    if (!selectedSite) {
      toast.info('Select plant first');
      return;
    }

    setIsLoading(true);
    try {
      const [outputFlat, intradayFlat, meterFlat] = await Promise.all([
        listS3ObjectsAcrossPrefixes(getSchedulePrefixes(selectedDate)),
        listS3ObjectsAcrossPrefixes(getIntradayPrefixes(selectedDate)),
        listS3ObjectsAcrossPrefixes(getMeterPrefixes(selectedDate)),
      ]);
      const outputObjects = Array.from(new Map(outputFlat.map((o) => [o.key, o])).values());
      const intradayObjects = Array.from(new Map(intradayFlat.map((o) => [o.key, o])).values());
      const meterObjects = Array.from(new Map(meterFlat.map((o) => [o.key, o])).values());

      const scheduleCandidates = sortLatestFirst(
        outputObjects.filter((o) => isScheduleCsvKey(o.key))
      );
      const latestIntraday = pickLatestIntradayForDate(intradayObjects);
      const meterCandidates = sortLatestFirst(
        meterObjects.filter((o) => o.key.toLowerCase().endsWith('.csv'))
      );

      const latestSchedule = scheduleCandidates[0];
      const latestMeter = meterCandidates[0];

      if (!latestSchedule) {
        throw new Error('No schedule file found in S3 for selected date');
      }
      if (!latestIntraday) {
        throw new Error('No intraday file found in S3 for selected date');
      }
      if (!latestMeter) {
        throw new Error('No meter file found in S3 for selected date');
      }

      const [scheduleText, intradayText, meterText] = await Promise.all([
        fetchTextFromS3(latestSchedule.key),
        fetchTextFromS3(latestIntraday.key),
        fetchTextFromS3(latestMeter.key),
      ]);

      const parsedSchedule = parseSeriesMap(scheduleText, 's3_schedule');
      const parsedIntraday = parseSeriesMap(intradayText, 'intraday');
      const parsedMeter = parseMeterSeriesMap(meterText);
      if (!parsedIntraday.size) {
        throw new Error('Intraday Forecast column not found in latest intraday file');
      }

      setS3ScheduleMap(parsedSchedule);
      setIntradayMap(parsedIntraday);
      setMeterMap(parsedMeter);
      setS3ScheduleMeta({
        fileName: latestSchedule.key.split('/').pop(),
        lastModified: latestSchedule.lastModified,
      });
      setIntradayMeta({
        fileName: latestIntraday.key.split('/').pop(),
        lastModified: latestIntraday.lastModified,
      });
      setMeterMeta({
        fileName: latestMeter.key.split('/').pop(),
        lastModified: latestMeter.lastModified,
      });

      toast.success('Latest S3 schedule, intraday, and meter loaded');
    } catch (error) {
      console.error(error);
      setS3ScheduleMap(null);
      setIntradayMap(null);
      setMeterMap(null);
      setS3ScheduleMeta(null);
      setIntradayMeta(null);
      setMeterMeta(null);
      toast.error(error?.message || 'Failed to load S3 data');
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setIsUploading(true);
    setFileName(file.name);
    try {
      const text = await file.text();
      const parsed = parseSeriesMap(text, 'uploaded_forecast');
      if (!parsed.size) {
        throw new Error('Forecast column not found in uploaded file');
      }
      setUploadedMap(parsed);
      setUploadTime(new Date());
      toast.success('Vedanjay schedule uploaded and added to graph');
    } catch (error) {
      console.error(error);
      setUploadedMap(null);
      toast.error(error?.message || 'Failed to parse uploaded schedule');
    } finally {
      setIsUploading(false);
      event.target.value = '';
    }
  };

  const handleClear = () => {
    setS3ScheduleMap(null);
    setIntradayMap(null);
    setMeterMap(null);
    setUploadedMap(null);
    setS3ScheduleMeta(null);
    setIntradayMeta(null);
    setMeterMeta(null);
    setUploadTime(null);
    setFileName('');
    toast.success('Comparison cleared');
  };

  const rows = useMemo(() => {
    if (!s3ScheduleMap && !intradayMap && !meterMap && !uploadedMap) return [];
    const todayIst = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const isTodaySelected = selectedDate === todayIst;
    const currentIstBlock = isTodaySelected ? getCurrentIstBlock() : TOTAL_BLOCKS;

    return Array.from({ length: TOTAL_BLOCKS }, (_, i) => {
      const block = i + 1;
      const meterActual = block <= currentIstBlock ? (meterMap?.get(block) ?? 0) : null;
      return {
        block,
        time: buildTime(block),
        s3Schedule: s3ScheduleMap?.get(block) ?? 0,
        intradayForecast: intradayMap?.get(block) ?? 0,
        meterActual,
        uploadedForecast: uploadedMap?.get(block) ?? null,
      };
    });
  }, [s3ScheduleMap, intradayMap, meterMap, uploadedMap, selectedDate]);

  const plotData = useMemo(() => {
    if (!rows.length) return [];
    const base = [
      {
        x: rows.map((r) => r.block),
        y: rows.map((r) => r.s3Schedule),
        type: 'scatter',
        mode: 'lines',
        name: 'Latest S3 Schedule (MW)',
        line: { color: '#6366f1', width: 2.5 },
        hovertemplate: 'Block %{x}<br>%{y:.3f} MW<extra>Latest S3 Schedule</extra>',
      },
      {
        x: rows.map((r) => r.block),
        y: rows.map((r) => r.intradayForecast),
        type: 'scatter',
        mode: 'lines',
        name: 'Latest Intraday Forecast (MW)',
        line: { color: '#f59e0b', width: 2.5, dash: 'dot' },
        hovertemplate: 'Block %{x}<br>%{y:.3f} MW<extra>Latest Intraday Forecast</extra>',
      },
      {
        x: rows.map((r) => r.block),
        y: rows.map((r) => r.meterActual),
        type: 'scatter',
        mode: 'lines',
        name: 'Latest Meter Actual (MW)',
        line: { color: '#ef4444', width: 2.5, dash: 'dash' },
        hovertemplate: 'Block %{x}<br>%{y:.3f} MW<extra>Latest Meter Actual</extra>',
      },
    ];

    if (uploadedMap) {
      base.push({
        x: rows.map((r) => r.block),
        y: rows.map((r) => r.uploadedForecast ?? null),
        type: 'scatter',
        mode: 'lines',
        name: 'Vedanjay Uploaded Forecast (MW)',
        line: { color: '#22c55e', width: 2.5 },
        hovertemplate: 'Block %{x}<br>%{y:.3f} MW<extra>Vedanjay Uploaded Forecast</extra>',
      });
    }

    return base;
  }, [rows, uploadedMap]);

  const exportCsv = () => {
    if (!rows.length) {
      toast.info('No comparison data to export');
      return;
    }
    const csv = [
      'Block,Time,Latest S3 Schedule (MW),Latest Intraday Forecast (MW),Latest Meter Actual (MW),Vedanjay Uploaded Forecast (MW)',
      ...rows.map((r) => `${r.block},${r.time},${r.s3Schedule.toFixed(3)},${r.intradayForecast.toFixed(3)},${r.meterActual === null ? '' : r.meterActual.toFixed(3)},${r.uploadedForecast === null ? '' : r.uploadedForecast.toFixed(3)}`),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `schedule-comparison-${selectedDate}.csv`;
    link.click();
  };

  const exitGraphFullscreen = async () => {
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        // Ignore and fallback to in-page fullscreen state reset
      }
    }
    setIsGraphFullscreen(false);
  };

  const toggleGraphFullscreen = async () => {
    const container = chartContainerRef.current;
    if (!container) return;

    const nativeSupported = Boolean(document.fullscreenEnabled && container.requestFullscreen);

    if (nativeSupported) {
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
          setIsGraphFullscreen(false);
        } else {
          await container.requestFullscreen();
          setIsGraphFullscreen(true);
        }
        return;
      } catch {
        // Fallback to in-page fullscreen mode below.
      }
    }

    setIsGraphFullscreen((prev) => !prev);
  };

  return (
    <div className="flex-1 overflow-auto bg-background min-h-0">
      {isDarkMode && (
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-0 left-1/4 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl animate-pulse" />
          <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />
        </div>
      )}

      <div className="p-4 sm:p-6 lg:p-8 space-y-8 max-w-[1600px] mx-auto relative z-10">
        <div className={`relative overflow-hidden rounded-2xl border shadow-sm ${isDarkMode ? 'bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 border-slate-700/50 shadow-2xl' : 'bg-gradient-to-r from-white via-slate-50 to-emerald-50 border-border'}`}>
          <div className={`absolute inset-0 ${isDarkMode ? 'bg-gradient-to-r from-indigo-500/5 via-transparent to-purple-500/5' : 'bg-gradient-to-r from-emerald-500/5 via-transparent to-cyan-500/5'}`} />
          <div className="relative p-4 sm:p-6 lg:p-8">
            <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-6">
              <div className="flex items-start gap-5">
                <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/25">
                  <FileText className="w-7 h-7 text-white" />
                </div>
                <div>
                  <h1 className="text-3xl font-bold text-foreground mb-2 tracking-tight">Schedule Comparison</h1>
                  <p className="text-sm text-muted-foreground">Latest S3 schedule + latest intraday + latest meter first. Uploaded Vedanjay forecast overlays after successful upload.</p>
                </div>
              </div>

              <div className="flex gap-4">
                {(rows.length > 0 || uploadedMap) && (
                  <button
                    onClick={handleClear}
                    className="group relative px-6 py-3 rounded-xl bg-card hover:bg-muted border border-border transition-all duration-300 flex items-center gap-3"
                  >
                    <X className="w-5 h-5 text-muted-foreground group-hover:text-foreground transition-colors" />
                    <div className="text-left">
                      <p className="text-sm font-semibold text-foreground">Clear</p>
                      <p className="text-xs text-muted-foreground">Reset comparison</p>
                    </div>
                  </button>
                )}
                <button
                  onClick={exportCsv}
                  disabled={!rows.length}
                  className="group relative px-6 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white shadow-lg shadow-indigo-500/25 transition-all duration-300 flex items-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Download className="w-5 h-5" />
                  <div className="text-left">
                    <p className="text-sm font-semibold">Export</p>
                    <p className="text-xs text-indigo-200">Download CSV</p>
                  </div>
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 p-4 rounded-2xl bg-card border border-border backdrop-blur-sm">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Filter className="w-5 h-5" />
            <span className="text-sm font-medium">Filters:</span>
          </div>

          <div className="flex flex-wrap gap-3">
            <div className="relative">
              <select
                value={selectedSite}
                onChange={(e) => setSelectedSite(e.target.value)}
                className="px-4 py-2.5 rounded-xl bg-background border border-border text-foreground text-sm font-medium appearance-none pr-10"
              >
                <option value="">Select Plant</option>
                {siteOptions.filter(Boolean).map((site) => (
                  <option key={site} value={site}>{site}</option>
                ))}
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            </div>

            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="px-4 py-2.5 rounded-xl bg-background border border-border text-foreground text-sm font-medium"
            />

            <button
              onClick={handleLoadData}
              disabled={isLoading}
              className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white text-sm font-medium transition-all duration-300 flex items-center gap-2 disabled:opacity-50"
            >
              {isLoading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Loading...
                </>
              ) : (
                <>
                  <Filter className="w-4 h-4" />
                  Load Latest S3
                </>
              )}
            </button>

            <div className="relative">
              <input
                type="file"
                accept=".csv"
                onChange={handleFileUpload}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                disabled={isUploading}
              />
              <button
                disabled={isUploading}
                className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 text-white text-sm font-medium transition-all duration-300 flex items-center gap-2 disabled:opacity-50"
              >
                <Upload className={`w-4 h-4 ${isUploading ? 'animate-bounce' : ''}`} />
                {isUploading ? 'Uploading...' : fileName ? fileName : 'Upload Vedanjay CSV'}
              </button>
            </div>

            {uploadTime && (
              <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-background border border-border">
                <Clock className="w-4 h-4 text-emerald-400" />
                <span className="text-sm text-foreground">
                  Uploaded: <span className="text-emerald-400 font-medium">{formatUploadTime(uploadTime)}</span>
                </span>
              </div>
            )}
          </div>
        </div>

        {!rows.length && (
          <div className="rounded-2xl bg-card border border-border backdrop-blur-sm p-20">
            <div className="flex flex-col items-center gap-6">
              <div className="p-6 rounded-full bg-muted">
                <FileText className="w-16 h-16 text-muted-foreground" />
              </div>
              <div className="text-center">
                <h3 className="text-xl font-bold text-foreground mb-2">No Schedule Data Available</h3>
                <p className="text-muted-foreground max-w-md">
                  Select plant and date, then click "Load Latest S3". This shows latest day schedule, latest intraday, and latest meter from S3 first.
                </p>
              </div>
              <div className="flex items-center gap-4 text-sm text-muted-foreground">
                <div className="flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 text-emerald-500" />
                  <span>Block-wise (1-96)</span>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 text-emerald-500" />
                  <span>Plotly graph with legend + hover</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {rows.length > 0 && (
          <div className="rounded-2xl bg-card border border-border backdrop-blur-sm overflow-hidden">
            <div className="p-6 border-b border-border bg-muted/50">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-xl bg-indigo-500/10">
                    <Table className="w-6 h-6 text-indigo-400" />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-foreground">Comparison Details</h3>
                    <p className="text-sm text-muted-foreground mt-1">{selectedSite} - {selectedDate} - 96 x 15-minute blocks</p>
                    {s3ScheduleMeta && (
                      <p className="text-xs text-muted-foreground mt-1">Latest S3 Schedule: {s3ScheduleMeta.fileName}</p>
                    )}
                    {intradayMeta && (
                      <p className="text-xs text-muted-foreground mt-1">Latest Intraday: {intradayMeta.fileName}</p>
                    )}
                    {meterMeta && (
                      <p className="text-xs text-muted-foreground mt-1">Latest Meter: {meterMeta.fileName}</p>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setShowGraph(false);
                      exitGraphFullscreen();
                    }}
                    className={`relative px-4 py-2 text-sm font-semibold rounded-xl transition-all duration-300 ${!showGraph ? 'text-white' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
                  >
                    {!showGraph && <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 shadow-lg shadow-indigo-500/25" />}
                    <span className="relative z-10 flex items-center gap-2"><Table className="w-4 h-4" /> Table</span>
                  </button>
                  <button
                    onClick={() => setShowGraph(true)}
                    className={`relative px-4 py-2 text-sm font-semibold rounded-xl transition-all duration-300 ${showGraph ? 'text-white' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
                  >
                    {showGraph && <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 shadow-lg shadow-indigo-500/25" />}
                    <span className="relative z-10 flex items-center gap-2"><BarChart3 className="w-4 h-4" /> Graph</span>
                  </button>
                  <button
                    onClick={toggleGraphFullscreen}
                    disabled={!showGraph}
                    className="relative px-4 py-2 text-sm font-semibold rounded-xl transition-all duration-300 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                    title={isGraphFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                  >
                    <span className="relative z-10 flex items-center gap-2">
                      {isGraphFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                      {isGraphFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
                    </span>
                  </button>
                </div>
              </div>
            </div>

            {!showGraph ? (
              <div className="overflow-x-auto max-h-[550px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-muted border-b border-border z-10">
                    <tr>
                      {['Block', 'Time', 'Latest S3 Schedule (MW)', 'Latest Intraday Forecast (MW)', 'Latest Meter Actual (MW)', 'Vedanjay Uploaded Forecast (MW)'].map((header) => (
                        <th key={header} className="px-4 py-3 text-left text-xs font-semibold text-foreground uppercase tracking-wider">{header}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rows.map((row) => (
                      <tr key={row.block} className="hover:bg-muted/50 transition-all duration-150">
                        <td className="px-4 py-2.5 text-foreground font-medium">{row.block}</td>
                        <td className="px-4 py-2.5 text-muted-foreground">{row.time}</td>
                        <td className="px-4 py-2.5 text-indigo-600">{row.s3Schedule.toFixed(3)}</td>
                        <td className="px-4 py-2.5 text-amber-600">{row.intradayForecast.toFixed(3)}</td>
                  <td className="px-4 py-2.5 text-red-600">{row.meterActual === null ? '--' : row.meterActual.toFixed(3)}</td>
                        <td className="px-4 py-2.5 text-emerald-700">{row.uploadedForecast === null ? '-' : row.uploadedForecast.toFixed(3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div
                ref={chartContainerRef}
                className={isGraphFullscreen ? 'fixed inset-0 z-50 bg-background p-4 sm:p-6' : 'p-6'}
              >
                <div className={`${isGraphFullscreen ? 'h-[calc(100vh-2rem)] sm:h-[calc(100vh-3rem)]' : 'h-[500px]'} bg-background rounded-xl border border-border p-4`}>
                  <Plot
                    data={plotData}
                    layout={{
                      margin: { l: 70, r: 20, t: 20, b: 60 },
                      paper_bgcolor: isDarkMode ? 'rgba(0,0,0,0)' : '#ffffff',
                      plot_bgcolor: isDarkMode ? 'rgba(0,0,0,0)' : '#ffffff',
                      font: { color: isDarkMode ? '#cbd5e1' : '#1f2937', size: 12 },
                      xaxis: {
                        title: 'Block No',
                        tickvals: [1, 12, 24, 36, 48, 60, 72, 84, 96],
                        gridcolor: isDarkMode ? 'rgba(148,163,184,0.2)' : 'rgba(100,116,139,0.22)',
                      },
                      yaxis: {
                        title: 'Power (MW)',
                        gridcolor: isDarkMode ? 'rgba(148,163,184,0.2)' : 'rgba(100,116,139,0.22)',
                      },
                      hovermode: 'x unified',
                      legend: {
                        orientation: 'h',
                        x: 0,
                        y: 1.1,
                        bgcolor: isDarkMode ? 'rgba(0,0,0,0)' : 'rgba(255,255,255,0.9)',
                        font: { color: isDarkMode ? '#cbd5e1' : '#1f2937' },
                      },
                      hoverlabel: {
                        bgcolor: isDarkMode ? '#1f2937' : '#ffffff',
                        bordercolor: isDarkMode ? '#334155' : '#cbd5e1',
                        font: { color: isDarkMode ? '#e2e8f0' : '#0f172a' },
                      },
                    }}
                    config={{ displayModeBar: false, responsive: true }}
                    style={{ width: '100%', height: '100%' }}
                    useResizeHandler
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
