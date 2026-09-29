import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageBody } from "../components/layout/PageBody";
import { Topbar } from "../components/layout/Topbar";
import { Badge, Button, Card, EmptyState, Field, Icon, Input, Select, Skeleton, type Tone } from "../components/ui";
import { api } from "../lib/api";
import { dateRangeToEpoch, fmtDateTime } from "../lib/format";
import type { AuditEntry } from "../types";

const PAGE = 50;

const ACTION_LABEL: Record<string, string> = {
  "auth.login": "Signed in",
  "auth.login_failed": "Failed sign-in",
  "auth.logout": "Signed out",
  "auth.password_change": "Changed own password",
  "user.seed": "Default account seeded",
  "user.create": "Created user",
  "user.update": "Changed user",
  "user.activate": "Reactivated user",
  "user.deactivate": "Deactivated user",
  "user.reset_password": "Reset password",
  "user.delete": "Deleted user",
  "config.update": "Changed config",
  "config.reset": "Reset config to defaults",
  "config.restore": "Restored config backup",
  "violation.acknowledge": "Acknowledged violation",
  "violation.delete": "Deleted violation",
  "violations.export": "Exported violations",
  "stream.start": "Started camera",
  "stream.stop": "Stopped camera",
};

function tone(action: string): Tone {
  if (action === "auth.login_failed" || action.endsWith(".delete") || action === "user.deactivate") return "danger";
  if (action.startsWith("config.") || action.startsWith("user.")) return "warning";
  if (action.startsWith("auth.")) return "neutral";
  return "primary";
}

const show = (v: unknown) => (v === "<unset>" ? <span className="italic text-muted">not set</span>
  : typeof v === "string" ? v : <span className="font-mono">{JSON.stringify(v)}</span>);

