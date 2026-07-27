import { useEffect, useMemo, useState } from 'react';
import createPlotlyComponent from 'react-plotly.js/factory';
import Plotly from 'plotly.js-dist-min';
import {
  Check,
  ChevronDown,
  Plus,
  Settings2,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '@/services/api';
import { fetchTextFromS3Optional, listS3ObjectsAcrossPrefixes } from '@/services/s3Utils';
import { useAuth } from '@/app/appContexts';
import { isAdminUser } from '@/utils/plantAccess';

let Plot = null;
try {
  Plot = createPlotlyComponent(Plotly);
} catch (error) {
  console.error('Failed to initialize Plotly for MultiGeneratorSchedule:', error);
}

const DEFAULT_BUYERS = ['AEML', 'OA-MSEDCL'];
const PLANT_ID = 'ZETRIC_SOLAR_PARK';
const MULTI_GENERATOR_S3_PLANT_CODE = 'ZTRIC';
const MULTI_GENERATOR_S3_BASE = `raw/vedanjay/multiple_generator/${MULTI_GENERATOR_S3_PLANT_CODE}`;
const MULTI_GENERATOR_GENERATED_BASE = `generated/vedanjay/multiple_generator/${MULTI_GENERATOR_S3_PLANT_CODE}`;
const GRAPH_SERIES_OPTIONS = [
  { key: 'systemSchedule', label: 'System Schedule' },
  { key: 'intraday', label: 'Enercast Forecast' },
  { key: 'meter', label: 'Meter Data' },
  { key: 'allowedBand', label: 'Allowed Band' },
  { key: 'dayAhead', label: 'Day-ahead' },
];

const INITIAL_PLANT = {
  plantName: 'ZETRIC',
  state: 'Maharashtra',
  location: 'Chakur, Maharashtra',
  latitude: '18.557968',
  longitude: '76.859083',
  totalCapacityAcMw: '25',
  totalCapacityDcMw: '25',
  schedulingCapacityAcMw: '14.485',
  schedulingCapacityDcMw: '14.485',
  revisionType: 'INTRADAY',
  schedulingEntity: 'MH_VEDANJAY',
  posName: 'Chakur 132kV',
  downstreamName: 'Chakur 132kV',
  energyType: 'SOLAR',
  contractType: 'MTOA',
  exchangeType: 'NA',
  transactionType: 'INTRA',
  reGeneratorName: 'Chakur 132kV',
  path: 'A-B',
  stuName: 'Chakur 132kV',
};

const INITIAL_BUYERS = {
  AEML: {
    scheduleCapacityMw: '6',
    contractId: 'CONTRACT24315',
    approvalNumber: 'Chakur/S/07/26/AEML',
  },
  'OA-MSEDCL': {
    scheduleCapacityMw: '8.485',
    contractId: 'CONTRACT23871',
    approvalNumber: 'CHAKUR/S/07/26/OA-MSEDCL',
  },
};

const INITIAL_ASSETS = [
  { id: 'polybond', assetName: 'Polybond', buyer: 'OA-MSEDCL', acCapacityMw: '3.3', dcCapacityMw: '4.5', meterAvailable: true },
  { id: 'sn-heat', assetName: 'S.N.Heat', buyer: 'OA-MSEDCL', acCapacityMw: '1.48', dcCapacityMw: '2', meterAvailable: true },
  { id: 'integrated', assetName: 'Integrated', buyer: 'OA-MSEDCL', acCapacityMw: '1.206', dcCapacityMw: '1', meterAvailable: true },
  { id: 'de-solar', assetName: 'DE Solar', buyer: 'AEML', acCapacityMw: '2.4', dcCapacityMw: '3', meterAvailable: true },
  { id: 'indiqube', assetName: 'Indiqube', buyer: 'OA-MSEDCL', acCapacityMw: '2.95', dcCapacityMw: '4.015', meterAvailable: true },
  { id: 'gajlaxmi', assetName: 'Gajlaxmi', buyer: 'AEML', acCapacityMw: '2', dcCapacityMw: '1.5', meterAvailable: true },
  { id: 'chakur-one-block-1', assetName: 'CHAKUR ONE BLOCK 1', buyer: 'AEML', acCapacityMw: '1.8', dcCapacityMw: '2.443', meterAvailable: true },
  { id: 'chakur-one-block-2', assetName: 'CHAKUR ONE BLOCK 2', buyer: 'AEML', acCapacityMw: '4.2', dcCapacityMw: '4.569', meterAvailable: true },
];

const createPlantId = (name) =>
  String(name || `plant-${Date.now()}`).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_') || `PLANT_${Date.now()}`;

const createGeneratorPlant = (config = INITIAL_PLANT) => ({
  id: createPlantId(config.plantName),
  ...config,
});

const toNumber = (value, fallback = 0) => {
  const num = Number(String(value ?? '').trim());
  return Number.isFinite(num) ? num : fallback;
};

const formatNumber = (value, decimals = 3) => {
  const num = toNumber(value);
  if (Math.abs(num - Math.trunc(num)) < 1e-9) return String(Math.trunc(num));
  return num.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '');
};

const blockToTime = (block) => {
  const minutes = (block - 1) * 15;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};

const buildDeclaredForecast = (capacityMw) =>
  Array.from({ length: 96 }, (_, idx) => {
    const block = idx + 1;
    const hour = ((block - 1) * 15) / 60;
    const isDaylight = hour >= 5.75 && hour <= 18.75;
    const curve = isDaylight ? Math.sin(((hour - 5.75) / 13) * Math.PI) : 0;
    return {
      block,
      time: blockToTime(block),
      declaredForecast: Number(Math.max(0, curve * capacityMw * 0.72).toFixed(3)),
    };
  });

const csvEscape = (value) => {
  const text = String(value ?? '');
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
};

const parseCsvRows = (text) => {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  const input = String(text || '');
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows.filter((items) => items.some((item) => String(item || '').trim()));
};

const normalizeToken = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
const normalizeAssetFolder = (value) => {
  const compact = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (compact === 'S_N_HEAT') return 'SNHEAT';
  if (compact === 'DE_SOLAR') return 'DE_SOLAR';
  return compact;
};

const yyyymmdd = (dateKey) => String(dateKey || '').replace(/-/g, '');
const ZETRIC_PLANT_VALUE_COLUMNS = ['ztricpark', 'zetricpark', 'ztric', 'zetric'];
const ZETRIC_SYSTEM_SCHEDULE_VALUE_COLUMNS = ['sourceforecastmw', 'sourceforecast'];
const ZETRIC_DAY_AHEAD_VALUE_COLUMNS = ['sourceforecastmw', 'sourceforecast'];

const parseBlockSeries = (csvText, options = {}) => {
  const preferredColumns = Array.isArray(options?.preferredColumns) ? options.preferredColumns : [];
  const rows = parseCsvRows(csvText);
  if (!rows.length) return new Map();
  let headerIndex = rows.findIndex((row) =>
    row.some((cell) => ['block', 'blockno', 'blkno', 'srno'].includes(normalizeToken(cell)))
  );
  if (headerIndex < 0) headerIndex = 0;
  const headers = rows[headerIndex].map(normalizeToken);
  const findCol = (names, fallback = -1) => {
    const normalized = names.map(normalizeToken);
    for (const name of normalized) {
      const idx = headers.findIndex((header) => header === name || (name && header.includes(name)));
      if (idx >= 0) return idx;
    }
    return fallback;
  };
  const blockCol = findCol(['block', 'blockno', 'blkno', 'srno'], 0);
  const preferredCol = findCol(preferredColumns, -1);
  let valueCol = preferredCol >= 0 ? preferredCol : findCol([
    'algo_schedule_mw',
    'stationschedule',
    'schedule',
    'declaredforecast',
    'forecast',
    'power',
    'mw',
  ], headers.length > 1 ? 1 : -1);
  const out = new Map();
  rows.slice(headerIndex + 1).forEach((row, index) => {
    const parsedBlock = Number(String(row?.[blockCol] || '').trim());
    const block = Number.isFinite(parsedBlock) ? Math.trunc(parsedBlock) : index + 1;
    if (block < 1 || block > 96) return;
    const rawValue = String(row?.[valueCol] ?? '').replace(/,/g, '').trim();
    const value = Number(rawValue);
    out.set(block, Number.isFinite(value) ? value : 0);
  });
  return out;
};

