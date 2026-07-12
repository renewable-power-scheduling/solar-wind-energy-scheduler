import { useEffect, useMemo, useState } from 'react';
import { Download, ExternalLink, Eye, FileText, Link as LinkIcon, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { API_BASE_URL } from '@/config/appConfig';
import { useAuth } from '@/app/appContexts';

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

const getFileExtension = (filename) => {
  const match = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
};

const isBrowserPreviewable = (doc) => {
  const contentType = String(doc?.content_type || '').toLowerCase();
  const extension = getFileExtension(doc?.filename);
  if (contentType.startsWith('image/') || contentType.startsWith('text/')) return true;
  if (contentType === 'application/pdf') return true;
  if (['csv', 'txt', 'json', 'xml', 'html', 'htm', 'log', 'docx', 'xlsx', 'xlsm', 'xltx', 'xltm'].includes(extension)) return true;
  return false;
};

const DOCUMENT_ACCESS_OPTIONS = [
  { value: 'everyone', label: 'Everyone' },
  { value: 'admin_intern', label: 'Admin + Intern only' },
];

const getAccessLabel = (value) => (
  value === 'admin_intern' ? 'Admin + Intern' : 'Everyone'
);

export function Documentation() {
  const { user } = useAuth() || {};
  const isAdmin = String(user?.role || '').trim().toLowerCase() === 'admin';
  const [documents, setDocuments] = useState([]);
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

  const loadDocuments = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/documentation/documents`, {
        headers: documentationHeaders,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.detail || 'Failed to load documents');
      setDocuments(Array.isArray(payload?.documents) ? payload.documents : []);
    } catch (error) {
      toast.error(error?.message || 'Failed to load documents');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDocuments();
  }, [documentationHeaders]);

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
      form.append('uploaded_by', userLabel);
      form.append('role', String(user?.role || '').trim());
      form.append('access_category', accessCategory);
      const response = await fetch(`${API_BASE_URL}/documentation/documents`, {
        method: 'POST',
        body: form,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.detail || 'Document upload failed');
      const uploadedName = payload?.document?.filename || selectedFile.name || 'Document';
      const successMessage = `${uploadedName} is uploaded`;
      setSelectedFile(null);
      await loadDocuments();
      setUploadNotice(successMessage);
      toast.success(successMessage);
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
      form.append('uploaded_by', userLabel);
      form.append('role', String(user?.role || '').trim());
      form.append('access_category', accessCategory);
      const response = await fetch(`${API_BASE_URL}/documentation/links`, {
        method: 'POST',
        body: form,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.detail || 'Link upload failed');
      setLinkTitle('');
      setLinkUrl('');
      await loadDocuments();
      setUploadNotice(`${payload?.document?.filename || title} link is uploaded`);
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
    const confirmed = window.confirm(`Delete document "${doc?.filename || 'document'}"?`);
    if (!confirmed) return;
    try {
      const response = await fetch(`${API_BASE_URL}/documentation/documents/${doc.id}`, {
        method: 'DELETE',
        headers: {
          'X-User-Role': 'admin',
          'X-User-Name': userLabel,
        },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.detail || 'Document delete failed');
      if (previewDoc?.id === doc.id) setPreviewDoc(null);
      await loadDocuments();
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
            onClick={loadDocuments}
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
          <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <div className="grid gap-4">
              <label className="grid gap-1.5 sm:max-w-xs">
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
            </div>
            {selectedFile && (
              <div className="mt-3 text-xs text-muted-foreground">
                Selected: <span className="font-semibold text-foreground">{selectedFile.name}</span> ({formatBytes(selectedFile.size)})
              </div>
            )}
          </div>
        )}

        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <div className="text-sm font-semibold">Documents</div>
            <div className="text-xs text-muted-foreground">{documents.length} items</div>
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
                ) : documents.length === 0 ? (
                  <tr>
                    <td colSpan={isAdmin ? 6 : 5} className="px-4 py-8 text-center text-muted-foreground">No documents uploaded.</td>
                  </tr>
                ) : (
                  documents.map((doc) => (
                    <tr key={doc.id} className="hover:bg-muted/40">
                      <td className="px-4 py-3 min-w-[260px]">
                        <div className="flex items-center gap-3">
                          <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                            {doc.document_type === 'link' ? <LinkIcon className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
                          </span>
                          <div>
                            <div className="font-semibold text-foreground">{doc.filename}</div>
                            <div className="text-xs text-muted-foreground">
                              {doc.document_type === 'link' ? doc.link_url : (doc.content_type || 'application/octet-stream')}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{doc.uploaded_by || 'N/A'}</td>
                      <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{formatDateTime(doc.uploaded_at)}</td>
                      <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{doc.document_type === 'link' ? 'Link' : formatBytes(doc.size)}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-2">
                          {doc.document_type === 'link' ? (
                            <a
                              href={doc.link_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:opacity-90"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                              Open
                            </a>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() => setPreviewDoc(doc)}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border bg-background text-xs font-semibold hover:bg-accent"
                              >
                                <Eye className="w-3.5 h-3.5" />
                                Preview
                              </button>
                              <a
                                href={documentationUrl(doc.download_url)}
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
                          {getAccessLabel(doc.access_category)}
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {previewDoc && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="w-full max-w-5xl h-[82vh] rounded-xl bg-card border border-border shadow-xl flex flex-col overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-semibold truncate">{previewDoc.filename}</div>
                <div className="text-xs text-muted-foreground">{previewDoc.content_type || 'application/octet-stream'}</div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPreviewDoc(null)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border hover:bg-accent"
                  aria-label="Close preview"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            {isBrowserPreviewable(previewDoc) ? (
              <iframe
                title={previewDoc.filename}
                src={documentationUrl(previewDoc.preview_url)}
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
