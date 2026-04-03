import { beforeEach, describe, expect, it, vi } from "vitest";

import { OPENCLAW_GATEWAY_URL, paths } from "../env.js";

const {
  getRuntimeSettings,
  updateRuntimeSettings,
  getJsonSetting,
  setJsonSetting,
  getMemoryPrepareStatus,
  getProcessEnv,
  runCommand,
  findProcesses,
  terminateProcesses,
  gatewayClientRequest,
  gatewayClientInstances,
  MockGatewayClient,
} = vi.hoisted(() => {
  const gatewayClientRequest = vi.fn();
  const gatewayClientInstances: Array<{
    opts: {
      onHelloOk?: ((hello: unknown) => void) | undefined;
      onEvent?: ((event: { event: string; payload: unknown; seq?: number }) => void) | undefined;
    };
    emitEvent: (event: string, payload: unknown, seq?: number) => void;
  }> = [];

  class MockGatewayClient {
    readonly opts: {
      onHelloOk?: ((hello: unknown) => void) | undefined;
      onEvent?: ((event: { event: string; payload: unknown; seq?: number }) => void) | undefined;
    };

    constructor(
      opts: {
        onHelloOk?: ((hello: unknown) => void) | undefined;
        onEvent?: ((event: { event: string; payload: unknown; seq?: number }) => void) | undefined;
      },
    ) {
      this.opts = opts;
      gatewayClientInstances.push(this);
    }

    start(): void {
      this.opts.onHelloOk?.({});
    }

    stop(): void {}

    async stopAndWait(): Promise<void> {}

    async request<T = unknown>(
      method: string,
      params?: unknown,
      opts?: unknown,
    ): Promise<T> {
      return await gatewayClientRequest(method, params, opts);
    }

    emitEvent(event: string, payload: unknown, seq?: number): void {
      this.opts.onEvent?.({
        event,
        payload,
        ...(typeof seq === "number" ? { seq } : {}),
      });
    }
  }

  return {
    getRuntimeSettings: vi.fn(),
    updateRuntimeSettings: vi.fn(),
    getJsonSetting: vi.fn(),
    setJsonSetting: vi.fn(),
    getMemoryPrepareStatus: vi.fn(),
    getProcessEnv: vi.fn(),
    runCommand: vi.fn(),
    findProcesses: vi.fn(),
    terminateProcesses: vi.fn(),
    gatewayClientRequest,
    gatewayClientInstances,
    MockGatewayClient,
  };
});

vi.mock("./app-state-service.js", () => ({
  DEFAULT_OLLAMA_VISION_MODEL: "qwen2.5vl:3b",
  appStateService: {
    getRuntimeSettings,
    updateRuntimeSettings,
    getJsonSetting,
    setJsonSetting,
    getMemoryPrepareStatus,
  },
}));

vi.mock("./keychain-service.js", () => ({
  keychainService: {
    getProcessEnv,
  },
}));

vi.mock("../lib/process.js", () => ({
  runCommand,
  findProcesses,
  terminateProcesses,
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

vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  GatewayClient: MockGatewayClient,
}));

import { openclawService } from "./openclaw-service.js";

