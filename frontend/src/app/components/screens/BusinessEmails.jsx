import { useEffect, useMemo, useState } from 'react';
import { FileUp, Mail, Paperclip, Send, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { API_ORIGIN } from '@/config/appConfig';
import { useAuth } from '@/app/appContexts';

const businessEmailBase = () => (API_ORIGIN ? `${API_ORIGIN}/api/business-emails` : '/api/business-emails');

const DEFAULT_SUBJECT = 'Powering Precision: Forecasting & Scheduling Partner for Your Renewable Energy Assets.';
const DEFAULT_BODY = `Dear Sir/Madam,
Warm greetings from Vedanjay Power Pvt. Ltd. (VPPL)!

Looking for a trusted QCA Services (Forecasting & Scheduling) partner with proven accuracy, compliance strength, and industry excellence?

Vedanjay Power Pvt. Ltd. is among India's leading QCA Services (Forecasting & Scheduling) companies, with strong expertise in renewable energy forecasting, DSM optimization, and SLDC coordination. In partnership with ENERCAST GmbH (Germany), we deliver AI-driven solar, wind, and hybrid forecasting solutions to help generators minimize DSM penalties, ensure regulatory compliance, and maximize generation value.

Why Choose VPPL:
High-accuracy forecasting using advanced AI models
End-to-end SLDC coordination and multi-state compliance support
24/7 monitoring through a dedicated control center
Transparent generator access for live schedules and deviation tracking
Pan-India QCA approval across all states
Weekly and monthly Reports along with Provisional and Final DSM Reports.

Additional Services:
Compliance with CEA Technical Standards Regulations, 2019, including Grid Simulation Reports and Harmonics Study Reports for seamless grid integration

Currently, we are managing 5509.18 MW of renewable energy capacity across India and are trusted by leading developers for reliable, data-driven forecasting performance.

At your convenience, we would be pleased to schedule a brief demo meeting to walk you through our forecasting platform, workflows, and performance capabilities in detail.

Next Step:
Please fill out the short form below, and our team will contact you to arrange a discussion.
https://forms.gle/hj4z8xhhR8C3LahR9

Best Regards,
Vedanjay Power Private Ltd.
Forecasting And Scheduling Dept.
Flat no-210, Grand Horizon, Behind Bramha Hotel,
Anand Nagar, Sinhgad road, Pune-411041.
Mob.: +91 7666901814
Email id: forecasting.india@vedanjay-power.com
forecasting.vppl@gmail.com
Website: http://www.vedanjay-power.com`;
const BUSINESS_EMAIL_DRAFT_KEY = 'business-emails:draft:v10';
const BUSINESS_EMAIL_NEXT_STEP_FORM_URL = 'https://forms.gle/hj4z8xhhR8C3LahR9';
const BUSINESS_EMAIL_BANNER_SRC = '/business-email/vedanjay-greeting-banner.png';
const BUSINESS_EMAIL_PROJECTS_SRC = '/business-email/vedanjay-projects-hq.png';
const BUSINESS_EMAIL_LOGO_SRC = '/image.png';
const BUSINESS_EMAIL_BANNER_CID = 'business_email_greeting_banner';
const BUSINESS_EMAIL_PROJECTS_CID = 'business_email_projects';
const BUSINESS_EMAIL_LOGO_CID = 'business_email_vedanjay_logo';
const BUSINESS_EMAIL_INLINE_IMAGE_ASSETS = [
  {
    cid: BUSINESS_EMAIL_BANNER_CID,
    src: BUSINESS_EMAIL_BANNER_SRC,
    filename: 'vedanjay-greeting-banner.png',
  },
  {
    cid: BUSINESS_EMAIL_PROJECTS_CID,
    src: BUSINESS_EMAIL_PROJECTS_SRC,
    filename: 'vedanjay-projects-hq.png',
  },
  {
    cid: BUSINESS_EMAIL_LOGO_CID,
    src: BUSINESS_EMAIL_LOGO_SRC,
    filename: 'vedanjay-power-logo.png',
  },
];

const inputClass =
  'h-11 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15';
const textareaClass =
  'min-h-[280px] w-full rounded-md border border-border bg-background px-3 py-3 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15';

const formatApiError = (payload, fallback) => {
  const detail = payload?.detail || payload?.message;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        if (typeof item === 'string') return item;
        const path = Array.isArray(item?.loc) ? item.loc.join('.') : '';
        return [path, item?.msg].filter(Boolean).join(': ');
      })
      .filter(Boolean)
      .join('; ') || fallback;
  }
  return fallback;
};

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const BUSINESS_EMAIL_BOLD_PHRASES = [
  'we are managing 5509.18 MW of renewable energy capacity',
  'CEA Technical Standards Regulations, 2019',
  'Grid Simulation Reports',
  'QCA Services (Forecasting & Scheduling)',
  'Harmonics Study Reports',
  'renewable energy forecasting, DSM optimization, and SLDC coordination',
  'ENERCAST GmbH (Germany)',
  'AI-driven solar, wind, and hybrid forecasting solutions',
];

