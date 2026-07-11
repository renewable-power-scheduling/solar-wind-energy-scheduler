import * as XLSX from 'xlsx';
const sldcPath = 'C:/Users/HP/Downloads/Bhupalpally_intraday_2026-03-24_Report (1).xlsx';
const uiPath = 'C:/Users/HP/Downloads/BHUPALPALLY_2026-03-28_schedule_from_29_sldc_template (1).xlsx';
const sldcWb = XLSX.readFile(sldcPath);
const uiWb = XLSX.readFile(uiPath);
const sldcSheet = sldcWb.Sheets[sldcWb.SheetNames[0]];
const uiSheet = uiWb.Sheets[uiWb.SheetNames[0]];
const sldcRows = XLSX.utils.sheet_to_json(sldcSheet, { header: 1, defval: '' });
const uiRows = XLSX.utils.sheet_to_json(uiSheet, { header: 1, defval: '' });
const maxRows = Math.max(sldcRows.length, uiRows.length);
const maxCols = Math.max(...sldcRows.map(r=>r.length), ...uiRows.map(r=>r.length));
const headerRow = (rows)=>rows.findIndex(r=>String(r[0]||'').trim().toLowerCase()==='block');
const sldcHeader = headerRow(sldcRows);
const uiHeader = headerRow(uiRows);
console.log('SLDC rows:', sldcRows.length, 'cols:', maxCols, 'headerRow:', sldcHeader+1);
console.log('UI rows:', uiRows.length, 'cols:', maxCols, 'headerRow:', uiHeader+1);
function norm(v){return String(v??'').trim();}
let diffs = [];
for(let r=0;r<Math.min(maxRows,120);r++){
  const sldc = sldcRows[r]||[]; const ui = uiRows[r]||[];
  for(let c=0;c<maxCols;c++){
    if(norm(sldc[c])!==norm(ui[c])){
      diffs.push({r:r+1,c:c+1,sldc:norm(sldc[c]),ui:norm(ui[c])});
      if(diffs.length>30) break;
    }
  }
  if(diffs.length>30) break;
}
console.log('First diffs (up to 30):');
diffs.forEach(d=>console.log('R'+d.r+'C'+d.c+": SLDC='"+d.sldc+"' UI='"+d.ui+"'"));