/** before/after as a per-field table (config changes are stored as a flat field diff). */
function Changes({ e }: { e: AuditEntry }) {
  const keys = [...new Set([...Object.keys(e.before ?? {}), ...Object.keys(e.after ?? {})])];
  if (!keys.length) return <p className="text-xs text-muted">No field-level changes recorded.</p>;
  return (
    <table className="w-full text-left text-xs">
      <thead className="text-muted"><tr><th className="py-1 pr-4 font-medium">Field</th><th className="py-1 pr-4 font-medium">Before</th><th className="py-1 font-medium">After</th></tr></thead>
      <tbody className="divide-y divide-border">
        {keys.map((k) => (
          <tr key={k} className="align-top">
            <td className="py-1.5 pr-4 font-mono text-text">{k}</td>
            <td className="max-w-[340px] break-words py-1.5 pr-4 text-danger">{show(e.before?.[k] ?? "<unset>")}</td>
            <td className="max-w-[340px] break-words py-1.5 text-success-text">{show(e.after?.[k] ?? "<unset>")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AuditPage() {
  const [actions, setActions] = useState<string[]>([]);
  const [filters, setFilters] = useState({ action: "", actor: "", from: "", to: "" });
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const req = useRef(0);
  const query = useMemo(() => ({ action: filters.action || undefined, actor: filters.actor.trim() || undefined, ...dateRangeToEpoch(filters.from, filters.to) }), [filters]);

  useEffect(() => { api.audit.actions().then(setActions).catch(() => {}); }, []);
  useEffect(() => {
    const id = ++req.current;
    setLoading(true);
    setError(null);
    const t = window.setTimeout(() => {
      api.audit.list({ ...query, limit: PAGE })
        .then((p) => { if (id === req.current) { setItems(p.items); setTotal(p.total); setCursor(p.next_before_id); } })
        .catch((e) => id === req.current && setError((e as Error).message))
        .finally(() => id === req.current && setLoading(false));
    }, 250); // debounce the actor text box
    return () => window.clearTimeout(t);
  }, [query]);

  const loadMore = useCallback(async () => {
    if (cursor === null) return;
    setMore(true);
    try {
      const p = await api.audit.list({ ...query, limit: PAGE, before_id: cursor });
      setItems((xs) => [...xs, ...p.items]);
      setCursor(p.next_before_id);
    } finally { setMore(false); }
  }, [cursor, query]);

  const toggle = (id: number) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const set = (k: keyof typeof filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const active = filters.action || filters.actor || filters.from || filters.to;

  return (
    <>
      <Topbar title="Audit log" subtitle={loading ? "Loading…" : `${total} entr${total === 1 ? "y" : "ies"} · who changed what, and when`} />
      <PageBody>
        <Card className="mb-6 p-4">
          <div className="grid grid-cols-2 items-end gap-3 xl:grid-cols-[repeat(4,minmax(0,1fr))_auto]">
            <Field id="a-action" label="Action">
              <Select id="a-action" value={filters.action} onChange={set("action")}>
                <option value="">All actions</option>
                <option value="config.">Config changes (all)</option>
                <option value="user.">User management (all)</option>
                <option value="auth.">Sign-ins (all)</option>
                {actions.map((a) => <option key={a} value={a}>{ACTION_LABEL[a] ?? a}</option>)}
              </Select>
            </Field>
            <Field id="a-actor" label="User"><Input id="a-actor" placeholder="username" value={filters.actor} onChange={set("actor")} /></Field>
            <Field id="a-from" label="From"><Input id="a-from" type="date" value={filters.from} onChange={set("from")} /></Field>
            <Field id="a-to" label="To"><Input id="a-to" type="date" value={filters.to} onChange={set("to")} /></Field>
            <Button variant="ghost" icon={<Icon.close size={15} />} disabled={!active} onClick={() => setFilters({ action: "", actor: "", from: "", to: "" })}>Clear filters</Button>
          </div>
        </Card>
        <Card>
          {loading ? (
            <div className="flex flex-col gap-3 p-5">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-9" />)}</div>
          ) : error ? (
            <EmptyState icon={<Icon.alert size={20} />} title="Couldn't load the audit log" message={error} />
          ) : items.length === 0 ? (
            <EmptyState icon={<Icon.clipboard size={20} />} title={active ? "No entries match these filters" : "No entries yet"} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-[13px]">
                <thead className="bg-subtle text-xs text-muted uppercase">
                  <tr>
                    <th className="w-8 px-3 py-2.5" />
                    <th className="px-3 py-2.5 font-medium">Time</th>
                    <th className="px-3 py-2.5 font-medium">User</th>
                    <th className="px-3 py-2.5 font-medium">Action</th>
                    <th className="px-3 py-2.5 font-medium">Target</th>
                    <th className="px-5 py-2.5 font-medium">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {items.map((e) => {
                    const expandable = !!(e.before || e.after);
                    const isOpen = open.has(e.id);
                    return (
                      <Fragment key={e.id}>
                        <tr className={expandable ? "cursor-pointer hover:bg-subtle/60" : ""} onClick={() => expandable && toggle(e.id)}>
                          <td className="px-3 py-2.5 text-muted">
                            {expandable && (
                              <button type="button" aria-expanded={isOpen} aria-label={isOpen ? "Hide changes" : "Show changes"} onClick={(ev) => { ev.stopPropagation(); toggle(e.id); }}>
                                <Icon.chevronRight size={14} className={`transition-transform ${isOpen ? "rotate-90" : ""}`} />
                              </button>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{fmtDateTime(e.timestamp)}</td>
                          <td className="px-3 py-2.5"><span className="font-medium">{e.actor}</span>{e.actor_role && <span className="ml-1 text-xs text-muted">({e.actor_role === "super_admin" ? "Super Admin" : "Admin"})</span>}</td>
                          <td className="px-3 py-2.5"><Badge tone={tone(e.action)}>{ACTION_LABEL[e.action] ?? e.action}</Badge></td>
                          <td className="px-3 py-2.5">{e.target_type && <span className="text-muted">{e.target_type} </span>}<span className="font-medium">{e.target}</span></td>
                          <td className="px-5 py-2.5 text-muted">{e.detail}{e.ip && <span className="ml-2 font-mono text-xs">{e.ip}</span>}</td>
                        </tr>
                        {isOpen && <tr className="bg-subtle/40"><td /><td colSpan={5} className="px-3 py-3"><Changes e={e} /></td></tr>}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              <div className="flex justify-center border-t border-border py-3">
                {cursor !== null ? <Button loading={more} onClick={loadMore}>Load more</Button> : <span className="text-xs text-muted">All {items.length} entries shown</span>}
              </div>
            </div>
          )}
        </Card>
      </PageBody>
    </>
  );
}
