import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageBody } from "../components/layout/PageBody";
import { Topbar } from "../components/layout/Topbar";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, Icon, Input, PpeChip, Select, Skeleton, useToast } from "../components/ui";
import { ViolationModal } from "../components/violations/ViolationModal";
import { api, jpegDataUrl, type ViolationQuery } from "../lib/api";
import { dateRangeToEpoch, dayKey, dayLabel, fmtTime, PPE_LABEL, BEHAVIOR_LABEL } from "../lib/format";
import { useAuth } from "../state/auth";
import { useMonitor } from "../state/monitor";
import type { Violation } from "../types";

const PAGE = 48;
interface Filters { from: string; to: string; camera: string; ppe: string; status: "" | "open" | "ack" }
const EMPTY: Filters = { from: "", to: "", camera: "", ppe: "", status: "" };

function toQuery(f: Filters): ViolationQuery {
  return {
    ...dateRangeToEpoch(f.from, f.to), camera: f.camera || undefined, ppe: f.ppe || undefined,
    acknowledged: f.status === "" ? undefined : f.status === "ack",
  };
}

function matches(v: Violation, q: ViolationQuery) {
  return (!q.camera || v.stream_id === q.camera) && (!q.ppe || v.missing.includes(q.ppe))
    && (q.start === undefined || v.timestamp >= q.start) && (q.end === undefined || v.timestamp < q.end)
    && (q.acknowledged === undefined || q.acknowledged === (v.acknowledged_at != null));
}

