// API Configuration
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api';

// Use real API by default (FastAPI backend)
const USE_REAL_API = import.meta.env.VITE_USE_REAL_API !== 'false';

// Mock delay to simulate network requests
const MOCK_DELAY = 300;

// Simulate network delay
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Generic API error class
export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

// Generic fetch wrapper with error handling
async function fetchWithError(url, options = {}) {
  try {
    // Don't set Content-Type for FormData (browser will set it with boundary)
    const isFormData = options.body instanceof FormData;
    const headers = isFormData 
      ? { ...options.headers }
      : {
          'Content-Type': 'application/json',
          ...options.headers,
        };
    
    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new ApiError(
        errorData.message || `HTTP ${response.status}: ${response.statusText}`,
        response.status,
        errorData
      );
    }

    return await response.json();
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError(
      error.message || 'Network request failed',
      0,
      { originalError: error }
    );
  }
}

// Mock API - Replace with real backend calls
const mockApi = {

  // Dashboard APIs
  dashboard: {
    getStats: async () => {
      if (USE_REAL_API) {
        try {
          const response = await fetchWithError(`${API_BASE_URL}/dashboard/stats`);
          return {
            ...response,
            schedules: {
              total: 45,
              pending: 8,
              approved: 32,
              revised: 5
            }
          };
        } catch (error) {
          console.warn('Backend API failed, using mock data:', error);
        }
      }
      
      await delay(MOCK_DELAY);
      return {
        activePlants: 12,
        totalCapacity: 1245,
        currentGeneration: 892,
        efficiency: 71.6,
        schedules: {
          total: 45,
          pending: 8,
          approved: 32,
          revised: 5
        }
      };
    },

    getSummary: async (filters = {}) => {
      await delay(MOCK_DELAY);
      return {
        period: filters.period || 'today',
        data: [
          { time: '00:00', scheduled: 45.2, actual: 48.5, forecast: 46.1 },
          { time: '06:00', scheduled: 52.1, actual: 49.8, forecast: 51.5 },
          { time: '12:00', scheduled: 61.2, actual: 58.9, forecast: 60.5 },
          { time: '18:00', scheduled: 46.8, actual: 51.2, forecast: 48.3 },
        ],
        summary: {
          totalScheduled: 205.3,
          totalActual: 208.4,
          deviation: 3.1,
          deviationPercent: 1.5
        }
      };
    }
  },

  // Plants APIs
  plants: {
    getAll: async (filters = {}) => {
      if (USE_REAL_API) {
        try {
          const params = new URLSearchParams();
          if (filters.type && filters.type !== 'All Types') params.append('type', filters.type);
          if (filters.state && filters.state !== 'All States') params.append('state', filters.state);
          
          const response = await fetchWithError(`${API_BASE_URL}/plants?${params}`);
          // FastAPI returns array directly
          const plants = Array.isArray(response) ? response : [];
          const plantsWithUpdate = plants.map(p => ({
            ...p,
            lastUpdate: p.lastUpdated ? new Date(p.lastUpdated).toLocaleString() : 'Unknown'
          }));
          
          const windPlants = plantsWithUpdate.filter(p => p.type === 'Wind');
          const solarPlants = plantsWithUpdate.filter(p => p.type === 'Solar');
          const activePlants = plantsWithUpdate.filter(p => p.status === 'Active');
          const maintenancePlants = plantsWithUpdate.filter(p => p.status === 'Maintenance');
          const windCapacity = windPlants.reduce((sum, p) => sum + (p.capacity || 0), 0);
          const solarCapacity = solarPlants.reduce((sum, p) => sum + (p.capacity || 0), 0);
          const totalCapacity = plantsWithUpdate.reduce((sum, p) => sum + (p.capacity || 0), 0);
          
          return {
            plants: plantsWithUpdate,
            total: plantsWithUpdate.length,
            stats: {
              totalPlants: plantsWithUpdate.length,
              totalCapacity: totalCapacity,
              windPlants: windPlants.length,
              solarPlants: solarPlants.length,
              windCapacity: windCapacity,
              solarCapacity: solarCapacity,
              activePlants: activePlants.length,
              maintenancePlants: maintenancePlants.length,
              uptime: plantsWithUpdate.length > 0 ? Math.round((activePlants.length / plantsWithUpdate.length) * 100) : 0,
              active: activePlants.length
            }
          };
        } catch (error) {
          console.warn('Backend API failed, using mock data:', error);
        }
      }
      
      await delay(MOCK_DELAY);
      const allPlants = [
        { id: 1, name: 'Wind Farm A', type: 'Wind', state: 'Maharashtra', capacity: 150, status: 'Active', lastUpdate: '2 hours ago' },
        { id: 2, name: 'Solar Plant B', type: 'Solar', state: 'Gujarat', capacity: 120, status: 'Active', lastUpdate: '1 hour ago' },
        { id: 3, name: 'Wind Farm C', type: 'Wind', state: 'Rajasthan', capacity: 95, status: 'Active', lastUpdate: '30 mins ago' },
        { id: 4, name: 'Solar Plant D', type: 'Solar', state: 'Tamil Nadu', capacity: 80, status: 'Maintenance', lastUpdate: '5 hours ago' },
        { id: 5, name: 'Wind Farm E', type: 'Wind', state: 'Maharashtra', capacity: 110, status: 'Active', lastUpdate: '3 hours ago' },
        { id: 6, name: 'Solar Plant F', type: 'Solar', state: 'Gujarat', capacity: 90, status: 'Active', lastUpdate: '45 mins ago' },
      ];

      // Apply filters
      let filtered = allPlants;
      if (filters.type && filters.type !== 'All Types') {
        filtered = filtered.filter(p => p.type === filters.type);
      }
      if (filters.state && filters.state !== 'All States') {
        filtered = filtered.filter(p => p.state === filters.state);
      }

      // Calculate comprehensive stats
      const windPlants = filtered.filter(p => p.type === 'Wind');
      const solarPlants = filtered.filter(p => p.type === 'Solar');
      const activePlants = filtered.filter(p => p.status === 'Active');
      const maintenancePlants = filtered.filter(p => p.status === 'Maintenance');
      const windCapacity = windPlants.reduce((sum, p) => sum + p.capacity, 0);
      const solarCapacity = solarPlants.reduce((sum, p) => sum + p.capacity, 0);
      const totalCapacity = filtered.reduce((sum, p) => sum + p.capacity, 0);

      return {
        plants: filtered,
        total: filtered.length,
        stats: {
          totalPlants: filtered.length,
          totalCapacity: totalCapacity,
          windPlants: windPlants.length,
          solarPlants: solarPlants.length,
          windCapacity: windCapacity,
          solarCapacity: solarCapacity,
          activePlants: activePlants.length,
          maintenancePlants: maintenancePlants.length,
          uptime: activePlants.length > 0 ? Math.round((activePlants.length / filtered.length) * 100) : 0,
          active: activePlants.length
        }
      };
    },

    getById: async (id) => {
      await delay(MOCK_DELAY);
      return {
        id,
        name: `Plant ${id}`,
        type: 'Wind',
        capacity: 150,
        location: { lat: 19.0760, lng: 72.8777 },
        status: 'Active'
      };
    },

    create: async (plantData) => {
      if (USE_REAL_API) {
        try {
          const response = await fetchWithError(`${API_BASE_URL}/plants`, {
            method: 'POST',
            body: JSON.stringify(plantData)
          });
          return {
            success: true,
            plant: {
              ...response,
              lastUpdate: response.lastUpdated ? new Date(response.lastUpdated).toLocaleString() : 'Just now'
            }
          };
        } catch (error) {
          console.warn('Backend API failed, using mock data:', error);
        }
      }
      
      await delay(MOCK_DELAY);
      return {
        success: true,
        plant: {
          id: Date.now(),
          ...plantData,
          status: 'Active',
          lastUpdate: 'Just now'
        }
      };
    },

    update: async (id, plantData) => {
      if (USE_REAL_API) {
        try {
          const response = await fetchWithError(`${API_BASE_URL}/plants/${id}`, {
            method: 'PUT',
            body: JSON.stringify(plantData)
          });
          return {
            success: true,
            plant: response
          };
        } catch (error) {
          console.warn('Backend API failed, using mock data:', error);
        }
      }
      
      await delay(MOCK_DELAY);
      return {
        success: true,
        plant: { id, ...plantData }
      };
    },

    delete: async (id) => {
      if (USE_REAL_API) {
        try {
          await fetchWithError(`${API_BASE_URL}/plants/${id}`, {
            method: 'DELETE'
          });
          return { success: true, message: 'Plant deleted successfully' };
        } catch (error) {
          console.warn('Backend API failed, using mock data:', error);
        }
      }
      
      await delay(MOCK_DELAY);
      return { success: true, message: 'Plant deleted successfully' };
    }
  },

// Schedules APIs
  schedules: {
    getAll: async (filters = {}) => {
      if (USE_REAL_API) {
        try {
          const params = new URLSearchParams();
          if (filters.status && filters.status !== 'All') params.append('status', filters.status);
          if (filters.type && filters.type !== 'All') params.append('type', filters.type);
          if (filters.plant && filters.plant !== 'All' && filters.plant !== 'Select Plant') params.append('plant', filters.plant);
          if (filters.startDate) params.append('startDate', filters.startDate);
          if (filters.endDate) params.append('endDate', filters.endDate);
          // Request limit of 10 from backend
          params.append('limit', '10');
          
          const response = await fetchWithError(`${API_BASE_URL}/schedules?${params}`);
          // FastAPI returns array directly - already limited by backend to 10
          const schedules = Array.isArray(response) ? response : [];
          // Ensure we don't exceed 10 (backend should already limit, but double-check)
          const limitedSchedules = schedules.slice(0, 10);
          return {
            schedules: limitedSchedules.map(s => {
              // Determine category based on plant name
              const plantName = s.plantName || '';
              const category = plantName.toLowerCase().includes('wind') ? 'Wind' : 
                             plantName.toLowerCase().includes('solar') ? 'Solar' : 
                             'Wind';
              return {
                id: s.id,
                time: s.scheduleDate ? (typeof s.scheduleDate === 'string' ? s.scheduleDate : s.scheduleDate.toISOString().split('T')[0]) : new Date().toISOString().split('T')[0],
                plant: s.plantName,
                category: category,
                type: s.type,
                status: s.status,
                capacity: s.capacity,
                forecasted: s.forecasted,
                actual: s.actual,
                deviation: s.deviation,
                changes: 'No',
                blockData: s.blockData || null
              };
            }),
            total: limitedSchedules.length
          };
        } catch (error) {
          console.warn('Backend API failed, using mock data:', error);
        }
      }
      
      await delay(MOCK_DELAY);
      // Return empty array for mock - Dashboard will use ALL_SCHEDULES instead
      const allSchedules = [];

      let filtered = allSchedules;
      if (filters.status && filters.status !== 'All') {
        filtered = filtered.filter(s => s.status === filters.status);
      }
      if (filters.type && filters.type !== 'All') {
        filtered = filtered.filter(s => s.type === filters.type);
      }

      return {
        schedules: filtered,
        total: filtered.length
      };
    },

    getById: async (id) => {
      await delay(MOCK_DELAY);
      return {
        id,
        time: '00:00',
        plant: 'Wind Farm A',
        scheduledValue: 45.2,
        actualValue: 48.5,
        status: 'Approved'
      };
    },

    create: async (scheduleData) => {
      if (USE_REAL_API) {
        try {
          const response = await fetchWithError(`${API_BASE_URL}/schedules`, {
            method: 'POST',
            body: JSON.stringify(scheduleData)
          });
          return {
            success: true,
            schedule: response
          };
        } catch (error) {
          console.warn('Backend API failed, using mock data:', error);
        }
      }
      
      await delay(MOCK_DELAY);
      return {
        success: true,
        schedule: {
          id: Date.now(),
          ...scheduleData,
          status: 'Pending'
        }
      };
    },

    update: async (id, scheduleData) => {
      if (USE_REAL_API) {
        try {
          const response = await fetchWithError(`${API_BASE_URL}/schedules/${id}`, {
            method: 'PUT',
            body: JSON.stringify(scheduleData)
          });
          return {
            success: true,
            schedule: response
          };
        } catch (error) {
          console.warn('Backend API failed, using mock data:', error);
        }
      }
      
      await delay(MOCK_DELAY);
      return {
        success: true,
        schedule: { id, ...scheduleData }
      };
    },

    delete: async (id) => {
      if (USE_REAL_API) {
        try {
          await fetchWithError(`${API_BASE_URL}/schedules/${id}`, {
            method: 'DELETE'
          });
          return { success: true, message: 'Schedule deleted successfully' };
        } catch (error) {
          console.warn('Backend API failed, using mock data:', error);
        }
      }
      
      await delay(MOCK_DELAY);
      return { success: true, message: 'Schedule deleted successfully' };
    },

    bulkUpload: async (file) => {
      if (USE_REAL_API) {
        try {
          const formData = new FormData();
          formData.append('file', file);
          
          const response = await fetchWithError(`${API_BASE_URL}/schedules/bulk-upload`, {
            method: 'POST',
            body: formData,
            headers: {} // Let browser set Content-Type for FormData
          });
          
          return {
            success: response.success || true,
            imported: response.imported || 0,
            failed: response.failed || 0,
            message: response.errors && response.errors.length > 0 
              ? `${response.imported} schedules imported, ${response.failed} failed`
              : `${response.imported} schedules imported successfully`
          };
        } catch (error) {
          console.warn('Backend API failed, using mock data:', error);
        }
      }
      
      await delay(MOCK_DELAY * 2);
      return {
        success: true,
        imported: 45,
        failed: 2,
        message: '45 schedules imported successfully, 2 failed'
      };
    },

    // New endpoint for uploading 96-block schedule data
    upload96Blocks: async (file, plantName, scheduleType, scheduleDate) => {
      if (USE_REAL_API) {
        try {
          const formData = new FormData();
          formData.append('file', file);
          formData.append('plant_name', plantName);
          formData.append('schedule_type', scheduleType);
          formData.append('schedule_date', scheduleDate);
          
          const response = await fetchWithError(`${API_BASE_URL}/schedules/upload-96-blocks`, {
            method: 'POST',
            body: formData,
            headers: {} // Let browser set Content-Type for FormData
          });
          
          return response;
        } catch (error) {
          console.warn('Backend API failed:', error);
          throw error;
        }
      }
      
      await delay(MOCK_DELAY * 2);
      return {
        success: true,
        message: `Schedule uploaded successfully with 96 time blocks`,
        scheduleId: Date.now(),
        plantName: plantName,
        scheduleDate: scheduleDate,
        type: scheduleType,
        totalBlocks: 96,
        totalForecasted: 4521.5,
        totalActual: 4682.3,
        deviation: 3.55
      };
    },

    // Get schedule with 96-block data
    getWithBlocks: async (scheduleId) => {
      if (USE_REAL_API) {
        try {
          const response = await fetchWithError(`${API_BASE_URL}/schedules/${scheduleId}/blocks`);
          return response;
        } catch (error) {
          console.warn('Backend API failed:', error);
          throw error;
        }
      }
      
      await delay(MOCK_DELAY);
      return {
        id: scheduleId,
        plantName: 'Wind Farm A',
        type: 'Day-Ahead',
        scheduleDate: new Date().toISOString().split('T')[0],
        capacity: 45.2,
        forecasted: 4521.5,
        actual: 4682.3,
        status: 'Pending',
        deviation: 3.55,
        blockData: generateMockBlockData()
      };
    },

    submit: async (scheduleData) => {
      if (USE_REAL_API) {
        try {
          const response = await fetchWithError(`${API_BASE_URL}/schedules/submit`, {
            method: 'POST',
            body: JSON.stringify(scheduleData)
          });
          return {
            success: true,
            message: 'Schedule submitted successfully',
            schedule: response
          };
        } catch (error) {
          console.warn('Backend API failed, using mock data:', error);
        }
      }
      
      await delay(MOCK_DELAY);
      return {
        success: true,
        message: 'Schedule submitted successfully',
        schedule: {
          id: Date.now(),
          ...scheduleData,
          status: 'Submitted',
          submittedAt: new Date().toISOString()
        }
      };
    }
  },

  // Forecasts APIs
  forecasts: {
    getAll: async (filters = {}) => {
      if (USE_REAL_API) {
        try {
          const params = new URLSearchParams();
          if (filters.plantId) params.append('plantId', filters.plantId);
          if (filters.date) params.append('date', filters.date);
          
          const response = await fetchWithError(`${API_BASE_URL}/forecasts?${params}`);
          const forecasts = Array.isArray(response) ? response : [];
          
          // Transform backend data to frontend format
          return {
            forecasts: forecasts.map(f => {
              const hourlyData = f.hourlyData ? (typeof f.hourlyData === 'string' ? JSON.parse(f.hourlyData) : f.hourlyData) : {};
              return {
                time: f.forecastDate || new Date().toISOString().split('T')[0],
                plantId: f.plantId,
                plantName: f.plantName,
                hourlyData: hourlyData
              };
            }),
            period: filters.period || 'today'
          };
        } catch (error) {
          console.warn('Backend API failed, using mock data:', error);
        }
      }
      
      await delay(MOCK_DELAY);
      return {
        forecasts: [],
        period: filters.period || 'today'
      };
    },

    // Get forecast data for a specific plant and date (96 time blocks)
    getForecastData: async (plantId, date) => {
      if (USE_REAL_API) {
        try {
          // Use the new backend endpoint: /api/forecasts/{plant_id}/data
          const response = await fetchWithError(`${API_BASE_URL}/forecasts/${plantId}/data?date=${date}`);
          return response;
        } catch (error) {
          console.warn('Backend API failed, using mock data:', error);
        }
      }

      await delay(MOCK_DELAY);
      // Generate realistic 96 time blocks of forecast data
      return generateMockForecastData(date);
    },

    compare: async (filters = {}) => {
      await delay(MOCK_DELAY);
      return {
        comparison: []
      };
    }
  },

  // Reports APIs
  reports: {
    generate: async (reportConfig) => {
      if (USE_REAL_API) {
        try {
          const response = await fetchWithError(`${API_BASE_URL}/reports/generate`, {
            method: 'POST',
            body: JSON.stringify(reportConfig)
          });
          return {
            success: true,
            reportId: response.id,
            downloadUrl: `/api/reports/${response.id}/download`,
            format: response.format,
            message: 'Report generated successfully'
          };
        } catch (error) {
          console.warn('Backend API failed, using mock data:', error);
        }
      }
      
      await delay(MOCK_DELAY * 2);
      return {
        success: true,
        reportId: Date.now(),
        downloadUrl: '/api/reports/download/' + Date.now(),
        format: reportConfig.format,
        message: 'Report generated successfully'
      };
    },

    getAll: async (filters = {}) => {
      if (USE_REAL_API) {
        try {
          // Build query params from filters
          const params = new URLSearchParams();
          if (filters.type) params.append('type', filters.type);
          if (filters.state) params.append('state', filters.state);
          if (filters.limit) params.append('limit', filters.limit.toString());
          
          const response = await fetchWithError(`${API_BASE_URL}/reports?${params}`);
          const reports = Array.isArray(response) ? response : [];
          
          // Transform backend report data to frontend format with proper date handling
          return {
            reports: reports.map(r => {
              // Parse the generatedDate - handle various formats
              let dateStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
              let createdAtIso = new Date().toISOString();
              
              try {
                if (r.generatedDate) {
                  // Handle both string and date object formats from backend
                  if (typeof r.generatedDate === 'string') {
                    const dateObj = new Date(r.generatedDate);
                    if (!isNaN(dateObj)) {
                      dateStr = dateObj.toLocaleDateString('en-GB', {
                        day: '2-digit',
                        month: 'short',
                        year: 'numeric'
                      });
                      createdAtIso = dateObj.toISOString();
                    }
                  } else if (r.generatedDate instanceof Date) {
                    // It's a JavaScript Date object
                    dateStr = r.generatedDate.toLocaleDateString('en-GB', {
                      day: '2-digit',
                      month: 'short',
                      year: 'numeric'
                    });
                    createdAtIso = r.generatedDate.toISOString();
                  } else if (r.generatedDate.year !== undefined) {
                    // It's a Python date object - convert manually
                    const { year, month, day } = r.generatedDate;
                    const dateObj = new Date(year, month - 1, day);
                    dateStr = dateObj.toLocaleDateString('en-GB', {
                      day: '2-digit',
                      month: 'short',
                      year: 'numeric'
                    });
                    createdAtIso = dateObj.toISOString();
                  }
                }
              } catch (e) {
                console.warn('Error parsing report date:', e);
              }
              
              // Also check for createdAt if available
              if (r.createdAt) {
                try {
                  const createdDate = new Date(r.createdAt);
                  if (!isNaN(createdDate)) {
                    createdAtIso = createdDate.toISOString();
                  }
                } catch (e) {
                  // Ignore
                }
              }
              
              return {
                id: r.id,
                name: r.name,
                date: dateStr,
                type: r.type,
                size: r.size || '2.4 MB',
                status: r.status || 'Ready',
                filePath: r.filePath || null,
                url: r.filePath || null,
                // Store ISO date for sorting
                createdAt: createdAtIso,
                generatedDate: createdAtIso
              };
            }).sort((a, b) => {
              // Sort by date (newest first)
              const dateA = new Date(a.createdAt || a.generatedDate || 0);
              const dateB = new Date(b.createdAt || b.generatedDate || 0);
              return dateB - dateA;
            })
          };
        } catch (error) {
          console.warn('Backend API failed for reports, using mock data:', error);
          // Fall back to mock data on API failure
          return {
            reports: [
              { id: 1, name: 'Monthly Schedule Summary - Dec 2025', date: '05-Jan-2026', type: 'Schedule', size: '2.4 MB', status: 'Ready', url: '#', createdAt: '2026-01-05T10:00:00Z' },
              { id: 2, name: 'Deviation Analysis - Q4 2025', date: '02-Jan-2026', type: 'Deviation', size: '1.8 MB', status: 'Ready', url: '#', createdAt: '2026-01-02T10:00:00Z' },
              { id: 3, name: 'Wind Farm Performance Report', date: '28-Dec-2025', type: 'Plant', size: '3.2 MB', status: 'Ready', url: '#', createdAt: '2025-12-28T10:00:00Z' },
              { id: 4, name: 'Solar Capacity Utilization', date: '20-Dec-2025', type: 'Capacity', size: '1.5 MB', status: 'Ready', url: '#', createdAt: '2025-12-20T10:00:00Z' },
            ]
          };
        }
      }
      
      // When not using real API, return mock data for development
      await delay(MOCK_DELAY);
      return {
        reports: [
          { id: 1, name: 'Monthly Schedule Summary - Dec 2025', date: '05-Jan-2026', type: 'Schedule', size: '2.4 MB', status: 'Ready', url: '#', createdAt: '2026-01-05T10:00:00Z' },
          { id: 2, name: 'Deviation Analysis - Q4 2025', date: '02-Jan-2026', type: 'Deviation', size: '1.8 MB', status: 'Ready', url: '#', createdAt: '2026-01-02T10:00:00Z' },
          { id: 3, name: 'Wind Farm Performance Report', date: '28-Dec-2025', type: 'Plant', size: '3.2 MB', status: 'Ready', url: '#', createdAt: '2025-12-28T10:00:00Z' },
          { id: 4, name: 'Solar Capacity Utilization', date: '20-Dec-2025', type: 'Capacity', size: '1.5 MB', status: 'Ready', url: '#', createdAt: '2025-12-20T10:00:00Z' },
        ]
      };
    },

    download: async (reportId) => {
      if (USE_REAL_API) {
        try {
          const response = await fetchWithError(`${API_BASE_URL}/reports/${reportId}/download`);
          return {
            success: true,
            url: response.url || `/api/reports/${reportId}/download`,
            filename: response.filename
          };
        } catch (error) {
          console.warn('Backend API failed, using mock data:', error);
        }
      }

      await delay(MOCK_DELAY);
      return {
        success: true,
        url: '/downloads/report-' + reportId + '.pdf'
      };
    },

    delete: async (reportId) => {
      if (USE_REAL_API) {
        try {
          // Check if it's a temp ID (not a real database ID)
          if (reportId?.toString().startsWith('temp-')) {
            return { success: true, message: 'Temp report removed' };
          }
          
          // Handle numeric IDs properly
          const cleanId = parseInt(reportId, 10);
          if (isNaN(cleanId)) {
            throw new Error(`Invalid report ID: ${reportId}`);
          }
          
          const result = await fetchWithError(`${API_BASE_URL}/reports/${cleanId}`, {
            method: 'DELETE'
          });
          
          // Backend returns { success: true/false, message: "...", id: report_id }
          if (result && (result.success === true || result.message)) {
            return { 
              success: true, 
              message: result.message || 'Report deleted successfully',
              id: result.id || cleanId
            };
          }
          
          // If result indicates failure
          if (result && result.success === false) {
            throw new Error(result.message || 'Failed to delete report');
          }
          
          return { success: false, message: 'Delete operation returned no result' };
        } catch (error) {
          console.error('Delete report API error:', error);
          // Return a structured error that the frontend can handle
          throw new Error(error.message || 'Failed to delete report');
        }
      }

      await delay(MOCK_DELAY);
      return { success: true, message: 'Report deleted successfully' };
    }
  },

  // Deviation APIs
  deviations: {
    getAll: async (filters = {}) => {
      if (USE_REAL_API) {
        try {
          const params = new URLSearchParams();
          if (filters.period) params.append('period', filters.period);
          if (filters.limit) params.append('limit', filters.limit);
          
          const response = await fetchWithError(`${API_BASE_URL}/deviations?${params}`);
          const deviations = Array.isArray(response) ? response : [];
          
          // Transform backend data to frontend format
          const transformed = deviations.map(d => ({
            time: d.hour !== undefined ? `${String(d.hour).padStart(2, '0')}:00` : '00:00',
            hour: d.hour,
            date: d.date || null,
            dayOfWeek: d.dayOfWeek || null,
            week: d.week || null,
            scheduled: d.forecasted || 0,
            actual: d.actual || 0,
            deviation: d.deviation || 0,
            percentage: d.forecasted ? ((d.deviation / d.forecasted) * 100).toFixed(1) : 0
          }));
          
          const totalDeviation = transformed.reduce((sum, d) => sum + Math.abs(d.deviation), 0);
          const avgPercentage = transformed.length > 0 
            ? (transformed.reduce((sum, d) => sum + Math.abs(parseFloat(d.percentage)), 0) / transformed.length).toFixed(2)
            : 0;
          const highDeviations = transformed.filter(d => Math.abs(parseFloat(d.percentage)) > 5).length;
          
          return {
            deviations: transformed,
            summary: {
              totalDeviation: totalDeviation.toFixed(2),
              avgPercentage: parseFloat(avgPercentage),
              highDeviations: highDeviations
            }
          };
        } catch (error) {
          console.warn('Backend API failed, using mock data:', error);
        }
      }
      
      await delay(MOCK_DELAY);
      return {
        deviations: [
          { time: '00:00', plant: 'Wind Farm A', scheduled: 45.2, actual: 48.5, deviation: 3.3, percentage: 7.3, type: 'Wind' },
          { time: '00:15', plant: 'Solar Plant B', scheduled: 52.1, actual: 49.8, deviation: -2.3, percentage: -4.4, type: 'Solar' },
          { time: '00:30', plant: 'Wind Farm C', scheduled: 38.5, actual: 42.1, deviation: 3.6, percentage: 9.4, type: 'Wind' },
          { time: '00:45', plant: 'Solar Plant D', scheduled: 61.2, actual: 58.9, deviation: -2.3, percentage: -3.8, type: 'Solar' },
          { time: '01:00', plant: 'Wind Farm A', scheduled: 46.8, actual: 51.2, deviation: 4.4, percentage: 9.4, type: 'Wind' },
        ],
        summary: {
          totalDeviation: 6.7,
          avgPercentage: 3.58,
          highDeviations: 2
        }
      };
    },

    // Get deviations by period (hourly, daily, weekly)
    getByPeriod: async (period = 'hourly', limit = 24) => {
      if (USE_REAL_API) {
        try {
          const params = new URLSearchParams();
          params.append('period', period);
          params.append('limit', limit.toString());
          
          const response = await fetchWithError(`${API_BASE_URL}/deviations?${params}`);
          const deviations = Array.isArray(response) ? response : [];
          
          return generateDeviationResponse(deviations, period);
        } catch (error) {
          console.warn('Backend API failed, using mock data:', error);
          // Fallback to mock data
          return generateMockDeviationsByPeriod(period, limit);
        }
      }
      
      // Use mock data
      return generateMockDeviationsByPeriod(period, limit);
    }
  },

  // Weather APIs
  weather: {
    getCurrent: async (plantId) => {
      if (USE_REAL_API) {
        try {
          // Get weather data - backend returns list, get first or by location
          const response = await fetchWithError(`${API_BASE_URL}/weather`);
          const weatherData = Array.isArray(response) ? response[0] : response;
          
          if (weatherData) {
            return {
              temperature: weatherData.temperature || 28,
              windSpeed: weatherData.windSpeed || 12.5,
              humidity: weatherData.humidity || 65,
              cloudCover: weatherData.cloudCover || 30,
              pressure: weatherData.pressure || 1013,
              visibility: weatherData.visibility || 10,
              location: weatherData.location
            };
          }
        } catch (error) {
          console.warn('Backend API failed, using mock data:', error);
        }
      }
      
      await delay(MOCK_DELAY);
      return {
        temperature: 28,
        windSpeed: 12.5,
        humidity: 65,
        cloudCover: 30,
        pressure: 1013,
        visibility: 10
      };
    },

    getForecast: async (plantId, days = 7) => {
      if (USE_REAL_API) {
        try {
          const response = await fetchWithError(`${API_BASE_URL}/weather`);
          const weatherData = Array.isArray(response) ? response[0] : response;
          
          if (weatherData && weatherData.forecast) {
            const forecast = typeof weatherData.forecast === 'string' 
              ? JSON.parse(weatherData.forecast) 
              : weatherData.forecast;
            
            return {
              forecast: Array.from({ length: days }, (_, i) => ({
                date: new Date(Date.now() + i * 86400000).toISOString().split('T')[0],
                tempMin: 22 + Math.random() * 5,
                tempMax: 30 + Math.random() * 5,
                windSpeed: 10 + Math.random() * 10,
                precipitation: Math.random() * 20
              }))
            };
          }
        } catch (error) {
          console.warn('Backend API failed, using mock data:', error);
        }
      }
      
      await delay(MOCK_DELAY);
      return {
        forecast: Array.from({ length: days }, (_, i) => ({
          date: new Date(Date.now() + i * 86400000).toISOString().split('T')[0],
          tempMin: 22 + Math.random() * 5,
          tempMax: 30 + Math.random() * 5,
          windSpeed: 10 + Math.random() * 10,
          precipitation: Math.random() * 20
        }))
      };
    }
  },

  // Templates APIs
  templates: {
    getAll: async (filters = {}) => {
      if (USE_REAL_API) {
        try {
          const params = new URLSearchParams();
          if (filters.vendor && filters.vendor !== 'all') params.append('vendor', filters.vendor);
          if (filters.type && filters.type !== 'all') params.append('type', filters.type);
          
          const response = await fetchWithError(`${API_BASE_URL}/templates?${params}`);
          const templates = Array.isArray(response) ? response : [];
          
          return {
            templates: templates.map(t => ({
              id: t.id,
              name: t.name,
              vendor: t.vendor,
              type: t.type,
              lastModified: t.lastModified ? new Date(t.lastModified).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Unknown',
              status: t.status,
              filePath: t.filePath
            })),
            total: templates.length
          };
        } catch (error) {
          console.warn('Backend API failed, using mock data:', error);
        }
      }
      
      await delay(MOCK_DELAY);
      return {
        templates: [],
        total: 0
      };
    },

    create: async (templateData) => {
      if (USE_REAL_API) {
        try {
          const response = await fetchWithError(`${API_BASE_URL}/templates`, {
            method: 'POST',
            body: JSON.stringify(templateData)
          });
          return {
            success: true,
            template: response
          };
        } catch (error) {
          console.warn('Backend API failed, using mock data:', error);
        }
      }
      
      await delay(MOCK_DELAY);
      return {
        success: true,
        template: { id: Date.now(), ...templateData }
      };
    },

    delete: async (id) => {
      if (USE_REAL_API) {
        try {
          await fetchWithError(`${API_BASE_URL}/templates/${id}`, {
            method: 'DELETE'
          });
          return { success: true, message: 'Template deleted successfully' };
        } catch (error) {
          console.warn('Backend API failed, using mock data:', error);
        }
      }
      
      await delay(MOCK_DELAY);
      return { success: true, message: 'Template deleted successfully' };
    }
  },

  // WhatsApp Data APIs
  whatsappData: {
    getAll: async (filters = {}) => {
      if (USE_REAL_API) {
        try {
          const params = new URLSearchParams();
          if (filters.plantId) params.append('plant_id', filters.plantId);
          // Add timestamp to prevent caching
          params.append('_t', Date.now().toString());
          if (filters.date) params.append('date', filters.date);
          if (filters.status) params.append('status', filters.status);
          
          const response = await fetchWithError(`${API_BASE_URL}/whatsapp-data?${params}`);
          return { data: Array.isArray(response.data) ? response.data : [], total: response.total || 0 };
        } catch (error) {
          console.warn('Backend API failed, using mock data:', error);
        }
      }
      
      await delay(MOCK_DELAY);
      return {
        data: [
          {
            id: 1,
            plantId: 1,
            plantName: 'Wind Farm A',
            state: 'Maharashtra',
            date: new Date().toISOString().split('T')[0],
            time: '11:30',
            currentGeneration: 125.5,
            expectedTrend: 'Stable',
            curtailmentStatus: false,
            curtailmentReason: null,
            weatherCondition: 'Clear',
            inverterAvailability: 95.5,
            remarks: 'Plant running at 85% capacity. Wind speed 12 m/s',
            status: 'Pending Review',
            createdAt: new Date().toISOString()
          }
        ],
        total: 1
      };
    },

    create: async (whatsappData) => {
      if (USE_REAL_API) {
        try {
          // Validate required fields before sending - ensure non-empty strings
          const requiredFields = ['plantId', 'plantName', 'state', 'date', 'time', 'currentGeneration', 'expectedTrend'];
          const missingFields = requiredFields.filter(field => {
            const value = whatsappData[field];
            return value === undefined || value === null || value === '' || value === 0;
          });
          
          if (missingFields.length > 0) {
            throw new ApiError(
              `Missing required fields: ${missingFields.join(', ')}`,
              422,
              { missingFields }
            );
          }

          // Parse currentGeneration as float - ensure it's a valid number
          const currentGenValue = parseFloat(whatsappData.currentGeneration);
          if (isNaN(currentGenValue)) {
            throw new ApiError(
              'currentGeneration must be a valid number',
              422,
              { field: 'currentGeneration', value: whatsappData.currentGeneration }
            );
          }

          // Transform data types to match backend schema requirements
          const transformedData = {
            plantId: parseInt(whatsappData.plantId, 10),
            plantName: String(whatsappData.plantName || '').trim(),
            state: String(whatsappData.state || '').trim(),
            date: String(whatsappData.date || '').trim(),
            time: String(whatsappData.time || '').trim(),
            currentGeneration: currentGenValue,
            expectedTrend: String(whatsappData.expectedTrend || '').trim(),
            curtailmentStatus: Boolean(whatsappData.curtailmentStatus),
            curtailmentReason: whatsappData.curtailmentReason ? String(whatsappData.curtailmentReason).trim() : null,
            weatherCondition: whatsappData.weatherCondition ? String(whatsappData.weatherCondition).trim() : null,
            inverterAvailability: whatsappData.inverterAvailability ? parseFloat(whatsappData.inverterAvailability) : null,
            remarks: whatsappData.remarks ? String(whatsappData.remarks).trim() : null,
            status: String(whatsappData.status || 'Pending Review').trim()
          };

          // Additional validation: expectedTrend must be one of the allowed values
          const allowedTrends = ['Increasing', 'Stable', 'Decreasing'];
          if (!allowedTrends.includes(transformedData.expectedTrend)) {
            throw new ApiError(
              `expectedTrend must be one of: ${allowedTrends.join(', ')}`,
              422,
              { field: 'expectedTrend', value: transformedData.expectedTrend }
            );
          }

          console.log('Sending WhatsApp data to backend:', transformedData);
          const response = await fetchWithError(`${API_BASE_URL}/whatsapp-data`, {
            method: 'POST',
            body: JSON.stringify(transformedData)
          });
          return response;
        } catch (error) {
          console.warn('Backend API failed, using mock data:', error);
          // Re-throw 422 errors to be handled by caller
          if (error.status === 422) {
            throw error;
          }
          // For other errors, fall through to mock data
        }
      }
      
      await delay(MOCK_DELAY);
      return {
        id: Date.now(),
        ...whatsappData,
        createdAt: new Date().toISOString()
      };
    },

    update: async (id, whatsappData) => {
      if (USE_REAL_API) {
        try {
          const response = await fetchWithError(`${API_BASE_URL}/whatsapp-data/${id}`, {
            method: 'PUT',
            body: JSON.stringify(whatsappData)
          });
          return response;
        } catch (error) {
          console.warn('Backend API failed, using mock data:', error);
        }
      }
      
      await delay(MOCK_DELAY);
      return { id, ...whatsappData };
    },

    delete: async (id) => {
      if (USE_REAL_API) {
        try {
          await fetchWithError(`${API_BASE_URL}/whatsapp-data/${id}`, {
            method: 'DELETE'
          });
          return { success: true };
        } catch (error) {
          console.warn('Backend API failed, using mock data:', error);
        }
      }
      
      await delay(MOCK_DELAY);
      return { success: true };
    }
  },

  // Meter Data APIs (No upload needed - data comes from backend/FTP)
  meterData: {
    getAll: async (filters = {}) => {
      if (USE_REAL_API) {
        try {
          const params = new URLSearchParams();
          if (filters.plantId) params.append('plant_id', filters.plantId);
          if (filters.dataDate) params.append('data_date', filters.dataDate);
          
          const response = await fetchWithError(`${API_BASE_URL}/meter-data?${params}`);
          return { data: Array.isArray(response.data) ? response.data : [], total: response.total || 0 };
        } catch (error) {
          console.warn('Backend API failed, using mock data:', error);
        }
      }
      
      await delay(MOCK_DELAY);
      return { data: [], total: 0 };
    },

    // Get latest meter data for a plant (from backend/FTP connection)
    getLatest: async (plantId, date) => {
      if (USE_REAL_API) {
        try {
          const params = new URLSearchParams();
          if (date) params.append('date', date);
          
          // Fixed: Added /latest to the endpoint URL
          const response = await fetchWithError(`${API_BASE_URL}/meter-data/plant/${plantId}/latest?${params}`);
          return response;
        } catch (error) {
          console.warn('Backend API failed, using mock data:', error);
        }
      }
      
      await delay(MOCK_DELAY);
      // Get plant info to determine if solar or wind
      const plantResponse = await mockApi.plants.getAll({});
      const plant = plantResponse.plants.find(p => p.id === plantId);
      const isSolar = plant?.type === 'Solar';
      
      return generateMockMeterData(date || new Date().toISOString().split('T')[0], isSolar);
    },

    // Get meter data as 96 time blocks for charting
    getDataPoints: async (plantId, date) => {
      if (USE_REAL_API) {
        try {
          // Use the /data endpoint for getting data points (96 blocks) - this is the correct endpoint
          const response = await fetchWithError(`${API_BASE_URL}/meter-data/plant/${plantId}/data?date=${date}`);
          return response;
        } catch (error) {
          console.warn('Backend API failed, using mock data:', error);
        }
      }

      await delay(MOCK_DELAY);
      // Get plant info to determine if solar or wind
      const plantResponse = await mockApi.plants.getAll({});
      const plant = plantResponse.plants.find(p => p.id === plantId);
      const isSolar = plant?.type === 'Solar';

      const meterData = generateMockMeterData(date || new Date().toISOString().split('T')[0], isSolar);
      return meterData;
    },

    // No CSV upload needed - data comes from backend FTP connection
    uploadCSV: async (file, plantId, plantName, dataDate) => {
      // This function is kept for backward compatibility but not used
      // Data is automatically fetched from backend/FTP
      console.warn('Meter data upload is deprecated - data comes from backend FTP connection');
      return {
        message: 'Meter data is automatically fetched from backend',
        note: 'No manual upload needed'
      };
    }
  }
};

