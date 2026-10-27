/**
 * Draw the areas of a camera image where the rules apply. A zone is a polygon whose points are
 * fractions of the frame (0..1, origin top-left), so it stays put whatever the video resolution.
 * The polygons are an SVG stretched over the image; the handles are real buttons on top of it, so
 * they stay round and can be focused and moved with the keyboard.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { api, jpegDataUrl } from "../../lib/api";
import type { FieldError, RawConfig, StreamInfo, Zone, ZoneType } from "../../types";
import { CameraVideo, ZONE_STYLE } from "../live/Video";
import { Button, cx, Empty, IconButton, Input, Kbd, Notice, Select, Spinner } from "../ui";

export const MAX_ZONES = 16;
export const MAX_POINTS = 32;
const MAX_NAME = 40;
const TYPES: ZoneType[] = ["monitor", "ignore", "restricted"];
type Pt = [number, number];

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const svgPoints = (pts: Pt[]) => pts.map(([x, y]) => `${x * 1000},${y * 1000}`).join(" ");
const pct = (n: number) => `${n * 100}%`;

/** What is wrong with each zone (null = fine), by the server's own rules, so it is caught before saving. */
export function zoneProblems(zones: Zone[]): (string | null)[] {
  const names = zones.map((z) => (z.name ?? "").trim().toLowerCase());
  return zones.map((z, i) => {
    if (!names[i]) return "Give the zone a name.";
    if (z.name.length > MAX_NAME) return `Use ${MAX_NAME} characters or fewer.`;
    if (names.indexOf(names[i]) !== i || names.lastIndexOf(names[i]) !== i) return "Another zone on this camera has this name.";
    if (z.points.length < 3) return "A zone needs at least 3 points.";
    if (z.points.length > MAX_POINTS) return `A zone can have at most ${MAX_POINTS} points.`;
    return null;
  });
}

function Swatch({ type }: { type: ZoneType }) {
  const st = ZONE_STYLE[type];
  return (
    <span aria-hidden="true" className="inline-block size-3 shrink-0 rounded-[3px] border-2"
      style={{ background: st.fill, borderColor: st.stroke, borderStyle: type === "ignore" ? "dashed" : "solid" }} />
  );
}

const MEANING: Record<ZoneType, string> = {
  monitor: "PPE is checked only for workers whose feet are inside one. Draw at least one and everything outside is left alone.",
  ignore: "Workers whose feet are inside are never checked. Use it for pedestrian walkways, or an office seen through a window.",
  restricted: "Standing inside is itself a violation (“Restricted area”), whatever PPE is worn.",
};

function Stage({ url, aspect, onAspect, children }: { url: string; aspect: number; onAspect?: (a: number) => void; children: ReactNode }) {
  return (
    <div className="relative flex items-center justify-center overflow-hidden rounded-md bg-stage">
      <div className="relative w-full" style={{ aspectRatio: String(aspect) }}>
        <img src={url} alt="" draggable={false} className="absolute inset-0 size-full object-fill select-none"
          onLoad={(e) => { const i = e.currentTarget; if (onAspect && i.naturalWidth && i.naturalHeight) onAspect(i.naturalWidth / i.naturalHeight); }} />
        {children}
      </div>
    </div>
  );
}

interface Props {
  zones: Zone[];
  onChange: (zones: Zone[]) => void;
  /** read-only: the role may not edit this camera */
  disabled?: boolean;
  /** id of the saved camera (absent while it is being created): live video and the stored password */
  streamId?: string;
  /** the camera's live state, when it is running */
  stream?: StreamInfo;
  /** the camera's source as currently edited, to fetch a still when it is not live */
  source?: RawConfig;
  /** validation errors from the server, `loc` relative to this camera's `zones` ("1.points", "" for the list) */
  errors?: FieldError[];
}

type Still = { state: "idle" } | { state: "loading" } | { state: "ok"; url: string; aspect: number } | { state: "error"; message: string };