const highlightBusinessEmailPhrases = (value) => {
  let html = escapeHtml(value);
  BUSINESS_EMAIL_BOLD_PHRASES.forEach((phrase) => {
    const escapedPhrase = escapeHtml(phrase);
    html = html.split(escapedPhrase).join(`<span style="font-weight:700;color:#111827;">${escapedPhrase}</span>`);
  });
  return html;
};

const renderBusinessDraftLine = (line, { logoSrc = BUSINESS_EMAIL_LOGO_SRC } = {}) => {
  const text = String(line || '').trim();
  if (!text) return '<div style="height:12px;line-height:12px;">&nbsp;</div>';
  if (text === 'Warm greetings from Vedanjay Power Pvt. Ltd. (VPPL)!') {
    return '<div style="font-weight:700;color:#111827;margin:6px 0;">Warm greetings from Vedanjay Power Pvt. Ltd. (VPPL)!</div>';
  }
  if (text === 'Best regards,' || text === 'Best Regards,') {
    return `<div style="font-weight:700;color:#243746;margin:18px 0 8px;">${escapeHtml(text)}</div>`;
  }
  if (text === 'Forecasting And Scheduling Dept.') {
    return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;color:#355b2d;line-height:1.45;margin:4px 0 2px;">Forecasting And Scheduling Dept.</div>';
  }
  if (text.startsWith('Flat no-') || text.startsWith('Anand Nagar,')) {
    return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111827;line-height:1.45;margin:0;">${escapeHtml(text)}</div>`;
  }
  if (text.startsWith('Mob.:')) {
    return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#f04b23;line-height:1.45;margin:0;">${escapeHtml(text)}</div>`;
  }
  if (text.startsWith('Email id:')) {
    const label = 'Email id:';
    const email = text.slice(label.length).trim();
    return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;margin:0;"><span style="color:#111827;">${label}</span> <span style="color:#0055ff;">${escapeHtml(email)}</span></div>`;
  }
  if (text === 'forecasting.vppl@gmail.com') {
    return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0055ff;line-height:1.45;margin:0 0 0 66px;">${escapeHtml(text)}</div>`;
  }
  if (text.startsWith('Website:')) {
    const label = 'Website:';
    const url = text.slice(label.length).trim();
    return [
      `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;margin:0;"><span style="color:#111827;">${label}</span> <span style="color:#0055ff;">${escapeHtml(url)}</span></div>`,
      `<img src="${logoSrc}" alt="Vedanjay Power" style="display:block;width:360px;max-width:100%;height:auto;margin:10px 0 0 0;border:0;" />`,
    ].join('');
  }
  if (text === 'Why Choose VPPL:' || text === 'Additional Services:') {
    return `<div style="font-weight:700;color:#0f4f7a;margin:14px 0 6px;">${escapeHtml(text)}</div>`;
  }
  if (text.startsWith('Currently, we are managing ')) {
    return `<div style="margin:12px 0;">${highlightBusinessEmailPhrases(text)}</div>`;
  }
  if (text.startsWith('At your convenience,')) {
    return `<div style="font-weight:700;color:#111827;margin:12px 0;">${escapeHtml(text)}</div>`;
  }
  if (text === 'Next Step:') {
    return `<div style="font-weight:700;color:#111827;margin:12px 0 2px;">${escapeHtml(text)}</div>`;
  }
  if (text === BUSINESS_EMAIL_NEXT_STEP_FORM_URL) {
    const url = escapeHtml(text);
    return `<div style="margin:4px 0 12px;"><a href="${url}" target="_blank" rel="noopener noreferrer" style="color:#0055ff;text-decoration:underline;">${url}</a></div>`;
  }
  if (/^(High-accuracy|End-to-end|24\/7|Transparent|Pan-India|Weekly and monthly)/.test(text)) {
    return `<div style="margin:4px 0 4px 18px;">&#8226; ${escapeHtml(text)}</div>`;
  }
  return `<div style="margin:6px 0;">${highlightBusinessEmailPhrases(text)}</div>`;
};

