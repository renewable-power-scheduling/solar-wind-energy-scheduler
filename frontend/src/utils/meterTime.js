export function parseBlockFromTimestamp(raw, { totalBlocks = 96 } = {}) {
  if (raw === null || raw === undefined) return null;
  const textVal = String(raw).trim();
  if (!textVal) return null;

  // Extract time part from many common formats:
  // - YYYY-MM-DDTHH:mm:ss(.sss)
  // - YYYY-MM-DD HH:mm:ss
  // - DD-MM-YYYY HH:mm
  // - HH:mm[:ss[.sss]]
  const timeMatch = textVal.match(/(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?/);
  if (!timeMatch) return null;

  const hours = Number.parseInt(timeMatch[1], 10);
  const minutes = Number.parseInt(timeMatch[2], 10);

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

  // Treat the timestamp as the END of the 15-min block (e.g., 00:15 => Block 1).
  // Ignore seconds/millis to prevent accidental +1 block shifts.
  const totalMinutes = (hours * 60) + minutes;
  const block = Math.ceil(totalMinutes / 15);

  if (!Number.isFinite(block) || block < 1 || block > totalBlocks) return null;
  return block;
}
