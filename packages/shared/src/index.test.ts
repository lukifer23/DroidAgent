import { describe, expect, it } from "vitest";

import {
  DashboardStateSchema,
  FileConflictResponseSchema,
  FileContentSchema,
  MemoryDraftApplyResultSchema,
  MemoryDraftUpdateRequestSchema,
  PerformanceSnapshotSchema,
  QuickstartResultSchema,
  ServerEventSchema,
} from "./index";

const memoryStatusFixture = {
  configuredWorkspaceRoot: "/tmp/droidagent",
  effectiveWorkspaceRoot: "/tmp/droidagent",
  ready: true,
  semanticReady: true,
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
  embeddingProvider: "ollama",
  embeddingRequestedProvider: "ollama",
  embeddingFallback: "none",
  embeddingModel: "embeddinggemma:300m-qat-q8_0",
  indexedFiles: 4,
  indexedChunks: 18,
  dirty: false,
  vectorEnabled: true,
  vectorAvailable: true,
  embeddingProbeOk: true,
  embeddingProbeError: null,
  sourceCounts: [{ source: "memory", files: 2, chunks: 8 }],
  contextWindow: 65536,
  prepareState: "idle",
  prepareStartedAt: null,
  prepareFinishedAt: null,
  prepareProgressLabel: null,
  prepareError: null,
  lastPrepareDurationMs: null,
} as const;

