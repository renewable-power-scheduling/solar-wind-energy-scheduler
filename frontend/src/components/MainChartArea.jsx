import { useMemo } from "react";
import { Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
  Legend,
  Filler,
} from "chart.js";
import { generateTimeSlots } from "../data/timeUtils";

ChartJS.register(
  CategoryScale,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
  Legend,
  Filler
);

export default function MainChartArea({ streams, selectedAsset, isDarkMode }) {
  // Generate consistent data based on selected asset
  const chartData = useMemo(() => {
    const timeLabels = generateTimeSlots();
    const baseValue = selectedAsset?.capacity * 0.6 || 50;
    const seed = selectedAsset?.id?.charCodeAt(0) || 0;
    
    const seededRandom = (seed) => {
      const x = Math.sin(seed) * 10000;
      return x - Math.floor(x);
    };
    
    let randomSeed = seed;
    const intradayData = timeLabels.map((_, i) => {
      randomSeed += i;
      return Math.floor(baseValue + Math.sin((i + seed + 10) * 0.1) * baseValue * 0.3 + seededRandom(randomSeed) * 10);
    });
    
    randomSeed = seed + 2000;
    const actualData = timeLabels.map((_, i) => {
      randomSeed += i;
      return Math.floor(baseValue + Math.sin((i + seed + 20) * 0.1) * baseValue * 0.3 + seededRandom(randomSeed) * 10);
    });

    return { timeLabels, intradayData, actualData };
  }, [selectedAsset]);

  const mainChartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index',
      intersect: false,
    },
    plugins: {
      legend: {
        display: true,
        position: "top",
        labels: {
          color: isDarkMode ? "#e5e7eb" : "#374151",
          font: { size: 11, weight: "500" },
          padding: 10,
          usePointStyle: true,
        },
      },
      tooltip: {
        backgroundColor: isDarkMode ? "rgba(15, 23, 42, 0.95)" : "rgba(255, 255, 255, 0.95)",
        titleColor: isDarkMode ? "#e5e7eb" : "#111827",
        bodyColor: isDarkMode ? "#e5e7eb" : "#111827",
        borderColor: "rgba(99, 102, 241, 0.5)",
        borderWidth: 1,
        padding: 10,
        displayColors: true,
      },
    },
    scales: {
      x: {
        grid: {
          color: isDarkMode ? "rgba(55, 65, 81, 0.2)" : "rgba(229, 231, 235, 0.5)",
          drawBorder: false,
        },
        ticks: {
          color: isDarkMode ? "#9ca3af" : "#6b7280",
          font: { size: 10 },
          maxRotation: 45,
          minRotation: 45,
        },
      },
      y: {
        title: {
          display: true,
          text: "Power (kW)",
          color: isDarkMode ? "#9ca3af" : "#6b7280",
          font: { size: 11 },
        },
        grid: {
          color: isDarkMode ? "rgba(55, 65, 81, 0.2)" : "rgba(229, 231, 235, 0.5)",
          drawBorder: false,
        },
        ticks: {
          color: isDarkMode ? "#9ca3af" : "#6b7280",
          font: { size: 10 },
          callback: function(value) {
            return value.toLocaleString() + " kW";
          },
        },
      },
    },
  }), [isDarkMode]);

  const mainChartData = {
    labels: chartData.timeLabels,
    datasets: [
      streams.intraday && {
        label: "Sum - PV_Intraday",
        data: chartData.intradayData.map(v => v * 10), // Convert to kW
        borderColor: "rgb(249, 115, 22)",
        backgroundColor: "rgba(249, 115, 22, 0.1)",
        borderWidth: 2,
        stepped: 'after',
        pointRadius: 0,
        pointHoverRadius: 4,
      },
      streams.actual && {
        label: "Sum - Meter data (live)",
        data: chartData.actualData.map(v => v * 10), // Convert to kW
        borderColor: "rgb(59, 130, 246)",
        backgroundColor: "rgba(59, 130, 246, 0.1)",
        borderWidth: 2,
        stepped: 'after',
        pointRadius: 0,
        pointHoverRadius: 4,
      },
    ].filter(Boolean),
  };

  // Forecast Error Chart
  const errorData = useMemo(() => {
    return chartData.timeLabels.map((_, i) => {
      const error = chartData.actualData[i] - chartData.intradayData[i];
      return Math.abs(error * 10); // Convert to kW
    });
  }, [chartData]);

  const errorChartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: isDarkMode ? "rgba(15, 23, 42, 0.95)" : "rgba(255, 255, 255, 0.95)",
        titleColor: isDarkMode ? "#e5e7eb" : "#111827",
        bodyColor: isDarkMode ? "#e5e7eb" : "#111827",
      },
    },
    scales: {
      x: {
        grid: {
          color: isDarkMode ? "rgba(55, 65, 81, 0.2)" : "rgba(229, 231, 235, 0.5)",
          drawBorder: false,
        },
        ticks: {
          color: isDarkMode ? "#9ca3af" : "#6b7280",
          font: { size: 10 },
        },
      },
      y: {
        title: {
          display: true,
          text: "Power (kW)",
          color: isDarkMode ? "#9ca3af" : "#6b7280",
          font: { size: 11 },
        },
        grid: {
          color: isDarkMode ? "rgba(55, 65, 81, 0.2)" : "rgba(229, 231, 235, 0.5)",
          drawBorder: false,
        },
        ticks: {
          color: isDarkMode ? "#9ca3af" : "#6b7280",
          font: { size: 10 },
        },
      },
    },
  }), [isDarkMode]);

  const errorChartData = {
    labels: chartData.timeLabels,
    datasets: [{
      label: "Forecast Error",
      data: errorData,
      borderColor: "rgb(34, 197, 94)",
      backgroundColor: "rgba(34, 197, 94, 0.1)",
      borderWidth: 1.5,
      fill: true,
      pointRadius: 0,
    }],
  };

  return (
    <div className="space-y-4">
      {/* Main Time-Series Chart */}
      <div className={`rounded-lg border p-4 transition-colors duration-300 ${
        isDarkMode 
          ? "bg-[#131b34] border-gray-800/50" 
          : "bg-white border-gray-200"
      }`}>
        <div className="h-80">
          <Line data={mainChartData} options={mainChartOptions} />
        </div>
      </div>

      {/* Forecast Error Chart */}
      <div className={`rounded-lg border p-4 transition-colors duration-300 ${
        isDarkMode 
          ? "bg-[#131b34] border-gray-800/50" 
          : "bg-white border-gray-200"
      }`}>
        <h3 className={`text-sm font-semibold mb-3 ${
          isDarkMode ? "text-gray-300" : "text-gray-900"
        }`}>
          Forecast Error
        </h3>
        <div className="h-48">
          <Line data={errorChartData} options={errorChartOptions} />
        </div>
      </div>

      {/* Actual Generation / Quality */}
      <div className={`rounded-lg border p-4 transition-colors duration-300 ${
        isDarkMode 
          ? "bg-[#131b34] border-gray-800/50" 
          : "bg-white border-gray-200"
      }`}>
        <div className="flex items-center justify-between mb-3">
          <h3 className={`text-sm font-semibold ${
            isDarkMode ? "text-gray-300" : "text-gray-900"
          }`}>
            Actual Generation
          </h3>
          <select className={`text-sm rounded px-3 py-1.5 border focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
            isDarkMode
              ? "bg-[#0f1629] border-gray-700 text-gray-300"
              : "bg-white border-gray-300 text-gray-900"
          }`}>
            <option>Meter data (live)</option>
            <option>Meter data (latest)</option>
            <option>Meter data (finalized)</option>
          </select>
        </div>
        <div className={`text-xs ${
          isDarkMode ? "text-gray-400" : "text-gray-500"
        }`}>
          Quality
        </div>
      </div>
    </div>
  );
}

