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

export const convertXlsxBlobToCsvText = async (blob) => {
  const XLSX = await import('xlsx');
  const buffer = await blob.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_csv(worksheet);
};

/**
 * Build styled XLSX for MH_VEDANJAY-style (OSEPL/CME) templates.
 * Merges metadata values across columns and preserves date as string.
 */
export const downloadVedanjayMhXlsx = async (csvText, filenameBase, sheetName = 'SLDC Template') => {
  const XLSX = await import('xlsx');
  const rows = parseCsvToRows(csvText).filter((r) => r.some((c) => String(c).length > 0));
  if (!rows.length) return;
  const tableStartIdx = rows.findIndex(
    (cols) => (cols[0] || '').trim().toLowerCase() === 'block'
  );

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const headerFill = { patternType: 'solid', fgColor: { rgb: 'D9D9D9' } };
  const border = { style: 'thin', color: { rgb: 'A0A0A0' } };
  const allBorders = { top: border, bottom: border, left: border, right: border };
  const titleStyle = {
    font: { bold: true },
    alignment: { vertical: 'center', horizontal: 'left' },
  };
  const labelStyle = {
    font: { bold: true },
    alignment: { vertical: 'center', horizontal: 'left' },
    border: allBorders,
  };
  const valueStyle = {
    font: { bold: false },
    alignment: { vertical: 'center', horizontal: 'left' },
    border: allBorders,
  };
  const tableHeaderStyle = {
    font: { bold: true },
    fill: headerFill,
    alignment: { vertical: 'center', horizontal: 'center' },
    border: allBorders,
  };
  const numStyle = {
    alignment: { vertical: 'center', horizontal: 'right' },
    border: allBorders,
  };
  const blockStyle = {
    alignment: { vertical: 'center', horizontal: 'center' },
    border: allBorders,
  };

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
        if (c === 0) {
          cell.s = labelStyle;
          cell.t = 's';
        } else {
          cell.s = valueStyle;
          cell.t = 's';
        }
      }
    }
  }

  ws['!cols'] = [{ wch: 22 }, { wch: 24 }, { wch: 18 }, { wch: 18 }];
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
    alignment: { vertical: 'center', horizontal: 'left' },
    border: allBorders,
  };
  const valueStyle = {
    font: { bold: false, color: { rgb: '111827' } },
    fill: headerFill,
    alignment: { vertical: 'center', horizontal: 'left' },
    border: allBorders,
  };
  const valueRightStyle = {
    ...valueStyle,
    alignment: { vertical: 'center', horizontal: 'right' },
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
    alignment: { vertical: 'center', horizontal: 'right' },
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

  // Spacer row (row 6)
  const spacerRow = headerRows.length;

  // Contract block (rows 7-10)
  const contractStart = spacerRow + 1;
  contractRows.forEach(([label, value], idx) => {
    const r = contractStart + idx;
    setCell(r, 0, label, labelStyle);
    for (let c = 1; c <= 4; c += 1) {
      setCell(r, c, '', valueStyle);
    }
    setCell(r, 5, value, valueRightStyle);
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
