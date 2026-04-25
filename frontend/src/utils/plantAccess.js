const ALWAYS_BLOCKED_PLANT_CODES = new Set(['GSNP', 'CME', 'KILAJ']);
const ADMIN_ONLY_PLANT_CODES = new Set(['OSEPL']);

export function isAdminUser(userOrRole) {
  if (!userOrRole) return false;
  const role =
    typeof userOrRole === 'string'
      ? userOrRole
      : String(userOrRole?.role || userOrRole?.userRole || userOrRole?.user_role || '').trim();
  return role.toLowerCase() === 'admin';
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
  const code = String(plantCode || '').trim().toUpperCase();
  if (!code) return true;
  if (ALWAYS_BLOCKED_PLANT_CODES.has(code)) return false;
  if (ADMIN_ONLY_PLANT_CODES.has(code)) return isAdminUser(userOrRole);
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
  // Keep always-blocked plants hidden for everyone. Hide admin-only plants for non-admin users.
  const parts = ['\\/CME\\/', '\\/GSNP\\/', '\\/KILAJ\\/'];
  if (!isAdminUser(userOrRole)) parts.push('\\/OSEPL\\/');
  return new RegExp(`(${parts.join('|')})`, 'i');
}

export function filterPrefixesForUser(prefixes, userOrRole) {
  const pattern = getDisabledPlantPattern(userOrRole);
  return (Array.isArray(prefixes) ? prefixes : []).filter((prefix) => prefix && !pattern.test(prefix));
}

