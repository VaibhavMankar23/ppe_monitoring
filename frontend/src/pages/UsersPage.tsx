import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { passwordAcceptable, PasswordField, PolicyChecklist } from "../components/admin/PasswordPolicy";
import { Page } from "../components/layout/Shell";
import { Button, ConfirmDialog, Dialog, Empty, Field, Icon, Input, Notice, Panel, Select, Skeleton, StatusDot, Switch, Tag, useToast } from "../components/ui";
import { api } from "../lib/api";
import { fmtAgo, fmtDateTime } from "../lib/format";
import { useAuth } from "../state/auth";
import type { Role, RolesInfo, UserRow } from "../types";

const ROLE_LABEL: Record<Role, string> = { admin: "Admin", super_admin: "Super Admin" };
const ROLE_HINT: Record<Role, string> = {
  admin: "Day-to-day operation: live view, camera control, reviewing violations, analytics and per-camera settings.",
  super_admin: "Everything an Admin can do, plus system settings, users and the audit log.",
};
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/; // same rule as the server (it stores usernames lowercase)
const message = (e: unknown) => (e instanceof Error ? e.message : "The request failed.");

type RoleOption = { id: Role; label: string };
const FALLBACK_ROLES: RoleOption[] = [{ id: "admin", label: ROLE_LABEL.admin }, { id: "super_admin", label: ROLE_LABEL.super_admin }];

function AddUserDialog({ roles, onClose, onCreated }: { roles: RoleOption[]; onClose: () => void; onCreated: (u: UserRow) => void }) {
  const formId = useId();
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<Role>("admin");
  const [password, setPassword] = useState("");
  const [mustChange, setMustChange] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = username.trim().toLowerCase();
  const nameOk = USERNAME_RE.test(name);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!nameOk) { setError("The username needs 3 to 32 characters: letters, digits, dot, underscore or hyphen, starting with a letter or digit."); return; }
    if (!passwordAcceptable(password, name)) { setError("The temporary password does not meet the requirements."); return; }
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.users.create({ username: name, password, role, must_change_password: mustChange }));
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title="Add user"
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" form={formId} variant="primary" loading={busy}>Add user</Button>
      </>}>
      <form id={formId} className="grid gap-4" onSubmit={submit} noValidate>
        {error && <Notice tone="bad">{error}</Notice>}
        <Field label="Username" hint="3 to 32 characters: letters, digits, . _ - (stored in lowercase)."
          error={username && !nameOk ? "Use 3 to 32 letters, digits, . _ or -, starting with a letter or digit." : null}>
          {(id) => <Input id={id} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" autoCapitalize="none"
            spellCheck={false} autoFocus invalid={!!username && !nameOk} />}
        </Field>
        <Field label="Role" hint={ROLE_HINT[role]}>
          {(id) => (
            <Select id={id} value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </Select>
          )}
        </Field>
        <div>
          <Field label="Temporary password" hint="You choose it, and you hand it to the person yourself. It is not shown again after this dialog closes.">
            {(id) => <PasswordField id={id} value={password} onChange={setPassword} autoComplete="new-password" invalid={!!password && !passwordAcceptable(password, name)} />}
          </Field>
          <PolicyChecklist className="mt-2" password={password} username={name} />
        </div>
        <Switch checked={mustChange} onChange={setMustChange} label="Must change at next sign-in"
          hint="The person has to set their own password before they can use the app." />
      </form>
    </Dialog>
  );
}

function ResetPasswordDialog({ user, onClose, onDone }: { user: UserRow; onClose: () => void; onDone: () => void }) {
  const formId = useId();
  const [password, setPassword] = useState("");
  const [mustChange, setMustChange] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!passwordAcceptable(password, user.username)) { setError("The temporary password does not meet the requirements."); return; }
    setBusy(true);
    setError(null);
    try {
      await api.users.resetPassword(user.id, password, mustChange);
      onDone();
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={`Reset password for ${user.username}`}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" form={formId} variant="primary" loading={busy}>Reset password</Button>
      </>}>
      <form id={formId} className="grid gap-4" onSubmit={submit} noValidate>
        {error && <Notice tone="bad">{error}</Notice>}
        <p className="text-[13px] text-ink-2">
          This signs <b className="font-semibold text-ink">{user.username}</b> out on every device. The old password stops working at once.
        </p>
        <div>
          <Field label="New temporary password" hint="You choose it, and you hand it to the person yourself.">
            {(id) => <PasswordField id={id} value={password} onChange={setPassword} autoComplete="new-password" autoFocus
              invalid={!!password && !passwordAcceptable(password, user.username)} />}
          </Field>
          <PolicyChecklist className="mt-2" password={password} username={user.username} />
        </div>
        <Switch checked={mustChange} onChange={setMustChange} label="Must change at next sign-in"
          hint="The person has to set their own password before they can use the app." />
      </form>
    </Dialog>
  );
}

