import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Bot,
  FolderTree,
  Hammer,
  MessagesSquare,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";

import { useAccessQuery, useAuthQuery, useDashboardQuery } from "./app-data";
import { useDroidAgentApp } from "./app-context";
import {
  DecisionInboxDrawer,
  HostStatusDrawer,
  decisionResolutionNotice,
  type HostStatusItem,
} from "./components/app-shell-drawers";
import { useDecisionActions } from "./hooks/use-decision-actions";
import { useViewportMeasure } from "./hooks/use-viewport-measure";
import { postJson } from "./lib/api";
import {
  formatHostBytes,
  formatTokenBudget,
} from "./lib/formatters";
import {
  getPendingDecisions,
  getResolvedDecisions,
} from "./lib/dashboard-selectors";
import { isOperatorReady } from "./lib/operator-readiness";

const AuthScreen = lazy(async () => ({
  default: (await import("./screens/auth-screen")).AuthScreen,
}));

const navItems = [
  { to: "/setup", label: "Setup", icon: ShieldCheck, readyOnly: false },
  { to: "/chat", label: "Chat", icon: MessagesSquare, readyOnly: true },
  { to: "/files", label: "Files", icon: FolderTree, readyOnly: true },
  { to: "/jobs", label: "Jobs", icon: Hammer, readyOnly: true },
  { to: "/models", label: "Models", icon: Bot, readyOnly: true },
  { to: "/settings", label: "Settings", icon: Settings2, readyOnly: true },
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
    runAction,
  } = useDroidAgentApp();
  const authQuery = useAuthQuery();
  const accessQuery = useAccessQuery();
  const dashboardQuery = useDashboardQuery(Boolean(authQuery.data?.user));
  const [hostDrawerOpen, setHostDrawerOpen] = useState(false);
  const [decisionDrawerOpen, setDecisionDrawerOpen] = useState(false);
  const shellRef = useRef<HTMLElement | null>(null);
  const topbarRef = useRef<HTMLElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);

  const access = accessQuery.data;
  const dashboard = dashboardQuery.data;
  const setup = dashboard?.setup;
  const memory = dashboard?.memory;
  const hostPressure = dashboard?.hostPressure;
  const build = dashboard?.build;
  const launchAgent = dashboard?.launchAgent;
  const providers = dashboard?.providers ?? [];
  const runtimes = dashboard?.runtimes ?? [];
  const decisions = dashboard?.decisions ?? [];
  const tailscaleStatus = access?.tailscaleStatus;
  const operatorReady = isOperatorReady(dashboard);
  const isSetupRoute = location.pathname === "/setup";
  const isChatRoute = location.pathname === "/chat";
  const isFilesRoute = location.pathname === "/files";
  const isTerminalRoute = location.pathname === "/terminal";
  const activeProvider = providers.find((provider) => provider.enabled);
  const runtimeCount = runtimes.filter((runtime) => runtime.state === "running")
    .length;
  const passkeyCount = setup?.passkeyConfigured ? 1 : 0;
  const pendingDecisions = getPendingDecisions(decisions);
  const recentDecisions = getResolvedDecisions(decisions);
  const navItemsForState = navItems.filter(
    (item) => !operatorReady || item.readyOnly,
  );
  const hostPressureLevel = hostPressure?.level ?? "unknown";
  const hostPressureAvailableBytes = hostPressure?.memoryAvailableBytes ?? null;
  const { resolveDecision } = useDecisionActions(decisions);
  useEffect(() => {
    finishRouteTransition(location.pathname);
  }, [finishRouteTransition, location.pathname]);

  useEffect(() => {
    setHostDrawerOpen(false);
    setDecisionDrawerOpen(false);
  }, [location.pathname]);

  const updateViewportChrome = useCallback(() => {
    const shell = shellRef.current;
    const topbar = topbarRef.current;
    const nav = navRef.current;
    if (!shell || !topbar || !nav) {
      return;
    }

    const topbarHeight = Math.round(topbar.getBoundingClientRect().height);
    const navHeight = Math.round(nav.getBoundingClientRect().height);
    const viewportHeight = Math.round(
      window.visualViewport?.height ?? window.innerHeight,
    );
    shell.style.setProperty("--app-topbar-h", `${topbarHeight}px`);
    shell.style.setProperty("--app-bottom-nav-h", `${navHeight}px`);
    shell.style.setProperty("--app-viewport-h", `${viewportHeight}px`);
  }, []);
  const viewportRefs = useMemo(() => [topbarRef, navRef], []);
  useViewportMeasure({
    enabled: Boolean(shellRef.current),
    refs: viewportRefs,
    onMeasure: updateViewportChrome,
    includeViewportScroll: true,
  });

  if (authQuery.isLoading) {
    return <main className="app-shell loading">Loading DroidAgent...</main>;
  }

  if (!authQuery.data?.user) {
    return (
      <Suspense fallback={<main className="app-shell loading">Loading DroidAgent...</main>}>
        <AuthScreen />
      </Suspense>
    );
  }

  const topbarMeta = [
    access?.canonicalOrigin?.origin ? "Tailscale live" : "Local only",
    activeProvider?.model ?? setup?.selectedModel ?? "model pending",
    `v${build?.version ?? "unknown"}`,
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
        tailscaleStatus?.healthMessage ??
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
      label: "Host pressure",
      value:
        hostPressureLevel === "critical"
          ? "Critical"
          : hostPressureLevel === "warn"
            ? "Elevated"
            : hostPressureLevel === "unknown"
              ? "Telemetry fallback"
              : "Normal",
      detail:
        hostPressure?.message ??
        "Host pressure telemetry is still loading.",
      tone:
        hostPressureLevel === "critical"
          ? "critical"
          : hostPressureLevel === "warn" || hostPressureLevel === "unknown"
            ? "warn"
            : "good",
    },
    {
      label: "Memory",
      value: memory?.semanticReady ? "Indexed" : "Pending",
      detail: memory?.semanticReady
        ? `${memory.indexedFiles} files • ${memory.indexedChunks} chunks`
        : memory?.embeddingProbeError ??
          "Semantic memory is not prepared yet.",
      tone: memory?.semanticReady ? "good" : "warn",
    },
    {
      label: "Decisions",
      value: pendingDecisions.length > 0 ? `${pendingDecisions.length} waiting` : "Clear",
      detail:
        pendingDecisions.length > 0
          ? "One or more owner decisions need attention."
          : "No owner decisions are waiting.",
      tone: pendingDecisions.length > 0 ? "warn" : "good",
    },
    {
      label: "LaunchAgent",
      value: launchAgent?.running ? "Running" : "Needs attention",
      detail:
        launchAgent?.healthMessage ??
        "LaunchAgent health is still loading.",
      tone: launchAgent?.running ? "good" : "warn",
    },
    ...(hostPressure && hostPressureAvailableBytes !== null
      ? [
          {
            label: "Reclaimable RAM",
            value: formatHostBytes(hostPressureAvailableBytes),
            detail: `${formatHostBytes(hostPressure.swapUsedBytes)} swap used • ${hostPressure.activeJobs} active job${hostPressure.activeJobs === 1 ? "" : "s"}.`,
            tone:
              hostPressure.level === "critical"
                ? "critical"
                : hostPressure.level === "warn"
                  ? "warn"
                  : "good",
          } satisfies HostStatusItem,
        ]
      : []),
  ];

  const handleResolveDecision = (
    decision: (typeof pendingDecisions)[number],
    resolution: "approved" | "denied",
  ) => {
    void runAction(async () => {
      await resolveDecision(decision, resolution);
    }, decisionResolutionNotice(decision, resolution));
  };

  return (
    <main
      ref={shellRef}
      className={`app-shell${isChatRoute ? " chat-route-shell" : ""}${isFilesRoute ? " files-route-shell" : ""}${isTerminalRoute ? " terminal-route-shell" : ""}`}
    >
      <header
        ref={topbarRef}
        className={`topbar-shell${isChatRoute || isTerminalRoute ? " compact" : ""}`}
      >
        <div className="topbar">
          <div className="topbar-copy">
            <div className="eyebrow">DroidAgent</div>
            <h1>
              {isSetupRoute
                ? "Setup"
                : isChatRoute
                  ? "Chat"
                  : isTerminalRoute
                    ? "Terminal"
                    : "Operator Console"}
            </h1>
            <small className="topbar-meta">{topbarMeta}</small>
          </div>

          <div className="topbar-actions">
            <button
              type="button"
              className={`secondary decision-trigger${pendingDecisions.length > 0 ? " attention" : ""}`}
              onClick={() => setDecisionDrawerOpen(true)}
            >
              Decisions
              <span className={`topbar-action-badge${pendingDecisions.length > 0 ? " warn" : ""}`}>
                {pendingDecisions.length}
              </span>
            </button>
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
      {isChatRoute && (notice || errorMessage) ? (
        <div className="notice-stack">
          {notice ? <section className="status-banner success">{notice}</section> : null}
          {errorMessage ? (
            <section className="status-banner error">{errorMessage}</section>
          ) : null}
        </div>
      ) : null}
      {!isChatRoute && notice ? <section className="status-banner success">{notice}</section> : null}
      {!isChatRoute && errorMessage ? (
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
          <div className="route-frame">
            <Outlet />
          </div>
        </div>

        <nav ref={navRef} className="bottom-nav">
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
        <HostStatusDrawer
          hostStatusItems={hostStatusItems}
          onClose={() => setHostDrawerOpen(false)}
          operatorReady={operatorReady}
        />
      ) : null}

      {decisionDrawerOpen ? (
        <DecisionInboxDrawer
          onClose={() => setDecisionDrawerOpen(false)}
          onResolveDecision={handleResolveDecision}
          pendingDecisions={pendingDecisions}
          recentDecisions={recentDecisions}
        />
      ) : null}
    </main>
  );
}
