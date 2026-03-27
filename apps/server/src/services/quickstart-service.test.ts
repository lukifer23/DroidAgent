import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getRuntimeSettings,
  updateRuntimeSettings,
  markSetupStepCompleted,
  getRuntimeStatuses,
  installRuntime,
  startRuntime,
  listProviderProfiles,
  pullModel,
  getBootstrapState,
  enableTailscaleServe,
  setCanonicalSource,
  startGateway,
  configureRuntimeModel,
} = vi.hoisted(() => ({
  getRuntimeSettings: vi.fn(),
  updateRuntimeSettings: vi.fn(),
  markSetupStepCompleted: vi.fn(),
  getRuntimeStatuses: vi.fn(),
  installRuntime: vi.fn(),
  startRuntime: vi.fn(),
  listProviderProfiles: vi.fn(),
  pullModel: vi.fn(),
  getBootstrapState: vi.fn(),
  enableTailscaleServe: vi.fn(),
  setCanonicalSource: vi.fn(),
  startGateway: vi.fn(),
  configureRuntimeModel: vi.fn(),
}));

vi.mock("./app-state-service.js", () => ({
  appStateService: {
    getRuntimeSettings,
    updateRuntimeSettings,
    markSetupStepCompleted,
  },
}));

vi.mock("./runtime-service.js", () => ({
  runtimeService: {
    getRuntimeStatuses,
    installRuntime,
    startRuntime,
    listProviderProfiles,
    pullModel,
  },
}));

vi.mock("./access-service.js", () => ({
  accessService: {
    getBootstrapState,
    enableTailscaleServe,
    setCanonicalSource,
  },
}));

vi.mock("./openclaw-service.js", () => ({
  openclawService: {
    startGateway,
  },
}));

vi.mock("./harness-service.js", () => ({
  harnessService: {
    configureRuntimeModel,
  },
}));

import { quickstartService } from "./quickstart-service.js";

