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
      cloudProviders: [],
      channels: [],
      channelConfig: {
        signal: {
          installed: false,
          binaryPath: null,
          javaHome: null,
          accountId: null,
          phoneNumber: null,
          deviceName: null,
          registrationMode: "none",
          registrationState: "unconfigured",
          daemonState: "stopped",
          daemonUrl: null,
          dmPolicy: "pairing",
          allowGroups: false,
          pairingPending: 0,
          approvedPeers: [],
          linkUri: null,
          lastError: null,
          lastStartedAt: null
        }
      },
      launchAgent: {
        label: "com.droidagent.server",
        plistPath: "/tmp/com.droidagent.server.plist",
        stdoutPath: "/tmp/droidagent.stdout.log",
        stderrPath: "/tmp/droidagent.stderr.log",
        installed: false,
        loaded: false,
        running: false,
        pid: null,
        lastExitStatus: null,
        health: "warn",
        healthMessage: "Not installed."
      },
      sessions: [],
      jobs: [],
      approvals: []
    });

    expect(parsed.setup.currentStep).toBe("hostScan");
  });
});
