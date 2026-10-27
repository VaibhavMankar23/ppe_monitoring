import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Page } from "../components/layout/Shell";
import { CameraTile } from "../components/live/CameraTile";
import { byAttention, FleetBoard, FleetLegend } from "../components/live/FleetBoard";
import { isProblem } from "../components/live/status";
import { Button, cx, Empty, Icon, Notice, Panel, Segmented, Skeleton, Tag, type IconName } from "../components/ui";
import { api, jpegDataUrl, type AnalyticsQuery } from "../lib/api";
import { fmtAgo, fmtInt, fmtPct, violationLabel } from "../lib/format";
import { href, navigateWith } from "../lib/router";
import { useAuth } from "../state/auth";
import { useMonitor } from "../state/monitor";
import type { AnalyticsSummary, CameraStats, Heatmap, PpeCount, TimePoint, Violation } from "../types";

const DAY = 86_400;
const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000;
const tz = () => -new Date().getTimezoneOffset();
const q = (days: number, end = Date.now() / 1000): AnalyticsQuery => ({ start: startOfDay() - (days - 1) * DAY, end, tz: tz() });

const ITEM_ICON: Record<string, IconName> = {
  helmet: "helmet", vest: "vest", gloves: "gloves", mask: "mask", goggles: "goggles", boots: "boots", ear_protection: "ear",
  phone_use: "phone", restricted_area: "restricted",
};

interface Figures {
  today: AnalyticsSummary;
  week: AnalyticsSummary;
  camsToday: CameraStats[];
  camsWeek: CameraStats[];
  ppe: PpeCount[];
  heat: Heatmap;
}

/** Today's, the last 7 days' and the last 4 weeks' figures, refreshed every minute. */
function useFigures(enabled: boolean) {
  const [data, setData] = useState<Figures | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = async () => {
      try {
        const [today, week, camsToday, camsWeek, ppe, heat] = await Promise.all([
          api.analytics.summary(q(1)), api.analytics.summary(q(7)), api.analytics.byCamera(q(1)),
          api.analytics.byCamera(q(7)), api.analytics.byPpe(q(7)), api.analytics.heatmap(q(28)),
        ]);
        if (alive) { setData({ today, week, camsToday, camsWeek, ppe, heat }); setError(null); }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "Couldn't load the figures.");
      }
    };
    void load();
    const t = window.setInterval(() => void load(), 60_000);
    return () => { alive = false; window.clearInterval(t); };
  }, [enabled]);
  return { data, error };
}

function useTrend(enabled: boolean, days: number) {
  const [points, setPoints] = useState<TimePoint[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setPoints(null);
    api.analytics.timeseries(q(days), "day").then((t) => alive && setPoints(t.points)).catch(() => alive && setPoints([]));
    return () => { alive = false; };
  }, [enabled, days]);
  return points;
}

/** The newest incidents nobody has reviewed yet, kept live. */
function useOpenIncidents(enabled: boolean) {
  const { onViolation, onViolationUpdate } = useMonitor();
  const [items, setItems] = useState<Violation[] | null>(null);
  const [total, setTotal] = useState(0);
  const [fresh, setFresh] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    api.violations.list({ review: "unreviewed", limit: 6 })
      .then((p) => { if (alive) { setItems(p.items); setTotal(p.total); } })
      .catch(() => alive && setFailed(true));
    const offNew = onViolation((v) => {
      setItems((xs) => [v, ...(xs ?? []).filter((x) => x.id !== v.id)].slice(0, 6));
      setTotal((n) => n + 1);
      setFresh(v.id);
    });
    const offUpd = onViolationUpdate((u) => setItems((xs) => xs?.map((x) => (x.id === u.id ? { ...x, state: u.state, last_seen: u.last_seen, missing: u.missing ?? x.missing } : x)) ?? xs));
    return () => { alive = false; offNew(); offUpd(); };
  }, [enabled, onViolation, onViolationUpdate]);
  return { items, total, failed, fresh };
}

