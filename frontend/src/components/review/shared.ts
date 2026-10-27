import type { Review, ReviewFilter, Verdict, Violation } from "../../types";

export interface Reason { id: string; label: string }
/** Used when the server does not list review reasons (older backend, or the schema call failed). */
export const FALLBACK_REASONS: Reason[] = [{ id: "other", label: "Other" }];

export const VERDICT_LABEL: Record<Verdict, string> = { valid: "Valid", false_alarm: "False alarm" };

/** The fields a review call changes on a violation. */
export interface ReviewPatch {
  review: Review | null;
  acknowledged_at: number | null;
  acknowledged_by: string | null;
}

export const matchesReview = (v: Violation, f: ReviewFilter | undefined) =>
  f === undefined || (f === "unreviewed" ? !v.review : v.review?.verdict === f);

/** True while the user is typing in a form control: single-key shortcuts must not fire. */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

/** Shortcuts are off while a dialog is open. `expected` = dialogs that host the shortcut target itself. */
export const dialogOpen = (expected = 0) => document.querySelectorAll('[role="dialog"]').length > expected;

export function b64ToBlob(b64: string, type = "image/jpeg"): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
