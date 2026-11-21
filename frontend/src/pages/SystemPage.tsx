import { sortCameras } from "../lib/cameras";
import { useCallback, useEffect, useRef, useState } from "react";
import { Page } from "../components/layout/Shell";
import { Button, cx, Empty, Notice, Panel, PanelHeader, Segmented, Skeleton, Stat, StatusDot, Tag, type Tone } from "../components/ui";
import { api } from "../lib/api";
import { fmtAgo, fmtDuration, fmtInt } from "../lib/format";
import { navigate } from "../lib/router";
import type { CameraHealth, PassSummary, StreamStatus, SystemHealth } from "../types";

const POLL_MS = 2000;
const HISTORY = 60; // samples kept for the sparklines (about two minutes)

type CapacityState = SystemHealth["capacity"]["state"];
const CAPACITY: Record<CapacityState, { tone: Tone; tag: string; verdict: string; advice: string }> = {
  ok: {
    tone: "ok", tag: "OK", verdict: "Keeping up",
    advice: "The detector has spare time. Another camera or a higher frame rate would still fit.",
  },
  busy: {
    tone: "warn", tag: "Busy", verdict: "Close to its limit",
    advice: "The detector is busy more than 70% of the time. Adding cameras now will lower the detection rate of every camera, so check Max FPS per camera in Settings → Performance first.",
  },
  saturated: {
    tone: "bad", tag: "Saturated", verdict: "Overloaded: cameras are waiting for the detector",
    advice: "Lower Max FPS per camera or the image size in Settings → Performance, set less important cameras to low priority, or move detection to a GPU.",
  },
};

const STATUS: Record<StreamStatus, { tone: Tone; label: string; rank: number }> = {
  error: { tone: "bad", label: "Error", rank: 0 },
  offline: { tone: "bad", label: "Offline", rank: 0 },
  stalled: { tone: "bad", label: "Stalled", rank: 0 },
  no_source: { tone: "bad", label: "No source", rank: 0 },
  reconnecting: { tone: "warn", label: "Reconnecting", rank: 1 },
  connecting: { tone: "warn", label: "Connecting", rank: 1 },
  live: { tone: "ok", label: "Live", rank: 2 },
  stopped: { tone: "neutral", label: "Stopped", rank: 3 },
};
const statusOf = (s: StreamStatus) => STATUS[s] ?? { tone: "neutral" as Tone, label: s, rank: 3 };

const TEXT: Record<Tone, string> = { neutral: "", accent: "text-accent", ok: "text-ok", warn: "text-warn", bad: "text-bad" };
const FILL: Record<Tone, string> = { neutral: "bg-ink-3", accent: "bg-accent", ok: "bg-ok", warn: "bg-warn", bad: "bg-bad" };

const dash = "–";
const pct = (v: number | undefined) => (v == null ? dash : v.toFixed(0));
const loadTone = (v: number | undefined, warnAt: number, badAt: number): Tone | undefined =>
  v == null ? undefined : v >= badAt ? "bad" : v >= warnAt ? "warn" : undefined;

/** Tiny trend line on a fixed 0..max scale: no axes, the Stat above it carries the current value. */
function Sparkline({ values, max = 100, label }: { values: number[]; max?: number; label: string }) {
  const W = 120, H = 24;
  if (values.length < 2) return <div className="mt-2 h-6 text-xs text-ink-3">Collecting samples…</div>;
  const step = W / (HISTORY - 1);
  const x0 = W - (values.length - 1) * step; // newest sample sits at the right edge
  const points = values.map((v, i) => `${(x0 + i * step).toFixed(1)},${(H - 1 - (Math.max(0, Math.min(max, v)) / max) * (H - 2)).toFixed(1)}`).join(" ");
  const lo = Math.min(...values), hi = Math.max(...values);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" className="mt-2 block max-w-full text-accent"
      aria-label={`${label} over the last ${Math.round((values.length * POLL_MS) / 1000)} s: between ${lo.toFixed(0)}% and ${hi.toFixed(0)}%`}>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Engine utilisation bar with the 70% (busy) and 90% (saturated) thresholds marked. */
function UtilisationMeter({ value }: { value: number }) {
  const v = Math.max(0, Math.min(1, value));
  const tone: Tone = v >= 0.9 ? "bad" : v >= 0.7 ? "warn" : "ok";
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="font-medium text-ink">Detection engine utilisation</span>
        <span className={cx("num text-sm font-semibold", TEXT[tone])}>{Math.round(v * 100)}%</span>
      </div>
      <div className="relative mt-2">
        <div role="meter" aria-label="Detection engine utilisation" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)}
          className="h-2.5 overflow-hidden rounded-full bg-sunken">
          <div className={cx("h-full rounded-full transition-[width] duration-500", FILL[tone])} style={{ width: `${v * 100}%` }} />
        </div>
        {[70, 90].map((t) => <span key={t} aria-hidden="true" className="absolute -top-1 h-4.5 w-px bg-ink-2" style={{ left: `${t}%` }} />)}
      </div>
      <div className="num relative mt-1 h-4 text-[11px] text-ink-3" aria-hidden="true">
        <span className="absolute left-0">0</span>
        <span className="absolute -translate-x-1/2" style={{ left: "70%" }}>70</span>
        <span className="absolute -translate-x-1/2" style={{ left: "90%" }}>90</span>
      </div>
      <p className="text-xs text-ink-3">Share of time the detector is busy. Above 70% is busy, above 90% cameras start to wait.</p>
    </div>
  );
}

