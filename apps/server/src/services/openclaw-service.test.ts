import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getRuntimeSettings,
  updateRuntimeSettings,
  getJsonSetting,
  setJsonSetting,
  getProcessEnv,
  runCommand
} = vi.hoisted(() => ({
  getRuntimeSettings: vi.fn(),
  updateRuntimeSettings: vi.fn(),
  getJsonSetting: vi.fn(),
  setJsonSetting: vi.fn(),
  getProcessEnv: vi.fn(),
  runCommand: vi.fn()
}));

vi.mock("./app-state-service.js", () => ({
  appStateService: {
    getRuntimeSettings,
    updateRuntimeSettings,
    getJsonSetting,
    setJsonSetting
  }
}));

vi.mock("./keychain-service.js", () => ({
  keychainService: {
    getProcessEnv
  }
}));

vi.mock("../lib/process.js", () => ({
  runCommand,
  CommandError: class CommandError extends Error {
    constructor(
      message: string,
      public readonly stdout: string,
      public readonly stderr: string,
      public readonly exitCode: number | null
    ) {
      super(message);
    }
  }
}));

import { openclawService } from "./openclaw-service.js";

describe("OpenClaw context management policy", () => {
  let runtimeSettings: {
    activeProviderId: string;
    ollamaModel: string;
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
    (openclawService as unknown as { gatewayToken: string | null }).gatewayToken = null;
    (openclawService as unknown as { gatewayProcess: unknown | null }).gatewayProcess = null;
    (openclawService as unknown as { activeRuns: Map<string, unknown> }).activeRuns = new Map();

    runtimeSettings = {
      activeProviderId: "anthropic",
      ollamaModel: "qwen3.5:4b",
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
        xai: { defaultModel: "xai/grok-4-fast" }
      }
    };

    getRuntimeSettings.mockImplementation(async () => runtimeSettings);
    updateRuntimeSettings.mockImplementation(async (update: Record<string, unknown>) => {
      runtimeSettings = {
        ...runtimeSettings,
        ...update
      };
      return runtimeSettings;
    });
    getJsonSetting.mockResolvedValue(null);
    setJsonSetting.mockResolvedValue(undefined);
    getProcessEnv.mockResolvedValue({});
    runCommand.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0
    });
  });

  it("writes safeguard compaction and cache-ttl pruning for Anthropic-backed models", async () => {
    vi.spyOn(openclawService as never, "readCurrentConfig" as never).mockReturnValue(null);
    const execSpy = vi.spyOn(openclawService as never, "execOpenClaw" as never).mockResolvedValue("");

    await openclawService.setSmartContextManagement(true);

    const compactionArgs = execSpy.mock.calls[0]?.[0] as string[];
    const pruningArgs = execSpy.mock.calls[1]?.[0] as string[];
    const compaction = JSON.parse(compactionArgs[3] ?? "{}") as Record<string, unknown>;
    const pruning = JSON.parse(pruningArgs[3] ?? "{}") as Record<string, unknown>;

    expect(compaction.mode).toBe("safeguard");
    expect(compaction.reserveTokensFloor).toBe(24000);
    expect((compaction.memoryFlush as { enabled: boolean }).enabled).toBe(true);
    expect((compaction.memoryFlush as { softThresholdTokens: number }).softThresholdTokens).toBe(6000);
    expect(pruning.mode).toBe("cache-ttl");
    expect((pruning.tools as { deny: string[] }).deny).toEqual(["browser", "canvas"]);
  });

  it("turns pruning off for local runtimes while keeping compaction active", async () => {
    runtimeSettings.activeProviderId = "ollama-default";
    vi.spyOn(openclawService as never, "readCurrentConfig" as never).mockReturnValue(null);
    const execSpy = vi.spyOn(openclawService as never, "execOpenClaw" as never).mockResolvedValue("");

    await openclawService.setSmartContextManagement(true);

    const compactionArgs = execSpy.mock.calls[0]?.[0] as string[];
    const pruningArgs = execSpy.mock.calls[1]?.[0] as string[];
    const compaction = JSON.parse(compactionArgs[3] ?? "{}") as Record<string, unknown>;
    const pruning = JSON.parse(pruningArgs[3] ?? "{}") as Record<string, unknown>;

    expect(compaction.mode).toBe("safeguard");
    expect(pruning.mode).toBe("off");
  });

  it("writes the currently selected Ollama model into the default primary model", async () => {
    runtimeSettings.activeProviderId = "ollama-default";
    runtimeSettings.ollamaModel = "qwen3.5:4b";
    vi.spyOn(openclawService as never, "readCurrentConfig" as never).mockReturnValue(null);
    const execSpy = vi.spyOn(openclawService as never, "execOpenClaw" as never).mockResolvedValue("");

    await openclawService.ensureConfigured();

    const modelArgs = execSpy.mock.calls.find((call) => (call[0] as string[])[2] === "agents.defaults.model.primary")?.[0] as
      | string[]
      | undefined;

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
          token: "existing-token"
        },
        http: {
          endpoints: {
            chatCompletions: {
              enabled: true
            }
          }
        }
      },
      agents: {
        defaults: {
          model: {
            primary: "ollama/qwen3.5:4b"
          },
          thinkingDefault: "off",
          compaction: {
            mode: "safeguard",
            timeoutSeconds: 900,
            reserveTokensFloor: 24000,
            identifierPolicy: "strict",
            postCompactionSections: ["Session Startup", "Red Lines"],
            memoryFlush: {
              enabled: true,
              softThresholdTokens: 6000,
              systemPrompt: "Session nearing compaction. Store durable memories now.",
              prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store."
            }
          },
          contextPruning: {
            mode: "off"
          }
        }
      },
      tools: {
        exec: {
          host: "gateway",
          security: "allowlist",
          ask: "on-miss"
        }
      },
      channels: {
        signal: {
          dmPolicy: "pairing",
          groupPolicy: "disabled"
        }
      }
    };

    vi.spyOn(openclawService as never, "readCurrentConfig" as never).mockReturnValue(currentConfig);
    const execSpy = vi.spyOn(openclawService as never, "execOpenClaw" as never).mockResolvedValue("");
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
          compaction: {
            mode: "safeguard",
            reserveTokensFloor: 24000,
            identifierPolicy: "strict",
            postCompactionSections: ["Session Startup", "Red Lines"],
            timeoutSeconds: 900,
            memoryFlush: {
              enabled: true,
              softThresholdTokens: 6000,
              prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",
              systemPrompt: "Session nearing compaction. Store durable memories now."
            }
          },
          contextPruning: {
            mode: "off"
          },
          thinkingDefault: "off",
          model: {
            primary: "ollama/qwen3.5:4b"
          }
        }
      },
      gateway: {
        auth: {
          token: "existing-token",
          mode: "token"
        },
        http: {
          endpoints: {
            chatCompletions: {
              enabled: true
            }
          }
        },
        bind: "loopback",
        port: 18789,
        mode: "local"
      },
      tools: {
        exec: {
          ask: "on-miss",
          security: "allowlist",
          host: "gateway"
        }
      },
      channels: {
        signal: {
          groupPolicy: "disabled",
          dmPolicy: "pairing"
        }
      }
    };

    vi.spyOn(openclawService as never, "readCurrentConfig" as never).mockReturnValue(currentConfig);
    const execSpy = vi.spyOn(openclawService as never, "execOpenClaw" as never).mockResolvedValue("");
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
    const execSpy = vi
      .spyOn(openclawService as never, "execOpenClaw" as never)
      .mockResolvedValueOnce(JSON.stringify({ version: "2026.3.24" }));

    await openclawService.startGateway();

    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(setJsonSetting).not.toHaveBeenCalledWith("openclawStartedAt", expect.anything());
  });

  it("surfaces a port conflict when another OpenClaw service owns the configured gateway port", async () => {
    vi.spyOn(openclawService as never, "execOpenClaw" as never).mockRejectedValue(
      new Error("gateway connect failed: GatewayClientRequestError: unauthorized: gateway token mismatch")
    );
    runCommand
      .mockResolvedValueOnce({
        stdout: "p87974\n",
        stderr: "",
        exitCode: 0
      })
      .mockResolvedValueOnce({
        stdout: "openclaw-gateway\n",
        stderr: "",
        exitCode: 0
      });

    const status = await openclawService.status();

    expect(status.health).toBe("warn");
    expect(status.healthMessage).toContain("A different OpenClaw service is already using the configured DroidAgent gateway port.");
    expect(status.healthMessage).toContain("openclaw-gateway");
    expect(status.metadata).toMatchObject({
      portOwnerPid: 87974,
      portOwnerCommand: "openclaw-gateway"
    });
  });
});