// Helper function to generate mock forecast data (96 time blocks)
function generateMockForecastData(date, isSolar = false) {
  const dataPoints = [];
  
  for (let i = 0; i < 96; i++) {
    const hour = Math.floor(i / 4);
    const minute = (i % 4) * 15;
    const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
    
    let forecast, actual;
    
    if (isSolar) {
      // Solar: Peak at noon, zero at night (6 AM to 6 PM)
      if (hour >= 6 && hour <= 18) {
        const solarProgress = (hour - 6 + minute / 60) / 12;
        forecast = Math.sin(solarProgress * Math.PI) * 85 + Math.random() * 5;
        actual = forecast + (Math.random() * 10 - 5);
      } else {
        forecast = 0;
        actual = 0;
      }
    } else {
      // Wind: More generation at night, less during day
      const windBase = 45 + Math.sin((i / 96) * Math.PI * 2 - Math.PI / 2) * 20;
      forecast = windBase + Math.random() * 8;
      actual = forecast + (Math.random() * 12 - 6);
    }
    
    dataPoints.push({
      time: timeStr,
      hour,
      minute,
      forecast: Math.max(0, forecast.toFixed(2)),
      actual: Math.max(0, actual.toFixed(2)),
      scheduled: (parseFloat(forecast) - 1 + Math.random() * 2).toFixed(2)
    });
  }
  
  return {
    date,
    dataPoints,
    totalForecast: dataPoints.reduce((sum, d) => sum + parseFloat(d.forecast), 0).toFixed(1),
    totalActual: dataPoints.reduce((sum, d) => sum + parseFloat(d.actual), 0).toFixed(1),
    avgForecast: (dataPoints.reduce((sum, d) => sum + parseFloat(d.forecast), 0) / dataPoints.filter(d => parseFloat(d.forecast) > 0).length).toFixed(2),
    avgActual: (dataPoints.reduce((sum, d) => sum + parseFloat(d.actual), 0) / dataPoints.filter(d => parseFloat(d.actual) > 0).length).toFixed(2),
    peakForecast: Math.max(...dataPoints.map(d => parseFloat(d.forecast))).toFixed(2),
    peakActual: Math.max(...dataPoints.map(d => parseFloat(d.actual))).toFixed(2)
  };
}

