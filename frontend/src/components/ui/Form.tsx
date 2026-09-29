import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

const base =
  "h-9 w-full rounded-lg border bg-surface px-3 text-sm text-text shadow-sm transition-colors placeholder:text-muted/70 focus:border-primary focus:outline-none focus:ring-3 focus:ring-primary/15 disabled:bg-subtle disabled:text-muted";

export function Input({ invalid, className = "", ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input className={`${base} ${invalid ? "border-danger" : "border-border"} ${className}`} aria-invalid={invalid || undefined} {...rest} />;
}

export function Select({ invalid, className = "", children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select className={`${base} cursor-pointer pr-8 ${invalid ? "border-danger" : "border-border"} ${className}`} aria-invalid={invalid || undefined} {...rest}>
      {children}
    </select>
  );
}

/** Label + control + hint/error, wired with ids for accessibility. */
export function Field({ id, label, hint, error, children, className = "" }: { id: string; label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${className}`} data-field={id}>
      <label htmlFor={id} className="text-[13px] font-medium text-text">{label}</label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-xs font-medium text-danger" role="alert">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

/** Accessible on/off switch. */
export function Toggle({ id, checked, onChange, label, disabled }: { id?: string; checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="group inline-flex items-center gap-2.5 text-sm text-text disabled:opacity-50"
    >
      <span className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? "bg-primary" : "bg-border-strong"}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-[18px]" : "translate-x-0.5"}`} />
      </span>
      {label}
    </button>
  );
}
