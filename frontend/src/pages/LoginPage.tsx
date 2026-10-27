import { useEffect, useState, type FormEvent } from "react";
import { AuthFrame } from "../components/admin/AuthFrame";
import { PasswordField } from "../components/admin/PasswordPolicy";
import { Button, Field, Input, Notice } from "../components/ui";
import { ApiError } from "../lib/api";
import { navigate, takeNext } from "../lib/router";
import { useAuth } from "../state/auth";

/** Seconds the server asks to wait ("… Try again in 42 s."); null when it does not say. */
function waitSeconds(err: ApiError): number | null {
  const m = /(\d+)\s*s\b/.exec(err.message);
  return m ? Number(m[1]) : null;
}

export function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  // too many failed attempts: the server locks this username for a while
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (lockedUntil === null) return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [lockedUntil]);

  const wait = lockedUntil === null ? 0 : Math.max(0, Math.ceil((lockedUntil - now) / 1000));
  useEffect(() => {
    if (lockedUntil !== null && wait === 0) {
      setLockedUntil(null);
      setError(null); // the server's "try again in N s" no longer applies
    }
  }, [lockedUntil, wait]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || wait > 0) return;
    if (!username.trim() || !password) {
      setMissing(true);
      setError("Enter your username and password.");
      return;
    }
    setMissing(false);
    setBusy(true);
    setError(null);
    try {
      const me = await login(username.trim(), password, remember);
      // an account that must change its password is taken to that screen by the app instead
      if (!me.must_change_password) navigate(takeNext(), true);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 429 || err.code === "too_many_attempts")) {
        const s = waitSeconds(err);
        if (s !== null) {
          setNow(Date.now());
          setLockedUntil(Date.now() + s * 1000);
        }
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : "Sign-in failed. Try again.");
      }
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  const locked = wait > 0;
  return (
    <AuthFrame title="Welcome back" intro="Sign in with the account your plant administrator gave you."
      footer="Repeated wrong passwords lock the account for a short while. Sign-ins and changes are recorded in the audit trail.">
      <form className="grid gap-4" onSubmit={submit} noValidate>
        {locked ? (
          <Notice tone="bad" title="Too many failed sign-in attempts">
            Try again in <span className="num">{wait} s</span>.
          </Notice>
        ) : error && <Notice tone="bad">{error}</Notice>}
        <Field label="Username">
          {(id) => (
            <Input id={id} name="username" value={username} autoComplete="username" autoCapitalize="none" autoCorrect="off"
              spellCheck={false} autoFocus invalid={missing && !username.trim()} onChange={(e) => setUsername(e.target.value)} />
          )}
        </Field>
        <Field label="Password">
          {(id) => <PasswordField id={id} value={password} onChange={setPassword} autoComplete="current-password" invalid={missing && !password} />}
        </Field>
        <label className="flex cursor-pointer items-start gap-2.5 text-[13.5px] text-ink">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="mt-0.5 size-4 accent-[var(--pri)]" />
          <span>
            Keep me signed in on this device
            <span className="block text-xs text-ink-3">For 30 days. Leave off on a shared computer.</span>
          </span>
        </label>
        <Button type="submit" variant="primary" loading={busy} disabled={locked} className="h-[46px] w-full text-[14.5px]">Sign in</Button>
      </form>
    </AuthFrame>
  );
}
