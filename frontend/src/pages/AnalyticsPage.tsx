import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CameraStack } from "../components/charts/CameraStack";
import { CHART, FigureTable, sortItems } from "../components/charts/common";
import { BarList, HourHeatmap, SplitBar } from "../components/charts/Marks";
import { ComplianceTrend, ViolationsTrend, type TrendPoint } from "../components/charts/TrendCharts";
import { Page } from "../components/layout/Shell";
import { Button, cx, Empty, Icon, Input, Notice, Panel, PanelHeader, Segmented, Skeleton, Stat, useToast, type Tone } from "../components/ui";
import { api, saveBlob, type AnalyticsQuery } from "../lib/api";
import { BEHAVIOR_LABEL, dateRangeToEpoch, dayKey, fmtAgo, fmtDateTime, fmtInt, fmtPct, PPE_LABEL, violationLabel } from "../lib/format";
import { navigate, navigateWith } from "../lib/router";
import { useMonitor } from "../state/monitor";
import type { AnalyticsSummary, CameraStats, Heatmap, Offender, PpeCount, ReviewQuality, TimeSeries } from "../types";

type Preset = "today" | "7d" | "30d" | "custom";
type Gran = "hour" | "day" | "week";
type GranChoice = Gran | "auto";

const PRESETS: { value: Preset; label: string }[] = [
  { value: "today", label: "Today" }, { value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }, { value: "custom", label: "Custom" },
];
const GRAN_LABEL: Record<GranChoice, string> = { auto: "Auto", hour: "Hour", day: "Day", week: "Week" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DEFAULT_ITEMS = [...Object.keys(PPE_LABEL), ...Object.keys(BEHAVIOR_LABEL)];
const DEBOUNCE_MS = 250;
const REFRESH_MS = 60_000;

/** Each false-alarm reason points at a different fix. Keyed by the review reason id. */
const REASON_FIX: Record<string, string> = {
  ppe_worn: "Retrain with these frames (Incidents → Export dataset).",
  not_a_person: "Raise the confidence threshold, or retrain with these frames as negatives.",
  wrong_person: "Check crowded areas and the camera angle.",
  not_required_here: "Draw an Ignore or Monitor zone for this camera (Devices → Zones).",
  duplicate: "Raise the cooldown / event gap in Settings.",
  poor_image: "Check camera focus, lighting and resolution.",
  other: "Read the reviewers' notes on these alerts.",
};

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
    default: {
      const r = dateRangeToEpoch(from, to);
      return r.start === undefined || r.end === undefined || r.end <= r.start ? null : { start: r.start, end: r.end };
    }
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
const dayShort = (t: number) => { const d = new Date(t * 1000); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const hourShort = (t: number) => `${pad(new Date(t * 1000).getHours())}:00`;
// hourly buckets across several days: the midnight tick carries the date
const tickLabel = (t: number, g: Gran) => (g !== "hour" ? dayShort(t) : new Date(t * 1000).getHours() === 0 ? dayShort(t) : hourShort(t));
const bucketLong = (t: number, g: Gran, size: number) => {
  const d = new Date(t * 1000);
  if (g === "hour") return `${dayShort(t)}, ${hourShort(t)}–${hourShort(t + size)}`;
  if (g === "week") return `Week of ${dayShort(t)} ${d.getFullYear()}`;
  return `${WEEKDAYS[d.getDay()]} ${dayShort(t)} ${d.getFullYear()}`;
};
const plural = (n: number, one: string, many = `${one}s`) => `${fmtInt(n)} ${n === 1 ? one : many}`;
const points1 = (x: number) => `${Math.abs(x * 100).toFixed(1)} pts`;
const toggle = (xs: string[], x: string) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);

// ------------------------------------------------------------------ small pieces
/** Compact multi-select: a button that opens a checklist. An empty selection means "all". */
function MultiSelect({ label, options, value, onChange }: { label: string; options: { value: string; label: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]);
  const chosen = options.filter((o) => value.includes(o.value));
  const text = value.length === 0 ? "All" : chosen.length === 1 ? chosen[0].label : `${value.length} selected`;
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className={cx("inline-flex h-9 max-w-[16rem] items-center gap-1.5 rounded-md border bg-surface px-2.5 text-[13px] font-medium transition-colors hover:bg-sunken",
          value.length ? "border-accent text-accent-strong" : "border-line-strong text-ink")}>
        <span className="text-ink-3">{label}</span>
        <span className="truncate">{text}</span>
        <Icon name="chevronDown" size={14} className="shrink-0 text-ink-3" />
      </button>
      {open && (
        <div role="group" aria-label={label} className="scroll-thin absolute left-0 z-20 mt-1 max-h-72 w-64 overflow-y-auto rounded-md border border-line bg-surface p-1 shadow-pop">
          {options.length === 0 && <p className="px-2 py-2 text-[13px] text-ink-3">Nothing to choose from yet.</p>}
          {options.map((o) => (
            <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] text-ink hover:bg-sunken">
              <input type="checkbox" className="size-3.5 accent-(--color-accent)" checked={value.includes(o.value)} onChange={() => onChange(toggle(value, o.value))} />
              <span className="min-w-0 truncate">{o.label}</span>
            </label>
          ))}
          {value.length > 0 && (
            <div className="mt-1 border-t border-line pt-1">
              <Button variant="ghost" size="sm" className="w-full" onClick={() => onChange([])}>Clear selection</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A panel that answers one question. Skeleton on first load, an Empty when there is nothing to show. */
function Section({ title, hint, actions, loading, empty, children, className, skeleton = "h-40" }:
  { title: string; hint: string; actions?: ReactNode; loading: boolean; empty?: ReactNode; children: ReactNode; className?: string; skeleton?: string }) {
  return (
    <Panel className={cx("break-inside-avoid print:shadow-none", className)}>
      <PanelHeader title={title} hint={hint} actions={actions} />
      {loading ? <div className="p-4"><Skeleton className={cx("w-full", skeleton)} /></div> : empty ?? children}
    </Panel>
  );
}

/** Change in a count where more is worse. Direction is in the words, colour only reinforces it. */
function CountChange({ now, prev }: { now: number; prev: number }) {
  const d = now - prev;
  if (d === 0) return <span className="text-ink-3">no change</span>;
  return <span className={d > 0 ? "text-bad" : "text-ok"}><span className="num">{fmtInt(Math.abs(d))}</span> {d > 0 ? "more" : "fewer"}</span>;
}

// ------------------------------------------------------------------ CSV of the visible aggregates
function toCsv(d: Data, series: TimeSeries | null, view: string): string {
  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines: string[] = [];
  const row = (...xs: unknown[]) => lines.push(xs.map(esc).join(","));
  const s = d.summary, r = s.review;
  const items = sortItems([...d.ppe.map((p) => p.item), ...d.cameras.flatMap((c) => Object.keys(c.by_ppe))]);
  row("PPE compliance analytics"); row("View", view); row("Generated", fmtDateTime(Date.now() / 1000)); row();
  row("Headline"); row("metric", "value");
  row("compliance_rate", s.compliance_rate ?? ""); row("previous_compliance_rate", s.previous_compliance_rate ?? ""); row("compliance_target", s.compliance_target);
  row("violations", s.total_violations); row("previous_period_violations", s.previous_total_violations);
  row("workers_checked_tracks", s.workers_seen); row("workers_flagged_tracks", s.workers_flagged);
  row("awaiting_review", r.unreviewed); row("unacknowledged", s.unacknowledged); row("alert_precision", r.precision ?? "");
  row("note", "Workers checked counts tracked people per camera session; someone who leaves and re-enters the view is counted again."); row();
  if (series) {
    row(`Over time (per ${series.granularity})`); row("bucket_start_local", "violations", "workers_checked", "workers_flagged", "compliance_rate");
    series.points.forEach((p) => row(fmtDateTime(p.t), p.violations, p.workers_seen, p.workers_flagged, p.compliance_rate ?? "")); row();
  }
  row("By camera"); row("camera_id", "camera", "violations", "previous_period", "compliance_rate", "previous_compliance_rate", "awaiting_ack", "last_violation", ...items);
  d.cameras.forEach((c) => row(c.stream_id, c.stream_name, c.violations, c.previous_violations, c.compliance_rate ?? "", c.previous_compliance_rate ?? "",
    c.unacknowledged, c.last_violation ? fmtDateTime(c.last_violation) : "", ...items.map((i) => c.by_ppe[i] ?? 0))); row();
  row("By violation type"); row("item", "violations", "share");
  d.ppe.forEach((p) => row(p.item, p.count, p.share)); row();
  row("By weekday and hour (local time)"); row("day", ...Array.from({ length: 24 }, (_, h) => `${pad(h)}h`));
  d.heatmap.grid.forEach((g, i) => row(d.heatmap.days[i], ...g)); row();
  row("Alert review"); row("metric", "value");
  row("alerts", r.total); row("reviewed", r.reviewed); row("real", r.valid); row("false_alarms", r.false_alarms); row("unreviewed", r.unreviewed); row("precision", r.precision ?? ""); row();
  row("False alarm reasons"); row("reason", "label", "count");
  r.reasons.forEach((x) => row(x.reason, x.label, x.count)); row();
  row("Alert review by camera"); row("camera_id", "camera", "real", "false_alarms", "precision");
  r.by_camera.forEach((c) => row(c.stream_id, c.stream_name, c.valid, c.false_alarms, c.precision ?? "")); row();
  row("Repeat tracks (a track id belongs to one camera session; it does not identify a person)");
  row("camera", "track_id", "session", "violations", "missing", "first_seen", "last_seen");
  d.offenders.forEach((o) => row(o.stream_name, o.track_id, o.run_id ?? "unknown", o.violations, o.missing.join(";"), fmtDateTime(o.first_seen), fmtDateTime(o.last_seen)));
  return `${lines.join("\r\n")}\r\n`;
}

// ------------------------------------------------------------------ page
export function AnalyticsPage() {
  const toast = useToast();
  const { streams } = useMonitor();
  const [preset, setPreset] = useState<Preset>("7d");
  const [from, setFrom] = useState(() => dayKey(Date.now() / 1000 - 6 * 86400));
  const [to, setTo] = useState(() => dayKey(Date.now() / 1000));
  const [cameras, setCameras] = useState<string[]>([]);
  const [ppe, setPpe] = useState<string[]>([]);
  const [gran, setGran] = useState<GranChoice>("auto");
  const [tick, setTick] = useState(0);
  const [schemaItems, setSchemaItems] = useState<string[]>([]);
  const [seenItems, setSeenItems] = useState<string[]>([]);
  const [data, setData] = useState<Data | null>(null);
  const [series, setSeries] = useState<TimeSeries | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const req = useRef(0);
  const seriesReq = useRef(0);
  const quiet = useRef(false);

  // `tick` re-evaluates "now" for the presets (Retry and the 60 s refresh bump it).
  const range = useMemo(() => rangeFor(preset, from, to), [preset, from, to, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const span = range ? range.end - range.start : 0;
  const grans: Gran[] = span <= 7 * 86400 ? ["hour", "day"] : span <= 14 * 86400 ? ["day"] : ["day", "week"];
  const g: GranChoice = gran !== "auto" && grans.includes(gran) ? gran : "auto";
  const wanted = useMemo<AnalyticsQuery | null>(() => range && {
    ...range, camera: cameras.length ? cameras : undefined, ppe: ppe.length ? ppe : undefined, tz: -new Date().getTimezoneOffset(),
  }, [range, cameras, ppe]);

  // Filters change in bursts (ticking several cameras): wait for them to settle before fetching.
  const [query, setQuery] = useState<AnalyticsQuery | null>(wanted);
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(wanted), DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [wanted]);

  // Everything except the time series. A newer request makes older responses stale; they are dropped.
  useEffect(() => {
    if (!query) return;
    const id = ++req.current;
    const silent = quiet.current;
    quiet.current = false;
    if (!silent) setLoading(true);
    Promise.all([
      api.analytics.summary(query), api.analytics.byCamera(query), api.analytics.byPpe(query),
      api.analytics.heatmap(query), api.analytics.topOffenders(query, 10),
    ]).then(([summary, cams, ppeRows, heatmap, offenders]) => {
      if (id !== req.current) return;
      setData({ summary, cameras: cams, ppe: ppeRows, heatmap, offenders });
      setSeenItems((xs) => sortItems([...xs, ...ppeRows.map((p) => p.item)]));
      setError(null);
    }).catch((e: unknown) => { if (id === req.current) setError((e as Error).message); })
      .finally(() => { if (id === req.current) setLoading(false); });
  }, [query]);

  // The time series is the only dataset bucketed by granularity, so switching it refetches only this.
  useEffect(() => {
    if (!query) return;
    const id = ++seriesReq.current;
    api.analytics.timeseries(query, g)
      .then((ts) => { if (id === seriesReq.current) setSeries(ts); })
      .catch((e: unknown) => { if (id === seriesReq.current) setError((e as Error).message); });
  }, [query, g]);

  // Keep the page current while the range runs up to now.
  const includesNow = preset !== "custom" || to >= dayKey(Date.now() / 1000);
  useEffect(() => {
    if (!includesNow) return;
    const t = window.setInterval(() => {
      if (document.hidden) return;
      quiet.current = true;
      setTick((n) => n + 1);
    }, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [includesNow]);

  useEffect(() => {
    let live = true;
    api.config.schema()
      .then((sc) => { if (live) setSchemaItems([...sc.ppe_items, ...sc.behaviors, ...(sc.zone_items ?? [])]); })
      .catch(() => { /* the built-in list and the types seen in the data still populate the filter */ });
    return () => { live = false; };
  }, []);

  const retry = () => { setError(null); setTick((n) => n + 1); };

  // ---------- labels
  const s = data?.summary;
  const review: ReviewQuality | undefined = s?.review;
  const target = s?.compliance_target ?? 0.95;
  const days = Math.max(1, Math.round(span / 86400));
  const previous = preset === "today" || days === 1 ? "the previous period of the same length" : `the previous ${days} days`;
  const cameraText = cameras.length ? cameras.map((c) => streams.find((st) => st.id === c)?.name ?? c).join(", ") : "all cameras";
  const typeText = ppe.length ? ppe.map(violationLabel).join(", ") : "all violation types";
  const rangeText = range ? `${fmtDateTime(range.start)} – ${fmtDateTime(range.end)}` : "";
  const view = `${rangeText} · ${cameraText} · ${typeText}`;
  const typeOptions = useMemo(() => sortItems([...DEFAULT_ITEMS, ...schemaItems, ...seenItems, ...ppe]).map((it) => ({ value: it, label: violationLabel(it) })), [schemaItems, seenItems, ppe]);
  const cameraOptions = useMemo(() => streams.map((st) => ({ value: st.id, label: st.name })), [streams]);

  const exportCsv = useCallback(() => {
    if (!data) return;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    saveBlob(new Blob([toCsv(data, series, view)], { type: "text/csv;charset=utf-8" }), `ppe-analytics-${stamp}.csv`);
    toast({ tone: "success", title: "CSV downloaded", message: "Every table and chart of this view is in one file." });
  }, [data, series, view, toast]);

  // ---------- derived chart data
  const sg: Gran = series?.granularity ?? "day";
  const size = series?.bucket_seconds ?? 86400;
  const points: TrendPoint[] = useMemo(() => (series?.points ?? []).map((p) => ({
    t: p.t, violations: p.violations, workers_seen: p.workers_seen, workers_flagged: p.workers_flagged,
    rate: p.compliance_rate == null ? null : p.compliance_rate * 100,
  })), [series]);
  const rated = points.filter((p) => p.rate != null);
  const lowest = rated.reduce<TrendPoint | null>((m, p) => (m == null || (p.rate as number) < (m.rate as number) ? p : m), null);
  const peak = points.reduce<TrendPoint | null>((m, p) => (m == null || p.violations > m.violations ? p : m), null);
  const seriesTotal = points.reduce((a, p) => a + p.violations, 0);
  const tickFmt = useCallback((t: number) => tickLabel(t, sg), [sg]);
  const longFmt = useCallback((t: number) => bucketLong(t, sg, size), [sg, size]);

  const camRows = useMemo(() => (data?.cameras ?? [])
    .filter((c) => !cameras.length || cameras.includes(c.stream_id))
    .sort((a, b) => b.violations - a.violations || a.stream_name.localeCompare(b.stream_name)), [data, cameras]);
  const camBars = camRows.filter((c) => c.violations > 0).map((c) => ({ id: c.stream_id, name: c.stream_name, total: c.violations, by: c.by_ppe }));
  const stackItems = sortItems(camBars.flatMap((c) => Object.keys(c.by).filter((k) => c.by[k] > 0)));
  const ppeRows = [...(data?.ppe ?? [])].filter((p) => p.count > 0).sort((a, b) => b.count - a.count);
  const openReview = (camera: string) => navigateWith("incidents", { camera, review: "unreviewed" });

  const first = loading && !data;
  const firstSeries = !series && !error;
  const total = s?.total_violations ?? 0;
  const rate = s?.compliance_rate ?? null;
  const rateTone: Tone | undefined = rate == null ? undefined : rate >= target ? "ok" : rate >= target - 0.05 ? "warn" : "bad";
  const reviewedCams = (review?.by_camera ?? []).filter((c) => c.valid + c.false_alarms > 0);

  return (
    <Page title="Reports" description={range ? `${rangeText} · ${cameraText} · ${typeText}` : "Choose a date range."}
      toolbar={<>
        <Segmented label="Date range" value={preset} onChange={setPreset} options={PRESETS} />
        {preset === "custom" && (
          <span className="flex flex-wrap items-center gap-2">
            <Input aria-label="From date" type="date" value={from} max={to} invalid={!range} onChange={(e) => setFrom(e.target.value)} className="!w-auto" />
            <span className="text-[13px] text-ink-3">to</span>
            <Input aria-label="To date" type="date" value={to} min={from} max={dayKey(Date.now() / 1000)} invalid={!range} onChange={(e) => setTo(e.target.value)} className="!w-auto" />
          </span>
        )}
        <MultiSelect label="Cameras" options={cameraOptions} value={cameras} onChange={setCameras} />
        <MultiSelect label="Violation types" options={typeOptions} value={ppe} onChange={setPpe} />
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <Button icon="download" onClick={exportCsv} disabled={!data}>Export CSV</Button>
          <Button icon="printer" onClick={() => window.print()} disabled={!data} title="Print, or save as PDF from the print dialog">Print</Button>
        </span>
      </>}>
      <div className="space-y-4">
        {!range && <Notice tone="warn" title="The date range is not valid">Pick a start date on or before the end date. The figures below are for the last valid range.</Notice>}
        {error && (
          <Notice tone="bad" title="Analytics could not be loaded" action={<Button size="sm" onClick={retry}>Retry</Button>}>
            {error}{data ? " The figures below are from the last successful load." : ""}
          </Notice>
        )}
        {ppe.length > 0 && (
          <Notice className="no-print">
            Violation counts are filtered to {typeText.toLowerCase()}. Compliance rate and workers checked are measured per worker, not per type, so they cover all types.
          </Notice>
        )}

        {(data || first) && (
          <div className={cx("space-y-4 transition-opacity", loading && data && "opacity-60")} aria-busy={loading}>
            {/* 1 — headline */}
            <Section title="How are we doing?" hint={`Headline figures for the selected range, compared with ${previous}.`} loading={first} skeleton="h-24">
              {s && review && (
                <div className="p-4">
                  <div className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-3 xl:grid-cols-5">
                    <Stat label="Compliance rate" value={fmtPct(rate)} tone={rateTone}
                      hint={rate == null ? "No workers were evaluated in this period, so there is no rate to show." : (
                        <>
                          target <span className="num">{fmtPct(target, 0)}</span> · {rate >= target ? "on target" : `${points1(target - rate)} below target`}
                          <br />
                          {s.previous_compliance_rate == null ? `no rate for ${previous}`
                            : Math.abs(rate - s.previous_compliance_rate) < 0.0005 ? `same as ${previous}`
                              : `${rate > s.previous_compliance_rate ? "up" : "down"} ${points1(rate - s.previous_compliance_rate)} on ${previous}`}
                        </>
                      )} />
                    <Stat label="Violations" value={fmtInt(total)}
                      hint={total === s.previous_total_violations ? `same as ${previous}`
                        : `${fmtInt(Math.abs(total - s.previous_total_violations))} ${total > s.previous_total_violations ? "more" : "fewer"} than ${previous}`} />
                    <Stat label="Workers checked" value={fmtInt(s.workers_seen)}
                      hint={s.workers_seen ? `${fmtInt(s.workers_flagged)} flagged at least once` : "no one was tracked in this period"} />
                    <Stat label="Awaiting review" value={fmtInt(review.unreviewed)}
                      hint={review.total ? `of ${plural(review.total, "alert")} · ${fmtInt(s.unacknowledged)} not acknowledged` : "no alerts in this period"} />
                    <Stat label="Alert precision" value={review.reviewed ? fmtPct(review.precision) : "–"}
                      hint={review.reviewed ? `${fmtInt(review.valid)} of ${fmtInt(review.reviewed)} reviewed alerts were real` : "nothing has been reviewed yet"} />
                  </div>
                  <p className="mt-4 border-t border-line pt-3 text-xs text-ink-3">
                    <strong className="font-semibold text-ink-2">How to read these.</strong> Workers checked counts tracked people per camera session, so one person who leaves
                    and re-enters the view is counted again. The compliance rate is therefore an estimate of compliant passes, not of distinct people.
                  </p>
                </div>
              )}
            </Section>

            {/* 2 — trend */}
            <Section title="Is compliance improving?"
              hint="Top: share of workers checked who were never flagged, against the target (dashed). Bottom: violations in the same periods. The two charts share the time axis."
              loading={firstSeries}
              skeleton="h-80"
              actions={grans.length > 1 ? (
                <span className="no-print"><Segmented size="sm" label="Bucket size" value={g} onChange={setGran}
                  options={(["auto", ...grans] as GranChoice[]).map((x) => ({ value: x, label: GRAN_LABEL[x] }))} /></span>
              ) : undefined}
              empty={series && (points.length === 0 || (seriesTotal === 0 && rated.length === 0))
                ? <Empty icon="chart" title="Nothing recorded in this range">No workers were tracked and no violations were saved. Try a wider range, or check that the cameras are running on the Live page.</Empty>
                : !series ? <Empty icon="alert" title="The trend could not be loaded">Use Retry at the top of the page.</Empty> : undefined}>
              <div className="p-4">
                <h3 className="eyebrow mb-1">Compliance rate per {sg}</h3>
                {rated.length === 0 ? (
                  <p className="py-6 text-[13px] text-ink-3">No workers were evaluated in this range, so there is no rate to plot.</p>
                ) : (
                  <ComplianceTrend points={points} target={target} long={longFmt}
                    label={`Compliance rate per ${sg}. Latest ${rated[rated.length - 1].rate?.toFixed(1)}%, lowest ${lowest?.rate?.toFixed(1)}% in ${lowest ? longFmt(lowest.t) : ""}, target ${fmtPct(target, 0)}.`} />
                )}
                <h3 className="eyebrow mt-3 mb-1">Violations per {sg}</h3>
                <ViolationsTrend points={points} tick={tickFmt} long={longFmt}
                  label={`Violations per ${sg}. ${fmtInt(seriesTotal)} in total${peak && peak.violations > 0 ? `, most in ${longFmt(peak.t)} with ${fmtInt(peak.violations)}` : ""}.`} />
                <FigureTable caption={`Compliance rate and violations per ${sg}`} head={["Period", "Compliance", "Workers checked", "Flagged", "Violations"]}
                  rows={points.map((p) => [longFmt(p.t), p.rate == null ? "–" : `${p.rate.toFixed(1)}%`, p.workers_seen, p.workers_flagged, p.violations])} />
              </div>
            </Section>

            {/* 3 — cameras */}
            <Section title="Where are the violations?" hint="Cameras sorted by violations, split by type. Select a row to open that camera's unreviewed alerts." loading={first} skeleton="h-56"
              empty={data && camRows.length === 0 ? <Empty icon="camera" title="No camera activity in this range">Nothing was recorded for the selected cameras. Widen the range or clear the camera filter.</Empty> : undefined}>
              <div className="grid gap-x-6 gap-y-4 p-4 xl:grid-cols-5">
                <div className="min-w-0 xl:col-span-2">
                  {camBars.length === 0 ? <p className="py-6 text-[13px] text-ink-3">No violations on these cameras in this range.</p> : (
                    <CameraStack rows={camBars.slice(0, 12)} items={stackItems} onSelect={openReview}
                      label={`Violations by camera. ${camBars[0].name} has the most: ${fmtInt(camBars[0].total)} of ${fmtInt(camBars.reduce((a, c) => a + c.total, 0))}.`} />
                  )}
                  {camBars.length > 12 && <p className="mt-1 text-xs text-ink-3">Showing the 12 cameras with the most violations. The table lists all {camBars.length}.</p>}
                </div>
                <div className="scroll-thin min-w-0 overflow-x-auto xl:col-span-3">
                  <table className="table">
                    <caption className="sr-only">Violations and compliance by camera</caption>
                    <thead>
                      <tr>
                        <th scope="col">Camera</th><th scope="col" className="text-right">Violations</th><th scope="col">Vs previous</th>
                        <th scope="col" className="text-right">Compliance</th><th scope="col" className="text-right">Awaiting ack</th><th scope="col">Last violation</th>
                      </tr>
                    </thead>
                    <tbody>
                      {camRows.map((c) => (
                        <tr key={c.stream_id} className="cursor-pointer" onClick={() => openReview(c.stream_id)}>
                          <td className="max-w-[14rem]">
                            <button type="button" className="block max-w-full truncate text-left font-medium text-ink hover:text-accent-strong hover:underline"
                              title={`Open unreviewed alerts for ${c.stream_name}`} onClick={(e) => { e.stopPropagation(); openReview(c.stream_id); }}>
                              {c.stream_name}
                            </button>
                          </td>
                          <td className="num text-right font-semibold">{fmtInt(c.violations)}</td>
                          <td className="whitespace-nowrap"><CountChange now={c.violations} prev={c.previous_violations} /></td>
                          <td className="num text-right">{fmtPct(c.compliance_rate)}</td>
                          <td className="num text-right">{fmtInt(c.unacknowledged)}</td>
                          <td className="num whitespace-nowrap text-ink-2">{c.last_violation ? fmtAgo(c.last_violation) : "–"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </Section>

            <div className="grid gap-4 xl:grid-cols-3">
              {/* 4 — types */}
              <Section title="What is missing most?" hint="Violation types by count, with each type's share. One violation can involve several types." loading={first}
                empty={data && ppeRows.length === 0 ? <Empty icon="shield" title="No violations in this range">There is nothing to break down. Widen the range or clear the filters.</Empty> : undefined}>
                <div className="p-4">
                  <BarList label="Violation types by count" unit="violations"
                    rows={ppeRows.map((p) => ({ key: p.item, label: violationLabel(p.item), value: p.count, aside: fmtPct(p.share, 0) }))} />
                </div>
              </Section>

              {/* 5 — heatmap */}
              <Section className="xl:col-span-2" title="When do they happen?" hint="Violations by weekday and hour of day, local time. Darker means more. Hover a cell for its count." loading={first}
                empty={data && data.heatmap.max === 0 ? <Empty icon="clock" title="No violations in this range">There is no pattern to show yet. Widen the range or clear the filters.</Empty> : undefined}>
                {data && <div className="p-4"><HourHeatmap grid={data.heatmap.grid} max={data.heatmap.max} /></div>}
              </Section>
            </div>

            {/* 6 — review quality */}
            <Section title="Can we trust the alerts?" hint="Based on what reviewers decided on the Incidents page. Precision is the share of reviewed alerts that were real violations." loading={first}
              empty={review && review.reviewed === 0 ? (
                <Empty icon="review" title="No alerts have been reviewed in this range"
                  action={<Button variant="primary" icon="review" onClick={() => navigate("incidents")}>Open incidents</Button>}>
                  {review.total > 0
                    ? `Mark a sample of the ${plural(review.total, "alert")} as real or false alarm on the Incidents page. That measures precision and shows which kind of false alarm to fix first.`
                    : "When alerts are recorded, mark a sample of them as real or false alarm on the Incidents page. That measures precision and shows which kind of false alarm to fix first."}
                </Empty>
              ) : undefined}>
              {review && (
                <div className="grid gap-x-8 gap-y-6 p-4 xl:grid-cols-2">
                  <div className="min-w-0 space-y-5">
                    <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
                      <Stat label="Alert precision" value={fmtPct(review.precision)} hint={`${fmtInt(review.valid)} of ${fmtInt(review.reviewed)} reviewed alerts were real`} />
                      <Stat label="Reviewed" value={fmtPct(review.total ? review.reviewed / review.total : null, 0)} hint={`${fmtInt(review.reviewed)} of ${plural(review.total, "alert")}`} />
                    </div>
                    <SplitBar label={`${fmtInt(review.valid)} real, ${fmtInt(review.false_alarms)} false alarms, ${fmtInt(review.unreviewed)} unreviewed of ${fmtInt(review.total)} alerts.`}
                      segments={[
                        { key: "valid", label: "Real violation", value: review.valid, color: CHART.ok },
                        { key: "false", label: "False alarm", value: review.false_alarms, color: CHART.warn },
                        { key: "unreviewed", label: "Unreviewed", value: review.unreviewed, color: CHART.rest },
                      ]} />
                    {review.unreviewed > review.reviewed && (
                      <p className="text-xs text-ink-3">Most alerts in this range are unreviewed, so precision rests on a small sample. Review more to firm it up.</p>
                    )}
                    {reviewedCams.length > 1 && (
                      <div className="scroll-thin overflow-x-auto">
                        <table className="table">
                          <caption className="eyebrow pb-1 text-left">Precision by camera</caption>
                          <thead><tr><th scope="col">Camera</th><th scope="col" className="text-right">Reviewed</th><th scope="col" className="text-right">Real</th><th scope="col" className="text-right">False alarms</th><th scope="col" className="text-right">Precision</th></tr></thead>
                          <tbody>
                            {[...reviewedCams].sort((a, b) => (a.precision ?? 1) - (b.precision ?? 1)).map((c) => (
                              <tr key={c.stream_id}>
                                <td className="max-w-[14rem] truncate" title={c.stream_name}>{c.stream_name}</td>
                                <td className="num text-right">{fmtInt(c.valid + c.false_alarms)}</td>
                                <td className="num text-right">{fmtInt(c.valid)}</td>
                                <td className="num text-right">{fmtInt(c.false_alarms)}</td>
                                <td className="num text-right font-semibold">{fmtPct(c.precision, 0)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                  <div className="min-w-0">
                    <h3 className="eyebrow mb-3">Why alerts were false, and what to do</h3>
                    {review.reasons.filter((r) => r.count > 0).length === 0 ? (
                      <p className="text-[13px] text-ink-3">{review.false_alarms === 0 ? "No reviewed alert in this range was a false alarm." : "The false alarms in this range have no reason recorded."}</p>
                    ) : (
                      <BarList label="False alarm reasons by count" unit="false alarms"
                        rows={[...review.reasons].filter((r) => r.count > 0).sort((a, b) => b.count - a.count).map((r) => ({
                          key: r.reason, label: r.label, value: r.count,
                          aside: review.false_alarms ? fmtPct(r.count / review.false_alarms, 0) : undefined,
                          note: REASON_FIX[r.reason] ?? REASON_FIX.other,
                        }))} />
                    )}
                  </div>
                </div>
              )}
            </Section>

            {/* 7 — repeat tracks */}
            <Section title="Who keeps coming back?" hint="Tracks flagged most often. A track is one tracked person within one camera session, not an identified individual: the same person gets a new track after leaving the view." loading={first}
              empty={data && data.offenders.length === 0 ? <Empty icon="person" title="No repeat tracks in this range">No tracked person was flagged in the selected range and filters.</Empty> : undefined}>
              <div className="scroll-thin overflow-x-auto">
                <table className="table">
                  <caption className="sr-only">Tracks with the most violations</caption>
                  <thead><tr><th scope="col">Track</th><th scope="col">Camera</th><th scope="col" className="text-right">Violations</th><th scope="col">What was missing</th><th scope="col">First seen</th><th scope="col">Last seen</th></tr></thead>
                  <tbody>
                    {(data?.offenders ?? []).map((o) => (
                      <tr key={`${o.stream_id}:${o.run_id ?? ""}:${o.track_id}`}>
                        <td className="whitespace-nowrap">
                          <span className="font-medium">Track <span className="num">#{o.track_id}</span></span> <span className="text-ink-3">on {o.stream_name}</span>
                          {!o.session_known && <span className="ml-1.5 text-xs text-ink-3" title="Recorded before sessions were tracked, so tracks from different sessions may be merged">· session unknown</span>}
                        </td>
                        <td>
                          <button type="button" className="max-w-[14rem] truncate text-left text-ink hover:text-accent-strong hover:underline" title={`Open unreviewed alerts for ${o.stream_name}`} onClick={() => openReview(o.stream_id)}>
                            {o.stream_name}
                          </button>
                        </td>
                        <td className="num text-right font-semibold">{fmtInt(o.violations)}</td>
                        <td className="text-ink-2">{o.missing.length ? sortItems(o.missing).map(violationLabel).join(", ") : "–"}</td>
                        <td className="num whitespace-nowrap text-ink-2">{fmtDateTime(o.first_seen)}</td>
                        <td className="num whitespace-nowrap text-ink-2">{fmtDateTime(o.last_seen)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          </div>
        )}
      </div>
    </Page>
  );
}
