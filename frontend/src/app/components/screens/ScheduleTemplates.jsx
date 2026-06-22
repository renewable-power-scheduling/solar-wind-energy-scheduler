import { useEffect, useMemo, useState } from 'react';
import { useAuth, useWorkflowGuide } from '@/app/appContexts';
import { getEmployeeName } from '@/utils/getEmployeeName.js';
import { filterPlantsForUser } from '@/utils/plantAccess';
import {
  RefreshCw,
  FileSearch,
  FileText,
  Wand2,
  History,
  AlertTriangle,
  CheckCircle,
  Download,
  ExternalLink,
  Building2,
  CalendarDays,
  FileSpreadsheet,
} from 'lucide-react';
import { api, templateTransformApi, scheduleReadinessApi, frozenScheduleApi } from '@/services/api';
import { toast } from 'sonner';
import { S3_BASE_URL, HIDE_METADATA } from '@/config/appConfig';
import DownloadFormatModal from '@/app/components/common/DownloadFormatModal';
import { recomputeFrozenForPlantDate } from '@/services/autoFreezeService';
import {
  computeIntradayRunIndexByKey,
  extractScheduleDateFromKey,
  formatMachineScheduleDisplayName,
} from '@/utils/machineScheduleDisplay';
import {
  downloadBlob,
  downloadCsvText,
  downloadXlsxFromCsvText,
  downloadTelanganaTemplateFromBaseXlsx,
  downloadVedanjayMhXlsx,
  normalizeVedanjayMhCsvText,
  downloadGsnpSirmourXlsx,
  convertXlsxBlobToCsvText,
} from '@/app/components/common/downloadUtils';

const GSNP_NAME = 'Globus Steel N Power (GSNP)';
const SUPPORTED_PLANT_CODES = ['ANJANGAON', 'BAMKHAL', 'BHUPALPALLY', 'CME', 'GSNP', 'KASIPET', 'KILAJ', 'KOTHAGUDEM', 'OSEPL', 'SIRMOUR', 'SAWDA'];
const TELANGANA_PLANT_CODES = new Set(['BHUPALPALLY', 'KASIPET', 'KOTHAGUDEM']);
const FALLBACK_PLANTS = [
  { id: 1, code: 'BHUPALPALLY', name: 'BHUPALPALLY', type: 'Solar', state: 'Telangana' },
  { id: 2, code: 'CME', name: 'CME', type: 'Solar', state: 'Maharashtra' },
  { id: 3, code: 'GSNP', name: 'Globus Steel N Power (GSNP)', type: 'Solar', state: 'Madhya Pradesh' },
  { id: 4, code: 'KASIPET', name: 'KASIPET', type: 'Solar', state: 'Telangana' },
  { id: 5, code: 'KILAJ', name: 'KILAJ', type: 'Solar', state: 'Maharashtra' },
  { id: 6, code: 'KOTHAGUDEM', name: 'KOTHAGUDEM', type: 'Solar', state: 'Telangana' },
  { id: 7, code: 'OSEPL', name: 'OSEL', type: 'Solar', state: 'Maharashtra' },
  { id: 8, code: 'SIRMOUR', name: 'SIRMOUR', type: 'Solar', state: 'Madhya Pradesh' },
  { id: 9, code: 'SAWDA', name: 'SAWDA', type: 'Solar', state: 'Madhya Pradesh' },
  { id: 10, code: 'ANJANGAON', name: 'ANJANGAON', type: 'Solar', state: 'Madhya Pradesh' },
  { id: 11, code: 'BAMKHAL', name: 'BAMKHAL', type: 'Solar', state: 'Madhya Pradesh' },
];
const FALLBACK_CAPACITY_BY_CODE = {
  BHUPALPALLY: 10,
  CME: 4,
  GSNP: 20,
  KASIPET: 15,
  KILAJ: 20,
  KOTHAGUDEM: 37,
  OSEPL: 20,
  SIRMOUR: 5.1,
  SAWDA: 7.5,
  BAMKHAL: 5,
};
const SLDC_TEMPLATE_MAP_STORAGE_KEY = 'vedanjay-sldc-template-map-v1';
const READINESS_WORKFLOW_STORAGE_KEY = 'vedanjay-readiness-workflow-v1';
const UI_WORKFLOW_STAGE_KEY = 'vedanjay-ui-workflow-stage-v1';
const SLDC_PORTALS = {
  TELANGANA: 'https://fs.tgsldc.in:8443/login',
  MAHARASHTRA: 'https://remc.mahasldc.in/',
  MADHYA_PRADESH: 'http://223.31.122.117/EltrixPortal/login.jsp',
};
const SLDC_PLANT_GROUPS = {
  TELANGANA: new Set(['BHUPALPALLY', 'KASIPET', 'KOTHAGUDEM']),
  MAHARASHTRA: new Set(['KILAJ', 'FDIPL', 'OSEPL', 'CME', 'ZITRIC']),
  MADHYA_PRADESH: new Set(['GSNP', 'SIRMOUR', 'SAWDA', 'ANJANGAON', 'BAMKHAL', 'CHANDAWAS']),
};

function derivePlantCodeFromName(name) {
  const text = String(name || '').trim();
  if (!text) return null;
  const match = text.match(/\(([A-Za-z0-9_-]+)\)/);
  if (match) return match[1].toUpperCase();
  if (/^[A-Z0-9_-]{2,6}$/.test(text)) return text.toUpperCase();
  const compact = text.replace(/[^A-Za-z0-9]/g, '');
  return compact ? compact.toUpperCase() : null;
}

function normalizePlantCodeAlias(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (normalized === 'ANJANGOAN') return 'ANJANGAON';
  return normalized;
}

function getSpecialS3PlantFolderAliases(code) {
  const normalized = normalizePlantCodeAlias(code);
  if (normalized === 'ANJANGAON') return ['ANJANGOAN', 'ANJANGAON'];
  return normalized ? [normalized] : [];
}

function getGeneratedPlantCodeAliases(code) {
  const normalized = normalizePlantCodeAlias(code);
  if (normalized === 'ANJANGAON') return ['ANJANGAON', 'ANJANGOAN'];
  return normalized ? [normalized] : [];
}

function derivePlantCodeFromKey(key) {
  const text = String(key || '');
  if (!text) return null;
  const vedanjayMatch = text.match(/\/vedanjay\/([^/]+)\//i);
  if (vedanjayMatch?.[1]) return normalizePlantCodeAlias(vedanjayMatch[1]);
  const dateMatch = text.match(/(^|\/)([A-Za-z]+)_[0-9]{4}-[0-9]{2}-[0-9]{2}/);
  if (dateMatch?.[2]) return normalizePlantCodeAlias(dateMatch[2]);
  const knownMatch = text.match(/(BHUPALPALLY|KASIPET|KOTHAGUDEM|OSEPL|CME|KILAJ|SIRMOUR|GSNP|SAWDA|ANJANGAON|ANJANGOAN|BAMKHAL)/i);
  if (knownMatch?.[1]) return normalizePlantCodeAlias(knownMatch[1]);
  return null;
}

function resolvePlantCodeFromHistoryRow(row) {
  const metaCode = String(row?.metadata?.plant_code || '').trim();
  if (metaCode) return metaCode.toUpperCase();
  const fromKey = derivePlantCodeFromKey(row?.source_file_key || row?.output_file_key || row?.file_key || row?.template_file_name || row?.filename);
  if (fromKey) return fromKey;
  const fromName = derivePlantCodeFromName(row?.plant_name || row?.plant || '');
  return fromName;
}

function resolvePlantCodeFromContext({ selectedPlant, selectedPlantId, plants, selectedSourceKey, sourceFileName }) {
  const fromSelected = resolvePlantCode(selectedPlant);
  if (fromSelected) return fromSelected;
  const fromId = plants?.find((p) => String(p?.id) === String(selectedPlantId));
  const fromIdCode = resolvePlantCode(fromId);
  if (fromIdCode) return fromIdCode;
  const fromKey = derivePlantCodeFromKey(selectedSourceKey || '');
  if (fromKey) return fromKey;
  const fromFile = derivePlantCodeFromName(sourceFileName || '');
  return fromFile;
}

function isTelanganaTemplateCsvText(csvText) {
  const text = String(csvText || '');
  if (!text) return false;
  return (
    text.includes('Block,Time Period,Forecast(MW),AvC(MW),Station Schedule')
    && text.includes('Name of Generator')
    && text.includes('Contract Type')
  );
}

function isSupportedPlant(plant) {
  const code = String(plant?.code || '').trim().toUpperCase();
  if (SUPPORTED_PLANT_CODES.includes(code)) return true;

  const name = String(plant?.name || '').trim().toLowerCase();
  return (
    name.includes('gsnp') ||
    name.includes('globus steel') ||
    name.includes('sirmour') ||
    name.includes('bhupalpally') ||
    name.includes('kasipet') ||
    name.includes('kothagudem') ||
    name.includes('cme') ||
    name.includes('kilaj') ||
    name.includes('osepl')
  );
}

function resolvePlantCode(plant) {
  if (typeof plant === 'string') {
    return derivePlantCodeFromName(plant);
  }
  const code = String(plant?.code || '').trim().toUpperCase();
  if (code) return code;
  const name = String(plant?.name || '').toLowerCase();
  if (name.includes('bhupalpally')) return 'BHUPALPALLY';
  if (name.includes('kasipet')) return 'KASIPET';
  if (name.includes('kilaj')) return 'KILAJ';
  if (name.includes('kothagudem')) return 'KOTHAGUDEM';
  if (name.includes('osepl')) return 'OSEPL';
  if (name.includes('cme')) return 'CME';
  if (name.includes('gsnp') || name.includes('globus steel')) return 'GSNP';
  if (name.includes('sirmour')) return 'SIRMOUR';
  if (name.includes('bamkhal')) return 'BAMKHAL';
  return derivePlantCodeFromName(plant?.name);
}

function normalizePlantName(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function derivePlantFolders(plant) {
  const name = String(plant?.name || plant?.code || '').trim();
  if (!name) return null;
  let folder = name;
  if (/^[A-Z0-9_-]+$/.test(folder) && folder.length > 4) {
    const lower = folder.toLowerCase();
    folder = lower.charAt(0).toUpperCase() + lower.slice(1);
  }
  const lowerFolder = folder.toLowerCase().replace(/\s+/g, '');
  const upperFolder = folder.toUpperCase().replace(/\s+/g, '');
  return { folder, lower: lowerFolder, upper: upperFolder };
}

async function listS3Objects(prefix) {
  try {
    const proxyResp = await fetch('/api/s3/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [prefix], limit: 5000 }),
    });
    if (!proxyResp.ok) return [];
    const payload = await proxyResp.json().catch(() => ({}));
    const items = Array.isArray(payload?.items) ? payload.items : [];
    return items
      .map((item) => ({
        key: String(item?.key || '').trim(),
        last_modified: String(item?.last_modified || item?.lastModified || '').trim(),
      }))
      .filter((item) => item.key);
  } catch {
    return [];
  }
}

async function listFrozenScheduleFilesFromS3(targetDate, plant) {
  const normalizedCode = String(resolvePlantCode(plant) || '').trim().toUpperCase();
  if (!normalizedCode || !targetDate) return [];
  const prefixes = getSpecialS3PlantFolderAliases(normalizedCode).map(
    (folder) => `frozenschedules/vedanjay/${folder}/${targetDate}/`
  );
  const settled = await Promise.allSettled(prefixes.map((prefix) => listS3Objects(prefix).catch(() => [])));
  const objects = settled
    .filter((result) => result.status === 'fulfilled')
    .flatMap((result) => result.value || []);
  return objects
    .filter((o) => {
      const key = String(o.key || '').toLowerCase();
      return (
        key.endsWith('.csv') &&
        (key.endsWith('/edited_frozen.csv') || key.endsWith('/system_frozen.csv'))
      );
    })
    .sort((a, b) => {
      const aTime = Date.parse(a.last_modified || '');
      const bTime = Date.parse(b.last_modified || '');
      const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
      if (timeDiff !== 0) return timeDiff;
      return (b.key || '').localeCompare(a.key || '');
    });
}

async function listLatestScheduleFilesFromS3(targetDate, plant) {
  const normalizedCode = String(resolvePlantCode(plant) || '').trim().toUpperCase();
  const derived = derivePlantFolders(plant || { code: normalizedCode });
  const rawPrefixes = normalizedCode
    ? getGeneratedPlantCodeAliases(normalizedCode).map((alias) => `raw/vedanjay/${alias}`)
    : (derived ? [`raw/vedanjay/${derived.folder.toUpperCase().replace(/\s+/g, '')}`] : []);
  const legacyRawPrefix = normalizedCode === 'SIRMOUR'
    ? 'raw/Sirmour/sirmour'
    : normalizedCode === 'GSNP'
      ? 'raw/GSNP/gsnp'
      : (derived ? `raw/${derived.folder}/${derived.lower}` : null);
  const generatedPrefixes = normalizedCode
    ? getGeneratedPlantCodeAliases(normalizedCode).map((alias) => `generated/vedanjay/${alias}/outputs`)
    : (derived ? [`generated/vedanjay/${derived.folder.toUpperCase().replace(/\s+/g, '')}/outputs`] : []);
  const legacyGeneratedPrefix = normalizedCode === 'SIRMOUR'
    ? 'generated/Sirmour/sirmour/outputs'
    : normalizedCode === 'GSNP'
      ? 'generated/GSNP/gsnp/outputs'
      : (derived ? `generated/${derived.folder}/${derived.lower}/outputs` : null);
  const prefixes = [
    ...rawPrefixes.map((prefix) => `${prefix}/${targetDate}/`),
    ...(legacyRawPrefix ? [`${legacyRawPrefix}/${targetDate}/`] : []),
    ...generatedPrefixes.map((prefix) => `${prefix}/${targetDate}/`),
    ...(legacyGeneratedPrefix ? [`${legacyGeneratedPrefix}/${targetDate}/`] : []),
    `outputs/${targetDate}/`,
  ];
  const settled = await Promise.allSettled(prefixes.map((p) => listS3Objects(p)));
  const objects = settled
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value || []);

  const normalizeToken = (value) =>
    String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  const normalizedCodeLower = String(normalizedCode || '').trim().toLowerCase();
  const plantTokens = [
    normalizedCodeLower,
    ...(normalizedCode === 'ANJANGAON' ? ['anjangoan'] : []),
    derived?.lower,
    derived?.folder,
  ].filter(Boolean);
  const plantTokensNormalized = Array.from(new Set(plantTokens.map(normalizeToken).filter(Boolean)));
  const scheduleFiles = objects
    .filter((o) => {
      const key = String(o.key || '').toLowerCase();
      if (/(?:\/day-ahead\/|\/dayahead\/|\/day_ahead\/)/i.test(key)) return false;
      const fileName = key.split('/').pop() || '';
      const pathSegments = key.split('/').filter(Boolean);
      const normalizedSegments = pathSegments.map(normalizeToken);
      const normalizedFile = normalizeToken(fileName);
      const plantScoped = plantTokensNormalized.length === 0
        ? true
        : plantTokensNormalized.some((token) =>
            normalizedSegments.includes(token) || normalizedFile.includes(token)
          );
      return (
        key.endsWith('.csv') &&
        /schedule_from_\d+\.csv$/i.test(key) &&
        plantScoped
      );
    })
    .sort((a, b) => {
      const getSeq = (k) => {
        const m = String(k || '').match(/schedule_(?:free(?:z|ze)_)?from_(\d+)\.csv$/i);
        return m ? Number.parseInt(m[1], 10) : null;
      };
      const aSeq = getSeq(a.key);
      const bSeq = getSeq(b.key);
      if (aSeq !== null && bSeq !== null && bSeq !== aSeq) return bSeq - aSeq;
      const aTime = Date.parse(a.last_modified || '');
      const bTime = Date.parse(b.last_modified || '');
      const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
      if (timeDiff !== 0) return timeDiff;
      return (b.key || '').localeCompare(a.key || '');
    });

  return scheduleFiles;
}

