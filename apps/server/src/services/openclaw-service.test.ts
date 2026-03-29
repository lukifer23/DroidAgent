import { beforeEach, describe, expect, it, vi } from "vitest";

import { paths } from "../env.js";

const {
  getRuntimeSettings,
  updateRuntimeSettings,
  getJsonSetting,
  setJsonSetting,
  getProcessEnv,
  runCommand,
} = vi.hoisted(() => ({
  getRuntimeSettings: vi.fn(),
  updateRuntimeSettings: vi.fn(),
  getJsonSetting: vi.fn(),
  setJsonSetting: vi.fn(),
  getProcessEnv: vi.fn(),
  runCommand: vi.fn(),
}));

vi.mock("./app-state-service.js", () => ({
  DEFAULT_OLLAMA_VISION_MODEL: "qwen2.5vl:3b",
  appStateService: {
    getRuntimeSettings,
    updateRuntimeSettings,
    getJsonSetting,
    setJsonSetting,
  },
}));

vi.mock("./keychain-service.js", () => ({
  keychainService: {
    getProcessEnv,
  },
}));

vi.mock("../lib/process.js", () => ({
  runCommand,
  CommandError: class CommandError extends Error {
    constructor(
      message: string,
      public readonly stdout: string,
      public readonly stderr: string,
      public readonly exitCode: number | null,
    ) {
      super(message);
    }
  },
}));

import { openclawService } from "./openclaw-service.js";

