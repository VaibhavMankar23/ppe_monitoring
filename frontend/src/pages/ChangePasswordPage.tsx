import { useState, type FormEvent } from "react";
import { Button, Field, Icon, Modal, useToast } from "../components/ui";
import { ApiError } from "../lib/api";
import { navigate, takeNext } from "../lib/router";
import { useAuth } from "../state/auth";
import { AuthShell, PasswordInput } from "./LoginPage";

/** Client-side mirror of the server's password policy (security.password_problems) for instant feedback. */
export function passwordChecks(pw: string, username: string) {
  return [
    { ok: pw.length >= 8, label: "At least 8 characters" },
    { ok: /[A-Za-z]/.test(pw) && /\d/.test(pw), label: "Contains a letter and a digit" },
    { ok: !!pw && pw.toLowerCase() !== username.toLowerCase(), label: "Not the same as your username" },
    { ok: new TextEncoder().encode(pw).length <= 72, label: "At most 72 bytes" },
  ];
}

export function PolicyList({ password, username }: { password: string; username: string }) {
  return (
    <ul className="flex flex-col gap-1 text-xs" aria-label="Password requirements">
      {passwordChecks(password, username).map((c) => (
        <li key={c.label} className={`flex items-center gap-1.5 ${c.ok ? "text-success-text" : "text-muted"}`}>
          {c.ok ? <Icon.check size={13} /> : <span className="inline-block h-[13px] w-[13px] text-center leading-[13px]">•</span>}
          {c.label}
        </li>
      ))}
    </ul>
  );
}

function ChangePasswordForm({ forced, onDone, onCancel }: { forced: boolean; onDone: () => void; onCancel?: () => void }) {
  const { user, changePassword } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const username = user?.username ?? "";
  const policyOk = passwordChecks(next, username).every((c) => c.ok);
  const mismatch = confirm.length > 0 && confirm !== next;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!current || !policyOk || next !== confirm) {
      setError(!current ? "Enter your current password." : !policyOk ? "The new password doesn't meet the requirements." : "The passwords don't match.");
      return;
    }
    if (next === current) { setError("The new password must be different from the current one."); return; }
    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      {error && (
        <div role="alert" className="flex gap-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2.5 text-[13px] font-medium text-danger">
          <Icon.alert size={16} className="mt-px shrink-0" />{error}
        </div>
      )}
      <input type="text" name="username" value={username} autoComplete="username" readOnly hidden />
      <Field id="cp-current" label={forced ? "Current (temporary) password" : "Current password"}>
        <PasswordInput id="cp-current" value={current} onChange={setCurrent} autoComplete="current-password" autoFocus />
      </Field>
      <Field id="cp-new" label="New password">
        <PasswordInput id="cp-new" value={next} onChange={setNext} autoComplete="new-password" invalid={!!next && !policyOk} />
      </Field>
      <PolicyList password={next} username={username} />
      <Field id="cp-confirm" label="Confirm new password" error={mismatch ? "Passwords don't match" : undefined}>
        <PasswordInput id="cp-confirm" value={confirm} onChange={setConfirm} autoComplete="new-password" invalid={mismatch} />
      </Field>
      <div className="mt-1 flex gap-2">
        {onCancel && <Button onClick={onCancel} className="flex-1">{forced ? "Sign out" : "Cancel"}</Button>}
        <Button type="submit" variant="primary" loading={busy} className="flex-1">Change password</Button>
      </div>
      <p className="text-xs text-muted">Changing your password signs you out on every other device.</p>
    </form>
  );
}

/** Shown instead of the app while the account must change its password (seeded admin, admin reset). */
export function ForcedPasswordChange() {
  const { user, logout } = useAuth();
  const toast = useToast();
  return (
    <AuthShell title="Set a new password"
      subtitle={`Hi ${user?.username}. Your account uses a temporary password. Choose your own to continue. This step can't be skipped.`}>
      <ChangePasswordForm forced onCancel={() => void logout()}
        onDone={() => {
          toast({ tone: "success", title: "Password changed", message: "Welcome! Your new password is active." });
          navigate(takeNext(), true);
        }} />
    </AuthShell>
  );
}

export function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  return (
    <Modal open={open} onClose={onClose} title="Change password" size="sm">
      <div className="px-5 py-4">
        {open && <ChangePasswordForm forced={false} onCancel={onClose}
          onDone={() => { toast({ tone: "success", title: "Password changed" }); onClose(); }} />}
      </div>
    </Modal>
  );
}
