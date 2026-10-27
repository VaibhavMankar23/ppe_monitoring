import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, jpegDataUrl } from "../../lib/api";
import { fmtTime, violationLabel } from "../../lib/format";
import { href, navigate, navigateWith, ROUTE_PERMISSION, type Route } from "../../lib/router";
import { useTheme } from "../../lib/theme";
import { useAuth } from "../../state/auth";
import { useMonitor } from "../../state/monitor";
import type { Violation } from "../../types";
import { passwordAcceptable, PasswordField, PolicyChecklist } from "../admin/PasswordPolicy";
import { Button, cx, Dialog, Field, Icon, Notice, useToast, type IconName } from "../ui";

type Page = Exclude<Route, "login">;

/** v3 information architecture: five workspaces, ordered by how often each is used. */
const WORKSPACES: { key: string; label: string; icon: IconName; routes: { route: Page; label: string; icon: IconName }[] }[] = [
  { key: "command", label: "Command", icon: "overview", routes: [{ route: "overview", label: "Command", icon: "overview" }] },
  { key: "live", label: "Live", icon: "monitoring", routes: [{ route: "monitoring", label: "Live", icon: "monitoring" }] },
  { key: "review", label: "Review", icon: "incidents", routes: [{ route: "incidents", label: "Review", icon: "incidents" }] },
  { key: "insights", label: "Insights", icon: "reports", routes: [{ route: "reports", label: "Insights", icon: "reports" }] },
  { key: "setup", label: "Setup", icon: "gear", routes: [
    { route: "devices", label: "Cameras & zones", icon: "devices" },
    { route: "settings", label: "Detection", icon: "sliders" },
    { route: "system", label: "System health", icon: "pulse" },
    { route: "users", label: "People", icon: "users" },
    { route: "audit", label: "Audit trail", icon: "log" },
  ] },
];
const ITEMS = WORKSPACES.flatMap((w) => w.routes.map((r) => ({ ...r, group: w.label })));
const WORKSPACE_OF = Object.fromEntries(WORKSPACES.flatMap((w) => w.routes.map((r) => [r.route, w]))) as Record<Page, (typeof WORKSPACES)[number]>;
const isAdmin = (r: Page) => WORKSPACE_OF[r]?.key === "setup";

const RouteCtx = createContext<Page>("overview");

// ------------------------------------------------------------------ shared data

/** Number of incidents nobody has reviewed yet (the Incidents badge). Refreshed on new events and every 30 s. */
function useOpenIncidents(enabled: boolean): number | null {
  const { onViolation } = useMonitor();
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () => api.violations.list({ review: "unreviewed", limit: 1 }).then((p) => alive && setN(p.total)).catch(() => {});
    load();
    const off = onViolation(() => setN((x) => (x === null ? x : x + 1)));
    const t = window.setInterval(load, 30_000);
    return () => { alive = false; off(); window.clearInterval(t); };
  }, [enabled, onViolation]);
  return n;
}

