"""Typed configuration loaded from config.yaml (+ .env / environment overrides)."""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Literal

import yaml
from dotenv import load_dotenv
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .ppe_logic import PPE_ITEMS

_ENV_PATTERN = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}")
BACKEND_DIR = Path(__file__).resolve().parent.parent

# Environment variables that override a config value after the YAML is loaded
# (numeric/enum keys stay plain in the YAML so the config page can edit them).
ENV_OVERRIDES: dict[str, tuple[str, ...]] = {
    "PPE_HOST": ("server", "host"),
    "PPE_PORT": ("server", "port"),
    "PPE_DEVICE": ("model", "device"),
    "PPE_IMGSZ": ("model", "imgsz"),
    "PPE_CPU_IMGSZ": ("model", "cpu_imgsz"),
    "PPE_DB_PATH": ("alerts", "db_path"),
}


class _Model(BaseModel):
    model_config = ConfigDict(extra="ignore")


class ServerConfig(_Model):
    host: str = "0.0.0.0"
    port: int = Field(8000, ge=1, le=65535)
    static_dir: str = "../frontend/dist"
    cors_origins: list[str] = Field(default_factory=lambda: ["*"])


class ModelConfig(_Model):
    weights: str = Field(min_length=1)
    device: Literal["auto", "cpu", "cuda", "cuda:0", "cuda:1", "intel:gpu", "intel:cpu"] = "auto"
    openvino: bool = True  # allow OpenVINO (auto-exported) when no CUDA GPU is present
    imgsz: int = Field(640, ge=160, le=1920, multiple_of=32)
    cpu_imgsz: int = Field(480, ge=160, le=1920, multiple_of=32)
    half: bool = True
    default_confidence: float = Field(0.35, ge=0.05, le=0.95)
    iou: float = Field(0.7, ge=0.1, le=0.95)  # NMS IoU threshold
    cpu_threads: int = Field(0, ge=0, le=64)
    class_map: dict[str, str] = Field(default_factory=dict)
    # Optional second, general-purpose detector for behaviour classes (currently "cell phone").
    # "" = phone detection off. A camera also needs streams[].detect_phone = true to act on it.
    phone_weights: str = ""


class InferenceConfig(_Model):
    mode: Literal["batched", "per_stream"] = "batched"
    max_fps_per_stream: float = Field(15.0, gt=0, le=60)
    frame_skip: int = Field(0, ge=0, le=30)  # extra captured frames to skip between processed ones
    process_width: int = Field(960, ge=320, le=3840)  # downscale width
    jpeg_quality: int = Field(75, ge=30, le=100)
    # Second pass: re-run the model on a full-resolution crop of each person so small/distant
    # workers' PPE (helmets especially) is seen at a usable size.
    person_refine: bool = True
    refine_imgsz: int = Field(320, ge=160, le=960, multiple_of=32)
    refine_max_persons: int = Field(6, ge=1, le=32)
    refine_batch: int = Field(4, ge=1, le=16)
    refine_min_height: int = Field(24, ge=0)  # px at process resolution
    # Scaling to many cameras
    max_batch: int = Field(8, ge=1, le=32)  # frames per model call; ready cameras beyond this wait a turn
    post_workers: int = Field(0, ge=0, le=32)  # post-processing pool size (0 = auto: half the CPU cores, 2-8)
    focus_pause_others: bool = False  # focus mode: while someone watches one camera full-screen, pause detection elsewhere
    paused_preview_fps: float = Field(4.0, gt=0, le=30)  # video rate of cameras whose detection is paused
    # FFmpeg decoder threads per camera (0 = FFmpeg's default, which uses every core for every camera and
    # oversubscribes the CPU with many cameras; 1 measured +48 % total decode throughput at 12 cameras)
    decode_threads: int = Field(1, ge=0, le=16)


class TrackingConfig(_Model):
    low_thresh: float = Field(0.15, ge=0.01, le=0.9)
    match_iou: float = Field(0.25, ge=0.05, le=0.95)
    max_lost_seconds: float = Field(2.0, gt=0, le=60)
    min_hits: int = Field(2, ge=1, le=10)


class ComplianceConfig(_Model):
    missing_policy: Literal["strict", "negative_only"] = "strict"
    min_containment: float = Field(0.35, ge=0.05, le=1.0)
    smoothing_window: int = Field(6, ge=1, le=60)
    min_person_height: int = Field(60, ge=0)