// Helper function to generate mock meter data (96 time blocks)
function generateMockMeterData(date, isSolar = false) {
  const dataPoints = [];
  
  for (let i = 0; i < 96; i++) {
    const hour = Math.floor(i / 4);
    const minute = (i % 4) * 15;
    const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
    
    let generation;
    
    if (isSolar) {
      // Solar: Peak at noon, zero at night
      if (hour >= 6 && hour <= 18) {
        const solarProgress = (hour - 6 + minute / 60) / 12;
        generation = Math.sin(solarProgress * Math.PI) * 82 + Math.random() * 8;
      } else {
        generation = 0;
      }
    } else {
      // Wind: Variable throughout day
      const windBase = 48 + Math.sin((i / 96) * Math.PI * 2 - Math.PI / 2) * 22;
      generation = windBase + Math.random() * 10;
    }
    
    dataPoints.push({
      time: timeStr,
      hour,
      minute,
      generation: Math.max(0, generation.toFixed(2)),
      availableCapacity: isSolar ? 90 : 95,
      availability: (90 + Math.random() * 10).toFixed(1)
    });
  }
  
  return {
    date,
    dataPoints,
    totalGeneration: dataPoints.reduce((sum, d) => sum + parseFloat(d.generation), 0).toFixed(1),
    avgGeneration: (dataPoints.reduce((sum, d) => sum + parseFloat(d.generation), 0) / dataPoints.filter(d => parseFloat(d.generation) > 0).length).toFixed(2),
    peakGeneration: Math.max(...dataPoints.map(d => parseFloat(d.generation))).toFixed(2),
    lastReading: new Date().toISOString(),
    source: 'SCADA',
    status: 'Live'
  };
}

