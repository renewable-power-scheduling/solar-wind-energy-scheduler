import React from 'react';

export default function DownloadFormatModal({
  open,
  title = 'Select file format',
  format = 'csv',
  formats = ['csv', 'xlsx'],
  onFormatChange,
  onClose,
  onDownload,
}) {
  if (!open) return null;

  const options = [
    { value: 'csv', label: 'CSV' },
    { value: 'xlsx', label: 'Excel (.xlsx)' },
    { value: 'pdf', label: 'PDF (.pdf)' },
  ].filter((opt) => formats.includes(opt.value));

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">
        <div className="px-6 py-4 border-b border-slate-700">
          <h2 className="text-lg font-semibold text-white">{title}</h2>
        </div>
        <div className="p-6 space-y-4">
          <p className="text-sm font-semibold text-black">Select file format:</p>
          <div className="space-y-3">
            {options.map((opt) => (
              <label key={opt.value} className="flex items-center gap-3 text-sm text-slate-200">
                <input
                  type="radio"
                  name="download-format"
                  value={opt.value}
                  checked={format === opt.value}
                  onChange={() => onFormatChange?.(opt.value)}
                  {...(opt.value === 'xlsx' ? { 'data-guide-id': 'download-format-xlsx' } : {})}
                  className="h-4 w-4 text-indigo-500 border-slate-600 bg-slate-800 focus:ring-indigo-500/60"
                />
                {opt.label}
              </label>
            ))}
          </div>
        </div>
        <div className="px-6 pb-6 flex items-center gap-3">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 rounded-xl border border-slate-700 text-slate-300 hover:bg-slate-800 transition-all font-medium"
          >
            Cancel
          </button>
          <button
            onClick={onDownload}
            data-guide-id="download-format-download"
            className="flex-1 px-4 py-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-500 transition-all font-medium"
          >
            Download
          </button>
        </div>
      </div>
    </div>
  );
}
