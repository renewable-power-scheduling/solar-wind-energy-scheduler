const TELANGANA_STATION_SCHEDULE_PLANTS = new Set([
  'KASIPET',
  'KOTHAGUDEM',
  'BHUPALPALLY',
]);

export function getTemplateScheduledMwPreferredColumns(plantCode) {
  const code = String(plantCode || '').trim().toUpperCase();

  // Mapping rules (per ops requirement):
  // - SIRMOUR: Frozen CSV "Scheduled MW" should mirror the SLDC template "Forecast" column.
  // - Telangana plants (Kasipet/Kothagudem/Bhupalpally): Frozen CSV "Scheduled MW" should mirror
  //   the SLDC template "Station Schedule" column.
  if (code === 'SIRMOUR') {
    return [
      'Forecast(MW)',
      'Forecast',
      'Scheduled MW',
      'Station Schedule',
      'Schedule',
    ];
  }

  if (TELANGANA_STATION_SCHEDULE_PLANTS.has(code)) {
    return [
      'Station Schedule',
      'Station Schedule(MW)',
      'Station Schedule (MW)',
      'Scheduled MW',
      'Schedule',
      'Forecast(MW)',
      'Forecast',
    ];
  }

  // Default: most templates treat "Station Schedule" as the authoritative scheduled MW.
  return [
    'Station Schedule',
    'Scheduled MW',
    'Schedule',
    'Forecast(MW)',
    'Forecast',
  ];
}

export const ScheduleColumnPreferences = {
  getTemplateScheduledMwPreferredColumns,
};

