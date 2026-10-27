/** Pieces both config editors (Cameras and Settings) share: save feedback, conflict handling, leave guard. */
import { useEffect, useRef } from "react";
import { ApiError, type SaveResult } from "../../lib/api";
import { setNavigationGuard } from "../../lib/router";
import type { CameraChanges, FieldError, ReloadResult } from "../../types";
import type { ToastInput } from "../ui";

/** One sentence on what a save did to the running system. */
export function summarizeReload(r: ReloadResult): string {
  const parts: string[] = [];
  if (r.restarted.length) parts.push(`restarted ${r.restarted.join(", ")}`);
  if (r.started.length) parts.push(`started ${r.started.join(", ")}`);
  if (r.stopped.length) parts.push(`stopped ${r.stopped.join(", ")}`);
  if (r.added.length) parts.push(`added ${r.added.join(", ")}`);
  if (r.removed.length) parts.push(`removed ${r.removed.join(", ")}`);
  if (r.engine_reloaded) parts.push("detection model reloaded");
  return parts.length ? `Applied: ${parts.join("; ")}.` : "Applied. No running camera needed a restart.";
}

/** Success toast for a config write, plus a warning when part of it waits for a server restart. */
export function toastSaved(toast: (t: ToastInput) => void, r: SaveResult, title: string) {
  toast({ tone: "success", title, message: summarizeReload(r.reload) });
  if (r.reload.requires_server_restart.length) {
    toast({
      tone: "warning", title: "Restart the server to finish",
      message: `${r.reload.requires_server_restart.join(", ")} only take effect after the server restarts.`,
    });
  }
}

/** The server refuses to drop cameras unless the request names them: the 409 carries the camera diff. */
export function removalRequest(e: unknown): CameraChanges | null {
  if (!(e instanceof ApiError) || e.code !== "confirm_camera_removal") return null;
  return (e.data as { cameras?: CameraChanges } | undefined)?.cameras ?? { removed: [], added: [], changed: [] };
}

/** Any other 409 on a config write: the file changed on the server after this page loaded it (stale etag). */
export const isConflict = (e: unknown) => e instanceof ApiError && e.status === 409 && e.code !== "confirm_camera_removal";

export const fieldErrors = (e: unknown): FieldError[] | null => (e instanceof ApiError && e.status === 422 ? e.fields : null);

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Cameras a pending write would remove (and add), for the confirmation dialog. */
export function CameraChangeList({ changes }: { changes: CameraChanges }) {
  return (
    <div className="flex flex-col gap-3">
      {changes.removed.length > 0 && (
        <div>
          <p className="font-medium text-ink">These cameras stop and leave the configuration. Their stored violations are kept.</p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {changes.removed.map((c) => (
              <li key={c.id} className="flex items-baseline gap-2">
                <span className="text-ink">{c.name}</span><span className="num text-xs text-ink-3">{c.id}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {changes.added.length > 0 && <p>Added: {changes.added.map((c) => c.name).join(", ")}.</p>}
      {changes.changed.length > 0 && <p>Changed: {changes.changed.map((c) => c.name).join(", ")}.</p>}
    </div>
  );
}

/** Warn before losing unsaved edits: tab close / reload, and in-app navigation. */
export function useUnsavedGuard(dirty: boolean, message: string) {
  const ref = useRef(dirty);
  ref.current = dirty;
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => { if (ref.current) e.preventDefault(); };
    window.addEventListener("beforeunload", onUnload);
    setNavigationGuard(() => !ref.current || window.confirm(message));
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      setNavigationGuard(null);
    };
  }, [message]);
}

export const fmtBytes = (b: number) =>
  b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(1)} GB` : b >= 2 ** 20 ? `${(b / 2 ** 20).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
