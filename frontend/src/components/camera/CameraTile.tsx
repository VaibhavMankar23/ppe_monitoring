import type { StreamInfo } from "../../types";
import { Card, Icon, IconButton, PpeChip, StatusBadge } from "../ui";
import { StreamControls } from "./StreamControls";
import { VideoView } from "./VideoView";

function Stat({ label, value, tone = "text-text" }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="px-3 py-2.5">
      <p className="text-[11px] font-medium tracking-wide text-muted uppercase">{label}</p>
      <p className={`mt-0.5 font-mono text-base font-semibold tabular-nums ${tone}`}>{value}</p>
    </div>
  );
}

/** One camera: header (name, status, FPS), live video, footer (workers, violations, latency), controls.
 * `dense` (12+ tiles per page): the essentials only; controls stay one click away in the detail view. */
export function CameraTile({ stream: s, expanded, onExpand, dense = false }: { stream: StreamInfo; expanded: boolean; onExpand: () => void; dense?: boolean }) {
  const alarm = s.running && s.violations > 0;
  if (dense) {
    return (
      <Card className={`flex min-w-0 flex-col overflow-hidden ${alarm ? "border-danger/60 ring-2 ring-danger/25" : ""}`} aria-label={s.name}>
        <button type="button" onClick={onExpand} className="group relative block aspect-video w-full cursor-zoom-in" aria-label={`Open ${s.name} in detail view`}>
          {expanded ? <div className="flex h-full items-center justify-center bg-video text-xs text-slate-400">Open in detail view</div>
            : <VideoView stream={s} fps={4} fit="cover" className="h-full w-full" />}
        </button>
        <div className="flex items-center gap-2 px-2.5 py-2">
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold" title={s.name}>{s.name}</h2>
          <StatusBadge status={s.status} />
        </div>
        <div className="flex items-center gap-3 border-t border-border px-2.5 py-1.5 text-xs tabular-nums text-muted">
          <span title="Workers in view">{s.workers} <span className="text-[11px]">wkr</span></span>
          <span className={s.violations ? "font-semibold text-danger" : ""} title="Non-compliant now">{s.violations} <span className="text-[11px]">viol</span></span>
          <span className="ml-auto font-mono" title="Detection frames per second">{s.fps.toFixed(1)} fps</span>
        </div>
      </Card>
    );
  }
  return (
    <Card className={`flex min-w-0 flex-col overflow-hidden transition-shadow ${alarm ? "border-danger/60 ring-2 ring-danger/25" : ""}`} aria-label={s.name}>
      <div className="flex items-center gap-2.5 px-4 py-3">
        <h2 className="truncate text-sm font-semibold">{s.name}</h2>
        <StatusBadge status={s.status} />
        <span className="ml-auto font-mono text-xs text-muted tabular-nums" title="Processed frames per second">
          {s.fps.toFixed(1)} fps
        </span>
        <IconButton label={`Expand ${s.name}`} size="sm" onClick={onExpand}><Icon.expand /></IconButton>
      </div>

      <button type="button" onClick={onExpand} className="group relative block aspect-video w-full cursor-zoom-in" aria-label={`Open ${s.name} in detail view`}>
        {expanded ? (
          <div className="flex h-full items-center justify-center bg-video text-xs text-slate-400">Open in detail view</div>
        ) : (
          <VideoView stream={s} fit="cover" className="h-full w-full" />
        )}
      </button>

      {/* Primary at-a-glance safety signals only; fps sits quietly in the header and
          latency / engine telemetry live in Camera detail and System health. */}
      <div className="grid grid-cols-2 divide-x divide-border border-t border-border">
        <Stat label="Workers" value={s.workers} />
        <Stat label="Violations" value={s.violations} tone={s.violations ? "text-danger" : "text-text"} />
      </div>

      <div className="flex flex-col gap-2.5 border-t border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] font-medium tracking-wide text-muted uppercase">Required</span>
          {s.required_ppe.map((p) => <PpeChip key={p} item={p} status={s.unenforced?.includes(p) ? "unenforced" : undefined} />)}
        </div>
        <StreamControls stream={s} compact slider={false} />
      </div>
    </Card>
  );
}
