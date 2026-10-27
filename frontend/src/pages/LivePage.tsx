import { useCallback, useEffect, useMemo, useState } from "react";
import { CameraDrawer } from "../components/live/CameraDrawer";
import { CameraTile } from "../components/live/CameraTile";
import { byAttention, FleetBoard, FleetLegend } from "../components/live/FleetBoard";
import { Page } from "../components/layout/Shell";
import { Button, cx, Empty, Icon, Notice, Panel, Segmented, Switch, Tag } from "../components/ui";
import { api, jpegDataUrl } from "../lib/api";
import { fmtAgo, fmtTime, violationLabel } from "../lib/format";
import type { Violation } from "../types";
import { hashParams, href, navigateWith } from "../lib/router";
import { useAuth } from "../state/auth";
import { useMonitor } from "../state/monitor";

type Layout = "2" | "3" | "4";
const GRID: Record<Layout, string> = {
  "2": "grid-cols-1 md:grid-cols-2",
  "3": "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3",
  "4": "grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
};
const PER_PAGE: Record<Layout, number> = { "2": 4, "3": 9, "4": 16 };
// fewer pixels per tile -> fewer frames: a 4x4 wall costs about what a 2x2 one does
const FPS: Record<Layout, number> = { "2": 8, "3": 5, "4": 3 };
const CYCLE_MS = 20_000;
type View = "board" | "wall";
const pref = <T extends string>(key: string, fallback: T): T => {
  try { return (localStorage.getItem(key) as T) || fallback; } catch { return fallback; }
};
const save = (key: string, v: string) => { try { localStorage.setItem(key, v); } catch { /* private mode */ } };

/** Layout switch icons: 1×1, 2×2, 3×3. */
function GridIcon({ n }: { n: number }) {
  const g = 18 / n;
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      {Array.from({ length: n * n }, (_, k) => (
        <rect key={k} x={3 + (k % n) * g + 0.75} y={3 + Math.floor(k / n) * g + 0.75} width={g - 1.5} height={g - 1.5} rx={n === 1 ? 2 : 1} />
      ))}
    </svg>
  );
}

type Filter = "all" | "violating" | "offline";

/** Incidents as they are raised, newest on top (the Live workspace's right rail). */
function EventRail() {
  const { can } = useAuth();
  const { onViolation, onViolationUpdate } = useMonitor();
  const [items, setItems] = useState<Violation[] | null>(null);
  const [fresh, setFresh] = useState<number | null>(null);
  const [, tick] = useState(0);
  const allowed = can("violations:view");
  useEffect(() => {
    if (!allowed) return;
    let alive = true;
    api.violations.list({ limit: 12 }).then((p) => alive && setItems(p.items)).catch(() => alive && setItems([]));
    const offNew = onViolation((v) => { setItems((xs) => [v, ...(xs ?? []).filter((x) => x.id !== v.id)].slice(0, 12)); setFresh(v.id); });
    const offUpd = onViolationUpdate((u) => setItems((xs) => xs?.map((x) => (x.id === u.id ? { ...x, state: u.state, last_seen: u.last_seen, missing: u.missing ?? x.missing } : x)) ?? xs));
    const t = window.setInterval(() => tick((n) => n + 1), 10_000);
    return () => { alive = false; offNew(); offUpd(); window.clearInterval(t); };
  }, [allowed, onViolation, onViolationUpdate]);
  if (!allowed) return null;
  return (
    <Panel className="flex flex-col xl:sticky xl:top-[calc(var(--topbar-h)+12px)] xl:max-h-[calc(100dvh-var(--topbar-h)-36px)]">
      <div className="flex items-center gap-2 border-b border-line px-5 py-4">
        <span className="size-2 rounded-full bg-bad live-ping" />
        <h2 className="text-[15px] font-bold tracking-tight">Live events</h2>
        <a href={href("incidents")} className="ml-auto text-[13px] font-semibold text-accent no-underline hover:underline">Review all</a>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-2">
        {items === null ? <div className="space-y-2 p-2">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-14" />)}</div>
          : items.length === 0 ? <Empty icon="shield" title="No incidents yet">New ones appear here the moment they are confirmed.</Empty>
          : items.map((v) => {
            const ongoing = v.state === "ongoing";
            return (
              <button key={v.id} type="button" onClick={() => navigateWith("incidents", { id: v.id })}
                className={cx("flex w-full items-center gap-3 rounded-xl p-2 text-left hover:bg-sunken", v.id === fresh && "animate-[flash_2.6s]")}>
                <img src={jpegDataUrl(v.thumbnail)} alt="" className="size-12 shrink-0 rounded-[10px] bg-stage object-cover" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[13.5px] font-semibold">{v.missing.map(violationLabel).join(", ")}</span>
                    {ongoing && <Tag tone="bad">Now</Tag>}
                  </span>
                  <span className="block truncate text-[12.5px] text-ink-3">{v.stream_name} · <span className="font-mono">{fmtTime(v.timestamp)}</span> · {fmtAgo(v.timestamp)}</span>
                </span>
              </button>
            );
          })}
      </div>
    </Panel>
  );
}

