import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Page } from "../components/layout/Shell";
import { FALLBACK_REASONS, dialogOpen, isTyping, matchesReview, type Reason, type ReviewPatch } from "../components/review/shared";
import { ViolationDetail } from "../components/review/ViolationDetail";
import { ListSkeleton, ViolationList } from "../components/review/ViolationList";
import { TableSkeleton, ViolationTable } from "../components/review/ViolationTable";
import { Button, cx, Dialog, Drawer, Empty, Field, Input, Notice, Select, Tabs, useToast } from "../components/ui";
import { api, type ViolationQuery } from "../lib/api";
import { dateRangeToEpoch, fmtDateTime, fmtInt, violationLabel } from "../lib/format";
import { hashParams } from "../lib/router";
import { useAuth } from "../state/auth";
import { useMonitor } from "../state/monitor";
import type { ConfigSchema, Violation, ViolationUpdate } from "../types";

const PAGE_SIZE = 50;

type Status = "unreviewed" | "valid" | "false_alarm" | "all";
const STATUS_OPTIONS: { value: Status; label: string }[] = [
  { value: "unreviewed", label: "Open" },
  { value: "valid", label: "Confirmed" },
  { value: "false_alarm", label: "False alarm" },
  { value: "all", label: "All" },
];
interface Filters { status: Status; camera: string; ppe: string; from: string; to: string }
interface Camera { id: string; name: string }

function toQuery(f: Filters): ViolationQuery {
  return {
    ...dateRangeToEpoch(f.from, f.to),
    camera: f.camera || undefined,
    ppe: f.ppe || undefined,
    review: f.status === "all" ? undefined : f.status,
  };
}

const matches = (v: Violation, q: ViolationQuery) =>
  (!q.camera || v.stream_id === q.camera) && (!q.ppe || v.missing.includes(q.ppe))
  && (q.start === undefined || v.timestamp >= q.start) && (q.end === undefined || v.timestamp < q.end)
  && matchesReview(v, q.review);

const applyUpdate = (x: Violation, u: ViolationUpdate): Violation => ({
  ...x, state: u.state, last_seen: u.last_seen, observations: u.observations,
  duration: Math.max(0, u.last_seen - x.timestamp), ...(u.missing ? { missing: u.missing } : {}),
});

function readDeepLink(): { filters: Filters; id: number | null } {
  const p = hashParams();
  const review = p.get("review");
  const id = Number(p.get("id"));
  return {
    filters: {
      status: STATUS_OPTIONS.some((o) => o.value === review) ? (review as Status) : "unreviewed",
      camera: p.get("camera") ?? "", ppe: p.get("ppe") ?? "", from: "", to: "",
    },
    id: Number.isInteger(id) && id > 0 ? id : null,
  };
}


const DESKTOP = "(min-width: 1280px)";

function useMediaQuery(query: string): boolean {
  const [on, setOn] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const h = () => setOn(m.matches);
    h();
    m.addEventListener("change", h);
    return () => m.removeEventListener("change", h);
  }, [query]);
  return on;
}

/** Height that makes the element end at the bottom of the viewport (the triage panes scroll inside it). */
function useFillHeight(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || !el) { setHeight(undefined); return; }
    const calc = () => setHeight(Math.max(520, Math.floor(window.innerHeight - el.getBoundingClientRect().top - window.scrollY - 24)));
    calc();
    window.addEventListener("resize", calc);
    const ro = new ResizeObserver(calc);
    ro.observe(document.body);
    return () => { window.removeEventListener("resize", calc); ro.disconnect(); };
  }, [enabled]);
  return [ref, height] as const;
}

/**
 * Review queue. The monitor context changes 4x/s, so this thin wrapper is the only part that
 * subscribes to it; the page itself is memoised and gets the camera list only when it really changes.
 */
