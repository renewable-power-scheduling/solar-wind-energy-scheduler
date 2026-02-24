import { useState, useMemo, useEffect, useRef } from 'react';
import createPlotlyComponent from 'react-plotly.js/factory';
import Plotly from 'plotly.js-dist-min';
import { 
  Upload, 
  Database, 
  Wind, 
  Sun, 
  MapPin, 
  Zap, 
  Calendar,
  CheckCircle,
  AlertCircle,
  Eye,
  RefreshCw,
  MessageSquare,
  FileSpreadsheet,
  Clock,
  Cloud,
  TrendingUp,
  TrendingDown,
  Minus,
  BarChart3,
  AlertTriangle,
  X
} from 'lucide-react';

const Plot = createPlotlyComponent(Plotly);
import { useApi } from '@/hooks/useApi';
import { LoadingSpinner } from '@/app/components/common/LoadingSpinner';
import { ErrorMessage } from '@/app/components/common/ErrorMessage';
import { useTheme } from '@/app/App';
import { S3_BASE_URL } from '@/config/appConfig';

const RAW_BASE_PREFIX = 'raw/vedanjay/GSNP/';
const GENERATED_OUTPUTS_BASE_PREFIX = 'generated/vedanjay/GSNP/outputs/';
const LEGACY_OUTPUTS_BASE_PREFIX = 'outputs/';
const S3_ONLY_PLANT = {
  id: 1,
  name: 'Globus Steel N Power (GSNP)',
  state: 'Madhya Pradesh',
  type: 'Solar'
};

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line && line.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
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

function parseS3ListXml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  const contents = Array.from(doc.getElementsByTagName('Contents'));
  return contents.map(node => ({
    key: node.getElementsByTagName('Key')[0]?.textContent || '',
    lastModified: node.getElementsByTagName('LastModified')[0]?.textContent || ''
  })).filter(item => item.key);
}

async function listS3Objects(prefix) {
  const url = `${S3_BASE_URL}/?list-type=2&prefix=${encodeURIComponent(prefix)}`;
  const xml = await fetch(url).then(r => r.text());
  return parseS3ListXml(xml);
}

async function listS3ObjectsAcrossPrefixes(prefixes) {
  const settled = await Promise.allSettled(prefixes.map((prefix) => listS3Objects(prefix)));
  return settled
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value || []);
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

function getWeatherPrefixes(date) {
  return [
    `${RAW_BASE_PREFIX}${date}/weather_data/`,
    `${GENERATED_OUTPUTS_BASE_PREFIX}${date}/weather/`,
    `${LEGACY_OUTPUTS_BASE_PREFIX}${date}/weather/`,
    `${date}/weather/`,
  ];
}

function mergeUniqueObjects(objectSets) {
  return Array.from(new Map(objectSets.flat().map((o) => [o.key, o])).values());
}

function getLatestObjectByExt(objects, extension) {
  if (!objects.length) return null;
  const normalizedExt = extension.toLowerCase();
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

  return objects
    .filter(o => o.key.toLowerCase().endsWith(normalizedExt))
    .sort(compareNewestFirst)[0] || null;
}

async function fetchCsvFromS3(key) {
  const url = `${S3_BASE_URL}/${String(key || '').split('/').map((s) => encodeURIComponent(s)).join('/')}`;
  const text = await fetch(url).then(r => r.text());
  return { url, text };
}

function parseForecastIntradayCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headerIndex = lines.findIndex(l => l.startsWith('BLOCK'));
  if (headerIndex === -1 || headerIndex + 2 >= lines.length) {
    return { dataPoints: [] };
  }
  const dataLines = lines.slice(headerIndex + 2);
  const dataPoints = dataLines.map(line => {
    const cols = line.split(',');
    const time = cols[1]?.trim() || '';
    const actual = parseFloat(cols[3]) || 0;
    const forecast = parseFloat(cols[4]) || 0;
    return { time, actual, forecast };
  }).filter(d => d.time);
  return { dataPoints };
}

