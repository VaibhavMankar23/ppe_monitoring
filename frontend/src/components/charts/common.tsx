/**
 * Shared chart vocabulary for the Analytics page: colours (all from the design tokens), axis styling,
 * the tooltip panel, the accessible figure wrapper and the "figures as a table" twin every chart gets.
 */
import type { ReactNode } from "react";
import { violationLabel } from "../../lib/format";

/**
 * Categorical slots for "which violation type". Slot 1 is the data (slate) colour; the other seven are the only
 * colours in the app that are not tokens, because the tokens define a single hue plus status colours and
 * status colours must not be reused for identity. The set was checked with the dataviz palette validator
 * in this order (lightness band, chroma floor, adjacent colour-blind separation, normal-vision floor).
 * Three slots sit under 3:1 contrast on white, so every chart using them ships a legend, a tooltip and
 * a table.
 */
const CATEGORICAL = ["var(--color-data)", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"] as const;

/** Fixed order: colour follows the violation type, never its rank, so filtering does not repaint the rest. */
export const ITEM_ORDER = ["helmet", "vest", "gloves", "goggles", "boots", "mask", "ear_protection", "phone_use", "restricted_area"] as const;

export const CHART = {
  series: "var(--color-data)",
  surface: "var(--color-surface)",
  ink: "var(--color-ink)",
  ink2: "var(--color-ink-2)",
  ink3: "var(--color-ink-3)",
  grid: "var(--color-line)",
  rest: "var(--color-line-strong)",
  ok: "var(--color-ok)",
  warn: "var(--color-warn)",
  bad: "var(--color-bad)",
} as const;

/** Eight hues is the ceiling: the ninth known type takes the dark neutral and anything unknown reads as "other". */
export function itemColor(item: string): string {
  const i = (ITEM_ORDER as readonly string[]).indexOf(item);
  if (i < 0) return CHART.ink3;
  return CATEGORICAL[i] ?? CHART.ink2;
}

/** Known types first in their fixed order, then anything else alphabetically. */
export function sortItems(items: string[]): string[] {
  const rank = (x: string) => { const i = (ITEM_ORDER as readonly string[]).indexOf(x); return i < 0 ? ITEM_ORDER.length : i; };
  return [...new Set(items)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Sequential scale for magnitude: one hue (the data slate), light to dark, in five steps. Zero is the neutral sunken tone. */
export const HEAT_STEPS = [18, 36, 56, 78, 100] as const;
export const heatStep = (v: number, max: number) => (v <= 0 || max <= 0 ? 0 : Math.min(HEAT_STEPS.length, Math.max(1, Math.ceil((v / max) * HEAT_STEPS.length))));
export const heatColor = (step: number) =>
  step <= 0 ? "var(--color-sunken)" : `color-mix(in oklab, var(--color-data) ${HEAT_STEPS[step - 1]}%, var(--color-surface))`;

export const AXIS_TICK = { fontSize: 11, fill: CHART.ink3, fontFamily: "var(--font-mono)" } as const;
export const AXIS_LINE = { stroke: CHART.grid } as const;

export const shortName = (s: string, n = 18) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** What Recharts hands a custom tooltip, reduced to the part these charts read. */
export interface TipArgs<T> { active?: boolean; payload?: ReadonlyArray<{ payload?: T }> }
export const tipDatum = <T,>(p: unknown): T | null => {
  const a = p as TipArgs<T>;
  return a.active && a.payload?.length ? a.payload[0].payload ?? null : null;
};

export interface TipRow { label: string; value: string; color?: string; mark?: "line" | "rect" }

/** Small white readout: the value leads, the label follows, colour sits on a key beside the text. */
export function TipPanel({ title, rows, foot }: { title: string; rows: TipRow[]; foot?: ReactNode }) {
  return (
    <div className="rounded-md border border-line bg-surface px-2.5 py-2 text-xs shadow-pop">
      <div className="mb-1 font-medium text-ink-2">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2 py-px">
          {r.color && <span aria-hidden="true" className={r.mark === "rect" ? "size-2 rounded-[2px]" : "h-0.5 w-3 rounded-full"} style={{ background: r.color }} />}
          <span className="num font-semibold text-ink">{r.value}</span>
          <span className="text-ink-3">{r.label}</span>
        </div>
      ))}
      {foot && <div className="mt-1 text-ink-3">{foot}</div>}
    </div>
  );
}

/** A chart with an accessible name that states the takeaway. */
export function Figure({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return <div role="img" aria-label={label} className={className}>{children}</div>;
}

/** Swatch legend for charts with two or more series. Text stays in ink; the swatch carries identity. */
export function ItemLegend({ items }: { items: string[] }) {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-2" aria-label="Violation types">
      {items.map((it) => (
        <li key={it} className="flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2.5 rounded-[2px]" style={{ background: itemColor(it) }} />
          {violationLabel(it)}
        </li>
      ))}
    </ul>
  );
}

/** The table twin of a chart: every plotted value, reachable without hovering. */
export function FigureTable({ caption, head, rows }: { caption: string; head: string[]; rows: (string | number)[][] }) {
  return (
    <details className="no-print mt-2 text-[13px]">
      <summary className="w-fit rounded text-xs text-ink-3 hover:text-ink">Show these figures as a table</summary>
      <div className="scroll-thin mt-2 max-h-64 overflow-auto rounded-md border border-line">
        <table className="table">
          <caption className="sr-only">{caption}</caption>
          <thead><tr>{head.map((h, i) => <th key={h} scope="col" className={i ? "text-right" : undefined}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>{r.map((c, j) => (j ? <td key={j} className="num text-right">{c}</td> : <th key={j} scope="row" className="!static !normal-case !tracking-normal !text-[13px] !font-normal !text-ink">{c}</th>))}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
