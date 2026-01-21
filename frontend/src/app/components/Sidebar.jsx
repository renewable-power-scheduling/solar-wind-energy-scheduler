import { LayoutDashboard, Calendar, CheckCircle, Database, TrendingDown, FileText, BarChart3 } from 'lucide-react';
import { useState } from 'react';

export function Sidebar({ activeScreen, onNavigate }) {
  const navItems = [
    { label: 'Dashboard', id: 'dashboard', icon: LayoutDashboard },
    { label: 'Schedule Preparation', id: 'schedule', icon: Calendar },
    { label: 'Schedule Readiness', id: 'schedule-readiness', icon: CheckCircle },
    { label: 'Data Inputs', id: 'data-inputs', icon: Database },
    { label: 'Deviation/DSM', id: 'deviation', icon: TrendingDown },
    { label: 'Schedule Templates', id: 'templates', icon: FileText },
    { label: 'Reports', id: 'reports', icon: BarChart3 },
  ];

  const [hoveredItem, setHoveredItem] = useState(null);

  return (
    <aside className="w-64 h-full flex flex-col bg-gradient-to-b from-slate-950 to-slate-900 border-r border-slate-800/50 relative overflow-hidden">
      {/* Navigation Section */}
      <div className="relative z-10 flex-1 p-4 overflow-y-auto">
        <div className="mb-4">
          <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider px-3 mb-2">
            Navigation
          </h2>
        </div>
        
        <nav className="space-y-1.5">
          {navItems.map((item, index) => {
            const Icon = item.icon;
            const isActive = activeScreen === item.id;
            const isHovered = hoveredItem === item.id;
            
            return (
              <button
                key={item.id}
                onClick={() => onNavigate(item.id)}
                onMouseEnter={() => setHoveredItem(item.id)}
                onMouseLeave={() => setHoveredItem(null)}
                className={`relative w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 group ${
                  isActive 
                    ? 'text-white' 
                    : 'text-slate-400 hover:text-white'
                }`}
                style={{ animationDelay: `${index * 50}ms` }}
              >
                {/* Active State Background */}
                {isActive && (
                  <div className="absolute inset-0 bg-gradient-to-r from-indigo-500/20 to-purple-500/20 rounded-lg border border-indigo-500/30" />
                )}
                
                {/* Hover Glow Effect */}
                {!isActive && isHovered && (
                  <div className="absolute inset-0 bg-slate-800/50 rounded-lg" />
                )}
                
                {/* Active Indicator */}
                {isActive && (
                  <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-gradient-to-b from-indigo-400 to-purple-400 rounded-r-full shadow-lg shadow-indigo-500/50" />
                )}
                
                {/* Icon */}
                <div className={`relative z-10 transition-transform duration-200 ${isHovered && !isActive ? 'scale-110' : ''}`}>
                  <Icon 
                    className={`w-5 h-5 transition-colors duration-200 ${
                      isActive 
                        ? 'text-indigo-400' 
                        : isHovered 
                          ? 'text-indigo-300' 
                          : 'text-slate-500 group-hover:text-slate-300'
                    }`} 
                  />
                </div>
                
                {/* Label */}
                <span className="relative z-10">{item.label}</span>
                
                {/* Active State Glow */}
                {isActive && (
                  <>
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 w-1.5 h-1.5 bg-indigo-400 rounded-full shadow-lg shadow-indigo-400/50" />
                    <div className="absolute inset-0 rounded-lg bg-indigo-500/5 animate-pulse" />
                  </>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Footer Section */}
      <div className="relative z-10 p-4 border-t border-slate-800/50">
        <div className="bg-gradient-to-br from-slate-800/50 to-slate-900/50 rounded-lg p-3 border border-slate-700/50">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
            <span>System Status: Online</span>
          </div>
        </div>
      </div>
    </aside>
  );
}

