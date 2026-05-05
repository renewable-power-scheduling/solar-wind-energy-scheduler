import {
  LayoutDashboard,
  Calendar,
  CheckCircle,
  Database,
  TrendingDown,
  FileText,
  ArrowLeftRight,
  Snowflake,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react';
import { useState } from 'react';
import { isAdminUser } from '@/utils/plantAccess';

export function Sidebar({ activeScreen, allowedScreens, onNavigate, user, collapsed = false, onToggleCollapse }) {
  const isAdmin = isAdminUser(user);
  const navItems = [
    { label: 'Dashboard', id: 'dashboard', icon: LayoutDashboard },
    { label: 'Data Inputs', id: 'data-inputs', icon: Database },
    { label: 'Schedule Readiness', id: 'schedule-readiness', icon: CheckCircle },
    { label: 'Schedule Preparation', id: 'schedule', icon: Calendar },
    { label: 'Schedule Templates', id: 'templates', icon: FileText },
    { label: 'Deviation/DSM', id: 'deviation', icon: TrendingDown },
    { label: 'Schedule Comparison', id: 'schedule-comparison', icon: ArrowLeftRight },
    { label: 'Frozen Schedule', id: 'frozen-schedule', icon: Snowflake },
  ];

  const visibleNavItems = isAdmin
    ? navItems
    : navItems.filter((item) => item.id !== 'frozen-schedule');

  const [hoveredItem, setHoveredItem] = useState(null);
  const canNavigate = (screenId) =>
    !allowedScreens || allowedScreens.has(screenId);

  return (
    <aside
      className={`h-full flex flex-col bg-card border-r border-border relative overflow-hidden transition-all duration-300 min-w-0 ${
        collapsed ? 'w-16 sm:w-20' : 'w-[82vw] max-w-72 sm:w-64'
      }`}
    >
      <div className="relative z-10 px-3 sm:px-4 pt-4">
        <div className="flex items-center justify-end mb-4">
          <button
            onClick={onToggleCollapse}
            className="hidden md:flex p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-all"
            aria-label="Toggle sidebar collapse"
          >
            {collapsed ? <ChevronsRight className="w-4 h-4" /> : <ChevronsLeft className="w-4 h-4" />}
          </button>
        </div>
      </div>

      <div className="relative z-10 flex-1 px-2.5 sm:px-3 pb-4 overflow-y-auto">
        <nav className="space-y-1.5">
          {visibleNavItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeScreen === item.id;
            const isHovered = hoveredItem === item.id;
            const isEnabled = canNavigate(item.id);

            return (
              <button
                key={item.id}
                onClick={() => {
                  if (!isEnabled) return;
                  onNavigate(item.id);
                }}
                disabled={!isEnabled}
                onMouseEnter={() => setHoveredItem(item.id)}
                onMouseLeave={() => setHoveredItem(null)}
                className={`relative w-full flex items-center ${collapsed ? 'justify-center' : 'gap-3'} px-2.5 sm:px-3 py-2.5 rounded-lg text-xs sm:text-sm font-medium transition-all duration-200 group ${
                  !isEnabled
                    ? 'opacity-50 cursor-not-allowed text-muted-foreground'
                    : isActive
                      ? 'text-primary'
                      : 'text-muted-foreground hover:text-foreground'
                }`}
                title={collapsed ? item.label : (!isEnabled ? `${item.label} (Locked)` : '')}
              >
                {isActive && (
                  <div className="absolute inset-0 bg-primary/10 rounded-lg border border-primary/30" />
                )}
                {!isActive && isHovered && isEnabled && <div className="absolute inset-0 bg-accent rounded-lg" />}
                {isActive && (
                  <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-primary rounded-r-full shadow-sm" />
                )}

                <div className={`relative z-10 transition-transform duration-200 ${isHovered && !isActive && isEnabled ? 'scale-110' : ''}`}>
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