class AlertConfig(_Model):
    # temporal confirmation: non-compliant on this many consecutive processed frames AND for this long
    min_violation_frames: int = Field(4, ge=1, le=100)
    min_violation_seconds: float = Field(1.0, ge=0, le=60)
    # one violation per incident: while the worker stays non-compliant the stored violation is extended;
    # the incident ends after `event_gap_seconds` without the violation. A new violation for the same
    # worker needs the incident to have ended and `cooldown_seconds` to have passed since it began.
    cooldown_seconds: float = Field(120.0, ge=0, le=86400)
    event_gap_seconds: float = Field(10.0, ge=0, le=600)
    snapshot_quality: int = Field(85, ge=30, le=100)
    retention_days: int = Field(30, ge=0, le=3650)  # 0 = keep forever
    # keep the clean full-resolution frame of each violation next to the annotated evidence image
    save_original_frame: bool = True
    # evidence images older than this are removed (the violation record and its thumbnail stay until
    # `retention_days`); 0 = keep images as long as the record
    evidence_retention_days: int = Field(0, ge=0, le=3650)
    db_path: str = "./data/violations.db"
    # Evidence box: re-detect the offending worker on a full-resolution crop of the alert frame at this
    # size, so the saved snapshot's box is exact rather than the coarse full-frame estimate (0 = off).
    evidence_imgsz: int = Field(640, ge=0, le=1280, multiple_of=32)
    # Only fire an alert on a frame where the worker's box comes from a confident detection; tracker
    # "coasting" boxes from low-confidence detections are sloppy evidence (the streak is kept, not reset).
    require_confident_box: bool = True
    # Drop an alert when the full-resolution re-detection finds no person where the tracker had one
    # (a phantom "person" on machinery). Needs evidence_imgsz > 0.
    drop_unconfirmed: bool = True


class SourceConfig(_Model):
    type: Literal["file", "rtsp", "webcam", "http", "images", "onvif"] = "file"
    uri: str = Field(min_length=1)
    # network cameras: credentials kept out of the URI; the password is stored encrypted ("enc:...")
    username: str = ""
    password: str = ""
    timeout: float = Field(10.0, gt=0, le=120)  # s to open / between frames before a reconnect
    loop: bool = True
    fps: float = Field(0.0, ge=0, le=120)  # playback fps for files/images; 0 = native (5 for images)
    reconnect_delay: float = Field(2.0, gt=0, le=300)
    max_reconnect_delay: float = Field(30.0, gt=0, le=3600)

    @field_validator("uri")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()


class ZoneConfig(_Model):
    """A polygon drawn on the camera image (Camera > Zones). Points are fractions of the frame."""
    name: str = Field(min_length=1, max_length=40)
    # monitor: judge PPE only inside | ignore: never judge inside | restricted: being inside is a violation
    type: Literal["monitor", "ignore", "restricted"] = "monitor"
    points: list[tuple[float, float]] = Field(min_length=3, max_length=32)

    @field_validator("points")
    @classmethod
    def _in_frame(cls, v: list[tuple[float, float]]) -> list[tuple[float, float]]:
        if any(not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0) for x, y in v):
            raise ValueError("zone points must be fractions of the frame (0..1)")
        return [(round(x, 4), round(y, 4)) for x, y in v]


class StreamConfig(_Model):
    id: str = Field(min_length=1, max_length=32, pattern=r"^[A-Za-z0-9_-]+$")
    name: str = Field(min_length=1, max_length=64)
    source: SourceConfig
    required_ppe: list[str] = Field(default_factory=lambda: ["helmet", "vest"])
    enabled: bool = True
    confidence: float | None = Field(None, ge=0.05, le=0.95)
    # Scheduling when the engine is saturated: high cameras are served first; low cameras are also
    # capped at 1/3 of inference.max_fps_per_stream (detection on every ~3rd frame a normal camera gets).
    priority: Literal["high", "normal", "low"] = "normal"
    # Raise a violation when a worker is using a phone. Needs model.phone_weights to be set.
    detect_phone: bool = False
    # Where on the image the rules apply (empty = the whole frame is monitored).
    zones: list[ZoneConfig] = Field(default_factory=list, max_length=16)

    @field_validator("zones")
    @classmethod
    def _unique_zone_names(cls, v: list[ZoneConfig]) -> list[ZoneConfig]:
        names = [z.name.strip().lower() for z in v]
        if len(set(names)) != len(names):
            raise ValueError("zone names must be unique within a camera")
        return v

    @field_validator("required_ppe")
    @classmethod
    def _known_items(cls, v: list[str]) -> list[str]:
        unknown = [i for i in v if i not in PPE_ITEMS]
        if unknown:
            raise ValueError(f"unknown PPE item(s) {unknown}; valid: {sorted(PPE_ITEMS)}")
        if len(set(v)) != len(v):
            raise ValueError("duplicate PPE items")
        return v


class WebhookAlarmConfig(_Model):
    enabled: bool = False
    url: str = ""  # POST target; a plant can wire it to a hooter/relay gateway, Teams/Slack, a PLC, ...
    timeout: float = Field(5.0, gt=0, le=60)


