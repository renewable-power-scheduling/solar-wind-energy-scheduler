import {
  derivePlantCodeFromValue,
  getDashboardGroups,
  getSelectedDashboardGroupId,
  isPlantInDashboardGroup,
} from './dashboardGroups';

const ALWAYS_BLOCKED_PLANT_CODES = new Set(['KILAJ']);
const ADMIN_ONLY_PLANT_CODES = new Set(['JEWLI', 'JGBPL', 'REWASPRNG', 'ENRICH', 'SHAHA']);

function normalizeAccessPlantCode(plantCode) {
  const raw = String(plantCode || '').trim().toUpperCase();
  const compact = raw.replace(/[^A-Z0-9_-]/g, '');
  if (compact === 'ZETRICSOLARPARK') return 'ZETRIC';
  if (compact === 'ZTRIC') return 'ZETRIC';
  if (compact === 'OSEL') return 'OSEPL';
  if (compact === 'CHANDAWASA') return 'CHANDWASA';
  if (compact === 'MARUTSHAKTICHANDWASA' || compact === 'MARUT_SHAKTI_CHANDWASA') return 'CHANDWASA';
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

export function canAccessDsmVerification(userOrRole) {
  if (!userOrRole) return false;
  if (typeof userOrRole === 'string') {
    const role = String(userOrRole).trim().toLowerCase();
    return ['admin', 'intern', 'employee', 'member'].includes(role);
  }
  const role = String(userOrRole?.role || userOrRole?.userRole || userOrRole?.user_role || '').trim().toLowerCase();
  const token = String(userOrRole?.empId || userOrRole?.username || '').trim().toLowerCase();
  return ['admin', 'intern', 'employee', 'member'].includes(role) || token === 'intern';
}

export function getCurrentUserFromStorage() {
  try {
    const raw = localStorage.getItem('vedanjay-user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function canUserAccessPlantCodeByRole(plantCode, userOrRole) {
  const code = normalizeAccessPlantCode(plantCode);
  if (!code) return true;
  if (ALWAYS_BLOCKED_PLANT_CODES.has(code)) return false;
  if (ADMIN_ONLY_PLANT_CODES.has(code)) return isAdminUser(userOrRole);
  return true;
}

export function canUserAccessDashboardGroup(group, userOrRole) {
  if (!group) return false;
  if (group.category === 'DSM') return canAccessDsmVerification(userOrRole);
  // All sites is a valid dashboard scope for every role; individual plant
  // access remains enforced by canUserAccessPlantCode/filterPlantsForUser.
  if (group.allSites) return true;
  const plantCodes = Array.isArray(group.plantCodes) ? group.plantCodes : [];
  return plantCodes.every((code) => canUserAccessPlantCodeByRole(code, userOrRole));
}

export function canUserAccessPlantCode(plantCode, userOrRole) {
  const code = normalizeAccessPlantCode(plantCode);
  if (!code) return true;
  if (!canUserAccessPlantCodeByRole(code, userOrRole)) return false;
  if (!isPlantInDashboardGroup(code, getSelectedDashboardGroupId())) return false;
  return true;
}

export function filterPlantsForUser(plants, userOrRole) {
  const list = Array.isArray(plants) ? plants : [];
  return list.filter((plant) => {
    const code =
      String(plant?.code || plant?.plant_code || plant?.plantCode || '').trim() ||
      derivePlantCodeFromValue(plant?.name);
    return canUserAccessPlantCode(code, userOrRole);
  });
}

export function getDisabledPlantPattern(userOrRole) {
  // Used to filter S3 prefixes by `/PLANT_CODE/` segment.
  // Keep always-blocked plants hidden for everyone. Hide admin-only plants for non-admin users.
  const parts = Array.from(ALWAYS_BLOCKED_PLANT_CODES).map(
    (code) => `\\/${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/`
  );
  if (!isAdminUser(userOrRole) && ADMIN_ONLY_PLANT_CODES.size > 0) {
    for (const code of ADMIN_ONLY_PLANT_CODES) {
      parts.push(`\\/${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/`);
    }
  }
  return new RegExp(`(${parts.join('|')})`, 'i');
}

export function filterPrefixesForUser(prefixes, userOrRole) {
  const pattern = getDisabledPlantPattern(userOrRole);
  const groups = getDashboardGroups(getSelectedDashboardGroupId());
  return (Array.isArray(prefixes) ? prefixes : []).filter((prefix) => {
    if (!prefix || pattern.test(prefix)) return false;
    if (!groups.length || groups.some((group) => group.allSites)) return true;
    const text = String(prefix || '');
    return groups.some((group) => (group.plantCodes || []).some((code) => {
      const normalized = String(code || '').trim().toUpperCase();
      if (!normalized) return false;
      if (normalized === 'ZETRIC') {
        return /\/(ZETRIC|ZTRIC)\//i.test(text);
      }
      return new RegExp(`/${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`, 'i').test(text);
    }));
  });
}
