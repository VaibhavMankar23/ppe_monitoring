import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useToast } from "../components/ui";
import { api, onAccountAction } from "../lib/api";
import { logoutRequest, onSession, onSessionExpired, refreshSession, setSession } from "../lib/auth";
import { navigate, rememberNext } from "../lib/router";
import type { Me, Permission } from "../types";

type Status = "loading" | "anonymous" | "authenticated";

interface AuthCtx {
  status: Status;
  user: Me | null;
  can: (p: Permission) => boolean;
  login: (username: string, password: string, remember: boolean) => Promise<Me>;
  logout: () => Promise<void>;
  changePassword: (current: string, next: string) => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

/** Session state for the whole app. On load, a refresh-cookie round trip restores the session. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<Me | null>(null);

  useEffect(() => onSession((s) => {
    setUser(s?.user ?? null);
    setStatus(s ? "authenticated" : "anonymous");
  }), []);

  useEffect(() => {
    void refreshSession().then((s) => { if (!s) setStatus("anonymous"); });
  }, []);

  // expired / revoked sessions: never fail silently
  useEffect(() => onSessionExpired((reason) => {
    rememberNext();
    toast({ tone: "warning", title: "Signed out", message: reason });
    navigate("login");
  }), [toast]);

  // the server says the password must change first (e.g. an admin reset it meanwhile)
  useEffect(() => onAccountAction(() => {
    void api.auth.me().then((me) => setUser(me)).catch(() => {});
  }), []);

  const login = useCallback(async (username: string, password: string, remember: boolean) => {
    const s = await api.auth.login(username, password, remember);
    setSession(s);
    return s.user;
  }, []);

  const logout = useCallback(async () => {
    await logoutRequest();
    navigate("login");
  }, []);

  const changePassword = useCallback(async (current: string, next: string) => {
    setSession(await api.auth.changePassword(current, next));
  }, []);

  const value = useMemo<AuthCtx>(() => ({
    status, user, login, logout, changePassword,
    can: (p) => !!user && !user.must_change_password && user.permissions.includes(p),
  }), [status, user, login, logout, changePassword]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth must be used inside <AuthProvider>");
  return c;
}