const pickLatestCsv = (items) => (Array.isArray(items) ? items : [])
  .filter((item) => String(item?.key || '').toLowerCase().endsWith('.csv'))
  .sort((a, b) => String(b?.lastModified || '').localeCompare(String(a?.lastModified || '')))[0] || null;

const pickLatestDayAheadCsv = (items) => {
  const csvItems = (Array.isArray(items) ? items : [])
    .filter((item) => String(item?.key || '').toLowerCase().endsWith('.csv'));
  const scheduleFromItems = csvItems.filter((item) =>
    /\/day-ahead\/schedule_from_\d+(?:[_-][a-z0-9]+)*\.csv$/i.test(String(item?.key || ''))
  );
  return pickLatestCsv(scheduleFromItems.length ? scheduleFromItems : csvItems);
};

const sumSeriesMaps = (maps) => {
  const out = new Map();
  (Array.isArray(maps) ? maps : []).forEach((map) => {
    for (let block = 1; block <= 96; block += 1) {
      out.set(block, (out.get(block) || 0) + Number(map?.get?.(block) || 0));
    }
  });
  return out;
};

const scaleSeriesMap = (map, ratio) => {
  const out = new Map();
  for (let block = 1; block <= 96; block += 1) {
    out.set(block, Number(((Number(map?.get?.(block) || 0)) * ratio).toFixed(3)));
  }
  return out;
};

const seriesToY = (map) => Array.from({ length: 96 }, (_, idx) => Number(map?.get?.(idx + 1) || 0));

const buildConfigPayload = (plantConfig, buyerConfig, assets, buyers, generatorPlants) => ({
  plant_id: PLANT_ID,
  plant_name: plantConfig.plantName,
  state: plantConfig.state,
  location: plantConfig.location,
  latitude: toNumber(plantConfig.latitude),
  longitude: toNumber(plantConfig.longitude),
  total_capacity: {
    ac_mw: toNumber(plantConfig.totalCapacityAcMw),
    dc_mw: toNumber(plantConfig.totalCapacityDcMw),
  },
  currently_scheduling_capacity: {
    ac_mw: toNumber(plantConfig.schedulingCapacityAcMw),
    dc_mw: toNumber(plantConfig.schedulingCapacityDcMw),
  },
  buyers: buyers.map((buyer) => ({
    buyer_name: buyer,
    schedule_capacity_mw: toNumber(buyerConfig[buyer]?.scheduleCapacityMw),
    contract_id: buyerConfig[buyer]?.contractId || '',
    approval_number: buyerConfig[buyer]?.approvalNumber || '',
    assets: assets
      .filter((asset) => asset.buyer === buyer)
      .map((asset) => ({
        asset_name: asset.assetName,
        capacity_ac_mw: toNumber(asset.acCapacityMw),
        capacity_dc_mw: toNumber(asset.dcCapacityMw),
        meter_data_available: Boolean(asset.meterAvailable),
      })),
  })),
  penalty_config: {
    state_regulation: 'Maharashtra',
    calculation_basis_column: 'Declared Forecast',
  },
  template_config: {
    schedule_columns: buyers,
    supported_templates: ['DAY_AHEAD', 'INTRADAY'],
    multi_generator_plants: generatorPlants,
  },
});

const cloneBuyerConfig = (config = {}) => Object.fromEntries(
  Object.entries(config || {}).map(([buyer, buyerValues]) => [buyer, { ...(buyerValues || {}) }])
);

const cloneAssets = (items = []) => (Array.isArray(items) ? items : []).map((asset) => ({ ...asset }));

const clonePlants = (items = []) => (Array.isArray(items) ? items : []).map((plant) => ({
  ...plant,
  buyers: [...(Array.isArray(plant?.buyers) ? plant.buyers : [])],
  buyerConfig: cloneBuyerConfig(plant?.buyerConfig),
  assets: cloneAssets(plant?.assets),
}));

const withScopedPlantConfig = (plant, buyers, buyerConfig, assets) => ({
  ...plant,
  buyers: [...(Array.isArray(buyers) ? buyers : [])],
  buyerConfig: cloneBuyerConfig(buyerConfig),
  assets: cloneAssets(assets),
});

const getPlantScopedConfig = (plant, fallback = {}) => {
  const scopedBuyers = Array.isArray(plant?.buyers) && plant.buyers.length ? plant.buyers : fallback.buyers;
  const scopedBuyerConfig = plant?.buyerConfig && Object.keys(plant.buyerConfig).length ? plant.buyerConfig : fallback.buyerConfig;
  const scopedAssets = Array.isArray(plant?.assets) && plant.assets.length ? plant.assets : fallback.assets;
  return {
    buyers: [...(Array.isArray(scopedBuyers) ? scopedBuyers : [])],
    buyerConfig: cloneBuyerConfig(scopedBuyerConfig || {}),
    assets: cloneAssets(scopedAssets || []),
  };
};

const syncSelectedPlantScopedConfig = (draft) => ({
  ...draft,
  generatorPlants: clonePlants(draft.generatorPlants).map((plant) => (
    plant.id === draft.selectedPlantId
      ? withScopedPlantConfig(plant, draft.buyers, draft.buyerConfig, draft.assets)
      : plant
  )),
});

const cloneConfigDraft = ({ plantConfig, generatorPlants, selectedPlantId, buyers, buyerConfig, assets }) => ({
  plantConfig: { ...plantConfig },
  generatorPlants: clonePlants(generatorPlants),
  selectedPlantId,
  buyers: [...(Array.isArray(buyers) ? buyers : [])],
  buyerConfig: cloneBuyerConfig(buyerConfig),
  assets: cloneAssets(assets),
});