// Helper function to generate deviations based on period
function generateDeviationResponse(deviations, period) {
  if (deviations.length === 0) {
    return generateMockDeviationsByPeriod(period, 24);
  }

  const transformed = deviations.map(d => ({
    time: d.time || d.hour !== undefined ? `${String(d.hour || 0).padStart(2, '0')}:00` : '00:00',
    hour: d.hour,
    date: d.date || null,
    dayOfWeek: d.dayOfWeek || null,
    week: d.week || null,
    plant: d.plant || 'Plant',
    plantType: d.plantType || (Math.random() > 0.5 ? 'Wind' : 'Solar'),
    scheduled: d.scheduled || d.forecasted || 0,
    actual: d.actual || 0,
    deviation: d.deviation || (d.actual || 0) - (d.scheduled || d.forecasted || 0),
    percentage: d.percentage || (d.scheduled || d.forecasted) ? (((d.actual || 0) - (d.scheduled || d.forecasted || 0)) / (d.scheduled || d.forecasted || 1) * 100).toFixed(1) : '0.0',
    type: d.type || (Math.random() > 0.5 ? 'Wind' : 'Solar')
  }));

  const totalDeviation = transformed.reduce((sum, d) => sum + Math.abs(parseFloat(d.deviation) || 0), 0);
  const avgPercentage = transformed.length > 0
    ? (transformed.reduce((sum, d) => sum + Math.abs(parseFloat(d.percentage) || 0), 0) / transformed.length).toFixed(2)
    : '0.00';
  const highDeviations = transformed.filter(d => Math.abs(parseFloat(d.percentage) || 0) > 10).length;

  return {
    deviations: transformed,
    period: period,
    summary: {
      totalDeviation: totalDeviation.toFixed(2),
      avgPercentage: parseFloat(avgPercentage),
      highDeviations: highDeviations,
      maxDeviation: Math.max(...transformed.map(d => parseFloat(d.percentage) || 0)).toFixed(1),
      minDeviation: Math.min(...transformed.map(d => parseFloat(d.percentage) || 0)).toFixed(1)
    }
  };
}

