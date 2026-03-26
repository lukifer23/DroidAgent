import { Suspense, lazy, useEffect, type ComponentType } from "react";
import {
  Navigate,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter
} from "@tanstack/react-router";

import { useAuthQuery, useDashboardQuery } from "./app-data";
import { DroidAgentAppProvider } from "./app-context";
import { AppLayout } from "./app-layout";

const loadSetupScreen = () => import("./screens/setup-screen");
const loadChatScreen = () => import("./screens/chat-screen");
const loadFilesScreen = () => import("./screens/files-screen");
const loadJobsScreen = () => import("./screens/jobs-screen");
const loadModelsScreen = () => import("./screens/models-screen");
const loadChannelsScreen = () => import("./screens/channels-screen");
const loadSettingsScreen = () => import("./screens/settings-screen");

const SetupScreen = lazy(async () => ({ default: (await loadSetupScreen()).SetupScreen }));
const ChatScreen = lazy(async () => ({ default: (await loadChatScreen()).ChatScreen }));
const FilesScreen = lazy(async () => ({ default: (await loadFilesScreen()).FilesScreen }));
const JobsScreen = lazy(async () => ({ default: (await loadJobsScreen()).JobsScreen }));
const ModelsScreen = lazy(async () => ({ default: (await loadModelsScreen()).ModelsScreen }));
const ChannelsScreen = lazy(async () => ({ default: (await loadChannelsScreen()).ChannelsScreen }));
const SettingsScreen = lazy(async () => ({ default: (await loadSettingsScreen()).SettingsScreen }));

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
  const completed = dashboardQuery.data?.setup.completedSteps.length ?? 0;
  return <Navigate to={completed < 5 ? "/setup" : "/chat"} />;
}

function IdleRoutePreloader() {
  useEffect(() => {
    const preload = () => {
      void Promise.all([
        loadSetupScreen(),
        loadChatScreen(),
        loadFilesScreen(),
        loadJobsScreen(),
        loadModelsScreen(),
        loadChannelsScreen(),
        loadSettingsScreen()
      ]);
    };

    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      const idleHandle = window.requestIdleCallback(preload, { timeout: 2500 });
      return () => {
        window.cancelIdleCallback(idleHandle);
      };
    }

    const timeout = globalThis.setTimeout(preload, 400);
    return () => {
      globalThis.clearTimeout(timeout);
    };
  }, []);

  return null;
}

const rootRoute = createRootRoute({
  component: AppLayout
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: IndexRedirect
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "setup",
  component: withLazyScreen(SetupScreen)
});

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "chat",
  component: withLazyScreen(ChatScreen)
});

const filesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "files",
  component: withLazyScreen(FilesScreen)
});

const jobsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "jobs",
  component: withLazyScreen(JobsScreen)
});

const modelsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "models",
  component: withLazyScreen(ModelsScreen)
});

const channelsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "channels",
  component: withLazyScreen(ChannelsScreen)
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings",
  component: withLazyScreen(SettingsScreen)
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  setupRoute,
  chatRoute,
  filesRoute,
  jobsRoute,
  modelsRoute,
  channelsRoute,
  settingsRoute
]);

const router = createRouter({
  routeTree
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
