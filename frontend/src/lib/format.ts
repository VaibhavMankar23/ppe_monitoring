export const PPE_LABEL: Record<string, string> = {
  helmet: "Helmet",
  vest: "Vest",
  gloves: "Gloves",
  goggles: "Goggles",
  boots: "Boots",
  mask: "Mask",
  ear_protection: "Ear protection",
};

/** Behavioural violations (not PPE gaps): the offence is the behaviour being present. */
export const BEHAVIOR_LABEL: Record<string, string> = {
  phone_use: "Phone use",
  restricted_area: "Restricted area",
};
export const isBehavior = (k: string) => k in BEHAVIOR_LABEL;

export const ppeLabel = (k: string) =>
  PPE_LABEL[k] ?? BEHAVIOR_LABEL[k] ?? k.replace(/_/g, " ");

const pad = (n: number) => String(n).padStart(2, "0");

/** 24-hour local time, e.g. 14:05:09 */
export const fmtTime = (epochSec: number) => {
  const d = new Date(epochSec * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/** Local calendar day key, e.g. 2026-09-21 */
export const dayKey = (epochSec: number) => {
  const d = new Date(epochSec * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Today" / "Yesterday" / "21 Sep 2026" for a day key. */
export function dayLabel(key: string, now = new Date()): string {
  const today = dayKey(now.getTime() / 1000);
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (key === today) return "Today";
  if (key === dayKey(y.getTime() / 1000)) return "Yesterday";
  const [yy, mm, dd] = key.split("-").map(Number);
  return `${dd} ${MONTHS[mm - 1]} ${yy}`;
}

/** Full local date-time, e.g. 21 Sep 2026, 14:05:09 */
export const fmtDateTime = (epochSec: number) => {
  const d = new Date(epochSec * 1000);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${fmtTime(epochSec)}`;
};

/** <input type="date"> values (local days) -> epoch bounds [start, end). */
export function dateRangeToEpoch(from: string, to: string): { start?: number; end?: number } {
  const out: { start?: number; end?: number } = {};
  if (from) {
    const [y, m, d] = from.split("-").map(Number);
    out.start = new Date(y, m - 1, d).getTime() / 1000;
  }
  if (to) {
    const [y, m, d] = to.split("-").map(Number);
    out.end = new Date(y, m - 1, d + 1).getTime() / 1000;
  }
  return out;
}

/** A violation's items as short phrases: "No helmet", "No vest", "Phone use", "Restricted area". */
export const violationLabel = (k: string) => (isBehavior(k) ? BEHAVIOR_LABEL[k] : `No ${ppeLabel(k).toLowerCase()}`);

/** 75 -> "1m 15s", 3700 -> "1h 1m", 8 -> "8s" */
export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** "just now", "42s ago", "5m ago", "3h ago", then the date. */
export function fmtAgo(epochSec: number, now = Date.now() / 1000): string {
  const d = now - epochSec;
  if (d < 5) return "just now";
  if (d < 60) return `${Math.floor(d)}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return fmtDateTime(epochSec);
}

export const fmtPct = (x: number | null | undefined, digits = 1) => (x == null ? "–" : `${(x * 100).toFixed(digits)}%`);
export const fmtInt = (n: number) => n.toLocaleString("en-IN");
