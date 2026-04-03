import { describe, expect, it } from "vitest";

import { llamaCppModelSupportsVision } from "./llamacpp.js";

describe("llamaCppModelSupportsVision", () => {
  it("detects maintained multimodal llama.cpp model families", () => {
    expect(
      llamaCppModelSupportsVision("unsloth/gemma-4-E4B-it-GGUF:Q4_K_M"),
    ).toBe(true);
    expect(
      llamaCppModelSupportsVision("ggml-org/gemma-3-1b-it-GGUF"),
    ).toBe(true);
  });

  it("keeps text-only llama.cpp models text-only", () => {
    expect(llamaCppModelSupportsVision("bartowski/Qwen3-8B-GGUF")).toBe(false);
    expect(llamaCppModelSupportsVision("")).toBe(false);
  });
});