export function LivePage() {
  const { connected, streams, info } = useMonitor();
  const { can } = useAuth();
  const [view, setViewState] = useState<View>(() => pref<View>("live.view", "wall"));
  const [layout, setLayoutState] = useState<Layout>(() => { const l = pref<string>("live.layout", "3"); return (["2", "3", "4"].includes(l) ? l : "3") as Layout; });
  const [zones, setZonesState] = useState(() => pref("live.zones", "1") === "1");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [cycle, setCycle] = useState(false);
  const [openId, setOpenId] = useState<string | null>(() => hashParams().get("camera"));
  const open = useCallback((id: string) => setOpenId(id), []);
  const setView = (v: View) => { setViewState(v); save("live.view", v); };
  const setLayout = (v: Layout) => { setLayoutState(v); setPage(0); save("live.layout", v); };
  const setZones = (v: boolean) => { setZonesState(v); save("live.zones", v ? "1" : "0"); };

  const live = streams.filter((s) => s.status === "live");
  const counts = useMemo(() => ({
    violating: streams.filter((s) => s.violations > 0).length,
    offline: streams.filter((s) => s.running && s.status !== "live").length, // stopped on purpose is not "down"
  }), [streams]);
  const matching = useMemo(() => {
    const t = query.trim().toLowerCase();
    return streams
      .filter((s) => (filter === "violating" ? s.violations > 0 : filter === "offline" ? s.running && s.status !== "live" : true))
      .filter((s) => !t || s.name.toLowerCase().includes(t) || s.id.toLowerCase().includes(t))
      .sort(byAttention);
  }, [streams, filter, query]);
  const per = PER_PAGE[layout];
  const pages = Math.max(1, Math.ceil(matching.length / per));
  const cur = Math.min(page, pages - 1);
  const wall = matching.slice(cur * per, cur * per + per);
  useEffect(() => setPage(0), [filter, query]);

  // control-room tour: turn the page every 20 s; hold while someone is unsafe so it isn't missed
  const unsafe = counts.violating > 0;
  useEffect(() => {
    if (!cycle || view !== "wall" || pages < 2 || unsafe) return;
    const t = window.setInterval(() => setPage((p) => (p + 1) % pages), CYCLE_MS);
    return () => window.clearInterval(t);
  }, [cycle, view, pages, unsafe]);

  const hasZones = streams.some((s) => s.zones?.length);
  const opened = streams.find((s) => s.id === openId) ?? null;
  const latency = live.length ? Math.round(live.reduce((n, s) => n + s.latency_ms, 0) / live.length) : null;

  return (
    <Page title="Live floor" wide
      description={streams.length
        ? `${live.length} of ${streams.length} camera${streams.length === 1 ? "" : "s"} online · ${counts.violating ? `${counts.violating} with someone unsafe` : "nobody unsafe"}${latency !== null ? ` · ${latency} ms camera-to-screen` : ""}`
        : "Every camera, as the detector sees it right now."}
      actions={<>
        <Segmented<View> label="View" value={view} onChange={setView} options={[{ value: "wall", label: "Video wall" }, { value: "board", label: `Board · ${streams.length}` }]} />
        {can("config:system") && <Button icon="plus" onClick={() => navigateWith("devices", { add: 1 })}>Add camera</Button>}
      </>}
      toolbar={streams.length ? <>
        <label className="flex h-10 w-full items-center gap-2 rounded-xl border border-line-strong bg-surface px-3 text-ink-3 focus-within:border-accent focus-within:ring-4 focus-within:ring-accent-soft sm:w-64">
          <Icon name="search" size={16} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a camera" aria-label="Find a camera"
            className="w-full min-w-0 bg-transparent text-sm text-ink outline-none placeholder:text-ink-4" />
        </label>
        <Segmented<Filter> label="Show cameras" value={filter} onChange={setFilter} options={[
          { value: "all", label: "All", count: streams.length },
          { value: "violating", label: "Unsafe", count: counts.violating },
          { value: "offline", label: "Down", count: counts.offline },
        ]} />
        {view === "wall" && <>
          <div role="radiogroup" aria-label="Tiles per page" className="inline-flex rounded-xl border border-line bg-sunken p-[3px]">
            {(["2", "3", "4"] as Layout[]).map((n) => (
              <button key={n} type="button" role="radio" aria-checked={layout === n} aria-label={`${n}×${n}, ${PER_PAGE[n]} per page`} title={`${n}×${n} · ${PER_PAGE[n]} per page`} onClick={() => setLayout(n)}
                className={cx("grid h-[30px] w-9 place-items-center rounded-[9px]", layout === n ? "bg-surface text-ink shadow-[var(--sh-xs)]" : "text-ink-3 hover:text-ink")}>
                <GridIcon n={Number(n)} />
              </button>
            ))}
          </div>
          {hasZones && <Switch checked={zones} onChange={setZones} label="Zones" />}
          {pages > 1 && (
            <div className="flex items-center gap-1.5 sm:ml-auto">
              <Switch checked={cycle} onChange={setCycle} label={<span title="Turn the page every 20 s; holds while someone is unsafe">Auto-cycle</span>} />
              <span className="mx-1 h-6 w-px bg-line" aria-hidden="true" />
              <Button size="sm" variant="outline" icon="chevronLeft" aria-label="Previous page" onClick={() => setPage((cur - 1 + pages) % pages)} />
              <span className="min-w-[64px] text-center font-mono text-[12.5px] text-ink-2">{cur + 1} / {pages}</span>
              <Button size="sm" variant="outline" icon="chevronRight" aria-label="Next page" onClick={() => setPage((cur + 1) % pages)} />
            </div>
          )}
        </>}
      </> : undefined}>
      {!connected && info && (
        <Notice tone="bad" title="Connection to the server lost" className="mb-4">Figures and video are frozen. Reconnecting automatically.</Notice>
      )}

      {streams.length === 0 ? (
        <Panel>
          <Empty icon="camera" title={info ? "No cameras yet" : "Connecting to the server…"}
            action={info && can("config:system") ? <Button variant="primary" icon="plus" onClick={() => navigateWith("devices", { add: 1 })}>Add the first camera</Button> : undefined}>
            {info ? "Add an RTSP or HTTP camera, or a recorded video, to start checking PPE." : undefined}
          </Empty>
        </Panel>
      ) : (
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0">
            {matching.length === 0 ? (
              <Panel>
                <Empty icon={filter === "violating" ? "shield" : "search"}
                  title={filter === "violating" ? "Nobody is unsafe right now" : filter === "offline" ? "Every camera is delivering" : "No camera matches"}
                  action={<Button onClick={() => { setFilter("all"); setQuery(""); }}>Show all cameras</Button>} />
              </Panel>
            ) : view === "board" ? (
              <Panel className="p-4">
                <div className="mb-3.5"><FleetLegend streams={matching} /></div>
                <FleetBoard streams={matching} onOpen={open} />
              </Panel>
            ) : (
              <>
                <div className={cx("grid gap-3.5", GRID[layout])}>
                  {wall.map((s) => <CameraTile key={s.id} s={s} onOpen={open} showZones={zones} fps={FPS[layout]} card />)}
                </div>
                {pages > 1 && (
                  <div className="mt-4 flex items-center justify-center gap-1.5" aria-label="Pages">
                    {Array.from({ length: pages }, (_, i) => (
                      <button key={i} type="button" onClick={() => setPage(i)} aria-label={`Page ${i + 1}`} aria-current={i === cur ? "page" : undefined}
                        className={cx("h-1.5 rounded-full transition-all", i === cur ? "w-6 bg-accent" : "w-1.5 bg-line-strong hover:bg-ink-4")} />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          <EventRail />
        </div>
      )}

      <CameraDrawer stream={opened} onClose={() => setOpenId(null)} />
    </Page>
  );
}
