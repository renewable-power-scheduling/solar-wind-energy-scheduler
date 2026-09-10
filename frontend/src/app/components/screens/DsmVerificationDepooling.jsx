import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Download,
  Edit3,
  FileSpreadsheet,
  RefreshCw,
  Save,
  ShieldAlert,
  Upload,
  FileCheck2,
  FileText,
  CircleX,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { API_BASE_URL } from '@/config/appConfig';
import { getCurrentUserFromStorage } from '@/utils/plantAccess';

const GENERATOR_LABELS = {
  SPRNG: 'SPRNG',
  SEIT: 'SEIT',
  ATHENA: 'Athena',
};

const FILE_TYPES = {
  METER: 'METER',
  SPRNG_SCHEDULE: 'SPRNG_SCHEDULE',
  SEIT_SCHEDULE: 'SEIT_SCHEDULE',
  ATHENA_SCHEDULE: 'ATHENA_SCHEDULE',
  OFFICIAL_REFERENCE: 'OFFICIAL_REFERENCE',
};

const DSM_UPLOAD_ACCEPT = '.csv,.xlsx,.xlsm';
const DSM_REGULATION_OPTIONS = ['2014', '2026'];

function formatDisplayDate(isoDate) {
  if (!isoDate) return '-';
  const match = String(isoDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return isoDate;
  const [, year, month, day] = match;
  const monthName = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' }).format(
    new Date(Date.UTC(Number(year), Number(month) - 1, 1))
  );
  return `${day}-${monthName}-${year}`;
}

function buildDateRange(fromDate, toDate) {
  if (!fromDate || !toDate) return [];
  const parseIsoDate = (value) => {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const [, year, month, day] = match;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  };
  const start = parseIsoDate(fromDate);
  const end = parseIsoDate(toDate);
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];
  const out = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function normalizeTemplateDateToken(token) {
  const raw = String(token || '').trim();
  if (!raw) return '';
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return raw;
  const dmyMatch = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (dmyMatch) {
    const [, day, month, year] = dmyMatch;
    return `${year}-${month}-${day}`;
  }
  return '';
}

function extractTemplateDateRange(filename) {
  const matches = String(filename || '').match(/\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{4}/g) || [];
  if (matches.length < 2) return null;
  const start = normalizeTemplateDateToken(matches[0]);
  const end = normalizeTemplateDateToken(matches[1]);
  if (!start || !end) return null;
  return { from: start, to: end };
}

async function readJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.detail || payload?.message || `HTTP ${response.status}`);
  }
  return payload;
}

