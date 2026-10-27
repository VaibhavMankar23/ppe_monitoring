import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Page } from "../components/layout/Shell";
import { Button, cx, Empty, Field, Icon, Input, Notice, Panel, Select, Skeleton } from "../components/ui";
import { api } from "../lib/api";
import { dateRangeToEpoch, fmtDateTime, fmtInt } from "../lib/format";
import type { AuditEntry } from "../types";

const PAGE_SIZE = 50;
const DEBOUNCE_MS = 300;

const ACTION_LABEL: Record<string, string> = {
  "auth.login": "Signed in",
  "auth.login_failed": "Failed to sign in",
  "auth.logout": "Signed out",
  "auth.password_change": "Changed their own password",
  "user.seed": "Created the default account",
  "user.create": "Added a user",
  "user.update": "Changed a user's role",
  "user.activate": "Activated a user",
  "user.deactivate": "Deactivated a user",
  "user.reset_password": "Reset a user's password",
  "user.delete": "Deleted a user",
  "config.update": "Changed settings",
  "config.reset": "Reset settings to defaults",
  "config.restore": "Restored a settings backup",
  "violation.acknowledge": "Acknowledged a violation",
  "violation.review": "Reviewed a violation",
  "violation.delete": "Deleted a violation",
  "violations.export": "Exported violations",
  "violations.export_dataset": "Exported a review dataset",
  "stream.start": "Started a camera",
  "stream.stop": "Stopped a camera",
};
/** Readable phrase for an action id; unknown ids fall back to their words ("thing.do_it" → "Thing: do it"). */
function actionLabel(action: string): string {
  if (ACTION_LABEL[action]) return ACTION_LABEL[action];
  const [group, ...rest] = action.split(".");
  const words = rest.join(" ").replace(/_/g, " ");
  const head = group.charAt(0).toUpperCase() + group.slice(1).replace(/_/g, " ");
  return words ? `${head}: ${words}` : head;
}

// a filter value ending in "." matches the whole group on the server
const GROUPS: { value: string; label: string }[] = [
  { value: "auth.", label: "All sign-in activity" },
  { value: "user.", label: "All user management" },
  { value: "config.", label: "All settings changes" },
  { value: "stream.", label: "All camera starts and stops" },
];

const ROLE_LABEL: Record<string, string> = { admin: "Admin", super_admin: "Super Admin" };
const message = (e: unknown) => (e instanceof Error ? e.message : "The request failed.");

// ------------------------------------------------------------------ before / after diff
const UNSET = "<unset>"; // the server's marker for "this field did not exist"
const MAX_DEPTH = 3;
type Flat = Map<string, unknown>;
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Flatten nested objects to dotted paths. Missing values (null, the unset marker) are left out. */
function flatten(value: unknown, prefix: string, depth: number, out: Flat): Flat {
  if (value === null || value === undefined || value === UNSET) return out;
  if (isPlainObject(value) && depth < MAX_DEPTH && Object.keys(value).length > 0) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, depth + 1, out);
  } else out.set(prefix, value);
  return out;
}

/** Scalars as plain text; lists and anything nested deeper than the flattening goes as compact JSON. */
const show = (v: unknown): string => (typeof v === "string" ? (v === "" ? '""' : v) : JSON.stringify(v));

interface Change { key: string; before?: unknown; after?: unknown; has: "both" | "before" | "after" }
function changesOf(e: AuditEntry): Change[] {
  const b = flatten(e.before ?? {}, "", 0, new Map());
  const a = flatten(e.after ?? {}, "", 0, new Map());
  const out: Change[] = [];
  for (const key of new Set([...b.keys(), ...a.keys()])) {
    const hb = b.has(key), ha = a.has(key);
    if (hb && ha && JSON.stringify(b.get(key)) === JSON.stringify(a.get(key))) continue;
    out.push({ key, before: b.get(key), after: a.get(key), has: hb && ha ? "both" : hb ? "before" : "after" });
  }
  return out.sort((x, y) => x.key.localeCompare(y.key));
}

const VALUE = "rounded px-1 py-px break-all";

