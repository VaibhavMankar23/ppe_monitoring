import { useEffect, useRef, useState } from "react";
import type { Permission } from "../types";

export type Route = "overview" | "monitoring" | "incidents" | "reports" | "devices" | "settings" | "system" | "users" | "audit" | "login";
export const ROUTES: Route[] = ["overview", "monitoring", "incidents", "reports", "devices", "settings", "system", "users", "audit", "login"];
// links and bookmarks from the previous UIs keep working
const ALIASES: Record<string, Route> = {
  dashboard: "overview", live: "monitoring", review: "incidents", violations: "incidents", analytics: "reports",
  cameras: "devices", "add-camera": "devices", config: "settings", admin: "settings",
};
/** Pages grouped under "Administration" (one top-nav entry, a side menu inside). */
export const ADMIN_ROUTES = ["settings", "system", "users", "audit"] as const;

/** Permission each page needs (the backend enforces the same thing on the API it calls). */
export const ROUTE_PERMISSION: Record<Exclude<Route, "login">, Permission> = {
  overview: "monitor:view",
  monitoring: "monitor:view",
  incidents: "violations:view",
  reports: "analytics:view",
  devices: "config:view",
  settings: "config:system",
  system: "monitor:view",
  users: "users:manage",
  audit: "audit:view",
};

const parse = (): Route => {
  const raw = location.hash.replace(/^#\/?/, "").split(/[?/]/)[0];
  const r = (ALIASES[raw] ?? raw) as Route;
  return ROUTES.includes(r) ? r : "overview";
};

let guard: (() => boolean) | null = null;
/** A page with unsaved work can block navigation: the guard returns false to stay. */
export function setNavigationGuard(fn: (() => boolean) | null) {
  guard = fn;
}

/** Minimal hash router: #/dashboard, #/violations, #/config ... (works with any static host). */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parse);
  const current = useRef(route);
  useEffect(() => {
    const on = () => {
      const next = parse();
      if (next === current.current) return;
      if (guard && next !== "login" && !guard()) {
        history.replaceState(null, "", `#/${current.current}`); // stay put
        return;
      }
      current.current = next;
      setRoute(next);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export const href = (r: Route) => `#/${r}`;

export function navigate(r: Route, replace = false) {
  if (parse() === r && location.hash) return;
  if (replace) {
    history.replaceState(null, "", href(r));
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else location.hash = href(r);
}

// where to go back to after signing in (kept in memory: a reload lands on the dashboard)
let nextRoute: Route | null = null;
export function rememberNext() {
  const r = parse();
  if (r !== "login") nextRoute = r;
}
export function takeNext(): Route {
  const r = nextRoute ?? "overview";
  nextRoute = null;
  return r;
}

/** Query part of the hash (#/incidents?camera=gate-1), for deep links between pages. */
export function hashParams(): URLSearchParams {
  const i = location.hash.indexOf("?");
  return new URLSearchParams(i >= 0 ? location.hash.slice(i + 1) : "");
}
export function navigateWith(r: Route, params: Record<string, string | number | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") p.set(k, String(v));
  const q = p.toString();
  location.hash = `${href(r)}${q ? `?${q}` : ""}`;
}
