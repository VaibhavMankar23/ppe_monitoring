import { useEffect, useRef, useState } from "react";
import { useMonitor } from "../../state/monitor";
import type { Zone, ZoneType } from "../../types";
import { cx } from "../ui";

/**
 * A camera's live video (annotated JPEG frames over the shared WebSocket) letterboxed on the dark
 * stage. Children are positioned over the *image* (not the letterbox), so overlays given in frame
 * fractions line up with the picture. `onFrame` reports each frame's blob (e.g. to freeze one).
 *
 * Sizing: by default the picture takes the full width and its own height. With `fit`, the element
 * must have a definite size (e.g. absolute inset-0, or an aspect ratio) and the picture is
 * contained in it without distortion.
 */
export function CameraVideo({ streamId, fps = 8, aspect = 16 / 9, className, children, onFrame, fit }:
  { streamId: string; fps?: number; aspect?: number; className?: string; children?: React.ReactNode; onFrame?: (jpeg: Blob) => void; fit?: boolean }) {
  const { subscribeFrames } = useMonitor();
  const img = useRef<HTMLImageElement>(null);
  const [has, setHas] = useState(false);
  const cb = useRef(onFrame);
  cb.current = onFrame;

  useEffect(() => {
    let url: string | null = null;
    setHas(false);
    const off = subscribeFrames(streamId, fps, (blob) => {
      const next = URL.createObjectURL(blob);
      if (img.current) img.current.src = next;
      if (url) URL.revokeObjectURL(url);
      url = next;
      setHas(true);
      cb.current?.(blob);
    });
    return () => {
      off();
      if (url) URL.revokeObjectURL(url);
    };
  }, [streamId, fps, subscribeFrames]);

  return (
    <div className={cx("relative flex items-center justify-center overflow-hidden bg-stage", className)} style={fit ? { containerType: "size" } : undefined}>
      <div className="relative w-full" style={{ aspectRatio: String(aspect), width: fit ? `min(100cqw, calc(100cqh * ${aspect}))` : undefined }}>
        <img ref={img} alt="" draggable={false} className={cx("absolute inset-0 size-full object-fill select-none", !has && "invisible")} />
        {has && children}
      </div>
    </div>
  );
}

export const ZONE_STYLE: Record<ZoneType, { label: string; stroke: string; fill: string; help: string }> = {
  monitor: { label: "Monitored", stroke: "#4f7cff", fill: "rgb(79 124 255 / 0.14)", help: "PPE is checked only for workers standing inside" },
  ignore: { label: "Ignored", stroke: "#b8bac4", fill: "rgb(184 186 196 / 0.22)", help: "Workers standing inside are never checked" },
  restricted: { label: "Restricted", stroke: "#ff5a4d", fill: "rgb(255 90 77 / 0.18)", help: "Standing inside is a violation" },
};

/** Zone polygons over a video or still. Place inside a box that exactly covers the image. */
export function ZoneOverlay({ zones, labels = true, className }: { zones: Zone[]; labels?: boolean; className?: string }) {
  if (!zones.length) return null;
  return (
    <div className={cx("pointer-events-none absolute inset-0", className)} aria-hidden="true">
      <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" className="absolute inset-0 size-full">
        {zones.map((z) => {
          const st = ZONE_STYLE[z.type];
          return (
            <polygon key={z.name} points={z.points.map(([x, y]) => `${x * 1000},${y * 1000}`).join(" ")} fill={st.fill} stroke={st.stroke}
              strokeWidth={2} vectorEffect="non-scaling-stroke" strokeDasharray={z.type === "ignore" ? "6 4" : undefined} />
          );
        })}
      </svg>
      {labels && zones.map((z) => {
        const top = z.points.reduce((a, p) => (p[1] < a[1] ? p : a), z.points[0]);
        return (
          <span key={z.name} style={{ left: `${Math.min(top[0], 0.8) * 100}%`, top: `${top[1] * 100}%`, background: ZONE_STYLE[z.type].stroke }}
            className="absolute -translate-y-full rounded-sm px-1 text-[10px] leading-4 font-semibold whitespace-nowrap text-stage">{z.name}</span>
        );
      })}
    </div>
  );
}
