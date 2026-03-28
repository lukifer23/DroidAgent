import type { DashboardState } from "@droidagent/shared";

export function isOperatorReady(
  dashboard: DashboardState | undefined,
): boolean {
  if (!dashboard) {
    return false;
  }

  return Boolean(
    dashboard.setup.passkeyConfigured &&
    dashboard.setup.workspaceRoot &&
    dashboard.memory.semanticReady &&
    dashboard.setup.selectedRuntime &&
    dashboard.setup.selectedModel &&
    dashboard.setup.remoteAccessEnabled &&
    dashboard.canonicalUrl,
  );
}
