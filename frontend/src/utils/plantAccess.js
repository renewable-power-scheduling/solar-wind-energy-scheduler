const ALWAYS_BLOCKED_PLANT_CODES = new Set(['KILAJ']);
const ADMIN_ONLY_PLANT_CODES = new Set([]);

function normalizeAccessPlantCode(plantCode) {
  const raw = String(plantCode || '').trim().toUpperCase();
  const compact = raw.replace(/[^A-Z0-9_-]/g, '');
  if (compact === 'ZETRICSOLARPARK') return 'ZETRIC';
  if (compact === 'ZTRIC') return 'ZETRIC';
  if (compact === 'OSEL') return 'OSEPL';
  return compact || raw;
}

export function isAdminUser(userOrRole) {
  if (!userOrRole) return false;
  const role =
    typeof userOrRole === 'string'
      ? userOrRole
      : String(userOrRole?.role || userOrRole?.userRole || userOrRole?.user_role || '').trim();
  return role.toLowerCase() === 'admin';
}

export function isSchedulingAdminUser(userOrRole) {
  if (!userOrRole || typeof userOrRole === 'string') return false;
  const username = String(userOrRole?.username || userOrRole?.email || '').trim().toLowerCase();
  const name = String(userOrRole?.name || userOrRole?.displayName || '').trim().toLowerCase();
  return username === 'scheduling_vppl' || name === 'scheduling admin';
}

export function isInternUser(userOrRole) {
  if (!userOrRole) return false;
  if (typeof userOrRole === 'string') return String(userOrRole).trim().toLowerCase() === 'intern';
  const role = String(userOrRole?.role || userOrRole?.userRole || userOrRole?.user_role || '').trim().toLowerCase();
  const token = String(userOrRole?.empId || userOrRole?.username || '').trim().toLowerCase();
  return role === 'intern' || token === 'intern';
}

export function isAdminOrInternUser(userOrRole) {
  return isAdminUser(userOrRole) || isInternUser(userOrRole);
}

export function canAccessEmailScheduler(userOrRole) {
  // Allow all authenticated users (admin, intern, employees) to access Email Scheduler.
  return Boolean(userOrRole);
}

export function getCurrentUserFromStorage() {
  try {
    const raw = localStorage.getItem('vedanjay-user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function canUserAccessPlantCode(plantCode, userOrRole) {
  const code = normalizeAccessPlantCode(plantCode);
  if (!code) return true;
  if (ALWAYS_BLOCKED_PLANT_CODES.has(code)) return false;
  if (ADMIN_ONLY_PLANT_CODES.has(code)) return isAdminOrInternUser(userOrRole);
  return true;
}

export function filterPlantsForUser(plants, userOrRole) {
  const list = Array.isArray(plants) ? plants : [];
  return list.filter((plant) => {
    const code = String(plant?.code || plant?.plant_code || plant?.plantCode || plant?.name || '').trim();
    return canUserAccessPlantCode(code, userOrRole);
  });
}

export function getDisabledPlantPattern(userOrRole) {
  // Used to filter S3 prefixes by `/PLANT_CODE/` segment.
  // Keep always-blocked plants hidden for everyone. Hide admin/intern plants for other users.
  const parts = Array.from(ALWAYS_BLOCKED_PLANT_CODES).map(
    (code) => `\\/${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/`
  );
  if (!isAdminOrInternUser(userOrRole) && ADMIN_ONLY_PLANT_CODES.size > 0) {
    for (const code of ADMIN_ONLY_PLANT_CODES) {
      parts.push(`\\/${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/`);
    }
  }
  return new RegExp(`(${parts.join('|')})`, 'i');
}

export function filterPrefixesForUser(prefixes, userOrRole) {
  const pattern = getDisabledPlantPattern(userOrRole);
  return (Array.isArray(prefixes) ? prefixes : []).filter((prefix) => prefix && !pattern.test(prefix));
}
