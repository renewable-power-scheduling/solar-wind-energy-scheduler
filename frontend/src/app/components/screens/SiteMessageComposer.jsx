import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Calendar,
  Clock,
  Copy,
  Factory,
  MessageSquareText,
  RotateCcw,
  Send,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/services/api';
import { useAuth } from '@/app/appContexts';
import { isAdminUser } from '@/utils/plantAccess';

const SITES = [
  {
    code: 'BHUPALPALLY',
    state: 'Telangana',
    messageName: 'BHUPALPALLY',
    aliases: ['BHUPALPALLY', 'BHPL', 'Bhpl'],
  },
  {
    code: 'KOTHAGUDEM',
    state: 'Telangana',
    messageName: 'KOTHAGUDEM',
    aliases: ['KOTHAGUDEM', 'Kotha', 'KTGDM'],
  },
  {
    code: 'KASIPET',
    state: 'Telangana',
    messageName: 'KASIPET',
    aliases: ['KASIPET', 'KSPT', 'Kasi'],
  },
  {
    code: 'SIRMOUR',
    state: 'Madhya Pradesh',
    messageName: 'SIRMOUR',
    aliases: ['sirmour', 'Sirm'],
  },
  {
    code: 'BAMKHAL',
    state: 'Madhya Pradesh',
    messageName: 'BAMKHAL',
    aliases: ['BAMKHAL', 'Bamkhal'],
  },
  {
    code: 'GSNP',
    state: 'Madhya Pradesh',
    messageName: 'GSNP',
    aliases: ['GSNP', 'Globus Steel N Power (GSNP)', 'Globus Steel'],
  },
  {
    code: 'SAWDA',
    state: 'Madhya Pradesh',
    messageName: 'SAWDA',
    aliases: ['SAWDA', 'Sawda'],
  },
  {
    code: 'ANJANGAON',
    state: 'Madhya Pradesh',
    messageName: 'ANJANGAON',
    aliases: ['ANJANGAON', 'ANJANGOAN', 'Anjangaon'],
  },
  {
    code: 'ZETRIC',
    state: 'Maharashtra',
    messageName: 'ZETRIC',
    aliases: ['ZETRIC', 'Zetric'],
  },
  {
    code: 'ANDAD',
    state: 'Madhya Pradesh',
    messageName: 'ANDAD',
    aliases: ['ANDAD', 'Andad'],
  },
  {
    code: 'BALAKWADA',
    state: 'Madhya Pradesh',
    messageName: 'BALAKWADA',
    aliases: ['BALAKWADA', 'Balakwada'],
  },
  {
    code: 'GUGARIYAKHEDI',
    state: 'Madhya Pradesh',
    messageName: 'GUGARIYAKHEDI',
    aliases: ['GUGARIYAKHEDI', 'Gugariyakhedi'],
  },
  {
    code: 'NANDGAON',
    state: 'Madhya Pradesh',
    messageName: 'NANDGAON',
    aliases: ['NANDGAON', 'Nandgaon'],
  },
  {
    code: 'OSEL',
    state: 'Maharashtra',
    messageName: '20 MW OSMANABAD SOLAR ENERGY LTD, HORTI',
    aliases: ['OSEL', 'OSEPL', '20 MW OSMANABAD SOLAR ENERGY LTD, HORTI'],
  },
  {
    code: 'CME',
    state: 'Maharashtra',
    messageName: 'CME',
    aliases: ['CME'],
  },
];

const EVENT_TYPES = [
  { id: 'shutdown', label: 'Complete Shutdown' },
  { id: 'curtailment', label: 'Curtailment (AC Reduction)' },
  { id: 'partial_shutdown', label: 'Partial Shutdown (DC Reduction)' },
  { id: 'normal', label: 'Normal / Restored' },
  { id: 'delay', label: 'Restoration Delay / Extension' },
];