export function ZoneEditor({ zones, onChange, disabled, streamId, stream, source, errors = [] }: Props) {
  const [selected, setSelected] = useState<number | null>(zones.length ? 0 : null);
  const [vertex, setVertex] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const [drawing, setDrawing] = useState<{ type: ZoneType; points: Pt[] } | null>(null);
  const [hover, setHover] = useState<Pt | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ zone: Zone; index: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);

  // ---------------------------------------------------------------- background image
  const live = !!streamId && stream?.status === "live";
  const liveAspect = stream?.frame_size && stream.frame_size[1] > 0 ? stream.frame_size[0] / stream.frame_size[1] : 16 / 9;
  const [hasFrame, setHasFrame] = useState(false);
  const lastBlob = useRef<Blob | null>(null);
  const [frozen, setFrozen] = useState<{ url: string; aspect: number } | null>(null);
  const [still, setStill] = useState<Still>({ state: "idle" });
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const hasSource = !!source?.uri;

  const onFrame = useCallback((b: Blob) => {
    lastBlob.current = b;
    setHasFrame(true);
  }, []);
  useEffect(() => { if (!live) { setHasFrame(false); lastBlob.current = null; } }, [live]);

  const fetchStill = useCallback(() => {
    const src = sourceRef.current;
    if (!src?.uri) return;
    setStill({ state: "loading" });
    api.sources.test(src, streamId)
      .then((r) => setStill(r.ok && r.thumbnail
        ? { state: "ok", url: jpegDataUrl(r.thumbnail), aspect: r.width && r.height ? r.width / r.height : 16 / 9 }
        : { state: "error", message: r.message || "The source opened but returned no picture." }))
      .catch((e) => setStill({ state: "error", message: e instanceof Error ? e.message : String(e) }));
  }, [streamId]);

  // not running: ask the server for one frame of the source instead
  const autoTried = useRef(false);
  useEffect(() => {
    if (live || disabled || autoTried.current || !hasSource) return;
    autoTried.current = true;
    fetchStill();
  }, [live, disabled, hasSource, fetchStill]);

  const frozenUrl = frozen?.url;
  useEffect(() => () => { if (frozenUrl) URL.revokeObjectURL(frozenUrl); }, [frozenUrl]);
  const toggleFreeze = () => {
    if (frozen) setFrozen(null);
    else if (lastBlob.current) setFrozen({ url: URL.createObjectURL(lastBlob.current), aspect: liveAspect });
  };

  const background: "frozen" | "live" | "still" | "loading" | "none" =
    frozen ? "frozen" : live ? "live" : still.state === "ok" ? "still" : still.state === "loading" ? "loading" : "none";
  const canDraw = !disabled && (background === "frozen" || background === "still" || (background === "live" && hasFrame));

  // ---------------------------------------------------------------- edits
  const zonesRef = useRef(zones);
  zonesRef.current = zones;
  const full = zones.length >= MAX_ZONES;
  const problems = zoneProblems(zones);
  const sel = selected !== null && selected < zones.length ? selected : null;
  const selZone = sel !== null ? zones[sel] : null;
  const selVertex = selZone && vertex !== null && vertex < selZone.points.length ? vertex : null;

  const select = (i: number | null) => {
    setSelected(i);
    setVertex(null);
  };
  const patch = (i: number, p: Partial<Zone>) => onChange(zonesRef.current.map((z, j) => (j === i ? { ...z, ...p } : z)));

  const freshName = (type: ZoneType) => {
    const used = new Set(zonesRef.current.map((z) => z.name.trim().toLowerCase()));
    for (let n = 1; ; n++) {
      const name = `${ZONE_STYLE[type].label} ${n}`;
      if (!used.has(name.toLowerCase())) return name;
    }
  };
  const addZone = (type: ZoneType, points: Pt[]) => {
    const next = [...zonesRef.current, { name: freshName(type), type, points }];
    onChange(next);
    setSelected(next.length - 1);
    setVertex(null);
  };
  const removeZone = (i: number) => {
    setUndo({ zone: zonesRef.current[i], index: i });
    onChange(zonesRef.current.filter((_, j) => j !== i));
    select(null);
  };
  const restoreZone = () => {
    if (!undo || zonesRef.current.length >= MAX_ZONES) return;
    const next = [...zonesRef.current];
    const at = Math.min(undo.index, next.length);
    next.splice(at, 0, undo.zone);
    onChange(next);
    setUndo(null);
    select(at);
  };

  const startDrawing = (type: ZoneType) => {
    setPicking(false);
    setHint(null);
    setHover(null);
    select(null);
    setDrawing({ type, points: [] });
  };
  const finish = () => {
    if (!drawing) return;
    if (drawing.points.length < 3) {
      setHint("A zone needs at least 3 points. Add more, or cancel.");
      return;
    }
    addZone(drawing.type, drawing.points);
    setDrawing(null);
    setHover(null);
    setHint(null);
  };
  const cancelDrawing = () => {
    setDrawing(null);
    setHover(null);
    setHint(null);
  };
  const undoPoint = () => setDrawing((d) => (d ? { ...d, points: d.points.slice(0, -1) } : d));

  const removeVertex = () => {
    if (sel === null || selVertex === null || !selZone) return;
    if (selZone.points.length <= 3) {
      setHint("A zone needs at least 3 points. Delete the zone instead.");
      return;
    }
    patch(sel, { points: selZone.points.filter((_, j) => j !== selVertex) });
    setVertex(null);
  };
  const insertVertex = (after: number) => {
    if (sel === null || !selZone || selZone.points.length >= MAX_POINTS) return;
    const a = selZone.points[after], b = selZone.points[(after + 1) % selZone.points.length];
    const points = [...selZone.points];
    points.splice(after + 1, 0, [round4((a[0] + b[0]) / 2), round4((a[1] + b[1]) / 2)]);
    patch(sel, { points });
    setVertex(after + 1);
  };
  const movePoint = (j: number, p: Pt) => {
    if (sel === null) return;
    const z = zonesRef.current[sel];
    if (!z) return;
    patch(sel, { points: z.points.map((q, k) => (k === j ? p : q)) });
  };

  const frac = (e: { clientX: number; clientY: number }): Pt | null => {
    const r = box.current?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return null;
    return [round4(clamp01((e.clientX - r.left) / r.width)), round4(clamp01((e.clientY - r.top) / r.height))];
  };

  const onCanvasClick = (e: React.MouseEvent) => {
    if (!drawing) {
      select(null);
      return;
    }
    if (e.detail > 1) { // the second click of a double-click closes the shape instead of adding a point
      finish();
      return;
    }
    const p = frac(e);
    if (!p) return;
    const last = drawing.points[drawing.points.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) return;
    if (drawing.points.length >= MAX_POINTS) {
      setHint(`A zone can have at most ${MAX_POINTS} points. Finish it now.`);
      return;
    }
    setHint(null);
    setDrawing({ ...drawing, points: [...drawing.points, p] });
  };

  // Keys act on the drawing wherever the focus is. Listening on window in the capture phase puts this
  // ahead of the drawer's own Escape handler, so Esc cancels the shape instead of closing the editor.
  const keys = useRef({ drawing, picking, selVertex, finish, cancelDrawing, undoPoint, removeVertex });
  keys.current = { drawing, picking, selVertex, finish, cancelDrawing, undoPoint, removeVertex };
  useEffect(() => {
    if (disabled) return;
    const onKey = (e: KeyboardEvent) => {
      const k = keys.current;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      const eat = () => { e.preventDefault(); e.stopPropagation(); };
      if (k.drawing) {
        if (e.key === "Escape") { eat(); k.cancelDrawing(); }
        else if (e.key === "Enter" && !typing) { eat(); k.finish(); }
        else if (e.key === "Backspace" && !typing) { eat(); k.undoPoint(); }
      } else if (k.picking && e.key === "Escape") {
        eat();
        setPicking(false);
      } else if (e.key === "Delete" && k.selVertex !== null && !typing) {
        eat();
        k.removeVertex();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [disabled]);

  const onHandleDown = (j: number) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = j;
    setVertex(j);
    setHint(null);
  };
  const onHandleMove = (j: number) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragging.current !== j) return;
    const p = frac(e);
    if (p) movePoint(j, p);
  };
  const onHandleUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    dragging.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onHandleKey = (j: number) => (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const d: Record<string, Pt> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const v = d[e.key];
    if (!v || !selZone) return;
    e.preventDefault();
    const step = e.shiftKey ? 0.02 : 0.005;
    const [x, y] = selZone.points[j];
    movePoint(j, [round4(clamp01(x + v[0] * step)), round4(clamp01(y + v[1] * step))]);
  };

  // ---------------------------------------------------------------- overlay
  const drawStyle = drawing ? ZONE_STYLE[drawing.type] : null;
  const overlay = (
    <div ref={box} className={cx("absolute inset-0 select-none", drawing && "cursor-crosshair")}
      onClick={disabled ? undefined : onCanvasClick}
      onPointerMove={drawing ? (e) => setHover(frac(e)) : undefined}
      onPointerLeave={drawing ? () => setHover(null) : undefined}>
      <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" className="absolute inset-0 size-full" aria-hidden="true">
        {zones.map((z, i) => {
          const st = ZONE_STYLE[z.type];
          if (z.points.length < 2) return null;
          return (
            <polygon key={i} points={svgPoints(z.points)} fill={st.fill} stroke={st.stroke} strokeWidth={i === sel ? 3 : 1.5}
              vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeDasharray={z.type === "ignore" ? "6 4" : undefined}
              opacity={drawing ? 0.45 : 1}
              style={{ pointerEvents: drawing || disabled ? "none" : "auto", cursor: "pointer" }}
              onClick={(e) => { e.stopPropagation(); if (i !== sel) select(i); else setVertex(null); }} />
          );
        })}
        {drawing && drawStyle && (
          <>
            {drawing.points.length >= 3 && <polygon points={svgPoints(drawing.points)} fill={drawStyle.fill} stroke="none" />}
            <polyline points={svgPoints(drawing.points)} fill="none" stroke={drawStyle.stroke} strokeWidth={2.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            {hover && drawing.points.length > 0 && (
              <polyline points={svgPoints([drawing.points[drawing.points.length - 1], hover, ...(drawing.points.length >= 2 ? [drawing.points[0]] : [])])}
                fill="none" stroke={drawStyle.stroke} strokeWidth={1.5} strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
            )}
          </>
        )}
      </svg>

      {zones.map((z, i) => {
        if (!z.points.length) return null;
        const top = z.points.reduce((a, p) => (p[1] < a[1] ? p : a), z.points[0]);
        return (
          <span key={i} aria-hidden="true"
            style={{ left: pct(Math.min(top[0], 0.8)), top: pct(Math.max(top[1], 0.05)), background: ZONE_STYLE[z.type].stroke, opacity: drawing ? 0.45 : 1 }}
            className="pointer-events-none absolute -translate-y-full rounded-sm px-1 text-[10px] leading-4 font-semibold whitespace-nowrap text-stage">
            {z.name || "Unnamed"}
          </span>
        );
      })}

      {!disabled && !drawing && selZone && sel !== null && (
        <>
          {selZone.points.length < MAX_POINTS && selZone.points.map((a, j) => {
            const b = selZone.points[(j + 1) % selZone.points.length];
            return (
              <button key={`m${j}`} type="button" aria-label={`Add a point after point ${j + 1} of ${selZone.name}`} title="Add a point here"
                style={{ left: pct((a[0] + b[0]) / 2), top: pct((a[1] + b[1]) / 2) }}
                className="group absolute flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full"
                onClick={(e) => { e.stopPropagation(); insertVertex(j); }}>
                <span className="size-2 rounded-full border bg-white/70 group-hover:size-2.5 group-hover:bg-white" style={{ borderColor: ZONE_STYLE[selZone.type].stroke }} />
              </button>
            );
          })}
          {selZone.points.map(([x, y], j) => (
            <button key={`v${j}`} type="button" aria-pressed={selVertex === j}
              aria-label={`Point ${j + 1} of ${selZone.points.length} of ${selZone.name}. Arrow keys move it, Delete removes it.`}
              style={{ left: pct(x), top: pct(y) }}
              className="absolute flex size-7 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none items-center justify-center rounded-full active:cursor-grabbing"
              onPointerDown={onHandleDown(j)} onPointerMove={onHandleMove(j)} onPointerUp={onHandleUp} onPointerCancel={onHandleUp}
              onClick={(e) => e.stopPropagation()} onFocus={() => setVertex(j)} onKeyDown={onHandleKey(j)}>
              <span className={cx("rounded-full border-2 shadow", selVertex === j ? "size-4 border-white" : "size-3 bg-white")}
                style={selVertex === j ? { background: ZONE_STYLE[selZone.type].stroke } : { borderColor: ZONE_STYLE[selZone.type].stroke }} />
            </button>
          ))}
        </>
      )}

      {drawing && drawStyle && drawing.points.map(([x, y], j) => (j === 0 ? (
        <button key={j} type="button" aria-label="Close the zone at its first point" title="Click to close the zone"
          style={{ left: pct(x), top: pct(y) }}
          className="absolute flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full"
          onClick={(e) => { e.stopPropagation(); finish(); }}>
          <span className="size-4 rounded-full border-2 border-white shadow" style={{ background: drawStyle.stroke }} />
        </button>
      ) : (
        <span key={j} aria-hidden="true" style={{ left: pct(x), top: pct(y), borderColor: drawStyle.stroke }}
          className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-white" />
      )))}
    </div>
  );

  // ---------------------------------------------------------------- render
  const general = errors.filter((e) => !/^\d+(\.|$)/.test(e.loc));
  const rowError = (i: number) => errors.find((e) => e.loc === String(i) || e.loc.startsWith(`${i}.`))?.msg ?? null;

  let stage: ReactNode;
  if (background === "frozen" && frozen) stage = <Stage url={frozen.url} aspect={frozen.aspect}>{overlay}</Stage>;
  else if (background === "live" && streamId) {
    stage = (
      <div className="relative">
        <CameraVideo streamId={streamId} aspect={liveAspect} onFrame={onFrame} className="rounded-md">{overlay}</CameraVideo>
        {!hasFrame && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-[13px] text-stage-ink-2"><Spinner size={14} /> Waiting for the camera's video</div>
        )}
      </div>
    );
  } else if (background === "still" && still.state === "ok") {
    stage = <Stage url={still.url} aspect={still.aspect} onAspect={(a) => setStill((s) => (s.state === "ok" && Math.abs(s.aspect - a) > 0.01 ? { ...s, aspect: a } : s))}>{overlay}</Stage>;
  } else if (background === "loading") {
    stage = (
      <div className="flex aspect-video items-center justify-center gap-2 rounded-md bg-stage text-[13px] text-stage-ink-2">
        <Spinner size={14} /> Fetching a frame from the camera. This can take up to 20 seconds.
      </div>
    );
  } else {
    stage = (
      <div className="rounded-md border border-line bg-sunken">
        <Empty icon="camera" title="The camera must be reachable to draw zones"
          action={!disabled && hasSource ? <Button icon="refresh" onClick={fetchStill}>Fetch a frame</Button> : undefined}>
          {still.state === "error" ? `${still.message} ` : ""}
          {hasSource
            ? "Start the camera, or fix its source and fetch a frame. Zones already drawn can still be renamed, retyped and deleted in the list."
            : "Set the camera's source first, on the Source tab. Zones already drawn can still be renamed, retyped and deleted in the list."}
        </Empty>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {general.length > 0 && (
        <Notice tone="bad" title="The server did not accept these zones">
          <ul className="flex flex-col gap-0.5">{general.map((e, i) => <li key={i}>{e.msg}</li>)}</ul>
        </Notice>
      )}

      <div className="grid items-start gap-4 md:grid-cols-[minmax(0,1fr)_264px]">
        <div className="flex min-w-0 flex-col gap-2">
          {/* toolbar */}
          {drawing ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md bg-accent-soft px-2.5 py-2" role="status">
              <Swatch type={drawing.type} />
              <span className="min-w-0 flex-1 text-[13px] text-ink">
                Drawing a <b className="font-semibold">{ZONE_STYLE[drawing.type].label.toLowerCase()}</b> zone, <span className="num">{drawing.points.length}</span> point{drawing.points.length === 1 ? "" : "s"}.
              </span>
              <Button size="sm" variant="ghost" icon="undo" disabled={!drawing.points.length} onClick={undoPoint}>Undo point</Button>
              <Button size="sm" variant="ghost" onClick={cancelDrawing}>Cancel</Button>
              <Button size="sm" icon="check" disabled={drawing.points.length < 3} onClick={finish}>Finish zone</Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" icon="plus" aria-expanded={picking} disabled={disabled || full || !canDraw} onClick={() => setPicking((p) => !p)}>Add zone</Button>
              <Button size="sm" variant="ghost" icon="expand" disabled={disabled || full}
                title="Adds a monitored zone covering the whole frame. Adjust its points afterwards."
                onClick={() => addZone("monitor", [[0, 0], [1, 0], [1, 1], [0, 1]])}>Whole-frame preset</Button>
              {selVertex !== null && <Button size="sm" variant="ghost" icon="trash" disabled={!selZone || selZone.points.length <= 3} onClick={removeVertex}>Remove point</Button>}
              <span className="flex-1" />
              {(live || frozen) && (
                <Button size="sm" variant="ghost" icon={frozen ? "play" : "stop"} aria-pressed={!!frozen} disabled={!frozen && !hasFrame} onClick={toggleFreeze}
                  title="Hold the current picture so it does not move while you draw">
                  {frozen ? "Resume video" : "Freeze frame"}
                </Button>
              )}
              {background === "still" && !disabled && <Button size="sm" variant="ghost" icon="refresh" onClick={fetchStill}>Fetch a new frame</Button>}
            </div>
          )}
          {picking && !drawing && (
            <div className="grid gap-2 sm:grid-cols-3" role="group" aria-label="Zone type">
              {TYPES.map((t) => (
                <button key={t} type="button" onClick={() => startDrawing(t)}
                  className="flex flex-col gap-1 rounded-md border border-line-strong bg-surface p-2.5 text-left transition-colors hover:bg-sunken">
                  <span className="flex items-center gap-1.5 text-[13px] font-semibold"><Swatch type={t} />{ZONE_STYLE[t].label}</span>
                  <span className="text-xs text-ink-3">{ZONE_STYLE[t].help}</span>
                </button>
              ))}
            </div>
          )}
          {hint && <p role="alert" className="text-xs text-bad">{hint}</p>}

          {stage}

          <p className="text-xs text-ink-3">
            {drawing ? (
              <>Click the picture to place points. Click the first point, press <Kbd>Enter</Kbd> or double-click to close the shape. <Kbd>Backspace</Kbd> removes the last point, <Kbd>Esc</Kbd> cancels.</>
            ) : disabled ? (
              "These zones are read-only for your role."
            ) : selZone ? (
              <>Drag a point to move it, or focus it and use the arrow keys. Click a small dot on an edge to add a point. Select a point and press <Kbd>Delete</Kbd> to remove it.</>
            ) : !canDraw && !full ? (
              "A picture from the camera is needed to draw a new zone."
            ) : full ? (
              `A camera can have at most ${MAX_ZONES} zones.`
            ) : (
              "Select a zone to edit its shape, or add one."
            )}
          </p>

          <div className="rounded-md bg-sunken px-3 py-2.5 text-[13px] text-ink-2">
            <p>
              A worker is placed by their <b className="font-semibold text-ink">feet</b>: the bottom centre of the box around them. Draw zones on the
              floor where people stand, not around their bodies.
            </p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {TYPES.map((t) => (
                <li key={t} className="flex items-baseline gap-2">
                  <span className="translate-y-0.5"><Swatch type={t} /></span>
                  <span><b className="font-semibold text-ink">{ZONE_STYLE[t].label}.</b> {MEANING[t]}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2">With no zones, the whole frame is monitored.</p>
          </div>
        </div>

        {/* zone list: everything except the shape can be done from here with the keyboard */}
        <div className="min-w-0">
          <div className="mb-1.5 flex items-baseline justify-between">
            <h3 className="eyebrow">Zones</h3>
            <span className="num text-xs text-ink-3">{zones.length} of {MAX_ZONES}</span>
          </div>
          {zones.length === 0 ? (
            <p className="rounded-md border border-dashed border-line-strong px-3 py-4 text-[13px] text-ink-3">
              No zones yet, so PPE is checked everywhere in the picture. Add a zone to limit or extend the rules.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {zones.map((z, i) => {
                const err = rowError(i) ?? problems[i];
                return (
                  <li key={i} onFocus={() => { if (i !== sel) select(i); }}
                    className={cx("rounded-md border p-2", i === sel ? "border-accent bg-accent-soft/40" : "border-line bg-surface")}>
                    <div className="flex items-center gap-2">
                      <button type="button" aria-pressed={i === sel} aria-label={`Select zone ${z.name || i + 1} on the picture`} title="Select on the picture"
                        className="flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-sunken" onClick={() => select(i)}>
                        <Swatch type={z.type} />
                      </button>
                      <Input aria-label={`Name of zone ${i + 1}`} className="h-8" value={z.name} maxLength={MAX_NAME} disabled={disabled}
                        invalid={!!err && (!z.name.trim() || /name/i.test(err))} onChange={(e) => patch(i, { name: e.target.value })} />
                      <IconButton icon="trash" label={`Delete zone ${z.name || i + 1}`} disabled={disabled} onClick={() => removeZone(i)} />
                    </div>
                    <div className="mt-1.5 flex items-center gap-2 pl-9">
                      <Select aria-label={`Type of zone ${z.name || i + 1}`} className="h-8" value={z.type} disabled={disabled}
                        onChange={(e) => patch(i, { type: e.target.value as ZoneType })}>
                        {TYPES.map((t) => <option key={t} value={t}>{ZONE_STYLE[t].label}</option>)}
                      </Select>
                      <span className="num shrink-0 text-xs whitespace-nowrap text-ink-3">{z.points.length} points</span>
                    </div>
                    {err ? <p role="alert" className="mt-1 pl-9 text-xs text-bad">{err}</p>
                      : i === sel && <p className="mt-1 pl-9 text-xs text-ink-3">{ZONE_STYLE[z.type].help}.</p>}
                  </li>
                );
              })}
            </ul>
          )}
          {undo && !disabled && (
            <p className="mt-2 flex items-center gap-2 text-xs text-ink-3" role="status">
              <span className="min-w-0 truncate">Deleted “{undo.zone.name}”.</span>
              <Button size="sm" variant="ghost" icon="undo" disabled={full} onClick={restoreZone}>Undo</Button>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
