/**
 * Unified Mock Data Service
 * 
 * This service provides consistent dummy data for all dashboard components.
 * Use this as a fallback when API data is unavailable.
 * 
 * IMPORTANT: All data should be consistent across components to ensure
 * the same plants, schedules, and values appear throughout the application.
 */

// Seeded random number generator for consistent values
let seed = 12345;
const seededRandom = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

// Constants - these must be consistent across the entire application
export const PLANTS = [
  { id: 1, name: 'North Wind Farm', category: 'Wind', state: 'Maharashtra', capacity: 150, vendor: 'Vendor X' },
  { id: 2, name: 'Coastal Breeze Solar', category: 'Solar', state: 'Gujarat', capacity: 120, vendor: 'Vendor Y' },
  { id: 3, name: 'Mountain View Wind', category: 'Wind', state: 'Rajasthan', capacity: 95, vendor: 'Vendor X' },
  { id: 4, name: 'Sunrise Solar Farm', category: 'Solar', state: 'Tamil Nadu', capacity: 80, vendor: 'Vendor Z' },
  { id: 5, name: 'Prairie Wind Station', category: 'Wind', state: 'Maharashtra', capacity: 110, vendor: 'Vendor X' },
  { id: 6, name: 'Desert Gold Solar', category: 'Solar', state: 'Rajasthan', capacity: 100, vendor: 'Vendor Y' },
  { id: 7, name: 'Valley Wind Complex', category: 'Wind', state: 'Gujarat', capacity: 130, vendor: 'Vendor Z' },
  { id: 8, name: 'Green Energy Solar', category: 'Solar', state: 'Maharashtra', capacity: 90, vendor: 'Vendor X' },
  { id: 9, name: 'Highland Wind Farm', category: 'Wind', state: 'Tamil Nadu', capacity: 105, vendor: 'Vendor Y' },
  { id: 10, name: 'Crystal Solar Park', category: 'Solar', state: 'Gujarat', capacity: 85, vendor: 'Vendor Z' },
  { id: 11, name: 'Ocean Breeze Wind', category: 'Wind', state: 'Maharashtra', capacity: 140, vendor: 'Vendor X' },
  { id: 12, name: 'Golden Sun Solar', category: 'Solar', state: 'Rajasthan', capacity: 95, vendor: 'Vendor Y' },
];

export const STATES = ['Maharashtra', 'Gujarat', 'Rajasthan', 'Tamil Nadu'];

export const REPORT_TYPES = [
  { id: 'schedule', name: 'Schedule Summary' },
  { id: 'deviation', name: 'Deviation Analysis' },
  { id: 'capacity', name: 'Capacity Utilization' },
  { id: 'plant', name: 'Plant Performance' },
];

/**
 * Generate consistent schedule data for a specific plant
 */
export const generateScheduleData = (plantId, date, type = 'Day-Ahead') => {
  const plant = PLANTS.find(p => p.id === plantId) || PLANTS[0];
  const isSolar = plant.category === 'Solar';
  
  return Array.from({ length: 96 }, (_, i) => {
    const hour = Math.floor(i / 4);
    const minute = (i % 4) * 15;
    const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
    
    // Use seeded random for consistency
    const baseValue = isSolar 
      ? (hour >= 7 && hour <= 18 ? Math.sin(((hour - 7) / 11) * Math.PI) * plant.capacity * 0.7 : 0)
      : plant.capacity * 0.3 + Math.sin((i / 96) * Math.PI * 2 - Math.PI / 2) * plant.capacity * 0.2;
    
    const forecast = Math.max(0, baseValue + (seededRandom() - 0.5) * 10);
    const actual = forecast + (seededRandom() - 0.5) * 8;
    const scheduled = forecast * 0.95;
    
    return {
      time: timeStr,
      hour,
      minute,
      forecast: parseFloat(forecast.toFixed(1)),
      actual: parseFloat(actual.toFixed(1)),
      scheduled: parseFloat(scheduled.toFixed(1))
    };
  });
};

