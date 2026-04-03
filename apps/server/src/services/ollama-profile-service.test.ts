import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getRuntimeSettings,
  updateRuntimeSettings,
  markSetupStepCompleted,
  configureRuntimeModel,
} = vi.hoisted(() => ({
  getRuntimeSettings: vi.fn(),
  updateRuntimeSettings: vi.fn(),
  markSetupStepCompleted: vi.fn(),
  configureRuntimeModel: vi.fn(),
}));

vi.mock("./app-state-service.js", () => ({
  DEFAULT_OLLAMA_CONTEXT_WINDOW: 65536,
  appStateService: {
    getRuntimeSettings,
    updateRuntimeSettings,
    markSetupStepCompleted,
  },
}));

vi.mock("./harness-service.js", () => ({
  harnessService: {
    configureRuntimeModel,
  },
}));

import { applyOllamaProfile } from "./ollama-profile-service.js";

describe("applyOllamaProfile", () => {
  beforeEach(() => {
    getRuntimeSettings.mockResolvedValue({
      selectedRuntime: "ollama",
      activeProviderId: "ollama-default",
      ollamaModel: "qwen3.5:4b",
      ollamaContextWindow: 65536,
    });
    updateRuntimeSettings.mockResolvedValue(undefined);
    markSetupStepCompleted.mockResolvedValue(undefined);
    configureRuntimeModel.mockResolvedValue(undefined);
  });

  it("applies the requested model and context window through one path", async () => {
    const ensureModel = vi.fn().mockResolvedValue(undefined);
    const afterApply = vi.fn();

    const result = await applyOllamaProfile({
      modelId: " gemma4:e4b ",
      contextWindow: 70000,
      ensureModel,
      afterApply,
    });

    expect(ensureModel).toHaveBeenCalledWith("gemma4:e4b");
    expect(updateRuntimeSettings).toHaveBeenCalledWith({
      selectedRuntime: "ollama",
      activeProviderId: "ollama-default",
      ollamaModel: "gemma4:e4b",
      ollamaContextWindow: 70000,
    });
    expect(configureRuntimeModel).toHaveBeenCalledWith({
      providerId: "ollama-default",
      modelId: "gemma4:e4b",
      contextWindow: 70000,
    });
    expect(markSetupStepCompleted).toHaveBeenCalledWith("models", {
      selectedRuntime: "ollama",
      selectedModel: "gemma4:e4b",
    });
    expect(afterApply).toHaveBeenCalled();
    expect(result).toEqual({
      modelId: "gemma4:e4b",
      contextWindow: 70000,
    });
  });

  it("falls back to the current context window when one is not provided", async () => {
    await applyOllamaProfile({
      modelId: "qwen3.5:4b",
      contextWindow: null,
    });

    expect(updateRuntimeSettings).toHaveBeenCalledWith({
      selectedRuntime: "ollama",
      activeProviderId: "ollama-default",
      ollamaModel: "qwen3.5:4b",
      ollamaContextWindow: 65536,
    });
    expect(configureRuntimeModel).toHaveBeenCalledWith({
      providerId: "ollama-default",
      modelId: "qwen3.5:4b",
      contextWindow: 65536,
    });
  });

  it("rejects empty model ids and undersized context windows", async () => {
    await expect(
      applyOllamaProfile({
        modelId: "   ",
      }),
    ).rejects.toThrow(/model id/i);

    await expect(
      applyOllamaProfile({
        modelId: "gemma4:e4b",
        contextWindow: 1024,
      }),
    ).rejects.toThrow(/context window/i);
  });
});
