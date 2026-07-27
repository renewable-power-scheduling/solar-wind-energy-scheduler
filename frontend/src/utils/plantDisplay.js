export function toPlantDisplayName(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (/^ZETRIC\s+SOLAR\s+PARK$/i.test(text)) return 'ZETRIC';
  if (/^ZTRIC$/i.test(text)) return 'ZETRIC';
  // UI should show "OSEL" but backend/S3 code is "OSEPL".
  // Replace standalone token so it works in headings like "OSEPL - 2026-05-03".
  return text
    .replace(/\bZETRIC\s+SOLAR\s+PARK\b/gi, 'ZETRIC')
    .replace(/\bZTRIC\b/gi, 'ZETRIC')
    .replace(/\bOSEPL\b/gi, 'OSEL');
}

// Back-compat alias (older components import this name)
export const displayPlantName = toPlantDisplayName;
