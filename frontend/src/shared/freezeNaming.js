// Helpers to keep S3 naming consistent for frozen schedules and logs.

const padBlock = (block) => String(block).padStart(2, '0');

export function buildFrozenScheduleKey({ plantCode, date, block }) {
  const code = String(plantCode || '').toUpperCase();
  const day = String(date || '').trim();
  const blk = padBlock(block || 0);
  return `frozenschedules/vedanjay/${code}/${day}/schedule_freeze_from_${blk}.csv`;
}

export function buildFrozenLogKey({ plantCode, date, block }) {
  const code = String(plantCode || '').toUpperCase();
  const day = String(date || '').trim();
  const blk = padBlock(block || 0);
  // Mirror the schedule naming, just switch to .log for easy inspection.
  return `frozenschedules/vedanjay/${code}/${day}/schedule_freeze_from_${blk}.log`;
}

export const FrozenNaming = {
  buildFrozenScheduleKey,
  buildFrozenLogKey,
};
