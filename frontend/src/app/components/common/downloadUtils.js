export const downloadBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

export const buildCsvText = (headers, rows) => {
  const headerLine = headers.join(',');
  const rowLines = rows.map((row) => row.join(','));
  return [headerLine, ...rowLines].join('\n');
};

export const downloadCsvText = (csvText, filenameBase) => {
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, `${filenameBase}.csv`);
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
    if (ch === '\r') {
      continue;
    }
    cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
};

const TELANGANA_TEMPLATE_META = {
  BHUPALPALLY: {
    generator: 'Singareni',
    plantName: 'Singareni Collieries Company Limited-Chelpur',
    capacityMw: 10,
    contractType: 'Mtoa',
    approvalNo: 'TSTRANSCO/21/2023-24',
    toUtility: 'SCCL(BPL-003, BPL-006, BPL-028)',
  },
  KASIPET: {
    generator: 'Singareni',
    plantName: 'Singareni Collieries Company Limited-Kasipet Mines',
    capacityMw: 15,
    contractType: 'Lta',
    approvalNo: 'TSTRANSCO/20/2023-24',
    toUtility: 'SCCL(BPL-003, BPL-004, BPL-065)',
  },
  KOTHAGUDEM: {
    generator: 'Singareni',
    plantName: 'Singareni Collieries Company Limited-Sitarampatnam',
    capacityMw: 37,
    contractType: 'Lta',
    approvalNo: 'TGTRANSCO/17/2024-25',
    toUtility: 'General',
  },
};

const COMBINED_DAYAHEAD_TEMPLATE_CONFIG = {
  TELANGANA: {
    templateUrl: '/templates/telangana_combined_dayahead_template.xlsx',
    sheetName: 'Schedule',
    dateCells: ['B4', 'H4', 'N4'],
    plantColumns: {
      KASIPET: { startCol: 1, dataRow: 13, capacity: 15 },
      BHUPALPALLY: { startCol: 7, dataRow: 13, capacity: 10 },
      KOTHAGUDEM: { startCol: 13, dataRow: 13, capacity: 37 },
    },
  },
  MADHYA_PRADESH: {
    templateUrl: '/templates/mp_combined_dayahead_template.xlsx',
    sheetName: 'REG',
    dateCells: ['B2'],
    revisionCells: ['B3'],
    plantColumns: {
      SIRMOUR: { availabilityCol: 3, forecastCol: 4, dataRow: 7, capacity: 5.1 },
      ANDAD: { availabilityCol: 5, forecastCol: 6, dataRow: 7, capacity: 7.5 },
      ANJANGAON: { availabilityCol: 7, forecastCol: 8, dataRow: 7, capacity: 7.5 },
      GUGARIYAKHEDI: { availabilityCol: 9, forecastCol: 10, dataRow: 7, capacity: 7.5 },
      BALAKWADA: { availabilityCol: 11, forecastCol: 12, dataRow: 7, capacity: 7.5 },
      BAMKHAL: { availabilityCol: 13, forecastCol: 14, dataRow: 7, capacity: 5 },
      NANDGAON: { availabilityCol: 15, forecastCol: 16, dataRow: 7, capacity: 7.5 },
      SAWDA: { availabilityCol: 17, forecastCol: 18, dataRow: 7, capacity: 7.5 },
    },
  },
  ILIOS_PV: {
    templateUrl: '/templates/mp_combined_dayahead_template.xlsx',
    sheetName: 'REG',
    dateCells: ['B2'],
    revisionCells: ['B3'],
    deleteColumns: [{ startCol: 3, count: 2 }],
    plantColumns: {
      ANDAD: { availabilityCol: 3, forecastCol: 4, dataRow: 7, capacity: 7.5 },
      ANJANGAON: { availabilityCol: 5, forecastCol: 6, dataRow: 7, capacity: 7.5 },
      GUGARIYAKHEDI: { availabilityCol: 7, forecastCol: 8, dataRow: 7, capacity: 7.5 },
      BALAKWADA: { availabilityCol: 9, forecastCol: 10, dataRow: 7, capacity: 7.5 },
      BAMKHAL: { availabilityCol: 11, forecastCol: 12, dataRow: 7, capacity: 5 },
      NANDGAON: { availabilityCol: 13, forecastCol: 14, dataRow: 7, capacity: 7.5 },
      SAWDA: { availabilityCol: 15, forecastCol: 16, dataRow: 7, capacity: 7.5 },
    },
  },
  MAHARASHTRA_OSEPL_CME: {
    templateUrl: '/templates/maharashtra_osepl_cme_combined_dayahead_template.csv',
    format: 'csv',
    dateRow: 2,
    dateCol: 2,
    plantColumns: {
      OSEPL: { declaredForecastCol: 1, availabilityCol: 2, scheduleCol: 3, dataRow: 19, capacity: 20 },
      CME: { declaredForecastCol: 4, availabilityCol: 5, scheduleCol: 6, dataRow: 19, capacity: 5 },
    },
  },
};

const normalizeTelanganaPlantCode = (value) => {
  const text = String(value || '').trim().toUpperCase();
  if (text.includes('BHUPALPALLY')) return 'BHUPALPALLY';
  if (text.includes('KASIPET')) return 'KASIPET';
  if (text.includes('KOTHAGUDEM')) return 'KOTHAGUDEM';
  return text.replace(/[^A-Z0-9_-]/g, '');
};

const formatTelanganaDate = (value) => {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return String(value || '').trim();
  return `${match[3]}-${match[2]}-${match[1]}`;
};

const telanganaBlockTimestamp = (block, scheduleDate = '') => {
  const startMinutes = Math.max(0, Number(block || 1) - 1) * 15;
  const hour = Math.floor(startMinutes / 60) % 24;
  const minute = startMinutes % 60;
  const timeText = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
  return scheduleDate ? `${scheduleDate} ${timeText}` : timeText;
};

const formatDateDmyHyphen = (value) => {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return String(value || '').trim();
  return `${match[3]}-${match[2]}-${match[1]}`;
};

const escapeXmlText = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const columnNameToNumber = (columnName) => {
  const text = String(columnName || '').trim().toUpperCase();
  let total = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 65 || code > 90) return 0;
    total = (total * 26) + (code - 64);
  }
  return total;
};

const numberToColumnName = (value) => {
  let num = Number(value || 0);
  let out = '';
  while (num > 0) {
    const mod = (num - 1) % 26;
    out = String.fromCharCode(65 + mod) + out;
    num = Math.floor((num - mod) / 26);
  }
  return out;
};

const splitCellRef = (cellRef) => {
  const match = String(cellRef || '').trim().toUpperCase().match(/^([A-Z]+)(\d+)$/);
  if (!match) return null;
  return { colName: match[1], colNumber: columnNameToNumber(match[1]), rowNumber: Number(match[2]) };
};

const compareCellRefs = (a, b) => {
  const pa = splitCellRef(a);
  const pb = splitCellRef(b);
  if (!pa || !pb) return String(a).localeCompare(String(b));
  if (pa.rowNumber !== pb.rowNumber) return pa.rowNumber - pb.rowNumber;
  return pa.colNumber - pb.colNumber;
};

const xlsxCellXml = (cellRef, value) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${cellRef}"><v>${String(Number(value.toFixed(6)))}</v></c>`;
  }
  const text = String(value ?? '');
  if (!text) return `<c r="${cellRef}"/>`;
  return `<c r="${cellRef}" t="inlineStr"><is><t>${escapeXmlText(text)}</t></is></c>`;
};

