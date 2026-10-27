import type { StreamInfo, StreamStatus } from "../../types";
import type { Tone } from "../ui";

export const STATUS: Record<StreamStatus, { label: string; tone: Tone; help: string }> = {
  live: { label: "Live", tone: "ok", help: "" },
  connecting: { label: "Connecting", tone: "warn", help: "Opening the source…" },
  reconnecting: { label: "Reconnecting", tone: "warn", help: "The source dropped. Trying again." },
  stalled: { label: "Stalled", tone: "bad", help: "Frames arrive but detection results stopped. Check System health." },
  offline: { label: "Offline", tone: "bad", help: "The source can't be reached." },
  no_source: { label: "No signal", tone: "bad", help: "The source file or device is missing." },
  error: { label: "Error", tone: "bad", help: "Detection failed on this camera." },
  stopped: { label: "Stopped", tone: "neutral", help: "Detection is off for this camera." },
};

export const isProblem = (s: StreamInfo) => s.running && s.status !== "live";
