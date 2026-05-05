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

export const normalizeVedanjayMhCsvText = (csvText) => {
  const original = String(csvText || '');
  const hadCrlf = original.includes('\r\n');
  const normalizedNewlines = original.replace(/\r\n/g, '\n');
  // Remove any blank spacer line(s) immediately before the `Capacity,...` row.
  const withoutGap = normalizedNewlines.replace(/\n\s*\n+(?=Capacity,)/g, '\n');
  return hadCrlf ? withoutGap.replace(/\n/g, '\r\n') : withoutGap;
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
    setNumberValue(excelRow, 6, row[5], mwFmt); // Capacity/helper
  }

  const out = await workbook.xlsx.writeBuffer();
  const blob = new Blob([out], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  downloadBlob(blob, `${filenameBase}.xlsx`);
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

  // Merge title row across all four columns (A1:D1) for visual parity with Vedanjay.
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }];

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

  // Consistent column widths: A wider for labels, B-D equal.
  ws['!cols'] = [{ wch: 28 }, { wch: 22 }, { wch: 22 }, { wch: 22 }];
  // Slightly taller rows for readability.
  ws['!rows'] = Array.from({ length: totalRows }, () => ({ hpt: 20 }));
  ws['!ref'] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: totalRows - 1, c: 3 },
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
