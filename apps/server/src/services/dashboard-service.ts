import { DashboardStateSchema } from "@droidagent/shared";

import { appStateService } from "./app-state-service.js";
import { jobService } from "./job-service.js";
import { openclawService } from "./openclaw-service.js";
import { runtimeService } from "./runtime-service.js";

export class DashboardService {
  async getDashboardState() {
    const [setup, runtimes, providers, channelState, sessions, jobs, approvals] = await Promise.all([
      appStateService.getSetupState(),
      runtimeService.getRuntimeStatuses(),
      runtimeService.listProviderProfiles(),
      openclawService.getChannelStatuses(),
      openclawService.listSessions(),
      jobService.listJobs(),
      openclawService.listApprovals()
    ]);

    return DashboardStateSchema.parse({
      setup,
      runtimes,
      providers,
      channels: channelState.statuses,
      channelConfig: channelState.config,
      sessions,
      jobs,
      approvals
    });
  }
}

export const dashboardService = new DashboardService();

