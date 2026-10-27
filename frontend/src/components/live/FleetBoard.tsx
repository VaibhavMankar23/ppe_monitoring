import { memo, useMemo } from "react";
import type { StreamInfo } from "../../types";
import { cx } from "../ui";
import { STATUS } from "./status";

export type FleetState = "violation" | "down" | "stopped" | "ok";

export const fleetState = (s: StreamInfo): FleetState =>
  !s.running ? "stopped" : s.status !== "live" ? "down" : s.violations > 0 ? "violation" : "ok";

/** Order for a plant-sized fleet: what needs a person first, then the rest by name. */
const RANK: Record<FleetState, number> = { violation: 0, down: 1, ok: 2, stopped: 3 };
export const byAttention = (a: StreamInfo, b: StreamInfo) =>
  RANK[fleetState(a)] - RANK[fleetState(b)] || b.violations - a.violations || a.name.localeCompare(b.name, undefined, { numeric: true });

const CELL: Record<FleetState, string> = {
  violation: "border-bad-line bg-bad-soft",
  down: "border-warn-line bg-warn-soft",
  stopped: "border-line bg-sunken opacity-70",
  ok: "border-line bg-surface hover:border-line-strong",
};
const DOT: Record<FleetState, string> = { violation: "bg-bad", down: "bg-warn", stopped: "bg-ink-4", ok: "bg-ok" };

export function fleetCounts(streams: StreamInfo[]) {
  const c = { violation: 0, down: 0, stopped: 0, ok: 0 } as Record<FleetState, number>;
  streams.forEach((s) => { c[fleetState(s)]++; });
  return c;
}

/**
 * Every camera as one compact status cell, no video: 40-50 cameras fit on one screen, so a
 * supervisor sees the whole plant at once. Cells needing a person sort first.
 */
export const FleetBoard = memo(function FleetBoard({ streams, onOpen, dense = false }:
  { streams: StreamInfo[]; onOpen: (id: string) => void; dense?: boolean }) {
  const sorted = useMemo(() => [...streams].sort(byAttention), [streams]);
  return (
    <div className={cx("grid gap-2", dense ? "grid-cols-[repeat(auto-fill,minmax(150px,1fr))]" : "grid-cols-[repeat(auto-fill,minmax(190px,1fr))]")}>
      {sorted.map((s) => {
        const st = fleetState(s);
        return (
          <button key={s.id} type="button" onClick={() => onOpen(s.id)} title={`${s.name}: ${STATUS[s.status].label}${s.message ? ` · ${s.message}` : ""}`}
            className={cx("group flex min-w-0 items-center gap-2.5 rounded-xl border px-3 text-left transition-colors", dense ? "py-2" : "py-2.5", CELL[st])}>
            <span className={cx("size-2 shrink-0 rounded-full", DOT[st], st === "violation" && "blink")} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] leading-tight font-semibold">{s.name}</span>
              <span className={cx("block truncate text-[11.5px]", st === "violation" ? "text-bad" : st === "down" ? "text-warn" : "text-ink-3")}>
                {st === "stopped" ? "Stopped" : st === "down" ? STATUS[s.status].label
                  : `${s.workers} in view${dense ? "" : ` · ${s.fps.toFixed(0)} fps`}`}
              </span>
            </span>
            {s.violations > 0 && <span className="rounded-full bg-bad px-1.5 font-mono text-[11px] leading-[18px] font-bold text-white">{s.violations}</span>}
          </button>
        );
      })}
    </div>
  );
});

export function FleetLegend({ streams }: { streams: StreamInfo[] }) {
  const c = fleetCounts(streams);
  const items: [FleetState, string][] = [["violation", "Unsafe now"], ["down", "Not delivering"], ["ok", "Clear"], ["stopped", "Stopped"]];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-ink-3">
      {items.map(([k, l]) => (
        <span key={k} className="flex items-center gap-1.5"><span className={cx("size-2 rounded-full", DOT[k])} />{l}<b className="font-mono font-semibold text-ink">{c[k]}</b></span>
      ))}
    </div>
  );
}
