import { useCallback, useEffect, useMemo, useState } from "react";
import { CameraTile } from "../components/camera/CameraTile";
import { DetailView } from "../components/camera/DetailView";
import { ActiveIncidents } from "../components/dashboard/ActiveIncidents";
import { SafetySummary } from "../components/dashboard/SafetySummary";
import { PageBody } from "../components/layout/PageBody";
import { Topbar } from "../components/layout/Topbar";
import { Button, Card, EmptyState, Icon, IconButton, Input, Select, Skeleton } from "../components/ui";
import { useAuth } from "../state/auth";
import { useMonitor } from "../state/monitor";
import type { StreamInfo } from "../types";

type Filter = "all" | "live" | "problems" | "violating";
const DENSITIES = [4, 9, 12, 16] as const;
type Density = (typeof DENSITIES)[number];
const PROBLEM = new Set(["reconnecting", "offline", "no_source", "error", "stalled"]);

const load = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};
const save = (key: string, v: unknown) => {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ }
};

const matches = (s: StreamInfo, f: Filter) =>
  f === "all" || (f === "live" && s.status === "live") || (f === "problems" && PROBLEM.has(s.status))
  || (f === "violating" && s.running && s.violations > 0);

export function DashboardPage() {
  const { connected, streams } = useMonitor();
  const { can } = useAuth();
  const canAdd = can("config:system");
  const addCamera = <Button variant="primary" icon={<Icon.plus size={15} />} onClick={() => { location.hash = "#/add-camera"; }}>Add camera</Button>;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [density, setDensity] = useState<Density>(() => {
    const d = load<number>("ppe.dashboard.density", 0);
    return (DENSITIES as readonly number[]).includes(d) ? (d as Density) : 4;
  });
  const [page, setPage] = useState(0);
  const close = useCallback(() => setExpanded(null), []);

  // first visit: pick a density that shows every camera on one page when possible
  useEffect(() => {
    if (streams.length && load<number>("ppe.dashboard.density", 0) === 0) {
      setDensity(DENSITIES.find((d) => d >= streams.length) ?? 16);
    }
  }, [streams.length]);

  // Arriving from "Add camera" (#/dashboard?focus=<id>): open that camera's detail
  // view so the just-added source (e.g. an uploaded video) is watched being analysed.
  useEffect(() => {
    const m = /[?&]focus=([^&/]+)/.exec(location.hash);
    if (m) {
      setExpanded(decodeURIComponent(m[1]));
      history.replaceState(null, "", "#/dashboard");
    }
  }, []);

  const counts = useMemo(() => ({
    all: streams.length,
    live: streams.filter((s) => matches(s, "live")).length,
    problems: streams.filter((s) => matches(s, "problems")).length,
    violating: streams.filter((s) => matches(s, "violating")).length,
  }), [streams]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return streams.filter((s) => matches(s, filter) && (!q || s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)));
  }, [streams, filter, query]);

  // Search / status-filter / pagination only earn their place on a large wall of
  // cameras; a small site shows every tile at once with no chrome to wade through.
  const showControls = streams.length > 6;
  const pages = Math.max(1, Math.ceil(shown.length / density));
  const current = Math.min(page, pages - 1);
  const visible = showControls ? shown.slice(current * density, current * density + density) : shown;
  useEffect(() => setPage(0), [filter, query, density]);

  const detail = streams.find((s) => s.id === expanded);
  // Compact tiles only when there are genuinely many cameras — a single camera should never render
  // as a tiny abbreviated sliver. Tiles auto-fill into a responsive wall at a comfortable min size.
  const dense = density >= 12 && shown.length > 6;
  const minTile = dense ? 260 : 360;

  return (
    <>
      <Topbar title="Dashboard" subtitle="Live PPE compliance monitoring" extra={canAdd ? addCamera : undefined} />
      <PageBody>
        {streams.length > 0 && <SafetySummary streams={streams} connected={connected} />}
        {streams.length > 0 && <ActiveIncidents onOpenCamera={setExpanded} />}
        {showControls && (
          <Card className="mb-5 flex flex-wrap items-center gap-2 px-3 py-2.5">
            <div className="relative w-full sm:w-60">
              <Icon.search size={15} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
              <Input aria-label="Search cameras" placeholder="Search cameras…" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-8" />
            </div>
            <div className="inline-flex flex-wrap rounded-lg border border-border bg-subtle p-0.5" role="group" aria-label="Filter cameras by status">
              {([["all", "All"], ["live", "Live"], ["problems", "Problems"], ["violating", "Violating now"]] as [Filter, string][]).map(([f, label]) => (
                <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium ${filter === f ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text"}`}>
                  {label}
                  <span className={`rounded-full px-1.5 text-[11px] tabular-nums ${f === "problems" && counts.problems ? "bg-danger-soft text-danger" : f === "violating" && counts.violating ? "bg-danger-soft text-danger" : "bg-surface text-muted"}`}>{counts[f]}</span>
                </button>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-2">
              <label htmlFor="density" className="text-[13px] text-muted">Per page</label>
              <Select id="density" value={density} className="w-20" onChange={(e) => { const d = Number(e.target.value) as Density; setDensity(d); save("ppe.dashboard.density", d); }}>
                {DENSITIES.map((d) => <option key={d} value={d}>{d}</option>)}
              </Select>
              {pages > 1 && (
                <div className="flex items-center gap-1" aria-label="Pages">
                  <IconButton label="Previous page" size="sm" variant="secondary" disabled={current === 0} onClick={() => setPage(current - 1)}><Icon.chevronLeft /></IconButton>
                  <span className="min-w-14 text-center text-[13px] tabular-nums">{current + 1} / {pages}</span>
                  <IconButton label="Next page" size="sm" variant="secondary" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}><Icon.chevronRight /></IconButton>
                </div>
              )}
            </div>
          </Card>
        )}

        {streams.length === 0 ? (
          connected ? (
            <Card><EmptyState icon={<Icon.camera size={20} />} title="No cameras configured"
              message={canAdd ? "Add an RTSP / HTTP IP camera, upload a video, or use a file on the server." : "Ask a Super Admin to add cameras."}
              action={canAdd ? addCamera : undefined} /></Card>
          ) : (
            <div className="grid gap-6 md:grid-cols-2">
              {[0, 1, 2, 3].map((i) => (
                <Card key={i} className="overflow-hidden">
                  <div className="flex gap-2 px-4 py-3"><Skeleton className="h-5 w-28" /><Skeleton className="h-5 w-14" /></div>
                  <Skeleton className="aspect-video w-full rounded-none" />
                  <div className="p-4"><Skeleton className="h-8 w-full" /></div>
                </Card>
              ))}
            </div>
          )
        ) : shown.length === 0 ? (
          <Card><EmptyState icon={<Icon.filter size={20} />} title="No cameras match" message="Clear the search or pick another status."
            action={<Button onClick={() => { setQuery(""); setFilter("all"); }}>Show all cameras</Button>} /></Card>
        ) : (
          <>
            {!showControls && <p className="mb-3 text-[11px] font-semibold tracking-wide text-muted uppercase">Live cameras</p>}
            <div className={`grid ${dense ? "gap-3" : "gap-5"}`} style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${minTile}px), 1fr))` }}>
              {visible.map((s) => (
                <CameraTile key={s.id} stream={s} dense={dense} expanded={expanded === s.id} onExpand={() => setExpanded(s.id)} />
              ))}
            </div>
          </>
        )}
      </PageBody>
      {detail && <DetailView stream={detail} onClose={close} />}
    </>
  );
}
