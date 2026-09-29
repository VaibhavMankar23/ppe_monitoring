import { useEffect, useRef, useState } from "react";
import type { Permission } from "../types";

export type Route = "dashboard" | "violations" | "analytics" | "config" | "add-camera" | "system" | "users" | "audit" | "login";
export const ROUTES: Route[] = ["dashboard", "violations", "analytics", "config", "add-camera", "system", "users", "audit", "login"];

/** Permission each page needs (the backend enforces the same thing on the API it calls). */
export const ROUTE_PERMISSION: Record<Exclude<Route, "login">, Permission> = {
  dashboard: "monitor:view",
  violations: "violations:view",
  analytics: "analytics:view",
  config: "config:view",
  "add-camera": "config:system",
  system: "monitor:view",
  users: "users:manage",
  audit: "audit:view",
};

const parse = (): Route => {
  const r = location.hash.replace(/^#\/?/, "").split(/[?/]/)[0] as Route;
  return ROUTES.includes(r) ? r : "dashboard";
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
  const r = nextRoute ?? "dashboard";
  nextRoute = null;
  return r;
}