describe("QuickstartService", () => {
  let runtimeSettings: {
    selectedRuntime: "ollama" | "llamaCpp";
    activeProviderId: string;
    ollamaModel: string;
    workspaceRoot: string | null;
  };
  let runtimeStatuses: Array<{
    id: "openclaw" | "ollama";
    state: "missing" | "running" | "stopped";
    installed: boolean;
  }>;
  let providerProfiles: Array<{
    id: string;
    model: string;
    enabled: boolean;
  }>;
  let accessState: {
    canonicalOrigin: {
      origin: string;
      source: "tailscaleServe" | "cloudflareTunnel";
      accessMode: "tailscale" | "cloudflare";
      rpId: string;
      hostname: string;
      updatedAt: string;
    } | null;
    serveStatus: {
      enabled: boolean;
      source: "tailscale" | "cloudflare" | "none";
    };
    tailscaleStatus: { authenticated: boolean; canonicalUrl: string | null };
    cloudflareStatus: { running: boolean; canonicalUrl: string | null };
  };

  beforeEach(() => {
    runtimeSettings = {
      selectedRuntime: "llamaCpp",
      activeProviderId: "llamacpp-default",
      ollamaModel: "qwen3.5:4b",
      workspaceRoot: null,
    };
    runtimeStatuses = [
      { id: "openclaw", state: "stopped", installed: true },
      { id: "ollama", state: "missing", installed: false },
    ];
    providerProfiles = [
      {
        id: "ollama-default",
        model: "qwen3.5:4b",
        enabled: false,
      },
    ];
    accessState = {
      canonicalOrigin: null,
      serveStatus: {
        enabled: false,
        source: "none",
      },
      tailscaleStatus: {
        authenticated: true,
        canonicalUrl: "https://droidagent.example.ts.net",
      },
      cloudflareStatus: {
        running: false,
        canonicalUrl: null,
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
    markSetupStepCompleted.mockResolvedValue(undefined);

    getRuntimeStatuses.mockImplementation(async () => runtimeStatuses);
    installRuntime.mockImplementation(async () => {
      runtimeStatuses = runtimeStatuses.map((runtime) =>
        runtime.id === "ollama"
          ? { ...runtime, installed: true, state: "stopped" }
          : runtime,
      );
    });
    startRuntime.mockImplementation(async () => {
      runtimeStatuses = runtimeStatuses.map((runtime) =>
        runtime.id === "ollama"
          ? { ...runtime, installed: true, state: "running" }
          : runtime,
      );
    });
    listProviderProfiles.mockImplementation(async () =>
      providerProfiles.map((provider) =>
        provider.id === "ollama-default"
          ? {
              ...provider,
              model: runtimeSettings.ollamaModel,
              enabled: runtimeSettings.activeProviderId === "ollama-default",
            }
          : provider,
      ),
    );
    pullModel.mockImplementation(
      async (_runtimeId: string, modelId: string) => {
        runtimeSettings = {
          ...runtimeSettings,
          selectedRuntime: "ollama",
          activeProviderId: "ollama-default",
          ollamaModel: modelId,
        };
        providerProfiles = providerProfiles.map((provider) =>
          provider.id === "ollama-default"
            ? {
                ...provider,
                model: modelId,
                enabled: true,
              }
            : provider,
        );
      },
    );

    getBootstrapState.mockImplementation(async () => accessState);
    enableTailscaleServe.mockImplementation(async () => {
      accessState = {
        ...accessState,
        canonicalOrigin: {
          accessMode: "tailscale",
          origin: "https://droidagent.example.ts.net",
          rpId: "droidagent.example.ts.net",
          hostname: "droidagent.example.ts.net",
          source: "tailscaleServe",
          updatedAt: new Date().toISOString(),
        },
        serveStatus: {
          enabled: true,
          source: "tailscale",
        },
      };
      return {
        canonicalOrigin: accessState.canonicalOrigin,
        tailscale: accessState.tailscaleStatus,
        serve: accessState.serveStatus,
      };
    });
    setCanonicalSource.mockImplementation(async () => {
      if (!accessState.canonicalOrigin) {
        throw new Error("No canonical origin");
      }
      return accessState.canonicalOrigin;
    });

    startGateway.mockImplementation(async () => {
      runtimeStatuses = runtimeStatuses.map((runtime) =>
        runtime.id === "openclaw" ? { ...runtime, state: "running" } : runtime,
      );
    });
    configureRuntimeModel.mockResolvedValue(undefined);
  });

  it("prepares the default local runtime and creates the Tailscale phone URL", async () => {
    const result = await quickstartService.prepare({
      workspaceRoot: process.cwd(),
      modelId: "qwen3.5:4b",
    });

    expect(result.hostReady).toBe(true);
    expect(result.remoteReady).toBe(true);
    expect(result.phoneUrl).toBe("https://droidagent.example.ts.net");
    expect(result.actions).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Workspace set to"),
        "Installed Ollama.",
        "Started Ollama.",
        "Started OpenClaw.",
        "Selected Ollama as the default runtime.",
        "Created the phone URL through Tailscale.",
      ]),
    );
  });

  it("returns a pending remote reason when no remote provider is ready", async () => {
    runtimeSettings = {
      ...runtimeSettings,
      selectedRuntime: "ollama",
      activeProviderId: "ollama-default",
      workspaceRoot: process.cwd(),
    };
    runtimeStatuses = [
      { id: "openclaw", state: "running", installed: true },
      { id: "ollama", state: "running", installed: true },
    ];
    providerProfiles = [
      {
        id: "ollama-default",
        model: "qwen3.5:4b",
        enabled: true,
      },
    ];
    accessState = {
      canonicalOrigin: null,
      serveStatus: {
        enabled: false,
        source: "none",
      },
      tailscaleStatus: {
        authenticated: false,
        canonicalUrl: null,
      },
      cloudflareStatus: {
        running: false,
        canonicalUrl: null,
      },
    };

    const result = await quickstartService.prepare({
      workspaceRoot: process.cwd(),
    });

    expect(result.hostReady).toBe(true);
    expect(result.remoteReady).toBe(false);
    expect(result.remotePendingReason).toMatch(/Sign in to Tailscale/);
    expect(result.actions).toContain("This Mac was already ready.");
  });
});