// Generate mock deviations by period
function generateMockDeviationsByPeriod(period, limit = 24) {
  const deviations = [];
  const now = new Date();
  const plants = [
    { name: 'Wind Farm A', type: 'Wind' },
    { name: 'Solar Plant B', type: 'Solar' },
    { name: 'Wind Farm C', type: 'Wind' },
    { name: 'Solar Plant D', type: 'Solar' },
    { name: 'Wind Farm E', type: 'Wind' },
    { name: 'Solar Plant F', type: 'Solar' }
  ];

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  if (period === 'hourly') {
    // Generate 24 hourly data points for today
    for (let hour = 0; hour < Math.min(limit, 24); hour++) {
      const plant = plants[hour % plants.length];
      const scheduled = 40 + Math.random() * 30;
      const deviationPercent = (Math.random() * 20 - 8); // -8% to +12%
      const actual = scheduled * (1 + deviationPercent / 100);

      deviations.push({
        time: `${hour.toString().padStart(2, '0')}:00`,
        hour: hour,
        date: now.toISOString().split('T')[0],
        plant: plant.name,
        plantType: plant.type,
        scheduled: parseFloat(scheduled.toFixed(1)),
        actual: parseFloat(actual.toFixed(1)),
        deviation: parseFloat((actual - scheduled).toFixed(1)),
        percentage: deviationPercent.toFixed(1),
        type: plant.type
      });
    }
  } else if (period === 'daily') {
    // Generate daily data points for last N days
    const days = Math.min(limit, 30);
    for (let i = 0; i < days; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() - (days - 1 - i));
      const plant = plants[i % plants.length];
      const scheduled = 800 + Math.random() * 400;
      const deviationPercent = (Math.random() * 15 - 5); // -5% to +10%
      const actual = scheduled * (1 + deviationPercent / 100);

      deviations.push({
        time: dayNames[date.getDay()],
        date: date.toISOString().split('T')[0],
        dayOfWeek: dayNames[date.getDay()],
        plant: plant.name,
        plantType: plant.type,
        scheduled: parseFloat(scheduled.toFixed(1)),
        actual: parseFloat(actual.toFixed(1)),
        deviation: parseFloat((actual - scheduled).toFixed(1)),
        percentage: deviationPercent.toFixed(1),
        type: plant.type
      });
    }
  } else if (period === 'weekly') {
    // Generate weekly data points for last N weeks
    const weeks = Math.min(limit, 12);
    for (let i = 0; i < weeks; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() - (weeks - 1 - i) * 7);
      const plant = plants[i % plants.length];
      const scheduled = 5000 + Math.random() * 2000;
      const deviationPercent = (Math.random() * 12 - 4); // -4% to +8%
      const actual = scheduled * (1 + deviationPercent / 100);
      const weekNum = getWeekNumber(date);

      deviations.push({
        time: `W${weekNum}`,
        week: weekNum,
        date: date.toISOString().split('T')[0],
        plant: plant.name,
        plantType: plant.type,
        scheduled: parseFloat(scheduled.toFixed(1)),
        actual: parseFloat(actual.toFixed(1)),
        deviation: parseFloat((actual - scheduled).toFixed(1)),
        percentage: deviationPercent.toFixed(1),
        type: plant.type
      });
    }
  }

  const totalDeviation = deviations.reduce((sum, d) => sum + Math.abs(d.deviation), 0);
  const avgPercentage = deviations.length > 0
    ? (deviations.reduce((sum, d) => sum + Math.abs(parseFloat(d.percentage)), 0) / deviations.length).toFixed(2)
    : '0.00';
  const highDeviations = deviations.filter(d => Math.abs(parseFloat(d.percentage)) > 10).length;

  return {
    deviations,
    period,
    summary: {
      totalDeviation: totalDeviation.toFixed(2),
      avgPercentage: parseFloat(avgPercentage),
      highDeviations: highDeviations,
      maxDeviation: Math.max(...deviations.map(d => parseFloat(d.percentage))).toFixed(1),
      minDeviation: Math.min(...deviations.map(d => parseFloat(d.percentage))).toFixed(1)
    }
  };
}

