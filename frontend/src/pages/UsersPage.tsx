import { useCallback, useEffect, useState, type FormEvent } from "react";
import { PageBody } from "../components/layout/PageBody";
import { Topbar } from "../components/layout/Topbar";
import { Badge, Button, Card, CardHeader, ConfirmModal, EmptyState, Field, Icon, Input, Modal, Select, Skeleton, useToast } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { fmtDateTime } from "../lib/format";
import { useAuth } from "../state/auth";
import type { Role, RolesInfo, UserRow } from "../types";
import { passwordChecks, PolicyList } from "./ChangePasswordPage";

const ROLE_LABEL: Record<Role, string> = { admin: "Admin", super_admin: "Super Admin" };

/** Readable random temporary password (no look-alike characters), always passes the policy. */
function generatePassword(): string {
  const letters = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ";
  const digits = "23456789";
  const all = letters + digits;
  const r = new Uint32Array(12);
  crypto.getRandomValues(r);
  const chars = Array.from(r, (n) => all[n % all.length]);
  chars[3] = digits[r[3] % digits.length];
  chars[8] = letters[r[8] % letters.length];
  return chars.join("");
}

function PasswordWithGenerate({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex gap-2">
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="new-password" className="font-mono" spellCheck={false} />
      <Button onClick={() => onChange(generatePassword())} title="Generate a random password">Generate</Button>
    </div>
  );
}

function CreateUserModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (u: UserRow, pw: string) => void }) {
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<Role>("admin");
  const [password, setPassword] = useState("");
  const [mustChange, setMustChange] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) { setUsername(""); setRole("admin"); setPassword(generatePassword()); setMustChange(true); setError(null); }
  }, [open]);
  const policyOk = passwordChecks(password, username).every((c) => c.ok);
  const nameOk = /^[a-z0-9][a-z0-9._-]{2,31}$/.test(username.trim().toLowerCase());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!nameOk || !policyOk) { setError(!nameOk ? "Username: 3–32 characters, letters, digits, . _ -" : "The password doesn't meet the requirements."); return; }
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.users.create({ username: username.trim(), password, role, must_change_password: mustChange }), password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="Create user" subtitle="Share the temporary password with the person over a safe channel." size="sm">
      <form className="flex flex-col gap-4 px-5 py-4" onSubmit={submit} noValidate>
        {error && <p role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] font-medium text-danger">{error}</p>}
        <Field id="nu-name" label="Username" hint="3–32 characters: letters, digits, . _ - (stored lowercase)">
          <Input id="nu-name" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" autoFocus spellCheck={false} invalid={!!username && !nameOk} />
        </Field>
        <Field id="nu-role" label="Role" hint={role === "super_admin" ? "Full control, including users, system settings and the audit log." : "Operations: dashboards, violations, analytics, per-camera settings."}>
          <Select id="nu-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="admin">Admin</option>
            <option value="super_admin">Super Admin</option>
          </Select>
        </Field>
        <Field id="nu-pass" label="Temporary password"><PasswordWithGenerate id="nu-pass" value={password} onChange={setPassword} /></Field>
        <PolicyList password={password} username={username} />
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={mustChange} onChange={(e) => setMustChange(e.target.checked)} className="h-4 w-4 accent-[var(--color-primary)]" />
          Require a password change at first sign-in (recommended)
        </label>
        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} icon={<Icon.plus size={15} />}>Create user</Button>
        </div>
      </form>
    </Modal>
  );
}

