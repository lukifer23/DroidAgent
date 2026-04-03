import { DashboardStateSchema } from "@droidagent/shared";

import { TtlCache } from "../lib/ttl-cache.js";
import { accessService } from "./access-service.js";
import { appStateService } from "./app-state-service.js";
import { buildInfoService } from "./build-info-service.js";
import { harnessService } from "./harness-service.js";
import { hostPressureService } from "./host-pressure-service.js";
import { jobService } from "./job-service.js";
import { keychainService } from "./keychain-service.js";
import { launchAgentService } from "./launch-agent-service.js";
import { maintenanceService } from "./maintenance-service.js";
import { decisionService } from "./decision-service.js";
import { memoryDraftService } from "./memory-draft-service.js";
import { openclawService } from "./openclaw-service.js";
import { performanceService } from "./performance-service.js";
import { runtimeService } from "./runtime-service.js";
import { sessionLifecycleService } from "./session-lifecycle-service.js";
import { startupService } from "./startup-service.js";

const DASHBOARD_SNAPSHOT_TTL_MS = 15_000;

export type DashboardSliceKey =
  | "setup"
  | "access"
  | "runtimes"
  | "providers"
  | "channels"
  | "harness"
  | "memory"
  | "hostPressure"
  | "memoryDrafts"
  | "contextManagement"
  | "maintenance"
  | "launchAgent"
  | "sessions"
  | "jobs"
  | "decisions"
  | "approvals";

export class DashboardService {
  private readonly snapshotCache = new TtlCache<
    ReturnType<typeof DashboardStateSchema.parse>
  >(DASHBOARD_SNAPSHOT_TTL_MS);
  private readonly setupCache = new TtlCache<
    Awaited<ReturnType<typeof appStateService.getSetupState>>
  >(DASHBOARD_SNAPSHOT_TTL_MS);
  private readonly accessCache = new TtlCache<
    Awaited<ReturnType<typeof accessService.getAccessSnapshot>>
  >(DASHBOARD_SNAPSHOT_TTL_MS);
  private readonly runtimesCache = new TtlCache<
    Awaited<ReturnType<typeof runtimeService.getRuntimeStatuses>>
  >(DASHBOARD_SNAPSHOT_TTL_MS);
  private readonly providersCache = new TtlCache<{
    providers: Awaited<ReturnType<typeof runtimeService.listProviderProfiles>>;
    cloudProviders: Awaited<
      ReturnType<typeof keychainService.listProviderSummaries>
    >;
  }>(DASHBOARD_SNAPSHOT_TTL_MS);
  private readonly channelsCache = new TtlCache<
    Awaited<ReturnType<typeof harnessService.listChannels>>
  >(DASHBOARD_SNAPSHOT_TTL_MS);
  private readonly harnessCache = new TtlCache<
    Awaited<ReturnType<typeof harnessService.harnessStatus>>
  >(DASHBOARD_SNAPSHOT_TTL_MS);
  private readonly memoryCache = new TtlCache<
    Awaited<ReturnType<typeof openclawService.memoryStatus>>
  >(DASHBOARD_SNAPSHOT_TTL_MS);
  private readonly hostPressureCache = new TtlCache<
    Awaited<ReturnType<typeof hostPressureService.getStatus>>
  >(DASHBOARD_SNAPSHOT_TTL_MS);
  private readonly memoryDraftsCache = new TtlCache<
    Awaited<ReturnType<typeof memoryDraftService.listDrafts>>
  >(DASHBOARD_SNAPSHOT_TTL_MS);
  private readonly contextManagementCache = new TtlCache<
    Awaited<ReturnType<typeof openclawService.contextManagementStatus>>
  >(DASHBOARD_SNAPSHOT_TTL_MS);
  private readonly maintenanceCache = new TtlCache<
    Awaited<ReturnType<typeof maintenanceService.getStatus>>
  >(DASHBOARD_SNAPSHOT_TTL_MS);
  private readonly launchAgentCache = new TtlCache<
    Awaited<ReturnType<typeof launchAgentService.status>>
  >(DASHBOARD_SNAPSHOT_TTL_MS);
  private readonly sessionsCache = new TtlCache<
    Awaited<ReturnType<typeof sessionLifecycleService.listActiveSessions>>
  >(DASHBOARD_SNAPSHOT_TTL_MS);
  private readonly jobsCache = new TtlCache<
    Awaited<ReturnType<typeof jobService.listJobs>>
  >(DASHBOARD_SNAPSHOT_TTL_MS);
  private readonly decisionsCache = new TtlCache<
    Awaited<ReturnType<typeof decisionService.listDecisions>>
  >(DASHBOARD_SNAPSHOT_TTL_MS);
  private readonly approvalsCache = new TtlCache<
    Awaited<ReturnType<typeof harnessService.listApprovals>>
  >(DASHBOARD_SNAPSHOT_TTL_MS);

