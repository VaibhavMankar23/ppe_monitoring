import { useState, type FormEvent } from "react";
import { AuthFrame } from "../components/admin/AuthFrame";
import { passwordAcceptable, PasswordField, PolicyChecklist } from "../components/admin/PasswordPolicy";
import { Button, Field, Notice, useToast } from "../components/ui";
import { navigate, takeNext } from "../lib/router";
import { useAuth } from "../state/auth";

/** Shown instead of the app while the account must change its password (seeded account, or an admin reset it). */
export function ForcedPasswordChange() {
  const { user, changePassword, logout } = useAuth();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const username = user?.username ?? "";
  const differs = next.length > 0 && next !== current;
  const policyOk = passwordAcceptable(next, username);
  const mismatch = confirm.length > 0 && confirm !== next;
  // never signed in before this session's sign-in means the default password; otherwise an admin reset it
  const firstTime = !user?.password_changed_at;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const problem = !current ? "Enter your current password."
      : !policyOk ? "The new password does not meet the requirements below."
      : !differs ? "The new password must be different from the current one."
      : next !== confirm ? "The two new passwords do not match."
      : null;
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next);
      toast({ tone: "success", title: "Password set", message: "Other devices signed in to this account were signed out." });
      navigate(takeNext(), true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The password could not be changed. Try again.");
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Set your own password"
      intro={firstTime
        ? <>The account <b className="font-semibold">{username}</b> still uses its starting password, so you need to choose your own before continuing.</>
        : <>An administrator reset the password for <b className="font-semibold">{username}</b>, so you need to choose your own before continuing.</>}>
      <form className="grid gap-4" onSubmit={submit} noValidate>
        {error && <Notice tone="bad">{error}</Notice>}
        {/* lets password managers attach the new password to the right account */}
        <input type="text" name="username" value={username} autoComplete="username" readOnly hidden />
        <Field label="Current password" hint="The one you just signed in with.">
          {(id) => <PasswordField id={id} value={current} onChange={setCurrent} autoComplete="current-password" autoFocus />}
        </Field>
        <div>
          <Field label="New password">
            {(id) => <PasswordField id={id} value={next} onChange={setNext} autoComplete="new-password" invalid={next.length > 0 && (!policyOk || !differs)} />}
          </Field>
          <PolicyChecklist className="mt-2" password={next} username={username}
            extra={[{ id: "differs", ok: differs, label: "Different from the current password" }]} />
        </div>
        <Field label="Confirm new password" error={mismatch ? "This does not match the new password." : null}>
          {(id) => <PasswordField id={id} value={confirm} onChange={setConfirm} autoComplete="new-password" invalid={mismatch} />}
        </Field>
        <div className="grid gap-2">
          <Button type="submit" variant="primary" loading={busy} className="w-full">Set password and continue</Button>
          <Button variant="ghost" icon="logout" loading={leaving} className="w-full"
            onClick={() => { setLeaving(true); void logout().finally(() => setLeaving(false)); }}>Sign out</Button>
        </div>
      </form>
    </AuthFrame>
  );
}
