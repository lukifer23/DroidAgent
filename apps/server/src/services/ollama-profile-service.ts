import type { SetupState } from "@droidagent/shared";

import { DEFAULT_OLLAMA_CONTEXT_WINDOW } from "./app-state-service.js";
import { appStateService } from "./app-state-service.js";
import { harnessService } from "./harness-service.js";

export interface ApplyOllamaProfileOptions {
  modelId: string;
  contextWindow?: number | null;
  ensureModel?: ((modelId: string) => Promise<unknown>) | null;
  afterApply?: (() => Promise<void> | void) | null;
  setupStep?: SetupState["currentStep"];
}

function normalizeModelId(modelId: string): string {
  const normalized = modelId.trim();
  if (!normalized) {
    throw new Error("A local Ollama model id is required.");
  }
  return normalized;
}

function normalizeContextWindow(
  contextWindow: number | null | undefined,
  fallback: number,
): number {
  if (contextWindow == null) {
    return fallback;
  }
  if (!Number.isFinite(contextWindow)) {
    throw new Error("Context window must be a finite number.");
  }
  const normalized = Math.floor(contextWindow);
  if (normalized < 2048) {
    throw new Error("Context window must be at least 2048 tokens.");
  }
  return normalized;
}

export async function applyOllamaProfile(
  options: ApplyOllamaProfileOptions,
): Promise<{ modelId: string; contextWindow: number }> {
  const modelId = normalizeModelId(options.modelId);
  const currentSettings = await appStateService.getRuntimeSettings();
  const contextWindow = normalizeContextWindow(
    options.contextWindow,
    currentSettings.ollamaContextWindow || DEFAULT_OLLAMA_CONTEXT_WINDOW,
  );

  if (options.ensureModel) {
    await options.ensureModel(modelId);
  }

  await appStateService.updateRuntimeSettings({
    selectedRuntime: "ollama",
    activeProviderId: "ollama-default",
    ollamaModel: modelId,
    ollamaContextWindow: contextWindow,
  });
  await harnessService.configureRuntimeModel({
    providerId: "ollama-default",
    modelId,
    contextWindow,
  });
  await appStateService.markSetupStepCompleted(options.setupStep ?? "models", {
    selectedRuntime: "ollama",
    selectedModel: modelId,
  });

  if (options.afterApply) {
    await options.afterApply();
  }

  return {
    modelId,
    contextWindow,
  };
}
