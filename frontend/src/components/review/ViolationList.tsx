import { memo, useMemo } from "react";
import { jpegDataUrl } from "../../lib/api";
import { dayKey, dayLabel, fmtDuration, fmtTime, violationLabel } from "../../lib/format";
import type { Violation } from "../../types";
import { cx, Icon, Skeleton, Tag } from "../ui";
import { VERDICT_LABEL } from "./shared";

const Row = memo(function Row({ v, selected, onSelect }: { v: Violation; selected: boolean; onSelect: (id: number) => void }) {
  const ongoing = v.state === "ongoing";
  return (
    <li className="border-b border-line">
      <button type="button" data-vid={v.id} aria-current={selected ? "true" : undefined} onClick={() => onSelect(v.id)}
        className={cx("flex w-full scroll-mt-8 items-start gap-3 px-4 py-3 text-left transition-colors",
          selected ? "bg-accent-soft shadow-[inset_3px_0_0_var(--color-accent)]" : "hover:bg-sunken")}>
        <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-stage text-stage-ink-2">
          {v.thumbnail
            ? <img src={jpegDataUrl(v.thumbnail)} alt="" loading="lazy" className="size-full object-cover" />
            : <Icon name="eyeOff" size={16} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="num text-[13px] font-semibold text-ink">{fmtTime(v.timestamp)}</span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">{v.stream_name}</span>
            <span className="num shrink-0 text-xs text-ink-3" title="Track id">#{v.track_id}</span>
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-1">
            {v.missing.map((m) => <Tag key={m} tone="bad">{violationLabel(m)}</Tag>)}
            {ongoing && <Tag tone="bad">Ongoing</Tag>}
            {v.review && <Tag tone={v.review.verdict === "valid" ? "ok" : "warn"} icon={v.review.verdict === "valid" ? "check" : "x"}>{VERDICT_LABEL[v.review.verdict]}</Tag>}
            {v.duration !== undefined && v.duration >= 1 && <span className="num ml-auto text-xs text-ink-3" title="Duration">{fmtDuration(v.duration)}</span>}
          </span>
        </span>
      </button>
    </li>
  );
});

/** Dense violation rows grouped under sticky day headers. `items` must be newest first. */
export const ViolationList = memo(function ViolationList({ items, selectedId, onSelect }:
  { items: Violation[]; selectedId: number | null; onSelect: (id: number) => void }) {
  const groups = useMemo(() => {
    const out: { key: string; items: Violation[] }[] = [];
    for (const v of items) {
      const k = dayKey(v.timestamp);
      if (!out.length || out[out.length - 1].key !== k) out.push({ key: k, items: [] });
      out[out.length - 1].items.push(v);
    }
    return out;
  }, [items]);
  return (
    <>
      {groups.map((g) => (
        <section key={g.key} aria-label={dayLabel(g.key)}>
          {/* below lg the page scrolls under the 3rem app bar; on lg the list is its own scroller */}
          <h2 className="eyebrow sticky top-0 z-10 border-b border-line bg-surface-2/95 px-4 py-2 backdrop-blur">{dayLabel(g.key)}</h2>
          <ul>{g.items.map((v) => <Row key={v.id} v={v} selected={v.id === selectedId} onSelect={onSelect} />)}</ul>
        </section>
      ))}
    </>
  );
});

export function ListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading violations">
      <div className="border-b border-line bg-sunken px-4 py-1.5"><Skeleton className="h-3 w-16" /></div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-start gap-3 border-b border-line px-4 py-2.5">
          <Skeleton className="h-12 w-16 shrink-0 rounded" />
          <div className="min-w-0 flex-1 space-y-2 py-0.5">
            <Skeleton className="h-3.5 w-3/5" />
            <Skeleton className="h-4 w-2/5" />
          </div>
        </div>
      ))}
    </div>
  );
}
