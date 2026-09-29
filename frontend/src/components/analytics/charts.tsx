/**
 * Hour x weekday heatmap (Recharts has no heatmap): a sequential one-hue blue ramp, 2px surface gaps
 * between cells, a hover tooltip per cell and a legend of the ramp. Other charts use Recharts (viz.tsx).
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useChartColors } from "./viz";

export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export const fmtInt = (n: number) => n.toLocaleString();

interface Tip { x: number; y: number; content: ReactNode }

function Tooltip({ tip, width }: { tip: Tip | null; width: number }) {
  if (!tip) return null;
  const left = Math.min(Math.max(tip.x, 80), Math.max(80, width - 80));
  return (
    <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-[var(--shadow-pop)]"
      style={{ left, top: tip.y - 8 }} role="tooltip">
      {tip.content}
    </div>
  );
}

// ------------------------------------------------------------------ heatmap (hour x weekday)
export function HeatmapChart({ days, grid, max, cellTip }: { days: string[]; grid: number[][]; max: number; cellTip: (d: number, h: number, n: number) => ReactNode }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<[number, number] | null>(null);
  const c = useChartColors();
  const SEQ = [c.empty, ...c.ramp]; // step 0 = no data; ramp scales with magnitude
  const MUTED = c.muted;
  const left = 40;
  const gap = 2; // surface gap between cells
  const cw = Math.max(8, (width - left) / 24);
  const ch = 26;
  const height = days.length * ch + 22;
  const step = (n: number) => (n <= 0 || max <= 0 ? 0 : Math.min(SEQ.length - 1, 1 + Math.floor((n / max) * (SEQ.length - 1.0001))));
  return (
    <div ref={ref} className="relative w-full" style={{ height: height + 30 }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Violations by hour of day and day of week" onMouseLeave={() => setHover(null)}>
          {days.map((d, di) => (
            <g key={d}>
              <text x={0} y={di * ch + ch / 2} dy="0.32em" fontSize={11} fill={MUTED}>{d}</text>
              {grid[di].map((n, h) => (
                <rect key={h} x={left + h * cw + gap / 2} y={di * ch + gap / 2} width={cw - gap} height={ch - gap} rx={3}
                  fill={SEQ[step(n)]} stroke={hover && hover[0] === di && hover[1] === h ? c.ink : "none"} strokeWidth={1.5}
                  onMouseEnter={() => setHover([di, h])} />
              ))}
            </g>
          ))}
          {Array.from({ length: 24 }, (_, h) => (h % 3 === 0 ? (
            <text key={h} x={left + h * cw + cw / 2} y={days.length * ch + 14} textAnchor="middle" fontSize={11} fill={MUTED} className="tabular-nums">
              {String(h).padStart(2, "0")}
            </text>
          ) : null))}
        </svg>
      )}
      <div className="flex items-center gap-2 pl-10 text-[11px] text-muted" aria-hidden>
        <span>Fewer</span>
        {SEQ.map((c) => <span key={c} className="h-3 w-5 rounded-sm" style={{ background: c }} />)}
        <span>More{max > 0 ? ` (max ${fmtInt(max)} in one hour slot)` : ""}</span>
      </div>
      <Tooltip width={width} tip={hover ? { x: left + hover[1] * cw + cw / 2, y: hover[0] * ch, content: cellTip(hover[0], hover[1], grid[hover[0]][hover[1]]) } : null} />
    </div>
  );
}
