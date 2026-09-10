import {
  downloadBlob,
  downloadCombinedDayAheadTemplate as baseDownloadCombinedDayAheadTemplate,
} from './downloadUtils';

export * from './downloadUtils';

const MAHARASHTRA_COMBINED_DAYAHEAD_CONFIG = {
  templateUrl: '/templates/maharashtra_osepl_cme_combined_dayahead_template.csv',
  format: 'csv',
  dateRow: 2,
  dateCol: 2,
  plantColumns: {
    OSEPL: { declaredForecastCol: 1, availabilityCol: 2, scheduleCol: 3, dataRow: 19, capacity: 20 },
    CME: { declaredForecastCol: 4, availabilityCol: 5, scheduleCol: 6, dataRow: 19, capacity: 5 },
    ZETRIC: { declaredForecastCol: 7, availabilityCol: 8, scheduleCol: 9, dataRow: 19, capacity: 25 },
  },
};

const VEDANJAY_META = {
  CME: {
    schedulingEntity: 'MH_VEDANJAY',
    posName: 'VSNL Dighi 220kV',
    downStreamName: 'VSNL Dighi 220kV',
    energyType: 'SOLAR',
    contractId: 'CONTRACT25484',
    contractType: 'MTOA',
    exchangeType: 'NA',
    transactionType: 'INTRA',
    reGeneratorName: 'VSNL Dighi 220kV',
    path: 'A-B',
    buyerName: 'OA-MSEDCL',
    stuName: 'VSNL Dighi 220kV',
    approvalNumber: 'VSNLDighi/S/09/26/OA-MSEDCL',
    capacity: 5,
  },
  OSEPL: {
    schedulingEntity: 'MH_VEDANJAY',
    posName: 'Naldurg Inter 132kV',
    downStreamName: 'Naldurg Inter 132kV',
    energyType: 'SOLAR',
    contractId: 'CONTRACT00192',
    contractType: 'LTA',
    exchangeType: 'NA',
    transactionType: 'INTER',
    reGeneratorName: 'Naldurg Inter 132kV',
    path: 'WR-WR',
    buyerName: 'SOLAR_CSEB',
    stuName: 'Naldurg 132kV',
    approvalNumber: 'L_WR_2014_03',
    capacity: 20,
  },
};

const parseCsvToRows = (csvText) => {
  const text = String(csvText || '');
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1];
        if (next === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      continue;
    }
    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    if (ch === '\r') continue;
    cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
};

const csvEscapeCell = (value) => {
  const text = String(value ?? '');
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
};

const formatDateDmyHyphen = (value) => {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return String(value || '').trim();
  return `${match[3]}-${match[2]}-${match[1]}`;
};

const formatTemplateNumber = (value) => {
  if (value === null || value === undefined || value === '') return '';
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value).trim();
  if (Math.abs(num - Math.trunc(num)) < 1e-9) return String(Math.trunc(num));
  return num.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
};

const formatTemplateCapacity = (value) => {
  if (value === null || value === undefined || value === '') return '';
  const text = String(value).replace(/,/g, '').trim();
  const num = Number(text);
  if (!Number.isFinite(num)) return String(value).trim();
  if (Math.abs(num - Math.trunc(num)) < 1e-9) return String(Math.trunc(num));
  return text;
};

