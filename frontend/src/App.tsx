import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { Sidebar } from "./components/layout/Sidebar";
import { PageBody } from "./components/layout/PageBody";
import { Button, Card, EmptyState, Icon } from "./components/ui";
import { navigate, rememberNext, ROUTE_PERMISSION, useRoute, type Route } from "./lib/router";
import { AddCameraPage } from "./pages/AddCameraPage";
import { AuditPage } from "./pages/AuditPage";
import { ForcedPasswordChange } from "./pages/ChangePasswordPage";
import { ConfigPage } from "./pages/ConfigPage";
import { DashboardPage } from "./pages/DashboardPage";
import { BrandCard, LoginPage } from "./pages/LoginPage";
import { SystemPage } from "./pages/SystemPage";
import { UsersPage } from "./pages/UsersPage";
import { ViolationsPage } from "./pages/ViolationsPage";
import { useAuth } from "./state/auth";
import { MonitorProvider } from "./state/monitor";

// Recharts is large: the Analytics page (and it) load only when opened
const AnalyticsPage = lazy(() => import("./pages/AnalyticsPage").then((m) => ({ default: m.AnalyticsPage })));

const PAGES: Record<Exclude<Route, "login">, () => ReactNode> = {
  dashboard: () => <DashboardPage />,
  violations: () => <ViolationsPage />,
  analytics: () => (
    <Suspense fallback={<PageBody><Card className="p-6 text-sm text-muted">Loading analytics…</Card></PageBody>}>
      <AnalyticsPage />
    </Suspense>
  ),
  config: () => <ConfigPage />,
  "add-camera": () => <AddCameraPage />,
  system: () => <SystemPage />,
  users: () => <UsersPage />,
  audit: () => <AuditPage />,
};

function Splash() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 text-sm text-muted" role="status">
      <BrandCard className="w-20" />
      Restoring your session…
    </div>
  );
}

/** Route guard: renders the page only when the signed-in role holds its permission. */
function RequirePermission({ route }: { route: Exclude<Route, "login"> }) {
  const { can } = useAuth();
  if (!can(ROUTE_PERMISSION[route])) {
    return (
      <PageBody>
        <Card>
          <EmptyState icon={<Icon.lock size={20} />} title="You don't have access to this page"
            message="This page is only available to Super Admins. Ask a Super Admin if you need access."
            action={<Button onClick={() => navigate("dashboard")}>Go to the dashboard</Button>} />
        </Card>
      </PageBody>
    );
  }
  return <>{PAGES[route]()}</>;
}

export default function App() {
  const { status, user } = useAuth();
  const route = useRoute();

  // signed out on a protected URL -> remember it and show the login page at #/login
  useEffect(() => {
    if (status === "anonymous" && route !== "login") {
      rememberNext();
      navigate("login", true);
    }
    if (status === "authenticated" && route === "login" && user && !user.must_change_password) navigate("dashboard", true);
  }, [status, route, user]);

  if (status === "loading") return <Splash />;
  if (!user) return <LoginPage />;
  if (user.must_change_password) return <ForcedPasswordChange />;

  const page = route === "login" ? "dashboard" : route;
  return (
    <MonitorProvider key={user.id}>
      <div className="min-h-screen">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">
          Skip to content
        </a>
        <Sidebar route={page} />
        <div className="pl-16 lg:pl-60 print:pl-0">
          <RequirePermission route={page} />
        </div>
      </div>
    </MonitorProvider>
  );
}
