import {
  LayoutDashboard,
  Calendar,
  CheckCircle,
  Database,
  TrendingDown,
  FileText,
  BarChart3,
  ArrowLeftRight,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react';
import { useState } from 'react';

export function Sidebar({ activeScreen, onNavigate, collapsed = false, onToggleCollapse }) {
  const navItems = [
    { label: 'Dashboard', id: 'dashboard', icon: LayoutDashboard },
    { label: 'Schedule Preparation', id: 'schedule', icon: Calendar },
    { label: 'Schedule Readiness', id: 'schedule-readiness', icon: CheckCircle },
    { label: 'Data Inputs', id: 'data-inputs', icon: Database },
    { label: 'Deviation/DSM', id: 'deviation', icon: TrendingDown },
    { label: 'Schedule Comparison', id: 'schedule-comparison', icon: ArrowLeftRight },
    { label: 'Schedule Templates', id: 'templates', icon: FileText },
    { label: 'Reports', id: 'reports', icon: BarChart3 },
  ];

  const [hoveredItem, setHoveredItem] = useState(null);

  return (
    <aside
      className={`h-full flex flex-col bg-card border-r border-border relative overflow-hidden transition-all duration-300 ${
        collapsed ? 'w-20' : 'w-[85vw] max-w-72'
      }`}
    >
      <div className="relative z-10 px-4 pt-4">
        <div className="flex items-center justify-between mb-4">
          {!collapsed && (
            <div className="flex items-center gap-3">
              <img src="/vedanjay logo.png" alt="Vedanjay logo" className="w-8 h-8 rounded-lg object-cover" />
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Navigation</span>
            </div>
          )}
          {collapsed && (
            <img src="/vedanjay logo.png" alt="Vedanjay logo" className="w-8 h-8 rounded-lg object-cover mx-auto" />
          )}
          <button
            onClick={onToggleCollapse}
            className="hidden md:flex p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-all"
            aria-label="Toggle sidebar collapse"
          >
            {collapsed ? <ChevronsRight className="w-4 h-4" /> : <ChevronsLeft className="w-4 h-4" />}
          </button>
        </div>
      </div>

      <div className="relative z-10 flex-1 px-3 pb-4 overflow-y-auto">
        <nav className="space-y-1.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeScreen === item.id;
            const isHovered = hoveredItem === item.id;

            return (
              <button
                key={item.id}
                onClick={() => onNavigate(item.id)}
                onMouseEnter={() => setHoveredItem(item.id)}
                onMouseLeave={() => setHoveredItem(null)}
                className={`relative w-full flex items-center ${collapsed ? 'justify-center' : 'gap-3'} px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 group ${
                  isActive ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
                }`}
                title={collapsed ? item.label : ''}
              >
                {isActive && (
                  <div className="absolute inset-0 bg-primary/10 rounded-lg border border-primary/30" />
                )}
                {!isActive && isHovered && <div className="absolute inset-0 bg-accent rounded-lg" />}
                {isActive && (
                  <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-primary rounded-r-full shadow-sm" />
                )}

                <div className={`relative z-10 transition-transform duration-200 ${isHovered && !isActive ? 'scale-110' : ''}`}>
                  <Icon className={`w-5 h-5 transition-colors duration-200 ${isActive ? 'text-primary' : ''}`} />
                </div>

                {!collapsed && <span className="relative z-10 text-left">{item.label}</span>}
              </button>
            );
          })}
        </nav>
      </div>

      {!collapsed && (
        <div className="relative z-10 p-4 border-t border-border">
          <div className="bg-muted/40 rounded-lg p-3 border border-border">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
              <span>System Status: Online</span>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
