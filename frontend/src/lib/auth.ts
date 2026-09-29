/**
 * Session tokens.
 *
 * - The access token (JWT, ~15 min) lives only in this module's memory: never localStorage,
 *   so a stored-XSS payload can't lift a long-lived credential from disk.
 * - The refresh token is an httpOnly, SameSite=Strict cookie scoped to /api/auth. Scripts can't
 *   read it; the browser sends it to /api/auth/refresh, which is how a page reload restores the
 *   session and how the access token is renewed shortly before it expires.
 * - Refreshes are single-flight: concurrent 401s / timers share one request.
 */
import type { SessionResponse } from "../types";

// Same-origin by default (vite proxy in dev, FastAPI static in prod). Override with VITE_API_BASE.
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? "";

let accessToken: string | null = null;
let expiresAt = 0; // epoch seconds
let refreshTimer: number | undefined;
let inflight: Promise<SessionResponse | null> | null = null;

type SessionListener = (s: SessionResponse | null) => void;
type ExpiredListener = (reason: string) => void;
const sessionListeners = new Set<SessionListener>();
const expiredListeners = new Set<ExpiredListener>();

export function onSession(fn: SessionListener): () => void {
  sessionListeners.add(fn);
  return () => { sessionListeners.delete(fn); };
}
export function onSessionExpired(fn: ExpiredListener): () => void {
  expiredListeners.add(fn);
  return () => { expiredListeners.delete(fn); };
}

/** Adopt a login / refresh / change-password response. */
export function setSession(s: SessionResponse | null): void {
  window.clearTimeout(refreshTimer);
  accessToken = s?.access_token ?? null;
  expiresAt = s?.expires_at ?? 0;
  if (s) {
    // renew a minute before expiry so WebSocket / video URLs always carry a valid token
    const ms = Math.max(5_000, (expiresAt - Date.now() / 1000 - 60) * 1000);
    refreshTimer = window.setTimeout(() => { void refreshSession(); }, ms);
  }
  sessionListeners.forEach((fn) => fn(s));
}

export const currentToken = (): string | null => accessToken;

/** Swap the refresh cookie for a new access token. Resolves null when there is no valid session. */
export function refreshSession(): Promise<SessionResponse | null> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/refresh`, { method: "POST", credentials: "same-origin" });
      if (!res.ok) {
        if (accessToken) expire("Your session has expired. Please sign in again.");
        else setSession(null);
        return null;
      }
      const s = (await res.json()) as SessionResponse;
      setSession(s);
      return s;
    } catch {
      return null; // offline: keep the current state, the caller shows the network error
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** A token that is valid for at least a few more seconds (refreshing first if needed). */
export async function freshToken(): Promise<string | null> {
  if (accessToken && expiresAt - Date.now() / 1000 > 15) return accessToken;
  if (!accessToken) return null;
  return (await refreshSession())?.access_token ?? null;
}

/** Drop the session and tell the app (toast + redirect to /login). */
export function expire(reason: string): void {
  const had = accessToken !== null;
  setSession(null);
  if (had) expiredListeners.forEach((fn) => fn(reason));
}

export async function logoutRequest(): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/auth/logout`, { method: "POST", credentials: "same-origin" });
  } catch {
    /* offline: the cookie is still cleared server-side on its next use / expiry */
  }
  setSession(null);
}

// A background tab's timer may have been throttled; catch up when it becomes visible again.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && accessToken && expiresAt - Date.now() / 1000 < 90) void refreshSession();
  });
}