function parseDateValue(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;

  let parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed;

  // Common fallback for "YYYY-MM-DD HH:mm:ss"
  parsed = new Date(value.replace(' ', 'T'));
  if (!Number.isNaN(parsed.getTime())) return parsed;

  // Fallback for "DD-MM-YYYY HH:mm[:ss]" and "DD/MM/YYYY HH:mm[:ss]"
  const dmyMatch = value.match(
    /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (dmyMatch) {
    const [, dd, mm, yyyy, hh = '0', min = '0', ss = '0'] = dmyMatch;
    parsed = new Date(
      Number(yyyy),
      Number(mm) - 1,
      Number(dd),
      Number(hh),
      Number(min),
      Number(ss)
    );
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  // Fallback for Unix timestamps (seconds or milliseconds)
  if (/^\d{10,13}$/.test(value)) {
    const num = Number(value);
    const ms = value.length === 10 ? num * 1000 : num;
    parsed = new Date(ms);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  return null;
}

function parseMeterCsv(text) {
  const { headers, rows } = parseCsv(text);
  const normalizedHeaders = headers.map(h => h.trim().toLowerCase());
  const timeIdx = normalizedHeaders.findIndex(h => h === 'timestamp' || h.includes('timestamp') || h === 'time');
  const powerIdx = normalizedHeaders.findIndex(
    h =>
      h.includes('active power') ||
      h.includes('meter power') ||
      (h.includes('power') && h.includes('kw'))
  );
  if (timeIdx === -1 || powerIdx === -1) {
    return { dataPoints: [] };
  }
  const dataPoints = rows
    .map(cols => {
      const time = (cols[timeIdx] || '').trim();
      const generation = (parseFloat(cols[powerIdx]) || 0) / 1000;
      const parsedTime = parseDateValue(time);
      return {
        time,
        generation,
        timestampMs: parsedTime ? parsedTime.getTime() : null
      };
    })
    .filter(d => d.time);
  return { dataPoints };
}

function parseWeatherCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line && line.trim().length > 0);
  const headerIdx = lines.findIndex((line) => {
    const l = String(line || '').toLowerCase();
    return !l.startsWith('#') && (l.includes('time') || l.includes('date')) && (l.includes(',') || l.includes(';') || l.includes('\t'));
  });
  const csvTextFromHeader = headerIdx > 0 ? lines.slice(headerIdx).join('\n') : text;
  const { headers, rows } = parseCsv(csvTextFromHeader);

  const normalizedHeaders = headers.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const findIndex = (candidates, fallbackMatcher = null) => {
    const exactIdx = normalizedHeaders.findIndex((h) => candidates.includes(h));
    if (exactIdx !== -1) return exactIdx;
    if (fallbackMatcher) return normalizedHeaders.findIndex((h) => fallbackMatcher(h));
    return -1;
  };

  const timeIdx = findIndex(['time', 'timestamp', 'date_time', 'datetime', 'date'], (h) => h.includes('time') || h === 'date');
  const tempIdx = findIndex(
    ['temperature_2m', 'temperature', 'temp', 'temp_c', 'temperature_c'],
    (h) => h.includes('temp')
  );
  const windIdx = findIndex(
    ['wind_speed_10m', 'windspeed', 'wind_speed', 'wind_speed_m_s'],
    (h) => h.includes('wind') && (h.includes('speed') || h.includes('windspeed'))
  );
  const diffuseIdx = findIndex(
    ['diffuse_radiation', 'dhi', 'diffuse'],
    (h) => h.includes('diffuse')
  );
  const globalIdx = findIndex(
    ['global_tilted_irradiance', 'global_irradiance', 'gti', 'ghi', 'global'],
    (h) => h.includes('global') || h.includes('irradiance')
  );

  if (timeIdx === -1) {
    return { dataPoints: [] };
  }

  const toNumber = (value) => {
    if (value === null || value === undefined) return null;
    const parsed = parseFloat(String(value).replace(/"/g, '').trim());
    return Number.isFinite(parsed) ? parsed : null;
  };

  const dataPoints = rows
    .map((cols) => ({
      time: (cols[timeIdx] || '').replace(/"/g, '').trim(),
      temperature: tempIdx === -1 ? null : toNumber(cols[tempIdx]),
      wind: windIdx === -1 ? null : toNumber(cols[windIdx]),
      diffuse: diffuseIdx === -1 ? null : toNumber(cols[diffuseIdx]),
      global: globalIdx === -1 ? null : toNumber(cols[globalIdx])
    }))
    .filter((d) => d.time && [d.temperature, d.wind, d.diffuse, d.global].some((v) => v !== null));

  return { dataPoints };
}

export function DataInputs({ sharedData, updateSharedData }) {
  const { isDarkMode } = useTheme();
  // Filter states
  const [selectedPlant, setSelectedPlant] = useState('');
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);

  // Success state for load operation
  const [loadSuccess, setLoadSuccess] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');

  // Success state for WhatsApp form submission
  const [whatsappSubmitSuccess, setWhatsappSubmitSuccess] = useState(false);
  const [whatsappSubmitMessage, setWhatsappSubmitMessage] = useState('');

  // Chart display states - use useRef to persist state across re-renders
  const [showForecastChart, setShowForecastChart] = useState(false);
  const [showMeterChart, setShowMeterChart] = useState(false);
  const [showCurrentWeatherChart, setShowCurrentWeatherChart] = useState(false);
  const [showMinutelyWeatherChart, setShowMinutelyWeatherChart] = useState(false);
  
  // Refs for chart state to ensure persistence
  const forecastChartRef = useRef(false);
  const meterChartRef = useRef(false);

  // Sync refs with state and log for debugging
  const toggleForecastChart = () => {
    forecastChartRef.current = !forecastChartRef.current;
    setShowForecastChart(forecastChartRef.current);
    console.log('Forecast chart toggled:', forecastChartRef.current, 'data:', forecastData ? 'available' : 'none');
  };

  const toggleMeterChart = () => {
    meterChartRef.current = !meterChartRef.current;
    setShowMeterChart(meterChartRef.current);
    console.log('Meter chart toggled:', meterChartRef.current, 'data:', meterData ? 'available' : 'none');
  };

  const toggleCurrentWeatherChart = () => {
    setShowCurrentWeatherChart(prev => !prev);
  };

  const toggleMinutelyWeatherChart = () => {
    setShowMinutelyWeatherChart(prev => !prev);
  };

  // Modal states
  const [showWhatsAppModal, setShowWhatsAppModal] = useState(false);
  const [showWhatsAppHistoryModal, setShowWhatsAppHistoryModal] = useState(false);

  // WhatsApp form state
  const [whatsappForm, setWhatsappForm] = useState({
    plantId: '',
    plantName: '',
    state: 'Madhya Pradesh',
    date: new Date().toISOString().split('T')[0],
    time: new Date().toTimeString().slice(0, 5),
    currentGeneration: '',
    expectedTrend: '',
    curtailmentStatus: false,
    curtailmentReason: '',
    weatherCondition: '',
    inverterAvailability: '',
    remarks: ''
  });

  const plantsData = useMemo(
    () => ({ plants: [S3_ONLY_PLANT], total: 1, stats: {} }),
    []
  );
  const plantsLoading = false;

  const {
    data: forecastData,
    loading: forecastLoading,
    error: forecastError,
    execute: fetchForecast
  } = useApi(
    async () => {
      const objectsFlat = await listS3ObjectsAcrossPrefixes(getIntradayPrefixes(selectedDate));
      const objects = mergeUniqueObjects([objectsFlat]);
      const latestCsv = getLatestObjectByExt(objects, '.csv');
      const latestHtml = getLatestObjectByExt(objects, '.html');

      if (!latestCsv && !latestHtml) {
        throw new Error('No intraday forecast files found for selected date');
      }

      let parsed = { dataPoints: [] };
      let latestFileKey = '';
      let latestFileUrl = '';

      if (latestCsv) {
        const csvResponse = await fetchCsvFromS3(latestCsv.key);
        parsed = parseForecastIntradayCsv(csvResponse.text);
        latestFileKey = latestCsv.key;
        latestFileUrl = csvResponse.url;
      } else if (latestHtml) {
        latestFileKey = latestHtml.key;
        latestFileUrl = `${S3_BASE_URL}/${String(latestHtml.key || '').split('/').map((s) => encodeURIComponent(s)).join('/')}`;
      }

      return {
        ...parsed,
        createdAt: latestCsv?.lastModified || latestHtml?.lastModified || new Date().toISOString(),
        fileUrl: latestFileUrl,
        fileName: latestFileKey.split('/').pop(),
        graphUrl: latestHtml ? `${S3_BASE_URL}/${String(latestHtml.key || '').split('/').map((s) => encodeURIComponent(s)).join('/')}` : null,
        graphFileName: latestHtml ? latestHtml.key.split('/').pop() : null
      };
    },
    { immediate: false, initialData: null }
  );

  const {
    data: meterData,
    loading: meterLoading,
    error: meterError,
    execute: fetchMeterData
  } = useApi(
    async () => {
      const meterObjectsFlat = await listS3ObjectsAcrossPrefixes(getMeterPrefixes(selectedDate));
      const meterObjects = mergeUniqueObjects([meterObjectsFlat])
        .filter((o) => o.key.toLowerCase().endsWith('.csv'))
        .sort((a, b) => {
          const aTime = Date.parse(a.lastModified || '');
          const bTime = Date.parse(b.lastModified || '');
          const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
          if (timeDiff !== 0) return timeDiff;
          return (b.key || '').localeCompare(a.key || '');
        });
      if (!meterObjects.length) {
        throw new Error(`No meter CSV found for ${selectedDate}`);
      }
      const meterKey = meterObjects[0].key;
      const { url, text } = await fetchCsvFromS3(meterKey);
      const parsed = parseMeterCsv(text);
      const lastPoint = parsed.dataPoints
        .filter(p => p.timestampMs !== null)
        .sort((a, b) => b.timestampMs - a.timestampMs)[0];
      return {
        ...parsed,
        lastReading: lastPoint?.time || null,
        source: 'S3',
        fileUrl: url,
        fileName: meterKey.split('/').pop()
      };
    },
    { immediate: false, initialData: null }
  );

  const {
    data: weatherCurrent,
    loading: weatherCurrentLoading,
    error: weatherCurrentError,
    execute: fetchWeatherCurrent
  } = useApi(
    async () => {
      const weatherObjectsFlat = await listS3ObjectsAcrossPrefixes(getWeatherPrefixes(selectedDate));
      const weatherObjects = mergeUniqueObjects([weatherObjectsFlat])
        .filter((o) => o.key.toLowerCase().endsWith('.csv'))
        .sort((a, b) => {
          const aTime = Date.parse(a.lastModified || '');
          const bTime = Date.parse(b.lastModified || '');
          const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
          if (timeDiff !== 0) return timeDiff;
          return (b.key || '').localeCompare(a.key || '');
        });
      const weatherCurrentObject = weatherObjects.filter((o) => {
        const fileName = (o.key.split('/').pop() || '').toLowerCase();
        return fileName.includes('openmeteo_current') || fileName.includes('current');
      })[0] || weatherObjects[0];
      if (!weatherCurrentObject) {
        throw new Error(`No weather current CSV found for ${selectedDate}`);
      }
      const { url, text } = await fetchCsvFromS3(weatherCurrentObject.key);
      const parsed = parseWeatherCsv(text);
      return { ...parsed, fileUrl: url, fileName: weatherCurrentObject.key.split('/').pop() };
    },
    { immediate: false, initialData: null }
  );

  const {
    data: weatherMinutely,
    loading: weatherMinutelyLoading,
    error: weatherMinutelyError,
    execute: fetchWeatherMinutely
  } = useApi(
    async () => {
      const weatherObjectsFlat = await listS3ObjectsAcrossPrefixes(getWeatherPrefixes(selectedDate));
      const weatherObjects = mergeUniqueObjects([weatherObjectsFlat])
        .filter((o) => o.key.toLowerCase().endsWith('.csv'))
        .sort((a, b) => {
          const aTime = Date.parse(a.lastModified || '');
          const bTime = Date.parse(b.lastModified || '');
          const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
          if (timeDiff !== 0) return timeDiff;
          return (b.key || '').localeCompare(a.key || '');
        });
      const weatherMinutelyObject = weatherObjects.filter((o) => {
        const fileName = (o.key.split('/').pop() || '').toLowerCase();
        return fileName.includes('openmeteo_minutely15') || fileName.includes('minutely');
      })[0] || weatherObjects[0];
      if (!weatherMinutelyObject) {
        throw new Error(`No weather minutely CSV found for ${selectedDate}`);
      }
      const { url, text } = await fetchCsvFromS3(weatherMinutelyObject.key);
      const parsed = parseWeatherCsv(text);
      return { ...parsed, fileUrl: url, fileName: weatherMinutelyObject.key.split('/').pop() };
    },
    { immediate: false, initialData: null }
  );

  const whatsappDataList = useMemo(() => ({ data: [] }), []);
  const whatsappLoading = false;
  const createWhatsAppLoading = false;
  const fetchWhatsAppData = async () => ({ success: true, data: [] });

  // Memoized selected plant data - must be defined BEFORE useEffect that uses it
  const selectedPlantData = useMemo(() => {
    if (!selectedPlant || !plantsData?.plants) return null;
    return plantsData.plants.find(p => p.id === parseInt(selectedPlant) || p.name === selectedPlant);
  }, [selectedPlant, plantsData]);

  // Reset WhatsApp form when plant selection changes
  useEffect(() => {
    if (selectedPlantData) {
      setWhatsappForm(prev => ({
        ...prev,
        plantId: selectedPlantData.id?.toString() || '',
        plantName: selectedPlantData.name || '',
        state: selectedPlantData.state || ''
      }));
    }
  }, [selectedPlantData]);

  // Load data when plant is selected
  useEffect(() => {
    if (selectedPlant) {
      fetchForecast();
      fetchMeterData();
      fetchWhatsAppData();
      fetchWeatherCurrent();
      fetchWeatherMinutely();
    }
  }, [selectedPlant, selectedDate]);

  // Auto-show chart when data is loaded (optional UX improvement) - defined AFTER useApi hooks
  useEffect(() => {
    if (forecastData && !forecastChartRef.current) {
      // Optionally auto-show chart when data loads
      // forecastChartRef.current = true;
      // setShowForecastChart(true);
    }
  }, [forecastData]);

  useEffect(() => {
    if (meterData && !meterChartRef.current) {
      // Optionally auto-show chart when data loads
      // meterChartRef.current = true;
      // setShowMeterChart(true);
    }
  }, [meterData]);

  const handleLoad = async () => {
    if (!selectedPlant) {
      alert('Please select a plant first');
      return;
    }
    
    // Reset success state
    setLoadSuccess(false);
    setSuccessMessage('');
    
    // Fetch data
    await fetchForecast();
    await fetchMeterData();
    await fetchWeatherCurrent();
    await fetchWeatherMinutely();
    await fetchWhatsAppData();
    
    // Show success message
    setLoadSuccess(true);
    setSuccessMessage('Data loaded successfully from S3 for the selected plant and date.');
    
    // Clear success message after 5 seconds
    setTimeout(() => {
      setLoadSuccess(false);
      setSuccessMessage('');
    }, 5000);
  };

  const handleWhatsAppSubmit = () => {
    // Validate all required fields before submission
    if (!whatsappForm.plantId) {
      alert('Please select a plant first');
      return;
    }
    if (!whatsappForm.currentGeneration || whatsappForm.currentGeneration.trim() === '') {
      alert('Please enter the current generation value');
      return;
    }
    if (!whatsappForm.expectedTrend || whatsappForm.expectedTrend.trim() === '') {
      alert('Please select an expected trend (Increasing, Stable, or Decreasing)');
      return;
    }
    if (isNaN(parseFloat(whatsappForm.currentGeneration))) {
      alert('Please enter a valid number for current generation');
      return;
    }
    // Validate curtailment if status is Yes
    if (whatsappForm.curtailmentStatus && (!whatsappForm.curtailmentReason || whatsappForm.curtailmentReason.trim() === '')) {
      alert('Please select a curtailment reason when curtailment status is Yes');
      return;
    }
    setWhatsappSubmitSuccess(false);
    setWhatsappSubmitMessage('WhatsApp inputs are disabled in S3-only mode.');
    setTimeout(() => {
      setWhatsappSubmitSuccess(false);
      setWhatsappSubmitMessage('');
    }, 5000);
  };

  const latestWhatsAppMessage = useMemo(() => {
    if (!whatsappDataList?.data || whatsappDataList.data.length === 0) return null;
    return whatsappDataList.data[0];
  }, [whatsappDataList]);

  // Calculate delays and status
  const meterDelay = useMemo(() => {
    if (!meterData?.lastReading) return null;
    const now = new Date();
    const lastReading = parseDateValue(meterData.lastReading);
    if (!lastReading) return null;
    const diffMinutes = Math.floor((now - lastReading) / (1000 * 60));
    return diffMinutes < 0 ? 0 : diffMinutes;
  }, [meterData]);

  const forecastPointsCount = useMemo(
    () => (forecastData?.dataPoints?.length ? forecastData.dataPoints.length : 0),
    [forecastData]
  );

  const forecastCoverage = useMemo(() => {
    if (!forecastPointsCount) return 'N/A';
    return `${Math.min(100, Math.round((forecastPointsCount / 96) * 100))}%`;
  }, [forecastPointsCount]);

  return (
    <div className={`flex-1 overflow-auto min-h-0 ${isDarkMode ? 'bg-slate-950' : 'bg-background'}`}>
      {/* Animated background elements */}
      {isDarkMode && (
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-0 left-1/4 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl animate-pulse" />
          <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />
        </div>
      )}

      <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-[1600px] mx-auto relative z-10">
        {/* Premium Header */}
        <div className={`relative overflow-hidden rounded-2xl border ${isDarkMode ? 'bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 border-slate-700/50 shadow-2xl' : 'bg-gradient-to-r from-white via-slate-50 to-emerald-50 border-border shadow-sm'}`}>
          <div className={`absolute inset-0 ${isDarkMode ? 'bg-gradient-to-r from-indigo-500/5 via-transparent to-purple-500/5' : 'bg-gradient-to-r from-emerald-500/5 via-transparent to-cyan-500/5'}`} />
          <div className={`absolute top-0 right-0 w-64 h-64 rounded-full blur-2xl ${isDarkMode ? 'bg-gradient-to-bl from-indigo-500/10 to-transparent' : 'bg-gradient-to-bl from-emerald-400/15 to-transparent'}`} />
          
          <div className="relative p-6">
            <div className="flex items-start gap-5">
              <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/25">
                <Database className="w-7 h-7 text-white" />
              </div>
              <div>
                <h1 className="text-3xl font-bold text-foreground mb-2 tracking-tight">Data Inputs</h1>
                <div className="flex items-center gap-4 text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
                    <span className="text-sm font-medium">Live Monitoring</span>
                  </div>
                  <span className="text-muted-foreground">•</span>
                  <span className="text-sm">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</span>
                </div>
                <p className="text-sm text-muted-foreground mt-2">View and manage all data sources for schedule preparation</p>
              </div>
            </div>
          </div>
        </div>

        {/* DATA INPUTS - VIEW ONLY Section */}
        <div className={`rounded-2xl border backdrop-blur-sm p-6 ${isDarkMode ? 'bg-slate-900/50 border-slate-700/50' : 'bg-white border-border shadow-sm'}`}>
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-indigo-500/10">
                <Database className="w-5 h-5 text-indigo-400" />
              </div>
              <h2 className="text-lg font-semibold text-foreground">DATA INPUTS - VIEW ONLY</h2>
            </div>
          </div>
          
          <div className="flex flex-col md:flex-row gap-4 mb-6">
            <div className="flex-1">
              <label className="text-sm font-semibold text-foreground mb-2 block">FILTERS: Plant</label>
              {plantsLoading ? (
                <div className={`w-full px-4 py-3 rounded-xl text-sm flex items-center gap-2 ${isDarkMode ? 'bg-slate-800/50 border border-slate-700/50' : 'bg-background border border-border'}`}>
                  <RefreshCw className="w-4 h-4 animate-spin text-indigo-400" />
                  <span className="text-muted-foreground">Loading plants...</span>
                </div>
              ) : (
                <select 
                  value={selectedPlant}
                  onChange={(e) => setSelectedPlant(e.target.value)}
                  className={`w-full px-4 py-3 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all ${isDarkMode ? 'bg-slate-800/50 border border-slate-700/50 text-white' : 'bg-background border border-border text-foreground'}`}
                >
                  <option value="">Select Plant</option>
                  {plantsData?.plants?.map(plant => (
                    <option key={plant.id} value={plant.id}>{plant.name}</option>
                  ))}
                </select>
              )}
            </div>
            <div className="flex-1">
              <label className="text-sm font-semibold text-foreground mb-2 block">Specific Date</label>
              <input 
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className={`w-full px-4 py-3 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all ${isDarkMode ? 'bg-slate-800/50 border border-slate-700/50 text-white' : 'bg-background border border-border text-foreground'}`}
              />
            </div>
            <div className="flex items-end">
              <button 
                onClick={handleLoad}
                disabled={!selectedPlant || plantsLoading || forecastLoading || meterLoading}
                className="px-8 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white shadow-lg shadow-indigo-500/25 hover:from-indigo-500 hover:to-purple-500 transition-all font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {forecastLoading || meterLoading ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Loading...
                  </>
                ) : (
                  'LOAD'
                )}
              </button>
            </div>
          </div>
          
          {/* Success Message */}
          {loadSuccess && (
            <div className="mt-4 p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl animate-in fade-in slide-in-from-top-2 duration-300">
              <div className="flex items-center gap-3">
                <CheckCircle className="w-5 h-5 text-emerald-400 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-white">Load Successful</p>
                  <p className="text-xs text-slate-400">{successMessage}</p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Main Grid - Forecast, Meter, Weather, WhatsApp */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Forecast Data (Enercast) */}
          <div className={`relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 to-slate-800 border border-slate-700/50 hover:border-slate-600 transition-all duration-500 ${forecastData ? 'ring-2 ring-emerald-500/20' : ''}`}>
            <div className={`absolute inset-0 bg-gradient-to-r ${forecastData ? 'bg-emerald-500/5' : ''} opacity-0 transition-opacity duration-500`} />
            <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-indigo-500/10 to-transparent rounded-full blur-2xl" />
            
            <div className="relative p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-xl bg-blue-500/10">
                    <TrendingUp className="w-5 h-5 text-blue-400" />
                  </div>
                  <h3 className="text-base font-semibold text-white">FORECAST DATA (ENERCAST)</h3>
                </div>
                {forecastData && (
                  <span className="px-3 py-1 rounded-lg text-xs font-semibold bg-emerald-500/10 text-emerald-400 flex items-center gap-1.5 border border-emerald-500/20">
                    <CheckCircle className="w-3.5 h-3.5" /> Loaded
                  </span>
                )}
              </div>
              
              {/* Error Display */}
              {forecastError && (
                <div className="mb-4">
                  <ErrorMessage 
                    error={forecastError} 
                    onRetry={handleLoad}
                    variant="warning"
                  />
                </div>
              )}
              
              {forecastLoading ? (
                <div className="py-8">
                  <LoadingSpinner message="Loading forecast data..." />
                </div>
              ) : forecastData ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Last Updated:</span>
                    <span className="font-medium text-white">
                      {new Date(forecastData.createdAt || Date.now()).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} {new Date(forecastData.createdAt || Date.now()).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Data Points:</span>
                    <span className="font-medium text-white">
                      {forecastPointsCount ? `${forecastPointsCount} (Available)` : 'N/A'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">API Status:</span>
                    <span className="px-3 py-1 rounded-lg text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                      {forecastData.fileUrl ? 'Loaded from S3' : 'N/A'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Coverage:</span>
                    <span className="font-medium text-white">{forecastCoverage}</span>
                  </div>
                  {forecastData.fileUrl && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-400">Latest File:</span>
                      <a
                        href={forecastData.fileUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-indigo-300 hover:text-indigo-200 truncate max-w-[220px]"
                        title={forecastData.fileName}
                      >
                        {forecastData.fileName}
                      </a>
                    </div>
                  )}
                  {forecastData.graphUrl && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-400">Latest Graph:</span>
                      <a
                        href={forecastData.graphUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-blue-300 hover:text-blue-200 truncate max-w-[220px]"
                        title={forecastData.graphFileName || 'Enercast graph'}
                      >
                        {forecastData.graphFileName || 'Open Enercast graph'}
                      </a>
                    </div>
                  )}
                  <button
                    onClick={toggleForecastChart}
                    disabled={!forecastData}
                    className="w-full mt-4 px-4 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white shadow-lg shadow-indigo-500/25 hover:from-indigo-500 hover:to-purple-500 transition-all font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    <BarChart3 className="w-4 h-4" />
                    {showForecastChart ? 'HIDE FORECAST CHART' : 'VIEW FORECAST CHART'}
                  </button>
                </div>
              ) : (
                <div className="text-center py-8 text-sm text-slate-400">
                  <TrendingUp className="w-10 h-10 mx-auto mb-3 text-slate-600" />
                  <p>Select a plant and click LOAD to view forecast data</p>
                </div>
              )}
            </div>
          </div>

          {/* Meter Data (Actual) */}
          <div className={`relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 to-slate-800 border border-slate-700/50 hover:border-slate-600 transition-all duration-500 ${meterData ? 'ring-2 ring-emerald-500/20' : ''}`}>
            <div className={`absolute inset-0 bg-gradient-to-r ${meterData ? 'bg-emerald-500/5' : ''} opacity-0 transition-opacity duration-500`} />
            <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-amber-500/10 to-transparent rounded-full blur-2xl" />
            
            <div className="relative p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-xl bg-amber-500/10">
                    <Zap className="w-5 h-5 text-amber-400" />
                  </div>
                  <h3 className="text-base font-semibold text-white">METER DATA (ACTUAL)</h3>
                </div>
                {meterData && (
                  <span className="px-3 py-1 rounded-lg text-xs font-semibold bg-emerald-500/10 text-emerald-400 flex items-center gap-1.5 border border-emerald-500/20">
                    <CheckCircle className="w-3.5 h-3.5" /> Loaded
                  </span>
                )}
              </div>
              
              {/* Error Display */}
              {meterError && (
                <div className="mb-4">
                  <ErrorMessage 
                    error={meterError} 
                    onRetry={handleLoad}
                    variant="warning"
                  />
                </div>
              )}
              
              {meterLoading ? (
                <div className="py-8">
                  <LoadingSpinner message="Loading meter data..." />
                </div>
              ) : meterData ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Last Reading:</span>
                    <span className="font-medium text-white">
                      {(() => {
                        const readingDate = parseDateValue(meterData.lastReading);
                        if (!readingDate) return 'N/A';
                        return `${readingDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} ${readingDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
                      })()}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Data Points:</span>
                    <span className="font-medium text-white">{meterData.dataPoints?.length ?? 0} (Available)</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Source:</span>
                    <span className="font-medium text-white">{meterData.source || 'N/A'}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Delay:</span>
                    <span className={`font-medium ${meterDelay && meterDelay > 20 ? 'text-red-400' : 'text-white'}`}>
                      {meterDelay === null ? 'N/A' : `${meterDelay} min`}
                    </span>
                  </div>
                  {meterData.fileUrl && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-400">File:</span>
                      <a
                        href={meterData.fileUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-amber-300 hover:text-amber-200 truncate max-w-[220px]"
                        title={meterData.fileName}
                      >
                        {meterData.fileName}
                      </a>
                    </div>
                  )}
                  <button
                    onClick={toggleMeterChart}
                    disabled={!meterData}
                    className="w-full mt-4 px-4 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white shadow-lg shadow-indigo-500/25 hover:from-indigo-500 hover:to-purple-500 transition-all font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    <BarChart3 className="w-4 h-4" />
                    {showMeterChart ? 'HIDE METER CHART' : 'VIEW METER CHART'}
                  </button>
                </div>
              ) : (
                <div className="text-center py-8 text-sm text-slate-400">
                  <Database className="w-10 h-10 mx-auto mb-3 text-slate-600" />
                  <p>No meter data available</p>
                </div>
              )}
            </div>
          </div>

          {/* Weather Data (Current) */}
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 to-slate-800 border border-slate-700/50 p-6">
            <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-cyan-500/10 to-transparent rounded-full blur-2xl" />
            <div className="relative">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-xl bg-cyan-500/10">
                    <Cloud className="w-5 h-5 text-cyan-400" />
                  </div>
                  <h3 className="text-base font-semibold text-white">WEATHER (CURRENT)</h3>
                </div>
                {weatherCurrent?.fileUrl && (
                  <a
                    href={weatherCurrent.fileUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs font-semibold text-cyan-300 hover:text-cyan-200"
                  >
                    {weatherCurrent.fileName}
                  </a>
                )}
              </div>

              {weatherCurrentError && (
                <div className="mb-4">
                  <ErrorMessage error={weatherCurrentError} onRetry={handleLoad} variant="warning" />
                </div>
              )}

              {weatherCurrentLoading ? (
                <LoadingSpinner message="Loading current weather..." />
              ) : weatherCurrent?.dataPoints?.length ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Last Update:</span>
                    <span className="font-medium text-white">
                      {(() => {
                        const rawTime = weatherCurrent.dataPoints[weatherCurrent.dataPoints.length - 1].time;
                        const parsed = parseDateValue(rawTime);
                        return parsed
                          ? parsed.toLocaleString('en-GB', {
                              hour: '2-digit',
                              minute: '2-digit',
                              day: '2-digit',
                              month: 'short'
                            })
                          : String(rawTime || 'N/A');
                      })()}
                    </span>
                  </div>
                  <div className="h-48 bg-slate-800/50 rounded-xl border border-slate-700/50 p-3">
                    <WeatherChart data={weatherCurrent} />
                  </div>
                  <button
                    onClick={toggleCurrentWeatherChart}
                    className="w-full mt-2 px-4 py-3 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 text-white shadow-lg shadow-cyan-500/20 hover:from-cyan-500 hover:to-blue-500 transition-all font-semibold flex items-center justify-center gap-2"
                  >
                    <Eye className="w-4 h-4" />
                    {showCurrentWeatherChart ? 'HIDE EXPANDED WEATHER CHART' : 'EXPAND WEATHER CHART'}
                  </button>
                </div>
              ) : (
                <div className="text-center py-6 text-sm text-slate-400">
                  <Cloud className="w-10 h-10 mx-auto mb-3 text-slate-600" />
                  <p>No current weather data</p>
                </div>
              )}
            </div>
          </div>

          {/* Weather Data (Minutely) */}
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 to-slate-800 border border-slate-700/50 p-6">
            <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-sky-500/10 to-transparent rounded-full blur-2xl" />
            <div className="relative">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-xl bg-sky-500/10">
                    <Clock className="w-5 h-5 text-sky-400" />
                  </div>
                  <h3 className="text-base font-semibold text-white">WEATHER (MINUTELY)</h3>
                </div>
                {weatherMinutely?.fileUrl && (
                  <a
                    href={weatherMinutely.fileUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs font-semibold text-sky-300 hover:text-sky-200"
                  >
                    {weatherMinutely.fileName}
                  </a>
                )}
              </div>

              {weatherMinutelyError && (
                <div className="mb-4">
                  <ErrorMessage error={weatherMinutelyError} onRetry={handleLoad} variant="warning" />
                </div>
              )}

              {weatherMinutelyLoading ? (
                <LoadingSpinner message="Loading minutely weather..." />
              ) : weatherMinutely?.dataPoints?.length ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Points:</span>
                    <span className="font-medium text-white">{weatherMinutely.dataPoints.length}</span>
                  </div>
                  <div className="h-48 bg-slate-800/50 rounded-xl border border-slate-700/50 p-3">
                    <WeatherChart
                      data={weatherMinutely}
                      series={[
                        { key: 'temperature', label: 'Temp (°C)', color: '#38bdf8' },
                        { key: 'wind', label: 'Wind (m/s)', color: '#a78bfa' },
                        { key: 'diffuse', label: 'Diffuse (W/m²)', color: '#f59e0b' },
                        { key: 'global', label: 'Global Tilted (W/m²)', color: '#22c55e' }
                      ]}
                    />
                  </div>
                  <button
                    onClick={toggleMinutelyWeatherChart}
                    className="w-full mt-2 px-4 py-3 rounded-xl bg-gradient-to-r from-sky-600 to-indigo-600 text-white shadow-lg shadow-sky-500/20 hover:from-sky-500 hover:to-indigo-500 transition-all font-semibold flex items-center justify-center gap-2"
                  >
                    <Eye className="w-4 h-4" />
                    {showMinutelyWeatherChart ? 'HIDE EXPANDED WEATHER CHART' : 'EXPAND WEATHER CHART'}
                  </button>
                </div>
              ) : (
                <div className="text-center py-6 text-sm text-slate-400">
                  <Clock className="w-10 h-10 mx-auto mb-3 text-slate-600" />
                  <p>No minutely weather data</p>
                </div>
              )}
            </div>
          </div>

          {/* WhatsApp Instant Data */}
          <div className={`relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 to-slate-800 border border-slate-700/50 hover:border-slate-600 transition-all duration-500 ${latestWhatsAppMessage ? 'ring-2 ring-emerald-500/20' : ''}`}>
            <div className={`absolute inset-0 bg-gradient-to-r ${latestWhatsAppMessage ? 'bg-emerald-500/5' : ''} opacity-0 transition-opacity duration-500`} />
            <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-green-500/10 to-transparent rounded-full blur-2xl" />
            
            <div className="relative p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-xl bg-green-500/10">
                    <MessageSquare className="w-5 h-5 text-green-400" />
                  </div>
                  <h3 className="text-base font-semibold text-white">WHATSAPP INSTANT DATA</h3>
                </div>
                <button
                  onClick={() => {
                    if (!selectedPlantData) {
                      alert('Please select a plant first');
                      return;
                    }
                    setWhatsappForm({
                      ...whatsappForm,
                      plantId: selectedPlantData.id.toString(),
                      plantName: selectedPlantData.name,
                      state: selectedPlantData.state
                    });
                    setShowWhatsAppModal(true);
                  }}
                  className="px-4 py-2 rounded-lg bg-slate-700/50 hover:bg-slate-600/50 border border-slate-600/50 text-slate-300 text-xs font-semibold transition-all flex items-center gap-2"
                >
                  MANUAL INPUT
                </button>
              </div>
              
              {/* WhatsApp Submit Success/Error Message */}
              {whatsappSubmitMessage && (
                <div className={`mb-4 p-3 rounded-xl border animate-in fade-in slide-in-from-top-2 duration-300 ${
                  whatsappSubmitSuccess 
                    ? 'bg-emerald-500/10 border-emerald-500/20' 
                    : 'bg-red-500/10 border-red-500/20'
                }`}>
                  <div className="flex items-center gap-2">
                    {whatsappSubmitSuccess ? (
                      <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                    ) : (
                      <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                    )}
                    <p className={`text-sm font-medium ${
                      whatsappSubmitSuccess ? 'text-emerald-400' : 'text-red-400'
                    }`}>
                      {whatsappSubmitMessage}
                    </p>
                  </div>
                </div>
              )}
              
              {whatsappLoading ? (
                <LoadingSpinner />
              ) : latestWhatsAppMessage ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Last Message:</span>
                    <span className="font-medium text-white">
                      {new Date(latestWhatsAppMessage.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} {latestWhatsAppMessage.time}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Source:</span>
                    <span className="font-medium text-white">Plant Operator</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Status:</span>
                    <span className={`px-3 py-1 rounded-lg text-xs font-semibold ${
                      latestWhatsAppMessage.status === 'Used' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                    }`}>
                      {latestWhatsAppMessage.status || 'Pending Review'}
                    </span>
                  </div>
                  <div className="mt-4 p-4 bg-slate-800/50 rounded-xl border border-slate-700/50">
                    <p className="text-sm font-semibold text-white mb-2">Latest Message:</p>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      Plant: {latestWhatsAppMessage.plantName}<br />
                      Generation: {latestWhatsAppMessage.currentGeneration} MW<br />
                      Trend: {latestWhatsAppMessage.expectedTrend}<br />
                      {latestWhatsAppMessage.remarks && `Remarks: ${latestWhatsAppMessage.remarks}`}
                    </p>
                  </div>
                  <button 
                    onClick={() => setShowWhatsAppHistoryModal(true)}
                    className="w-full mt-2 px-4 py-3 rounded-xl bg-slate-700/50 hover:bg-slate-600/50 text-slate-300 text-sm font-semibold transition-all border border-slate-600/50"
                  >
                    VIEW ALL MESSAGES
                  </button>
                </div>
              ) : (
                <div className="text-center py-8 text-sm text-slate-400">
                  <MessageSquare className="w-10 h-10 mx-auto mb-3 text-slate-600" />
                  <p>No WhatsApp data available</p>
                  <button 
                    onClick={() => {
                      if (!selectedPlantData) {
                        alert('Please select a plant first');
                        return;
                      }
                      setWhatsappForm({
                        ...whatsappForm,
                        plantId: selectedPlantData.id.toString(),
                        plantName: selectedPlantData.name,
                        state: selectedPlantData.state
                      });
                      setShowWhatsAppModal(true);
                    }}
                    className="mt-4 px-6 py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white text-sm font-semibold hover:from-indigo-500 hover:to-purple-500 transition-all shadow-lg shadow-indigo-500/25"
                  >
                    Add Manual Input
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Inline Forecast Chart */}
        {showForecastChart && forecastData && (
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 to-slate-800 border border-slate-700/50 p-6 animate-in fade-in slide-in-from-top-2 duration-300">
            <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-bl from-indigo-500/10 to-transparent rounded-full blur-3xl" />
            
            <div className="relative flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-blue-500/10">
                  <BarChart3 className="w-5 h-5 text-blue-400" />
                </div>
                <h3 className="text-lg font-semibold text-white">Forecast Data Chart</h3>
              </div>
              <button
                onClick={toggleForecastChart}
                className="px-4 py-2 rounded-lg bg-slate-700/50 hover:bg-slate-600/50 border border-slate-600/50 text-slate-300 text-sm font-medium transition-all"
              >
                Close
              </button>
            </div>
            <div className="h-80 bg-slate-800/50 rounded-xl border border-slate-700/50 p-4 relative overflow-hidden">
              <ForecastChart data={forecastData} graphUrl={forecastData?.graphUrl} />
            </div>
          </div>
        )}

        {/* Inline Meter Chart */}
        {showMeterChart && meterData && (
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 to-slate-800 border border-slate-700/50 p-6 animate-in fade-in slide-in-from-top-2 duration-300">
            <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-bl from-amber-500/10 to-transparent rounded-full blur-3xl" />
            
            <div className="relative flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-amber-500/10">
                  <BarChart3 className="w-5 h-5 text-amber-400" />
                </div>
                <h3 className="text-lg font-semibold text-white">Meter Data Chart</h3>
              </div>
              <button
                onClick={toggleMeterChart}
                className="px-4 py-2 rounded-lg bg-slate-700/50 hover:bg-slate-600/50 border border-slate-600/50 text-slate-300 text-sm font-medium transition-all"
              >
                Close
              </button>
            </div>
            <div className="h-80 bg-slate-800/50 rounded-xl border border-slate-700/50 p-4 relative overflow-hidden">
              <MeterChart data={meterData} />
            </div>
          </div>
        )}

        {/* Expanded Current Weather Chart */}
        {showCurrentWeatherChart && weatherCurrent?.dataPoints?.length > 0 && (
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 to-slate-800 border border-cyan-700/40 p-6 animate-in fade-in slide-in-from-top-2 duration-300">
            <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-bl from-cyan-500/10 to-transparent rounded-full blur-3xl" />
            <div className="relative flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-cyan-500/10">
                  <Cloud className="w-5 h-5 text-cyan-400" />
                </div>
                <h3 className="text-lg font-semibold text-white">Current Weather Trend</h3>
              </div>
              <button
                onClick={toggleCurrentWeatherChart}
                className="px-4 py-2 rounded-lg bg-slate-700/50 hover:bg-slate-600/50 border border-slate-600/50 text-slate-300 text-sm font-medium transition-all"
              >
                Close
              </button>
            </div>
            <div className="h-[420px] bg-slate-800/50 rounded-xl border border-slate-700/50 p-4 relative overflow-hidden">
              <WeatherChart data={weatherCurrent} />
            </div>
          </div>
        )}

        {/* Expanded Minutely Weather Chart */}
        {showMinutelyWeatherChart && weatherMinutely?.dataPoints?.length > 0 && (
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 to-slate-800 border border-sky-700/40 p-6 animate-in fade-in slide-in-from-top-2 duration-300">
            <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-bl from-sky-500/10 to-transparent rounded-full blur-3xl" />
            <div className="relative flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-sky-500/10">
                  <Clock className="w-5 h-5 text-sky-400" />
                </div>
                <h3 className="text-lg font-semibold text-white">Minutely Weather Trend</h3>
              </div>
              <button
                onClick={toggleMinutelyWeatherChart}
                className="px-4 py-2 rounded-lg bg-slate-700/50 hover:bg-slate-600/50 border border-slate-600/50 text-slate-300 text-sm font-medium transition-all"
              >
                Close
              </button>
            </div>
            <div className="h-[420px] bg-slate-800/50 rounded-xl border border-slate-700/50 p-4 relative overflow-hidden">
              <WeatherChart
                data={weatherMinutely}
                series={[
                  { key: 'temperature', label: 'Temp (°C)', color: '#38bdf8' },
                  { key: 'wind', label: 'Wind (m/s)', color: '#a78bfa' },
                  { key: 'diffuse', label: 'Diffuse (W/m²)', color: '#f59e0b' },
                  { key: 'global', label: 'Global Tilted (W/m²)', color: '#22c55e' }
                ]}
              />
            </div>
          </div>
        )}

        {/* Data Validation Alerts */}
        <div className="rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 rounded-xl bg-indigo-500/10">
              <AlertCircle className="w-5 h-5 text-indigo-400" />
            </div>
            <h3 className="text-lg font-semibold text-white">DATA VALIDATION ALERTS</h3>
          </div>
          
          <div className="space-y-4">
            {meterDelay && meterDelay > 20 && (
              <div className="flex items-start gap-3 p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl">
                <AlertCircle className="w-5 h-5 text-amber-400 mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-white">Meter data delayed by {meterDelay} minutes</p>
                  <p className="text-xs text-slate-400 mt-1">Last update: {meterData?.lastReading ? new Date(meterData.lastReading).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'N/A'}</p>
                </div>
              </div>
            )}
            
            {forecastData && (
              <div className="flex items-start gap-3 p-4 bg-indigo-500/10 border border-indigo-500/20 rounded-xl">
                <CheckCircle className="w-5 h-5 text-indigo-400 mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-white">Forecast confidence: 92% - Good for scheduling</p>
                  <p className="text-xs text-slate-400 mt-1">Data quality indicators are within acceptable range</p>
                </div>
              </div>
            )}

            {latestWhatsAppMessage && latestWhatsAppMessage.status === 'Pending Review' && (
              <div className="flex items-start gap-3 p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl">
                <AlertCircle className="w-5 h-5 text-amber-400 mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-white">WhatsApp data pending review</p>
                  <p className="text-xs text-slate-400 mt-1">Manual input data requires validation before use</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* WhatsApp Manual Input Modal */}
      {showWhatsAppModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-slate-900 rounded-2xl shadow-2xl w-full max-w-2xl border border-slate-700 max-h-[90vh] flex flex-col my-8">
            <div className="px-6 py-5 border-b border-slate-700 bg-gradient-to-r from-slate-800/50 to-transparent flex-shrink-0">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-green-500/10">
                  <MessageSquare className="w-6 h-6 text-green-400" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-white">WhatsApp Template - Manual Input</h2>
                  <p className="text-sm text-slate-400 mt-1">[VEDANJAY - INTRADAY SITE UPDATE]</p>
                </div>
              </div>
            </div>
            
            <div className="p-6 space-y-4 overflow-auto flex-1">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="md:col-span-2">
                  <label className="text-sm font-semibold text-slate-300 mb-2 block">Plant ID / Name *</label>
                  <input 
                    type="text"
                    value={whatsappForm.plantName}
                    readOnly
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700 text-white text-sm"
                  />
                </div>
                
                <div>
                  <label className="text-sm font-semibold text-slate-300 mb-2 block">State *</label>
                  <input 
                    type="text"
                    value={whatsappForm.state}
                    readOnly
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700 text-white text-sm"
                  />
                </div>
                
                <div>
                  <label className="text-sm font-semibold text-slate-300 mb-2 block">Date (DD-MM-YYYY) *</label>
                  <input 
                    type="date"
                    value={whatsappForm.date}
                    onChange={(e) => setWhatsappForm({ ...whatsappForm, date: e.target.value })}
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                  />
                </div>
                
                <div>
                  <label className="text-sm font-semibold text-slate-300 mb-2 block">Time (HH:MM) *</label>
                  <input 
                    type="time"
                    value={whatsappForm.time}
                    onChange={(e) => setWhatsappForm({ ...whatsappForm, time: e.target.value })}
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                  />
                </div>
                
                <div>
                  <label className="text-sm font-semibold text-slate-300 mb-2 block">Current Generation (MW) *</label>
                  <input 
                    type="number"
                    step="0.01"
                    value={whatsappForm.currentGeneration}
                    onChange={(e) => setWhatsappForm({ ...whatsappForm, currentGeneration: e.target.value })}
                    placeholder="e.g., 125.5"
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                  />
                </div>
                
                <div>
                  <label className="text-sm font-semibold text-slate-300 mb-2 block">Expected Generation Trend (Next 1 Hour) *</label>
                  <select 
                    value={whatsappForm.expectedTrend}
                    onChange={(e) => setWhatsappForm({ ...whatsappForm, expectedTrend: e.target.value })}
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                  >
                    <option value="">Select Trend</option>
                    <option value="Increasing">Increasing</option>
                    <option value="Stable">Stable</option>
                    <option value="Decreasing">Decreasing</option>
                  </select>
                </div>
                
                <div>
                  <label className="text-sm font-semibold text-slate-300 mb-2 block">Curtailment Status *</label>
                  <select 
                    value={whatsappForm.curtailmentStatus ? 'Yes' : 'No'}
                    onChange={(e) => setWhatsappForm({ ...whatsappForm, curtailmentStatus: e.target.value === 'Yes' })}
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                  >
                    <option value="No">No</option>
                    <option value="Yes">Yes</option>
                  </select>
                </div>
                
                {whatsappForm.curtailmentStatus && (
                  <div>
                    <label className="text-sm font-semibold text-slate-300 mb-2 block">If Yes, Curtailment Reason *</label>
                    <select 
                      value={whatsappForm.curtailmentReason}
                      onChange={(e) => setWhatsappForm({ ...whatsappForm, curtailmentReason: e.target.value })}
                      className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                    >
                      <option value="">Select Reason</option>
                      <option value="Grid Constraint">Grid Constraint</option>
                      <option value="Weather">Weather</option>
                      <option value="Maintenance">Maintenance</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>
                )}
                
                <div>
                  <label className="text-sm font-semibold text-slate-300 mb-2 block">Weather Condition</label>
                  <select 
                    value={whatsappForm.weatherCondition}
                    onChange={(e) => setWhatsappForm({ ...whatsappForm, weatherCondition: e.target.value })}
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                  >
                    <option value="">Select Condition</option>
                    <option value="Clear">Clear</option>
                    <option value="Partly Cloudy">Partly Cloudy</option>
                    <option value="Cloudy">Cloudy</option>
                    <option value="Sudden Change">Sudden Change</option>
                  </select>
                </div>
                
                <div>
                  <label className="text-sm font-semibold text-slate-300 mb-2 block">Inverter Availability (%) (Optional)</label>
                  <input 
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    value={whatsappForm.inverterAvailability}
                    onChange={(e) => setWhatsappForm({ ...whatsappForm, inverterAvailability: e.target.value })}
                    placeholder="e.g., 95.5"
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                  />
                </div>
                
                <div className="md:col-span-2">
                  <label className="text-sm font-semibold text-slate-300 mb-2 block">Remarks (Optional)</label>
                  <textarea 
                    value={whatsappForm.remarks}
                    onChange={(e) => setWhatsappForm({ ...whatsappForm, remarks: e.target.value })}
                    placeholder="Additional notes or observations..."
                    rows={3}
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                  />
                </div>
              </div>
            </div>

            <div className="px-6 py-5 border-t border-slate-700 bg-slate-800/30 flex gap-3 flex-shrink-0">
              <button 
                onClick={() => setShowWhatsAppModal(false)}
                className="flex-1 px-4 py-3 rounded-xl bg-slate-700/50 hover:bg-slate-600/50 border border-slate-600/50 text-slate-300 font-semibold transition-all"
              >
                Cancel
              </button>
              <button 
                onClick={handleWhatsAppSubmit}
                disabled={createWhatsAppLoading}
                className="flex-1 px-4 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white font-semibold hover:from-indigo-500 hover:to-purple-500 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {createWhatsAppLoading ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Submitting...
                  </>
                ) : (
                  'Submit Data'
                )}
              </button>
            </div>
          </div>
        </div>
      )}



      {/* WhatsApp History Modal */}
      {showWhatsAppHistoryModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 rounded-2xl shadow-2xl w-full max-w-4xl border border-slate-700 max-h-[85vh] flex flex-col">
            <div className="px-6 py-5 border-b border-slate-700 bg-gradient-to-r from-slate-800/50 to-transparent flex-shrink-0">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-xl bg-green-500/10">
                    <MessageSquare className="w-6 h-6 text-green-400" />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-white">WhatsApp Message History</h2>
                    <p className="text-sm text-slate-400 mt-1">All incoming messages for this plant</p>
                  </div>
                </div>
                <button 
                  onClick={() => setShowWhatsAppHistoryModal(false)}
                  className="p-2 hover:bg-slate-800 rounded-lg transition-all"
                >
                  <X className="w-5 h-5 text-slate-400" />
                </button>
              </div>
            </div>
            
            <div className="p-6 overflow-y-auto flex-1 scrollbar-thin">
              {whatsappDataList?.data && whatsappDataList.data.length > 0 ? (
                <div className="space-y-4">
                  {whatsappDataList.data.map((msg) => (
                    <div key={msg.id} className="p-5 bg-slate-800/50 rounded-xl border border-slate-700/50 hover:bg-slate-800/70 transition-all">
                      <div className="flex items-start justify-between mb-3">
                        <div>
                          <p className="font-semibold text-white">{msg.plantName}</p>
                          <p className="text-xs text-slate-500 mt-1">
                            {new Date(msg.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} {msg.time}
                          </p>
                        </div>
                        <span className={`px-3 py-1 rounded-lg text-xs font-semibold ${
                          msg.status === 'Used' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                        }`}>
                          {msg.status}
                        </span>
                      </div>
                      <div className="text-sm text-white space-y-1.5">
                        <p><span className="text-slate-400">Generation:</span> {msg.currentGeneration} MW</p>
                        <p><span className="text-slate-400">Trend:</span> {msg.expectedTrend}</p>
                        {msg.curtailmentStatus && <p><span className="text-slate-400">Curtailment:</span> {msg.curtailmentReason}</p>}
                        {msg.remarks && <p className="text-slate-400 mt-2"><span className="text-slate-500">Remarks:</span> {msg.remarks}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12 text-sm text-slate-400">
                  <MessageSquare className="w-12 h-12 mx-auto mb-3 text-slate-600" />
                  <p>No WhatsApp messages found</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Forecast Chart Component - Plotly
function ForecastChart({ data, graphUrl }) {
  if (!data) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <div className="text-center">
          <LoadingSpinner />
          <p className="text-sm text-muted-foreground mt-2">Loading chart data...</p>
        </div>
      </div>
    );
  }

  if (graphUrl) {
    return (
      <div className="w-full h-full">
        <iframe
          src={graphUrl}
          title="Enercast Forecast Graph"
          className="w-full h-full rounded-lg border border-slate-700/50 bg-slate-900"
        />
      </div>
    );
  }

  if (!data?.dataPoints || !Array.isArray(data.dataPoints) || data.dataPoints.length === 0) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <div className="text-center text-muted-foreground">
          <BarChart3 className="w-12 h-12 mx-auto mb-2 opacity-50" />
          <p>No forecast data available</p>
          <p className="text-xs mt-2">Click LOAD to fetch forecast data</p>
        </div>
      </div>
    );
  }

  const points = data.dataPoints.map((point, i) => ({
    ...point,
    block: i + 1
  }));

  if (points.length === 0) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <div className="text-center text-muted-foreground">
          <BarChart3 className="w-12 h-12 mx-auto mb-2 opacity-50" />
          <p>No valid data points</p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-full">
      <Plot
        data={[
          {
            x: points.map(p => p.block),
            y: points.map(p => parseFloat(p.forecast || 0)),
            type: 'scatter',
            mode: 'lines',
            name: 'Forecast (MW)',
            line: { color: '#3b82f6', width: 2 }
          },
          {
            x: points.map(p => p.block),
            y: points.map(p => parseFloat(p.actual || 0)),
            type: 'scatter',
            mode: 'lines',
            name: 'Actual (MW)',
            line: { color: '#22c55e', width: 2 }
          }
        ]}
        layout={{
          margin: { l: 50, r: 20, t: 20, b: 40 },
          paper_bgcolor: 'rgba(0,0,0,0)',
          plot_bgcolor: 'rgba(0,0,0,0)',
          font: { color: '#cbd5e1', size: 11 },
          xaxis: {
            title: 'Block',
            tickvals: points.length >= 96 ? [1, 24, 48, 72, 96] : [
              1,
              Math.ceil(points.length * 0.25),
              Math.ceil(points.length * 0.5),
              Math.ceil(points.length * 0.75),
              points.length
            ],
            gridcolor: 'rgba(148,163,184,0.2)'
          },
          yaxis: {
            title: 'Power (MW)',
            gridcolor: 'rgba(148,163,184,0.2)'
          },
          legend: { orientation: 'h', x: 0, y: 1.1 }
        }}
        config={{ displayModeBar: false, responsive: true }}
        style={{ width: '100%', height: '100%' }}
        useResizeHandler
      />
    </div>
  );
}

// Meter Chart Component - Plotly
function MeterChart({ data }) {
  if (!data) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <div className="text-center">
          <LoadingSpinner />
          <p className="text-sm text-muted-foreground mt-2">Loading chart data...</p>
        </div>
      </div>
    );
  }

  if (!data?.dataPoints || !Array.isArray(data.dataPoints) || data.dataPoints.length === 0) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <div className="text-center text-muted-foreground">
          <BarChart3 className="w-12 h-12 mx-auto mb-2 opacity-50" />
          <p>No meter data available</p>
          <p className="text-xs mt-2">Click LOAD to fetch meter data</p>
        </div>
      </div>
    );
  }

  const points = data.dataPoints.map((point, i) => ({
    ...point,
    block: i + 1
  }));

  if (points.length === 0) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <div className="text-center text-muted-foreground">
          <BarChart3 className="w-12 h-12 mx-auto mb-2 opacity-50" />
          <p>No valid data points</p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-full">
      <Plot
        data={[
          {
            x: points.map(p => p.block),
            y: points.map(p => parseFloat(p.generation || 0)),
            type: 'scatter',
            mode: 'lines',
            name: 'Generation (MW)',
            line: { color: '#f59e0b', width: 2 }
          }
        ]}
        layout={{
          margin: { l: 50, r: 20, t: 20, b: 40 },
          paper_bgcolor: 'rgba(0,0,0,0)',
          plot_bgcolor: 'rgba(0,0,0,0)',
          font: { color: '#cbd5e1', size: 11 },
          xaxis: {
            title: 'Block',
            tickvals: points.length >= 96 ? [1, 24, 48, 72, 96] : [
              1,
              Math.ceil(points.length * 0.25),
              Math.ceil(points.length * 0.5),
              Math.ceil(points.length * 0.75),
              points.length
            ],
            gridcolor: 'rgba(148,163,184,0.2)'
          },
          yaxis: {
            title: 'Power (MW)',
            gridcolor: 'rgba(148,163,184,0.2)'
          },
          legend: { orientation: 'h', x: 0, y: 1.1 }
        }}
        config={{ displayModeBar: false, responsive: true }}
        style={{ width: '100%', height: '100%' }}
        useResizeHandler
      />
    </div>
  );
}
function WeatherChart({ data, series = [{ key: 'temperature', label: 'Temperature (°C)', color: '#38bdf8' }] }) {
  if (!data?.dataPoints || data.dataPoints.length === 0) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <div className="text-center text-muted-foreground">
          <Cloud className="w-10 h-10 mx-auto mb-2 opacity-50" />
          <p>No weather data available</p>
        </div>
      </div>
    );
  }

  const points = data.dataPoints.map((point, i) => ({
    ...point,
    block: i + 1
  }));

  const tickIndexes = points.length >= 5
    ? [0, Math.floor(points.length * 0.25), Math.floor(points.length * 0.5), Math.floor(points.length * 0.75), points.length - 1]
    : points.map((_, i) => i);
  const tickPairs = tickIndexes
    .map(i => ({ index: i, point: points[i] }))
    .filter(item => Boolean(item.point));
  const tickvals = tickPairs.map(item => item.point.block);
  const ticktext = tickPairs.map(item => {
    const rawTime = item.point.time;
    const dt = parseDateValue(rawTime);
    if (dt) {
      return dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    }
    if (typeof rawTime === 'string' && rawTime.length >= 16) {
      return rawTime.slice(11, 16);
    }
    return `B${item.index + 1}`;
  });

  return (
    <div className="w-full h-full">
      <Plot
        data={series.map(s => ({
          x: points.map(p => p.block),
          y: points.map(p => parseFloat(p[s.key] || 0)),
          type: 'scatter',
          mode: 'lines',
          name: s.label,
          line: { color: s.color, width: 2.5, shape: 'spline', smoothing: 0.4 },
          hovertemplate: `%{y:.2f}<extra>${s.label}</extra>`
        }))}
        layout={{
          margin: { l: 55, r: 20, t: 20, b: 45 },
          paper_bgcolor: 'rgba(0,0,0,0)',
          plot_bgcolor: 'rgba(0,0,0,0)',
          font: { color: '#cbd5e1', size: 11, family: 'Segoe UI, sans-serif' },
          hovermode: 'x unified',
          xaxis: {
            title: 'Time',
            tickvals,
            ticktext,
            gridcolor: 'rgba(148,163,184,0.2)',
            showspikes: true,
            spikecolor: 'rgba(148,163,184,0.6)',
            spikethickness: 1
          },
          yaxis: {
            title: 'Value',
            gridcolor: 'rgba(148,163,184,0.2)',
            zeroline: false
          },
          legend: {
            orientation: 'h',
            x: 0,
            y: 1.12,
            bgcolor: 'rgba(15,23,42,0.45)',
            bordercolor: 'rgba(148,163,184,0.2)',
            borderwidth: 1
          }
        }}
        config={{ displayModeBar: false, responsive: true }}
        style={{ width: '100%', height: '100%' }}
        useResizeHandler
      />
    </div>
  );
}










