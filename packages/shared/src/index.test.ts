import { describe, expect, it } from "vitest";

import {
  DashboardStateSchema,
  FileConflictResponseSchema,
  FileContentSchema,
  PerformanceSnapshotSchema,
  QuickstartResultSchema,
  ServerEventSchema,
} from "./index";

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
        signalEnabled: false,
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
        lastCheckedAt: null,
      },
      cloudflareStatus: {
        installed: false,
        configured: false,
        running: false,
        tokenStored: false,
        health: "warn",
        healthMessage: "Cloudflare not configured",
        version: null,
        hostname: null,
        canonicalUrl: null,
        lastStartedAt: null,
        lastCheckedAt: null,
      },
      serveStatus: {
        enabled: false,
        health: "warn",
        healthMessage: "Serve not enabled",
        source: "none",
        url: null,
        target: null,
        lastCheckedAt: null,
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
          cliVersion: null,
          registrationMode: "none",
          registrationState: "unconfigured",
          daemonState: "stopped",
          daemonUrl: null,
          receiveMode: "persistent",
          dmPolicy: "pairing",
          allowGroups: false,
          channelConfigured: false,
          pendingPairings: [],
          linkUri: null,
          lastError: null,
          lastStartedAt: null,
          compatibilityWarning: null,
          healthChecks: [],
        },
      },
      memory: {
        configuredWorkspaceRoot: "/tmp/droidagent",
        effectiveWorkspaceRoot: "/tmp/droidagent",
        ready: true,
        memoryDirectory: "/tmp/droidagent/memory",
        memoryDirectoryReady: true,
        skillsDirectory: "/tmp/droidagent/skills",
        skillsDirectoryReady: true,
        memoryFilePath: "/tmp/droidagent/MEMORY.md",
        todayNotePath: "/tmp/droidagent/memory/2026-03-28.md",
        bootstrapFiles: [
          {
            path: "AGENTS.md",
            exists: true,
          },
        ],
        bootstrapFilesReady: 1,
        bootstrapFilesTotal: 1,
        memorySearchEnabled: true,
        sessionMemoryEnabled: true,
        contextWindow: 65536,
      },
      contextManagement: {
        enabled: true,
        compactionMode: "safeguard",
        pruningMode: "off",
        memoryFlushEnabled: true,
        reserveTokensFloor: 2048,
        softThresholdTokens: 512,
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
        healthMessage: "Not installed.",
      },
      sessions: [],
      jobs: [],
      approvals: [],
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
      encoding: "utf-8",
    });

    expect(parsed.path).toBe("src/app.ts");
  });

  it("accepts structured file conflict payloads", () => {
    const parsed = FileConflictResponseSchema.parse({
      error: "The file changed on disk after it was loaded.",
      currentModifiedAt: new Date().toISOString(),
    });

    expect(parsed.error).toMatch(/changed on disk/);
  });

  it("accepts chat stream events", () => {
    const parsed = ServerEventSchema.parse({
      type: "chat.stream.delta",
      payload: {
        sessionId: "main",
        runId: "run-1",
        delta: "hello",
      },
    });

    expect(parsed.type).toBe("chat.stream.delta");
  });

  it("accepts targeted access updates", () => {
    const parsed = ServerEventSchema.parse({
      type: "access.updated",
      payload: {
        ownerExists: true,
        bootstrapRequired: false,
        enrollmentState: "complete",
        accessMode: "cloudflare",
        canonicalOrigin: {
          accessMode: "cloudflare",
          origin: "https://agent.example.com",
          rpId: "agent.example.com",
          hostname: "agent.example.com",
          source: "cloudflareTunnel",
          updatedAt: new Date().toISOString(),
        },
        tailscaleStatus: {
          installed: true,
          running: true,
          authenticated: true,
          health: "ok",
          healthMessage: "Healthy",
          version: "1.80.0",
          deviceName: "droidagent-mac",
          tailnetName: "example.ts.net",
          dnsName: "droidagent.example.ts.net",
          magicDnsEnabled: true,
          httpsEnabled: true,
          serveCommand: "tailscale serve --bg --https=443 4318",
          canonicalUrl: "https://droidagent.example.ts.net",
          lastCheckedAt: new Date().toISOString(),
        },
        cloudflareStatus: {
          installed: true,
          configured: true,
          running: true,
          tokenStored: true,
          health: "ok",
          healthMessage: "Healthy",
          version: "2026.3.0",
          hostname: "agent.example.com",
          canonicalUrl: "https://agent.example.com",
          lastStartedAt: new Date().toISOString(),
          lastCheckedAt: new Date().toISOString(),
        },
        serveStatus: {
          enabled: true,
          health: "ok",
          healthMessage: "Cloudflare is serving DroidAgent",
          source: "cloudflare",
          url: "https://agent.example.com",
          target: "http://127.0.0.1:4318",
          lastCheckedAt: new Date().toISOString(),
        },
        bootstrapTokenIssuedAt: null,
        bootstrapTokenExpiresAt: null,
        bootstrapUrl: null,
        localhostOnlyMessage: "Use localhost only for maintenance.",
      },
    });

    expect(parsed.type).toBe("access.updated");
  });

  it("accepts targeted provider and context updates", () => {
    const providerEvent = ServerEventSchema.parse({
      type: "providers.updated",
      payload: {
        providers: [],
        cloudProviders: [],
      },
    });
    const contextEvent = ServerEventSchema.parse({
      type: "context.updated",
      payload: {
        enabled: true,
        compactionMode: "safeguard",
        pruningMode: "cache-ttl",
        memoryFlushEnabled: true,
        reserveTokensFloor: 24000,
        softThresholdTokens: 6000,
      },
    });
    const memoryEvent = ServerEventSchema.parse({
      type: "memory.updated",
      payload: {
        configuredWorkspaceRoot: "/tmp/droidagent",
        effectiveWorkspaceRoot: "/tmp/droidagent",
        ready: true,
        memoryDirectory: "/tmp/droidagent/memory",
        memoryDirectoryReady: true,
        skillsDirectory: "/tmp/droidagent/skills",
        skillsDirectoryReady: true,
        memoryFilePath: "/tmp/droidagent/MEMORY.md",
        todayNotePath: "/tmp/droidagent/memory/2026-03-28.md",
        bootstrapFiles: [],
        bootstrapFilesReady: 0,
        bootstrapFilesTotal: 0,
        memorySearchEnabled: true,
        sessionMemoryEnabled: true,
        contextWindow: 65536,
      },
    });

    expect(providerEvent.type).toBe("providers.updated");
    expect(contextEvent.type).toBe("context.updated");
    expect(memoryEvent.type).toBe("memory.updated");
  });

  it("accepts performance snapshots and performance events", () => {
    const snapshot = PerformanceSnapshotSchema.parse({
      generatedAt: new Date().toISOString(),
      metrics: [
        {
          name: "http.get./api/access",
          source: "server",
          summary: {
            name: "http.get./api/access",
            source: "server",
            count: 2,
            lastDurationMs: 12,
            minDurationMs: 10,
            maxDurationMs: 12,
            avgDurationMs: 11,
            p50DurationMs: 10,
            p95DurationMs: 12,
          },
          recentSamples: [
            {
              id: "sample-1",
              name: "http.get./api/access",
              source: "server",
              startedAt: new Date().toISOString(),
              endedAt: new Date().toISOString(),
              durationMs: 10,
              context: {
                method: "GET",
              },
            },
          ],
        },
      ],
      recentSamples: [],
    });

    const event = ServerEventSchema.parse({
      type: "performance.updated",
      payload: snapshot,
    });

    expect(event.type).toBe("performance.updated");
  });

  it("accepts quickstart results", () => {
    const parsed = QuickstartResultSchema.parse({
      hostReady: true,
      remoteReady: false,
      workspaceRoot: "/tmp/droidagent",
      modelId: "qwen3.5:4b",
      phoneUrl: null,
      actions: ["Workspace selected.", "Ollama started."],
      remotePendingReason:
        "Sign in to Tailscale on this Mac to finish phone access.",
    });

    expect(parsed.actions).toHaveLength(2);
  });
});
