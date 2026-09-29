import type { ReactNode } from "react";

export function EmptyState({ icon, title, message, action }: { icon?: ReactNode; title: string; message?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      {icon && <div className="flex h-12 w-12 items-center justify-center rounded-full bg-subtle text-muted">{icon}</div>}
      <div>
        <p className="text-sm font-semibold text-text">{title}</p>
        {message && <p className="mt-1 max-w-md text-[13px] text-muted">{message}</p>}
      </div>
      {action}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-skeleton ${className}`} aria-hidden />;
}
