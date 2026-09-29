import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { HeatmapChart } from "../components/analytics/charts";
import { axisProps, ChartCard, fmtInt, pct, PPE_ORDER, ppeColor, PpeLegend, SERIES, TARGET, TipBox, useChartColors } from "../components/analytics/viz";
import { PageBody } from "../components/layout/PageBody";
import { Topbar } from "../components/layout/Topbar";
import { Badge, Button, Card, EmptyState, Icon, Input, Skeleton, useToast } from "../components/ui";
import { api, saveBlob, type AnalyticsQuery } from "../lib/api";
import { dateRangeToEpoch, dayKey, fmtDateTime, ppeLabel } from "../lib/format";
import { useMonitor } from "../state/monitor";
import type { AnalyticsSummary, CameraStats, Heatmap, Offender, PpeCount, TimeSeries } from "../types";

type Preset = "today" | "7d" | "30d" | "90d" | "custom";
type Gran = "hour" | "day" | "week";
const PRESETS: { id: Preset; label: string }[] = [
  { id: "today", label: "Today" }, { id: "7d", label: "7 days" }, { id: "30d", label: "30 days" },
  { id: "90d", label: "90 days" }, { id: "custom", label: "Custom" },
];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const GOOD = "#0ca30c"; // status colour: compliant (always paired with a label)
const BAD = "#d03b3b"; // status colour: non-compliant

/** Long auto-generated camera names (NVR channels / video filenames) blow up chart
 *  axis labels, wrapping over several lines. Clamp them for axis display only —
 *  tooltips and tables keep the full name. */
const shortName = (s: string, n = 18) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

interface Data {
  summary: AnalyticsSummary;
  cameras: CameraStats[];
  ppe: PpeCount[];
  heatmap: Heatmap;
  offenders: Offender[];
}

function rangeFor(preset: Preset, from: string, to: string): { start: number; end: number } | null {
  const now = new Date();
  const midnight = (daysAgo: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo).getTime() / 1000;
  const end = Math.ceil(now.getTime() / 1000);
  switch (preset) {
    case "today": return { start: midnight(0), end };
    case "7d": return { start: midnight(6), end };
    case "30d": return { start: midnight(29), end };
    case "90d": return { start: midnight(89), end };
    default: {
      const r = dateRangeToEpoch(from, to);
      return r.start === undefined || r.end === undefined || r.end <= r.start ? null : { start: r.start, end: r.end };
    }
  }
}

