import { useState, useMemo, useEffect } from 'react';
import createPlotlyComponent from 'react-plotly.js/factory';
import Plotly from 'plotly.js-dist-min';
import {
  Save,
  Download,
  CheckCircle,
  AlertTriangle,
  Edit3,
  Calendar,
  Wind,
  TrendingUp,
  Clock,
  FileText,
  RefreshCw,
  Upload,
  AlertCircle,
  Layers,
  Activity,
  BarChart2,
  ExternalLink,
  X,
} from 'lucide-react';
import { api } from '@/services/api';
import { useApi } from '@/hooks/useApi';
import { LoadingSpinner } from '@/app/components/common/LoadingSpinner';
import { useTheme } from '@/app/App';
import { toast } from 'sonner';
import { S3_BASE_URL } from '@/config/appConfig';

const Plot = createPlotlyComponent(Plotly);

// =============================================================================
// S3 CONFIG
// =============================================================================
const RAW_BASE_PREFIX = 'raw/vedanjay/GSNP/';
const GENERATED_OUTPUTS_BASE_PREFIX = 'generated/vedanjay/GSNP/outputs/';
const LEGACY_OUTPUTS_BASE_PREFIX = 'outputs/';
const GSNP_INTRADAY_PREFIX = 'gsnp_dc_reg_';

const S3_ONLY_PLANT = {
  id: 1,
  name: 'Globus Steel N Power (GSNP)',
  state: 'Madhya Pradesh',
  type: 'Solar',
};

// =============================================================================
// S3 HELPERS
// =============================================================================
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

function mergeUniqueObjects(objectSets) {
  return Array.from(new Map(objectSets.flat().map((o) => [o.key, o])).values());
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

function getLatestObject(objects, matcher) {
  const extractTrailingNumber = (key) => {
    const fileName = (key || '').split('/').pop() || '';
    const match = fileName.match(/_(\d+)(?=\.[^.]+$)/);
    return match ? parseInt(match[1], 10) : null;
  };

  const compareNewestFirst = (a, b) => {
    const aSeq = extractTrailingNumber(a.key);
    const bSeq = extractTrailingNumber(b.key);
    if (aSeq !== null && bSeq !== null && bSeq !== aSeq) return bSeq - aSeq;

    const aTime = Date.parse(a.lastModified || '');
    const bTime = Date.parse(b.lastModified || '');
    const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
    if (timeDiff !== 0) return timeDiff;

    return (b.key || '').localeCompare(a.key || '');
  };

  return (
    objects
      .filter((o) => matcher(o.key))
      .sort(compareNewestFirst)[0] || null
  );
}

function sortLatestFirst(items) {
  const extractTrailingNumber = (key) => {
    const fileName = (key || '').split('/').pop() || '';
    const match = fileName.match(/_(\d+)(?=\.[^.]+$)/);
    return match ? parseInt(match[1], 10) : null;
  };

  return [...items].sort((a, b) => {
    const aSeq = extractTrailingNumber(a.key);
    const bSeq = extractTrailingNumber(b.key);
    if (aSeq !== null && bSeq !== null && bSeq !== aSeq) return bSeq - aSeq;

    const aTime = Date.parse(a.lastModified || '');
    const bTime = Date.parse(b.lastModified || '');
    const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
    if (timeDiff !== 0) return timeDiff;
    return (b.key || '').localeCompare(a.key || '');
  });
}

function findLatestCsvByKeywords(objects, requiredKeywords = []) {
  const lowered = requiredKeywords.map((k) => String(k).toLowerCase());
  return getLatestObject(objects, (key) => {
    const k = key.toLowerCase();
    if (!k.endsWith('.csv')) return false;
    return lowered.every((kw) => k.includes(kw));
  });
}

function findLatestIntradayCsv(objects) {
  return (
    getLatestObject(
      objects,
      (key) => key.toLowerCase().endsWith('.csv') && key.toLowerCase().includes('/intraday/')
    ) ||
    findLatestCsvByKeywords(objects, ['intraday']) ||
    findLatestCsvByKeywords(objects, ['forecast', 'intraday'])
  );
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

function findLatestMeterCsv(objects) {
  return (
    getLatestObject(
      objects,
      (key) => key.toLowerCase().endsWith('.csv') && key.toLowerCase().includes('/meter/')
    ) ||
    findLatestCsvByKeywords(objects, ['meter']) ||
    findLatestCsvByKeywords(objects, ['generation'])
  );
}

// =============================================================================
// CSV PARSER — maps columns from schedule_from_XX.csv
// =============================================================================
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line && line.trim().length > 0);
  if (!lines.length) return { headers: [], rows: [] };
  const delimiterCandidates = [',', ';', '\t'];
  const headerLine = lines[0];
  const delimiter = delimiterCandidates.reduce((best, candidate) => {
    const count = headerLine.split(candidate).length - 1;
    return count > best.count ? { value: candidate, count } : best;
  }, { value: ',', count: -1 }).value;

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

  const headers = parseLine(lines[0]).map((h) => h.replace(/^\uFEFF/, '').trim());
  const rows = lines.slice(1).map(parseLine);
  return { headers, rows };
}

function toFixed3(value) {
  const num = parseFloat(value);
  return isNaN(num) ? '0.000' : num.toFixed(3);
}

