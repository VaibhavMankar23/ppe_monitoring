import { useState, type FormEvent } from "react";
import { Button, Field, Icon, Input } from "../components/ui";
import { ApiError } from "../lib/api";
import { navigate, takeNext } from "../lib/router";
import { useAuth } from "../state/auth";
import logoUrl from "../assets/mai-mahindra.png";

/** The company's official m·ai wordmark, shown at its natural aspect ratio.
 *  This is the company brand identity — it is never restyled, boxed into a
 *  square, or replaced. Height is set by the caller via className. */
export function BrandMark({ className = "w-14" }: { className?: string }) {
  // Explicit width + auto height (with intrinsic dims) keeps the wordmark's aspect
  // ratio and never collapses inside a shrink-to-fit flex container. Width is set
  // by the caller via className.
  return <img src={logoUrl} alt="MAI" width={200} height={86} className={`h-auto ${className}`} />;
}

/** Company logo on a clean white card — used on the tinted canvas (auth / splash)
 *  where the logo's own white background would otherwise show a faint seam. */
export function BrandCard({ className = "w-16" }: { className?: string }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-md bg-white px-2.5 py-1.5 ring-1 ring-border">
      <BrandMark className={className} />
    </span>
  );
}

/** Company logo + product name lockup: the maker (logo) · a hairline · the product. */
export function BrandLockup() {
  return (
    <div className="flex items-center gap-3">
      <BrandCard />
      <span className="h-9 w-px bg-border" aria-hidden />
      <div>
        <p className="text-[15px] font-semibold leading-tight tracking-tight">PPE Compliance</p>
        <p className="text-[13px] text-muted">Safety monitoring</p>
      </div>
    </div>
  );
}

/** Centered card layout shared by the sign-in and forced password-change screens. */
export function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <main id="main" className="flex min-h-screen items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-6"><BrandLockup /></div>
        <div className="rounded-xl border border-border bg-surface p-6 shadow-[var(--shadow-card)]">
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-[13px] text-muted">{subtitle}</p>
          <div className="mt-5">{children}</div>
        </div>
      </div>
    </main>
  );
}

export function PasswordInput({ id, value, onChange, autoComplete, invalid, autoFocus }: {
  id: string; value: string; onChange: (v: string) => void; autoComplete: string; invalid?: boolean; autoFocus?: boolean;
}) {
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  return (
    <>
      <div className="relative">
        <Input id={id} type={show ? "text" : "password"} value={value} autoComplete={autoComplete} invalid={invalid}
          autoFocus={autoFocus} className="pr-10" onChange={(e) => onChange(e.target.value)}
          onKeyUp={(e) => setCaps(e.getModifierState?.("CapsLock") ?? false)} />
        <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide password" : "Show password"}
          aria-pressed={show} className="absolute top-1/2 right-1 flex h-7 w-8 -translate-y-1/2 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-text">
          {show ? <Icon.eyeOff size={16} /> : <Icon.eye size={16} />}
        </button>
      </div>
      {caps && <p className="text-xs font-medium text-warning-text">Caps Lock is on</p>}
    </>
  );
}

export function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError("Enter your username and password.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const me = await login(username.trim(), password, remember);
      if (!me.must_change_password) navigate(takeNext(), true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Sign in" subtitle="Use the account your administrator gave you.">
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate aria-describedby={error ? "login-error" : undefined}>
        {error && (
          <div id="login-error" role="alert" className="flex gap-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2.5 text-[13px] font-medium text-danger">
            <Icon.alert size={16} className="mt-px shrink-0" />{error}
          </div>
        )}
        <Field id="login-user" label="Username">
          <Input autoFocus id="login-user" value={username} autoComplete="username" autoCapitalize="none" spellCheck={false}
            invalid={!!error && !username.trim()} onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <Field id="login-pass" label="Password">
          <PasswordInput id="login-pass" value={password} onChange={setPassword} autoComplete="current-password" invalid={!!error && !password} />
        </Field>
        <label className="flex cursor-pointer items-start gap-2.5 text-[13px]">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--color-primary)]" />
          <span>
            <span className="font-medium">Remember me</span>
            <span className="block text-xs text-muted">Stay signed in on this device for 30 days. Leave off on shared computers.</span>
          </span>
        </label>
        <Button type="submit" variant="primary" loading={busy} className="mt-1 w-full">{busy ? "Signing in…" : "Sign in"}</Button>
      </form>
    </AuthShell>
  );
}