const patchWorksheetCellValues = (sheetXml, cellValues) => {
  const byRef = cellValues instanceof Map ? cellValues : new Map(Object.entries(cellValues || {}));
  if (!byRef.size) return sheetXml;
  const rowMatches = [...String(sheetXml || '').matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>[\s\S]*?<\/row>/g)];
  let patchedXml = String(sheetXml || '');

  [...rowMatches].reverse().forEach((rowMatch) => {
    const rowNumber = Number(rowMatch[1]);
    const rowXml = rowMatch[0];
    const rowPrefixMatch = rowXml.match(/^<row\b[^>]*>/);
    const rowPrefix = rowPrefixMatch?.[0] || `<row r="${rowNumber}">`;
    const existingCells = new Map();
    [...rowXml.matchAll(/<c\b[^>]*\br="([A-Z]+\d+)"[^>]*(?:\/>|>[\s\S]*?<\/c>)/g)].forEach((cellMatch) => {
      existingCells.set(cellMatch[1], cellMatch[0]);
    });

    let changed = false;
    byRef.forEach((value, cellRef) => {
      const parsed = splitCellRef(cellRef);
      if (!parsed || parsed.rowNumber !== rowNumber) return;
      existingCells.set(cellRef, xlsxCellXml(cellRef, value));
      changed = true;
    });
    if (!changed) return;

    const orderedCells = [...existingCells.entries()]
      .sort(([a], [b]) => compareCellRefs(a, b))
      .map(([, xml]) => xml)
      .join('');
    const nextRowXml = `${rowPrefix}${orderedCells}</row>`;
    patchedXml = `${patchedXml.slice(0, rowMatch.index)}${nextRowXml}${patchedXml.slice(rowMatch.index + rowXml.length)}`;
  });

  return patchedXml;
};

const readWorksheetSharedStringIndex = (sheetXml, cellRef) => {
  const escapedRef = String(cellRef || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(sheetXml || '').match(new RegExp(`<c\\b[^>]*\\br="${escapedRef}"[^>]*\\bt="s"[^>]*>\\s*<v>(\\d+)<\\/v>\\s*<\\/c>`));
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isInteger(index) ? index : null;
};

const patchSharedStringValues = (sharedStringsXml, replacements) => {
  const byIndex = replacements instanceof Map ? replacements : new Map(Object.entries(replacements || {}));
  if (!byIndex.size) return sharedStringsXml;
  let idx = -1;
  return String(sharedStringsXml || '').replace(/<si>[\s\S]*?<\/si>/g, (match) => {
    idx += 1;
    if (!byIndex.has(idx)) return match;
    return `<si><t>${escapeXmlText(byIndex.get(idx))}</t></si>`;
  });
};

const normalizeTelanganaCombinedWorksheetXml = (sheetXml) => {
  let nextXml = String(sheetXml || '');
  // Match the accepted Telangana package more closely: omit these empty cells.
  ['F11', 'L11', 'R11'].forEach((cellRef) => {
    nextXml = nextXml.replace(new RegExp(`<c\\b[^>]*\\br="${cellRef}"[^>]*/>`, 'g'), '');
  });
  // Keep equivalent numeric values in the accepted lexical form.
  ['B3', 'H3', 'N3', 'F12', 'L12', 'R12'].forEach((cellRef) => {
    nextXml = nextXml.replace(
      new RegExp(`(<c\\b[^>]*\\br="${cellRef}"[^>]*>\\s*<v>)(\\d+)\\.0(<\\/v>\\s*<\\/c>)`, 'g'),
      '$1$2$3'
    );
  });
  return nextXml;
};

const downloadTelanganaCombinedDayAheadTemplatePreserveXml = async ({
  config,
  scheduleDate,
  plantCsvByCode,
  filenameBase,
  key,
}) => {
  const response = await fetch(config.templateUrl);
  if (!response.ok) throw new Error(`Failed to load combined template (${response.status})`);

  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  const sheetPath = 'xl/worksheets/sheet1.xml';
  const sheetFile = zip.file(sheetPath);
  if (!sheetFile) throw new Error('Combined template sheet XML is missing.');
  const sharedStringsPath = 'xl/sharedStrings.xml';

  const dateText = String(scheduleDate || '').trim();
  const displayDate = formatDateDmyHyphen(dateText);
  const cellValues = new Map();
  const sharedStringValues = new Map();
  const originalSheetXml = await sheetFile.async('string');
  (config.dateCells || []).forEach((cellRef) => {
    const sharedIndex = readWorksheetSharedStringIndex(originalSheetXml, cellRef);
    if (sharedIndex !== null) sharedStringValues.set(sharedIndex, displayDate);
    else cellValues.set(cellRef, displayDate);
  });

  Object.entries(config.plantColumns).forEach(([plantCode, colConfig]) => {
    const csvText = String((plantCsvByCode || {})[plantCode] || '').trim();
    const valuesByBlock = parseScheduleBlocksForCombinedTemplate(csvText);
    for (let block = 1; block <= 96; block += 1) {
      const row = colConfig.dataRow + block - 1;
      const values = valuesByBlock.get(block) || { schedule: 0, availability: null };
      const schedule = Number.isFinite(values.schedule) ? values.schedule : 0;
      const availability = values.availability !== null && Number.isFinite(values.availability)
        ? values.availability
        : (block >= 23 && block <= 76 ? Number(colConfig.capacity || 0) : 0);
      const startCol = Number(colConfig.startCol || 1);
      cellValues.set(`${numberToColumnName(startCol)}${row}`, block);
      const intervalCellRef = `${numberToColumnName(startCol + 1)}${row}`;
      const intervalSharedIndex = readWorksheetSharedStringIndex(originalSheetXml, intervalCellRef);
      if (intervalSharedIndex !== null) sharedStringValues.set(intervalSharedIndex, blockInterval(block));
      else cellValues.set(intervalCellRef, blockInterval(block));
      cellValues.set(`${numberToColumnName(startCol + 3)}${row}`, availability);
      cellValues.set(`${numberToColumnName(startCol + 4)}${row}`, schedule);
      cellValues.set(`${numberToColumnName(startCol + 5)}${row}`, schedule);
    }
  });

  const patchedSheetXml = patchWorksheetCellValues(originalSheetXml, cellValues);
  zip.file(sheetPath, normalizeTelanganaCombinedWorksheetXml(patchedSheetXml));
  const sharedStringsFile = zip.file(sharedStringsPath);
  if (sharedStringsFile && sharedStringValues.size) {
    zip.file(sharedStringsPath, patchSharedStringValues(await sharedStringsFile.async('string'), sharedStringValues));
  }
  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const filename = `${filenameBase || `${key}_combined_dayahead_${dateText || 'schedule'}`}.xlsx`;
  downloadBlob(blob, filename);
  return { blob, filename };
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
  const scheduleCol = findCol(
    ['Station Schedule', 'Schedule', 'Scheduled MW', 'Forecast', 'Forecast(MW)', 'Declared Forecast', 'MW'],
    headers.length > 4 ? 4 : 1
  );
  const availabilityCol = findCol(['Availability', 'AvC', 'Inter Avc'], headers.length > 3 ? 3 : -1);
  const dataRows = headerIndex >= 0 ? rows.slice(headerIndex + 1) : rows;
  const blocks = new Map();

  dataRows.forEach((row) => {
    const blockNumber = toFiniteNumber(row?.[blockCol]);
    if (blockNumber === null) return;
    const block = Math.trunc(blockNumber);
    if (block < 1 || block > 96) return;
    const schedule = toFiniteNumber(row?.[scheduleCol]) ?? 0;
    const availability = availabilityCol >= 0 ? toFiniteNumber(row?.[availabilityCol]) : null;
    blocks.set(block, {
      schedule,
      availability,
    });
  });

  return blocks;
};

const downloadCsvCombinedDayAheadTemplate = async ({
  config,
  scheduleDate,
  plantCsvByCode,
  filenameBase,
  key,
}) => {
  const response = await fetch(config.templateUrl);
  if (!response.ok) throw new Error(`Failed to load combined template (${response.status})`);

  const templateRows = parseCsvToRows(await response.text());
  const dateText = String(scheduleDate || '').trim();
  const displayDate = formatDateDmyHyphen(dateText);

  if (Number.isInteger(config.dateRow) && Number.isInteger(config.dateCol)) {
    templateRows[config.dateRow] = templateRows[config.dateRow] || [];
    templateRows[config.dateRow][config.dateCol] = displayDate;
  }

  Object.entries(config.plantColumns || {}).forEach(([plantCode, colConfig]) => {
    const csvText = String((plantCsvByCode || {})[plantCode] || '').trim();
    const valuesByBlock = parseScheduleBlocksForCombinedTemplate(csvText);
    for (let block = 1; block <= 96; block += 1) {
      const rowIndex = Number(colConfig.dataRow || 0) + block - 1;
      templateRows[rowIndex] = templateRows[rowIndex] || [];
      templateRows[rowIndex][0] = String(block);

      const values = valuesByBlock.get(block) || { schedule: 0, availability: null };
      const schedule = Number.isFinite(values.schedule) ? values.schedule : 0;
      const availability = values.availability !== null && Number.isFinite(values.availability)
        ? values.availability
        : (schedule > 0 ? Number(colConfig.capacity || 0) : 0);

      templateRows[rowIndex][colConfig.declaredForecastCol] = formatTemplateNumber(schedule);
      templateRows[rowIndex][colConfig.availabilityCol] = formatTemplateNumber(availability);
      templateRows[rowIndex][colConfig.scheduleCol] = formatTemplateNumber(schedule);
    }
  });

  const csvText = templateRows.map((row) => (row || []).map(csvEscapeCell).join(',')).join('\n');
  const filename = `${filenameBase || `${key}_combined_dayahead_${dateText || 'schedule'}`}.csv`;
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, filename);
  return { blob, filename };
};

