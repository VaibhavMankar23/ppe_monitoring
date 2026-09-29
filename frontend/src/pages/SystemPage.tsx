import { useCallback, useEffect, useState } from "react";
import { PageBody } from "../components/layout/PageBody";
import { Topbar } from "../components/layout/Topbar";
import { Badge, Button, Card, CardHeader, EmptyState, Icon, Skeleton, StatusBadge, type Tone } from "../components/ui";
import { api } from "../lib/api";
import type { SystemHealth } from "../types";

const REFRESH_MS = 3000;

function Meter({ label, value, sub, warnAt = 0.7, badAt = 0.9 }: { label: string; value: number | null | undefined; sub?: string; warnAt?: number; badAt?: number }) {
  const v = value == null ? null : Math.max(0, Math.min(1, value));
  const tone = v == null ? "bg-border-strong" : v >= badAt ? "bg-danger" : v >= warnAt ? "bg-warning" : "bg-success";
  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[13px] font-medium text-muted">{label}</p>
        <p className="text-xl font-semibold">{v == null ? "—" : `${Math.round(v * 100)}%`}</p>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-subtle" role="meter" aria-label={label} aria-valuenow={v == null ? undefined : Math.round(v * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${(v ?? 0) * 100}%` }} />
      </div>
      {sub && <p className="text-xs text-muted">{sub}</p>}
    </Card>
  );
}

const STATE: Record<SystemHealth["capacity"]["state"], { tone: Tone; label: string; hint: string }> = {
  ok: { tone: "success", label: "Capacity OK", hint: "The model has spare time: more cameras or a higher frame rate would fit." },
  busy: { tone: "warning", label: "Busy", hint: "Above 70 % busy. A few more cameras will start lowering everyone's detection rate." },
  saturated: {
    tone: "danger", label: "Saturated",
    hint: "The model is busy nearly all the time: every extra camera now lowers the detection rate of all of them. Set less important cameras to low priority, raise frame skip, or add a GPU.",
  },
};