class EmailAlarmConfig(_Model):
    enabled: bool = False
    smtp_host: str = ""
    smtp_port: int = Field(587, ge=1, le=65535)
    username: str = ""
    # Keep the password out of config.yaml: put `password: ${PPE_SMTP_PASSWORD}` and set the env var.
    password: str = ""
    use_tls: bool = True  # STARTTLS (587); set false for an open relay
    sender: str = ""
    recipients: list[str] = Field(default_factory=list)
    attach_snapshot: bool = True  # attach the violation JPEG

    @field_validator("recipients", mode="before")
    @classmethod
    def _split_recipients(cls, v: Any) -> Any:
        """Accept a comma/newline-separated string (from the config form) as well as a YAML list."""
        if isinstance(v, str):
            return [x.strip() for x in re.split(r"[,\n;]", v) if x.strip()]
        return v


class AlarmConfig(_Model):
    """Outbound alarm on a stored violation. Rate-limited per camera on top of violation dedupe."""
    cooldown_seconds: float = Field(60.0, ge=0, le=86400)  # min gap between alarms for one camera
    webhook: WebhookAlarmConfig = Field(default_factory=WebhookAlarmConfig)
    email: EmailAlarmConfig = Field(default_factory=EmailAlarmConfig)

    @property
    def any_enabled(self) -> bool:
        return self.webhook.enabled or self.email.enabled


class AnalyticsConfig(_Model):
    compliance_target: float = Field(0.95, ge=0.5, le=1.0)  # the goal line on the compliance trend


class AppConfig(_Model):
    server: ServerConfig = Field(default_factory=ServerConfig)
    model: ModelConfig
    inference: InferenceConfig = Field(default_factory=InferenceConfig)
    tracking: TrackingConfig = Field(default_factory=TrackingConfig)
    compliance: ComplianceConfig = Field(default_factory=ComplianceConfig)
    alerts: AlertConfig = Field(default_factory=AlertConfig)
    alarm: AlarmConfig = Field(default_factory=AlarmConfig)
    analytics: AnalyticsConfig = Field(default_factory=AnalyticsConfig)
    streams: list[StreamConfig] = Field(default_factory=list, max_length=64)  # empty = add cameras from the UI; sized for a 40-45 camera plant

    @field_validator("streams")
    @classmethod
    def _unique_ids(cls, v: list[StreamConfig]) -> list[StreamConfig]:
        ids = [s.id for s in v]
        dup = sorted({i for i in ids if ids.count(i) > 1})
        if dup:
            raise ValueError(f"stream ids must be unique (duplicated: {', '.join(dup)})")
        return v


def expand_env(value: Any) -> Any:
    """Replace ${VAR} / ${VAR:-default} in every string of a nested structure."""
    if isinstance(value, str):
        return _ENV_PATTERN.sub(lambda m: os.environ.get(m.group(1), m.group(2) or ""), value)
    if isinstance(value, list):
        return [expand_env(v) for v in value]
    if isinstance(value, dict):
        return {k: expand_env(v) for k, v in value.items()}
    return value


def _apply_env_overrides(raw: dict[str, Any]) -> dict[str, Any]:
    for var, (section, key) in ENV_OVERRIDES.items():
        val = os.environ.get(var)
        if val not in (None, ""):
            raw.setdefault(section, {})
            if isinstance(raw[section], dict):
                raw[section][key] = val
    return raw


def _resolve(path: str, base: Path) -> str:
    if not path:
        return path
    p = Path(path)
    return str(p if p.is_absolute() else (base / p).resolve())


def default_config_path() -> Path:
    load_dotenv(BACKEND_DIR / ".env")
    return Path(os.environ.get("PPE_CONFIG") or BACKEND_DIR / "config.yaml").resolve()


def parse_config(raw: dict[str, Any], base_dir: Path) -> AppConfig:
    """Validate a raw (un-expanded) config mapping; paths resolved against `base_dir`.

    Raises pydantic.ValidationError with field-level locations.
    """
    import copy

    data = _apply_env_overrides(expand_env(copy.deepcopy(raw or {})))
    cfg = AppConfig.model_validate(data)
    cfg.model.weights = _resolve(cfg.model.weights, base_dir)
    if cfg.model.phone_weights:
        cfg.model.phone_weights = _resolve(cfg.model.phone_weights, base_dir)
    cfg.server.static_dir = _resolve(cfg.server.static_dir, base_dir)
    cfg.alerts.db_path = _resolve(cfg.alerts.db_path, base_dir)
    for s in cfg.streams:
        if s.source.type in ("file", "images"):
            s.source.uri = _resolve(s.source.uri, base_dir)
    return cfg


def load_config(path: str | os.PathLike[str] | None = None) -> AppConfig:
    """Load config.yaml. Path precedence: argument > $PPE_CONFIG > backend/config.yaml."""
    cfg_path = Path(path).resolve() if path else default_config_path()
    load_dotenv(BACKEND_DIR / ".env")
    raw = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
    return parse_config(raw, cfg_path.parent)
