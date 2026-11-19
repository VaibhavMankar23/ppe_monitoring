import { useCallback, useEffect, useState } from "react";

export type ThemePref = "dark" | "light";
const KEY = "ppe-theme";

/** The saved choice, else what the operating system prefers (light when it says nothing). */
export const initialTheme = (): ThemePref => {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch { /* private mode */ }
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

/** Light (default) / dark. index.html applies the same rule before first paint. data-theme is always set. */
export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(initialTheme);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", pref);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", pref === "dark" ? "#0e1015" : "#f4f5f7");
  }, [pref]);
  // follow the operating system until the person has chosen
  useEffect(() => {
    let chosen = false;
    try { chosen = !!localStorage.getItem(KEY); } catch { /* ignore */ }
    if (chosen || typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setPref(mq.matches ? "dark" : "light");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const choose = useCallback((p: ThemePref) => {
    setPref(p);
    try { localStorage.setItem(KEY, p); } catch { /* applies to this tab only */ }
  }, []);
  return [pref, choose];
}