export const downloadCombinedDayAheadTemplate = async ({
  groupKey,
  scheduleDate,
  plantCsvByCode,
  filenameBase,
  download = true,
} = {}) => {
  const key = String(groupKey || '').trim().toUpperCase();
  const config = COMBINED_DAYAHEAD_TEMPLATE_CONFIG[key];
  if (!config) throw new Error('Combined day-ahead group is not configured.');

  if (key === 'TELANGANA') {
    return downloadTelanganaCombinedDayAheadTemplatePreserveXml({
      config,
      scheduleDate,
      plantCsvByCode,
      filenameBase,
      key,
    });
  }
  if (config.format === 'csv') {
    return downloadCsvCombinedDayAheadTemplate({
      config,
      scheduleDate,
      plantCsvByCode,
      filenameBase,
      key,
    });
  }

  const ExcelJS = (await import('exceljs')).default;
  const response = await fetch(config.templateUrl);
  if (!response.ok) throw new Error(`Failed to load combined template (${response.status})`);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await response.arrayBuffer());
  const worksheet = workbook.getWorksheet(config.sheetName) || workbook.worksheets[0];
  if (!worksheet) throw new Error('Combined template sheet is missing.');
  (config.deleteColumns || []).forEach(({ startCol, count }) => {
    worksheet.spliceColumns(Number(startCol), Number(count));
  });

  const dateText = String(scheduleDate || '').trim();
  const displayDate = key === 'TELANGANA' ? formatDateDmyHyphen(dateText) : dateText;
  (config.dateCells || []).forEach((cellRef) => {
    worksheet.getCell(cellRef).value = displayDate;
  });
  (config.revisionCells || []).forEach((cellRef) => {
    worksheet.getCell(cellRef).value = '0';
  });

  Object.entries(config.plantColumns).forEach(([plantCode, colConfig]) => {
    const csvText = String((plantCsvByCode || {})[plantCode] || '').trim();
    const valuesByBlock = parseScheduleBlocksForCombinedTemplate(csvText);
    for (let block = 1; block <= 96; block += 1) {
      const row = colConfig.dataRow + block - 1;
      const values = valuesByBlock.get(block) || { schedule: 0, availability: null };
      const schedule = Number.isFinite(values.schedule) ? values.schedule : 0;
      const availability = values.availability !== null && Number.isFinite(values.availability)
        ? values.availability
        : (
            key === 'TELANGANA'
              ? (block >= 23 && block <= 76 ? Number(colConfig.capacity || 0) : 0)
              : (schedule > 0 ? Number(colConfig.capacity || 0) : 0)
          );

      if (key === 'TELANGANA') {
        const startCol = colConfig.startCol;
        worksheet.getCell(row, startCol).value = block;
        worksheet.getCell(row, startCol + 1).value = blockInterval(block);
        worksheet.getCell(row, startCol + 2).value = null;
        worksheet.getCell(row, startCol + 3).value = availability;
        worksheet.getCell(row, startCol + 4).value = schedule;
        worksheet.getCell(row, startCol + 5).value = schedule;
      } else {
        worksheet.getCell(row, 1).value = block;
        worksheet.getCell(row, 2).value = blockInterval(block);
        worksheet.getCell(row, colConfig.availabilityCol).value = availability;
        worksheet.getCell(row, colConfig.forecastCol).value = schedule;
      }
    }
  });

  const output = await workbook.xlsx.writeBuffer();
  const blob = new Blob([output], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const filename = `${filenameBase || `${key}_combined_dayahead_${dateText || 'schedule'}`}.xlsx`;
  if (download) downloadBlob(blob, filename);
  return { blob, filename };
};

export const normalizeVedanjayMhCsvText = (csvText) => {
  const original = String(csvText || '');
  const hadCrlf = original.includes('\r\n');
  const normalizedNewlines = original.replace(/\r\n/g, '\n');
  // Remove any blank spacer line(s) immediately before the `Capacity,...` row.
  const withoutGap = normalizedNewlines.replace(/\n\s*\n+(?=Capacity,)/g, '\n');
  return hadCrlf ? withoutGap.replace(/\n/g, '\r\n') : withoutGap;
};

const csvEscapeCell = (value) => {
  const text = String(value ?? '');
  if (text.includes('"')) return `"${text.replace(/"/g, '""')}"`;
  if (text.includes(',') || text.includes('\n') || text.includes('\r')) return `"${text}"`;
  return text;
};

const toFiniteNumber = (value) => {
  const raw = String(value ?? '').trim().replace(/,/g, '');
  if (!raw) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
};

const formatTemplateNumber = (value) => {
  const num = toFiniteNumber(value);
  if (num === null) return '0';
  if (Math.abs(num - Math.trunc(num)) < 1e-9) return String(Math.trunc(num));
  return num.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
};

const normalizeHeaderToken = (value) =>
  String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');

const extractIsoDateFromCsvRows = (rows, fallback = '') => {
  for (const row of rows) {
    for (const cell of row) {
      const match = String(cell ?? '').match(/\b(\d{4}-\d{2}-\d{2})\b/);
      if (match) return match[1];
    }
  }
  return String(fallback || '').trim();
};

