import { Suspense, lazy, useEffect, type ComponentType } from "react";
import {
  Navigate,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import { useAuthQuery, useDashboardQuery } from "./app-data";
import { DroidAgentAppProvider } from "./app-context";
import { AppLayout } from "./app-layout";
import { isOperatorReady } from "./lib/operator-readiness";
import { ChatScreen } from "./screens/chat-screen";
import { FilesScreen } from "./screens/files-screen";

const loadSetupScreen = () => import("./screens/setup-screen");
const loadSettingsScreen = () => import("./screens/settings-screen");
const loadJobsScreen = () => import("./screens/jobs-screen");
const loadModelsScreen = () => import("./screens/models-screen");
const loadChannelsScreen = () => import("./screens/channels-screen");

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
const preloadScreens = () =>
  Promise.all([
    loadSetupScreen(),
    loadSettingsScreen(),
    loadJobsScreen(),
    loadModelsScreen(),
    loadChannelsScreen(),
  ]);

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
  const dashboardQuery = useDashboardQuery(Boolean(authQuery.data?.user));
  return (
    <Navigate to={isOperatorReady(dashboardQuery.data) ? "/chat" : "/setup"} />
  );
}

function IdleRoutePreloader() {
  useEffect(() => {
    let didPreload = false;
    let idleHandle: number | null = null;
    let frameHandle: number | null = null;

    const preload = () => {
      if (didPreload) {
        return;
      }
      didPreload = true;
      void preloadScreens();
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
  }, []);

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
  component: withLazyScreen(FilesScreen),
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

const routeTree = rootRoute.addChildren([
  indexRoute,
  setupRoute,
  chatRoute,
  filesRoute,
  jobsRoute,
  modelsRoute,
  channelsRoute,
  settingsRoute,
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
