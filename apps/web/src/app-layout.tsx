import { useEffect, useState } from "react";
import {
  Activity,
  Bot,
  FolderTree,
  Hammer,
  MessagesSquare,
  Settings2,
  ShieldCheck,
  Smartphone,
  X,
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
  { to: "/setup", label: "Setup", icon: ShieldCheck, readyOnly: false },
  { to: "/chat", label: "Chat", icon: MessagesSquare, readyOnly: true },
  { to: "/files", label: "Files", icon: FolderTree, readyOnly: true },
  { to: "/jobs", label: "Jobs", icon: Hammer, readyOnly: true },
  { to: "/models", label: "Models", icon: Bot, readyOnly: true },
  { to: "/settings", label: "Settings", icon: Settings2, readyOnly: true },
] as const;

interface HostStatusItem {
  label: string;
  value: string;
  detail: string;
  tone: "good" | "warn";
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
  const [hostDrawerOpen, setHostDrawerOpen] = useState(false);

  const access = accessQuery.data;
  const dashboard = dashboardQuery.data;
  const operatorReady = isOperatorReady(dashboard);
  const isSetupRoute = location.pathname === "/setup";
  const isChatRoute = location.pathname === "/chat";
  const activeProvider = dashboard?.providers.find((provider) => provider.enabled);
  const runtimeCount =
    dashboard?.runtimes.filter((runtime) => runtime.state === "running")
      .length ?? 0;
  const passkeyCount = dashboard?.setup.passkeyConfigured ? 1 : 0;
  const pendingApprovals = dashboard?.approvals.length ?? 0;
  const navItemsForState = navItems.filter(
    (item) => !operatorReady || item.readyOnly,
  );
  const showStatusRow = !isChatRoute;

  useEffect(() => {
    finishRouteTransition(location.pathname);
  }, [finishRouteTransition, location.pathname]);

  useEffect(() => {
    setHostDrawerOpen(false);
  }, [location.pathname]);

  if (authQuery.isLoading) {
    return <main className="app-shell loading">Loading DroidAgent...</main>;
  }

  if (!authQuery.data?.user) {
    return <AuthScreen />;
  }

  const topbarMeta = [
    access?.canonicalOrigin?.origin ? "Tailscale live" : "Local only",
    activeProvider?.model ?? dashboard?.setup.selectedModel ?? "model pending",
    activeProvider?.contextWindow
      ? formatTokenBudget(activeProvider.contextWindow)
      : null,
    dashboard?.memory.semanticReady ? "memory ready" : "memory pending",
    `v${dashboard?.build.version ?? "unknown"}`,
  ]
    .filter(Boolean)
    .join(" • ");

  const hostStatusItems: HostStatusItem[] = [
    {
      label: "Owner access",
      value: passkeyCount > 0 ? "Ready" : "Pending",
      detail:
        passkeyCount > 0
          ? "The owner passkey is enrolled."
          : "Finish owner passkey setup before using remote control.",
      tone: passkeyCount > 0 ? "good" : "warn",
    },
    {
      label: "Remote access",
      value: access?.canonicalOrigin?.origin ? "Live" : "Local only",
      detail:
        access?.canonicalOrigin?.origin ??
        access?.tailscaleStatus.healthMessage ??
        "Tailscale is not ready yet.",
      tone: access?.canonicalOrigin?.origin ? "good" : "warn",
    },
    {
      label: "Runtime",
      value: runtimeCount > 0 ? `${runtimeCount} live` : "Not running",
      detail: activeProvider?.model
        ? `${activeProvider.model} • ${formatTokenBudget(activeProvider.contextWindow)}`
        : "Select and start a local runtime.",
      tone: runtimeCount > 0 ? "good" : "warn",
    },
    {
      label: "Memory",
      value: dashboard?.memory.semanticReady ? "Indexed" : "Pending",
      detail: dashboard?.memory.semanticReady
        ? `${dashboard.memory.indexedFiles} files • ${dashboard.memory.indexedChunks} chunks`
        : dashboard?.memory.embeddingProbeError ??
          "Semantic memory is not prepared yet.",
      tone: dashboard?.memory.semanticReady ? "good" : "warn",
    },
    {
      label: "Approvals",
      value: pendingApprovals > 0 ? `${pendingApprovals} waiting` : "Clear",
      detail:
        pendingApprovals > 0
          ? "One or more OpenClaw actions need approval."
          : "No agent approvals are blocking progress.",
      tone: pendingApprovals > 0 ? "warn" : "good",
    },
    {
      label: "LaunchAgent",
      value: dashboard?.launchAgent.running ? "Running" : "Needs attention",
      detail:
        dashboard?.launchAgent.healthMessage ??
        "LaunchAgent health is still loading.",
      tone: dashboard?.launchAgent.running ? "good" : "warn",
    },
  ];

