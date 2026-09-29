export type StreamStatus = "stopped" | "connecting" | "live" | "reconnecting" | "offline" | "no_source" | "error" | "stalled";
export type Priority = "high" | "normal" | "low";
export type ItemStatus = "present" | "missing" | "unknown";
export type PersonStatus = "compliant" | "non_compliant" | "unknown";

export interface Person {
  id: number;
  box: [number, number, number, number];
  conf: number;
  status: PersonStatus;
  items: Record<string, ItemStatus>;
  missing: string[];
}

export interface StreamInfo {
  id: string;
  name: string;
  source_type: string;
  status: StreamStatus;
  message: string;
  running: boolean;
  fps: number;
  capture_fps: number;
  source_fps: number;
  infer_ms: number;
  batch: number;
  latency_ms: number;
  frame_size: [number, number] | null;
  frames_processed: number;
  confidence: number;
  show_boxes: boolean;
  required_ppe: string[];
  /** configured checks the loaded model(s) can't perform (PPE with no class, phone use without a phone model) */
  unenforced?: string[];
  connected?: boolean;
  last_frame_at?: number | null; // epoch s
  last_detection_at?: number | null;
  last_violation_at?: number | null;
  workers: number;
  compliant: number;
  violations: number;
  unknown: number;
  people: Person[];
  class_counts: Record<string, number>;
  alerts_total: number;
  frame_seq: number;
  enabled: boolean;
  priority: Priority;
  paused: boolean;
  health: { captured: number; dropped: number; drop_rate: number; reconnects: number; last_error: string; alerts_dropped: number };
}

export interface FocusState {
  enabled: boolean;
  stream_id: string | null;
  paused: string[];
}

export interface MonitorSnapshot {
  device: string;
  imgsz: number;
  mode: string;
  model_classes: string[];
  violations_today: number;
  alerts_session: number;
  focus: FocusState;
  streams: StreamInfo[];
}

/** A stored violation (list item). `thumbnail` / `image` are base64 JPEG without the data: prefix. */
export interface Violation {
  id: number;
  timestamp: number; // epoch seconds
  iso: string;
  stream_id: string;
  stream_name: string;
  track_id: number;
  missing: string[];
  thumbnail: string;
  image?: string;
  acknowledged_at: number | null;
  acknowledged_by: string | null;
  // lifecycle: detected (timestamp) -> confirmed -> ongoing / ended (last_seen) -> acknowledged
  state?: "ongoing" | "ended";
  last_seen?: number;
  duration?: number; // s
  observations?: number;
  confidence?: number | null;
  evidence_purged_at?: number | null;
  // detail only
  meta?: ViolationMeta | null;
  has_original?: boolean;
  has_crop?: boolean;
  original?: string;
  crop?: string;
}

/** Provenance stored with each violation (null on violations recorded before this was kept). */
export interface ViolationMeta {
  camera?: { id: string; name: string; source_type: string; run_id: string };
  lifecycle?: { detected_at: number; confirmed_at: number; evidence_frame_at: number };
  detection?: {
    track_id: number; box: number[]; frame_size: number[]; box_verified_at_full_res: boolean | null;
    person_confidence: number; items: Record<string, { confidence: number | null; evidence: string }>;
    evidence_frame_score: number | null;
  };
  model?: { weights?: string; sha256?: string; runtime?: string; device?: string; imgsz?: number; phone_model?: { weights?: string; sha256?: string } } | null;
  settings?: Record<string, unknown> & { config_sha256?: string; not_checked?: string[] };
  evidence?: { rendered_at: string; sha256: Record<string, string | null> };
}

/** A stored violation event was extended or ended (WebSocket). */
export interface ViolationUpdate {
  id: number;
  last_seen: number;
  observations: number;
  state: "ongoing" | "ended";
  missing?: string[];
}

export interface CameraChanges {
  removed: { id: string; name: string }[];
  added: { id: string; name: string }[];
  changed: { id: string; name: string; fields: string[] }[];
}

/** What the loaded model(s) can check (GET /api/config/schema -> capabilities). */
export interface Capabilities {
  model: { weights?: string; sha256?: string } | null;
  ppe_supported: string[] | null; // null = no model loaded yet
  ppe_not_supported: string[] | null;
  phone: { configured: boolean; weights: string; wanted_by_cameras: string[]; loaded: boolean; load_failed: boolean };
}

export interface ViolationPage {
  items: Violation[];
  total: number;
  next_before_id: number | null;
}

export type ServerMessage =
  | ({ type: "hello" } & MonitorSnapshot)
  | ({ type: "stats" } & MonitorSnapshot)
  | { type: "violation"; violation: Violation }
  | { type: "violation_update"; violation: ViolationUpdate };

export interface FieldError {
  loc: string;
  msg: string;
  line?: number;
}

