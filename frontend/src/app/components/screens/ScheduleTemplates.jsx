import { useMemo, useState } from 'react';
import { 
  FileText, 
  Upload, 
  CheckCircle, 
  AlertCircle, 
  Eye, 
  Download,
  RefreshCw,
  X,
  Wind,
  Sun,
  FileSpreadsheet,
  Edit3
} from 'lucide-react';
import { api } from '@/services/api';
import { useApi } from '@/hooks/useApi';
import { LoadingSpinner } from '@/app/components/common/LoadingSpinner';
import { useTheme } from '@/app/App';
import { toast } from 'sonner';
import { API_BASE_URL } from '@/config/appConfig';

const GSNP_NAME = 'Globus Steel N Power (GSNP)';

export function ScheduleTemplates({ onNavigate }) {
  const { isDarkMode } = useTheme();
  const [selectedPlant, setSelectedPlant] = useState('');
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [showValidationModal, setShowValidationModal] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [showCSVViewModal, setShowCSVViewModal] = useState(false);
  const [uploadedFile, setUploadedFile] = useState('');
  const [currentStep, setCurrentStep] = useState(1);
  const [updatePlant, setUpdatePlant] = useState(null);
  const [newTemplateVersion, setNewTemplateVersion] = useState('');
  
  const {
    data: templatesData,
    loading: templatesLoading,
    execute: fetchTemplates
  } = useApi(
    () => api.templates.getAll({}),
    { immediate: true, initialData: { templates: [], total: 0 } }
  );

  const allTemplates = useMemo(() => {
    const raw = Array.isArray(templatesData?.templates) ? templatesData.templates : [];
    const mapped = raw.map((t) => {
      const typeText = t.type || '';
      const category = typeText.toLowerCase().includes('wind')
        ? 'Wind'
        : typeText.toLowerCase().includes('solar')
          ? 'Solar'
          : 'Unknown';
      return {
        id: t.id,
        name: t.name || 'Unknown Plant',
        category,
        vendor: t.vendor || 'Unknown',
        template: t.version || 'N/A',
        updated: t.lastModified || 'Unknown',
        filePath: t.filePath || null
      };
    });

    const hasGsnp = mapped.some((item) => (item.name || '').trim().toLowerCase() === GSNP_NAME.toLowerCase());
    if (!hasGsnp) {
      mapped.push({
        id: 'gsnp-default',
        name: GSNP_NAME,
        category: 'Solar',
        vendor: 'Not Assigned',
        template: 'N/A',
        updated: 'Not Available',
        filePath: null,
      });
    }

    return mapped;
  }, [templatesData]);

  // Create template API
  const {
    loading: createLoading,
    execute: createTemplate
  } = useApi(api.templates.create, {
    onSuccess: (result) => {
      setShowUploadModal(false);
      setCurrentStep(1);
      setUpdatePlant(null);
      setUploadedFile('');
      setNewTemplateVersion('');
      fetchTemplates();
      alert('Template activated successfully!');
    },
    onError: (error) => {
      alert(`Error: ${error.message}`);
    }
  });

  const selectedPlantData = allTemplates.find((p) => String(p.id) === String(selectedPlant));

  const getTemplateUrl = (template) => {
    const filePath = template?.filePath;
    if (!filePath) return null;
    const apiBaseUrl = API_BASE_URL;
    let downloadUrl = filePath;
    if (filePath.startsWith('/')) {
      downloadUrl = `${apiBaseUrl}${filePath}`;
    } else if (!filePath.startsWith('http')) {
      downloadUrl = `${apiBaseUrl}/templates/download/${filePath}`;
    }
    return downloadUrl;
  };

  const handleDownloadTemplate = (template) => {
    const downloadUrl = getTemplateUrl(template);
    if (!downloadUrl) {
      toast.error('Template file not available for download');
      return;
    }

    const link = document.createElement('a');
    link.setAttribute('href', downloadUrl);
    link.setAttribute('download', `template-${template.name}.csv`);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      setUploadedFile(file.name);
      setShowUploadModal(false);
      setCurrentStep(2);
      // Generate new version number
      const currentVersion = updatePlant ? updatePlant.template : 'v1.0';
      const versionParts = currentVersion.replace('v', '').split('.');
      const major = parseInt(versionParts[0]) || 1;
      const minor = parseInt(versionParts[1]) || 0;
      const newVersion = `v${major}.${minor + 1}`;
      setNewTemplateVersion(newVersion);
      setTimeout(() => setShowValidationModal(true), 300);
    }
  };

  // Handle update template button click
  const handleUpdateTemplate = (plant) => {
    setUpdatePlant(plant);
    setSelectedPlant(plant.id);
    setCurrentStep(1);
    setShowUploadModal(true);
  };

  // Handle template activation (Step 4)
  const handleActivateTemplate = async () => {
    try {
      await createTemplate({
        name: updatePlant ? `${updatePlant.name} Template` : 'New Template',
        vendor: updatePlant ? updatePlant.vendor : 'Unknown',
        type: 'Schedule',
        status: 'Active',
        filePath: `/templates/${updatePlant?.id || 'new'}/${newTemplateVersion}.csv`
      });
      
      setShowConfirmModal(false);
      setCurrentStep(4);
      
      // Refresh templates list
      fetchTemplates();
      
    } catch (error) {
      // For demo, simulate successful activation
      setShowConfirmModal(false);
      setCurrentStep(4);
      setUpdatePlant(null);
      alert('Template activated successfully!');
    }
  };

  return (
    <>
      <div className="flex-1 overflow-auto bg-slate-950 min-h-0">
        {/* Animated background elements */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-0 left-1/4 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl animate-pulse" />
          <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />
        </div>

        <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-[1600px] mx-auto relative z-10">
          {/* Premium Header */}
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 border border-slate-700/50 shadow-2xl">
            <div className="absolute inset-0 bg-gradient-to-r from-indigo-500/5 via-transparent to-purple-500/5" />
            <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-bl from-indigo-500/10 to-transparent rounded-full blur-2xl" />
            
            <div className="relative p-4 sm:p-6 lg:p-8">
              <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-6">
                <div className="flex items-start gap-5">
                  <div className="relative">
                    <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/25">
                      <FileText className="w-7 h-7 text-white" />
                    </div>
                    <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-emerald-500 rounded-full border-2 border-slate-900 animate-ping" />
                  </div>
                  <div>
                    <h1 className="text-3xl font-bold text-white mb-2 tracking-tight">
                      Schedule Templates
                      <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-purple-400"> Management</span>
                    </h1>
                    <div className="flex items-center gap-4 text-slate-400">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
                        <span className="text-sm font-medium">System Active</span>
                      </div>
                      <span className="text-slate-600">•</span>
                      <span className="text-sm">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</span>
                    </div>
                    <p className="text-sm text-slate-400 mt-2 flex items-center gap-2">
                      <FileText className="w-4 h-4" />
                      Manage vendor-specific CSV templates for scheduling
                    </p>
                  </div>
                </div>
                
                <button 
                  onClick={() => setShowUploadModal(true)}
                  className="group relative px-6 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white shadow-lg shadow-indigo-500/25 hover:shadow-indigo-500/40 transition-all duration-300 flex items-center gap-3"
                >
                  <Upload className="w-5 h-5 group-hover:animate-bounce" />
                  <div className="text-left">
                    <p className="text-sm font-semibold">Upload New Template</p>
                    <p className="text-xs text-indigo-200">Add CSV template</p>
                  </div>
                </button>
              </div>
            </div>
          </div>

          {/* Info Banner */}
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-indigo-900/30 to-purple-900/30 border border-indigo-700/50 p-5">
            <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-indigo-500/10 to-transparent rounded-full blur-2xl" />
            
            <div className="relative flex items-start gap-4">
              <div className="p-3 rounded-xl bg-indigo-500/10">
                <AlertCircle className="w-6 h-6 text-indigo-400 flex-shrink-0" />
              </div>
              <div>
                <p className="text-base font-semibold text-white mb-1">Template Version Management</p>
                <p className="text-sm text-slate-400">Each plant vendor requires a specific CSV format. Templates are versioned and automatically extracted based on the plant being scheduled.</p>
              </div>
            </div>
          </div>

          {/* Plant Selection */}
          <div className={`rounded-2xl backdrop-blur-sm p-6 ${isDarkMode ? 'bg-slate-900/50 border border-slate-700/50' : 'bg-card border border-border'}`}>
            <div className="flex items-center gap-3 mb-6">
              <div className="p-2 rounded-xl bg-indigo-500/10">
                <Wind className="w-5 h-5 text-indigo-400" />
              </div>
              <h3 className="text-lg font-semibold text-foreground">Select Plant</h3>
            </div>
            <div className="grid grid-cols-1 gap-4">
              <div>
                <label className="text-sm font-semibold text-foreground mb-2.5 block">Plant</label>
                <select 
                  value={selectedPlant}
                  onChange={(e) => setSelectedPlant(e.target.value)}
                  className={`w-full px-4 py-3 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all ${isDarkMode ? 'bg-slate-800/50 border border-slate-700/50 text-white' : 'bg-background border border-border text-foreground'}`}
                >
                  <option value="">Select Plant</option>
                  {allTemplates.map(plant => (
                    <option key={plant.id} value={plant.id}>{plant.name}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Current Template Details */}
          {selectedPlantData && (
            <div className="relative overflow-hidden rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm p-6">
              <div className="absolute inset-0 bg-gradient-to-r from-indigo-500/5 via-transparent to-purple-500/5" />
              <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-indigo-500/10 to-transparent rounded-full blur-2xl" />

              <div className="relative">
                <div className="flex items-start justify-between mb-6">
                  <div>
                    <h3 className="text-lg font-bold text-white">Current Template</h3>
                    <p className="text-sm text-slate-400 mt-1">{selectedPlantData.name}</p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setShowCSVViewModal(true)}
                      className="px-4 py-2 rounded-lg border border-slate-700/50 hover:bg-slate-800/50 transition-all duration-300 flex items-center gap-2 text-slate-300 hover:text-white"
                    >
                      <Eye className="w-4 h-4" />
                      View Template
                    </button>
                    <button
                      onClick={() => handleDownloadTemplate(selectedPlantData)}
                      className="px-4 py-2 rounded-lg bg-gradient-to-r from-indigo-600 to-purple-600 text-white hover:from-indigo-500 hover:to-purple-500 transition-all duration-300 flex items-center gap-2 shadow-lg shadow-indigo-500/25"
                    >
                      <Download className="w-4 h-4" />
                      Download
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-4 gap-6">
                  <div className="p-5 bg-slate-800/50 rounded-xl border border-slate-700/50 hover:border-slate-600 transition-all duration-300">
                    <div className="flex items-center gap-3 mb-3">
                      {selectedPlantData.category === 'Wind' ? (
                        <div className="p-2 bg-indigo-500/10 rounded-lg">
                          <Wind className="w-5 h-5 text-indigo-400" />
                        </div>
                      ) : (
                        <div className="p-2 bg-amber-500/10 rounded-lg">
                          <Sun className="w-5 h-5 text-amber-400" />
                        </div>
                      )}
                      <div>
                        <p className="text-xs text-slate-500 uppercase tracking-wider">Category</p>
                        <p className="text-sm font-semibold text-white">{selectedPlantData.category}</p>
                      </div>
                    </div>
                  </div>

                  <div className="p-5 bg-slate-800/50 rounded-xl border border-slate-700/50 hover:border-slate-600 transition-all duration-300">
                    <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Vendor</p>
                    <p className="text-lg font-bold text-white">{selectedPlantData.vendor}</p>
                  </div>

                  <div className="p-5 bg-slate-800/50 rounded-xl border border-slate-700/50 hover:border-slate-600 transition-all duration-300">
                    <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Template Version</p>
                    <p className="text-lg font-bold text-white">{selectedPlantData.template}</p>
                  </div>

                  <div className="p-5 bg-slate-800/50 rounded-xl border border-slate-700/50 hover:border-slate-600 transition-all duration-300">
                    <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Last Updated</p>
                    <p className="text-sm font-semibold text-white">{selectedPlantData.updated}</p>
                  </div>
                </div>

                <div className="mt-6 p-5 bg-slate-800/30 rounded-xl border border-slate-700/50">
                  <h4 className="text-sm font-semibold text-white mb-3">Template Structure</h4>
                  <div className="space-y-2 text-sm">
                    <div className="flex items-center gap-2">
                      <CheckCircle className="w-4 h-4 text-emerald-400" />
                      <span className="text-slate-400">96 time blocks (15-minute intervals)</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <CheckCircle className="w-4 h-4 text-emerald-400" />
                      <span className="text-slate-400">Columns: Time, Forecast, Scheduled, Remarks</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <CheckCircle className="w-4 h-4 text-emerald-400" />
                      <span className="text-slate-400">Format: CSV (UTF-8)</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Workflow Steps */}
          <div className="relative overflow-hidden rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm p-6">
            <div className="absolute inset-0 bg-gradient-to-r from-indigo-500/5 via-transparent to-purple-500/5" />
            <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-indigo-500/10 to-transparent rounded-full blur-2xl" />

            <div className="relative">
              <h3 className="text-lg font-bold text-foreground mb-6">Template Update Workflow</h3>
              <div className="flex items-center justify-between">
                {[
                  { step: 1, label: 'Upload CSV', icon: Upload },
                  { step: 2, label: 'System Validation', icon: CheckCircle },
                  { step: 3, label: 'User Review', icon: Eye },
                  { step: 4, label: 'Activation', icon: RefreshCw }
                ].map((item, idx) => {
                  const Icon = item.icon;
                  const isActive = currentStep >= item.step;
                  const isCurrent = currentStep === item.step;

                  return (
                    <div key={item.step} className="flex items-center flex-1">
                      <div className="flex flex-col items-center flex-1">
                        <div className={`w-12 h-12 rounded-full flex items-center justify-center transition-all duration-300 ${
                          isActive
                            ? 'bg-gradient-to-r from-indigo-600 to-purple-600 shadow-lg shadow-indigo-500/25'
                            : 'bg-slate-800/50'
                        } ${isCurrent ? 'scale-110' : ''}`}>
                          <Icon className={`w-6 h-6 ${isActive ? 'text-white' : 'text-slate-400'}`} />
                        </div>
                        <p className={`text-sm mt-2 font-medium ${isActive ? 'text-white' : 'text-slate-400'}`}>
                          Step {item.step}
                        </p>
                        <p className="text-xs text-slate-500">
                          {item.label}
                        </p>
                      </div>
                      {idx < 3 && (
                        <div className="flex-1 h-1 mx-4 relative">
                          <div className="absolute inset-0 bg-slate-700 rounded"></div>
                          <div
                            className={`absolute inset-0 rounded transition-all duration-500 ${
                              currentStep > item.step ? 'bg-gradient-to-r from-indigo-600 to-purple-600' : 'w-0'
                            }`}
                          ></div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* All Templates Table */}
          <div className="relative overflow-hidden rounded-2xl bg-slate-900/50 border border-slate-700/50 backdrop-blur-sm overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-r from-indigo-500/5 via-transparent to-purple-500/5" />
            <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-indigo-500/10 to-transparent rounded-full blur-2xl" />

            <div className="relative">
              <div className="p-6 border-b border-slate-700/50 bg-slate-800/30">
                <h3 className="text-lg font-bold text-foreground">All Template Versions</h3>
                <p className="text-sm text-slate-400 mt-1">Manage templates for all plants</p>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-slate-800/50">
                    <tr>
                      {['Plant', 'Category', 'Vendor', 'Template Version', 'Last Updated', 'Actions'].map(header => (
                        <th key={header} className="px-6 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700">
                    {allTemplates.map((plant) => {
                      const Icon = plant.category === 'Wind' ? Wind : Sun;
                      return (
                        <tr key={plant.id} className="hover:bg-slate-800/30 transition-all duration-300 group">
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-3">
                              <div className={`p-1.5 rounded-lg ${plant.category === 'Wind' ? 'bg-indigo-500/10' : 'bg-amber-500/10'}`}>
                                <Icon className={`w-4 h-4 ${plant.category === 'Wind' ? 'text-indigo-400' : 'text-amber-400'}`} />
                              </div>
                              <span className="text-sm font-medium text-white">{plant.name}</span>
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <span className={`inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-medium ${
                              plant.category === 'Wind' ? 'bg-indigo-500/10 text-indigo-400' : 'bg-amber-500/10 text-amber-400'
                            }`}>
                              {plant.category}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-sm text-slate-400">{plant.vendor}</td>
                          <td className="px-6 py-4">
                            <span className="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-semibold bg-emerald-500/10 text-emerald-400">
                              {plant.template}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-sm text-slate-400">{plant.updated}</td>
                          <td className="px-6 py-4">
                            <div className="flex gap-2">
                              <button
                                onClick={() => {
                                  setSelectedPlant(plant.id);
                                  setShowCSVViewModal(true);
                                }}
                                className="p-1.5 rounded-lg border border-slate-700/50 hover:bg-slate-800/50 transition-all duration-300 text-slate-400 hover:text-white"
                                title="View template"
                              >
                                <Eye className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => handleDownloadTemplate(plant)}
                                className="p-1.5 rounded-lg border border-slate-700/50 hover:bg-slate-800/50 transition-all duration-300 text-slate-400 hover:text-white"
                                title="Download template"
                              >
                                <Download className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => handleUpdateTemplate(plant)}
                                className="p-1.5 rounded-lg border border-slate-700/50 hover:bg-slate-800/50 transition-all duration-300 text-slate-400 hover:text-white"
                                title="Update template"
                              >
                                <Edit3 className="w-4 h-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Upload Modal */}
      {showUploadModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 rounded-2xl shadow-2xl w-full max-w-lg border border-slate-700">
            <div className="px-6 py-4 border-b border-slate-700 bg-slate-800/30">
              <h2 className="text-lg font-semibold text-white">
                {updatePlant ? `Update Template - ${updatePlant.name}` : 'Upload New Template'}
              </h2>
              <p className="text-sm text-slate-400 mt-1">Upload CSV template</p>
            </div>

            <div className="p-6 space-y-4">
              {updatePlant && (
                <div className="p-3 bg-slate-800/50 border border-slate-700/50 rounded-xl">
                  <p className="text-sm text-white">
                    <strong>Plant:</strong> {updatePlant.name}<br />
                    <strong>Current Version:</strong> {updatePlant.template}<br />
                    <strong>Vendor:</strong> {updatePlant.vendor}
                  </p>
                </div>
              )}
              <div>
                <label className="text-sm font-medium text-white mb-2 block">Upload CSV File</label>
                <div className="border-2 border-dashed border-slate-700/50 rounded-xl p-8 text-center hover:border-indigo-500 transition-all duration-300 cursor-pointer group">
                  <input
                    type="file"
                    accept=".csv"
                    onChange={handleFileUpload}
                    className="hidden"
                    id="file-upload"
                  />
                  <label htmlFor="file-upload" className="cursor-pointer">
                    <FileSpreadsheet className="w-12 h-12 text-slate-400 mx-auto mb-3 group-hover:text-indigo-400 transition-colors" />
                    <p className="text-sm font-medium text-white mb-1">Drop CSV file here or click to browse</p>
                    <p className="text-xs text-slate-500">Maximum file size: 5MB</p>
                  </label>
                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-slate-700 bg-slate-800/20">
              <button
                onClick={() => {
                  setShowUploadModal(false);
                  setUpdatePlant(null);
                }}
                className="w-full px-4 py-2 rounded-lg border border-slate-700/50 hover:bg-slate-800/50 transition-all duration-300 font-medium text-slate-300 hover:text-white"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Validation Modal */}
      {showValidationModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 rounded-2xl shadow-2xl w-full max-w-lg border border-slate-700">
            <div className="px-6 py-4 border-b border-slate-700 bg-emerald-500/10">
              <h2 className="text-lg font-semibold text-white">Validation Complete</h2>
              <p className="text-sm text-slate-400 mt-1">Template validation results</p>
            </div>

            <div className="p-6 space-y-4">
              <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl flex items-start gap-3">
                <CheckCircle className="w-6 h-6 text-emerald-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold text-emerald-400">Validation Passed</p>
                  <p className="text-sm text-slate-400 mt-1">Template structure is valid and ready for activation.</p>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between p-3 bg-slate-800/50 rounded-lg">
                  <span className="text-sm text-slate-400">Total Rows</span>
                  <span className="text-sm font-semibold text-white">96</span>
                </div>
                <div className="flex items-center justify-between p-3 bg-slate-800/50 rounded-lg">
                  <span className="text-sm text-slate-400">Valid Rows</span>
                  <span className="text-sm font-semibold text-emerald-400">96</span>
                </div>
                <div className="flex items-center justify-between p-3 bg-slate-800/50 rounded-lg">
                  <span className="text-sm text-slate-400">File Size</span>
                  <span className="text-sm font-semibold text-white">12 KB</span>
                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-slate-700 bg-slate-800/20 flex gap-3">
              <button
                onClick={() => setShowValidationModal(false)}
                className="flex-1 px-4 py-2 rounded-lg border border-slate-700/50 hover:bg-slate-800/50 transition-all duration-300 font-medium text-slate-300 hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowValidationModal(false);
                  setCurrentStep(3);
                  setTimeout(() => setShowConfirmModal(true), 300);
                }}
                className="flex-1 px-4 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 transition-all duration-300 font-medium"
              >
                Proceed to Review
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Activation Modal */}
      {showConfirmModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 rounded-2xl shadow-2xl w-full max-w-lg border border-slate-700">
            <div className="px-6 py-4 border-b border-slate-700 bg-slate-800/30">
              <h2 className="text-lg font-semibold text-white">Activate Template</h2>
              <p className="text-sm text-slate-400 mt-1">Confirm template activation</p>
            </div>

            <div className="p-6 space-y-4">
              <div className="p-4 bg-slate-800/50 border border-slate-700/50 rounded-xl">
                <p className="text-sm text-white">
                  This will activate the new template and it will be used for all future schedules for this plant.
                </p>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between p-3 bg-slate-800/50 rounded-lg">
                  <span className="text-sm text-slate-400">Plant</span>
                  <span className="text-sm font-semibold text-white">{updatePlant?.name || 'New Plant'}</span>
                </div>
                <div className="flex items-center justify-between p-3 bg-slate-800/50 rounded-lg">
                  <span className="text-sm text-slate-400">Current Version</span>
                  <span className="text-sm font-semibold text-white">{updatePlant?.template || 'N/A'}</span>
                </div>
                <div className="flex items-center justify-between p-3 bg-slate-800/50 rounded-lg">
                  <span className="text-sm text-slate-400">New Version</span>
                  <span className="text-sm font-semibold text-emerald-400">{newTemplateVersion}</span>
                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-slate-700 bg-slate-800/20 flex gap-3">
              <button
                onClick={() => setShowConfirmModal(false)}
                className="flex-1 px-4 py-2 rounded-lg border border-slate-700/50 hover:bg-slate-800/50 transition-all duration-300 font-medium text-slate-300 hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={handleActivateTemplate}
                disabled={createLoading}
                className="flex-1 px-4 py-2 rounded-lg bg-gradient-to-r from-indigo-600 to-purple-600 text-white hover:from-indigo-500 hover:to-purple-500 transition-all duration-300 font-medium disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-indigo-500/25"
              >
                {createLoading ? (
                  <>
                    <LoadingSpinner size="sm" />
                    Activating...
                  </>
                ) : (
                  'Activate Template'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CSV View Modal */}
      {showCSVViewModal && selectedPlantData && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 rounded-2xl shadow-2xl w-full max-w-6xl max-h-[90vh] overflow-hidden flex flex-col border border-slate-700">
            <div className="px-6 py-4 border-b border-slate-700 bg-slate-800/30 flex-shrink-0">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-white">Template CSV Preview</h2>
                  <p className="text-sm text-slate-400 mt-1">{selectedPlantData.name} - {selectedPlantData.template}</p>
                </div>
                <button
                  onClick={() => setShowCSVViewModal(false)}
                  className="p-2 hover:bg-slate-800/50 rounded-lg transition-all duration-300 text-slate-400 hover:text-white"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-auto p-6">
              <div className="bg-slate-800/30 rounded-xl border border-slate-700/50 overflow-hidden">
                {getTemplateUrl(selectedPlantData) ? (
                  <iframe
                    src={getTemplateUrl(selectedPlantData)}
                    className="w-full h-[60vh] border-0"
                    title="Template CSV Preview"
                  />
                ) : (
                  <div className="p-10 text-center text-sm text-slate-400">
                    No template file available for preview.
                  </div>
                )}
              </div>
            </div>

            <div className="px-6 py-4 border-t border-slate-700 bg-slate-800/20 flex gap-3 flex-shrink-0">
              <button
                onClick={() => setShowCSVViewModal(false)}
                className="flex-1 px-4 py-2 rounded-lg border border-slate-700/50 hover:bg-slate-800/50 transition-all duration-300 font-medium text-slate-300 hover:text-white"
              >
                Close
              </button>
              <button
                onClick={() => handleDownloadTemplate(selectedPlantData)}
                className="flex-1 px-4 py-2 rounded-lg bg-gradient-to-r from-indigo-600 to-purple-600 text-white hover:from-indigo-500 hover:to-purple-500 transition-all duration-300 font-medium flex items-center justify-center gap-2 shadow-lg shadow-indigo-500/25"
              >
                <Download className="w-4 h-4" />
                Download Template
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}