/**
 * Generate forecast data (same structure as schedule but different values)
 */
export const generateForecastData = (plantId, date) => {
  const plant = PLANTS.find(p => p.id === plantId) || PLANTS[0];
  const isSolar = plant.category === 'Solar';
  
  return {
    date,
    dataPoints: Array.from({ length: 96 }, (_, i) => {
      const hour = Math.floor(i / 4);
      const minute = (i % 4) * 15;
      const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
      
      let forecast;
      if (isSolar) {
        forecast = hour >= 6 && hour <= 18 
          ? Math.sin(((hour - 6) / 12) * Math.PI) * plant.capacity * 0.8 + seededRandom() * 5
          : 0;
      } else {
        forecast = plant.capacity * 0.35 + Math.sin((i / 96) * Math.PI * 2 - Math.PI / 2) * plant.capacity * 0.25 + seededRandom() * 8;
      }
      
      return {
        time: timeStr,
        hour,
        minute,
        forecast: parseFloat(Math.max(0, forecast).toFixed(1)),
        actual: parseFloat(Math.max(0, forecast + (seededRandom() - 0.5) * 10).toFixed(1)),
        scheduled: parseFloat(Math.max(0, forecast - 2 + seededRandom() * 4).toFixed(1))
      };
    }),
    createdAt: new Date().toISOString(),
    totalForecast: 0,
    totalActual: 0
  };
};

/**
 * Generate meter data
 */
export const generateMeterData = (plantId, date) => {
  const plant = PLANTS.find(p => p.id === plantId) || PLANTS[0];
  const isSolar = plant.category === 'Solar';
  
  return {
    date,
    dataPoints: Array.from({ length: 96 }, (_, i) => {
      const hour = Math.floor(i / 4);
      const minute = (i % 4) * 15;
      const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
      
      let generation;
      if (isSolar) {
        generation = hour >= 6 && hour <= 18 
          ? Math.sin(((hour - 6) / 12) * Math.PI) * plant.capacity * 0.75 + seededRandom() * 8
          : 0;
      } else {
        generation = plant.capacity * 0.38 + Math.sin((i / 96) * Math.PI * 2 - Math.PI / 2) * plant.capacity * 0.22 + seededRandom() * 10;
      }
      
      return {
        time: timeStr,
        hour,
        minute,
        generation: parseFloat(Math.max(0, generation).toFixed(1)),
        availableCapacity: isSolar ? 90 : 95,
        availability: parseFloat((90 + seededRandom() * 10).toFixed(1))
      };
    }),
    totalGeneration: 0,
    lastReading: new Date().toISOString(),
    source: 'SCADA',
    status: 'Live'
  };
};

/**
 * Generate deviation data for a specific period
 */
export const generateDeviationData = (period = 'hourly', limit = 24) => {
  const deviations = [];
  
  for (let i = 0; i < limit; i++) {
    const plant = PLANTS[i % PLANTS.length];
    let time;
    
    if (period === 'hourly') {
      const hour = i % 24;
      time = `${hour.toString().padStart(2, '0')}:00`;
    } else if (period === 'daily') {
      const date = new Date();
      date.setDate(date.getDate() - (limit - i));
      time = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    } else {
      time = `W${52 - limit + i + 1}`;
    }
    
    const scheduled = plant.capacity * (0.3 + seededRandom() * 0.3);
    const actual = scheduled * (0.85 + seededRandom() * 0.3);
    const deviation = actual - scheduled;
    const percentage = ((deviation / scheduled) * 100).toFixed(1);
    
    deviations.push({
      time,
      plant: plant.name,
      type: plant.category,
      scheduled: parseFloat(scheduled.toFixed(1)),
      actual: parseFloat(actual.toFixed(1)),
      deviation: parseFloat(deviation.toFixed(1)),
      percentage: parseFloat(percentage)
    });
  }
  
  const totalDeviation = deviations.reduce((sum, d) => sum + Math.abs(d.deviation), 0);
  const avgPercentage = deviations.reduce((sum, d) => sum + Math.abs(d.percentage), 0) / deviations.length;
  const highDeviations = deviations.filter(d => Math.abs(d.percentage) > 10).length;
  const maxDeviation = Math.max(...deviations.map(d => Math.abs(d.percentage)));
  const minDeviation = Math.min(...deviations.map(d => Math.abs(d.percentage)));
  
  return {
    deviations,
    period,
    summary: {
      totalDeviation: totalDeviation.toFixed(2),
      avgPercentage,
      highDeviations,
      maxDeviation: maxDeviation.toFixed(1),
      minDeviation: minDeviation.toFixed(1)
    }
  };
};

