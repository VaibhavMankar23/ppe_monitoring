import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { wsUrl } from "../lib/api";
import { freshToken, refreshSession } from "../lib/auth";
import type { MonitorSnapshot, ServerMessage, StreamInfo, Violation, ViolationUpdate } from "../types";

export type MonitorInfo = Omit<MonitorSnapshot, "streams">;
type Listener = (v: Violation) => void;
type UpdateListener = (u: ViolationUpdate) => void;
/** A decoded video message: the camera's newest annotated JPEG. */
export type FrameListener = (jpeg: Blob, seq: number) => void;

interface MonitorCtx {
  connected: boolean;
  info: MonitorInfo | null;
  streams: StreamInfo[];
  /** Merge a REST response into local state right away (the next WS tick confirms it). */
  patchStream: (s: StreamInfo) => void;
  /** Subscribe to live violation events; returns an unsubscribe function. */
  onViolation: (fn: Listener) => () => void;
  /** an ongoing violation event was extended (duration, observations, newly missing items) or ended */
  onViolationUpdate: (fn: UpdateListener) => () => void;
  /** Receive a camera's video over the shared socket at up to `fps`; returns an unsubscribe function. */
  subscribeFrames: (streamId: string, fps: number, fn: FrameListener) => () => void;
}

const Ctx = createContext<MonitorCtx | null>(null);

const WS_TOKEN_EXPIRED = 4401; // server closed: handshake token expired/invalid -> refresh, then reconnect
// The server pushes stats 4x/s. A hung server or a silently dropped network path never fires `close`,
// so silence this long means the connection is dead: drop it, show "offline" and reconnect.
const STALE_MS = 8000;

/**
 * One WebSocket for the whole app: stats 4x/s, violation events, and the video of every tile on
 * screen as binary frames. Multiplexing video here (instead of one MJPEG <img> connection per tile)
 * sidesteps the browser's ~6 connections-per-host limit, so 12-16 tiles all stay live. Only
 * cameras that a mounted VideoView subscribed to are sent, at the highest fps any of them asked for.
 * Mounted only while signed in; the access token rides in the URL (checked at the handshake).
 */
export function MonitorProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [info, setInfo] = useState<MonitorInfo | null>(null);
  const [streams, setStreams] = useState<StreamInfo[]>([]);
  const listeners = useRef(new Set<Listener>());
  const updateListeners = useRef(new Set<UpdateListener>());
  const frameSubs = useRef(new Map<string, Map<number, { fps: number; fn: FrameListener }>>());
  const wsRef = useRef<WebSocket | null>(null);
  const nextToken = useRef(1);
  const pending = useRef(false);

  const sendSubscription = useCallback(() => {
    if (pending.current) return;
    pending.current = true;
    queueMicrotask(() => { // coalesce the many (un)subscribes of one render into one message
      pending.current = false;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const out: Record<string, number> = {};
      frameSubs.current.forEach((subs, id) => {
        if (subs.size) out[id] = Math.max(...[...subs.values()].map((s) => s.fps));
      });
      ws.send(JSON.stringify({ type: "subscribe", streams: out }));
    });
  }, []);

  useEffect(() => {
    let closed = false;
    let retry = 500;
    let timer: number | undefined;
    let ws: WebSocket | null = null;
    let lastMsg = 0;
    const decoder = new TextDecoder();

    const onBinary = (buf: ArrayBuffer) => {
      const b = new Uint8Array(buf);
      if (b[0] !== 1) return;
      const n = b[1];
      const id = decoder.decode(b.subarray(2, 2 + n));
      const seq = new DataView(buf, 2 + n, 4).getUint32(0);
      const subs = frameSubs.current.get(id);
      if (!subs?.size) return;
      const blob = new Blob([b.subarray(6 + n)], { type: "image/jpeg" });
      subs.forEach((s) => s.fn(blob, seq));
    };

    const connect = async () => {
      const token = await freshToken();
      if (closed) return;
      if (!token) { // no session any more: the auth layer redirects to the login page
        setConnected(false);
        return;
      }
      ws = new WebSocket(wsUrl(token));
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      ws.onopen = () => {
        lastMsg = Date.now();
        retry = 500;
        setConnected(true);
        sendSubscription();
      };
      ws.onmessage = (ev) => {
        lastMsg = Date.now();
        if (ev.data instanceof ArrayBuffer) {
          onBinary(ev.data);
          return;
        }
        const msg = JSON.parse(ev.data) as ServerMessage;
        if (msg.type === "violation") {
          listeners.current.forEach((fn) => fn(msg.violation));
          setInfo((i) => (i ? { ...i, violations_today: i.violations_today + 1 } : i));
          return;
        }
        if (msg.type === "violation_update") {
          updateListeners.current.forEach((fn) => fn(msg.violation));
          return;
        }
        const { streams: s, type: _type, ...rest } = msg;
        setStreams(s);
        setInfo(rest);
      };
      ws.onclose = (ev) => {
        setConnected(false);
        if (closed) return;
        if (ev.code === WS_TOKEN_EXPIRED) {
          // renew the token first, then reconnect right away (a failed refresh signs the user out)
          void refreshSession().then((s) => { if (s && !closed) void connect(); });
          return;
        }
        timer = window.setTimeout(() => void connect(), retry);
        retry = Math.min(retry * 2, 8000);
      };
      ws.onerror = () => ws?.close();
    };
    void connect();
    const watchdog = window.setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN || Date.now() - lastMsg < STALE_MS) return;
      const dead = ws;
      dead.onopen = dead.onmessage = dead.onclose = dead.onerror = null;
      dead.close();
      ws = null;
      wsRef.current = null;
      setConnected(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void connect(), retry);
      retry = Math.min(retry * 2, 8000);
    }, 2000);
    return () => {
      closed = true;
      window.clearInterval(watchdog);
      window.clearTimeout(timer);
      if (ws) {
        // detach first: a late onclose from this socket must not clobber the next connection's state
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        ws.close();
      }
      wsRef.current = null;
    };
  }, [sendSubscription]);

  const patchStream = useCallback((s: StreamInfo) => {
    setStreams((xs) => xs.map((x) => (x.id === s.id ? { ...x, ...s } : x)));
  }, []);

  const onViolation = useCallback((fn: Listener) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  const onViolationUpdate = useCallback((fn: UpdateListener) => {
    updateListeners.current.add(fn);
    return () => {
      updateListeners.current.delete(fn);
    };
  }, []);

  const subscribeFrames = useCallback((streamId: string, fps: number, fn: FrameListener) => {
    const token = nextToken.current++;
    let subs = frameSubs.current.get(streamId);
    if (!subs) frameSubs.current.set(streamId, (subs = new Map()));
    subs.set(token, { fps, fn });
    sendSubscription();
    return () => {
      subs!.delete(token);
      sendSubscription();
    };
  }, [sendSubscription]);

  return <Ctx.Provider value={{ connected, info, streams, patchStream, onViolation, onViolationUpdate, subscribeFrames }}>{children}</Ctx.Provider>;
}

export function useMonitor(): MonitorCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useMonitor must be used inside <MonitorProvider>");
  return c;
}