/** Plant roll-out size the planner checks against (minimum and full build-out). */
const PLANT_CAMERAS = [30, 45];
const HEADROOM = 0.7; // plan to keep the detector at most 70% busy (the "busy" line on the meter)
type PlanRate = "1" | "2" | "3" | "5";

/**
 * "Will N cameras fit on this server?" from what the detector actually costs right now: its time
 * per analysed frame (person crops and CPU contention included) gives the frames/s it could do
 * at 100% busy. Decoding is not counted separately; it shows up as CPU load in Host.
 */
function CapacityPlanner({ engines, cameras, maxFps }: { engines: SystemHealth["engines"]; cameras: number; maxFps?: number }) {
  const [rate, setRate] = useState<PlanRate>("2");
  const measured = engines.filter((e) => (e.ms_per_frame ?? 0) > 0 && e.frames_per_s > 0);
  const ceiling = measured.reduce((s, e) => s + 1000 / (e.ms_per_frame as number), 0); // frames/s at 100% busy
  const fps = Number(rate);
  const fits = Math.floor((ceiling * HEADROOM) / fps);
  const msPerFrame = measured.length ? 1000 / ceiling : 0;
  return (
    <Panel>
      <PanelHeader title="Capacity planner"
        hint={`How many cameras this server can check, measured from the detector's real cost per frame. Planned with ${Math.round((1 - HEADROOM) * 100)}% headroom.`}
        actions={<Segmented size="sm" label="Detection rate per camera" value={rate} onChange={setRate}
          options={(["1", "2", "3", "5"] as PlanRate[]).map((v) => ({ value: v, label: `${v} fps` }))} />} />
      {measured.length === 0 ? (
        <p className="p-4 text-[13px] text-ink-3">Measuring… start at least one camera and wait a few seconds.</p>
      ) : (
        <div className="grid gap-x-6 gap-y-5 p-4 sm:grid-cols-2 lg:grid-cols-[repeat(2,minmax(0,0.8fr))_minmax(0,1.6fr)]">
          <Stat label="Detector cost" value={msPerFrame.toFixed(0)} unit="ms / frame"
            hint={`About ${ceiling.toFixed(1)} frames/s at full load, on ${measured.map((e) => e.device).join(", ")}`} />
          <Stat label={`Cameras at ${fps} fps`} value={fmtInt(fits)} tone={fits < PLANT_CAMERAS[0] ? "bad" : undefined}
            hint={<>You run {cameras} now{maxFps ? `, set to at most ${maxFps} fps each` : ""}</>} />
          <ul className="grid gap-2">
            {PLANT_CAMERAS.map((n) => {
              const need = n * fps;
              const ok = need <= ceiling * HEADROOM;
              const factor = need / (ceiling * HEADROOM);
              return (
                <li key={n} className="flex items-start gap-2.5 text-[13px]">
                  <StatusDot tone={ok ? "ok" : "bad"} />
                  <span className="min-w-0">
                    <span className="font-semibold text-ink">{n} cameras</span>
                    <span className="text-ink-2"> need {fmtInt(need)} frames/s: </span>
                    {ok ? <span className="text-ok">fits on this server.</span>
                      : <span className="text-bad">about {factor < 10 ? factor.toFixed(1) : Math.round(factor)}× what this server can do.</span>}
                  </span>
                </li>
              );
            })}
            {fits < PLANT_CAMERAS[PLANT_CAMERAS.length - 1] && (
              <li className="text-xs text-ink-3">
                Options: an NVIDIA GPU (detected and used automatically), more servers each taking a share of the cameras,
                the cameras' sub-stream instead of the main stream, or a lower rate (PPE checks rarely need more than 2 fps).
              </li>
            )}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function Ago({ at, now, tone }: { at: number | null | undefined; now: number; tone?: Tone }) {
  if (!at) return <span className="text-ink-3">Never</span>;
  return <span className={cx("num", tone && TEXT[tone])}>{fmtAgo(at, now)}</span>;
}

function CameraRow({ c, now }: { c: CameraHealth; now: number }) {
  const st = statusOf(c.status);
  const active = c.running && !c.paused;
  const latencyTone: Tone | undefined = !active ? undefined : c.latency_ms > 3000 ? "bad" : c.latency_ms > 1000 ? "warn" : undefined;
  const fpsTone: Tone | undefined = !active || c.status !== "live" ? undefined : c.fps < 1 ? "bad" : undefined;
  const frameTone: Tone | undefined = active && (!c.last_frame_at || now - c.last_frame_at > 10) ? "bad" : undefined;
  const problem = c.last_error || (st.rank < 2 ? c.message : "");
  return (
    <tr>
      <td>
        <div className="font-medium whitespace-nowrap text-ink">{c.name}</div>
        <div className="text-xs whitespace-nowrap text-ink-3">
          {c.source_type} · {c.priority} priority{c.paused ? " · paused by focus mode" : ""}{!c.enabled ? " · disabled" : ""}
        </div>
      </td>
      <td>
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title={c.message || undefined}>
          <StatusDot tone={st.tone} pulse={c.status === "live"} />{st.label}
        </span>
      </td>
      <td className="num text-right whitespace-nowrap">
        <span className={cx(fpsTone && TEXT[fpsTone])}>{c.fps.toFixed(1)}</span>
        <span className="text-ink-3"> / {c.source_fps ? c.source_fps.toFixed(0) : "?"}</span>
      </td>
      <td className="num text-right">{c.capture_fps.toFixed(1)}</td>
      <td className={cx("num text-right whitespace-nowrap", latencyTone && TEXT[latencyTone])}>
        {active && c.latency_ms ? `${fmtInt(Math.round(c.latency_ms))} ms` : dash}
        {latencyTone && <span className="sr-only"> ({latencyTone === "bad" ? "very high" : "high"})</span>}
      </td>
      <td className="num text-right whitespace-nowrap" title={`${fmtInt(c.dropped)} of ${fmtInt(c.captured)} captured frames skipped`}>
        {fmtInt(c.dropped)} <span className="text-ink-3">({(c.drop_rate * 100).toFixed(0)}%)</span>
      </td>
      <td className={cx("num text-right", c.reconnects > 0 && "text-warn")}>{fmtInt(c.reconnects)}</td>
      <td className="num text-right">{fmtInt(c.alerts_dropped ?? 0)}</td>
      <td className="num text-right">{fmtInt(c.alerts_disproved ?? 0)}</td>
      <td className="text-right whitespace-nowrap"><Ago at={c.last_frame_at} now={now} tone={frameTone} /></td>
      <td className="text-right whitespace-nowrap"><Ago at={c.last_detection_at} now={now} /></td>
      <td className="text-right whitespace-nowrap"><Ago at={c.last_violation_at} now={now} /></td>
      <td className="max-w-60">
        {problem ? <div className="truncate text-xs text-ink-2" title={problem}>{problem}</div> : <span className="text-ink-3">{dash}</span>}
      </td>
    </tr>
  );
}

export function SystemPage() {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastOk, setLastOk] = useState<number | null>(null); // epoch s of the last good poll
  const [now, setNow] = useState(() => Date.now() / 1000);
  const [hist, setHist] = useState<{ cpu: number[]; engine: number[] }>({ cpu: [], engine: [] });
  const alive = useRef(true);
  const inflight = useRef(false);

  const poll = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const h = await api.system.health();
      if (!alive.current) return;
      setHealth(h);
      setError(null);
      setLastOk(Date.now() / 1000);
      setHist((p) => ({
        cpu: h.host.cpu_percent == null ? p.cpu : [...p.cpu, h.host.cpu_percent].slice(-HISTORY),
        engine: [...p.engine, h.capacity.engine_utilization * 100].slice(-HISTORY),
      }));
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : "The request failed.");
    } finally {
      inflight.current = false;
    }
  }, []);

  // poll every 2 s, but only while the tab is visible; catch up at once when it becomes visible again
  useEffect(() => {
    alive.current = true;
    const tick = () => { if (!document.hidden) void poll(); };
    tick();
    const t = window.setInterval(tick, POLL_MS);
    const clock = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      alive.current = false;
      window.clearInterval(t);
      window.clearInterval(clock);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [poll]);

  const retry = <Button size="sm" icon="refresh" onClick={() => void poll()}>Retry</Button>;

  if (!health) {
    return (
      <Page title="System health" description="Whether this machine keeps up with detection, and whether every camera is delivering frames.">
        {error ? (
          <Notice tone="bad" title="System health could not be loaded" action={retry}>{error}</Notice>
        ) : (
          <div className="grid gap-4" role="status" aria-label="Loading system health">
            <Skeleton className="h-36" />
            <Skeleton className="h-32" />
            <Skeleton className="h-56" />
          </div>
        )}
      </Page>
    );
  }

  const cap = CAPACITY[health.capacity.state] ?? CAPACITY.ok;
  const host = health.host;
  const cams = sortCameras(health.cameras); // natural order by name; the status column shows problems
  const running = health.cameras.filter((c) => c.running).length;
  const troubled = health.cameras.filter((c) => statusOf(c.status).rank < 2).length;
  const staleFor = lastOk == null ? 0 : Math.max(0, Math.round(now - lastOk));

  return (
    <Page title="System health" description="Whether this machine keeps up with detection, and whether every camera is delivering frames. Updates every 2 s.">
      <div className="grid gap-4">
        {error && (
          <Notice tone="warn" title={`Last update ${staleFor} s ago`} action={retry}>
            The figures below are the last ones received. {error}
          </Notice>
        )}

        <Panel className="grid gap-x-8 gap-y-5 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="min-w-0">
            <div className="eyebrow">Capacity</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <h2 className="text-lg leading-snug font-semibold tracking-tight">{cap.verdict}</h2>
              <Tag tone={cap.tone}>{cap.tag}</Tag>
            </div>
            <p className="mt-1.5 max-w-xl text-[13px] text-ink-2">{cap.advice}</p>
            {health.focus.enabled && health.focus.stream_id && health.focus.paused.length > 0 && (
              <p className="mt-2 text-xs text-ink-3">
                Focus mode is on: {health.focus.paused.length} other camera{health.focus.paused.length === 1 ? " is" : "s are"} paused while one is watched full screen.
              </p>
            )}
          </div>
          <div className="min-w-0">
            <UtilisationMeter value={health.capacity.engine_utilization} />
            <Sparkline values={hist.engine} label="Engine utilisation" />
          </div>
        </Panel>

        <CapacityPlanner engines={health.engines} cameras={health.cameras.filter((c) => c.enabled).length}
          maxFps={health.capacity.max_fps_per_stream} />

        <ServerPanel health={health} />

        <Panel>
          <PanelHeader title="Host" hint="The machine running detection. The figures for this app include the video decoders (ffmpeg) it starts." />
          <div className="grid grid-cols-2 gap-x-6 gap-y-5 p-4 sm:grid-cols-3 lg:grid-cols-4">
            <div className="min-w-0">
              <Stat label="CPU" value={pct(host.cpu_percent)} unit={host.cpu_percent == null ? undefined : "%"} tone={loadTone(host.cpu_percent, 80, 95)}
                hint={host.cpu_count ? `All ${host.cpu_count} cores` : undefined} />
              {host.cpu_percent != null && <Sparkline values={hist.cpu} label="CPU" />}
            </div>
            <Stat label="This app, CPU" value={host.process_cpu_percent == null ? dash : host.process_cpu_percent.toFixed(1)}
              unit={host.process_cpu_percent == null ? undefined : "%"}
              hint={host.process_count && host.process_count > 1 ? `Share of all cores, with ${host.process_count - 1} video decoder${host.process_count === 2 ? "" : "s"}` : "Share of all cores"} />
            <Stat label="Memory" value={pct(host.memory_percent)} unit={host.memory_percent == null ? undefined : "%"} tone={loadTone(host.memory_percent, 80, 92)}
              hint="Of the host's RAM" />
            <Stat label="This app, memory" value={host.process_rss_mb == null ? dash : fmtInt(host.process_rss_mb)} unit={host.process_rss_mb == null ? undefined : "MB"} />
            <Stat label="Threads" value={host.threads == null ? dash : fmtInt(host.threads)} hint={`${health.post_workers} post-processing worker${health.post_workers === 1 ? "" : "s"}`} />
            <Stat label="Uptime" value={fmtDuration(health.uptime_s)} hint="Since the server started" />
            <Stat label="Detection device" value={health.device || dash} />
            <Stat label="Detection mode" value={health.mode || dash} />
          </div>
          {host.cpu_percent == null && (
            <p className="border-t border-line px-4 py-2.5 text-xs text-ink-3">CPU and memory figures are not available on this host.</p>
          )}
        </Panel>

        <Panel>
          <PanelHeader title={health.engines.length === 1 ? "Detection engine" : "Detection engines"}
            hint="Contended loops count the times more cameras had a frame ready than fit in one batch: if the number keeps climbing, cameras are queueing for the detector." />
          {health.engines.length === 0 ? (
            <Empty icon="pulse" title="No detection engine is loaded">Engines start with the first running camera.</Empty>
          ) : (
            <div className="scroll-thin overflow-x-auto">
              <table className="table min-w-[760px]">
                <thead>
                  <tr>
                    <th>Engine</th><th>Device</th>
                    <th className="text-right">Utilisation</th><th className="text-right">Frames/s</th><th className="text-right">Calls/s</th>
                    <th className="text-right">Avg batch</th><th className="text-right">Avg call</th><th className="text-right">Cameras</th>
                    <th className="text-right" title="Times more cameras were ready than fit in one batch">Contended loops</th>
                  </tr>
                </thead>
                <tbody>
                  {health.engines.map((e) => {
                    const t: Tone | undefined = e.utilization >= 0.9 ? "bad" : e.utilization >= 0.7 ? "warn" : undefined;
                    return (
                      <tr key={e.name}>
                        <td className="font-medium text-ink">{e.name}</td>
                        <td className="num">{e.device || dash}</td>
                        <td className={cx("num text-right", t && TEXT[t])}>{Math.round(e.utilization * 100)}%</td>
                        <td className="num text-right">{e.frames_per_s.toFixed(1)}</td>
                        <td className="num text-right">{e.calls_per_s.toFixed(1)}</td>
                        <td className="num text-right whitespace-nowrap">
                          {e.avg_batch.toFixed(1)} <span className="text-ink-3">of {e.max_batch}{e.padded_batches ? ", padded" : ""}</span>
                        </td>
                        <td className="num text-right whitespace-nowrap">{e.avg_call_ms.toFixed(0)} ms</td>
                        <td className="num text-right">{e.cameras}</td>
                        <td className={cx("num text-right", e.contended_loops > 0 && "text-warn")}>{fmtInt(e.contended_loops)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <PassesPanel data={health.passes} />

        <Panel>
          <PanelHeader title="Cameras"
            hint={health.cameras.length === 0 ? undefined
              : <>{running} of {health.cameras.length} running{troubled > 0 ? `, ${troubled} with a problem` : ""}. Dropped frames are stale frames skipped on purpose, so a high share is normal for fast sources; reconnects and errors are not.</>} />
          {health.cameras.length === 0 ? (
            <Empty icon="camera" title="No cameras yet" action={<Button icon="camera" onClick={() => navigate("devices")}>Open Cameras &amp; zones</Button>}>
              Add a camera in Cameras &amp; zones and its throughput will show up here.
            </Empty>
          ) : (
            <div className="scroll-thin overflow-x-auto">
              <table className="table min-w-[1280px]">
                <thead>
                  <tr>
                    <th>Camera</th><th>Status</th>
                    <th className="text-right" title="Frames analysed per second, against what the source delivers">Detection / source fps</th>
                    <th className="text-right" title="Frames read from the camera per second">Capture fps</th>
                    <th className="text-right" title="Delay between a frame being captured and its detection result">Latency</th>
                    <th className="text-right">Frames dropped</th>
                    <th className="text-right">Reconnects</th>
                    <th className="text-right" title="Alerts dropped as phantom detections: the evidence check found nothing there">Phantom alerts dropped</th>
                    <th className="text-right" title="Alerts not raised because the sharp evidence check showed every claimed item worn">Alerts disproved</th>
                    <th className="text-right">Last frame</th><th className="text-right">Last detection</th><th className="text-right">Last violation</th>
                    <th>Last error</th>
                  </tr>
                </thead>
                <tbody>{cams.map((c) => <CameraRow key={c.id} c={c} now={now} />)}</tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </Page>
  );
}


/** Which deployment this is, how it is reached, what detection runs on, and the state of each GPU. */
function ServerPanel({ health }: { health: SystemHealth }) {
  const server = health.server;
  const gpus = health.gpus ?? [];
  const engine = health.engines[0];
  const onCuda = health.device.startsWith("cuda");
  const runtime = engine?.runtime ?? "";
  const kind = !runtime ? null : runtime.endsWith(".engine") ? "TensorRT" : runtime.endsWith(".pt") ? "PyTorch" : runtime.includes("openvino") ? "OpenVINO" : runtime;
  const plain = location.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  const used = (g: { index: number }) => health.device === `cuda:${g.index}`;
  const gpuTone = (g: { memory_used_mb: number | null; memory_total_mb: number | null }): Tone => {
    const f = g.memory_used_mb != null && g.memory_total_mb ? g.memory_used_mb / g.memory_total_mb : 0;
    return f >= 0.9 ? "bad" : f >= 0.8 ? "warn" : "ok";
  };
  const full = gpus.filter((g) => used(g) && gpuTone(g) !== "ok");

  return (
    <Panel>
      <PanelHeader title="This server" hint="Which installation you are looking at, and what it runs on." />
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 p-4 sm:grid-cols-3 lg:grid-cols-4">
        <Stat label="Name" value={server?.name ?? dash} hint="Set PPE_SERVER_NAME in .env" />
        <Stat label="Version" value={server ? `v${server.version}` : dash} hint={server?.build ? `Build ${server.build}` : "Build not recorded"} />
        <Stat label="Address" value={location.host} hint={location.protocol === "https:" ? "Encrypted (HTTPS)" : "Plain HTTP"} />
        <Stat label="Detection runs on" value={kind ?? dash} hint={engine?.device ? `${engine.device}${runtime ? ` · ${runtime}` : ""}` : undefined} />
      </div>
      {(plain || (onCuda && kind === "PyTorch") || full.length > 0) && (
        <div className="grid gap-2 border-t border-line p-4">
          {onCuda && kind === "PyTorch" && (
            <Notice tone="warn" title="Detection is running on PyTorch, not TensorRT">
              It works, but is slower and uses more of the GPU. The TensorRT engines did not load or did not fit in GPU memory. Check the server log, free some GPU memory and restart.
            </Notice>
          )}
          {full.map((g) => (
            <Notice key={g.index} tone={gpuTone(g) === "bad" ? "bad" : "warn"} title={`GPU ${g.index} is ${gpuTone(g) === "bad" ? "almost full" : "getting full"}`}>
              Detection runs on it and it is at {Math.round(((g.memory_used_mb ?? 0) / (g.memory_total_mb ?? 1)) * 100)}% of its memory. Another card has more room: set PPE_DEVICE to it in .env and restart.
            </Notice>
          ))}
          {plain && (
            <Notice tone="warn" title="This page is not encrypted">
              Sign-in passwords and video cross the plant network as plain HTTP. Put the HTTPS proxy in front (deploy/docker-compose.https.yml) before anyone outside this room uses it.
            </Notice>
          )}
        </div>
      )}
      {gpus.length > 0 && (
        <div className="overflow-x-auto border-t border-line">
          <table className="table min-w-[560px]">
            <thead><tr><th scope="col">GPU</th><th scope="col">Memory</th><th scope="col" className="text-right!">Load</th><th scope="col" className="text-right!">Temp</th><th scope="col">Used by detection</th></tr></thead>
            <tbody>
              {gpus.map((g) => {
                const pctUsed = g.memory_used_mb != null && g.memory_total_mb ? Math.round((g.memory_used_mb / g.memory_total_mb) * 100) : null;
                const tone = gpuTone(g);
                return (
                  <tr key={g.index}>
                    <td><span className="num text-ink-3">{g.index}</span> {g.name}</td>
                    <td>
                      <span className="flex items-center gap-2">
                        <span className="h-1.5 w-28 overflow-hidden rounded-full bg-sunken" role="img" aria-label={pctUsed == null ? "Memory unknown" : `${pctUsed}% of memory used`}>
                          <span className={cx("block h-full", tone === "bad" ? "bg-bad" : tone === "warn" ? "bg-warn" : "bg-ok")} style={{ width: `${pctUsed ?? 0}%` }} />
                        </span>
                        <span className="num text-xs text-ink-2">{g.memory_used_mb != null ? `${fmtInt(g.memory_used_mb)} / ${fmtInt(g.memory_total_mb ?? 0)} MB` : dash}</span>
                      </span>
                    </td>
                    <td className="num text-right">{g.utilization_percent != null ? `${g.utilization_percent}%` : dash}</td>
                    <td className="num text-right">{g.temperature_c != null ? `${g.temperature_c}°C` : dash}</td>
                    <td>{used(g) ? <Tag tone="accent">In use</Tag> : <span className="text-xs text-ink-3">Not used</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}


const COUNTER_LABEL: Record<string, string> = {
  crops: "person crops checked",
  blank_padding_crops: "blank crops added to fill a batch",
  evidence_recheck_held_back: "evidence re-checks held back",
  crops_reused: "crop results reused",
  stall_episodes: "times most cameras stalled at once",
};

const TIMING_LABEL: Record<string, string> = {
  confirmation_wait_s: "First unsafe frame to confirmed violation",
  evidence_build_s: "Evidence built (sharp re-check, four pictures)",
  db_write_wait_s: "A worker waited for the database (slow waits only)",
  db_write_held_s: "A database write held everyone else up (slow writes only)",
};

/** Every kind of model call: full frames, person tiles, person crops, evidence. Shows where the detector's time goes. */
function PassesPanel({ data }: { data?: PassSummary }) {
  if (!data || data.passes.length === 0) return null;
  return (
    <Panel>
      <PanelHeader title="Where detector time goes"
        hint={`Every model call in the last ${Math.round(data.window_s)} s, by model and input size. An image is a frame, a tile or a crop.`} />
      <div className="scroll-thin overflow-x-auto">
        <table className="table min-w-[680px]">
          <thead>
            <tr>
              <th>Pass</th><th>Runs on</th>
              <th className="text-right">Calls/s</th><th className="text-right">Images/s</th>
              <th className="text-right">Per call</th><th className="text-right">Per image</th><th>Share of detector time</th>
            </tr>
          </thead>
          <tbody>
            {data.passes.map((p) => (
              <tr key={p.name}>
                <td className="num font-medium text-ink">{p.name}</td>
                <td>{p.role || dash}</td>
                <td className="num text-right">{p.calls_per_s.toFixed(1)}</td>
                <td className="num text-right">{p.images_per_s.toFixed(1)}</td>
                <td className="num text-right whitespace-nowrap">{p.avg_ms_call.toFixed(1)} ms</td>
                <td className="num text-right whitespace-nowrap">{p.avg_ms_image.toFixed(2)} ms</td>
                <td>
                  <span className="flex items-center gap-2">
                    <span className="h-1.5 w-24 overflow-hidden rounded-full bg-sunken" role="img" aria-label={`${Math.round(p.share * 100)}% of detector time`}>
                      <span className="block h-full bg-accent" style={{ width: `${Math.round(p.share * 100)}%` }} />
                    </span>
                    <span className="num text-xs text-ink-2">{Math.round(p.share * 100)}%</span>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(data.timings ?? []).length > 0 && (
        <div className="border-t border-line px-4 py-2.5 text-xs text-ink-3">
          <div className="mb-1 font-medium text-ink-2">Timings in this window</div>
          {(data.timings ?? []).map((t) => (
            <div key={t.name}>
              {TIMING_LABEL[t.name] ?? t.name}: <span className="num text-ink-2">{t.avg.toFixed(2)} s</span> on average,{" "}
              <span className="num text-ink-2">{t.max.toFixed(2)} s</span> at most ({t.n}x)
            </div>
          ))}
        </div>
      )}
      {data.counters.length > 0 && (
        <p className="border-t border-line px-4 py-2.5 text-xs text-ink-3">
          {data.counters.map((c, i) => (
            <span key={c.name}>{i > 0 && " · "}{COUNTER_LABEL[c.name] ?? c.name}: <span className="num text-ink-2">{c.per_s.toFixed(1)}/s</span></span>
          ))}
        </p>
      )}
    </Panel>
  );
}
