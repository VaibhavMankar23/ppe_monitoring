import type { ReactNode } from "react";
import type { ItemStatus, StreamStatus } from "../../types";
import { ppeLabel, isBehavior } from "../../lib/format";
import { Icon } from "./Icons";

export type Tone = "neutral" | "primary" | "success" | "danger" | "warning";

const TONES: Record<Tone, string> = {
  neutral: "bg-subtle text-muted border-border",
  primary: "bg-primary-soft text-primary border-primary/25",
  success: "bg-success-soft text-success-text border-success/25",
  danger: "bg-danger-soft text-danger border-danger/25",
  warning: "bg-warning-soft text-warning-text border-warning/25",
};
const DOTS: Record<Tone, string> = {
  neutral: "bg-muted",
  primary: "bg-primary",
  success: "bg-success",
  danger: "bg-danger",
  warning: "bg-warning",
};

export function Badge({ tone = "neutral", dot, pulse, children, className = "" }: { tone?: Tone; dot?: boolean; pulse?: boolean; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${TONES[tone]} ${className}`}>
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${DOTS[tone]} ${pulse ? "animate-pulse" : ""}`} aria-hidden />}
      {children}
    </span>
  );
}

const STATUS: Record<StreamStatus, { label: string; tone: Tone; pulse?: boolean }> = {
  live: { label: "Live", tone: "success", pulse: true },
  connecting: { label: "Connecting", tone: "primary", pulse: true },
  reconnecting: { label: "Reconnecting", tone: "warning", pulse: true },
  stalled: { label: "Stalled", tone: "warning" },
  offline: { label: "Offline", tone: "danger" },
  no_source: { label: "No signal", tone: "neutral" },
  error: { label: "Error", tone: "danger" },
  stopped: { label: "Stopped", tone: "neutral" },
};

export function StatusBadge({ status }: { status: StreamStatus }) {
  const s = STATUS[status] ?? STATUS.error;
  return <Badge tone={s.tone} dot pulse={s.pulse}>{s.label}</Badge>;
}

/** PPE item chip: required (neutral), present (✓), missing (✗) or unknown (?).
 *  Behavioural items (e.g. phone use) are shown distinctly — a warning-tone 📱 chip, since their
 *  "missing" status means the offending behaviour is present, not that PPE is absent. */
export function PpeChip({ item, status }: { item: string; status?: ItemStatus | "required" | "unenforced" }) {
  if (status === "unenforced") {
    // Required, but the loaded model can't detect it — a configuration limit, not a fault.
    // A calm "not watched" chip (muted, eye-off, subtle strikethrough), never an alarm.
    return (
      <span title="Required, but not checked — the current model can't detect this item.">
        <Badge tone="neutral" className="text-muted"><Icon.eyeOff size={11} aria-hidden /><span className="line-through decoration-border-strong decoration-1">{ppeLabel(item)}</span></Badge>
      </span>
    );
  }
  if (isBehavior(item)) {
    const on = status === "missing";  // "missing" = behaviour detected (a violation)
    return <Badge tone={on ? "warning" : "neutral"}>📱 {ppeLabel(item)}</Badge>;
  }
  const map = { present: ["success", "✓ "], missing: ["danger", "✗ "], unknown: ["neutral", "? "], required: ["neutral", ""] } as const;
  const [tone, prefix] = map[status ?? "required"];
  return <Badge tone={tone}>{prefix}{ppeLabel(item)}</Badge>;
}

/** Shared advisory: an informational note (never an error), for configuration limits like
 *  "not checked by the current model". Neutral tone, an "eye-off" (not-watched) icon, optional bold lead. */
export function Advisory({ title, children, icon, className = "" }: { title?: ReactNode; children: ReactNode; icon?: ReactNode; className?: string }) {
  return (
    <div role="note" className={`flex gap-2 rounded-lg border border-border bg-subtle px-3 py-2 text-xs text-muted ${className}`}>
      <span className="mt-px shrink-0" aria-hidden>{icon ?? <Icon.eyeOff size={14} />}</span>
      <p>{title && <span className="font-medium text-text">{title} </span>}{children}</p>
    </div>
  );
}

/** Advisory (not an error): required PPE the loaded model can't detect, so it isn't being checked. */
export function UnenforcedNote({ items, className = "" }: { items: string[]; className?: string }) {
  if (!items.length) return null;
  const it = items.length === 1 ? "it" : "them";
  return (
    <Advisory title="Required, but not checked." className={className}>
      The current model can’t detect {items.map(ppeLabel).join(", ")}, so no violation is raised for {it}. To enforce {it}, set a model that detects {it} in Configuration → Model settings — or remove {it} from required PPE.
    </Advisory>
  );
}
