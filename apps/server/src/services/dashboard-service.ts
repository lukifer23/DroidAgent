import { DashboardStateSchema } from "@droidagent/shared";

import { TtlCache } from "../lib/ttl-cache.js";
import { performanceService } from "./performance-service.js";
import { accessService } from "./access-service.js";
import { appStateService } from "./app-state-service.js";
import { harnessService } from "./harness-service.js";
import { jobService } from "./job-service.js";
import { keychainService } from "./keychain-service.js";
import { launchAgentService } from "./launch-agent-service.js";
import { openclawService } from "./openclaw-service.js";
import { runtimeService } from "./runtime-service.js";
import { signalService } from "./signal-service.js";
import { startupService } from "./startup-service.js";

const DASHBOARD_SNAPSHOT_TTL_MS = 5000;

export class DashboardService {
  private readonly snapshotCache = new TtlCache<ReturnType<typeof DashboardStateSchema.parse>>(DASHBOARD_SNAPSHOT_TTL_MS);

  invalidate(): void {
    this.snapshotCache.invalidate();
  }

  async getDashboardState() {
    const metric = performanceService.start("server", "dashboard.snapshot");
    try {
      return await this.snapshotCache.get(async () => {
        await signalService.refreshState();

        const [
          setup,
          access,
          startupDiagnostics,
          runtimes,
          providers,
          cloudProviders,
          channelState,
          contextManagement,
          launchAgent,
          sessions,
          jobs,
          approvals
        ] = await Promise.all([
          appStateService.getSetupState(),
          accessService.getAccessSnapshot(),
          startupService.getDiagnostics(),
          runtimeService.getRuntimeStatuses(),
          runtimeService.listProviderProfiles(),
          keychainService.listProviderSummaries(),
          harnessService.listChannels(),
          openclawService.contextManagementStatus(),
          launchAgentService.status(),
          harnessService.listSessions(),
          jobService.listJobs(),
          harnessService.listApprovals()
        ]);

        return DashboardStateSchema.parse({
          setup,
          canonicalUrl: access.canonicalUrl,
          tailscaleStatus: access.tailscaleStatus,
          cloudflareStatus: access.cloudflareStatus,
          serveStatus: access.serveStatus,
          bootstrapRequired: access.bootstrapRequired,
          startupDiagnostics,
          runtimes,
          providers,
          cloudProviders,
          channels: channelState.statuses,
          channelConfig: channelState.config,
          contextManagement,
          launchAgent,
          sessions,
          jobs,
          approvals
        });
      });
    } finally {
      metric.finish();
    }
  }
}

export const dashboardService = new DashboardService();
