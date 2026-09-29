import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { useMonitor } from "../../state/monitor";
import type { StreamInfo } from "../../types";
import { Button, Icon, useToast } from "../ui";

/** Start/stop, box toggle and (optionally) the live confidence slider for one stream.
 *  `slider` is off on the monitoring wall — confidence is a tuning control that lives
 *  in Camera detail, not something to nudge per-tile while watching the floor. */
export function StreamControls({ stream, compact = false, slider = true }: { stream: StreamInfo; compact?: boolean; slider?: boolean }) {
  const { patchStream } = useMonitor();
  const toast = useToast();
  const [conf, setConf] = useState(stream.confidence);
  const [busy, setBusy] = useState(false);
  const debounce = useRef<number | undefined>(undefined);
  const dragging = useRef(false);
  const sliderId = `conf-${stream.id}${compact ? "" : "-detail"}`;

  useEffect(() => {
    if (!dragging.current) setConf(stream.confidence);
  }, [stream.confidence]);

  const run = async (fn: () => Promise<StreamInfo>) => {
    setBusy(true);
    try {
      patchStream(await fn());
    } catch (e) {
      toast({ tone: "error", title: `${stream.name}: action failed`, message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const onConf = (v: number) => {
    setConf(v);
    dragging.current = true;
    window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => {
      dragging.current = false;
      run(() => api.streams.settings(stream.id, { confidence: v }));
    }, 150);
  };

  return (
    <div className="flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
      {stream.running ? (
        <Button size="sm" variant="secondary" icon={<Icon.stop size={14} className="text-danger" />} disabled={busy}
          onClick={() => run(() => api.streams.stop(stream.id))}>Stop</Button>
      ) : (
        <Button size="sm" variant="primary" icon={<Icon.play size={14} />} disabled={busy}
          onClick={() => run(() => api.streams.start(stream.id))}>Start</Button>
      )}
      <button type="button" aria-pressed={stream.show_boxes} disabled={busy}
        onClick={() => run(() => api.streams.settings(stream.id, { show_boxes: !stream.show_boxes }))}
        className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] font-medium shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          stream.show_boxes
            ? "border-primary/40 bg-primary-soft text-primary"
            : "border-border bg-surface text-muted hover:bg-subtle hover:text-text"
        }`}>
        <Icon.boxes size={14} />
        {stream.show_boxes ? "Boxes on" : "Boxes off"}
      </button>
      {slider && (
        <div className="flex min-w-[150px] flex-1 items-center gap-2">
          <label htmlFor={sliderId} className="text-xs font-medium text-muted">Confidence</label>
          <input id={sliderId} type="range" min={0.05} max={0.95} step={0.05} value={conf}
            onChange={(e) => onConf(Number(e.target.value))} className="h-1.5 min-w-16 flex-1 cursor-pointer accent-primary" />
          <span className="w-9 text-right font-mono text-xs tabular-nums">{conf.toFixed(2)}</span>
        </div>
      )}
    </div>
  );
}
