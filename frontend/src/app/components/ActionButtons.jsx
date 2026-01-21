import { Save, CheckCircle, FileText, Download, Send, Loader2 } from 'lucide-react';
import { useState } from 'react';

export function ActionButtons({ 
  onSave = () => {}, 
  onValidate = () => {}, 
  onExport = () => {}, 
  onSubmit = () => {},
  isLoading = false,
  disabled = false
}) {
  const [loadingAction, setLoadingAction] = useState(null);

  const handleAction = async (action, handler) => {
    if (isLoading || disabled) return;
    setLoadingAction(action);
    try {
      await handler();
    } finally {
      setTimeout(() => setLoadingAction(null), 500);
    }
  };

  const buttons = [
    {
      id: 'save',
      label: 'Save Draft',
      icon: Save,
      variant: 'secondary',
      handler: onSave
    },
    {
      id: 'validate',
      label: 'Validate',
      icon: CheckCircle,
      variant: 'secondary',
      handler: onValidate
    },
    {
      id: 'export',
      label: 'Export CSV',
      icon: Download,
      variant: 'secondary',
      handler: onExport
    },
    {
      id: 'submit',
      label: 'Submit',
      icon: Send,
      variant: 'primary',
      handler: onSubmit
    }
  ];

  return (
    <div className="flex items-center justify-end gap-3 p-4 bg-card border-t border-border animate-fade-in">
      {buttons.map((button) => {
        const Icon = button.icon;
        const isLoading = loadingAction === button.id;
        const isPrimary = button.variant === 'primary';

        return (
          <button
            key={button.id}
            onClick={() => handleAction(button.id, button.handler)}
            disabled={disabled || isLoading}
            className={`
              inline-flex items-center gap-2 px-5 py-2.5 rounded-md
              font-medium text-sm transition-all duration-200
              ${isPrimary 
                ? 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm hover:shadow-md' 
                : 'bg-card text-foreground border border-border hover:bg-accent hover:border-primary/50'
              }
              ${disabled || isLoading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
            `}
          >
            {isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Icon className="w-4 h-4" />
            )}
            <span>{button.label}</span>
          </button>
        );
      })}
    </div>
  );
}
