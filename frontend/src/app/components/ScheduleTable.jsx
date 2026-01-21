import { Clock, Edit3, ChevronRight, Info } from 'lucide-react';
import { useState } from 'react';

export function ScheduleTable({ 
  scheduleData = [], 
  onEdit = () => {},
  maxRows = 10
}) {
  const [editingRow, setEditingRow] = useState(null);
  const [editValue, setEditValue] = useState('');

  // Generate sample time blocks for demonstration if no data provided
  const defaultTimeBlocks = Array.from({ length: maxRows }, (_, i) => {
    const hour = Math.floor(i / 4);
    const minute = (i % 4) * 15;
    return {
      time: `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`,
      forecast: (40 + Math.random() * 20).toFixed(1),
      actual: (42 + Math.random() * 18).toFixed(1),
      suggested: (41 + Math.random() * 19).toFixed(1)
    };
  });

  const displayData = scheduleData.length > 0 ? scheduleData : defaultTimeBlocks;

  const handleEdit = (row) => {
    setEditingRow(row.time);
    setEditValue(row.scheduled || row.suggested || '');
  };

  const handleSave = (row) => {
    if (onEdit && typeof onEdit === 'function') {
      onEdit(row, editValue);
    }
    setEditingRow(null);
    setEditValue('');
  };

  const handleKeyDown = (e, row) => {
    if (e.key === 'Enter') {
      handleSave(row);
    } else if (e.key === 'Escape') {
      setEditingRow(null);
      setEditValue('');
    }
  };

  return (
    <div className="bg-card rounded-lg border border-border shadow-sm overflow-hidden animate-fade-in">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Clock className="w-5 h-5 text-primary" />
          <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">
            Schedule Table - 15 Min Blocks
          </h3>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Info className="w-4 h-4" />
          <span>{displayData.length} of 96 blocks shown</span>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-muted/50">
              <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider w-24">
                Time
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Forecast (MW)
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Actual (MW)
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Suggested (MW)
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Scheduled (MW)
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider w-24">
                Action
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {displayData.map((row, index) => (
              <tr 
                key={row.time || index}
                className="hover:bg-accent/50 transition-colors"
              >
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm font-medium text-foreground">
                      {row.time}
                    </span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className="text-sm text-muted-foreground">
                    {row.forecast} MW
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className="text-sm text-muted-foreground">
                    {row.actual} MW
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className="text-sm font-medium text-primary">
                    {row.suggested || row.forecast} MW
                  </span>
                </td>
                <td className="px-4 py-3">
                  {editingRow === row.time ? (
                    <input
                      type="number"
                      step="0.1"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => handleKeyDown(e, row)}
                      onBlur={() => handleSave(row)}
                      className="w-24 px-3 py-1.5 rounded border border-primary bg-input-background text-sm font-semibold text-primary focus:outline-none focus:ring-2 focus:ring-ring"
                      autoFocus
                    />
                  ) : (
                    <span className="text-sm font-semibold text-foreground">
                      {row.scheduled || row.suggested || row.forecast} MW
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {editingRow === row.time ? (
                    <button
                      onClick={() => handleSave(row)}
                      className="px-3 py-1.5 rounded text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                    >
                      Save
                    </button>
                  ) : (
                    <button
                      onClick={() => handleEdit(row)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded border border-border hover:bg-accent transition-colors text-xs font-medium text-foreground"
                    >
                      <Edit3 className="w-3 h-3" />
                      Edit
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-border bg-muted/20 flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Showing {displayData.length} of 96 blocks
        </p>
        <button className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:text-primary/80 transition-colors">
          View all blocks
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
