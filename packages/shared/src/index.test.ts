import { describe, expect, it } from "vitest";

import { DashboardStateSchema, FileContentSchema, ServerEventSchema } from "./index";

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
      canonicalUrl: null,
      tailscaleStatus: {
        installed: false,
        running: false,
        authenticated: false,
        health: "warn",
        healthMessage: "Tailscale not installed",
        version: null,
        deviceName: null,
        tailnetName: null,
        dnsName: null,
        magicDnsEnabled: false,
        httpsEnabled: false,
        serveCommand: null,
        canonicalUrl: null,
        lastCheckedAt: null
      },
      serveStatus: {
        enabled: false,
        health: "warn",
        healthMessage: "Serve not enabled",
        source: "none",
        url: null,
        target: null,
        lastCheckedAt: null
      },
      bootstrapRequired: true,
      startupDiagnostics: [],
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

  it("accepts the new file content contract", () => {
    const parsed = FileContentSchema.parse({
      path: "src/app.ts",
      content: "console.log('ok')",
      modifiedAt: new Date().toISOString(),
      size: 17,
      truncated: false,
      mimeType: "application/typescript",
      encoding: "utf-8"
    });

    expect(parsed.path).toBe("src/app.ts");
  });

  it("accepts chat stream events", () => {
    const parsed = ServerEventSchema.parse({
      type: "chat.stream.delta",
      payload: {
        sessionId: "main",
        runId: "run-1",
        delta: "hello"
      }
    });

    expect(parsed.type).toBe("chat.stream.delta");
  });
});
