import {
  Navigate,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter
} from "@tanstack/react-router";

import { DroidAgentAppProvider, useDroidAgentApp } from "./app-context";
import { AppLayout } from "./app-layout";
import { ChannelsScreen } from "./screens/channels-screen";
import { ChatScreen } from "./screens/chat-screen";
import { FilesScreen } from "./screens/files-screen";
import { JobsScreen } from "./screens/jobs-screen";
import { ModelsScreen } from "./screens/models-screen";
import { SettingsScreen } from "./screens/settings-screen";
import { SetupScreen } from "./screens/setup-screen";

function IndexRedirect() {
  const { dashboard } = useDroidAgentApp();
  const completed = dashboard?.setup.completedSteps.length ?? 0;
  return <Navigate to={completed < 5 ? "/setup" : "/chat"} />;
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
  component: SetupScreen
});

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "chat",
  component: ChatScreen
});

const filesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "files",
  component: FilesScreen
});

const jobsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "jobs",
  component: JobsScreen
});

const modelsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "models",
  component: ModelsScreen
});

const channelsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "channels",
  component: ChannelsScreen
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings",
  component: SettingsScreen
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
      <RouterProvider router={router} />
    </DroidAgentAppProvider>
  );
}
