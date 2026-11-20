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

/** Why a camera is not working, in plain words, with what to do about it. */
export interface Problem {
  title: string;
  fix: string;
  /** where in the camera editor the fix is made */
  tab?: "source" | "rules";
}

/** Match the server's wording of a connection problem. `null` = not recognised: show the server's text as it is. */
export function explainMessage(message: string | undefined | null): Problem | null {
  const m = (message ?? "").toLowerCase();
  if (!m) return null;
  if (m.includes("can't be decrypted") || m.includes("cannot be decrypted"))
    return {
      title: "The saved camera password can't be unlocked",
      fix: "It was saved under a different secret key than the one this server uses now (PPE_SECRET_KEY in the .env file). Put the old key back and restart the server, or enter this camera's password again and save.",
      tab: "source",
    };
  if (m.includes("secret_key") || m.includes("ppe_secret"))
    return { title: "The server has no secret key to store passwords with", fix: "Set PPE_SECRET_KEY in the .env file and restart the server. Then enter the camera password again." };
  if (m.includes("401") || m.includes("unauthor") || m.includes("authentication") || m.includes("sign-in") || m.includes("login") || m.includes("credentials") || m.includes("forbidden"))
    return { title: "The camera rejected the sign-in", fix: "Check the username and password. Some cameras also limit how many people can watch at once or only allow certain addresses.", tab: "source" };
  if (m.includes("refused or not found"))
    return { title: "The camera did not answer", fix: "Check the IP address and port (554 for RTSP), that the camera is switched on, and that this server can reach the camera's network.", tab: "source" };
  if (m.includes("within") && m.includes("cannot connect"))
    return { title: "The camera took too long to answer", fix: "Check the address and path, and that the network between this server and the camera is not blocked or overloaded.", tab: "source" };
  if (m.includes("not found on the server") || m.includes("outside the videos folder") || m.includes("must be inside"))
    return { title: "The file is not on the server", fix: "Choose a video from the list, or upload it. Files must be in the server's videos folder.", tab: "source" };
  if (m.includes("unsupported codec") || m.includes("damaged"))
    return { title: "The video can't be read", fix: "The file is damaged or uses a format this server can't decode. Export it again from the recorder.", tab: "source" };
  if (m.includes("ffmpeg is not installed"))
    return { title: "This server can't read rtsps:// cameras", fix: "ffmpeg is missing on the server. Use an rtsp:// address, or install ffmpeg." };
  if (m.includes("inference error") || m.includes("processing error"))
    return { title: "The detector failed on this camera", fix: "The video arrives, but detection stops. Open System health, and check the server log for the error." };
  return null;
}

/** Same, from a camera's live state; `null` while the camera is fine, still starting, or switched off. */
export function explainProblem(stream: StreamInfo | undefined): Problem | null {
  if (!stream || !stream.running) return null;
  if (stream.status !== "offline" && stream.status !== "error" && stream.status !== "no_source") return null;
  return explainMessage(stream.message);
}