export interface ReloadResult {
  restarted: string[];
  started: string[];
  stopped: string[];
  added: string[];
  removed: string[];
  engine_reloaded: boolean;
  requires_server_restart: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RawConfig = Record<string, any>;

export interface ConfigDoc {
  config: RawConfig;
  yaml: string;
  etag: string;
  path: string;
}

export interface ConfigSchema {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any;
  ppe_items: string[];
  behaviors: string[];
  devices: string[];
  source_types: string[];
  restart_required: string[];
  capabilities?: Capabilities;
}

export interface BackupInfo {
  name: string;
  created: number;
  size: number;
}

// ------------------------------------------------------------------ auth
export type Role = "admin" | "super_admin";
export type Permission =
  | "monitor:view" | "streams:control" | "violations:view" | "violations:ack" | "violations:export"
  | "violations:delete" | "analytics:view" | "config:view" | "config:cameras" | "config:system"
  | "users:manage" | "audit:view";

export interface Me {
  id: number;
  username: string;
  role: Role;
  role_label: string;
  permissions: Permission[];
  created_at: number;
  last_login: number | null;
  must_change_password: boolean;
  is_active: boolean;
  password_changed_at: number | null;
}

export interface SessionResponse {
  access_token: string;
  token_type: "bearer";
  expires_in: number;
  expires_at: number;
  user: Me;
}

export interface UserRow extends Omit<Me, "permissions" | "role_label"> {
  role_label?: string;
  active_sessions?: number;
}

export interface RolesInfo {
  roles: { id: Role; label: string; permissions: Permission[] }[];
  permissions: { id: Permission; description: string }[];
}

export interface AuditEntry {
  id: number;
  timestamp: number;
  actor_id: number | null;
  actor: string;
  actor_role: string;
  action: string;
  target_type: string;
  target: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  before: Record<string, any> | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  after: Record<string, any> | null;
  detail: string;
  ip: string;
}

export interface AuditPage {
  items: AuditEntry[];
  total: number;
  next_before_id: number | null;
}

// ------------------------------------------------------------------ analytics
export interface PpeCount { item: string; count: number; share: number }

export interface CameraStats {
  stream_id: string;
  stream_name: string;
  violations: number;
  flagged_tracks: number;
  last_violation: number | null;
  unacknowledged: number;
  workers_seen: number;
  workers_flagged: number;
  compliance_rate: number | null;
  by_ppe: Record<string, number>;
  previous_violations: number;
  previous_compliance_rate: number | null;
}

export interface AnalyticsSummary {
  range: { start: number; end: number; tz: number; cameras: string[]; ppe: string[]; days: number };
  avg_violations_per_day: number;
  avg_workers_per_day: number;
  compliance_target: number;
  total_violations: number;
  previous_total_violations: number;
  unacknowledged: number;
  flagged_tracks: number;
  workers_seen: number;
  workers_flagged: number;
  compliance_rate: number | null;
  previous_compliance_rate: number | null;
  compliance_data_since: number | null;
  most_common_missing: PpeCount | null;
  most_flagged_camera: CameraStats | null;
  cameras: { configured: number; enabled: number; running: number; live: number };
}

export interface TimePoint {
  t: number;
  violations: number;
  workers_seen: number;
  workers_flagged: number;
  compliance_rate: number | null;
}

export interface TimeSeries {
  granularity: "hour" | "day" | "week";
  bucket_seconds: number;
  tz: number;
  points: TimePoint[];
}

export interface Heatmap {
  days: string[];
  grid: number[][];
  max: number;
  tz: number;
}

export interface Offender {
  stream_id: string;
  stream_name: string;
  track_id: number;
  run_id: string | null;
  session_known: boolean;
  violations: number;
  first_seen: number;
  last_seen: number;
  missing: string[];
}

// ------------------------------------------------------------------ cameras / capacity
export interface SourceTestResult {
  ok: boolean;
  source: string;
  type: string;
  message?: string;
  width?: number;
  height?: number;
  fps?: number;
  open_ms?: number;
  total_ms?: number;
  thumbnail?: string;
}

export interface ServerFiles {
  dir: string;
  files: { name: string; size: number; modified: number; uri: string }[];
  image_folders: { name: string; uri: string; type: "images" }[];
  extensions: string[];
  max_upload_mb: number;
}

export interface EngineStats {
  name: string;
  device: string;
  utilization: number;
  calls_per_s: number;
  frames_per_s: number;
  avg_batch: number;
  avg_call_ms: number;
  max_batch: number;
  padded_batches: boolean;
  cameras: number;
  contended_loops: number;
}

export interface CameraHealth {
  id: string;
  name: string;
  source_type: string;
  status: StreamStatus;
  message: string;
  running: boolean;
  enabled: boolean;
  priority: Priority;
  paused: boolean;
  fps: number;
  capture_fps: number;
  source_fps: number;
  infer_ms: number;
  latency_ms: number;
  frames_processed: number;
  workers: number;
  captured: number;
  dropped: number;
  drop_rate: number;
  reconnects: number;
  last_error: string;
  alerts_dropped: number;
  connected?: boolean;
  last_frame_at?: number | null; // epoch s
  last_detection_at?: number | null;
  last_violation_at?: number | null;
}

export interface SystemHealth {
  uptime_s: number;
  device: string;
  mode: string;
  post_workers: number;
  engines: EngineStats[];
  host: { cpu_percent?: number; process_cpu_percent?: number; memory_percent?: number; process_rss_mb?: number; threads?: number; cpu_count?: number };
  cameras: CameraHealth[];
  focus: FocusState;
  capacity: { engine_utilization: number; state: "ok" | "busy" | "saturated" };
}