function Diff({ entry }: { entry: AuditEntry }) {
  const changes = useMemo(() => changesOf(entry), [entry]);
  if (!changes.length) return <p className="text-xs text-ink-3">No field changes were recorded for this entry.</p>;
  return (
    <ul className="num grid gap-1 text-xs leading-relaxed" aria-label="Changed fields">
      {changes.map((c) => (
        <li key={c.key} className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
          <span className="font-medium text-ink">{c.key}:</span>
          {c.has !== "after" && (
            <span className={cx(VALUE, "bg-bad-soft text-ink")}><span className="sr-only">{c.has === "both" ? "before " : "removed "}</span>{show(c.before)}</span>
          )}
          {c.has === "both" && <span className="text-ink-3" aria-hidden="true">→</span>}
          {c.has !== "before" && (
            <span className={cx(VALUE, "bg-ok-soft text-ink")}><span className="sr-only">{c.has === "both" ? "after " : "added "}</span>{show(c.after)}</span>
          )}
          {c.has !== "both" && <span className="font-sans text-ink-3">{c.has === "after" ? "added" : "removed"}</span>}
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ page
interface Filters { action: string; actor: string; from: string; to: string }
const NO_FILTERS: Filters = { action: "", actor: "", from: "", to: "" };

export function AuditPage() {
  const [actions, setActions] = useState<string[]>([]);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [actor, setActor] = useState(""); // debounced copy of filters.actor
  const [items, setItems] = useState<AuditEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const [attempt, setAttempt] = useState(0);
  const req = useRef(0);

  useEffect(() => { api.audit.actions().then(setActions).catch(() => { /* the filter still offers the groups */ }); }, []);

  useEffect(() => {
    const t = window.setTimeout(() => setActor(filters.actor.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [filters.actor]);

  const rangeInvalid = !!filters.from && !!filters.to && filters.from > filters.to;
  const query = useMemo(() => ({
    action: filters.action || undefined,
    actor: actor || undefined,
    ...dateRangeToEpoch(filters.from, filters.to),
  }), [filters.action, filters.from, filters.to, actor]);

  useEffect(() => {
    if (rangeInvalid) return;
    const id = ++req.current;
    setLoading(true);
    setError(null);
    setMoreError(null);
    api.audit.list({ ...query, limit: PAGE_SIZE })
      .then((p) => {
        if (id !== req.current) return;
        setItems(p.items);
        setTotal(p.total);
        setCursor(p.next_before_id);
        setOpen(new Set());
      })
      .catch((e) => { if (id === req.current) setError(message(e)); })
      .finally(() => { if (id === req.current) setLoading(false); });
  }, [query, rangeInvalid, attempt]);

  const loadMore = useCallback(async () => {
    if (cursor === null || moreBusy) return;
    const id = req.current;
    setMoreBusy(true);
    setMoreError(null);
    try {
      const p = await api.audit.list({ ...query, limit: PAGE_SIZE, before_id: cursor });
      if (id !== req.current) return; // the filters changed meanwhile
      setItems((xs) => [...(xs ?? []), ...p.items]);
      setTotal(p.total);
      setCursor(p.next_before_id);
    } catch (e) {
      if (id === req.current) setMoreError(message(e));
    } finally {
      setMoreBusy(false);
    }
  }, [cursor, moreBusy, query]);

  const toggle = (id: number) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const filtered = !!(filters.action || filters.actor || filters.from || filters.to);
  const clear = () => { setFilters(NO_FILTERS); setActor(""); };
  const retry = <Button size="sm" icon="refresh" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>;
  // an action stored in the filter may be one the server no longer lists
  const actionOptions = filters.action && !filters.action.endsWith(".") && !actions.includes(filters.action) ? [filters.action, ...actions] : actions;

  return (
    <Page title="Audit trail" description="Who changed what, and when. Entries cannot be edited or deleted.">
      <Panel>
        <div className="grid grid-cols-1 items-end gap-3 border-b border-line p-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto_auto_auto]">
          <Field label="Action">
            {(id) => (
              <Select id={id} value={filters.action} onChange={set("action")}>
                <option value="">All actions</option>
                <optgroup label="Groups">
                  {GROUPS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
                </optgroup>
                {actionOptions.length > 0 && (
                  <optgroup label="Single action">
                    {actionOptions.map((a) => <option key={a} value={a}>{actionLabel(a)}</option>)}
                  </optgroup>
                )}
              </Select>
            )}
          </Field>
          <Field label="User">
            {(id) => <Input id={id} type="search" placeholder="Exact username" value={filters.actor} onChange={set("actor")} autoComplete="off" autoCapitalize="none" spellCheck={false} />}
          </Field>
          <Field label="From" error={rangeInvalid ? "After the To date" : null}>
            {(id) => <Input id={id} type="date" value={filters.from} max={filters.to || undefined} onChange={set("from")} invalid={rangeInvalid} className="num" />}
          </Field>
          <Field label="To">
            {(id) => <Input id={id} type="date" value={filters.to} min={filters.from || undefined} onChange={set("to")} className="num" />}
          </Field>
          <Button variant="ghost" icon="x" disabled={!filtered} onClick={clear}>Clear filters</Button>
        </div>

        {error && !items ? (
          <div className="p-4"><Notice tone="bad" title="The audit log could not be loaded" action={retry}>{error}</Notice></div>
        ) : !items ? (
          <div className="grid gap-2 p-4" role="status" aria-label="Loading the audit log">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-8" />)}</div>
        ) : (
          <>
            {error && <div className="border-b border-line p-4"><Notice tone="bad" title="The audit log could not be refreshed" action={retry}>{error}</Notice></div>}
            <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2 text-xs text-ink-3" aria-live="polite">
              <span>
                <span className="num">{fmtInt(items.length)}</span> of <span className="num">{fmtInt(total)}</span> {total === 1 ? "entry" : "entries"}
                {filtered ? " matching the filters" : ""}, newest first
              </span>
              {loading && <span>Updating…</span>}
            </div>
            {items.length === 0 ? (
              <Empty icon="log" title={filtered ? "No entries match these filters" : "Nothing has been recorded yet"}
                action={filtered ? <Button onClick={clear}>Clear filters</Button> : undefined}>
                {filtered
                  ? "Widen the date range or clear a filter. The user filter needs the exact username."
                  : "Sign-ins, settings changes, user changes and violation reviews will be listed here as they happen."}
              </Empty>
            ) : (
              <div className={cx("scroll-thin overflow-x-auto", loading && "opacity-60")}>
                <table className="table min-w-[860px]">
                  <thead>
                    <tr>
                      <th className="w-8"><span className="sr-only">Details</span></th>
                      <th>Time</th><th>User</th><th>Action</th><th>Target</th><th>IP address</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((e) => {
                      const isOpen = open.has(e.id);
                      return (
                        <Fragment key={e.id}>
                          <tr className="cursor-pointer" onClick={() => toggle(e.id)}>
                            <td className="pr-0">
                              <button type="button" aria-expanded={isOpen} aria-label={`${isOpen ? "Hide" : "Show"} details of entry ${e.id}`}
                                className="flex size-6 items-center justify-center rounded text-ink-3 hover:bg-sunken hover:text-ink"
                                onClick={(ev) => { ev.stopPropagation(); toggle(e.id); }}>
                                <Icon name="chevronRight" size={14} className={cx("transition-transform", isOpen && "rotate-90")} />
                              </button>
                            </td>
                            <td className="num whitespace-nowrap">{fmtDateTime(e.timestamp)}</td>
                            <td className="whitespace-nowrap">
                              <span className="font-medium text-ink">{e.actor || "unknown"}</span>
                              {e.actor_role && <span className="ml-1.5 text-xs text-ink-3">{ROLE_LABEL[e.actor_role] ?? e.actor_role}</span>}
                            </td>
                            <td>
                              <div className={cx("whitespace-nowrap", e.action === "auth.login_failed" ? "text-bad" : "text-ink")}>{actionLabel(e.action)}</div>
                              <div className="num text-[11px] text-ink-3">{e.action}</div>
                            </td>
                            <td>
                              {e.target
                                ? <><span className="text-ink-3">{e.target_type} </span><span className="num text-ink">{e.target}</span></>
                                : <span className="text-ink-3">–</span>}
                            </td>
                            <td className="num whitespace-nowrap text-ink-2">{e.ip || "–"}</td>
                          </tr>
                          {isOpen && (
                            <tr>
                              <td className="bg-sunken/50" />
                              <td colSpan={5} className="bg-sunken/50">
                                <div className="grid max-w-4xl gap-2 py-1">
                                  {e.detail && <p className="text-[13px] text-ink-2">{e.detail}</p>}
                                  {(e.before || e.after) ? <Diff entry={e} />
                                    : !e.detail && <p className="text-xs text-ink-3">Nothing more was recorded for this entry.</p>}
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {items.length > 0 && (
              <div className="grid justify-items-center gap-2 border-t border-line px-4 py-3">
                {moreError && <Notice tone="bad" className="w-full" title="More entries could not be loaded">{moreError}</Notice>}
                {cursor !== null
                  ? <Button loading={moreBusy} onClick={() => void loadMore()}>{moreError ? "Retry loading more" : "Load more"}</Button>
                  : <span className="text-xs text-ink-3">End of the log for these filters.</span>}
              </div>
            )}
          </>
        )}
      </Panel>
    </Page>
  );
}