export function ReviewPage() {
  const { streams, onViolation, onViolationUpdate } = useMonitor();
  const signature = streams.map((s) => `${s.id}\u0000${s.name}`).join("\u0001");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cameras = useMemo<Camera[]>(() => streams.map((s) => ({ id: s.id, name: s.name })), [signature]);
  return <ReviewQueue cameras={cameras} onViolation={onViolation} onViolationUpdate={onViolationUpdate} />;
}

const ReviewQueue = memo(function ReviewQueue({ cameras, onViolation, onViolationUpdate }: {
  cameras: Camera[];
  onViolation: (fn: (v: Violation) => void) => () => void;
  onViolationUpdate: (fn: (u: ViolationUpdate) => void) => () => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const canReview = can("violations:ack");
  const canExport = can("violations:export");
  const canDelete = can("violations:delete");
  // v3: three-pane triage (queue | evidence + verdict) on wide screens; table + slide-over panel below that
  const isDesktop = useMediaQuery(DESKTOP);

  const [initial] = useState(readDeepLink);
  const [filters, setFilters] = useState<Filters>(initial.filters);
  const [items, setItems] = useState<Violation[]>([]);
  const [queued, setQueued] = useState<Violation[]>([]); // live arrivals held back while the user is scrolled down
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(initial.id);
  const [drawerOpen, setDrawerOpen] = useState(initial.id !== null);
  const [schema, setSchema] = useState<ConfigSchema | null>(null);
  const [exportingCsv, setExportingCsv] = useState(false);
  const [datasetOpen, setDatasetOpen] = useState(false);
  const [datasetLimit, setDatasetLimit] = useState(500);
  const [datasetBusy, setDatasetBusy] = useState(false);

  const query = useMemo(() => toQuery(filters), [filters]);

  // per-tab counts under the same camera / type / date filters; refreshed whenever the list total moves
  const [counts, setCounts] = useState<Partial<Record<Status, number>>>({});
  useEffect(() => {
    let alive = true;
    const base = toQuery({ ...filters, status: "all" });
    Promise.all(STATUS_OPTIONS.map((o) => api.violations.list({ ...base, review: o.value === "all" ? undefined : o.value, limit: 1 })
      .then((p) => [o.value, p.total] as const)))
      .then((xs) => alive && setCounts(Object.fromEntries(xs)))
      .catch(() => {});
    return () => { alive = false; };
  }, [filters.camera, filters.ppe, filters.from, filters.to, total]); // eslint-disable-line react-hooks/exhaustive-deps
  const rangeError = !!filters.from && !!filters.to && filters.from > filters.to;
  const narrowed = !!(filters.camera || filters.ppe || filters.from || filters.to);

  const reqId = useRef(0);
  const moreBusy = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  // latest values for callbacks that must stay stable (rows are memoised on them)
  const live = useRef({ items, selectedId, cursor, query, isDesktop, drawerOpen });
  live.current = { items, selectedId, cursor, query, isDesktop, drawerOpen };

  useEffect(() => {
    let on = true;
    api.config.schema().then((s) => on && setSchema(s)).catch(() => { /* fall back to defaults */ });
    return () => { on = false; };
  }, []);
  const reasons: Reason[] = schema?.review_reasons?.length ? schema.review_reasons : FALLBACK_REASONS;

  const changeFilters = useCallback((patch: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setSelectedId(null); // the first row of the new result is selected once it arrives
    setLoading(true); // same render as the selection reset, so the old rows are never auto-selected
    setDrawerOpen(false);
  }, []);

  // first page whenever the filters change
  useEffect(() => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    setQueued([]);
    api.violations.list({ ...query, limit: PAGE_SIZE })
      .then((p) => {
        if (id !== reqId.current) return;
        setItems(p.items);
        setTotal(p.total);
        setCursor(p.next_before_id);
        listRef.current?.scrollTo({ top: 0 });
      })
      .catch((e) => {
        if (id !== reqId.current) return;
        setItems([]);
        setTotal(0);
        setCursor(null);
        setError((e as Error).message);
      })
      .finally(() => id === reqId.current && setLoading(false));
  }, [query, reload]);

  const loadMore = useCallback(async () => {
    const { cursor: before, query: q } = live.current;
    if (before === null || moreBusy.current) return;
    const id = reqId.current;
    moreBusy.current = true;
    setLoadingMore(true);
    try {
      const p = await api.violations.list({ ...q, limit: PAGE_SIZE, before_id: before });
      if (id !== reqId.current) return;
      setItems((xs) => {
        const seen = new Set(xs.map((x) => x.id));
        return [...xs, ...p.items.filter((x) => !seen.has(x.id))];
      });
      setCursor(p.next_before_id);
    } catch (e) {
      toast({ tone: "error", title: "Couldn't load more violations", message: (e as Error).message });
    } finally {
      moreBusy.current = false;
      setLoadingMore(false);
    }
  }, [toast]);

  // infinite scroll: the list is its own scroller on desktop, the page scrolls on small screens
  useEffect(() => {
    const el = sentinel.current;
    if (!el || cursor === null || loading) return;
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) void loadMore(); },
      { root: isDesktop ? listRef.current : null, rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, loading, loadMore, isDesktop, items.length]);

  // live: a new violation goes on top when the user is at the top of the list, otherwise it waits behind a button
  useEffect(() => onViolation((v) => {
    const s = live.current;
    if (!matches(v, s.query) || s.items.some((x) => x.id === v.id)) return;
    setTotal((t) => t + 1);
    const atTop = s.isDesktop ? (listRef.current?.scrollTop ?? 0) < 60 : window.scrollY < 160;
    if (atTop) setItems((xs) => (xs.some((x) => x.id === v.id) ? xs : [v, ...xs]));
    else setQueued((xs) => (xs.some((x) => x.id === v.id) ? xs : [v, ...xs]));
  }), [onViolation]);

  // live: an ongoing event got longer, gained an item or ended
  useEffect(() => onViolationUpdate((u) => {
    const patch = (xs: Violation[]) => (xs.some((x) => x.id === u.id) ? xs.map((x) => (x.id === u.id ? applyUpdate(x, u) : x)) : xs);
    setItems(patch);
    setQueued(patch);
  }), [onViolationUpdate]);

  const showQueued = () => {
    setItems((xs) => {
      const seen = new Set(xs.map((x) => x.id));
      return [...queued.filter((x) => !seen.has(x.id)), ...xs];
    });
    setQueued([]);
    if (isDesktop) listRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    else window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const select = useCallback((id: number) => {
    setSelectedId(id);
    setDrawerOpen(true);
  }, []);

  // desktop always shows a violation in the detail pane: pick the first row when nothing is selected
  useEffect(() => {
    if (isDesktop && selectedId === null && !loading && items.length) setSelectedId(items[0].id);
  }, [isDesktop, selectedId, loading, items]);

  useEffect(() => {
    if (selectedId === null) return;
    listRef.current?.querySelector(`[data-vid="${selectedId}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedId, isDesktop]);

  const [fillRef, height] = useFillHeight(isDesktop);

  const step = useCallback((delta: 1 | -1) => {
    const { items: xs, selectedId: cur, cursor: more } = live.current;
    if (!xs.length) return;
    const i = xs.findIndex((x) => x.id === cur);
    const next = i < 0 ? xs[0] : xs[i + delta];
    if (next) setSelectedId(next.id);
    else if (delta === 1 && more !== null) void loadMore();
  }, [loadMore]);

  /** Take a row out of the list (reviewed away from the filter, or deleted) and move on to its neighbour. */
  const dropRow = useCallback((id: number) => {
    const xs = live.current.items;
    const i = xs.findIndex((x) => x.id === id);
    if (i < 0) return false;
    const next = xs[i + 1] ?? xs[i - 1];
    setItems((ys) => ys.filter((y) => y.id !== id));
    setTotal((t) => Math.max(0, t - 1));
    if (live.current.selectedId === id) {
      setSelectedId(next ? next.id : null);
      if (!next) setDrawerOpen(false);
    }
    return true;
  }, []);

  const handleReviewed = useCallback((id: number, patch: ReviewPatch) => {
    const { items: xs, query: q } = live.current;
    const i = xs.findIndex((x) => x.id === id);
    if (i < 0) return; // opened from a link and not part of this list: stay on it
    const updated = { ...xs[i], ...patch };
    if (!matchesReview(updated, q.review)) {
      dropRow(id);
      if (!patch.review) toast({ tone: "info", title: "Review undone", message: "The violation is back in the Unreviewed queue." });
      return;
    }
    setItems((ys) => ys.map((y) => (y.id === id ? { ...y, ...patch } : y)));
    if (!patch.review) return; // undo: stay on the row
    const next = xs[i + 1];
    if (next) setSelectedId(next.id);
    else if (live.current.cursor !== null) void loadMore();
  }, [dropRow, loadMore, toast]);

  const handleDeleted = useCallback((id: number) => {
    if (!dropRow(id)) { setSelectedId(null); setDrawerOpen(false); }
  }, [dropRow]);

  // J/K and arrows move through the list (V / F live in the detail pane)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      const s = live.current;
      if (dialogOpen(!s.isDesktop && s.drawerOpen ? 1 : 0)) return;
      const k = e.key.toLowerCase();
      if (k === "j" || e.key === "ArrowDown") { e.preventDefault(); step(1); }
      else if (k === "k" || e.key === "ArrowUp") { e.preventDefault(); step(-1); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [step]);

  // ---- filter options
  const cameraOptions = useMemo(() => (
    filters.camera && !cameras.some((c) => c.id === filters.camera) ? [...cameras, { id: filters.camera, name: filters.camera }] : cameras
  ), [cameras, filters.camera]);
  const seenTypes = useRef(new Set<string>());
  const typeOptions = useMemo(() => {
    const out = new Set<string>(schema ? [...schema.ppe_items, ...schema.behaviors, ...(schema.zone_items ?? [])] : []);
    if (!schema) {
      items.forEach((v) => v.missing.forEach((m) => seenTypes.current.add(m)));
      seenTypes.current.forEach((m) => out.add(m));
    }
    if (filters.ppe) out.add(filters.ppe);
    return [...out];
  }, [schema, items, filters.ppe]);

  // ---- exports
  const exportCsv = async () => {
    setExportingCsv(true);
    try { await api.violations.exportCsv(query); }
    catch (e) { toast({ tone: "error", title: "Couldn't export the CSV", message: (e as Error).message }); }
    finally { setExportingCsv(false); }
  };
  const exportDataset = async () => {
    setDatasetBusy(true);
    try {
      await api.violations.exportDataset(query, datasetLimit);
      setDatasetOpen(false);
      toast({ tone: "success", title: "Dataset downloaded", message: "Open the zip in an annotation tool to complete the labels." });
    } catch (e) {
      toast({ tone: "error", title: "Couldn't export the dataset", message: (e as Error).message });
    } finally {
      setDatasetBusy(false);
    }
  };
  const scope = [
    STATUS_OPTIONS.find((o) => o.value === filters.status)!.label.toLowerCase() + (filters.status === "all" ? " violations" : ""),
    filters.camera && `camera ${cameraOptions.find((c) => c.id === filters.camera)?.name ?? filters.camera}`,
    filters.ppe && `type “${violationLabel(filters.ppe)}”`,
    filters.from && `from ${filters.from}`,
    filters.to && `to ${filters.to}`,
  ].filter(Boolean).join(", ");

  const selectedItem = selectedId === null ? undefined : items.find((x) => x.id === selectedId) ?? queued.find((x) => x.id === selectedId);
  const statusLabel = STATUS_OPTIONS.find((o) => o.value === filters.status)!.label.toLowerCase();

  const toolbar = (
    <>
      <Select aria-label="Camera" className="w-full sm:w-44" value={filters.camera} onChange={(e) => changeFilters({ camera: e.target.value })}>
        <option value="">All cameras</option>
        {cameraOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </Select>
      <Select aria-label="Violation type" className="w-full sm:w-44" value={filters.ppe} onChange={(e) => changeFilters({ ppe: e.target.value })}>
        <option value="">All types</option>
        {typeOptions.map((t) => <option key={t} value={t}>{violationLabel(t)}</option>)}
      </Select>
      <div className="flex w-full items-center gap-1.5 sm:w-auto">
        <Input type="date" aria-label="From date" title={rangeError ? "The start date is after the end date" : "From date"} invalid={rangeError}
          className="num min-w-0 flex-1 sm:w-36 sm:flex-none" value={filters.from} max={filters.to || undefined} onChange={(e) => changeFilters({ from: e.target.value })} />
        <span className="text-[13px] text-ink-3">to</span>
        <Input type="date" aria-label="To date" title={rangeError ? "The start date is after the end date" : "To date"} invalid={rangeError}
          className="num min-w-0 flex-1 sm:w-36 sm:flex-none" value={filters.to} min={filters.from || undefined} onChange={(e) => changeFilters({ to: e.target.value })} />
      </div>
      {narrowed && <Button variant="ghost" icon="x" onClick={() => changeFilters({ camera: "", ppe: "", from: "", to: "" })}>Clear</Button>}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <span className="mr-1 text-[13px] text-ink-3" aria-live="polite">
          <span className="num font-semibold text-ink">{loading ? "–" : fmtInt(total)}</span> {total === 1 && !loading ? "incident" : "incidents"}
        </span>
        {canExport && <>
          <Button icon="download" loading={exportingCsv} onClick={() => void exportCsv()}>Export CSV</Button>
          <Button icon="dataset" onClick={() => setDatasetOpen(true)}>Export dataset</Button>
        </>}
      </div>
    </>
  );

  const list = loading ? (isDesktop ? <ListSkeleton /> : <TableSkeleton />) : error ? (
    <div className="p-4">
      <Notice tone="bad" title="Couldn't load violations" action={<Button size="sm" onClick={() => setReload((n) => n + 1)}>Retry</Button>}>{error}</Notice>
    </div>
  ) : !items.length && cursor === null && !queued.length ? (
    filters.status === "unreviewed" && !narrowed ? (
      <Empty icon="check" title="The queue is clear">
        Every recorded violation has a verdict. New violations appear here as soon as a camera records one.
      </Empty>
    ) : (
      <Empty icon="filter" title={rangeError ? "The start date is after the end date" : `No ${filters.status === "all" ? "" : `${statusLabel} `}violations match`}
        action={narrowed ? <Button onClick={() => changeFilters({ camera: "", ppe: "", from: "", to: "" })}>Clear filters</Button>
          : filters.status !== "all" ? <Button onClick={() => changeFilters({ status: "all" })}>Show all violations</Button> : undefined}>
        {rangeError ? "Swap the dates or clear them to see results."
          : narrowed ? "Widen the date range or remove a filter to see more."
          : filters.status === "all" ? "Nothing has been recorded yet. Violations appear here once a running camera detects one."
          : "No violation has this verdict yet."}
      </Empty>
    )
  ) : (
    <>
      {queued.length > 0 && (
        <div className="border-b border-line bg-accent-soft px-[18px] py-2">
          <button type="button" onClick={showQueued} className="text-[13px] font-medium text-accent-strong hover:underline">
            Show <span className="num">{queued.length}</span> new violation{queued.length === 1 ? "" : "s"}
          </button>
        </div>
      )}
      {isDesktop ? <ViolationList items={items} selectedId={selectedId} onSelect={select} /> : <ViolationTable items={items} selectedId={selectedId} onSelect={select} />}
      <div ref={sentinel} className="flex min-h-10 items-center justify-center px-4 py-3">
        {cursor !== null
          ? <Button variant="ghost" size="sm" loading={loadingMore} onClick={() => void loadMore()}>Load more</Button>
          : <span className="text-xs text-ink-3">End of list · <span className="num">{fmtInt(items.length)}</span> shown</span>}
      </div>
    </>
  );

  const detail = selectedId !== null && (
    <ViolationDetail key={selectedId} id={selectedId} item={selectedItem} reasons={reasons} canReview={canReview} canDelete={canDelete}
      inDrawer={!isDesktop} onReviewed={handleReviewed} onDeleted={handleDeleted} />
  );

  return (
    <Page title="Review" wide
      tabs={<Tabs<Status> label="Review status" value={filters.status} onChange={(status) => changeFilters({ status })}
        options={STATUS_OPTIONS.map((o) => ({ ...o, count: counts[o.value] }))} />}
      description={<>One incident at a time: check the evidence, then confirm or dismiss. <span className="hidden xl:inline">Keys: <b className="font-mono font-semibold text-ink-2">J</b>/<b className="font-mono font-semibold text-ink-2">K</b> move, <b className="font-mono font-semibold text-ink-2">V</b> confirm, <b className="font-mono font-semibold text-ink-2">F</b> false alarm.</span></>}>
      <section className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
        <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-[18px] py-3.5">{toolbar}</div>
        <div ref={fillRef} style={isDesktop && height ? { height } : undefined} className={cx(isDesktop && "flex")}>
          <div ref={listRef} aria-label="Incidents" role="region"
            className={cx(isDesktop && "scroll-thin w-[400px] shrink-0 overflow-y-auto border-r border-line bg-surface-2")}>{list}</div>
          {isDesktop && (
            <div className="scroll-thin flex min-w-0 flex-1 flex-col overflow-y-auto">
              {detail || (
                <div className="flex flex-1 items-center justify-center">
                  {loading ? null : (
                    <Empty icon="incidents" title="Nothing selected">
                      {items.length ? "Choose an incident from the queue to see its evidence." : "Evidence and verdict controls appear here when the queue has an incident."}
                    </Empty>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {!isDesktop && (
        <Drawer open={drawerOpen && selectedId !== null} onClose={() => setDrawerOpen(false)} width={660}
          title={selectedItem ? selectedItem.missing.map(violationLabel).join(", ") : `Incident #${selectedId ?? ""}`}
          subtitle={selectedItem ? <><span className="font-mono">#{selectedItem.id}</span> · {selectedItem.stream_name} · <span className="num">{fmtDateTime(selectedItem.timestamp)}</span></> : undefined}>
          {detail}
        </Drawer>
      )}

      <Dialog open={datasetOpen} onClose={() => !datasetBusy && setDatasetOpen(false)} title="Export retraining dataset"
        footer={<>
          <Button variant="ghost" onClick={() => setDatasetOpen(false)} disabled={datasetBusy}>Cancel</Button>
          <Button variant="primary" icon="download" loading={datasetBusy} onClick={() => void exportDataset()}>Download zip</Button>
        </>}>
        <div className="space-y-3 text-[13px] text-ink-2">
          <p>Downloads a zip in YOLO layout for retraining the detection model, built from the violations that match the current filters ({scope}).</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>Clean camera frames, without boxes or captions drawn on them.</li>
            <li>A label file per frame with the flagged person's box as a pre-label.</li>
            <li>A manifest with the reviewer verdict and false-alarm reason for each frame.</li>
          </ul>
          <p>The labels are pre-labels, not finished annotations: open the set in an annotation tool and complete the PPE boxes before training.</p>
          <Field label="Number of violations" hint="The newest matching violations are exported first. Only violations with a stored original frame are included.">
            {(fid) => (
              <Select id={fid} className="num w-40" value={datasetLimit} onChange={(e) => setDatasetLimit(Number(e.target.value))}>
                {[100, 500, 1000, 2000].map((n) => <option key={n} value={n}>Newest {fmtInt(n)}</option>)}
              </Select>
            )}
          </Field>
        </div>
      </Dialog>
    </Page>
  );
});