function ChangeRoleDialog({ user, roles, onClose, onDone }: { user: UserRow; roles: RoleOption[]; onClose: () => void; onDone: (role: Role) => void }) {
  const formId = useId();
  const [role, setRole] = useState<Role>(user.role);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || role === user.role) return;
    setBusy(true);
    setError(null);
    try {
      await api.users.update(user.id, { role });
      onDone(role);
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={`Change role of ${user.username}`} width={420}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" form={formId} variant="primary" loading={busy} disabled={role === user.role}>Change role</Button>
      </>}>
      <form id={formId} className="grid gap-4" onSubmit={submit} noValidate>
        {error && <Notice tone="bad">{error}</Notice>}
        <Field label="Role" hint={ROLE_HINT[role]}>
          {(id) => (
            <Select id={id} value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {roles.map((r) => <option key={r.id} value={r.id}>{r.label}{r.id === user.role ? " (current)" : ""}</option>)}
            </Select>
          )}
        </Field>
        <p className="text-xs text-ink-3">The new role applies from their next request. See "What each role can do" on the Users page for the details.</p>
      </form>
    </Dialog>
  );
}

function RoleMatrix({ info, error, onRetry }: { info: RolesInfo | null; error: string | null; onRetry: () => void }) {
  return (
    <Panel>
      <details className="group">
        <summary className="flex list-none items-center gap-2 px-4 py-3 text-sm font-semibold text-ink [&::-webkit-details-marker]:hidden">
          <Icon name="chevronRight" size={14} className="shrink-0 text-ink-3 transition-transform group-open:rotate-90" />
          What each role can do
        </summary>
        <div className="border-t border-line">
          {error ? (
            <div className="p-4"><Notice tone="bad" title="The role list could not be loaded" action={<Button size="sm" icon="refresh" onClick={onRetry}>Retry</Button>}>{error}</Notice></div>
          ) : !info ? (
            <div className="grid gap-2 p-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-7" />)}</div>
          ) : (
            <>
              <div className="scroll-thin overflow-x-auto">
                <table className="table min-w-[520px]">
                  <thead>
                    <tr>
                      <th scope="col">Permission</th>
                      {info.roles.map((r) => <th key={r.id} scope="col" className="w-32 text-center">{r.label}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {info.permissions.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <span className="text-ink">{p.description}</span>
                          <span className="num ml-2 text-[11px] text-ink-3">{p.id}</span>
                        </td>
                        {info.roles.map((r) => {
                          const yes = r.permissions.includes(p.id);
                          return (
                            <td key={r.id} className="text-center">
                              <span role="img" aria-label={yes ? "Yes" : "No"} className={yes ? "inline-flex text-ok" : "inline-flex text-ink-3"}>
                                {yes ? <Icon name="check" size={16} /> : <span aria-hidden="true">–</span>}
                              </span>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="border-t border-line px-4 py-2.5 text-xs text-ink-3">
                The server checks these on every request. The app only hides what a role cannot use.
              </p>
            </>
          )}
        </div>
      </details>
    </Panel>
  );
}

type Pending = { kind: "deactivate" | "delete"; user: UserRow };

export function UsersPage() {
  const toast = useToast();
  const { user: me } = useAuth();
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roles, setRoles] = useState<RolesInfo | null>(null);
  const [rolesError, setRolesError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const [changingRole, setChangingRole] = useState<UserRow | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setUsers(await api.users.list());
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  }, []);
  const loadRoles = useCallback(() => {
    setRolesError(null);
    api.users.roles().then(setRoles).catch((e) => setRolesError(message(e)));
  }, []);
  useEffect(() => { void load(); loadRoles(); }, [load, loadRoles]);

  const roleOptions: RoleOption[] = roles?.roles.map((r) => ({ id: r.id, label: r.label })) ?? FALLBACK_ROLES;
  const roleLabel = (u: UserRow) => u.role_label ?? roleOptions.find((r) => r.id === u.role)?.label ?? ROLE_LABEL[u.role] ?? u.role;

  const activate = async (u: UserRow) => {
    setBusyId(u.id);
    try {
      await api.users.update(u.id, { is_active: true });
      toast({ tone: "success", title: "Account activated", message: `${u.username} can sign in again.` });
      await load();
    } catch (e) {
      toast({ tone: "error", title: `${u.username} was not activated`, message: message(e) });
    } finally { setBusyId(null); }
  };

  const confirmPending = async () => {
    if (!pending) return;
    const { kind, user: u } = pending;
    setBusyId(u.id);
    try {
      if (kind === "delete") {
        await api.users.remove(u.id);
        toast({ tone: "success", title: "User deleted", message: `${u.username} was removed and signed out.` });
      } else {
        await api.users.update(u.id, { is_active: false });
        toast({ tone: "success", title: "Account deactivated", message: `${u.username} can no longer sign in.` });
      }
      setPending(null);
      await load();
    } catch (e) {
      // the server's rule (own account, last Super Admin, already gone…) in its own words
      toast({ tone: "error", title: kind === "delete" ? `${u.username} was not deleted` : `${u.username} was not deactivated`, message: message(e) });
      setPending(null);
      void load();
    } finally { setBusyId(null); }
  };

  const list = users ?? [];
  const activeSupers = list.filter((u) => u.role === "super_admin" && u.is_active).length;
  const activeCount = list.filter((u) => u.is_active).length;
  const mustChange = list.filter((u) => u.must_change_password).length;
  const now = Date.now() / 1000;
  const summary = users
    ? `${users.length} account${users.length === 1 ? "" : "s"}, ${activeCount} active${mustChange ? `, ${mustChange} still to set their own password` : ""}.`
    : "Accounts that can sign in to this system.";

  return (
    <Page title="Users & roles" description={summary}
      actions={<Button variant="accent" icon="plus" onClick={() => setAdding(true)}>Add user</Button>}>
      <div className="grid gap-4">
        {error && users && (
          <Notice tone="warn" title="The list could not be refreshed" action={<Button size="sm" icon="refresh" onClick={() => void load()}>Retry</Button>}>{error}</Notice>
        )}
        <Panel>
          {error && !users ? (
            <div className="p-4">
              <Notice tone="bad" title="Users could not be loaded" action={<Button size="sm" icon="refresh" onClick={() => void load()}>Retry</Button>}>{error}</Notice>
            </div>
          ) : !users ? (
            <div className="grid gap-2 p-4" role="status" aria-label="Loading users">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-9" />)}</div>
          ) : users.length === 0 ? (
            <Empty icon="users" title="No accounts yet" action={<Button variant="accent" icon="plus" onClick={() => setAdding(true)}>Add user</Button>}>
              Add the first account so someone can sign in.
            </Empty>
          ) : (
            <div className="scroll-thin overflow-x-auto">
              <table className="table min-w-[1040px]">
                <thead>
                  <tr>
                    <th>Username</th><th>Role</th><th>Status</th><th>Password</th>
                    <th className="text-right">Sessions</th><th>Last sign-in</th><th>Created</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => {
                    const self = u.id === me?.id;
                    const lastSuper = u.role === "super_admin" && u.is_active && activeSupers <= 1;
                    const busy = busyId === u.id;
                    const selfWhy = "You can't do this to your own account";
                    const lastWhy = "This is the last active Super Admin: promote someone else first";
                    const block = self ? selfWhy : lastSuper ? lastWhy : undefined;
                    return (
                      <tr key={u.id}>
                        <td>
                          <span className="flex items-center gap-2 whitespace-nowrap">
                            <span className={u.is_active ? "font-medium text-ink" : "font-medium text-ink-3"}>{u.username}</span>
                            {self && <Tag tone="accent">You</Tag>}
                          </span>
                        </td>
                        <td><Tag tone={u.role === "super_admin" ? "accent" : "neutral"} icon={u.role === "super_admin" ? "shield" : undefined}>{roleLabel(u)}</Tag></td>
                        <td>
                          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                            <StatusDot tone={u.is_active ? "ok" : "neutral"} />{u.is_active ? "Active" : "Deactivated"}
                          </span>
                        </td>
                        <td>
                          {u.must_change_password
                            ? <Tag tone="warn" icon="key" title="This person must set their own password at the next sign-in">Must change</Tag>
                            : <span className="text-ink-3">Set by user</span>}
                        </td>
                        <td className="num text-right">{u.active_sessions ?? 0}</td>
                        <td className="whitespace-nowrap">
                          {u.last_login ? <span className="num" title={fmtDateTime(u.last_login)}>{fmtAgo(u.last_login, now)}</span> : <span className="text-ink-3">Never</span>}
                        </td>
                        <td className="num whitespace-nowrap text-ink-2">{fmtDateTime(u.created_at)}</td>
                        <td>
                          <div className="flex justify-end gap-1">
                            <Button size="sm" variant="ghost" disabled={busy || self || lastSuper} title={block}
                              aria-label={`Change role of ${u.username}`} onClick={() => setChangingRole(u)}>Change role</Button>
                            {u.is_active ? (
                              <Button size="sm" variant="ghost" disabled={busy || self || lastSuper} title={block}
                                aria-label={`Deactivate ${u.username}`} onClick={() => setPending({ kind: "deactivate", user: u })}>Deactivate</Button>
                            ) : (
                              <Button size="sm" variant="ghost" loading={busy} aria-label={`Activate ${u.username}`} onClick={() => void activate(u)}>Activate</Button>
                            )}
                            <Button size="sm" variant="ghost" icon="key" disabled={busy}
                              aria-label={`Reset password for ${u.username}`} onClick={() => setResetting(u)}>Reset password</Button>
                            <Button size="sm" variant="ghost" icon="trash" disabled={busy || self || lastSuper} title={block}
                              className="text-bad hover:text-bad" aria-label={`Delete ${u.username}`} onClick={() => setPending({ kind: "delete", user: u })}>Delete</Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <RoleMatrix info={roles} error={rolesError} onRetry={loadRoles} />
      </div>

      {adding && (
        <AddUserDialog roles={roleOptions} onClose={() => setAdding(false)} onCreated={(u) => {
          setAdding(false);
          toast({
            tone: "success", title: "User added",
            message: `${u.username} can sign in with the temporary password you typed${u.must_change_password ? " and will be asked to set their own" : ""}.`,
          });
          void load();
        }} />
      )}
      {resetting && (
        <ResetPasswordDialog user={resetting} onClose={() => setResetting(null)} onDone={() => {
          toast({ tone: "success", title: "Password reset", message: `${resetting.username} was signed out on every device.` });
          setResetting(null);
          void load();
        }} />
      )}
      {changingRole && (
        <ChangeRoleDialog user={changingRole} roles={roleOptions} onClose={() => setChangingRole(null)} onDone={(role) => {
          toast({ tone: "success", title: "Role changed", message: `${changingRole.username} is now ${roleOptions.find((r) => r.id === role)?.label ?? role}.` });
          setChangingRole(null);
          void load();
        }} />
      )}
      <ConfirmDialog open={!!pending} danger busy={!!pending && busyId === pending.user.id} onClose={() => setPending(null)} onConfirm={() => void confirmPending()}
        title={pending?.kind === "delete" ? `Delete ${pending.user.username}?` : `Deactivate ${pending?.user.username ?? "user"}?`}
        confirmLabel={pending?.kind === "delete" ? "Delete user" : "Deactivate user"}>
        {pending?.kind === "delete"
          ? "The account is removed for good and signed out everywhere. Its audit log entries are kept. To block access but keep the account, deactivate it instead."
          : "The account stays in the list but can no longer sign in, and its sessions end. You can activate it again at any time."}
      </ConfirmDialog>
    </Page>
  );
}