const normalizeLoadedConfig = (item) => {
  if (!item || typeof item !== 'object') return null;
  const buyers = Array.isArray(item.buyers) ? item.buyers : [];
  const buyerNames = Array.from(new Set([
    ...DEFAULT_BUYERS,
    ...buyers.map((buyer) => String(buyer?.buyer_name || '').trim()).filter(Boolean),
  ]));
  const nextBuyerConfig = { ...INITIAL_BUYERS };
  const nextAssets = [];
  buyers.forEach((buyer) => {
    const buyerName = String(buyer?.buyer_name || '').trim();
    if (!buyerName) return;
    nextBuyerConfig[buyerName] = {
      scheduleCapacityMw: String(buyer.schedule_capacity_mw ?? nextBuyerConfig[buyerName]?.scheduleCapacityMw ?? ''),
      contractId: String(buyer.contract_id ?? nextBuyerConfig[buyerName]?.contractId ?? ''),
      approvalNumber: String(buyer.approval_number ?? nextBuyerConfig[buyerName]?.approvalNumber ?? ''),
    };
    (Array.isArray(buyer.assets) ? buyer.assets : []).forEach((asset, index) => {
      const assetName = String(asset?.asset_name || '').trim();
      if (!assetName) return;
      nextAssets.push({
        id: `${buyerName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${index}-${assetName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        assetName,
        buyer: buyerName,
        acCapacityMw: String(asset.capacity_ac_mw ?? '0'),
        dcCapacityMw: String(asset.capacity_dc_mw ?? '0'),
        meterAvailable: asset.meter_data_available !== false,
      });
    });
  });
  const loadedPlantConfig = {
    ...INITIAL_PLANT,
    plantName: String(item.plant_name || INITIAL_PLANT.plantName),
    state: String(item.state || INITIAL_PLANT.state),
    location: String(item.location || INITIAL_PLANT.location),
    latitude: String(item.latitude ?? INITIAL_PLANT.latitude),
    longitude: String(item.longitude ?? INITIAL_PLANT.longitude),
    totalCapacityAcMw: String(item.total_capacity?.ac_mw ?? INITIAL_PLANT.totalCapacityAcMw),
    totalCapacityDcMw: String(item.total_capacity?.dc_mw ?? INITIAL_PLANT.totalCapacityDcMw),
    schedulingCapacityAcMw: String(item.currently_scheduling_capacity?.ac_mw ?? INITIAL_PLANT.schedulingCapacityAcMw),
    schedulingCapacityDcMw: String(item.currently_scheduling_capacity?.dc_mw ?? INITIAL_PLANT.schedulingCapacityDcMw),
  };
  const loadedPlants = Array.isArray(item.template_config?.multi_generator_plants)
    ? item.template_config.multi_generator_plants
      .map((plant) => ({
        ...INITIAL_PLANT,
        ...plant,
        id: String(plant?.id || createPlantId(plant?.plantName || plant?.plant_name || '')).trim(),
        plantName: String(plant?.plantName || plant?.plant_name || '').trim(),
        buyers: Array.isArray(plant?.buyers) && plant.buyers.length ? plant.buyers : buyerNames,
        buyerConfig: plant?.buyerConfig && Object.keys(plant.buyerConfig).length ? cloneBuyerConfig(plant.buyerConfig) : cloneBuyerConfig(nextBuyerConfig),
        assets: Array.isArray(plant?.assets) && plant.assets.length ? cloneAssets(plant.assets) : cloneAssets(nextAssets.length ? nextAssets : INITIAL_ASSETS),
      }))
      .filter((plant) => plant.id && plant.plantName)
    : [];
  const activePlant = loadedPlants[0] || null;
  const activeScoped = activePlant
    ? getPlantScopedConfig(activePlant, {
      buyers: buyerNames,
      buyerConfig: nextBuyerConfig,
      assets: nextAssets.length ? nextAssets : INITIAL_ASSETS,
    })
    : {
      buyers: buyerNames,
      buyerConfig: nextBuyerConfig,
      assets: nextAssets.length ? nextAssets : INITIAL_ASSETS,
    };
  return {
    plantConfig: loadedPlantConfig,
    buyerConfig: activeScoped.buyerConfig,
    buyers: activeScoped.buyers,
    generatorPlants: loadedPlants.length ? loadedPlants : [createGeneratorPlant(loadedPlantConfig)],
    assets: activeScoped.assets,
  };
};

export function MultiGeneratorSchedule() {
  const { user: currentUser } = useAuth();
  const isAdmin = isAdminUser(currentUser);
  const [plantConfig, setPlantConfig] = useState(INITIAL_PLANT);
  const [generatorPlants, setGeneratorPlants] = useState([createGeneratorPlant(INITIAL_PLANT)]);
  const [selectedPlantId, setSelectedPlantId] = useState(createPlantId(INITIAL_PLANT.plantName));
  const [buyers, setBuyers] = useState(DEFAULT_BUYERS);
  const [buyerConfig, setBuyerConfig] = useState(INITIAL_BUYERS);
  const [assets, setAssets] = useState(INITIAL_ASSETS);
  const [selectedAssetIds, setSelectedAssetIds] = useState([]);
  const [assetDropdownOpen, setAssetDropdownOpen] = useState(false);
  const [aggregationMode, setAggregationMode] = useState('sum');
  const [visibleGraphSeries, setVisibleGraphSeries] = useState({
    systemSchedule: true,
    intraday: true,
    meter: true,
    allowedBand: true,
    dayAhead: true,
    weekAhead: false,
  });
  const [graphData, setGraphData] = useState({
    loading: false,
    error: '',
    schedule: new Map(),
    intraday: new Map(),
    dayAhead: new Map(),
    weekAhead: new Map(),
    meterByAsset: {},
  });
  const [scheduleDate, setScheduleDate] = useState(() =>
    new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
  );
  const [showConfig, setShowConfig] = useState(false);
  const [configStatus, setConfigStatus] = useState({ type: '', message: '' });
  const [savingConfig, setSavingConfig] = useState(false);
  const [configDraft, setConfigDraft] = useState(() => cloneConfigDraft({
    plantConfig: INITIAL_PLANT,
    generatorPlants: [createGeneratorPlant(INITIAL_PLANT)],
    selectedPlantId: createPlantId(INITIAL_PLANT.plantName),
    buyers: DEFAULT_BUYERS,
    buyerConfig: INITIAL_BUYERS,
    assets: INITIAL_ASSETS,
  }));

  useEffect(() => {
    let cancelled = false;
    api.multiGeneratorPlant.get(PLANT_ID)
      .then((response) => {
        if (cancelled || !response?.item) return;
        const loaded = normalizeLoadedConfig(response.item);
        if (!loaded) return;
        setPlantConfig(loaded.plantConfig);
        setGeneratorPlants(loaded.generatorPlants);
        setSelectedPlantId(loaded.generatorPlants?.[0]?.id || createPlantId(loaded.plantConfig.plantName));
        setBuyers(loaded.buyers);
        setBuyerConfig(loaded.buyerConfig);
        setAssets(loaded.assets);
      })
      .catch((error) => {
        if (!cancelled) {
          setConfigStatus({
            type: 'error',
            message: error?.message || 'Failed to load saved asset configuration',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadGraphData = async () => {
      const dateKey = String(scheduleDate || '').trim();
      if (!dateKey) return;
      setGraphData((prev) => ({ ...prev, loading: true, error: '' }));
      try {
        const prefixBase = `${MULTI_GENERATOR_S3_BASE}/${dateKey}`;
        const generatedPrefix = `${MULTI_GENERATOR_GENERATED_BASE}/${dateKey}/`;
        const [generatedObjects, intradayObjects, dayAheadObjects, weekAheadObjects] = await Promise.all([
          listS3ObjectsAcrossPrefixes([generatedPrefix]).catch(() => []),
          listS3ObjectsAcrossPrefixes([`${prefixBase}/enercast_data/intraday/`]).catch(() => []),
          listS3ObjectsAcrossPrefixes([
            `${MULTI_GENERATOR_GENERATED_BASE}/${dateKey}/Day-ahead/`,
            `${prefixBase}/enercast_data/day_ahead/`,
          ]).catch(() => []),
          listS3ObjectsAcrossPrefixes([`${prefixBase}/enercast_data/week_ahead/`]).catch(() => []),
        ]);
        const schedulePick = pickLatestCsv(generatedObjects);
        const intradayPick = pickLatestCsv(intradayObjects);
        const dayAheadPick = pickLatestDayAheadCsv(dayAheadObjects);
        const weekAheadPick = pickLatestCsv(weekAheadObjects);
        const [scheduleText, intradayText, dayAheadText, weekAheadText] = await Promise.all([
          schedulePick?.key ? fetchTextFromS3Optional(schedulePick.key).catch(() => '') : '',
          intradayPick?.key ? fetchTextFromS3Optional(intradayPick.key).catch(() => '') : '',
          dayAheadPick?.key ? fetchTextFromS3Optional(dayAheadPick.key).catch(() => '') : '',
          weekAheadPick?.key ? fetchTextFromS3Optional(weekAheadPick.key).catch(() => '') : '',
        ]);

        const selectedAssets = assets.filter((asset) => selectedAssetIds.includes(asset.id));
        const meterEntries = await Promise.all(selectedAssets.map(async (asset) => {
          const folder = normalizeAssetFolder(asset.assetName);
          const meterPrefix = `${prefixBase}/metered_data/${folder}/`;
          const objects = await listS3ObjectsAcrossPrefixes([meterPrefix]).catch(() => []);
          const exactKey = `${meterPrefix}${folder}_${yyyymmdd(dateKey)}.csv`;
          const pick = objects.find((item) => String(item?.key || '') === exactKey) || pickLatestCsv(objects);
          const text = pick?.key ? await fetchTextFromS3Optional(pick.key).catch(() => '') : '';
          return [asset.id, parseBlockSeries(text)];
        }));

        if (cancelled) return;
        setGraphData({
          loading: false,
          error: '',
          schedule: parseBlockSeries(scheduleText, { preferredColumns: ZETRIC_SYSTEM_SCHEDULE_VALUE_COLUMNS }),
          intraday: parseBlockSeries(intradayText, { preferredColumns: ZETRIC_PLANT_VALUE_COLUMNS }),
          dayAhead: parseBlockSeries(dayAheadText, { preferredColumns: ZETRIC_DAY_AHEAD_VALUE_COLUMNS }),
          weekAhead: parseBlockSeries(weekAheadText, { preferredColumns: ZETRIC_PLANT_VALUE_COLUMNS }),
          meterByAsset: Object.fromEntries(meterEntries),
        });
      } catch (error) {
        if (!cancelled) {
          setGraphData((prev) => ({
            ...prev,
            loading: false,
            error: error?.message || 'Failed to load multi generator graph data',
          }));
        }
      }
    };
    loadGraphData();
    return () => {
      cancelled = true;
    };
  }, [assets, scheduleDate, selectedAssetIds]);

  const selectedAsset = useMemo(
    () => assets.find((asset) => asset.id === selectedAssetIds[0]) || null,
    [assets, selectedAssetIds]
  );

  const selectedAssets = useMemo(
    () => assets.filter((asset) => selectedAssetIds.includes(asset.id)),
    [assets, selectedAssetIds]
  );

  const selectedAssetLabel = useMemo(() => {
    if (!selectedAssetIds.length) return 'Select assets';
    if (selectedAssetIds.length === assets.length) return 'All assets';
    if (selectedAssetIds.length === 1) return selectedAssets[0]?.assetName || '1 asset selected';
    return `${selectedAssetIds.length} assets selected`;
  }, [assets.length, selectedAssetIds, selectedAssets]);

  const toggleAssetSelection = (assetId) => {
    setSelectedAssetIds((prev) => (
      prev.includes(assetId)
        ? prev.filter((id) => id !== assetId)
        : [...prev, assetId]
    ));
  };

  const graphPlotData = useMemo(() => {
    if (!selectedAssets.length) return [];
    const blockLabels = Array.from({ length: 96 }, (_, idx) => idx + 1);
    const selectedCapacity = selectedAssets.reduce((sum, asset) => sum + toNumber(asset.acCapacityMw), 0);
    const plantCapacity = Math.max(toNumber(plantConfig.totalCapacityAcMw, 25), 0.000001);
    const ratio = Math.min(1, selectedCapacity / plantCapacity);
    const schedule = scaleSeriesMap(graphData.schedule, ratio);
    const intraday = scaleSeriesMap(graphData.intraday.size ? graphData.intraday : graphData.schedule, ratio);
    const dayAhead = scaleSeriesMap(graphData.dayAhead, ratio);
    const meterMaps = selectedAssets.map((asset) => graphData.meterByAsset?.[asset.id]).filter(Boolean);
    const meterSum = sumSeriesMaps(meterMaps);
    const traces = [];
    const addTrace = (enabled, name, map, color, dash = 'solid') => {
      if (!enabled) return;
      traces.push({
        x: blockLabels,
        y: seriesToY(map),
        type: 'scatter',
        mode: 'lines+markers',
        name,
        line: { color, width: 2, dash },
        marker: { size: 4 },
      });
    };
    if (aggregationMode === 'sum') {
      addTrace(visibleGraphSeries.systemSchedule, 'System Schedule (MW)', schedule, '#1d4ed8');
      addTrace(visibleGraphSeries.intraday, 'Enercast Forecast', intraday, '#2563eb');
      addTrace(visibleGraphSeries.dayAhead, 'Day-ahead', dayAhead, '#ec4899', 'dot');
      if (visibleGraphSeries.allowedBand) {
        addTrace(true, 'Allowed Band Upper', scaleSeriesMap(schedule, 1.1), '#94a3b8', 'dash');
        addTrace(true, 'Allowed Band Lower', scaleSeriesMap(schedule, 0.9), '#94a3b8', 'dash');
      }
      if (visibleGraphSeries.meter) {
        addTrace(true, 'Meter Data Sum', meterSum, '#111827');
      }
      return traces;
    }

    selectedAssets.forEach((asset, index) => {
      const assetRatio = Math.min(1, toNumber(asset.acCapacityMw) / plantCapacity);
      const color = ['#2563eb', '#0891b2', '#7c3aed', '#16a34a', '#dc2626', '#9333ea'][index % 6];
      const assetSchedule = scaleSeriesMap(graphData.schedule, assetRatio);
      addTrace(visibleGraphSeries.systemSchedule, `${asset.assetName} System Schedule`, assetSchedule, '#1d4ed8');
      addTrace(visibleGraphSeries.intraday, `${asset.assetName} Enercast Forecast`, scaleSeriesMap(graphData.intraday.size ? graphData.intraday : graphData.schedule, assetRatio), color);
      addTrace(visibleGraphSeries.dayAhead, `${asset.assetName} Day-ahead`, scaleSeriesMap(graphData.dayAhead, assetRatio), '#ec4899', 'dot');
      if (visibleGraphSeries.allowedBand) {
        addTrace(true, `${asset.assetName} Allowed Upper`, scaleSeriesMap(assetSchedule, 1.1), '#94a3b8', 'dash');
        addTrace(true, `${asset.assetName} Allowed Lower`, scaleSeriesMap(assetSchedule, 0.9), '#94a3b8', 'dash');
      }
      addTrace(visibleGraphSeries.meter, `${asset.assetName} Meter Data`, graphData.meterByAsset?.[asset.id] || new Map(), '#111827');
    });
    return traces;
  }, [aggregationMode, graphData, plantConfig.totalCapacityAcMw, selectedAssets, visibleGraphSeries]);

  const buyerScheduleCapacity = useMemo(() => {
    const out = {};
    buyers.forEach((buyer) => {
      out[buyer] = toNumber(buyerConfig[buyer]?.scheduleCapacityMw);
    });
    return out;
  }, [buyerConfig, buyers]);

  const assetSummary = useMemo(() => {
    const byBuyer = {};
    buyers.forEach((buyer) => {
      byBuyer[buyer] = { ac: 0, dc: 0, count: 0 };
    });
    assets.forEach((asset) => {
      const buyer = buyers.includes(asset.buyer) ? asset.buyer : buyers[0];
      if (!buyer) return;
      byBuyer[buyer].ac += toNumber(asset.acCapacityMw);
      byBuyer[buyer].dc += toNumber(asset.dcCapacityMw);
      byBuyer[buyer].count += 1;
    });
    return byBuyer;
  }, [assets, buyers]);

  const previewRows = useMemo(() => {
    const schedulingCapacity = toNumber(plantConfig.schedulingCapacityAcMw);
    return buildDeclaredForecast(schedulingCapacity).map((row) => {
      const buyerValues = {};
      let remaining = row.declaredForecast;
      buyers.forEach((buyer, index) => {
        const isLast = index === buyers.length - 1;
        const value = isLast
          ? remaining
          : row.declaredForecast * (buyerScheduleCapacity[buyer] / Math.max(schedulingCapacity, 0.000001));
        const rounded = Number(value.toFixed(3));
        buyerValues[buyer] = rounded;
        remaining = Number((remaining - rounded).toFixed(3));
      });
      return {
        ...row,
        intraAvc: row.declaredForecast > 0 ? schedulingCapacity : 0,
        buyerValues,
      };
    });
  }, [buyerScheduleCapacity, plantConfig.schedulingCapacityAcMw]);

  const validation = useMemo(() => {
    const schedulingCapacity = toNumber(plantConfig.schedulingCapacityAcMw);
    const buyerTotal = buyers.reduce((sum, buyer) => sum + buyerScheduleCapacity[buyer], 0);
    const assetAcTotal = assets.reduce((sum, asset) => sum + toNumber(asset.acCapacityMw), 0);
    const meterMissing = assets.filter((asset) => !asset.meterAvailable).length;
    const capacityMismatch = Math.abs(buyerTotal - schedulingCapacity) > 0.001;
    return {
      buyerTotal,
      assetAcTotal,
      meterMissing,
      capacityMismatch,
      ready: !capacityMismatch && assets.length > 0,
    };
  }, [assets, buyerScheduleCapacity, buyers, plantConfig.schedulingCapacityAcMw]);

  const updatePlant = (field, value) => {
    setPlantConfig((prev) => {
      const next = { ...prev, [field]: value };
      setGeneratorPlants((plants) => plants.map((plant) => (plant.id === selectedPlantId ? { ...plant, ...next } : plant)));
      return next;
    });
  };

  const selectGeneratorPlant = (plantId) => {
    const plant = generatorPlants.find((item) => item.id === plantId);
    if (!plant) return;
    const scoped = getPlantScopedConfig(plant, { buyers, buyerConfig, assets });
    setSelectedPlantId(plantId);
    setPlantConfig({ ...INITIAL_PLANT, ...plant });
    setBuyers(scoped.buyers);
    setBuyerConfig(scoped.buyerConfig);
    setAssets(scoped.assets);
    setSelectedAssetIds((prev) => prev.filter((assetId) => scoped.assets.some((asset) => asset.id === assetId)));
  };

  const updateGeneratorPlant = (plantId, field, value) => {
    setGeneratorPlants((prev) => prev.map((plant) => {
      if (plant.id !== plantId) return plant;
      const patch = { [field]: value };
      if (field === 'plantName') patch.id = plant.id;
      return { ...plant, ...patch };
    }));
    if (plantId === selectedPlantId) {
      setPlantConfig((prev) => ({ ...prev, [field]: value }));
    }
  };

  const addGeneratorPlant = () => {
    const id = `PLANT_${Date.now()}`;
    const nextPlant = {
      ...INITIAL_PLANT,
      id,
      plantName: `Plant ${generatorPlants.length + 1}`,
    };
    setGeneratorPlants((prev) => [...prev, nextPlant]);
    setSelectedPlantId(id);
    setPlantConfig(nextPlant);
  };

  const deleteGeneratorPlant = (plantId) => {
    setGeneratorPlants((prev) => {
      const next = prev.filter((plant) => plant.id !== plantId);
      const safeNext = next.length ? next : [createGeneratorPlant(INITIAL_PLANT)];
      if (plantId === selectedPlantId) {
        setSelectedPlantId(safeNext[0].id);
        setPlantConfig({ ...INITIAL_PLANT, ...safeNext[0] });
      }
      return safeNext;
    });
  };

  const updateBuyer = (buyer, field, value) => {
    setBuyerConfig((prev) => ({
      ...prev,
      [buyer]: {
        ...(prev[buyer] || {}),
        [field]: value,
      },
    }));
  };

  const updateBuyerName = (oldName, nextName) => {
    const cleanName = String(nextName || '').trim();
    setBuyers((prev) => prev.map((buyer) => (buyer === oldName ? cleanName : buyer)));
    setBuyerConfig((prev) => {
      const current = prev[oldName] || {};
      const next = { ...prev };
      delete next[oldName];
      if (cleanName) next[cleanName] = current;
      return next;
    });
    setAssets((prev) => prev.map((asset) => (asset.buyer === oldName ? { ...asset, buyer: cleanName } : asset)));
  };

  const addBuyer = () => {
    const name = `Buyer ${buyers.length + 1}`;
    setBuyers((prev) => [...prev, name]);
    setBuyerConfig((prev) => ({
      ...prev,
      [name]: { scheduleCapacityMw: '0', contractId: '', approvalNumber: '' },
    }));
  };

  const deleteBuyer = (buyerName) => {
    if (buyers.length <= 1) return;
    const fallbackBuyer = buyers.find((buyer) => buyer !== buyerName) || buyers[0];
    setBuyers((prev) => prev.filter((buyer) => buyer !== buyerName));
    setBuyerConfig((prev) => {
      const next = { ...prev };
      delete next[buyerName];
      return next;
    });
    setAssets((prev) => prev.map((asset) => (asset.buyer === buyerName ? { ...asset, buyer: fallbackBuyer } : asset)));
  };

  const updateAsset = (id, patch) => {
    setAssets((prev) => prev.map((asset) => (asset.id === id ? { ...asset, ...patch } : asset)));
  };

  const addAsset = () => {
    const id = `asset-${Date.now()}`;
    setAssets((prev) => [
      ...prev,
      {
        id,
        assetName: `Asset ${prev.length + 1}`,
        buyer: buyers[0] || '',
        acCapacityMw: '0',
        dcCapacityMw: '0',
        meterAvailable: false,
      },
    ]);
    setSelectedAssetIds([id]);
  };

  const deleteAsset = (id) => {
    setAssets((prev) => prev.filter((asset) => asset.id !== id));
    setSelectedAssetIds((prev) => prev.filter((assetId) => assetId !== id));
  };

  const openConfiguration = () => {
    if (!isAdmin) return;
    setConfigDraft(cloneConfigDraft({
      plantConfig,
      generatorPlants,
      selectedPlantId,
      buyers,
      buyerConfig,
      assets,
    }));
    setConfigStatus({ type: '', message: '' });
    setShowConfig(true);
  };

  const closeConfiguration = () => {
    if (savingConfig) return;
    setShowConfig(false);
    setConfigStatus({ type: '', message: '' });
  };

  const updateDraftPlant = (field, value) => {
    setConfigDraft((prev) => {
      const nextPlantConfig = { ...prev.plantConfig, [field]: value };
      return {
        ...prev,
        plantConfig: nextPlantConfig,
        generatorPlants: prev.generatorPlants.map((plant) => (
          plant.id === prev.selectedPlantId ? { ...plant, ...nextPlantConfig } : plant
        )),
      };
    });
  };

  const selectDraftGeneratorPlant = (plantId) => {
    setConfigDraft((prev) => {
      const synced = syncSelectedPlantScopedConfig(prev);
      const plant = synced.generatorPlants.find((item) => item.id === plantId);
      if (!plant) return prev;
      const scoped = getPlantScopedConfig(plant, {
        buyers: synced.buyers,
        buyerConfig: synced.buyerConfig,
        assets: synced.assets,
      });
      return {
        ...synced,
        selectedPlantId: plantId,
        plantConfig: { ...INITIAL_PLANT, ...plant },
        buyers: scoped.buyers,
        buyerConfig: scoped.buyerConfig,
        assets: scoped.assets,
      };
    });
  };

  const updateDraftGeneratorPlant = (plantId, field, value) => {
    setConfigDraft((prev) => ({
      ...prev,
      generatorPlants: prev.generatorPlants.map((plant) => {
        if (plant.id !== plantId) return plant;
        const patch = { [field]: value };
        if (field === 'plantName') patch.id = plant.id;
        return { ...plant, ...patch };
      }),
      plantConfig: plantId === prev.selectedPlantId ? { ...prev.plantConfig, [field]: value } : prev.plantConfig,
    }));
  };

  const addDraftGeneratorPlant = () => {
    setConfigDraft((prev) => {
      const synced = syncSelectedPlantScopedConfig(prev);
      const id = `PLANT_${Date.now()}`;
      const nextBuyers = ['Buyer 1'];
      const nextBuyerConfig = { 'Buyer 1': { scheduleCapacityMw: '0', contractId: '', approvalNumber: '' } };
      const nextAssets = [];
      const nextPlant = {
        ...INITIAL_PLANT,
        id,
        plantName: `Plant ${synced.generatorPlants.length + 1}`,
        buyers: nextBuyers,
        buyerConfig: nextBuyerConfig,
        assets: nextAssets,
      };
      return {
        ...synced,
        generatorPlants: [...synced.generatorPlants, nextPlant],
        selectedPlantId: id,
        plantConfig: nextPlant,
        buyers: nextBuyers,
        buyerConfig: nextBuyerConfig,
        assets: nextAssets,
      };
    });
  };

  const deleteDraftGeneratorPlant = (plantId) => {
    setConfigDraft((prev) => {
      const synced = syncSelectedPlantScopedConfig(prev);
      const next = synced.generatorPlants.filter((plant) => plant.id !== plantId);
      const safeNext = next.length ? next : [createGeneratorPlant(INITIAL_PLANT)];
      const selectedDeleted = plantId === synced.selectedPlantId;
      const scoped = selectedDeleted
        ? getPlantScopedConfig(safeNext[0], {
          buyers: ['Buyer 1'],
          buyerConfig: { 'Buyer 1': { scheduleCapacityMw: '0', contractId: '', approvalNumber: '' } },
          assets: [],
        })
        : null;
      return {
        ...synced,
        generatorPlants: safeNext,
        selectedPlantId: selectedDeleted ? safeNext[0].id : synced.selectedPlantId,
        plantConfig: selectedDeleted ? { ...INITIAL_PLANT, ...safeNext[0] } : synced.plantConfig,
        buyers: selectedDeleted ? scoped.buyers : synced.buyers,
        buyerConfig: selectedDeleted ? scoped.buyerConfig : synced.buyerConfig,
        assets: selectedDeleted ? scoped.assets : synced.assets,
      };
    });
  };

  const updateDraftBuyer = (buyer, field, value) => {
    setConfigDraft((prev) => ({
      ...prev,
      buyerConfig: {
        ...prev.buyerConfig,
        [buyer]: {
          ...(prev.buyerConfig[buyer] || {}),
          [field]: value,
        },
      },
    }));
  };

  const updateDraftBuyerName = (oldName, nextName) => {
    const cleanName = String(nextName || '').trim();
    setConfigDraft((prev) => {
      const current = prev.buyerConfig[oldName] || {};
      const nextBuyerConfig = { ...prev.buyerConfig };
      delete nextBuyerConfig[oldName];
      if (cleanName) nextBuyerConfig[cleanName] = current;
      return {
        ...prev,
        buyers: prev.buyers.map((buyer) => (buyer === oldName ? cleanName : buyer)),
        buyerConfig: nextBuyerConfig,
        assets: prev.assets.map((asset) => (asset.buyer === oldName ? { ...asset, buyer: cleanName } : asset)),
      };
    });
  };

  const addDraftBuyer = () => {
    setConfigDraft((prev) => {
      const name = `Buyer ${prev.buyers.length + 1}`;
      return {
        ...prev,
        buyers: [...prev.buyers, name],
        buyerConfig: {
          ...prev.buyerConfig,
          [name]: { scheduleCapacityMw: '0', contractId: '', approvalNumber: '' },
        },
      };
    });
  };

  const deleteDraftBuyer = (buyerName) => {
    setConfigDraft((prev) => {
      if (prev.buyers.length <= 1) return prev;
      const fallbackBuyer = prev.buyers.find((buyer) => buyer !== buyerName) || prev.buyers[0];
      const nextBuyerConfig = { ...prev.buyerConfig };
      delete nextBuyerConfig[buyerName];
      return {
        ...prev,
        buyers: prev.buyers.filter((buyer) => buyer !== buyerName),
        buyerConfig: nextBuyerConfig,
        assets: prev.assets.map((asset) => (asset.buyer === buyerName ? { ...asset, buyer: fallbackBuyer } : asset)),
      };
    });
  };

  const updateDraftAsset = (id, patch) => {
    setConfigDraft((prev) => ({
      ...prev,
      assets: prev.assets.map((asset) => (asset.id === id ? { ...asset, ...patch } : asset)),
    }));
  };

  const addDraftAsset = () => {
    setConfigDraft((prev) => ({
      ...prev,
      assets: [
        ...prev.assets,
        {
          id: `asset-${Date.now()}`,
          assetName: `Asset ${prev.assets.length + 1}`,
          buyer: prev.buyers[0] || '',
          acCapacityMw: '0',
          dcCapacityMw: '0',
          meterAvailable: false,
        },
      ],
    }));
  };

  const deleteDraftAsset = (id) => {
    setConfigDraft((prev) => ({
      ...prev,
      assets: prev.assets.filter((asset) => asset.id !== id),
    }));
  };

  const saveConfiguration = async () => {
    setSavingConfig(true);
    setConfigStatus({ type: '', message: '' });
    try {
      const draft = syncSelectedPlantScopedConfig(cloneConfigDraft(configDraft));
      const payload = buildConfigPayload(
        draft.plantConfig,
        draft.buyerConfig,
        draft.assets,
        draft.buyers.filter(Boolean),
        draft.generatorPlants
      );
      const response = await api.multiGeneratorPlant.save(PLANT_ID, payload);
      setPlantConfig(draft.plantConfig);
      setGeneratorPlants(draft.generatorPlants);
      setSelectedPlantId(draft.selectedPlantId);
      setBuyers(draft.buyers);
      setBuyerConfig(draft.buyerConfig);
      setAssets(draft.assets);
      setSelectedAssetIds((prev) => prev.filter((assetId) => draft.assets.some((asset) => asset.id === assetId)));
      setConfigStatus({
        type: 'success',
        message: `Saved to ${response?.table || 'multi_generator_plant'}`,
      });
    } catch (error) {
      setConfigStatus({
        type: 'error',
        message: error?.message || 'Failed to save asset configuration',
      });
    } finally {
      setSavingConfig(false);
    }
  };

  const buildTemplateCsv = (revisionType = plantConfig.revisionType) => {
    const activeBuyers = buyers.filter(Boolean);
    const buyerConfigCells = (field) => activeBuyers.map((buyer) => buyerConfig[buyer]?.[field] || '');
    const buyerCapacityCells = activeBuyers.map((buyer) => formatNumber(buyerConfig[buyer]?.scheduleCapacityMw));
    const rows = [
      [`Schedule Template for MH_VEDANJAY and revision ${revisionType}`],
      ['', 'Scheduling entity', plantConfig.schedulingEntity],
      ['', 'Date', scheduleDate],
      ['', 'Revision No', revisionType],
      [],
      ['POS Name', plantConfig.posName, plantConfig.posName, ...activeBuyers.map(() => plantConfig.posName)],
      ['Down Stream Name', '', '', ...activeBuyers.map(() => plantConfig.downstreamName)],
      ['Energy Type', '', '', ...activeBuyers.map(() => plantConfig.energyType)],
      ['Contract ID', '', '', ...buyerConfigCells('contractId')],
      ['Contract Type', '', '', ...activeBuyers.map(() => plantConfig.contractType)],
      ['Exchange Type', '', '', ...activeBuyers.map(() => plantConfig.exchangeType)],
      ['Transaction Type', plantConfig.transactionType, plantConfig.transactionType, ...activeBuyers.map(() => plantConfig.transactionType)],
      ['RE Generator Name', '', '', ...activeBuyers.map(() => plantConfig.reGeneratorName)],
      ['Path', '', '', ...activeBuyers.map(() => plantConfig.path)],
      ['Buyer Name', '', '', ...activeBuyers],
      ['STU Name', '', '', ...activeBuyers.map(() => plantConfig.stuName)],
      ['Approval Number', '', '', ...buyerConfigCells('approvalNumber')],
      [
        'Capacity',
        formatNumber(plantConfig.schedulingCapacityAcMw),
        formatNumber(plantConfig.schedulingCapacityAcMw),
        ...buyerCapacityCells,
      ],
      ['Block', 'Declared Forecast', 'Intra Avc', ...activeBuyers.map(() => 'Schedule')],
      ...previewRows.map((row) => [
        row.block,
        formatNumber(row.declaredForecast),
        formatNumber(row.intraAvc),
        ...activeBuyers.map((buyer) => formatNumber(row.buyerValues[buyer])),
      ]),
    ];
    return rows.map((row) => row.map(csvEscape).join(',')).join('\n');
  };

  const downloadTemplate = (revisionType) => {
    const csvText = buildTemplateCsv(revisionType);
    const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `MH_VEDANJAY_${revisionType}_${scheduleDate}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const draftPlantConfig = configDraft.plantConfig || INITIAL_PLANT;
  const draftGeneratorPlants = configDraft.generatorPlants || [];
  const draftBuyers = configDraft.buyers || [];
  const draftBuyerConfig = configDraft.buyerConfig || {};
  const draftAssets = configDraft.assets || [];

  return (
    <div className="min-h-full bg-background text-foreground overflow-auto">
      <div className="p-4 sm:p-6 lg:p-8 space-y-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-normal">Multi Generator</h1>
          </div>
          {isAdmin && (
            <button
              type="button"
              onClick={openConfiguration}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground"
            >
              <Settings2 className="h-4 w-4" />
              Asset Configuration
            </button>
          )}
        </div>

        <section className="rounded-lg border border-border bg-card p-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
            <label className="space-y-1.5">
              <span className="text-xs font-semibold text-muted-foreground">Plant Name</span>
              <select
                value={selectedPlantId}
                onChange={(event) => selectGeneratorPlant(event.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              >
                {generatorPlants.map((plant) => (
                  <option key={plant.id} value={plant.id}>
                    {plant.plantName}
                  </option>
                ))}
              </select>
            </label>
            <div className="relative space-y-1.5">
              <span className="text-xs font-semibold text-muted-foreground">Asset Name</span>
              <button
                type="button"
                onClick={() => setAssetDropdownOpen((open) => !open)}
                className="flex h-[46px] w-full items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-2.5 text-left text-sm outline-none focus:ring-2 focus:ring-primary/30"
              >
                <span className="min-w-0 truncate">{selectedAssetLabel}</span>
                <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${assetDropdownOpen ? 'rotate-180' : ''}`} />
              </button>
              {assetDropdownOpen ? (
                <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-64 overflow-auto rounded-lg border border-border bg-card p-2 shadow-lg">
                  <button
                    type="button"
                    onClick={() => setSelectedAssetIds(selectedAssetIds.length === assets.length ? [] : assets.map((asset) => asset.id))}
                    className="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
                  >
                    <span className={`flex h-4 w-4 items-center justify-center rounded border ${
                      selectedAssetIds.length === assets.length && assets.length ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
                    }`}>
                      {selectedAssetIds.length === assets.length && assets.length ? <Check className="h-3 w-3" /> : null}
                    </span>
                    All assets
                  </button>
                  {assets.map((asset) => {
                    const checked = selectedAssetIds.includes(asset.id);
                    return (
                      <button
                        key={asset.id}
                        type="button"
                        onClick={() => toggleAssetSelection(asset.id)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
                      >
                        <span className={`flex h-4 w-4 items-center justify-center rounded border ${
                          checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
                        }`}>
                          {checked ? <Check className="h-3 w-3" /> : null}
                        </span>
                        <span className="min-w-0 truncate">{asset.assetName}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
            <label className="space-y-1.5">
              <span className="text-xs font-semibold text-muted-foreground">Aggregation</span>
              <select
                value={aggregationMode}
                onChange={(event) => setAggregationMode(event.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="sum">Sum</option>
                <option value="individual">Not Aggregated</option>
              </select>
            </label>
            <label className="space-y-1.5">
              <span className="text-xs font-semibold text-muted-foreground">Date</span>
              <input
                type="date"
                value={scheduleDate}
                onChange={(event) => setScheduleDate(event.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-xs font-semibold text-muted-foreground">Template Type</span>
              <select
                value={plantConfig.revisionType}
                onChange={(event) => updatePlant('revisionType', event.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="INTRADAY">Intraday</option>
                <option value="DA">Day Ahead</option>
              </select>
            </label>
          </div>
        </section>

        <section className="rounded-lg border border-border bg-card">
          <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-lg font-bold">Schedule Graph</h2>
            </div>
            <div className="flex flex-wrap gap-2">
              {GRAPH_SERIES_OPTIONS.map((item) => (
                <label key={item.key} className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs font-semibold">
                  <input
                    type="checkbox"
                    checked={Boolean(visibleGraphSeries[item.key])}
                    onChange={(event) => setVisibleGraphSeries((prev) => ({ ...prev, [item.key]: event.target.checked }))}
                  />
                  {item.label}
                </label>
              ))}
            </div>
          </div>
          <div className="h-[520px] p-4">
            {graphData.loading ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading graph...</div>
            ) : graphData.error ? (
              <div className="flex h-full items-center justify-center text-sm text-destructive">{graphData.error}</div>
            ) : graphPlotData.length && Plot ? (
              <Plot
                data={graphPlotData}
                layout={{
                  autosize: true,
                  margin: { l: 56, r: 24, t: 18, b: 48 },
                  xaxis: { title: 'Block', dtick: 4, gridcolor: '#e5e7eb' },
                  yaxis: { title: 'Power (MW)', gridcolor: '#e5e7eb', rangemode: 'tozero' },
                  legend: { orientation: 'h', y: 1.12, x: 0 },
                  paper_bgcolor: 'rgba(0,0,0,0)',
                  plot_bgcolor: 'rgba(0,0,0,0)',
                  hovermode: 'x unified',
                }}
                config={{ displayModeBar: false, responsive: true }}
                style={{ width: '100%', height: '100%' }}
                useResizeHandler
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Select asset and date to view graph data
              </div>
            )}
          </div>
        </section>

      </div>

      {isAdmin && showConfig && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
          <div className="max-h-[92vh] w-full max-w-6xl overflow-hidden rounded-lg border border-border bg-card shadow-xl">
            <div className="flex items-center justify-between gap-3 border-b border-border p-4">
              <div>
                <h2 className="text-xl font-bold">Asset Configuration</h2>
                <p className="text-xs text-muted-foreground">
                  Configure plant metadata, buyer details, and generator assets.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={saveConfiguration}
                  disabled={savingConfig}
                  className="inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {savingConfig ? 'Saving...' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={closeConfiguration}
                  className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label="Close asset configuration"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>
            <div className="max-h-[calc(92vh-76px)] overflow-auto p-4 space-y-5">
              {configStatus.message && (
                <div className={`rounded-lg border px-3 py-2 text-sm ${
                  configStatus.type === 'success'
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700'
                    : 'border-destructive/30 bg-destructive/10 text-destructive'
                }`}>
                  {configStatus.message}
                </div>
              )}
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                {[
                  ['plantName', 'Plant Name'],
                  ['totalCapacityAcMw', 'Total Capacity AC MW'],
                  ['totalCapacityDcMw', 'Total Capacity DC MW'],
                  ['schedulingCapacityAcMw', 'Currently Scheduling Capacity AC MW'],
                  ['schedulingCapacityDcMw', 'Currently Scheduling Capacity DC MW'],
                  ['state', 'State'],
                  ['location', 'Location'],
                  ['latitude', 'Latitude'],
                  ['longitude', 'Longitude'],
                  ['posName', 'POS Name'],
                  ['downstreamName', 'Down Stream Name'],
                ].map(([field, label]) => (
                  <label key={field} className="space-y-1.5">
                    <span className="text-xs font-semibold text-muted-foreground">{label}</span>
                    <input
                      value={draftPlantConfig[field]}
                      onChange={(event) => updateDraftPlant(field, event.target.value)}
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                    />
                  </label>
                ))}
              </div>

              <div className="rounded-lg border border-border">
                <div className="flex items-center justify-between border-b border-border p-3">
                  <h3 className="font-bold">Multi Generator Plants</h3>
                  <button
                    type="button"
                    onClick={addDraftGeneratorPlant}
                    className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
                  >
                    <Plus className="h-4 w-4" />
                    Add Plant
                  </button>
                </div>
                <div className="overflow-auto">
                  <table className="w-full min-w-[720px] text-sm">
                    <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                      <tr>
                        <th className="px-3 py-3 text-left">Plant Name</th>
                        <th className="px-3 py-3 text-left">State</th>
                        <th className="px-3 py-3 text-right">Scheduling AC MW</th>
                        <th className="px-3 py-3 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {draftGeneratorPlants.map((plant) => (
                        <tr key={plant.id}>
                          <td className="px-3 py-2">
                            <input
                              value={plant.plantName || ''}
                              onChange={(event) => updateDraftGeneratorPlant(plant.id, 'plantName', event.target.value)}
                              className="w-full rounded-md border border-border bg-background px-2 py-1.5 outline-none focus:ring-2 focus:ring-primary/25"
                            />
                          </td>
                          <td className="px-3 py-2">
                            <input
                              value={plant.state || ''}
                              onChange={(event) => updateDraftGeneratorPlant(plant.id, 'state', event.target.value)}
                              className="w-full rounded-md border border-border bg-background px-2 py-1.5 outline-none focus:ring-2 focus:ring-primary/25"
                            />
                          </td>
                          <td className="px-3 py-2 text-right">
                            <input
                              type="number"
                              step="0.001"
                              value={plant.schedulingCapacityAcMw || ''}
                              onChange={(event) => updateDraftGeneratorPlant(plant.id, 'schedulingCapacityAcMw', event.target.value)}
                              className="w-32 rounded-md border border-border bg-background px-2 py-1.5 text-right outline-none focus:ring-2 focus:ring-primary/25"
                            />
                          </td>
                          <td className="px-3 py-2 text-right">
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => selectDraftGeneratorPlant(plant.id)}
                                className="rounded-md border border-border px-2 py-1 text-xs font-semibold hover:bg-accent"
                              >
                                Use
                              </button>
                              <button
                                type="button"
                                onClick={() => deleteDraftGeneratorPlant(plant.id)}
                                className="inline-flex rounded-md p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                aria-label="Delete plant"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {draftBuyers.map((buyer) => (
                  <div key={buyer} className="rounded-lg border border-border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <input
                        value={buyer}
                        onChange={(event) => updateDraftBuyerName(buyer, event.target.value)}
                        className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-bold outline-none focus:ring-2 focus:ring-primary/25"
                      />
                      <button
                        type="button"
                        onClick={() => deleteDraftBuyer(buyer)}
                        disabled={draftBuyers.length <= 1}
                        className="inline-flex rounded-md p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40"
                        aria-label="Delete buyer"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
                      {[
                        ['scheduleCapacityMw', 'Schedule Capacity MW'],
                        ['contractId', 'Contract ID'],
                        ['approvalNumber', 'Approval Number'],
                      ].map(([field, label]) => (
                        <label key={field} className="space-y-1.5">
                          <span className="text-xs font-semibold text-muted-foreground">{label}</span>
                          <input
                            value={draftBuyerConfig[buyer]?.[field] || ''}
                            onChange={(event) => updateDraftBuyer(buyer, field, event.target.value)}
                            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addDraftBuyer}
                  className="flex min-h-[116px] items-center justify-center gap-2 rounded-lg border border-dashed border-border p-3 text-sm font-semibold hover:bg-accent"
                >
                  <Plus className="h-4 w-4" />
                  Add Buyer
                </button>
              </div>

              <div className="rounded-lg border border-border">
                <div className="flex items-center justify-between border-b border-border p-3">
                  <h3 className="font-bold">Assets</h3>
                  <button
                    type="button"
                    onClick={addDraftAsset}
                    className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
                  >
                    <Plus className="h-4 w-4" />
                    Add Asset
                  </button>
                </div>
                <div className="overflow-auto">
                  <table className="w-full min-w-[940px] text-sm">
                    <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                      <tr>
                        <th className="px-3 py-3 text-left">Sr. No</th>
                        <th className="px-3 py-3 text-left">Asset Name</th>
                        <th className="px-3 py-3 text-left">Buyer</th>
                        <th className="px-3 py-3 text-right">AC MW</th>
                        <th className="px-3 py-3 text-right">DC MW</th>
                        <th className="px-3 py-3 text-left">Meter Data</th>
                        <th className="px-3 py-3 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {draftAssets.map((asset, index) => (
                        <tr key={asset.id}>
                          <td className="px-3 py-2 font-semibold">{index + 1}</td>
                          <td className="px-3 py-2">
                            <input
                              value={asset.assetName}
                              onChange={(event) => updateDraftAsset(asset.id, { assetName: event.target.value })}
                              className="w-full rounded-md border border-border bg-background px-2 py-1.5 outline-none focus:ring-2 focus:ring-primary/25"
                            />
                          </td>
                          <td className="px-3 py-2">
                            <select
                              value={asset.buyer}
                              onChange={(event) => updateDraftAsset(asset.id, { buyer: event.target.value })}
                              className="w-full rounded-md border border-border bg-background px-2 py-1.5 outline-none focus:ring-2 focus:ring-primary/25"
                            >
                              {draftBuyers.map((buyer) => (
                                <option key={buyer} value={buyer}>{buyer}</option>
                              ))}
                            </select>
                          </td>
                          <td className="px-3 py-2">
                            <input
                              type="number"
                              step="0.001"
                              value={asset.acCapacityMw}
                              onChange={(event) => updateDraftAsset(asset.id, { acCapacityMw: event.target.value })}
                              className="w-24 rounded-md border border-border bg-background px-2 py-1.5 text-right outline-none focus:ring-2 focus:ring-primary/25"
                            />
                          </td>
                          <td className="px-3 py-2">
                            <input
                              type="number"
                              step="0.001"
                              value={asset.dcCapacityMw}
                              onChange={(event) => updateDraftAsset(asset.id, { dcCapacityMw: event.target.value })}
                              className="w-24 rounded-md border border-border bg-background px-2 py-1.5 text-right outline-none focus:ring-2 focus:ring-primary/25"
                            />
                          </td>
                          <td className="px-3 py-2">
                            <select
                              value={asset.meterAvailable ? 'yes' : 'no'}
                              onChange={(event) => updateDraftAsset(asset.id, { meterAvailable: event.target.value === 'yes' })}
                              className="w-24 rounded-md border border-border bg-background px-2 py-1.5 outline-none focus:ring-2 focus:ring-primary/25"
                            >
                              <option value="yes">Yes</option>
                              <option value="no">No</option>
                            </select>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <button
                              type="button"
                              onClick={() => deleteDraftAsset(asset.id)}
                              className="inline-flex rounded-md p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                              aria-label="Delete asset"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
