export function toPlantDisplayName(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  // UI should show "OSEL" but backend/S3 code is "OSEPL".
  // Replace standalone token so it works in headings like "OSEPL - 2026-05-03".
  return text.replace(/\bOSEPL\b/gi, 'OSEL');
}

// Back-compat alias (older components import this name)
export const displayPlantName = toPlantDisplayName;