// Helper function to get week number
function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

// Generate mock block data (96 time blocks)
function generateMockBlockData() {
  const blockData = {};
  
  for (let i = 0; i < 96; i++) {
    const hour = Math.floor(i / 4);
    const minute = (i % 4) * 15;
    const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
    
    // Wind pattern
    const windBase = 45 + Math.sin((i / 96) * Math.PI * 2 - Math.PI / 2) * 20;
    const forecast = Math.max(0, windBase + Math.random() * 8);
    const actual = forecast + (Math.random() * 12 - 6);
    const scheduled = Math.max(0, forecast - 1 + Math.random() * 2);
    
    blockData[`block_${i + 1}`] = {
      block: i + 1,
      time: timeStr,
      forecasted: parseFloat(forecast.toFixed(2)),
      actual: parseFloat(actual.toFixed(2)),
      scheduled: parseFloat(scheduled.toFixed(2))
    };
  }
  
  return blockData;
}

// Export API methods
export const api = mockApi;


// ==================== SCHEDULE READINESS API ====================
export const scheduleReadinessApi = {
  // Get all plant readiness statuses with summary
  getAll: async (statusFilter = null) => {
    const params = new URLSearchParams();
    if (statusFilter && statusFilter !== 'All') {
      params.append('status', statusFilter);
    }
    
    if (USE_REAL_API) {
      try {
        const response = await fetchWithError(`${API_BASE_URL}/schedule-readiness?${params}`);
        return response;
      } catch (error) {
        console.warn('Backend API failed, using mock data:', error);
      }
    }
    
    await delay(MOCK_DELAY);
    return generateMockReadinessSummary();
  },

  // Get quick summary
  getSummary: async () => {
    if (USE_REAL_API) {
      try {
        const response = await fetchWithError(`${API_BASE_URL}/schedule-readiness/summary`);
        return response;
      } catch (error) {
        console.warn('Backend API failed, using mock data:', error);
      }
    }
    
    await delay(MOCK_DELAY);
    return {
      total: 6,
      ready: 1,
      pending: 2,
      no_action: 3
    };
  },

  // Get specific plant readiness
  getByPlant: async (plantId) => {
    if (USE_REAL_API) {
      try {
        const response = await fetchWithError(`${API_BASE_URL}/schedule-readiness/${plantId}`);
        return response;
      } catch (error) {
        console.warn('Backend API failed, using mock data:', error);
      }
    }
    
    await delay(MOCK_DELAY);
    return generateMockPlantReadiness(plantId);
  },

  // Trigger manual revision
  triggerRevision: async (plantId, reason) => {
    if (USE_REAL_API) {
      try {
        const response = await fetchWithError(
          `${API_BASE_URL}/schedule-readiness/${plantId}/trigger?reason=${encodeURIComponent(reason)}`,
          { method: 'POST' }
        );
        return response;
      } catch (error) {
        console.warn('Backend API failed, using mock data:', error);
      }
    }
    
    await delay(MOCK_DELAY);
    return {
      success: true,
      message: `Schedule revision triggered for Plant ${plantId}`,
      plant_id: plantId,
      status: 'PENDING',
      trigger_reason: reason
    };
  },

  // Continue existing schedule
  continueExisting: async (plantId) => {
    if (USE_REAL_API) {
      try {
        const response = await fetchWithError(
          `${API_BASE_URL}/schedule-readiness/${plantId}/continue`,
          { method: 'POST' }
        );
        return response;
      } catch (error) {
        console.warn('Backend API failed, using mock data:', error);
      }
    }
    
    await delay(MOCK_DELAY);
    return {
      success: true,
      message: `Continuing existing schedule`,
      plant_id: plantId,
      status: 'NO_ACTION'
    };
  },

  // Mark schedule as ready
  markReady: async (plantId, uploadDeadline = null) => {
    const params = new URLSearchParams();
    if (uploadDeadline) {
      params.append('upload_deadline', uploadDeadline);
    }
    
    if (USE_REAL_API) {
      try {
        const response = await fetchWithError(
          `${API_BASE_URL}/schedule-readiness/${plantId}/mark-ready?${params}`,
          { method: 'POST' }
        );
        return response;
      } catch (error) {
        console.warn('Backend API failed, using mock data:', error);
      }
    }
    
    await delay(MOCK_DELAY);
    return {
      success: true,
      message: `Schedule marked as ready`,
      plant_id: plantId,
      status: 'READY',
      upload_deadline: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString()
    };
  },

  // Check triggers for all plants
  checkTriggers: async () => {
    if (USE_REAL_API) {
      try {
        const response = await fetchWithError(
          `${API_BASE_URL}/schedule-readiness/check-triggers`,
          { method: 'POST' }
        );
        return response;
      } catch (error) {
        console.warn('Backend API failed, using mock data:', error);
      }
    }
    
    await delay(MOCK_DELAY * 2);
    return {
      success: true,
      message: 'Trigger check completed',
      plants_checked: 6,
      ready_count: 1,
      pending_count: 2,
      no_action_count: 3
    };
  },

  // Get notifications
  getNotifications: async (unreadOnly = false, plantId = null, limit = 50) => {
    const params = new URLSearchParams();
    params.append('unread_only', unreadOnly);
    params.append('limit', limit);
    if (plantId) {
      params.append('plant_id', plantId);
    }
    
    if (USE_REAL_API) {
      try {
        const response = await fetchWithError(`${API_BASE_URL}/schedule-readiness/notifications?${params}`);
        return response;
      } catch (error) {
        console.warn('Backend API failed, using mock data:', error);
      }
    }
    
    await delay(MOCK_DELAY);
    return generateMockNotifications();
  },

  // Mark notification as read
  markNotificationRead: async (notificationId) => {
    if (USE_REAL_API) {
      try {
        const response = await fetchWithError(
          `${API_BASE_URL}/schedule-readiness/notifications/${notificationId}/read`,
          { method: 'PUT' }
        );
        return response;
      } catch (error) {
        console.warn('Backend API failed:', error);
      }
    }
    
    await delay(MOCK_DELAY);
    return {
      success: true,
      message: 'Notification marked as read',
      notification_id: notificationId
    };
  },

  // Get triggers
  getTriggers: async (plantId = null, triggerType = null, processed = null, limit = 50) => {
    const params = new URLSearchParams();
    params.append('limit', limit);
    if (plantId) params.append('plant_id', plantId);
    if (triggerType) params.append('trigger_type', triggerType);
    if (processed !== null) params.append('processed', processed);
    
    if (USE_REAL_API) {
      try {
        const response = await fetchWithError(`${API_BASE_URL}/schedule-readiness/triggers?${params}`);
        return response;
      } catch (error) {
        console.warn('Backend API failed, using mock data:', error);
      }
    }
    
    await delay(MOCK_DELAY);
    return { triggers: [], total: 0 };
  }
};


