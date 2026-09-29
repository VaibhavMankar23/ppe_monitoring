import { useEffect, useState } from "react";
import { api, jpegDataUrl } from "../../lib/api";
import { isBehavior } from "../../lib/format";
import { href } from "../../lib/router";
import { useMonitor } from "../../state/monitor";
import type { Violation } from "../../types";
import { Card, EmptyState, Icon, PpeChip, Skeleton } from "../ui";

const ago = (ts: number) => {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

/**
 * Incident-first action list: the most recent violations across all cameras, so the
 * operator sees *what to act on* before the camera wall. Fed by the same live violation
 * stream as the Violations page (no new data); clicking opens that camera's live view.
 */
export function ActiveIncidents({ onOpenCamera }: { onOpenCamera: (streamId: string) => void }) {
  const { onViolation } = useMonitor();
  const [items, setItems] = useState<Violation[] | null>(null);

  useEffect(() => {
    let alive = true;
    api.violations.list({ limit: 6 }).then((p) => alive && setItems(p.items)).catch(() => alive && setItems([]));
    const off = onViolation((v) => setItems((xs) => {
      const base = xs ?? [];
      return base.some((x) => x.id === v.id) ? base : [v, ...base].slice(0, 6);
    }));
    return () => { alive = false; off(); };
  }, [onViolation]);

  return (
    <Card className="mb-5 overflow-hidden">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <span className="h-2 w-2 shrink-0 rounded-full bg-danger" aria-hidden />
        <h2 className="text-[15px] font-semibold">Active incidents</h2>
        <span className="ml-auto rounded-full border border-border bg-subtle px-2 py-0.5 text-xs font-medium text-muted">Live queue</span>
      </div>

      {items === null ? (
        <div className="flex flex-col">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-0">
              <Skeleton className="h-16 w-[52px] rounded-md" />
              <div className="flex-1"><Skeleton className="h-4 w-40" /><Skeleton className="mt-2 h-4 w-28" /></div>
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={<Icon.shield size={20} />} title="No active violations" message="Every monitored area is currently clear." />
      ) : (
        <ul>
          {items.map((v) => {
            const crit = v.missing.some((m) => !isBehavior(m)); // any missing-PPE gap = critical; behaviour-only = review
            return (
              <li key={v.id}>
                <button type="button" onClick={() => onOpenCamera(v.stream_id)}
                  aria-label={`Open ${v.stream_name} — worker ${v.track_id}, missing ${v.missing.join(", ")}`}
                  className="flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left transition-colors last:border-0 hover:bg-subtle">
                  <span className={`h-12 w-1 shrink-0 rounded ${crit ? "bg-danger" : "bg-warning"}`} aria-hidden />
                  {v.thumbnail
                    ? <img src={jpegDataUrl(v.thumbnail)} alt="" className="h-16 w-[52px] shrink-0 rounded-md border border-border object-cover" />
                    : <span className="grid h-16 w-[52px] shrink-0 place-items-center rounded-md border border-border bg-subtle"><Icon.image size={18} className="text-muted" /></span>}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{v.stream_name} <span className="font-normal text-muted">· Worker #{v.track_id}</span></p>
                    <div className="mt-1.5 flex flex-wrap gap-1">{v.missing.map((m) => <PpeChip key={m} item={m} status="missing" />)}</div>
                  </div>
                  <span className="hidden shrink-0 font-mono text-xs text-muted tabular-nums sm:block">{ago(v.timestamp)}</span>
                  <Icon.chevronRight size={16} className="shrink-0 text-muted" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="border-t border-border px-4 py-2.5">
        <a href={href("violations")} className="inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline">
          Review all evidence <Icon.chevronRight size={14} />
        </a>
      </div>
    </Card>
  );
}