describe("DashboardStateSchema", () => {
  it("accepts a minimal dashboard payload", () => {
    const parsed = DashboardStateSchema.parse({
      build: {
        productName: "DroidAgent",
        version: "0.2.0",
        gitCommit: "abc1234",
        packageManager: "pnpm@10.13.1",
        nodeVersion: "v22.16.0",
      },
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
      harness: {
        configured: true,
        agentId: "main",
        defaultSessionId: "web:operator",
        gatewayAuthMode: "token",
        gatewayBind: "loopback",
        activeModel: "ollama/qwen3.5:4b",
        contextWindow: 65536,
        thinkingDefault: "off",
        imageModel: "ollama/qwen3.5:4b",
        pdfModel: "ollama/qwen3.5:4b",
        workspaceRoot: "/tmp/droidagent",
        toolProfile: "coding",
        availableTools: [
          "read",
          "write",
          "edit",
          "apply_patch",
          "exec",
          "process",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "sessions_yield",
          "session_status",
          "subagents",
          "memory_search",
          "memory_get",
        ],
        workspaceOnlyFs: true,
        memorySearchEnabled: true,
        sessionMemoryEnabled: true,
        attachmentsEnabled: true,
        execHost: "gateway",
        execSecurity: "allowlist",
        execAsk: "on-miss",
      },
      memory: memoryStatusFixture,
      hostPressure: {
        observedAt: new Date().toISOString(),
        health: "ok",
        level: "ok",
        message: "Host pressure is normal.",
        blocksAgentRuns: false,
        cpuLogicalCores: 8,
        load1m: 1.24,
        load5m: 1.11,
        load15m: 0.98,
        loadRatio: 0.16,
        memoryTotalBytes: 16 * 1024 * 1024 * 1024,
        memoryUsedBytes: 10 * 1024 * 1024 * 1024,
        memoryAvailableBytes: 6 * 1024 * 1024 * 1024,
        memoryUsedRatio: 0.625,
        compressedBytes: 512 * 1024 * 1024,
        swapTotalBytes: 2 * 1024 * 1024 * 1024,
        swapUsedBytes: 0,
        swapUsedRatio: 0,
        activeJobs: 0,
        activeTerminalSession: false,
        contributors: [
          {
            id: "reclaimableMemory",
            label: "Reclaimable memory",
            severity: "ok",
            value: "6.0 GiB",
            detail: "Available RAM looks healthy.",
          },
          {
            id: "ramUsage",
            label: "RAM usage",
            severity: "ok",
            value: "63%",
            detail: "RAM usage is within the normal range.",
          },
          {
            id: "swapUsage",
            label: "Swap",
            severity: "ok",
            value: "0 MiB",
            detail: "Swap usage is negligible.",
          },
          {
            id: "cpuLoad",
            label: "CPU load",
            severity: "ok",
            value: "1.24 / 8 cores",
            detail: "CPU load is within the normal range.",
          },
          {
            id: "activeJobs",
            label: "Workspace jobs",
            severity: "ok",
            value: "0",
            detail: "No workspace jobs are running.",
          },
          {
            id: "terminalSession",
            label: "Rescue terminal",
            severity: "ok",
            value: "idle",
            detail: "No rescue terminal session is open.",
          },
        ],
        recommendations: [],
        lastError: null,
      },
      contextManagement: {
        enabled: true,
        compactionMode: "safeguard",
        pruningMode: "off",
        memoryFlushEnabled: true,
        reserveTokensFloor: 2048,
        softThresholdTokens: 512,
      },
      memoryDrafts: [],
      maintenance: {
        active: false,
        blocksNewWork: false,
        current: null,
        recent: [],
        updatedAt: new Date().toISOString(),
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
      decisions: [],
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

  it("accepts chat attachments and attachment-backed messages", () => {
    const payload = {
      text: "Summarize the attached PDF and screenshot.",
      attachments: [
        {
          id: "attachment-1",
          name: "report.pdf",
          kind: "pdf",
          mimeType: "application/pdf",
          size: 1024,
          url: "/api/chat/uploads/attachment-1",
        },
        {
          id: "attachment-2",
          name: "screenshot.png",
          kind: "image",
          mimeType: "image/png",
          size: 2048,
          url: "/api/chat/uploads/attachment-2",
        },
      ],
    } as const;

    const message = ServerEventSchema.parse({
      type: "chat.message",
      payload: {
        id: "message-1",
        sessionId: "web:operator",
        role: "user",
        text: payload.text,
        parts: [
          {
            type: "attachments",
            attachments: payload.attachments,
          },
          {
            type: "markdown",
            text: payload.text,
          },
        ],
        attachments: payload.attachments,
        createdAt: new Date().toISOString(),
        status: "complete",
        source: "web",
      },
    });

    expect(message.payload.attachments).toHaveLength(2);
    expect(message.payload.parts).toHaveLength(2);
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
        ...memoryStatusFixture,
        bootstrapFiles: [],
        bootstrapFilesReady: 0,
        bootstrapFilesTotal: 0,
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
            okCount: 1,
            warnCount: 0,
            errorCount: 1,
            lastDurationMs: 12,
            lastEndedAt: new Date().toISOString(),
            sampleAgeMs: 32,
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

  it("accepts stale-safe memory draft mutation payloads", () => {
    const update = MemoryDraftUpdateRequestSchema.parse({
      expectedUpdatedAt: new Date().toISOString(),
      content: "Updated memory draft",
    });
    const apply = MemoryDraftApplyResultSchema.parse({
      draft: {
        id: "draft-1",
        target: "memory",
        status: "applied",
        title: "Local-first preference",
        content: "Prefer local-first tooling.",
        sourceKind: "manual",
        sourceLabel: null,
        sourceRef: null,
        sessionId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        appliedAt: new Date().toISOString(),
        dismissedAt: null,
        failedAt: null,
        lastError: null,
        appliedPath: "/tmp/droidagent/MEMORY.md",
      },
      outcome: "alreadyApplied",
      memory: {
        effectiveWorkspaceRoot: "/tmp/droidagent",
        memoryFilePath: "/tmp/droidagent/MEMORY.md",
        todayNotePath: "/tmp/droidagent/memory/2026-03-28.md",
      },
      reindexMode: null,
    });

    expect(update.expectedUpdatedAt.length).toBeGreaterThan(0);
    expect(apply.outcome).toBe("alreadyApplied");
  });

  it("accepts chat run events", () => {
    const event = ServerEventSchema.parse({
      type: "chat.run",
      payload: {
        sessionId: "web:operator",
        runId: "run-1",
        stage: "approval_required",
        label: "Approval required",
        detail: "Host: gateway",
        toolName: null,
        approvalId: "approval-1",
        active: true,
        updatedAt: new Date().toISOString(),
      },
    });

    expect(event.type).toBe("chat.run");
    expect(event.payload.stage).toBe("approval_required");
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