// Helper function to generate mock readiness summary
function generateMockReadinessSummary() {
  const plants = getMockPlants();
  return {
    total_plants: plants.length,
    ready_count: plants.filter(p => p.readiness?.status === 'READY').length,
    pending_count: plants.filter(p => p.readiness?.status === 'PENDING').length,
    no_action_count: plants.filter(p => p.readiness?.status === 'NO_ACTION').length,
    plants: plants.map(p => ({
      id: p.id,
      plant_id: p.id,
      plant_name: p.name,
      status: p.readiness?.status || 'NO_ACTION',
      last_checked: new Date().toISOString(),
      trigger_reason: p.readiness?.trigger_reason || null,
      upload_deadline: p.readiness?.status === 'READY' ? new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString() : null,
      revision_number: p.readiness?.revision_number || 0,
      schedule_date: new Date().toISOString().split('T')[0]
    }))
  };
}


// Helper function to generate mock plant readiness
function generateMockPlantReadiness(plantId) {
  const statuses = ['READY', 'PENDING', 'NO_ACTION'];
  const status = statuses[plantId % 3];
  
  return {
    id: plantId,
    plant_id: plantId,
    plant_name: `Plant ${plantId}`,
    status: status,
    last_checked: new Date().toISOString(),
    trigger_reason: status === 'PENDING' ? 'Weather, Deviation' : null,
    upload_deadline: status === 'READY' ? new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString() : null,
    revision_number: status === 'READY' ? 2 : 0,
    schedule_date: new Date().toISOString().split('T')[0]
  };
}