const dayShort = (t: number) => { const d = new Date(t * 1000); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const hourShort = (t: number) => `${String(new Date(t * 1000).getHours()).padStart(2, "0")}:00`;
const tickLabel = (t: number, g: Gran) => (g === "hour" ? hourShort(t) : g === "week" ? `wk ${dayShort(t)}` : dayShort(t));
const bucketLong = (t: number, g: Gran, size: number) => g === "hour" ? `${dayShort(t)}, ${hourShort(t)}–${hourShort(t + size)}`
  : g === "week" ? `Week of ${new Date(t * 1000).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })}`
    : new Date(t * 1000).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" });

// ------------------------------------------------------------------ small pieces
function Kpi({ label, value, sub, delta, loading, icon, title }: { label: string; value: ReactNode; sub?: ReactNode; delta?: ReactNode; loading: boolean; icon?: ReactNode; title?: string }) {
  return (
    <Card className="flex min-w-0 flex-col gap-1 p-4">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase">{icon}{label}</p>
      {loading ? <><Skeleton className="mt-1 h-8 w-24" /><Skeleton className="h-3 w-32" /></> : (
        <>
          <p title={title} className="mt-0.5 truncate text-[26px] leading-tight font-semibold tracking-tight">{value}</p>
          {delta}
          {sub && <p className="text-xs text-muted">{sub}</p>}
        </>
      )}
    </Card>
  );
}

/** Direction + words, not colour alone. `upIsBad` picks the colour. */
function Delta({ now, prev, upIsBad, format, period }: { now: number | null; prev: number | null; upIsBad: boolean; format: (d: number) => string; period: string }) {
  if (now == null || prev == null) return <p className="text-xs text-muted">No data for the previous {period}</p>;
  const d = now - prev;
  if (Math.abs(d) < 1e-9) return <p className="text-xs text-muted">Same as the previous {period}</p>;
  const bad = upIsBad ? d > 0 : d < 0;
  return (
    <p className={`text-xs font-medium ${bad ? "text-danger" : "text-success-text"}`}>
      {d > 0 ? "▲" : "▼"} {format(Math.abs(d))} {d > 0 ? "higher" : "lower"} <span className="font-normal text-muted">than the previous {period}</span>
    </p>
  );
}

function Trend({ now, prev, upIsBad, fmt }: { now: number | null; prev: number | null; upIsBad: boolean; fmt: (d: number) => string }) {
  if (now == null || prev == null) return <span className="text-muted">—</span>;
  const d = now - prev;
  if (Math.abs(d) < 1e-9) return <span className="text-muted" title="No change">→ 0</span>;
  const bad = upIsBad ? d > 0 : d < 0;
  return <span className={`font-medium ${bad ? "text-danger" : "text-success-text"}`} title={bad ? "Getting worse" : "Improving"}>{d > 0 ? "▲" : "▼"} {fmt(Math.abs(d))}</span>;
}

function Chip({ on, onClick, children, color }: { on: boolean; onClick: () => void; children: ReactNode; color?: string }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick}
      className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium ${on ? "border-primary bg-primary-soft text-primary" : "border-border text-muted hover:text-text"}`}>
      {color && <span className="h-2 w-2 rounded-full" style={{ background: color }} />}
      {on && !color && <Icon.check size={13} />}{children}
    </button>
  );
}

// ------------------------------------------------------------------ CSV (the current view)
function toCsv(d: Data, series: TimeSeries, label: string): string {
  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines: string[] = [];
  const row = (...xs: unknown[]) => lines.push(xs.map(esc).join(","));
  const s = d.summary;
  row("PPE compliance analytics"); row("View", label); row("Generated", fmtDateTime(Date.now() / 1000)); row();
  row("KPIs"); row("metric", "value");
  row("total_violations", s.total_violations); row("previous_period_violations", s.previous_total_violations);
  row("compliance_rate", s.compliance_rate ?? ""); row("compliance_target", s.compliance_target);
  row("workers_detected", s.workers_seen); row("workers_flagged", s.workers_flagged);
  row("avg_workers_detected_per_day", s.avg_workers_per_day); row("avg_violations_per_day", s.avg_violations_per_day);
  row("live_cameras", `${s.cameras.live}/${s.cameras.configured}`); row("open_unacknowledged", s.unacknowledged); row();
  row(`Violations over time (${series.granularity})`); row("bucket_start_local", "violations", "workers_detected", "workers_flagged", "compliance_rate");
  series.points.forEach((p) => row(fmtDateTime(p.t), p.violations, p.workers_seen, p.workers_flagged, p.compliance_rate ?? "")); row();
  row("Camera leaderboard"); row("camera_id", "camera", "violations", "previous_period", "compliance_rate", "previous_compliance", "open", ...PPE_ORDER);
  d.cameras.forEach((c) => row(c.stream_id, c.stream_name, c.violations, c.previous_violations, c.compliance_rate ?? "", c.previous_compliance_rate ?? "", c.unacknowledged, ...PPE_ORDER.map((i) => c.by_ppe[i] ?? 0))); row();
  row("Violation share by missing PPE"); row("item", "violations", "share");
  d.ppe.forEach((p) => row(p.item, p.count, p.share)); row();
  row("Heatmap (violations, local time)"); row("day", ...Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}h`));
  d.heatmap.grid.forEach((r, i) => row(d.heatmap.days[i], ...r)); row();
  row("Top repeat offenders (track IDs are per camera session, not a person's identity)");
  row("camera", "track_id", "session", "violations", "missing", "first_seen", "last_seen");
  d.offenders.forEach((o) => row(o.stream_name, o.track_id, o.run_id ?? "unknown", o.violations, o.missing.join(";"), fmtDateTime(o.first_seen), fmtDateTime(o.last_seen)));
  return lines.join("\r\n") + "\r\n";
}

// ------------------------------------------------------------------ page
type SortKey = "stream_name" | "violations" | "delta" | "compliance_rate" | "unacknowledged";