function ResetPasswordModal({ user, onClose, onDone }: { user: UserRow | null; onClose: () => void; onDone: (pw: string) => void }) {
  const [password, setPassword] = useState("");
  const [mustChange, setMustChange] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (user) { setPassword(generatePassword()); setMustChange(true); setError(null); } }, [user]);
  if (!user) return null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try { await api.users.resetPassword(user.id, password, mustChange); onDone(password); }
    catch (err) { setError(err instanceof ApiError ? err.message : (err as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Reset password for ${user.username}`} subtitle="All of their current sessions are signed out." size="sm">
      <form className="flex flex-col gap-4 px-5 py-4" onSubmit={submit} noValidate>
        {error && <p role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] font-medium text-danger">{error}</p>}
        <Field id="rp-pass" label="New temporary password"><PasswordWithGenerate id="rp-pass" value={password} onChange={setPassword} /></Field>
        <PolicyList password={password} username={user.username} />
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={mustChange} onChange={(e) => setMustChange(e.target.checked)} className="h-4 w-4 accent-[var(--color-primary)]" />
          Force a password change at next sign-in
        </label>
        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} icon={<Icon.key size={15} />}>Reset password</Button>
        </div>
      </form>
    </Modal>
  );
}

function RoleMatrix({ info }: { info: RolesInfo | null }) {
  if (!info) return <Card className="p-5"><Skeleton className="h-40" /></Card>;
  return (
    <Card>
      <CardHeader title="Role permissions" description="Enforced by the server on every request; the interface only hides what a role can't use." />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-[13px]">
          <thead className="bg-subtle text-xs text-muted uppercase">
            <tr><th className="px-5 py-2.5 font-medium">Permission</th>{info.roles.map((r) => <th key={r.id} className="w-32 px-3 py-2.5 text-center font-medium">{r.label}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-border">
            {info.permissions.map((p) => (
              <tr key={p.id}>
                <td className="px-5 py-2.5"><span className="font-medium">{p.description}</span> <span className="font-mono text-xs text-muted">{p.id}</span></td>
                {info.roles.map((r) => (
                  <td key={r.id} className="px-3 py-2.5 text-center">
                    {r.permissions.includes(p.id)
                      ? <Icon.check size={16} className="mx-auto text-success-text" aria-label="allowed" />
                      : <span className="text-muted" aria-label="not allowed">–</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function UsersPage() {
  const toast = useToast();
  const { user: me } = useAuth();
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [roles, setRoles] = useState<RolesInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const [deleting, setDeleting] = useState<UserRow | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [revealed, setRevealed] = useState<{ username: string; password: string } | null>(null);

  const load = useCallback(() => {
    setError(null);
    api.users.list().then(setUsers).catch((e) => setError((e as Error).message));
  }, []);
  useEffect(() => { load(); api.users.roles().then(setRoles).catch(() => {}); }, [load]);

  const patch = async (u: UserRow, change: { role?: Role; is_active?: boolean }, what: string) => {
    setBusyId(u.id);
    try {
      await api.users.update(u.id, change);
      toast({ tone: "success", title: what, message: u.username });
      load();
    } catch (e) {
      toast({ tone: "error", title: `${what} failed`, message: (e as Error).message });
    } finally { setBusyId(null); }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusyId(deleting.id);
    try {
      await api.users.remove(deleting.id);
      toast({ tone: "success", title: "User deleted", message: deleting.username });
      setDeleting(null);
      load();
    } catch (e) {
      toast({ tone: "error", title: "Delete failed", message: (e as Error).message });
    } finally { setBusyId(null); }
  };

  const activeSupers = (users ?? []).filter((u) => u.role === "super_admin" && u.is_active).length;

  return (
    <>
      <Topbar title="Users" subtitle={users ? `${users.length} account${users.length === 1 ? "" : "s"} · Super Admin only` : "Loading…"}
        extra={<Button variant="primary" icon={<Icon.plus size={15} />} onClick={() => setCreating(true)}>Create user</Button>} />
      <PageBody>
        <div className="flex flex-col gap-6">
          {revealed && (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-[13px]" role="status">
              <Icon.key size={16} className="text-warning-text" />
              <span>Temporary password for <b>{revealed.username}</b>: <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-sm">{revealed.password}</code>. It is shown only once.</span>
              <Button size="sm" className="ml-auto" onClick={() => { void navigator.clipboard?.writeText(revealed.password); toast({ tone: "info", title: "Copied to clipboard" }); }}>Copy</Button>
              <Button size="sm" variant="ghost" onClick={() => setRevealed(null)}>Dismiss</Button>
            </div>
          )}
          <Card>
            {error ? (
              <EmptyState icon={<Icon.alert size={20} />} title="Couldn't load users" message={error} action={<Button onClick={load}>Try again</Button>} />
            ) : !users ? (
              <div className="flex flex-col gap-3 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10" />)}</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-left text-[13px]">
                  <thead className="bg-subtle text-xs text-muted uppercase">
                    <tr>
                      <th className="px-5 py-2.5 font-medium">User</th>
                      <th className="px-3 py-2.5 font-medium">Role</th>
                      <th className="px-3 py-2.5 font-medium">Status</th>
                      <th className="px-3 py-2.5 font-medium">Last sign-in</th>
                      <th className="px-3 py-2.5 font-medium">Sessions</th>
                      <th className="px-5 py-2.5 text-right font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {users.map((u) => {
                      const self = u.id === me?.id;
                      const lastSuper = u.role === "super_admin" && u.is_active && activeSupers <= 1;
                      const busy = busyId === u.id;
                      return (
                        <tr key={u.id} className={u.is_active ? "" : "bg-subtle/50 text-muted"}>
                          <td className="px-5 py-3">
                            <div className="flex items-center gap-2">
                              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-subtle text-[11px] font-semibold ring-1 ring-border">{u.username.slice(0, 2).toUpperCase()}</span>
                              <span className="font-medium text-text">{u.username}</span>
                              {self && <Badge tone="primary">You</Badge>}
                            </div>
                            <p className="mt-0.5 pl-9 text-xs text-muted">Created {fmtDateTime(u.created_at)}</p>
                          </td>
                          <td className="px-3 py-3">
                            <Select aria-label={`Role of ${u.username}`} value={u.role} disabled={self || busy || (lastSuper && u.role === "super_admin")}
                              title={self ? "You can't change your own role" : lastSuper ? "Last active Super Admin: promote someone else first" : undefined}
                              onChange={(e) => void patch(u, { role: e.target.value as Role }, "Role changed")} className="h-8 w-36 min-w-36">
                              <option value="admin">{ROLE_LABEL.admin}</option>
                              <option value="super_admin">{ROLE_LABEL.super_admin}</option>
                            </Select>
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex flex-wrap gap-1">
                              {u.is_active ? <Badge tone="success" dot>Active</Badge> : <Badge dot>Deactivated</Badge>}
                              {u.must_change_password && <Badge tone="warning">Must change password</Badge>}
                            </div>
                          </td>
                          <td className="px-3 py-3 tabular-nums">{u.last_login ? fmtDateTime(u.last_login) : <span className="text-muted">Never</span>}</td>
                          <td className="px-3 py-3 tabular-nums">{u.active_sessions ?? 0}</td>
                          <td className="px-5 py-3">
                            <div className="flex justify-end gap-1">
                              <Button size="sm" variant="ghost" icon={<Icon.key size={14} />} onClick={() => setResetting(u)} disabled={busy}>Reset password</Button>
                              <Button size="sm" variant="ghost" disabled={self || busy || (lastSuper && u.is_active)}
                                title={self ? "You can't deactivate yourself" : lastSuper ? "Last active Super Admin" : undefined}
                                onClick={() => void patch(u, { is_active: !u.is_active }, u.is_active ? "User deactivated" : "User reactivated")}>
                                {u.is_active ? "Deactivate" : "Activate"}
                              </Button>
                              <Button size="sm" variant="danger-ghost" icon={<Icon.trash size={14} />} disabled={self || busy || lastSuper}
                                aria-label={`Delete ${u.username}`} onClick={() => setDeleting(u)}>Delete</Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <RoleMatrix info={roles} />
        </div>
      </PageBody>

      <CreateUserModal open={creating} onClose={() => setCreating(false)} onCreated={(u, pw) => {
        setCreating(false);
        setRevealed({ username: u.username, password: pw });
        toast({ tone: "success", title: "User created", message: `${u.username} · ${ROLE_LABEL[u.role]}` });
        load();
      }} />
      <ResetPasswordModal user={resetting} onClose={() => setResetting(null)} onDone={(pw) => {
        setRevealed({ username: resetting!.username, password: pw });
        toast({ tone: "success", title: "Password reset", message: `${resetting!.username} was signed out everywhere.` });
        setResetting(null);
        load();
      }} />
      <ConfirmModal open={!!deleting} danger busy={busyId === deleting?.id} title={`Delete ${deleting?.username}?`} confirmLabel="Delete user"
        message="The account is removed permanently and signed out everywhere. Their audit-log entries are kept. To keep the account but block access, deactivate it instead."
        onConfirm={remove} onCancel={() => setDeleting(null)} />
    </>
  );
}
