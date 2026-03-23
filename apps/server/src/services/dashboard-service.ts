import { DashboardStateSchema } from "@droidagent/shared";

import { appStateService } from "./app-state-service.js";
import { jobService } from "./job-service.js";
import { keychainService } from "./keychain-service.js";
import { launchAgentService } from "./launch-agent-service.js";
import { openclawService } from "./openclaw-service.js";
import { runtimeService } from "./runtime-service.js";
import { signalService } from "./signal-service.js";

export class DashboardService {
  async getDashboardState() {
    await signalService.refreshState();

    const [setup, runtimes, providers, cloudProviders, channelState, launchAgent, sessions, jobs, approvals] = await Promise.all([
      appStateService.getSetupState(),
      runtimeService.getRuntimeStatuses(),
      runtimeService.listProviderProfiles(),
      keychainService.listProviderSummaries(),
      openclawService.getChannelStatuses(),
      launchAgentService.status(),
      openclawService.listSessions(),
      jobService.listJobs(),
      openclawService.listApprovals()
    ]);

    return DashboardStateSchema.parse({
      setup,
      runtimes,
      providers,
      cloudProviders,
      channels: channelState.statuses,
      channelConfig: channelState.config,
      launchAgent,
      sessions,
      jobs,
      approvals
    });
  }
}

export const dashboardService = new DashboardService();
