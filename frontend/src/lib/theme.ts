/**
 * App theme (light / dark / follow-system).
 *
 * The chosen *preference* is persisted; the *resolved* theme ("light" | "dark") is what actually
 * applies and follows the OS when the preference is "system". The `html.dark` class re-declares the
 * design tokens (see index.css), so toggling it re-themes the whole app with no re-render needed.
 * `applyTheme()` is called once from the no-flash bootstrap in index.html AND kept in sync here.
 */
import { useSyncExternalStore } from "react";

export type ThemePref = "light" | "dark" | "system";
export type Theme = "light" | "dark";

const KEY = "ppe-theme";
const mql = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
const listeners = new Set<() => void>();

export function getPref(): ThemePref {
  const v = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
  // Default to Light (not the OS) so a fresh install is predictable; Console (dark)
  // is an explicit choice for wall displays.
  return v === "light" || v === "dark" || v === "system" ? v : "light";
}

export function resolveTheme(_pref: ThemePref = getPref()): Theme {
  // Appearance switcher removed — the app is light-only. To re-enable Light / Console:
  // restore `return pref === "system" ? (mql?.matches ? "dark" : "light") : pref;`
  // and re-add <ThemeToggle /> to the sidebar (components/layout/Sidebar.tsx).
  return "light";
}

/** Toggle the `html.dark` class (+ native color-scheme) to match the resolved theme. */
export function applyTheme(pref: ThemePref = getPref()): void {
  if (typeof document === "undefined") return;
  const theme = resolveTheme(pref);
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

export function setPref(pref: ThemePref): void {
  try { localStorage.setItem(KEY, pref); } catch { /* private mode */ }
  // brief cross-fade, unless the user prefers reduced motion
  const root = document.documentElement;
  const animate = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (animate) {
    root.classList.add("theme-anim");
    window.setTimeout(() => root.classList.remove("theme-anim"), 260);
  }
  applyTheme(pref);
  listeners.forEach((fn) => fn());
}

// keep "system" preference live when the OS flips light/dark
mql?.addEventListener?.("change", () => {
  if (getPref() === "system") { applyTheme("system"); listeners.forEach((fn) => fn()); }
});

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** React hook: current preference + resolved theme, and a setter that re-themes instantly. */
export function useTheme(): { pref: ThemePref; theme: Theme; setPref: (p: ThemePref) => void } {
  const pref = useSyncExternalStore(subscribe, getPref, () => "system" as ThemePref);
  const theme = useSyncExternalStore(subscribe, () => resolveTheme(), () => "light" as Theme);
  return { pref, theme, setPref };
}
