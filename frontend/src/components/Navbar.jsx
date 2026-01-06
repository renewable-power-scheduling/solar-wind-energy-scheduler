import { useState } from "react";

export default function Navbar({ selectedDate, onDateChange, onExportCSV, isDarkMode, onThemeToggle, selectedDateRange }) {
  const [activeTab, setActiveTab] = useState("WORKBENCH");
  const [showUserMenu, setShowUserMenu] = useState(false);

  return (
    <header className={`transition-colors duration-300 border-b shadow-sm ${
      isDarkMode 
        ? "bg-[#0f1629] border-gray-800/50" 
        : "bg-white border-gray-200"
    }`}>
      {/* Top Bar */}
      <div className={`px-6 py-3 flex justify-between items-center border-b ${
        isDarkMode ? "border-gray-800/50" : "border-gray-200"
      }`}>
        <div className="flex items-center gap-4">
          {/* Logo */}
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-green-500 rounded flex items-center justify-center">
              <span className="text-white font-bold text-sm">A</span>
            </div>
            <span className={`font-bold text-lg ${
              isDarkMode ? "text-white" : "text-gray-900"
            }`}>
              Automatic Scheduling System
            </span>
          </div>

          {/* Navigation Tabs */}
          <div className="flex gap-1 ml-8">
            {["WORKBENCH", "DATA", "USER MANAGEMENT"].map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-4 py-2 text-sm font-medium rounded-t transition-colors ${
                  activeTab === tab
                    ? isDarkMode
                      ? "bg-[#131b34] text-white border-t-2 border-indigo-500"
                      : "bg-gray-50 text-indigo-600 border-t-2 border-indigo-500"
                    : isDarkMode
                      ? "text-gray-400 hover:text-white hover:bg-[#131b34]/50"
                      : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-4">
          <button
            onClick={onThemeToggle}
            className={`p-2 rounded-lg transition-all duration-200 hover:scale-110 ${
              isDarkMode 
                ? "bg-[#131b34] hover:bg-[#1a2332] text-yellow-400" 
                : "bg-gray-100 hover:bg-gray-200 text-indigo-600"
            }`}
            title={isDarkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
          >
            {isDarkMode ? (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
            )}
          </button>
          
          {/* User Dropdown */}
          <div className="relative">
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors ${
                isDarkMode 
                  ? "hover:bg-[#131b34] text-gray-300" 
                  : "hover:bg-gray-100 text-gray-700"
              }`}
            >
              <span className="text-sm font-medium">vedanjay</span>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Date Range Bar */}
      <div className={`px-6 py-3 flex justify-between items-center ${
        isDarkMode ? "bg-[#131b34]" : "bg-gray-50"
      }`}>
        <div className="flex items-center gap-3">
          <button className={`p-1.5 rounded hover:bg-opacity-20 ${
            isDarkMode ? "hover:bg-white text-gray-400" : "hover:bg-gray-200 text-gray-600"
          }`}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className={`text-sm font-medium ${
            isDarkMode ? "text-gray-300" : "text-gray-700"
          }`}>
            {selectedDateRange || `${selectedDate} to ${selectedDate} (Asia/Calcutta)`}
          </div>
          <button className={`p-1.5 rounded hover:bg-opacity-20 ${
            isDarkMode ? "hover:bg-white text-gray-400" : "hover:bg-gray-200 text-gray-600"
          }`}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>

        <button 
          onClick={onExportCSV}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            isDarkMode
              ? "bg-indigo-600 hover:bg-indigo-700 text-white"
              : "bg-indigo-600 hover:bg-indigo-700 text-white"
          }`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          EXPORT AS CSV
        </button>
      </div>
    </header>
  );
}
