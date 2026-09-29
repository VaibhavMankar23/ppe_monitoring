import type { HTMLAttributes, ReactNode } from "react";

export function Card({ className = "", children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`rounded-xl border border-border bg-surface shadow-[var(--shadow-card)] ${className}`} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({ title, description, actions, className = "" }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4 ${className}`}>
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold text-text">{title}</h2>
        {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
