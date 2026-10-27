import { useEffect, useRef, useState } from "react";
import { api, ApiError, jpegDataUrl } from "../../lib/api";
import { fmtAgo, fmtTime, ppeLabel, violationLabel } from "../../lib/format";
import { navigateWith } from "../../lib/router";
import { useAuth } from "../../state/auth";
import { useMonitor } from "../../state/monitor";
import type { Person, StreamInfo, Violation } from "../../types";
import { Button, Drawer, Empty, Notice, StatusDot, Switch, Tag, useToast } from "../ui";
import { STATUS } from "./status";
import { CameraVideo, ZONE_STYLE, ZoneOverlay } from "./Video";

const PERSON: Record<Person["status"], { label: string; tone: "ok" | "bad" | "warn" }> = {
  compliant: { label: "Compliant", tone: "ok" },
  non_compliant: { label: "In violation", tone: "bad" },
  unknown: { label: "Not judged", tone: "warn" },
};

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div title={hint}>
      <dt className="eyebrow">{label}</dt>
      <dd className="num mt-0.5 text-sm font-medium">{value}</dd>
    </div>
  );
}

function Recent({ streamId }: { streamId: string }) {
  const { onViolation } = useMonitor();
  const [items, setItems] = useState<Violation[] | null>(null);
  useEffect(() => {
    let alive = true;
    setItems(null);
    api.violations.list({ camera: streamId, limit: 6 }).then((p) => alive && setItems(p.items)).catch(() => alive && setItems([]));
    const off = onViolation((v) => { if (v.stream_id === streamId) setItems((xs) => [v, ...(xs ?? [])].slice(0, 6)); });
    return () => { alive = false; off(); };
  }, [streamId, onViolation]);
  if (items === null) return <div className="skeleton h-16" />;
  if (!items.length) return <p className="text-[13px] text-ink-3">No violations recorded on this camera yet.</p>;
  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {items.map((v) => (
        <li key={v.id}>
          <button type="button" onClick={() => navigateWith("incidents", { id: v.id, review: "" })}
            className="flex w-full items-center gap-2 rounded-md border border-line p-1.5 text-left hover:bg-sunken">
            <img src={jpegDataUrl(v.thumbnail)} alt="" className="h-12 w-9 shrink-0 rounded-sm bg-stage object-cover" />
            <span className="min-w-0">
              <span className="num block text-xs text-ink">{fmtTime(v.timestamp)}</span>
              <span className="block truncate text-xs text-ink-3">{v.missing.map(violationLabel).join(", ")}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** One camera, large: video with zones, who is in view and why they are flagged, and the live controls. */
export function CameraDrawer({ stream: s, onClose }: { stream: StreamInfo | null; onClose: () => void }) {
  const { can } = useAuth();
  const { info, patchStream } = useMonitor();
  const toast = useToast();
  const [zonesOn, setZonesOn] = useState(true);
  const [conf, setConf] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const id = s?.id;
  const control = can("streams:control");
  const focusPauses = !!info?.focus.enabled;

  // focus mode: hold a lease while this view is open (the server lets it lapse if the tab dies)
  useEffect(() => {
    if (!id || !focusPauses) return;
    void api.system.focus(id).catch(() => {});
    const t = window.setInterval(() => void api.system.focus(id).catch(() => {}), 10_000);
    return () => { window.clearInterval(t); void api.system.focus(null).catch(() => {}); };
  }, [id, focusPauses]);

  useEffect(() => { setConf(null); }, [id]);

  if (!s) return null;
  const st = STATUS[s.status];
  const fail = (e: unknown) => toast({ tone: "error", title: "That didn't work", message: e instanceof ApiError ? e.message : String(e) });
  const toggle = async () => {
    setBusy(true);
    try { patchStream(await (s.running ? api.streams.stop(s.id) : api.streams.start(s.id))); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const setBoxes = (show_boxes: boolean) => void api.streams.settings(s.id, { show_boxes }).then(patchStream).catch(fail);
  const onConf = (v: number) => {
    setConf(v);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void api.streams.settings(s.id, { confidence: v }).then(patchStream).catch(fail), 250);
  };
  const shownConf = conf ?? s.confidence;
  const zones = s.zones ?? [];
  const aspect = s.frame_size ? s.frame_size[0] / s.frame_size[1] : 16 / 9;
  const people = [...s.people].sort((a, b) => (a.status === "non_compliant" ? 0 : 1) - (b.status === "non_compliant" ? 0 : 1) || a.id - b.id);

  return (
    <Drawer open onClose={onClose} width={960} title={s.name}
      subtitle={<span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1.5"><StatusDot tone={st.tone} pulse={s.status === "live"} />{st.label}</span>
        <span>· requires {s.required_ppe.map(ppeLabel).join(", ") || "nothing"}</span>
        {focusPauses && <span className="text-warn">· focus mode: detection on other cameras is paused while this is open</span>}
      </span>}
      headerActions={can("config:view") ? <Button size="sm" icon="zone" onClick={() => navigateWith("devices", { camera: s.id })}>Rules and zones</Button> : undefined}>
      <div className="bg-stage">
        {s.running
          ? <CameraVideo fit streamId={s.id} fps={15} aspect={aspect} className="aspect-video max-h-[56dvh] w-full">
              {zonesOn && <ZoneOverlay zones={zones} />}
            </CameraVideo>
          : <div className="flex aspect-video max-h-[56dvh] w-full flex-col items-center justify-center gap-1 text-stage-ink-2">
              <span className="text-sm text-stage-ink">{st.label}</span><span className="text-xs">{s.message || st.help}</span>
            </div>}
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-line px-4 py-3">
        {control && <Button variant={s.running ? "outline" : "primary"} icon={s.running ? "stop" : "play"} loading={busy} onClick={() => void toggle()}>
          {s.running ? "Stop detection" : "Start detection"}
        </Button>}
        <Switch checked={s.show_boxes} onChange={setBoxes} disabled={!control} label="Boxes" />
        {zones.length > 0 && <Switch checked={zonesOn} onChange={setZonesOn} label="Zones" />}
        <label className="flex min-w-56 flex-1 items-center gap-2.5 text-sm">
          <span className="shrink-0" title="Detections below this confidence are ignored. Lower finds more, with more false alarms.">Confidence</span>
          <input type="range" min={0.05} max={0.95} step={0.05} value={shownConf} disabled={!control}
            onChange={(e) => onConf(Number(e.target.value))} className="min-w-0 flex-1 accent-[var(--color-accent)]" />
          <span className="num w-9 text-right">{Math.round(shownConf * 100)}%</span>
        </label>
      </div>

      <div className="space-y-5 px-4 py-4">
        {s.status !== "live" && s.running && <Notice tone="warn" title={st.label}>{s.message || st.help}</Notice>}
        {!!s.unenforced?.length && (
          <Notice tone="warn" title="Some rules are not being checked">
            The loaded model cannot detect: {s.unenforced.map(ppeLabel).join(", ")}. They are listed as required but will never raise a violation.
          </Notice>
        )}

        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-5">
          <Metric label="Detection" value={`${s.fps.toFixed(1)} fps`} hint="Frames analysed per second" />
          <Metric label="Camera" value={`${s.capture_fps.toFixed(1)} fps`} hint="Frames received per second" />
          <Metric label="Model time" value={`${Math.round(s.infer_ms)} ms`} hint={`Time of the last detector call (batch of ${s.batch})`} />
          <Metric label="Delay" value={`${Math.round(s.latency_ms)} ms`} hint="From the frame being captured to its result" />
          <Metric label="Last violation" value={s.last_violation_at ? fmtAgo(s.last_violation_at) : "none"} />
        </dl>

        <section>
          <h3 className="mb-2 flex items-baseline gap-2 text-sm font-semibold">In view now <span className="num text-xs font-normal text-ink-3">{s.people.length}</span></h3>
          {people.length === 0
            ? <p className="text-[13px] text-ink-3">{s.running ? "Nobody is in view." : "Detection is stopped."}</p>
            : <div className="overflow-x-auto rounded-md border border-line">
                <table className="table">
                  <thead><tr><th>Track</th><th>Status</th><th>Checks</th><th>Zone</th></tr></thead>
                  <tbody>
                    {people.map((p) => (
                      <tr key={p.id}>
                        <td className="num">#{p.id}</td>
                        <td><Tag tone={PERSON[p.status].tone}>{PERSON[p.status].label}</Tag></td>
                        <td>
                          {p.monitored === false && p.status === "unknown"
                            ? <span className="text-ink-3">Outside the monitored area</span>
                            : <span className="flex flex-wrap gap-1">
                                {Object.entries(p.items).map(([k, v]) => (
                                  <Tag key={k} tone={v === "missing" ? "bad" : v === "present" ? "ok" : "neutral"}
                                    title={v === "unknown" ? "Can't be judged: body part out of frame, or the worker is too small" : undefined}>
                                    {v === "missing" ? violationLabel(k) : v === "present" ? (k === "restricted_area" ? "Outside restricted areas" : k === "phone_use" ? "No phone" : ppeLabel(k)) : `${ppeLabel(k)}?`}
                                  </Tag>
                                ))}
                              </span>}
                        </td>
                        <td className="text-ink-2">{p.zone ?? "–"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>}
        </section>

        <section>
          <h3 className="mb-2 text-sm font-semibold">Zones</h3>
          {zones.length === 0
            ? <Empty icon="zone" title="The whole frame is monitored" className="rounded-md border border-dashed border-line-strong py-6"
                action={can("config:cameras") ? <Button size="sm" icon="zone" onClick={() => navigateWith("devices", { camera: s.id, tab: "zones" })}>Draw zones</Button> : undefined}>
                Draw zones to check PPE only where it is required, skip walkways, or flag anyone entering a restricted area.
              </Empty>
            : <ul className="flex flex-wrap gap-2">
                {zones.map((z) => (
                  <li key={z.name} className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[13px]" title={ZONE_STYLE[z.type].help}>
                    <span className="size-2.5 rounded-sm" style={{ background: ZONE_STYLE[z.type].stroke }} />
                    {z.name} <span className="text-ink-3">· {ZONE_STYLE[z.type].label}</span>
                  </li>
                ))}
              </ul>}
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Latest violations here</h3>
            <Button size="sm" variant="ghost" onClick={() => navigateWith("incidents", { camera: s.id, review: "unreviewed" })}>Review this camera</Button>
          </div>
          <Recent streamId={s.id} />
        </section>
      </div>
    </Drawer>
  );
}
