import { useEffect, useRef, useState } from "react";
import { useMonitor } from "../../state/monitor";
import type { StreamInfo } from "../../types";

const PLACEHOLDER: Partial<Record<StreamInfo["status"], string>> = {
  stopped: "Stream stopped",
  no_source: "No signal",
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  offline: "Offline",
  error: "Stream error",
};

/**
 * Live view of one camera, fed by binary frames over the app's single WebSocket.
 *
 * Only subscribes while the tile is on screen (a paginated / scrolled-away tile costs nothing), and
 * never queues: if the previous JPEG is still being decoded, newer frames replace the pending one.
 * `fps` is the most this view wants; the server may send fewer (a camera only has new frames as fast
 * as detection runs).
 */
export function VideoView({ stream, className = "", fps = 6, fit = "contain" }: { stream: StreamInfo; className?: string; fps?: number; fit?: "cover" | "contain" }) {
  const { subscribeFrames } = useMonitor();
  const boxRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [visible, setVisible] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const active = stream.running && stream.frame_seq > 0;

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: "100px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !active) return;
    let url: string | null = null;
    let decoding = false;
    let queued: Blob | null = null;
    const show = (blob: Blob) => {
      const img = imgRef.current;
      if (!img) return;
      if (decoding) {
        queued = blob; // keep only the newest
        return;
      }
      decoding = true;
      const next = URL.createObjectURL(blob);
      img.onload = () => {
        if (url) URL.revokeObjectURL(url);
        url = next;
        decoding = false;
        setLoaded(true);
        if (queued) {
          const q = queued;
          queued = null;
          show(q);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(next);
        decoding = false;
      };
      img.src = next;
    };
    const off = subscribeFrames(stream.id, fps, (blob) => show(blob));
    return () => {
      off();
      if (url) URL.revokeObjectURL(url);
      queued = null;
    };
  }, [visible, active, stream.id, fps, subscribeFrames]);

  useEffect(() => { if (!active) setLoaded(false); }, [active]);

  const showOverlay = !active || !loaded || stream.status !== "live";
  const label = PLACEHOLDER[stream.status] ?? (loaded ? undefined : "Waiting for frames…");

  return (
    <div ref={boxRef} className={`relative overflow-hidden bg-video ${className}`}>
      <img
        ref={imgRef}
        alt={`${stream.name} live view`}
        className={`absolute inset-0 h-full w-full transition-opacity ${fit === "cover" ? "object-cover" : "object-contain"} ${
          active && loaded ? (stream.status === "live" ? "opacity-100" : "opacity-40") : "opacity-0"
        }`}
        draggable={false}
      />
      {stream.paused && active && (
        <span className="absolute top-2 left-2 rounded bg-slate-900/75 px-1.5 py-0.5 text-[11px] font-medium text-white">Detection paused</span>
      )}
      {showOverlay && label && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-4 text-center">
          <p className="text-sm font-medium text-slate-300">{label}</p>
          {stream.message && <p className="max-w-[90%] truncate text-xs text-slate-400">{stream.message}</p>}
        </div>
      )}
    </div>
  );
}
