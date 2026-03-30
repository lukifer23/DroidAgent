import { describe, expect, it } from "vitest";

import {
  buildRunInChatPrompt,
  extractRunnableCommand,
} from "./command-suggestions";

describe("extractRunnableCommand", () => {
  it("returns null for non-shell code blocks", () => {
    expect(extractRunnableCommand("typescript", "console.log('hi')")).toBeNull();
  });

  it("normalizes simple shell prompts into a runnable command", () => {
    expect(
      extractRunnableCommand(
        "bash",
        "$ rg --files\n$ pnpm test",
      ),
    ).toBe("rg --files\npnpm test");
  });

  it("returns null for empty shell blocks", () => {
    expect(extractRunnableCommand("zsh", "   \n")).toBeNull();
  });

  it("builds a deterministic run-in-chat prompt", () => {
    expect(buildRunInChatPrompt("printf 'hi'")).toContain("```sh\nprintf 'hi'\n```");
    expect(buildRunInChatPrompt("printf 'hi'")).toContain(
      "Run this exact workspace command now and continue using the real output.",
    );
  });
});