const extractScheduleValuesByBlock = (rows) => {
  let headerIdx = -1;
  let bestScore = -1;
  rows.slice(0, 100).forEach((row, idx) => {
    const normalized = row.map(normalizeHeaderToken);
    const joined = normalized.join(' ');
    let score = 0;
    if (joined.includes('block')) score += 4;
    if (
      joined.includes('stationschedule') ||
      joined.includes('schedule') ||
      joined.includes('forecast') ||
      joined.includes('declaredforecast')
    ) score += 4;
    if (score > bestScore) {
      bestScore = score;
      headerIdx = idx;
    }
  });

  const header = headerIdx >= 0 ? rows[headerIdx] || [] : [];
  const normalizedHeader = header.map(normalizeHeaderToken);
  const findCol = (candidates) => {
    const normalizedCandidates = candidates.map(normalizeHeaderToken);
    for (const candidate of normalizedCandidates) {
      const idx = normalizedHeader.findIndex((value) => value === candidate || (candidate && value.includes(candidate)));
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const blockCol = Math.max(0, findCol(['Block']));
  const scheduleColRaw = findCol(['Station Schedule', 'Schedule', 'Declared Forecast', 'Forecast(MW)', 'Forecast', 'Scheduled MW', 'Scheduled']);
  const scheduleCol = scheduleColRaw >= 0 ? scheduleColRaw : (header.length > 4 ? 4 : 1);
  const values = new Map();

  rows.slice(headerIdx >= 0 ? headerIdx + 1 : 0).forEach((row) => {
    const blockNum = toFiniteNumber(row?.[blockCol]);
    if (blockNum === null) return;
    const block = Math.trunc(blockNum);
    if (block < 1 || block > 96) return;
    values.set(block, toFiniteNumber(row?.[scheduleCol]) ?? 0);
  });
  return values;
};

export const buildOseplDayAheadCsvText = (sourceCsvText, options = {}) => {
  const rows = parseCsvToRows(sourceCsvText);
  const scheduleDate = extractIsoDateFromCsvRows(rows, options.reportDate);
  const valuesByBlock = extractScheduleValuesByBlock(rows);
  const activeBlocks = Array.from(valuesByBlock.entries())
    .filter(([, value]) => Number.isFinite(value) && value > 0)
    .map(([block]) => block);
  const firstActive = activeBlocks.length ? Math.min(...activeBlocks) : null;
  const lastActive = activeBlocks.length ? Math.max(...activeBlocks) : null;
  const revision = 'DA';

  const lines = [
    [`Schedule Template for MH_VEDANJAY and revision ${revision}`],
    ['', 'Scheduling entity', 'MH_VEDANJAY'],
    ['', 'Date', scheduleDate],
    ['', 'Revision No', revision],
    [],
    ['POS Name', 'Naldurg Inter 132kV', 'Naldurg Inter 132kV', 'Naldurg Inter 132kV'],
    ['Down Stream Name', '', '', 'Naldurg Inter 132kV'],
    ['Energy Type', '', '', 'SOLAR'],
    ['Contract ID', '', '', 'CONTRACT00192'],
    ['Contract Type', '', '', 'LTA'],
    ['Exchange Type', '', '', 'NA'],
    ['Transaction Type', 'INTER', 'INTER', 'INTER'],
    ['RE Generator Name', '', '', 'Naldurg Inter 132kV'],
    ['Path', '', '', 'WR-WR'],
    ['Buyer Name', '', '', 'SOLAR_CSEB'],
    ['STU Name', '', '', 'Naldurg 132kV'],
    ['Approval Number', '', '', 'L_WR_2014_03'],
    ['Capacity', 20, 20, 20],
    ['Block', 'Declared Forecast', 'Inter Avc', 'Schedule'],
  ];

  for (let block = 1; block <= 96; block += 1) {
    const scheduleValue = valuesByBlock.get(block) ?? 0;
    const interAvc = firstActive !== null && lastActive !== null && block >= firstActive && block <= lastActive ? 20 : 0;
    lines.push([
      block,
      formatTemplateNumber(scheduleValue),
      formatTemplateNumber(interAvc),
      formatTemplateNumber(scheduleValue),
    ]);
  }

  return lines.map((row) => row.map(csvEscapeCell).join(',')).join('\n');
};

export const downloadXlsxFromCsvText = async (
  csvText,
  filenameBase,
  sheetName = 'Sheet1',
  options = {}
) => {
  const XLSX = await import('xlsx');
  let workbook;
  if (options.forceString) {
    const rows = parseCsvToRows(csvText);
    const ws = XLSX.utils.aoa_to_sheet(rows, { raw: true });
    workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, ws, sheetName);
  } else {
    workbook = XLSX.read(csvText, { type: 'string' });
    if (!workbook.SheetNames.includes(sheetName)) {
      const firstSheetName = workbook.SheetNames[0];
      workbook.SheetNames = [sheetName];
      workbook.Sheets[sheetName] = workbook.Sheets[firstSheetName];
    }
  }
  const out = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([out], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  downloadBlob(blob, `${filenameBase}.xlsx`);
};

export const downloadXlsxFromRows = async (headers, rows, filenameBase, sheetName = 'Sheet1') => {
  const XLSX = await import('xlsx');
  const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  const out = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([out], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  downloadBlob(blob, `${filenameBase}.xlsx`);
};

export const downloadXlsxFromSheets = async (sheets, filenameBase) => {
  const XLSX = await import('xlsx');
  const workbook = XLSX.utils.book_new();

  (Array.isArray(sheets) ? sheets : []).forEach((sheet, idx) => {
    const safeNameRaw = String(sheet?.name || `Sheet${idx + 1}`);
    const safeName = safeNameRaw.length > 31 ? safeNameRaw.slice(0, 31) : safeNameRaw;
    const aoa = Array.isArray(sheet?.aoa)
      ? sheet.aoa
      : [sheet?.headers || [], ...(sheet?.rows || [])];
    const worksheet = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(workbook, worksheet, safeName || `Sheet${idx + 1}`);
  });

  const out = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([out], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  downloadBlob(blob, `${filenameBase}.xlsx`);
};

export const convertXlsxBlobToCsvText = async (blob) => {
  const XLSX = await import('xlsx');
  const buffer = await blob.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_csv(worksheet);
};

export const downloadGsnpSirmourXlsx = async (csvText, filenameBase, sheetName = 'SLDC Template') => {
  const ExcelJS = (await import('exceljs')).default;
  const rows = parseCsvToRows(csvText);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);

  const findRowIndex = (predicate) => rows.findIndex((row) => row.some((c) => predicate(String(c || ''))));
  const availabilityHeaderRow = findRowIndex((v) => v.toLowerCase().includes('availability'));
  const forecastHeaderRow = availabilityHeaderRow >= 0 ? availabilityHeaderRow : findRowIndex((v) => v.toLowerCase().includes('forecast'));
  const headerRow = availabilityHeaderRow >= 0 ? availabilityHeaderRow : forecastHeaderRow;

  let availabilityCol = -1;
  let forecastCol = -1;
  if (headerRow >= 0) {
    const hdr = rows[headerRow].map((c) => String(c || '').toLowerCase().trim());
    availabilityCol = hdr.findIndex((c) => c.includes('availability'));
    forecastCol = hdr.findIndex((c) => c.includes('forecast'));
  }
  const dataStart = headerRow >= 0 ? headerRow + 1 : 0;

  const isNumericValue = (value) => {
    const text = String(value ?? '').trim();
    if (!text) return false;
    return !Number.isNaN(Number(text));
  };

  rows.forEach((row, rIdx) => {
    const isRevisionRow = String(row?.[0] ?? '').trim().toLowerCase().includes('revision');
    row.forEach((val, cIdx) => {
      const cell = ws.getCell(rIdx + 1, cIdx + 1);
      if (isNumericValue(val)) {
        cell.value = Number(val);
      } else {
        cell.value = val;
      }
      cell.font = { ...(cell.font || {}), size: 11, bold: false, italic: false, strike: false };
      if (isRevisionRow && cIdx === 1) {
        cell.alignment = { ...(cell.alignment || {}), horizontal: 'left', vertical: 'center' };
      }
      if (rIdx >= dataStart && (cIdx === availabilityCol || cIdx === forecastCol)) {
        cell.alignment = { ...(cell.alignment || {}), horizontal: 'right', vertical: 'center' };
      }
    });
  });

  const out = await wb.xlsx.writeBuffer();
  const blob = new Blob([out], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  downloadBlob(blob, `${filenameBase}.xlsx`);
};

export const generateGsnpSirmourXlsxBuffer = async (csvText, sheetName = 'SLDC Template') => {
  const ExcelJS = (await import('exceljs')).default;
  const rows = parseCsvToRows(csvText);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);

  const findRowIndex = (predicate) => rows.findIndex((row) => row.some((c) => predicate(String(c || ''))));
  const availabilityHeaderRow = findRowIndex((v) => v.toLowerCase().includes('availability'));
  const forecastHeaderRow = availabilityHeaderRow >= 0 ? availabilityHeaderRow : findRowIndex((v) => v.toLowerCase().includes('forecast'));
  const headerRow = availabilityHeaderRow >= 0 ? availabilityHeaderRow : forecastHeaderRow;

  let availabilityCol = -1;
  let forecastCol = -1;
  if (headerRow >= 0) {
    const hdr = rows[headerRow].map((c) => String(c || '').toLowerCase().trim());
    availabilityCol = hdr.findIndex((c) => c.includes('availability'));
    forecastCol = hdr.findIndex((c) => c.includes('forecast'));
  }
  const dataStart = headerRow >= 0 ? headerRow + 1 : 0;

  const isNumericValue = (value) => {
    const text = String(value ?? '').trim();
    if (!text) return false;
    return !Number.isNaN(Number(text));
  };

  rows.forEach((row, rIdx) => {
    const isRevisionRow = String(row?.[0] ?? '').trim().toLowerCase().includes('revision');
    row.forEach((val, cIdx) => {
      const cell = ws.getCell(rIdx + 1, cIdx + 1);
      if (isNumericValue(val)) {
        cell.value = Number(val);
      } else {
        cell.value = val;
      }
      cell.font = { ...(cell.font || {}), size: 11, bold: false, italic: false, strike: false };
      if (isRevisionRow && cIdx === 1) {
        cell.alignment = { ...(cell.alignment || {}), horizontal: 'left', vertical: 'center' };
      }
      if (rIdx >= dataStart && (cIdx === availabilityCol || cIdx === forecastCol)) {
        cell.alignment = { ...(cell.alignment || {}), horizontal: 'right', vertical: 'center' };
      }
    });
  });

  return wb.xlsx.writeBuffer();
};

export const downloadTelanganaTemplateFromBaseXlsx = async (
  csvText,
  filenameBase,
  sheetName = 'SLDC Template',
  templateUrl = '/templates/telangana_sldc_template.xlsx'
) => {
  const ExcelJS = (await import('exceljs')).default;
  const response = await fetch(templateUrl);
  if (!response.ok) throw new Error(`Failed to load template (${response.status})`);
  const buffer = await response.arrayBuffer();

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const ws = workbook.worksheets[0];
  ws.name = sheetName;

  const rows = parseCsvToRows(csvText);
  const get = (r, c) => (rows[r] && rows[r][c] !== undefined ? rows[r][c] : '');

  const isDayAhead = (() => {
    const typeText = String(get(4, 1) || '').trim().toLowerCase();
    return (
      typeText === 'dayahead' ||
      typeText === 'day_ahead' ||
      typeText.includes('day-ahead') ||
      (typeText.includes('day') && typeText.includes('ahead'))
    );
  })();

  const setTextValue = (r, c, v) => {
    ws.getCell(r, c).value = v === '' ? '' : v;
  };

  const setNumberValue = (r, c, v, numFmt = null, options = {}) => {
    const cell = ws.getCell(r, c);
    const raw = String(v ?? '').trim();
    const blankIfEmpty = options.blankIfEmpty === true;

    if (!raw && blankIfEmpty) {
      cell.value = null;
      if (numFmt) cell.numFmt = numFmt;
      return;
    }

    const n = Number(raw);
    cell.value = Number.isFinite(n) ? n : (blankIfEmpty ? null : 0);
    if (numFmt) cell.numFmt = numFmt;
  };

  const normalizeCellStyle = (cell, r, c) => {
    const font = cell.font || {};
    cell.font = {
      ...font,
      italic: false,
      strike: false,
      bold: r === 12 && c !== 6, // Only column header row (except last column)
    };
    cell.alignment = {
      ...(cell.alignment || {}),
      horizontal: 'center',
      vertical: 'center',
      wrapText: false,
    };
  };

  // Normalize styles across template range (A1:F108)
  for (let r = 1; r <= 108; r += 1) {
    for (let c = 1; c <= 6; c += 1) {
      normalizeCellStyle(ws.getCell(r, c), r, c);
    }
  }

  // For Telangana Day-ahead, prefer Excel's "General" formatting so integers render as `10` / `0`
  // (not `10.` / `0.`) while still showing decimals when present.
  const capacityFmt = isDayAhead ? 'General' : '0.0';
  const mwFmt = isDayAhead ? 'General' : '0.00';

  // Header values (B1..B5)
  setTextValue(1, 2, get(0, 1));
  setTextValue(2, 2, get(1, 1));
  setNumberValue(3, 2, get(2, 1), capacityFmt);
  setTextValue(4, 2, get(3, 1));
  setTextValue(5, 2, get(4, 1));

  // Contract block values (F8..F11)
  setTextValue(8, 6, get(7, 5));
  setTextValue(9, 6, get(8, 5));
  setTextValue(10, 6, get(9, 5));
  setTextValue(11, 6, get(10, 5));

  // Header last column (F12)
  setNumberValue(12, 6, get(11, 5), capacityFmt);

  // Data rows (A13..F108)
  for (let i = 12; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    const excelRow = i + 1; // Excel is 1-based
    setNumberValue(excelRow, 1, row[0], '0'); // Block
    setTextValue(excelRow, 2, row[1]); // Time Period
    // Forecast is intentionally blank for Telangana SLDC (esp. day-ahead).
    setNumberValue(excelRow, 3, row[2], mwFmt, { blankIfEmpty: isDayAhead }); // Forecast
    setNumberValue(excelRow, 4, row[3], mwFmt); // AvC
    setNumberValue(excelRow, 5, row[4], mwFmt); // Station Schedule
    setNumberValue(excelRow, 6, isDayAhead ? row[4] : row[5], mwFmt); // Capacity/helper
  }

  const out = await workbook.xlsx.writeBuffer();
  const blob = new Blob([out], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  downloadBlob(blob, `${filenameBase}.xlsx`);
};

export const generateTelanganaTemplateFromBaseXlsxBuffer = async (
  csvText,
  sheetName = 'SLDC Template',
  templateUrl = '/templates/telangana_sldc_template.xlsx',
  options = {}
) => {
  const ExcelJS = (await import('exceljs')).default;
  const response = await fetch(templateUrl);
  if (!response.ok) throw new Error(`Failed to load template (${response.status})`);
  const buffer = await response.arrayBuffer();

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const ws = workbook.worksheets[0];
  ws.name = sheetName;

  const rows = parseCsvToRows(csvText);
  const get = (r, c) => (rows[r] && rows[r][c] !== undefined ? rows[r][c] : '');

  const isDayAhead = (() => {
    const typeText = String(get(4, 1) || '').trim().toLowerCase();
    return (
      typeText === 'dayahead' ||
      typeText === 'day_ahead' ||
      typeText.includes('day-ahead') ||
      (typeText.includes('day') && typeText.includes('ahead'))
    );
  })();

  const setTextValue = (r, c, v) => {
    ws.getCell(r, c).value = v === '' ? '' : v;
  };

  const setNumberValue = (r, c, v, numFmt = null, options = {}) => {
    const cell = ws.getCell(r, c);
    const raw = String(v ?? '').trim();
    const blankIfEmpty = options.blankIfEmpty === true;

    if (!raw && blankIfEmpty) {
      cell.value = null;
      if (numFmt) cell.numFmt = numFmt;
      return;
    }

    const n = Number(raw);
    cell.value = Number.isFinite(n) ? n : (blankIfEmpty ? null : 0);
    if (numFmt) cell.numFmt = numFmt;
  };

  const normalizeCellStyle = (cell, r, c) => {
    const font = cell.font || {};
    cell.font = {
      ...font,
      italic: false,
      strike: false,
      bold: r === 12 && c !== 6,
    };
    cell.alignment = {
      ...(cell.alignment || {}),
      horizontal: 'center',
      vertical: 'center',
      wrapText: false,
    };
  };

  for (let r = 1; r <= 108; r += 1) {
    for (let c = 1; c <= 6; c += 1) {
      normalizeCellStyle(ws.getCell(r, c), r, c);
    }
  }

  const revisionLabelRow = 6;
  const revisionValueRow = 7;
  const dateRow = 5;
  const projectRow = 3;
  const scheduleTypeRow = 5;

  const scheduleType = isDayAhead ? 'DAYAHEAD' : 'INTRADAY';
  const projectName = String(get(2, 1) || '').trim() || 'PLANT';
  const dateValue = String(get(3, 1) || '').trim() || '';
  const resolveDayAheadRevision = () => {
    const selector = `${options?.templateId || ''} ${options?.scheduleType || ''}`.toLowerCase();
    if (/(^|[_\s-])da0($|[_\s-])/.test(selector)) return 0;
    if (/(^|[_\s-])da1($|[_\s-])/.test(selector)) return 1;
    return null;
  };
  const dayAheadRevision = isDayAhead ? resolveDayAheadRevision() : null;
  const sourceText = `${options?.sourceKey || ''} ${options?.fileName || ''}`.toLowerCase();
  const isDayAheadManualSource = dayAheadRevision !== null && (sourceText.includes('manual-edits/') || sourceText.includes('edited_schedule'));
  const isDa1TelanganaSource = dayAheadRevision === 1;
  const revisionValue = dayAheadRevision !== null ? String(dayAheadRevision) : (String(get(6, 1) || '').trim() || '');

  const manualValuesByBlock = (() => {
    if (!isDayAheadManualSource) return new Map();
    const normalizeHeader = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    const headerIndex = rows.findIndex((row) => {
      const normalized = row.map(normalizeHeader);
      return normalized.includes('block') && normalized.some((item) => ['mw', 'stationschedule', 'schedule', 'scheduledmw', 'forecast'].includes(item));
    });
    const header = headerIndex >= 0 ? rows[headerIndex].map(normalizeHeader) : [];
    const blockCol = header.includes('block') ? header.indexOf('block') : 0;
    let valueCol = header.findIndex((item) => ['mw', 'stationschedule', 'schedule', 'scheduledmw', 'forecast'].includes(item));
    if (valueCol < 0) valueCol = 1;
    const dataRows = headerIndex >= 0 ? rows.slice(headerIndex + 1) : rows;
    const values = new Map();
    dataRows.forEach((row) => {
      const block = Number(row?.[blockCol]);
      const value = row?.[valueCol];
      const num = Number(String(value ?? '').trim());
      if (Number.isFinite(block) && block >= 1 && block <= 96 && Number.isFinite(num)) {
        values.set(Math.trunc(block), value);
      }
    });
    return values;
  })();

  setTextValue(projectRow, 2, projectName);
  setTextValue(scheduleTypeRow, 2, scheduleType);
  setTextValue(dateRow, 2, dateValue);
  if (dayAheadRevision !== null) {
    setNumberValue(revisionLabelRow, 2, revisionValue, 'General');
  } else {
    setTextValue(revisionLabelRow, 2, 'Revision');
    setTextValue(revisionValueRow, 2, revisionValue);
  }

  // Data table starts at row 13, columns: A block, B time, C availability, D schedule/forecast, etc.
  // We keep existing template structure but populate numeric columns from csv where possible.
  const findRowIndex = (predicate) => rows.findIndex((row) => row.some((c) => predicate(String(c || ''))));
  const availabilityHeaderRow = findRowIndex((v) => v.toLowerCase().includes('availability'));
  const forecastHeaderRow = availabilityHeaderRow >= 0 ? availabilityHeaderRow : findRowIndex((v) => v.toLowerCase().includes('forecast'));
  const headerRow = availabilityHeaderRow >= 0 ? availabilityHeaderRow : forecastHeaderRow;
  let availabilityCol = -1;
  let forecastCol = -1;
  let blockCol = -1;
  let timeCol = -1;
  if (headerRow >= 0) {
    const hdr = rows[headerRow].map((c) => String(c || '').toLowerCase().trim());
    availabilityCol = hdr.findIndex((c) => c.includes('availability'));
    forecastCol = hdr.findIndex((c) => c.includes('forecast') || c.includes('schedule'));
    blockCol = hdr.findIndex((c) => c.includes('block') || c.includes('blk') || c.includes('sr') || c.includes('sno'));
    timeCol = hdr.findIndex((c) => c.includes('time') || c.includes('from') || c.includes('to'));
  }
  const dataStart = headerRow >= 0 ? headerRow + 1 : 0;
  const standardTelanganaHeader = headerRow >= 0 ? rows[headerRow].map((c) => String(c || '').toLowerCase().trim()) : [];
  const stationScheduleCol = standardTelanganaHeader.findIndex((c) => c.includes('station') && c.includes('schedule'));
  const avcCol = standardTelanganaHeader.findIndex((c) => c.includes('avc'));
  const isStandardTelanganaSldc =
    isDayAhead &&
    blockCol >= 0 &&
    timeCol >= 0 &&
    stationScheduleCol >= 0 &&
    avcCol >= 0;

  if (isStandardTelanganaSldc) {
    const capacityFmt = 'General';
    const mwFmt = 'General';

    setTextValue(1, 2, get(0, 1));
    setTextValue(2, 2, get(1, 1));
    setNumberValue(3, 2, get(2, 1), capacityFmt);
    setTextValue(4, 2, get(3, 1));
    setTextValue(5, 2, get(4, 1));
    setTextValue(8, 6, get(7, 5));
    setTextValue(9, 6, get(8, 5));
    setTextValue(10, 6, get(9, 5));
    setTextValue(11, 6, get(10, 5));
    setNumberValue(12, 6, get(headerRow, 5), capacityFmt);

    for (let i = 0; i < 96; i += 1) {
      const srcRow = rows[dataStart + i] || [];
      const targetRow = 13 + i;
      const stationSchedule = srcRow[stationScheduleCol];
      const forecastValue = isDayAheadManualSource ? stationSchedule : (isDa1TelanganaSource ? '' : srcRow[forecastCol]);
      setNumberValue(targetRow, 1, srcRow[blockCol] || String(i + 1), '0');
      setTextValue(targetRow, 2, srcRow[timeCol] || '');
      setNumberValue(targetRow, 3, forecastValue, mwFmt, { blankIfEmpty: true });
      setNumberValue(targetRow, 4, srcRow[avcCol], mwFmt);
      setNumberValue(targetRow, 5, stationSchedule, mwFmt);
      setNumberValue(targetRow, 6, stationSchedule, mwFmt);
    }

    return workbook.xlsx.writeBuffer();
  }

  if (isDayAheadManualSource && manualValuesByBlock.size > 0) {
    const plantCode = normalizeTelanganaPlantCode(options?.plantCode || sheetName);
    const meta = TELANGANA_TEMPLATE_META[plantCode] || {};
    const scheduleDate = String(options?.scheduleDate || '').trim();
    const displayDate = formatTelanganaDate(scheduleDate);
    const capacity = meta.capacityMw || '';

    setTextValue(1, 2, meta.generator || get(0, 1));
    setTextValue(2, 2, meta.plantName || get(1, 1));
    setNumberValue(3, 2, capacity || get(2, 1), 'General');
    setTextValue(4, 2, displayDate || get(3, 1));
    setTextValue(5, 2, 'dayahead');
    setNumberValue(6, 2, revisionValue, 'General');
    setTextValue(8, 6, meta.contractType || get(7, 5));
    setTextValue(9, 6, meta.approvalNo || get(8, 5));
    setTextValue(10, 6, meta.toUtility || get(9, 5));
    setNumberValue(12, 6, capacity || get(11, 5), 'General');

    for (let i = 0; i < 96; i += 1) {
      const block = i + 1;
      const targetRow = 13 + i;
      const value = manualValuesByBlock.get(block) ?? '';
      setNumberValue(targetRow, 1, String(block), '0');
      setTextValue(targetRow, 2, telanganaBlockTimestamp(block, scheduleDate));
      setNumberValue(targetRow, 3, value, 'General', { blankIfEmpty: true });
      setNumberValue(targetRow, 4, capacity, 'General', { blankIfEmpty: true });
      setNumberValue(targetRow, 5, value, 'General', { blankIfEmpty: true });
      setNumberValue(targetRow, 6, value, 'General', { blankIfEmpty: true });
    }

    return workbook.xlsx.writeBuffer();
  }

  for (let i = 0; i < 96; i += 1) {
    const srcRow = rows[dataStart + i] || [];
    const block = blockCol !== -1 ? srcRow[blockCol] : String(i + 1);
    const time = timeCol !== -1 ? srcRow[timeCol] : '';
    const availability = availabilityCol !== -1 ? srcRow[availabilityCol] : '';
    const forecast = forecastCol !== -1 ? srcRow[forecastCol] : '';

    const targetRow = 13 + i;
    setNumberValue(targetRow, 1, block, '0');
    setTextValue(targetRow, 2, time);
    setNumberValue(targetRow, 3, availability, '0.00', { blankIfEmpty: true });
    setNumberValue(targetRow, 4, forecast, '0.000', { blankIfEmpty: true });
  }

  return workbook.xlsx.writeBuffer();
};

/**
 * Build styled XLSX for MH_VEDANJAY-style (OSEPL/CME) templates.
 * Merges metadata values across columns and preserves date as string.
 */
export const downloadVedanjayMhXlsx = async (csvText, filenameBase, sheetName = 'SLDC Template') => {
  const XLSX = await import('xlsx');
  // Preserve source CSV row order by not filtering empties.
  const rows = parseCsvToRows(normalizeVedanjayMhCsvText(csvText));
  // Remove any accidental blank spacer row immediately before the Capacity row.
  const capacityIdx = rows.findIndex(
    (r) => String(r?.[0] || r?.[1] || '').trim().toLowerCase() === 'capacity'
  );
  if (capacityIdx > 0) {
    let idx = capacityIdx;
    while (idx > 0) {
      const prev = rows[idx - 1] || [];
      const prevHasData = prev.some((c) => String(c || '').trim().length > 0);
      if (prevHasData) break;
      rows.splice(idx - 1, 1);
      idx -= 1;
    }
  }
  // Do NOT force an extra spacer after the Revision row; only rely on source CSV.
  if (!rows.length) return;
  const tableStartIdx = rows.findIndex(
    (cols) => (cols[0] || '').trim().toLowerCase() === 'block'
  );
  const maxCols = Math.max(4, ...rows.map((row) => (Array.isArray(row) ? row.length : 0)));

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const headerFill = { patternType: 'solid', fgColor: { rgb: 'D9D9D9' } };
  const border = { style: 'thin', color: { rgb: 'A0A0A0' } };
  const allBorders = { top: border, bottom: border, left: border, right: border };
  const titleStyle = {
    font: { bold: true, name: 'Calibri', sz: 11 },
    alignment: { vertical: 'center', horizontal: 'center' },
  };
  const labelStyle = {
    font: { bold: true, name: 'Calibri', sz: 11 },
    alignment: { vertical: 'center', horizontal: 'left' },
    border: allBorders,
  };
  const valueStyle = {
    font: { bold: false, name: 'Calibri', sz: 11 },
    alignment: { vertical: 'center', horizontal: 'center' },
    border: allBorders,
  };
  const tableHeaderStyle = {
    font: { bold: true, name: 'Calibri', sz: 11 },
    fill: headerFill,
    alignment: { vertical: 'center', horizontal: 'center' },
    border: allBorders,
  };
  const numStyle = {
    font: { name: 'Calibri', sz: 11 },
    alignment: { vertical: 'center', horizontal: 'center' },
    border: allBorders,
  };
  const capacityStyle = {
    font: { name: 'Calibri', sz: 11 },
    alignment: { vertical: 'center', horizontal: 'right' },
    border: allBorders,
  };
  const dateStyle = {
    font: { name: 'Calibri', sz: 11 },
    alignment: { vertical: 'center', horizontal: 'right' },
    border: allBorders,
  };
  const blockStyle = {
    font: { name: 'Calibri', sz: 11 },
    alignment: { vertical: 'center', horizontal: 'center' },
    border: allBorders,
  };

  // Merge title row across the full template width.
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: maxCols - 1 } }];

  const totalRows = rows.length;
  for (let r = 0; r < totalRows; r += 1) {
    const cols = rows[r];
    for (let c = 0; c < cols.length; c += 1) {
      const ref = XLSX.utils.encode_cell({ r, c });
      const cell = ws[ref];
      if (!cell) continue;

      if (r === 0) {
        cell.s = titleStyle;
        cell.t = 's';
      } else if (tableStartIdx >= 0 && r === tableStartIdx) {
        cell.s = tableHeaderStyle;
        cell.t = 's';
      } else if (tableStartIdx >= 0 && r > tableStartIdx) {
        if (c === 0) {
          cell.s = blockStyle;
          cell.t = 'n';
        } else {
          cell.s = numStyle;
          cell.t = 'n';
        }
      } else {
        const isCapacityRow = String(rows[r]?.[0] || rows[r]?.[1] || '').trim().toLowerCase() === 'capacity';
        const isDateRow = String(rows[r]?.[1] || '').trim().toLowerCase() === 'date';
        if (c === 0) {
          cell.s = labelStyle;
          cell.t = 's';
        } else if (isCapacityRow) {
          cell.s = capacityStyle;
          cell.t = 'n';
        } else if (isDateRow && c >= 2) {
          cell.s = dateStyle;
          cell.t = 's';
        } else {
          cell.s = valueStyle;
          cell.t = 's';
        }
      }
    }
  }

  // Consistent column widths: A wider for labels, remaining columns equal.
  ws['!cols'] = Array.from({ length: maxCols }, (_, idx) => ({ wch: idx === 0 ? 28 : 22 }));
  // Slightly taller rows for readability.
  ws['!rows'] = Array.from({ length: totalRows }, () => ({ hpt: 20 }));
  ws['!ref'] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: totalRows - 1, c: maxCols - 1 },
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array', cellStyles: true });
  const blob = new Blob([out], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  downloadBlob(blob, `${filenameBase}.xlsx`);
};

/**
 * Build a styled XLSX that matches the Telangana SLDC (Vedanjay-style) template.
 * Applies header blocks, contract block, column widths, borders, fills, and alignment.
 */
export const downloadTelanganaTemplateXlsx = async (csvText, filenameBase, sheetName = 'Template') => {
  const XLSX = await import('xlsx');

  const workbook = XLSX.read(String(csvText || ''), { type: 'string' });
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
  const safeRow = (idx) => (rows[idx] ? rows[idx] : []);
  const headerRows = [
    ['Name of Generator', safeRow(0)[1] || ''],
    ['Plant name', safeRow(1)[1] || ''],
    ['Capacity(MW)', safeRow(2)[1] || ''],
    ['Date', safeRow(3)[1] || ''],
    ['Type', safeRow(4)[1] || ''],
  ];
  const contractRows = [
    ['Contract Type', safeRow(7)[5] || ''],
    ['Approval No', safeRow(8)[5] || ''],
    ['To Utility', safeRow(9)[5] || ''],
    ['Path', safeRow(10)[1] || ''],
  ];

  const tableHeaderIndex = rows.findIndex(
    (cols) => String(cols?.[0] || '').trim().toLowerCase() === 'block'
      && String(cols?.[1] || '').trim().toLowerCase() === 'time period'
  );
  const dataRows = tableHeaderIndex >= 0
    ? rows.slice(tableHeaderIndex + 1).filter((cols) => cols.some((c) => String(c).trim().length > 0))
    : [];

  const ws = {};
  const merges = [];

  // Colors tuned to Vedanjay reference
  const headerFill = { patternType: 'solid', fgColor: { rgb: 'B7C7E6' }, bgColor: { indexed: 64 } };
  const tableHeaderFill = { patternType: 'solid', fgColor: { rgb: '9FB5D8' }, bgColor: { indexed: 64 } };
  const border = { style: 'thin', color: { rgb: '9CA3AF' } };
  const allBorders = { top: border, bottom: border, left: border, right: border };
  const labelStyle = {
    font: { bold: true, color: { rgb: '0F172A' } },
    fill: headerFill,
    alignment: { vertical: 'center', horizontal: 'center' },
    border: allBorders,
  };
  const valueStyle = {
    font: { bold: false, color: { rgb: '111827' } },
    fill: headerFill,
    alignment: { vertical: 'center', horizontal: 'center' },
    border: allBorders,
  };
  const spacerStyle = {
    font: { bold: false, color: { rgb: '111827' } },
    alignment: { vertical: 'center', horizontal: 'center' },
    border: allBorders,
  };
  const contractValueStyle = {
    font: { bold: false, color: { rgb: '111827' } },
    alignment: { vertical: 'center', horizontal: 'center' },
    border: allBorders,
  };
  const tableHeaderStyle = {
    font: { bold: true, color: { rgb: '0F172A' } },
    fill: tableHeaderFill,
    alignment: { vertical: 'center', horizontal: 'center' },
    border: allBorders,
  };
  const blockStyle = {
    font: { bold: false, color: { rgb: '111827' } },
    alignment: { vertical: 'center', horizontal: 'center' },
    border: allBorders,
  };
  const timeStyle = { ...blockStyle };
  const numericStyle = {
    font: { bold: false, color: { rgb: '111827' } },
    alignment: { vertical: 'center', horizontal: 'center' },
    border: allBorders,
  };

  const setCell = (r, c, v, s) => {
    const ref = XLSX.utils.encode_cell({ r, c });
    const isNumber = typeof v === 'number' && Number.isFinite(v);
    ws[ref] = { v: isNumber ? v : v ?? '', t: isNumber ? 'n' : 's', s };
  };

  // Header block (rows 1-5)
  headerRows.forEach(([label, value], idx) => {
    const r = idx;
    setCell(r, 0, label, labelStyle);
    setCell(r, 1, value, valueStyle);
    for (let c = 2; c <= 5; c += 1) {
      setCell(r, c, '', valueStyle);
    }
    merges.push({ s: { r, c: 1 }, e: { r, c: 5 } });
  });

  // Spacer rows (rows 6-7)
  const spacerRow = headerRows.length;
  const spacerRow2 = spacerRow + 1;

  // Contract block (rows 7-10)
  const contractStart = spacerRow2 + 1;
  // Spacer rows with borders (keep blank but bordered)
  [spacerRow, spacerRow2].forEach((r) => {
    for (let c = 0; c <= 5; c += 1) {
      setCell(r, c, '', spacerStyle);
    }
  });
  contractRows.forEach(([label, value], idx) => {
    const r = contractStart + idx;
    setCell(r, 0, label, labelStyle);
    for (let c = 1; c <= 4; c += 1) {
      setCell(r, c, '', valueStyle);
    }
    setCell(r, 5, value, contractValueStyle);
    merges.push({ s: { r, c: 1 }, e: { r, c: 4 } });
  });

  // Spacer before table
  const tableHeaderRow = contractStart + contractRows.length + 1;

  // Table header
  const headers = ['Block', 'Time Period', 'Forecast(MW)', 'AvC(MW)', 'Station Schedule', safeRow(2)[1] || ''];
  headers.forEach((val, idx) => setCell(tableHeaderRow, idx, val, tableHeaderStyle));

  // Data rows
  const dataStart = tableHeaderRow + 1;
  dataRows.forEach((cols, rowIdx) => {
    const r = dataStart + rowIdx;
    const [block, time, forecast, avc, station, capacity] = cols;
    setCell(r, 0, block || '', blockStyle);
    setCell(r, 1, time || '', timeStyle);
    setCell(r, 2, forecast === '' ? '' : Number(forecast), numericStyle);
    setCell(r, 3, avc === '' ? '' : Number(avc), numericStyle);
    setCell(r, 4, station === '' ? '' : Number(station), numericStyle);
    setCell(r, 5, capacity === '' ? '' : Number(capacity), numericStyle);
  });

  ws['!merges'] = merges;
  ws['!cols'] = [
    { wch: 6 }, // Block
    { wch: 16 }, // Time
    { wch: 14 }, // Forecast
    { wch: 14 }, // AvC
    { wch: 16 }, // Station Schedule
    { wch: 10 }, // Capacity/helper column
  ];
  ws['!rows'] = [
    { hpt: 24 },
    { hpt: 24 },
    { hpt: 24 },
    { hpt: 24 },
    { hpt: 24 },
    { hpt: 10 },
    { hpt: 10 },
    { hpt: 22 },
    { hpt: 22 },
    { hpt: 22 },
    { hpt: 22 },
    { hpt: 12 },
    { hpt: 24 },
  ];

  // Define sheet range so Excel renders cells
  const lastRow = Math.max(tableHeaderRow, dataStart + dataRows.length - 1);
  const lastCol = 5;
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow, c: lastCol } });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array', cellStyles: true });
  const blob = new Blob([out], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  downloadBlob(blob, `${filenameBase}.xlsx`);
};