const fmtUptime = (s: number) => `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;

/** "4 s ago" / "12 min ago" for an epoch-seconds time; "—" when it never happened. */
function ago(t: number | null | undefined): string {
  if (!t) return "—";
  const d = Math.max(0, Date.now() / 1000 - t);
  return d < 60 ? `${Math.round(d)} s ago` : d < 3600 ? `${Math.round(d / 60)} min ago` : d < 86400 ? `${Math.round(d / 3600)} h ago` : `${Math.round(d / 86400)} d ago`;
}
const stale = (t: number | null | undefined, s: number) => !t || Date.now() / 1000 - t > s;

export function SystemPage() {
  const [h, setH] = useState<SystemHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One-off fetch for the manual "Try again" action (the effect below keeps it fresh on a timer).
  const load = useCallback(() => {
    api.system.health().then((x) => { setH(x); setError(null); }).catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = () => api.system.health().then((x) => { if (alive) { setH(x); setError(null); } }).catch((e) => alive && setError((e as Error).message));
    tick();
    const t = window.setInterval(tick, REFRESH_MS);
    return () => { alive = false; window.clearInterval(t); };
  }, []);

  const eng = h?.engines[0];
  const state = h ? STATE[h.capacity.state] : null;
  const cams = h ? [...h.cameras].sort((a, b) => Number(b.running) - Number(a.running) || a.fps - b.fps) : [];

  return (
    <>
      <Topbar title="System health" subtitle={h ? `Model on ${h.device} · ${h.mode} engine · up ${fmtUptime(h.uptime_s)} · refreshes every 3 s` : "Loading…"}
        extra={state && <Badge tone={state.tone} dot>{state.label}</Badge>} />
      <PageBody>
        {error && !h ? (
          <Card><EmptyState icon={<Icon.alert size={20} />} title="Couldn't load system health" message={error} action={<Button onClick={load}>Try again</Button>} /></Card>
        ) : !h ? (
          <div className="grid gap-4 md:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}</div>
        ) : (
          <div className="flex flex-col gap-6">
            {state && h.capacity.state !== "ok" && (
              <div role="status" className={`rounded-xl border px-4 py-3 text-[13px] ${h.capacity.state === "saturated" ? "border-danger/30 bg-danger-soft text-danger" : "border-warning/30 bg-warning-soft text-warning-text"}`}>
                <b>{state.label}.</b> {state.hint}
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Meter label="Model engine busy" value={h.capacity.engine_utilization}
                sub={eng ? `${eng.frames_per_s} frames/s in ${eng.calls_per_s} calls/s · avg batch ${eng.avg_batch} · ${eng.avg_call_ms} ms/call` : undefined} />
              <Meter label="Host CPU" value={h.host.cpu_percent != null ? h.host.cpu_percent / 100 : null}
                sub={h.host.process_cpu_percent != null ? `this app ${h.host.process_cpu_percent}% of ${h.host.cpu_count} cores · video decoding counts here` : undefined} />
              <Meter label="Host memory" value={h.host.memory_percent != null ? h.host.memory_percent / 100 : null} warnAt={0.8} badAt={0.92}
                sub={h.host.process_rss_mb != null ? `this app ${h.host.process_rss_mb} MB` : undefined} />
              <Card className="flex flex-col gap-1 p-4 text-[13px]">
                <p className="font-medium text-muted">Pipeline</p>
                <p><span className="font-semibold">{h.cameras.filter((c) => c.running).length}</span> of {h.cameras.length} cameras running</p>
                <p>{h.post_workers} post-processing workers · {h.host.threads ?? "?"} threads</p>
                <p>Max batch {eng?.max_batch ?? "—"}{eng?.padded_batches ? " (padded for the GPU)" : ""}</p>
                <p>{h.focus.enabled ? (h.focus.stream_id ? `Focus mode: ${h.focus.paused.length} camera(s) paused` : "Focus mode on (idle)") : "Focus mode off: all cameras always live"}</p>
              </Card>
            </div>

            <Card>
              <CardHeader title="Cameras" description="Detection FPS is how often the model looks at a camera. Dropped frames are stale frames skipped on purpose (never queued), so a high drop rate is normal for fast sources; reconnects and errors are not." />
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1040px] text-left text-[13px]">
                  <thead className="bg-subtle text-xs text-muted uppercase">
                    <tr>
                      <th className="px-5 py-2.5 font-medium">Camera</th>
                      <th className="px-3 py-2.5 font-medium">Status</th>
                      <th className="px-3 py-2.5 text-right font-medium">Detection fps</th>
                      <th className="px-3 py-2.5 text-right font-medium">Capture / source fps</th>
                      <th className="px-3 py-2.5 text-right font-medium">Latency</th>
                      <th className="px-3 py-2.5 text-right font-medium">Dropped</th>
                      <th className="px-3 py-2.5 text-right font-medium">Reconnects</th>
                      <th className="px-3 py-2.5 text-right font-medium" title="Last frame received from the camera">Last frame</th>
                      <th className="px-3 py-2.5 text-right font-medium" title="Last frame the model finished analysing">Last detection</th>
                      <th className="px-3 py-2.5 text-right font-medium">Last violation</th>
                      <th className="px-5 py-2.5 font-medium">Last problem</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border tabular-nums">
                    {cams.map((c) => (
                      <tr key={c.id} className={c.running ? "" : "text-muted"}>
                        <td className="px-5 py-2.5">
                          <span className="font-medium text-text">{c.name}</span>
                          <span className="ml-1.5 text-xs text-muted">{c.source_type} · {c.priority}{c.paused ? " · paused" : ""}</span>
                        </td>
                        <td className="px-3 py-2.5"><StatusBadge status={c.status} /></td>
                        <td className={`px-3 py-2.5 text-right font-mono ${c.running && c.fps < 1 ? "text-danger" : c.running && c.fps < 3 ? "text-warning-text" : ""}`}>{c.fps.toFixed(1)}</td>
                        <td className="px-3 py-2.5 text-right font-mono">{c.capture_fps.toFixed(1)} / {c.source_fps ? c.source_fps.toFixed(0) : "?"}</td>
                        <td className="px-3 py-2.5 text-right font-mono">{c.running && c.latency_ms ? `${Math.round(c.latency_ms)} ms` : "—"}</td>
                        <td className="px-3 py-2.5 text-right font-mono" title={`${c.dropped} of ${c.captured} captured`}>{Math.round(c.drop_rate * 100)}%</td>
                        <td className={`px-3 py-2.5 text-right font-mono ${c.reconnects ? "text-warning-text" : ""}`}>{c.reconnects}</td>
                        <td className={`px-3 py-2.5 text-right font-mono ${c.running && stale(c.last_frame_at, 10) ? "text-danger" : ""}`}>{ago(c.last_frame_at)}</td>
                        <td className={`px-3 py-2.5 text-right font-mono ${c.running && stale(c.last_detection_at, 30) ? "text-warning-text" : ""}`}>{ago(c.last_detection_at)}</td>
                        <td className="px-3 py-2.5 text-right font-mono">{ago(c.last_violation_at)}</td>
                        <td className="max-w-[280px] truncate px-5 py-2.5 text-xs text-muted" title={c.last_error || c.message}>{c.last_error || c.message || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        )}
      </PageBody>
    </>
  );
}
