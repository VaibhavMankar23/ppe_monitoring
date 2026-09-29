/**
 * Shared chart pieces for the Analytics page (Recharts).
 *
 * Colour rules (dataviz method): one series = the primary blue; PPE items keep a fixed categorical
 * slot so "vest" is the same orange in every chart and after any filter (colour follows the entity,
 * never its rank). The 7-slot order below was run through the palette validator: every adjacent pair
 * passes the CVD and normal-vision gates on white; aqua / yellow / magenta are under 3:1 contrast, so
 * every chart ships a legend, tooltips and a table view (the required relief).
 */
import { useState, type ReactNode } from "react";
import { ppeLabel } from "../../lib/format";
import { useTheme } from "../../lib/theme";
import { Button, Card, CardHeader, EmptyState, Icon, Skeleton } from "../ui";

/* Recharts writes colours to SVG presentation attributes, which don't resolve CSS var(), so chart
   chrome (grid, axes, tick labels, hover cursor, segment hairlines, empty heatmap cell) is themed
   here in JS instead of via tokens. Data hues (SERIES, TARGET, the PPE slots) are chosen to read on
   both light and dark surfaces, so they stay constant. */
export const SERIES = "#1466E0"; // signal blue (Operations Console accent)
export const TARGET = "#12965A"; // success green

export interface ChartColors { grid: string; axis: string; muted: string; ink: string; cursor: string; hairline: string; empty: string; ramp: string[] }
const LIGHT: ChartColors = {
  grid: "#E4E8EF", axis: "#D6DCE6", muted: "#5B6472", ink: "#0E1420", cursor: "#F1F4F8", hairline: "#ffffff", empty: "#F1F4F8",
  ramp: ["#E1EAFB", "#BFD4F6", "#93B6EF", "#6394E8", "#3B79E4", "#1F63D8", "#0F52BE"],
};
const DARK: ChartColors = {
  grid: "#223041", axis: "#2C3D51", muted: "#93A0B2", ink: "#E6ECF3", cursor: "#18222E", hairline: "#121A24", empty: "#18222E",
  ramp: ["#15263B", "#1B3556", "#224778", "#2C5EA6", "#3D82DC", "#66A4F2", "#9BC4FA"],
};
/** Theme-aware chart chrome colours; re-reads on theme change so charts re-render. */
export function useChartColors(): ChartColors {
  return useTheme().theme === "dark" ? DARK : LIGHT;
}

export const PPE_ORDER = ["helmet", "vest", "gloves", "goggles", "boots", "mask", "ear_protection"];
const SLOTS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7"];
export const ppeColor = (item: string) => SLOTS[PPE_ORDER.indexOf(item)] ?? "#94A3B8";

export const axisProps = (c: ChartColors) => ({
  tick: { fontSize: 11, fill: c.muted },
  tickLine: false,
  axisLine: { stroke: c.axis },
} as const);

export const fmtInt = (n: number) => n.toLocaleString();
export const pct = (r: number | null | undefined, digits = 1) => (r == null ? "—" : `${(r * 100).toFixed(digits)}%`);

export interface TableSpec { head: string[]; rows: (string | number)[][] }

/** A card whose header states the question the chart answers, with a Chart / Table toggle. */
export function ChartCard({ question, title, description, loading, empty, table, actions, children, className = "", minHeight = 260 }: {
  question: string; title: string; description?: ReactNode; loading: boolean; empty?: string | { title: string; message?: ReactNode } | false | null;
  table?: TableSpec; actions?: ReactNode; children: ReactNode; className?: string; minHeight?: number;
}) {
  const [asTable, setAsTable] = useState(false);
  const emptyTitle = typeof empty === "string" ? empty : empty ? empty.title : null;
  const emptyMsg = typeof empty === "string" ? "Try a longer date range, or include more cameras / PPE types."
    : empty ? empty.message : undefined;
  return (
    <Card className={`flex min-w-0 flex-col break-inside-avoid ${className}`}>
      <CardHeader
        title={<><span className="mb-0.5 block text-[11px] font-semibold tracking-wide text-primary uppercase">{question}</span>{title}</>}
        description={description}
        actions={<>
          {actions}
          {table && !loading && !empty && (
            <Button size="sm" variant="ghost" aria-pressed={asTable} onClick={() => setAsTable((t) => !t)} className="print:hidden">
              {asTable ? "Chart" : "Table"}
            </Button>
          )}
        </>} />
      <div className="flex-1 p-4" style={{ minHeight }}>
        {loading ? <Skeleton className="h-full min-h-[220px] w-full" /> : emptyTitle ? (
          <EmptyState icon={<Icon.chart size={20} />} title={emptyTitle} message={emptyMsg} />
        ) : asTable && table ? (
          <div className="max-h-[320px] overflow-auto">
            <table className="w-full text-left text-[13px]">
              <thead className="sticky top-0 bg-surface text-xs text-muted"><tr>{table.head.map((h) => <th key={h} className="py-1.5 pr-4 font-medium">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-border tabular-nums">{table.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="py-1.5 pr-4">{c}</td>)}</tr>)}</tbody>
            </table>
          </div>
        ) : children}
      </div>
    </Card>
  );
}

/** Recharts tooltip body in the app's style (text in ink; colour only on the swatch). */
export function TipBox({ title, rows }: { title: ReactNode; rows: { color?: string; label: ReactNode; value: ReactNode }[] }) {
  return (
    <div className="min-w-[160px] rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-[var(--shadow-pop)]">
      <p className="mb-1 font-semibold text-text">{title}</p>
      {rows.map((r, i) => (
        <p key={i} className="flex items-center gap-2 text-muted">
          {r.color && <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: r.color }} />}
          <span className="flex-1">{r.label}</span>
          <span className="font-medium text-text tabular-nums">{r.value}</span>
        </p>
      ))}
    </div>
  );
}

export function PpeLegend({ items }: { items: string[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Legend">
      {items.map((it) => (
        <span key={it} className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: ppeColor(it) }} />{ppeLabel(it)}
        </span>
      ))}
    </div>
  );
}
