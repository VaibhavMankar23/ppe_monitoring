import { useEffect, useState } from "react";
import { api, jpegDataUrl } from "../../lib/api";
import { fmtTime, ppeLabel } from "../../lib/format";
import { href } from "../../lib/router";
import { useMonitor } from "../../state/monitor";
import type { StreamInfo, Violation } from "../../types";
import { Badge, Modal, PpeChip, StatusBadge, UnenforcedNote } from "../ui";
import { StreamControls } from "./StreamControls";
import { VideoView } from "./VideoView";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-surface p-3.5">
      <h3 className="mb-2.5 text-xs font-semibold tracking-wide text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

/** Expanded camera view with detailed live stats and this camera's latest stored violations. */
export function DetailView({ stream: s, onClose }: { stream: StreamInfo; onClose: () => void }) {
  const { onViolation, info } = useMonitor();
  const [recent, setRecent] = useState<Violation[] | null>(null);
  const focusPauses = !!info?.focus.enabled;

  // focus mode: hold a lease while this view is open (the server lets it lapse if the tab dies)
  useEffect(() => {
    void api.system.focus(s.id).catch(() => {});
    const t = window.setInterval(() => void api.system.focus(s.id).catch(() => {}), 10_000);
    return () => {
      window.clearInterval(t);
      void api.system.focus(null).catch(() => {});
    };
  }, [s.id]);

  useEffect(() => {
    let alive = true;
    api.violations.list({ camera: s.id, limit: 8 }).then((p) => alive && setRecent(p.items)).catch(() => alive && setRecent([]));
    const off = onViolation((v) => v.stream_id === s.id && setRecent((r) => [v, ...(r ?? [])].slice(0, 8)));
    return () => {
      alive = false;
      off();
    };
  }, [s.id, onViolation]);

  const counts = Object.entries(s.class_counts).sort((a, b) => b[1] - a[1]);
  const maxCount = Math.max(1, ...counts.map(([, n]) => n));
  const people = [...s.people].sort((a, b) => (a.status === b.status ? a.id - b.id : a.status === "non_compliant" ? -1 : 1));

  return (
    <Modal open onClose={onClose} size="xl"
      title={<span className="flex items-center gap-2.5">{s.name}<StatusBadge status={s.status} /></span>}
      subtitle={<>{s.source_type} source · {s.frame_size ? `${s.frame_size[0]}×${s.frame_size[1]}` : "no frames yet"} · priority {s.priority}
        {focusPauses && <span className="text-warning-text"> · focus mode: detection on the other cameras is paused while this view is open</span>}</>}>
      <div className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-3">
          <VideoView stream={s} fps={15} className="aspect-video w-full rounded-lg" />
          <StreamControls stream={s} slider={false} />
          {/* Small secondary telemetry only — full engine/camera health lives in System health. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted tabular-nums">
            <span title="How often the model looks at this camera">
              Processed <span className={`font-mono font-medium ${s.fps >= 5 ? "text-success-text" : s.running ? "text-warning-text" : "text-text"}`}>{s.fps.toFixed(1)} fps</span>
            </span>
            <span aria-hidden className="text-border-strong">·</span>
            <span title="Capture → annotated frame latency">
              Latency <span className="font-mono font-medium text-text">{s.running && s.latency_ms ? `${Math.round(s.latency_ms)} ms` : "—"}</span>
            </span>
            <a href={href("system")} onClick={onClose} className="ml-auto font-medium text-primary hover:underline">Camera telemetry →</a>
          </div>
        </div>
        {/* The rail scrolls inside the modal's video-driven height so the modal stays a consistent
            size regardless of how many workers / violations a camera has (no empty gap, no growth). */}
        <div className="relative min-w-0">
          <div className="flex flex-col gap-3 lg:absolute lg:inset-0 lg:overflow-y-auto lg:pr-1">
          <Section title="Required PPE">
            <div className="flex flex-wrap gap-1.5">{s.required_ppe.map((p) => <PpeChip key={p} item={p} status={s.unenforced?.includes(p) ? "unenforced" : undefined} />)}</div>
            {!!s.unenforced?.length && <UnenforcedNote items={s.unenforced} className="mt-2" />}
          </Section>
          <Section title={`Workers in view (${people.length})`}>
            {people.length === 0 ? <p className="text-[13px] text-muted">No workers detected.</p> : (
              <div className="mb-2.5 flex items-center gap-3 text-xs tabular-nums">
                <span className="text-success-text">{s.compliant} compliant</span>
                <span className={s.violations ? "font-semibold text-danger" : "text-muted"}>{s.violations} violating</span>
                {s.unknown > 0 && <span className="text-warning-text">{s.unknown} uncertain</span>}
              </div>
            )}
            <ul className="flex flex-col gap-2">
              {people.map((p) => (
                <li key={p.id} className="rounded-md border border-border p-2.5">
                  <div className="flex items-center justify-between text-[13px]">
                    <span className="font-semibold">Worker #{p.id}
                      <span className="ml-1.5 font-mono text-[11px] font-normal text-muted" title="Person detection confidence">{Math.round(p.conf * 100)}%</span>
                    </span>
                    <Badge tone={p.status === "compliant" ? "success" : p.status === "non_compliant" ? "danger" : "warning"}>
                      {p.status === "compliant" ? "Compliant" : p.status === "non_compliant" ? "Non-compliant" : "Uncertain"}
                    </Badge>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">{Object.entries(p.items).map(([k, v]) => <PpeChip key={k} item={k} status={v} />)}</div>
                </li>
              ))}
            </ul>
          </Section>
          <Section title="Detections (current frame)">
            {counts.length === 0 && <p className="text-[13px] text-muted">Nothing detected.</p>}
            <ul className="flex flex-col gap-1.5">
              {counts.map(([k, n]) => (
                <li key={k} className="flex items-center gap-2 text-[13px]">
                  <span className={`w-28 shrink-0 truncate ${k.startsWith("no_") ? "text-danger" : "text-text"}`}>
                    {k.startsWith("no_") ? `No ${ppeLabel(k.slice(3)).toLowerCase()}` : k === "person" ? "Person" : ppeLabel(k)}
                  </span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-subtle">
                    <span className={`block h-full rounded-full ${k.startsWith("no_") ? "bg-danger" : k === "person" ? "bg-primary" : "bg-success"}`} style={{ width: `${(n / maxCount) * 100}%` }} />
                  </span>
                  <span className="w-5 text-right font-mono tabular-nums">{n}</span>
                </li>
              ))}
            </ul>
          </Section>
          <Section title="Latest violations">
            {recent === null ? <p className="text-[13px] text-muted">Loading…</p> : recent.length === 0 ? (
              <p className="text-[13px] text-muted">No violations stored for this camera.</p>
            ) : (
              <div className="grid grid-cols-4 gap-2">
                {recent.map((v) => (
                  <figure key={v.id} className="overflow-hidden rounded-md border border-border" title={`#${v.track_id} missing ${v.missing.join(", ")}`}>
                    <img src={jpegDataUrl(v.thumbnail)} alt="" className="aspect-[3/4] w-full bg-subtle object-cover" />
                    <figcaption className="py-0.5 text-center font-mono text-[10px] text-muted">{fmtTime(v.timestamp)}</figcaption>
                  </figure>
                ))}
              </div>
            )}
            <a href={href("violations")} onClick={onClose} className="mt-2.5 inline-block text-[13px] font-medium text-primary hover:underline">All violations →</a>
          </Section>
          </div>
        </div>
      </div>
    </Modal>
  );
}
