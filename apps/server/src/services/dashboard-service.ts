import { DashboardStateSchema } from "@droidagent/shared";

import { TtlCache } from "../lib/ttl-cache.js";
import { performanceService } from "./performance-service.js";
import { accessService } from "./access-service.js";
import { appStateService } from "./app-state-service.js";
import { buildInfoService } from "./build-info-service.js";
import { harnessService } from "./harness-service.js";
import { hostPressureService } from "./host-pressure-service.js";
import { jobService } from "./job-service.js";
import { keychainService } from "./keychain-service.js";
import { launchAgentService } from "./launch-agent-service.js";
import { maintenanceService } from "./maintenance-service.js";
import { memoryDraftService } from "./memory-draft-service.js";
import { openclawService } from "./openclaw-service.js";
import { runtimeService } from "./runtime-service.js";
import { sessionLifecycleService } from "./session-lifecycle-service.js";
import { signalService } from "./signal-service.js";
import { startupService } from "./startup-service.js";

const DASHBOARD_SNAPSHOT_TTL_MS = 15_000;

export class DashboardService {
  private readonly snapshotCache = new TtlCache<ReturnType<typeof DashboardStateSchema.parse>>(DASHBOARD_SNAPSHOT_TTL_MS);

  invalidate(): void {
    this.snapshotCache.invalidate();
  }

  async getDashboardState() {
    const metric = performanceService.start("server", "dashboard.snapshot");
    try {
      return await this.snapshotCache.get(async () => {
        signalService.refreshStateInBackground();

        const [
          setup,
          access,
          runtimes,
          providers,
          cloudProviders,
          channelState,
          harness,
          memory,
          hostPressure,
          memoryDrafts,
          contextManagement,
          maintenance,
          launchAgent,
          sessions,
          jobs,
          approvals
        ] = await Promise.all([
          appStateService.getSetupState(),
          accessService.getAccessSnapshot(),
          runtimeService.getRuntimeStatuses(),
          runtimeService.listProviderProfiles(),
          keychainService.listProviderSummaries(),
          harnessService.listChannels(),
          harnessService.harnessStatus(),
          openclawService.memoryStatus(),
          hostPressureService.getStatus(),
          memoryDraftService.listDrafts(),
          openclawService.contextManagementStatus(),
          maintenanceService.getStatus(),
          launchAgentService.status(),
          sessionLifecycleService.listActiveSessions(),
          jobService.listJobs(),
          harnessService.listApprovals()
        ]);

        return DashboardStateSchema.parse({
          build: buildInfoService.getBuildInfo(),
          setup,
          canonicalUrl: access.canonicalUrl,
          tailscaleStatus: access.tailscaleStatus,
          cloudflareStatus: access.cloudflareStatus,
          serveStatus: access.serveStatus,
          bootstrapRequired: access.bootstrapRequired,
          startupDiagnostics: startupService.peekDiagnostics(),
          runtimes,
          providers,
          cloudProviders,
          channels: channelState.statuses,
          channelConfig: channelState.config,
          harness,
          memory,
          hostPressure,
          memoryDrafts,
          contextManagement,
          maintenance,
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
