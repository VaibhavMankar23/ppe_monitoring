import { useState } from "react";
import { cx, Icon, IconButton, Input } from "../ui";

/*
 * Client-side mirror of backend/app/security.py `password_problems` (instant feedback only: the
 * server stays the authority and its message is shown when it disagrees).
 */
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_BYTES = 72;

export interface PolicyCheck { id: string; ok: boolean; label: string }

export function passwordChecks(password: string, username = ""): PolicyCheck[] {
  const typed = password.length > 0;
  const name = username.trim();
  const checks: PolicyCheck[] = [
    { id: "length", ok: [...password].length >= MIN_PASSWORD_LENGTH, label: `At least ${MIN_PASSWORD_LENGTH} characters` },
    { id: "mix", ok: /\p{L}/u.test(password) && /\p{Nd}/u.test(password), label: "At least one letter and one digit" },
    { id: "bytes", ok: typed && new TextEncoder().encode(password).length <= MAX_PASSWORD_BYTES, label: `At most ${MAX_PASSWORD_BYTES} bytes long` },
    { id: "username", ok: typed && (!name || password.toLowerCase() !== name.toLowerCase()), label: "Not the same as the username" },
  ];
  return checks;
}

export const passwordAcceptable = (password: string, username = "") => passwordChecks(password, username).every((c) => c.ok);

/** Live checklist of the password policy. `extra` adds screen-specific rules (e.g. "differs from the current one"). */
export function PolicyChecklist({ password, username, extra = [], className }:
  { password: string; username?: string; extra?: PolicyCheck[]; className?: string }) {
  const checks = [...passwordChecks(password, username), ...extra];
  return (
    <ul aria-label="Password requirements" className={cx("grid gap-1 text-xs", className)}>
      {checks.map((c) => (
        <li key={c.id} className={cx("flex items-center gap-1.5", c.ok ? "text-ok" : "text-ink-3")}>
          <span className="flex size-3.5 shrink-0 items-center justify-center">
            {c.ok ? <Icon name="check" size={13} /> : <span aria-hidden="true" className="size-1 rounded-full bg-ink-3" />}
          </span>
          <span>{c.label}</span>
          <span className="sr-only">{c.ok ? "(met)" : "(not met yet)"}</span>
        </li>
      ))}
    </ul>
  );
}

/** Password input with a show/hide toggle and a Caps Lock hint. */
export function PasswordField({ id, value, onChange, autoComplete, invalid, autoFocus, disabled }: {
  id: string; value: string; onChange: (v: string) => void; autoComplete: "current-password" | "new-password";
  invalid?: boolean; autoFocus?: boolean; disabled?: boolean;
}) {
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const readCaps = (e: React.KeyboardEvent<HTMLInputElement>) => setCaps(e.getModifierState?.("CapsLock") ?? false);
  return (
    <>
      <div className="relative">
        <Input id={id} type={show ? "text" : "password"} value={value} autoComplete={autoComplete} invalid={invalid}
          autoFocus={autoFocus} disabled={disabled} spellCheck={false} autoCapitalize="none" className="pr-10"
          onChange={(e) => onChange(e.target.value)} onKeyDown={readCaps} onKeyUp={readCaps} onBlur={() => setCaps(false)} />
        <IconButton icon={show ? "eyeOff" : "eye"} label={show ? "Hide password" : "Show password"} aria-pressed={show}
          size={28} className="absolute top-1 right-1" onClick={() => setShow((s) => !s)} />
      </div>
      {caps && <p role="status" className="mt-1 text-xs font-medium text-warn">Caps Lock is on</p>}
    </>
  );
}
