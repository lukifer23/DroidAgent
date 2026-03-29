import { describe, expect, it } from "vitest";

import { parseOllamaCapabilities } from "./ollama.js";

describe("parseOllamaCapabilities", () => {
  it("extracts capability names from ollama show output", () => {
    expect(
      parseOllamaCapabilities(`
  Model
    architecture        qwen35

  Capabilities
    completion
    vision
    tools
    thinking

  Parameters
    temperature         1
`),
    ).toEqual(["completion", "vision", "tools", "thinking"]);
  });

  it("returns an empty list when the output has no capabilities section", () => {
    expect(
      parseOllamaCapabilities(`
  Model
    architecture        qwen35
`),
    ).toEqual([]);
  });
});
