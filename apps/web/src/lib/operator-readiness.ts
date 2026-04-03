import type { DashboardState } from "@droidagent/shared";

export function isOperatorReady(
  dashboard:
    | Pick<DashboardState, "canonicalUrl" | "memory" | "setup">
    | undefined,
): boolean {
  const setup = dashboard?.setup;
  const memory = dashboard?.memory;
  if (!dashboard || !setup || !memory) {
    return false;
  }

  return Boolean(
    setup.passkeyConfigured &&
    setup.workspaceRoot &&
    memory.semanticReady &&
    setup.selectedRuntime &&
    setup.selectedModel &&
    setup.remoteAccessEnabled &&
    dashboard.canonicalUrl,
  );
}