const normalizeZetricCombinedDayAheadConfig = (item, fallbackCapacityMw = 25) => {
  const plants = Array.isArray(item?.template_config?.multi_generator_plants)
    ? item.template_config.multi_generator_plants
    : [];
  const activePlant = plants.find((plant) => {
    const plantName = String(plant?.plantName || plant?.plant_name || '').trim().toUpperCase();
    return plantName.includes('ZETRIC') || plantName.includes('ZTRIC');
  }) || plants.find((plant) => String(plant?.plantName || plant?.plant_name || '').trim()) || {};
  const parseNumber = (value) => {
    const num = Number(String(value || '').replace(/,/g, '').trim());
    return Number.isFinite(num) ? num : null;
  };
  const resolveCapacity = () => {
    const candidates = [
      item?.currently_scheduling_capacity?.ac_mw,
      item?.currently_scheduling_capacity?.mw,
      item?.currentlySchedulingCapacityMw,
      item?.currently_scheduling_capacity_mw,
      activePlant?.currently_scheduling_capacity?.ac_mw,
      activePlant?.currentlySchedulingCapacityMw,
      activePlant?.schedulingCapacityMw,
      activePlant?.scheduleCapacityMw,
      activePlant?.capacityMw,
      activePlant?.capacity_mw,
      fallbackCapacityMw,
    ];
    for (const candidate of candidates) {
      const parsed = parseNumber(candidate);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return fallbackCapacityMw;
  };
  const topLevelBuyers = (Array.isArray(item?.buyers) ? item.buyers : [])
    .map((buyer) => ({
      buyerName: String(buyer?.buyer_name || buyer?.buyerName || '').trim(),
      scheduleCapacityMw: parseNumber(buyer?.schedule_capacity_mw ?? buyer?.scheduleCapacityMw ?? buyer?.capacity_mw),
      contractId: String(buyer?.contract_id || buyer?.contractId || '').trim(),
      approvalNumber: String(buyer?.approval_number || buyer?.approvalNumber || '').trim(),
    }))
    .filter((buyer) => buyer.buyerName);
  const activePlantBuyers = Array.isArray(activePlant?.buyers)
    ? activePlant.buyers
        .map((buyerKey) => {
          const cfg = activePlant?.buyerConfig?.[buyerKey] || {};
          return {
            buyerName: String(cfg.buyerName || cfg.buyer_name || buyerKey || '').trim(),
            scheduleCapacityMw: parseNumber(cfg.scheduleCapacityMw ?? cfg.schedule_capacity_mw ?? cfg.capacity_mw),
            contractId: String(cfg.contractId || cfg.contract_id || '').trim(),
            approvalNumber: String(cfg.approvalNumber || cfg.approval_number || '').trim(),
          };
        })
        .filter((buyer) => buyer.buyerName)
    : [];
  const buyers = topLevelBuyers.length ? topLevelBuyers : activePlantBuyers;
  const fallbackBuyers = [
    { buyerName: 'AEML', scheduleCapacityMw: 6, contractId: 'CONTRACT24315', approvalNumber: 'Chakur/S/07/26/AEML' },
    { buyerName: 'OA-MSEDCL', scheduleCapacityMw: Math.max(0, resolveCapacity() - 6), contractId: 'CONTRACT23871', approvalNumber: 'CHAKUR/S/07/26/OA-MSEDCL' },
  ];
  const normalizedBuyers = buyers.length ? buyers : fallbackBuyers;
  const schedulingCapacityMw = resolveCapacity();
  const firstBuyer = normalizedBuyers[0] || {};
  return {
    posName: String(activePlant?.posName || item?.posName || 'Chakur 132kV').trim(),
    downStreamName: String(activePlant?.downstreamName || activePlant?.downStreamName || item?.downStreamName || 'Chakur 132kV').trim(),
    energyType: String(activePlant?.energyType || 'SOLAR').trim(),
    contractType: String(activePlant?.contractType || 'MTOA').trim(),
    exchangeType: String(activePlant?.exchangeType || 'NA').trim(),
    transactionType: String(activePlant?.transactionType || 'INTRA').trim(),
    reGeneratorName: String(activePlant?.reGeneratorName || activePlant?.posName || item?.posName || 'Chakur 132kV').trim(),
    path: String(activePlant?.path || 'A-B').trim(),
    stuName: String(activePlant?.stuName || activePlant?.posName || item?.posName || 'Chakur 132kV').trim(),
    buyerName: String(firstBuyer.buyerName || normalizedBuyers.map((buyer) => buyer.buyerName).filter(Boolean).join(' / ') || '').trim(),
    contractId: String(firstBuyer.contractId || normalizedBuyers.map((buyer) => buyer.contractId).filter(Boolean).join(' / ') || '').trim(),
    approvalNumber: String(firstBuyer.approvalNumber || normalizedBuyers.map((buyer) => buyer.approvalNumber).filter(Boolean).join(' / ') || '').trim(),
    schedulingCapacityMw,
    buyers: normalizedBuyers,
  };
};

const fetchZetricCombinedDayAheadConfig = async () => {
  try {
    const response = await fetch('/api/multi-generator-plant/ZETRIC_SOLAR_PARK');
    if (!response.ok) return null;
    const payload = await response.json();
    return payload?.item || payload || null;
  } catch (error) {
    console.warn('Failed to load ZETRIC config for combined day-ahead template.', error);
    return null;
  }
};

const blockInterval = (block) => {
  const start = (Number(block || 1) - 1) * 15;
  const end = Number(block || 1) * 15;
  const fmt = (minutes) => {
    if (minutes === 1440) return '24:00';
    const hour = Math.floor(minutes / 60) % 24;
    const minute = minutes % 60;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  };
  return `${fmt(start)}-${fmt(end)}`;
};

const parseScheduleBlocksForCombinedTemplate = (csvText) => {
  const rows = parseCsvToRows(csvText);
  const normalize = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  let headerIndex = -1;
  let bestScore = -1;

  rows.slice(0, 120).forEach((row, idx) => {
    const normalized = row.map(normalize);
    const joined = normalized.join(' ');
    let score = 0;
    if (joined.includes('block')) score += 4;
    if (joined.includes('availability') || joined.includes('avc') || joined.includes('interavc')) score += 3;
    if (joined.includes('forecast') || joined.includes('schedule') || joined.includes('stationschedule')) score += 4;
    if (score > bestScore) {
      bestScore = score;
      headerIndex = idx;
    }
  });

  const headers = headerIndex >= 0 ? rows[headerIndex].map(normalize) : [];
  const findCol = (candidates, fallback) => {
    const normalizedCandidates = candidates.map(normalize);
    for (const candidate of normalizedCandidates) {
      const idx = headers.findIndex((h) => h === candidate || (candidate && h.includes(candidate)));
      if (idx >= 0) return idx;
    }
    return fallback;
  };

  const blockCol = findCol(['Block', 'Block No', 'Sr No'], 0);
  const scheduleCol = findCol(['Station Schedule', 'Schedule', 'Scheduled MW', 'Forecast', 'Forecast(MW)', 'Declared Forecast', 'MW'], headers.length > 4 ? 4 : 1);
  const availabilityCol = findCol(['Availability', 'AvC', 'Inter Avc'], headers.length > 3 ? 3 : -1);
  const dataRows = headerIndex >= 0 ? rows.slice(headerIndex + 1) : rows;
  const blocks = new Map();

  dataRows.forEach((row) => {
    const blockNumber = Number(row?.[blockCol]);
    if (!Number.isFinite(blockNumber)) return;
    const block = Math.trunc(blockNumber);
    if (block < 1 || block > 96) return;
    const schedule = Number(String(row?.[scheduleCol] || '').replace(/,/g, '').trim());
    const availabilityRaw = availabilityCol >= 0 ? Number(String(row?.[availabilityCol] || '').replace(/,/g, '').trim()) : null;
    blocks.set(block, {
      schedule: Number.isFinite(schedule) ? schedule : 0,
      availability: Number.isFinite(availabilityRaw) ? availabilityRaw : null,
    });
  });

  return blocks;
};

const parseZetricCombinedScheduleBlocks = (csvText) => {
  const rows = parseCsvToRows(csvText);
  const normalize = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  const parseNumber = (value) => {
    const num = Number(String(value || '').replace(/,/g, '').trim());
    return Number.isFinite(num) ? num : null;
  };

  let headerIndex = -1;
  let bestScore = -1;
  rows.slice(0, 120).forEach((row, idx) => {
    const normalized = row.map(normalize);
    const joined = normalized.join(' ');
    let score = 0;
    if (joined.includes('block')) score += 4;
    if (joined.includes('declaredforecast') || joined.includes('forecast')) score += 4;
    if (joined.includes('intraavc') || joined.includes('interavc') || joined.includes('avc')) score += 3;
    if (joined.includes('schedule')) score += 4;
    if (score > bestScore) {
      bestScore = score;
      headerIndex = idx;
    }
  });

  const headers = headerIndex >= 0 ? rows[headerIndex].map(normalize) : [];
  const blockCol = headers.findIndex((header) => header === 'block' || header.includes('block'));
  const declaredForecastCol = headers.findIndex((header) => header.includes('declaredforecast') || (header.includes('forecast') && !header.includes('actual')));
  const intraAvcCol = headers.findIndex((header) => header.includes('intraavc') || header.includes('interavc') || header === 'avc' || header.includes('avc'));
  let scheduleCols = headers
    .map((header, idx) => (idx >= 3 && header.includes('schedule') ? idx : -1))
    .filter((idx) => idx >= 0);
  if (!scheduleCols.length && headers.length > 3) {
    scheduleCols = headers.slice(3).map((_, idx) => idx + 3);
  }

  const blocks = new Map();
  const dataRows = headerIndex >= 0 ? rows.slice(headerIndex + 1) : rows;
  dataRows.forEach((row) => {
    const blockNumber = Number(row?.[blockCol >= 0 ? blockCol : 0]);
    if (!Number.isFinite(blockNumber)) return;
    const block = Math.trunc(blockNumber);
    if (block < 1 || block > 96) return;

    const parsedScheduleValues = scheduleCols.map((colIdx) => parseNumber(row?.[colIdx]));
    const hasScheduleValue = parsedScheduleValues.some((value) => Number.isFinite(value));
    const scheduleValues = parsedScheduleValues.map((value) => (Number.isFinite(value) ? value : 0));
    const declaredForecastFromSource = parseNumber(row?.[declaredForecastCol >= 0 ? declaredForecastCol : 1]);
    const declaredForecast = hasScheduleValue
      ? scheduleValues.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0)
      : (Number.isFinite(declaredForecastFromSource) ? declaredForecastFromSource : 0);
    const intraAvcFromSource = parseNumber(row?.[intraAvcCol >= 0 ? intraAvcCol : 2]);
    blocks.set(block, {
      declaredForecast,
      intraAvc: Number.isFinite(intraAvcFromSource) ? intraAvcFromSource : null,
      schedules: scheduleValues,
    });
  });

  return {
    blocks,
    scheduleCount: scheduleCols.length || Math.max(0, headers.length - 3),
  };
};

