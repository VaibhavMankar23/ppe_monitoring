import { memo } from "react";
import { jpegDataUrl } from "../../lib/api";
import { dayKey, fmtAgo, fmtDuration, fmtTime, violationLabel } from "../../lib/format";
import type { Violation } from "../../types";
import { cx, Icon, Skeleton, Tag } from "../ui";

const today = () => dayKey(Date.now() / 1000);

const Row = memo(function Row({ v, selected, onSelect }: { v: Violation; selected: boolean; onSelect: (id: number) => void }) {
  const ongoing = v.state === "ongoing";
  const status = ongoing ? <Tag tone="bad"><span className="size-1.5 rounded-full bg-current" />Ongoing</Tag>
    : !v.review ? <Tag>Open</Tag>
    : v.review.verdict === "valid" ? <Tag tone="ok">Confirmed</Tag> : <Tag tone="warn">False alarm</Tag>;
  return (
    <tr data-vid={v.id} onClick={() => onSelect(v.id)} aria-selected={selected}
      className={cx("cursor-pointer", selected && "[&>td]:!bg-accent-soft")}>
      <td className="w-[60px] !pr-0">
        <span className="flex size-11 items-center justify-center overflow-hidden rounded-lg bg-stage text-stage-ink-2">
          {v.thumbnail ? <img src={jpegDataUrl(v.thumbnail)} alt="" loading="lazy" className="size-full object-cover" /> : <Icon name="eyeOff" size={16} />}
        </span>
      </td>
      <td>
        <button type="button" onClick={(e) => { e.stopPropagation(); onSelect(v.id); }} className="block text-left font-semibold hover:underline">
          {v.missing.map(violationLabel).join(", ")}
        </button>
        <span className="font-mono text-xs text-ink-3">#{v.id}</span>
      </td>
      <td><span className="block font-medium">{v.stream_name}</span><span className="text-[12.5px] text-ink-3">{v.stream_id}</span></td>
      <td className="font-mono text-[13px] max-md:hidden">#{v.track_id}</td>
      <td className="font-mono text-[13px] max-md:hidden">{v.duration !== undefined && v.duration >= 1 ? fmtDuration(v.duration) : "–"}</td>
      <td>{status}</td>
      <td className="text-right whitespace-nowrap text-ink-3">
        {dayKey(v.timestamp) === today() ? fmtAgo(v.timestamp) : new Date(v.timestamp * 1000).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
        <div className="font-mono text-[11.5px]">{fmtTime(v.timestamp)}</div>
      </td>
    </tr>
  );
});

/** Incidents as a table (v2). Rows open the review panel. `items` newest first. */
export const ViolationTable = memo(function ViolationTable({ items, selectedId, onSelect }:
  { items: Violation[]; selectedId: number | null; onSelect: (id: number) => void }) {
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead><tr><th aria-label="Evidence" /><th>Incident</th><th>Camera</th><th className="max-md:hidden">Worker</th><th className="max-md:hidden">Duration</th><th>Status</th><th className="text-right">When</th></tr></thead>
        <tbody>{items.map((v) => <Row key={v.id} v={v} selected={v.id === selectedId} onSelect={onSelect} />)}</tbody>
      </table>
    </div>
  );
});

export function TableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading incidents" className="divide-y divide-line">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 px-[18px] py-3">
          <Skeleton className="size-11 shrink-0 rounded-lg" />
          <Skeleton className="h-4 w-1/4" /><Skeleton className="h-4 w-1/5" /><Skeleton className="ml-auto h-4 w-16" />
        </div>
      ))}
    </div>
  );
}