async function listDayAheadFilesFromS3(targetDate, plant) {
  const normalizedCode = String(resolvePlantCode(plant) || '').trim().toUpperCase();
  const derived = derivePlantFolders(plant || { code: normalizedCode });
  const legacyGeneratedPrefix = normalizedCode === 'SIRMOUR'
    ? 'generated/Sirmour/sirmour/outputs'
    : normalizedCode === 'GSNP'
      ? 'generated/GSNP/gsnp/outputs'
      : (derived ? `generated/${derived.folder}/${derived.lower}/outputs` : null);

  const prevDate = (() => {
    const base = new Date(`${String(targetDate || '').trim()}T00:00:00`);
    if (Number.isNaN(base.getTime())) return '';
    base.setDate(base.getDate() - 1);
    const yyyy = base.getFullYear();
    const mm = String(base.getMonth() + 1).padStart(2, '0');
    const dd = String(base.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  })();

  const candidateDates = Array.from(
    new Set([String(targetDate || '').trim(), prevDate].filter(Boolean))
  );

  const dayAheadFolderVariants = ['Day-ahead', 'day-ahead', 'dayahead', 'day_ahead'];
  const prefixes = candidateDates.flatMap((d) => [
    ...dayAheadFolderVariants.flatMap((folder) => ([
      ...getGeneratedPlantCodeAliases(normalizedCode).map((alias) => `generated/vedanjay/${alias}/outputs/${d}/${folder}/`),
      ...(derived?.upper ? [`generated/vedanjay/${derived.upper}/outputs/${d}/${folder}/`] : []),
      ...(derived?.upper === 'ANJANGAON' ? [`generated/vedanjay/ANJANGOAN/outputs/${d}/${folder}/`] : []),
      ...(legacyGeneratedPrefix ? [`${legacyGeneratedPrefix}/${d}/${folder}/`] : []),
    ])),
  ]);
  if (!prefixes.length) return [];
  const settled = await Promise.allSettled(Array.from(new Set(prefixes)).map((p) => listS3Objects(p)));
  const objects = settled
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value || []);
  const dayAheadFiles = objects.filter((o) => {
    const key = String(o.key || '').toLowerCase();
    if (!key.endsWith('.csv')) return false;
    return /_da0\.csv$/i.test(key) || /schedule_from_\d+\.csv$/i.test(key);
  });

  // Prefer schedule_from_* within Day-ahead as the "latest" baseline when present (highest block/revision).
  // Fall back to *_DA0.csv only when no schedule_from_* exists.
  const hasScheduleFrom = dayAheadFiles.some((o) => /schedule_from_\d+\.csv$/i.test(String(o.key || '')));
  const filtered = hasScheduleFrom
    ? dayAheadFiles.filter((o) => /schedule_from_\d+\.csv$/i.test(String(o.key || '')))
    : dayAheadFiles.filter((o) => /_da0\.csv$/i.test(String(o.key || '')));

  const sorted = filtered.sort((a, b) => {
    const getSeq = (k) => {
      const m = String(k || '').match(/schedule_(?:free(?:z|ze)_)?from_(\d+)\.csv$/i);
      return m ? Number.parseInt(m[1], 10) : null;
    };
    const aSeq = getSeq(a.key);
    const bSeq = getSeq(b.key);
    if (aSeq !== null && bSeq !== null && bSeq !== aSeq) return bSeq - aSeq;
    const aTime = Date.parse(a.last_modified || '');
    const bTime = Date.parse(b.last_modified || '');
    const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
    if (timeDiff !== 0) return timeDiff;
    return (b.key || '').localeCompare(a.key || '');
  });

  return sorted;
}

function isScheduleFromFileEntry(file) {
  const key = String(file?.key || file || '').toLowerCase();
  if (!key.endsWith('.csv')) return false;
  if (/schedule_from_\d+\.csv$/i.test(key)) return true;
  if (/_da0\.csv$/i.test(key)) return true;
  return false;
}

function filterScheduleFilesByPlant(files, plant) {
  const normalizedCode = String(resolvePlantCode(plant) || '').trim().toUpperCase();
  const derived = derivePlantFolders(plant || { code: normalizedCode });
  const normalizeToken = (value) =>
    String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  const normalizedCodeLower = String(normalizedCode || '').trim().toLowerCase();
  if (!normalizedCodeLower) return files;
  const plantTokens = [
    normalizedCodeLower,
    ...(normalizedCode === 'ANJANGAON' ? ['anjangoan'] : []),
    derived?.lower,
    derived?.folder,
  ].filter(Boolean);
  const plantTokensNormalized = Array.from(new Set(plantTokens.map(normalizeToken).filter(Boolean)));
  if (!plantTokensNormalized.length) return files;

  return (files || []).filter((file) => {
    const key = String(file?.key || file || '').toLowerCase();
    if (!key) return false;
    const fileName = key.split('/').pop() || '';
    const pathSegments = key.split('/').filter(Boolean);
    const normalizedSegments = pathSegments.map(normalizeToken);
    const normalizedFile = normalizeToken(fileName);
    return plantTokensNormalized.some((token) =>
      normalizedSegments.includes(token) || normalizedFile.includes(token)
    );
  });
}

function sortScheduleFiles(files) {
  return (files || []).slice().sort((a, b) => {
    const getKey = (item) => String(item?.key || item || '');
    const getRank = (k) => {
      const key = String(k || '').toLowerCase();
      if (key.endsWith('/edited_frozen.csv')) return 0;
      if (key.endsWith('/system_frozen.csv')) return 1;
      if (/(?:\/day-ahead\/|\/dayahead\/|\/day_ahead\/)/i.test(key) || /_da0\.csv$/i.test(key)) return 4;
      if (/schedule_from_\d+\.csv$/i.test(key)) return 2;
      return 9;
    };
    const getSeq = (k) => {
      const m = String(k || '').match(/schedule_(?:free(?:z|ze)_)?from_(\d+)\.csv$/i);
      return m ? Number.parseInt(m[1], 10) : null;
    };
    const aKey = getKey(a);
    const bKey = getKey(b);
    const aRank = getRank(aKey);
    const bRank = getRank(bKey);
    if (aRank !== bRank) return aRank - bRank;
    const aSeq = getSeq(aKey);
    const bSeq = getSeq(bKey);
    if (aSeq !== null && bSeq !== null && bSeq !== aSeq) return bSeq - aSeq;
    const aTime = Date.parse(a?.lastModified || a?.last_modified || '');
    const bTime = Date.parse(b?.lastModified || b?.last_modified || '');
    const timeDiff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
    if (timeDiff !== 0) return timeDiff;
    return bKey.localeCompare(aKey);
  });
}

function pickPreferredSourceFile(files, { plantCode = '', preferredDate = '', previousKey = '', preferredSourceKey = '' } = {}) {
  const rows = Array.isArray(files) ? files : [];
  if (!rows.length) return '';

  if (preferredSourceKey && rows.some((row) => row?.key === preferredSourceKey)) {
    return preferredSourceKey;
  }

  if (previousKey && rows.some((row) => row?.key === previousKey)) {
    return previousKey;
  }

  const normalizedPlantCode = String(plantCode || '').trim().toUpperCase();
  const preferredDateText = String(preferredDate || '').trim();
  const shouldPreferDayAhead = normalizedPlantCode === 'ANJANGAON' || normalizedPlantCode === 'BAMKHAL' || normalizedPlantCode === 'SIRMOUR';
  if (shouldPreferDayAhead) {
    const matchingDayAhead = rows.find((row) => {
      const key = String(row?.key || '').trim();
      if (!isDayAheadKey(key)) return false;
      if (!preferredDateText) return true;
      return key.includes(`/${preferredDateText}/`);
    });
    if (matchingDayAhead?.key) return matchingDayAhead.key;
  }

  return rows[0]?.key || '';
}