const extractZetricCombinedDayAheadMetadata = (csvText, zetricConfig = null) => {
  const rows = parseCsvToRows(csvText);
  const normalize = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  const parseNumber = (value) => {
    const num = Number(String(value || '').replace(/,/g, '').trim());
    return Number.isFinite(num) ? num : null;
  };
  const findRowValue = (row) => row.slice(1).map(parseNumber).find((value) => Number.isFinite(value) && value > 0);
  const findRow = (label) => rows.find((row) => normalize(row?.[0]) === normalize(label));
  const readCell = (label, colIdx) => String(findRow(label)?.[colIdx] || '').trim();
  const readNumberCell = (label, colIdx) => parseNumber(findRow(label)?.[colIdx]);
  const meta = {};

  const configPlants = Array.isArray(zetricConfig?.template_config?.multi_generator_plants)
    ? zetricConfig.template_config.multi_generator_plants
    : [];
  const activePlant = configPlants.find((plant) => String(plant?.plantName || plant?.plant_name || '').trim()) || {};
  const configCapacityCandidates = [
    zetricConfig?.currently_scheduling_capacity?.ac_mw,
    zetricConfig?.currently_scheduling_capacity?.mw,
    zetricConfig?.currentlySchedulingCapacityMw,
    zetricConfig?.currently_scheduling_capacity_mw,
    activePlant?.currently_scheduling_capacity?.ac_mw,
    activePlant?.currentlySchedulingCapacityMw,
    activePlant?.schedulingCapacityMw,
    activePlant?.scheduleCapacityMw,
    activePlant?.capacityMw,
    activePlant?.capacity_mw,
  ];
  const configCapacity = configCapacityCandidates
    .map(parseNumber)
    .find((value) => Number.isFinite(value) && value > 0);
  if (Number.isFinite(configCapacity) && configCapacity > 0) {
    meta.schedulingCapacityMw = configCapacity;
  }

  rows.forEach((row) => {
    const label = normalize(row?.[0]);
    if (!label) return;

    if (
      label.includes('currentlyschedulingcapacityacmw') ||
      label.includes('currentschedulingcapacityacmw') ||
      label.includes('schedulingcapacityacmw') ||
      label.includes('currentlyschedulingcapacity') ||
      label.includes('currentschedulingcapacity') ||
      label.includes('schedulingcapacity')
    ) {
      const capacity = findRowValue(row);
      if (Number.isFinite(capacity) && capacity > 0) {
        meta.schedulingCapacityMw = capacity;
      }
    }

    if (
      !Number.isFinite(meta.schedulingCapacityMw) &&
      label.includes('totalcapacity')
    ) {
      const totalCapacity = findRowValue(row);
      if (Number.isFinite(totalCapacity) && totalCapacity > 0) {
        meta.schedulingCapacityMw = totalCapacity;
      }
    }

    if (
      !Number.isFinite(meta.schedulingCapacityMw) &&
      label === 'capacity'
    ) {
      const capacity = findRowValue(row);
      if (Number.isFinite(capacity) && capacity > 0) {
        meta.schedulingCapacityMw = capacity;
      }
    }
  });

  const headerRow = rows.find((row) => row.map(normalize).some((cell) => cell === 'block'));
  const scheduleCols = Array.isArray(headerRow)
    ? headerRow
        .map((cell, idx) => (idx >= 3 && normalize(cell).includes('schedule') ? idx : -1))
        .filter((idx) => idx >= 0)
    : [];
  if (scheduleCols.length) {
    const fallbackBuyers = Array.isArray(zetricConfig?.buyers) ? zetricConfig.buyers : [];
    const buyers = scheduleCols.map((colIdx, index) => {
      const fallbackBuyer = fallbackBuyers[index] || fallbackBuyers[fallbackBuyers.length - 1] || {};
      const scheduleCapacityMw = readNumberCell('Capacity', colIdx);
      return {
        buyerName: readCell('Buyer Name', colIdx) || fallbackBuyer.buyerName || '',
        scheduleCapacityMw: Number.isFinite(scheduleCapacityMw) ? scheduleCapacityMw : fallbackBuyer.scheduleCapacityMw,
        contractId: readCell('Contract ID', colIdx) || fallbackBuyer.contractId || '',
        approvalNumber: readCell('Approval Number', colIdx) || fallbackBuyer.approvalNumber || '',
      };
    });
    if (buyers.some((buyer) => buyer.buyerName || buyer.contractId || buyer.approvalNumber || Number.isFinite(buyer.scheduleCapacityMw))) {
      meta.buyers = buyers;
    }
  }

  return meta;
};

