import { useEffect, useMemo, useState } from 'react';
import {
  Download,
  ExternalLink,
  Eye,
  FileText,
  FolderOpen,
  Link as LinkIcon,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { API_BASE_URL } from '@/config/appConfig';
import { useAuth } from '@/app/appContexts';

const DEFAULT_HEADING = 'General';
const HIDDEN_DEFAULT_HEADINGS = new Set(['development document', 'site details']);

const formatBytes = (value) => {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)));
  return `${(size / (1024 ** idx)).toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
};

const formatDateTime = (value) => {
  if (!value) return 'N/A';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'N/A';
  return date.toLocaleString();
};

const normalizeHeading = (value) => String(value || '').trim().replace(/\s+/g, ' ') || DEFAULT_HEADING;

const isHiddenDefaultHeading = (value) => HIDDEN_DEFAULT_HEADINGS.has(normalizeHeading(value).toLowerCase());

const textValue = (value, fallback = '') => {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return fallback;
};

const getFileExtension = (filename) => {
  const match = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
};

const isBrowserPreviewable = (doc) => {
  const contentType = String(doc?.content_type || '').toLowerCase();
  const extension = getFileExtension(doc?.filename);
  return contentType === 'application/pdf' || extension === 'pdf';
};

const DOCUMENT_ACCESS_OPTIONS = [
  { value: 'everyone', label: 'Everyone (Admin, Intern, Employee)' },
  { value: 'admin_intern', label: 'Admin + Intern only' },
];

const getAccessLabel = (value) => (
  value === 'admin_intern' ? 'Admin + Intern' : 'Everyone (Admin, Intern, Employee)'
);

export function Documentation() {
  const { user } = useAuth() || {};
  const isAdmin = String(user?.role || '').trim().toLowerCase() === 'admin';
  const [documents, setDocuments] = useState([]);
  const [headings, setHeadings] = useState([]);
  const [activeHeading, setActiveHeading] = useState(DEFAULT_HEADING);
  const [newHeading, setNewHeading] = useState('');
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [previewDoc, setPreviewDoc] = useState(null);
  const [uploadNotice, setUploadNotice] = useState('');
  const [linkTitle, setLinkTitle] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [accessCategory, setAccessCategory] = useState('everyone');

  const userLabel = useMemo(() => {
    const name = user?.name || user?.username || user?.empId || user?.emp_id || '';
    return String(name || '').trim();
  }, [user]);

  const documentationHeaders = useMemo(() => ({
    'X-User-Role': String(user?.role || '').trim(),
    'X-User-Name': userLabel,
  }), [user?.role, userLabel]);

  const documentationAccessQuery = useMemo(() => {
    const params = new URLSearchParams();
    params.set('role', String(user?.role || '').trim());
    params.set('user_name', userLabel);
    return params.toString();
  }, [user?.role, userLabel]);

  const documentationUrl = (path) => {
    const separator = String(path || '').includes('?') ? '&' : '?';
    return `${API_BASE_URL}${path}${separator}${documentationAccessQuery}`;
  };

  const headingRows = useMemo(() => {
    const byName = new Map();
    headings.forEach((heading) => {
      const name = normalizeHeading(heading?.name);
      byName.set(name.toLowerCase(), { ...heading, name });
    });
    documents.forEach((doc) => {
      const name = normalizeHeading(doc?.heading);
      if (isHiddenDefaultHeading(name)) return;
      if (!byName.has(name.toLowerCase())) {
        byName.set(name.toLowerCase(), { id: `derived-${name}`, name });
      }
    });
    if (isAdmin && !byName.has(DEFAULT_HEADING.toLowerCase())) {
      byName.set(DEFAULT_HEADING.toLowerCase(), { id: 'default', name: DEFAULT_HEADING });
    }
    return Array.from(byName.values()).filter((heading) => !isHiddenDefaultHeading(heading?.name));
  }, [documents, headings, isAdmin]);

  const groupedDocuments = useMemo(() => {
    const groups = new Map();
    documents.forEach((doc) => {
      const name = normalizeHeading(doc?.heading);
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(doc);
    });
    return groups;
  }, [documents]);

  const activeDocuments = groupedDocuments.get(activeHeading) || [];

  const loadDocumentation = async () => {
    setLoading(true);
    try {
      const [headingResponse, documentResponse] = await Promise.all([
        fetch(`${API_BASE_URL}/documentation/headings`, { headers: documentationHeaders }),
        fetch(`${API_BASE_URL}/documentation/documents`, { headers: documentationHeaders }),
      ]);
      const headingPayload = await headingResponse.json().catch(() => ({}));
      const documentPayload = await documentResponse.json().catch(() => ({}));
      if (!headingResponse.ok) throw new Error(headingPayload?.detail || 'Failed to load headings');
      if (!documentResponse.ok) throw new Error(documentPayload?.detail || 'Failed to load documents');
      setHeadings(Array.isArray(headingPayload?.headings) ? headingPayload.headings : []);
      setDocuments(Array.isArray(documentPayload?.documents) ? documentPayload.documents : []);
    } catch (error) {
      toast.error(error?.message || 'Failed to load documentation');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDocumentation();
  }, [documentationHeaders]);

  useEffect(() => {
    if (!headingRows.length) return;
    const exists = headingRows.some((heading) => normalizeHeading(heading.name) === activeHeading);
    if (!exists) setActiveHeading(normalizeHeading(headingRows[0].name));
  }, [activeHeading, headingRows]);

  const handleCreateHeading = async () => {
    if (!isAdmin) return;
    const name = normalizeHeading(newHeading);
    if (!name) {
      toast.error('Enter heading name');
      return;
    }
    const form = new FormData();
    form.append('name', name);
    form.append('created_by', userLabel);
    try {
      const response = await fetch(`${API_BASE_URL}/documentation/headings`, {
        method: 'POST',
        headers: documentationHeaders,
        body: form,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.detail || 'Heading create failed');
      setNewHeading('');
      setActiveHeading(normalizeHeading(payload?.heading?.name || name));
      await loadDocumentation();
      toast.success('Heading created');
    } catch (error) {
      toast.error(error?.message || 'Heading create failed');
    }
  };

  const handleDeleteHeading = async (heading) => {
    if (!isAdmin) return;
    const name = normalizeHeading(heading?.name);
    if (name === DEFAULT_HEADING) {
      toast.error('Default heading cannot be deleted');
      return;
    }
    const count = (groupedDocuments.get(name) || []).length;
    const confirmed = window.confirm(`Delete "${name}" heading and ${count} document(s) inside it?`);
    if (!confirmed) return;
    try {
      const response = await fetch(`${API_BASE_URL}/documentation/headings/${heading.id}`, {
        method: 'DELETE',
        headers: documentationHeaders,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.detail || 'Heading delete failed');
      if (activeHeading === name) setActiveHeading(DEFAULT_HEADING);
      await loadDocumentation();
      toast.success('Heading deleted');
    } catch (error) {
      toast.error(error?.message || 'Heading delete failed');
    }
  };

  const appendCommonUploadFields = (form) => {
    form.append('uploaded_by', userLabel);
    form.append('role', String(user?.role || '').trim());
    form.append('access_category', accessCategory);
    form.append('heading', activeHeading);
  };

  const handleUpload = async () => {
    if (!isAdmin) {
      toast.error('Only admin users can upload documents');
      return;
    }
    if (!selectedFile) {
      toast.error('Please choose a document to upload');
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', selectedFile, selectedFile.name);
      appendCommonUploadFields(form);
      const response = await fetch(`${API_BASE_URL}/documentation/documents`, {
        method: 'POST',
        body: form,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.detail || 'Document upload failed');
      const uploadedName = payload?.document?.filename || selectedFile.name || 'Document';
      setSelectedFile(null);
      await loadDocumentation();
      setUploadNotice(`${uploadedName} uploaded under ${activeHeading}`);
      toast.success('Document uploaded');
    } catch (error) {
      toast.error(error?.message || 'Document upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleLinkUpload = async () => {
    if (!isAdmin) {
      toast.error('Only admin users can upload links');
      return;
    }
    const title = linkTitle.trim();
    const url = linkUrl.trim();
    if (!title || !url) {
      toast.error('Please enter a link title and URL');
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.append('title', title);
      form.append('url', url);
      appendCommonUploadFields(form);
      const response = await fetch(`${API_BASE_URL}/documentation/links`, {
        method: 'POST',
        body: form,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.detail || 'Link upload failed');
      setLinkTitle('');
      setLinkUrl('');
      await loadDocumentation();
      setUploadNotice(`${payload?.document?.filename || title} link uploaded under ${activeHeading}`);
      toast.success('Link uploaded');
    } catch (error) {
      toast.error(error?.message || 'Link upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (doc) => {
    if (!isAdmin) {
      toast.error('Only admin users can delete documents');
      return;
    }
    const confirmed = window.confirm(`Delete document "${textValue(doc?.filename, 'document')}"?`);
    if (!confirmed) return;
    try {
      const response = await fetch(`${API_BASE_URL}/documentation/documents/${doc.id}`, {
        method: 'DELETE',
        headers: documentationHeaders,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.detail || 'Document delete failed');
      if (previewDoc?.id === doc.id) setPreviewDoc(null);
      await loadDocumentation();
      toast.success('Document deleted');
    } catch (error) {
      toast.error(error?.message || 'Document delete failed');
    }
  };

  return (
    <div className="flex-1 min-h-0 bg-background text-foreground overflow-auto">
      <div className="p-4 sm:p-6 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Documentation</h1>
          </div>
          <button
            type="button"
            onClick={loadDocumentation}
            disabled={loading}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-border bg-card text-sm font-semibold hover:bg-accent disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {uploadNotice && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm font-semibold text-emerald-600">
            {uploadNotice}
          </div>
        )}

        {isAdmin && (
          <div className="rounded-xl border border-border bg-card p-4 sm:p-5 space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(180px,0.8fr)_minmax(180px,0.8fr)_minmax(180px,0.8fr)] gap-3">
              <label className="grid gap-1.5">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Heading</span>
                <select
                  value={activeHeading}
                  onChange={(event) => setActiveHeading(normalizeHeading(event.target.value))}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                >
                  {headingRows.map((heading) => (
                    <option key={heading.id || heading.name} value={normalizeHeading(heading.name)}>
                      {normalizeHeading(heading.name)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1.5">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Visible to</span>
                <select
                  value={accessCategory}
                  onChange={(event) => setAccessCategory(event.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                >
                  {DOCUMENT_ACCESS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <div className="grid gap-1.5">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Create heading</span>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newHeading}
                    onChange={(event) => setNewHeading(event.target.value)}
                    placeholder="Site Details"
                    className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  <button
                    type="button"
                    onClick={handleCreateHeading}
                    disabled={!newHeading.trim()}
                    className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-border bg-background text-sm font-semibold hover:bg-accent disabled:opacity-50"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>

            <div className="flex flex-col md:flex-row md:items-center gap-3">
              <label className="flex-1">
                <span className="sr-only">Choose document</span>
                <input
                  type="file"
                  onChange={(event) => setSelectedFile(event.target.files?.[0] || null)}
                  className="block w-full text-sm text-muted-foreground file:mr-4 file:rounded-lg file:border-0 file:bg-primary file:px-4 file:py-2 file:text-sm file:font-semibold file:text-primary-foreground hover:file:opacity-90"
                />
              </label>
              <button
                type="button"
                onClick={handleUpload}
                disabled={uploading || !selectedFile}
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 disabled:opacity-50"
              >
                <Upload className="w-4 h-4" />
                {uploading ? 'Uploading...' : 'Upload'}
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.3fr)_auto] gap-3">
              <input
                type="text"
                value={linkTitle}
                onChange={(event) => setLinkTitle(event.target.value)}
                placeholder="Link title"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
              <input
                type="url"
                value={linkUrl}
                onChange={(event) => setLinkUrl(event.target.value)}
                placeholder="https://example.com"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
              <button
                type="button"
                onClick={handleLinkUpload}
                disabled={uploading || !linkTitle.trim() || !linkUrl.trim()}
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg border border-border bg-background text-sm font-semibold hover:bg-accent disabled:opacity-50"
              >
                <LinkIcon className="w-4 h-4" />
                Add Link
              </button>
            </div>

            {selectedFile && (
              <div className="text-xs text-muted-foreground">
                Selected: <span className="font-semibold text-foreground">{selectedFile.name}</span> ({formatBytes(selectedFile.size)})
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-[280px_minmax(0,1fr)] gap-4">
          <aside className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <div className="text-sm font-semibold">Headings</div>
              <div className="text-xs text-muted-foreground">{headingRows.length}</div>
            </div>
            <div className="divide-y divide-border">
              {headingRows.map((heading) => {
                const name = normalizeHeading(heading.name);
                const count = (groupedDocuments.get(name) || []).length;
                const active = activeHeading === name;
                return (
                  <div key={heading.id || name} className={active ? 'bg-primary/5' : ''}>
                    <button
                      type="button"
                      onClick={() => setActiveHeading(name)}
                      className="w-full px-4 py-3 text-left flex items-center gap-3 hover:bg-muted/40"
                    >
                      <FolderOpen className={`w-4 h-4 ${active ? 'text-primary' : 'text-muted-foreground'}`} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-foreground">{name}</span>
                        <span className="block text-xs text-muted-foreground">{count} document{count === 1 ? '' : 's'}</span>
                      </span>
                    </button>
                    {isAdmin && name !== DEFAULT_HEADING && !String(heading.id || '').startsWith('derived-') && (
                      <button
                        type="button"
                        onClick={() => handleDeleteHeading(heading)}
                        className="mx-4 mb-3 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-red-500/30 bg-red-500/10 text-red-500 text-xs font-semibold hover:bg-red-500/15"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Delete heading
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </aside>

          <section className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold">{activeHeading}</div>
                <div className="text-xs text-muted-foreground">{activeDocuments.length} document{activeDocuments.length === 1 ? '' : 's'}</div>
              </div>
            </div>
            <div className="overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/60">
                  <tr>
                    {['Document', 'Uploaded By', 'Uploaded At', 'Size', 'Actions', ...(isAdmin ? ['Visible to'] : [])].map((header) => (
                      <th key={header} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground whitespace-nowrap">
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {loading ? (
                    <tr>
                      <td colSpan={isAdmin ? 6 : 5} className="px-4 py-8 text-center text-muted-foreground">Loading documents...</td>
                    </tr>
                  ) : activeDocuments.length === 0 ? (
                    <tr>
                      <td colSpan={isAdmin ? 6 : 5} className="px-4 py-8 text-center text-muted-foreground">No documents uploaded in this heading.</td>
                    </tr>
                  ) : (
                    activeDocuments.map((doc) => (
                      <tr key={doc.id} className="hover:bg-muted/40">
                        <td className="px-4 py-3 min-w-[260px]">
                          <div className="flex items-center gap-3">
                            <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                              {doc.document_type === 'link' ? <LinkIcon className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
                            </span>
                            <div>
                              <div className="font-semibold text-foreground">{textValue(doc.filename, 'Document')}</div>
                              <div className="text-xs text-muted-foreground">
                                {doc.document_type === 'link' ? textValue(doc.link_url, 'Link') : textValue(doc.content_type, 'application/octet-stream')}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{textValue(doc.uploaded_by, 'N/A') || 'N/A'}</td>
                        <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{formatDateTime(doc.uploaded_at)}</td>
                        <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{doc.document_type === 'link' ? 'Link' : formatBytes(doc.size)}</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-2">
                            {doc.document_type === 'link' ? (
                              <a
                                href={textValue(doc.link_url, '#')}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:opacity-90"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                                Open
                              </a>
                            ) : (
                              <>
                                {isBrowserPreviewable(doc) && (
                                  <button
                                    type="button"
                                    onClick={() => setPreviewDoc(doc)}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border bg-background text-xs font-semibold hover:bg-accent"
                                  >
                                    <Eye className="w-3.5 h-3.5" />
                                    Preview
                                  </button>
                                )}
                                <a
                                  href={documentationUrl(textValue(doc.download_url, ''))}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:opacity-90"
                                >
                                  <Download className="w-3.5 h-3.5" />
                                  Download
                                </a>
                              </>
                            )}
                            {isAdmin && (
                              <button
                                type="button"
                                onClick={() => handleDelete(doc)}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-red-500/30 bg-red-500/10 text-red-500 text-xs font-semibold hover:bg-red-500/15"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                                Delete
                              </button>
                            )}
                          </div>
                        </td>
                        {isAdmin && (
                          <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                            {getAccessLabel(textValue(doc.access_category))}
                          </td>
                        )}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>

      {previewDoc && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="w-full max-w-5xl h-[82vh] rounded-xl bg-card border border-border shadow-xl flex flex-col overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-semibold truncate">{textValue(previewDoc.filename, 'Document')}</div>
                <div className="text-xs text-muted-foreground">{textValue(previewDoc.content_type, 'application/octet-stream')}</div>
              </div>
              <button
                type="button"
                onClick={() => setPreviewDoc(null)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border hover:bg-accent"
                aria-label="Close preview"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {isBrowserPreviewable(previewDoc) ? (
              <iframe
                title={textValue(previewDoc.filename, 'Document')}
                src={documentationUrl(textValue(previewDoc.preview_url, ''))}
                className="flex-1 w-full bg-white"
              />
            ) : (
              <div className="flex-1 bg-background flex items-center justify-center p-6">
                <div className="max-w-md text-center space-y-4">
                  <div className="mx-auto h-14 w-14 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
                    <FileText className="w-7 h-7" />
                  </div>
                  <div>
                    <div className="text-base font-semibold text-foreground">Preview is not available for this file type</div>
                    <div className="mt-1 text-sm text-muted-foreground">
                      This uploaded file type cannot be rendered directly inside the browser preview.
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
