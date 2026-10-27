import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { Page, Shell } from "./components/layout/Shell";
import { Button, Empty, Panel, Spinner } from "./components/ui";
import { navigate, rememberNext, ROUTE_PERMISSION, useRoute, type Route } from "./lib/router";
import { AuditPage } from "./pages/AuditPage";
import { CamerasPage } from "./pages/CamerasPage";
import { ForcedPasswordChange } from "./pages/ChangePasswordPage";
import { LivePage } from "./pages/LivePage";
import { LoginPage } from "./pages/LoginPage";
import { OverviewPage } from "./pages/OverviewPage";
import { ReviewPage } from "./pages/ReviewPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SystemPage } from "./pages/SystemPage";
import { UsersPage } from "./pages/UsersPage";
import { useAuth } from "./state/auth";
import { MonitorProvider } from "./state/monitor";

// the chart library is large: Analytics (and it) load only when opened
const AnalyticsPage = lazy(() => import("./pages/AnalyticsPage").then((m) => ({ default: m.AnalyticsPage })));

type PageRoute = Exclude<Route, "login">;
const PAGES: Record<PageRoute, () => ReactNode> = {
  overview: () => <OverviewPage />,
  monitoring: () => <LivePage />,
  incidents: () => <ReviewPage />,
  reports: () => (
    <Suspense fallback={<div className="flex h-64 items-center justify-center text-ink-3"><Spinner size={20} /></div>}>
      <AnalyticsPage />
    </Suspense>
  ),
  devices: () => <CamerasPage />,
  settings: () => <SettingsPage />,
  system: () => <SystemPage />,
  users: () => <UsersPage />,
  audit: () => <AuditPage />,
};

function Guarded({ route }: { route: PageRoute }) {
  const { can } = useAuth();
  if (can(ROUTE_PERMISSION[route])) return <>{PAGES[route]()}</>;
  return (
    <Page title="No access">
      <Panel>
        <Empty icon="lock" title="Your role can't open this page"
          action={<Button variant="primary" onClick={() => navigate("overview")}>Go to Overview</Button>}>
          It is limited to Super Admins. Ask one of them if you need it.
        </Empty>
      </Panel>
    </Page>
  );
}

export default function App() {
  const { status, user } = useAuth();
  const route = useRoute();

  // signed out on a protected URL: remember it, show the sign-in page, come back after
  useEffect(() => {
    if (status === "anonymous" && route !== "login") {
      rememberNext();
      navigate("login", true);
    }
    if (status === "authenticated" && route === "login" && user && !user.must_change_password) navigate("overview", true);
  }, [status, route, user]);

  if (status === "loading") {
    return <div className="flex min-h-dvh items-center justify-center gap-2 text-sm text-ink-3" role="status"><Spinner /> Restoring your session…</div>;
  }
  if (!user) return <LoginPage />;
  if (user.must_change_password) return <ForcedPasswordChange />;

  const page: PageRoute = route === "login" ? "overview" : route;
  return (
    <MonitorProvider key={user.id}>
      <Shell route={page}><Guarded route={page} /></Shell>
    </MonitorProvider>
  );
}
