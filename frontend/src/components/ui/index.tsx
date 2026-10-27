/**
 * UI primitives. Everything visual in the app is built from these, so pages stay consistent:
 * Button, IconButton, Panel, Tag, StatusDot, Field + inputs, Switch, Segmented, Dialog, Drawer,
 * ConfirmDialog, Empty, Skeleton, Spinner, Kbd, Stat, Toast. Colours come from the tokens in index.css.
 */
import {
  createContext, useCallback, useContext, useEffect, useId, useRef, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon";

export { Icon, type IconName };

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

export type Tone = "neutral" | "accent" | "ok" | "warn" | "bad";

// ------------------------------------------------------------------ Button
type Variant = "primary" | "accent" | "outline" | "ghost" | "danger";
const VARIANT: Record<Variant, string> = {
  primary: "border border-pri bg-pri text-pri-ink shadow-[var(--sh-xs)] hover:border-pri-hover hover:bg-pri-hover",
  accent: "border border-accent bg-accent text-accent-ink shadow-[var(--sh-xs)] hover:border-accent-strong hover:bg-accent-strong",
  outline: "border border-line-strong bg-surface text-ink shadow-[var(--sh-xs)] hover:border-ink-4",
  ghost: "border border-transparent text-ink-2 hover:bg-sunken hover:text-ink",
  danger: "border border-bad bg-bad text-white shadow-[var(--sh-xs)] hover:brightness-95",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md";
  icon?: IconName;
  loading?: boolean;
}

export function Button({ variant = "outline", size = "md", icon, loading, className, children, disabled, type = "button", ...rest }: ButtonProps) {
  return (
    <button type={type} disabled={disabled || loading}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-2 rounded-xl font-semibold whitespace-nowrap transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-8 rounded-[10px] px-3 text-[13px]" : "h-10 px-4 text-[13.5px]", VARIANT[variant], className)}
      {...rest}>
      {loading ? <Spinner size={14} /> : icon && <Icon name={icon} size={size === "sm" ? 14 : 16} />}
      {children}
    </button>
  );
}

/** Square icon-only button. `label` is required: it is the accessible name and the tooltip. */
export function IconButton({ icon, label, tone = "light", size = 32, className, ...rest }:
  { icon: IconName; label: string; tone?: "light" | "stage"; size?: number } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  return (
    <button type="button" aria-label={label} title={label} style={{ width: size, height: size }}
      className={cx("inline-flex shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-40",
        tone === "stage" ? "text-stage-ink-2 hover:bg-white/10 hover:text-white" : "text-ink-3 hover:bg-sunken hover:text-ink", className)}
      {...rest}>
      <Icon name={icon} size={Math.round(size * 0.5)} />
    </button>
  );
}

// ------------------------------------------------------------------ Panel
export function Panel({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return <section className={cx("min-w-0 rounded-card border border-line bg-surface shadow-card", className)} {...rest}>{children}</section>;
}

/** Title row of a Panel: title + optional one-line description on the left, actions on the right. */
export function PanelHeader({ title, hint, actions, className }: { title: ReactNode; hint?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <header className={cx("flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-[22px] py-4", className)}>
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        {hint && <p className="mt-0.5 text-[12.5px] text-ink-3">{hint}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

// ------------------------------------------------------------------ Tag / StatusDot / Kbd
const TAG: Record<Tone, string> = {
  neutral: "border-transparent bg-sunken text-ink-2",
  accent: "border-transparent bg-accent-soft text-accent",
  ok: "border-transparent bg-ok-soft text-ok",
  warn: "border-transparent bg-warn-soft text-warn",
  bad: "border-transparent bg-bad-soft text-bad",
};

export function Tag({ tone = "neutral", icon, children, className, title }: { tone?: Tone; icon?: IconName; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs leading-[18px] font-semibold whitespace-nowrap", TAG[tone], className)}>
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}

const DOT: Record<Tone, string> = { neutral: "bg-ink-3 text-ink-3", accent: "bg-accent text-accent", ok: "bg-ok text-ok", warn: "bg-warn text-warn", bad: "bg-bad text-bad" };

/** Status is never colour alone: always pair the dot with a text label. */
export function StatusDot({ tone, pulse, className }: { tone: Tone; pulse?: boolean; className?: string }) {
  return <span aria-hidden="true" className={cx("inline-block size-2 shrink-0 rounded-full", DOT[tone], pulse && "pulse-ring", className)} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-b-2 border-line-strong bg-surface px-1.5 font-mono text-[11px] font-medium text-ink-3">{children}</kbd>;
}

// ------------------------------------------------------------------ Stat
/** A headline figure. `tone` colours the value only when the number itself is a status. */
export function Stat({ label, value, unit, hint, tone, className }:
  { label: string; value: ReactNode; unit?: string; hint?: ReactNode; tone?: Tone; className?: string }) {
  const color = tone === "bad" ? "text-bad" : tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : "text-ink";
  return (
    <div className={cx("min-w-0", className)}>
      <div className="eyebrow truncate">{label}</div>
      <div className={cx("num mt-1.5 text-2xl leading-none font-semibold tracking-[-0.03em]", color)}>
        {value}{unit && <span className="ml-0.5 text-sm font-medium text-ink-3">{unit}</span>}
      </div>
      {hint && <div className="mt-1.5 text-xs text-ink-3">{hint}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ Form
const CONTROL = "h-10 w-full min-w-0 rounded-xl border border-line-strong bg-surface px-3 text-sm text-ink shadow-card placeholder:text-ink-4 " +
  "focus:border-accent focus:outline-none focus:ring-4 focus:ring-accent-soft " +
  "disabled:bg-sunken disabled:text-ink-3 aria-[invalid=true]:border-bad";

/** Label + control + help / error. Pass the control as a render prop to receive the wired `id`. */
export function Field({ label, hint, error, children, className, optional }:
  { label: ReactNode; hint?: ReactNode; error?: string | null; optional?: boolean; className?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className={cx("min-w-0", className)}>
      <label htmlFor={id} className="mb-1.5 flex items-baseline gap-1.5 text-[13.5px] font-semibold text-ink">
        {label}{optional && <span className="font-normal text-ink-3">optional</span>}
      </label>
      {children(id)}
      {error ? <p role="alert" className="mt-1.5 text-[12.5px] text-bad">{error}</p> : hint && <p className="mt-1.5 text-[12.5px] text-ink-3">{hint}</p>}
    </div>
  );
}

export function Input({ className, invalid, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input aria-invalid={invalid || undefined} className={cx(CONTROL, className)} {...rest} />;
}

export function Select({ className, invalid, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return <select aria-invalid={invalid || undefined} className={cx(CONTROL, "pr-7", className)} {...rest}>{children}</select>;
}

export function Textarea({ className, invalid, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return <textarea aria-invalid={invalid || undefined} className={cx(CONTROL, "h-auto py-2", className)} {...rest} />;
}

export function Switch({ checked, onChange, label, disabled, hint }:
  { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean; hint?: ReactNode }) {
  return (
    <label className={cx("flex items-start gap-2.5", disabled && "cursor-not-allowed opacity-60")}>
      <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
        className={cx("relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors", checked ? "bg-accent" : "bg-line-strong")}>
        <span className={cx("absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform", checked && "translate-x-4")} />
      </button>
      <span className="min-w-0 text-sm text-ink">
        {label}
        {hint && <span className="block text-xs text-ink-3">{hint}</span>}
      </span>
    </label>
  );
}

/** Toggle chip for multi-select sets (required PPE, filters). */
export function Chip({ selected, onClick, children, disabled, tone = "accent", title }:
  { selected: boolean; onClick?: () => void; children: ReactNode; disabled?: boolean; tone?: "accent" | "bad" | "ok"; title?: string }) {
  const on = tone === "bad" ? "border-bad bg-bad-soft text-bad" : tone === "ok" ? "border-ok bg-ok-soft text-ok" : "border-accent bg-accent-soft text-accent";
  return (
    <button type="button" aria-pressed={selected} onClick={onClick} disabled={disabled} title={title}
      className={cx("inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        selected ? on : "border-line-strong bg-surface text-ink-2 hover:bg-surface-2")}>
      {selected && <Icon name="check" size={12} />}
      {children}
    </button>
  );
}

export function Segmented<T extends string>({ value, onChange, options, label, size = "md" }:
  { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; count?: number }[]; label: string; size?: "sm" | "md" }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex shrink-0 rounded-xl border border-line bg-sunken p-[3px]">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}
          className={cx("inline-flex items-center gap-1.5 rounded-[9px] font-semibold whitespace-nowrap transition-colors",
            size === "sm" ? "h-[26px] px-2.5 text-[12.5px]" : "h-[30px] px-3 text-[13px]",
            o.value === value ? "bg-surface text-ink shadow-[var(--sh-xs)]" : "text-ink-3 hover:text-ink")}>
          {o.label}
          {o.count !== undefined && <span className="num text-[11px] text-ink-3">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Underlined page tabs (in the page header band); `count` shows a pill next to the label. */
export function Tabs<T extends string>({ value, onChange, options, label }:
  { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; count?: number }[]; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="-mb-px flex gap-5 overflow-x-auto [scrollbar-width:none]">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={o.value} type="button" role="tab" aria-selected={on} onClick={() => onChange(o.value)}
            className={cx("flex items-center gap-2 border-b-2 py-2.5 text-sm font-medium whitespace-nowrap transition-colors",
              on ? "border-accent text-ink" : "border-transparent text-ink-3 hover:text-ink")}>
            {o.label}
            {o.count !== undefined && (
              <span className={cx("rounded-full px-[7px] font-mono text-[11px] leading-5 font-semibold", on ? "bg-accent text-surface" : "bg-sunken text-ink-2")}>{o.count.toLocaleString("en-IN")}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ feedback
export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={cx("animate-spin", className)} role="status" aria-label="Loading">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cx("skeleton", className)} />;
}

/** Empty / error / no-access state. Say what is empty and what to do next. */
export function Empty({ icon = "info", title, children, action, className }:
  { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex flex-col items-center px-6 py-10 text-center", className)}>
      <span className="flex size-11 items-center justify-center rounded-full bg-sunken text-ink-3"><Icon name={icon} size={20} /></span>
      <h3 className="mt-3 text-[15px] font-semibold text-ink">{title}</h3>
      {children && <p className="mt-1 max-w-sm text-[13px] text-ink-3">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Inline notice inside a page or form. */
export function Notice({ tone = "accent", title, children, action, className }:
  { tone?: Exclude<Tone, "neutral">; title?: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  const icon: IconName = tone === "bad" || tone === "warn" ? "alert" : tone === "ok" ? "check" : "info";
  return (
    <div role={tone === "bad" ? "alert" : "status"} className={cx("flex items-start gap-3 rounded-lg border px-3.5 py-3 text-[13.5px]", TAG[tone], className)}>
      <Icon name={icon} size={16} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1 text-ink">
        {title && <div className="font-semibold">{title}</div>}
        {children}
      </div>
      {action}
    </div>
  );
}

// ------------------------------------------------------------------ overlays
// open overlays, oldest first: only the top one reacts to Escape / Tab, so a dialog over a drawer closes alone
const overlayStack: object[] = [];

function useOverlay(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose; // callers may pass a new function every render: never a reason to re-run the effect
  useEffect(() => {
    if (!open) return;
    const token = {};
    overlayStack.push(token);
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (overlayStack[overlayStack.length - 1] !== token) return;
      if (e.key === "Escape" && !e.defaultPrevented) { e.stopPropagation(); close.current(); }
      if (e.key !== "Tab" || !ref.current) return;
      const f = ref.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])');
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    queueMicrotask(() => { if (ref.current && !ref.current.contains(document.activeElement)) ref.current.focus(); });
    return () => {
      overlayStack.splice(overlayStack.indexOf(token), 1);
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, [open]);
  return ref;
}

/** Centered modal for a short, focused task. */
export function Dialog({ open, onClose, title, children, footer, width = 480 }:
  { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; width?: number }) {
  const ref = useOverlay(open, onClose);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[rgb(5_10_18/0.45)] backdrop-blur-[2px] p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} style={{ maxWidth: width }}
        className="animate-rise flex max-h-[92dvh] w-full flex-col rounded-t-2xl border border-line bg-surface shadow-pop outline-none sm:rounded-2xl">
        <header className="flex items-center justify-between gap-3 px-6 pt-5 pb-1">
          <h2 className="text-lg font-semibold">{title}</h2>
          <IconButton icon="x" label="Close" onClick={onClose} />
        </header>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 py-4">{children}</div>
        {footer && <footer className="flex flex-wrap items-center justify-end gap-2.5 border-t border-line px-6 py-4">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/** Right-hand sheet for detail that keeps the page behind it in context. */
export function Drawer({ open, onClose, title, subtitle, children, footer, width = 560, headerActions }:
  { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; width?: number; headerActions?: ReactNode }) {
  const ref = useOverlay(open, onClose);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end bg-[rgb(5_10_18/0.42)] p-0 backdrop-blur-[2px] sm:p-3" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" tabIndex={-1} style={{ maxWidth: width }}
        className="animate-slide-in flex h-full w-full flex-col overflow-hidden border border-line bg-surface shadow-pop outline-none sm:rounded-[18px]">
        <header className="flex items-start justify-between gap-3 border-b border-line px-[22px] pt-5 pb-4">
          <div className="min-w-0">
            <h2 className="truncate text-[19px] font-semibold tracking-tight">{title}</h2>
            {subtitle && <div className="mt-0.5 text-[13px] text-ink-3">{subtitle}</div>}
          </div>
          <div className="flex shrink-0 items-center gap-1">{headerActions}<IconButton icon="x" label="Close" onClick={onClose} /></div>
        </header>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-[22px] py-3.5">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, children, confirmLabel, danger, busy }:
  { open: boolean; onClose: () => void; onConfirm: () => void; title: string; children: ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean }) {
  return (
    <Dialog open={open} onClose={onClose} title={title} width={420}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} loading={busy}>{confirmLabel}</Button>
      </>}>
      <div className="text-sm text-ink-2">{children}</div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ Toast
export interface ToastInput { tone?: "success" | "error" | "warning" | "info"; title: string; message?: string }
interface ToastItem extends ToastInput { id: number }
const ToastCtx = createContext<((t: ToastInput) => void) | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const push = useCallback((t: ToastInput) => {
    const id = next.current++;
    setItems((xs) => [...xs.slice(-3), { ...t, id }]);
    window.setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), t.tone === "error" ? 8000 : 4500);
  }, []);
  const tone = (t: ToastItem): [Tone, IconName] =>
    t.tone === "error" ? ["bad", "alert"] : t.tone === "warning" ? ["warn", "alert"] : t.tone === "success" ? ["ok", "check"] : ["accent", "info"];
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {createPortal(
        <div className="no-print pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end" aria-live="polite">
          {items.map((t) => {
            const [tn, ic] = tone(t);
            return (
              <div key={t.id} role={t.tone === "error" ? "alert" : "status"}
                className="animate-rise pointer-events-auto flex w-full max-w-[380px] items-start gap-3 rounded-[14px] border border-line bg-surface px-4 py-3.5 shadow-pop">
                <span className={cx("flex size-8 shrink-0 items-center justify-center rounded-full", TAG[tn])}><Icon name={ic} size={16} /></span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold">{t.title}</div>
                  {t.message && <div className="mt-0.5 text-[13px] break-words text-ink-2">{t.message}</div>}
                </div>
                <IconButton icon="x" label="Dismiss" size={24} onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))} />
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  );
}

export function useToast(): (t: ToastInput) => void {
  const c = useContext(ToastCtx);
  if (!c) throw new Error("useToast must be used inside <ToastProvider>");
  return c;
}