  invalidate(...slices: DashboardSliceKey[]): void {
    this.snapshotCache.invalidate();
    const targets =
      slices.length > 0
        ? new Set<DashboardSliceKey>(slices)
        : new Set<DashboardSliceKey>([
            "setup",
            "access",
            "runtimes",
            "providers",
            "channels",
            "harness",
            "memory",
            "hostPressure",
            "memoryDrafts",
            "contextManagement",
            "maintenance",
            "launchAgent",
            "sessions",
            "jobs",
            "decisions",
            "approvals",
          ]);

    if (targets.has("setup")) this.setupCache.invalidate();
    if (targets.has("access")) this.accessCache.invalidate();
    if (targets.has("runtimes")) this.runtimesCache.invalidate();
    if (targets.has("providers")) this.providersCache.invalidate();
    if (targets.has("channels")) this.channelsCache.invalidate();
    if (targets.has("harness")) this.harnessCache.invalidate();
    if (targets.has("memory")) this.memoryCache.invalidate();
    if (targets.has("hostPressure")) this.hostPressureCache.invalidate();
    if (targets.has("memoryDrafts")) this.memoryDraftsCache.invalidate();
    if (targets.has("contextManagement"))
      this.contextManagementCache.invalidate();
    if (targets.has("maintenance")) this.maintenanceCache.invalidate();
    if (targets.has("launchAgent")) this.launchAgentCache.invalidate();
    if (targets.has("sessions")) this.sessionsCache.invalidate();
    if (targets.has("jobs")) this.jobsCache.invalidate();
    if (targets.has("decisions")) this.decisionsCache.invalidate();
    if (targets.has("approvals")) this.approvalsCache.invalidate();
  }

  private async getSetup() {
    return await this.setupCache.get(() => appStateService.getSetupState());
  }

  private async getAccess() {
    return await this.accessCache.get(() => accessService.getAccessSnapshot());
  }

  private async getRuntimes() {
    return await this.runtimesCache.get(() =>
      runtimeService.getRuntimeStatuses(),
    );
  }

  private async getProviders() {
    return await this.providersCache.get(async () => {
      const [providers, cloudProviders] = await Promise.all([
        runtimeService.listProviderProfiles(),
        keychainService.listProviderSummaries(),
      ]);
      return { providers, cloudProviders };
    });
  }

  private async getChannels() {
    return await this.channelsCache.get(() => harnessService.listChannels());
  }

  private async getHarness() {
    return await this.harnessCache.get(() => harnessService.harnessStatus());
  }

  private async getMemory() {
    return await this.memoryCache.get(() =>
      openclawService.memoryStatusQuick(),
    );
  }

  private async getHostPressure() {
    return await this.hostPressureCache.get(() =>
      hostPressureService.getStatus(),
    );
  }

  private async getMemoryDrafts() {
    return await this.memoryDraftsCache.get(() =>
      memoryDraftService.listDrafts(),
    );
  }

  private async getContextManagement() {
    return await this.contextManagementCache.get(() =>
      openclawService.contextManagementStatus(),
    );
  }

  private async getMaintenance() {
    return await this.maintenanceCache.get(() =>
      maintenanceService.getStatus(),
    );
  }

  private async getLaunchAgent() {
    return await this.launchAgentCache.get(() => launchAgentService.status());
  }

  private async getSessions() {
    return await this.sessionsCache.get(() =>
      sessionLifecycleService.listActiveSessions(),
    );
  }

  private async getJobs() {
    return await this.jobsCache.get(() => jobService.listJobs());
  }

  private async getDecisions() {
    return await this.decisionsCache.get(() => decisionService.listDecisions());
  }

  private async getApprovals() {
    return await this.approvalsCache.get(() =>
      decisionService.listLegacyApprovals(),
    );
  }

  private async composeDashboardState() {
    const metric = performanceService.start(
      "server",
      "dashboard.snapshot.compose",
    );
    try {
      const [
        setup,
        access,
        runtimes,
        providerState,
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
        decisions,
        approvals,
      ] = await Promise.all([
        this.getSetup(),
        this.getAccess(),
        this.getRuntimes(),
        this.getProviders(),
        this.getChannels(),
        this.getHarness(),
        this.getMemory(),
        this.getHostPressure(),
        this.getMemoryDrafts(),
        this.getContextManagement(),
        this.getMaintenance(),
        this.getLaunchAgent(),
        this.getSessions(),
        this.getJobs(),
        this.getDecisions(),
        this.getApprovals(),
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
        providers: providerState.providers,
        cloudProviders: providerState.cloudProviders,
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
        decisions,
        approvals,
      });
    } finally {
      metric.finish();
    }
  }

  async getDashboardState() {
    const cache = this.snapshotCache.state();
    const metric = performanceService.start("server", "dashboard.snapshot", {
      cache,
    });
    try {
      const snapshot = await this.snapshotCache.get(() =>
        this.composeDashboardState(),
      );
      metric.finish({
        cache,
        outcome: "ok",
      });
      return snapshot;
    } catch (error) {
      metric.finish({
        cache,
        outcome: "error",
        error: error instanceof Error ? error.name : "unknown",
      });
      throw error;
    }
  }
}

export const dashboardService = new DashboardService();
