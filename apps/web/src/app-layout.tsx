import { useEffect } from "react";
import {
  Bot,
  FolderTree,
  Gauge,
  Hammer,
  MessagesSquare,
  Settings2,
  ShieldCheck,
  Smartphone,
  Sparkles,
} from "lucide-react";
import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";

import { useAccessQuery, useAuthQuery, useDashboardQuery } from "./app-data";
import { useDroidAgentApp } from "./app-context";
import { formatTokenBudget } from "./lib/formatters";
import { isOperatorReady } from "./lib/operator-readiness";
import { AuthScreen } from "./screens/auth-screen";
import { postJson } from "./lib/api";

const navItems = [
  { to: "/setup", label: "Setup", icon: Sparkles },
  { to: "/chat", label: "Chat", icon: MessagesSquare },
  { to: "/files", label: "Files", icon: FolderTree },
  { to: "/jobs", label: "Jobs", icon: Hammer },
  { to: "/models", label: "Models", icon: Bot },
  { to: "/settings", label: "Settings", icon: Settings2 },
] as const;

function meterPercent(completed: number, total: number): number {
  if (total === 0) {
    return 0;
  }

  return Math.round((completed / total) * 100);
}

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
  const accessQuery = useAccessQuery();
  const dashboardQuery = useDashboardQuery(Boolean(authQuery.data?.user));
  const access = accessQuery.data;
  const dashboard = dashboardQuery.data;
  const operatorReady = isOperatorReady(dashboard);
  const isSetupRoute = location.pathname === "/setup";
  const isChatRoute = location.pathname === "/chat";

  useEffect(() => {
    finishRouteTransition(location.pathname);
  }, [finishRouteTransition, location.pathname]);

  if (authQuery.isLoading) {
    return <main className="app-shell loading">Loading DroidAgent...</main>;
  }

  if (!authQuery.data?.user) {
    return <AuthScreen />;
  }

  const runtimeCount =
    dashboard?.runtimes.filter((runtime) => runtime.state === "running")
      .length ?? 0;
  const memoryReady = Boolean(dashboard?.memory.semanticReady);
  const pendingApprovals = dashboard?.approvals.length ?? 0;
  const activeProvider = dashboard?.providers.find((provider) => provider.enabled);
  const setupCompletion = meterPercent(
    [
      dashboard?.setup.passkeyConfigured,
      dashboard?.setup.workspaceRoot,
      memoryReady,
      dashboard?.setup.selectedRuntime,
      dashboard?.setup.selectedModel,
      dashboard?.setup.remoteAccessEnabled,
      dashboard?.canonicalUrl,
    ].filter(Boolean).length,
    7,
  );
  const hostCompletion = meterPercent(
    [
      dashboard?.setup.workspaceRoot,
      memoryReady,
      runtimeCount > 0,
      dashboard?.launchAgent.running,
      dashboard?.setup.selectedModel,
    ].filter(Boolean).length,
    5,
  );
  const remoteReady = Boolean(access?.canonicalOrigin?.origin);
  const remoteCompletion = remoteReady
    ? 100
    : access?.tailscaleStatus.authenticated
      ? 68
      : 20;
  const systemCards = [
    {
      key: "system",
      icon: ShieldCheck,
      label: "System",
      value: operatorReady ? "Ready" : "Needs attention",
      detail: operatorReady
        ? "Core setup is in place and DroidAgent is ready to operate."
        : `${setupCompletion}% of the guided setup path is complete.`,
      progress: operatorReady ? 100 : setupCompletion,
      tone: operatorReady ? "good" : "warn",
    },
    {
      key: "remote",
      icon: Smartphone,
      label: "Phone access",
      value: remoteReady ? "Tailscale live" : "Local only",
      detail: remoteReady
        ? (access?.canonicalOrigin?.origin ?? dashboard?.canonicalUrl)
        : access?.tailscaleStatus.authenticated
          ? "Enable the Tailscale URL from Setup or Settings to finish phone access."
          : "Sign in to Tailscale on this Mac to publish a private phone URL.",
      progress: remoteCompletion,
      tone: remoteReady
        ? "good"
        : access?.tailscaleStatus.authenticated
          ? "warn"
          : "muted",
    },
    {
      key: "runtime",
      icon: Bot,
      label: "Runtime",
      value: runtimeCount > 0 ? `${runtimeCount} live` : "Not running",
      detail: activeProvider?.model
        ? `${activeProvider.model} • ${formatTokenBudget(activeProvider.contextWindow)} context • ${memoryReady ? "semantic memory live" : "semantic memory pending"}`
        : "Select a local model to make the common path feel instant.",
      progress: runtimeCount > 0 ? hostCompletion : 24,
      tone: runtimeCount > 0 ? "good" : "warn",
    },
    {
      key: "activity",
      icon: Gauge,
      label: pendingApprovals > 0 ? "Approvals" : "Sessions",
      value:
        pendingApprovals > 0
          ? `${pendingApprovals} waiting`
          : `${dashboard?.sessions.length ?? 0} active`,
      detail:
        pendingApprovals > 0
          ? "The approval queue needs attention before agent exec can continue."
          : "Chat, files, jobs, and models stay one tap away in the bottom bar.",
      progress:
        pendingApprovals > 0
          ? 56
          : Math.min(100, 36 + (dashboard?.sessions.length ?? 0) * 18),
      tone: pendingApprovals > 0 ? "warn" : "good",
    },
  ] as const;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-copy">
          <div className="eyebrow">DroidAgent</div>
          <h1>{isChatRoute ? "Operator Chat" : "Control Center"}</h1>
          <small className="topbar-meta">
            {remoteReady ? "Tailscale live" : "Local-first"} •{" "}
            {activeProvider?.model ?? dashboard?.setup.selectedModel ?? "No model"}
            {activeProvider?.contextWindow
              ? ` • ${formatTokenBudget(activeProvider.contextWindow)}`
              : ""}{" "}
            • {memoryReady ? "memory ready" : "memory pending"}
          </small>
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

      {!isChatRoute ? (
        <section className="system-rail">
          {systemCards.map((card) => {
          const Icon = card.icon;
          return (
            <article
              key={card.key}
              className={`panel-card compact system-rail-card ${card.tone}`}
            >
              <div className="system-rail-head">
                <div className={`system-rail-icon ${card.tone}`}>
                  <Icon size={18} />
                </div>
                <span>{card.label}</span>
              </div>
              <strong>{card.value}</strong>
              <div className="health-meter">
                <span style={{ width: `${card.progress}%` }} />
              </div>
              <small>{card.detail}</small>
            </article>
          );
          })}
        </section>
      ) : null}

      {!operatorReady && !isSetupRoute ? (
        <section className="status-banner offline">
          DroidAgent still needs a quick setup pass before phone control feels
          normal. <Link to="/setup">Finish setup</Link>
        </section>
      ) : null}

      {location.pathname === "/channels" ? (
        <section className="status-banner offline">
          Signal is available, but the primary path stays in the web shell. Use
          Channels only when you need the optional Signal integration.
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
