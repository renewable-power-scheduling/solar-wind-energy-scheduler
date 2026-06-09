// Helpers to keep S3 naming consistent for frozen schedules and logs.

const padBlock = (block) => String(block).padStart(2, '0');
const normalizePlantCode = (value) => {
  const code = String(value || '').trim().toUpperCase();
  if (code === 'ANJANGOAN') return 'ANJANGAON';
  if (code === 'OSEL') return 'OSEPL';
  return code;
};

export function buildFrozenScheduleKey({ plantCode, date, block }) {
  const code = normalizePlantCode(plantCode);
  const day = String(date || '').trim();
  const blk = padBlock(block || 0);
  return `frozenschedules/vedanjay/${code}/${day}/schedule_freeze_from_${blk}.csv`;
}

export function buildFrozenLogKey({ plantCode, date, block }) {
  const code = normalizePlantCode(plantCode);
  const day = String(date || '').trim();
  const blk = padBlock(block || 0);
  // Mirror the schedule naming, just switch to .log for easy inspection.
  return `frozenschedules/vedanjay/${code}/${day}/schedule_freeze_from_${blk}.log`;
}

export const FrozenNaming = {
  buildFrozenScheduleKey,
  buildFrozenLogKey,
};
