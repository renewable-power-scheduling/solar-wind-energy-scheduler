import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Download, Filter } from 'lucide-react';
import { toast } from 'sonner';
import { useTheme } from '@/app/App';
import createPlotlyComponent from 'react-plotly.js/factory';
import Plotly from 'plotly.js-dist-min';
import { S3_BASE_URL } from '@/config/appConfig';

const Plot = createPlotlyComponent(Plotly);

const RAW_BASE_PREFIX = 'raw/vedanjay/GSNP/';
const GENERATED_OUTPUTS_BASE_PREFIX = 'generated/vedanjay/GSNP/outputs/';
const LEGACY_OUTPUTS_BASE_PREFIX = 'outputs/';
const DSM_THRESHOLD_PERCENT = 10;
const EPSILON = 0.001;
const S3_PRIMARY_PLANT = 'Globus Steel N Power (GSNP)';
const PLANT_CAPACITY_MW = {
  [S3_PRIMARY_PLANT]: 20,
};

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

function getLatestObject(objects, matcher) {
  const extractTrailingNumber = (key) => {
    const fileName = (key || '').split('/').pop() || '';
    const schedMatch = fileName.match(/schedule_from_(\d+)\.csv$/i);
    if (schedMatch) return parseInt(schedMatch[1], 10);
    const trailingMatch = fileName.match(/_(\d+)(?=\.[^.]+$)/);
    return trailingMatch ? parseInt(trailingMatch[1], 10) : null;
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

function extractTrailingNumber(key) {
  const fileName = (key || '').split('/').pop() || '';
  const schedMatch = fileName.match(/schedule_from_(\d+)\.csv$/i);
  if (schedMatch) return parseInt(schedMatch[1], 10);
  const trailingMatch = fileName.match(/_(\d+)(?=\.[^.]+$)/);
  return trailingMatch ? parseInt(trailingMatch[1], 10) : null;
}

function isNewerObject(candidate, current) {
  if (!current) return true;
  const cSeq = extractTrailingNumber(candidate.key);
  const pSeq = extractTrailingNumber(current.key);
  if (cSeq !== null && pSeq !== null && cSeq !== pSeq) return cSeq > pSeq;

  const cTime = Date.parse(candidate.lastModified || '');
  const pTime = Date.parse(current.lastModified || '');
  if (!Number.isNaN(cTime) && !Number.isNaN(pTime) && cTime !== pTime) return cTime > pTime;

  return String(candidate.key || '').localeCompare(String(current.key || '')) > 0;
}

function sortLatestFirst(items) {
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

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = lines[0].split(',').map((h) => h.trim());
  const rows = lines.slice(1).map((line) => line.split(',').map((v) => v.trim()));
  return { headers, rows };
}

function blockToTime(block) {
  const idx = Math.max(0, Number(block) - 1);
  const h = Math.floor((idx * 15) / 60);
  const m = (idx * 15) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function getCurrentIstBlock() {
  const now = new Date();
  const istNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const totalMinutes = (istNow.getHours() * 60) + istNow.getMinutes();
  const block = Math.floor(totalMinutes / 15) + 1;
  return Math.min(Math.max(block, 1), 96);
}

function parseScheduleBlocks(text) {
  const { headers, rows } = parseCsv(text);
  const normalized = headers.map((h) => h.toLowerCase().replace(/["']/g, '').replace(/[\s_-]+/g, ''));
  const blockCol = normalized.findIndex((h) => h.includes('block'));
  const algoCol = normalized.findIndex((h) => h.includes('algoschedule') || h.includes('scheduledmw') || h.includes('schedule'));
  const intradayCol = normalized.findIndex((h) => h.includes('intradayforecast') || h.includes('intraday'));

  return rows
    .map((cols) => {
      const block = parseInt(cols[blockCol], 10);
      const algo = parseFloat(cols[algoCol]);
      const intraday = parseFloat(cols[intradayCol]);
      const scheduled = Number.isFinite(algo) ? algo : (Number.isFinite(intraday) ? intraday : 0);
      return { block, scheduled };
    })
    .filter((r) => Number.isFinite(r.block) && r.block >= 1 && r.block <= 96);
}

function parseMeterBlocks(text) {
  const { headers, rows } = parseCsv(text);
  const normalized = headers.map((h) => h.toLowerCase());
  const powerIdx = normalized.findIndex((h) =>
    h.includes('meter power') || h.includes('active power') || h.includes('generation') || h.includes('kw')
  );
  if (powerIdx === -1) return [];

  // Detect unit from header text; fallback to heuristic when unit is unclear.
  const powerHeader = normalized[powerIdx] || '';
  const explicitKw = powerHeader.includes('(kw)') || powerHeader.includes(' kw');
  const explicitMw = powerHeader.includes('(mw)') || powerHeader.includes(' mw');

  const parsedRaw = rows.slice(0, 96).map((cols) => {
    const raw = cols[powerIdx];
    const value = parseFloat(raw);
    const hasReading = raw !== undefined && raw !== null && String(raw).trim() !== '' && Number.isFinite(value);
    return { hasReading, value: hasReading ? value : null };
  });
  const nonZero = parsedRaw.map((x) => x.value).filter((v) => Number.isFinite(v) && v > 0);
  const avg = nonZero.length ? (nonZero.reduce((a, b) => a + b, 0) / nonZero.length) : 0;
  const assumeKw = explicitKw || (!explicitMw && avg > 200); // typical kW series often >200 for utility plants
  const factor = assumeKw ? 1 / 1000 : 1; // keep MW as-is

  return parsedRaw
    .map((item, idx) => (
      item.hasReading
        ? { block: idx + 1, actual: item.value * factor }
        : null
    ))
    .filter(Boolean);
}

function extractPlantFromKey(key, selectedDate) {
  const normalizedKey = String(key || '').replace(/\\/g, '/');
  const datePrefixes = getSchedulePrefixes(selectedDate);
  const rootDatePrefix = `${selectedDate}/`;

  for (const datePrefix of datePrefixes) {
    if (normalizedKey.startsWith(datePrefix)) {
      const rest = normalizedKey.slice(datePrefix.length);
      const seg = rest.split('/').filter(Boolean);
      if (seg.length > 1) {
        const first = seg[0].toLowerCase();
        if (!['meter', 'intraday', 'weather', 'reports', 'metered_data', 'weather_data', 'enercast_data'].includes(first)) {
          return seg[0];
        }
      }
    }
  }

  // Pattern A (root): {date}/{plant}/...
  if (normalizedKey.startsWith(rootDatePrefix)) {
    const rest = normalizedKey.slice(rootDatePrefix.length);
    const seg = rest.split('/').filter(Boolean);
    if (seg.length > 1) {
      const first = seg[0].toLowerCase();
      if (!['meter', 'intraday', 'weather', 'reports'].includes(first)) {
        return seg[0];
      }
    }
  }

  const parts = normalizedKey.split('/').filter(Boolean);
  const dateIdx = parts.findIndex((p) => p === selectedDate);
  if (parts[0] === 'outputs' && dateIdx === 2) {
    return parts[1];
  }

  return null;
}

function getPlantTypeFromName(name) {
  if (name === S3_PRIMARY_PLANT) return 'Solar';
  const n = String(name || '').toLowerCase();
  if (n.includes('solar') || n.includes('pv')) return 'Solar';
  return 'Solar';
}

function getPlantCapacityMw(name) {
  return PLANT_CAPACITY_MW[name] ?? 20;
}

function getSchedulePrefixes(date) {
  return [
    `${RAW_BASE_PREFIX}${date}/`,
    `${GENERATED_OUTPUTS_BASE_PREFIX}${date}/`,
    `${LEGACY_OUTPUTS_BASE_PREFIX}${date}/`,
  ];
}

export function DeviationDSM() {
  const { isDarkMode } = useTheme();
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [selectedPlant, setSelectedPlant] = useState('Select Plant');
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);
  const [availablePlants, setAvailablePlants] = useState([]);
  const [scheduleFileByPlant, setScheduleFileByPlant] = useState({});
  const [showTrendFullscreen, setShowTrendFullscreen] = useState(false);

  const plantFilterOptions = useMemo(
    () => ['Select Plant', ...Array.from(new Set([S3_PRIMARY_PLANT, ...availablePlants]))],
    [availablePlants]
  );

  useEffect(() => {
    const loadBlockwise = async () => {
      setLoading(true);
      try {
        const dateScopedObjectsOutputs = await listS3ObjectsAcrossPrefixes(getSchedulePrefixes(selectedDate));
        const dateScopedObjectsRoot = await listS3Objects(`${selectedDate}/`);
        const rootObjects = await listS3Objects(LEGACY_OUTPUTS_BASE_PREFIX);
        const allObjects = [...dateScopedObjectsOutputs, ...dateScopedObjectsRoot, ...rootObjects].filter((o) =>
          o.key.includes(`/${selectedDate}/`) ||
          o.key.startsWith(`${RAW_BASE_PREFIX}${selectedDate}/`) ||
          o.key.startsWith(`${GENERATED_OUTPUTS_BASE_PREFIX}${selectedDate}/`) ||
          o.key.startsWith(`${LEGACY_OUTPUTS_BASE_PREFIX}${selectedDate}/`) ||
          o.key.startsWith(`${selectedDate}/`)
        );

        if (!allObjects.length) {
          setRows([]);
          setAvailablePlants([]);
          toast.error(`No S3 files found for ${selectedDate}`);
          return;
        }

        const todayIst = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        const isTodaySelected = selectedDate === todayIst;
        const currentIstBlock = isTodaySelected ? getCurrentIstBlock() : 96;

        const plantToSchedule = new Map();
        const plantToMeter = new Map();

        allObjects.forEach((obj) => {
          const keyLower = obj.key.toLowerCase();
          const plant = extractPlantFromKey(obj.key, selectedDate) || S3_PRIMARY_PLANT;

          if (
            keyLower.endsWith('.csv') &&
            !keyLower.includes('/intraday/') &&
            (keyLower.includes('schedule_from_') || (keyLower.split('/').pop() || '').startsWith('gsnp_dc_reg_'))
          ) {
            const prev = plantToSchedule.get(plant);
            if (isNewerObject(obj, prev)) {
              plantToSchedule.set(plant, obj);
            }
          }

          if ((keyLower.includes('/meter/') || keyLower.includes('meter')) && keyLower.endsWith('.csv')) {
            const prev = plantToMeter.get(plant);
            if (isNewerObject(obj, prev)) {
              plantToMeter.set(plant, obj);
            }
          }
        });

        const plants = Array.from(new Set([...plantToSchedule.keys(), ...plantToMeter.keys()]));
        const scheduleFileNameMap = Object.fromEntries(
          plants.map((plant) => [plant, (plantToSchedule.get(plant)?.key || '').split('/').pop() || 'N/A'])
        );
        setScheduleFileByPlant(scheduleFileNameMap);
        setAvailablePlants(plants);
        if (selectedPlant !== 'Select Plant' && plants.length && !plants.includes(selectedPlant)) {
          setSelectedPlant('Select Plant');
        }

        const allRows = [];
        for (const plant of plants) {
          const scheduleFile = plantToSchedule.get(plant);
          const [scheduleText] = await Promise.all([
            scheduleFile
              ? fetch(
                  `${S3_BASE_URL}/${String(scheduleFile.key || '').split('/').map((s) => encodeURIComponent(s)).join('/')}`
                ).then((r) => r.text())
              : Promise.resolve(''),
          ]);

          const scheduleBlocks = parseScheduleBlocks(scheduleText);
          // Collect meter candidates for this plant and pick first valid/non-zero parse.
          const meterCandidates = allObjects
            .filter((obj) => {
              const p = extractPlantFromKey(obj.key, selectedDate) || 'Default';
              const k = obj.key.toLowerCase();
              return p === plant && (k.includes('/meter/') || k.includes('meter')) && k.endsWith('.csv');
            })
            .sort((a, b) => {
              const aSeq = extractTrailingNumber(a.key);
              const bSeq = extractTrailingNumber(b.key);
              if (aSeq !== null && bSeq !== null && bSeq !== aSeq) return bSeq - aSeq;
              const aTime = Date.parse(a.lastModified || '');
              const bTime = Date.parse(b.lastModified || '');
              const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
              if (timeDiff !== 0) return timeDiff;
              return (b.key || '').localeCompare(a.key || '');
            });

          let meterBlocks = [];
          for (const candidate of meterCandidates) {
            try {
              const text = await fetch(
                `${S3_BASE_URL}/${String(candidate.key || '').split('/').map((s) => encodeURIComponent(s)).join('/')}`
              ).then((r) => r.text());
              const parsed = parseMeterBlocks(text);
              const nonZeroCount = parsed.filter((x) => x.actual > 0).length;
              if (parsed.length && nonZeroCount > 0) {
                meterBlocks = parsed;
                break;
              }
              if (!meterBlocks.length && parsed.length) {
                meterBlocks = parsed;
              }
            } catch {
              // Try next candidate
            }
          }

          // Fallback to pre-picked latest meter mapping if candidate scan yielded nothing
          if (!meterBlocks.length) {
            const meterFile = plantToMeter.get(plant);
            if (meterFile) {
              const meterText = await fetch(
                `${S3_BASE_URL}/${String(meterFile.key || '').split('/').map((s) => encodeURIComponent(s)).join('/')}`
              ).then((r) => r.text());
              meterBlocks = parseMeterBlocks(meterText);
            }
          }

          const sm = new Map(scheduleBlocks.map((x) => [x.block, x.scheduled]));
          const mm = new Map(meterBlocks.map((x) => [x.block, x.actual]));

          const availableBlocks = Array.from(mm.keys())
            .filter((block) => !isTodaySelected || block <= currentIstBlock)
            .sort((a, b) => a - b);
          for (const block of availableBlocks) {
            const scheduled = sm.get(block) ?? 0;
            const actual = mm.get(block);
            if (!Number.isFinite(actual)) continue;
            const deviation = actual - scheduled;
            const capacityMw = getPlantCapacityMw(plant);
            const allowedMw = (capacityMw * DSM_THRESHOLD_PERCENT) / 100;
            const percentage = (deviation / Math.max(Math.abs(capacityMw), EPSILON)) * 100;
            const isBreach = Math.abs(deviation) > allowedMw;
            allRows.push({
              block,
              time: blockToTime(block),
              plant,
              type: getPlantTypeFromName(plant),
              capacityMw,
              allowedMw,
              scheduled,
              actual,
              deviation,
              percentage,
              status: isBreach ? 'DSM Breach' : 'Normal',
            });
          }
        }

        setRows(allRows);
      } catch (e) {
        console.error(e);
        setRows([]);
        setAvailablePlants([]);
        setScheduleFileByPlant({});
        toast.error('Failed to load block-wise deviation from S3');
      } finally {
        setLoading(false);
      }
    };

    loadBlockwise();
  }, [selectedDate]);

  const filteredRows = useMemo(() => {
    if (selectedPlant === 'Select Plant') return [];
    return rows.filter((r) => r.plant === selectedPlant);
  }, [rows, selectedPlant]);

  const summary = useMemo(() => {
    if (!filteredRows.length) return { avg: 0, max: 0, within: 0, dsm: 0 };
    const abs = filteredRows.map((r) => Math.abs(r.percentage));
    const dsm = abs.filter((x) => x > DSM_THRESHOLD_PERCENT).length;
    return {
      avg: abs.reduce((a, b) => a + b, 0) / abs.length,
      max: Math.max(...abs),
      within: Math.round(((filteredRows.length - dsm) / filteredRows.length) * 100),
      dsm,
    };
  }, [filteredRows]);

  const chartData = useMemo(
    () => filteredRows.map((r, idx) => ({
      idx,
      value: r.deviation,
      block: r.block,
      time: r.time,
      percentage: r.percentage,
      allowedMw: r.allowedMw,
      status: r.status,
    })),
    [filteredRows]
  );

  const trendChartConfig = useMemo(() => {
    const limitMw = chartData.length
      ? Math.max(...chartData.map((d) => Math.abs(d.allowedMw || 0)))
      : 0;
    const maxAbs = chartData.length
      ? Math.max(...chartData.map((d) => Math.abs(d.value)))
      : 1;
    const yMax = Math.max(maxAbs, limitMw, 1);

    const tickvals = [1, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 96];
    const ticktext = tickvals.map((v) => `B${v}`);

    const data = [
      {
        type: 'bar',
        x: chartData.map((d) => d.block),
        y: chartData.map((d) => d.value),
        marker: {
          color: chartData.map((d) => (Math.abs(d.value) > (d.allowedMw || 0) ? '#ef4444' : '#10b981')),
          line: {
            color: isDarkMode ? '#0f172a' : '#e2e8f0',
            width: 0.6,
          },
        },
        customdata: chartData.map((d) => [d.time, d.percentage, d.status, d.allowedMw || 0]),
        hovertemplate:
          '<b>Block B%{x}</b><br>' +
          'Time: %{customdata[0]}<br>' +
          'Deviation: %{y:.3f} MW<br>' +
          'Deviation %: %{customdata[1]:+.2f}%<br>' +
          'DSM Limit: ±%{customdata[3]:.3f} MW<br>' +
          'Status: %{customdata[2]}<extra></extra>',
      },
    ];

    const layout = {
      margin: { l: 56, r: 18, t: 18, b: 44 },
      paper_bgcolor: isDarkMode ? 'rgba(0,0,0,0)' : '#ffffff',
      plot_bgcolor: isDarkMode ? 'rgba(0,0,0,0)' : '#ffffff',
      font: { color: isDarkMode ? '#cbd5e1' : '#1f2937', size: 11 },
      xaxis: {
        title: 'Block Number',
        tickmode: 'array',
        tickvals,
        ticktext,
        range: [0.5, 96.5],
        showline: true,
        linecolor: isDarkMode ? '#334155' : '#94a3b8',
        gridcolor: isDarkMode ? 'rgba(148,163,184,0.14)' : 'rgba(100,116,139,0.18)',
      },
      yaxis: {
        title: 'Deviation (MW)',
        range: [-(yMax * 1.25), yMax * 1.25],
        zeroline: true,
        zerolinecolor: isDarkMode ? '#64748b' : '#64748b',
        zerolinewidth: 1.3,
        gridcolor: isDarkMode ? 'rgba(148,163,184,0.14)' : 'rgba(100,116,139,0.18)',
      },
      shapes: limitMw > 0
        ? [
            {
              type: 'line',
              xref: 'x',
              yref: 'y',
              x0: 1,
              x1: 96,
              y0: limitMw,
              y1: limitMw,
              line: { color: '#f59e0b', width: 1.2, dash: 'dot' },
            },
            {
              type: 'line',
              xref: 'x',
              yref: 'y',
              x0: 1,
              x1: 96,
              y0: -limitMw,
              y1: -limitMw,
              line: { color: '#f59e0b', width: 1.2, dash: 'dot' },
            },
          ]
        : [],
      showlegend: false,
      hovermode: 'x',
      hoverlabel: {
        bgcolor: isDarkMode ? '#1f2937' : '#ffffff',
        bordercolor: isDarkMode ? '#334155' : '#cbd5e1',
        font: { color: isDarkMode ? '#e2e8f0' : '#0f172a', size: 12 },
      },
    };

    return { data, layout };
  }, [chartData, isDarkMode]);

  const exportCsv = () => {
    const headers = ['Block', 'Time', 'Plant', 'Type', 'Scheduled MW', 'Actual MW', 'Deviation MW', 'Deviation %', 'Status'];
    const csv = [
      headers.join(','),
      ...filteredRows.map((r) => [r.block, r.time, r.plant, r.type, r.scheduled.toFixed(3), r.actual.toFixed(3), r.deviation.toFixed(3), r.percentage.toFixed(2), r.status].join(',')),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `blockwise-dsm-${selectedDate}.csv`;
    link.click();
  };

  const TrendChart = ({ className = 'h-56' }) => (
    <div className={`${className} bg-card rounded border border-border p-2`}>
      <Plot
        data={trendChartConfig.data}
        layout={trendChartConfig.layout}
        config={{ displayModeBar: false, responsive: true }}
        style={{ width: '100%', height: '100%' }}
        useResizeHandler
      />
    </div>
  );

  return (
    <div className="flex-1 h-full overflow-auto bg-background p-6 space-y-6">
      <div className="rounded-xl border border-border bg-card p-4 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-foreground">Deviation & DSM (Block-wise)</h2>
          <p className="text-muted-foreground text-sm">Dynamic plant/date from S3 (latest schedule + latest meter CSV per plant)</p>
          {selectedPlant !== 'Select Plant' && (
            <p className="text-muted-foreground text-sm mt-1">
              Schedule used: <span className="text-foreground font-medium">{scheduleFileByPlant[selectedPlant] || 'N/A'}</span>
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} className="px-3 py-2 rounded bg-background text-foreground border border-border transition-all duration-200 hover:border-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30" />
          <select value={selectedPlant} onChange={(e) => setSelectedPlant(e.target.value)} className="px-3 py-2 rounded bg-background text-foreground border border-border transition-all duration-200 hover:border-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30">
            {plantFilterOptions.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <button onClick={exportCsv} className="px-4 py-2 rounded bg-indigo-600 text-white flex items-center gap-2 transition-all duration-200 hover:bg-indigo-500 hover:shadow-md hover:shadow-indigo-300/40"><Download className="w-4 h-4" />Export</button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="rounded-xl border border-border bg-card p-4 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md hover:shadow-slate-200/70 dark:hover:shadow-black/25"><p className="text-muted-foreground text-sm">Avg Deviation</p><p className="text-3xl font-bold text-red-500">{summary.avg.toFixed(2)}%</p></div>
        <div className="rounded-xl border border-border bg-card p-4 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md hover:shadow-slate-200/70 dark:hover:shadow-black/25"><p className="text-muted-foreground text-sm">Max Deviation</p><p className="text-3xl font-bold text-amber-500">{summary.max.toFixed(2)}%</p></div>
        <div className="rounded-xl border border-border bg-card p-4 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md hover:shadow-slate-200/70 dark:hover:shadow-black/25"><p className="text-muted-foreground text-sm">Within DSM Limit</p><p className="text-3xl font-bold text-emerald-600">{summary.within}%</p></div>
        <div className="rounded-xl border border-border bg-card p-4 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md hover:shadow-slate-200/70 dark:hover:shadow-black/25"><p className="text-muted-foreground text-sm">DSM Breaches</p><p className="text-3xl font-bold text-violet-600">{summary.dsm}</p></div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-foreground font-semibold mb-1">Deviation Trend Analysis (Block-wise)</h3>
            <p className="text-muted-foreground text-sm">Block B1 to B96 deviation (MW)</p>
          </div>
          <button
            onClick={() => setShowTrendFullscreen(true)}
            className="px-3 py-2 rounded bg-indigo-600 text-white text-sm hover:bg-indigo-500"
          >
            Full Screen
          </button>
        </div>
        <TrendChart />
      </div>

      <div className="rounded-xl border border-border bg-card overflow-auto max-h-[65vh]">
        {loading ? (
          <div className="p-8 text-muted-foreground">Loading block-wise data...</div>
        ) : (
          <table className="w-full">
            <thead className="sticky top-0 bg-muted">
              <tr>
                {['Block/Time', 'Plant', 'Type', 'Scheduled', 'Actual', 'Deviation', 'Percentage', 'Status'].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-xs text-foreground uppercase">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredRows.map((r) => (
                <tr key={`${r.plant}-${r.block}`} className="hover:bg-muted/50">
                  <td className="px-4 py-3 text-foreground font-medium">{`B${r.block} - ${r.time}`}</td>
                  <td className="px-4 py-3 text-foreground">{r.plant}</td>
                  <td className="px-4 py-3 text-muted-foreground">{r.type}</td>
                  <td className="px-4 py-3 text-foreground">{r.scheduled.toFixed(3)} MW</td>
                  <td className="px-4 py-3 text-foreground font-semibold">{r.actual.toFixed(3)} MW</td>
                  <td className={`px-4 py-3 font-semibold ${Math.abs(r.percentage) > DSM_THRESHOLD_PERCENT ? 'text-red-600' : 'text-emerald-700'}`}>{r.deviation >= 0 ? '+' : ''}{r.deviation.toFixed(3)} MW</td>
                  <td className={`px-4 py-3 font-semibold ${Math.abs(r.percentage) > DSM_THRESHOLD_PERCENT ? 'text-red-600' : 'text-emerald-700'}`}>{r.percentage >= 0 ? '+' : ''}{r.percentage.toFixed(2)}%</td>
                  <td className="px-4 py-3">
                    {Math.abs(r.percentage) > DSM_THRESHOLD_PERCENT ? (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-red-500/15 text-red-600 text-xs"><AlertTriangle className="w-3 h-3" />DSM Breach</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-emerald-500/15 text-emerald-700 text-xs">Normal</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="text-xs text-muted-foreground flex items-center gap-2">
        <Filter className="w-3 h-3" /> DSM threshold applied: {DSM_THRESHOLD_PERCENT}%
      </div>

      {showTrendFullscreen && (
        <div className="fixed inset-0 z-50 bg-black/50 p-4 md:p-8">
          <div className="h-full w-full rounded-xl border border-border bg-card p-4 md:p-6 flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-foreground text-lg font-semibold">Deviation Trend Analysis (Block-wise)</h3>
                <p className="text-muted-foreground text-sm">Block B1 to B96 deviation (MW)</p>
              </div>
              <button
                onClick={() => setShowTrendFullscreen(false)}
                className="px-3 py-2 rounded bg-muted text-foreground text-sm hover:bg-muted/70"
              >
                Close
              </button>
            </div>
            <TrendChart className="flex-1 min-h-0" />
          </div>
        </div>
      )}
    </div>
  );
}

export default DeviationDSM;
