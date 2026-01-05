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

export default function ChartPanel({ streams, selectedAsset, isDarkMode }) {
  // Generate consistent data based on selected asset
  const chartData = useMemo(() => {
    const timeLabels = generateTimeSlots();
    const baseValue = selectedAsset?.capacity * 0.6 || 50; // 60% of capacity as base
    
    // Generate data with some variation but consistent for the same asset
    // Using a seeded approach for consistency
    const seed = selectedAsset?.id?.charCodeAt(0) || 0;
    
    // Simple seeded random function
    const seededRandom = (seed) => {
      const x = Math.sin(seed) * 10000;
      return x - Math.floor(x);
    };
    
    let randomSeed = seed;
    const dayAheadData = timeLabels.map((_, i) => {
      randomSeed += i;
      return Math.floor(baseValue + Math.sin((i + seed) * 0.1) * baseValue * 0.3 + seededRandom(randomSeed) * 10);
    });
    
    randomSeed = seed + 1000;
    const intradayData = timeLabels.map((_, i) => {
      randomSeed += i;
      return Math.floor(baseValue + Math.sin((i + seed + 10) * 0.1) * baseValue * 0.3 + seededRandom(randomSeed) * 10);
    });
    
    randomSeed = seed + 2000;
    const actualData = timeLabels.map((_, i) => {
      randomSeed += i;
      return Math.floor(baseValue + Math.sin((i + seed + 20) * 0.1) * baseValue * 0.3 + seededRandom(randomSeed) * 10);
    });
    
    const capacityData = timeLabels.map(() => selectedAsset?.capacity || 100);

    return { timeLabels, dayAheadData, intradayData, actualData, capacityData };
  }, [selectedAsset]);

  const datasets = [];

  if (streams.dayAhead) {
    datasets.push({
      label: "Day-Ahead (MW)",
      data: chartData.dayAheadData,
      borderColor: "rgb(99, 102, 241)",
      backgroundColor: "rgba(99, 102, 241, 0.1)",
      borderWidth: 2.5,
      tension: 0.4,
      fill: true,
      pointRadius: 0,
      pointHoverRadius: 5,
      pointHoverBackgroundColor: "rgb(99, 102, 241)",
      pointHoverBorderColor: "#fff",
      pointHoverBorderWidth: 2,
    });
  }

  if (streams.intraday) {
    datasets.push({
      label: "Intraday (MW)",
      data: chartData.intradayData,
      borderColor: "rgb(59, 130, 246)",
      backgroundColor: "rgba(59, 130, 246, 0.1)",
      borderWidth: 2.5,
      tension: 0.4,
      fill: true,
      pointRadius: 0,
      pointHoverRadius: 5,
      pointHoverBackgroundColor: "rgb(59, 130, 246)",
      pointHoverBorderColor: "#fff",
      pointHoverBorderWidth: 2,
    });
  }

  if (streams.actual) {
    datasets.push({
      label: "Actual (MW)",
      data: chartData.actualData,
      borderColor: "rgb(34, 197, 94)",
      backgroundColor: "rgba(34, 197, 94, 0.1)",
      borderWidth: 2.5,
      tension: 0.4,
      fill: true,
      pointRadius: 0,
      pointHoverRadius: 5,
      pointHoverBackgroundColor: "rgb(34, 197, 94)",
      pointHoverBorderColor: "#fff",
      pointHoverBorderWidth: 2,
    });
  }

  if (streams.capacity) {
    datasets.push({
      label: "Capacity Limit (MW)",
      data: chartData.capacityData,
      borderColor: "rgb(234, 179, 8)",
      backgroundColor: "rgba(234, 179, 8, 0.05)",
      borderWidth: 2,
      borderDash: [5, 5],
      tension: 0,
      fill: false,
      pointRadius: 0,
      pointHoverRadius: 5,
      pointHoverBackgroundColor: "rgb(234, 179, 8)",
      pointHoverBorderColor: "#fff",
      pointHoverBorderWidth: 2,
    });
  }

  const data = {
    labels: chartData.timeLabels,
    datasets: datasets,
  };

  const options = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: true,
        position: "top",
        labels: {
          color: isDarkMode ? "#e5e7eb" : "#374151",
          font: {
            size: 12,
            weight: "500",
          },
          padding: 15,
          usePointStyle: true,
          pointStyle: "line",
        },
      },
      tooltip: {
        backgroundColor: isDarkMode ? "rgba(15, 23, 42, 0.95)" : "rgba(255, 255, 255, 0.95)",
        titleColor: isDarkMode ? "#e5e7eb" : "#111827",
        bodyColor: isDarkMode ? "#e5e7eb" : "#111827",
        borderColor: "rgba(99, 102, 241, 0.5)",
        borderWidth: 1,
        padding: 12,
        displayColors: true,
        callbacks: {
          label: function(context) {
            return `${context.dataset.label}: ${context.parsed.y} MW`;
          },
        },
      },
    },
    scales: {
      x: {
        grid: {
          color: isDarkMode ? "rgba(55, 65, 81, 0.3)" : "rgba(229, 231, 235, 0.5)",
          drawBorder: false,
        },
        ticks: {
          color: isDarkMode ? "#9ca3af" : "#6b7280",
          font: {
            size: 11,
          },
        },
      },
      y: {
        grid: {
          color: isDarkMode ? "rgba(55, 65, 81, 0.3)" : "rgba(229, 231, 235, 0.5)",
          drawBorder: false,
        },
        ticks: {
          color: isDarkMode ? "#9ca3af" : "#6b7280",
          font: {
            size: 11,
          },
          callback: function(value) {
            return value + " MW";
          },
        },
      },
    },
  }), [isDarkMode]);

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
            Time-Series Chart
          </h2>
          <p className={`text-xs ${
            isDarkMode ? "text-gray-400" : "text-gray-500"
          }`}>
            15-minute interval data visualization
          </p>
        </div>
        <div className="flex gap-2">
          <div className="px-3 py-1.5 bg-indigo-500/20 border border-indigo-500/30 rounded-lg">
            <span className="text-xs text-indigo-300 font-medium">Live</span>
          </div>
        </div>
      </div>
      <div className="h-80">
        <Line data={data} options={options} />
      </div>
    </div>
  );
}