// Helper function to generate mock notifications
function generateMockNotifications() {
  return {
    notifications: [
      {
        id: 1,
        plant_id: 1,
        plant_name: 'Wind Farm A',
        notification_type: 'Schedule Ready',
        title: 'Schedule Ready for Upload',
        message: 'Updated schedule for Wind Farm A is ready for upload. Deadline: 4 hours',
        priority: 'URGENT',
        read: false,
        action_required: true,
        deadline: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        created_at: new Date().toISOString()
      },
      {
        id: 2,
        plant_id: 3,
        plant_name: 'Wind Farm C',
        notification_type: 'Trigger Alert',
        title: 'Weather Change Detected',
        message: 'Weather forecast change detected for Wind Farm C. Schedule revision may be required.',
        priority: 'HIGH',
        read: false,
        action_required: true,
        deadline: null,
        created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString()
      },
      {
        id: 3,
        plant_id: 5,
        plant_name: 'Solar Plant F',
        notification_type: 'Trigger Alert',
        title: 'Meter Deviation Detected',
        message: 'Meter deviation of 12.5% detected for Solar Plant F.',
        priority: 'NORMAL',
        read: true,
        action_required: false,
        deadline: null,
        created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
      }
    ],
    total: 3,
    unread_count: 2
  };
}


// Helper function to get mock plants
function getMockPlants() {
  return [
    { id: 1, name: 'Wind Farm A', type: 'Wind', readiness: { status: 'NO_ACTION' } },
    { id: 2, name: 'Solar Plant B', type: 'Solar', readiness: { status: 'READY', revision_number: 1 } },
    { id: 3, name: 'Wind Farm C', type: 'Wind', readiness: { status: 'PENDING', trigger_reason: 'Weather' } },
    { id: 4, name: 'Solar Plant D', type: 'Solar', readiness: { status: 'NO_ACTION' } },
    { id: 5, name: 'Wind Farm E', type: 'Wind', readiness: { status: 'PENDING', trigger_reason: 'Deviation' } },
    { id: 6, name: 'Solar Plant F', type: 'Solar', readiness: { status: 'NO_ACTION' } }
  ];
}