export function ViolationsPage() {
  const { streams, onViolation, onViolationUpdate } = useMonitor();
  const { can } = useAuth();
  const toast = useToast();
  const [exporting, setExporting] = useState(false);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [items, setItems] = useState<Violation[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null); // by id: live inserts must not shift it
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const canDelete = can("violations:delete");
  const query = useMemo(() => toQuery(filters), [filters]);
  const reqId = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<Violation[]>([]);
  itemsRef.current = items;
  const openIndex = openId === null ? -1 : items.findIndex((x) => x.id === openId);

  // first page whenever the filters change
  useEffect(() => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    api.violations.list({ ...query, limit: PAGE })
      .then((p) => {
        if (id !== reqId.current) return;
        setItems(p.items);
        setTotal(p.total);
        setCursor(p.next_before_id);
      })
      .catch((e) => id === reqId.current && setError((e as Error).message))
      .finally(() => id === reqId.current && setLoading(false));
  }, [query]);

  const loadMore = useCallback(async () => {
    if (cursor === null || loadingMore) return;
    const id = reqId.current;
    setLoadingMore(true);
    try {
      const p = await api.violations.list({ ...query, limit: PAGE, before_id: cursor });
      if (id !== reqId.current) return;
      setItems((xs) => {
        const seen = new Set(xs.map((x) => x.id));
        return [...xs, ...p.items.filter((x) => !seen.has(x.id))];
      });
      setCursor(p.next_before_id);
      setTotal(p.total);
    } catch (e) {
      toast({ tone: "error", title: "Couldn't load more violations", message: (e as Error).message });
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, query, toast]);

  // infinite scroll
  useEffect(() => {
    const el = sentinel.current;
    if (!el || cursor === null) return;
    const io = new IntersectionObserver((es) => es[0].isIntersecting && loadMore(), { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, loadMore]);

  // live: prepend new violations that match the current filters
  useEffect(() => onViolation((v) => {
    if (!matches(v, query)) return;
    setItems((xs) => (xs.some((x) => x.id === v.id) ? xs : [v, ...xs]));
    setTotal((t) => t + 1);
    setFresh((s) => new Set(s).add(v.id));
    window.setTimeout(() => setFresh((s) => { const n = new Set(s); n.delete(v.id); return n; }), 2000);
  }), [onViolation, query]);

  // live: an ongoing event got longer / ended / gained a missing item - update its card in place
  useEffect(() => onViolationUpdate((u) => setItems((xs) => xs.map((x) => (x.id !== u.id ? x : {
    ...x, state: u.state, last_seen: u.last_seen, observations: u.observations,
    duration: Math.max(0, u.last_seen - x.timestamp), ...(u.missing ? { missing: u.missing } : {}),
  })))), [onViolationUpdate]);

  const groups = useMemo(() => {
    const out: { key: string; items: { v: Violation }[] }[] = [];
    items.forEach((v) => {
      const k = dayKey(v.timestamp);
      if (!out.length || out[out.length - 1].key !== k) out.push({ key: k, items: [] });
      out[out.length - 1].items.push({ v });
    });
    return out;
  }, [items]);

  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const active = filters.from || filters.to || filters.camera || filters.ppe || filters.status;

  // ---- multi-select + bulk delete (uses the existing single-delete endpoint per item)
  const toggleSelect = (id: number) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const clearSelection = () => setSelected(new Set());
  const selectAll = () => setSelected(new Set(items.map((v) => v.id)));
  const allLoadedSelected = items.length > 0 && items.every((v) => selected.has(v.id));
  useEffect(() => setSelected(new Set()), [query]); // the visible set changed under the selection
  const bulkDelete = async () => {
    setBulkBusy(true);
    const ids = [...selected];
    const res = await Promise.allSettled(ids.map((id) => api.violations.remove(id)));
    const ok = new Set(ids.filter((_, i) => res[i].status === "fulfilled"));
    const failed = ids.length - ok.size;
    if (ok.size) {
      setItems((xs) => xs.filter((x) => !ok.has(x.id)));
      setTotal((t) => Math.max(0, t - ok.size));
    }
    setBulkBusy(false);
    setConfirmBulk(false);
    clearSelection();
    if (failed) toast({ tone: "error", title: `Couldn't delete ${failed} violation${failed === 1 ? "" : "s"}`, message: ok.size ? `${ok.size} deleted.` : undefined });
    else toast({ tone: "success", title: `Deleted ${ok.size} violation${ok.size === 1 ? "" : "s"}` });
  };
  const exportCsv = async () => {
    setExporting(true);
    try { await api.violations.exportCsv(query); }
    catch (e) { toast({ tone: "error", title: "Export failed", message: (e as Error).message }); }
    finally { setExporting(false); }
  };
  const rangeError = filters.from && filters.to && filters.from > filters.to ? "“From” is after “To”" : undefined;

  return (
    <>
      <Topbar title="Violations" subtitle={loading ? "Loading…" : `Captured evidence · ${total} record${total === 1 ? "" : "s"}${active ? " match the filters" : ""} · updates live`}
        extra={
          <div className="flex items-center gap-2">
            {selected.size > 0 && <span className="text-[13px] font-medium tabular-nums text-muted">{selected.size} selected</span>}
            {canDelete && items.length > 0 && !allLoadedSelected && <Button variant="ghost" size="sm" onClick={selectAll}>Select all</Button>}
            {selected.size > 0 && <Button variant="ghost" size="sm" onClick={clearSelection}>Clear</Button>}
            {selected.size > 0 && <Button variant="danger" size="sm" icon={<Icon.trash size={15} />} onClick={() => setConfirmBulk(true)}>Delete</Button>}
            {selected.size === 0 && can("violations:export") && <Button icon={<Icon.download size={15} />} loading={exporting} onClick={exportCsv} className="hidden sm:inline-flex">Export CSV</Button>}
          </div>
        } />
      <PageBody>
        <Card className="mb-6 p-4">
          <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 xl:grid-cols-[repeat(5,minmax(0,1fr))_auto]">
            <Field id="f-from" label="From" error={rangeError}><Input id="f-from" type="date" value={filters.from} max={filters.to || undefined} onChange={set("from")} invalid={!!rangeError} /></Field>
            <Field id="f-to" label="To"><Input id="f-to" type="date" value={filters.to} min={filters.from || undefined} onChange={set("to")} /></Field>
            <Field id="f-cam" label="Camera">
              <Select id="f-cam" value={filters.camera} onChange={set("camera")}>
                <option value="">All cameras</option>
                {streams.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
            <Field id="f-ppe" label="Violation type">
              <Select id="f-ppe" value={filters.ppe} onChange={set("ppe")}>
                <option value="">Any type</option>
                {Object.entries(PPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                {Object.entries(BEHAVIOR_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </Select>
            </Field>
            <Field id="f-status" label="Status">
              <Select id="f-status" value={filters.status} onChange={set("status")}>
                <option value="">Open and acknowledged</option>
                <option value="open">Open only</option>
                <option value="ack">Acknowledged only</option>
              </Select>
            </Field>
            <Button variant="ghost" icon={<Icon.close size={15} />} disabled={!active} onClick={() => setFilters(EMPTY)} className="justify-self-start sm:col-span-2 xl:col-span-1">Clear filters</Button>
          </div>
        </Card>

        {loading ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {Array.from({ length: 12 }, (_, i) => (
              <Card key={i} className="overflow-hidden"><Skeleton className="aspect-[4/5] w-full rounded-none" /><div className="flex flex-col gap-2 p-3"><Skeleton className="h-4 w-16" /><Skeleton className="h-3 w-24" /></div></Card>
            ))}
          </div>
        ) : error ? (
          <Card><EmptyState icon={<Icon.alert size={20} />} title="Couldn't load violations" message={error} action={<Button onClick={() => setFilters({ ...filters })}>Try again</Button>} /></Card>
        ) : items.length === 0 ? (
          <Card>
            <EmptyState icon={<Icon.shield size={20} />} title={active ? "No violations match these filters" : "No violations recorded yet"}
              message={active ? "Try a wider date range or clear the filters." : "When a worker is missing required PPE — or a flagged behaviour such as phone use is seen — a snapshot appears here automatically."}
              action={active ? <Button onClick={() => setFilters(EMPTY)}>Clear filters</Button> : undefined} />
          </Card>
        ) : (
          <div className="flex flex-col gap-6">
            {groups.map((g) => {
              const groupIds = g.items.map((x) => x.v.id);
              const groupAll = groupIds.length > 0 && groupIds.every((id) => selected.has(id));
              const groupSome = groupIds.some((id) => selected.has(id));
              const toggleGroup = () => setSelected((s) => { const n = new Set(s); if (groupAll) groupIds.forEach((id) => n.delete(id)); else groupIds.forEach((id) => n.add(id)); return n; });
              return (
              <section key={g.key} aria-labelledby={`day-${g.key}`}>
                <h2 id={`day-${g.key}`} className="sticky top-0 z-10 -mx-3 mb-3 flex items-center gap-2 border-b border-border bg-bg/95 px-3 py-2.5 text-sm font-semibold backdrop-blur sm:top-16 sm:-mx-6 sm:px-6">
                  {canDelete && (
                    <input type="checkbox" checked={groupAll} onChange={toggleGroup}
                      ref={(el) => { if (el) el.indeterminate = groupSome && !groupAll; }}
                      aria-label={`Select all violations from ${dayLabel(g.key)}`} title={`Select all · ${dayLabel(g.key)}`}
                      className="h-4 w-4 cursor-pointer accent-[var(--color-primary)]" />
                  )}
                  {dayLabel(g.key)}
                  <span className="text-xs font-normal text-muted">{g.items.length} shown</span>
                </h2>
                <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                  {g.items.map(({ v }) => (
                    <li key={v.id} className="relative">
                      {canDelete && (
                        <label onClick={(e) => e.stopPropagation()}
                          className={`absolute left-2 top-2 z-10 flex h-8 w-8 cursor-pointer sm:h-6 sm:w-6 items-center justify-center rounded-md shadow-sm ring-1 transition ${selected.has(v.id) ? "bg-primary ring-primary" : "bg-surface/90 ring-border backdrop-blur-sm"}`}
                          title="Select for bulk delete">
                          <input type="checkbox" checked={selected.has(v.id)} onChange={() => toggleSelect(v.id)}
                            aria-label={`Select violation at ${fmtTime(v.timestamp)} from ${v.stream_name}`}
                            className="h-4 w-4 cursor-pointer accent-[var(--color-primary)]" />
                        </label>
                      )}
                      <button type="button" onClick={() => setOpenId(v.id)}
                        className={`group block w-full overflow-hidden rounded-xl border bg-surface text-left shadow-[var(--shadow-card)] transition hover:shadow-md ${selected.has(v.id) ? "border-primary ring-2 ring-primary/50" : "border-border hover:border-border-strong"} ${fresh.has(v.id) ? "animate-flash-new" : ""}`}
                        aria-label={`${v.stream_name}, ${fmtTime(v.timestamp)}, missing ${v.missing.join(", ")}`}>
                        <div className="relative aspect-[4/5] overflow-hidden bg-subtle">
                          {v.thumbnail ? <img src={jpegDataUrl(v.thumbnail)} alt="" loading="lazy" className="h-full w-full object-cover transition-transform group-hover:scale-[1.03]" /> : <Icon.image className="absolute inset-0 m-auto text-muted" size={28} />}
                          <span className="absolute bottom-2 left-2 rounded-md bg-slate-900/75 px-1.5 py-0.5 font-mono text-[11px] font-medium whitespace-nowrap text-white tabular-nums">
                            {fmtTime(v.timestamp)}{(v.duration ?? 0) >= 60 ? ` · ${Math.round((v.duration ?? 0) / 60)} min` : (v.duration ?? 0) >= 1 ? ` · ${Math.round(v.duration ?? 0)} s` : ""}
                          </span>
                          {v.state === "ongoing" && <Badge tone="danger" dot pulse className="absolute right-2 bottom-9 shadow-sm">Ongoing</Badge>}
                          {v.acknowledged_at != null && <Badge tone="success" className="absolute top-2 right-2 shadow-sm"><Icon.check size={12} />Ack</Badge>}
                        </div>
                        <div className="flex flex-col gap-1.5 p-3">
                          <p className="truncate text-[13px] font-semibold">{v.stream_name} <span className="font-normal text-muted">· #{v.track_id}</span></p>
                          <div className="flex flex-wrap gap-1">{v.missing.map((m) => <PpeChip key={m} item={m} status="missing" />)}</div>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
            })}
            <div ref={sentinel} className="flex justify-center py-4">
              {loadingMore ? <span className="text-sm text-muted">Loading more…</span> : cursor !== null ? (
                <Button onClick={loadMore}>Load more</Button>
              ) : (
                <span className="text-xs text-muted">All {items.length} records shown</span>
              )}
            </div>
          </div>
        )}
      </PageBody>

      {openIndex >= 0 && (
        <ViolationModal items={items} index={openIndex} hasMore={cursor !== null}
          onIndex={(i) => setOpenId(itemsRef.current[i]?.id ?? null)}
          onClose={() => setOpenId(null)} onLoadMore={loadMore}
          onChanged={(nv) => setItems((xs) => xs.map((x) => (x.id === nv.id ? { ...x, ...nv, thumbnail: x.thumbnail } : x)))}
          onDeleted={(id) => {
            const xs = itemsRef.current;
            const i = xs.findIndex((x) => x.id === id);
            const nextItem = xs[i + 1] ?? xs[i - 1];
            setItems(xs.filter((x) => x.id !== id));
            setTotal((t) => Math.max(0, t - 1));
            setOpenId(nextItem ? nextItem.id : null);
          }} />
      )}

      <ConfirmModal open={confirmBulk} danger busy={bulkBusy}
        title={`Delete ${selected.size} violation${selected.size === 1 ? "" : "s"}?`}
        confirmLabel={`Delete ${selected.size}`}
        message="The selected records and their snapshots are removed permanently. This can't be undone."
        onConfirm={bulkDelete} onCancel={() => setConfirmBulk(false)} />
    </>
  );
}
