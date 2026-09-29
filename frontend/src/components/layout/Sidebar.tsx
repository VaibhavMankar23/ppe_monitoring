import { useEffect, useRef, useState, type ReactNode } from "react";
import { href, ROUTE_PERMISSION, type Route } from "../../lib/router";
import { ChangePasswordModal } from "../../pages/ChangePasswordPage";
import { BrandMark } from "../../pages/LoginPage";
import { useAuth } from "../../state/auth";
import { useMonitor } from "../../state/monitor";
import { Badge, Icon } from "../ui";

type NavRoute = Exclude<Route, "login">;
type NavEntry = { route: NavRoute; label: string; icon: ReactNode };
// Grouped by job: Monitor (day-to-day safety), Manage (setup & health), Administration (governance).
const GROUPS: { label: string; items: NavEntry[] }[] = [
  { label: "Monitor", items: [
    { route: "dashboard", label: "Dashboard", icon: <Icon.dashboard size={18} /> },
    { route: "violations", label: "Violations", icon: <Icon.alert size={18} /> },
    { route: "analytics", label: "Analytics", icon: <Icon.chart size={18} /> },
  ] },
  { label: "Manage", items: [
    { route: "system", label: "System health", icon: <Icon.pulse size={18} /> },
    { route: "config", label: "Configuration", icon: <Icon.settings size={18} /> },
    { route: "add-camera", label: "Add camera", icon: <Icon.camera size={18} /> },
  ] },
  { label: "Administration", items: [
    { route: "users", label: "Users", icon: <Icon.users size={18} /> },
    { route: "audit", label: "Audit log", icon: <Icon.clipboard size={18} /> },
  ] },
];

function NavItem({ route, label, icon, active, badge }: { route: NavRoute; label: string; icon: ReactNode; active: boolean; badge?: number }) {
  return (
    <a href={href(route)} aria-current={active ? "page" : undefined} title={label}
      className={`relative flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors ${
        active ? "bg-primary-soft text-primary" : "text-muted hover:bg-subtle hover:text-text"}`}>
      {active && <span className="absolute top-2 bottom-2 left-0 w-[3px] rounded-r bg-accent" aria-hidden />}
      <span className="shrink-0">{icon}</span>
      <span className="hidden flex-1 lg:inline">{label}</span>
      {!!badge && badge > 0 && (
        <span className="absolute -top-1 -right-1 min-w-5 rounded-full bg-danger px-1 text-center text-[10px] leading-4 ring-2 ring-surface font-semibold text-white tabular-nums lg:static lg:px-1.5 lg:text-[11px] lg:leading-5 lg:ring-0">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </a>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", close); };
  }, [open]);
  if (!user) return null;
  const initials = user.username.slice(0, 2).toUpperCase();
  return (
    <div ref={ref} className="relative border-t border-border p-2.5">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}
        title={`${user.username} (${user.role_label})`}
        className="flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left hover:bg-subtle">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-subtle text-xs font-semibold text-text ring-1 ring-border">{initials}</span>
        <span className="hidden min-w-0 flex-1 lg:block">
          <span className="block truncate text-sm font-medium">{user.username}</span>
          <span className="block truncate text-xs text-muted">{user.role_label}</span>
        </span>
      </button>
      {open && (
        <div role="menu" className="absolute bottom-full left-2.5 z-40 mb-1 w-56 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-[var(--shadow-pop)]">
          <div className="border-b border-border px-3 py-2">
            <p className="truncate text-sm font-semibold">{user.username}</p>
            <Badge tone={user.role === "super_admin" ? "primary" : "neutral"} className="mt-1">{user.role_label}</Badge>
          </div>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); setPwOpen(true); }}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-subtle"><Icon.key size={15} /> Change password</button>
          <button type="button" role="menuitem" onClick={() => void logout()}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-danger hover:bg-danger-soft"><Icon.logout size={15} /> Sign out</button>
        </div>
      )}
      <ChangePasswordModal open={pwOpen} onClose={() => setPwOpen(false)} />
    </div>
  );
}

/** Fixed left sidebar: full width (240px) on desktop, icon rail (64px) on tablet. Items the role can't use are hidden. */
export function Sidebar({ route }: { route: NavRoute }) {
  const { info } = useMonitor();
  const { can } = useAuth();
  const today = info?.violations_today ?? 0;
  const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter((n) => can(ROUTE_PERMISSION[n.route])) })).filter((g) => g.items.length);
  return (
    <aside className="fixed inset-y-0 left-0 z-30 flex w-16 flex-col border-r border-border bg-surface lg:w-60 print:hidden" aria-label="Main navigation">
      {/* Company wordmark (the maker) · hairline · product name — collapses to the bare logo on the rail. */}
      <div className="flex h-16 items-center gap-2.5 border-b border-border px-3 lg:px-4">
        <BrandMark className="w-9 lg:w-14" />
        <div className="hidden min-w-0 flex-1 items-center gap-2.5 lg:flex">
          <span className="h-8 w-px shrink-0 bg-border" aria-hidden />
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold leading-tight tracking-tight">PPE Compliance</p>
            <p className="truncate text-[11px] text-muted">Safety monitoring</p>
          </div>
        </div>
      </div>
      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2.5">
        {groups.map((g, gi) => (
          <div key={g.label}>
            <p className={`hidden px-3 ${gi ? "mt-4 " : ""}pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase lg:block`}>{g.label}</p>
            {gi > 0 && <div className="mx-3 my-2 border-t border-border lg:hidden" />}
            <div className="flex flex-col gap-1">
              {g.items.map((n) => <NavItem key={n.route} {...n} active={n.route === route} badge={n.route === "violations" ? today : undefined} />)}
            </div>
          </div>
        ))}
      </nav>
      <UserMenu />
    </aside>
  );
}
