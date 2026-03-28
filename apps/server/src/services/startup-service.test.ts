import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getRuntimeSettings,
  getAccessSettings,
  getTailscaleStatus,
  getCloudflareStatus,
  listProviderSummaries,
  getRuntimeStatuses,
  startRuntime,
  ensureConfigured,
  startGateway,
  refreshState,
  startDaemon,
  startCloudflare,
} = vi.hoisted(() => ({
  getRuntimeSettings: vi.fn(),
  getAccessSettings: vi.fn(),
  getTailscaleStatus: vi.fn(),
  getCloudflareStatus: vi.fn(),
  listProviderSummaries: vi.fn(),
  getRuntimeStatuses: vi.fn(),
  startRuntime: vi.fn(),
  ensureConfigured: vi.fn(),
  startGateway: vi.fn(),
  refreshState: vi.fn(),
  startDaemon: vi.fn(),
  startCloudflare: vi.fn(),
}));

vi.mock("./app-state-service.js", () => ({
  appStateService: {
    getRuntimeSettings,
    getAccessSettings,
  },
}));

vi.mock("./access-service.js", () => ({
  accessService: {
    getTailscaleStatus,
    getCloudflareStatus,
  },
}));

vi.mock("./keychain-service.js", () => ({
  keychainService: {
    listProviderSummaries,
  },
}));

vi.mock("./runtime-service.js", () => ({
  runtimeService: {
    getRuntimeStatuses,
    startRuntime,
  },
}));

vi.mock("./openclaw-service.js", () => ({
  openclawService: {
    ensureConfigured,
    startGateway,
  },
}));

vi.mock("./signal-service.js", () => ({
  signalService: {
    refreshState,
    startDaemon,
  },
}));

vi.mock("./remote-access-service.js", () => ({
  cloudflareRemoteAccessProvider: {
    start: startCloudflare,
  },
}));

import { startupService } from "./startup-service.js";

describe("StartupService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    startupService.invalidate();
    getRuntimeSettings.mockResolvedValue({
      selectedRuntime: "ollama",
      activeProviderId: "ollama-default",
      ollamaModel: "qwen3.5:4b",
      ollamaEmbeddingModel: "embeddinggemma:300m-qat-q8_0",
      ollamaContextWindow: 65536,
      llamaCppModel: "ggml-org/gemma-3-1b-it-GGUF",
      llamaCppContextWindow: 8192,
      smartContextManagementEnabled: true,
      signalRegistrationMode: "none",
      signalRegistrationState: "unconfigured",
      signalDaemonState: "stopped",
      cloudProviders: {
        openai: { defaultModel: "openai/gpt-5.4", lastUpdatedAt: null },
        anthropic: { defaultModel: "anthropic/claude-sonnet-4-5", lastUpdatedAt: null },
        openrouter: { defaultModel: "openrouter/anthropic/claude-sonnet-4-5", lastUpdatedAt: null },
        gemini: { defaultModel: "gemini/gemini-2.5-pro", lastUpdatedAt: null },
        groq: { defaultModel: "groq/llama-3.3-70b-versatile", lastUpdatedAt: null },
        together: { defaultModel: "together/deepseek-ai/DeepSeek-R1-Distill-Llama-70B-free", lastUpdatedAt: null },
        xai: { defaultModel: "xai/grok-4-fast", lastUpdatedAt: null },
      },
    });
    getAccessSettings.mockResolvedValue({
      mode: "tailscale",
      canonicalOrigin: null,
      bootstrapTokenHash: null,
      bootstrapTokenIssuedAt: null,
      bootstrapTokenExpiresAt: null,
      cloudflareHostname: null,
      cloudflareLastStartedAt: null,
    });
    getTailscaleStatus.mockResolvedValue({
      installed: true,
      running: true,
      authenticated: true,
      health: "ok",
      healthMessage: "Serve is live.",
      version: "1.0.0",
      deviceName: "droidagent-mac",
      tailnetName: "taila06290.ts.net",
      dnsName: "mac.taila06290.ts.net",
      magicDnsEnabled: true,
      httpsEnabled: true,
      serveCommand: "tailscale serve --bg --https=443 4318",
      canonicalUrl: "https://mac.taila06290.ts.net",
      lastCheckedAt: "2026-03-28T00:00:00.000Z",
    });
    getCloudflareStatus.mockResolvedValue({
      installed: true,
      configured: true,
      running: true,
      tokenStored: true,
      health: "ok",
      healthMessage: "Cloudflare is live.",
      version: "1.0.0",
      hostname: "agent.example.com",
      canonicalUrl: "https://agent.example.com",
      lastStartedAt: null,
      lastCheckedAt: "2026-03-28T00:00:00.000Z",
    });
    listProviderSummaries.mockResolvedValue([]);
    getRuntimeStatuses.mockResolvedValue([
      {
        id: "openclaw",
        label: "OpenClaw Gateway",
        state: "running",
        enabled: true,
        installMethod: "bundledNpm",
        detectedVersion: null,
        binaryPath: "/tmp/openclaw",
        health: "ok",
        healthMessage: "ready",
        endpoint: "ws://127.0.0.1:18789",
        installed: true,
        lastStartedAt: null,
        metadata: {},
      },
      {
        id: "ollama",
        label: "Ollama",
        state: "running",
        enabled: true,
        installMethod: "brew",
        detectedVersion: "0.18.3",
        binaryPath: "/opt/homebrew/bin/ollama",
        health: "ok",
        healthMessage: "ready",
        endpoint: "http://127.0.0.1:11434",
        installed: true,
        lastStartedAt: null,
        metadata: {},
      },
      {
        id: "llamaCpp",
        label: "llama.cpp",
        state: "stopped",
        enabled: true,
        installMethod: "brew",
        detectedVersion: null,
        binaryPath: "/opt/homebrew/bin/llama-server",
        health: "warn",
        healthMessage: "idle",
        endpoint: "http://127.0.0.1:8012/v1",
        installed: true,
        lastStartedAt: null,
        metadata: {},
      },
    ]);
    startRuntime.mockResolvedValue(undefined);
    ensureConfigured.mockResolvedValue(undefined);
    startGateway.mockResolvedValue(undefined);
    refreshState.mockResolvedValue(undefined);
    startDaemon.mockResolvedValue(undefined);
    startCloudflare.mockResolvedValue(undefined);
  });

  it("skips optional Cloudflare and Signal restore work when they are not configured", async () => {
    const diagnostics = await startupService.restore();

    expect(getCloudflareStatus).not.toHaveBeenCalled();
    expect(startCloudflare).not.toHaveBeenCalled();
    expect(refreshState).not.toHaveBeenCalled();
    expect(startDaemon).not.toHaveBeenCalled();
    expect(diagnostics.find((entry) => entry.id === "cloudflare")?.message).toContain(
      "not configured",
    );
    expect(diagnostics.find((entry) => entry.id === "signal")?.message).toContain(
      "not configured",
    );
  });
});
