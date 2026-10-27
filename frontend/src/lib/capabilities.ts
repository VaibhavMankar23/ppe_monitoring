import type { Capabilities } from "../types";

/** "Is this PPE item actually checked by the loaded model?" - from the server's capability report
 *  (the same logic that marks a camera's unchecked items), never a hard-coded list. Unknown (no report
 *  yet / no model loaded) counts as checked, so nothing is flagged by mistake. */
export function isChecked(item: string, caps: Capabilities | undefined | null): boolean {
  return !caps?.ppe_supported || caps.ppe_supported.includes(item);
}

/** Phone detection needs BOTH the camera toggle and a (global) phone model. Returns why it isn't
 *  running for a camera that asked for it, or null when it is / can be. `draftWeights` = the Model
 *  section's current value, `savedWeights` = the saved one: while they're equal the server's report
 *  decides (it knows what `${PPE_PHONE_WEIGHTS:-}`-style placeholders expand to). */
export function phoneProblem(draftWeights: string | undefined, caps: Capabilities | undefined | null, savedWeights?: string): string | null {
  const draft = (draftWeights ?? "").trim();
  const unchanged = savedWeights === undefined || draftWeights === savedWeights;
  const configured = unchanged && caps ? caps.phone.configured : draft !== "" && !/^\$\{[^}]*:-\}$/.test(draft);
  if (!configured) {
    return "No phone model is configured. Set one (e.g. ../models/coco/yolov8n.pt) in Settings → Detection model — it runs as an additional detector alongside the PPE model.";
  }
  if (unchanged && caps?.phone.load_failed) {
    return "The phone model is set but couldn't be loaded (missing file, or no phone class). Check the server log.";
  }
  return null;
}