// ------------------------------------------------------------------ pieces

function Card({ title, sub, actions, children, className, bodyClass }:
  { title: string; sub?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <Panel className={cx("flex flex-col", className)}>
      <div className="flex items-center gap-3 px-6 pt-5">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold tracking-tight">{title}</h3>
          {sub && <div className="mt-px text-[12.5px] text-ink-3">{sub}</div>}
        </div>
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </div>
      <div className={cx("min-h-0 flex-1", bodyClass ?? "px-6 pt-5 pb-6")}>{children}</div>
    </Panel>
  );
}

function Trend({ points, target }: { points: TimePoint[]; target: number }) {
  const pts = points.filter((p) => p.compliance_rate !== null) as (TimePoint & { compliance_rate: number })[];
  if (pts.length < 2) return <p className="m-auto py-10 text-[13px] text-ink-3">Not enough days with workers checked to draw a trend yet.</p>;
  const W = 600, H = 170, vals = pts.map((p) => p.compliance_rate * 100);
  const lo = Math.floor(Math.min(target * 100 - 2, ...vals) - 1), hi = Math.ceil(Math.max(target * 100 + 1, ...vals) + 0.5);
  const X = (i: number) => 34 + (i * (W - 48)) / (pts.length - 1), Y = (v: number) => 10 + ((hi - v) / (hi - lo)) * (H - 34);
  const d = vals.map((v, i) => `${i ? "L" : "M"}${X(i)},${Y(v)}`).join(" ");
  const ticks = [lo, Math.round((lo + hi) / 2), hi].filter((v, i, a) => a.indexOf(v) === i);
  const every = Math.ceil(pts.length / 8);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-auto block h-auto w-full pt-2.5" role="img" aria-label={`Compliance rate per day, last ${pts.length} days`}>
      <defs><linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--color-data)" stopOpacity=".22" /><stop offset="1" stopColor="var(--color-data)" stopOpacity="0" /></linearGradient></defs>
      {ticks.map((v) => <g key={v}><line x1="34" x2={W - 14} y1={Y(v)} y2={Y(v)} stroke="var(--color-line)" /><text x="0" y={Y(v) + 4} className="fill-ink-4 font-mono text-[11px]">{v}%</text></g>)}
      <line x1="34" x2={W - 14} y1={Y(target * 100)} y2={Y(target * 100)} stroke="var(--color-ink-4)" strokeDasharray="4 4" />
      <path d={`${d} L${X(pts.length - 1)},${H - 24} L${X(0)},${H - 24} Z`} fill="url(#trendFill)" />
      <path d={d} fill="none" stroke="var(--color-data)" strokeWidth="2.2" strokeLinejoin="round" />
      <circle cx={X(pts.length - 1)} cy={Y(vals[vals.length - 1])} r="4.5" fill="var(--color-surface)" stroke="var(--color-data)" strokeWidth="2.2" />
      {pts.map((p, i) => (i % every === 0 || i === pts.length - 1) && (
        <text key={p.t} x={X(i)} y={H - 6} textAnchor="middle" className="fill-ink-4 font-mono text-[11px]">{new Date(p.t * 1000).getDate()}</text>
      ))}
    </svg>
  );
}