const injectBusinessEmployeeName = (bodyText, employeeName) => {
  const safeEmployee = String(employeeName || '').trim() || 'Vedanjay Power Private Ltd.';
  const lines = String(bodyText || '').split(/\r?\n/);

  const bestRegardsIndex = lines.findIndex((line) => {
    const text = String(line || '').trim();
    return text === 'Best regards,' || text === 'Best Regards,';
  });
  if (bestRegardsIndex < 0) return lines.join('\n');

  const nextLine = String(lines[bestRegardsIndex + 1] || '').trim();
  if (nextLine === safeEmployee) return lines.join('\n');
  if (nextLine && nextLine !== 'Forecasting And Scheduling Dept.' && nextLine !== 'Forecasting and QCA Department,') {
    const nextLines = [...lines];
    nextLines[bestRegardsIndex + 1] = safeEmployee;
    return nextLines.join('\n');
  }
  return [
    ...lines.slice(0, bestRegardsIndex + 1),
    safeEmployee,
    ...lines.slice(bestRegardsIndex + 1),
  ].join('\n');
};

const buildBusinessEmailHtml = (bodyText, { useCidImages = false, employeeName = '' } = {}) => {
  const bannerSrc = useCidImages ? `cid:${BUSINESS_EMAIL_BANNER_CID}` : BUSINESS_EMAIL_BANNER_SRC;
  const projectsSrc = useCidImages ? `cid:${BUSINESS_EMAIL_PROJECTS_CID}` : BUSINESS_EMAIL_PROJECTS_SRC;
  const logoSrc = useCidImages ? `cid:${BUSINESS_EMAIL_LOGO_CID}` : BUSINESS_EMAIL_LOGO_SRC;
  const lines = injectBusinessEmployeeName(bodyText, employeeName).split(/\r?\n/);
  const signatureStart = lines.findIndex((line) => {
    const text = String(line || '').trim();
    return text === 'Best regards,' || text === 'Best Regards,' || text === 'Forecasting And Scheduling Dept.' || text === 'Forecasting and QCA Department,';
  });
  const bodyLines = signatureStart >= 0 ? lines.slice(0, signatureStart) : lines;
  const signatureLines = signatureStart >= 0 ? lines.slice(signatureStart) : [];
  const convenienceIndex = bodyLines.findIndex((line) => String(line || '').trim().startsWith('At your convenience,'));
  const projectImageHtml = `<img src="${projectsSrc}" alt="Vedanjay Power projects and capacities" style="display:block;width:100%;max-width:948px;height:auto;margin:18px 0;border:0;" />`;
  const bodyContent = convenienceIndex >= 0
    ? [
        bodyLines.slice(0, convenienceIndex).map((line) => renderBusinessDraftLine(line, { logoSrc })).join(''),
        projectImageHtml,
        bodyLines.slice(convenienceIndex).map((line) => renderBusinessDraftLine(line, { logoSrc })).join(''),
      ].join('')
    : `${bodyLines.map((line) => renderBusinessDraftLine(line, { logoSrc })).join('')}${projectImageHtml}`;
  const signatureContent = signatureLines.map((line) => renderBusinessDraftLine(line, { logoSrc })).join('');

  return `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#243746;max-width:948px;">
      <img src="${bannerSrc}" alt="Warm greetings from Vedanjay Power Pvt. Ltd. (VPPL)" style="display:block;width:100%;max-width:904px;height:auto;margin:0 0 18px;border:0;" />
      ${bodyContent}
      ${signatureContent}
    </div>
  `.trim();
};

