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

import { LLAMA_CPP_PORT, baseEnv } from "../env.js";
import { CommandError, runCommand } from "../lib/process.js";
import { appStateService } from "./app-state-service.js";
import { openclawService } from "./openclaw-service.js";

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

  private async ollamaStatus(): Promise<RuntimeStatus> {
    const binaryPath = await this.binaryPath("ollama");
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
        metadata: {}
      });
    }

    try {
      const tags = await this.fetchJson<{ models?: Array<{ name: string }> }>("http://127.0.0.1:11434/api/tags");
      return RuntimeStatusSchema.parse({
        id: "ollama",
        label: "Ollama",
        state: "running",
        enabled: true,
        installMethod: "brew",
        detectedVersion: (await runCommand(binaryPath, ["--version"])).stdout.trim() || null,
        binaryPath,
        health: "ok",
        healthMessage: `Ollama is serving ${tags.models?.length ?? 0} model(s).`,
        endpoint: "http://127.0.0.1:11434",
        installed: true,
        lastStartedAt: await appStateService.getJsonSetting<string | null>("ollamaStartedAt", null),
        metadata: {
          models: tags.models?.length ?? 0
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
        metadata: {}
      });
    }
  }

  private async llamaCppStatus(): Promise<RuntimeStatus> {
    const binaryPath = await this.binaryPath("llama-server");
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
        metadata: {}
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
        healthMessage: `llama.cpp is serving ${models.data?.length ?? 0} model(s).`,
        endpoint: `http://127.0.0.1:${LLAMA_CPP_PORT}/v1`,
        installed: true,
        lastStartedAt: await appStateService.getJsonSetting<string | null>("llamaCppStartedAt", null),
        metadata: {
          models: models.data?.length ?? 0
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
        healthMessage: "llama.cpp is installed but its local server is not running.",
        endpoint: `http://127.0.0.1:${LLAMA_CPP_PORT}/v1`,
        installed: true,
        lastStartedAt: await appStateService.getJsonSetting<string | null>("llamaCppStartedAt", null),
        metadata: {}
      });
    }
  }

  async getRuntimeStatuses(): Promise<RuntimeStatus[]> {
    return await Promise.all([openclawService.status(), this.ollamaStatus(), this.llamaCppStatus()]);
  }

  async installRuntime(runtimeId: RuntimeId): Promise<void> {
    if (runtimeId === "openclaw") {
      return;
    }
    const formula = runtimeId === "ollama" ? "ollama" : "llama.cpp";
    await runCommand("brew", ["install", formula]);
  }

  async startRuntime(runtimeId: RuntimeId): Promise<void> {
    if (runtimeId === "openclaw") {
      await openclawService.startGateway();
      return;
    }

    if (runtimeId === "ollama") {
      await runCommand("brew", ["services", "start", "ollama"]);
      await appStateService.setJsonSetting("ollamaStartedAt", new Date().toISOString());
      return;
    }

    await this.startLlamaCppServer();
  }

  async stopRuntime(runtimeId: RuntimeId): Promise<void> {
    if (runtimeId === "openclaw") {
      await openclawService.stopGateway();
      return;
    }

    if (runtimeId === "ollama") {
      await runCommand("brew", ["services", "stop", "ollama"], { okExitCodes: [0, 1] });
      return;
    }

    if (this.llamaCppProcess && this.llamaCppProcess.exitCode === null) {
      this.llamaCppProcess.kill("SIGTERM");
      this.llamaCppProcess = null;
    }
  }

  async pullModel(runtimeId: RuntimeId, modelId: string): Promise<void> {
    if (runtimeId === "ollama") {
      await runCommand("ollama", ["pull", modelId]);
      await appStateService.updateRuntimeSettings({
        selectedRuntime: "ollama",
        ollamaModel: modelId
      });
      await openclawService.selectOllamaModel(modelId);
      await appStateService.markSetupStepCompleted("models", {
        selectedRuntime: "ollama",
        selectedModel: modelId
      });
      return;
    }

    if (runtimeId === "llamaCpp") {
      const preset = LLAMA_CPP_PRESETS.find((entry) => entry.id === modelId) ?? LLAMA_CPP_PRESETS[0]!;
      await appStateService.updateRuntimeSettings({
        selectedRuntime: "llamaCpp",
        llamaCppModel: preset.hfRepo,
        llamaCppContextWindow: preset.contextWindow
      });
      await openclawService.registerLlamaCppProvider(path.basename(preset.hfRepo).toLowerCase(), preset.contextWindow);
      await appStateService.markSetupStepCompleted("models", {
        selectedRuntime: "llamaCpp",
        selectedModel: preset.hfRepo
      });
      return;
    }
  }

  async listProviderProfiles(): Promise<ProviderProfile[]> {
    const statuses = await this.getRuntimeStatuses();
    const settings = await appStateService.getRuntimeSettings();

    return [
      ProviderProfileSchema.parse({
        id: "ollama-default",
        provider: "ollama",
        label: "Ollama",
        model: settings.ollamaModel,
        baseUrl: "http://127.0.0.1:11434",
        enabled: settings.selectedRuntime === "ollama",
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
        enabled: settings.selectedRuntime === "llamaCpp",
        toolSupport: true,
        health: statuses.find((status) => status.id === "llamaCpp")?.health ?? "warn",
        healthMessage: statuses.find((status) => status.id === "llamaCpp")?.healthMessage ?? "Unavailable"
      })
    ];
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
    await runCommand("brew", ["install", "signal-cli"]);
    const binaryPath = await this.binaryPath("signal-cli");
    if (!binaryPath) {
      throw new Error("signal-cli install completed, but the binary was not found on PATH.");
    }
    await appStateService.updateRuntimeSettings({ signalCliPath: binaryPath });
    return binaryPath;
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
    const child = spawn(
      binaryPath,
      ["-hf", settings.llamaCppModel, "--host", "127.0.0.1", "--port", String(LLAMA_CPP_PORT)],
      {
        env: baseEnv(),
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    child.stdout.on("data", (chunk) => {
      fs.appendFileSync(path.join(process.env.HOME ?? "", ".droidagent", "logs", "llama-cpp.log"), chunk);
    });
    child.stderr.on("data", (chunk) => {
      fs.appendFileSync(path.join(process.env.HOME ?? "", ".droidagent", "logs", "llama-cpp.log"), chunk);
    });
    child.on("exit", () => {
      this.llamaCppProcess = null;
    });

    this.llamaCppProcess = child;
    await appStateService.setJsonSetting("llamaCppStartedAt", new Date().toISOString());
    await openclawService.registerLlamaCppProvider(path.basename(settings.llamaCppModel).toLowerCase(), settings.llamaCppContextWindow);
  }
}

export const runtimeService = new RuntimeService();