export function DsmVerificationDepooling() {
  const user = getCurrentUserFromStorage();
  const fileInputRef = useRef(null);
  const bulkZipInputRef = useRef(null);
  const bulkFolderInputRef = useRef(null);
  const templateInputRef = useRef(null);
  const officialInputRef = useRef(null);

  const [configs, setConfigs] = useState([]);
  const [selectedPss, setSelectedPss] = useState('');
  const [selectedRegulation, setSelectedRegulation] = useState('2014');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [currentTemplate, setCurrentTemplate] = useState(null);
  const [currentRun, setCurrentRun] = useState(null);
  const [runValidation, setRunValidation] = useState({ ok: false, missing: [] });
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [bulkUploading, setBulkUploading] = useState(false);
  const [autoFetchingSchedules, setAutoFetchingSchedules] = useState(false);
  const [scheduleUnavailable, setScheduleUnavailable] = useState({});
  const [generating, setGenerating] = useState(false);
  const [deletingFileId, setDeletingFileId] = useState(null);
  const [pendingUpload, setPendingUpload] = useState(null);
  const [uploadNotice, setUploadNotice] = useState('');
  const [validationRemarks, setValidationRemarks] = useState('');
  const autoScheduleFetchKeyRef = useRef('');
  const [avcPpaEditing, setAvcPpaEditing] = useState(false);
  const [avcPpaDraft, setAvcPpaDraft] = useState({
    sprng_avc: '',
    sprng_ppa: '',
    seit_avc: '',
    seit_ppa: '',
    athena_avc: '',
    athena_ppa: '',
  });

  const selectedConfig = useMemo(
    () => configs.find((item) => String(item.pss_code || '').toUpperCase() === String(selectedPss || '').toUpperCase()) || null,
    [configs, selectedPss]
  );
  const dateRange = useMemo(() => buildDateRange(fromDate, toDate), [fromDate, toDate]);
  const scheduleGenerators = useMemo(() => {
    const configured = Array.isArray(selectedConfig?.schedule_generators) ? selectedConfig.schedule_generators : ['SPRNG', 'SEIT'];
    const seen = new Set();
    return configured
      .map((item) => String(item || '').trim().toUpperCase())
      .filter((item) => {
        if (!item || seen.has(item)) return false;
        seen.add(item);
        return true;
      });
  }, [selectedConfig]);
  const meterFilesByDate = useMemo(() => {
    const map = new Map();
    for (const item of currentRun?.files || []) {
      if (item.file_type !== 'METER' || !item.file_date) continue;
      map.set(item.file_date, item);
    }
    return map;
  }, [currentRun]);
  const scheduleFilesByType = useMemo(() => {
    const byGenerator = {};
    scheduleGenerators.forEach((generator) => {
      byGenerator[generator] = new Map();
    });
    for (const item of currentRun?.files || []) {
      if (!item.file_date) continue;
      const generator = String(item.file_type || '').replace(/_SCHEDULE$/i, '').toUpperCase();
      if (byGenerator[generator]) byGenerator[generator].set(item.file_date, item);
    }
    return byGenerator;
  }, [currentRun, scheduleGenerators]);
  const officialReportFile = useMemo(
    () => (currentRun?.files || []).find((item) => item.file_type === 'OFFICIAL_REFERENCE') || null,
    [currentRun]
  );

  const templateFilename = currentTemplate?.template?.original_filename || currentTemplate?.template?.filename || '';
  const templateName = currentTemplate?.uploaded ? templateFilename : '';
  const templateActive = Boolean(currentTemplate?.uploaded);
  const runId = currentRun?.run?.id || currentRun?.id || null;
  const runStatus = currentRun?.run?.status || currentRun?.status || 'DRAFT';
  const validationStatus = currentRun?.run?.validation_status || currentRun?.validation_status || 'PENDING';

  useEffect(() => {
    setAvcPpaDraft({
      sprng_avc: currentRun?.run?.sprng_avc ?? '',
      sprng_ppa: currentRun?.run?.sprng_ppa ?? '',
      seit_avc: currentRun?.run?.seit_avc ?? '',
      seit_ppa: currentRun?.run?.seit_ppa ?? '',
      athena_avc: currentRun?.run?.athena_avc ?? '',
      athena_ppa: currentRun?.run?.athena_ppa ?? '',
    });
    setAvcPpaEditing(false);
  }, [currentRun?.run?.id, currentRun?.run?.sprng_avc, currentRun?.run?.sprng_ppa, currentRun?.run?.seit_avc, currentRun?.run?.seit_ppa, currentRun?.run?.athena_avc, currentRun?.run?.athena_ppa]);

  const loadOverview = async (pss = selectedPss, regulation = selectedRegulation) => {
    if (!pss) return;
    setLoading(true);
    const reg = DSM_REGULATION_OPTIONS.includes(String(regulation)) ? String(regulation) : '2014';
    try {
      const [templateResp, runsResp] = await Promise.all([
        fetch(`${API_BASE_URL}/dsm-verification/templates/current?pss_code=${encodeURIComponent(pss)}&regulation=${encodeURIComponent(reg)}`),
        fetch(`${API_BASE_URL}/dsm-verification/runs?pss_code=${encodeURIComponent(pss)}&limit=50`),
      ]);
      const templatePayload = await readJson(templateResp);
      const runsPayload = await readJson(runsResp);
      setCurrentTemplate(templatePayload);
      setHistory(Array.isArray(runsPayload?.items) ? runsPayload.items : []);
      const existing = (runsPayload?.items || []).find(
        (row) => row.pss_code === String(pss).toUpperCase() && row.from_date === fromDate && row.to_date === toDate
      );
      if (existing?.id) {
        await loadRun(existing.id, reg);
      }
    } catch (error) {
      toast.error(error?.message || 'Failed to load DSM data');
    } finally {
      setLoading(false);
    }
  };

  const loadRun = async (id, regulation = selectedRegulation) => {
    if (!id) return;
    const reg = DSM_REGULATION_OPTIONS.includes(String(regulation)) ? String(regulation) : '2014';
    const resp = await fetch(`${API_BASE_URL}/dsm-verification/runs/${encodeURIComponent(String(id))}?regulation=${encodeURIComponent(reg)}`);
    const payload = await readJson(resp);
    setCurrentRun(payload);
    setRunValidation(payload?.validation || { ok: false, missing: [] });
    setValidationRemarks(payload?.run?.validation_remarks || '');
    return payload;
  };

  useEffect(() => {
    fetch(`${API_BASE_URL}/dsm-verification/configs`)
      .then(readJson)
      .then((payload) => {
        const items = Array.isArray(payload?.items) ? payload.items : [];
        setConfigs(items);
        if (!selectedPss && items[0]?.pss_code) {
          setSelectedPss(String(items[0].pss_code));
        }
      })
      .catch((error) => toast.error(error?.message || 'Failed to load DSM configs'));
  }, []);

  useEffect(() => {
    if (!selectedPss || !fromDate || !toDate || !dateRange.length) {
      setCurrentRun(null);
      setRunValidation({ ok: false, missing: [] });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(`${API_BASE_URL}/dsm-verification/runs?pss_code=${encodeURIComponent(selectedPss)}&limit=50`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        });
        const payload = await readJson(resp);
        const match = (payload?.items || []).find(
          (row) => row.pss_code === String(selectedPss).toUpperCase() && row.from_date === fromDate && row.to_date === toDate
        );
        if (match?.id) {
          if (!cancelled) await loadRun(match.id, selectedRegulation);
          return;
        }
        const createResp = await fetch(`${API_BASE_URL}/dsm-verification/runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pss_code: selectedPss,
            regulation: selectedRegulation,
            from_date: fromDate,
            to_date: toDate,
            created_by: user?.name || user?.username || '',
            force_new_revision: false,
            sprng_avc: selectedConfig?.generator_defaults?.SPRNG?.avc_mw ?? null,
            sprng_ppa: selectedConfig?.generator_defaults?.SPRNG?.ppa ?? null,
            seit_avc: selectedConfig?.generator_defaults?.SEIT?.avc_mw ?? null,
            seit_ppa: selectedConfig?.generator_defaults?.SEIT?.ppa ?? null,
            athena_avc: selectedConfig?.generator_defaults?.ATHENA?.avc_mw ?? null,
            athena_ppa: selectedConfig?.generator_defaults?.ATHENA?.ppa ?? null,
          }),
        });
        const createPayload = await readJson(createResp);
        if (!cancelled) {
          setCurrentRun(createPayload);
          setRunValidation(createPayload?.validation || { ok: false, missing: [] });
          setValidationRemarks(createPayload?.run?.validation_remarks || '');
        }
      } catch (error) {
        if (!cancelled) toast.error(error?.message || 'Failed to create DSM run');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedPss, selectedRegulation, fromDate, toDate, selectedConfig]);

  useEffect(() => {
    if (!selectedPss) return;
    loadOverview(selectedPss, selectedRegulation);
  }, [selectedPss, selectedRegulation]);

  useEffect(() => {
    if (!runId) return;
    loadRun(runId, selectedRegulation).catch(() => {});
  }, [runId, selectedRegulation]);

  const refreshRun = async () => {
    if (!runId) return;
    await loadRun(runId, selectedRegulation);
    const runsResp = await fetch(`${API_BASE_URL}/dsm-verification/runs?pss_code=${encodeURIComponent(selectedPss)}&limit=50`);
    const runsPayload = await readJson(runsResp);
    setHistory(Array.isArray(runsPayload?.items) ? runsPayload.items : []);
  };

  const deleteRunFile = async (fileId) => {
    if (!runId || !fileId) return;
    const okToDelete = window.confirm('Delete this uploaded file?');
    if (!okToDelete) return;
    setDeletingFileId(fileId);
    try {
      const resp = await fetch(`${API_BASE_URL}/dsm-verification/runs/${encodeURIComponent(String(runId))}/files/${encodeURIComponent(String(fileId))}`, {
        method: 'DELETE',
      });
      await readJson(resp);
      await refreshRun();
      setUploadNotice('');
      toast.success('File deleted');
    } catch (error) {
      toast.error(error?.message || 'Delete failed');
    } finally {
      setDeletingFileId(null);
    }
  };

  const handleTemplatePick = () => templateInputRef.current?.click();
  const handleBulkZipPick = () => {
    if (!runId) {
      toast.error('Select PSS and date range before uploading files');
      return;
    }
    bulkZipInputRef.current?.click();
  };
  const handleBulkFolderPick = () => {
    if (!runId) {
      toast.error('Select PSS and date range before uploading files');
      return;
    }
    bulkFolderInputRef.current?.click();
  };
  const handleOfficialPick = () => {
    if (!runId) {
      toast.error('Select PSS and date range before uploading files');
      return;
    }
    setPendingUpload({ fileType: FILE_TYPES.OFFICIAL_REFERENCE, fileDate: '', generator: '' });
    officialInputRef.current?.click();
  };
  const handleFilePick = (fileType, fileDate, generator = '') => {
    if (!runId && fileType !== FILE_TYPES.OFFICIAL_REFERENCE) {
      toast.error('Select PSS and date range before uploading files');
      return;
    }
    setPendingUpload({ fileType, fileDate, generator });
    fileInputRef.current?.click();
  };

  const uploadFile = async (file) => {
    if (!file || !pendingUpload) return;
    if (!runId) {
      toast.error('Select PSS and date range before uploading files');
      return;
    }
    setUploading(true);
    setUploadNotice('');
    try {
      const form = new FormData();
      form.set('file_type', pendingUpload.fileType);
      form.set('file_date', pendingUpload.fileDate || '');
      form.set('uploaded_by', user?.name || user?.username || '');
      if (pendingUpload.generator) form.set('generator', pendingUpload.generator);
      form.set('file', file, file.name || 'upload.xlsx');
      const resp = await fetch(`${API_BASE_URL}/dsm-verification/runs/${encodeURIComponent(String(runId))}/files`, {
        method: 'POST',
        body: form,
      });
      const payload = await readJson(resp);
      setCurrentRun((prev) => {
        const existingFiles = Array.isArray(prev?.files) ? prev.files : [];
        const nextFile = payload?.file
          ? {
              ...payload.file,
              original_filename: file.name || 'upload',
              uploaded_at: new Date().toISOString(),
              uploaded_by: user?.name || user?.username || '',
            }
          : null;
        const withoutReplaced = existingFiles.filter((item) => {
          if (!nextFile) return true;
          return !(
            item.file_type === nextFile.file_type &&
            item.file_date === nextFile.file_date &&
            String(item.generator || '') === String(nextFile.generator || '')
          );
        });
        return {
          ...(prev || {}),
          ...(payload || {}),
          run: payload?.run || prev?.run || null,
          files: nextFile ? [...withoutReplaced, nextFile] : existingFiles,
          validation: payload?.validation || prev?.validation || { ok: false, missing: [] },
        };
      });
      await refreshRun();
      setUploadNotice(
        pendingUpload.fileType === FILE_TYPES.OFFICIAL_REFERENCE
          ? `Official DSM report uploaded: ${file.name || 'upload'}`
          : `${String(pendingUpload.fileType || '').replace(/_/g, ' ').toLowerCase()} uploaded for ${formatDisplayDate(pendingUpload.fileDate)}`
      );
      toast.success('File uploaded');
    } catch (error) {
      setUploadNotice('');
      toast.error(error?.message || 'Upload failed');
    } finally {
      setUploading(false);
      setPendingUpload(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (templateInputRef.current) templateInputRef.current.value = '';
      if (officialInputRef.current) officialInputRef.current.value = '';
    }
  };

  const uploadBulkMeterFiles = async (selectedFiles) => {
    const files = Array.from(selectedFiles || []);
    if (!files.length) return;
    if (!runId) {
      toast.error('Select PSS and date range before uploading files');
      return;
    }
    setBulkUploading(true);
    setUploadNotice('');
    try {
      const form = new FormData();
      form.set('uploaded_by', user?.name || user?.username || '');
      files.forEach((file) => {
        form.append('files', file, file.webkitRelativePath || file.name || 'upload');
      });
      const resp = await fetch(`${API_BASE_URL}/dsm-verification/runs/${encodeURIComponent(String(runId))}/bulk-meter-files`, {
        method: 'POST',
        body: form,
      });
      const payload = await readJson(resp);
      await refreshRun();
      const uploadedCount = Number(payload?.uploaded_count || 0);
      const skippedCount = Array.isArray(payload?.skipped) ? payload.skipped.length : 0;
      const errorCount = Array.isArray(payload?.errors) ? payload.errors.length : 0;
      setUploadNotice(
        `Auto uploaded ${uploadedCount} meter file${uploadedCount === 1 ? '' : 's'} from QC13 match${skippedCount || errorCount ? ` (${skippedCount} skipped, ${errorCount} errors)` : ''}`
      );
      toast.success(`Auto uploaded ${uploadedCount} meter file${uploadedCount === 1 ? '' : 's'}`);
      if (payload?.errors?.length) {
        toast.error(payload.errors.slice(0, 2).join('; '));
      }
    } catch (error) {
      setUploadNotice('');
      toast.error(error?.message || 'Bulk meter upload failed');
    } finally {
      setBulkUploading(false);
      if (bulkZipInputRef.current) bulkZipInputRef.current.value = '';
      if (bulkFolderInputRef.current) bulkFolderInputRef.current.value = '';
    }
  };

  const autoFetchSchedulesFromFtp = async (targetRunId = runId, { silent = true } = {}) => {
    if (!targetRunId) return null;
    setAutoFetchingSchedules(true);
    try {
      const resp = await fetch(
        `${API_BASE_URL}/dsm-verification/runs/${encodeURIComponent(String(targetRunId))}/auto-fetch-schedules?uploaded_by=${encodeURIComponent(user?.name || user?.username || 'FTP_AUTO')}`,
        { method: 'POST' }
      );
      const payload = await readJson(resp);
      const unavailableMap = {};
      (payload?.unavailable || []).forEach((item) => {
        const generator = String(item?.generator || '').toUpperCase();
        const day = String(item?.file_date || '');
        if (generator && day) unavailableMap[`${generator}:${day}`] = item?.reason || 'Unavailable';
      });
      setScheduleUnavailable(unavailableMap);
      await loadRun(targetRunId, selectedRegulation);
      const uploadedCount = Number(payload?.uploaded_count || 0);
      if (!silent && uploadedCount) {
        toast.success(`Fetched ${uploadedCount} schedule file${uploadedCount === 1 ? '' : 's'} from FTP`);
      }
      return payload;
    } catch (error) {
      if (!silent) toast.error(error?.message || 'Schedule FTP fetch failed');
      return null;
    } finally {
      setAutoFetchingSchedules(false);
    }
  };

  useEffect(() => {
    if (!runId || !selectedPss || !fromDate || !toDate || !dateRange.length) return;
    const key = `${runId}:${selectedPss}:${fromDate}:${toDate}`;
    if (autoScheduleFetchKeyRef.current === key) return;
    autoScheduleFetchKeyRef.current = key;
    setScheduleUnavailable({});
    autoFetchSchedulesFromFtp(runId, { silent: true }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, selectedPss, fromDate, toDate, dateRange.length]);

  const uploadTemplate = async (file) => {
    if (!file || !selectedPss) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.set('pss_code', selectedPss);
      form.set('regulation', selectedRegulation);
      form.set('uploaded_by', user?.name || user?.username || '');
      form.set('file', file, file.name || 'template.xlsx');
      const resp = await fetch(`${API_BASE_URL}/dsm-verification/templates/upload`, {
        method: 'POST',
        body: form,
      });
      const payload = await readJson(resp);
      setCurrentTemplate({ ok: true, uploaded: true, template: payload.template });
      await loadOverview(selectedPss, selectedRegulation);
      toast.success('Template uploaded');
    } catch (error) {
      toast.error(error?.message || 'Template upload failed');
    } finally {
      setUploading(false);
      if (templateInputRef.current) templateInputRef.current.value = '';
    }
  };

  const handleGenerate = async () => {
    if (!runId) return;
    setGenerating(true);
    try {
      const resp = await fetch(`${API_BASE_URL}/dsm-verification/runs/${encodeURIComponent(String(runId))}/generate?regulation=${encodeURIComponent(selectedRegulation)}`, {
        method: 'POST',
      });
      const payload = await readJson(resp);
      setCurrentRun(payload);
      await refreshRun();
      toast.success('DSM calculation generated');
    } catch (error) {
      toast.error(error?.message || 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };

  const handleValidation = async (status) => {
    if (!runId) return;
    try {
      const resp = await fetch(`${API_BASE_URL}/dsm-verification/runs/${encodeURIComponent(String(runId))}/validation`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status,
          validated_by: user?.name || user?.username || '',
          remarks: validationRemarks,
        }),
      });
      const payload = await readJson(resp);
      setCurrentRun(payload);
      await refreshRun();
      toast.success(`Marked ${status.toLowerCase()}`);
    } catch (error) {
      toast.error(error?.message || 'Validation update failed');
    }
  };

  const handleSaveAvcPpa = async () => {
    if (!runId) return;
    try {
      const toNumberOrNull = (value) => {
        if (value === '' || value === null || value === undefined) return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
      };
      const resp = await fetch(`${API_BASE_URL}/dsm-verification/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pss_code: selectedPss,
          regulation: selectedRegulation,
          from_date: fromDate,
          to_date: toDate,
          created_by: user?.name || user?.username || '',
          force_new_revision: false,
          sprng_avc: toNumberOrNull(avcPpaDraft.sprng_avc),
          sprng_ppa: toNumberOrNull(avcPpaDraft.sprng_ppa),
          seit_avc: toNumberOrNull(avcPpaDraft.seit_avc),
          seit_ppa: toNumberOrNull(avcPpaDraft.seit_ppa),
          athena_avc: toNumberOrNull(avcPpaDraft.athena_avc),
          athena_ppa: toNumberOrNull(avcPpaDraft.athena_ppa),
        }),
      });
      await readJson(resp);
      await loadRun(runId, selectedRegulation);
      setAvcPpaEditing(false);
      toast.success('AVC / PPA saved');
    } catch (error) {
      toast.error(error?.message || 'Failed to save AVC / PPA');
    }
  };

  const canGenerate = Boolean(runValidation?.ok && templateActive && runId);
  const meterCompleteCount = dateRange.filter((day) => meterFilesByDate.has(day)).length;
  const scheduleFileTypeForGenerator = (generator) => FILE_TYPES[`${String(generator || '').toUpperCase()}_SCHEDULE`] || `${String(generator || '').toUpperCase()}_SCHEDULE`;

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <FileSpreadsheet className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-foreground">DSM Verification & Depooling</h1>
            </div>
          </div>
          <button
            type="button"
            onClick={() => loadOverview(selectedPss, selectedRegulation)}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-accent"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-4">
        <div className="rounded-xl border border-border bg-card p-4 lg:col-span-4">
          <div className="grid gap-4 md:grid-cols-4">
            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">PSS</span>
              <select
                value={selectedPss}
                onChange={(e) => setSelectedPss(e.target.value)}
                className="w-full rounded-md border border-border bg-input-background px-3 py-2 text-sm"
              >
                <option value="">Select PSS</option>
                {configs.map((item) => (
                  <option key={item.pss_code} value={item.pss_code}>
                    {item.pss_name || item.pss_code}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">Select Regulation</span>
              <select
                value={selectedRegulation}
                onChange={(e) => {
                  setSelectedRegulation(DSM_REGULATION_OPTIONS.includes(e.target.value) ? e.target.value : '2014');
                  setCurrentRun(null);
                  setRunValidation({ ok: false, missing: [] });
                }}
                className="w-full rounded-md border border-border bg-input-background px-3 py-2 text-sm"
              >
                {DSM_REGULATION_OPTIONS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">From Date</span>
              <div className="relative">
                <CalendarDays className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <input
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="w-full rounded-md border border-border bg-input-background py-2 pl-9 pr-3 text-sm"
                />
              </div>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">To Date</span>
              <div className="relative">
                <CalendarDays className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <input
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                  className="w-full rounded-md border border-border bg-input-background py-2 pl-9 pr-3 text-sm"
                />
              </div>
            </label>
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-base font-semibold text-foreground">Meter Data</h2>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleBulkFolderPick}
                disabled={bulkUploading || !runId}
                className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Upload className="h-3.5 w-3.5" />
                {bulkUploading ? 'Auto uploading...' : 'Upload Folder'}
              </button>
              <div className="text-xs text-muted-foreground">
                {meterCompleteCount} / {dateRange.length || 0} uploaded
              </div>
            </div>
          </div>
          {uploadNotice && (
            <div className="mb-3 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
              {uploadNotice}
            </div>
          )}
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Upload File</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {dateRange.map((day) => {
                  const file = meterFilesByDate.get(day);
                  return (
                    <tr key={day} className="border-t border-border">
                      <td className="px-3 py-2">{formatDisplayDate(day)}</td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => handleFilePick(FILE_TYPES.METER, day)}
                          disabled={uploading}
                          className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Upload className="h-4 w-4" />
                          {uploading && pendingUpload?.fileType === FILE_TYPES.METER && pendingUpload?.fileDate === day ? 'Uploading...' : 'Upload'}
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        {file ? (
                          <div className="min-w-0 text-success">
                            <div className="flex items-start gap-2">
                              <button
                                type="button"
                                onClick={() => deleteRunFile(file.id)}
                                disabled={deletingFileId === file.id}
                                className="mt-0.5 inline-flex h-5 w-5 flex-none items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                                title="Delete uploaded file"
                                aria-label="Delete uploaded file"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                              <div className="min-w-0">
                                <span className="inline-flex items-center gap-1">
                                  <CheckCircle2 className="h-4 w-4" />
                                  Uploaded
                                </span>
                                <div className="mt-0.5 max-w-[220px] truncate text-xs text-muted-foreground" title={file.original_filename || ''}>
                                  {file.original_filename || 'File saved'}
                                </div>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-muted-foreground">
                            <CircleX className="h-4 w-4" />
                            Missing
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-base font-semibold text-foreground">Schedules</h2>
            <div className="flex items-center gap-2">
              {autoFetchingSchedules && (
                <span className="text-xs text-muted-foreground">Fetching FTP...</span>
              )}
              <button
                type="button"
                onClick={() => autoFetchSchedulesFromFtp(runId, { silent: false })}
                disabled={!runId || autoFetchingSchedules}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${autoFetchingSchedules ? 'animate-spin' : ''}`} />
                Fetch FTP
              </button>
              {scheduleGenerators.map((generator) => (
                <span key={generator} className="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                  {GENERATOR_LABELS[generator] || generator}
                </span>
              ))}
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {scheduleGenerators.map((generator) => {
              const fileType = scheduleFileTypeForGenerator(generator);
              const map = scheduleFilesByType[generator] || new Map();
              const completeCount = dateRange.filter((day) => map.has(day)).length;
              return (
                <div key={generator} className="rounded-lg border border-border p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-sm font-semibold">{GENERATOR_LABELS[generator] || generator}</h3>
                    <span className="text-xs text-muted-foreground">{completeCount} / {dateRange.length || 0}</span>
                  </div>
                  <div className="space-y-2">
                    {dateRange.map((day) => {
                      const file = map.get(day);
                      const unavailableReason = scheduleUnavailable[`${generator}:${day}`];
                      return (
                        <div key={`${generator}-${day}`} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
                          <div>{formatDisplayDate(day)}</div>
                          <div className="flex items-center gap-2">
                            {file ? <CheckCircle2 className="h-4 w-4 text-success" /> : <CircleX className={`h-4 w-4 ${unavailableReason ? 'text-amber-600' : 'text-muted-foreground'}`} />}
                            <button
                              type="button"
                              onClick={() => handleFilePick(fileType, day, generator)}
                              disabled={uploading}
                              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <Upload className="h-3.5 w-3.5" />
                              {uploading && pendingUpload?.fileType === fileType && pendingUpload?.fileDate === day ? 'Uploading...' : 'Upload Schedule'}
                            </button>
                          </div>
                          {!file && unavailableReason && (
                            <div className="mt-1 text-xs text-amber-600" title={unavailableReason}>
                              Unavailable
                            </div>
                          )}
                          {file?.original_filename && (
                            <div className="mt-1 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                              <button
                                type="button"
                                onClick={() => deleteRunFile(file.id)}
                                disabled={deletingFileId === file.id}
                                className="inline-flex h-4 w-4 flex-none items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                                title="Delete uploaded file"
                                aria-label="Delete uploaded file"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                              <FileText className="h-3.5 w-3.5 flex-none" />
                              <span className="truncate" title={file.original_filename}>{file.original_filename}</span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-foreground">AVC / PPA</h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setAvcPpaEditing(true)}
                disabled={!runId || avcPpaEditing}
                className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Edit3 className="h-3.5 w-3.5" />
                Edit
              </button>
              {avcPpaEditing && (
                <button
                  type="button"
                  onClick={handleSaveAvcPpa}
                  disabled={!runId}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Save className="h-3.5 w-3.5" />
                  Save
                </button>
              )}
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {scheduleGenerators.map((generator) => {
              const avcKey = `${generator.toLowerCase()}_avc`;
              const ppaKey = `${generator.toLowerCase()}_ppa`;
              return (
              <div key={generator} className="rounded-lg border border-border p-3">
                <div className="mb-2 font-medium">{GENERATOR_LABELS[generator] || generator}</div>
                <div className="grid gap-2">
                  <label className="block">
                    <span className="mb-1 block text-xs text-muted-foreground">AVC</span>
                    <input
                      type="number"
                      step="0.001"
                      value={avcPpaDraft[avcKey] ?? ''}
                      onChange={(e) => {
                        setAvcPpaDraft((prev) => ({ ...prev, [avcKey]: e.target.value }));
                      }}
                      disabled={!avcPpaEditing}
                      className="w-full rounded-md border border-border bg-input-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-70"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-muted-foreground">PPA</span>
                    <input
                      type="number"
                      step="0.001"
                      value={avcPpaDraft[ppaKey] ?? ''}
                      onChange={(e) => {
                        setAvcPpaDraft((prev) => ({ ...prev, [ppaKey]: e.target.value }));
                      }}
                      disabled={!avcPpaEditing}
                      className="w-full rounded-md border border-border bg-input-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-70"
                    />
                  </label>
                </div>
              </div>
            );
            })}
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-foreground">Calculation Template</h2>
            <div className="flex gap-2">
              <input ref={templateInputRef} type="file" accept=".xlsx,.xlsm" className="hidden" onChange={(e) => uploadTemplate(e.target.files?.[0])} />
              <button type="button" onClick={handleTemplatePick} className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent">
                <Upload className="h-4 w-4" />
                {templateActive ? 'Replace Template' : 'Upload Template'}
              </button>
              {templateActive && (
                <a
                  href={`${API_BASE_URL}/dsm-verification/templates/download?pss_code=${encodeURIComponent(selectedPss)}&regulation=${encodeURIComponent(selectedRegulation)}`}
                  className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent"
                >
                  <Download className="h-4 w-4" />
                  Download Template
                </a>
              )}
            </div>
          </div>
          {templateActive && (
            <div className="rounded-lg border border-border bg-muted/20 p-3 text-sm">
              <div className="font-medium break-all">{templateName}</div>
              <div className="mt-1 text-xs text-muted-foreground">Regulation: {selectedRegulation}</div>
            </div>
          )}

          <div className="my-5 border-t border-border" />

          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-foreground">Official DSM Report</h2>
          </div>
          <input ref={officialInputRef} type="file" className="hidden" onChange={(e) => uploadFile(e.target.files?.[0])} />
          <button type="button" onClick={handleOfficialPick} disabled={uploading || !runId} className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50">
            <Upload className="h-4 w-4" />
            {uploading && pendingUpload?.fileType === FILE_TYPES.OFFICIAL_REFERENCE ? 'Uploading...' : 'Upload Official DSM Report'}
          </button>
          <div className="mt-3 rounded-md border border-border bg-muted/20 px-3 py-2 text-sm">
            {officialReportFile ? (
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => deleteRunFile(officialReportFile.id)}
                      disabled={deletingFileId === officialReportFile.id}
                      className="inline-flex h-5 w-5 flex-none items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                      title="Delete uploaded file"
                      aria-label="Delete uploaded file"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                    <div className="truncate font-medium text-foreground">{officialReportFile.original_filename || 'Official DSM report'}</div>
                  </div>
                  <div className="text-xs text-muted-foreground">File uploaded and applied to the generated aggregated sheet.</div>
                </div>
                <div className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-1 text-xs font-semibold text-success">
                  <FileCheck2 className="h-3.5 w-3.5" />
                  Uploaded
                </div>
              </div>
            ) : null}
          </div>
        </section>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <section className="rounded-xl border border-border bg-card p-4 sm:p-5 xl:col-span-2">
          <div className="flex min-h-[220px] flex-col items-center justify-center gap-3 text-center">
            <button
              type="button"
              onClick={handleGenerate}
              disabled={!canGenerate || generating}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50"
            >
              <CheckCircle2 className="h-4 w-4" />
              {generating ? 'Generating...' : 'Generate Calculation'}
            </button>
            {currentRun?.run?.generated_filename && (
              <a
                href={`${API_BASE_URL}/dsm-verification/runs/${encodeURIComponent(String(runId))}/download`}
                className="inline-flex items-center gap-2 rounded-md border border-border px-5 py-2.5 text-sm hover:bg-accent"
              >
                <Download className="h-4 w-4" />
                Download Generated Calculation Sheet
              </a>
            )}
          </div>
        </section>

      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept={DSM_UPLOAD_ACCEPT}
        className="hidden"
        onChange={(e) => uploadFile(e.target.files?.[0])}
      />
      <input
        ref={bulkZipInputRef}
        type="file"
        accept=".zip"
        className="hidden"
        onChange={(e) => uploadBulkMeterFiles(e.target.files)}
      />
      <input
        ref={bulkFolderInputRef}
        type="file"
        accept=".csv"
        multiple
        webkitdirectory=""
        directory=""
        className="hidden"
        onChange={(e) => uploadBulkMeterFiles(e.target.files)}
      />
    </div>
  );
}

export default DsmVerificationDepooling;