function HourHeat({ heat }: { heat: Heatmap }) {
  const steps = ["var(--color-sunken)", "color-mix(in oklab,var(--color-data) 22%,var(--color-surface))", "color-mix(in oklab,var(--color-data) 45%,var(--color-surface))",
    "color-mix(in oklab,var(--color-data) 70%,var(--color-surface))", "var(--color-data)"];
  const step = (v: number) => (v <= 0 || heat.max <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((v / heat.max) * 4))));
  let peak = { d: 0, h: 0, v: -1 };
  heat.grid.forEach((row, d) => row.forEach((v, h) => { if (v > peak.v) peak = { d, h, v }; }));
  return (
    <>
      <div className="grid grid-cols-[30px_repeat(24,minmax(0,1fr))] gap-[3px] font-mono text-[10.5px] text-ink-4" role="img" aria-label="Incidents by hour and weekday">
        {heat.grid.map((row, d) => [
          <span key={`l${d}`} className="flex items-center">{heat.days[d]?.slice(0, 3)}</span>,
          ...row.map((v, h) => <span key={`${d}-${h}`} title={`${heat.days[d]} ${String(h).padStart(2, "0")}:00 · ${v} incident${v === 1 ? "" : "s"}`}
            className="aspect-square rounded-[3px]" style={{ background: steps[step(v)] }} />),
        ])}
        <span />
        {Array.from({ length: 24 }, (_, h) => <span key={h} className="text-center">{h % 6 === 0 ? String(h).padStart(2, "0") : ""}</span>)}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-3">
        Fewer {steps.map((c) => <i key={c} className="inline-block h-2 w-3.5 rounded-sm" style={{ background: c }} />)} More
        {peak.v > 0 && <span className="ml-auto">Busiest: {heat.days[peak.d]?.slice(0, 3)} {String(peak.h).padStart(2, "0")}:00</span>}
      </div>
    </>
  );
}

/** Small ring for the metric cards. */
function Ring({ value, tone = "data", size = 56 }: { value: number; tone?: "data" | "ok" | "warn" | "bad"; size?: number }) {
  const R = size / 2 - 5, C = 2 * Math.PI * R, f = Math.max(0, Math.min(1, value));
  const col = tone === "ok" ? "var(--color-ok)" : tone === "warn" ? "var(--color-warn)" : tone === "bad" ? "var(--color-bad)" : "var(--color-data)";
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0 -rotate-90" aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={R} fill="none" stroke="var(--color-sunken)" strokeWidth="6" />
      <circle cx={size / 2} cy={size / 2} r={R} fill="none" stroke={col} strokeWidth="6" strokeLinecap="round" strokeDasharray={`${C * f} ${C}`} />
    </svg>
  );
}

function Spark({ values, color = "var(--color-data)" }: { values: number[]; color?: string }) {
  if (values.length < 2) return null;
  const W = 120, H = 40, lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * W, H - 4 - ((v - lo) / span) * (H - 8)]);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0 overflow-visible" aria-hidden="true">
      <path d={`${d} L${W},${H} L0,${H} Z`} fill={color} opacity=".12" />
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="3" fill={color} />
    </svg>
  );
}

function Metric({ label, icon, children, foot, aside }: { label: string; icon: IconName; children: ReactNode; foot?: ReactNode; aside?: ReactNode }) {
  return (
    <Panel className="flex flex-col gap-3 p-5">
      <div className="flex items-center gap-2 text-[13px] font-semibold text-ink-3">
        <span className="grid size-7 place-items-center rounded-lg bg-accent-soft text-accent"><Icon name={icon} size={15} /></span>{label}
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">{children}</div>
        {aside}
      </div>
      {foot && <div className="mt-auto flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">{foot}</div>}
    </Panel>
  );
}

const Num = ({ children, unit }: { children: ReactNode; unit?: ReactNode }) => (
  <div className="num text-[34px] leading-none font-bold tracking-[-0.04em]">{children}{unit && <span className="ml-1 text-base font-semibold tracking-normal text-ink-3">{unit}</span>}</div>
);

