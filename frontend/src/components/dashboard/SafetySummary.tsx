import { useMemo, type ReactNode } from "react";
import type { StreamInfo } from "../../types";
import { Card, Icon } from "../ui";

/** One live KPI, shown as a compact tile: icon + label, a big number, and a one-line context. */
function StatTile({ label, value, sub, tone, icon }: { label: string; value: string; sub: string; tone?: "crit" | "warn" | "good"; icon: ReactNode }) {
  const color = tone === "crit" ? "text-danger" : tone === "warn" ? "text-warning-text" : tone === "good" ? "text-success-text" : "text-text";
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border bg-subtle px-3.5 py-3 max-sm:flex-row max-sm:items-center max-sm:gap-3 max-sm:py-2">
      <span className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase">
        {icon}{label}
      </span>
      <span className={`font-mono text-[22px] font-bold leading-none tabular-nums ${color}`}>{value}</span>
      <span className="truncate text-[11px] text-muted max-sm:ml-auto">{sub}</span>
    </div>
  );
}

/** Command-centre header: answers "is the site safe right now?" from the live monitor snapshot. */
export function SafetySummary({ streams, connected }: { streams: StreamInfo[]; connected: boolean }) {
  const m = useMemo(() => {
    const running = streams.filter((s) => s.running);
    const workers = running.reduce((a, s) => a + s.workers, 0);
    const violating = running.reduce((a, s) => a + s.violations, 0);
    const live = streams.filter((s) => s.status === "live").length;
    const problems = streams.filter((s) => ["reconnecting", "offline", "no_source", "error", "stalled"].includes(s.status)).length;
    const worst = [...running].filter((s) => s.violations > 0).sort((a, b) => b.violations - a.violations)[0] ?? null;
    const zones = new Set(running.filter((s) => s.violations > 0).map((s) => s.id)).size;
    return { workers, violating, live, problems, worst, zones, total: streams.length };
  }, [streams]);

  // Overall state drives the accent stripe + headline so the answer is readable at a glance.
  const state: "crit" | "warn" | "ok" | "idle" = !connected ? "idle"
    : m.violating > 0 ? "crit" : m.problems > 0 ? "warn" : m.workers > 0 ? "ok" : "idle";
  const stripe = { crit: "bg-danger", warn: "bg-warning", ok: "bg-success", idle: "bg-border-strong" }[state];

  const thesis = !connected
    ? "Waiting for the monitoring service…"
    : m.violating > 0
      ? `${m.violating} worker${m.violating === 1 ? " is" : "s are"} non-compliant right now`
      : m.workers > 0 ? "All monitored workers are compliant" : "No workers detected on camera right now";

  const detail = !connected
    ? "The dashboard reconnects automatically."
    : m.violating > 0
      ? <>Attention needed at <span className="font-semibold text-text">{m.worst?.name}</span>{m.zones > 1 ? ` and ${m.zones - 1} other camera${m.zones - 1 === 1 ? "" : "s"}` : ""}. Review the live tiles below.</>
      : m.problems > 0 ? `${m.problems} camera${m.problems === 1 ? "" : "s"} need attention, but no active violations.` : "Every running camera is clear.";

  return (
    <Card className="relative mb-5 overflow-hidden">
      <span className={`absolute inset-y-0 left-0 w-1.5 ${stripe}`} aria-hidden />
      <div className="grid grid-cols-1 items-center gap-x-6 gap-y-4 py-4 pr-5 pl-7 lg:grid-cols-[1fr_auto]">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">Site safety · right now</p>
          <h2 className="mt-1.5 text-lg leading-tight font-semibold tracking-tight text-balance">{thesis}</h2>
          <p className="mt-1 text-[13px] text-muted">{detail}</p>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 sm:gap-3 lg:w-[420px]">
          <StatTile icon={<Icon.alert size={13} />} label="Violations" value={String(m.violating)}
            tone={m.violating ? "crit" : "good"} sub={m.violating ? "active now" : "none active"} />
          <StatTile icon={<Icon.users size={13} />} label="Workers" value={String(m.workers)} sub="on site now" />
          <StatTile icon={<Icon.camera size={13} />} label="Cameras" value={`${m.live}/${m.total}`}
            tone={m.problems ? "warn" : "good"} sub={m.problems ? `${m.problems} need attention` : m.live === m.total ? "all live" : `${m.total - m.live} not live`} />
        </div>
      </div>
    </Card>
  );
}
