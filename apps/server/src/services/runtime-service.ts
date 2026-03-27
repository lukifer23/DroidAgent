import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import {
  ProviderProfileSchema,
  RuntimeStatusSchema,
  type ProviderProfile,
  type RuntimeId,
  type RuntimeStatus
} from "@droidagent/shared";

import {
  LLAMA_CPP_BATCH_SIZE,
  LLAMA_CPP_FLASH_ATTN,
  LLAMA_CPP_GPU_LAYERS,
  LLAMA_CPP_PORT,
  LLAMA_CPP_UBATCH_SIZE,
  baseEnv,
  paths
} from "../env.js";
import { CommandError, runCommand } from "../lib/process.js";
import { TtlCache } from "../lib/ttl-cache.js";
import { appStateService } from "./app-state-service.js";
import { harnessService } from "./harness-service.js";
import { keychainService } from "./keychain-service.js";
import { openclawService } from "./openclaw-service.js";
import { signalService } from "./signal-service.js";

const HEALTH_CHECK_RETRIES = 3;
const HEALTH_CHECK_DELAY_MS = 500;
const RUNTIME_STATUS_TTL_MS = 5000;
const PROVIDER_PROFILE_TTL_MS = 5000;

interface LlamaModelPreset {
  id: string;
  label: string;
  hfRepo: string;
  contextWindow: number;
}

const LLAMA_CPP_PRESETS: LlamaModelPreset[] = [
  {
    id: "gemma-3-1b-it",
    label: "Gemma 3 1B IT GGUF",
    hfRepo: "ggml-org/gemma-3-1b-it-GGUF",
    contextWindow: 8192
  },
  {
    id: "qwen3-8b-instruct",
    label: "Qwen3 8B Instruct GGUF",
    hfRepo: "bartowski/Qwen3-8B-GGUF",
    contextWindow: 32768
  }
];

export class RuntimeService {
  private llamaCppProcess: ChildProcess | null = null;
  private readonly runtimeStatusesCache = new TtlCache<RuntimeStatus[]>(RUNTIME_STATUS_TTL_MS);
  private readonly providerProfilesCache = new TtlCache<ProviderProfile[]>(PROVIDER_PROFILE_TTL_MS);
  private readonly hostAccelerationCache = new TtlCache<Record<string, string | number | boolean>>(60_000);

  invalidateCaches(): void {
    this.runtimeStatusesCache.invalidate();
    this.providerProfilesCache.invalidate();
  }