function blockToTime(block) {
  const idx = Math.max(0, parseInt(block, 10) - 1);
  const h = Math.floor((idx * 15) / 60);
  const m = (idx * 15) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Parses the schedule_from_XX.csv produced by lambda_engine.py.
 * Expected columns: block, timestamp, algo_schedule_mw, condition_used,
 *                   BaseForecast, IntradayForecast_mw
 */
function parseScheduleCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line && line.trim().length > 0);
  if (!lines.length) return [];

  // Find real header row (supports files with meta lines before headers).
  const headerIdx = lines.findIndex((line) => {
    const l = String(line || '').toLowerCase();
    return l.includes('block') && (l.includes('schedule') || l.includes('forecast') || l.includes('timestamp'));
  });

  const csvTextFromHeader = headerIdx > 0 ? lines.slice(headerIdx).join('\n') : text;
  const { headers, rows } = parseCsv(csvTextFromHeader);
  if (!headers.length) return [];

  const normalized = headers.map((h) =>
    h.toLowerCase().replace(/["']/g, '').replace(/[\s_-]+/g, '')
  );
  const findCol = (matchers) =>
    normalized.findIndex((h) => matchers.some((m) => h.includes(m)));

  const blockCol = findCol(['block', 'blockno']);
  const algoCol = findCol([
    'algoschedulemw',
    'algoschedule',
    'systemschedule',
    'finalschedule',
    'schedule',
    'scheduledmw',
    'scheduled',
  ]);
  const baseCol = findCol(['baseforecastmw', 'baseforecast', 'base']);
  const intradayCol = findCol(['intradayforecastmw', 'intradayforecast', 'intraday']);
  const condCol = findCol(['conditionused', 'condition', 'triggerreason']);

  const toScheduleRows = (inputRows) =>
    inputRows
      .filter((cols) => cols.length > 1)
      .map((cols) => {
        const block = blockCol >= 0 ? cols[blockCol] : '';
        const algoValue = algoCol >= 0 ? cols[algoCol] : '';
        const baseValue = baseCol >= 0 ? cols[baseCol] : '';
        const intradayValue = intradayCol >= 0 ? cols[intradayCol] : '';
        const conditionValue = condCol >= 0 ? cols[condCol] : '';
        return {
          block: parseInt(block, 10) || 0,
          time: blockToTime(block),
          algo: toFixed3(algoValue),
          base: toFixed3(baseValue),
          intraday: toFixed3(intradayValue),
          condition: conditionValue || 'NONE',
        };
      })
      .filter((r) => r.block > 0);

  const parsed = toScheduleRows(rows);
  if (parsed.length) return parsed;

  // Fallback: handle GSNP intraday-style files by mapping forecast into schedule fields.
  const intradayRows = parseForecastIntradayCsv(csvTextFromHeader);
  return intradayRows.map((r) => ({
    block: r.block,
    time: blockToTime(r.block),
    algo: toFixed3(r.forecast),
    base: '0.000',
    intraday: toFixed3(r.forecast),
    condition: 'AUTO_FALLBACK',
  }));
}

function parseForecastIntradayCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return [];

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

  const normalized = headers.map((h) =>
    String(h || '').toLowerCase().replace(/["']/g, '').replace(/[\s_-]+/g, '')
  );
  const blockIdx = normalized.findIndex((h) => h.includes('block'));
  let forecastIdx = normalized.findIndex((h) => h === 'forecast' || h.endsWith('forecast') || h.includes('forecast'));
  if (forecastIdx === -1) {
    forecastIdx = normalized.findIndex((h) => h.includes('intradayforecast'));
  }
  if (blockIdx === -1 || forecastIdx === -1) return [];

  const dataStart = start + (useSecondHeader ? 2 : 1);
  const rows = lines.slice(dataStart).map((line) => line.split(',').map((v) => v.trim()));

  return rows
    .map((cols) => ({
      block: parseInt(cols[blockIdx], 10),
      forecast: parseFloat(cols[forecastIdx]),
    }))
    .filter((r) => Number.isFinite(r.block) && r.block >= 1 && r.block <= 96 && Number.isFinite(r.forecast));
}

function parseMeterCsvByBlock(text) {
  const { headers, rows } = parseCsv(text);
  const normalizedHeaders = headers.map((h) => h.trim().toLowerCase());
  const powerIdx = normalizedHeaders.findIndex((h) =>
    h.includes('active power-avg mfm-out(meter power)') ||
    h.includes('meter power') ||
    h.includes('active power') ||
    h.includes('generation') ||
    h === 'mw' ||
    h.endsWith('(kw)') ||
    h.includes('kw')
  );
  if (powerIdx === -1) return [];

  return rows
    .slice(0, 96)
    .map((cols, idx) => {
      const mw = (parseFloat(cols[powerIdx]) || 0) / 1000;
      return { block: idx + 1, generationMw: mw };
    });
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================
export function SchedulePreparation({ onNavigate, context, filters }) {
  const { isDarkMode } = useTheme();
  // ── Modal states ────────────────────────────────────────────────────────
  const [showExportModal,     setShowExportModal]     = useState(false);
  const [showValidationModal, setShowValidationModal] = useState(false);
  const [showSaveModal,       setShowSaveModal]       = useState(false);
  const [showDeleteModal,     setShowDeleteModal]     = useState(false);
  const [showEditModal,       setShowEditModal]       = useState(false);
  const [showSubmitModal,     setShowSubmitModal]     = useState(false);

  // ── Data states ──────────────────────────────────────────────────────────
  const [editingCell,         setEditingCell]         = useState(null);
  const [scheduleData,        setScheduleData]        = useState([]);
  const [currentScheduleId,   setCurrentScheduleId]   = useState(null);
  const [validationErrors,    setValidationErrors]    = useState([]);
  const [changes,             setChanges]             = useState([]);
  const [isDataLoaded,        setIsDataLoaded]        = useState(false);
  const [loadedScheduleInfo,  setLoadedScheduleInfo]  = useState(null);
  const [loadingData,         setLoadingData]         = useState(false);
  const [loadError,           setLoadError]           = useState(null);

  // ── Graph states ─────────────────────────────────────────────────────────
  const [graphLoading,        setGraphLoading]        = useState(false);
  const [graphError,          setGraphError]          = useState(null);
  const [showGraphModal,      setShowGraphModal]      = useState(false);
  const [intradayCurve,       setIntradayCurve]       = useState([]);
  const [meterCurve,          setMeterCurve]          = useState([]);

  // ── Filter states ────────────────────────────────────────────────────────
  const [selectedState, setSelectedState] = useState(filters?.state || S3_ONLY_PLANT.state);
  const [selectedPlant, setSelectedPlant] = useState(filters?.plant || S3_ONLY_PLANT.name);
  const [selectedDate,  setSelectedDate]  = useState(
    filters?.date || new Date().toISOString().split('T')[0]
  );

  const fromDashboard = context?.fromDashboard;

  // ── Available plants ─────────────────────────────────────────────────────
  const availablePlants = useMemo(() => {
    if (selectedState === 'Select State') return ['Select Plant'];
    if (selectedState !== S3_ONLY_PLANT.state) return ['Select Plant'];
    return ['Select Plant', S3_ONLY_PLANT.name];
  }, [selectedState]);

  const handleStateChange = (state) => {
    setSelectedState(state);
    setSelectedPlant('Select Plant');
  };

  const handlePlantChange = (plant) => {
    setSelectedPlant(plant);
    if (plant === S3_ONLY_PLANT.name) {
      setSelectedState(S3_ONLY_PLANT.state);
    }
  };

  // ==========================================================================
  // LOAD DATA FROM S3
  // ==========================================================================
  const handleLoadData = async (dateOverride) => {
    if (selectedState === 'Select State' || selectedPlant === 'Select Plant') {
      toast.error('Please select both State and Plant to load data');
      return;
    }
    if (selectedPlant === S3_ONLY_PLANT.name && selectedState !== S3_ONLY_PLANT.state) {
      toast.error(`Selected plant is in ${S3_ONLY_PLANT.state}. Please select the correct state.`);
      return;
    }

    const targetDate = typeof dateOverride === 'string'
      ? dateOverride
      : dateOverride instanceof Date
        ? dateOverride.toISOString().split('T')[0]
        : selectedDate;

    setLoadingData(true);
    setLoadError(null);
    setIsDataLoaded(false);
    setScheduleData([]);
    setGraphError(null);
    setIntradayCurve([]);
    setMeterCurve([]);

    try {
      const scheduleObjectsFlat = await listS3ObjectsAcrossPrefixes(getSchedulePrefixes(targetDate));
      const objects = mergeUniqueObjects([scheduleObjectsFlat]);

      if (!objects.length) {
        throw new Error(`No files found in S3 for date: ${targetDate}`);
      }

      // ── 1. Load schedule CSV ─────────────────────────────────────────────
      const scheduleFiles = objects.filter((o) => isScheduleCsvKey(o.key));
      const requestedFile = context?.fileName
        ? scheduleFiles.find((o) => o.key.endsWith(`/${context.fileName}`) || o.key.endsWith(context.fileName))
        : null;
      const latestSchedule = requestedFile || getLatestObject(objects, (key) => isScheduleCsvKey(key));

      if (!latestSchedule) {
        throw new Error(`No schedule CSV found for ${targetDate}`);
      }

      const csvUrl  = `${S3_BASE_URL}/${String(latestSchedule.key || '').split('/').map((s) => encodeURIComponent(s)).join('/')}`;
      const csvText = await fetch(csvUrl).then((r) => {
        if (!r.ok) throw new Error(`Failed to fetch CSV: ${r.status}`);
        return r.text();
      });

      const parsed = parseScheduleCsv(csvText);
      if (!parsed.length) {
        throw new Error('Schedule CSV parsed but returned no valid rows');
      }

      setScheduleData(parsed);
      setIsDataLoaded(true);
      setCurrentScheduleId(null);
      setSelectedDate(targetDate);
      setLoadedScheduleInfo({
        state:    selectedState,
        plant:    S3_ONLY_PLANT.name,
        date:     targetDate,
        fileName: latestSchedule.key.split('/').pop(),
        source:   'S3',
      });

      // ── 2. Load latest intraday + meter curves for Plotly ───────────────
      setGraphLoading(true);
      const curveWarnings = [];

      try {
        // Use latest intraday from date-root path (same logic as Schedule Comparison).
        const intradayObjectsFlat = await listS3ObjectsAcrossPrefixes(getIntradayPrefixes(targetDate));
        const intradayObjectsMerged = mergeUniqueObjects([intradayObjectsFlat]);
        const intradayObjectsRoot = intradayObjectsMerged;
        const intradayObjectsOutputs = intradayObjectsMerged;
        const latestIntraday =
          pickLatestIntradayForDate(intradayObjectsRoot) ||
          pickLatestIntradayForDate(intradayObjectsOutputs) ||
          findLatestIntradayCsv(intradayObjectsRoot) ||
          findLatestIntradayCsv(intradayObjectsOutputs) ||
          findLatestIntradayCsv(objects);

        if (latestIntraday) {
          const intradayUrl = `${S3_BASE_URL}/${String(latestIntraday.key || '').split('/').map((s) => encodeURIComponent(s)).join('/')}`;
          const intradayText = await fetch(intradayUrl).then((r) => {
            if (!r.ok) throw new Error(`Intraday fetch failed: ${r.status}`);
            return r.text();
          });
          const parsedIntraday = parseForecastIntradayCsv(intradayText);
          if (!parsedIntraday.length) {
            throw new Error('Forecast column not found in latest intraday CSV');
          }
          setIntradayCurve(parsedIntraday);
        }
      } catch {
        // Ignore intraday curve load warning in UI
      }

      try {
        // Always use latest updated meter CSV by LastModified.
        const meterObjectsFlat = await listS3ObjectsAcrossPrefixes(getMeterPrefixes(targetDate));
        const meterObjects = mergeUniqueObjects([meterObjectsFlat]);
        const meterObjectsOutputs = meterObjects;
        const meterObject = findLatestMeterCsv(meterObjects) || findLatestMeterCsv(objects);
        const meterObjectFallback = meterObject || findLatestMeterCsv(meterObjectsOutputs);

        if (!meterObjectFallback) {
          throw new Error('Meter CSV not found');
        }

        const meterUrl = `${S3_BASE_URL}/${String(meterObjectFallback.key || '').split('/').map((s) => encodeURIComponent(s)).join('/')}`;
        const meterText = await fetch(meterUrl).then((r) => {
          if (!r.ok) throw new Error(`Meter fetch failed: ${r.status}`);
          return r.text();
        });
        const parsedMeter = parseMeterCsvByBlock(meterText);
        setMeterCurve(parsedMeter);
      } catch {
        // Ignore meter curve load warning in UI
      }

      setGraphError(curveWarnings.length ? curveWarnings.join(' • ') : null);
      setGraphLoading(false);

      toast.success(`Schedule loaded: ${latestSchedule.key.split('/').pop()}`);
    } catch (err) {
      setLoadError(err.message);
      toast.error(err.message);
    } finally {
      setLoadingData(false);
    }
  };

  // Auto-load when navigated from Dashboard
  useEffect(() => {
    if (fromDashboard && context?.plant) {
      const dashboardDate = context?.date || selectedDate;
      setSelectedState(S3_ONLY_PLANT.state);
      setSelectedPlant(S3_ONLY_PLANT.name);
      setSelectedDate(dashboardDate);
      handleLoadData(dashboardDate);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromDashboard]);

  // ==========================================================================
  // API HOOKS
  // ==========================================================================
  const { loading: createLoading, execute: createSchedule } = useApi(
    api.schedules.create,
    {
      onSuccess: () => { setShowSaveModal(false); toast.success('Schedule saved!'); },
      onError: (e) => toast.error(`Save failed: ${e.message}`),
    }
  );

  const { loading: updateLoading, execute: updateSchedule } = useApi(
    api.schedules.update,
    {
      onSuccess: () => { setShowEditModal(false); toast.success('Schedule updated!'); },
      onError: (e) => toast.error(`Update failed: ${e.message}`),
    }
  );

  const { loading: deleteLoading, execute: deleteSchedule } = useApi(
    api.schedules.delete,
    {
      onSuccess: () => {
        setShowDeleteModal(false);
        setScheduleData([]);
        setIsDataLoaded(false);
        toast.success('Schedule deleted');
      },
      onError: (e) => toast.error(`Delete failed: ${e.message}`),
    }
  );

  const { loading: submitLoading, execute: submitScheduleData } = useApi(
    api.schedules.submit,
    {
      onSuccess: () => {
        setShowSubmitModal(false);
        toast.success('Schedule submitted!');
        onNavigate('dashboard');
      },
      onError: (e) => toast.error(`Submit failed: ${e.message}`),
    }
  );


  // ==========================================================================
  // HANDLERS
  // ==========================================================================
  const validateScheduleData = () => {
    const errors = [];
    if (scheduleData.length === 0) errors.push('No schedule data loaded');
    scheduleData.forEach((row) => {
      const v = parseFloat(row.algo);
      if (isNaN(v) || v < 0) errors.push(`Invalid value at ${row.time}`);
      if (v > 1000) errors.push(`Value too high at ${row.time} (max 1000 MW)`);
    });
    return errors;
  };

  const handleSaveSchedule = async () => {
    const errors = validateScheduleData();
    if (errors.length > 0) {
      setValidationErrors(errors);
      setShowValidationModal(true);
      return;
    }
    const blockData = {};
    scheduleData.forEach((row, i) => {
      blockData[`block_${row.block}`] = {
        block: row.block,
        time: row.time,
        forecasted: parseFloat(row.intraday) || 0,
        actual: 0,
        scheduled: parseFloat(row.algo) || 0,
      };
    });
    const payload = {
      plantName: selectedPlant,
      scheduleDate: selectedDate,
      status: 'Pending',
      blockData,
    };
    if (currentScheduleId) {
      await updateSchedule(currentScheduleId, payload);
    } else {
      await createSchedule(payload);
    }
  };

  const handleDeleteSchedule = async () => {
    if (currentScheduleId) {
      await deleteSchedule(currentScheduleId);
    } else {
      setScheduleData([]);
      setIsDataLoaded(false);
      setShowDeleteModal(false);
    }
  };

  const handleSubmitToDatabase = async () => {
    await submitScheduleData({
      plantName: loadedScheduleInfo?.plant,
      scheduleDate: selectedDate,
      status: 'Submitted',
      scheduleData,
    });
  };

  // Upload CSV handler removed

  const handleExportCsv = () => {
    if (!scheduleData.length) { toast.error('No data to export'); return; }
    const headers = ['Block', 'Time', 'Algo Schedule (MW)', 'Base Forecast (MW)', 'Intraday Forecast (MW)', 'Condition'];
    const rows = scheduleData.map((r) =>
      [r.block, r.time, r.algo, r.base, r.intraday, r.condition].join(',')
    );
    const blob = new Blob([[headers.join(','), ...rows].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `schedule-${loadedScheduleInfo?.date || selectedDate}.csv`;
    a.click();
    setShowExportModal(false);
  };

  const plotSeries = useMemo(() => {
    const blocks = Array.from({ length: 96 }, (_, i) => i + 1);
    const toNumOrNull = (value) => {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };
    const scheduleMap = new Map(scheduleData.map((r) => [r.block, toNumOrNull(r.algo)]));
    const intradayMap = new Map(intradayCurve.map((r) => [r.block, toNumOrNull(r.forecast)]));
    const meterMap = new Map(meterCurve.map((r) => [r.block, toNumOrNull(r.generationMw)]));
    const times = blocks.map((b) => blockToTime(b));
    return {
      blocks,
      times,
      systemSchedule: blocks.map((b) => (scheduleMap.has(b) ? scheduleMap.get(b) : null)),
      intradayForecast: blocks.map((b) => (intradayMap.has(b) ? intradayMap.get(b) : null)),
      actualMetered: blocks.map((b) => (meterMap.has(b) ? meterMap.get(b) : null)),
    };
  }, [scheduleData, intradayCurve, meterCurve]);

  const plotLayout = useMemo(() => {
    return {
      margin: { l: 50, r: 20, t: 20, b: 40 },
      paper_bgcolor: isDarkMode ? 'rgba(0,0,0,0)' : '#ffffff',
      plot_bgcolor: isDarkMode ? 'rgba(0,0,0,0)' : '#ffffff',
      font: { color: isDarkMode ? '#cbd5e1' : '#1f2937', size: 11 },
      xaxis: {
        title: 'Block No',
        tickmode: 'linear',
        tick0: 1,
        dtick: 12,
        range: [1, 96],
        gridcolor: isDarkMode ? 'rgba(148,163,184,0.2)' : 'rgba(100,116,139,0.22)'
      },
      yaxis: {
        title: 'Power (MW)',
        gridcolor: isDarkMode ? 'rgba(148,163,184,0.2)' : 'rgba(100,116,139,0.22)'
      },
      hovermode: 'x unified',
      hoverlabel: {
        bgcolor: isDarkMode ? '#1f2937' : '#ffffff',
        bordercolor: isDarkMode ? '#334155' : '#94a3b8',
        font: { color: isDarkMode ? '#e2e8f0' : '#0f172a', size: 12 }
      },
      legend: {
        orientation: 'h',
        x: 0,
        y: 1.1,
        bgcolor: isDarkMode ? 'rgba(0,0,0,0)' : 'rgba(255,255,255,0.92)',
        font: { color: isDarkMode ? '#cbd5e1' : '#1f2937' },
      }
    };
  }, [isDarkMode]);

  const plotData = useMemo(() => ([
    {
      x: plotSeries.blocks,
      y: plotSeries.systemSchedule,
      customdata: plotSeries.times,
      type: 'scatter',
      mode: 'lines',
      name: 'Latest Algo Schedule (MW)',
      line: { color: '#6366f1', width: 2.5 },
      hovertemplate: '<b>Block %{x}</b><br>Time %{customdata}<br>Algo Schedule: %{y:.3f} MW<extra></extra>',
      connectgaps: false
    },
    {
      x: plotSeries.blocks,
      y: plotSeries.intradayForecast,
      customdata: plotSeries.times,
      type: 'scatter',
      mode: 'lines',
      name: 'Latest Intraday Forecast (MW)',
      line: { color: '#f59e0b', width: 2.5, dash: 'dot' },
      hovertemplate: '<b>Block %{x}</b><br>Time %{customdata}<br>Intraday: %{y:.3f} MW<extra></extra>',
      connectgaps: false
    },
    {
      x: plotSeries.blocks,
      y: plotSeries.actualMetered,
      customdata: plotSeries.times,
      type: 'scatter',
      mode: 'lines',
      name: 'Latest Meter Actual (MW)',
      line: { color: '#ef4444', width: 2.5, dash: 'dash' },
      hovertemplate: '<b>Block %{x}</b><br>Time %{customdata}<br>Meter: %{y:.3f} MW<extra></extra>',
      connectgaps: false
    }
  ]), [plotSeries]);

  // ==========================================================================
  // RENDER
  // ==========================================================================
  return (
    <>
      <div className="flex-1 overflow-auto bg-slate-950 min-h-0">
        {/* Background blobs */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-0 left-1/4 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl animate-pulse" />
          <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />
        </div>

        <div className="p-4 sm:p-6 lg:p-8 space-y-8 max-w-[1800px] mx-auto relative z-10">

          {/* ── Page Header ────────────────────────────────────────────────── */}
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 border border-slate-700/50 shadow-2xl">
            <div className="absolute inset-0 bg-gradient-to-r from-indigo-500/5 via-transparent to-purple-500/5" />
            <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-bl from-indigo-500/10 to-transparent rounded-full blur-2xl" />
            <div className="relative p-4 sm:p-6 lg:p-8">
              <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-6">
                <div className="flex items-start gap-5">
                  <div className="relative">
                    <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/25">
                      <Calendar className="w-7 h-7 text-white" />
                    </div>
                    <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-emerald-500 rounded-full border-2 border-slate-900 animate-ping" />
                  </div>
                  <div>
                    <h1 className="text-3xl font-bold text-white mb-2 tracking-tight">Schedule Preparation</h1>
                    <div className="flex items-center gap-4 text-slate-400">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
                        <span className="text-sm font-medium">Ready</span>
                      </div>
                      <span className="text-slate-600">•</span>
                      <span className="text-sm">S3 Schedule Viewer</span>
                    </div>
                  </div>
                </div>
                <div className="flex gap-4">
                  <button
                    onClick={handleSaveSchedule}
                    disabled={createLoading || updateLoading || !isDataLoaded}
                    className="px-6 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white shadow-lg shadow-indigo-500/25 transition-all duration-300 flex items-center gap-3 disabled:opacity-50"
                  >
                    <Save className="w-5 h-5" />
                    <div className="text-left">
                      <p className="text-sm font-semibold">{createLoading || updateLoading ? 'Saving...' : 'Save Draft'}</p>
                      <p className="text-xs text-indigo-200">Keep progress</p>
                    </div>
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* ── Filters ─────────────────────────────────────────────────────── */}
          {!fromDashboard && (
            <div className="rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm p-6">
              <div className="flex items-center gap-3 mb-6">
                <div className="p-3 rounded-xl bg-indigo-500/10">
                  <Layers className="w-6 h-6 text-indigo-400" />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-foreground">Load Schedule from S3</h3>
                  <p className="text-sm text-slate-400">Select state, plant and date to fetch schedule data</p>
                </div>
              </div>

              {/* 4-col grid: State | Plant | Date | Load Button */}
              <div className="grid grid-cols-4 gap-4">
                <div>
                  <label className="text-xs font-medium text-slate-400 mb-2 block">State</label>
                  <select
                    value={selectedState}
                    onChange={(e) => handleStateChange(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700/50 text-slate-300 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all appearance-none cursor-pointer"
                  >
                    <option>Select State</option>
                    <option>Maharashtra</option>
                    <option>Madhya Pradesh</option>
                    <option>Gujarat</option>
                    <option>Rajasthan</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-medium text-slate-400 mb-2 block">Plant</label>
                  <select
                    value={selectedPlant}
                    onChange={(e) => handlePlantChange(e.target.value)}
                    disabled={selectedState === 'Select State'}
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700/50 text-slate-300 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all appearance-none cursor-pointer disabled:opacity-50"
                  >
                    {availablePlants.map((p) => <option key={p}>{p}</option>)}
                  </select>
                </div>

                <div>
                  <label className="text-xs font-medium text-slate-400 mb-2 block">Date</label>
                  <input
                    type="date"
                    value={selectedDate}
                    onChange={(e) => setSelectedDate(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700/50 text-slate-300 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                  />
                </div>

                <div className="flex items-end">
                  <button
                    onClick={handleLoadData}
                    disabled={loadingData}
                    className="w-full px-6 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white font-semibold hover:from-indigo-500 hover:to-purple-500 transition-all duration-300 shadow-lg shadow-indigo-500/25 disabled:opacity-60 flex items-center justify-center gap-2"
                  >
                    {loadingData
                      ? <><LoadingSpinner size="sm" /> Loading...</>
                      : <><RefreshCw className="w-4 h-4" /> Load Data</>}
                  </button>
                </div>
              </div>

              {/* Success banner */}
              {isDataLoaded && (
                <div className="mt-6 p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl flex items-center gap-3">
                  <CheckCircle className="w-5 h-5 text-emerald-400 flex-shrink-0" />
                  <div className="text-sm text-emerald-400">
                    <span className="font-semibold">Loaded:</span>{' '}
                    {loadedScheduleInfo?.fileName} — {scheduleData.length} blocks for{' '}
                    <span className="font-semibold">{loadedScheduleInfo?.date}</span>
                  </div>
                </div>
              )}

              {/* Error banner */}
              {loadError && (
                <div className="mt-6 p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-3">
                  <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
                  <span className="text-sm text-red-400">{loadError}</span>
                </div>
              )}
            </div>
          )}

          {/* ── Content (only when data is loaded) ──────────────────────── */}
          {(isDataLoaded || fromDashboard) && (
            <>
              {/* ── Plotly Graph + Status ──────────────────────────────────── */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

                {/* Plotly HTML Graph — 2/3 width */}
                <div className="lg:col-span-2 rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm p-6">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className="p-3 rounded-xl bg-indigo-500/10">
                        <BarChart2 className="w-6 h-6 text-indigo-400" />
                      </div>
                      <div>
                        <h3 className="text-xl font-bold text-foreground">Schedule Graph</h3>
                        <p className="text-sm text-muted-foreground">
                          Interactive Plotly chart — {loadedScheduleInfo?.date || selectedDate}
                        </p>
                      </div>
                    </div>

                    <button
                      onClick={() => setShowGraphModal(true)}
                      disabled={!scheduleData.length}
                      className="flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-800/50 text-slate-300 text-sm font-semibold hover:bg-slate-700 hover:text-white transition-all border border-slate-700 disabled:opacity-50"
                    >
                      <ExternalLink className="w-4 h-4" />
                      Expand
                    </button>
                  </div>

                  {/* Graph area */}
                  <div className={`rounded-xl overflow-hidden border ${isDarkMode ? 'border-slate-700/50 bg-slate-800/30' : 'border-border bg-white'}`} style={{ height: 440 }}>
                    {(loadingData || graphLoading) && (
                      <div className="flex items-center justify-center h-full gap-3 text-slate-400">
                        <LoadingSpinner size="md" />
                        <span className="text-sm">Loading graph…</span>
                      </div>
                    )}

                    {!(loadingData || graphLoading) && scheduleData.length === 0 && (
                      <div className="flex flex-col items-center justify-center h-full gap-3 text-slate-500 px-8 text-center">
                        <BarChart2 className="w-12 h-12 text-slate-700" />
                        <p className="text-sm">No schedule data to plot</p>
                      </div>
                    )}

                    {!(loadingData || graphLoading) && scheduleData.length > 0 && (
                      <Plot
                        data={plotData}
                        layout={plotLayout}
                        config={{ displayModeBar: false, responsive: true }}
                        style={{ width: '100%', height: '100%' }}
                        useResizeHandler
                      />
                    )}
                  </div>
                  {graphError && <p className="mt-2 text-xs text-amber-300">{graphError}</p>}
                </div>

                {/* Status Panel — 1/3 width */}
                <div className="rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm p-6 flex flex-col gap-4">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="p-3 rounded-xl bg-emerald-500/10">
                      <Activity className="w-6 h-6 text-emerald-400" />
                    </div>
                    <div>
                      <h3 className="text-xl font-bold text-foreground">Schedule Status</h3>
                      <p className="text-sm text-muted-foreground">Overview</p>
                    </div>
                  </div>

                  {/* Plant info */}
                  <div className="p-4 bg-slate-800/50 rounded-xl border border-slate-700/50">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-xl bg-blue-500/20">
                          <Wind className="w-5 h-5 text-blue-400" />
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-white">
                            {fromDashboard ? context.plant : loadedScheduleInfo?.plant || S3_ONLY_PLANT.name}
                          </p>
                        </div>
                      </div>
                      <span className="px-2.5 py-1 bg-emerald-500/10 text-emerald-400 text-xs font-semibold rounded-lg border border-emerald-500/20">
                        Active
                      </span>
                    </div>
                  </div>

                  {/* File info */}
                  {loadedScheduleInfo?.fileName && (
                    <div className="p-4 bg-slate-800/50 rounded-xl border border-slate-700/50">
                      <p className="text-xs font-medium text-slate-400 mb-1">Source File</p>
                      <p className="text-xs font-mono text-indigo-300 break-all">
                        {loadedScheduleInfo.fileName}
                      </p>
                    </div>
                  )}

                  {/* Stats */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="p-4 bg-slate-800/50 rounded-xl border border-slate-700/50 text-center">
                      <p className="text-xs text-slate-400 mb-1">Total Blocks</p>
                      <p className="text-3xl font-bold bg-gradient-to-r from-emerald-400 to-teal-400 bg-clip-text text-transparent">
                        {scheduleData.length}
                      </p>
                    </div>
                    <div className="p-4 bg-slate-800/50 rounded-xl border border-slate-700/50 text-center">
                      <p className="text-xs text-slate-400 mb-1">Modified</p>
                      <p className="text-3xl font-bold bg-gradient-to-r from-amber-400 to-orange-400 bg-clip-text text-transparent">
                        {changes.length}
                      </p>
                    </div>
                  </div>

                  {/* Avg algo schedule */}
                  {scheduleData.length > 0 && (
                    <div className="p-4 bg-slate-800/50 rounded-xl border border-slate-700/50">
                      <p className="text-xs text-slate-400 mb-1">Avg Algo Schedule</p>
                      <p className="text-2xl font-bold text-indigo-300">
                        {(
                          scheduleData.reduce((s, r) => s + parseFloat(r.algo || 0), 0) /
                          scheduleData.length
                        ).toFixed(3)}{' '}
                        <span className="text-sm font-normal text-slate-400">MW</span>
                      </p>
                    </div>
                  )}

                  {/* Action buttons */}
                  <div className="flex gap-2 mt-auto">
                    <button
                      onClick={() => setShowDeleteModal(true)}
                      className="flex-1 py-2.5 rounded-xl bg-red-500/10 text-red-400 text-sm font-semibold border border-red-500/20 hover:bg-red-500/20 transition-all"
                    >
                      Delete
                    </button>
                    <button
                      onClick={() => setShowSubmitModal(true)}
                      className="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 text-white text-sm font-semibold hover:from-emerald-500 hover:to-teal-500 transition-all shadow-lg shadow-emerald-500/20"
                    >
                      Submit
                    </button>
                  </div>
                </div>
              </div>

              {/* ── Manual Changes Log ─────────────────────────────────────── */}
              {changes.length > 0 && (
                <div className="rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm p-6">
                  <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-3">
                      <div className="p-3 rounded-xl bg-amber-500/10">
                        <Clock className="w-6 h-6 text-amber-400" />
                      </div>
                      <div>
                        <h3 className="text-xl font-bold text-white">Manual Changes Log</h3>
                        <p className="text-sm text-slate-400">Track all modifications</p>
                      </div>
                    </div>
                    <div className="px-4 py-2 bg-amber-500/10 text-amber-400 text-sm font-semibold rounded-xl border border-amber-500/20">
                      {changes.length} Changes
                    </div>
                  </div>
                  <div className="space-y-3">
                    {changes.map((change, i) => {
                      const delta = parseFloat(change.newValue) - parseFloat(change.oldValue);
                      const pct = parseFloat(change.oldValue) !== 0
                        ? ((delta / parseFloat(change.oldValue)) * 100).toFixed(1)
                        : '—';
                      return (
                        <div key={i} className="p-5 bg-slate-800/50 rounded-xl border border-slate-700/50 flex items-center justify-between hover:bg-slate-800/70 transition-all group">
                          <div className="flex items-center gap-4">
                            <div className="p-3 bg-amber-500/10 rounded-xl group-hover:bg-amber-500/20 transition-colors">
                              <Clock className="w-5 h-5 text-amber-400" />
                            </div>
                            <div>
                              <p className="text-sm font-semibold text-white">Block {change.block} — {change.time}</p>
                              <p className="text-xs text-slate-400 mt-1">
                                <span className="text-red-400 font-semibold">{change.oldValue} MW</span>
                                {' → '}
                                <span className="text-emerald-400 font-semibold">{change.newValue} MW</span>
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className={`text-sm font-semibold ${delta >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {delta >= 0 ? '+' : ''}{pct}%
                            </span>
                            <TrendingUp className={`w-5 h-5 ${delta >= 0 ? 'text-emerald-400' : 'text-red-400'}`} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* ── Schedule Table ─────────────────────────────────────────── */}
              <div className="rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm overflow-hidden">
                <div className="p-6 border-b border-slate-700/50 bg-gradient-to-r from-slate-800/50 to-transparent">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="p-3 rounded-xl bg-indigo-500/10">
                        <FileText className="w-6 h-6 text-indigo-400" />
                      </div>
                      <div>
                        <h3 className="text-xl font-bold text-white">15-Minute Schedule Blocks</h3>
                        <p className="text-sm text-slate-400">{scheduleData.length} blocks — {loadedScheduleInfo?.date}</p>
                      </div>
                    </div>
                    <button
                      onClick={() => setShowExportModal(true)}
                      className="px-6 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white font-semibold hover:from-indigo-500 hover:to-purple-500 transition-all duration-300 flex items-center gap-2 shadow-lg shadow-indigo-500/25"
                    >
                      <Download className="w-5 h-5" />
                      Export CSV
                    </button>
                  </div>
                </div>

                <div className="overflow-auto max-h-[520px]">
                  <table className="w-full">
                    <thead className="bg-slate-800/60 backdrop-blur-sm sticky top-0 z-10">
                      <tr>
                        {['Block', 'Time', 'Algo Schedule (MW)', 'Base Forecast (MW)', 'Intraday (MW)', 'Condition', 'Status', 'Action'].map((h) => (
                          <th key={h} className="px-5 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {scheduleData.map((row, i) => {
                        const hasChange = changes.some((c) => c.block === row.block);
                        return (
                          <tr
                            key={row.block}
                            className={`group hover:bg-slate-800/30 transition-all duration-200 ${hasChange ? 'bg-amber-500/5' : ''}`}
                          >
                            <td className="px-5 py-4 text-sm font-mono text-slate-500">{row.block}</td>
                            <td className="px-5 py-4">
                              <div className="flex items-center gap-2">
                                <div className="p-1.5 bg-slate-800 rounded-lg group-hover:bg-slate-700 transition-colors">
                                  <Clock className="w-3.5 h-3.5 text-slate-400" />
                                </div>
                                <span className="text-sm font-semibold text-white">{row.time}</span>
                              </div>
                            </td>

                            {/* Algo Schedule — editable */}
                            <td className="px-5 py-4">
                              {editingCell?.row === i ? (
                                <input
                                  type="number"
                                  step="0.001"
                                  defaultValue={row.algo}
                                  onBlur={(e) => {
                                    const newValue = parseFloat(e.target.value).toFixed(3);
                                    const updated = [...scheduleData];
                                    updated[i] = { ...updated[i], algo: newValue };
                                    setScheduleData(updated);
                                    const existing = changes.find((c) => c.block === row.block);
                                    if (existing) {
                                      setChanges(changes.map((c) =>
                                        c.block === row.block ? { ...c, newValue } : c
                                      ));
                                    } else {
                                      setChanges([...changes, {
                                        block: row.block,
                                        time: row.time,
                                        oldValue: row.algo,
                                        newValue,
                                      }]);
                                    }
                                    setEditingCell(null);
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') e.target.blur();
                                    if (e.key === 'Escape') setEditingCell(null);
                                  }}
                                  className="w-28 px-3 py-2 rounded-xl bg-slate-800 border border-indigo-500/50 text-sm font-semibold text-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                  autoFocus
                                />
                              ) : (
                                <span className="text-sm font-semibold text-indigo-400">{row.algo}</span>
                              )}
                            </td>

                            <td className="px-5 py-4 text-sm text-slate-400">{row.base}</td>
                            <td className="px-5 py-4 text-sm text-slate-400">{row.intraday}</td>
                            <td className="px-5 py-4">
                              <span className={`text-xs font-semibold px-2.5 py-1 rounded-lg ${
                                row.condition === 'PRE_START'
                                  ? 'bg-slate-700 text-slate-400'
                                  : row.condition === 'NONE'
                                  ? 'bg-slate-800 text-slate-500'
                                  : 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20'
                              }`}>
                                {row.condition}
                              </span>
                            </td>
                            <td className="px-5 py-4">
                              {hasChange ? (
                                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                                  <Edit3 className="w-3 h-3" /> Modified
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                  <CheckCircle className="w-3 h-3" /> Original
                                </span>
                              )}
                            </td>
                            <td className="px-5 py-4">
                              <button
                                onClick={() => setEditingCell(editingCell?.row === i ? null : { row: i })}
                                className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300 text-sm font-semibold hover:bg-slate-700 hover:text-white transition-all border border-slate-700"
                              >
                                {editingCell?.row === i ? 'Cancel' : 'Edit'}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          MODALS
      ══════════════════════════════════════════════════════════════════════ */}

      {/* Graph Modal */}
      {showGraphModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className={`rounded-2xl shadow-2xl w-full max-w-6xl border ${isDarkMode ? 'bg-slate-900 border-slate-700' : 'bg-card border-border'}`}>
            <div className={`px-6 py-5 flex items-center justify-between ${isDarkMode ? 'border-b border-slate-700 bg-gradient-to-r from-slate-800/50 to-transparent' : 'border-b border-border bg-muted/50'}`}>
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-indigo-500/10">
                  <BarChart2 className="w-6 h-6 text-indigo-400" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-foreground">Schedule Graph</h2>
                  <p className="text-sm text-muted-foreground">{loadedScheduleInfo?.date || selectedDate}</p>
                </div>
              </div>
              <button
                onClick={() => setShowGraphModal(false)}
                className={`p-2 rounded-lg transition-colors ${isDarkMode ? 'hover:bg-slate-800' : 'hover:bg-muted'}`}
              >
                <X className="w-5 h-5 text-muted-foreground" />
              </button>
            </div>
            <div className="p-6">
              <div className={`h-[70vh] rounded-xl overflow-hidden border ${isDarkMode ? 'border-slate-700/50 bg-slate-800/30' : 'border-border bg-white'}`}>
                {scheduleData.length > 0 ? (
                  <Plot
                    data={plotData}
                    layout={plotLayout}
                    config={{ displayModeBar: false, responsive: true }}
                    style={{ width: '100%', height: '100%' }}
                    useResizeHandler
                  />
                ) : (
                  <div className="flex items-center justify-center h-full text-slate-500">
                    No schedule data to plot
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Export Modal */}
      {showExportModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 rounded-2xl shadow-2xl w-full max-w-md border border-slate-700">
            <div className="px-6 py-4 border-b border-slate-700">
              <h2 className="text-lg font-semibold text-white">Export Schedule CSV</h2>
              <p className="text-sm text-slate-400 mt-1">Download all {scheduleData.length} blocks</p>
            </div>
            <div className="p-6">
              <p className="text-sm text-slate-300">
                Exports: Block, Time, Algo Schedule, Base Forecast, Intraday Forecast, Condition
              </p>
            </div>
            <div className="px-6 py-4 border-t border-slate-700 flex gap-3">
              <button onClick={() => setShowExportModal(false)} className="flex-1 px-4 py-2 rounded-xl border border-slate-700 text-slate-300 hover:bg-slate-800 transition-all font-medium">Cancel</button>
              <button onClick={handleExportCsv} className="flex-1 px-4 py-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-500 transition-all font-medium flex items-center justify-center gap-2">
                <Download className="w-4 h-4" /> Download
              </button>
            </div>
          </div>
        </div>
      )}


      {/* Validation Modal */}
      {showValidationModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 rounded-2xl shadow-2xl w-full max-w-lg border border-slate-700">
            <div className="px-6 py-4 border-b border-slate-700">
              <h2 className="text-lg font-semibold text-white">Validation Results</h2>
            </div>
            <div className="p-6 space-y-4">
              {validationErrors.length === 0 ? (
                <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl flex gap-3">
                  <CheckCircle className="w-6 h-6 text-emerald-400 flex-shrink-0" />
                  <div><p className="font-semibold text-emerald-400">Validation Passed</p>
                    <p className="text-sm text-slate-300 mt-1">All blocks are valid.</p></div>
                </div>
              ) : (
                <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex gap-3">
                  <AlertTriangle className="w-6 h-6 text-red-400 flex-shrink-0" />
                  <div><p className="font-semibold text-red-400">Validation Failed</p>
                    <ul className="text-sm text-slate-300 mt-1 list-disc list-inside space-y-1">
                      {validationErrors.map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  </div>
                </div>
              )}
              <div className="space-y-2">
                {[['Total Blocks', scheduleData.length], ['Modified', changes.length]].map(([k, v]) => (
                  <div key={k} className="flex justify-between p-3 bg-slate-800/50 rounded-xl">
                    <span className="text-sm text-slate-400">{k}</span>
                    <span className="text-sm font-semibold text-white">{v}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="px-6 py-4 border-t border-slate-700">
              <button onClick={() => setShowValidationModal(false)}
                className={`w-full px-4 py-2 rounded-xl font-medium transition-all ${validationErrors.length === 0 ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'border border-slate-700 text-slate-300 hover:bg-slate-800'}`}>
                {validationErrors.length === 0 ? 'Continue' : 'Close'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 rounded-2xl shadow-2xl w-full max-w-md border border-slate-700">
            <div className="px-6 py-4 border-b border-red-500/20 bg-red-500/5">
              <h2 className="text-lg font-semibold text-white">Delete Schedule</h2>
              <p className="text-sm text-slate-400 mt-1">This action cannot be undone</p>
            </div>
            <div className="p-6">
              <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex gap-3">
                <AlertTriangle className="w-6 h-6 text-red-400 flex-shrink-0" />
                <p className="text-sm text-slate-300">All schedule data for {loadedScheduleInfo?.date} will be cleared.</p>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-slate-700 flex gap-3">
              <button onClick={() => setShowDeleteModal(false)} className="flex-1 px-4 py-2 rounded-xl border border-slate-700 text-slate-300 hover:bg-slate-800 transition-all font-medium">Cancel</button>
              <button onClick={handleDeleteSchedule} disabled={deleteLoading} className="flex-1 px-4 py-2 rounded-xl bg-red-600 text-white hover:bg-red-500 transition-all font-medium disabled:opacity-50">
                {deleteLoading ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Submit Modal */}
      {showSubmitModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 rounded-2xl shadow-2xl w-full max-w-md border border-slate-700">
            <div className="px-6 py-4 border-b border-emerald-500/20 bg-emerald-500/5">
              <h2 className="text-lg font-semibold text-white">Submit Schedule</h2>
              <p className="text-sm text-slate-400 mt-1">Confirm submission</p>
            </div>
            <div className="p-6 space-y-3">
              {[
                ['Plant', loadedScheduleInfo?.plant || S3_ONLY_PLANT.name],
                ['Date', loadedScheduleInfo?.date || selectedDate],
                ['Modified Blocks', changes.length],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between p-3 bg-slate-800/50 rounded-xl">
                  <span className="text-sm text-slate-400">{k}</span>
                  <span className="text-sm font-semibold text-white">{v}</span>
                </div>
              ))}
            </div>
            <div className="px-6 py-4 border-t border-slate-700 flex gap-3">
              <button onClick={() => setShowSubmitModal(false)} className="flex-1 px-4 py-2 rounded-xl border border-slate-700 text-slate-300 hover:bg-slate-800 transition-all font-medium">Cancel</button>
              <button onClick={handleSubmitToDatabase} disabled={submitLoading} className="flex-1 px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-500 transition-all font-medium disabled:opacity-50">
                {submitLoading ? 'Submitting…' : 'Submit'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}