type RelaySpies = {
  onDelta: ReturnType<typeof vi.fn>;
  onDone: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
  onState: ReturnType<typeof vi.fn>;
};

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
    gatewayClientRequest.mockReset();
    gatewayClientRequest.mockResolvedValue({});
    gatewayClientInstances.length = 0;
    (
      openclawService as unknown as { gatewayToken: string | null }
    ).gatewayToken = null;
    (
      openclawService as unknown as { gatewayProcess: unknown | null }
    ).gatewayProcess = null;
    (
      openclawService as unknown as {
        liveGatewayClient: unknown | null;
        liveGatewayClientReadyPromise: Promise<unknown> | null;
      }
    ).liveGatewayClient = null;
    (
      openclawService as unknown as {
        liveGatewayClient: unknown | null;
        liveGatewayClientReadyPromise: Promise<unknown> | null;
      }
    ).liveGatewayClientReadyPromise = null;
    (
      openclawService as unknown as {
        liveGatewayEventListeners: Set<unknown>;
      }
    ).liveGatewayEventListeners = new Set();
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
    getMemoryPrepareStatus.mockResolvedValue({
      state: "idle",
      startedAt: null,
      finishedAt: null,
      progressLabel: null,
      error: null,
      lastDurationMs: null,
      updatedAt: "2026-03-29T00:00:00.000Z",
    });
    getProcessEnv.mockResolvedValue({});
    runCommand.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    findProcesses.mockResolvedValue([]);
    terminateProcesses.mockResolvedValue(undefined);
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

  it("reuses the active Ollama model for image and pdf work when the model supports vision", async () => {
    runtimeSettings.activeProviderId = "ollama-default";
    runtimeSettings.ollamaModel = "qwen3.5:4b";
    runCommand.mockResolvedValue({
      stdout: `
  Capabilities
    completion
    vision
    tools
`,
      stderr: "",
      exitCode: 0,
    });
    vi.spyOn(
      openclawService as never,
      "readCurrentConfig" as never,
    ).mockReturnValue(null);
    const execSpy = vi
      .spyOn(openclawService as never, "execOpenClaw" as never)
      .mockResolvedValue("");

    await openclawService.ensureConfigured();

    const imageModelArgs = execSpy.mock.calls.find(
      (call) => (call[0] as string[])[2] === "agents.defaults.imageModel.primary",
    )?.[0] as string[] | undefined;
    const pdfModelArgs = execSpy.mock.calls.find(
      (call) => (call[0] as string[])[2] === "agents.defaults.pdfModel.primary",
    )?.[0] as string[] | undefined;
    const providerArgs = execSpy.mock.calls.find(
      (call) => (call[0] as string[])[2] === "models.providers.ollama",
    )?.[0] as string[] | undefined;
    const providerConfig = JSON.parse(providerArgs?.[3] ?? "{}") as {
      models?: Array<{ id: string; input: string[] }>;
    };

    expect(JSON.parse(imageModelArgs?.[3] ?? '""')).toBe("ollama/qwen3.5:4b");
    expect(JSON.parse(pdfModelArgs?.[3] ?? '""')).toBe("ollama/qwen3.5:4b");
    expect(providerConfig.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "qwen3.5:4b",
          input: ["text", "image"],
        }),
      ]),
    );
    expect(providerConfig.models).toHaveLength(1);
  });

  it("reuses the active llama.cpp model for image and pdf work when the selected repo supports vision", async () => {
    runtimeSettings.activeProviderId = "llamacpp-default";
    runtimeSettings.llamaCppModel = "unsloth/gemma-4-E4B-it-GGUF:Q4_K_M";
    vi.spyOn(
      openclawService as never,
      "readCurrentConfig" as never,
    ).mockReturnValue(null);
    const execSpy = vi
      .spyOn(openclawService as never, "execOpenClaw" as never)
      .mockResolvedValue("");

    await openclawService.ensureConfigured();

    const imageModelArgs = execSpy.mock.calls.find(
      (call) => (call[0] as string[])[2] === "agents.defaults.imageModel.primary",
    )?.[0] as string[] | undefined;
    const pdfModelArgs = execSpy.mock.calls.find(
      (call) => (call[0] as string[])[2] === "agents.defaults.pdfModel.primary",
    )?.[0] as string[] | undefined;

    expect(JSON.parse(imageModelArgs?.[3] ?? '""')).toBe(
      "llamacpp/gemma-4-e4b-it-gguf:q4_k_m",
    );
    expect(JSON.parse(pdfModelArgs?.[3] ?? '""')).toBe(
      "llamacpp/gemma-4-e4b-it-gguf:q4_k_m",
    );
  });

  it("registers llama.cpp multimodal providers with text-and-image input when vision is enabled", async () => {
    const execSpy = vi
      .spyOn(openclawService as never, "execOpenClaw" as never)
      .mockResolvedValue("");

    await openclawService.registerLlamaCppProvider(
      "gemma-4-e4b-it-gguf:q4_k_m",
      65536,
      true,
    );

    const providerArgs = execSpy.mock.calls.find(
      (call) => (call[0] as string[])[2] === "models.providers.llamacpp",
    )?.[0] as string[] | undefined;
    const providerConfig = JSON.parse(providerArgs?.[3] ?? "{}") as {
      models?: Array<{ id: string; input: string[] }>;
    };

    expect(providerConfig.models).toEqual([
      expect.objectContaining({
        id: "gemma-4-e4b-it-gguf:q4_k_m",
        input: ["text", "image"],
      }),
    ]);
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
        remote: {
          url: OPENCLAW_GATEWAY_URL,
          token: "existing-token",
        },
        tailscale: {
          mode: "off",
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
            extraPaths: [
              "PREFERENCES.md",
              "MEMORY.md",
              "memory/**/*.md",
              "skills/**/*.md",
            ],
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
                "Session nearing compaction. Store durable memories now in a short structured note.",
              prompt:
                "Append durable notes to memory/YYYY-MM-DD.md with sections Summary, Decisions, Next Steps, and Durable Memory Candidates. Reply with NO_REPLY if nothing durable should be stored.",
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
          enabled: false,
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
            extraPaths: [
              "PREFERENCES.md",
              "MEMORY.md",
              "memory/**/*.md",
              "skills/**/*.md",
            ],
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
                "Append durable notes to memory/YYYY-MM-DD.md with sections Summary, Decisions, Next Steps, and Durable Memory Candidates. Reply with NO_REPLY if nothing durable should be stored.",
              systemPrompt:
                "Session nearing compaction. Store durable memories now in a short structured note.",
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
        remote: {
          url: OPENCLAW_GATEWAY_URL,
          token: "existing-token",
        },
        tailscale: {
          mode: "off",
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
          enabled: false,
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
      "inspectGatewayPortOwner" as never,
    ).mockResolvedValue({
      pid: 4242,
      command:
        "/Users/admin/Downloads/VSCode/DroidAgent/apps/server/node_modules/.bin/openclaw --profile droidagent gateway run",
    });
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
    expect(terminateProcesses).not.toHaveBeenCalled();
  });

  it("refuses to reuse a healthy foreign OpenClaw gateway on the DroidAgent port", async () => {
    vi.spyOn(openclawService, "ensureConfigured").mockResolvedValue(undefined);
    vi.spyOn(
      openclawService as never,
      "inspectGatewayPortOwner" as never,
    ).mockResolvedValue({
      pid: 8181,
      command:
        "/Applications/Atomic Bot.app/Contents/MacOS/Atomic Bot --gateway openclaw",
    });
    const allowlistSpy = vi.spyOn(
      openclawService as never,
      "ensureOperatorExecAllowlist" as never,
    );
    const execSpy = vi
      .spyOn(openclawService as never, "execOpenClaw" as never)
      .mockResolvedValueOnce(JSON.stringify({ version: "2026.3.31" }));

    await expect(openclawService.startGateway()).rejects.toThrow(
      "A different OpenClaw service is already using the configured DroidAgent gateway port.",
    );

    expect(execSpy).not.toHaveBeenCalled();
    expect(allowlistSpy).not.toHaveBeenCalled();
  });

  it("reuses the tracked gateway when the port owner command is generic", async () => {
    vi.spyOn(openclawService, "ensureConfigured").mockResolvedValue(undefined);
    (
      openclawService as unknown as {
        gatewayProcess: { pid: number; exitCode: null };
      }
    ).gatewayProcess = {
      pid: 5151,
      exitCode: null,
    };
    vi.spyOn(
      openclawService as never,
      "inspectGatewayPortOwner" as never,
    ).mockResolvedValue({
      pid: 5151,
      command: "openclaw-gateway",
    });
    vi.spyOn(
      openclawService as never,
      "ensureOperatorExecAllowlist" as never,
    ).mockResolvedValue(undefined);
    const execSpy = vi
      .spyOn(openclawService as never, "execOpenClaw" as never)
      .mockResolvedValueOnce(JSON.stringify({ version: "2026.3.31" }));

    await openclawService.startGateway();

    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(terminateProcesses).not.toHaveBeenCalled();
  });

  it("cleans up orphaned DroidAgent OpenClaw workers without touching unrelated processes", async () => {
    findProcesses.mockImplementation(
      async (
        predicate: (processInfo: { pid: number; command: string }) => boolean,
      ) =>
        [
          {
            pid: 12345,
            command:
              "/Users/admin/Downloads/VSCode/DroidAgent/apps/server/node_modules/.bin/openclaw --profile droidagent sessions list",
          },
          {
            pid: 555,
            command: "/usr/local/bin/openclaw --profile personal gateway run",
          },
        ].filter(predicate),
    );

    await (
      openclawService as unknown as {
        cleanupManagedOpenClawProcesses: (params?: {
          excludePids?: number[];
        }) => Promise<void>;
      }
    ).cleanupManagedOpenClawProcesses();

    expect(terminateProcesses).toHaveBeenCalledWith([12345], {
      timeoutMs: 2_000,
    });
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
    expect(messages[1]?.parts).toEqual([
      expect.objectContaining({
        type: "tool_call_summary",
        toolName: "read",
      }),
    ]);
    expect(messages[2]).toMatchObject({
      role: "tool",
      text: "HEARTBEAT_OK",
    });
    expect(messages[2]?.parts).toEqual([
      expect.objectContaining({
        type: "tool_result_summary",
        summary: "Tool returned output",
        details: "HEARTBEAT_OK",
      }),
    ]);
  });

  it("preserves assistant text around structured tool calls without flattening it", async () => {
    vi.spyOn(openclawService, "callGateway").mockResolvedValue({
      messages: [
        {
          id: "message-assistant",
          role: "assistant",
          ts: 1_710_000_010_000,
          content: [
            {
              type: "text",
              text: "I am checking the workspace now.",
            },
            {
              type: "toolCall",
              name: "read",
              arguments: {
                path: "/tmp/README.md",
              },
            },
            {
              type: "text",
              text: "I found the file and will summarize it next.",
            },
          ],
        },
      ],
    } as never);

    const messages = await openclawService.loadHistory("web:operator");

    expect(messages).toHaveLength(1);
    expect(messages[0]?.parts).toEqual([
      expect.objectContaining({
        type: "markdown",
        text: "I am checking the workspace now.",
      }),
      expect.objectContaining({
        type: "tool_call_summary",
        toolName: "read",
      }),
      expect.objectContaining({
        type: "markdown",
        text: "I found the file and will summarize it next.",
      }),
    ]);
  });

  it("deduplicates repeated structured history parts before rendering", async () => {
    vi.spyOn(openclawService, "callGateway").mockResolvedValue({
      messages: [
        {
          id: "message-assistant",
          role: "assistant",
          ts: 1_710_000_020_000,
          content: [
            {
              type: "text",
              text: "Checking the workspace.",
            },
            {
              type: "text",
              text: "Checking the workspace.",
            },
            {
              type: "toolCall",
              name: "read",
              arguments: {
                path: "/tmp/README.md",
              },
            },
            {
              type: "toolCall",
              name: "read",
              arguments: {
                path: "/tmp/README.md",
              },
            },
            {
              type: "text",
              text: "Done.",
            },
            {
              type: "text",
              text: "Done.",
            },
          ],
        },
      ],
    } as never);

    const messages = await openclawService.loadHistory("web:operator");

    expect(messages).toHaveLength(1);
    expect(messages[0]?.parts).toEqual([
      expect.objectContaining({
        type: "markdown",
        text: "Checking the workspace.",
      }),
      expect.objectContaining({
        type: "tool_call_summary",
        toolName: "read",
      }),
      expect.objectContaining({
        type: "markdown",
        text: "Done.",
      }),
    ]);
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
    expect(messages[0]?.parts).toEqual([
      expect.objectContaining({
        type: "attachments",
      }),
      expect.objectContaining({
        type: "markdown",
        text: "Inspect the attached files.",
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

  it("keeps abort non-fatal and forwards the active run id to the gateway abort request", async () => {
    vi.spyOn(openclawService as never, "startGateway" as never).mockResolvedValue(
      undefined,
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const throwingController = {
      abort: vi.fn(() => {
        throw new DOMException("This operation was aborted", "AbortError");
      }),
    };

    (
      openclawService as unknown as {
        activeRuns: Map<string, { controller: { abort: () => void }; runId: string }>;
      }
    ).activeRuns.set("web:operator", {
      runId: "run-123",
      controller: throwingController,
    });

    await openclawService.abortMessage("web:operator");

    expect(throwingController.abort).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(gatewayClientRequest).toHaveBeenCalledWith(
      "chat.abort",
      {
        sessionKey: "web:operator",
        runId: "run-123",
      },
      {},
    );
    expect(
      (
        openclawService as unknown as {
          activeRuns: Map<string, unknown>;
        }
      ).activeRuns.has("web:operator"),
    ).toBe(false);
  });

  it("streams chat over the gateway event client and relays tool updates", async () => {
    vi.spyOn(openclawService as never, "startGateway" as never).mockResolvedValue(
      undefined,
    );
    gatewayClientRequest.mockImplementation(async (method, params) => {
      if (method === "chat.send") {
        return {
          runId: (params as { idempotencyKey: string }).idempotencyKey,
          status: "started",
        };
      }
      return {};
    });

    const relay: RelaySpies = {
      onDelta: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onState: vi.fn(),
    };

    const streamPromise = (
      openclawService as unknown as {
        streamMessageRun: (
          sessionKey: string,
          message: string,
          runId: string,
          controller: AbortController,
          relay: RelaySpies,
        ) => Promise<void>;
      }
    ).streamMessageRun(
      "web:operator",
      "Reply with exactly OK.",
      "run-1",
      new AbortController(),
      relay,
    );

    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const client = gatewayClientInstances.at(-1);
    expect(client).toBeDefined();

    client?.emitEvent("agent", {
      runId: "run-1",
      stream: "tool",
      data: {
        phase: "start",
        toolCallId: "tool-1",
        name: "exec",
      },
    });
    client?.emitEvent("chat", {
      runId: "run-1",
      sessionKey: "web:operator",
      seq: 1,
      state: "delta",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hel" }],
      },
    });
    client?.emitEvent("chat", {
      runId: "run-1",
      sessionKey: "web:operator",
      seq: 2,
      state: "delta",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
      },
    });
    client?.emitEvent("agent", {
      runId: "run-1",
      stream: "tool",
      data: {
        phase: "result",
        toolCallId: "tool-1",
        name: "exec",
        isError: false,
      },
    });
    client?.emitEvent("chat", {
      runId: "run-1",
      sessionKey: "web:operator",
      seq: 3,
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
        stopReason: "stop",
      },
    });

    await streamPromise;

    expect(gatewayClientRequest).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: "web:operator",
        idempotencyKey: "run-1",
        deliver: false,
      }),
      expect.any(Object),
    );
    expect(relay.onDelta.mock.calls.map(([delta]) => delta)).toEqual([
      "Hel",
      "lo",
    ]);
    expect(relay.onDone).toHaveBeenCalledTimes(1);
    expect(relay.onError).not.toHaveBeenCalled();
    expect(relay.onState).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "tool_call",
        toolName: "exec",
      }),
    );
    expect(relay.onState).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "streaming",
      }),
    );
    expect(relay.onState).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "tool_result",
        toolName: "exec",
      }),
    );
  });

  it("ends the relay cleanly when the local controller aborts", async () => {
    vi.spyOn(openclawService as never, "startGateway" as never).mockResolvedValue(
      undefined,
    );
    gatewayClientRequest.mockResolvedValue({
      runId: "run-2",
      status: "started",
    });

    const controller = new AbortController();
    const relay: RelaySpies = {
      onDelta: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onState: vi.fn(),
    };

    const streamPromise = (
      openclawService as unknown as {
        streamMessageRun: (
          sessionKey: string,
          message: string,
          runId: string,
          controller: AbortController,
          relay: RelaySpies,
        ) => Promise<void>;
      }
    ).streamMessageRun("web:operator", "stop", "run-2", controller, relay);

    controller.abort(new Error("operator aborted"));
    await streamPromise;

    expect(relay.onDone).toHaveBeenCalledTimes(1);
    expect(relay.onError).not.toHaveBeenCalled();
    expect(relay.onState).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "completed",
        label: "Run stopped",
      }),
    );
  });
});
