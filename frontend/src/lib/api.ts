import type {
  AnalyticsSummary, AuditPage, BackupInfo, CameraChanges, CameraStats, ConfigDoc, ConfigSchema, FieldError, FocusState, Heatmap, Me, Offender,
  PpeCount, RawConfig, ReloadResult, ReviewFilter, ReviewQuality, RolesInfo, ServerFiles, SessionResponse, SourceTestResult, StreamInfo, SystemHealth,
  TimeSeries, UserRow, Verdict, Violation, ViolationPage,
} from "../types";
import { API_BASE, expire, freshToken, refreshSession } from "./auth";

export { API_BASE };

/** WebSocket URL; browsers can't set headers on the handshake, so the access token goes in the query. */
export function wsUrl(token: string): string {
  const base = API_BASE ? API_BASE.replace(/^http/, "ws") : `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
  return `${base}/ws?access_token=${encodeURIComponent(token)}`;
}

export const jpegDataUrl = (b64: string) => `data:image/jpeg;base64,${b64}`;

/** Error from the API; `fields` holds field-level validation errors (422 on config saves). */
export class ApiError extends Error {
  status: number;
  fields: FieldError[];
  code?: string;
  /** the full JSON error body (e.g. the camera diff of a 409 "confirm_camera_removal") */
  data?: unknown;
  constructor(status: number, message: string, fields: FieldError[] = [], code?: string, data?: unknown) {
    super(message);
    this.status = status;
    this.fields = fields;
    this.code = code;
    this.data = data;
  }
}

type Listener = (code: string) => void;
const forbiddenListeners = new Set<Listener>();
/** Fired on 403 "password_change_required" so the app can switch to the change-password screen. */
export function onAccountAction(fn: Listener): () => void {
  forbiddenListeners.add(fn);
  return () => { forbiddenListeners.delete(fn); };
}

async function toError(res: Response): Promise<ApiError> {
  let msg = `${res.status} ${res.statusText}`;
  let fields: FieldError[] = [];
  let code: string | undefined;
  let data: unknown;
  try {
    const j = await res.json();
    data = j;
    if (Array.isArray(j.errors)) fields = j.errors;
    if (typeof j.detail === "string") msg = j.detail;
    if (typeof j.code === "string") code = j.code;
  } catch {
    /* not JSON */
  }
  return new ApiError(res.status, msg, fields, code, data);
}

interface CallOpts { auth?: boolean; raw?: boolean }

/**
 * fetch wrapper: attaches the access token, and on a 401 refreshes the session once and retries.
 * If the refresh fails too, the session is expired (toast + redirect to the login page).
 */
async function request(method: string, path: string, body?: unknown, opts: CallOpts = {}): Promise<Response> {
  const auth = opts.auth !== false;
  const send = async (token: string | null) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      return await fetch(`${API_BASE}${path}`, {
        method, headers, credentials: "same-origin", body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, "Can't reach the server. Check that the backend is running.");
    }
  };
  let res = await send(auth ? await freshToken() : null);
  if (auth && res.status === 401) {
    const s = await refreshSession();
    if (!s) {
      expire("Your session has expired. Please sign in again.");
      throw await toError(res);
    }
    res = await send(s.access_token);
    if (res.status === 401) {
      expire("Your session is no longer valid. Please sign in again.");
      throw await toError(res);
    }
  }
  if (!res.ok) {
    const err = await toError(res);
    if (res.status === 403 && err.code === "password_change_required") forbiddenListeners.forEach((fn) => fn(err.code!));
    throw err;
  }
  return res;
}

async function call<T>(method: string, path: string, body?: unknown, opts?: CallOpts): Promise<T> {
  return (await request(method, path, body, opts)).json() as Promise<T>;
}

/** Authenticated file download (a plain <a href> can't carry the bearer token). */
export async function download(path: string, fallbackName: string): Promise<void> {
  const res = await request("GET", path);
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") ?? "";
  const name = /filename="?([^";]+)"?/.exec(cd)?.[1] ?? fallbackName;
  saveBlob(blob, name);
}

export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type Params = Record<string, string | number | boolean | undefined | null | string[]>;
export const qs = (params: Params) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
};

export interface ViolationQuery {
  start?: number;
  end?: number;
  camera?: string;
  ppe?: string;
  acknowledged?: boolean;
  review?: ReviewFilter;
  before_id?: number | null;
  limit?: number;
}

export interface AnalyticsQuery {
  start: number;
  end: number;
  camera?: string[];
  ppe?: string[];
  tz: number;
}

export type SaveResult = ConfigDoc & { ok: true; reload: ReloadResult };

export const api = {
  auth: {
    login: (username: string, password: string, remember: boolean) =>
      call<SessionResponse>("POST", "/api/auth/login", { username, password, remember }, { auth: false }),
    me: () => call<Me>("GET", "/api/auth/me"),
    changePassword: (current_password: string, new_password: string) =>
      call<SessionResponse>("POST", "/api/auth/change-password", { current_password, new_password }),
  },
  users: {
    list: () => call<UserRow[]>("GET", "/api/users"),
    roles: () => call<RolesInfo>("GET", "/api/users/roles"),
    create: (u: { username: string; password: string; role: string; must_change_password: boolean }) =>
      call<UserRow>("POST", "/api/users", u),
    update: (id: number, patch: { role?: string; is_active?: boolean }) => call<UserRow>("PATCH", `/api/users/${id}`, patch),
    resetPassword: (id: number, new_password: string, must_change_password = true) =>
      call<UserRow>("POST", `/api/users/${id}/reset-password`, { new_password, must_change_password }),
    remove: (id: number) => call<{ ok: boolean }>("DELETE", `/api/users/${id}`),
  },
  audit: {
    list: (q: { action?: string; actor?: string; start?: number; end?: number; before_id?: number | null; limit?: number }) =>
      call<AuditPage>("GET", `/api/audit${qs({ ...q })}`),
    actions: () => call<string[]>("GET", "/api/audit/actions"),
  },
  system: {
    health: () => call<SystemHealth>("GET", "/api/system/health"),
    focus: (stream_id: string | null) => call<FocusState>("POST", "/api/focus", { stream_id }),
  },
  sources: {
    test: (source: RawConfig, stream_id?: string) => call<SourceTestResult>("POST", "/api/sources/test", { source, stream_id }),
    files: () => call<ServerFiles>("GET", "/api/sources/files"),
    upload: async (file: File, onProgress?: (pct: number) => void): Promise<{ name: string; size: number; uri: string }> => {
      // XHR (not fetch) for upload progress; same auth handling as every other call
      const token = await freshToken();
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${API_BASE}/api/sources/upload`);
        if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
        xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100));
        xhr.onload = () => {
          let body: { detail?: string; code?: string } = {};
          try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
          if (xhr.status >= 200 && xhr.status < 300) resolve(body as never);
          else reject(new ApiError(xhr.status, body.detail ?? `${xhr.status} ${xhr.statusText}`, [], body.code));
        };
        xhr.onerror = () => reject(new ApiError(0, "Upload failed: can't reach the server."));
        const form = new FormData();
        form.append("file", file);
        xhr.send(form);
      });
    },
  },
  streams: {
    start: (id: string) => call<StreamInfo>("POST", `/api/streams/${id}/start`),
    stop: (id: string) => call<StreamInfo>("POST", `/api/streams/${id}/stop`),
    settings: (id: string, s: { confidence?: number; show_boxes?: boolean }) =>
      call<StreamInfo>("PATCH", `/api/streams/${id}/settings`, s),
  },
  config: {
    get: () => call<ConfigDoc>("GET", "/api/config"),
    schema: () => call<ConfigSchema>("GET", "/api/config/schema"),
    validate: (body: { config?: RawConfig; yaml?: string }) =>
      call<{ valid: boolean; errors: FieldError[]; cameras?: CameraChanges }>("POST", "/api/config/validate", body),
    // `confirm_remove`: ids of the cameras the user agreed to remove (the server refuses silent removals)
    save: (body: { config?: RawConfig; yaml?: string; etag?: string; confirm_remove?: string[] }) => call<SaveResult>("PUT", "/api/config", body),
    reset: (body: { keep_cameras: boolean; confirm_remove?: string[] }) => call<SaveResult>("POST", "/api/config/reset", body),
    backups: () => call<BackupInfo[]>("GET", "/api/config/backups"),
    restore: (name: string, confirm_remove?: string[]) => call<SaveResult>("POST", "/api/config/restore", { name, confirm_remove }),
  },
  violations: {
    list: (q: ViolationQuery) => call<ViolationPage>("GET", `/api/violations${qs({ ...q })}`),
    get: (id: number, include: ("original" | "crop")[] = []) =>
      call<Violation>("GET", `/api/violations/${id}${qs({ include: include.join(",") })}`),
    ack: (id: number) => call<Violation>("POST", `/api/violations/${id}/ack`),
    /** verdict null clears the review; a false alarm needs a `reason` (ConfigSchema.review_reasons) */
    review: (id: number, verdict: Verdict | null, reason?: string | null, note = "") =>
      call<Violation>("POST", `/api/violations/${id}/review`, { verdict, reason: reason ?? null, note }),
    remove: (id: number) => call<{ ok: boolean }>("DELETE", `/api/violations/${id}`),
    exportCsv: (q: ViolationQuery) =>
      download(`/api/violations/export${qs({ start: q.start, end: q.end, camera: q.camera, ppe: q.ppe, acknowledged: q.acknowledged, review: q.review })}`,
        "violations.csv"),
    /** YOLO-layout zip (clean frames + person pre-labels + verdicts) of the newest `limit` matches; 404 = nothing to export */
    exportDataset: (q: ViolationQuery, limit = 500) =>
      download(`/api/violations/dataset${qs({ start: q.start, end: q.end, camera: q.camera, ppe: q.ppe, review: q.review, limit })}`,
        "ppe-review-dataset.zip"),
  },
  analytics: {
    summary: (q: AnalyticsQuery) => call<AnalyticsSummary>("GET", `/api/analytics/summary${qs({ ...q })}`),
    timeseries: (q: AnalyticsQuery, granularity: "auto" | "hour" | "day" | "week" = "auto") =>
      call<TimeSeries>("GET", `/api/analytics/timeseries${qs({ ...q, granularity })}`),
    byCamera: (q: AnalyticsQuery) => call<CameraStats[]>("GET", `/api/analytics/by-camera${qs({ ...q })}`),
    byPpe: (q: AnalyticsQuery) => call<PpeCount[]>("GET", `/api/analytics/by-ppe-type${qs({ ...q })}`),
    heatmap: (q: AnalyticsQuery) => call<Heatmap>("GET", `/api/analytics/heatmap${qs({ ...q })}`),
    reviewQuality: (q: AnalyticsQuery) => call<ReviewQuality>("GET", `/api/analytics/review-quality${qs({ ...q })}`),
    topOffenders: (q: AnalyticsQuery, limit = 10) => call<Offender[]>("GET", `/api/analytics/top-offenders${qs({ ...q, limit })}`),
  },
};