/**
 * Generate dashboard statistics
 */
export const generateDashboardStats = () => {
  // Count all 12 plants as active for consistency
  const activePlants = PLANTS.length; // All 12 plants
  
  const totalCapacity = PLANTS.reduce((sum, p) => sum + p.capacity, 0);
  
  // Calculate current generation based on all plants
  const currentGeneration = PLANTS.reduce((sum, p) => {
    const isSolar = p.category === 'Solar';
    const hour = new Date().getHours();
    
    // Solar only generates during day hours (6-18), wind generates 24/7
    let baseFactor;
    if (isSolar) {
      baseFactor = hour >= 6 && hour <= 18 ? 0.6 + Math.sin(((hour - 6) / 12) * Math.PI) * 0.3 : 0;
    } else {
      baseFactor = 0.4 + Math.sin((hour / 24) * Math.PI * 2 - Math.PI / 2) * 0.3;
    }
    
    return sum + (p.capacity * baseFactor);
  }, 0);
  
  const efficiency = (currentGeneration / totalCapacity) * 100;
  
  // Schedule counts - generate schedules for all plants
  const schedules = PLANTS.slice(0, 12).map((p, index) => ({
    plant: p.name,
    category: p.category,
    type: ['Day-Ahead', 'Intraday', 'Real-Time'][index % 3],
    status: ['Completed', 'Pending', 'Draft'][index % 3],
    changes: Math.floor(seededRandom() * 20)
  }));
  
  const pending = schedules.filter(s => s.status === 'Pending').length;
  const approved = schedules.filter(s => s.status === 'Completed').length;
  
  return {
    activePlants,
    totalCapacity: totalCapacity.toFixed(0),
    currentGeneration: currentGeneration.toFixed(1),
    efficiency: efficiency.toFixed(1),
    schedules: {
      total: schedules.length,
      pending,
      approved,
      revised: Math.floor(seededRandom() * 5)
    }
  };
};

/**
 * Generate dashboard schedule list (consistent with ALL_SCHEDULES in Dashboard.jsx)
 */
export const generateDashboardSchedules = () => {
  return PLANTS.slice(0, 10).map((plant, index) => ({
    id: plant.id,
    plant: plant.name,
    category: plant.category,
    type: ['Day-Ahead', 'Intraday', 'Real-Time'][index % 3],
    status: ['Completed', 'Pending', 'Draft'][index % 3],
    changes: Math.floor(seededRandom() * 20),
    time: ['08:30 AM', '09:15 AM', '10:00 AM', '10:45 AM', '11:30 AM', '12:15 PM', '01:00 PM', '02:30 PM', '03:45 PM', '04:20 PM'][index],
    icon: plant.category === 'Wind' ? 'Wind' : 'Sun'
  }));
};

/**
 * Generate weather data for all plants
 */
