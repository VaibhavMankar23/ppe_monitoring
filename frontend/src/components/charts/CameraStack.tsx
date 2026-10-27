/** "Where are the violations?" One horizontal bar per camera, stacked by violation type, longest first. */
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtInt, violationLabel } from "../../lib/format";
import { AXIS_TICK, CHART, Figure, ItemLegend, itemColor, shortName, TipPanel, tipDatum } from "./common";

export interface CameraBar {
  id: string;
  name: string;
  total: number;
  by: Record<string, number>;
}

const ROW = 34;

export function CameraStack({ rows, items, label, onSelect }: { rows: CameraBar[]; items: string[]; label: string; onSelect?: (id: string) => void }) {
  const names = new Map(rows.map((r) => [r.id, r.name]));
  const data = rows.map((r) => ({ ...r, ...Object.fromEntries(items.map((it) => [`v_${it}`, r.by[it] ?? 0])) }));
  return (
    <div>
      {items.length > 1 && <div className="mb-2"><ItemLegend items={items} /></div>}
      <Figure label={label}>
        <ResponsiveContainer width="100%" height={rows.length * ROW + 30}>
          <BarChart data={data} layout="vertical" margin={{ top: 0, right: 40, bottom: 0, left: 0 }} barCategoryGap={8}>
            <CartesianGrid horizontal={false} stroke={CHART.grid} />
            <XAxis type="number" allowDecimals={false} tick={AXIS_TICK} tickLine={false} axisLine={false} height={24} />
            <YAxis type="category" dataKey="id" width={124} tick={{ fontSize: 12, fill: CHART.ink2 }} tickLine={false} axisLine={{ stroke: CHART.rest }}
              tickFormatter={(id: string) => shortName(names.get(id) ?? id, 17)} interval={0} />
            <Tooltip cursor={{ fill: CHART.grid, fillOpacity: 0.45 }} isAnimationActive={false}
              content={(p) => {
                const d = tipDatum<CameraBar>(p);
                if (!d) return null;
                return (
                  <TipPanel title={d.name}
                    rows={[
                      ...items.filter((it) => (d.by[it] ?? 0) > 0).map((it) => ({ label: violationLabel(it), value: fmtInt(d.by[it]), color: itemColor(it), mark: "rect" as const })),
                      { label: "violations in total", value: fmtInt(d.total) },
                    ]}
                    foot="One violation can involve more than one type." />
                );
              }} />
            {items.map((it, i) => (
              <Bar key={it} dataKey={`v_${it}`} name={violationLabel(it)} stackId="camera" fill={itemColor(it)} stroke={CHART.surface} strokeWidth={2}
                maxBarSize={18} isAnimationActive={false} cursor={onSelect ? "pointer" : undefined}
                onClick={(d: unknown) => { const id = (d as { payload?: CameraBar; id?: string }).payload?.id ?? (d as { id?: string }).id; if (id && onSelect) onSelect(id); }}>
                {i === items.length - 1 && <LabelList dataKey="total" position="right" offset={6} fontSize={11} fontWeight={600} fill={CHART.ink} fontFamily="var(--font-mono)" />}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </Figure>
    </div>
  );
}
