import { describe, expect, it } from "vitest";

import { DashboardStateSchema } from "./index";

describe("DashboardStateSchema", () => {
  it("accepts a minimal dashboard payload", () => {
    const parsed = DashboardStateSchema.parse({
      setup: {
        completedSteps: [],
        currentStep: "hostScan",
        passkeyConfigured: false,
        workspaceRoot: null,
        selectedRuntime: "ollama",
        selectedModel: null,
        remoteAccessEnabled: false,
        signalEnabled: false
      },
      runtimes: [],
      providers: [],
      channels: [],
      channelConfig: {
        signal: {
          installed: false,
          binaryPath: null,
          phoneNumber: null,
          dmPolicy: "pairing",
          allowGroups: false,
          pairingPending: 0,
          approvedPeers: []
        }
      },
      sessions: [],
      jobs: [],
      approvals: []
    });

    expect(parsed.setup.currentStep).toBe("hostScan");
  });
});