const extractCombinedDayAheadMetadata = (csvText, fallbackMeta = {}) => {
  const rows = parseCsvToRows(csvText);
  const normalize = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  const parseNumber = (value) => {
    const num = Number(String(value || '').replace(/,/g, '').trim());
    return Number.isFinite(num) ? num : null;
  };
  const firstTextValue = (row) => (Array.isArray(row) ? row.slice(1).map((cell) => String(cell || '').trim()).find(Boolean) || '' : '');
  const firstNumericValue = (row) => {
    if (!Array.isArray(row)) return null;
    for (const cell of row.slice(1)) {
      const parsed = parseNumber(cell);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return null;
  };
  const findRow = (label) => rows.find((row) => normalize(row?.[0]) === normalize(label));
  const readText = (labels, fallback = '') => {
    for (const label of labels) {
      const row = findRow(label);
      const value = firstTextValue(row);
      if (value) return value;
    }
    return String(fallback || '').trim();
  };
  const readNumber = (labels, fallback = null) => {
    for (const label of labels) {
      const row = findRow(label);
      const value = firstNumericValue(row);
      if (Number.isFinite(value) && value > 0) return value;
    }
    const parsedFallback = parseNumber(fallback);
    return Number.isFinite(parsedFallback) && parsedFallback > 0 ? parsedFallback : fallback;
  };

  return {
    schedulingEntity: readText(['Scheduling entity'], fallbackMeta.schedulingEntity || 'MH_VEDANJAY'),
    posName: readText(['POS Name'], fallbackMeta.posName || ''),
    downStreamName: readText(['Down Stream Name'], fallbackMeta.downStreamName || ''),
    energyType: readText(['Energy Type'], fallbackMeta.energyType || 'SOLAR'),
    contractId: readText(['Contract ID'], fallbackMeta.contractId || ''),
    contractType: readText(['Contract Type'], fallbackMeta.contractType || 'MTOA'),
    exchangeType: readText(['Exchange Type'], fallbackMeta.exchangeType || 'NA'),
    transactionType: readText(['Transaction Type'], fallbackMeta.transactionType || 'INTRA'),
    reGeneratorName: readText(['RE Generator Name'], fallbackMeta.reGeneratorName || ''),
    path: readText(['Path'], fallbackMeta.path || 'A-B'),
    buyerName: readText(['Buyer Name'], fallbackMeta.buyerName || ''),
    stuName: readText(['STU Name'], fallbackMeta.stuName || ''),
    approvalNumber: readText(['Approval Number'], fallbackMeta.approvalNumber || ''),
    schedulingCapacityMw: readNumber(['Capacity', 'Currently Scheduling Capacity AC MW', 'Currently Scheduling Capacity DC MW', 'Total Capacity AC MW', 'Total Capacity DC MW'], fallbackMeta.schedulingCapacityMw || fallbackMeta.capacity || 0),
  };
};

const downloadMaharashtraCombinedDayAheadTemplate = async ({
  scheduleDate,
  plantCsvByCode,
  filenameBase,
  key,
  zetricConfig,
  download = true,
} = {}) => {
  const dateText = String(scheduleDate || '').trim();
  const displayDate = dateText;
  const resolvedZetricConfig = zetricConfig || await fetchZetricCombinedDayAheadConfig();
  const plantOrder = ['OSEPL', 'CME', 'ZETRIC'];
  const fallbackMetaByCode = {
    OSEPL: VEDANJAY_META.OSEPL || {},
    CME: VEDANJAY_META.CME || {},
    ZETRIC: normalizeZetricCombinedDayAheadConfig(
      resolvedZetricConfig,
      MAHARASHTRA_COMBINED_DAYAHEAD_CONFIG.plantColumns?.ZETRIC?.capacity || 25
    ),
  };
  const plantMetaByCode = {};
  const plantBlocksByCode = {};

  plantOrder.forEach((plantCode) => {
    const csvText = String((plantCsvByCode || {})[plantCode] || '').trim();
    const fallbackMeta = fallbackMetaByCode[plantCode] || {};
    plantMetaByCode[plantCode] = plantCode === 'ZETRIC'
      ? { ...fallbackMeta, ...extractZetricCombinedDayAheadMetadata(csvText, fallbackMeta) }
      : extractCombinedDayAheadMetadata(csvText, fallbackMeta);
    plantBlocksByCode[plantCode] = plantCode === 'ZETRIC'
      ? parseZetricCombinedScheduleBlocks(csvText)
      : parseScheduleBlocksForCombinedTemplate(csvText);
  });

  const zetricMeta = plantMetaByCode.ZETRIC || {};
  const zetricBuyers = Array.isArray(zetricMeta.buyers) ? zetricMeta.buyers.filter(Boolean) : [];
  const zetricScheduleCount = Math.max(
    1,
    Number(plantBlocksByCode.ZETRIC?.scheduleCount || 0) || zetricBuyers.length || 1
  );
  const zetricBuyerColumns = Array.from({ length: zetricScheduleCount }, (_, index) => (
    zetricBuyers[index]
    || zetricBuyers[zetricBuyers.length - 1]
    || {}
  ));
  const zetricCapacityValue = formatTemplateCapacity(
    zetricMeta.schedulingCapacityMw
    || zetricMeta.capacity
    || MAHARASHTRA_COMBINED_DAYAHEAD_CONFIG.plantColumns?.ZETRIC?.capacity
    || 25
  );
  const zetricScheduleHeaders = zetricBuyerColumns.map(() => 'Schedule');
  const zetricPosColumns = zetricBuyerColumns.map(() => zetricMeta.posName || '');
  const zetricDownStreamColumns = zetricBuyerColumns.map(() => zetricMeta.downStreamName || '');
  const zetricEnergyTypeColumns = zetricBuyerColumns.map(() => zetricMeta.energyType || 'SOLAR');
  const zetricContractIdColumns = zetricBuyerColumns.map((buyer) => buyer.contractId || '');
  const zetricContractTypeColumns = zetricBuyerColumns.map(() => zetricMeta.contractType || 'MTOA');
  const zetricExchangeTypeColumns = zetricBuyerColumns.map(() => zetricMeta.exchangeType || 'NA');
  const zetricTransactionTypeColumns = zetricBuyerColumns.map(() => zetricMeta.transactionType || 'INTRA');
  const zetricReGeneratorColumns = zetricBuyerColumns.map(() => zetricMeta.reGeneratorName || zetricMeta.posName || '');
  const zetricPathColumns = zetricBuyerColumns.map(() => zetricMeta.path || 'A-B');
  const zetricBuyerNameColumns = zetricBuyerColumns.map((buyer) => buyer.buyerName || '');
  const zetricStuNameColumns = zetricBuyerColumns.map(() => zetricMeta.stuName || zetricMeta.posName || '');
  const zetricApprovalNumberColumns = zetricBuyerColumns.map((buyer) => buyer.approvalNumber || '');
  const zetricCapacityColumns = zetricBuyerColumns.map((buyer) => formatTemplateCapacity(buyer.scheduleCapacityMw || 0));

  const rows = [
    ['Schedule Template for MH_VEDANJAY and revision DA', '', '', '', '', '', '', '', '', ''],
    ['', 'Scheduling entity', 'MH_VEDANJAY', '', '', '', '', '', '', ''],
    ['', 'Date', displayDate, '', '', '', '', '', '', ''],
    ['', 'Revision No', 'DA', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', ''],
    ['POS Name',
      plantMetaByCode.OSEPL.posName || '',
      plantMetaByCode.OSEPL.posName || '',
      plantMetaByCode.OSEPL.posName || '',
      plantMetaByCode.CME.posName || '',
      plantMetaByCode.CME.posName || '',
      plantMetaByCode.CME.posName || '',
      plantMetaByCode.ZETRIC.posName || '',
      plantMetaByCode.ZETRIC.posName || '',
      ...zetricPosColumns,
    ],
    ['Down Stream Name',
      '',
      '',
      plantMetaByCode.OSEPL.downStreamName || '',
      '',
      '',
      plantMetaByCode.CME.downStreamName || '',
      '',
      '',
      ...zetricDownStreamColumns,
    ],
    ['Energy Type',
      '',
      '',
      plantMetaByCode.OSEPL.energyType || '',
      '',
      '',
      plantMetaByCode.CME.energyType || '',
      '',
      '',
      ...zetricEnergyTypeColumns,
    ],
    ['Contract ID',
      '',
      '',
      plantMetaByCode.OSEPL.contractId || '',
      '',
      '',
      plantMetaByCode.CME.contractId || '',
      '',
      '',
      ...zetricContractIdColumns,
    ],
    ['Contract Type',
      '',
      '',
      plantMetaByCode.OSEPL.contractType || '',
      '',
      '',
      plantMetaByCode.CME.contractType || '',
      '',
      '',
      ...zetricContractTypeColumns,
    ],
    ['Exchange Type',
      '',
      '',
      plantMetaByCode.OSEPL.exchangeType || '',
      '',
      '',
      plantMetaByCode.CME.exchangeType || '',
      '',
      '',
      ...zetricExchangeTypeColumns,
    ],
    ['Transaction Type',
      plantMetaByCode.OSEPL.transactionType || '',
      plantMetaByCode.OSEPL.transactionType || '',
      plantMetaByCode.OSEPL.transactionType || '',
      plantMetaByCode.CME.transactionType || '',
      plantMetaByCode.CME.transactionType || '',
      plantMetaByCode.CME.transactionType || '',
      zetricMeta.transactionType || 'INTRA',
      zetricMeta.transactionType || 'INTRA',
      ...zetricTransactionTypeColumns,
    ],
    ['RE Generator Name',
      '',
      '',
      plantMetaByCode.OSEPL.reGeneratorName || '',
      '',
      '',
      plantMetaByCode.CME.reGeneratorName || '',
      '',
      '',
      ...zetricReGeneratorColumns,
    ],
    ['Path',
      '',
      '',
      plantMetaByCode.OSEPL.path || '',
      '',
      '',
      plantMetaByCode.CME.path || '',
      '',
      '',
      ...zetricPathColumns,
    ],
    ['Buyer Name',
      '',
      '',
      plantMetaByCode.OSEPL.buyerName || '',
      '',
      '',
      plantMetaByCode.CME.buyerName || '',
      '',
      '',
      ...zetricBuyerNameColumns,
    ],
    ['STU Name',
      '',
      '',
      plantMetaByCode.OSEPL.stuName || '',
      '',
      '',
      plantMetaByCode.CME.stuName || '',
      '',
      '',
      ...zetricStuNameColumns,
    ],
    ['Approval Number',
      '',
      '',
      plantMetaByCode.OSEPL.approvalNumber || '',
      '',
      '',
      plantMetaByCode.CME.approvalNumber || '',
      '',
      '',
      ...zetricApprovalNumberColumns,
    ],
    ['Capacity',
      formatTemplateCapacity(plantMetaByCode.OSEPL.schedulingCapacityMw || plantMetaByCode.OSEPL.capacity || MAHARASHTRA_COMBINED_DAYAHEAD_CONFIG.plantColumns?.OSEPL?.capacity || 20),
      formatTemplateCapacity(plantMetaByCode.OSEPL.schedulingCapacityMw || plantMetaByCode.OSEPL.capacity || MAHARASHTRA_COMBINED_DAYAHEAD_CONFIG.plantColumns?.OSEPL?.capacity || 20),
      formatTemplateCapacity(plantMetaByCode.OSEPL.schedulingCapacityMw || plantMetaByCode.OSEPL.capacity || MAHARASHTRA_COMBINED_DAYAHEAD_CONFIG.plantColumns?.OSEPL?.capacity || 20),
      formatTemplateCapacity(plantMetaByCode.CME.schedulingCapacityMw || plantMetaByCode.CME.capacity || MAHARASHTRA_COMBINED_DAYAHEAD_CONFIG.plantColumns?.CME?.capacity || 5),
      formatTemplateCapacity(plantMetaByCode.CME.schedulingCapacityMw || plantMetaByCode.CME.capacity || MAHARASHTRA_COMBINED_DAYAHEAD_CONFIG.plantColumns?.CME?.capacity || 5),
      formatTemplateCapacity(plantMetaByCode.CME.schedulingCapacityMw || plantMetaByCode.CME.capacity || MAHARASHTRA_COMBINED_DAYAHEAD_CONFIG.plantColumns?.CME?.capacity || 5),
      zetricCapacityValue,
      zetricCapacityValue,
      ...zetricCapacityColumns,
    ],
    [
      'Block',
      'Declared Forecast',
      'Inter Avc',
      'Schedule',
      'Declared Forecast',
      'Inter Avc',
      'Schedule',
      'Declared Forecast',
      'Inter Avc',
      ...zetricScheduleHeaders,
    ],
  ];

  for (let block = 1; block <= 96; block += 1) {
    const row = [String(block)];
    plantOrder.forEach((plantCode) => {
      if (plantCode === 'ZETRIC') {
        const values = plantBlocksByCode.ZETRIC?.blocks?.get(block) || { declaredForecast: 0, intraAvc: null, schedules: [] };
        const schedules = Array.isArray(values.schedules) ? values.schedules.slice(0, zetricScheduleCount) : [];
        while (schedules.length < zetricScheduleCount) schedules.push(0);
        const declaredForecast = Number.isFinite(values.declaredForecast)
          ? values.declaredForecast
          : schedules.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
        const availability = values.intraAvc !== null && Number.isFinite(values.intraAvc)
          ? values.intraAvc
          : (declaredForecast > 0 ? Number(zetricMeta.schedulingCapacityMw || zetricMeta.capacity || MAHARASHTRA_COMBINED_DAYAHEAD_CONFIG.plantColumns?.ZETRIC?.capacity || 25) : 0);
        row.push(
          formatTemplateNumber(declaredForecast),
          formatTemplateNumber(availability),
          ...schedules.map((value) => formatTemplateNumber(value)),
        );
        return;
      }
      const values = plantBlocksByCode[plantCode]?.get(block) || { schedule: 0, availability: null };
      const schedule = Number.isFinite(values.schedule) ? values.schedule : 0;
      const capacity = Number(
        plantMetaByCode[plantCode]?.schedulingCapacityMw
        || plantMetaByCode[plantCode]?.capacity
        || MAHARASHTRA_COMBINED_DAYAHEAD_CONFIG.plantColumns?.[plantCode]?.capacity
        || 0
      );
      const fallbackAvailability = schedule > 0 ? capacity : 0;
      const availability = values.availability !== null && Number.isFinite(values.availability)
        ? values.availability
        : fallbackAvailability;
      row.push(
        formatTemplateNumber(schedule),
        formatTemplateNumber(availability),
        formatTemplateNumber(schedule),
      );
    });
    rows.push(row);
  }

  const csvText = rows.map((row) => (row || []).map(csvEscapeCell).join(',')).join('\n');
  const filename = `${filenameBase || `${key}_combined_dayahead_${dateText || 'schedule'}`}.csv`;
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
  if (download) downloadBlob(blob, filename);
  return { blob, filename };
};

export const downloadCombinedDayAheadTemplate = async (options = {}) => {
  const key = String(options?.groupKey || '').trim().toUpperCase();
  if (key === 'MAHARASHTRA_OSEPL_CME') {
    return downloadMaharashtraCombinedDayAheadTemplate({
      scheduleDate: options.scheduleDate,
      plantCsvByCode: options.plantCsvByCode,
      filenameBase: options.filenameBase,
      key,
      zetricConfig: options.zetricConfig,
      download: options.download !== false,
    });
  }
  return baseDownloadCombinedDayAheadTemplate(options);
};
