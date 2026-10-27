import type { StreamInfo, StreamStatus } from "../../types";
import type { Tone } from "../ui";

const STATUS: Record<StreamStatus, { tone: Tone; label: string }> = {
  live: { tone: "ok", label: "Live" },
  connecting: { tone: "warn", label: "Connecting" },
  reconnecting: { tone: "warn", label: "Reconnecting" },
  stalled: { tone: "warn", label: "Stalled" },
  offline: { tone: "bad", label: "Offline" },
  no_source: { tone: "bad", label: "No source" },
  error: { tone: "bad", label: "Error" },
  stopped: { tone: "neutral", label: "Stopped" },
};

/** A camera's state in words, from the monitor's live report (absent while the camera is not loaded). */
export function streamStatus(stream: StreamInfo | undefined, enabled: boolean): { tone: Tone; label: string } {
  if (!enabled && (!stream || !stream.running)) return { tone: "neutral", label: "Disabled" };
  if (!stream) return { tone: "neutral", label: "Not running" };
  if (stream.paused && stream.status === "live") return { tone: "warn", label: "Detection paused" };
  return STATUS[stream.status] ?? { tone: "neutral", label: stream.status };
}
