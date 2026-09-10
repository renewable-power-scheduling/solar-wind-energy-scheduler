import { Building2, CheckCircle2, FileCheck2, Loader2, LogOut, SunMedium, Wind } from 'lucide-react';
import { useMemo, useState } from 'react';
import { API_BASE_URL } from '@/config/appConfig';
import {
  DASHBOARD_GROUPS,
  getDashboardGroup,
  getDashboardGroupSelectionLabel,
  normalizeDashboardGroupIds,
  serializeDashboardGroupIds,
} from '@/utils/dashboardGroups';
import { canAccessDsmVerification } from '@/utils/plantAccess';

export function DashboardGroupSelection({ user, initialGroupId = '', onSelect, onLogout }) {
  const canSelectDsm = canAccessDsmVerification(user);
  const [category, setCategory] = useState(() => {
    const initialGroups = normalizeDashboardGroupIds(initialGroupId || DASHBOARD_GROUPS[0]?.id || '');
    const initialGroup = DASHBOARD_GROUPS.find((group) => initialGroups.includes(group.id));
    if (initialGroup?.category === 'DSM' && canSelectDsm) return 'DSM';
    return initialGroup?.category === 'Wind' ? 'Wind' : 'Solar';
  });
  const [selectedGroupIds, setSelectedGroupIds] = useState(() =>
    normalizeDashboardGroupIds(initialGroupId || DASHBOARD_GROUPS[0]?.id || '')
      .filter((id) => canSelectDsm || getDashboardGroup(id)?.category !== 'DSM')
  );
  const [isPreloading, setIsPreloading] = useState(false);
  const [error, setError] = useState('');

  const visibleGroups = useMemo(() => {
    const solarGroups = DASHBOARD_GROUPS.filter((group) => !group.category || group.category === 'Solar');
    const windGroups = DASHBOARD_GROUPS.filter((group) => group.category === 'Wind');
    const dsmGroups = canSelectDsm ? DASHBOARD_GROUPS.filter((group) => group.category === 'DSM') : [];
    if (category === 'DSM') return dsmGroups;
    return category === 'Wind' ? windGroups : solarGroups;
  }, [canSelectDsm, category]);

  const selectedGroupValue = serializeDashboardGroupIds(selectedGroupIds);
  const selectedLabel = getDashboardGroupSelectionLabel(selectedGroupValue);

  const handleToggleGroup = (groupId) => {
    if (isPreloading) return;
    setSelectedGroupIds((prev) => {
      const current = normalizeDashboardGroupIds(prev);
      const group = getDashboardGroup(groupId);
      if (group?.category === 'DSM') return current.includes(group.id) ? [] : [group.id];
      const withoutDsm = current.filter((id) => getDashboardGroup(id)?.category !== 'DSM');
      if (groupId === 'ALL_SITES') return current.includes('ALL_SITES') ? [] : ['ALL_SITES'];
      const withoutAll = withoutDsm.filter((id) => id !== 'ALL_SITES');
      if (withoutAll.includes(groupId)) return withoutAll.filter((id) => id !== groupId);
      return [...withoutAll, groupId];
    });
  };

  const handleSelectCategory = (nextCategory) => {
    if (isPreloading) return;
    if (nextCategory === 'DSM') {
      if (!canSelectDsm) return;
      setCategory('DSM');
      setSelectedGroupIds(['DSM_VERIFICATION']);
      return;
    }
    setCategory(nextCategory);
    setSelectedGroupIds((prev) => {
      const current = normalizeDashboardGroupIds(prev);
      return current.some((id) => getDashboardGroup(id)?.category === 'DSM') ? [] : current;
    });
  };

  const handleContinue = async () => {
    if (!selectedGroupValue || isPreloading) return;
    setError('');
    setIsPreloading(true);
    try {
      const response = await fetch(
        `${API_BASE_URL}/dashboard-groups/preload?group=${encodeURIComponent(selectedGroupValue)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Dashboard-Group': selectedGroupValue,
          },
        }
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.detail || `Preload failed with HTTP ${response.status}`);
      }
      onSelect?.(selectedGroupValue);
    } catch (exc) {
      setError(exc?.message || 'Could not load selected dashboard data.');
    } finally {
      setIsPreloading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-3xl rounded-xl border border-border bg-card shadow-lg">
        <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
              <Building2 className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold">Select Dashboard</h1>
              <p className="text-sm text-muted-foreground">
                {user?.name || user?.username || 'User'} can continue after choosing plant groups.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onLogout}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent"
          >
            <LogOut className="h-4 w-4" />
            Logout
          </button>
        </div>

        <div className="p-6">
          <div className="mb-4 flex items-center gap-2 rounded-xl border border-border bg-muted/20 p-1.5 w-fit">
            <button
              type="button"
              onClick={() => handleSelectCategory('Solar')}
              className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition ${
                category === 'Solar' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <SunMedium className="h-4 w-4" />
              Solar
            </button>
            <button
              type="button"
              onClick={() => handleSelectCategory('Wind')}
              className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition ${
                category === 'Wind' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Wind className="h-4 w-4" />
              Wind
            </button>
            {canSelectDsm && (
              <button
                type="button"
                onClick={() => handleSelectCategory('DSM')}
                className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition ${
                  category === 'DSM' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <FileCheck2 className="h-4 w-4" />
                DSM
              </button>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {visibleGroups.map((group) => {
              const checked = selectedGroupIds.includes(group.id);
              return (
                <label
                  key={group.id}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition ${
                    checked ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/60'
                  }`}
                >
                  <input
                    type="checkbox"
                    name="dashboard-group"
                    value={group.id}
                    checked={checked}
                    onChange={() => handleToggleGroup(group.id)}
                    disabled={isPreloading}
                    className="mt-1 h-4 w-4 accent-primary"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{group.label}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {group.plantNames.join(', ')}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>

          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm text-muted-foreground">
                Selected: <span className="font-medium text-foreground">{selectedLabel || '-'}</span>
              </div>
              {error && <div className="mt-1 text-xs font-medium text-destructive">{error}</div>}
            </div>
            <button
              type="button"
              disabled={!selectedGroupValue || isPreloading}
              onClick={handleContinue}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {isPreloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              {isPreloading ? 'Loading dashboard...' : 'Continue'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
