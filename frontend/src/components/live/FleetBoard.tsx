import { memo } from "react";
import type { StreamInfo } from "../../types";
import { cx, Icon, type IconName } from "../ui";
import { STATUS } from "./status";

export type FleetState = "violation" | "down" | "stopped" | "ok";

export const fleetState = (s: StreamInfo): FleetState =>
  !s.running ? "stopped" : s.status !== "live" ? "down" : s.violations > 0 ? "violation" : "ok";

/** Order for a plant-sized fleet: what needs a person first, then the rest by name. */
// Cameras are always shown in the configured order (Setup > Cameras & zones), never re-sorted by
// status: a camera keeps its place on every screen, and colour shows what needs attention.

const CELL: Record<FleetState, string> = {
  violation: "border-bad bg-bad-soft",
  down: "border-warn-line bg-warn-soft",
  stopped: "border-line bg-sunken",
  ok: "border-ok-line bg-surface-2 hover:bg-sunken",
};
const DOT: Record<FleetState, string> = { violation: "bg-bad", down: "bg-warn", stopped: "bg-ink-4", ok: "bg-ok" };
const TEXT: Record<FleetState, string> = { violation: "text-bad", down: "text-warn", stopped: "text-ink-3", ok: "text-ok" };
const ICON: Record<FleetState, IconName> = { violation: "alert", down: "eyeOff", stopped: "clock", ok: "check" };

export function fleetCounts(streams: StreamInfo[]) {
  const c = { violation: 0, down: 0, stopped: 0, ok: 0 } as Record<FleetState, number>;
  streams.forEach((s) => { c[fleetState(s)]++; });
  return c;
}

/**
 * Every camera as one compact status cell, no video: 40-50 cameras fit on one screen, so a
 * supervisor sees the whole plant at once. Cameras stay in their configured order. Each cell names
 * its state in words as well as colour.
 */
export const FleetBoard = memo(function FleetBoard({ streams, onOpen, dense = false }:
  { streams: StreamInfo[]; onOpen: (id: string) => void; dense?: boolean }) {
  return (
    <div className={cx("grid gap-2", dense ? "grid-cols-[repeat(auto-fill,minmax(132px,1fr))]" : "grid-cols-[repeat(auto-fill,minmax(190px,1fr))]")}>
      {streams.map((s) => {
        const st = fleetState(s);
        const word = st === "stopped" ? "Stopped" : st === "down" ? STATUS[s.status].label : st === "violation" ? `Unsafe · ${s.violations}` : "Clear";
        return (
          <button key={s.id} type="button" onClick={() => onOpen(s.id)} aria-label={`${s.name}: ${word}`}
            title={`${s.name}: ${STATUS[s.status].label}${s.message ? ` · ${s.message}` : ""}${st === "ok" || st === "violation" ? ` · ${s.workers} in view` : ""}`}
            className={cx("flex min-h-[58px] min-w-0 flex-col justify-center gap-0.5 rounded-lg border px-2.5 py-2 text-left transition-colors", CELL[st])}>
            <span className="block truncate text-[13px] leading-tight font-semibold">{s.name}</span>
            <span className={cx("flex items-center gap-1.5 text-xs", TEXT[st], st !== "ok" && "font-semibold")}>
              <Icon name={ICON[st]} size={13} className={cx("shrink-0", st === "violation" && "blink")} />
              <span className="truncate">{word}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
});

export function FleetLegend({ streams }: { streams: StreamInfo[] }) {
  const c = fleetCounts(streams);
  const items: [FleetState, string][] = [["ok", "Clear"], ["violation", "Unsafe worker"], ["down", "Not delivering video"], ["stopped", "Switched off"]];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-ink-2" aria-label="Legend">
      {items.map(([k, l]) => (
        <span key={k} className="flex items-center gap-1.5"><i className={cx("inline-block size-3 rounded-[3px]", DOT[k])} />{l}<b className="num font-semibold text-ink">{c[k]}</b></span>
      ))}
    </div>
  );
}