function dedupeScheduleFiles(files, { preferredDate = '', plantCode = '' } = {}) {
  const items = Array.isArray(files) ? files : [];
  if (items.length <= 1) return items;

  const getKey = (item) => String(item?.key || item || '');
  const getFileName = (k) => getFileNameFromKey(String(k || ''));
  const extractDate = (k) => {
    const m = String(k || '').match(/\/(\d{4}-\d{2}-\d{2})\//);
    return m ? m[1] : '';
  };
  const isDayAheadKey = (k) =>
    /(?:\/day-ahead\/|\/dayahead\/|\/day_ahead\/)/i.test(String(k || '')) || /_da0\.csv$/i.test(String(k || ''));

  const preferredDateNorm = String(preferredDate || '').trim();
  const plantCodeUpper = String(plantCode || '').trim().toUpperCase();

  const scoreItem = (item) => {
    const k = getKey(item);
    const lower = k.toLowerCase();
    let score = 0;

    const dateInKey = extractDate(k);
    const dayAhead = isDayAheadKey(k);

    if (dayAhead && preferredDateNorm && dateInKey === preferredDateNorm) score += 200;
    if (!dayAhead && preferredDateNorm && dateInKey === preferredDateNorm) score += 100;

    if (plantCodeUpper && lower.includes(`/generated/vedanjay/${plantCodeUpper.toLowerCase()}/`)) score += 80;
    if (lower.includes('/generated/vedanjay/')) score += 40;

    if (dayAhead && /\/day-ahead\/|\/dayahead\/|\/day_ahead\//i.test(lower)) score += 10;
    if (lower.includes('/manual-edits/')) score += 5;

    const lastModified = Date.parse(item?.lastModified || item?.last_modified || '');
    if (!Number.isNaN(lastModified)) score += Math.min(25, Math.floor(lastModified / 1e12)); // stable-ish tie-break

    return score;
  };

  const bestByGroup = new Map();
  for (const item of items) {
    const k = getKey(item);
    const fileName = getFileName(k);
    const groupDate = extractDate(k);
    const groupType = isDayAheadKey(k) ? 'DAY_AHEAD' : 'INTRADAY';
    const groupKey = `${groupType}|${groupDate}|${fileName}`;

    const existing = bestByGroup.get(groupKey);
    if (!existing) {
      bestByGroup.set(groupKey, item);
      continue;
    }
    if (scoreItem(item) > scoreItem(existing)) {
      bestByGroup.set(groupKey, item);
    }
  }

  const chosenKeys = new Set(Array.from(bestByGroup.values()).map((i) => getKey(i)));
  const seenKeys = new Set();
  return items.filter((item) => {
    const k = getKey(item);
    if (!chosenKeys.has(k)) return false;
    if (seenKeys.has(k)) return false;
    seenKeys.add(k);
    return true;
  });
}

async function fetchTextFromS3(key) {
  const encoded = String(key || '').split('/').map((s) => encodeURIComponent(s)).join('/');
  try {
    const resp = await fetch(`${S3_BASE_URL}/${encoded}`);
    if (!resp.ok) throw new Error(`S3 fetch failed: ${resp.status}`);
    return resp.text();
  } catch (error) {
    // Fallback: proxy via backend to avoid S3 CORS issues when accessed via EC2/IP.
    const proxyUrl = `/api/s3/text?key=${encodeURIComponent(String(key || ''))}`;
    const resp = await fetch(proxyUrl);
    if (!resp.ok) throw error;
    return resp.text();
  }
}

function parseCsvRows(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return { headers: [], rows: [] };

  const delimiterCandidates = [',', ';', '\t'];
  const headerCandidate = lines.find((line) => /block/i.test(line)) || lines[0];
  const delimiter = delimiterCandidates.reduce(
    (best, candidate) => {
      const count = String(headerCandidate || '').split(candidate).length - 1;
      return count > best.count ? { value: candidate, count } : best;
    },
    { value: ',', count: -1 }
  ).value;

  const parseLine = (line) => {
    const cells = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === delimiter && !inQuotes) {
        cells.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    cells.push(current.trim());
    return cells;
  };

  const headerLine = lines.find((line) => /block/i.test(line) && line.includes(delimiter)) || lines[0];
  const startIdx = lines.indexOf(headerLine);
  const headers = parseLine(headerLine).map((h) => h.trim());
  const rows = lines.slice(startIdx + 1).map((line) => parseLine(line));
  return { headers, rows };
}

function parseSourceScheduleForecastMap(text, options = {}) {
  const { headers, rows } = parseCsvRows(text);
  if (!headers.length) return new Map();

  const normalize = (value) => String(value || '').toLowerCase().replace(/["']/g, '').replace(/[\s_-]+/g, '');
  const preserveNull = Boolean(options?.preserveNull);
  const normalizeValue = (value) => {
    if (!Number.isFinite(value)) return preserveNull ? null : 0;
    return Math.max(0, value);
  };
  const parseNum = (value) => {
    const cleaned = String(value ?? '').replace(/,/g, '').trim();
    const n = Number.parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
  };
  const parseBlock = (value, idx) => {
    const raw = String(value ?? '').trim();
    const direct = Number.parseInt(raw, 10);
    if (Number.isFinite(direct) && direct >= 1 && direct <= 96) return direct;
    const matched = raw.match(/[bB]\s*([0-9]{1,3})/);
    if (matched) {
      const b = Number.parseInt(matched[1], 10);
      if (Number.isFinite(b) && b >= 1 && b <= 96) return b;
    }
    return idx + 1;
  };

  const normalized = headers.map((h) => normalize(h));
  const findCol = (needles) => normalized.findIndex((h) => needles.some((n) => h.includes(n)));

  // SLDC template structure:
  // Block,Block Interval,<Plant Header>,
  // ,,Availability,Forecast
  // 1,00:00-00:15,20,3.5
  const blockHeaderIdx = findCol(['block']);
  const blockIntervalIdx = findCol(['blockinterval']);
  if (blockHeaderIdx === 0 && blockIntervalIdx === 1) {
    let dataStart = 0;
    let forecastCol = 3;
    if (rows.length > 0) {
      const firstRowNormalized = (rows[0] || []).map((v) => normalize(v));
      const firstRowForecastCol = firstRowNormalized.findIndex((h) => h.includes('forecast'));
      const looksLikeSubHeader =
        firstRowForecastCol >= 0 ||
        (firstRowNormalized[0] === '' && firstRowNormalized[1] === '' && firstRowNormalized[2]?.includes('availability'));
      if (looksLikeSubHeader) {
        dataStart = 1;
        if (firstRowForecastCol >= 0) forecastCol = firstRowForecastCol;
      }
    }

    const map = new Map();
    rows.slice(dataStart).forEach((cols, idx) => {
      const block = parseBlock(cols?.[0], idx);
      if (!Number.isFinite(block) || block < 1 || block > 96) return;
      const forecast = parseNum(cols?.[forecastCol]);
      map.set(block, normalizeValue(forecast));
    });
    return map;
  }

  const blockIdx = findCol(['block', 'blk', 'blockno']);
  const algoIdx = findCol(['algoschedulemw', 'algoschedule', 'scheduledmw', 'schedule']);
  const forecastIdx = findCol(['forecastmw', 'forecast']);
  const stationScheduleIdx = findCol(['stationschedule', 'station_schedule', 'station']);
  const intradayIdx = findCol(['intradayforecastmw', 'intradayforecast', 'intraday']);
  const fallbackValIdx = normalized.findIndex((h, idx) => idx !== blockIdx && (h.includes('mw') || h.includes('value')));

  const map = new Map();
  const preferForecast = Boolean(options.preferForecast);
  rows.forEach((cols, idx) => {
    const safeBlock = parseBlock(cols?.[blockIdx], idx);
    if (!Number.isFinite(safeBlock) || safeBlock < 1 || safeBlock > 96) return;

    // Prefer algo_schedule_mw for schedule template Forecast column.
    let value = preferForecast ? parseNum(cols?.[forecastIdx]) : parseNum(cols?.[algoIdx]);
    if (!Number.isFinite(value)) {
      value = preferForecast ? parseNum(cols?.[stationScheduleIdx]) : parseNum(cols?.[stationScheduleIdx]);
    }
    if (!Number.isFinite(value)) {
      value = preferForecast ? parseNum(cols?.[algoIdx]) : parseNum(cols?.[forecastIdx]);
    }
    if (!Number.isFinite(value)) value = parseNum(cols?.[intradayIdx]);
    if (!Number.isFinite(value)) value = parseNum(cols?.[fallbackValIdx]);
    map.set(safeBlock, normalizeValue(value));
  });

  return map;
}

function blockToInterval(block) {
  const idx = Math.max(0, Number(block) - 1);
  const fromMins = idx * 15;
  const toMins = (idx + 1) * 15;
  const fmt = (mins) => {
    const hh = Math.floor(mins / 60) % 24;
    const mm = mins % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };
  return `${fmt(fromMins)}-${fmt(toMins)}`;
}

function extractRevisionFromKey(sourceKey) {
  const m = String(sourceKey || '').match(/schedule_(?:free(?:z|ze)_)?from_(\d+)\.csv$/i);
  return m ? Number.parseInt(m[1], 10) : null;
}

function computeOrderedScheduleRevisionMap(files, { dayAhead = false } = {}) {
  const normalized = (Array.isArray(files) ? files : [])
    .map((item) => {
      const key = String(item?.key || item || '').trim();
      const block = extractRevisionFromKey(key);
      return { key, block, dayAhead: isDayAheadKey(key) };
    })
    .filter((row) => row.key && Number.isFinite(row.block) && row.dayAhead === dayAhead);

  normalized.sort((a, b) => {
    if (a.block !== b.block) return a.block - b.block;
    return a.key.localeCompare(b.key);
  });

  const revisionByKey = new Map();
  let lastBlock = null;
  let revision = 0;
  for (const row of normalized) {
    if (row.block !== lastBlock) {
      revision += 1;
      lastBlock = row.block;
    }
    revisionByKey.set(row.key, revision);
  }
  return revisionByKey;
}

function resolveOrderedTemplateRevisionFromFiles({
  sourceKey,
  revisionSourceKey = '',
  primaryFiles = [],
  fallbackFiles = [],
}) {
  const lookupKey = String(revisionSourceKey || sourceKey || '').trim();
  const candidateKeys = Array.from(new Set([lookupKey, String(sourceKey || '').trim()].filter(Boolean)));
  const dayAhead = isDayAheadKey(lookupKey || sourceKey);

  const resolveFrom = (files) => {
    const revisionByKey = computeOrderedScheduleRevisionMap(files, { dayAhead });
    for (const key of candidateKeys) {
      if (revisionByKey.has(key)) return revisionByKey.get(key);
    }

    const targetBlock = extractRevisionFromKey(lookupKey || sourceKey);
    if (!Number.isFinite(targetBlock)) return null;

    const uniqueBlocks = Array.from(
      new Set(
        (Array.isArray(files) ? files : [])
          .map((item) => {
            const key = String(item?.key || item || '').trim();
            if (!key || isDayAheadKey(key) !== dayAhead) return null;
            return extractRevisionFromKey(key);
          })
          .filter((value) => Number.isFinite(value))
      )
    ).sort((a, b) => a - b);

    const position = uniqueBlocks.findIndex((value) => value === targetBlock);
    return position >= 0 ? position + 1 : null;
  };

  const primaryRevision = resolveFrom(primaryFiles);
  if (Number.isFinite(primaryRevision) && primaryRevision > 0) return primaryRevision;

  const fallbackRevision = resolveFrom(fallbackFiles);
  if (Number.isFinite(fallbackRevision) && fallbackRevision > 0) return fallbackRevision;

  return 1;
}

function formatSldcPlantHeader(plantCode) {
  if (plantCode === 'GSNP') return 'GLOBUS STEEL N POWER';
  if (plantCode === 'SIRMOUR') return '5.1MW M/s SIRMOUR SMALL HYDRO POWER PVT LTD';
  if (plantCode === 'ANJANGAON') return 'M/s Physis Solar One Pvt Ltd Anjangaon';
  if (plantCode === 'BAMKHAL') return 'M/s Physis Solar Power Two Pvt Ltd BAMKHAL';
  return plantCode || 'PLANT';
}

function resolveCapacityByPlant({ plantCode, plantName, plantCapacity }) {
  const code = String(plantCode || '').trim().toUpperCase();
  // Enforce known site capacities first to avoid wrong backend values.
  if (FALLBACK_CAPACITY_BY_CODE[code] !== undefined) return Number(FALLBACK_CAPACITY_BY_CODE[code]);

  const parsedCapacity = Number(plantCapacity);
  if (Number.isFinite(parsedCapacity) && parsedCapacity > 0) return parsedCapacity;

  const normalizedName = String(plantName || '').trim().toLowerCase();
  if (normalizedName.includes('gsnp') || normalizedName.includes('globus steel')) return FALLBACK_CAPACITY_BY_CODE.GSNP;
  if (normalizedName.includes('sirmour')) return FALLBACK_CAPACITY_BY_CODE.SIRMOUR;
  if (normalizedName.includes('bamkhal')) return FALLBACK_CAPACITY_BY_CODE.BAMKHAL;
  return 0;
}

function isTelanganaPlantCode(plantCode) {
  return TELANGANA_PLANT_CODES.has(String(plantCode || '').trim().toUpperCase());
}

function isOseplPlantCode(plantCode) {
  return String(plantCode || '').trim().toUpperCase() === 'OSEPL';
}

function isCmePlantCode(plantCode) {
  return String(plantCode || '').trim().toUpperCase() === 'CME';
}

function isGsnpSirmourPlantCode(plantCode) {
  const code = String(plantCode || '').trim().toUpperCase();
  return code === 'GSNP' || code === 'SIRMOUR' || code === 'ANJANGAON' || code === 'BAMKHAL';
}

function resolveSldcPortalUrl(plantCode) {
  const code = String(plantCode || '').trim().toUpperCase();
  if (!code) return '';
  if (SLDC_PLANT_GROUPS.TELANGANA.has(code)) return SLDC_PORTALS.TELANGANA;
  if (SLDC_PLANT_GROUPS.MAHARASHTRA.has(code)) return SLDC_PORTALS.MAHARASHTRA;
  if (SLDC_PLANT_GROUPS.MADHYA_PRADESH.has(code)) return SLDC_PORTALS.MADHYA_PRADESH;
  return '';
}

function isGsnpSirmourCsvText(csvText) {
  const text = String(csvText || '').toUpperCase();
  return text.includes('GSNP') || text.includes('GLOBUS') || text.includes('SIRMOUR') || text.includes('ANJANGAON') || text.includes('BAMKHAL');
}

function formatTelanganaDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return raw;
}

function addDaysToDateKey(value, days) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  const base = new Date(`${raw}T00:00:00`);
  if (Number.isNaN(base.getTime())) return raw;
  base.setDate(base.getDate() + Number(days || 0));
  const year = base.getFullYear();
  const month = String(base.getMonth() + 1).padStart(2, '0');
  const day = String(base.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatTelanganaPlantName(plantCode, plantName) {
  const name = String(plantName || '').trim();
  if (name) return name;
  return String(plantCode || '').trim().toUpperCase();
}

function formatTelanganaCapacity(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '';
  const rounded = Math.round(num * 10) / 10;
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(1);
}

function formatSldcNumber(value, decimals = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '';
  const fixed = num.toFixed(decimals);
  return fixed.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (text.includes('"')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  if (text.includes(',') || text.includes('\n') || text.includes('\r')) {
    return `"${text}"`;
  }
  return text;
}

const TELANGANA_TEMPLATE_META = {
  BHUPALPALLY: {
    plantName: 'Singareni Collieries Company Limited-Chelpur',
    contractType: 'Mtoa',
    approvalNo: 'TSTRANSCO/21/2023-24',
    toUtility: 'SCCL(BPL-003, BPL-006, BPL-028)',
  },
  KASIPET: {
    plantName: 'Singareni Collieries Company Limited-Kasipet Mines',
    contractType: 'Lta',
    approvalNo: 'TSTRANSCO/20/2023-24',
    toUtility: 'SCCL(BPL-003, BPL-004, BPL-065)',
  },
  KOTHAGUDEM: {
    plantName: 'Singareni Collieries Company Limited-Sitarampatnam',
    contractType: 'Lta',
    approvalNo: 'TGTRANSCO/17/2024-25',
    toUtility:
      'General Manager, SCCL Mandamarri MCL-009,General Manager, SCCL Mandamarri MCL-022,General Manager, SCCL Ramagundam PDL-001,General Manager, SCCL RG3 area PDL-023,General Manager, SCCL Yellandu BKM-002, General Manager, SCCL sathupalli KMM-361.',
  },
};

const VEDANJAY_META = {
  CME: {
    schedulingEntity: 'MH_VEDANJAY',
    posName: 'VSNL Dighi 220kV',
    downStreamName: 'VSNL Dighi 220kV',
    energyType: 'SOLAR',
    contractId: 'CONTRACT21424',
    contractType: 'MTOA',
    exchangeType: 'NA',
    transactionType: 'INTRA',
    reGeneratorName: 'VSNL Dighi 220kV',
    path: 'A-B',
    buyerName: 'OA-MSEDCL',
    stuName: 'VSNL Dighi 220kV',
    approvalNumber: 'VSNLDighi/S/03/26/OA-MSEDCL',
    capacity: 4,
  },
  OSEPL: {
    schedulingEntity: 'MH_VEDANJAY',
    posName: 'Naldurg Inter 132kV',
    downStreamName: 'Naldurg Inter 132kV',
    energyType: 'SOLAR',
    contractId: 'CONTRACT00192',
    contractType: 'LTA',
    exchangeType: 'NA',
    transactionType: 'INTER',
    reGeneratorName: 'Naldurg Inter 132kV',
    path: 'WR-WR',
    buyerName: 'SOLAR_CSEB',
    stuName: 'Naldurg 132kV',
    approvalNumber: 'L_WR_2014_03',
    capacity: 20,
  },
};

function getTelanganaTemplateMeta(plantCode, plantName) {
  const code = String(plantCode || '').trim().toUpperCase();
  const meta = TELANGANA_TEMPLATE_META[code] || {};
  return {
    plantDisplayName: meta.plantName || formatTelanganaPlantName(code, plantName),
    contractType: meta.contractType || 'Mtoa',
    approvalNo: meta.approvalNo || '',
    toUtility: meta.toUtility || '',
  };
}

function buildAvcValueResolver(valuesMap) {
  const nonZeroBlocks = Array.from(valuesMap.entries())
    .filter(([, value]) => Number.isFinite(value) && value > 0)
    .map(([block]) => Number(block))
    .filter((block) => Number.isFinite(block))
    .sort((a, b) => a - b);

  if (!nonZeroBlocks.length) {
    return () => 0;
  }

  const first = nonZeroBlocks[0];
  const last = nonZeroBlocks[nonZeroBlocks.length - 1];
  return (block, capacity) => {
    const safeBlock = Number(block);
    if (!Number.isFinite(safeBlock)) return capacity;
    // Set AVC = 0 for all blocks before intraday starts (incl. 2 blocks before).
    if (safeBlock < first) return 0;
    // Set AVC = 0 for all blocks after intraday ends.
    if (safeBlock > last) return 0;
    return capacity;
  };
}

function isManualEditsKey(key) {
  return /^manual-edits\//i.test(String(key || '').trim());
}

function deriveManualEditsSiblingKey(key, targetFileName) {
  const text = String(key || '').trim();
  if (!text) return '';
  const parts = text.split('/').filter(Boolean);
  if (parts.length < 2) return '';
  parts[parts.length - 1] = targetFileName;
  return parts.join('/');
}


function inferTelanganaScheduleTypeFromKey(sourceKey) {
  const text = String(sourceKey || '').toLowerCase();
  if (
    text.includes('day-ahead') ||
    text.includes('dayahead') ||
    text.includes('day_ahead') ||
    text.includes('/day-ahead/') ||
    text.includes('/dayahead/') ||
    text.includes('/day_ahead/')
  ) {
    return 'dayahead';
  }
  return 'intraday';
}

function isDayAheadKey(sourceKey) {
  const text = String(sourceKey || '').toLowerCase();
  return (
    text.includes('/day-ahead/')
    || text.includes('/dayahead/')
    || text.includes('/day_ahead/')
    || /_da0\.csv$/i.test(text)
  );
}

function inferVedanjayMhRevisionLabelFromKey(sourceKey) {
  const text = String(sourceKey || '').trim();
  const lower = text.toLowerCase();
  const isDayAhead =
    /(?:\/day-ahead\/|\/dayahead\/|\/day_ahead\/)/i.test(lower)
    || /_da0\.csv$/i.test(lower)
    || /(?:^|[\/_-])da(?:[\/_-]|\d)/i.test(lower);
  return isDayAhead ? 'DA' : 'INTRADAY';
}

function buildSldcCsvText({ sourceKey, sourceText, plantCode, plantName, scheduleDate, capacityMw, revisionNumber }) {
  if (isTelanganaPlantCode(plantCode)) {
    const scheduleType = inferTelanganaScheduleTypeFromKey(sourceKey);
    const stationScheduleMap = parseSourceScheduleForecastMap(sourceText, { preferForecast: false });
    const capacity = Number.isFinite(Number(capacityMw)) ? Number(capacityMw) : 0;
    const resolveAvc = buildAvcValueResolver(stationScheduleMap);
    const dateValue = formatTelanganaDate(scheduleDate);
    const generatorName = 'Singareni';
    const meta = getTelanganaTemplateMeta(plantCode, plantName);
    const plantDisplayName = meta.plantDisplayName;
    const capacityDisplay = formatTelanganaCapacity(capacity);
    const blankRow = ',,,,,';
    const lines = [
      `Name of Generator,${csvEscape(generatorName)}`,
      `Plant name,${csvEscape(plantDisplayName)}`,
      `Capacity(MW),${csvEscape(capacityDisplay)}`,
      `Date,${csvEscape(dateValue)}`,
      `Type,${csvEscape(scheduleType)}`,
      blankRow,
      blankRow,
      `Contract Type,,,,,${csvEscape(meta.contractType)}`,
      `Approval No,,,,,${csvEscape(meta.approvalNo)}`,
      `To Utility,,,,,${csvEscape(meta.toUtility)}`,
      'Path,,,,,',
      `Block,Time Period,Forecast(MW),AvC(MW),Station Schedule,${csvEscape(capacityDisplay)}`,
    ];

    for (let block = 1; block <= 96; block += 1) {
      const timePeriod = blockToInterval(block);
      const stationSchedule = stationScheduleMap.get(block);
      const stationValue = formatSldcNumber(stationSchedule);
      const avcValue = resolveAvc(block, capacity);
      const avcText = formatSldcNumber(avcValue);
      const stationText = stationValue === '' ? '0' : stationValue;
      // For Telangana SLDC, duplicate Station Schedule into the last column (capacity/helper)
      lines.push(`${block},${timePeriod},,${avcText || '0'},${stationText},${stationText}`);
    }

    return lines.join('\n');
  }

  if (isOseplPlantCode(plantCode) || isCmePlantCode(plantCode)) {
    const meta = VEDANJAY_META[String(plantCode || '').trim().toUpperCase()] || {};
    const forecastMap = parseSourceScheduleForecastMap(sourceText);
    const revisionLabel = inferVedanjayMhRevisionLabelFromKey(sourceKey);
    const capacity = Number.isFinite(Number(meta.capacity))
      ? Number(meta.capacity)
      : Number.isFinite(Number(capacityMw))
        ? Number(capacityMw)
        : 0;
    const resolveAvc = buildAvcValueResolver(forecastMap);
    const lines = [
      `Schedule Template for MH_VEDANJAY and revision ${revisionLabel},,,`,
      ['', 'Scheduling entity', meta.schedulingEntity || 'MH_VEDANJAY', '']
        .map(csvEscape)
        .join(','),
      ['', 'Date', scheduleDate, '']
        .map(csvEscape)
        .join(','),
      ['', 'Revision No', revisionLabel, '']
        .map(csvEscape)
        .join(','),
      '',
      ['POS Name', meta.posName || '', meta.posName || '', meta.posName || '']
        .map(csvEscape)
        .join(','),
      ['Down Stream Name', '', '', meta.downStreamName || '']
        .map(csvEscape)
        .join(','),
      ['Energy Type', '', '', meta.energyType || '']
        .map(csvEscape)
        .join(','),
      ['Contract ID', '', '', meta.contractId || '']
        .map(csvEscape)
        .join(','),
      ['Contract Type', '', '', meta.contractType || '']
        .map(csvEscape)
        .join(','),
      ['Exchange Type', '', '', meta.exchangeType || '']
        .map(csvEscape)
        .join(','),
      ['Transaction Type', meta.transactionType || '', meta.transactionType || '', meta.transactionType || '']
        .map(csvEscape)
        .join(','),
      ['RE Generator Name', '', '', meta.reGeneratorName || '']
        .map(csvEscape)
        .join(','),
      ['Path', '', '', meta.path || '']
        .map(csvEscape)
        .join(','),
      ['Buyer Name', '', '', meta.buyerName || '']
        .map(csvEscape)
        .join(','),
      ['STU Name', '', '', meta.stuName || '']
        .map(csvEscape)
        .join(','),
      ['Approval Number', '', '', meta.approvalNumber || '']
        .map(csvEscape)
        .join(','),
      ['Capacity', capacity, capacity, capacity]
        .map(csvEscape)
        .join(','),
      'Block,Declared Forecast,Inter Avc,Schedule',
    ];

    for (let block = 1; block <= 96; block += 1) {
      const forecast = Number.isFinite(forecastMap.get(block)) ? forecastMap.get(block) : 0;
      const scheduleVal = forecast;
      const avcValue = resolveAvc(block, capacity);
      lines.push(`${block},${scheduleVal},${avcValue},${scheduleVal}`);
    }

    return lines.join('\n');
  }

  const forecastMap = parseSourceScheduleForecastMap(sourceText);
  const revision = plantCode === 'BAMKHAL' && isDayAheadKey(sourceKey)
    ? 0
    : Number.isFinite(Number(revisionNumber)) && Number(revisionNumber) > 0
    ? Math.trunc(Number(revisionNumber))
    : 1;
  const plantHeader = formatSldcPlantHeader(plantCode);
  const capacity = Number.isFinite(Number(capacityMw)) ? Number(capacityMw) : 0;
  const resolveAvc = buildAvcValueResolver(forecastMap);

  const lines = [
    'TYPE:,REG,,',
    `DATE:,${scheduleDate},,`,
    `REVISION:,${revision},,`,
    'REASON:,NA,,',
    `Block,Block Interval,${plantHeader},`,
    ',,Availability,Forecast',
  ];

  for (let block = 1; block <= 96; block += 1) {
    const forecast = Number.isFinite(forecastMap.get(block)) ? forecastMap.get(block) : 0;
    const avcValue = resolveAvc(block, capacity);
    lines.push(`${block},${blockToInterval(block)},${avcValue},${forecast}`);
  }

  return lines.join('\n');
}

function validateSldcPreviewRows(rows, capacityMw, options = {}) {
  const errors = [];
  const warnings = [];
  const allowBlankForecast = options.allowBlankForecast === true;

  if (!Array.isArray(rows) || rows.length === 0) {
    return { is_valid: false, errors: ['No rows generated for SLDC preview.'], warnings };
  }

  if (rows.length !== 96) {
    errors.push(`Expected 96 blocks but got ${rows.length}.`);
  }

  const seen = new Set();
  const capacity = Number(capacityMw);
  rows.forEach((row, idx) => {
    const block = Number.parseInt(row?.Block, 10);
    const forecastRaw = row?.Forecast;
    const forecast = Number.parseFloat(forecastRaw);
    const availability = Number.parseFloat(row?.Availability);
    const rowLabel = `Row ${idx + 1}`;

    if (!Number.isFinite(block) || block < 1 || block > 96) {
      errors.push(`${rowLabel}: invalid block number.`);
    } else if (seen.has(block)) {
      errors.push(`${rowLabel}: duplicate block ${block}.`);
    } else {
      seen.add(block);
    }

    if (!Number.isFinite(forecast)) {
      const isBlankForecast = forecastRaw === '' || forecastRaw === null || forecastRaw === undefined;
      if (!(allowBlankForecast && isBlankForecast)) {
        errors.push(`${rowLabel}: invalid forecast value.`);
      }
    }

    if (!Number.isFinite(availability)) {
      errors.push(`${rowLabel}: invalid availability value.`);
    }
  });

  if (Number.isFinite(capacity) && capacity > 0) {
    const overflow = rows.filter((r) => Number.parseFloat(r?.Forecast) > capacity * 2).length;
    if (overflow > 0) {
      warnings.push(`${overflow} block(s) have forecast above 2x plant capacity.`);
    }
  }

  return { is_valid: errors.length === 0, errors, warnings };
}

function sanitizeValidationAllowNegative(backendValidation, fallbackValidation) {
  const fallback = fallbackValidation || { is_valid: true, errors: [], warnings: [] };
  if (!backendValidation || typeof backendValidation !== 'object') return fallback;

  const errors = (Array.isArray(backendValidation.errors) ? backendValidation.errors : []).filter(
    (msg) => !String(msg || '').toLowerCase().includes('negative')
  );
  const warnings = (Array.isArray(backendValidation.warnings) ? backendValidation.warnings : []).filter(
    (msg) => !String(msg || '').toLowerCase().includes('negative')
  );

  return {
    is_valid: errors.length === 0,
    errors,
    warnings,
  };
}

async function buildPreviewFromSourceCsv({
  sourceKey,
  plantId,
  plantCode,
  plantName,
  scheduleDate,
  capacityMw,
  revisionNumber,
}) {
  const text = await fetchTextFromS3(sourceKey);
  const resolvedPlantCode = plantCode || 'GSNP';
  const resolvedDate = scheduleDate || String(sourceKey || '').match(/(\d{4}-\d{2}-\d{2})/)?.[1] || new Date().toISOString().split('T')[0];
  const resolvedCapacity = resolveCapacityByPlant({
    plantCode: resolvedPlantCode,
    plantName,
    plantCapacity: capacityMw,
  });
  const csvText = buildSldcCsvText({
    sourceKey,
    sourceText: text,
    plantCode: resolvedPlantCode,
    plantName,
    scheduleDate: resolvedDate,
    capacityMw: resolvedCapacity,
    revisionNumber,
  });

  const isTelangana = isTelanganaPlantCode(resolvedPlantCode);
  const isOsepl = isOseplPlantCode(resolvedPlantCode) || isCmePlantCode(resolvedPlantCode);
  const targetColumns = isTelangana
    ? ['Block', 'Time Period', 'Forecast(MW)', 'AvC(MW)', 'Station Schedule']
    : isOsepl
      ? ['Block', 'Declared Forecast', 'Inter Avc', 'Schedule']
      : ['Block', 'Block Interval', 'Availability', 'Forecast'];
  const lines = csvText.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) =>
    isTelangana
      ? line.trim().toLowerCase().startsWith('block,time period')
      : isOsepl
        ? line.trim().toLowerCase().startsWith('block,declared forecast')
        : line.trim().toLowerCase().startsWith('block,block interval')
  );
  const dataLines = headerIndex >= 0 ? lines.slice(headerIndex + 1) : lines;
  const transformedPreview = dataLines
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const cols = line.split(',');
      if (isTelangana) {
        const [block, timePeriod, forecastMw, avcMw, stationSchedule] = cols;
        return {
          Block: block ?? '',
          'Time Period': timePeriod ?? '',
          'Forecast(MW)': forecastMw ?? '',
          'AvC(MW)': avcMw ?? '',
          'Station Schedule': stationSchedule ?? '',
        };
      }
      if (isOsepl) {
        const [block, declaredForecast, interAvc, schedule] = cols;
        return {
          Block: block ?? '',
          'Declared Forecast': declaredForecast ?? '',
          'Inter Avc': interAvc ?? '',
          Schedule: schedule ?? '',
        };
      }
      const [block, blockInterval, availability, forecast] = cols;
      return {
        Block: block ?? '',
        'Block Interval': blockInterval ?? '',
        Availability: availability ?? '',
        Forecast: forecast ?? '',
      };
    });
  const validation = isTelangana
    ? validateSldcPreviewRows(
        transformedPreview.map((row) => ({
          Block: row.Block,
          Availability: row['AvC(MW)'],
          Forecast: row['Station Schedule'],
        })),
        resolvedCapacity,
        { allowBlankForecast: true }
      )
    : isOsepl
      ? validateSldcPreviewRows(
          transformedPreview.map((row) => ({
            Block: row.Block,
            Availability: row['Inter Avc'],
            Forecast: row.Schedule,
          })),
          resolvedCapacity
        )
      : validateSldcPreviewRows(transformedPreview, resolvedCapacity);

  return {
    plant_id: plantId,
    template_id: 'client_fallback_sldc_v1',
    template_version: '1.0.0',
    source_file_key: sourceKey,
    source_hash: 'client-fallback',
    canonical_row_count: transformedPreview.length,
    validation,
    target_columns: targetColumns,
    canonical_preview: [],
    transformed_preview: transformedPreview,
    sldc_metadata: {
      type: 'REG',
      date: resolvedDate,
      revision: resolvedPlantCode === 'BAMKHAL' && isDayAheadKey(sourceKey)
        ? 0
        : Number.isFinite(Number(revisionNumber)) && Number(revisionNumber) > 0
        ? Math.trunc(Number(revisionNumber))
        : 1,
      reason: 'NA',
      plant_header: formatSldcPlantHeader(resolvedPlantCode),
      capacity_mw: resolvedCapacity,
      template_format: isTelangana
        ? (inferTelanganaScheduleTypeFromKey(sourceKey) === 'dayahead' ? 'TELANGANA_DAYAHEAD' : 'TELANGANA_INTRADAY')
        : 'DEFAULT_SLDC',
    },
    download_csv_text: csvText,
  };
}

async function buildClientSldcPreview({
  selectedSourceKey,
  revisionSourceKey = '',
  selectedPlantId,
  selectedPlant,
  selectedDate,
  sourceFiles,
}) {
  const plantCode = resolvePlantCode(selectedPlant) || 'GSNP';
  const resolvedCapacity = resolveCapacityByPlant({
    plantCode,
    plantName: selectedPlant?.name,
    plantCapacity: selectedPlant?.capacity,
  });
  const revisionLookupKey = String(revisionSourceKey || selectedSourceKey || '').trim();
  const dayAhead = isDayAheadKey(revisionLookupKey || selectedSourceKey);
  let fallbackRevisionFiles = [];
  const hasOrderedPrimaryFiles = (Array.isArray(sourceFiles) ? sourceFiles : []).some((file) => {
    const key = String(file?.key || file || '').trim();
    return key && isDayAheadKey(key) === dayAhead && /schedule_from_\d+\.csv$/i.test(key);
  });
  if (!hasOrderedPrimaryFiles) {
    fallbackRevisionFiles = dayAhead
      ? await listDayAheadFilesFromS3(selectedDate, selectedPlant).catch(() => [])
      : await listLatestScheduleFilesFromS3(selectedDate, selectedPlant).catch(() => []);
    fallbackRevisionFiles = dedupeScheduleFiles(sortScheduleFiles(fallbackRevisionFiles), {
      preferredDate: selectedDate,
      plantCode,
    });
  }
  const revisionNumber = resolveOrderedTemplateRevisionFromFiles({
    sourceKey: selectedSourceKey,
    revisionSourceKey: revisionLookupKey,
    primaryFiles: sourceFiles,
    fallbackFiles: fallbackRevisionFiles,
  });

  return buildPreviewFromSourceCsv({
    sourceKey: selectedSourceKey,
    plantId: Number(selectedPlantId),
    plantCode,
    plantName: selectedPlant?.name,
    scheduleDate: selectedDate,
    capacityMw: resolvedCapacity,
    revisionNumber,
  });
}

function toCsvCell(value) {
  const text = String(value ?? '');
  if (text.includes('"') || text.includes(',') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function buildCsvBlobFromPreview(preview) {
  if (preview?.download_csv_text) {
    return new Blob([preview.download_csv_text], { type: 'text/csv;charset=utf-8;' });
  }
  const columns = Array.isArray(preview?.target_columns) ? preview.target_columns : [];
  const rows = Array.isArray(preview?.transformed_preview) ? preview.transformed_preview : [];
  if (!columns.length) throw new Error('No preview columns available to generate CSV.');

  const csvLines = [
    columns.map(toCsvCell).join(','),
    ...rows.map((row) => columns.map((c) => toCsvCell(row?.[c] ?? '')).join(',')),
  ];
  return new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
}

function formatDisplayDateTime(value) {
  const dt = value ? new Date(value) : new Date();
  if (Number.isNaN(dt.getTime())) return '-';
  return dt.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function getFileNameFromKey(key) {
  return String(key || '').split('/').pop() || '';
}

function readSldcTemplateMap() {
  try {
    const raw = localStorage.getItem(SLDC_TEMPLATE_MAP_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeSldcTemplateMap(nextMap) {
  localStorage.setItem(SLDC_TEMPLATE_MAP_STORAGE_KEY, JSON.stringify(nextMap || {}));
}

export function ScheduleTemplates({ context = null, onNavigate }) {
  const { user: currentUser } = useAuth();
  const workflowGuide = useWorkflowGuide();
  const today = new Date().toISOString().split('T')[0];
  const [selectedPlantId, setSelectedPlantId] = useState('');
  const [selectedDate, setSelectedDate] = useState(today);
  const [selectedSourceKey, setSelectedSourceKey] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const [plants, setPlants] = useState([]);
  const [sourceFiles, setSourceFiles] = useState([]);
  const [sourceFilesByPlantCode, setSourceFilesByPlantCode] = useState({});
  const [previewResult, setPreviewResult] = useState(null);
  const [generateResult, setGenerateResult] = useState(null);
  const [historyRows, setHistoryRows] = useState([]);
  const [localHistoryRows, setLocalHistoryRows] = useState([]);

  const [loadingPlants, setLoadingPlants] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [loadingGenerate, setLoadingGenerate] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [downloadingRunId, setDownloadingRunId] = useState(null);
  const [localDownloads, setLocalDownloads] = useState({});
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [downloadFormat, setDownloadFormat] = useState('xlsx');
  const [pendingDownloadAction, setPendingDownloadAction] = useState(null);
  const [hasAppliedReadinessContext, setHasAppliedReadinessContext] = useState(false);
  const [preferredSourceKey, setPreferredSourceKey] = useState('');
  const [autoPreviewRequested, setAutoPreviewRequested] = useState(false);
  const [autoGenerateRequested, setAutoGenerateRequested] = useState(false);
  const [autoConfirmUploadRequested, setAutoConfirmUploadRequested] = useState(false);
  const [readinessIsDayAhead, setReadinessIsDayAhead] = useState(false);
  const [isSldcReady, setIsSldcReady] = useState(false);
  const [showSldcConfirm, setShowSldcConfirm] = useState(false);
  const [confirmingSldc, setConfirmingSldc] = useState(false);

  const readReadinessContextFromUrl = () => {
    try {
      const params = new URLSearchParams(window.location.search || '');
      if (!params.has('fromReadiness')) return null;
      return {
        plantId: params.get('plantId') || '',
        plantName: params.get('plantName') || '',
        plantCode: params.get('plantCode') || '',
        sourceFileKey: params.get('sourceFileKey') || '',
        originSourceKey: params.get('originSourceKey') || '',
        manualRequestId: params.get('manualRequestId') || '',
        scheduleDate: params.get('scheduleDate') || '',
        fromReadiness: params.get('fromReadiness') === '1',
        autoPreview: params.get('autoPreview') === '1',
        autoGenerate: params.get('autoGenerate') === '1',
        autoConfirmUpload: params.get('autoConfirmUpload') === '1',
        isDayAhead: params.get('isDayAhead') === '1',
      };
    } catch {
      return null;
    }
  };

  const getEffectiveReadinessContext = () => {
    const urlContext = readReadinessContextFromUrl();
    if (urlContext) return urlContext;
    if (context?.fromReadiness) return context;
    return null;
  };

  const effectiveReadinessContext = getEffectiveReadinessContext();
  const readinessContextSourceKey = String(effectiveReadinessContext?.sourceFileKey || '').trim();
  const readinessContextOriginSourceKey = String(effectiveReadinessContext?.originSourceKey || '').trim();
  const readinessContextManualRequestId = String(effectiveReadinessContext?.manualRequestId || '').trim();
  const isFromReadiness = Boolean(effectiveReadinessContext?.fromReadiness);

  useEffect(() => {
    // If user arrived from the Preparation/Readiness flow, start/restore the guided workflow at Templates.
    if (!isFromReadiness) return;
    if (workflowGuide?.active) return;
    workflowGuide?.start?.('tmpl_convert');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFromReadiness]);
  const readinessContextResetKey = [
    isFromReadiness ? '1' : '0',
    String(effectiveReadinessContext?.plantId || '').trim(),
    String(effectiveReadinessContext?.plantCode || '').trim(),
    String(effectiveReadinessContext?.plantName || '').trim(),
    String(effectiveReadinessContext?.scheduleDate || '').trim(),
    readinessContextSourceKey,
    readinessContextOriginSourceKey,
    readinessContextManualRequestId,
    effectiveReadinessContext?.autoPreview ? '1' : '0',
    effectiveReadinessContext?.autoGenerate ? '1' : '0',
    effectiveReadinessContext?.autoConfirmUpload ? '1' : '0',
    effectiveReadinessContext?.isDayAhead ? '1' : '0',
  ].join('|');

  const selectedPlant = useMemo(
    () => plants.find((p) => String(p.id) === String(selectedPlantId)) || null,
    [plants, selectedPlantId]
  );
  const selectedPlantCode = useMemo(
    () => resolvePlantCode(selectedPlant),
    [selectedPlant]
  );
  const sldcPortalUrl = useMemo(
    () => resolveSldcPortalUrl(selectedPlantCode),
    [selectedPlantCode]
  );

  const intradayRunBySourceKey = useMemo(() => {
    const candidates = (sourceFiles || [])
      .filter((f) => {
        const key = String(f?.key || '');
        const isDayAhead = /(?:day-ahead|dayahead|day_ahead)/i.test(key);
        if (isDayAhead) return false;
        const fileName = getFileNameFromKey(key);
        return /schedule_(?:free(?:z|ze)_)?from_\d+\.csv$/i.test(fileName);
      })
      .map((f) => ({ key: String(f?.key || '').trim() }));
    return computeIntradayRunIndexByKey(candidates);
  }, [sourceFiles]);

  const canPreview = Boolean(selectedPlantId && selectedDate && selectedSourceKey) && !loadingPreview;
  const canGenerate = canPreview && Boolean(previewResult?.validation?.is_valid) && !loadingGenerate;

  useEffect(() => {
    // The app keeps screens mounted. Reset one-time readiness application whenever
    // a new readiness context arrives so source dropdown and context banner stay aligned.
    setHasAppliedReadinessContext(false);
    if (!isFromReadiness) {
      setPreferredSourceKey('');
      setAutoPreviewRequested(false);
      setAutoGenerateRequested(false);
      setAutoConfirmUploadRequested(false);
      setReadinessIsDayAhead(false);
    }
  }, [readinessContextResetKey, isFromReadiness]);

  const appendLocalHistory = (row) => {
    setLocalHistoryRows((prev) => [row, ...prev.filter((r) => r.id !== row.id)]);
  };

  const persistGeneratedTemplate = ({ sourceFileKey, templateFileName, csvText, plantId, plantName }) => {
    if (!sourceFileKey || !templateFileName) return;
    const prev = readSldcTemplateMap();
    prev[sourceFileKey] = {
      source_file_key: sourceFileKey,
      template_file_name: templateFileName,
      csv_text: String(csvText || ''),
      plant_id: plantId ?? null,
      plant_name: plantName || '',
      generated_at: new Date().toISOString(),
    };
    writeSldcTemplateMap(prev);
  };

  const loadPlants = async () => {
    setLoadingPlants(true);
    try {
      const [plantsResult, activeResult] = await Promise.allSettled([
        api.plants.getAll({}),
        templateTransformApi.getActivePlants(),
      ]);
      const plantPayload = plantsResult.status === 'fulfilled' ? plantsResult.value : null;
      const rows = Array.isArray(plantPayload?.plants) ? plantPayload.plants : [];
      const activePlantIds = activeResult.status === 'fulfilled'
        ? (Array.isArray(activeResult.value?.plant_ids)
          ? activeResult.value.plant_ids.map((id) => Number(id))
          : [])
        : [];
      const activePlantNames = activeResult.status === 'fulfilled'
        ? (Array.isArray(activeResult.value?.plant_names) ? activeResult.value.plant_names : [])
        : [];
      const activeNameSet = new Set(activePlantNames.map((name) => normalizePlantName(name)));

      let finalPlants = rows.length ? rows : FALLBACK_PLANTS;
      if (activePlantIds.length > 0) {
        finalPlants = finalPlants.filter((p) => {
          if (activePlantIds.includes(Number(p.id))) return true;
          if (activeNameSet.size === 0) return false;
          const plantKey = normalizePlantName(p?.name);
          return plantKey && activeNameSet.has(plantKey);
        });
      } else {
        finalPlants = finalPlants.filter((p) => isSupportedPlant(p));
      }
      if (!finalPlants.length) {
        finalPlants = rows.length ? rows : FALLBACK_PLANTS;
        toast.warning('No active template plants detected. Showing all plants.');
      }
      // If coming from Readiness, ensure the target plant is present even if not in active list.
      const readinessContext = isFromReadiness ? getEffectiveReadinessContext() : null;
      if (isFromReadiness && readinessContext) {
        const normalizeCode = (value) => {
          const text = String(value || '').trim().toUpperCase();
          if (!text) return '';
          if (text.includes('SIRMOUR') || text.includes('SHRIMOUR') || text.includes('SHROMOUR')) return 'SIRMOUR';
          if (text.includes('BAMKHAL')) return 'BAMKHAL';
          if (text.includes('GSNP') || text.includes('GLOBUS')) return 'GSNP';
          if (text.includes('BHUPALPALLY')) return 'BHUPALPALLY';
          if (text.includes('KASIPET')) return 'KASIPET';
          if (text.includes('KILAJ')) return 'KILAJ';
          if (text.includes('KOTHAGUDEM')) return 'KOTHAGUDEM';
          if (text.includes('OSEPL')) return 'OSEPL';
          if (text.includes('CME')) return 'CME';
          return text;
        };
        const desiredCode = normalizeCode(readinessContext?.plantCode || readinessContext?.plantName);
        if (desiredCode) {
          const already = finalPlants.some((p) => String(resolvePlantCode(p) || '').trim().toUpperCase() === desiredCode);
          if (!already) {
            const fromRows = rows.find((p) => String(resolvePlantCode(p) || '').trim().toUpperCase() === desiredCode);
            const fromFallback = FALLBACK_PLANTS.find((p) => String(resolvePlantCode(p) || '').trim().toUpperCase() === desiredCode);
            const target = fromRows || fromFallback;
            if (target) {
              finalPlants = [...finalPlants, target];
            }
          }
        }
      }

      // Always include MP simple-template plants in the template plant dropdown.
      const hardcodedPlantCodes = ['ANJANGAON', 'BAMKHAL'];
      const hardcodedAlready = finalPlants.some(
        (p) => hardcodedPlantCodes.includes(String(resolvePlantCode(p) || '').trim().toUpperCase())
      );
      if (!hardcodedAlready) {
        const targets = hardcodedPlantCodes
          .map((code) => (
            rows.find((p) => String(resolvePlantCode(p) || '').trim().toUpperCase() === code) ||
            FALLBACK_PLANTS.find((p) => String(resolvePlantCode(p) || '').trim().toUpperCase() === code)
          ))
          .filter(Boolean);
        if (targets.length) finalPlants = [...finalPlants, ...targets];
      }

      finalPlants = filterPlantsForUser(finalPlants, currentUser);
      setPlants(finalPlants);

      const hasCurrentSelection = finalPlants.some((p) => String(p.id) === String(selectedPlantId));
      if ((!selectedPlantId || !hasCurrentSelection) && finalPlants.length > 0) {
        if (isFromReadiness && readinessContext) {
          const normalizeCode = (value) => {
            const text = String(value || '').trim().toUpperCase();
            if (!text) return '';
            if (text.includes('SIRMOUR') || text.includes('SHRIMOUR') || text.includes('SHROMOUR')) return 'SIRMOUR';
            if (text.includes('BAMKHAL')) return 'BAMKHAL';
            if (text.includes('GSNP') || text.includes('GLOBUS')) return 'GSNP';
            if (text.includes('BHUPALPALLY')) return 'BHUPALPALLY';
            if (text.includes('KASIPET')) return 'KASIPET';
            if (text.includes('KILAJ')) return 'KILAJ';
            if (text.includes('KOTHAGUDEM')) return 'KOTHAGUDEM';
            if (text.includes('OSEPL')) return 'OSEPL';
            if (text.includes('CME')) return 'CME';
            return text;
          };
          const desiredCode = normalizeCode(readinessContext?.plantCode || readinessContext?.plantName);
          const desiredPlant = desiredCode
            ? finalPlants.find((p) => String(resolvePlantCode(p) || '').trim().toUpperCase() === desiredCode)
            : null;
          if (desiredPlant) {
            setSelectedPlantId(String(desiredPlant.id));
          } else {
            const gsnp = finalPlants.find((p) => String(p.name || '').trim().toLowerCase() === GSNP_NAME.toLowerCase());
            setSelectedPlantId(String((gsnp || finalPlants[0]).id));
          }
        } else {
          setSelectedPlantId('');
        }
      }

    } catch (error) {
      const fallbackPlants = FALLBACK_PLANTS.filter((p) => isSupportedPlant(p));
      setPlants(fallbackPlants);
      if (!selectedPlantId && fallbackPlants.length > 0) {
        setSelectedPlantId(String(fallbackPlants[0].id));
      }
      toast.warning('Plant API unavailable. Using GSNP/SIRMOUR fallback.');
    } finally {
      setLoadingPlants(false);
    }
  };

  const loadSourceFiles = async () => {
    if (!selectedDate) return;
    setLoadingFiles(true);
    setPreviewResult(null);
    setGenerateResult(null);
    try {
      if (!selectedPlantId) {
        setSourceFilesByPlantCode({});
        setSourceFiles([]);
        setSelectedSourceKey('');
        return;
      }
      const plantRef = selectedPlant || { code: selectedPlantCode };
      const plantKey = String(resolvePlantCode(plantRef) || selectedPlantCode || 'PLANT').toUpperCase();
      const allowedDayAheadDates = new Set([String(selectedDate || '').trim().toLowerCase()].filter(Boolean));

      // If user came from Schedule Preparation "Submit Changes" (manual-edits key),
      // show ONLY that fetched source key in the dropdown (not both system+edited, not other schedules).
      const manualContextKey = String(readinessContextSourceKey || preferredSourceKey || '').trim();
      if (isFromReadiness && manualContextKey && isManualEditsKey(manualContextKey)) {
        const onlyFiles = [{ key: manualContextKey, last_modified: '', _synthetic: true }];
        const nextMap = { [plantKey]: onlyFiles };
        setSourceFilesByPlantCode(nextMap);
        setSourceFiles(onlyFiles);
        setSelectedSourceKey(manualContextKey);
        return;
      }

      let files = [];
      try {
        const backendResult = await templateTransformApi.listSourceFiles(selectedDate, selectedPlantId);
        files = Array.isArray(backendResult?.files) ? backendResult.files : [];
        files = sortScheduleFiles(filterScheduleFilesByPlant(files, plantRef));
        files = files.filter((file) => isScheduleFromFileEntry(file));
        // Day-ahead should display for (and be sourced from) the selected operating date.
        files = files.filter((file) => {
          const key = String(file?.key || '').toLowerCase();
          if (!/(?:\/day-ahead\/|\/dayahead\/|\/day_ahead\/)/i.test(key)) return true;
          if (!allowedDayAheadDates.size) return false;
          return Array.from(allowedDayAheadDates).some((d) => key.includes(`/${d}/`));
        });
        if (files.length === 0) {
          files = await listLatestScheduleFilesFromS3(selectedDate, plantRef);
        }
      } catch (backendError) {
        files = await listLatestScheduleFilesFromS3(selectedDate, plantRef);
      }

      const dayAheadPrimary = await listDayAheadFilesFromS3(selectedDate, plantRef).catch(() => []);

      // Directly opening Templates should show only machine schedules + day-ahead schedules (no frozen edited/system).
      files = sortScheduleFiles([...files, ...dayAheadPrimary])
        .filter((file) => isScheduleFromFileEntry(file));
      files = dedupeScheduleFiles(files, { preferredDate: selectedDate, plantCode: plantKey });

      const nextMap = { [plantKey]: files };
      setSourceFilesByPlantCode(nextMap);

      const currentRows = nextMap[plantKey] || [];
      setSourceFiles(currentRows);
      setSelectedSourceKey((prev) => {
        return pickPreferredSourceFile(currentRows, {
          plantCode: plantKey,
          preferredDate: selectedDate,
          previousKey: prev,
          preferredSourceKey,
        });
      });
      if (plantKey && currentRows.length === 0) {
        toast.warning(`No schedule_from_*.csv found for ${plantKey} on ${selectedDate}.`);
      }
    } catch (error) {
      toast.error(`Failed to load source files: ${error.message || 'Unknown error'}`);
    } finally {
      setLoadingFiles(false);
    }
  };

  const loadHistory = async () => {
    setLoadingHistory(true);
    try {
      const result = await templateTransformApi.history({
        plantId: selectedPlantId ? Number(selectedPlantId) : null,
        runDate: selectedDate || null,
        status: statusFilter || null,
        limit: 50,
      });
      setHistoryRows(Array.isArray(result?.items) ? result.items : []);
    } catch (error) {
      toast.error(`Failed to load history: ${error.message || 'Unknown error'}`);
    } finally {
      setLoadingHistory(false);
    }
  };

  const onPreview = async () => {
    if (!canPreview) return;
    setLoadingPreview(true);
    setGenerateResult(null);
    setIsSldcReady(false);
    try {
      const fallbackPreview = await buildClientSldcPreview({
        selectedSourceKey,
        revisionSourceKey: readinessContextOriginSourceKey || preferredSourceKey || selectedSourceKey,
        selectedPlantId,
        selectedPlant,
        selectedDate,
        sourceFiles,
      });

      const result = await templateTransformApi.preview({
        plant_id: Number(selectedPlantId),
        date: selectedDate,
        source_file_key: selectedSourceKey,
        revision_source_key: readinessContextOriginSourceKey || preferredSourceKey || selectedSourceKey,
        requested_by: getEmployeeName(currentUser?.empId || currentUser?.username),
      });
      // Keep backend validation/source metadata, but use deterministic client SLDC layout.
      const normalizedResult = {
        ...result,
        transformed_preview: fallbackPreview.transformed_preview,
        target_columns: fallbackPreview.target_columns,
        canonical_row_count: fallbackPreview.canonical_row_count,
        sldc_metadata: fallbackPreview.sldc_metadata,
        download_csv_text: fallbackPreview.download_csv_text,
        validation: sanitizeValidationAllowNegative(result?.validation, fallbackPreview.validation),
      };
      setPreviewResult(normalizedResult);
      if (result?.validation?.is_valid) toast.success('Preview completed: validation passed.');
      else toast.warning('Preview completed: validation failed.');
      if (workflowGuide?.isStep?.('tmpl_convert')) workflowGuide.setStep('tmpl_download');
      appendLocalHistory({
        id: `local-preview-${Date.now()}`,
        created_at: new Date().toISOString(),
        plant_id: Number(selectedPlantId),
        template_id: normalizedResult?.template_id || 'client_fallback_sldc_v1',
        template_version: normalizedResult?.template_version || '1.0.0',
        status: normalizedResult?.validation?.is_valid ? 'PREVIEW_VALID' : 'PREVIEW_FAILED',
        source_file_key: selectedSourceKey,
        output_file_key: '-',
        metadata: normalizedResult?.sldc_metadata || null,
      });
      await loadHistory();
    } catch (error) {
      const errorText = String(error?.message || error?.detail || '').toLowerCase();
      const shouldFallback =
        error?.status === 404 ||
        error?.status === 400 ||
        errorText.includes('no active template');

      if (shouldFallback && selectedSourceKey) {
        try {
          const fallbackPreview = await buildClientSldcPreview({
            selectedSourceKey,
            revisionSourceKey: readinessContextOriginSourceKey || preferredSourceKey || selectedSourceKey,
            selectedPlantId,
            selectedPlant,
            selectedDate,
            sourceFiles,
          });
          setPreviewResult(fallbackPreview);
          appendLocalHistory({
            id: `local-preview-${Date.now()}`,
            created_at: new Date().toISOString(),
            plant_id: Number(selectedPlantId),
            template_id: fallbackPreview?.template_id || 'client_fallback_sldc_v1',
            template_version: fallbackPreview?.template_version || '1.0.0',
            status: fallbackPreview?.validation?.is_valid ? 'PREVIEW_VALID' : 'PREVIEW_FAILED',
            source_file_key: selectedSourceKey,
            output_file_key: '-',
            metadata: fallbackPreview?.sldc_metadata || null,
          });
          toast.warning('Preview API unavailable for this plant. Showing client-side preview from S3.');
          return;
        } catch (fallbackError) {
          toast.error(`Preview fallback failed: ${fallbackError.message || 'Unknown error'}`);
          return;
        }
      }
      toast.error(`Preview failed: ${error.message || 'Unknown error'}`);
    } finally {
      setLoadingPreview(false);
    }
  };

  const downloadCsvOrXlsxFromText = async (csvText, filename, format, sheetName = 'Template', options = {}) => {
    const base = String(filename || 'template').replace(/\.(csv|xlsx|xls)$/i, '');
    const { useTelanganaStyling = false, useVedanjayMhStyling = false } = options;
    const inferredCode = derivePlantCodeFromKey(filename || '');
    const codeForSheet = String(inferredCode || '').trim().toUpperCase();
    const resolvedSheetName = codeForSheet === 'ANJANGAON' || codeForSheet === 'BAMKHAL' ? 'REG' : sheetName;
    const forceTelanganaStyling =
      useTelanganaStyling
      || isTelanganaPlantCode(inferredCode)
      || isTelanganaTemplateCsvText(csvText);
    const forceGsnpSirmourStyling =
      isGsnpSirmourPlantCode(inferredCode)
      || isGsnpSirmourCsvText(csvText);
    if (format === 'xlsx') {
      if (forceTelanganaStyling) {
        await downloadTelanganaTemplateFromBaseXlsx(csvText, base, resolvedSheetName);
      } else if (forceGsnpSirmourStyling) {
        await downloadGsnpSirmourXlsx(csvText, base, resolvedSheetName);
      } else if (useVedanjayMhStyling) {
        await downloadVedanjayMhXlsx(csvText, base, resolvedSheetName);
      } else {
        await downloadXlsxFromCsvText(csvText, base, resolvedSheetName, { forceString: true });
      }
    } else {
      const normalizedCsvText = useVedanjayMhStyling ? normalizeVedanjayMhCsvText(csvText) : csvText;
      downloadCsvText(normalizedCsvText, base);
    }
  };

  const downloadFromBlobWithFormat = async (blob, filename, format, sheetName = 'Template', options = {}) => {
    const base = String(filename || 'template').replace(/\.(csv|xlsx|xls)$/i, '');
    const lowerName = String(filename || '').toLowerCase();
    const isXlsx = lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls');
    const { useTelanganaStyling = false, useVedanjayMhStyling = false } = options;
    const inferredCode = derivePlantCodeFromKey(filename || '');
    const forceTelanganaStyling = useTelanganaStyling || isTelanganaPlantCode(inferredCode);
    const forceGsnpSirmourStyling = isGsnpSirmourPlantCode(inferredCode);
    if (format === 'xlsx') {
      if (isXlsx) {
        if (forceTelanganaStyling || forceGsnpSirmourStyling || useVedanjayMhStyling) {
          const csvText = await convertXlsxBlobToCsvText(blob);
          await downloadCsvOrXlsxFromText(csvText, base, 'xlsx', sheetName, options);
        } else {
          downloadBlob(blob, `${base}.xlsx`);
        }
      } else {
        const csvText = await blob.text();
        await downloadCsvOrXlsxFromText(csvText, base, 'xlsx', sheetName, options);
      }
      return;
    }
    if (isXlsx) {
      const csvText = await convertXlsxBlobToCsvText(blob);
      const normalizedCsvText = useVedanjayMhStyling ? normalizeVedanjayMhCsvText(csvText) : csvText;
      downloadCsvText(normalizedCsvText, base);
      return;
    }
    const csvText = await blob.text();
    const normalizedCsvText = useVedanjayMhStyling ? normalizeVedanjayMhCsvText(csvText) : csvText;
    downloadCsvText(normalizedCsvText, base);
  };

  const onGenerate = async (format = 'csv') => {
    if (!canGenerate) return;
    setLoadingGenerate(true);
    const sourceFileName = getFileNameFromKey(selectedSourceKey).replace(/\.csv$/i, '');
    const plantCode = resolvePlantCodeFromContext({
      selectedPlant,
      selectedPlantId,
      plants,
      selectedSourceKey,
      sourceFileName,
    }) || 'plant';
    const isTelanganaPlant = isTelanganaPlantCode(plantCode);
    const isVedanjayMh = isOseplPlantCode(plantCode) || isCmePlantCode(plantCode);
    const filename = `${plantCode}_${selectedDate}_${sourceFileName || 'source'}_sldc_template.csv`;
    try {
      const previewMatchesSource =
        previewResult &&
        String(previewResult?.source_file_key || '') === String(selectedSourceKey || '');
      const localPreview = previewMatchesSource ? previewResult : await buildClientSldcPreview({
        selectedSourceKey,
        revisionSourceKey: readinessContextOriginSourceKey || preferredSourceKey || selectedSourceKey,
        selectedPlantId,
        selectedPlant,
        selectedDate,
        sourceFiles,
      });
      const localBlob = buildCsvBlobFromPreview(localPreview);
      let localCsvText = localPreview?.download_csv_text || '';
      if (!localCsvText) {
        try {
          localCsvText = await localBlob.text();
        } catch {
          localCsvText = '';
        }
      }

      const result = await templateTransformApi.generate({
        plant_id: Number(selectedPlantId),
        date: selectedDate,
        source_file_key: selectedSourceKey,
        revision_source_key: readinessContextOriginSourceKey || preferredSourceKey || selectedSourceKey,
        requested_by: getEmployeeName(currentUser?.empId || currentUser?.username),
      });
      setGenerateResult(result);
      persistGeneratedTemplate({
        sourceFileKey: selectedSourceKey,
        templateFileName: filename,
        csvText: localCsvText,
        plantId: Number(selectedPlantId),
        plantName: selectedPlant?.name || '',
      });
      appendLocalHistory({
        id: String(result?.run_id || `local-generate-${Date.now()}`),
        created_at: new Date().toISOString(),
        plant_id: Number(selectedPlantId),
        template_id: result?.template_id || previewResult?.template_id || 'client_fallback_sldc_v1',
        template_version: result?.template_version || previewResult?.template_version || '1.0.0',
        status: 'GENERATED',
        source_file_key: selectedSourceKey,
        output_file_key: result?.output_file_key || filename,
        metadata: previewResult?.sldc_metadata || null,
      });
      toast.success('SLDC template generated successfully.');
      // Always download client-built SLDC CSV so Availability/Revision match dashboard rule.
      // Always generate XLSX on client for Telangana templates to ensure styling.
      if (format === 'xlsx' && isTelanganaPlant) {
        await downloadTelanganaTemplateFromBaseXlsx(localCsvText, String(filename || 'template').replace(/\.(csv|xlsx|xls)$/i, ''), 'SLDC Template');
      } else {
        await downloadCsvOrXlsxFromText(localCsvText, filename, format, 'SLDC Template', {
          useTelanganaStyling: isTelanganaPlant && format === 'xlsx',
          useVedanjayMhStyling: isVedanjayMh && format === 'xlsx',
        });
      }
      setIsSldcReady(true);
      if (workflowGuide?.isStep?.('tmpl_download')) workflowGuide.setStep('tmpl_upload');
      await loadHistory();
    } catch (error) {
      if ((error?.status === 404 || error?.status === 400) && previewResult) {
        try {
          const blob = buildCsvBlobFromPreview(previewResult);
          const runId = `local-${Date.now()}`;
          const csvText = previewResult?.download_csv_text || '';

          setLocalDownloads((prev) => ({ ...prev, [runId]: { blob, filename, csvText } }));
          persistGeneratedTemplate({
            sourceFileKey: selectedSourceKey,
            templateFileName: filename,
            csvText,
            plantId: Number(selectedPlantId),
            plantName: selectedPlant?.name || '',
          });
          setGenerateResult({
            run_id: runId,
            output_file_key: filename,
            status: 'GENERATED',
            template_id: previewResult?.template_id || 'client_fallback_v1',
            template_version: previewResult?.template_version || '1.0.0',
            validation: previewResult?.validation || { is_valid: true, errors: [], warnings: [] },
          });
          appendLocalHistory({
            id: runId,
            created_at: new Date().toISOString(),
            plant_id: Number(selectedPlantId),
            template_id: previewResult?.template_id || 'client_fallback_sldc_v1',
            template_version: previewResult?.template_version || '1.0.0',
            status: 'GENERATED',
            source_file_key: selectedSourceKey,
            output_file_key: filename,
            metadata: previewResult?.sldc_metadata || null,
          });

          await downloadCsvOrXlsxFromText(csvText, filename, format, 'SLDC Template', {
            useTelanganaStyling: isTelanganaPlant && format === 'xlsx',
            useVedanjayMhStyling: isVedanjayMh && format === 'xlsx',
          });

          toast.warning('Generated and downloaded using client-side fallback.');
          setIsSldcReady(true);
          return;
        } catch (fallbackError) {
          toast.error(`Generate fallback failed: ${fallbackError.message || 'Unknown error'}`);
          return;
        }
      }

      const detail = error?.data?.detail;
      const message = typeof detail === 'string' ? detail : (detail?.message || error.message || 'Generation failed');
      toast.error(message);
    } finally {
      setLoadingGenerate(false);
    }
  };

  const handleOpenSldcPortal = () => {
    if (!selectedPlantCode) {
      toast.info('Select plant first');
      return;
    }
    const url = resolveSldcPortalUrl(selectedPlantCode);
    if (!url) {
      toast.warning('No SLDC portal configured for the selected plant');
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const getCurrentTemplateEntry = () => {
    if (!selectedSourceKey) return null;
    const map = readSldcTemplateMap();
    return map?.[selectedSourceKey] || null;
  };

  const handleUploadToSldcClick = () => {
    if (!isFromReadiness) {
      toast.info('To upload to SLDC, start from Schedule Readiness → Upload (then Preparation → Templates).');
      return;
    }
    if (!isSldcReady) {
      toast.info('Generate the SLDC template first.');
      return;
    }
    if (!selectedPlantCode || !sldcPortalUrl) {
      handleOpenSldcPortal();
      return;
    }
    handleOpenSldcPortal();
    setShowSldcConfirm(true);
    if (workflowGuide?.isStep?.('tmpl_upload')) workflowGuide.setStep('tmpl_confirm');
  };

  const handlePreviewClick = () => {
    if (!selectedPlantId) {
      toast.info('First select Plant.');
      return;
    }
    if (!selectedSourceKey) {
      toast.info('First select Latest source file.');
      return;
    }
    if (!canPreview) {
      toast.info('Select Plant + Latest source file to convert.');
      return;
    }
    onPreview();
  };

  const handleDownloadClick = () => {
    if (!selectedPlantId || !selectedSourceKey) {
      toast.info('Select Plant + Latest source file first.');
      return;
    }
    if (!canGenerate) {
      toast.info('First convert to SLDC (Preview), then download.');
      return;
    }
    const rawCode = String(resolvePlantCode(selectedPlant) || selectedPlant?.code || selectedPlant?.name || '').trim().toUpperCase();
    const isOsepl = rawCode === 'OSEPL' || rawCode === 'OSEL';
    if (!isOsepl) {
      onGenerate('xlsx');
      return;
    }
    setPendingDownloadAction(() => (format) => onGenerate(format));
    // Require user to explicitly pick a format in the modal (avoid accidental CSV download).
    setDownloadFormat('');
    setShowDownloadModal(true);
    if (workflowGuide?.isStep?.('tmpl_download')) workflowGuide.setStep('tmpl_download_format');
  };

  const handleConfirmUploaded = async (options = {}) => {
    if (confirmingSldc) return;
    const entry = getCurrentTemplateEntry();
    if (!entry || !String(entry?.csv_text || '').trim()) {
      toast.error('Template CSV not found. Generate the SLDC template first.');
      return;
    }
    if (!selectedSourceKey) {
      toast.error('Select a source schedule first.');
      return;
    }
    const nowIso = new Date().toISOString();
    const plantCode = resolvePlantCodeFromContext({
      selectedPlant,
      selectedPlantId,
      plants,
      selectedSourceKey,
      sourceFileName: getFileNameFromKey(selectedSourceKey).replace(/\.csv$/i, ''),
    }) || 'PLANT';
    const templateFileName =
      String(entry?.template_file_name || '').trim()
      || `${plantCode}_${selectedDate}_sldc_template.csv`;

    setConfirmingSldc(true);
    try {
      const uploadSourceKey =
        readinessContextOriginSourceKey
        || String(selectedSourceKey || '').trim();
      const requestedByRaw =
        currentUser?.empId
        || currentUser?.username
        || currentUser?.email
        || currentUser?.name
        || currentUser?.displayName;
      const uploadResult = await scheduleReadinessApi.uploadConfirmedTemplate({
        plant_code: plantCode,
        schedule_date: selectedDate,
        template_file_name: templateFileName,
        csv_text: String(entry.csv_text || ''),
        // Important: use the original schedule_from_* key when available so Schedule Readiness can
        // mark the READY row as UPLOADED and move it out of the READY list.
        source_file_key: uploadSourceKey,
        manual_request_id: readinessContextManualRequestId || undefined,
        requested_by: getEmployeeName(requestedByRaw),
      });

      const storageMode = String(uploadResult?.storage_mode || '').trim().toLowerCase();
      const uploadFailedToS3 =
        storageMode === 'local' ||
        String(uploadResult?.message || '').toLowerCase().includes('local fallback');
      if (uploadFailedToS3) {
        toast.error(`S3 upload failed. ${uploadResult?.message || 'Template stored locally.'}`);
      } else {
        toast.success('SLDC upload confirmed and stored in cloud.');
      }

      // Update local readiness workflow so when the user returns to Schedule Readiness,
      // the READY row immediately appears under UPLOADED without waiting for a refresh.
      try {
        const workflowRaw = localStorage.getItem(READINESS_WORKFLOW_STORAGE_KEY);
        const workflow = workflowRaw ? JSON.parse(workflowRaw) : {};
        const now = new Date().toISOString();
        const uploadedAt = String(uploadResult?.uploaded_at || now).trim();
        const key = String(uploadSourceKey || '').trim();
        if (key) {
          workflow[key] = {
            ...(workflow[key] || {}),
            status: 'UPLOADED',
            uploaded_at: uploadedAt,
            updated_at: now,
            requested_by: getEmployeeName(currentUser?.empId || currentUser?.username),
          };
          localStorage.setItem(READINESS_WORKFLOW_STORAGE_KEY, JSON.stringify(workflow));
        }
      } catch {
        // Ignore storage errors; backend upload history will still reflect status.
      }

      // Close the modal immediately; run freeze in background so UI doesn't stay blocked.
      setConfirmingSldc(false);
      setShowSldcConfirm(false);

      // After upload confirmation, lock the upload workflow screens again to avoid accidental re-uploads.
      // The user can still review DSM/Comparison (unlocked by App workflow stage).
      try {
        localStorage.setItem(UI_WORKFLOW_STAGE_KEY, 'post-upload');
      } catch {
        // ignore storage errors
      }
      workflowGuide?.stop?.();
      onNavigate?.('schedule-readiness', { workflowEvent: 'sldc_confirmed' });

      const skipFreeze = Boolean(options?.skipFreeze);
      if (skipFreeze) {
        toast.info('Day-ahead submission captured (no frozen schedule generated).');
        return;
      }

      toast.info('Updating frozen schedule in background...');

      void (async () => {
        try {
          const freezePlantCode = String(plantCode || '').trim().toUpperCase();
          const freezeDateKey = String(selectedDate || '').trim();
          // Recompute from confirmed layers for both system and manual flows so behavior stays identical.
          const freezeResult = await recomputeFrozenForPlantDate(freezePlantCode, freezeDateKey);
          if (freezeResult?.success) {
            toast.success(`Frozen schedule updated for ${freezePlantCode} (${freezeDateKey}).`);
            return;
          }

          const reason = String(freezeResult?.reason || '').trim();
          if (freezeResult?.skipped) {
            toast.warning(`Frozen schedule not updated for ${freezePlantCode} (${freezeDateKey}): ${reason || 'skipped'}`);
            return;
          }

          throw new Error(reason || 'Unknown failure');
        } catch (freezeError) {
          // Keep UI flow resilient even if freeze fails, but surface the failure so ops can act.
          toast.error(
            `Frozen schedule update failed. ${
              freezeError?.message || 'Please retry or check backend logs.'
            }`
          );
        }
      })();
      return;
    } catch (error) {
      toast.error(error?.message || 'Failed to confirm SLDC upload');
    } finally {
      setConfirmingSldc(false);
      setShowSldcConfirm(false);
    }
  };

  const handleDownloadRun = async (runId, format = 'csv', row = null) => {
    if (!runId) return;
    setDownloadingRunId(runId);
    try {
      const resolvedCode = resolvePlantCodeFromHistoryRow(row)
        || resolvePlantCode(selectedPlant)
        || '';
      const isTelanganaSelection = isTelanganaPlantCode(resolvedCode);
      const isVedanjayMhSelection = isOseplPlantCode(resolvedCode) || isCmePlantCode(resolvedCode);
      if (localDownloads[runId]) {
        const { blob, filename, csvText } = localDownloads[runId];
        if (csvText && format !== 'csv') {
          await downloadCsvOrXlsxFromText(
            csvText,
            filename || `template_transform_run_${runId}.csv`,
            format,
            'SLDC Template',
            {
              useTelanganaStyling: isTelanganaSelection && format === 'xlsx',
              useVedanjayMhStyling: isVedanjayMhSelection && format === 'xlsx',
            }
          );
        } else if (csvText && format === 'csv') {
          await downloadCsvOrXlsxFromText(
            csvText,
            filename || `template_transform_run_${runId}.csv`,
            'csv',
            'SLDC Template'
          );
        } else if (blob) {
          await downloadFromBlobWithFormat(
            blob,
            filename || `template_transform_run_${runId}.csv`,
            format,
            'SLDC Template',
            {
              useTelanganaStyling: isTelanganaSelection && format === 'xlsx',
              useVedanjayMhStyling: isVedanjayMhSelection && format === 'xlsx',
            }
          );
        }
        return;
      }

      // Fallback for local run ids when in-memory blob map is not available
      if (String(runId).startsWith('local-') && previewResult) {
        const blob = buildCsvBlobFromPreview(previewResult);
        const plantCode = resolvePlantCode(selectedPlant) || 'plant';
        const filename = `${plantCode}_${selectedDate}_template.csv`;
        await downloadFromBlobWithFormat(blob, filename, format, 'SLDC Template', {
          useTelanganaStyling: isTelanganaSelection && format === 'xlsx',
          useVedanjayMhStyling: isVedanjayMhSelection && format === 'xlsx',
        });
        return;
      }

      const result = await templateTransformApi.downloadGenerated(runId);
      if (result.mode === 'url' && result.url) {
        const response = await fetch(result.url);
        if (!response.ok) throw new Error(`Failed to download file (${response.status})`);
        const blob = await response.blob();
        const filename = result.filename || `template_transform_run_${runId}.csv`;
        await downloadFromBlobWithFormat(blob, filename, format, 'SLDC Template', {
          useTelanganaStyling: isTelanganaSelection && format === 'xlsx',
          useVedanjayMhStyling: isVedanjayMhSelection && format === 'xlsx',
        });
        return;
      }

      if (result.mode === 'blob' && result.blob) {
        const filename = result.filename || `template_transform_run_${runId}.csv`;
        await downloadFromBlobWithFormat(result.blob, filename, format, 'SLDC Template', {
          useTelanganaStyling: isTelanganaSelection && format === 'xlsx',
          useVedanjayMhStyling: isVedanjayMhSelection && format === 'xlsx',
        });
        return;
      }

      toast.error('Download payload is invalid.');
    } catch (error) {
      toast.error(`Download failed: ${error.message || 'Unknown error'}`);
    } finally {
      setDownloadingRunId(null);
    }
  };

  useEffect(() => {
    loadPlants();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (hasAppliedReadinessContext || plants.length === 0) return;

    const effectiveContext = effectiveReadinessContext;
    if (!effectiveContext) return;

    const normalizeName = (value) =>
      String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
    const normalizeCode = (value) => {
      const text = String(value || '').trim().toUpperCase();
      if (!text) return '';
      if (text.includes('SIRMOUR') || text.includes('SHRIMOUR') || text.includes('SHROMOUR')) return 'SIRMOUR';
      if (text.includes('BAMKHAL')) return 'BAMKHAL';
      if (text.includes('GSNP') || text.includes('GLOBUS')) return 'GSNP';
      if (text.includes('BHUPALPALLY')) return 'BHUPALPALLY';
      if (text.includes('KASIPET')) return 'KASIPET';
      if (text.includes('KILAJ')) return 'KILAJ';
      if (text.includes('KOTHAGUDEM')) return 'KOTHAGUDEM';
      if (text.includes('OSEPL')) return 'OSEPL';
      if (text.includes('CME')) return 'CME';
      return text;
    };

    const contextPlantId = String(effectiveContext?.plantId || '').trim();
    const contextPlantNameRaw = String(effectiveContext?.plantName || '').trim();
    const contextPlantName = normalizeName(contextPlantNameRaw);
    const contextPlantCode = normalizeCode(effectiveContext?.plantCode);
    const sourceKey = String(effectiveContext?.sourceFileKey || '').trim();
    const keyMatch = sourceKey.match(/\/vedanjay\/([^/]+)\//i);
    const contextCodeFromKey = keyMatch?.[1] ? normalizeCode(keyMatch[1]) : '';
    const normalizedNameCode = normalizeCode(contextPlantNameRaw);
    let effectiveContextCode = contextPlantCode || normalizedNameCode || contextCodeFromKey;
    if (contextCodeFromKey && contextPlantCode && contextCodeFromKey !== contextPlantCode) {
      effectiveContextCode = contextCodeFromKey;
    }

    const matchingById = plants.find((p) => String(p.id) === contextPlantId);
    const matchingByName = plants.find((p) => normalizeName(p.name) === contextPlantName);
    const matchingByCode = effectiveContextCode
      ? plants.find((p) => String(resolvePlantCode(p) || '').trim().toUpperCase() === effectiveContextCode)
      : null;

    let matchedPlant = null;
    if (effectiveContext?.fromReadiness) {
      if (matchingByCode) {
        matchedPlant = matchingByCode;
      } else if (matchingByName) {
        matchedPlant = matchingByName;
      } else if (matchingById) {
        const idCode = normalizeCode(resolvePlantCode(matchingById) || matchingById?.name);
        if (!effectiveContextCode || idCode === effectiveContextCode) {
          matchedPlant = matchingById;
        }
      }
    } else {
      matchedPlant = matchingById || matchingByName || matchingByCode;
    }

    if (matchedPlant) {
      setSelectedPlantId(String(matchedPlant.id));
    }
    if (effectiveContext?.scheduleDate) {
      setSelectedDate(String(effectiveContext.scheduleDate));
    }
    if (effectiveContext?.sourceFileKey) {
      setPreferredSourceKey(String(effectiveContext.sourceFileKey));
    }
    if (effectiveContext?.autoPreview) {
      setAutoPreviewRequested(true);
    }
    if (effectiveContext?.autoGenerate) {
      setAutoGenerateRequested(true);
    }
    if (effectiveContext?.autoConfirmUpload) {
      setAutoConfirmUploadRequested(true);
    }
    if (effectiveContext?.isDayAhead) {
      setReadinessIsDayAhead(true);
    }

    if (effectiveContext?.fromReadiness) {
      toast.info('File received from Schedule Readiness. Review and convert to SLDC template.');
    }
    setHasAppliedReadinessContext(true);
  }, [hasAppliedReadinessContext, plants, readinessContextResetKey]);

  useEffect(() => {
    if (selectedDate && selectedPlantId) loadSourceFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate, selectedPlantId, preferredSourceKey]);

  useEffect(() => {
    setPreviewResult(null);
    setGenerateResult(null);
    setIsSldcReady(false);
    const rows = selectedPlantCode ? (sourceFilesByPlantCode[selectedPlantCode] || []) : [];
    const preferredKey = String(preferredSourceKey || '').trim();
    const hasPreferredInRows = preferredKey ? rows.some((r) => r.key === preferredKey) : false;
    const rowsWithPreferred = preferredKey && !hasPreferredInRows
      ? [{ key: preferredKey, last_modified: '', _synthetic: true }, ...rows]
      : rows;
    setSourceFiles(rowsWithPreferred);
    setSelectedSourceKey((prev) => {
      if (preferredKey) return preferredKey;
      return rowsWithPreferred.some((r) => r.key === prev) ? prev : rowsWithPreferred[0]?.key || '';
    });
  }, [selectedPlantCode, sourceFilesByPlantCode, preferredSourceKey]);

  useEffect(() => {
    setPreviewResult(null);
    setGenerateResult(null);
    setIsSldcReady(false);
  }, [selectedSourceKey]);

  useEffect(() => {
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPlantId, selectedDate, statusFilter]);

  useEffect(() => {
    if (!autoPreviewRequested) return;
    if (loadingFiles || loadingPreview) return;
    if (!selectedPlantId || !selectedDate || !selectedSourceKey) return;

    setAutoPreviewRequested(false);
    onPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPreviewRequested, loadingFiles, loadingPreview, selectedPlantId, selectedDate, selectedSourceKey]);

  useEffect(() => {
    if (!autoGenerateRequested) return;
    if (loadingGenerate || loadingPreview) return;
    if (!previewResult?.validation?.is_valid) return;

    setAutoGenerateRequested(false);
    toast.info('Preview passed. Click Download to choose format.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoGenerateRequested, loadingGenerate, loadingPreview, previewResult]);

  useEffect(() => {
    if (!autoConfirmUploadRequested) return;
    if (!isSldcReady) return;
    if (confirmingSldc) return;

    setAutoConfirmUploadRequested(false);
    // Keep behavior identical for day-ahead and intraday: always run the same confirm flow.
    handleConfirmUploaded();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConfirmUploadRequested, isSldcReady, confirmingSldc]);

  const previewRows = previewResult?.transformed_preview || [];
  const previewColumns = previewResult?.target_columns || [];
  const visiblePreviewWarnings = useMemo(
    () => (previewResult?.validation?.warnings || []).filter(
      (warn) => !String(warn || '').toLowerCase().includes('auto-filled')
    ),
    [previewResult]
  );
  const combinedHistoryRows = useMemo(() => {
    const allRows = [...localHistoryRows, ...historyRows];
    const filtered = statusFilter ? allRows.filter((r) => r?.status === statusFilter) : allRows;
    return filtered.sort((a, b) => {
      const at = Date.parse(a?.created_at || '');
      const bt = Date.parse(b?.created_at || '');
      return (Number.isNaN(bt) ? 0 : bt) - (Number.isNaN(at) ? 0 : at);
    });
  }, [localHistoryRows, historyRows, statusFilter]);

  const plantNameById = useMemo(() => {
    const map = new Map();
    plants.forEach((p) => map.set(String(p.id), p.name));
    return map;
  }, [plants]);

  return (
    <>
    <div className="flex-1 overflow-auto bg-background relative overflow-x-hidden">
      <div className="max-w-[1600px] mx-auto p-4 sm:p-6 space-y-6 w-full">
        <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/25">
              <FileText className="w-6 h-6 sm:w-7 sm:h-7 text-white" />
            </div>
            <h1 className="text-xl sm:text-2xl font-bold text-foreground">Schedule Templates</h1>
          </div>
        </div>

        {isFromReadiness && readinessContextSourceKey && (
          <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-4 text-sm text-foreground dark:text-amber-100">
            {`Selected file: ${readinessContextSourceKey}`}
          </div>
        )}

        <div className="rounded-xl border border-border bg-card p-4 sm:p-5 space-y-4">
          <div className="flex items-center gap-2 text-foreground font-semibold">
            <FileSearch className="w-4 h-4" />
            Conversion Inputs
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Plant Site</label>
              <div className="relative">
                <Building2 className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground" />
                <select
                  value={selectedPlantId}
                  onChange={(e) => setSelectedPlantId(e.target.value)}
                  className="w-full pl-8 pr-3 py-2 rounded-md border border-border bg-input-background text-foreground"
                  disabled={loadingPlants}
                >
                  <option value="">{loadingPlants ? 'Loading plants...' : 'Select plant'}</option>
                  {plants.map((plant) => (
                    <option key={plant.id} value={plant.id}>
                      {plant.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Schedule Date</label>
              <div className="relative">
                <CalendarDays className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground" />
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  className="w-full pl-8 pr-3 py-2 rounded-md border border-border bg-input-background text-foreground"
                />
              </div>
            </div>

            <div className="md:col-span-2">
              <label className="text-xs text-muted-foreground mb-1 block">Latest S3 Schedule File (Intraday/Day-ahead)</label>
              <div className="relative">
                <FileSpreadsheet className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground" />
                <select
                  value={selectedSourceKey}
                  onChange={(e) => setSelectedSourceKey(e.target.value)}
                  className="w-full pl-8 pr-3 py-2 rounded-md border border-border bg-input-background text-foreground"
                  disabled={loadingFiles}
                >
                  <option value="">{loadingFiles ? 'Loading source files...' : 'Select source file'}</option>
                  {sourceFiles.map((f) => (
                    <option key={f.key} value={f.key}>
                      {(() => {
                        const key = String(f.key || '');
                        const fileName = getFileNameFromKey(key);
                        const lower = key.toLowerCase();
                        const isDayAhead = /(?:day-ahead|dayahead|day_ahead)/i.test(key);
                        const scheduleDate = extractScheduleDateFromKey(key) || selectedDate;
                        const displayName = formatMachineScheduleDisplayName({
                          baseName: fileName,
                          key,
                          plantCodeOrName: selectedPlantCode || selectedPlant?.name,
                          scheduleDate,
                          isDayAhead,
                          intradayRunIndex: intradayRunBySourceKey.get(key),
                        });
                        if (isManualEditsKey(key)) return `${fileName} (Manual Request)`;
                        if (!isDayAhead && !/_da0\.csv$/i.test(key) && /schedule_from_\d+\.csv$/i.test(key)) {
                          return `${displayName} (Machine)`;
                        }
                        if (!isDayAhead && !/_da0\.csv$/i.test(key)) return displayName;
                        return `${displayName} (Day-ahead)`;
                      })()}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2">
            {(() => {
              const canUploadToSldc = Boolean(isFromReadiness && selectedPlantCode && isSldcReady);
              const convertDisabled = !selectedPlantId || !selectedSourceKey || !canPreview;
              const downloadDisabled = !selectedPlantId || !selectedSourceKey || !canGenerate;

              return (
                <>
            <button
              onClick={loadSourceFiles}
              disabled={loadingFiles}
              className={`w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2 rounded-md border border-border hover:bg-accent disabled:opacity-50 ${isSldcReady ? 'opacity-60' : ''}`}
            >
              <RefreshCw className={`w-4 h-4 ${loadingFiles ? 'animate-spin' : ''}`} />
              Refresh Latest S3
            </button>
            <button
              onClick={handlePreviewClick}
              aria-disabled={convertDisabled}
              data-guide-id="tmpl-convert"
              className={`w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground ${
                convertDisabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-primary/90'
              } ${isSldcReady ? 'opacity-60' : ''}`}
            >
              <Wand2 className={`w-4 h-4 ${loadingPreview ? 'animate-spin' : ''}`} />
              Convert to SLDC (Preview)
            </button>
            <button
              onClick={handleDownloadClick}
              aria-disabled={downloadDisabled}
              data-guide-id="tmpl-download"
              className={`w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2 rounded-md bg-success text-white ${
                downloadDisabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-success/90'
              } ${isSldcReady ? 'opacity-60' : ''}`}
            >
              <Download className={`w-4 h-4 ${loadingGenerate ? 'animate-spin' : ''}`} />
              Download
            </button>
            <button
              onClick={handleUploadToSldcClick}
              aria-disabled={!canUploadToSldc}
              data-guide-id="tmpl-upload"
              className={`w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2 rounded-md border ${
                canUploadToSldc
                  ? 'bg-success text-white border-success hover:bg-success/90 opacity-100'
                  : 'bg-success/10 text-success border-success/50 opacity-50 cursor-not-allowed'
              }`}
            >
              <ExternalLink className="w-4 h-4" />
              Upload to SLDC
            </button>
                </>
              );
            })()}
          </div>
          {!isSldcReady && (
            <p className="text-xs text-muted-foreground mt-2">
              Template not generated yet.
            </p>
          )}
          {sldcPortalUrl && (
            <p className="text-xs text-muted-foreground mt-2">
              SLDC Portal:{' '}
              <a
                href={sldcPortalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-2 hover:text-primary/80"
              >
                {sldcPortalUrl}
              </a>
            </p>
          )}

          {selectedPlant && (
            <p className="text-xs text-muted-foreground">
              Plant: {selectedPlant.name} | Type: {selectedPlant.type} | State: {selectedPlant.state}
            </p>
          )}
        </div>

        {previewResult && (
          <div className="rounded-xl border border-border bg-card p-4 sm:p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div className="font-semibold text-foreground">Converted Template Preview</div>
              <div className="text-xs text-muted-foreground">
                Template: {previewResult.template_id} v{previewResult.template_version}
              </div>
            </div>

            <div className="flex flex-wrap gap-3 sm:gap-4 text-xs sm:text-sm">
              <div className="inline-flex items-center gap-2">
                {previewResult.validation?.is_valid ? (
                  <CheckCircle className="w-4 h-4 text-success" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-destructive" />
                )}
                <span className="text-foreground">
                  Validation: {previewResult.validation?.is_valid ? 'PASS' : 'FAIL'}
                </span>
              </div>
              <div className="text-muted-foreground">Rows: {previewResult.canonical_row_count}</div>
              <div className="text-muted-foreground truncate max-w-[220px] sm:max-w-[700px]">Source: {previewResult.source_file_key}</div>
            </div>
            {!HIDE_METADATA && previewResult?.sldc_metadata && (
              <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                <p>
                  TYPE: {previewResult.sldc_metadata.type} | DATE: {previewResult.sldc_metadata.date} | REVISION: {previewResult.sldc_metadata.revision} | REASON: {previewResult.sldc_metadata.reason}
                </p>
                <p className="mt-1">
                  Plant Header: {previewResult.sldc_metadata.plant_header} | Availability: {previewResult.sldc_metadata.capacity_mw} MW
                </p>
              </div>
            )}

            {previewResult.validation?.errors?.length > 0 && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3">
                <p className="font-medium text-destructive mb-1">Validation Errors</p>
                {previewResult.validation.errors.map((err, idx) => (
                  <p key={`${err}-${idx}`} className="text-xs text-destructive">{err}</p>
                ))}
              </div>
            )}

            {visiblePreviewWarnings.length > 0 && (
              <div className="rounded-md border border-warning/30 bg-warning/10 p-3">
                <p className="font-medium text-warning mb-1">Validation Warnings</p>
                {visiblePreviewWarnings.map((warn, idx) => (
                  <p key={`${warn}-${idx}`} className="text-xs text-warning">{warn}</p>
                ))}
              </div>
            )}

            <div className="overflow-auto border border-border rounded-md">
              <table className="w-full text-xs">
                <thead className="bg-muted/40">
                  <tr>
                    {previewColumns.map((c) => (
                      <th key={c} className="text-left px-3 py-2 font-semibold text-white dark:text-white">{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row, rowIndex) => (
                    <tr key={`preview-row-${rowIndex}`} className="border-t border-border">
                      {previewColumns.map((c) => (
                        <td key={`${rowIndex}-${c}`} className="px-3 py-2 text-muted-foreground">
                          {String(row?.[c] ?? '')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="rounded-xl border border-border bg-card p-4 sm:p-5 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div className="inline-flex items-center gap-2 font-semibold text-foreground">
              <History className="w-4 h-4" />
              Conversion History
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="w-full sm:w-auto px-2 py-1 text-sm rounded border border-border bg-input-background"
              >
                <option value="">All Status</option>
                <option value="PREVIEW_VALID">PREVIEW_VALID</option>
                <option value="PREVIEW_FAILED">PREVIEW_FAILED</option>
                <option value="GENERATED">GENERATED</option>
              </select>
              <button
                onClick={loadHistory}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-1 px-3 py-1 rounded border border-border text-sm hover:bg-accent"
              >
                <RefreshCw className={`w-3 h-3 ${loadingHistory ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            </div>
          </div>

          <div className="overflow-auto border border-border rounded-md">
            <table className="w-full text-xs">
              <thead className="bg-muted/40">
                <tr>
                  <th className="text-left px-3 py-2 text-white dark:text-white">Time</th>
                  <th className="text-left px-3 py-2 text-white dark:text-white">Plant</th>
                  <th className="text-left px-3 py-2 text-white dark:text-white">Template</th>
                  <th className="text-left px-3 py-2 text-white dark:text-white">Status</th>
                  {!HIDE_METADATA && <th className="text-left px-3 py-2 text-white dark:text-white">Metadata</th>}
                  <th className="text-left px-3 py-2 text-white dark:text-white">Source</th>
                  <th className="text-left px-3 py-2 text-white dark:text-white">Output</th>
                </tr>
              </thead>
              <tbody>
                {combinedHistoryRows.length === 0 ? (
                  <tr>
                    <td className="px-3 py-3 text-muted-foreground" colSpan={HIDE_METADATA ? 6 : 7}>
                      {loadingHistory ? 'Loading history...' : 'No history rows'}
                    </td>
                  </tr>
                ) : (
                  combinedHistoryRows.map((row) => (
                    <tr key={row.id} className="border-t border-border">
                      <td className="px-3 py-2 text-muted-foreground">{formatDisplayDateTime(row.created_at)}</td>
                      <td className="px-3 py-2 text-foreground">{plantNameById.get(String(row.plant_id)) || row.plant_id}</td>
                      <td className="px-3 py-2 text-foreground">{row.template_id} v{row.template_version}</td>
                      <td className="px-3 py-2 text-foreground">{row.status}</td>
                      {!HIDE_METADATA && (
                        <td className="px-3 py-2 text-muted-foreground">
                          {row?.metadata ? (
                            <span>
                              TYPE:{row.metadata.type} | DATE:{row.metadata.date} | REV:{row.metadata.revision} | REASON:{row.metadata.reason}
                            </span>
                          ) : (
                            '-'
                          )}
                        </td>
                      )}
                      <td className="px-3 py-2 text-muted-foreground truncate max-w-[180px] sm:max-w-[320px]">{row.source_file_key}</td>
                      <td className="px-3 py-2">
                        {row.status === 'GENERATED' ? (
                          <button
                            onClick={() => {
                              const rawCode = String(resolvePlantCode(selectedPlant) || selectedPlant?.code || selectedPlant?.name || '').trim().toUpperCase();
                              const isOsepl = rawCode === 'OSEPL' || rawCode === 'OSEL';
                              if (!isOsepl) {
                                handleDownloadRun(row.run_id || row.id, 'xlsx', row);
                                return;
                              }
                              setPendingDownloadAction(() => (format) => handleDownloadRun(row.run_id || row.id, format, row));
                              setDownloadFormat('xlsx');
                              setShowDownloadModal(true);
                            }}
                            disabled={downloadingRunId === (row.run_id || row.id)}
                            className="text-primary hover:underline disabled:opacity-50"
                          >
                            {downloadingRunId === (row.run_id || row.id) ? 'Downloading...' : 'Download'}
                          </button>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
    {showSldcConfirm && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
        <div className="w-full max-w-md rounded-xl border border-border bg-card shadow-xl">
          <div className="border-b border-border px-5 py-4">
            <h3 className="text-base font-semibold text-foreground">Confirm SLDC Upload</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Is this schedule uploaded to SLDC for the selected plant?
            </p>
          </div>
          <div className="px-5 py-4 space-y-2 text-sm text-foreground">
            <div className="text-xs text-muted-foreground">
              Plant: {selectedPlant?.name || '-'}
            </div>
            <div className="text-xs text-muted-foreground">
              Date: {selectedDate || '-'}
            </div>
            <div className="text-xs text-muted-foreground truncate">
              Source: {getFileNameFromKey(selectedSourceKey) || '-'}
            </div>
          </div>
          <div className="flex gap-3 border-t border-border px-5 py-4">
            <button
              onClick={() => setShowSldcConfirm(false)}
              className="flex-1 rounded-md border border-border px-3 py-2 text-sm text-foreground hover:bg-accent"
              disabled={confirmingSldc}
            >
              Cancel
            </button>
            <button
              onClick={handleConfirmUploaded}
              data-guide-id="tmpl-confirm"
              className="flex-1 rounded-md bg-success px-3 py-2 text-sm font-semibold text-white hover:bg-success/90 disabled:opacity-60"
              disabled={confirmingSldc}
            >
              {confirmingSldc ? 'Confirming...' : 'Yes, Uploaded'}
            </button>
          </div>
        </div>
      </div>
    )}
    <DownloadFormatModal
      open={showDownloadModal}
      onClose={() => { setShowDownloadModal(false); setPendingDownloadAction(null); }}
      format={downloadFormat}
      formats={(() => {
        const rawCode = String(resolvePlantCode(selectedPlant) || selectedPlant?.code || selectedPlant?.name || '').trim().toUpperCase();
        const isOsepl = rawCode === 'OSEPL' || rawCode === 'OSEL';
        return isOsepl ? ['xlsx', 'csv'] : ['xlsx'];
      })()}
      onFormatChange={(next) => {
        setDownloadFormat(next);
        if (workflowGuide?.isStep?.('tmpl_download_format')) workflowGuide.setStep('tmpl_download_confirm');
      }}
      onDownload={() => {
        const rawCode = String(resolvePlantCode(selectedPlant) || selectedPlant?.code || selectedPlant?.name || '').trim().toUpperCase();
        const isOsepl = rawCode === 'OSEPL' || rawCode === 'OSEL';
        const allowedFormats = isOsepl ? ['xlsx', 'csv'] : ['xlsx'];
        if (!allowedFormats.includes(String(downloadFormat || '').trim().toLowerCase())) {
          toast.error('Select file format to download.');
          return;
        }
        if (pendingDownloadAction) {
          pendingDownloadAction(downloadFormat);
        }
        setShowDownloadModal(false);
        setPendingDownloadAction(null);
      }}
    />
    </>
  );
}

export default ScheduleTemplates;

