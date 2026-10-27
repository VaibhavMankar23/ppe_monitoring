/**
 * "Is compliance improving?" Two small charts that share the x axis instead of one dual-axis chart:
 * the compliance rate as a line against the target, and violations per bucket as bars.
 */
import { Bar, BarChart, CartesianGrid, ComposedChart, Line, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtInt } from "../../lib/format";
import { AXIS_LINE, AXIS_TICK, CHART, Figure, TipPanel, tipDatum } from "./common";

export interface TrendPoint {
  t: number;
  violations: number;
  workers_seen: number;
  workers_flagged: number;
  /** Compliance rate in percent, null when no workers were evaluated in the bucket. */
  rate: number | null;
}

interface TrendProps {
  points: TrendPoint[];
  /** Full bucket description for the tooltip. */
  long: (t: number) => string;
  label: string;
}

const SYNC = "analytics-trend";
const Y_WIDTH = 44;
const MARGIN = { top: 20, right: 24, bottom: 0, left: 0 };

export function ComplianceTrend({ points, long, label, target }: TrendProps & { target: number }) {
  const rates = points.flatMap((p) => (p.rate == null ? [] : [p.rate]));
  const targetPct = target * 100;
  // Crop the axis to where the data lives (a 90–100% series is a flat line on 0–100), keeping the target in view.
  const floor = Math.max(0, Math.floor((Math.min(targetPct, ...rates) - 5) / 10) * 10);
  const ticks = Array.from({ length: 5 }, (_, i) => Math.round(floor + ((100 - floor) * i) / 4));
  const last = [...points].reverse().find((p) => p.rate != null);
  return (
    <Figure label={label}>
      <ResponsiveContainer width="100%" height={190}>
        {/* ComposedChart gives the same band x scale as the bar chart below, so the two line up bucket for bucket */}
        <ComposedChart data={points} syncId={SYNC} margin={MARGIN}>
          <CartesianGrid vertical={false} stroke={CHART.grid} />
          <XAxis dataKey="t" hide />
          <YAxis width={Y_WIDTH} domain={[floor, 100]} ticks={ticks} tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={(v: number) => `${v}%`} />
          <Tooltip cursor={{ stroke: CHART.rest, strokeWidth: 1 }} isAnimationActive={false}
            content={(p) => {
              const d = tipDatum<TrendPoint>(p);
              if (!d) return null;
              return (
                <TipPanel title={long(d.t)}
                  rows={[
                    { label: "compliance rate", value: d.rate == null ? "–" : `${d.rate.toFixed(1)}%`, color: CHART.series },
                    { label: "workers checked", value: fmtInt(d.workers_seen) },
                    { label: "flagged", value: fmtInt(d.workers_flagged) },
                  ]}
                  foot={d.rate == null ? "No workers were evaluated in this bucket." : undefined} />
              );
            }} />
          <ReferenceLine y={targetPct} stroke={CHART.ink3} strokeDasharray="4 3" ifOverflow="extendDomain"
            label={{ value: `target ${Math.round(targetPct)}%`, position: "insideBottomRight", fontSize: 11, fill: CHART.ink3 }} />
          <Line dataKey="rate" name="Compliance rate" stroke={CHART.series} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
            connectNulls={false} isAnimationActive={false}
            dot={points.length <= 45 ? { r: 2.5, fill: CHART.series, stroke: CHART.series, strokeWidth: 0 } : false}
            activeDot={{ r: 4, fill: CHART.series, stroke: CHART.surface, strokeWidth: 2 }} />
          {last && last.rate != null && (
            <ReferenceDot x={last.t} y={last.rate} r={4} fill={CHART.series} stroke={CHART.surface} strokeWidth={2} ifOverflow="visible"
              label={{ value: `${last.rate.toFixed(1)}%`, position: "top", offset: 8, fontSize: 11, fontWeight: 600, fill: CHART.ink }} />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </Figure>
  );
}

/** `tick` is the short axis label for a bucket start; this chart carries the x axis for both. */
export function ViolationsTrend({ points, tick, long, label }: TrendProps & { tick: (t: number) => string }) {
  return (
    <Figure label={label}>
      <ResponsiveContainer width="100%" height={170}>
        <BarChart data={points} syncId={SYNC} margin={MARGIN} barCategoryGap={2}>
          <CartesianGrid vertical={false} stroke={CHART.grid} />
          <XAxis dataKey="t" tick={AXIS_TICK} tickLine={false} axisLine={AXIS_LINE} tickFormatter={tick} interval="preserveStartEnd" minTickGap={28} height={26} />
          <YAxis width={Y_WIDTH} allowDecimals={false} tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}K` : String(v))} />
          <Tooltip cursor={{ fill: CHART.grid, fillOpacity: 0.45 }} isAnimationActive={false}
            content={(p) => {
              const d = tipDatum<TrendPoint>(p);
              if (!d) return null;
              return <TipPanel title={long(d.t)} rows={[{ label: d.violations === 1 ? "violation" : "violations", value: fmtInt(d.violations), color: CHART.series, mark: "rect" }]} />;
            }} />
          <Bar dataKey="violations" name="Violations" fill={CHART.series} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </Figure>
  );
}
