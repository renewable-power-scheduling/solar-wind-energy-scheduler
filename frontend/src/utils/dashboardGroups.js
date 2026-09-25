export const DASHBOARD_GROUP_STORAGE_KEY = 'vedanjay-dashboard-group';

export const DASHBOARD_GROUPS = [
  {
    id: 'ALL_SITES',
    label: 'All sites',
    allSites: true,
    plantCodes: [],
    plantNames: ['All plants'],
  },
  {
    id: 'SCCL_F_AND_S',
    label: 'Adani Mundra',
    plantCodes: ['BHUPALPALLY', 'KASIPET', 'KOTHAGUDEM'],
    plantNames: ['Bhupalpally', 'Kasipet', 'Kothagudam'],
  },
  {
    id: 'ILIOS_PV',
    label: 'ILios_PV',
    plantCodes: ['ANDAD', 'ANJANGAON', 'BALAKWADA', 'BAMKHAL', 'GUGARIYAKHEDI', 'NANDGAON', 'SAWDA'],
    plantNames: ['Andad', 'Anjangaon', 'Balakwada', 'Bamkhal', 'Gugariyakhedi', 'Nandgaon', 'Sawda'],
  },
  {
    id: 'CHANDWASA',
    label: 'CHANDWASA',
    category: 'Wind',
    plantCodes: ['CHANDWASA'],
    plantNames: ['CHANDWASA'],
  },
  {
    id: 'DSM_VERIFICATION',
    label: 'DSM',
    category: 'DSM',
    plantCodes: [],
    plantNames: ['DSM Verification'],
  },
  { id: 'SIRMOUR', label: 'Sirmour', plantCodes: ['SIRMOUR'], plantNames: ['Sirmour'] },
  { id: 'GSNP', label: 'GSNP', plantCodes: ['GSNP'], plantNames: ['GSNP'] },
  { id: 'CME', label: 'CME', plantCodes: ['CME'], plantNames: ['CME'] },
  { id: 'ZETRIC', label: 'Zetric', plantCodes: ['ZETRIC'], plantNames: ['Zetric'] },
  { id: 'REWASPRNG', label: 'REWASPRNG', category: 'Solar', plantCodes: ['REWASPRNG'], plantNames: ['REWASPRNG'] },
  { id: 'JEWLI', label: 'JEWLI', category: 'Wind', plantCodes: ['JEWLI'], plantNames: ['JEWLI'] },
  { id: 'JGBPL', label: 'JGBPL', category: 'Wind', plantCodes: ['JGBPL'], plantNames: ['JGBPL'] },
  { id: 'ENRICH', label: 'ENRICH', category: 'Solar', plantCodes: ['ENRICH'], plantNames: ['ENRICH'] },
  { id: 'SHAHA', label: 'SHAHA', category: 'Solar', plantCodes: ['SHAHA'], plantNames: ['SHAHA'] },
  { id: 'ESSEL', label: 'Essel', plantCodes: ['OSEPL'], plantNames: ['OSEPL'] },
];

const normalizeCode = (value) => {
  const text = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (text === 'OSEL') return 'OSEPL';
  if (text === 'KOTHAGUDAM') return 'KOTHAGUDEM';
  if (text === 'ZTRIC' || text === 'ZETRICSOLARPARK') return 'ZETRIC';
  if (text === 'CHANDAWASA') return 'CHANDWASA';
  if (text === 'MARUTSHAKTICHANDWASA' || text === 'MARUT_SHAKTI_CHANDWASA') return 'CHANDWASA';
  return text;
};

export function getDashboardGroup(groupId) {
  const normalized = String(groupId || '').trim().toUpperCase();
  return DASHBOARD_GROUPS.find((group) => group.id === normalized) || null;
}

export function normalizeDashboardGroupIds(value) {
  const ids = Array.isArray(value)
    ? value
    : String(value || '').split(/[,|]/);
  const normalized = [];
  const seen = new Set();
  for (const id of ids) {
    const group = getDashboardGroup(id);
    if (!group || seen.has(group.id)) continue;
    if (group.id === 'ALL_SITES') return ['ALL_SITES'];
    seen.add(group.id);
    normalized.push(group.id);
  }
  return normalized;
}

export function serializeDashboardGroupIds(value) {
  return normalizeDashboardGroupIds(value).join(',');
}

export function getDashboardGroups(value) {
  return normalizeDashboardGroupIds(value).map((id) => getDashboardGroup(id)).filter(Boolean);
}

export function hasDashboardGroup(value, groupId) {
  const wanted = String(groupId || '').trim().toUpperCase();
  return normalizeDashboardGroupIds(value).includes(wanted);
}

export function getDashboardGroupSelectionLabel(value) {
  const groups = getDashboardGroups(value);
  if (!groups.length) return '';
  if (groups.some((group) => group.allSites)) return 'All sites';
  return groups.map((group) => group.label).join(', ');
}

export function getStoredDashboardGroupId() {
  try {
    const value = localStorage.getItem(DASHBOARD_GROUP_STORAGE_KEY);
    return serializeDashboardGroupIds(value);
  } catch {
    return '';
  }
}

export function setStoredDashboardGroupId(groupId) {
  try {
    const serialized = serializeDashboardGroupIds(groupId);
    if (serialized) localStorage.setItem(DASHBOARD_GROUP_STORAGE_KEY, serialized);
    else localStorage.removeItem(DASHBOARD_GROUP_STORAGE_KEY);
  } catch {
    // Ignore storage errors.
  }
}

export function clearStoredDashboardGroupId() {
  setStoredDashboardGroupId('');
}

export function getSelectedDashboardGroupId() {
  return getStoredDashboardGroupId();
}

export function getSelectedDashboardGroupPlantCodes() {
  const groups = getDashboardGroups(getSelectedDashboardGroupId());
  if (!groups.length || groups.some((group) => group.allSites)) return [];
  return Array.from(new Set(groups.flatMap((group) => group.plantCodes || [])));
}

export function isPlantInDashboardGroup(plantCode, groupId = getSelectedDashboardGroupId()) {
  const groups = getDashboardGroups(groupId);
  if (!groups.length) return true;
  if (groups.some((group) => group.allSites)) return true;
  const code = normalizeCode(plantCode);
  return !code || groups.some((group) => group.plantCodes.some((allowed) => normalizeCode(allowed) === code));
}

export function derivePlantCodeFromValue(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const paren = text.match(/\(([A-Za-z0-9_-]+)\)/);
  return normalizeCode(paren?.[1] || text);
}
