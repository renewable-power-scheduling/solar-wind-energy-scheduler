import { useState } from "react";

export default function Sidebar({ assets, selectedAsset, onSelect, isDarkMode }) {
  const [search, setSearch] = useState("");

  const filteredAssets = assets.filter(a =>
    a.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <aside className={`w-72 border-r transition-colors duration-300 flex flex-col h-full ${
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
            Assets
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

      {/* Asset List */}
      <div className="flex-1 overflow-y-auto p-2">
        <div className="space-y-1">
          {filteredAssets.map(asset => (
            <button
              key={asset.id}
              onClick={() => onSelect(asset)}
              className={`w-full text-left px-3 py-2.5 rounded transition-all duration-200 flex items-center gap-3 ${
                selectedAsset.id === asset.id
                  ? isDarkMode
                    ? "bg-green-600 text-white"
                    : "bg-green-100 text-green-900"
                  : isDarkMode
                    ? "hover:bg-[#131b34] text-gray-300"
                    : "hover:bg-gray-50 text-gray-700"
              }`}
            >
              {/* Icon */}
              <div className={`flex-shrink-0 ${
                asset.type === "SOLAR" ? "text-yellow-400" : 
                asset.type === "WIND" ? "text-blue-400" : 
                "text-purple-400"
              }`}>
                {asset.type === "SOLAR" ? (
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M5 3a1 1 0 000 2h5.5a1 1 0 010 2H5a3 3 0 000 6h5.5a1 1 0 010 2H5a1 1 0 100 2h5.5a1 1 0 110 2H5a3 3 0 01-3-3V6a3 3 0 013-3z" />
                  </svg>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className={`font-medium text-sm truncate ${
                  selectedAsset.id === asset.id 
                    ? "text-white" 
                    : isDarkMode 
                      ? "text-gray-200" 
                      : "text-gray-900"
                }`}>
                  {asset.name}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className={`p-4 border-t ${
        isDarkMode ? "border-gray-800/50" : "border-gray-200"
      }`}>
        <div className={`text-xs mb-3 ${
          isDarkMode ? "text-gray-400" : "text-gray-500"
        }`}>
          Total: {assets.length}
        </div>
        <button className={`w-full px-4 py-2 rounded text-sm font-medium transition-colors ${
          isDarkMode
            ? "bg-[#131b34] hover:bg-[#1a2332] text-gray-300 border border-gray-700"
            : "bg-gray-100 hover:bg-gray-200 text-gray-700 border border-gray-300"
        }`}>
          + ADD ASSET
        </button>
      </div>
    </aside>
  );
}