const todayKey = () => {
  try {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
};

const inputClass =
  'h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15';
const labelClass = 'text-sm font-medium text-foreground';
const panelClass = 'rounded-md border border-border bg-card shadow-sm';
const panelHeaderClass = 'border-b border-border px-4 py-3';
const panelTitleClass = 'flex items-center gap-2 text-sm font-semibold text-foreground';

const textValue = (value, fallback = '') => {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return fallback;
};

const buildMessage = ({
  eventType,
  siteAlias,
  dateContext,
  startTime,
  endTime,
  mw,
  normalStatus,
  delayMode,
  delayMinutes,
}) => {
  const site = String(siteAlias || '').trim();
  const dayText = dateContext === 'tomorrow' ? ' tomorrow' : '';
  const start = String(startTime || '').trim();
  const end = String(endTime || '').trim();
  const mwText = String(mw || '').trim();
  const minutes = String(delayMinutes || '').trim();

  if (!site || !eventType) return '';

  if (eventType === 'normal') {
    return `${site} ${normalStatus === 'restored' ? 'normal' : normalStatus}`;
  }

  if (eventType === 'delay') {
    if (!minutes) return '';
    return delayMode === 'extended'
      ? `${site} extended ${minutes} min`
      : `${site} restoration delayed ${minutes} min`;
  }

  if (!start) return '';

  const timeText = end ? ` from ${start} to ${end}` : ` from ${start}`;

  if (eventType === 'shutdown') {
    return `${site} shutdown${dayText}${timeText}`;
  }

  if (!mwText) return '';

  if (eventType === 'curtailment') {
    return `${site} ${mwText} MW AC down${dayText}${timeText}`;
  }

  return `${site} ${mwText} MW DC down${dayText}${timeText}`;
};

export function SiteMessageComposer() {
  const { user: currentUser } = useAuth() || {};
  const states = useMemo(() => ['All States', ...Array.from(new Set(SITES.map((site) => site.state)))], []);

  const [state, setState] = useState('');
  const [siteCode, setSiteCode] = useState('');
  const [siteAlias, setSiteAlias] = useState('');
  const [eventDate, setEventDate] = useState(todayKey());
  const [dateContext, setDateContext] = useState('today');
  const [eventType, setEventType] = useState('');
  const [startTime, setStartTime] = useState('14:00');
  const [endTime, setEndTime] = useState('');
  const [mw, setMw] = useState('5');
  const [normalStatus, setNormalStatus] = useState('restored');
  const [delayMode, setDelayMode] = useState('restoration_delayed');
  const [delayMinutes, setDelayMinutes] = useState('35');
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [logDate, setLogDate] = useState(todayKey());
  const [activityLogs, setActivityLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const isAdmin = isAdminUser(currentUser);
  const userRole = isAdmin
    ? 'admin'
    : String(currentUser?.empId || currentUser?.username || '').trim().toLowerCase() === 'intern'
      ? 'intern'
      : 'employee';

  const filteredSites = useMemo(
    () => SITES.filter((site) => !state || state === 'All States' || site.state === state),
    [state]
  );

  const selectedSite = useMemo(
    () => SITES.find((site) => site.code === siteCode) || null,
    [siteCode]
  );

  const selectedEvent = EVENT_TYPES.find((item) => item.id === eventType) || null;
  const needsMw = eventType === 'curtailment' || eventType === 'partial_shutdown';
  const needsTime = eventType === 'shutdown' || eventType === 'curtailment' || eventType === 'partial_shutdown';
  const isNormal = eventType === 'normal';
  const isDelay = eventType === 'delay';

  const messagePreview = buildMessage({
    eventType,
    siteAlias,
    dateContext,
    startTime,
    endTime,
    mw,
    normalStatus,
    delayMode,
    delayMinutes,
  });

  const previewPayload = {
    site_id: selectedSite?.code || '',
    site_id_raw: siteAlias,
    record_type: 'site_event_message',
    source: 'ui',
    event_date: eventDate,
    event_type: eventType,
    raw_message: messagePreview,
    ...(needsTime ? { start_time: startTime || null, end_time: endTime || null, date_context: dateContext } : {}),
    ...(isNormal ? { start_time: startTime || null } : {}),
    ...(needsMw ? { mw: Number(mw) || null, unit: 'MW', reduction_type: eventType === 'curtailment' ? 'AC' : 'DC' } : {}),
    ...(isNormal ? { status: normalStatus } : {}),
    ...(isDelay ? { delay_mode: delayMode, minutes: Number(delayMinutes) || null } : {}),
    ...(description.trim() ? { description: description.trim() } : {}),
  };

  const handleStateChange = (nextState) => {
    setState(nextState);
    setSiteCode('');
    setSiteAlias('');
  };

  const handleSiteChange = (nextCode) => {
    const nextSite = SITES.find((site) => site.code === nextCode) || null;
    setSiteCode(nextSite?.code || '');
    setSiteAlias(nextSite?.messageName || nextSite?.code || '');
  };

  const resetForm = () => {
    setState('');
    setSiteCode('');
    setSiteAlias('');
    setEventDate(todayKey());
    setDateContext('today');
    setEventType('');
    setStartTime('14:00');
    setEndTime('');
    setMw('5');
    setNormalStatus('restored');
    setDelayMode('restoration_delayed');
    setDelayMinutes('35');
    setDescription('');
  };

  const validateDraft = () => {
    if (!state) return 'State is required.';
    if (!selectedSite?.code) return 'Plant is required.';
    if (!siteAlias) return 'Message name is required.';
    if (!eventType) return 'Message type is required.';
    if (!eventDate) return 'Event date is required.';
    if (!messagePreview) return 'Message preview is empty.';
    if (needsTime && !startTime) return 'Start time is required.';
    if (isNormal && !startTime) return 'Restoration time is required.';
    if (needsMw && (!mw || Number(mw) <= 0)) return 'MW Down must be greater than zero.';
    return '';
  };

  const submitMessage = async () => {
    const error = validateDraft();
    if (error) {
      toast.error(error);
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await api.siteMessages.create(previewPayload, { user: currentUser, role: userRole });
      if (result?.duplicate) {
        toast.warning(result?.message || 'Message has already been stored.');
        if (isAdmin) fetchActivityLogs(logDate);
        return;
      }
      toast.success(result?.message || 'Site message saved');
      if (isAdmin) fetchActivityLogs(logDate);
    } catch (error) {
      toast.error(error?.message || 'Failed to save site message');
    } finally {
      setIsSubmitting(false);
    }
  };

  const fetchActivityLogs = useCallback(async (dateKey = logDate) => {
    setLogsLoading(true);
    try {
      const result = await api.siteMessages.listLogs({ date: dateKey, user: currentUser, role: userRole });
      setActivityLogs(Array.isArray(result?.items) ? result.items : []);
    } catch (error) {
      toast.error(error?.message || 'Failed to load site message logs');
    } finally {
      setLogsLoading(false);
    }
  }, [currentUser, logDate, userRole]);

  useEffect(() => {
    fetchActivityLogs(logDate);
  }, [fetchActivityLogs, logDate]);

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-background text-foreground">
      <div className="mx-auto max-w-7xl space-y-4 px-4 py-4 sm:px-6 sm:py-5">
        <div className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <MessageSquareText className="h-4 w-4" />
              Site Operations
            </div>
            <h1 className="mt-1 text-xl font-semibold text-foreground sm:text-2xl">
              Site Message Composer
            </h1>
          </div>
        </div>

        <div className="space-y-4">
          <div className={panelClass}>
              <div className={panelHeaderClass}>
                <div className={panelTitleClass}>
                  <Factory className="h-4 w-4 text-primary" />
                  Site Selection
                </div>
              </div>
              <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-4">
                <label className="space-y-1.5">
                  <span className={labelClass}>State</span>
                  <select className={inputClass} value={state} onChange={(e) => handleStateChange(e.target.value)}>
                    <option value="" disabled>Select State</option>
                    {states.map((item) => (
                      <option key={item} value={item}>{item}</option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1.5">
                  <span className={labelClass}>Plant</span>
                  <select className={inputClass} value={siteCode} onChange={(e) => handleSiteChange(e.target.value)} disabled={!state}>
                    <option value="" disabled>Select Plant</option>
                    {filteredSites.map((site) => (
                      <option key={site.code} value={site.code}>{site.code}</option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1.5">
                  <span className={labelClass}>Message Name</span>
                  <select className={inputClass} value={siteAlias} onChange={(e) => setSiteAlias(e.target.value)} disabled={!selectedSite}>
                    <option value="" disabled>Select Message</option>
                    {selectedSite && (
                      <option value={selectedSite.messageName || selectedSite.code}>
                        {selectedSite.messageName || selectedSite.code}
                      </option>
                    )}
                  </select>
                </label>
                <label className="space-y-1.5">
                  <span className={labelClass}>Event Date</span>
                  <div className="relative">
                    <Calendar className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <input
                      className={`${inputClass} pl-9`}
                      type="date"
                      value={eventDate}
                      onChange={(e) => setEventDate(e.target.value)}
                    />
                  </div>
                </label>
              </div>
          </div>

          <div className={panelClass}>
              <div className={panelHeaderClass}>
                <div className={panelTitleClass}>
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  Event Details
                </div>
              </div>
              <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-4">
                <label className="space-y-1.5 md:col-span-2">
                  <span className={labelClass}>Message Type</span>
                  <select className={inputClass} value={eventType} onChange={(e) => setEventType(e.target.value)}>
                    <option value="" disabled>Select Message Type</option>
                    {EVENT_TYPES.map((item) => (
                      <option key={item.id} value={item.id}>{item.label}</option>
                    ))}
                  </select>
                </label>

                {needsTime && (
                  <>
                    <label className="space-y-1.5">
                      <span className={labelClass}>Date Context</span>
                      <select className={inputClass} value={dateContext} onChange={(e) => setDateContext(e.target.value)}>
                        <option value="today">Today</option>
                        <option value="tomorrow">Tomorrow</option>
                      </select>
                    </label>
                    {needsMw && (
                      <label className="space-y-1.5">
                        <span className={labelClass}>MW Down</span>
                        <div className="relative">
                          <Zap className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                          <input
                            className={`${inputClass} pl-9`}
                            type="number"
                            min="0"
                            step="0.01"
                            value={mw}
                            onChange={(e) => setMw(e.target.value)}
                          />
                        </div>
                      </label>
                    )}
                    <label className="space-y-1.5">
                      <span className={labelClass}>Start Time</span>
                      <div className="relative">
                        <Clock className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                        <input
                          className={`${inputClass} pl-9`}
                          type="time"
                          value={startTime}
                          onChange={(e) => setStartTime(e.target.value)}
                        />
                      </div>
                    </label>
                    <label className="space-y-1.5">
                      <span className={labelClass}>End Time</span>
                      <div className="relative">
                        <Clock className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                        <input
                          className={`${inputClass} pl-9`}
                          type="time"
                          value={endTime}
                          onChange={(e) => setEndTime(e.target.value)}
                        />
                      </div>
                    </label>
                  </>
                )}

                {isNormal && (
                  <>
                    <label className="space-y-1.5">
                      <span className={labelClass}>Status</span>
                      <select className={inputClass} value={normalStatus} onChange={(e) => setNormalStatus(e.target.value)}>
                        <option value="restored">restored</option>
                        <option value="normal">normal</option>
                      </select>
                    </label>
                    <label className="space-y-1.5">
                      <span className={labelClass}>Restoration Time</span>
                      <div className="relative">
                        <Clock className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                        <input
                          className={`${inputClass} pl-9`}
                          type="time"
                          value={startTime}
                          onChange={(e) => setStartTime(e.target.value)}
                        />
                      </div>
                    </label>
                  </>
                )}

                {isDelay && (
                  <>
                    <label className="space-y-1.5">
                      <span className={labelClass}>Delay Type</span>
                      <select className={inputClass} value={delayMode} onChange={(e) => setDelayMode(e.target.value)}>
                        <option value="restoration_delayed">restoration delayed</option>
                        <option value="extended">extended</option>
                      </select>
                    </label>
                    <label className="space-y-1.5">
                      <span className={labelClass}>Minutes</span>
                      <input
                        className={inputClass}
                        type="number"
                        min="1"
                        step="1"
                        value={delayMinutes}
                        onChange={(e) => setDelayMinutes(e.target.value)}
                      />
                    </label>
                  </>
                )}

                <label className="space-y-1.5 md:col-span-2 xl:col-span-4">
                  <span className={labelClass}>Description</span>
                  <input
                    className={inputClass}
                    type="text"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Optional"
                  />
                </label>
              </div>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className={panelClass}>
              <div className={panelHeaderClass}>
                <div className={panelTitleClass}>
                  <MessageSquareText className="h-4 w-4 text-primary" />
                  Accepted Format Preview
                </div>
              </div>
              <div className="p-4">
                <div className="min-h-20 rounded-md border border-border bg-muted/30 px-4 py-3 text-base font-medium leading-7 text-foreground break-words">
                  {messagePreview || 'Select required values'}
                </div>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm text-muted-foreground">
                    Submit writes this message through the backend endpoint only.
                  </div>
                  <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-medium text-muted-foreground opacity-70 cursor-not-allowed"
                    disabled
                  >
                    <Copy className="h-4 w-4" />
                    Copy
                  </button>
                  <button
                    type="button"
                    onClick={resetForm}
                    className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground transition hover:bg-accent"
                  >
                    <RotateCcw className="h-4 w-4" />
                    Reset
                  </button>
                  <button
                    type="button"
                    onClick={submitMessage}
                    disabled={isSubmitting}
                    className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Send className="h-4 w-4" />
                    {isSubmitting ? 'Submitting...' : 'Submit'}
                  </button>
                  </div>
                </div>
              </div>
            </div>

            <div className={panelClass}>
              <div className={panelHeaderClass}>
                <div className={panelTitleClass}>Current Draft</div>
              </div>
              <div className="divide-y divide-border text-sm">
                <div className="flex justify-between gap-4 px-4 py-3">
                  <span className="text-muted-foreground">Site</span>
                  <span className="font-medium text-right">{selectedSite?.code || '-'}</span>
                </div>
                <div className="flex justify-between gap-4 px-4 py-3">
                  <span className="text-muted-foreground">Message Name</span>
                  <span className="font-medium text-right">{siteAlias || '-'}</span>
                </div>
                <div className="flex justify-between gap-4 px-4 py-3">
                  <span className="text-muted-foreground">Type</span>
                  <span className="font-medium text-right">{selectedEvent?.label || '-'}</span>
                </div>
                <div className="flex justify-between gap-4 px-4 py-3">
                  <span className="text-muted-foreground">Date</span>
                  <span className="font-medium text-right">{eventDate}</span>
                </div>
              </div>
            </div>
          </div>

          <div className={panelClass}>
              <div className={`${panelHeaderClass} flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between`}>
                <div className={panelTitleClass}>
                  <MessageSquareText className="h-4 w-4 text-primary" />
                  Site Message Activity Log
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">Date</span>
                  <input
                    className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15"
                    type="date"
                    value={logDate}
                    onChange={(event) => setLogDate(event.target.value)}
                  />
                </label>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-sm">
                  <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Time</th>
                      {isAdmin && <th className="px-4 py-3 font-semibold">User</th>}
                      {isAdmin && <th className="px-4 py-3 font-semibold">Role</th>}
                      <th className="px-4 py-3 font-semibold">Site</th>
                      <th className="px-4 py-3 font-semibold">Type</th>
                      <th className="px-4 py-3 font-semibold">Message</th>
                      <th className="px-4 py-3 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {logsLoading ? (
                      <tr>
                        <td className="px-4 py-5 text-center text-muted-foreground" colSpan={isAdmin ? 7 : 5}>
                          Loading logs...
                        </td>
                      </tr>
                    ) : activityLogs.length ? (
                      activityLogs.map((row) => {
                        const created = row?.created_at ? new Date(row.created_at) : null;
                        const timeLabel = created && !Number.isNaN(created.getTime())
                          ? created.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })
                          : '-';
                        return (
                          <tr key={textValue(row.id, `${row.site_id || 'row'}-${timeLabel}`)} className="align-top">
                            <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{timeLabel}</td>
                            {isAdmin && <td className="whitespace-nowrap px-4 py-3 font-medium text-foreground">{textValue(row.username, '-') || '-'}</td>}
                            {isAdmin && <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{textValue(row.user_role, '-') || '-'}</td>}
                            <td className="whitespace-nowrap px-4 py-3 text-foreground">{textValue(row.site_id, '-') || '-'}</td>
                            <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{textValue(row.event_type, '-') || '-'}</td>
                            <td className="max-w-[420px] px-4 py-3 text-foreground">{textValue(row.raw_message, '-') || '-'}</td>
                            <td className="whitespace-nowrap px-4 py-3">
                              <span className={`inline-flex rounded-md px-2 py-1 text-xs font-semibold ${
                                String(row.status || '').toUpperCase() === 'SUCCESS'
                                  ? 'bg-emerald-500/10 text-emerald-700'
                                  : 'bg-destructive/10 text-destructive'
                              }`}>
                                {textValue(row.status, '-') || '-'}
                              </span>
                            </td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td className="px-4 py-5 text-center text-muted-foreground" colSpan={isAdmin ? 7 : 5}>
                          No site message logs for selected date.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
          </div>
        </div>
      </div>
    </div>
  );
}