export const generateWeatherData = () => {
  return PLANTS.map(plant => {
    const random = seededRandom();
    if (plant.category === 'Wind') {
      return {
        name: plant.name,
        state: plant.state,
        windSpeed: parseFloat((8 + random * 10).toFixed(1)),
        direction: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.floor(random * 8)],
        temperature: parseFloat((22 + random * 15).toFixed(0)),
        status: random > 0.7 ? 'Excellent' : random > 0.4 ? 'Optimal' : 'Good'
      };
    } else {
      return {
        name: plant.name,
        state: plant.state,
        cloudCover: parseFloat((random * 50).toFixed(0)),
        irradiance: parseFloat((600 + random * 400).toFixed(0)),
        temperature: parseFloat((25 + random * 12).toFixed(0)),
        status: random > 0.7 ? 'Optimal' : random > 0.4 ? 'Good' : 'Fair'
      };
    }
  });
};

/**
 * Generate report data
 */
export const generateReportData = (reportType, dateFrom, dateTo) => {
  return {
    reportType,
    dateFrom,
    dateTo,
    generatedAt: new Date().toISOString(),
    plants: PLANTS.map(plant => ({
      name: plant.name,
      capacity: plant.capacity,
      generation: parseFloat((plant.capacity * (0.6 + seededRandom() * 0.3)).toFixed(1)),
      efficiency: parseFloat((60 + seededRandom() * 35).toFixed(1))
    })),
    summary: {
      totalPlants: PLANTS.length,
      totalCapacity: PLANTS.reduce((sum, p) => sum + p.capacity, 0),
      avgEfficiency: parseFloat((70 + seededRandom() * 20).toFixed(1)),
      totalGeneration: parseFloat(PLANTS.reduce((sum, p) => sum + p.capacity * (0.6 + seededRandom() * 0.3), 0).toFixed(1))
    }
  };
};

/**
 * Generate template data
 */
export const generateTemplateData = () => {
  return PLANTS.map((plant, index) => ({
    id: plant.id,
    name: plant.name,
    category: plant.category,
    vendor: ['Vendor X', 'Vendor Y', 'Vendor Z'][index % 3],
    template: `v${Math.floor(2 + seededRandom() * 2)}.${Math.floor(seededRandom() * 5)}`,
    updated: new Date(Date.now() - Math.floor(seededRandom() * 30 * 24 * 60 * 60 * 1000)).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  }));
};

/**
 * Generate WhatsApp data for a plant
 */
export const generateWhatsAppData = (plantId) => {
  const plant = PLANTS.find(p => p.id === plantId) || PLANTS[0];
  
  return {
    data: Array.from({ length: 5 }, (_, i) => ({
      id: plantId * 10 + i,
      plantId: plant.id,
      plantName: plant.name,
      state: plant.state,
      date: new Date(Date.now() - i * 6 * 60 * 60 * 1000).toISOString().split('T')[0],
      time: `${8 + i}:00`,
      currentGeneration: parseFloat((plant.capacity * (0.3 + seededRandom() * 0.4)).toFixed(1)),
      expectedTrend: ['Increasing', 'Stable', 'Decreasing'][Math.floor(seededRandom() * 3)],
      curtailmentStatus: seededRandom() > 0.8,
      curtailmentReason: seededRandom() > 0.8 ? ['Grid Constraint', 'Weather', 'Maintenance'][Math.floor(seededRandom() * 3)] : '',
      weatherCondition: ['Clear', 'Partly Cloudy', 'Cloudy'][Math.floor(seededRandom() * 3)],
      inverterAvailability: parseFloat((85 + seededRandom() * 15).toFixed(1)),
      remarks: '',
      status: seededRandom() > 0.5 ? 'Used' : 'Pending Review'
    }))
  };
};

export default {
  PLANTS,
  STATES,
  REPORT_TYPES,
  generateScheduleData,
  generateForecastData,
  generateMeterData,
  generateDeviationData,
  generateDashboardStats,
  generateDashboardSchedules,
  generateWeatherData,
  generateReportData,
  generateTemplateData,
  generateWhatsAppData
};

