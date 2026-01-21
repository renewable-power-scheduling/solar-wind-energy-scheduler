import { AlertCircle, XCircle, AlertTriangle, RefreshCw } from 'lucide-react';

export function ErrorMessage({ 
  error, 
  onRetry = null, 
  variant = 'default',
  className = '' 
}) {
  if (!error) return null;

  const errorMessage = error.message || 'An unexpected error occurred';
  const errorStatus = error.status || 0;

  const variantStyles = {
    default: 'bg-destructive/10 border-destructive/20 text-destructive',
    warning: 'bg-warning/10 border-warning/20 text-warning',
    info: 'bg-primary/10 border-primary/20 text-primary',
  };

  const Icon = variant === 'warning' ? AlertTriangle : XCircle;

  return (
    <div className={`rounded-lg border p-4 ${variantStyles[variant]} ${className}`}>
      <div className="flex items-start gap-3">
        <Icon className="w-5 h-5 mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <h4 className="font-semibold mb-1">
            {errorStatus ? `Error ${errorStatus}` : 'Error'}
          </h4>
          <p className="text-sm opacity-90">{errorMessage}</p>
          {error.data && error.data.details && (
            <p className="text-xs mt-2 opacity-75">{error.data.details}</p>
          )}
        </div>
        {onRetry && (
          <button
            onClick={onRetry}
            className="flex items-center gap-2 px-3 py-1.5 rounded border border-current hover:bg-current/10 transition-all text-sm font-medium"
          >
            <RefreshCw className="w-4 h-4" />
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

export function EmptyState({ 
  icon: Icon = AlertCircle, 
  title = 'No data available', 
  description = '',
  action = null 
}) {
  return (
    <div className="flex flex-col items-center justify-center p-12 text-center">
      <div className="p-4 bg-muted/50 rounded-full mb-4">
        <Icon className="w-12 h-12 text-muted-foreground" />
      </div>
      <h3 className="text-lg font-semibold text-foreground mb-2">{title}</h3>
      {description && (
        <p className="text-sm text-muted-foreground max-w-md mb-4">{description}</p>
      )}
      {action}
    </div>
  );
}

export function NetworkError({ onRetry }) {
  return (
    <ErrorMessage
      error={{
        message: 'Unable to connect to the server',
        data: { details: 'Please check your internet connection and try again.' }
      }}
      onRetry={onRetry}
      variant="warning"
    />
  );
}

export function NotFoundError({ message = 'The requested resource was not found' }) {
  return (
    <EmptyState
      icon={AlertCircle}
      title="Not Found"
      description={message}
    />
  );
}