export function AnalyticsPage() {
  const toast = useToast();
  const { streams } = useMonitor();
  const [preset, setPreset] = useState<Preset>("7d");
  const [from, setFrom] = useState(() => dayKey(Date.now() / 1000 - 6 * 86400));
  const [to, setTo] = useState(() => dayKey(Date.now() / 1000));
  const [cameras, setCameras] = useState<string[]>([]);
  const [ppe, setPpe] = useState<string[]>([]);
  const [gran, setGran] = useState<Gran | "auto">("auto");
  const [data, setData] = useState<Data | null>(null);
  const [series, setSeries] = useState<TimeSeries | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "violations", desc: true });
  const req = useRef(0);
  const seriesReq = useRef(0);

  const range = useMemo(() => rangeFor(preset, from, to), [preset, from, to, nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  const span = range ? range.end - range.start : 0;
  const grans: Gran[] = span <= 2 * 86400 ? ["hour", "day"] : ["day", "week"];
  const g: Gran = gran !== "auto" && grans.includes(gran) ? gran : grans[0];
  const query = useMemo<AnalyticsQuery | null>(() => range && {
    ...range, camera: cameras.length ? cameras : undefined, ppe: ppe.length ? ppe : undefined, tz: -new Date().getTimezoneOffset(),
  }, [range, cameras, ppe]);

  // The five range-driven datasets. These do NOT depend on the chart granularity,
  // so toggling Hourly/Daily/Weekly must not refetch them (see the timeseries effect below).
  useEffect(() => {
    if (!query) return;
    const id = ++req.current;
    setLoading(true);
    setError(null);
    Promise.all([
      api.analytics.summary(query), api.analytics.byCamera(query),
      api.analytics.byPpe(query), api.analytics.heatmap(query), api.analytics.topOffenders(query, 5),
    ]).then(([summary, cams, ppeRows, heatmap, offenders]) => {
      if (id === req.current) setData({ summary, cameras: cams, ppe: ppeRows, heatmap, offenders });
    }).catch((e) => id === req.current && setError((e as Error).message))
      .finally(() => id === req.current && setLoading(false));
  }, [query]);

  // The timeseries is the only dataset bucketed by granularity, so it refetches on its own
  // when either the range/filters (query) or the granularity (g) change.
  useEffect(() => {
    if (!query) return;
    const id = ++seriesReq.current;
    api.analytics.timeseries(query, g)
      .then((s) => { if (id === seriesReq.current) setSeries(s); })
      .catch((e) => { if (id === seriesReq.current) setError((e as Error).message); });
  }, [query, g]);

  const periodDays = Math.max(1, Math.round(span / 86400));
  const period = preset === "today" ? "day" : `${periodDays} days`;
  const cameraLabel = cameras.length ? cameras.map((c) => streams.find((s) => s.id === c)?.name ?? c).join(", ") : "All cameras";
  const ppeLabelText = ppe.length ? `missing ${ppe.map((p) => ppeLabel(p).toLowerCase()).join(" / ")}` : "all PPE types";
  const rangeLabel = range ? `${fmtDateTime(range.start)} – ${fmtDateTime(range.end)}` : "";
  const s = data?.summary;
  const total = s?.total_violations ?? 0;
  const noData = !loading && !!data && total === 0;
  const target = s?.compliance_target ?? 0.95;
  const size = series?.bucket_seconds ?? 86400;
  const toggle = (xs: string[], x: string) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);

  const exportCsv = useCallback(() => {
    if (!data || !series) return;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    saveBlob(new Blob([toCsv(data, series, `${rangeLabel} · ${cameraLabel} · ${ppeLabelText}`)], { type: "text/csv;charset=utf-8" }), `ppe-analytics-${stamp}.csv`);
    toast({ tone: "success", title: "CSV downloaded", message: "Every chart of the current view in one file." });
  }, [data, series, rangeLabel, cameraLabel, ppeLabelText, toast]);

  // ---------- chart data
  const points = (series?.points ?? []).map((p) => ({ ...p, label: tickLabel(p.t, g), rate: p.compliance_rate == null ? null : p.compliance_rate * 100 }));
  const hasCompliance = points.some((p) => p.rate != null);
  const presentItems = PPE_ORDER.filter((it) => (data?.ppe ?? []).some((p) => p.item === it));
  const camRows = useMemo(() => (data?.cameras ?? []).filter((c) => !cameras.length || cameras.includes(c.stream_id)), [data, cameras]);
  const stacked = camRows.filter((c) => c.violations > 0).map((c) => ({ name: c.stream_name, short: shortName(c.stream_name, 16), id: c.stream_id, total: c.violations, ...c.by_ppe }));
  const donut = [...(data?.ppe ?? [])].sort((a, b) => PPE_ORDER.indexOf(a.item) - PPE_ORDER.indexOf(b.item));
  const itemTotal = donut.reduce((a, p) => a + p.count, 0);
  const topItem = [...donut].sort((a, b) => b.count - a.count)[0];
  const offenders = (data?.offenders ?? []).map((o) => ({ ...o, label: `${shortName(o.stream_name, 16)} · #${o.track_id}` }));
  const funnel = s ? [
    { stage: "Workers seen", value: s.workers_seen, color: SERIES },
    { stage: "Fully compliant", value: s.workers_seen - s.workers_flagged, color: GOOD },
    { stage: "Flagged at least once", value: s.workers_flagged, color: BAD },
  ] : [];
  const leaderboard = useMemo(() => {
    const val = (c: CameraStats): number | string => sort.key === "delta" ? c.violations - c.previous_violations
      : sort.key === "stream_name" ? c.stream_name : (c[sort.key] ?? -1);
    return [...camRows].sort((a, b) => {
      const va = val(a), vb = val(b);
      const cmp = typeof va === "string" ? va.localeCompare(vb as string) : va - (vb as number);
      return sort.desc ? -cmp : cmp;
    });
  }, [camRows, sort]);
  const th = (key: SortKey, label: string, right = false) => (
    <th className={`px-3 py-2.5 font-medium ${right ? "text-right" : ""}`} aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button type="button" className="inline-flex items-center gap-1 uppercase hover:text-text" onClick={() => setSort((x) => ({ key, desc: x.key === key ? !x.desc : key !== "stream_name" }))}>
        {label}{sort.key === key && <span aria-hidden>{sort.desc ? "▼" : "▲"}</span>}
      </button>
    </th>
  );

  const c = useChartColors();
  const ap = axisProps(c);

  return (
    <>
      <Topbar title="Analytics" subtitle={range ? `${rangeLabel} · ${cameraLabel} · ${ppeLabelText}` : "Choose a date range"}
        extra={
          <div className="flex items-center gap-2 print:hidden">
            <Button size="sm" variant="ghost" icon={<Icon.history size={14} />} onClick={() => setNonce((n) => n + 1)} disabled={loading}>Refresh</Button>
            <Button size="sm" icon={<Icon.download size={14} />} onClick={exportCsv} disabled={!data || !series || loading}>CSV</Button>
            <Button size="sm" icon={<Icon.printer size={14} />} onClick={() => window.print()} disabled={!data || loading} title="Print or save as PDF">PDF</Button>
          </div>
        } />
      <PageBody>
        {/* one filter row drives every chart below */}
        <Card className="mb-6 flex flex-col gap-2.5 px-4 py-3 print:hidden">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2" role="group" aria-labelledby="range-label">
            <span className="w-20 shrink-0 text-[13px] font-medium text-muted" id="range-label">Date range</span>
            <div className="inline-flex flex-wrap rounded-lg border border-border bg-subtle p-0.5">
              {PRESETS.map((p) => (
                <button key={p.id} type="button" aria-pressed={preset === p.id} onClick={() => setPreset(p.id)}
                  className={`h-8 rounded-md px-3 text-[13px] font-medium ${preset === p.id ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text"}`}>{p.label}</button>
              ))}
            </div>
            {preset === "custom" && (
              <div className="flex flex-wrap items-center gap-2">
                <Input aria-label="From date" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} invalid={!range} className="h-8 w-auto" />
                <span className="text-[13px] text-muted">to</span>
                <Input aria-label="To date" type="date" value={to} min={from} max={dayKey(Date.now() / 1000)} onChange={(e) => setTo(e.target.value)} className="h-8 w-auto" />
                {!range && <span className="text-xs font-medium text-danger">Start must be on or before the end</span>}
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5" role="group" aria-label="Cameras">
            <span className="w-20 shrink-0 text-[13px] font-medium text-muted">Cameras</span>
            <Chip on={!cameras.length} onClick={() => setCameras([])}>All</Chip>
            {streams.map((st) => <Chip key={st.id} on={cameras.includes(st.id)} onClick={() => setCameras(toggle(cameras, st.id))}>{st.name}</Chip>)}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5" role="group" aria-label="PPE types">
            <span className="w-20 shrink-0 text-[13px] font-medium text-muted">PPE type</span>
            <Chip on={!ppe.length} onClick={() => setPpe([])}>All</Chip>
            {PPE_ORDER.map((it) => <Chip key={it} on={ppe.includes(it)} color={ppeColor(it)} onClick={() => setPpe(toggle(ppe, it))}>{ppeLabel(it)}</Chip>)}
          </div>
          {ppe.length > 0 && <p className="text-xs text-muted">Filtered to violations missing {ppe.map(ppeLabel).join(" or ")}. Compliance and worker-count charts are measured per worker, not per item, so they always show all PPE.</p>}
        </Card>

        <div className="mb-4 hidden text-sm print:block">
          <p className="font-semibold">PPE compliance analytics</p>
          <p className="text-muted">{rangeLabel} · {cameraLabel} · {ppeLabelText}</p>
        </div>

        {error ? (
          <Card><EmptyState icon={<Icon.alert size={20} />} title="Couldn't load analytics" message={error} action={<Button onClick={() => setNonce((n) => n + 1)}>Try again</Button>} /></Card>
        ) : (
          <div className="flex flex-col gap-6">
            <section aria-label="Safety performance">
              <p className="mb-2 text-[11px] font-semibold tracking-wide text-primary uppercase">Safety performance</p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Kpi icon={<Icon.shield size={13} />} label="Compliance rate" loading={loading || !s} value={pct(s?.compliance_rate)}
                  delta={s && s.compliance_rate != null ? (
                    <p className={`text-xs font-medium ${s.compliance_rate >= target ? "text-success-text" : "text-danger"}`}>
                      {s.compliance_rate >= target ? "✓ On target" : `✗ ${((target - s.compliance_rate) * 100).toFixed(1)} pts below`} <span className="font-normal text-muted">({pct(target, 0)} goal)</span>
                    </p>) : undefined}
                  sub={s && (s.compliance_rate != null ? `${fmtInt(s.workers_seen - s.workers_flagged)} of ${fmtInt(s.workers_seen)} workers fully compliant`
                    : s.compliance_data_since ? "No workers counted in this range" : "No worker data yet for this range")} />
                <Kpi icon={<Icon.alert size={13} />} label="Total violations" loading={loading || !s} value={fmtInt(total)}
                  delta={s && <Delta now={s.total_violations} prev={s.previous_total_violations} upIsBad format={fmtInt} period={period} />}
                  sub={s && `${fmtInt(s.unacknowledged)} still open · ${s.avg_violations_per_day}/day`} />
                <Kpi icon={<Icon.camera size={13} />} label="Area needing attention" loading={loading || !s} title={s?.most_flagged_camera?.stream_name} value={s?.most_flagged_camera ? s.most_flagged_camera.stream_name : "—"}
                  sub={s && (s.most_flagged_camera ? `${fmtInt(s.most_flagged_camera.violations)} violations · ${pct(s.most_flagged_camera.compliance_rate)} compliant` : "No violations in this range")} />
              </div>
            </section>

            {noData && !hasCompliance ? (
              <Card><EmptyState icon={<Icon.chart size={20} />} title="No safety data for this range yet"
                message="No violations or worker activity were recorded in the selected dates. Try a wider date range, or wait for the cameras to record new activity." /></Card>
            ) : (
              <>
            {/* Worker compliance — the live per-worker tally. Persists, and is independent of saved violation records. */}
            <section aria-label="Worker compliance">
              <p className="mb-2 text-[11px] font-semibold tracking-wide text-primary uppercase">Worker compliance &middot; live tally</p>
              <div className="grid gap-6 xl:grid-cols-2">
              <ChartCard question="Are we hitting our safety target?" title="Compliance rate trend" loading={loading || !series}
                empty={!loading && !!series && !hasCompliance && "No worker counts in this range yet"}
                description={<>Share of workers seen who were never flagged · green line = {pct(target, 0)} target</>}
                table={{ head: ["Period", "Compliance", "Workers", "Flagged"], rows: points.filter((p) => p.workers_seen).map((p) => [bucketLong(p.t, g, size), pct(p.compliance_rate), p.workers_seen, p.workers_flagged]) }}>
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
                    <CartesianGrid vertical={false} stroke={c.grid} />
                    <XAxis dataKey="label" {...ap} minTickGap={24} />
                    <YAxis {...ap} domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} width={44} tickFormatter={(v) => `${v}%`} />
                    <ReferenceLine y={target * 100} stroke={TARGET} strokeWidth={1.5}
                      label={{ value: `Target ${pct(target, 0)}`, position: "insideTopRight", fontSize: 11, fill: TARGET }} />
                    <Tooltip cursor={{ stroke: c.axis }} content={({ active, payload }) => {
                      const p = active && payload?.length ? payload[0].payload : null;
                      return p ? <TipBox title={bucketLong(p.t, g, size)} rows={p.rate == null ? [{ label: "No workers detected", value: "" }] : [
                        { color: SERIES, label: "Compliant", value: pct(p.compliance_rate) },
                        { label: "Workers without alert", value: `${fmtInt(p.workers_seen - p.workers_flagged)} / ${fmtInt(p.workers_seen)}` },
                        { label: "vs target", value: `${p.rate >= target * 100 ? "+" : ""}${(p.rate - target * 100).toFixed(1)} pts` }]} /> : null;
                    }} />
                    <Line type="linear" dataKey="rate" stroke={SERIES} strokeWidth={2} connectNulls={false}
                      dot={{ r: 3.5, fill: SERIES, stroke: c.hairline, strokeWidth: 2 }} activeDot={{ r: 5, stroke: c.hairline, strokeWidth: 2 }} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </ChartCard>
              <ChartCard question="What share of workers were flagged?" title="Worker compliance breakdown" loading={loading}
                empty={!loading && !!s && !s.workers_seen && "No worker counts in this range yet"}
                description="Of all workers seen this period, how many stayed fully compliant vs. were flagged at least once for missing PPE. Counted live per worker — separate from the saved records in Violations."
                table={funnel.length ? { head: ["Stage", "Workers", "Share"], rows: funnel.map((f) => [f.stage, f.value, pct(s!.workers_seen ? f.value / s!.workers_seen : 0, 1)]) } : undefined}>
                <div className="flex flex-col gap-3 pt-2">
                  {funnel.map((f) => {
                    const share = s!.workers_seen ? f.value / s!.workers_seen : 0;
                    return (
                      <div key={f.stage}>
                        <div className="mb-1 flex items-baseline justify-between text-[13px]">
                          <span className="font-medium">{f.stage}</span>
                          <span className="tabular-nums"><b>{fmtInt(f.value)}</b> <span className="text-muted">· {pct(share, 1)}</span></span>
                        </div>
                        <div className="h-7 overflow-hidden rounded-md bg-subtle">
                          <div className="h-full rounded-r-[4px]" style={{ width: `${Math.max(share * 100, f.value ? 1 : 0)}%`, background: f.color }} />
                        </div>
                      </div>
                    );
                  })}
                  {s && s.workers_seen > 0 && (
                    <p className={`mt-1 text-[13px] ${s.compliance_rate != null && s.compliance_rate >= target ? "text-success-text" : "text-danger"}`}>
                      {s.compliance_rate != null && s.compliance_rate >= target ? "✓" : "✗"} {pct(1 - (s.compliance_rate ?? 0), 1)} of workers were flagged at least once (target: at most {pct(1 - target, 0)}).
                    </p>
                  )}
                </div>
              </ChartCard>
              </div>
            </section>

            {/* Violation records — saved evidence, reviewable in Violations. Subject to clearing / retention, so it can read differently from the live tally above. */}
            <section aria-label="Violation records">
              <p className="mb-2 text-[11px] font-semibold tracking-wide text-primary uppercase">Violation records &middot; saved evidence</p>
              {noData ? (
                <Card><EmptyState icon={<Icon.alert size={20} />}
                  title="No violation records saved for this range"
                  message={<>Live monitoring flagged {fmtInt(s?.workers_flagged ?? 0)} of {fmtInt(s?.workers_seen ?? 0)} workers in these dates (see Worker compliance above), but no violation snapshots are stored for this range. New incidents appear here as they are captured; earlier records may have been cleared from the Violations log.</>} />
                </Card>
              ) : (
                <div className="flex flex-col gap-6">
                  <div className="grid gap-6 xl:grid-cols-2">
              <ChartCard question="Are we improving or worsening?" title="Violations over time" loading={loading || !series} empty={noData && "No violations in this range"}
                description={`${g === "hour" ? "Hourly" : g === "week" ? "Weekly (Mon–Sun)" : "Daily"} totals, local time`}
                actions={
                  <div className="inline-flex rounded-md border border-border bg-subtle p-0.5 print:hidden" role="group" aria-label="Bucket size">
                    {grans.map((x) => (
                      <button key={x} type="button" aria-pressed={g === x} onClick={() => setGran(x)}
                        className={`h-7 rounded px-2 text-xs font-medium ${g === x ? "bg-surface shadow-sm" : "text-muted hover:text-text"}`}>
                        {x === "hour" ? "Hourly" : x === "day" ? "Daily" : "Weekly"}
                      </button>
                    ))}
                  </div>}
                table={{ head: ["Period", "Violations"], rows: points.map((p) => [bucketLong(p.t, g, size), p.violations]) }}>
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
                    <CartesianGrid vertical={false} stroke={c.grid} />
                    <XAxis dataKey="label" {...ap} minTickGap={24} />
                    <YAxis {...ap} allowDecimals={false} width={44} tickFormatter={fmtInt} />
                    <Tooltip cursor={{ stroke: c.axis }} content={({ active, payload }) => active && payload?.length ? (
                      <TipBox title={bucketLong(payload[0].payload.t, g, size)} rows={[{ color: SERIES, label: "Violations", value: fmtInt(payload[0].payload.violations) }]} />) : null} />
                    <Line type="linear" dataKey="violations" stroke={SERIES} strokeWidth={2} dot={points.length <= 31 ? { r: 3.5, fill: SERIES, stroke: c.hairline, strokeWidth: 2 } : false}
                      activeDot={{ r: 5, stroke: c.hairline, strokeWidth: 2 }} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </ChartCard>
              <ChartCard question="Which camera has the worst problem, and with what?" title="Violations by camera and missing PPE" loading={loading}
                empty={noData && "No violations in this range"} description="Bars stacked by the item missing; a violation missing two items counts in both segments."
                table={{ head: ["Camera", ...presentItems.map(ppeLabel), "Violations"], rows: stacked.map((c) => [c.name, ...presentItems.map((it) => (c as unknown as Record<string, number>)[it] ?? 0), c.total]) }}>
                <ResponsiveContainer width="100%" height={Math.max(200, stacked.length * 40 + 30)}>
                  <BarChart data={stacked} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }} barCategoryGap={10}>
                    <CartesianGrid horizontal={false} stroke={c.grid} />
                    <XAxis type="number" {...ap} allowDecimals={false} tickFormatter={fmtInt} />
                    <YAxis type="category" dataKey="short" {...ap} width={116} tick={{ fontSize: 12, fill: c.ink }} />
                    <Tooltip cursor={{ fill: c.cursor }} content={({ active, payload }) => {
                      const c = active && payload?.length ? payload[0].payload : null;
                      return c ? <TipBox title={`${c.name} · ${fmtInt(c.total)} violations`} rows={presentItems.filter((it) => c[it]).map((it) => ({ color: ppeColor(it), label: `Missing ${ppeLabel(it).toLowerCase()}`, value: fmtInt(c[it]) }))} /> : null;
                    }} />
                    {presentItems.map((it, i) => (
                      <Bar key={it} dataKey={it} stackId="ppe" fill={ppeColor(it)} barSize={22} stroke={c.hairline} strokeWidth={2}
                        radius={i === presentItems.length - 1 ? [0, 4, 4, 0] : 0} isAnimationActive={false} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
                <PpeLegend items={presentItems} />
              </ChartCard>
              <ChartCard question="What's the #1 gap: helmets, vests, gloves?" title="Violation share by missing PPE" loading={loading}
                empty={noData && "No violations in this range"} description="Share of all missing-PPE flags in the range."
                table={{ head: ["Item", "Violations", "Share"], rows: donut.map((p) => [ppeLabel(p.item), p.count, pct(itemTotal ? p.count / itemTotal : 0, 0)]) }}>
                <div className="flex flex-wrap items-center gap-4">
                  <div className="relative h-[230px] w-[230px] shrink-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Tooltip content={({ active, payload }) => {
                          const p = active && payload?.length ? payload[0].payload : null;
                          return p ? <TipBox title={`Missing ${ppeLabel(p.item).toLowerCase()}`} rows={[{ color: ppeColor(p.item), label: "Violations", value: fmtInt(p.count) }, { label: "Share of findings", value: pct(p.count / itemTotal, 0) }]} /> : null;
                        }} />
                        <Pie data={donut} dataKey="count" nameKey="item" innerRadius={64} outerRadius={100} paddingAngle={1.5} stroke={c.hairline} strokeWidth={2} isAnimationActive={false}>
                          {donut.map((p) => <Cell key={p.item} fill={ppeColor(p.item)} />)}
                        </Pie>
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                      <span className="text-2xl font-semibold">{topItem ? pct(topItem.count / itemTotal, 0) : "—"}</span>
                      <span className="text-[11px] text-muted">{topItem ? `are ${ppeLabel(topItem.item).toLowerCase()}` : ""}</span>
                    </div>
                  </div>
                  <ul className="flex min-w-[160px] flex-1 flex-col gap-2 text-[13px]" aria-label="Share by item">
                    {[...donut].sort((a, b) => b.count - a.count).map((p, i) => (
                      <li key={p.item} className="flex items-center gap-2">
                        <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: ppeColor(p.item) }} />
                        <span className={`flex-1 ${i === 0 ? "font-semibold" : ""}`}>{ppeLabel(p.item)}</span>
                        <span className="tabular-nums text-muted">{fmtInt(p.count)}</span>
                        <span className="w-10 text-right font-medium tabular-nums">{pct(p.count / itemTotal, 0)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </ChartCard>
              <ChartCard question="Where do the same workers keep getting flagged?" title="Most repeatedly flagged · to review" loading={loading}
                empty={!loading && !!data && !offenders.length && "No repeat flags in this range"}
                description={<>The same worker flagged several times within one camera session — open the snapshots to review these moments. <span className="text-muted">These are not named individuals; the count resets whenever a camera restarts.</span></>}
                table={{ head: ["Camera", "Track", "Violations", "Missing", "Last seen"], rows: offenders.map((o) => [o.stream_name, `#${o.track_id}${o.session_known ? "" : " (session unknown)"}`, o.violations, o.missing.map(ppeLabel).join(", "), fmtDateTime(o.last_seen)]) }}>
                <ResponsiveContainer width="100%" height={Math.max(180, offenders.length * 40 + 30)}>
                  <BarChart data={offenders} layout="vertical" margin={{ top: 4, right: 36, bottom: 0, left: 8 }} barCategoryGap={10}>
                    <CartesianGrid horizontal={false} stroke={c.grid} />
                    <XAxis type="number" {...ap} allowDecimals={false} />
                    <YAxis type="category" dataKey="label" {...ap} width={140} tick={{ fontSize: 12, fill: c.ink }} />
                    <Tooltip cursor={{ fill: c.cursor }} content={({ active, payload }) => {
                      const o = active && payload?.length ? payload[0].payload : null;
                      return o ? <TipBox title={`${o.stream_name} · track #${o.track_id}`} rows={[
                        { color: SERIES, label: "Violations", value: o.violations },
                        { label: "Missing", value: o.missing.map(ppeLabel).join(", ") },
                        { label: "First seen", value: fmtDateTime(o.first_seen) }, { label: "Last seen", value: fmtDateTime(o.last_seen) },
                        ...(o.session_known ? [] : [{ label: "Session", value: "unknown (older record)" }])]} /> : null;
                    }} />
                    <Bar dataKey="violations" fill={SERIES} barSize={20} radius={[0, 4, 4, 0]} isAnimationActive={false}
                      label={{ position: "right", fontSize: 12, fill: c.ink }} />
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
                  </div>
            <ChartCard question="When do violations spike? (shift changes, late shift…)" title="Violations by hour of day × day of week" loading={loading}
              empty={noData && "No violations in this range"} description="Local time. Darker = more violations in that hour slot across the range." minHeight={230}
              table={data ? { head: ["Day", ...Array.from({ length: 24 }, (_, h) => `${h}h`)], rows: data.heatmap.grid.map((r, i) => [data.heatmap.days[i], ...r]) } : undefined}>
              {data && <HeatmapChart days={data.heatmap.days} grid={data.heatmap.grid} max={data.heatmap.max}
                cellTip={(d, h, n) => <div className="min-w-[140px]"><p className="mb-1 font-semibold text-text">{DAYS_LONG[d]}, {String(h).padStart(2, "0")}:00–{String(h + 1).padStart(2, "0")}:00</p><p className="text-muted">{fmtInt(n)} violation{n === 1 ? "" : "s"}</p></div>} />}
            </ChartCard>
                </div>
              )}
            </section>
            <Card className="break-inside-avoid">
              <div className="border-b border-border px-5 py-4">
                <span className="mb-0.5 block text-[11px] font-semibold tracking-wide text-primary uppercase">Which areas need attention?</span>
                <h2 className="text-[15px] font-semibold">Camera performance</h2>
                <p className="mt-0.5 text-[13px] text-muted">Click a column to sort. Trend compares with the previous {period}.</p>
              </div>
              {loading ? <div className="flex flex-col gap-2 p-5">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-8" />)}</div>
                : !leaderboard.length ? <EmptyState icon={<Icon.camera size={20} />} title="No cameras in this view" /> : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-[13px]">
                      <thead className="bg-subtle text-xs text-muted">
                        <tr>
                          <th className="w-10 px-5 py-2.5 font-medium">#</th>
                          {th("stream_name", "Camera")}
                          {th("violations", "Violations", true)}
                          {th("delta", "Trend", true)}
                          {th("compliance_rate", "Compliance", true)}
                          <th className="px-3 py-2.5 text-right font-medium uppercase">Δ compliance</th>
                          {th("unacknowledged", "Open", true)}
                          <th className="px-3 py-2.5 font-medium uppercase">Top missing PPE</th>
                          <th className="px-5 py-2.5 font-medium uppercase">Last violation</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border tabular-nums">
                        {leaderboard.map((c, i) => {
                          const gap = Object.entries(c.by_ppe).sort((a, b) => b[1] - a[1])[0];
                          return (
                            <tr key={c.stream_id}>
                              <td className="px-5 py-2.5 text-muted">{i + 1}</td>
                              <td className="px-3 py-2.5 font-medium"><span className="block max-w-[240px] truncate" title={c.stream_name}>{c.stream_name}</span></td>
                              <td className="px-3 py-2.5 text-right font-semibold">{fmtInt(c.violations)}</td>
                              <td className="px-3 py-2.5 text-right"><Trend now={c.violations} prev={c.previous_violations} upIsBad fmt={fmtInt} /></td>
                              <td className={`px-3 py-2.5 text-right ${c.compliance_rate != null && c.compliance_rate < target ? "text-danger" : ""}`}>{pct(c.compliance_rate)}</td>
                              <td className="px-3 py-2.5 text-right"><Trend now={c.compliance_rate == null ? null : c.compliance_rate * 100} prev={c.previous_compliance_rate == null ? null : c.previous_compliance_rate * 100} upIsBad={false} fmt={(d) => `${d.toFixed(1)} pts`} /></td>
                              <td className="px-3 py-2.5 text-right">{c.unacknowledged ? <Badge tone="warning">{fmtInt(c.unacknowledged)}</Badge> : "0"}</td>
                              <td className="px-3 py-2.5">{gap ? <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: ppeColor(gap[0]) }} />{ppeLabel(gap[0])}</span> : <span className="text-muted">—</span>}</td>
                              <td className="px-5 py-2.5 whitespace-nowrap text-muted">{c.last_violation ? fmtDateTime(c.last_violation) : "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
            </Card>
            <p className="text-xs text-muted">
              Compliance and worker counts have been recorded{s?.compliance_data_since ? ` since ${fmtDateTime(s.compliance_data_since)}` : ""}; earlier periods show "—". Violation counts cover the full history.
            </p>
              </>
            )}
          </div>
        )}
      </PageBody>
    </>
  );
}