/** Close a popover on outside click / Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open, close]);
  return ref;
}

const NAV_ICON = "relative grid size-9 place-items-center rounded-xl text-ink-2 transition-colors hover:bg-sunken hover:text-ink";
const MENU = "animate-rise absolute top-[calc(100%+12px)] right-0 z-[60] overflow-hidden rounded-2xl border border-line bg-surface text-ink shadow-pop";

// ------------------------------------------------------------------ notifications

function Bell() {
  const { onViolation } = useMonitor();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Violation[]>([]);
  const [unread, setUnread] = useState(0);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);

  useEffect(() => onViolation((v) => {
    setItems((xs) => [v, ...xs.filter((x) => x.id !== v.id)].slice(0, 20));
    setUnread((n) => n + 1);
  }), [onViolation]);

  return (
    <div ref={ref} className="relative">
      <button type="button" className={NAV_ICON} aria-label={unread ? `Notifications, ${unread} new` : "Notifications"} aria-expanded={open}
        onClick={() => { setOpen((o) => !o); setUnread(0); }}>
        <Icon name="bell" size={18} />
        {unread > 0 && <span className="absolute top-[7px] right-2 size-2 rounded-full border-2 border-surface bg-bad" />}
      </button>
      {open && (
        <div className={cx(MENU, "w-[min(360px,calc(100vw-24px))]")}>
          <div className="flex items-center gap-2 border-b border-line px-3.5 py-3">
            <b className="text-sm font-semibold">Notifications</b>
            <a href={href("incidents")} onClick={close} className="ml-auto text-[13px] font-medium text-accent hover:underline">Open incidents</a>
          </div>
          {items.length === 0 ? (
            <div className="px-4 py-8 text-center text-[13px] text-ink-3">No new incidents since you signed in. New ones appear here as they are raised.</div>
          ) : (
            <div className="scroll-thin max-h-[400px] overflow-y-auto">
              {items.map((v) => (
                <button key={v.id} type="button" onClick={() => { close(); navigateWith("incidents", { id: v.id }); }}
                  className="grid w-full grid-cols-[auto_minmax(0,1fr)] gap-2.5 border-t border-line px-3.5 py-3 text-left first:border-t-0 hover:bg-surface-2">
                  <img src={jpegDataUrl(v.thumbnail)} alt="" className="size-10 rounded-md bg-stage object-cover" />
                  <span className="min-w-0">
                    <span className="block truncate text-[13.5px] font-semibold">{v.missing.map(violationLabel).join(", ")}</span>
                    <span className="block truncate text-[12.5px] text-ink-3">{v.stream_name} · <span className="num">{fmtTime(v.timestamp)}</span></span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ theme

function ThemeButton() {
  const [pref, setPref] = useTheme();
  const dark = pref === "dark";
  return (
    <button type="button" className={NAV_ICON} onClick={() => setPref(dark ? "light" : "dark")}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"} title={dark ? "Light theme" : "Dark theme"}>
      <Icon name={dark ? "sun" : "moon"} size={18} />
    </button>
  );
}

// ------------------------------------------------------------------ account

function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, changePassword } = useAuth();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const username = user?.username ?? "";
  const differs = next.length > 0 && next !== current;

  useEffect(() => { if (open) { setCurrent(""); setNext(""); setError(null); } }, [open]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    const problem = !current ? "Enter your current password."
      : !passwordAcceptable(next, username) ? "The new password does not meet the requirements."
      : !differs ? "The new password must be different from the current one." : null;
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next);
      toast({ tone: "success", title: "Password updated", message: "Your other sessions were signed out." });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The password could not be changed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Change password" width={460}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void submit()}>Update password</Button></>}>
      <form className="grid gap-4" onSubmit={submit} noValidate>
        <p className="text-[13.5px] text-ink-3">Your other sessions are signed out when you save.</p>
        {error && <Notice tone="bad">{error}</Notice>}
        <input type="text" name="username" value={username} autoComplete="username" readOnly hidden />
        <Field label="Current password">{(id) => <PasswordField id={id} value={current} onChange={setCurrent} autoComplete="current-password" autoFocus />}</Field>
        <div>
          <Field label="New password">{(id) => <PasswordField id={id} value={next} onChange={setNext} autoComplete="new-password" />}</Field>
          <PolicyChecklist className="mt-2" password={next} username={username}
            extra={[{ id: "differs", ok: differs, label: "Different from the current password" }]} />
        </div>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}


const initials = (name: string) => {
  const parts = name.split(/[._\s-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase();
};

interface Cmd { id: string; group: string; label: string; hint?: string; icon: IconName; run: () => void }

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { can } = useAuth();
  const { streams } = useMonitor();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) { setQ(""); setSel(0); queueMicrotask(() => input.current?.focus()); } }, [open]);

  const all = useMemo<Cmd[]>(() => {
    const pages: Cmd[] = ITEMS.filter((i) => can(ROUTE_PERMISSION[i.route])).map((i) => ({
      id: `p-${i.route}`, group: "Pages", label: i.label, hint: i.group, icon: i.icon, run: () => navigate(i.route),
    }));
    const cams: Cmd[] = can("monitor:view") ? streams.map((s) => ({
      id: `c-${s.id}`, group: "Cameras", label: s.name, hint: s.status === "live" ? "Live" : s.running ? s.status : "Stopped", icon: "camera",
      run: () => navigateWith("monitoring", { camera: s.id }),
    })) : [];
    return [...pages, ...cams];
  }, [can, streams]);

  const term = q.trim().toLowerCase();
  const incidentId = /^#?\d+$/.test(term) && can("violations:view") ? Number(term.replace("#", "")) : null;
  const results: Cmd[] = [
    ...(incidentId !== null ? [{ id: "inc", group: "Incidents", label: `Open incident #${incidentId}`, icon: "incidents" as IconName, run: () => navigateWith("incidents", { id: incidentId }) }] : []),
    ...all.filter((c) => !term || c.label.toLowerCase().includes(term) || c.group.toLowerCase().includes(term)),
  ].slice(0, 30);

  useEffect(() => setSel(0), [q]);
  if (!open) return null;
  const run = (c: Cmd | undefined) => { if (!c) return; onClose(); c.run(); };

  let lastGroup = "";
  return (
    <div className="fixed inset-0 z-[70] grid place-items-start justify-items-center overflow-auto bg-[rgb(16_24_40/0.5)] px-4 pt-[10vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Search" className="animate-rise w-full max-w-[640px] overflow-hidden rounded-2xl border border-line bg-surface shadow-pop">
        <div className="flex items-center gap-2.5 border-b border-line px-[18px] py-3.5 text-ink-3">
          <Icon name="search" size={18} />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search pages, cameras, or an incident number"
            className="w-full bg-transparent text-base text-ink outline-none placeholder:text-ink-4"
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") { e.preventDefault(); setSel((i) => Math.min(results.length - 1, i + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setSel((i) => Math.max(0, i - 1)); }
              else if (e.key === "Enter") { e.preventDefault(); run(results[sel]); }
            }} />
        </div>
        <div className="scroll-thin max-h-[380px] overflow-y-auto p-1.5" role="listbox">
          {results.length === 0 && <div className="px-3 py-8 text-center text-[13px] text-ink-3">Nothing matches “{q}”.</div>}
          {results.map((c, i) => {
            const head = c.group !== lastGroup ? (lastGroup = c.group) : null;
            return (
              <div key={c.id}>
                {head && <div className="eyebrow px-3 pt-2.5 pb-1 text-ink-4">{head}</div>}
                <button type="button" role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => run(c)}
                  className={cx("flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm", i === sel && "bg-accent-soft text-accent")}>
                  <Icon name={c.icon} size={16} />{c.label}
                  {c.hint && <span className="ml-auto text-xs text-ink-3">{c.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function AccountMenu() {
  const { user, logout } = useAuth();
  const { connected, streams, info } = useMonitor();
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  if (!user) return null;
  const live = streams.filter((s) => s.status === "live").length;
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={user.username}
        className="grid size-9 place-items-center rounded-full bg-[linear-gradient(140deg,var(--iris),var(--iris-2))] text-xs font-bold text-white ring-2 ring-surface">
        {initials(user.username)}
      </button>
      {open && (
        <div role="menu" className={cx(MENU, "w-[290px]")}>
          <div className="flex items-center gap-3 px-4 py-3.5">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-[linear-gradient(140deg,var(--iris),var(--iris-2))] text-[13px] font-bold text-white">{initials(user.username)}</span>
            <div className="min-w-0"><b className="block truncate text-sm font-semibold">{user.username}</b><span className="text-[12.5px] text-ink-3">{user.role_label}</span></div>
          </div>
          <div className="mx-3 mb-2 rounded-xl bg-sunken px-3 py-2.5 text-[12.5px] text-ink-2">
            <div className="flex items-center gap-2"><span className={cx("size-[7px] rounded-full", connected ? "live-ping bg-ok" : "bg-bad")} />{connected ? "Connected to the server" : "Server unreachable"}</div>
            <div className="mt-1 text-ink-3">{live} of {streams.length} cameras live{info?.device ? ` · detector on ${info.device}` : ""}</div>
          </div>
          <div className="border-t border-line p-1.5">
            <button type="button" role="menuitem" onClick={() => { close(); setPw(true); }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] hover:bg-sunken"><Icon name="key" size={16} />Change password</button>
            <button type="button" role="menuitem" onClick={() => { close(); void logout(); }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] hover:bg-sunken"><Icon name="logout" size={16} />Sign out</button>
          </div>
        </div>
      )}
      <ChangePasswordDialog open={pw} onClose={() => setPw(false)} />
    </div>
  );
}

// ------------------------------------------------------------------ top navigation

function LiveChip() {
  const { connected, streams } = useMonitor();
  const live = streams.filter((s) => s.status === "live").length;
  const bad = streams.reduce((n, s) => n + s.violations, 0);
  const down = streams.filter((s) => s.running && s.status !== "live").length;
  const tone = !connected ? "bad" : bad ? "bad" : down ? "warn" : "ok";
  const text = !connected ? "Offline" : bad ? `${bad} unsafe now` : down ? `${down} camera${down === 1 ? "" : "s"} down` : "All clear";
  return (
    <a href={href("monitoring")} title={`${live} of ${streams.length} cameras live`}
      className={cx("hidden h-9 items-center gap-2 rounded-full border px-3 text-[12.5px] font-semibold no-underline md:inline-flex",
        tone === "ok" ? "border-ok-line bg-ok-soft text-ok" : tone === "warn" ? "border-warn-line bg-warn-soft text-warn" : "border-bad-line bg-bad-soft text-bad")}>
      <span className={cx("size-[7px] rounded-full bg-current", tone === "ok" && "live-ping")} />
      {text}<span className="font-mono font-medium opacity-70">{live}/{streams.length}</span>
    </a>
  );
}

function TopNav({ route }: { route: Page }) {
  const { can } = useAuth();
  const [search, setSearch] = useState(false);
  const open = useOpenIncidents(can("violations:view"));
  const bar = useRef<HTMLElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setSearch(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty("--topbar-h", `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const current = WORKSPACE_OF[route]?.key;
  const spaces = WORKSPACES.map((w) => ({ ...w, routes: w.routes.filter((r) => can(ROUTE_PERMISSION[r.route])) })).filter((w) => w.routes.length);

  return (
    <header ref={bar} className="no-print sticky top-0 z-30 px-3 pt-3 pb-2 sm:px-5">
      <div className="mx-auto flex max-w-[1560px] flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-[var(--nav-border)] bg-[var(--nav)] px-3 py-2 shadow-pop backdrop-blur-xl backdrop-saturate-150 lg:flex-nowrap">
        <a href={href("overview")} aria-label="Mahindra PPE Compliance home" className="flex shrink-0 items-center gap-2.5 pl-1.5 no-underline">
          <img src="/mahindra-logo.png" alt="Mahindra" className="h-[22px] w-auto dark:hidden" />
          <img src="/mahindra-logo-on-dark.png" alt="Mahindra" className="hidden h-[22px] w-auto dark:block" />
          <span aria-hidden="true" className="h-5 w-px bg-line-strong" />
          <span className="text-[14px] font-bold tracking-tight text-ink">PPE<span className="font-medium text-ink-3"> Compliance</span></span>
        </a>

        <nav aria-label="Workspaces" className="order-3 -mx-1 flex w-full gap-1 overflow-x-auto [scrollbar-width:none] lg:order-none lg:mx-auto lg:w-auto">
          {spaces.map((w) => {
            const active = w.key === current;
            const count = w.key === "review" ? open : null;
            return (
              <a key={w.key} href={href(w.routes[0].route)} aria-current={active ? "page" : undefined}
                className={cx("flex h-9 items-center gap-2 rounded-xl px-3.5 text-[13.5px] font-semibold whitespace-nowrap no-underline transition-colors",
                  active ? "bg-ink text-canvas" : "text-ink-2 hover:bg-sunken hover:text-ink")}>
                <Icon name={w.icon} size={17} />{w.label}
                {!!count && (
                  <span title={`${count.toLocaleString("en-IN")} incidents not reviewed yet`}
                    className={cx("rounded-full px-1.5 font-mono text-[11px] leading-[18px] font-semibold", active ? "bg-bad text-white" : "bg-bad-soft text-bad")}>
                    {count >= 10_000 ? `${Math.floor(count / 1000)}k` : count >= 1000 ? `${(count / 1000).toFixed(1)}k` : count}
                  </span>
                )}
              </a>
            );
          })}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-1 lg:ml-0">
          <LiveChip />
          <button type="button" onClick={() => setSearch(true)} className={NAV_ICON} aria-label="Search (Ctrl K)" title="Search (Ctrl K)"><Icon name="search" size={18} /></button>
          <Bell />
          <ThemeButton />
          <span className="mx-1 h-6 w-px bg-line" aria-hidden="true" />
          <AccountMenu />
        </div>
      </div>
      <CommandPalette open={search} onClose={() => setSearch(false)} />
    </header>
  );
}

/** App frame (v3): floating glass navigation above the page. */
export function Shell({ route, children }: { route: Page; children: ReactNode }) {
  return (
    <RouteCtx.Provider value={route}>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:shadow-pop">
        Skip to content
      </a>
      <div className="min-h-dvh">
        <TopNav route={route} />
        <main id="main" tabIndex={-1} className="outline-none">{children}</main>
      </div>
    </RouteCtx.Provider>
  );
}

