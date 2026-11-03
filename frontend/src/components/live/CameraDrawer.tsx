import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../../lib/api";
import { useMonitor } from "../../state/monitor";
import type { StreamInfo } from "../../types";
import { Button, cx, Icon, IconButton, StatusDot, useOverlay } from "../ui";
import { STATUS } from "./status";
import { CameraVideo, ZoneOverlay } from "./Video";

/**
 * One camera, nothing else: the live video centred and as large as the screen allows, with full
 * screen on demand. Technical controls and figures live in Setup (Cameras & zones, System health).
 */
export function CameraDrawer({ stream: s, onClose }: { stream: StreamInfo | null; onClose: () => void }) {
  const { info } = useMonitor();
  const id = s?.id;
  const focusPauses = !!info?.focus.enabled;

  // focus mode: hold a lease while this view is open (the server lets it lapse if the tab dies)
  useEffect(() => {
    if (!id || !focusPauses) return;
    void api.system.focus(id).catch(() => {});
    const t = window.setInterval(() => void api.system.focus(id).catch(() => {}), 10_000);
    return () => { window.clearInterval(t); void api.system.focus(null).catch(() => {}); };
  }, [id, focusPauses]);

  // centred window over the page (Esc / outside click close it; the page behind doesn't scroll)
  const dialog = useOverlay(!!s, onClose);
  // full screen: the browser's own (the video fills the monitor); an in-app full window where refused
  const stage = useRef<HTMLDivElement>(null);
  const [browserFull, setBrowserFull] = useState(false);
  const [fallback, setFallback] = useState(false);
  const full = browserFull || fallback;
  useEffect(() => {
    const h = () => setBrowserFull(!!stage.current && document.fullscreenElement === stage.current);
    document.addEventListener("fullscreenchange", h);
    return () => document.removeEventListener("fullscreenchange", h);
  }, []);
  useEffect(() => { setFallback(false); if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); }, [id]);
  const toggleFull = useCallback(async () => {
    if (document.fullscreenElement) { await document.exitFullscreen().catch(() => {}); return; }
    if (fallback) { setFallback(false); return; }
    try {
      if (!stage.current?.requestFullscreen) throw new Error("no fullscreen");
      await stage.current.requestFullscreen();
    } catch {
      setFallback(true);
    }
  }, [fallback]);
  // F toggles full screen; Esc leaves the in-app full window before it closes the camera
  useEffect(() => {
    if (!id) return;
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement | null)?.closest?.("input,textarea,select")) return;
      if (e.key.toLowerCase() === "f") { e.preventDefault(); void toggleFull(); }
      else if (e.key === "Escape" && fallback) { e.preventDefault(); e.stopPropagation(); setFallback(false); }
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [id, fallback, toggleFull]);

  if (!s) return null;
  const st = STATUS[s.status];
  const aspect = s.frame_size ? s.frame_size[0] / s.frame_size[1] : 16 / 9;
  const status = <>{st.label}{s.running && s.violations > 0 && <b className="font-semibold text-bad"> · {s.violations} unsafe</b>}</>;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(5_10_18/0.6)] p-2 backdrop-blur-[2px] sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-label={s.name} tabIndex={-1}
        className="animate-rise flex max-h-[96dvh] w-full max-w-[1400px] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop outline-none">
        <header className="flex items-center gap-3 border-b border-line px-4 py-2.5 sm:px-5">
          <h2 className="min-w-0 truncate text-[16px] font-semibold tracking-tight">{s.name}</h2>
          <span className="inline-flex shrink-0 items-center gap-1.5 text-[13px] text-ink-2"><StatusDot tone={st.tone} pulse={s.status === "live"} />{status}</span>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button size="sm" icon="expand" onClick={() => void toggleFull()} disabled={!s.running} title="Full screen (F, or double-click the video)">Full screen</Button>
            <IconButton icon="x" label="Close (Esc)" onClick={onClose} />
          </div>
        </header>

        {/* only the camera: centred, as large as the window allows; full screen fills the whole monitor */}
        <div ref={stage} data-own-escape={full || undefined} onDoubleClick={() => s.running && void toggleFull()}
          className={cx("relative min-h-0 bg-stage", fallback && "fixed inset-0 z-[80]")}>
          {s.running
            ? <CameraVideo fit streamId={s.id} fps={15} aspect={aspect}
                className={full ? "h-dvh w-screen" : "aspect-video max-h-[calc(96dvh-60px)] w-full"}>
                <ZoneOverlay zones={s.zones ?? []} />
              </CameraVideo>
            : <div className="flex aspect-video max-h-[calc(96dvh-60px)] w-full flex-col items-center justify-center gap-1 text-stage-ink-2">
                <span className="text-sm text-stage-ink">{st.label}</span><span className="text-xs">{s.message || st.help}</span>
              </div>}
          {full && (
            <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 bg-gradient-to-b from-black/70 to-transparent p-4 text-white">
              <div>
                <div className="text-lg font-semibold">{s.name}</div>
                <div className="text-[13px] text-white/80">{status}</div>
              </div>
              <button type="button" onClick={() => void toggleFull()}
                className="pointer-events-auto inline-flex h-9 items-center gap-1.5 rounded-lg bg-black/50 px-3 text-[13px] font-semibold text-white hover:bg-black/70">
                <Icon name="x" size={16} />Exit full screen <span className="opacity-70">Esc</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