function EventRow({ v, fresh, last }: { v: Violation; fresh: boolean; last: boolean }) {
  const ongoing = v.state === "ongoing";
  return (
    <button type="button" onClick={() => navigateWith("incidents", { id: v.id })}
      className={cx("relative grid w-full grid-cols-[20px_48px_minmax(0,1fr)_auto] items-center gap-3 rounded-xl px-2 py-2.5 text-left hover:bg-sunken", fresh && "animate-[flash_2.6s]")}>
      <span className="relative flex h-full justify-center">
        {!last && <span aria-hidden="true" className="absolute top-1/2 -bottom-6 w-px bg-line" />}
        <span className={cx("relative mt-0 size-2.5 self-center rounded-full ring-4", ongoing ? "bg-bad ring-bad-soft" : "bg-ink-4 ring-surface")} />
      </span>
      <img src={jpegDataUrl(v.thumbnail)} alt="" className="size-12 rounded-[10px] bg-stage object-cover" />
      <span className="min-w-0">
        <span className="block truncate text-[13.5px] font-semibold">{v.missing.map(violationLabel).join(", ")}</span>
        <span className="block truncate text-[12.5px] text-ink-3">{v.stream_name} · <span className="font-mono">#{v.track_id}</span></span>
      </span>
      <span className="grid justify-items-end gap-1 text-[12px] text-ink-3">
        {ongoing ? <Tag tone="bad">Ongoing</Tag> : <span className="font-mono">{new Date(v.timestamp * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>}
        <span>{fmtAgo(v.timestamp)}</span>
      </span>
    </button>
  );
}

/** "A, B, C and 4 more": names stay readable at plant scale. */
const names = (xs: { name: string }[], max = 3) =>
  xs.length <= max ? xs.map((x) => x.name).join(", ") : `${xs.slice(0, max).map((x) => x.name).join(", ")} and ${xs.length - max} more`;

const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; };
const rateColor = (r: number, target: number) => (r < target - 0.025 ? "var(--color-bad)" : r < target ? "var(--color-warn)" : "var(--color-data)");

// ------------------------------------------------------------------ page

export function OverviewPage() {
  const { can, user } = useAuth();
  const { connected, streams, info } = useMonitor();
  const canAnalytics = can("analytics:view");
  const canIncidents = can("violations:view");
  const { data, error } = useFigures(canAnalytics);
  const [days, setDays] = useState<"7" | "14" | "30">("14");
  const trend = useTrend(canAnalytics, Number(days));
  const spark = useTrend(canAnalytics, 14);
  const open = useOpenIncidents(canIncidents);
  const [, tick] = useState(0);
  useEffect(() => { const t = window.setInterval(() => tick((n) => n + 1), 15_000); return () => window.clearInterval(t); }, []);
  const openCamera = useCallback((id: string) => navigateWith("monitoring", { camera: id }), []);

  const live = useMemo(() => ({
    workers: streams.reduce((n, s) => n + s.workers, 0),
    bad: streams.reduce((n, s) => n + s.violations, 0),
    online: streams.filter((s) => s.status === "live").length,
    problems: streams.filter(isProblem),
    unsafe: streams.filter((s) => s.violations > 0).sort(byAttention),
  }), [streams]);

  const target = data?.week.compliance_target ?? 0.95;
  const rate = data?.today.compliance_rate ?? null;
  const delta = rate !== null && data?.today.previous_compliance_rate != null ? (rate - data.today.previous_compliance_rate) * 100 : null;
  const review = data?.week.review;
  const reviewedShare = review && review.total ? review.reviewed / review.total : 0;
  const avgDay = data?.week.avg_violations_per_day ?? null;
  const today = info?.violations_today ?? 0;
  const camRows = (data?.camsWeek ?? []).filter((c) => c.compliance_rate !== null).sort((a, b) => a.compliance_rate! - b.compliance_rate!);
  const lo = Math.min(0.85, ...camRows.map((c) => c.compliance_rate! - 0.02));
  const pos = (r: number) => `${Math.max(2, ((r - lo) / (1 - lo)) * 100)}%`;
  const ppeRows = (data?.ppe ?? []).filter((p) => p.count > 0).sort((a, b) => b.count - a.count).slice(0, 6);
  const ppeMax = Math.max(1, ...ppeRows.map((p) => p.count));

  const status = !connected ? { tone: "bad" as const, title: "Live connection lost", sub: "Figures and video are frozen. Reconnecting automatically." }
    : live.bad ? { tone: "bad" as const, title: `${live.bad} worker${live.bad === 1 ? " is" : "s are"} unsafe right now`, sub: `On ${names(live.unsafe)}. Open a camera to see who and why.` }
    : live.problems.length ? { tone: "warn" as const, title: "Everyone in view is compliant", sub: `${live.problems.length} camera${live.problems.length === 1 ? " is" : "s are"} not delivering: ${names(live.problems)}.` }
    : { tone: "ok" as const, title: streams.length ? "All clear across the plant" : "No cameras yet", sub: streams.length ? `${live.workers} worker${live.workers === 1 ? "" : "s"} in view on ${live.online} live camera${live.online === 1 ? "" : "s"}, all compliant.` : "Add a camera in Setup to start monitoring." };

  return (
    <Page wide={false} title={`${greeting()}, ${user?.username ?? ""}`}
      description={`${new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })} · plant status, review progress and today's compliance at a glance.`}
      actions={<>
        {canAnalytics && <a href={href("reports")} className="inline-flex h-10 items-center gap-2 rounded-xl border border-line-strong bg-surface px-4 text-[13.5px] font-semibold text-ink no-underline shadow-[var(--sh-xs)] hover:border-ink-4"><Icon name="reports" size={16} />Insights</a>}
        {canIncidents && (
          <button type="button" onClick={() => navigateWith("incidents", {})}
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-pri px-4 text-[13.5px] font-semibold text-pri-ink shadow-[var(--sh-xs)] hover:bg-pri-hover">
            Start review{open.items ? ` · ${fmtInt(open.total)}` : ""}<Icon name="arrowRight" size={16} />
          </button>
        )}
      </>}>
      {error && <Notice tone="bad" title="Couldn't load the figures" className="mb-5">{error}</Notice>}

      {/* ---- status hero ---- */}
      <Panel className={cx("relative mb-5 overflow-hidden p-6 sm:p-7", live.unsafe.length > 0 && "grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]")}>
        <span aria-hidden="true" className={cx("pointer-events-none absolute -top-24 -left-24 size-72 rounded-full blur-3xl",
          status.tone === "ok" ? "bg-ok/20" : status.tone === "warn" ? "bg-warn/20" : "bg-bad/25")} />
        <div className="relative flex flex-col justify-center">
          <div className={cx("mb-4 inline-flex w-fit items-center gap-2 rounded-full px-3 py-1 text-[12px] font-bold tracking-[0.08em] uppercase",
            status.tone === "ok" ? "bg-ok-soft text-ok" : status.tone === "warn" ? "bg-warn-soft text-warn" : "bg-bad-soft text-bad")}>
            <span className={cx("size-2 rounded-full bg-current", connected && "live-ping")} />Live now
          </div>
          <h2 className="max-w-[22ch] text-[30px] leading-[1.1] font-bold tracking-[-0.03em] sm:text-[38px]">{status.title}</h2>
          <p className="mt-3 max-w-[56ch] text-[15px] text-ink-2">{status.sub}</p>
          <div className="mt-6 flex flex-wrap gap-x-8 gap-y-3 text-[13px] text-ink-3">
            <span><b className="num block text-xl font-bold tracking-tight text-ink">{live.workers}</b>workers in view</span>
            <span><b className={cx("num block text-xl font-bold tracking-tight", live.bad ? "text-bad" : "text-ink")}>{live.bad}</b>non-compliant</span>
            <span><b className="num block text-xl font-bold tracking-tight text-ink">{live.online}<span className="text-ink-3">/{streams.length}</span></b>cameras live</span>
            <span><b className="num block text-xl font-bold tracking-tight text-ink">{fmtInt(today)}</b>incidents today</span>
          </div>
        </div>
        {live.unsafe.length > 0 && (
          <div className={cx("relative grid gap-3", live.unsafe.length > 1 && "sm:grid-cols-2")}>
            {live.unsafe.slice(0, 4).map((s) => <CameraTile key={s.id} s={s} onOpen={openCamera} showZones={false} fps={6} />)}
            {live.unsafe.length > 4 && (
              <a href={href("monitoring")} className="col-span-full inline-flex items-center justify-center gap-1.5 rounded-xl border border-bad-line bg-bad-soft py-2 text-[13px] font-semibold text-bad no-underline">
                {live.unsafe.length - 4} more camera{live.unsafe.length - 4 === 1 ? "" : "s"} with someone unsafe<Icon name="arrowRight" size={14} />
              </a>
            )}
          </div>
        )}
      </Panel>

      {/* ---- metrics ---- */}
      <div className="mb-5 grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
        {canAnalytics && (
          <Metric label="Compliance today" icon="shield"
            aside={data ? <Ring value={rate ?? 0} tone={rate === null ? "data" : rate >= target ? "ok" : rate >= target - 0.025 ? "warn" : "bad"} /> : undefined}
            foot={<>Target {fmtPct(target, 0)}{delta !== null && <span className={cx("inline-flex items-center gap-0.5 font-semibold", delta >= 0 ? "text-ok" : "text-bad")}><Icon name={delta >= 0 ? "arrowUp" : "arrowDown"} size={12} />{Math.abs(delta).toFixed(1)} pts</span>}</>}>
            {data ? <Num>{rate === null ? "–" : (rate * 100).toFixed(1)}<span className="text-xl text-ink-3">{rate === null ? "" : "%"}</span></Num> : <Skeleton className="h-9 w-24" />}
          </Metric>
        )}
        {canIncidents && (
          <Metric label="Review queue" icon="incidents"
            aside={review ? <Ring value={reviewedShare} tone={reviewedShare > 0.8 ? "ok" : "data"} /> : undefined}
            foot={review ? <>{fmtPct(reviewedShare, 0)} of this week's alerts reviewed{review.precision != null && ` · ${fmtPct(review.precision, 0)} real`}</> : "Incidents waiting for a verdict"}>
            {open.items ? <Num unit="to review">{fmtInt(open.total)}</Num> : <Skeleton className="h-9 w-20" />}
          </Metric>
        )}
        <Metric label="Incidents today" icon="clock"
          aside={<Spark values={(spark ?? []).map((p) => p.violations)} color={avgDay !== null && today > avgDay ? "var(--color-warn)" : "var(--color-data)"} />}
          foot={avgDay !== null ? <>{today > avgDay ? <span className="font-semibold text-warn">Above</span> : <span className="font-semibold text-ok">Below</span>} the 7-day average of {avgDay.toFixed(1)}</> : "Recorded since midnight"}>
          <Num>{fmtInt(today)}</Num>
        </Metric>
        <Metric label="Cameras" icon="monitoring"
          aside={streams.length ? <Ring value={live.online / streams.length} tone={live.problems.length ? "warn" : "ok"} /> : undefined}
          foot={live.problems.length ? <><Tag tone="warn">{live.problems[0].name}</Tag>{live.problems.length > 1 && `+${live.problems.length - 1} more`} not delivering</> : <>All delivering{info?.device && ` · detector on ${info.device}`}</>}>
          <Num unit={`/ ${streams.length} online`}>{live.online}</Num>
        </Metric>
      </div>

      {/* ---- the whole fleet at a glance ---- */}
      {streams.length > 1 && (
        <Card className="mb-5" title="Camera fleet" sub={`All ${streams.length} cameras · unsafe and down first · select one to open it`}
          actions={<><span className="hidden lg:block"><FleetLegend streams={streams} /></span>
            <a href={href("monitoring")} className="inline-flex h-8 items-center gap-1.5 rounded-[10px] px-3 text-[13px] font-semibold text-accent no-underline hover:bg-accent-soft">Video wall<Icon name="arrowRight" size={14} /></a></>}>
          <FleetBoard streams={streams} onOpen={openCamera} dense />
        </Card>
      )}

      {/* ---- trend + events ---- */}
      <div className={cx("mb-5 grid gap-5", canIncidents && "xl:grid-cols-[minmax(0,1.55fr)_minmax(360px,1fr)]")}>
        {canAnalytics ? (
          <Card title="Compliance trend" sub={`Share of workers checked who were never flagged · dashed line is the ${fmtPct(target, 0)} target`}
            actions={<Segmented size="sm" label="Trend range" value={days} onChange={setDays} options={[{ value: "7", label: "7D" }, { value: "14", label: "14D" }, { value: "30", label: "30D" }]} />}>
            <div className="flex min-h-[190px] flex-col">{trend === null ? <Skeleton className="h-44" /> : <Trend points={trend} target={target} />}</div>
            {camRows.length > 0 && (
              <div className="mt-6 grid gap-x-8 gap-y-3.5 border-t border-line pt-5 sm:grid-cols-2">
                {camRows.slice(0, 6).map((c) => (
                  <div key={c.stream_id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 text-[13px]">
                    <b className="truncate font-semibold" title={c.stream_name}>{c.stream_name}</b>
                    <span className="num font-mono text-[12.5px]">{fmtPct(c.compliance_rate)}</span>
                    <div className="relative col-span-2 h-1.5 rounded-full bg-sunken">
                      <i className="block h-full rounded-full" style={{ width: pos(c.compliance_rate!), background: rateColor(c.compliance_rate!, target) }} />
                      <span className="absolute -top-[3px] -bottom-[3px] w-0.5 rounded bg-ink-3" style={{ left: pos(target) }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        ) : (
          <Card title="Cameras" sub="Select one to open its live view">
            {streams.length === 1
              ? <CameraTile s={streams[0]} onOpen={openCamera} showZones={false} fps={4} />
              : <FleetBoard streams={streams} onOpen={openCamera} />}
          </Card>
        )}

        {canIncidents && (
          <Card title="Latest events" sub="Incidents not reviewed yet, newest first" bodyClass="px-4 pt-3 pb-4"
            actions={<Button size="sm" onClick={() => navigateWith("incidents", {})}>Open review</Button>}>
            {open.failed ? <Notice tone="bad">Couldn't load incidents.</Notice>
              : open.items === null ? <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14" />)}</div>
              : open.items.length === 0 ? <Empty icon="check" title="Queue is clear">Every incident has a verdict. New ones appear here the moment they are confirmed.</Empty>
              : open.items.map((v, i) => <EventRow key={v.id} v={v} fresh={v.id === open.fresh} last={i === open.items!.length - 1} />)}
          </Card>
        )}
      </div>

      {/* ---- where & when ---- */}
      {canAnalytics && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <Card title="What's being missed" sub="Incidents by type, last 7 days">
            {!data ? <Skeleton className="h-40" /> : ppeRows.length === 0 ? <p className="text-[13px] text-ink-3">No incidents in the last 7 days.</p> : (
              <div className="grid gap-3.5">
                {ppeRows.map((p, i) => (
                  <div key={p.item} className="flex items-center gap-3 text-[13.5px]">
                    <span className={cx("grid size-9 shrink-0 place-items-center rounded-xl", i === 0 ? "bg-accent text-accent-ink" : "bg-sunken text-ink-2")}><Icon name={ITEM_ICON[p.item] ?? "alert"} size={18} /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex justify-between gap-2"><span className="truncate font-semibold">{violationLabel(p.item)}</span><span className="num font-mono text-[12.5px] text-ink-2">{fmtInt(p.count)} · {fmtPct(p.share, 0)}</span></div>
                      <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-sunken"><i className="block h-full rounded-full bg-data" style={{ width: `${(p.count / ppeMax) * 100}%` }} /></span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card title="When it happens" sub="Incidents by hour and weekday, last 4 weeks">
            {!data ? <Skeleton className="h-40" /> : data.heat.max === 0 ? <p className="text-[13px] text-ink-3">No incidents in the last 4 weeks.</p> : <HourHeat heat={data.heat} />}
          </Card>
        </div>
      )}
    </Page>
  );
}