  private async binaryPath(name: string): Promise<string | null> {
    try {
      const result = await runCommand("which", [name]);
      const firstLine = result.stdout.trim().split("\n")[0];
      return firstLine || null;
    } catch {
      return null;
    }
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`${url} returned ${response.status}`);
    }
    return (await response.json()) as T;
  }

  private async hostAccelerationMetadata(): Promise<Record<string, string | number | boolean>> {
    return await this.hostAccelerationCache.get(async () => {
      try {
        const result = await runCommand("system_profiler", ["SPDisplaysDataType"]);
        const gpuModel = result.stdout.match(/Chipset Model:\s+(.+)/)?.[1]?.trim() ?? null;
        const metalSupport = result.stdout.match(/Metal Support:\s+(.+)/)?.[1]?.trim() ?? null;
        const metadata: Record<string, string | number | boolean> = {
          accelerationBackend: metalSupport ? "metal" : "cpu"
        };
        if (gpuModel) {
          metadata.gpuModel = gpuModel;
        }
        if (metalSupport) {
          metadata.metalSupport = metalSupport;
        }
        return metadata;
      } catch {
        return {};
      }
    });
  }

  private async ollamaProcessorMetadata(): Promise<Record<string, string | number | boolean>> {
    try {
      const result = await runCommand("ollama", ["ps"]);
      const lines = result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length < 2) {
        return {};
      }

      const columns = lines[1]!.split(/\s{2,}/);
      const processor = columns[3];
      return processor ? { activeProcessor: processor } : {};
    } catch {
      return {};
    }
  }

  private async ollamaStatus(): Promise<RuntimeStatus> {
    const binaryPath = await this.binaryPath("ollama");
    const hostAcceleration = await this.hostAccelerationMetadata();
    if (!binaryPath) {
      return RuntimeStatusSchema.parse({
        id: "ollama",
        label: "Ollama",
        state: "missing",
        enabled: true,
        installMethod: "brew",
        detectedVersion: null,
        binaryPath: null,
        health: "warn",
        healthMessage: "Install via Homebrew to use the default local model path.",
        endpoint: "http://127.0.0.1:11434",
        installed: false,
        lastStartedAt: null,
        metadata: hostAcceleration
      });
    }

    try {
      const tags = await this.fetchJson<{ models?: Array<{ name: string }> }>("http://127.0.0.1:11434/api/tags");
      const ollamaProcessor = await this.ollamaProcessorMetadata();
      return RuntimeStatusSchema.parse({
        id: "ollama",
        label: "Ollama",
        state: "running",
        enabled: true,
        installMethod: "brew",
        detectedVersion: (await runCommand(binaryPath, ["--version"])).stdout.trim() || null,
        binaryPath,
        health: "ok",
        healthMessage: `Ollama is serving ${tags.models?.length ?? 0} model(s)${hostAcceleration.accelerationBackend === "metal" ? " with Metal available." : "."}`,
        endpoint: "http://127.0.0.1:11434",
        installed: true,
        lastStartedAt: await appStateService.getJsonSetting<string | null>("ollamaStartedAt", null),
        metadata: {
          models: tags.models?.length ?? 0,
          ...hostAcceleration,
          ...ollamaProcessor
        }
      });
    } catch {
      return RuntimeStatusSchema.parse({
        id: "ollama",
        label: "Ollama",
        state: "stopped",
        enabled: true,
        installMethod: "brew",
        detectedVersion: (await runCommand(binaryPath, ["--version"])).stdout.trim() || null,
        binaryPath,
        health: "warn",
        healthMessage: "Ollama is installed but not currently serving on 127.0.0.1:11434.",
        endpoint: "http://127.0.0.1:11434",
        installed: true,
        lastStartedAt: await appStateService.getJsonSetting<string | null>("ollamaStartedAt", null),
        metadata: hostAcceleration
      });
    }
  }

  private async llamaCppStatus(): Promise<RuntimeStatus> {
    const binaryPath = await this.binaryPath("llama-server");
    const hostAcceleration = await this.hostAccelerationMetadata();
    const llamaMetadata = {
      ...hostAcceleration,
      gpuLayers: LLAMA_CPP_GPU_LAYERS,
      flashAttention: LLAMA_CPP_FLASH_ATTN,
      batchSize: LLAMA_CPP_BATCH_SIZE,
      ubatchSize: LLAMA_CPP_UBATCH_SIZE
    };
    if (!binaryPath) {
      return RuntimeStatusSchema.parse({
        id: "llamaCpp",
        label: "llama.cpp",
        state: "missing",
        enabled: true,
        installMethod: "brew",
        detectedVersion: null,
        binaryPath: null,
        health: "warn",
        healthMessage: "Install the Homebrew formula to enable advanced local model serving.",
        endpoint: `http://127.0.0.1:${LLAMA_CPP_PORT}/v1`,
        installed: false,
        lastStartedAt: null,
        metadata: llamaMetadata
      });
    }

    try {
      const models = await this.fetchJson<{ data?: Array<{ id: string }> }>(`http://127.0.0.1:${LLAMA_CPP_PORT}/v1/models`);
      return RuntimeStatusSchema.parse({
        id: "llamaCpp",
        label: "llama.cpp",
        state: "running",
        enabled: true,
        installMethod: "brew",
        detectedVersion: (await runCommand(binaryPath, ["--version"])).stdout.trim() || null,
        binaryPath,
        health: "ok",
        healthMessage: `llama.cpp is serving ${models.data?.length ?? 0} model(s) with ${hostAcceleration.accelerationBackend === "metal" ? "Metal acceleration" : "CPU execution"}.`,
        endpoint: `http://127.0.0.1:${LLAMA_CPP_PORT}/v1`,
        installed: true,
        lastStartedAt: await appStateService.getJsonSetting<string | null>("llamaCppStartedAt", null),
        metadata: {
          models: models.data?.length ?? 0,
          ...llamaMetadata
        }
      });
    } catch {
      return RuntimeStatusSchema.parse({
        id: "llamaCpp",
        label: "llama.cpp",
        state: "stopped",
        enabled: true,
        installMethod: "brew",
        detectedVersion: (await runCommand(binaryPath, ["--version"])).stdout.trim() || null,
        binaryPath,
        health: "warn",
        healthMessage: `llama.cpp is installed but its local server is not running. It will launch with ${hostAcceleration.accelerationBackend === "metal" ? "Metal acceleration" : "CPU execution"} defaults.`,
        endpoint: `http://127.0.0.1:${LLAMA_CPP_PORT}/v1`,
        installed: true,
        lastStartedAt: await appStateService.getJsonSetting<string | null>("llamaCppStartedAt", null),
        metadata: llamaMetadata
      });
    }
  }

  async getRuntimeStatuses(): Promise<RuntimeStatus[]> {
    return await this.runtimeStatusesCache.get(async () => {
      return await Promise.all([harnessService.health(), this.ollamaStatus(), this.llamaCppStatus()]);
    });
  }

  async installRuntime(runtimeId: RuntimeId): Promise<void> {
    if (runtimeId === "openclaw") {
      return;
    }
    const formula = runtimeId === "ollama" ? "ollama" : "llama.cpp";
    await runCommand("brew", ["install", formula]);
    this.invalidateCaches();
  }

  async startRuntime(runtimeId: RuntimeId): Promise<void> {
    if (runtimeId === "openclaw") {
      await openclawService.startGateway();
      this.invalidateCaches();
      return;
    }

    if (runtimeId === "ollama") {
      await runCommand("brew", ["services", "start", "ollama"]);
      await appStateService.setJsonSetting("ollamaStartedAt", new Date().toISOString());
      this.invalidateCaches();
      return;
    }

    await this.startLlamaCppServer();
    this.invalidateCaches();
  }

  async stopRuntime(runtimeId: RuntimeId): Promise<void> {
    if (runtimeId === "openclaw") {
      await openclawService.stopGateway();
      this.invalidateCaches();
      return;
    }

    if (runtimeId === "ollama") {
      await runCommand("brew", ["services", "stop", "ollama"], { okExitCodes: [0, 1] });
      this.invalidateCaches();
      return;
    }

    if (this.llamaCppProcess && this.llamaCppProcess.exitCode === null) {
      this.llamaCppProcess.kill("SIGTERM");
      this.llamaCppProcess = null;
    }
    this.invalidateCaches();
  }

  async pullModel(runtimeId: RuntimeId, modelId: string): Promise<void> {
    if (runtimeId === "ollama") {
      await runCommand("ollama", ["pull", modelId]);
      await appStateService.updateRuntimeSettings({
        selectedRuntime: "ollama",
        activeProviderId: "ollama-default",
        ollamaModel: modelId
      });
      await harnessService.configureRuntimeModel({
        providerId: "ollama-default",
        modelId
      });
      await appStateService.markSetupStepCompleted("models", {
        selectedRuntime: "ollama",
        selectedModel: modelId
      });
      this.invalidateCaches();
      return;
    }

    if (runtimeId === "llamaCpp") {
      const preset = LLAMA_CPP_PRESETS.find((entry) => entry.id === modelId) ?? LLAMA_CPP_PRESETS[0]!;
      await appStateService.updateRuntimeSettings({
        selectedRuntime: "llamaCpp",
        activeProviderId: "llamacpp-default",
        llamaCppModel: preset.hfRepo,
        llamaCppContextWindow: preset.contextWindow
      });
      await harnessService.configureRuntimeModel({
        providerId: "llamacpp-default",
        modelId: path.basename(preset.hfRepo).toLowerCase(),
        contextWindow: preset.contextWindow
      });
      await appStateService.markSetupStepCompleted("models", {
        selectedRuntime: "llamaCpp",
        selectedModel: preset.hfRepo
      });
      this.invalidateCaches();
      return;
    }
  }

  async listProviderProfiles(): Promise<ProviderProfile[]> {
    return await this.providerProfilesCache.get(async () => {
      const statuses = await this.getRuntimeStatuses();
      const settings = await appStateService.getRuntimeSettings();
      const cloudProviders = await keychainService.listProviderSummaries();

      return [
        ProviderProfileSchema.parse({
          id: "ollama-default",
          provider: "ollama",
          label: "Ollama",
          model: settings.ollamaModel,
          baseUrl: "http://127.0.0.1:11434",
          enabled: settings.activeProviderId === "ollama-default",
          toolSupport: true,
          health: statuses.find((status) => status.id === "ollama")?.health ?? "warn",
          healthMessage: statuses.find((status) => status.id === "ollama")?.healthMessage ?? "Unavailable"
        }),
        ProviderProfileSchema.parse({
          id: "llamacpp-default",
          provider: "llamaCpp",
          label: "llama.cpp",
          model: settings.llamaCppModel,
          baseUrl: `http://127.0.0.1:${LLAMA_CPP_PORT}/v1`,
          enabled: settings.activeProviderId === "llamacpp-default",
          toolSupport: true,
          health: statuses.find((status) => status.id === "llamaCpp")?.health ?? "warn",
          healthMessage: statuses.find((status) => status.id === "llamaCpp")?.healthMessage ?? "Unavailable"
        }),
        ...cloudProviders
          .filter((provider) => provider.stored && provider.defaultModel)
          .map((provider) =>
            ProviderProfileSchema.parse({
              id: provider.id,
              provider: "cloud",
              label: provider.label,
              model: provider.defaultModel ?? "",
              baseUrl: null,
              enabled: settings.activeProviderId === provider.id,
              toolSupport: true,
              health: provider.health,
              healthMessage: provider.healthMessage
            })
          )
      ];
    });
  }

  async listModels(runtimeId: RuntimeId) {
    if (runtimeId === "ollama") {
      try {
        const tags = await this.fetchJson<{ models?: Array<{ name: string }> }>("http://127.0.0.1:11434/api/tags");
        return (tags.models ?? []).map((model) => model.name);
      } catch {
        return [];
      }
    }

    if (runtimeId === "llamaCpp") {
      return LLAMA_CPP_PRESETS.map((entry) => entry.id);
    }

    return [];
  }

  async installSignalCli(): Promise<string> {
    const runtime = await signalService.installCli();
    this.invalidateCaches();
    return runtime.cliPath;
  }

  private async startLlamaCppServer(): Promise<void> {
    const binaryPath = await this.binaryPath("llama-server");
    if (!binaryPath) {
      throw new Error("llama-server is not installed.");
    }

    if (this.llamaCppProcess && this.llamaCppProcess.exitCode === null) {
      return;
    }

    const settings = await appStateService.getRuntimeSettings();
    const logPath = path.join(paths.logsDir, "llama-cpp.log");
    const child = spawn(
      binaryPath,
      [
        "-hf",
        settings.llamaCppModel,
        "--host",
        "127.0.0.1",
        "--port",
        String(LLAMA_CPP_PORT),
        "--ctx-size",
        String(settings.llamaCppContextWindow),
        "--n-gpu-layers",
        String(LLAMA_CPP_GPU_LAYERS),
        "--flash-attn",
        LLAMA_CPP_FLASH_ATTN,
        "--batch-size",
        String(Math.min(settings.llamaCppContextWindow, LLAMA_CPP_BATCH_SIZE)),
        "--ubatch-size",
        String(Math.min(settings.llamaCppContextWindow, LLAMA_CPP_UBATCH_SIZE))
      ],
      {
        env: baseEnv(),
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    child.stdout.on("data", (chunk) => {
      fs.appendFileSync(logPath, chunk);
    });
    child.stderr.on("data", (chunk) => {
      fs.appendFileSync(logPath, chunk);
    });
    child.on("exit", (code) => {
      this.llamaCppProcess = null;
      if (code !== 0 && code !== null) {
        fs.appendFileSync(logPath, `\n[Process exited with code ${code}]\n`);
      }
    });

    this.llamaCppProcess = child;
    await appStateService.setJsonSetting("llamaCppStartedAt", new Date().toISOString());
    this.invalidateCaches();

    for (let i = 0; i < HEALTH_CHECK_RETRIES; i++) {
      await new Promise((r) => setTimeout(r, HEALTH_CHECK_DELAY_MS * (i + 1)));
      try {
        await this.fetchJson(`http://127.0.0.1:${LLAMA_CPP_PORT}/v1/models`);
        await harnessService.configureRuntimeModel({
          providerId: "llamacpp-default",
          modelId: path.basename(settings.llamaCppModel).toLowerCase(),
          contextWindow: settings.llamaCppContextWindow
        });
        return;
      } catch {
        if (i === HEALTH_CHECK_RETRIES - 1) {
          throw new Error("llama.cpp server started but did not become ready in time.");
        }
      }
    }
  }
}

export const runtimeService = new RuntimeService();