const appendBusinessInlineImages = async (formData) => {
  const fetchResults = await Promise.allSettled(
    BUSINESS_EMAIL_INLINE_IMAGE_ASSETS.map(async (asset) => {
      const response = await fetch(asset.src, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Failed to load ${asset.filename}`);
      return {
        ...asset,
        blob: await response.blob(),
      };
    }),
  );

  fetchResults.forEach((result) => {
    if (result.status !== 'fulfilled') return;
    const { cid, filename, blob } = result.value;
    formData.append('inline_image_cid', cid);
    formData.append('inline_image', new File([blob], filename, { type: blob.type || 'image/png' }));
  });
};

export function BusinessEmails() {
  const { user: currentUser } = useAuth() || {};
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [employeeName, setEmployeeName] = useState('Vedanjay Power Private Ltd.');
  const [fromEmail, setFromEmail] = useState('forecasting.india@vedanjay-power.com');
  const [toEmail, setToEmail] = useState('');
  const [ccEmail, setCcEmail] = useState('');
  const [bccEmail, setBccEmail] = useState('');
  const [subject, setSubject] = useState(DEFAULT_SUBJECT);
  const [body, setBody] = useState(DEFAULT_BODY);
  const [attachments, setAttachments] = useState([]);
  const [sending, setSending] = useState(false);
  const [logDate, setLogDate] = useState(todayIso);
  const [logRows, setLogRows] = useState([]);
  const [logLoading, setLogLoading] = useState(false);

  useEffect(() => {
    setEmployeeName((current) => String(current || '').trim() || 'Vedanjay Power Private Ltd.');
  }, [currentUser]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(BUSINESS_EMAIL_DRAFT_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved && typeof saved === 'object') {
        if (typeof saved.fromEmail === 'string') setFromEmail(saved.fromEmail);
        if (typeof saved.toEmail === 'string') setToEmail(saved.toEmail);
        if (typeof saved.ccEmail === 'string') setCcEmail(saved.ccEmail);
        if (typeof saved.bccEmail === 'string') setBccEmail(saved.bccEmail);
        if (typeof saved.subject === 'string') setSubject(saved.subject);
        if (typeof saved.body === 'string') setBody(saved.body);
      }
    } catch {
      // ignore draft restore failures
    }
  }, []);

  const attachmentInfo = useMemo(() => {
    if (!attachments.length) return [];
    return attachments.map((file, index) => ({
      id: `${file.name}-${file.size}-${file.lastModified}-${index}`,
      name: file.name,
      sizeKb: Math.max(1, Math.round((file.size || 0) / 1024)),
    }));
  }, [attachments]);

  const resetAttachment = () => setAttachments([]);
  const saveDraft = () => {
    try {
      window.localStorage.setItem(
        BUSINESS_EMAIL_DRAFT_KEY,
        JSON.stringify({
          fromEmail: String(fromEmail || ''),
          toEmail: String(toEmail || ''),
          ccEmail: String(ccEmail || ''),
          bccEmail: String(bccEmail || ''),
          subject: String(subject || ''),
          body: String(body || ''),
        }),
      );
      toast.success('Draft saved');
    } catch {
      toast.error('Unable to save draft');
    }
  };

  const clearDraft = () => {
    setFromEmail('forecasting.india@vedanjay-power.com');
    setToEmail('');
    setCcEmail('');
    setBccEmail('');
    setSubject(DEFAULT_SUBJECT);
    setBody(DEFAULT_BODY);
    resetAttachment();
    try {
      window.localStorage.removeItem(BUSINESS_EMAIL_DRAFT_KEY);
    } catch {
      // ignore clear failures
    }
    toast.success('Changes cleared');
  };

  const loadLogs = async (selectedDate) => {
    setLogLoading(true);
    try {
      const qs = new URLSearchParams();
      if (selectedDate) qs.set('log_date', selectedDate);
      qs.set('limit', '100');
      const response = await fetch(`${businessEmailBase()}/logs?${qs.toString()}`, {
        headers: {
          'X-User-Role': String(currentUser?.role || '').trim(),
          'X-User-Name': String(currentUser?.username || currentUser?.empId || '').trim(),
        },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(formatApiError(payload, `Request failed (${response.status})`));
      }
      setLogRows(Array.isArray(payload?.items) ? payload.items : []);
    } catch (error) {
      setLogRows([]);
      toast.error(error?.message || 'Failed to load email logs');
    } finally {
      setLogLoading(false);
    }
  };

  const sendBusinessEmail = async () => {
    const safeTo = String(toEmail || '').trim();
    const safeBcc = String(bccEmail || '').trim();
    const safeSubject = String(subject || '').trim();
    const safeBody = String(body || '').trim();
    if (!safeTo && !safeBcc) {
      toast.error('To or BCC email is required');
      return;
    }
    if (!safeSubject) {
      toast.error('Subject is required');
      return;
    }
    if (!safeBody) {
      toast.error('Body is required');
      return;
    }

    if (!attachments.length) {
      toast.error('Add at least one attachment');
      return;
    }
    const invalidAttachment = attachments.find((file) => {
      const lower = String(file.name || '').toLowerCase();
      return !lower.endsWith('.pdf') && !lower.endsWith('.xlsx') && !lower.endsWith('.xls');
    });
    if (invalidAttachment) {
      toast.error('Attachments must be PDF or XLSX files');
      return;
    }

    const safeEmployeeName = String(employeeName || '').trim() || 'Vedanjay Power Private Ltd.';
    const safeBodyForSend = injectBusinessEmployeeName(safeBody, safeEmployeeName);
    const formData = new FormData();
    formData.append('employee_name', safeEmployeeName);
    formData.append('from_email', String(fromEmail || '').trim());
    formData.append('to_email', safeTo);
    formData.append('cc_email', String(ccEmail || '').trim());
    formData.append('bcc_email', safeBcc);
    formData.append('subject', safeSubject);
    formData.append('body', safeBodyForSend);
    formData.append('body_html', buildBusinessEmailHtml(safeBody, { useCidImages: true, employeeName: safeEmployeeName }));
    attachments.forEach((file) => {
      formData.append('attachment', file);
    });
    await appendBusinessInlineImages(formData);

    setSending(true);
    try {
      const response = await fetch(`${businessEmailBase()}/send`, {
        method: 'POST',
        headers: {
          'X-User-Role': String(currentUser?.role || '').trim(),
          'X-User-Name': String(currentUser?.username || currentUser?.empId || '').trim(),
        },
        body: formData,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(formatApiError(payload, `Request failed (${response.status})`));
      }
      toast.success('Business email sent');
      resetAttachment();
      await loadLogs(logDate);
    } catch (error) {
      toast.error(error?.message || 'Failed to send business email');
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    loadLogs(logDate);
  }, [logDate]);

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-background text-foreground">
      <div className="mx-auto max-w-7xl space-y-4 px-4 py-4 sm:px-6 sm:py-5">
        <div className="flex flex-col gap-3 border-b border-border pb-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Mail className="h-4 w-4" />
              Business Communication
            </div>
            <h1 className="mt-1 text-xl font-semibold text-foreground sm:text-2xl">Business Emails</h1>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4">
          <section className="rounded-lg border border-border bg-card shadow-sm">
            <div className="border-b border-border px-4 py-3 sm:px-6">
              <div className="text-sm font-semibold text-foreground">Compose</div>
            </div>
            <div className="space-y-4 p-4 sm:p-6">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <label className="space-y-1.5 md:col-span-2">
                  <span className="text-sm font-medium text-foreground">Employee Name</span>
                  <input
                    className={inputClass}
                    value={employeeName}
                    onChange={(e) => setEmployeeName(e.target.value)}
                    placeholder="Employee name"
                  />
                </label>
                <label className="space-y-1.5 md:col-span-2">
                  <span className="text-sm font-medium text-foreground">From</span>
                  <input
                    className={inputClass}
                    value={fromEmail}
                    onChange={(e) => setFromEmail(e.target.value)}
                    placeholder="forecasting.india@vedanjay-power.com"
                  />
                </label>
                <label className="space-y-1.5">
                  <span className="text-sm font-medium text-foreground">To</span>
                  <input
                    className={inputClass}
                    value={toEmail}
                    onChange={(e) => setToEmail(e.target.value)}
                    placeholder="recipient@example.com"
                  />
                </label>
                <label className="space-y-1.5">
                  <span className="text-sm font-medium text-foreground">CC</span>
                  <input
                    className={inputClass}
                    value={ccEmail}
                    onChange={(e) => setCcEmail(e.target.value)}
                    placeholder="cc@example.com"
                  />
                </label>
                <label className="space-y-1.5 md:col-span-2">
                  <span className="text-sm font-medium text-foreground">BCC</span>
                  <input
                    className={inputClass}
                    value={bccEmail}
                    onChange={(e) => setBccEmail(e.target.value)}
                    placeholder="hidden1@example.com, hidden2@example.com"
                  />
                </label>
                <label className="space-y-1.5 md:col-span-2">
                  <span className="text-sm font-medium text-foreground">Subject</span>
                  <input
                    className={inputClass}
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                  />
                </label>
              </div>

              <label className="space-y-1.5 block">
                <span className="text-sm font-medium text-foreground">Body</span>
                <textarea
                  className={textareaClass}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
              </label>

              <div className="space-y-2 rounded-lg border border-border bg-background p-4">
                <div className="text-sm font-semibold text-foreground">Draft Preview</div>
                <div
                  className="max-w-full overflow-x-auto rounded-md border border-border bg-white p-3"
                  dangerouslySetInnerHTML={{ __html: buildBusinessEmailHtml(body, { employeeName }) }}
                />
              </div>

              <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-4">
                <div className="text-sm font-semibold text-foreground">Attachment</div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition hover:bg-accent cursor-pointer">
                    <input
                      type="file"
                      className="hidden"
                      accept=".pdf,.xlsx,.xls"
                      multiple
                      onChange={(e) => {
                        const files = Array.from(e.target.files || []);
                        e.target.value = '';
                        if (!files.length) return;
                        setAttachments((prev) => [...prev, ...files]);
                      }}
                    />
                    <FileUp className="h-4 w-4" />
                    Upload Attachment(s)
                  </label>
                  {attachmentInfo.length ? (
                    <div className="flex flex-col gap-2">
                      {attachmentInfo.map((file, index) => (
                        <div key={file.id} className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground">
                          <Paperclip className="h-4 w-4 text-muted-foreground" />
                          <span className="max-w-[320px] truncate">{file.name}</span>
                          <span className="text-muted-foreground">({file.sizeKb} KB)</span>
                          <button
                            type="button"
                            onClick={() => setAttachments((prev) => prev.filter((_, prevIndex) => prevIndex !== index))}
                            className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-foreground transition hover:bg-accent"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <span className="text-sm text-muted-foreground">PDF or XLSX</span>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={saveDraft}
                    className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground transition hover:bg-accent"
                  >
                    Save Changes
                  </button>
                  <button
                    type="button"
                    onClick={clearDraft}
                    className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground transition hover:bg-accent"
                  >
                    Clear Changes
                  </button>
                </div>
                <button
                  type="button"
                  onClick={sendBusinessEmail}
                  disabled={sending}
                  className="mx-auto inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60 sm:mx-0"
                >
                  <Send className="h-4 w-4" />
                  {sending ? 'Sending...' : 'Send Email'}
                </button>
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card shadow-sm">
            <div className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <div>
                <div className="text-sm font-semibold text-foreground">Email Log</div>
                <div className="text-xs text-muted-foreground">Filter by date to review sent recipients and delivery status.</div>
              </div>
              <label className="flex items-center gap-2 text-sm font-medium text-foreground">
                <span>Date</span>
                <input
                  type="date"
                  className={inputClass}
                  value={logDate}
                  onChange={(e) => setLogDate(e.target.value)}
                  style={{ width: 170 }}
                />
              </label>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full border-separate border-spacing-0 text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="border-b border-border px-4 py-3 font-semibold sm:px-6">Date</th>
                    <th className="border-b border-border px-4 py-3 font-semibold">Time</th>
                    <th className="border-b border-border px-4 py-3 font-semibold">To</th>
                    <th className="border-b border-border px-4 py-3 font-semibold">CC</th>
                    <th className="border-b border-border px-4 py-3 font-semibold">BCC</th>
                    <th className="border-b border-border px-4 py-3 font-semibold">Status</th>
                    <th className="border-b border-border px-4 py-3 font-semibold">Employee</th>
                  </tr>
                </thead>
                <tbody>
                  {logLoading ? (
                    <tr>
                      <td className="px-4 py-4 text-muted-foreground sm:px-6" colSpan={7}>
                        Loading logs...
                      </td>
                    </tr>
                  ) : logRows.length ? (
                    logRows.map((row) => (
                      <tr key={row.id} className="align-top">
                        <td className="border-b border-border px-4 py-3 sm:px-6">{row.date || '-'}</td>
                        <td className="border-b border-border px-4 py-3">{row.time || '-'}</td>
                        <td className="border-b border-border px-4 py-3 break-all">{row.to_email || '-'}</td>
                        <td className="border-b border-border px-4 py-3 break-all">{row.cc_email || '-'}</td>
                        <td className="border-b border-border px-4 py-3 break-all">{row.bcc_email || '-'}</td>
                        <td className="border-b border-border px-4 py-3">
                          <span
                            className={[
                              'inline-flex rounded-full px-2.5 py-1 text-xs font-semibold',
                              row.status === 'SENT'
                                ? 'bg-emerald-100 text-emerald-700'
                                : row.status === 'FAILED'
                                  ? 'bg-red-100 text-red-700'
                                  : 'bg-muted text-muted-foreground',
                            ].join(' ')}
                          >
                            {row.status || '-'}
                          </span>
                          {row.error_message ? (
                            <div className="mt-1 max-w-[220px] text-xs text-red-600">{row.error_message}</div>
                          ) : null}
                        </td>
                        <td className="border-b border-border px-4 py-3">{row.employee_name || '-'}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td className="px-4 py-4 text-muted-foreground sm:px-6" colSpan={7}>
                        No email log entries found for the selected date.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
