import { Suspense, lazy, useEffect, type ComponentType } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Navigate,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type { DashboardState, WorkspaceEntry } from "@droidagent/shared";

import { useAuthQuery, useDashboardQuery } from "./app-data";
import { DroidAgentAppProvider } from "./app-context";
import { AppLayout } from "./app-layout";
import { api } from "./lib/api";
import { isOperatorReady } from "./lib/operator-readiness";
import { FilesScreen } from "./screens/files-screen";

const loadChatScreen = () => import("./screens/chat-screen");
const loadSetupScreen = () => import("./screens/setup-screen");
const loadSettingsScreen = () => import("./screens/settings-screen");
const loadJobsScreen = () => import("./screens/jobs-screen");
const loadModelsScreen = () => import("./screens/models-screen");
const loadChannelsScreen = () => import("./screens/channels-screen");
const loadTerminalScreen = () => import("./screens/terminal-screen");

const ChatScreen = lazy(async () => ({
  default: (await loadChatScreen()).ChatScreen,
}));
const SetupScreen = lazy(async () => ({
  default: (await loadSetupScreen()).SetupScreen,
}));
const SettingsScreen = lazy(async () => ({
  default: (await loadSettingsScreen()).SettingsScreen,
}));
const JobsScreen = lazy(async () => ({
  default: (await loadJobsScreen()).JobsScreen,
}));
const ModelsScreen = lazy(async () => ({
  default: (await loadModelsScreen()).ModelsScreen,
}));
const ChannelsScreen = lazy(async () => ({
  default: (await loadChannelsScreen()).ChannelsScreen,
}));
const TerminalScreen = lazy(async () => ({
  default: (await loadTerminalScreen()).TerminalScreen,
}));
const preloadScreens = () =>
  Promise.all([
    loadSettingsScreen(),
    loadJobsScreen(),
    loadModelsScreen(),
    loadChannelsScreen(),
    loadTerminalScreen(),
  ]);

function selectOperatorReadiness(data: DashboardState): boolean {
  return isOperatorReady(data);
}

function withLazyScreen(Component: ComponentType) {
  return function LazyScreen() {
    return (
      <Suspense fallback={<section className="panel-card">Loading...</section>}>
        <Component />
      </Suspense>
    );
  };
}

function IndexRedirect() {
  const authQuery = useAuthQuery();
  const dashboardQuery = useDashboardQuery(
    Boolean(authQuery.data?.user),
    selectOperatorReadiness,
  );
  return <Navigate to={dashboardQuery.data ? "/chat" : "/setup"} />;
}

function IdleRoutePreloader() {
  const authQuery = useAuthQuery();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!authQuery.data?.user) {
      return;
    }

    let didPreload = false;
    let idleHandle: number | null = null;
    let frameHandle: number | null = null;

    const preload = () => {
      if (didPreload) {
        return;
      }
      didPreload = true;
      void Promise.all([
        preloadScreens(),
        queryClient.prefetchQuery({
          queryKey: ["files", "."],
          queryFn: () =>
            api<WorkspaceEntry[]>(`/api/files?path=${encodeURIComponent(".")}`),
          staleTime: 15_000,
        }),
      ]);
    };

    frameHandle = window.requestAnimationFrame(() => {
      preload();
    });

    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      idleHandle = window.requestIdleCallback(preload, { timeout: 150 });
    }

    return () => {
      if (
        idleHandle !== null &&
        typeof window !== "undefined" &&
        "cancelIdleCallback" in window
      ) {
        window.cancelIdleCallback(idleHandle);
      }
      if (frameHandle !== null) {
        window.cancelAnimationFrame(frameHandle);
      }
    };
  }, [authQuery.data?.user, queryClient]);

  return null;
}

const rootRoute = createRootRoute({
  component: AppLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: IndexRedirect,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "setup",
  component: withLazyScreen(SetupScreen),
});

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "chat",
  component: withLazyScreen(ChatScreen),
});

const filesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "files",
  component: FilesScreen,
});

const jobsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "jobs",
  component: withLazyScreen(JobsScreen),
});

const modelsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "models",
  component: withLazyScreen(ModelsScreen),
});

const channelsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "channels",
  component: withLazyScreen(ChannelsScreen),
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings",
  component: withLazyScreen(SettingsScreen),
});

const terminalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "terminal",
  component: withLazyScreen(TerminalScreen),
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  setupRoute,
  chatRoute,
  filesRoute,
  jobsRoute,
  modelsRoute,
  channelsRoute,
  settingsRoute,
  terminalRoute,
]);

const router = createRouter({
  routeTree,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export function App() {
  return (
    <DroidAgentAppProvider>
      <IdleRoutePreloader />
      <RouterProvider router={router} />
    </DroidAgentAppProvider>
  );
}