describe("OpenClaw context management policy", () => {
  let runtimeSettings: {
    activeProviderId: string;
    ollamaModel: string;
    ollamaEmbeddingModel: string;
    ollamaContextWindow: number;
    llamaCppModel: string;
    llamaCppContextWindow: number;
    smartContextManagementEnabled: boolean;
    cloudProviders: {
      openai: { defaultModel: string };
      anthropic: { defaultModel: string };
      openrouter: { defaultModel: string };
      gemini: { defaultModel: string };
      groq: { defaultModel: string };
      together: { defaultModel: string };
      xai: { defaultModel: string };
    };
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    (
      openclawService as unknown as { gatewayToken: string | null }
    ).gatewayToken = null;
    (
      openclawService as unknown as { gatewayProcess: unknown | null }
    ).gatewayProcess = null;
    (
      openclawService as unknown as { activeRuns: Map<string, unknown> }
    ).activeRuns = new Map();
    openclawService.invalidateMemoryStatusCache();
    vi.spyOn(
      openclawService as never,
      "ensureWorkspaceScaffold" as never,
    ).mockResolvedValue(undefined);

    runtimeSettings = {
      activeProviderId: "anthropic",
      ollamaModel: "qwen3.5:4b",
      ollamaEmbeddingModel: "embeddinggemma:300m-qat-q8_0",
      ollamaContextWindow: 65536,
      llamaCppModel: "ggml-org/gemma-3-1b-it-GGUF",
      llamaCppContextWindow: 8192,
      smartContextManagementEnabled: true,
      cloudProviders: {
        openai: { defaultModel: "openai/gpt-5.4" },
        anthropic: { defaultModel: "anthropic/claude-sonnet-4-5" },
        openrouter: { defaultModel: "openrouter/anthropic/claude-sonnet-4-5" },
        gemini: { defaultModel: "gemini/gemini-2.5-pro" },
        groq: { defaultModel: "groq/llama-3.3-70b-versatile" },
        together: { defaultModel: "together/deepseek-r1" },
        xai: { defaultModel: "xai/grok-4-fast" },
      },
    };

    getRuntimeSettings.mockImplementation(async () => runtimeSettings);
    updateRuntimeSettings.mockImplementation(
      async (update: Record<string, unknown>) => {
        runtimeSettings = {
          ...runtimeSettings,
          ...update,
        };
        return runtimeSettings;
      },
    );
    getJsonSetting.mockResolvedValue(null);
    setJsonSetting.mockResolvedValue(undefined);
    getProcessEnv.mockResolvedValue({});
    runCommand.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
  });

  it("writes safeguard compaction and cache-ttl pruning for Anthropic-backed models", async () => {
    vi.spyOn(
      openclawService as never,
      "readCurrentConfig" as never,
    ).mockReturnValue(null);
    const execSpy = vi
      .spyOn(openclawService as never, "execOpenClaw" as never)
      .mockResolvedValue("");

    await openclawService.setSmartContextManagement(true);

    const compactionArgs = execSpy.mock.calls[0]?.[0] as string[];
    const pruningArgs = execSpy.mock.calls[1]?.[0] as string[];
    const compaction = JSON.parse(compactionArgs[3] ?? "{}") as Record<
      string,
      unknown
    >;
    const pruning = JSON.parse(pruningArgs[3] ?? "{}") as Record<
      string,
      unknown
    >;

    expect(compaction.mode).toBe("safeguard");
    expect(compaction.reserveTokensFloor).toBe(24000);
    expect((compaction.memoryFlush as { enabled: boolean }).enabled).toBe(true);
    expect(
      (compaction.memoryFlush as { softThresholdTokens: number })
        .softThresholdTokens,
    ).toBe(6000);
    expect(pruning.mode).toBe("cache-ttl");
    expect((pruning.tools as { deny: string[] }).deny).toEqual([
      "browser",
      "canvas",
    ]);
  });

  it("turns pruning off for local runtimes while keeping compaction active", async () => {
    runtimeSettings.activeProviderId = "ollama-default";
    vi.spyOn(
      openclawService as never,
      "readCurrentConfig" as never,
    ).mockReturnValue(null);
    const execSpy = vi
      .spyOn(openclawService as never, "execOpenClaw" as never)
      .mockResolvedValue("");

    await openclawService.setSmartContextManagement(true);

    const compactionArgs = execSpy.mock.calls[0]?.[0] as string[];
    const pruningArgs = execSpy.mock.calls[1]?.[0] as string[];
    const compaction = JSON.parse(compactionArgs[3] ?? "{}") as Record<
      string,
      unknown
    >;
    const pruning = JSON.parse(pruningArgs[3] ?? "{}") as Record<
      string,
      unknown
    >;

    expect(compaction.mode).toBe("safeguard");
    expect(pruning.mode).toBe("off");
  });

  it("writes the currently selected Ollama model into the default primary model", async () => {
    runtimeSettings.activeProviderId = "ollama-default";
    runtimeSettings.ollamaModel = "qwen3.5:4b";
    vi.spyOn(
      openclawService as never,
      "readCurrentConfig" as never,
    ).mockReturnValue(null);
    const execSpy = vi
      .spyOn(openclawService as never, "execOpenClaw" as never)
      .mockResolvedValue("");

    await openclawService.ensureConfigured();

    const modelArgs = execSpy.mock.calls.find(
      (call) => (call[0] as string[])[2] === "agents.defaults.model.primary",
    )?.[0] as string[] | undefined;

    expect(modelArgs).toBeDefined();
    expect(JSON.parse(modelArgs?.[3] ?? '""')).toBe("ollama/qwen3.5:4b");
  });

  it("skips config writes when the desired OpenClaw config is already present", async () => {
    runtimeSettings.activeProviderId = "ollama-default";
    runtimeSettings.ollamaModel = "qwen3.5:4b";
    const currentConfig = {
      gateway: {
        mode: "local",
        port: 18789,
        bind: "loopback",
        auth: {
          mode: "token",
          token: "existing-token",
        },
        http: {
          endpoints: {
            chatCompletions: {
              enabled: true,
            },
          },
        },
      },
      agents: {
        defaults: {
          workspace: paths.workspaceRoot,
          model: {
            primary: "ollama/qwen3.5:4b",
          },
          imageModel: {
            primary: "ollama/qwen2.5vl:3b",
          },
          pdfModel: {
            primary: "ollama/qwen2.5vl:3b",
          },
          thinkingDefault: "off",
          memorySearch: {
            provider: "ollama",
            fallback: "none",
            model: "embeddinggemma:300m-qat-q8_0",
            extraPaths: ["MEMORY.md", "PREFERENCES.md", "skills/**/*.md"],
            cache: {
              enabled: true,
              maxEntries: 50000,
            },
            experimental: {
              sessionMemory: true,
            },
            sources: ["memory", "sessions"],
            sync: {
              sessions: {
                deltaBytes: 100000,
                deltaMessages: 50,
              },
            },
          },
          compaction: {
            mode: "safeguard",
            timeoutSeconds: 900,
            reserveTokensFloor: 16384,
            identifierPolicy: "strict",
            postCompactionSections: ["Session Startup", "Red Lines"],
            memoryFlush: {
              enabled: true,
              softThresholdTokens: 5242,
              systemPrompt:
                "Session nearing compaction. Store durable memories now.",
              prompt:
                "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",
            },
          },
          contextPruning: {
            mode: "off",
          },
        },
      },
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            api: "ollama",
            apiKey: "ollama-local",
            models: [
              {
                id: "qwen3.5:4b",
                name: "qwen3.5:4b",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 65536,
            maxTokens: 65536,
              },
              {
                id: "qwen2.5vl:3b",
                name: "qwen2.5vl:3b",
                reasoning: false,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 65536,
                maxTokens: 65536,
              },
            ],
          },
        },
      },
      hooks: {
        internal: {
          entries: {
            "bootstrap-extra-files": {
              paths: [
                "SOUL.md",
                "IDENTITY.md",
                "USER.md",
                "MEMORY.md",
                "PREFERENCES.md",
                "HEARTBEAT.md",
                "memory/**/*.md",
                "skills/**/*.md",
              ],
            },
          },
        },
      },
      tools: {
        profile: "coding",
        allow: ["pdf"],
        exec: {
          host: "gateway",
          security: "allowlist",
          ask: "on-miss",
        },
        fs: {
          workspaceOnly: true,
        },
      },
      channels: {
        signal: {
          dmPolicy: "pairing",
          groupPolicy: "disabled",
        },
      },
    };

    vi.spyOn(
      openclawService as never,
      "readCurrentConfig" as never,
    ).mockReturnValue(currentConfig);
    const execSpy = vi
      .spyOn(openclawService as never, "execOpenClaw" as never)
      .mockResolvedValue("");
    getJsonSetting.mockImplementation(async (key: string) => {
      if (key === "openclawGatewayToken") {
        return "existing-token";
      }
      return null;
    });

    await openclawService.ensureConfigured();

    expect(execSpy).not.toHaveBeenCalled();
  });

  it("treats equivalent config objects with different key order as unchanged", async () => {
    runtimeSettings.activeProviderId = "ollama-default";
    runtimeSettings.ollamaModel = "qwen3.5:4b";
    const currentConfig = {
      agents: {
        defaults: {
          workspace: paths.workspaceRoot,
          memorySearch: {
            provider: "ollama",
            fallback: "none",
            model: "embeddinggemma:300m-qat-q8_0",
            extraPaths: ["MEMORY.md", "PREFERENCES.md", "skills/**/*.md"],
            sync: {
              sessions: {
                deltaMessages: 50,
                deltaBytes: 100000,
              },
            },
            sources: ["memory", "sessions"],
            experimental: {
              sessionMemory: true,
            },
            cache: {
              maxEntries: 50000,
              enabled: true,
            },
          },
          compaction: {
            mode: "safeguard",
            reserveTokensFloor: 16384,
            identifierPolicy: "strict",
            postCompactionSections: ["Session Startup", "Red Lines"],
            timeoutSeconds: 900,
            memoryFlush: {
              enabled: true,
              softThresholdTokens: 5242,
              prompt:
                "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",
              systemPrompt:
                "Session nearing compaction. Store durable memories now.",
            },
          },
          contextPruning: {
            mode: "off",
          },
          thinkingDefault: "off",
          imageModel: {
            primary: "ollama/qwen2.5vl:3b",
          },
          pdfModel: {
            primary: "ollama/qwen2.5vl:3b",
          },
          model: {
            primary: "ollama/qwen3.5:4b",
          },
        },
      },
      models: {
        providers: {
          ollama: {
            models: [
              {
                maxTokens: 65536,
                cost: { cacheWrite: 0, input: 0, cacheRead: 0, output: 0 },
                contextWindow: 65536,
                input: ["text"],
                reasoning: false,
                name: "qwen3.5:4b",
                id: "qwen3.5:4b",
              },
              {
                maxTokens: 65536,
                cost: { cacheWrite: 0, input: 0, cacheRead: 0, output: 0 },
                contextWindow: 65536,
                input: ["text", "image"],
                reasoning: false,
                name: "qwen2.5vl:3b",
                id: "qwen2.5vl:3b",
              },
            ],
            api: "ollama",
            apiKey: "ollama-local",
            baseUrl: "http://127.0.0.1:11434",
          },
        },
      },
      gateway: {
        auth: {
          token: "existing-token",
          mode: "token",
        },
        http: {
          endpoints: {
            chatCompletions: {
              enabled: true,
            },
          },
        },
        bind: "loopback",
        port: 18789,
        mode: "local",
      },
      hooks: {
        internal: {
          entries: {
            "bootstrap-extra-files": {
              paths: [
                "SOUL.md",
                "IDENTITY.md",
                "USER.md",
                "MEMORY.md",
                "PREFERENCES.md",
                "HEARTBEAT.md",
                "memory/**/*.md",
                "skills/**/*.md",
              ],
            },
          },
        },
      },
      tools: {
        profile: "coding",
        allow: ["pdf"],
        exec: {
          ask: "on-miss",
          security: "allowlist",
          host: "gateway",
        },
        fs: {
          workspaceOnly: true,
        },
      },
      channels: {
        signal: {
          groupPolicy: "disabled",
          dmPolicy: "pairing",
        },
      },
    };

    vi.spyOn(
      openclawService as never,
      "readCurrentConfig" as never,
    ).mockReturnValue(currentConfig);
    const execSpy = vi
      .spyOn(openclawService as never, "execOpenClaw" as never)
      .mockResolvedValue("");
    getJsonSetting.mockImplementation(async (key: string) => {
      if (key === "openclawGatewayToken") {
        return "existing-token";
      }
      return null;
    });

    await openclawService.ensureConfigured();

    expect(execSpy).not.toHaveBeenCalled();
  });

  it("reuses a healthy externally managed gateway instead of spawning a new local process", async () => {
    vi.spyOn(openclawService, "ensureConfigured").mockResolvedValue(undefined);
    vi.spyOn(
      openclawService as never,
      "ensureOperatorExecAllowlist" as never,
    ).mockResolvedValue(undefined);
    const execSpy = vi
      .spyOn(openclawService as never, "execOpenClaw" as never)
      .mockResolvedValueOnce(JSON.stringify({ version: "2026.3.24" }));

    await openclawService.startGateway();

    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(setJsonSetting).not.toHaveBeenCalledWith(
      "openclawStartedAt",
      expect.anything(),
    );
  });

  it("surfaces a port conflict when another OpenClaw service owns the configured gateway port", async () => {
    vi.spyOn(
      openclawService as never,
      "execOpenClaw" as never,
    ).mockRejectedValue(
      new Error(
        "gateway connect failed: GatewayClientRequestError: unauthorized: gateway token mismatch",
      ),
    );
    runCommand
      .mockResolvedValueOnce({
        stdout: "p87974\n",
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: "openclaw-gateway\n",
        stderr: "",
        exitCode: 0,
      });

    const status = await openclawService.status();

    expect(status.health).toBe("warn");
    expect(status.healthMessage).toContain(
      "A different OpenClaw service is already using the configured DroidAgent gateway port.",
    );
    expect(status.healthMessage).toContain("openclaw-gateway");
    expect(status.metadata).toMatchObject({
      portOwnerPid: 87974,
      portOwnerCommand: "openclaw-gateway",
    });
  });

  it("filters internal heartbeat sessions and keeps a stable operator chat session", async () => {
    vi.spyOn(openclawService, "callGateway").mockResolvedValue([
      {
        key: "agent:main:main",
        displayName: "heartbeat",
        derivedTitle: "Hello",
        updatedAtMs: 1_710_000_000_000,
        lastMessagePreview: "ignore this",
      },
      {
        key: "signal:+15551234567",
        derivedTitle: "Signal thread",
        updatedAtMs: 1_710_000_000_500,
        lastMessagePreview: "pairing request",
      },
    ] as never);

    const sessions = await openclawService.listSessions();

    expect(sessions[0]).toMatchObject({
      id: "web:operator",
      title: "Operator Chat",
      scope: "web",
    });
    expect(sessions.some((session) => session.id === "agent:main:main")).toBe(
      false,
    );
    expect(
      sessions.some((session) => session.id === "signal:+15551234567"),
    ).toBe(true);
  });

  it("renders structured history content into readable chat messages", async () => {
    vi.spyOn(openclawService, "callGateway").mockResolvedValue({
      messages: [
        {
          id: "message-user",
          role: "user",
          ts: 1_710_000_000_000,
          content: [
            {
              type: "text",
              text: "Read HEARTBEAT.md if it exists.",
            },
          ],
        },
        {
          id: "message-assistant",
          role: "assistant",
          ts: 1_710_000_000_100,
          content: [
            {
              type: "toolCall",
              name: "read",
              arguments: {
                path: "/tmp/HEARTBEAT.md",
              },
            },
          ],
        },
        {
          id: "message-tool",
          role: "toolResult",
          ts: 1_710_000_000_200,
          content: [
            {
              type: "text",
              text: "HEARTBEAT_OK",
            },
          ],
        },
      ],
    } as never);

    const messages = await openclawService.loadHistory("web:operator");

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      role: "user",
      text: "Read HEARTBEAT.md if it exists.",
    });
    expect(messages[1]?.role).toBe("assistant");
    expect(messages[1]?.text).toContain("Tool call: read");
    expect(messages[1]?.text).toContain('"path": "/tmp/HEARTBEAT.md"');
    expect(messages[2]).toMatchObject({
      role: "tool",
      text: "HEARTBEAT_OK",
    });
  });

  it("strips attachment envelopes from history while preserving attachment metadata", async () => {
    vi.spyOn(openclawService, "callGateway").mockResolvedValue({
      messages: [
        {
          id: "message-user",
          role: "user",
          ts: 1_710_000_000_000,
          content: `<<DROIDAGENT_ATTACHMENTS_V1>>
{
  "text": "Inspect the attached files.",
  "attachments": [
    {
      "id": "attachment-1",
      "name": "notes.md",
      "kind": "markdown",
      "mimeType": "text/markdown",
      "size": 120,
      "url": "/api/chat/uploads/attachment-1",
      "filePath": "/tmp/notes.md"
    }
  ]
}
<<END_DROIDAGENT_ATTACHMENTS_V1>>
Local attachments are available for this request.
User request:
Inspect the attached files.`,
        },
      ],
    } as never);

    const messages = await openclawService.loadHistory("web:operator");

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "user",
      text: "Inspect the attached files.",
    });
    expect(messages[0]?.attachments).toEqual([
      expect.objectContaining({
        id: "attachment-1",
        name: "notes.md",
        kind: "markdown",
      }),
    ]);
  });

  it("surfaces the live harness tool and session policy", async () => {
    runtimeSettings.activeProviderId = "ollama-default";
    runtimeSettings.ollamaModel = "qwen3.5:4b";
    vi.spyOn(
      openclawService as never,
      "readCurrentConfig" as never,
    ).mockReturnValue({
      gateway: {
        auth: {
          mode: "token",
        },
        bind: "loopback",
      },
      agents: {
        defaults: {
          thinkingDefault: "off",
          imageModel: {
            primary: "ollama/qwen2.5vl:3b",
          },
          pdfModel: {
            primary: "ollama/qwen2.5vl:3b",
          },
          memorySearch: {
            cache: {
              enabled: true,
            },
            experimental: {
              sessionMemory: true,
            },
          },
        },
      },
      tools: {
        profile: "coding",
        allow: ["pdf"],
        exec: {
          host: "gateway",
          security: "allowlist",
          ask: "on-miss",
        },
        fs: {
          workspaceOnly: true,
        },
      },
    });

    const status = await openclawService.harnessStatus();

    expect(status).toMatchObject({
      configured: true,
      agentId: "main",
      defaultSessionId: "web:operator",
      gatewayAuthMode: "token",
      gatewayBind: "loopback",
      activeModel: "ollama/qwen3.5:4b",
      contextWindow: 65536,
      imageModel: "ollama/qwen2.5vl:3b",
      pdfModel: "ollama/qwen2.5vl:3b",
      toolProfile: "coding",
      workspaceOnlyFs: true,
      memorySearchEnabled: true,
      sessionMemoryEnabled: true,
      attachmentsEnabled: true,
      execHost: "gateway",
      execSecurity: "allowlist",
      execAsk: "on-miss",
    });
    expect(status.availableTools).toEqual(
      expect.arrayContaining([
        "read",
        "write",
        "edit",
        "apply_patch",
        "exec",
        "process",
        "sessions_history",
        "subagents",
        "memory_search",
        "pdf",
      ]),
    );
  });

  it("reports workspace memory readiness with session memory enabled", async () => {
    runtimeSettings.activeProviderId = "ollama-default";
    vi.spyOn(
      openclawService as never,
      "readCurrentConfig" as never,
    ).mockReturnValue({
      agents: {
        defaults: {
          memorySearch: {
            provider: "ollama",
            fallback: "none",
            model: "embeddinggemma:300m-qat-q8_0",
            cache: {
              enabled: true,
            },
            experimental: {
              sessionMemory: true,
            },
          },
        },
      },
    });

    const status = await openclawService.memoryStatus();

    expect(status.contextWindow).toBe(65536);
    expect(status.memorySearchEnabled).toBe(true);
    expect(status.sessionMemoryEnabled).toBe(true);
    expect(status.embeddingRequestedProvider).toBe("ollama");
    expect(status.embeddingModel).toBe("embeddinggemma:300m-qat-q8_0");
    expect(status.bootstrapFiles.some((file) => file.path === "MEMORY.md")).toBe(
      true,
    );
  });

  it("surfaces live local embedding status and index counts", async () => {
    runtimeSettings.activeProviderId = "ollama-default";
    vi.spyOn(
      openclawService as never,
      "readCurrentConfig" as never,
    ).mockReturnValue({
      agents: {
        defaults: {
          memorySearch: {
            provider: "ollama",
            fallback: "none",
            model: "embeddinggemma:300m-qat-q8_0",
            cache: {
              enabled: true,
            },
            experimental: {
              sessionMemory: true,
            },
          },
        },
      },
    });
    vi.spyOn(openclawService as never, "execOpenClaw" as never).mockResolvedValue(
      JSON.stringify([
        {
          agentId: "main",
          status: {
            files: 4,
            chunks: 18,
            dirty: false,
            provider: "ollama",
            model: "embeddinggemma:300m-qat-q8_0",
            requestedProvider: "ollama",
            sourceCounts: [
              { source: "memory", files: 2, chunks: 8 },
              { source: "sessions", files: 2, chunks: 10 },
            ],
            vector: {
              enabled: true,
              available: true,
            },
          },
          embeddingProbe: {
            ok: true,
          },
        },
      ]),
    );

    const status = await openclawService.memoryStatus();

    expect(status.semanticReady).toBe(true);
    expect(status.embeddingProvider).toBe("ollama");
    expect(status.indexedFiles).toBe(4);
    expect(status.indexedChunks).toBe(18);
    expect(status.sourceCounts).toEqual([
      { source: "memory", files: 2, chunks: 8 },
      { source: "sessions", files: 2, chunks: 10 },
    ]);
  });

  it("skips aborting the gateway when starting a fresh session run", async () => {
    const ensureConfiguredSpy = vi
      .spyOn(openclawService as never, "ensureConfigured" as never)
      .mockResolvedValue(undefined);
    vi.spyOn(
      openclawService as never,
      "ensureOperatorExecAllowlist" as never,
    ).mockResolvedValue(undefined);
    const abortMessageSpy = vi
      .spyOn(openclawService, "abortMessage")
      .mockResolvedValue(undefined);
    const streamMessageRunSpy = vi
      .spyOn(openclawService as never, "streamMessageRun" as never)
      .mockResolvedValue(undefined);

    await openclawService.sendMessage("web:operator", {
      text: "hello",
      attachments: [],
    }, {
      onDelta: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    });

    expect(ensureConfiguredSpy).toHaveBeenCalledTimes(1);
    expect(abortMessageSpy).not.toHaveBeenCalled();
    expect(streamMessageRunSpy).toHaveBeenCalledTimes(1);
  });

  it("aborts the previous run before replacing an active session run", async () => {
    const ensureConfiguredSpy = vi
      .spyOn(openclawService as never, "ensureConfigured" as never)
      .mockResolvedValue(undefined);
    vi.spyOn(
      openclawService as never,
      "ensureOperatorExecAllowlist" as never,
    ).mockResolvedValue(undefined);
    const abortMessageSpy = vi
      .spyOn(openclawService, "abortMessage")
      .mockResolvedValue(undefined);
    const streamMessageRunSpy = vi
      .spyOn(openclawService as never, "streamMessageRun" as never)
      .mockResolvedValue(undefined);

    (
      openclawService as unknown as {
        activeRuns: Map<string, unknown>;
      }
    ).activeRuns.set("web:operator", {
      runId: "existing-run",
      controller: new AbortController(),
    });

    await openclawService.sendMessage("web:operator", {
      text: "hello again",
      attachments: [],
    }, {
      onDelta: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    });

    expect(ensureConfiguredSpy).toHaveBeenCalledTimes(1);
    expect(abortMessageSpy).toHaveBeenCalledTimes(1);
    expect(abortMessageSpy).toHaveBeenCalledWith("web:operator");
    expect(streamMessageRunSpy).toHaveBeenCalledTimes(1);
  });
});
