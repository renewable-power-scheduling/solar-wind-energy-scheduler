import { useState } from "react";

export default function RightSidebar({ streams, setStreams, asset, isDarkMode }) {
  const [search, setSearch] = useState("");
  
  const toggle = (key) => {
    setStreams(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const streamCategories = [
    {
      title: "Site Forecast",
      streams: [
        { key: "default", label: "Default" },
        { key: "chandwasaDayahead", label: "Chandwasa_Dayahead" },
        { key: "chandwasaIntraday", label: "Chandwasa_Intraday" },
        { key: "pvDayahead", label: "PV_Dayahead" },
        { key: "pvIntraday", label: "PV_Intraday", active: streams.intraday },
        { key: "pvWeekahead", label: "PV_Weekahead" },
      ]
    },
    {
      title: "Actual Generation",
      streams: [
        { key: "meterLatest", label: "Meter data (latest)" },
        { key: "meterLive", label: "Meter data (live)", active: streams.actual },
        { key: "meterFinalized", label: "Meter data (finalized)" },
      ]
    },
    {
      title: "Capacity",
      streams: [
        { key: "installed", label: "Installed capacity" },
        { key: "availablePlanned", label: "Available capacity (planned)" },
        { key: "availableLatest", label: "Available capacity (latest)" },
        { key: "availableLive", label: "Available capacity (live)" },
        { key: "availableFinalized", label: "Available capacity (finalized)" },
      ]
    }
  ];

  const filteredCategories = streamCategories.map(category => ({
    ...category,
    streams: category.streams.filter(stream => 
      stream.label.toLowerCase().includes(search.toLowerCase())
    )
  })).filter(category => category.streams.length > 0);

  return (
    <aside className={`w-72 border-l transition-colors duration-300 flex flex-col h-full ${
      isDarkMode 
        ? "bg-[#0f1629] border-gray-800/50" 
        : "bg-white border-gray-200"
    }`}>
      {/* Header */}
      <div className={`p-4 border-b flex items-center justify-between ${
        isDarkMode ? "border-gray-800/50" : "border-gray-200"
      }`}>
        <div className="flex items-center gap-2">
          <button className={`p-1.5 rounded hover:bg-opacity-20 ${
            isDarkMode ? "hover:bg-white text-gray-400" : "hover:bg-gray-100 text-gray-600"
          }`}>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <h3 className={`text-sm font-semibold ${
            isDarkMode ? "text-gray-300" : "text-gray-900"
          }`}>
            Data Streams
          </h3>
        </div>
      </div>

      {/* Search */}
      <div className="p-4 border-b">
        <div className="relative">
          <svg 
            className={`absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 ${
              isDarkMode ? "text-gray-500" : "text-gray-400"
            }`}
            fill="none" 
            stroke="currentColor" 
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            placeholder="Search..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className={`w-full border rounded px-10 py-2 text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all ${
              isDarkMode 
                ? "bg-[#131b34] border-gray-700/50 text-gray-200" 
                : "bg-gray-50 border-gray-300 text-gray-900"
            }`}
          />
        </div>
      </div>

      {/* Stream Categories */}
      <div className="flex-1 overflow-y-auto p-2 space-y-4">
        {filteredCategories.map((category, catIdx) => (
          <div key={catIdx}>
            <h4 className={`text-xs font-semibold uppercase tracking-wider mb-2 px-2 ${
              isDarkMode ? "text-gray-500" : "text-gray-600"
            }`}>
              {category.title}
            </h4>
            <div className="space-y-1">
              {category.streams.map((stream) => {
                const isActive = stream.active || false;
                return (
                  <button
                    key={stream.key}
                    onClick={() => {
                      if (stream.key === "pvIntraday") toggle("intraday");
                      if (stream.key === "meterLive") toggle("actual");
                    }}
                    className={`w-full text-left px-3 py-2 rounded transition-all duration-200 ${
                      isActive
                        ? isDarkMode
                          ? "bg-orange-600 text-white"
                          : "bg-orange-100 text-orange-900"
                        : isDarkMode
                          ? "hover:bg-[#131b34] text-gray-300"
                          : "hover:bg-gray-50 text-gray-700"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm">{stream.label}</span>
                      {isActive && (
                        <div className={`w-2 h-2 rounded-full ${
                          isDarkMode ? "bg-white" : "bg-orange-600"
                        }`}></div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
  