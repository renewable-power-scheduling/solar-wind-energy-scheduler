import React, { useState, useEffect, useRef } from 'react';
import { User, LogOut, Settings, Bell, ChevronDown } from 'lucide-react';

export function TopNav() {
  const [showUserMenu, setShowUserMenu] = useState(false);
  const menuRef = useRef(null);

  // Close user menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setShowUserMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <header className="h-16 bg-gradient-to-r from-slate-900 to-slate-800 border-b border-slate-700/50 flex items-center justify-between px-4 md:px-6 sticky top-0 z-50 shadow-xl shadow-slate-950/20">
      {/* Logo & Brand - Left Side */}
      <div className="flex items-center gap-3 flex-shrink-0">
        <div className="relative group">
          <div className="w-9 h-9 md:w-10 md:h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/30 transition-transform group-hover:scale-105">
            <span className="text-white font-bold text-sm md:text-lg">Q</span>
          </div>
          <div className="absolute inset-0 rounded-xl bg-indigo-500/20 blur-md -z-10" />
        </div>
        <div className="hidden sm:block">
          <h1 className="text-sm md:text-base font-bold text-white tracking-tight">
            QCA Dashboard
          </h1>
          <p className="text-xs text-slate-400 font-medium">Renewable Energy Management</p>
        </div>
      </div>

      {/* Right Side Actions */}
      <div className="flex items-center gap-3">
        {/* Notifications */}
        <button className="relative p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/50 transition-all">
          <Bell className="w-5 h-5" />
          <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-indigo-500 rounded-full animate-pulse" />
        </button>

        {/* User Menu */}
        <div ref={menuRef} className="user-menu-container relative">
          <button 
            onClick={() => setShowUserMenu(!showUserMenu)}
            className="flex items-center gap-2 md:gap-3 pl-3 md:pl-4 border-l border-slate-700 hover:border-slate-600 transition-colors"
          >
            <div className="hidden lg:block text-right">
              <div className="text-sm font-medium text-white">Admin User</div>
              <div className="text-xs text-slate-400">System Operator</div>
            </div>
            <div className="relative">
              <div className="w-8 h-8 md:w-9 md:h-9 rounded-full bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-purple-500/30 transition-transform hover:scale-105">
                <User className="w-4 h-4 md:w-5 md:h-5 text-white" />
              </div>
              <div className="absolute inset-0 rounded-full bg-purple-500/20 blur-md -z-10" />
            </div>
            <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${showUserMenu ? 'rotate-180' : ''}`} />
          </button>

          {/* User Dropdown Menu */}
          <div 
            className={`absolute right-0 top-full mt-2 w-56 bg-gradient-to-b from-slate-800 to-slate-900 rounded-xl shadow-2xl border border-slate-700/50 py-2 z-50 overflow-hidden transition-all duration-200 ${
              showUserMenu 
                ? 'opacity-100 translate-y-0' 
                : 'opacity-0 translate-y-2 pointer-events-none'
            }`}
          >
            {/* User Info Header */}
            <div className="px-4 py-3 border-b border-slate-700/50 bg-slate-800/50">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center">
                  <User className="w-5 h-5 text-white" />
                </div>
                <div>
                  <div className="text-sm font-medium text-white">Admin User</div>
                  <div className="text-xs text-slate-400">admin@qca.com</div>
                </div>
              </div>
            </div>
            
            {/* Menu Items */}
            <div className="py-1">
              <button 
                onClick={() => setShowUserMenu(false)}
                className="w-full px-4 py-2.5 text-left text-sm text-slate-300 hover:text-white hover:bg-slate-800/80 flex items-center gap-3 transition-all"
              >
                <Settings className="w-4 h-4 text-slate-400" />
                <span>Settings</span>
              </button>
              <button 
                onClick={() => {
                  setShowUserMenu(false);
                  alert('Logout functionality - to be implemented');
                }}
                className="w-full px-4 py-2.5 text-left text-sm text-red-400 hover:text-red-300 hover:bg-red-500/10 flex items-center gap-3 transition-all"
              >
                <LogOut className="w-4 h-4" />
                <span>Logout</span>
              </button>
            </div>
            
            {/* Footer */}
            <div className="px-4 py-2 border-t border-slate-700/50 bg-slate-800/30">
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <span>Version 1.0.0</span>
                <span className="text-slate-600">•</span>
                <span>QCA Energy</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

