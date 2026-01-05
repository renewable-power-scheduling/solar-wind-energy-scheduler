import { useState, useMemo } from "react";
import Navbar from "../components/Navbar";
import Sidebar from "../components/Sidebar";
import RightSidebar from "../components/RightSidebar";
import MainChartArea from "../components/MainChartArea";
import { assets } from "../data/assetsData";
import { generateTimeSlots } from "../data/timeUtils";

export default function Dashboard() {
  const [selectedAsset, setSelectedAsset] = useState(assets[0]);
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [isDarkMode, setIsDarkMode] = useState(true);

  const [streams, setStreams] = useState({
    dayAhead: true,
    intraday: true,
    actual: true,
    capacity: false,
  });

  // Generate consistent table data for CSV export
  const tableDataForExport = useMemo(() => {
    const slots = generateTimeSlots();
    const baseValue = selectedAsset?.capacity * 0.6 || 50;
    const seed = selectedAsset?.id?.charCodeAt(0) || 0;
    
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
  }, [selectedAsset]);

  const handleExportCSV = () => {
    try {
      // Create CSV content
      let csvContent = "Time,Forecast (MW),Actual (MW),Deviation (MW)\n";
      tableDataForExport.forEach((row) => {
        csvContent += `${row.time},${row.forecast},${row.actual},${row.deviation}\n`;
      });
      
      // Create blob and download
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const link = document.createElement("a");
      const url = URL.createObjectURL(blob);
      link.setAttribute("href", url);
      const fileName = `${selectedAsset.name.replace(/\s+/g, '_')}_${selectedDate}_data.csv`;
      link.setAttribute("download", fileName);
      link.style.visibility = "hidden";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Error exporting CSV:", error);
      alert("Failed to export CSV. Please try again.");
    }
  };

  return (
    <div className={`min-h-screen transition-colors duration-300 flex flex-col ${
      isDarkMode 
        ? "bg-[#0a0f1a] text-gray-200" 
        : "bg-gray-50 text-gray-900"
    }`}>
      <Navbar 
        selectedDate={selectedDate}
        onDateChange={setSelectedDate}
        onExportCSV={handleExportCSV}
        isDarkMode={isDarkMode}
        onThemeToggle={() => setIsDarkMode(!isDarkMode)}
        selectedDateRange={`${selectedDate} to ${selectedDate} (Asia/Calcutta)`}
      />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          assets={assets}
          selectedAsset={selectedAsset}
          onSelect={setSelectedAsset}
          isDarkMode={isDarkMode}
        />

        <main className={`flex-1 p-6 transition-colors duration-300 overflow-y-auto ${
          isDarkMode 
            ? "bg-[#0a0f1a]" 
            : "bg-gray-50"
        }`}>
          <MainChartArea streams={streams} selectedAsset={selectedAsset} isDarkMode={isDarkMode} />
        </main>

        <RightSidebar
          streams={streams}
          setStreams={setStreams}
          asset={selectedAsset}
          isDarkMode={isDarkMode}
        />
      </div>
    </div>
  );
}
