export const CHART_COLORS = {
  machineSchedule: '#1d4ed8', // dark blue
  manualEditedSchedule: '#eab308', // yellow
  vedanjaySchedule: '#22c55e', // green
  intradayForecast: '#f59e0b', // orange/amber
  enercastFrozen: '#8000FF', // purple/violet
  dayAheadSchedule: '#ec4899', // pink
  allowedBand: '#9ca3af', // gray
  withinBand: '#10b981', // green
  breach: '#ef4444', // red
  weather: '#38bdf8', // sky
};

export function getActualLineColor(isDarkMode) {
  return isDarkMode ? '#ffffff' : '#0f172a';
}
