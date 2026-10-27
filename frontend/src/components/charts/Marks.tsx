/** Chart forms that need no SVG: a ranked bar list, a part-to-whole split bar and the hour × weekday heatmap. */
import { useState, type ReactNode } from "react";
import { fmtInt } from "../../lib/format";
import { CHART, FigureTable, heatColor, HEAT_STEPS, heatStep } from "./common";

// ------------------------------------------------------------------ ranked bar list
export interface BarRow {
  key: string;
  label: string;
  value: number;
  /** Text after the value, e.g. a share ("42%"). */
  aside?: string;
  /** A line under the row, e.g. what to do about it. */
  note?: ReactNode;
  color?: string;
}

/** One series, one colour: every bar is the accent unless the row is a distinct entity with its own colour. */
export function BarList({ rows, label, unit }: { rows: BarRow[]; label: string; unit: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ol aria-label={label} className="space-y-3">
      {rows.map((r) => (
        <li key={r.key} title={`${r.label}: ${fmtInt(r.value)} ${unit}${r.aside ? ` (${r.aside})` : ""}`}>
          <div className="flex items-baseline justify-between gap-3 text-[13px]">
            <span className="min-w-0 truncate text-ink">{r.label}</span>
            <span className="shrink-0 whitespace-nowrap">
              <span className="num font-semibold text-ink">{fmtInt(r.value)}</span>
              {r.aside && <span className="num ml-2 inline-block w-11 text-right text-xs text-ink-3">{r.aside}</span>}
            </span>
          </div>
          <div className="mt-1 h-2" aria-hidden="true">
            <div className="h-full min-w-[3px] rounded-r-[4px]" style={{ width: `${(r.value / max) * 100}%`, background: r.color ?? CHART.series }} />
          </div>
          {r.note && <p className="mt-1 text-xs text-ink-3">{r.note}</p>}
        </li>
      ))}
    </ol>
  );
}

// ------------------------------------------------------------------ split bar
export interface Segment { key: string; label: string; value: number; color: string }

/** Parts of one total as a single bar with a 2px surface gap between segments and a labelled legend below. */
export function SplitBar({ segments, label }: { segments: Segment[]; label: string }) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  const share = (v: number) => (total ? `${Math.round((v / total) * 100)}%` : "–");
  return (
    <div>
      <div role="img" aria-label={label} className="flex h-3 gap-0.5 overflow-hidden rounded-[4px]">
        {total === 0 ? <div className="flex-1 bg-sunken" /> : segments.filter((s) => s.value > 0).map((s) => (
          <div key={s.key} title={`${s.label}: ${fmtInt(s.value)} (${share(s.value)})`} style={{ flexGrow: s.value, flexBasis: 0, minWidth: 3, background: s.color }} />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
        {segments.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span aria-hidden="true" className="size-2.5 rounded-[2px]" style={{ background: s.color }} />
            <span className="text-ink-2">{s.label}</span>
            <span className="num font-semibold text-ink">{fmtInt(s.value)}</span>
            <span className="num text-xs text-ink-3">{share(s.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ heatmap
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
const slot = (d: number, h: number) => `${DAYS[d] ?? `Day ${d + 1}`} ${hh(h)}–${hh((h + 1) % 24)}`;
const count = (v: number) => `${fmtInt(v)} violation${v === 1 ? "" : "s"}`;

/** Hour × weekday grid (rows Monday..Sunday, local time). Colour is a five-step single-hue scale of the accent. */
export function HourHeatmap({ grid, max }: { grid: number[][]; max: number }) {
  const [hover, setHover] = useState<{ d: number; h: number } | null>(null);
  let peak = { d: 0, h: 0, v: 0 };
  grid.forEach((row, d) => row.forEach((v, h) => { if (v > peak.v) peak = { d, h, v }; }));
  const readout = hover ? `${slot(hover.d, hover.h)}: ${count(grid[hover.d]?.[hover.h] ?? 0)}` : `Busiest hour: ${slot(peak.d, peak.h)}, ${count(peak.v)}`;
  const bounds = HEAT_STEPS.map((_, i) => Math.max(1, Math.ceil((max * (i + 1)) / HEAT_STEPS.length)));
  const cols = { gridTemplateColumns: "2.25rem repeat(24, minmax(0, 1fr))" };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="num text-xs text-ink-2" aria-live="off">{readout}</p>
        <div className="flex items-center gap-1.5 text-[11px] text-ink-3" aria-label={`Colour scale from 0 to ${max} violations per hour`}>
          <span className="num">0</span>
          <span aria-hidden="true" className="size-3 rounded-[2px]" style={{ background: heatColor(0) }} />
          {HEAT_STEPS.map((_, i) => <span key={i} aria-hidden="true" title={`up to ${bounds[i]}`} className="size-3 rounded-[2px]" style={{ background: heatColor(i + 1) }} />)}
          <span className="num">{fmtInt(max)}</span>
          <span>per hour</span>
        </div>
      </div>
      <div className="scroll-thin overflow-x-auto">
        <div role="img" aria-label={`Violations by weekday and hour. ${`Busiest hour: ${slot(peak.d, peak.h)}, ${count(peak.v)}`}.`}
          className="min-w-[560px]" onMouseLeave={() => setHover(null)}>
          {grid.map((row, d) => (
            <div key={d} className="mb-0.5 grid items-center gap-0.5" style={cols}>
              <span className="text-[11px] text-ink-3">{(DAYS[d] ?? "").slice(0, 3)}</span>
              {row.map((v, h) => {
                const on = hover?.d === d && hover.h === h;
                return (
                  <div key={h} title={`${slot(d, h)}: ${count(v)}`} onMouseEnter={() => setHover({ d, h })}
                    className="h-5 rounded-[3px]"
                    style={{ background: heatColor(heatStep(v, max)), outline: on ? `2px solid ${CHART.ink}` : undefined, outlineOffset: on ? 0 : undefined }} />
                );
              })}
            </div>
          ))}
          <div className="grid gap-0.5" style={cols} aria-hidden="true">
            <span />
            {Array.from({ length: 24 }, (_, h) => <span key={h} className="num text-[11px] text-ink-3">{h % 3 === 0 ? String(h).padStart(2, "0") : ""}</span>)}
          </div>
        </div>
      </div>
      <FigureTable caption="Violations by weekday and hour of day"
        head={["Day", ...Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"))]}
        rows={grid.map((row, d) => [DAYS[d] ?? `Day ${d + 1}`, ...row])} />
    </div>
  );
}