  return (
    <main className={`app-shell${isChatRoute ? " chat-route-shell" : ""}`}>
      <header className={`topbar-shell${isChatRoute ? " compact" : ""}`}>
        <div className="topbar">
          <div className="topbar-copy">
            <div className="eyebrow">DroidAgent</div>
            <h1>{isSetupRoute ? "Setup" : isChatRoute ? "Live Chat" : "Operator Console"}</h1>
            <small className="topbar-meta">{topbarMeta}</small>
          </div>

          <div className="topbar-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => setHostDrawerOpen(true)}
            >
              Host
            </button>
            <button
              className="ghost-button"
              onClick={async () => {
                await postJson("/api/auth/logout", {});
                await queryClient.invalidateQueries({ queryKey: ["auth"] });
              }}
            >
              Sign out
            </button>
          </div>
        </div>

        {showStatusRow ? (
          <div className="topbar-status-row">
            <span className={`status-chip${operatorReady ? " ready" : ""}`}>
              <ShieldCheck size={14} />
              {operatorReady ? "Ready" : "Setup required"}
            </span>
            <span
              className={`status-chip${access?.canonicalOrigin?.origin ? " ready" : ""}`}
            >
              <Smartphone size={14} />
              {access?.canonicalOrigin?.origin ? "Phone live" : "Phone pending"}
            </span>
            <span className={`status-chip${runtimeCount > 0 ? " ready" : ""}`}>
              <Bot size={14} />
              {runtimeCount > 0 ? "Runtime live" : "Runtime pending"}
            </span>
            <span
              className={`status-chip${pendingApprovals > 0 ? "" : " ready"}`}
            >
              <Activity size={14} />
              {pendingApprovals > 0
                ? `${pendingApprovals} approval${pendingApprovals === 1 ? "" : "s"}`
                : "No approvals"}
            </span>
          </div>
        ) : null}
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
      {notice ? <section className="status-banner success">{notice}</section> : null}
      {errorMessage ? (
        <section className="status-banner error">{errorMessage}</section>
      ) : null}

      {!operatorReady && !isSetupRoute ? (
        <section className="status-banner offline">
          DroidAgent still needs a short setup pass before the live operator flow
          is ready. <Link to="/setup">Finish setup</Link>
        </section>
      ) : null}

      <section className="main-layout routed-layout">
        <div className="content-panel">
          <div key={location.pathname} className="route-frame">
            <Outlet />
          </div>
        </div>

        <nav className="bottom-nav">
          {navItemsForState.map((item) => {
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

      {hostDrawerOpen ? (
        <div
          className="drawer-backdrop"
          onClick={() => setHostDrawerOpen(false)}
          role="presentation"
        >
          <aside
            className="host-drawer panel-card"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="drawer-header">
              <div>
                <div className="eyebrow">Host Status</div>
                <h2>Mac, runtime, and remote access</h2>
              </div>
              <button
                type="button"
                className="ghost-button"
                onClick={() => setHostDrawerOpen(false)}
                aria-label="Close host status"
              >
                <X size={18} />
              </button>
            </div>

            <div className="host-status-list">
              {hostStatusItems.map((item) => (
                <article
                  key={item.label}
                  className={`host-status-row ${item.tone}`}
                >
                  <div>
                    <strong>{item.label}</strong>
                    <span>{item.value}</span>
                  </div>
                  <small>{item.detail}</small>
                </article>
              ))}
            </div>

            <div className="drawer-actions">
              {!operatorReady ? (
                <Link className="button-link secondary" to="/setup">
                  Finish setup
                </Link>
              ) : null}
              <Link className="button-link secondary" to="/settings">
                Open settings
              </Link>
            </div>
          </aside>
        </div>
      ) : null}
    </main>
  );
}
