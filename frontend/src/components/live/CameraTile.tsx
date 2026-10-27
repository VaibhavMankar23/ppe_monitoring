import { memo, useEffect, useRef, useState } from "react";
import type { StreamInfo } from "../../types";
import { cx, StatusDot } from "../ui";
import { STATUS } from "./status";
import { CameraVideo, ZoneOverlay } from "./Video";

/** Only tiles that are on screen subscribe to video, so a long wall costs what is visible. */
function useOnScreen<T extends Element>() {
  const ref = useRef<T>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    const io = new IntersectionObserver(([e]) => setOn(e.isIntersecting), { rootMargin: "120px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, []);
  return [ref, on] as const;
}

function TileImpl({ s, onOpen, showZones, fps, card = false }: { s: StreamInfo; onOpen: (id: string) => void; showZones: boolean; fps: number; card?: boolean }) {
  const [ref, visible] = useOnScreen<HTMLButtonElement>();
  const st = STATUS[s.status];
  const aspect = s.frame_size ? s.frame_size[0] / s.frame_size[1] : 16 / 9;
  const alarm = s.violations > 0;
  const live = s.status === "live";
  const tile = (
    <button ref={ref} type="button" onClick={() => onOpen(s.id)} aria-label={`Open ${s.name}: ${st.label}, ${s.workers} workers, ${s.violations} in violation`}
      className={cx("group relative block w-full overflow-hidden bg-stage text-left transition-shadow",
        card ? "rounded-none" : "rounded-[11px]",
        alarm && !card && "shadow-[0_0_0_2px_var(--brand),0_0_24px_-4px_var(--brand)]")}>
      <div className={cx("relative", card ? "aspect-video" : "aspect-[16/10]")}>
        {s.running && visible
          ? <div className="absolute inset-0">
              <CameraVideo fit streamId={s.id} fps={fps} aspect={aspect} className="size-full">
                {showZones && s.zones && <ZoneOverlay zones={s.zones} labels={false} />}
              </CameraVideo>
            </div>
          : null}
        {!live && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-stage/85 px-4 text-center">
            <div className="text-[13px] font-semibold text-stage-ink">{s.name}</div>
            <div className="line-clamp-2 text-[12.5px] text-stage-ink-2">{st.label}{(s.message || st.help) && ` · ${s.message || st.help}`}</div>
          </div>
        )}
        {s.paused && <div className="absolute top-10 left-2.5 rounded-md bg-warn px-1.5 text-[11px] font-medium text-white">Detection paused (focus mode)</div>}

        {live && (
          <div className="pointer-events-none absolute inset-0 flex flex-col justify-between bg-[linear-gradient(180deg,rgba(0,0,0,.55),transparent_34%,transparent_66%,rgba(0,0,0,.6))] px-[11px] py-2.5 text-white">
            <div className="flex min-w-0 items-center gap-[7px] text-[12.5px] font-semibold whitespace-nowrap">
              <span className="inline-flex items-center gap-[5px] rounded-[5px] bg-white/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-[0.06em] backdrop-blur">
                <i className="blink size-1.5 rounded-full bg-[#ff3b57]" />LIVE
              </span>
              <span className="truncate">{s.name}</span>
              {alarm && <span className="ml-auto shrink-0 rounded-[5px] bg-brand px-[7px] py-0.5 text-[11px]">{s.violations} non-compliant</span>}
            </div>
            {!card && (
              <div className="flex justify-between gap-2 font-mono text-[11px] font-medium text-white/75">
                <span>{s.workers} in view · <span className="text-[#6ee7a8]">{s.compliant} ok</span>{s.unknown > 0 && ` · ${s.unknown} not judged`}</span>
                <span>{s.fps.toFixed(1)} fps · {Math.round(s.latency_ms)} ms</span>
              </div>
            )}
          </div>
        )}
      </div>
    </button>
  );
  if (!card) return tile;
  return (
    <div className={cx("overflow-hidden rounded-[14px] border bg-surface", alarm ? "border-transparent shadow-[0_0_0_2px_var(--brand),0_0_28px_-6px_var(--brand)]" : "border-line shadow-card")}>
      {tile}
      <div className="flex items-center gap-3.5 overflow-hidden px-3.5 py-[11px] text-[12.5px] whitespace-nowrap text-ink-3">
        {live ? <>
          <span><b className="num font-semibold text-ink">{s.workers}</b> in view</span>
          <span><b className={cx("num font-semibold", alarm ? "text-bad" : "text-ok")}>{s.violations}</b> non-compliant</span>
          {s.unknown > 0 && <span title="Outside the monitored zones, too small, or body part out of frame"><b className="num font-semibold text-ink">{s.unknown}</b> not judged</span>}
          <span className="ml-auto font-mono text-[11.5px]">{s.fps.toFixed(1)} fps · {Math.round(s.latency_ms)} ms</span>
        </> : <>
          <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold", st.tone === "neutral" ? "bg-sunken text-ink-2" : st.tone === "bad" ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn")}>
            <StatusDot tone={st.tone} />{st.label}
          </span>
          <span className="ml-auto truncate font-mono text-[11.5px]">{s.source_type.toUpperCase()}</span>
        </>}
      </div>
    </div>
  );
}

/** Stats tick 4x/s: re-render a tile only when something it shows changed. */
export const CameraTile = memo(TileImpl, (a, b) => {
  const x = a.s, y = b.s;
  return a.onOpen === b.onOpen && a.card === b.card && a.showZones === b.showZones && a.fps === b.fps && x.id === y.id && x.name === y.name && x.status === y.status
    && x.message === y.message && x.running === y.running && x.paused === y.paused && x.workers === y.workers && x.compliant === y.compliant
    && x.violations === y.violations && x.unknown === y.unknown && x.fps === y.fps && Math.round(x.latency_ms / 50) === Math.round(y.latency_ms / 50)
    && x.zones === y.zones && x.frame_size?.[0] === y.frame_size?.[0];
});
