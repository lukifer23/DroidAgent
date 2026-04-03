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

import { applyLlamaCppProfile } from "./llamacpp-profile-service.js";

describe("applyLlamaCppProfile", () => {
  beforeEach(() => {
    getRuntimeSettings.mockResolvedValue({
      selectedRuntime: "llamaCpp",
      activeProviderId: "llamacpp-default",
      llamaCppModel: "ggml-org/gemma-3-1b-it-GGUF",
      llamaCppContextWindow: 8192,
    });
    updateRuntimeSettings.mockResolvedValue(undefined);
    markSetupStepCompleted.mockResolvedValue(undefined);
    configureRuntimeModel.mockResolvedValue(undefined);
  });

  it("applies the requested Hugging Face repo and context window through one path", async () => {
    const afterApply = vi.fn();

    const result = await applyLlamaCppProfile({
      hfRepo: " unsloth/gemma-4-E4B-it-GGUF:Q4_K_M ",
      contextWindow: 65536,
      afterApply,
    });

    expect(updateRuntimeSettings).toHaveBeenCalledWith({
      selectedRuntime: "llamaCpp",
      activeProviderId: "llamacpp-default",
      llamaCppModel: "unsloth/gemma-4-E4B-it-GGUF:Q4_K_M",
      llamaCppContextWindow: 65536,
    });
    expect(configureRuntimeModel).toHaveBeenCalledWith({
      providerId: "llamacpp-default",
      modelId: "gemma-4-e4b-it-gguf:q4_k_m",
      contextWindow: 65536,
    });
    expect(markSetupStepCompleted).toHaveBeenCalledWith("models", {
      selectedRuntime: "llamaCpp",
      selectedModel: "unsloth/gemma-4-E4B-it-GGUF:Q4_K_M",
    });
    expect(afterApply).toHaveBeenCalled();
    expect(result).toEqual({
      hfRepo: "unsloth/gemma-4-E4B-it-GGUF:Q4_K_M",
      contextWindow: 65536,
      modelId: "gemma-4-e4b-it-gguf:q4_k_m",
    });
  });

  it("falls back to the current context window when one is not provided", async () => {
    await applyLlamaCppProfile({
      hfRepo: "ggml-org/gemma-3-1b-it-GGUF",
      contextWindow: null,
    });

    expect(updateRuntimeSettings).toHaveBeenCalledWith({
      selectedRuntime: "llamaCpp",
      activeProviderId: "llamacpp-default",
      llamaCppModel: "ggml-org/gemma-3-1b-it-GGUF",
      llamaCppContextWindow: 8192,
    });
    expect(configureRuntimeModel).toHaveBeenCalledWith({
      providerId: "llamacpp-default",
      modelId: "gemma-3-1b-it-gguf",
      contextWindow: 8192,
    });
  });

  it("rejects empty repos and undersized context windows", async () => {
    await expect(
      applyLlamaCppProfile({
        hfRepo: "   ",
      }),
    ).rejects.toThrow(/hugging face repo/i);

    await expect(
      applyLlamaCppProfile({
        hfRepo: "unsloth/gemma-4-E4B-it-GGUF:Q4_K_M",
        contextWindow: 1024,
      }),
    ).rejects.toThrow(/context window/i);
  });

  it("normalizes a Hugging Face resolve URL into the maintained repo-plus-quant profile", async () => {
    await applyLlamaCppProfile({
      hfRepo:
        "https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_K_M.gguf?download=true",
      contextWindow: 65536,
    });

    expect(updateRuntimeSettings).toHaveBeenCalledWith({
      selectedRuntime: "llamaCpp",
      activeProviderId: "llamacpp-default",
      llamaCppModel: "unsloth/gemma-4-E4B-it-GGUF:Q4_K_M",
      llamaCppContextWindow: 65536,
    });
    expect(configureRuntimeModel).toHaveBeenCalledWith({
      providerId: "llamacpp-default",
      modelId: "gemma-4-e4b-it-gguf:q4_k_m",
      contextWindow: 65536,
    });
  });
});
