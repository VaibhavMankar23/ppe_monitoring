import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./Button";
import { Icon } from "./Icons";

const WIDTHS = { sm: "max-w-md", md: "max-w-xl", lg: "max-w-3xl", xl: "max-w-6xl" };

interface Props {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  size?: keyof typeof WIDTHS;
  footer?: ReactNode;
  children: ReactNode;
  /** extra keyboard handling (arrow keys etc.); Esc is always handled */
  onKeyDown?: (e: KeyboardEvent) => void;
}

/** Accessible modal: Esc and backdrop close it, focus moves in and is restored on close, body scroll locks. */
export function Modal({ open, onClose, title, subtitle, size = "md", footer, children, onKeyDown }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const keyRef = useRef(onKeyDown);
  keyRef.current = onKeyDown;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key === "Tab" && panel.current) {
        // keep focus inside the dialog
        const f = panel.current.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])');
        if (f.length) {
          const first = f[0], last = f[f.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }
      keyRef.current?.(e);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={`flex max-h-[calc(100vh-2rem)] w-full ${WIDTHS[size]} flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-pop)] outline-none`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">{title}</h2>
            {subtitle && <div className="mt-0.5 text-[13px] text-muted">{subtitle}</div>}
          </div>
          <IconButton label="Close (Esc)" size="sm" onClick={onClose}>
            <Icon.close />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-subtle/60 px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Small confirm dialog built on Modal. */
export function ConfirmModal({ open, title, message, confirmLabel = "Confirm", danger, busy, onConfirm, onCancel }: {
  open: boolean; title: string; message: ReactNode; confirmLabel?: string; danger?: boolean; busy?: boolean;
  onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Modal open={open} onClose={onCancel} title={title} size="sm"
      footer={<>
        <button type="button" className="h-9 rounded-lg border border-border bg-surface px-3.5 text-sm font-medium hover:bg-subtle" onClick={onCancel}>Cancel</button>
        <button type="button" disabled={busy} onClick={onConfirm}
          className={`h-9 rounded-lg px-3.5 text-sm font-medium disabled:opacity-50 ${danger ? "bg-danger text-white hover:bg-danger-hover" : "bg-primary text-on-primary hover:bg-primary-hover"}`}>
          {busy ? "Working…" : confirmLabel}
        </button>
      </>}>
      <div className="px-5 py-4 text-sm text-muted">{message}</div>
    </Modal>
  );
}
