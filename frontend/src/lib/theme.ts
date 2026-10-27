import { useCallback, useEffect, useState } from "react";

export type ThemePref = "dark" | "light";
const KEY = "ppe-theme";

const read = (): ThemePref => {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
};

/** Dark (default) / light. index.html applies the saved choice before first paint. */
export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(read);
  useEffect(() => {
    const el = document.documentElement;
    if (pref === "light") el.setAttribute("data-theme", "light");
    else el.removeAttribute("data-theme");
    try {
      if (pref === "light") localStorage.setItem(KEY, "light");
      else localStorage.removeItem(KEY);
    } catch { /* private mode: applies to this tab only */ }
  }, [pref]);
  return [pref, useCallback((p: ThemePref) => setPref(p), [])];
}