function SetupTabs({ route }: { route: Page }) {
  const { can } = useAuth();
  const items = WORKSPACES.find((w) => w.key === "setup")!.routes.filter((r) => can(ROUTE_PERMISSION[r.route]));
  return (
    <nav aria-label="Setup" className="no-print mb-6 flex gap-1 overflow-x-auto rounded-2xl border border-line bg-surface p-1 shadow-[var(--sh-xs)] [scrollbar-width:none] sm:inline-flex">
      {items.map((r) => (
        <a key={r.route} href={href(r.route)} aria-current={r.route === route ? "page" : undefined}
          className={cx("flex h-9 items-center gap-2 rounded-xl px-3.5 text-[13.5px] font-semibold whitespace-nowrap no-underline",
            r.route === route ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-sunken hover:text-ink")}>
          <Icon name={r.icon} size={16} />{r.label}
        </a>
      ))}
    </nav>
  );
}

/**
 * Standard page frame (v3): workspace eyebrow, a large title, one-line description and actions,
 * optional tabs and toolbar, then the content. Setup pages get the Setup tab strip.
 */
export function Page({ title, description, actions, toolbar, tabs, children, flush, wide }:
  { title: string; description?: ReactNode; actions?: ReactNode; toolbar?: ReactNode; tabs?: ReactNode; children: ReactNode; flush?: boolean; wide?: boolean }) {
  const route = useContext(RouteCtx);
  const max = wide ? "max-w-[1760px]" : "max-w-[1560px]";
  const ws = WORKSPACE_OF[route];
  return (
    <div className="flex min-h-[calc(100dvh-var(--topbar-h))] flex-col">
      <div className={cx("mx-auto w-full px-4 pt-5 sm:px-7", max)}>
        {isAdmin(route) && <SetupTabs route={route} />}
        <div className="mb-7 flex flex-wrap items-end gap-4">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold tracking-[0.12em] text-accent uppercase">
              <Icon name={ws?.icon ?? "overview"} size={14} />{ws?.label ?? ""}
            </div>
            <h1 className="text-[26px] leading-[1.1] font-bold tracking-[-0.03em] sm:text-[34px]">{title}</h1>
            {description && <p className="mt-2 max-w-3xl text-[14.5px] text-ink-3">{description}</p>}
          </div>
          {actions && <div className="no-print ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
        {tabs && <div className="no-print mb-5 border-b border-line">{tabs}</div>}
        {toolbar && <div className="no-print mb-5 flex flex-wrap items-center gap-2.5">{toolbar}</div>}
      </div>
      <div className={cx("mx-auto min-h-0 w-full flex-1", max, !flush && "px-4 pb-16 sm:px-7")}>
        {children}
      </div>
    </div>
  );
}

export { isAdmin };
