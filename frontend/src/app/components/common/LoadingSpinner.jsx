import { Loader2 } from 'lucide-react';

export function LoadingSpinner({ size = 'md', message = 'Loading...' }) {
  const sizeClasses = {
    sm: 'w-4 h-4',
    md: 'w-8 h-8',
    lg: 'w-12 h-12',
    xl: 'w-16 h-16',
  };

  return (
    <div className="flex flex-col items-center justify-center gap-3 p-8">
      <Loader2 className={`${sizeClasses[size]} text-primary animate-spin`} />
      {message && (
        <p className="text-sm text-muted-foreground">{message}</p>
      )}
    </div>
  );
}

export function FullPageLoader({ message = 'Loading...' }) {
  return (
    <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-card rounded-lg border border-border shadow-lg p-8">
        <LoadingSpinner size="lg" message={message} />
      </div>
    </div>
  );
}

export function InlineLoader({ message }) {
  return (
    <div className="flex items-center gap-2 p-4">
      <Loader2 className="w-4 h-4 text-primary animate-spin" />
      {message && (
        <span className="text-sm text-muted-foreground">{message}</span>
      )}
    </div>
  );
}

export function SkeletonLoader({ count = 1, height = 'h-20' }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className={`${height} bg-muted/50 rounded animate-pulse`} />
      ))}
    </div>
  );
}
