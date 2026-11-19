import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Page } from "../components/layout/Shell";
import { fleetCounts, fleetState, FleetBoard, FleetLegend } from "../components/live/FleetBoard";
import { CameraVideo } from "../components/live/Video";
import { isProblem } from "../components/live/status";
import { Button, cx, Empty, Icon, Notice, Panel, Segmented, Skeleton, Tag, type IconName } from "../components/ui";
import { api, type AnalyticsQuery } from "../lib/api";
import { fmtAgo, fmtDuration, fmtInt, fmtPct, violationLabel } from "../lib/format";
import { href, navigateWith } from "../lib/router";
import { useAuth } from "../state/auth";
import { useMonitor } from "../state/monitor";
import type { AnalyticsSummary, CameraStats, Heatmap, PpeCount, StreamInfo, TimePoint, Violation } from "../types";

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
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 pt-4">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          {sub && <div className="mt-0.5 text-[13px] text-ink-3">{sub}</div>}
        </div>
        {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className={cx("min-h-0 flex-1", bodyClass ?? "px-5 pt-4 pb-5")}>{children}</div>
    </Panel>
  );
}

/** Compliance per day: one scale for grid, line, target and labels; days under target are marked red. */
function Trend({ points, target }: { points: TimePoint[]; target: number }) {
  const pts = points.filter((p) => p.compliance_rate !== null) as (TimePoint & { compliance_rate: number })[];
  if (pts.length < 2) return <p className="m-auto py-10 text-[13px] text-ink-3">Not enough days with workers checked to draw a trend yet.</p>;
  const W = 640, H = 250, L = 44, R = 16, T = 12, B = 30;
  const vals = pts.map((p) => p.compliance_rate * 100), tg = target * 100;
  const lo = Math.max(0, Math.floor((Math.min(tg, ...vals) - 2) / 5) * 5), hi = 100;
  const X = (i: number) => L + (i * (W - L - R)) / (pts.length - 1), Y = (v: number) => T + ((hi - v) / (hi - lo)) * (H - T - B);
  const d = vals.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  const ticks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4);
  const every = pts.length > 14 ? 5 : pts.length > 7 ? 2 : 1;
  const last = pts.length - 1;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={`Compliance rate per day, last ${pts.length} days`}>
      {ticks.map((v) => (
        <g key={v}><line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} stroke="var(--color-line)" />
          <text x={L - 8} y={Y(v) + 4} textAnchor="end" className="fill-ink-3 text-[11px]">{Number.isInteger(v) ? v : v.toFixed(1)}%</text></g>
      ))}
      <line x1={L} x2={W - R} y1={Y(tg)} y2={Y(tg)} stroke="var(--color-ink-3)" strokeWidth="1.25" strokeDasharray="4 4" />
      <text x={W - R} y={Y(tg) - 6} textAnchor="end" className="fill-ink-3 text-[11px]">Target {fmtPct(target, 0)}</text>
      <path d={`${d} L${X(last)},${Y(lo)} L${X(0)},${Y(lo)} Z`} fill="var(--color-data)" opacity=".12" />
      <path d={d} fill="none" stroke="var(--color-data)" strokeWidth="2.25" strokeLinejoin="round" strokeLinecap="round" />
      {pts.map((p, i) => {
        const below = vals[i] < tg;
        if (!below && i !== last) return null;
        return (
          <circle key={p.t} cx={X(i)} cy={Y(vals[i])} r="4" fill="var(--color-surface)" strokeWidth="2.25" stroke={below ? "var(--color-bad)" : "var(--color-data)"}>
            <title>{new Date(p.t * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}: {vals[i].toFixed(1)}%</title>
          </circle>
        );
      })}
      {pts.map((p, i) => (last - i) % every === 0 && (
        <text key={`x${p.t}`} x={X(i)} y={H - 8} textAnchor={i === last ? "end" : "middle"} className="fill-ink-3 text-[11px]">
          {new Date(p.t * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
        </text>
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
      <div className="grid grid-cols-[32px_repeat(24,minmax(0,1fr))] gap-[3px] text-[11px] text-ink-3" role="img" aria-label="Incidents by hour and weekday">
        {heat.grid.map((row, d) => [
          <span key={`l${d}`} className="flex items-center">{heat.days[d]?.slice(0, 3)}</span>,
          ...row.map((v, h) => <span key={`${d}-${h}`} title={`${heat.days[d]} ${String(h).padStart(2, "0")}:00 · ${v} incident${v === 1 ? "" : "s"}`}
            className="aspect-square rounded-[3px]" style={{ background: steps[step(v)] }} />),
        ])}
        <span />
        {Array.from({ length: 24 }, (_, h) => <span key={h} className="text-center text-[10.5px]">{h % 3 === 0 ? String(h).padStart(2, "0") : ""}</span>)}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[12.5px] text-ink-3">
        Fewer {steps.map((c) => <i key={c} className="inline-block h-2 w-3.5 rounded-sm" style={{ background: c }} />)} More
        {peak.v > 0 && <span className="ml-auto">Busiest: {heat.days[peak.d]?.slice(0, 3)} {String(peak.h).padStart(2, "0")}:00</span>}
      </div>
    </>
  );
}

/** Today's compliance by day as a line that fills the card. */
function Spark({ values, color = "var(--color-data)" }: { values: number[]; color?: string }) {
  if (values.length < 2) return <div className="h-9" />;
  const W = 120, H = 36, lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * W, H - 3 - ((v - lo) / span) * (H - 6)]);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-9 w-full overflow-visible" role="img" aria-label="Trend over the last 14 days">
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Bar({ value, tone = "ink", label }: { value: number; tone?: "ink" | "ok" | "warn" | "bad"; label: string }) {
  const f = Math.max(0, Math.min(1, value));
  const bg = tone === "ok" ? "bg-ok" : tone === "warn" ? "bg-warn" : tone === "bad" ? "bg-bad" : "bg-ink";
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(f * 100)} className="h-2 overflow-hidden rounded-full bg-sunken">
      <i className={cx("block h-full rounded-full", bg)} style={{ width: `${f * 100}%` }} />
    </div>
  );
}

const PILL: Record<"ok" | "warn" | "bad" | "idle", string> = {
  ok: "border-ok-line bg-ok-soft text-ok", warn: "border-warn-line bg-warn-soft text-warn", bad: "border-bad-line bg-bad-soft text-bad", idle: "border-line bg-sunken text-ink-3",
};
const Pill = ({ tone, children }: { tone: keyof typeof PILL; children: ReactNode }) => (
  <span className={cx("inline-flex h-6 items-center rounded-full border px-2.5 text-xs font-semibold whitespace-nowrap", PILL[tone])}>{children}</span>
);

/** One headline figure: label, value, a status pill, one small graphic, one line of context. */
function Kpi({ label, icon, value, unit, pill, viz, foot }:
  { label: string; icon: IconName; value: ReactNode; unit?: ReactNode; pill?: ReactNode; viz?: ReactNode; foot?: ReactNode }) {
  return (
    <Panel className="flex flex-col gap-2.5 p-5" aria-label={label}>
      <div className="flex items-center justify-between gap-2 font-medium text-ink-2">{label}<Icon name={icon} size={18} className="text-ink-3" /></div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1.5">
        <span className="num text-[34px] leading-none font-bold tracking-[-0.02em]">{value}</span>
        {unit && <span className="text-sm font-medium text-ink-3">{unit}</span>}
        {pill}
      </div>
      {viz}
      {foot && <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-3">{foot}</div>}
    </Panel>
  );
}

const Tags = ({ items }: { items: string[] }) => (
  <div className="flex flex-wrap gap-1.5">
    {items.map((i) => (
      <span key={i} className="inline-flex h-[22px] items-center gap-1 rounded-md border border-bad-line bg-bad-soft px-2 text-xs font-semibold whitespace-nowrap text-bad">
        <Icon name={ITEM_ICON[i] ?? "alert"} size={13} />{violationLabel(i)}
      </span>
    ))}
  </div>
);

/** "A, B, C and 4 more": names stay readable at plant scale. */
const names = (xs: { name: string }[], max = 3) =>
  xs.length <= max ? xs.map((x) => x.name).join(", ") : `${xs.slice(0, max).map((x) => x.name).join(", ")} and ${xs.length - max} more`;

const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; };
const rateColor = (r: number, target: number) => (r < target - 0.025 ? "var(--color-bad)" : r < target ? "var(--color-warn)" : "var(--color-data)");
const hhmm = (t: number) => new Date(t * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/**
 * Where a supervisor has to go now: one row per unsafe camera with its live picture (boxes on), who is
 * flagged and what they are missing, and a button straight to that camera. The list scrolls inside a
 * fixed-height box, so cameras turning unsafe or safe never push the rest of the page around.
 */
function ActNow({ unsafe, onOpen, online, lastAt }: { unsafe: StreamInfo[]; onOpen: (id: string) => void; online: number; lastAt: number | null }) {
  return (
    <section aria-label="Act now" className="flex min-h-0 flex-col gap-3 lg:h-full">
      <div className="flex items-center justify-between gap-3">
        <h3 className="eyebrow">Act now{unsafe.length > 0 && <span className="num ml-1.5 text-bad">{unsafe.length}</span>}</h3>
        <a href={href("monitoring")} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-[13px] font-semibold text-ink no-underline hover:bg-sunken">
          Open Live<Icon name="arrowRight" size={14} />
        </a>
      </div>
      {unsafe.length === 0 ? (
        <div className="grid flex-1 place-items-center rounded-lg border border-dashed border-ok-line bg-ok-soft px-4 py-6 text-center">
          <div>
            <Icon name="check" size={22} className="mx-auto text-ok" />
            <p className="mt-2 text-sm font-semibold text-ink">Nobody is unsafe right now</p>
            <p className="mt-0.5 text-[13px] text-ink-3">{online} camera{online === 1 ? "" : "s"} watching{lastAt ? <> · last incident {fmtAgo(lastAt, Date.now() / 1000)}</> : null}</p>
          </div>
        </div>
      ) : (
        <ul className="scroll-thin max-h-[300px] min-h-0 flex-1 space-y-2.5 overflow-y-auto pr-1 lg:max-h-none">
          {unsafe.map((s) => {
            const flagged = s.people.filter((p) => p.status === "non_compliant");
            const missing = [...new Set(flagged.flatMap((p) => p.missing))];
            const zones = [...new Set(flagged.map((p) => p.zone).filter(Boolean))] as string[];
            return (
              <li key={s.id} className="grid grid-cols-[96px_minmax(0,1fr)_auto] items-center gap-3.5 rounded-lg border border-line bg-surface-2 p-2.5 max-sm:grid-cols-[80px_minmax(0,1fr)]">
                <button type="button" onClick={() => onOpen(s.id)} aria-label={`Open ${s.name}`} className="block overflow-hidden rounded-md">
                  <CameraVideo streamId={s.id} fps={2} aspect={16 / 10} width={192} className="w-full" />
                </button>
                <div className="min-w-0">
                  <h4 className="truncate text-sm font-semibold">{s.name}</h4>
                  <p className="mt-0.5 truncate text-[12.5px] text-ink-3">
                    <span className="num">{s.violations}</span> of <span className="num">{s.workers}</span> in view{zones.length > 0 && ` · ${zones.join(", ")}`}
                  </p>
                  <div className="mt-1.5">{missing.length ? <Tags items={missing} /> : <Tag tone="bad">Unsafe</Tag>}</div>
                </div>
                <Button size="sm" onClick={() => onOpen(s.id)} className="max-sm:col-span-2">Open camera</Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

type FleetFilter = "all" | "violation" | "down";

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
  const [fleetFilter, setFleetFilter] = useState<FleetFilter>("all");
  const [, tick] = useState(0);
  useEffect(() => { const t = window.setInterval(() => tick((n) => n + 1), 15_000); return () => window.clearInterval(t); }, []);
  const openCamera = useCallback((id: string) => navigateWith("monitoring", { camera: id }), []);

  const live = useMemo(() => ({
    workers: streams.reduce((n, s) => n + s.workers, 0),
    bad: streams.reduce((n, s) => n + s.violations, 0),
    online: streams.filter((s) => s.status === "live").length,
    problems: streams.filter(isProblem),
    unsafe: streams.filter((s) => s.violations > 0), // configured camera order
  }), [streams]);
  const fc = useMemo(() => fleetCounts(streams), [streams]);
  const fleetShown = useMemo(() => streams.filter((s) => fleetFilter === "all" || fleetState(s) === fleetFilter), [streams, fleetFilter]);

  const target = data?.week.compliance_target ?? 0.95;
  const rate = data?.today.compliance_rate ?? null;
  const review = data?.week.review;
  const reviewedShare = review && review.total ? review.reviewed / review.total : 0;
  const avgDay = data?.week.avg_violations_per_day ?? null;
  const today = info?.violations_today ?? 0;
  const order = new Map(streams.map((s, i) => [s.id, i]));
  const camRows = (data?.camsWeek ?? []).filter((c) => c.compliance_rate !== null)
    .sort((a, b) => (order.get(a.stream_id) ?? 1e6) - (order.get(b.stream_id) ?? 1e6)); // camera order
  const lo = Math.min(0.85, ...camRows.map((c) => c.compliance_rate! - 0.02));
  const pos = (r: number) => `${Math.max(2, ((r - lo) / (1 - lo)) * 100)}%`;
  const ppeRows = (data?.ppe ?? []).filter((p) => p.count > 0).sort((a, b) => b.count - a.count).slice(0, 6);
  const ppeMax = Math.max(1, ...ppeRows.map((p) => p.count));
  const trendPts = (trend ?? []).filter((p) => p.compliance_rate !== null) as (TimePoint & { compliance_rate: number })[];
  const trendAvg = trendPts.length ? (trendPts.reduce((a, p) => a + p.compliance_rate, 0) / trendPts.length) * 100 : null;
  const trendBelow = trendPts.filter((p) => p.compliance_rate < target).length;
  const sparkVals = (spark ?? []).filter((p) => p.compliance_rate !== null).map((p) => p.compliance_rate! * 100);
  const aboveAvg = avgDay !== null && today > avgDay;
  const avgPct = avgDay ? Math.round((Math.abs(today - avgDay) / avgDay) * 100) : null;

  const status = !connected ? { tone: "bad" as const, title: "Live connection lost", sub: "Figures and video are frozen. Reconnecting automatically." }
    : live.bad ? { tone: "bad" as const, title: `${live.bad} worker${live.bad === 1 ? "" : "s"} need${live.bad === 1 ? "s" : ""} attention now`, sub: `On ${names(live.unsafe)}. Walk over or tell the area supervisor, then confirm in Review.` }
    : live.problems.length ? { tone: "warn" as const, title: "Everyone in view is compliant", sub: `${live.problems.length} camera${live.problems.length === 1 ? " is" : "s are"} not delivering: ${names(live.problems)}.` }
    : { tone: "ok" as const, title: streams.length ? "All clear across the plant" : "No cameras yet", sub: streams.length ? `${live.workers} worker${live.workers === 1 ? "" : "s"} in view on ${live.online} live camera${live.online === 1 ? "" : "s"}, all compliant.` : "Add a camera in Setup to start monitoring." };

  return (
    <Page wide={false} title={`${greeting()}, ${user?.username ?? ""}`}
      description={`${new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })} · plant status, review progress and today's compliance.`}
      actions={<>
        {canAnalytics && <a href={href("reports")} className="inline-flex h-10 items-center gap-2 rounded-lg border border-line-strong bg-surface px-4 text-[13.5px] font-semibold text-ink no-underline shadow-[var(--sh-xs)] hover:bg-sunken"><Icon name="reports" size={16} />Insights</a>}
        {canIncidents && (
          <button type="button" onClick={() => navigateWith("incidents", {})}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-pri px-4 text-[13.5px] font-semibold text-pri-ink shadow-[var(--sh-xs)] hover:bg-pri-hover">
            <Icon name="incidents" size={16} />Start reviewing{open.items ? ` (${fmtInt(open.total)})` : ""}
          </button>
        )}
      </>}>
      {error && <Notice tone="bad" title="Couldn't load the figures" className="mb-5">{error}</Notice>}

      {/* ---- 1. status: is anyone unsafe right now? ---- */}
      <Panel className={cx("mb-4 grid gap-0 overflow-hidden border-l-4 lg:h-[330px] lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]",
        status.tone === "ok" ? "border-l-ok" : status.tone === "warn" ? "border-l-warn" : "border-l-bad")} aria-label="Plant status">
        <div className="flex flex-col gap-4 p-6 lg:border-r lg:border-line">
          <span className={cx("inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold",
            status.tone === "ok" ? PILL.ok : status.tone === "warn" ? PILL.warn : PILL.bad)}>
            <span className={cx("size-2 rounded-full bg-current", connected && "live-ping")} />
            {status.tone === "ok" ? "All clear" : status.tone === "warn" ? "Needs a look" : "Action needed"}
          </span>
          <h2 className="max-w-[18ch] text-[28px] leading-[1.15] font-bold tracking-[-0.02em] sm:text-[32px]">{status.title}</h2>
          <p className="line-clamp-3 max-w-[46ch] text-sm text-ink-2">{status.sub}</p>
          <div className="mt-auto flex flex-wrap gap-x-6 gap-y-2">
            <span className="flex flex-col"><b className="num text-[22px] font-bold">{live.online} / {streams.length}</b><span className="text-xs text-ink-3">cameras online</span></span>
            <span className="flex flex-col"><b className="num text-[22px] font-bold">{fmtInt(live.workers)}</b><span className="text-xs text-ink-3">workers in view</span></span>
            <span className="flex flex-col"><b className={cx("num text-[22px] font-bold", live.bad ? "text-bad" : "")}>{live.bad}</b><span className="text-xs text-ink-3">unsafe now</span></span>
          </div>
        </div>
        <div className="min-h-0 p-5 max-lg:border-t max-lg:border-line">
          <ActNow unsafe={live.unsafe} onOpen={openCamera} online={live.online} lastAt={open.items?.[0]?.timestamp ?? null} />
        </div>
      </Panel>

      {/* ---- 2. key figures ---- */}
      <section aria-label="Key figures" className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {canAnalytics && (
          <Kpi label="Compliance today" icon="shield"
            value={!data ? <Skeleton className="h-9 w-24" /> : rate === null ? <span className="text-[15px] font-semibold text-ink-3">{live.workers > 0 ? "Calculating…" : "No workers yet"}</span> : <>{(rate * 100).toFixed(1)}%</>}
            pill={rate !== null && <Pill tone={rate >= target ? "ok" : rate >= target - 0.025 ? "warn" : "bad"}>{rate >= target ? "At or above target" : `${((target - rate) * 100).toFixed(1)} pts below target`}</Pill>}
            viz={<Spark values={sparkVals} color={rate !== null && rate < target ? "var(--color-bad)" : "var(--color-data)"} />}
            foot={<>Target {fmtPct(target, 0)}{data && rate !== null && data.today.workers_seen ? ` · ${fmtInt(data.today.workers_seen)} workers checked today` : ""}</>} />
        )}
        {canIncidents && (
          <Kpi label="Review queue" icon="incidents"
            value={open.items ? fmtInt(open.total) : <Skeleton className="h-9 w-16" />} unit="waiting for a verdict"
            viz={<Bar value={reviewedShare} tone={reviewedShare > 0.8 ? "ok" : "ink"} label="Alerts reviewed this week" />}
            foot={review ? <>{fmtPct(reviewedShare, 0)} of this week's alerts reviewed{review.precision != null && ` · ${fmtPct(review.precision, 0)} were real`}</> : "Incidents waiting for a verdict"} />
        )}
        <Kpi label="Incidents today" icon="clock" value={fmtInt(today)}
          pill={avgPct !== null && avgPct > 0 && avgDay && <Pill tone={aboveAvg ? "warn" : "ok"}>{avgPct >= 200 ? `${(today / avgDay).toFixed(1)}× the average` : `${avgPct}% ${aboveAvg ? "above" : "below"} average`}</Pill>}
          viz={avgDay ? <Bar value={today / (avgDay * 2)} tone={aboveAvg ? "warn" : "ok"} label="Incidents today against the weekly average" /> : <div className="h-2" />}
          foot={avgDay !== null ? <>{aboveAvg ? "Above" : "Below"} the 7-day average of {avgDay.toFixed(1)}</> : "Recorded since midnight"} />
        <Kpi label="Cameras" icon="monitoring" value={live.online} unit={`of ${streams.length} online`}
          viz={<Bar value={streams.length ? live.online / streams.length : 0} tone={live.problems.length ? "warn" : "ok"} label="Cameras online" />}
          foot={live.problems.length ? <><Pill tone="warn">{live.problems.length} not delivering</Pill>{names(live.problems, 2)}</> : <>All delivering{info?.device && ` · detector on ${info.device}`}</>} />
      </section>

      {/* ---- 3. the whole fleet ---- */}
      {streams.length > 0 && (
        <Card className="mb-4" title="Camera fleet" sub={`All ${streams.length} camera${streams.length === 1 ? "" : "s"} in camera order. Select one to open its live view.`}
          actions={<>
            <Segmented size="sm" label="Filter cameras" value={fleetFilter} onChange={setFleetFilter}
              options={[{ value: "all", label: "All", count: streams.length }, { value: "violation", label: "Unsafe", count: fc.violation }, { value: "down", label: "Not delivering", count: fc.down }]} />
            <a href={href("monitoring")} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-semibold text-accent no-underline hover:bg-accent-soft">Video wall<Icon name="arrowRight" size={14} /></a>
          </>}>
          <div className="mb-3.5"><FleetLegend streams={streams} /></div>
          {fleetShown.length === 0
            ? <p className="py-6 text-center text-[13px] text-ink-3">{fleetFilter === "violation" ? "No camera has an unsafe worker right now." : "Every camera is delivering video."}</p>
            : <FleetBoard streams={fleetShown} onOpen={openCamera} dense />}
        </Card>
      )}

      {/* ---- 4. trend and what is missed ---- */}
      {canAnalytics && (
        <div className="mb-4 grid gap-4 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
          <Card title="Compliance trend" sub={`Share of workers checked who were never flagged. Dashed line is the ${fmtPct(target, 0)} target.`}
            actions={<Segmented size="sm" label="Trend range" value={days} onChange={setDays} options={[{ value: "7", label: "7D" }, { value: "14", label: "14D" }, { value: "30", label: "30D" }]} />}>
            <div className="flex min-h-[190px] flex-col">{trend === null ? <Skeleton className="h-44" /> : <Trend points={trend} target={target} />}</div>
            {trendAvg !== null && trendPts.length >= 2 && (
              <p className="mt-2 text-[12.5px] text-ink-3">Average {trendAvg.toFixed(1)}% over {trendPts.length} day{trendPts.length === 1 ? "" : "s"} with workers checked. Below target on {trendBelow} of {trendPts.length} (red markers).</p>
            )}
            {camRows.length > 0 && (
              <div className="mt-5 grid gap-x-8 gap-y-3.5 border-t border-line pt-4 sm:grid-cols-2">
                {camRows.slice(0, 6).map((c) => (
                  <div key={c.stream_id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 text-[13px]">
                    <b className="truncate font-semibold" title={c.stream_name}>{c.stream_name}</b>
                    <span className="num text-[12.5px] font-medium">{fmtPct(c.compliance_rate)}</span>
                    <div className="relative col-span-2 h-1.5 rounded-full bg-sunken">
                      <i className="block h-full rounded-full" style={{ width: pos(c.compliance_rate!), background: rateColor(c.compliance_rate!, target) }} />
                      <span className="absolute -top-[3px] -bottom-[3px] w-0.5 rounded bg-ink-3" style={{ left: pos(target) }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card title="What's being missed" sub="Incidents by type, last 7 days">
            {!data ? <Skeleton className="h-40" /> : ppeRows.length === 0 ? <p className="text-[13px] text-ink-3">No incidents in the last 7 days.</p> : (
              <>
                <div>
                  {ppeRows.map((p) => (
                    <div key={p.item} className="grid grid-cols-[112px_minmax(0,1fr)_40px] items-center gap-3 py-[7px] text-sm max-sm:grid-cols-[96px_minmax(0,1fr)_32px]">
                      <span className="flex items-center gap-2 truncate"><Icon name={ITEM_ICON[p.item] ?? "alert"} size={15} className="shrink-0 text-ink-3" />{violationLabel(p.item)}</span>
                      <span className="h-3 overflow-hidden rounded-full bg-sunken"><i className="block h-full rounded-full bg-data" style={{ width: `${(p.count / ppeMax) * 100}%` }} /></span>
                      <b className="num text-right font-semibold">{fmtInt(p.count)}</b>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-[12.5px] text-ink-3">
                  {fmtInt(data.week.total_violations)} incident{data.week.total_violations === 1 ? "" : "s"} in total. {violationLabel(ppeRows[0].item)} is {fmtPct(ppeRows[0].share, 0)} of them.
                </p>
              </>
            )}
          </Card>
        </div>
      )}

      {/* ---- 5. events and timing ---- */}
      <div className={cx("grid gap-4", canIncidents && canAnalytics ? "xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]" : "")}>
        {canIncidents && (
          <Card title="Latest events" sub="Incidents not reviewed yet, newest first" bodyClass="pt-3"
            actions={<Button size="sm" onClick={() => navigateWith("incidents", {})}>Open Review</Button>}>
            {open.failed ? <div className="px-5 pb-5"><Notice tone="bad">Couldn't load incidents.</Notice></div>
              : open.items === null ? <div className="space-y-2 px-5 pb-5">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12" />)}</div>
              : open.items.length === 0 ? <div className="px-5 pb-5"><Empty icon="check" title="Queue is clear">Every incident has a verdict. New ones appear here the moment they are confirmed.</Empty></div>
              : (
                <div className="scroll-thin overflow-x-auto">
                  <table className="table">
                    <thead><tr><th scope="col">Time</th><th scope="col">Camera</th><th scope="col">Missing</th><th scope="col" className="max-sm:hidden">Duration</th><th scope="col" className="max-sm:hidden"><span className="sr-only">Action</span></th></tr></thead>
                    <tbody>
                      {open.items.map((v) => (
                        <tr key={v.id} className={cx("cursor-pointer", v.id === open.fresh && "animate-[flash_2.6s]")} onClick={() => navigateWith("incidents", { id: v.id })}>
                          <td className="num font-mono text-[13px] whitespace-nowrap">{hhmm(v.timestamp)}</td>
                          <td className="min-w-0"><span className="block max-w-[200px] truncate font-medium">{v.stream_name}</span><span className="font-mono text-xs text-ink-3">#{v.track_id}</span></td>
                          <td><Tags items={v.missing} /></td>
                          <td className="num whitespace-nowrap text-ink-2 max-sm:hidden">{v.state === "ongoing" ? <Tag tone="bad">Ongoing</Tag> : v.duration != null ? fmtDuration(v.duration) : "-"}</td>
                          <td className="text-right max-sm:hidden"><Button size="sm" onClick={(e) => { e.stopPropagation(); navigateWith("incidents", { id: v.id }); }}>Review</Button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </Card>
        )}
        {canAnalytics ? (
          <Card title="When it happens" sub="Incidents by hour and weekday, last 4 weeks">
            {!data ? <Skeleton className="h-40" /> : data.heat.max === 0 ? <p className="text-[13px] text-ink-3">No incidents in the last 4 weeks.</p> : <HourHeat heat={data.heat} />}
          </Card>
        ) : (
          <Card title="Cameras" sub="Select one to open its live view"><FleetBoard streams={streams} onOpen={openCamera} /></Card>
        )}
      </div>
    </Page>
  );
}
