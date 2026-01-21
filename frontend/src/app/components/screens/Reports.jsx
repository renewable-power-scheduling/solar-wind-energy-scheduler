
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  FileText,
  Download,
  Calendar,
  Filter,
  BarChart3,
  TrendingUp,
  Wind,
  FileSpreadsheet,
  Eye,
  X,
  Trash2,
  RefreshCw,
  Bell,
  CheckCircle,
  Clock,
  TrendingUp as TrendingUpIcon
} from 'lucide-react';
import { api } from '@/services/api';
import { jsPDF } from 'jspdf';
import { generateReportData } from '@/services/mockDataService';
import { toast } from 'sonner';

// Helper function to generate actual PDF report using data from API
const generatePDFReport = async (reportType, dateFrom, dateTo, filters = {}) => {
  const doc = new jsPDF();
  
  // Fetch real data from API
  let reportData = {
    summary: {
      totalPlants: 0,
      totalCapacity: 0,
      avgEfficiency: 0
    },
    plants: [],
    schedules: [],
    deviations: []
  };
  
  try {
    const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api';
    
    // Fetch plants data
    const plantsResponse = await fetch(`${API_BASE_URL}/plants`);
    if (plantsResponse.ok) {
      const plants = await plantsResponse.json();
      const plantsList = Array.isArray(plants) ? plants : [];
      reportData.plants = plantsList.map(p => ({
        name: p.name,
        type: p.type,
        capacity: p.capacity,
        state: p.state,
        status: p.status
      }));
      reportData.summary.totalPlants = plantsList.length;
      reportData.summary.totalCapacity = plantsList.reduce((sum, p) => sum + (p.capacity || 0), 0);
      reportData.summary.avgEfficiency = plantsList.length > 0 
        ? plantsList.reduce((sum, p) => sum + (p.efficiency || 0), 0) / plantsList.length 
        : 0;
    }
    
    // Fetch schedules data
    const schedulesResponse = await fetch(`${API_BASE_URL}/schedules?limit=100`);
    if (schedulesResponse.ok) {
      const schedules = await schedulesResponse.json();
      const schedulesList = Array.isArray(schedules) ? schedules : [];
      reportData.schedules = schedulesList;
    }
    
    // Fetch deviations data
    const deviationsResponse = await fetch(`${API_BASE_URL}/deviations?limit=100`);
    if (deviationsResponse.ok) {
      const deviations = await deviationsResponse.json();
      reportData.deviations = Array.isArray(deviations) ? deviations : [];
    }
  } catch (error) {
    console.warn('Could not fetch real data for report, using fallback:', error);
    // Fallback to mock data if API fails
    reportData = generateReportData(reportType, dateFrom, dateTo);
  }
  
  // Title
  doc.setFontSize(20);
  doc.setTextColor(30, 64, 175);
  doc.text(reportType, 14, 22);
  
  // Report info
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Period: ${dateFrom} to ${dateTo}`, 14, 32);
  doc.text(`Generated: ${new Date().toLocaleDateString()}`, 14, 38);
  doc.text(`Format: PDF`, 14, 44);
  
  // Summary
  doc.setFontSize(14);
  doc.setTextColor(30);
  doc.text('Summary', 14, 56);
  
  doc.setFontSize(10);
  doc.text(`Total Plants: ${reportData.summary.totalPlants}`, 14, 64);
  doc.text(`Total Capacity: ${reportData.summary.totalCapacity.toFixed(1)} MW`, 14, 70);
  doc.text(`Avg Efficiency: ${reportData.summary.avgEfficiency.toFixed(1)}%`, 14, 76);
  
  // Add deviation summary if available
  if (reportData.deviations && reportData.deviations.length > 0) {
    const totalDeviation = reportData.deviations.reduce((sum, d) => sum + Math.abs(parseFloat(d.deviation) || 0), 0);
    const avgPercentage = reportData.deviations.reduce((sum, d) => sum + Math.abs(parseFloat(d.percentage) || 0), 0) / reportData.deviations.length;
    doc.text(`Total Deviation: ${totalDeviation.toFixed(2)} MW`, 14, 82);
    doc.text(`Avg Deviation: ${avgPercentage.toFixed(2)}%`, 14, 88);
  }
  
  // Plant data section
  doc.setFontSize(14);
  doc.setTextColor(30);
  doc.text('Plant Data', 14, 100);
  
  const tableData = reportData.plants.slice(0, 15).map(row => [
    row.name,
    row.type || 'N/A',
    `${row.capacity || 0} MW`,
    row.state || 'N/A',
    row.status || 'N/A'
  ]);
  
  if (tableData.length > 0) {
    let yPos = 106;
    
    // Draw table header
    doc.setFillColor(30, 64, 175);
    doc.rect(14, yPos, 182, 10, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(10);
    doc.text('Plant', 16, yPos + 7);
    doc.text('Type', 65, yPos + 7);
    doc.text('Capacity', 110, yPos + 7);
    doc.text('State', 145, yPos + 7);
    doc.text('Status', 175, yPos + 7);
    
    yPos += 10;
    
    // Draw table rows
    doc.setTextColor(0, 0, 0);
    tableData.forEach((row, index) => {
      if (index % 2 === 0) {
        doc.setFillColor(248, 250, 252);
        doc.rect(14, yPos, 182, 8, 'F');
      }
      doc.text(row[0], 16, yPos + 6);
      doc.text(row[1], 65, yPos + 6);
      doc.text(row[2], 110, yPos + 6);
      doc.text(row[3], 145, yPos + 6);
      doc.text(row[4], 175, yPos + 6);
      yPos += 8;
    });
  }
  
  // Add schedule data section if available
  if (reportData.schedules && reportData.schedules.length > 0) {
    doc.setFontSize(14);
    doc.setTextColor(30);
    const scheduleYPos = tableData.length > 0 ? Math.min(190, 106 + (reportData.plants.length + 1) * 8 + 20) : 100;
    doc.text('Schedule Data', 14, scheduleYPos);
    
    const scheduleTableData = reportData.schedules.slice(0, 10).map(s => [
      s.plantName || 'N/A',
      s.type || 'N/A',
      s.scheduleDate ? new Date(s.scheduleDate).toLocaleDateString() : 'N/A',
      `${s.forecasted || 0} MW`,
      `${s.actual || 0} MW`,
      `${s.deviation || 0}%`
    ]);
    
    if (scheduleTableData.length > 0) {
      let yPos = scheduleYPos + 6;
      
      // Draw schedule table header
      doc.setFillColor(30, 64, 175);
      doc.rect(14, yPos, 182, 10, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(9);
      doc.text('Plant', 16, yPos + 7);
      doc.text('Type', 55, yPos + 7);
      doc.text('Date', 85, yPos + 7);
      doc.text('Forecast', 115, yPos + 7);
      doc.text('Actual', 145, yPos + 7);
      doc.text('Dev %', 170, yPos + 7);
      
      yPos += 10;
      
      // Draw schedule table rows
      doc.setTextColor(0, 0, 0);
      scheduleTableData.forEach((row, index) => {
        if (index % 2 === 0) {
          doc.setFillColor(248, 250, 252);
          doc.rect(14, yPos, 182, 8, 'F');
        }
        doc.text(row[0], 16, yPos + 6);
        doc.text(row[1], 55, yPos + 6);
        doc.text(row[2], 85, yPos + 6);
        doc.text(row[3], 115, yPos + 6);
        doc.text(row[4], 145, yPos + 6);
        doc.text(row[5], 170, yPos + 6);
        yPos += 8;
      });
    }
  }
  
  // Footer
  const pageHeight = doc.internal.pageSize.height;
  doc.setFontSize(8);
  doc.setTextColor(150);
  doc.text('QCA Dashboard - Renewable Energy Management', 14, pageHeight - 10);
  doc.text(`Generated on ${new Date().toLocaleString()}`, 14, pageHeight - 5);
  
  // Save the PDF
  doc.save(`${reportType.replace(/\s+/g, '-')}-report-${dateFrom}-to-${dateTo}.pdf`);
};

export function Reports() {
  const [selectedReport, setSelectedReport] = useState('');
  const [dateFrom, setDateFrom] = useState('2026-01-01');
  const [dateTo, setDateTo] = useState('2026-01-14');
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [selectedReportData, setSelectedReportData] = useState(null);
  const [viewedReport, setViewedReport] = useState(null);
  
  // Reports state
  const [reports, setReports] = useState([]);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);

  // Real-time update state
  const [pendingReports, setPendingReports] = useState([]);
  const [showNewReportNotification, setShowNewReportNotification] = useState(false);
  const [pollingInterval, setPollingInterval] = useState(null);
  const pollingCountRef = useRef(0);
  const MAX_POLLING_ATTEMPTS = 10; // Poll for up to 30 seconds (3s * 10)

  // Filter state
  const [filters, setFilters] = useState({
    plantCategory: '',
    state: ''
  });

  const reportTypes = [
    { id: 'schedule', name: 'Schedule Summary', icon: FileText, color: 'primary' },
    { id: 'deviation', name: 'Deviation Analysis', icon: TrendingUp, color: 'destructive' },
    { id: 'capacity', name: 'Capacity Utilization', icon: BarChart3, color: 'success' },
    { id: 'plant', name: 'Plant Performance', icon: Wind, color: 'secondary' },
  ];

  // Fetch reports from API with filters
  const fetchReports = useCallback(async (options = {}) => {
    try {
      const { showLoading = true } = options;
      
      if (showLoading) {
        setReportsLoading(true);
      }
      setErrorMessage(null);
      
      const result = await api.reports.getAll({});
      
      // If no reports from backend, show empty state (no fake reports)
      if (!result || !result.reports || result.reports.length === 0) {
        setReports([]);
        setReportsLoading(false);
        return;
      }
      
      if (result && result.reports) {
        // Transform reports from database
        const transformedReports = result.reports.map((r) => ({
          id: r.id,
          name: r.name || 'Unknown Report',
          date: r.date || new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
          type: r.type || 'General',
          size: r.size || 'N/A',
          status: r.status || 'Ready',
          filePath: r.filePath || null,
          source: 'database',
          sortDate: r.createdAt || r.generatedDate || new Date().toISOString()
        }));
        
        // Sort by date (newest first)
        const sortedReports = transformedReports.sort((a, b) => {
          const dateA = new Date(a.sortDate);
          const dateB = new Date(b.sortDate);
          return dateB - dateA;
        });
        
        setReports(sortedReports);
      }
    } catch (error) {
      console.error('Error fetching reports:', error);
      setReports([]);
      setErrorMessage(`Failed to load reports: ${error.message || 'Unknown error'}`);
    } finally {
      setReportsLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  // Fetch reports when filters change
  useEffect(() => {
    // Small delay to avoid too many API calls while typing
    const timer = setTimeout(() => {
      fetchReports();
    }, 300);
    
    return () => clearTimeout(timer);
  }, [filters, fetchReports]);

const handleGenerateReport = async () => {
    // Clear previous error
    setErrorMessage(null);
    
    // If no report type selected but we have a viewed report, use its type
    let reportId = selectedReport;
    if (!reportId && viewedReport && viewedReport.type) {
      const reportType = reportTypes.find(rt => rt.name === viewedReport.type);
      if (reportType) {
        reportId = reportType.id;
        setSelectedReport(reportId);
      }
    }
    
    if (!reportId) {
      setErrorMessage('Please select a report type');
      return;
    }

    setIsGenerating(true);

    try {
      // Use reportId which was determined earlier (may be from viewedReport)
      const reportTypeName = reportTypes.find(r => r.id === reportId)?.name || viewedReport?.type || reportId;
      const reportName = `${reportTypeName} - ${dateFrom} to ${dateTo}`;
      const reportSize = '2.4 MB';
      const currentDate = new Date();
      
      // OPTIMISTIC UPDATE: Add new report immediately to the table with "Generating" status
      const tempReportId = `pending-${Date.now()}`;
      const optimisticReport = {
        id: tempReportId,
        name: reportName,
        type: reportTypeName,
        date: currentDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
        size: reportSize,
        status: 'Generating',
        filePath: null,
        source: 'pending',
        sortDate: currentDate.toISOString()
      };
      
      // Add to reports list immediately (at the top since it's the newest)
      setReports(prev => [optimisticReport, ...prev]);
      setPendingReports(prev => [optimisticReport, ...prev]);
      
      // Show notification
      setShowNewReportNotification(true);
      setTimeout(() => {
        setShowNewReportNotification(false);
      }, 5000);

      // Generate PDF first (client-side with real data)
      await generatePDFReport(reportTypeName, dateFrom, dateTo, filters);
      
      // Save to backend
      const reportConfig = {
        name: reportName,
        type: reportTypeName,
        format: 'PDF',
        generatedDate: new Date().toISOString().split('T')[0],
        status: 'Ready',
        size: reportSize
      };
      
      const result = await api.reports.generate(reportConfig);
      
      if (result && result.reportId) {
        // Success - update the optimistic report with real data
        const newReportId = typeof result.reportId === 'number' ? result.reportId : result.reportId.id || Date.now();
        
        setReports(prev => prev.map(r => 
          r.id === tempReportId 
            ? { 
                ...r, 
                id: newReportId, 
                status: 'Ready',
                filePath: result.downloadUrl || null,
                source: 'backend'
              }
            : r
        ));
        
        // Also update pendingReports
        setPendingReports(prev => prev.map(r => 
          r.id === tempReportId 
            ? { 
                ...r, 
                id: newReportId, 
                status: 'Ready',
                filePath: result.downloadUrl || null,
                source: 'backend'
              }
            : r
        ));
        
        // Start polling to ensure the report appears in the list from backend
        startPollingForNewReport(tempReportId, newReportId);
        
        // Clear any error
        setErrorMessage(null);
      } else {
        // Report generated but failed to save - keep optimistic report but show warning
        setErrorMessage('Report generated but save verification pending. Refresh to see in list.');
      }
    } catch (error) {
      console.error('Report generation error:', error);
      setErrorMessage(`Error generating report: ${error.message || 'Unknown error'}`);
      
      // Remove the optimistic report on error
      setReports(prev => prev.filter(r => r.source !== 'pending' || r.status !== 'Generating'));
      setPendingReports(prev => prev.filter(r => r.source !== 'pending' || r.status !== 'Generating'));
    } finally {
      setIsGenerating(false);
    }
  };

  // Start polling to check for new reports after generation
  const startPollingForNewReport = useCallback((tempId, realId) => {
    pollingCountRef.current = 0;
    
    // Clear any existing interval
    if (pollingInterval) {
      clearInterval(pollingInterval);
    }
    
    // Poll every 3 seconds for up to 30 seconds
    const interval = setInterval(async () => {
      pollingCountRef.current += 1;
      
      try {
        await fetchReports({ showLoading: false, append: true });
        
        // Check if our real report is now in the list from backend
        const hasRealReport = reports.some(r => 
          (r.id === realId || r.id === tempId) && 
          r.status === 'Ready' &&
          r.source === 'backend'
        );
        
        // If we found the real report, update pending status
        if (hasRealReport) {
          setReports(prev => prev.map(r => 
            r.id === tempId ? { ...r, source: 'backend' } : r
          ));
          setPendingReports(prev => prev.filter(r => r.id !== tempId));
        }
        
        if (hasRealReport || pollingCountRef.current >= MAX_POLLING_ATTEMPTS) {
          clearInterval(interval);
          setPollingInterval(null);
        }
      } catch (error) {
        console.warn('Polling error:', error);
        if (pollingCountRef.current >= MAX_POLLING_ATTEMPTS) {
          clearInterval(interval);
          setPollingInterval(null);
        }
      }
    }, 3000);
    
    setPollingInterval(interval);
  }, [fetchReports, reports, MAX_POLLING_ATTEMPTS, pollingInterval]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollingInterval) {
        clearInterval(pollingInterval);
      }
    };
  }, [pollingInterval]);

  /**
   * Handle downloading an existing report PDF
   * Downloads the actual file from the backend using report.filePath or report.url
   * Does NOT regenerate the PDF
   */
  const handleDownloadReport = async (report) => {
    try {
      // If the report has status "Generating", show info message and don't proceed
      if (report.status === 'Generating') {
        toast.info('Report is still generating. Please wait for it to complete.');
        return;
      }

      // Get the file URL from report.filePath or report.url (single source of truth)
      const fileUrl = report.filePath || report.url;
      
      if (!fileUrl) {
        toast.error('No file available for download');
        return;
      }

      // Build the full download URL
      const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api';
      
      // Handle different URL formats
      let downloadUrl = fileUrl;
      
      // If it's a relative path, prepend the API base URL
      if (fileUrl.startsWith('/')) {
        downloadUrl = `${API_BASE_URL}${fileUrl}`;
      } else if (!fileUrl.startsWith('http')) {
        // If it's just a filename or path without protocol
        downloadUrl = `${API_BASE_URL}/reports/download/${fileUrl}`;
      }

      console.log('Downloading report from:', downloadUrl);

      // Method 1: Use window.open for direct download
      window.open(downloadUrl, '_blank');

      // Method 2: Also create an anchor tag for reliable download
      const anchor = document.createElement('a');
      anchor.href = downloadUrl;
      anchor.download = `${report.name || 'report'}.pdf`;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      
      // Try to trigger download
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);

      toast.success('Download started');
    } catch (error) {
      console.error('Download error:', error);
      toast.error(`Error downloading report: ${error.message || 'Unknown error'}`);
    }
  };

  // Get current date inputs for fallback
  const dateFromInput = dateFrom;
  const dateToInput = dateTo;


  /**
   * Handle viewing a report
   * Previews the actual PDF if filePath or url exists
   * Shows "Preview not available" if no file is present
   */
  const handleViewReport = (report) => {
    setSelectedReportData(report);
    setViewedReport(report);
    setShowPreviewModal(true);
    toast.success(`Viewing report: ${report.name}`);
    
    // Set report type from report.type field (single source of truth)
    if (report.type) {
      const reportType = reportTypes.find(rt => rt.name === report.type || rt.id === report.type.toLowerCase());
      if (reportType) {
        setSelectedReport(reportType.id);
      } else {
        // If type doesn't match known types, still set it
        setSelectedReport(report.type);
      }
    }
    
    // Use report.date directly (single source of truth)
    // The date field is already in the correct format from the API transformation
    // No need to extract from name
  };

  /**
   * Normalize report ID to consistent format
   * Handles string IDs (like 'pending-123456789'), numeric IDs, and object IDs
   */
  const normalizeReportId = (id) => {
    if (id === null || id === undefined) return null;
    
    // If it's a number, return as-is for backend
    if (typeof id === 'number') return id;
    
    // If it's a string, return as-is
    if (typeof id === 'string') return id;
    
    // If it's an object (like MongoDB _id), convert to string
    return String(id);
  };

  /**
   * Handle deleting a report from database
   * - Optimistically removes from UI
   * - Calls backend delete API for database reports
   */
  const handleDeleteReport = async (report) => {
    // Normalize the report ID
    const reportId = normalizeReportId(report.id);
    
    if (!reportId) {
      toast.error('Invalid report ID');
      return;
    }
    
    // Show confirmation dialog
    if (!window.confirm(`Are you sure you want to delete "${report.name}"?`)) {
      return;
    }

    // Reports from database have numeric IDs and source === 'database'
    const isDatabaseReport = report.source === 'database' && typeof report.id === 'number';
    const isPendingReport = reportId.startsWith('pending-');
    
    // Store current reports state for potential restore on error
    const currentReports = [...reports];
    
    try {
      setDeletingId(reportId);
      
      // OPTIMISTIC UPDATE: Remove from UI immediately
      setReports(prev => prev.filter(r => normalizeReportId(r.id) !== reportId));
      
      // Also remove from pendingReports if present
      setPendingReports(prev => prev.filter(r => normalizeReportId(r.id) !== reportId));
      
      // Show success message immediately (optimistic UI)
      toast.success(`Report "${report.name}" deleted successfully`);
      
      // Only call backend delete for actual database reports
      if (isDatabaseReport) {
        // Clean numeric ID for API call
        const cleanNumericId = parseInt(reportId, 10);
        if (!isNaN(cleanNumericId)) {
          await api.reports.delete(cleanNumericId);
          console.log('Database report deleted successfully:', cleanNumericId);
        }
      } else if (isPendingReport) {
        console.log('Pending report removed from UI only (not yet in backend):', reportId);
      }
      
    } catch (error) {
      console.error('Delete error:', error);
      
      // Handle API errors gracefully
      if (error.message?.includes('Failed to fetch') || error.status === 0 || error.name === 'ApiError') {
        // Backend not available - keep the optimistic deletion
        console.log('Backend unavailable, report removed from UI only');
        toast.success(`Report deleted (backend unavailable)`);
      } else {
        // Restore reports on other errors
        setReports(currentReports);
        toast.error(`Failed to delete report: ${error.message || 'Unknown error'}`);
      }
    } finally {
      setDeletingId(null);
    }
  };

  const handlePreviewReport = () => {
    if (!selectedReport) {
      setErrorMessage('Please select a report type');
      return;
    }
    setSelectedReportData(null);
    setShowPreviewModal(true);
  };

  // Live clock state
  const [currentTime, setCurrentTime] = useState(new Date());

  // Update time every second for live clock
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="flex-1 overflow-auto bg-slate-950 min-h-0">
      {/* Animated background elements */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />
      </div>

      <div className="p-8 space-y-8 max-w-[1600px] mx-auto relative z-10">
        {/* Premium Header */}
        <div className="relative overflow-hidden rounded-2xl bg-linear-to-br from-slate-900 via-slate-800 to-slate-900 border border-slate-700/50 shadow-2xl">
          <div className="absolute inset-0 bg-linear-to-r from-indigo-500/5 via-transparent to-purple-500/5" />
          <div className="absolute top-0 right-0 w-64 h-64 bg-linear-to-bl from-indigo-500/10 to-transparent rounded-full blur-2xl" />
          
          <div className="relative p-8">
            <div className="flex items-start gap-5">
              <div className="relative">
                <div className="w-14 h-14 rounded-xl bg-linear-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/25">
                  <FileText className="w-7 h-7 text-white" />
                </div>
                <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-emerald-500 rounded-full border-2 border-slate-900 animate-ping" />
              </div>
              <div>
                <h1 className="text-3xl font-bold text-white mb-2 tracking-tight">
                  Reports & Analytics
                  <span className="text-transparent bg-clip-text bg-linear-to-r from-indigo-400 to-purple-400"> Dashboard</span>
                </h1>
                <div className="flex items-center gap-4 text-slate-400">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
                    <span className="text-sm font-medium">Live Monitoring</span>
                  </div>
                  <span className="text-slate-600">•</span>
                  <span className="text-sm font-mono">{currentTime.toLocaleTimeString()}</span>
                  <span className="text-slate-600">•</span>
                  <span className="text-sm">{currentTime.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Report Type Selection */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {reportTypes.map(report => {
            const Icon = report.icon;
            const isSelected = selectedReport === report.id;

            const colorMap = {
              primary: { glow: 'bg-indigo-500/20', text: 'text-indigo-400' },
              destructive: { glow: 'bg-red-500/20', text: 'text-red-400' },
              success: { glow: 'bg-emerald-500/20', text: 'text-emerald-400' },
              secondary: { glow: 'bg-slate-500/20', text: 'text-slate-400' }
            };
            const colors = colorMap[report.color] || colorMap.secondary;

            return (
              <div
                key={report.id}
                onClick={() => setSelectedReport(report.id)}
                className={`group relative overflow-hidden rounded-2xl bg-linear-to-br from-slate-900 to-slate-800 border transition-all duration-500 cursor-pointer hover:-translate-y-1 hover:shadow-2xl ${
                  isSelected 
                    ? `border-${report.color === 'primary' ? 'indigo' : report.color === 'destructive' ? 'red' : report.color === 'success' ? 'emerald' : 'slate'}-500/50 shadow-lg shadow-${report.color === 'primary' ? 'indigo' : report.color === 'destructive' ? 'red' : report.color === 'success' ? 'emerald' : 'slate'}-500/20` 
                    : 'border-slate-700/50 hover:border-slate-600'
                }`}
              >
                <div className={`absolute inset-0 bg-linear-to-r ${colors.glow} opacity-0 group-hover:opacity-100 transition-opacity duration-500`} />
                <div className={`absolute top-0 right-0 w-32 h-32 bg-linear-to-bl ${colors.glow} rounded-full blur-3xl opacity-50 group-hover:opacity-75 transition-opacity duration-500`} />
                
                <div className="relative p-6">
                  <div className={`relative w-fit mb-4 p-3 rounded-xl bg-linear-to-br ${colors.glow} group-hover:scale-110 transition-transform duration-300`}>
                    <Icon className={`w-6 h-6 ${colors.text}`} />
                  </div>
                  <h3 className={`text-base font-semibold text-white mb-2 group-hover:text-${report.color === 'primary' ? 'indigo' : report.color === 'destructive' ? 'red' : report.color === 'success' ? 'emerald' : 'slate'}-400 transition-colors`}>{report.name}</h3>
                  <p className="text-xs text-slate-400 group-hover:text-slate-300 transition-colors">Click to select</p>
                </div>
                
                {isSelected && (
                  <div className="absolute inset-0 border-2 border-indigo-500/50 rounded-2xl pointer-events-none">
                    <div className="absolute top-2 right-2 w-2 h-2 bg-indigo-500 rounded-full animate-pulse" />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Report Configuration */}
        <div className="relative overflow-hidden rounded-2xl bg-linear-to-br from-slate-900 via-slate-800 to-slate-900 border border-slate-700/50 shadow-2xl">
          <div className="absolute inset-0 bg-linear-to-r from-indigo-500/5 via-transparent to-purple-500/5" />
          <div className="absolute top-0 left-0 w-64 h-64 bg-linear-to-br from-indigo-500/5 to-transparent rounded-full blur-2xl" />
          
          <div className="relative p-8">
            <div className="flex items-center gap-4 mb-6">
              <div className="p-3 rounded-xl bg-indigo-500/10">
                <BarChart3 className="w-6 h-6 text-indigo-400" />
              </div>
              <div>
                <h3 className="text-xl font-bold text-white">Report Configuration</h3>
                <p className="text-sm text-slate-400">Configure your report parameters</p>
              </div>
            </div>
            
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              <div className="space-y-5">
                <div>
                  <label className="text-sm font-medium text-slate-300 mb-2.5 block">Report Type</label>
                  <select 
                    value={selectedReport}
                    onChange={(e) => setSelectedReport(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700/50 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                  >
                    <option value="">Select Report Type</option>
                    {reportTypes.map(type => (
                      <option key={type.id} value={type.id}>{type.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-sm font-medium text-slate-300 mb-2.5 block">Plant Category</label>
                  <select 
                    value={filters.plantCategory}
                    onChange={(e) => setFilters(prev => ({ ...prev, plantCategory: e.target.value }))}
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700/50 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                  >
                    <option value="">All Categories</option>
                    <option value="Wind">Wind Plants</option>
                    <option value="Solar">Solar Plants</option>
                  </select>
                </div>

                <div>
                  <label className="text-sm font-medium text-slate-300 mb-2.5 block">State</label>
                  <select 
                    value={filters.state}
                    onChange={(e) => setFilters(prev => ({ ...prev, state: e.target.value }))}
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700/50 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                  >
                    <option value="">All States</option>
                    <option value="Maharashtra">Maharashtra</option>
                    <option value="Gujarat">Gujarat</option>
                    <option value="Rajasthan">Rajasthan</option>
                    <option value="Tamil Nadu">Tamil Nadu</option>
                  </select>
                </div>
              </div>

              <div className="space-y-5">
                <div>
                  <label className="text-sm font-medium text-slate-300 mb-2.5 block">Date From</label>
                  <input 
                    type="date"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700/50 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all scheme-dark"
                  />
                </div>

                <div>
                  <label className="text-sm font-medium text-slate-300 mb-2.5 block">Date To</label>
                  <input 
                    type="date"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700/50 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all scheme-dark"
                  />
                </div>

                <div>
                  <label className="text-sm font-medium text-slate-300 mb-2.5 block">Export Format</label>
                  <div className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700/50 text-sm">
                    <span className="text-white font-medium">PDF Document</span>
                  </div>
                  <p className="text-xs text-slate-500 mt-2">Only PDF format is available</p>
                </div>
              </div>
            </div>

            <div className="mt-8 flex gap-4">
              <button 
                onClick={handlePreviewReport}
                className="flex-1 px-6 py-3.5 rounded-xl bg-slate-800/50 hover:bg-slate-700/50 border border-slate-700/50 hover:border-slate-600 transition-all font-semibold flex items-center justify-center gap-2 text-white"
              >
                <Eye className="w-5 h-5" />
                Preview Report
              </button>
              <button 
                onClick={handleGenerateReport}
                disabled={isGenerating}
                className={`flex-1 px-6 py-3.5 rounded-xl bg-linear-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white shadow-lg shadow-indigo-500/25 hover:shadow-indigo-500/40 transition-all font-semibold flex items-center justify-center gap-2 ${isGenerating ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {isGenerating ? (
                  <>
                    <RefreshCw className="w-5 h-5 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Download className="w-5 h-5" />
                    Generate PDF
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Error Message Display */}
        {errorMessage && (
          <div className="mt-4 p-4 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm">
            <div className="flex items-center gap-2">
              <span>{errorMessage}</span>
            </div>
            <button 
              onClick={() => setErrorMessage(null)}
              className="mt-2 text-xs underline hover:text-destructive/80"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Statistics Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[
            { label: 'Total Reports Generated', value: reports.length + 248, subtext: 'This month', icon: FileText, color: 'indigo', gradient: 'from-indigo-600 to-purple-600', glow: 'bg-indigo-500/20' },
            { label: 'Data Exported', value: '12.4 GB', subtext: 'Total size', icon: Download, color: 'emerald', gradient: 'from-emerald-600 to-teal-600', glow: 'bg-emerald-500/20' },
            { label: 'Scheduled Reports', value: '12', subtext: 'Active schedules', icon: Calendar, color: 'amber', gradient: 'from-amber-600 to-orange-600', glow: 'bg-amber-500/20' }
          ].map((stat, i) => (
            <div 
              key={i}
              className="group relative overflow-hidden rounded-2xl bg-linear-to-br from-slate-900 to-slate-800 border border-slate-700/50 hover:border-slate-600 transition-all duration-500 hover:-translate-y-1 hover:shadow-2xl cursor-pointer"
            >
              <div className={`absolute inset-0 bg-linear-to-r ${stat.glow} opacity-0 group-hover:opacity-100 transition-opacity duration-500`} />
              <div className={`absolute top-0 right-0 w-32 h-32 bg-linear-to-bl ${stat.glow} rounded-full blur-3xl opacity-50 group-hover:opacity-75 transition-opacity duration-500`} />
              
              <div className="relative p-6">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <p className="text-sm font-medium text-slate-400 uppercase tracking-wider">{stat.label}</p>
                    <div className={`text-5xl font-bold mt-2 bg-linear-to-r ${stat.gradient} bg-clip-text text-transparent`}>
                      {stat.value}
                    </div>
                  </div>
                  <div className={`p-3 rounded-xl bg-linear-to-br ${stat.glow} group-hover:scale-110 transition-transform duration-300`}>
                    <stat.icon className={`w-6 h-6 text-${stat.color}-400`} />
                  </div>
                </div>
                <div className="flex items-center gap-2 text-sm text-slate-400 group-hover:text-slate-300 transition-colors">
                  <TrendingUp className="w-4 h-4 text-indigo-400" />
                  {stat.subtext}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* New Report Notification */}
        {showNewReportNotification && (
          <div className="fixed top-4 right-4 z-50 animate-in slide-in-from-right duration-300">
            <div className="bg-success/10 border border-success/20 text-success px-4 py-3 rounded-lg shadow-lg flex items-center gap-3">
              <CheckCircle className="w-5 h-5" />
              <div>
                <p className="font-medium">Report Generated!</p>
                <p className="text-sm opacity-80">Check the Recent Reports table</p>
              </div>
              <button 
                onClick={() => setShowNewReportNotification(false)}
                className="ml-2 p-1 hover:bg-success/20 rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* Recent Reports */}
        <div className="relative overflow-hidden rounded-2xl bg-linear-to-br from-slate-900 via-slate-800 to-slate-900 border border-slate-700/50 shadow-2xl">
          <div className="absolute inset-0 bg-linear-to-r from-indigo-500/5 via-transparent to-purple-500/5" />
          
          <div className="relative p-6 border-b border-slate-700/50">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-indigo-500/10">
                  <FileSpreadsheet className="w-6 h-6 text-indigo-400" />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-white">Recent Reports</h3>
                  <p className="text-sm text-slate-400">Previously generated reports</p>
                </div>
              </div>
              <button 
                onClick={() => fetchReports({ showLoading: true })}
                className="px-4 py-2.5 rounded-xl bg-slate-800/50 hover:bg-slate-700/50 border border-slate-700/50 hover:border-slate-600 transition-all flex items-center gap-2 text-white font-medium"
                disabled={reportsLoading}
              >
                <RefreshCw className={`w-4 h-4 ${reportsLoading ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            </div>
          </div>
          
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-800/50">
                <tr>
                  {['Report Name', 'Type', 'Status', 'Generated Date', 'File Size', 'Actions'].map(header => (
                    <th key={header} className="px-6 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {reportsLoading && reports.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center">
                      <div className="flex flex-col items-center gap-3">
                        <div className="w-10 h-10 rounded-full border-2 border-slate-700 border-t-indigo-500 animate-spin" />
                        <p className="text-sm text-slate-400">Loading reports...</p>
                      </div>
                    </td>
                  </tr>
                ) : reports.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center">
                      <div className="flex flex-col items-center gap-3">
                        <div className="p-4 rounded-full bg-slate-800/50">
                          <FileSpreadsheet className="w-10 h-10 text-slate-600" />
                        </div>
                        <div>
                          <p className="text-base font-semibold text-slate-400">No reports found</p>
                          <p className="text-sm text-slate-500 mt-1">Generate a new report to get started</p>
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : (
                  reports.map((report) => (
                    <tr 
                      key={report.id || report.name} 
                      className={`hover:bg-slate-800/50 transition-colors group ${
                        report.status === 'Generating' ? 'bg-indigo-500/5' : ''
                      }`}
                    >
                      <td className="px-6 py-5">
                        <div className="flex items-center gap-3">
                          <div className={`p-2.5 rounded-xl ${
                            report.status === 'Generating' ? 'bg-indigo-500/20 animate-pulse' : 'bg-indigo-500/20'
                          }`}>
                            <FileSpreadsheet className={`w-5 h-5 ${
                              report.status === 'Generating' ? 'text-indigo-400' : 'text-indigo-400'
                            }`} />
                          </div>
                          <div>
                            <p className="text-sm font-medium text-white group-hover:text-indigo-400 transition-colors">{report.name}</p>
                            <p className="text-xs text-slate-500">PDF Document</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-5">
                        <span className="inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 text-slate-300 border border-slate-700">
                          {report.type}
                        </span>
                      </td>
                      <td className="px-6 py-5">
                        {report.status === 'Generating' ? (
                          <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-500/20 text-amber-400 border border-amber-500/30">
                            <Clock className="w-4 h-4 animate-pulse" />
                            Generating...
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                            <CheckCircle className="w-4 h-4" />
                            Ready
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-5 text-sm text-slate-400">{report.date}</td>
                      <td className="px-6 py-5 text-sm font-semibold text-white">{report.size}</td>
                      <td className="px-6 py-5">
                        <div className="flex gap-2" style={{ position: 'relative', zIndex: 10 }}>
                          {/* View Button */}
                          <button
                            onClick={() => {
                              console.log('View button clicked for report:', report.id);
                              handleViewReport(report);
                            }}
                            disabled={report.status === 'Generating'}
                            className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white text-sm font-medium flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            style={{ pointerEvents: 'auto' }}
                          >
                            <Eye className="w-4 h-4" />
                            View
                          </button>
                          
                          {/* Download Button */}
                          <button
                            onClick={() => {
                              console.log('Download button clicked for report:', report.id);
                              handleDownloadReport(report);
                            }}
                            disabled={report.status === 'Generating'}
                            className="px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            style={{ pointerEvents: 'auto' }}
                          >
                            <Download className="w-4 h-4" />
                            Download
                          </button>
                          
                          {/* Delete Button */}
                          <button
                            onClick={() => {
                              console.log('Delete button clicked for report:', report.id);
                              handleDeleteReport(report);
                            }}
                            disabled={report.status === 'Generating' || deletingId !== null}
                            className="px-3.5 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-medium flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            style={{ pointerEvents: 'auto' }}
                          >
                            {deletingId !== null ? (
                              <>
                                <RefreshCw className="w-4 h-4 animate-spin" />
                                Deleting...
                              </>
                            ) : (
                              <>
                                <Trash2 className="w-4 h-4" />
                                Delete
                              </>
                            )}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Preview Modal */}
      {showPreviewModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="relative overflow-hidden rounded-2xl bg-linear-to-br from-slate-900 via-slate-800 to-slate-900 border border-slate-700 shadow-2xl w-full max-w-6xl max-h-[90vh] flex flex-col">
            <div className="absolute inset-0 bg-linear-to-r from-indigo-500/5 via-transparent to-purple-500/5" />
            
            <div className="relative px-8 py-6 border-b border-slate-700 shrink-0">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-xl bg-indigo-500/10">
                    <FileText className="w-6 h-6 text-indigo-400 shrink-0" />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-white">Report Preview</h2>
                    <p className="text-sm text-slate-400 mt-1">
                      {selectedReportData 
                        ? `${selectedReportData.name} - ${selectedReportData.date}`
                        : `${reportTypes.find(r => r.id === selectedReport)?.name || 'Report'} - ${dateFrom} to ${dateTo}`
                      }
                    </p>
                  </div>
                </div>
                <button 
                  onClick={() => {
                    setShowPreviewModal(false);
                    setSelectedReportData(null);
                    setViewedReport(null);
                  }}
                  className="p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 hover:border-slate-600 transition-all"
                >
                  <X className="w-5 h-5 text-slate-400" />
                </button>
              </div>
            </div>
            
            <div className="relative flex-1 overflow-auto p-8">
              <div className="space-y-6">
                {/* When viewing an existing report with filePath, show actual PDF */}
                {selectedReportData && (selectedReportData.filePath || selectedReportData.url) ? (
                  // Actual PDF Preview
                  <div className="relative overflow-hidden rounded-xl bg-slate-800 border border-slate-700 h-[60vh]">
                    <iframe
                      src={(() => {
                        const fileUrl = selectedReportData.filePath || selectedReportData.url;
                        const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api';
                        if (fileUrl.startsWith('/')) {
                          return `${API_BASE_URL}${fileUrl}`;
                        }
                        return fileUrl;
                      })()}
                      className="w-full h-full border-0"
                      title="Report PDF Preview"
                    />
                  </div>
                ) : selectedReportData ? (
                  // No file available - show preview not available message
                  <div className="relative overflow-hidden rounded-xl bg-linear-to-br from-slate-900 via-slate-800 to-slate-900 border border-slate-700 p-12">
                    <div className="absolute inset-0 bg-linear-to-r from-indigo-500/5 via-transparent to-purple-500/5" />
                    <div className="relative flex flex-col items-center justify-center text-center">
                      <div className="p-4 rounded-full bg-slate-800/50 mb-4">
                        <FileText className="w-12 h-12 text-slate-500" />
                      </div>
                      <h3 className="text-xl font-bold text-white mb-2">Preview Not Available</h3>
                      <p className="text-slate-400 max-w-md">
                        The PDF file for this report is not available. This may happen if the report is still generating or if the file has been deleted.
                      </p>
                    </div>
                  </div>
                ) : (
                  // New report preview - show template/summary
                  <>
                    {/* Report Header */}
                    <div className="border-b border-slate-700 pb-6">
                      <h3 className="text-2xl font-bold text-white mb-3">
                        {reportTypes.find(r => r.id === selectedReport)?.name || 'Report'}
                      </h3>
                      <div className="flex flex-wrap gap-6 text-sm text-slate-400">
                        <div className="flex items-center gap-2">
                          <Calendar className="w-4 h-4 text-indigo-400" />
                          <span>Period: <span className="text-white font-medium">{dateFrom} to {dateTo}</span></span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Clock className="w-4 h-4 text-indigo-400" />
                          <span>Generated: <span className="text-white font-medium">{new Date().toLocaleDateString()}</span></span>
                        </div>
                        <div className="flex items-center gap-2">
                          <FileText className="w-4 h-4 text-indigo-400" />
                          <span>Format: <span className="text-white font-medium">PDF</span></span>
                        </div>
                      </div>
                    </div>

                    {/* Use generated mock data for preview */}
                    {(() => {
                      const reportData = generateReportData(
                        reportTypes.find(r => r.id === selectedReport)?.name || 'Report',
                        dateFrom,
                        dateTo
                      );
                      
                      return (
                        <>
                          {/* Report Summary */}
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div className="relative overflow-hidden rounded-xl bg-linear-to-br from-slate-900 to-slate-800 border border-slate-700/50 p-5">
                              <div className="absolute top-0 right-0 w-24 h-24 bg-indigo-500/10 rounded-full blur-2xl" />
                              <p className="text-xs font-medium text-slate-400 uppercase tracking-wider mb-2">Total Plants</p>
                              <p className="text-3xl font-bold bg-linear-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">{reportData.summary.totalPlants}</p>
                            </div>
                            <div className="relative overflow-hidden rounded-xl bg-linear-to-br from-slate-900 to-slate-800 border border-slate-700/50 p-5">
                              <div className="absolute top-0 right-0 w-24 h-24 bg-emerald-500/10 rounded-full blur-2xl" />
                              <p className="text-xs font-medium text-slate-400 uppercase tracking-wider mb-2">Total Capacity</p>
                              <p className="text-3xl font-bold bg-linear-to-r from-emerald-400 to-teal-400 bg-clip-text text-transparent">{reportData.summary.totalCapacity} <span className="text-lg text-slate-500">MW</span></p>
                            </div>
                            <div className="relative overflow-hidden rounded-xl bg-linear-to-br from-slate-900 to-slate-800 border border-slate-700/50 p-5">
                              <div className="absolute top-0 right-0 w-24 h-24 bg-amber-500/10 rounded-full blur-2xl" />
                              <p className="text-xs font-medium text-slate-400 uppercase tracking-wider mb-2">Avg Efficiency</p>
                              <p className="text-3xl font-bold bg-linear-to-r from-amber-400 to-orange-400 bg-clip-text text-transparent">{reportData.summary.avgEfficiency}<span className="text-lg text-slate-500">%</span></p>
                            </div>
                          </div>

                          {/* Report Data Table */}
                          <div className="relative overflow-hidden rounded-xl bg-linear-to-br from-slate-900 via-slate-800 to-slate-900 border border-slate-700/50">
                            <div className="absolute inset-0 bg-linear-to-r from-indigo-500/3 via-transparent to-purple-500/3" />
                            
                            <div className="relative overflow-x-auto">
                              <table className="w-full text-sm">
                                <thead className="bg-slate-800/80">
                                  <tr>
                                    {['Plant', 'Capacity (MW)', 'Generation (MW)', 'Efficiency (%)'].map(header => (
                                      <th key={header} className="px-6 py-4 text-left text-xs font-semibold text-slate-300 uppercase tracking-wider border-b border-slate-700">
                                        {header}
                                      </th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-800">
                                  {reportData.plants.map((row, i) => (
                                    <tr key={i} className="hover:bg-slate-800/50 transition-colors">
                                      <td className="px-6 py-4 font-medium text-white">{row.name}</td>
                                      <td className="px-6 py-4 text-slate-400">{row.capacity}</td>
                                      <td className="px-6 py-4 text-slate-400">{row.generation}</td>
                                      <td className="px-6 py-4 font-semibold text-indigo-400">{row.efficiency}%</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        </>
                      );
                    })()}

                    <div className="relative overflow-hidden rounded-xl bg-indigo-500/10 border border-indigo-500/20 p-5">
                      <div className="absolute inset-0 bg-linear-to-r from-indigo-500/5 via-transparent to-purple-500/5" />
                      <p className="relative text-sm text-slate-300">
                        <strong className="text-white">Note:</strong> This is a preview of the report. The actual generated report will contain complete data for the selected period and format.
                      </p>
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="relative px-8 py-6 border-t border-slate-700 bg-slate-900/50 flex gap-4 shrink-0">
              <button 
                onClick={() => setShowPreviewModal(false)}
                className="flex-1 px-6 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 hover:border-slate-600 transition-all font-semibold text-white flex items-center justify-center"
              >
                Close
              </button>
              {/* Only show Generate PDF button for new report preview (not when viewing existing reports) */}
              {!viewedReport && (
                <button 
                  onClick={() => {
                    setShowPreviewModal(false);
                    setTimeout(() => {
                      handleGenerateReport();
                    }, 100);
                  }}
                  className="flex-1 px-6 py-3 rounded-xl bg-linear-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white shadow-lg shadow-indigo-500/25 hover:shadow-indigo-500/40 transition-all font-semibold flex items-center justify-center gap-2"
                >
                  <Download className="w-5 h-5" />
                  Generate PDF
                </button>
              )}
              {/* Show Download button when viewing existing report with file */}
              {viewedReport && (viewedReport.filePath || viewedReport.url) && (
                <button 
                  onClick={() => {
                    handleDownloadReport(viewedReport);
                  }}
                  className="flex-1 px-6 py-3 rounded-xl bg-linear-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white shadow-lg shadow-indigo-500/25 hover:shadow-indigo-500/40 transition-all font-semibold flex items-center justify-center gap-2"
                >
                  <Download className="w-5 h-5" />
                  Download PDF
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Reports;

