import { useMemo } from "react";
import { generateTimeSlots } from "../data/timeUtils";

export default function ScheduleTable({ selectedAsset, isDarkMode }) {
  const slots = generateTimeSlots();

  // Generate consistent data based on selected asset
  const tableData = useMemo(() => {
    const baseValue = selectedAsset?.capacity * 0.6 || 50;
    const seed = selectedAsset?.id?.charCodeAt(0) || 0;
    
    // Simple seeded random function for consistency
    const seededRandom = (seed) => {
      const x = Math.sin(seed) * 10000;
      return x - Math.floor(x);
    };
    
    let randomSeed = seed;
    return slots.map((time, i) => {
      randomSeed += i;
      const forecast = Math.floor(baseValue + Math.sin((i + seed) * 0.1) * baseValue * 0.3 + seededRandom(randomSeed) * 10);
      randomSeed += 100;
      const actual = Math.floor(baseValue + Math.sin((i + seed + 20) * 0.1) * baseValue * 0.3 + seededRandom(randomSeed) * 10);
      const deviation = actual - forecast;
      return { time, forecast, actual, deviation };
    });
  }, [selectedAsset, slots]);

  return (
    <div className={`rounded-xl border p-6 shadow-2xl backdrop-blur-sm transition-colors duration-300 ${
      isDarkMode 
        ? "bg-gradient-to-br from-[#0f1629] to-[#131b34] border-gray-800/50" 
        : "bg-white border-gray-200"
    }`}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className={`text-lg font-bold mb-1 ${
            isDarkMode ? "text-white" : "text-gray-900"
          }`}>
            Schedule Table
          </h2>
          <p className={`text-xs ${
            isDarkMode ? "text-gray-400" : "text-gray-500"
          }`}>
            96 × 15-minute blocks
          </p>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-indigo-500"></div>
            <span className={isDarkMode ? "text-gray-400" : "text-gray-600"}>Forecast</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-green-500"></div>
            <span className={isDarkMode ? "text-gray-400" : "text-gray-600"}>Actual</span>
          </div>
        </div>
      </div>

      <div className={`max-h-96 overflow-y-auto rounded-lg border custom-scrollbar ${
        isDarkMode 
          ? "border-gray-800/50 bg-[#0a0f1a]/50" 
          : "border-gray-200 bg-gray-50"
      }`}>
        <table className="w-full text-sm">
          <thead className={`sticky top-0 border-b z-10 ${
            isDarkMode 
              ? "bg-gradient-to-b from-[#131b34] to-[#0f1629] border-gray-800" 
              : "bg-gradient-to-b from-gray-100 to-white border-gray-200"
          }`}>
            <tr>
              <th className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider ${
                isDarkMode ? "text-gray-400" : "text-gray-600"
              }`}>
                Time
              </th>
              <th className={`px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider ${
                isDarkMode ? "text-gray-400" : "text-gray-600"
              }`}>
                Forecast (MW)
              </th>
              <th className={`px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider ${
                isDarkMode ? "text-gray-400" : "text-gray-600"
              }`}>
                Actual (MW)
              </th>
              <th className={`px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider ${
                isDarkMode ? "text-gray-400" : "text-gray-600"
              }`}>
                Deviation
              </th>
            </tr>
          </thead>

          <tbody className={`divide-y ${
            isDarkMode ? "divide-gray-800/50" : "divide-gray-200"
          }`}>
            {tableData.map((row, i) => (
              <tr 
                key={i} 
                className={`transition-colors duration-150 border-b ${
                  isDarkMode 
                    ? "hover:bg-indigo-500/10 border-gray-800/30" 
                    : "hover:bg-indigo-50 border-gray-200"
                }`}
              >
                <td className={`px-4 py-3 font-mono text-xs ${
                  isDarkMode ? "text-gray-300" : "text-gray-700"
                }`}>
                  {row.time}
                </td>
                <td className="px-4 py-3 text-right text-indigo-400 font-medium">{row.forecast}</td>
                <td className="px-4 py-3 text-right text-green-400 font-medium">{row.actual}</td>
                <td
                  className={`px-4 py-3 text-right font-semibold ${
                    row.deviation >= 0 
                      ? "text-green-400" 
                      : "text-red-400"
                  }`}
                >
                  {row.deviation >= 0 ? "+" : ""}{row.deviation}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
