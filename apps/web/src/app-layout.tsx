import { useEffect } from "react";
import {
  Bot,
  FolderTree,
  Hammer,
  MessagesSquare,
  Radio,
  Settings2,
  Sparkles,
} from "lucide-react";
import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";

import { useAuthQuery, useDashboardQuery } from "./app-data";
import { useDroidAgentApp } from "./app-context";
import { isOperatorReady } from "./lib/operator-readiness";
import { AuthScreen } from "./screens/auth-screen";
import { postJson } from "./lib/api";

const navItems = [
  { to: "/setup", label: "Setup", icon: Sparkles },
  { to: "/chat", label: "Chat", icon: MessagesSquare },
  { to: "/files", label: "Files", icon: FolderTree },
  { to: "/jobs", label: "Jobs", icon: Hammer },
  { to: "/models", label: "Models", icon: Bot },
  { to: "/channels", label: "Channels", icon: Radio },
  { to: "/settings", label: "Settings", icon: Settings2 },
] as const;

export function AppLayout() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const {
    notice,
    errorMessage,
    isOnline,
    wsStatus,
    beginRouteTransition,
    finishRouteTransition,
  } = useDroidAgentApp();
  const authQuery = useAuthQuery();
  const dashboardQuery = useDashboardQuery(Boolean(authQuery.data?.user));
  const dashboard = dashboardQuery.data;
  const operatorReady = isOperatorReady(dashboard);
  const isSetupRoute = location.pathname === "/setup";

  useEffect(() => {
    finishRouteTransition(location.pathname);
  }, [finishRouteTransition, location.pathname]);

  if (authQuery.isLoading) {
    return <main className="app-shell loading">Loading DroidAgent...</main>;
  }

  if (!authQuery.data?.user) {
    return <AuthScreen />;
  }

  const setup = dashboard?.setup;
  const runtimeCount =
    dashboard?.runtimes.filter((runtime) => runtime.state === "running")
      .length ?? 0;
  const summaryCards = [
    { label: "Status", value: operatorReady ? "Ready" : "Needs Setup" },
    { label: "Live Runtimes", value: String(runtimeCount) },
    {
      label: "LaunchAgent",
      value: dashboard?.launchAgent.running
        ? "Running"
        : dashboard?.launchAgent.installed
          ? "Loaded"
          : "Off",
    },
  ];

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">DroidAgent</div>
          <h1>Operator Console</h1>
        </div>
        <button
          className="ghost-button"
          onClick={async () => {
            await postJson("/api/auth/logout", {});
            await queryClient.invalidateQueries({ queryKey: ["auth"] });
          }}
        >
          Sign out
        </button>
      </header>

      {!isOnline ? (
        <section className="status-banner offline offline-banner">
          You are offline. Agent control requires the host. Reconnecting...
        </section>
      ) : null}
      {wsStatus === "disconnected" && isOnline && authQuery.data?.user ? (
        <section className="status-banner offline offline-banner">
          Reconnecting to DroidAgent...
        </section>
      ) : null}
      {notice ? (
        <section className="status-banner success">{notice}</section>
      ) : null}
      {errorMessage ? (
        <section className="status-banner error">{errorMessage}</section>
      ) : null}

      {!isSetupRoute ? (
        <section className="summary-grid">
          {summaryCards.map((card) => (
            <article key={card.label} className="summary-card">
              <span>{card.label}</span>
              <strong>{card.value}</strong>
            </article>
          ))}
        </section>
      ) : null}

      {!operatorReady && !isSetupRoute ? (
        <section className="status-banner offline">
          DroidAgent still needs a quick setup pass before phone control feels
          normal. <Link to="/setup">Finish setup</Link>
        </section>
      ) : null}

      <section className="main-layout routed-layout">
        <div className="content-panel">
          <div key={location.pathname} className="route-frame">
            <Outlet />
          </div>
        </div>

        <nav className="bottom-nav">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className="nav-link"
                activeProps={{ className: "nav-link active" }}
                onClick={() => beginRouteTransition(item.to)}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </section>
    </main>
  );
}
