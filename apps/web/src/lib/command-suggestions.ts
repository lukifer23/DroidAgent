const RUNNABLE_SHELL_LANGUAGES = new Set([
  "bash",
  "console",
  "shell",
  "shellscript",
  "sh",
  "terminal",
  "zsh",
]);

export function extractRunnableCommand(
  language: string | null | undefined,
  code: string,
): string | null {
  const normalizedLanguage = language?.trim().toLowerCase() ?? "";
  if (!RUNNABLE_SHELL_LANGUAGES.has(normalizedLanguage)) {
    return null;
  }

  const normalized = code
    .split("\n")
    .map((line) => line.replace(/^\$\s?/, "").replace(/\s+$/u, ""))
    .join("\n")
    .trim();

  return normalized.length > 0 ? normalized : null;
}

export function buildRunInChatPrompt(command: string): string {
  const normalized = command.trim();
  return [
    "Run this exact workspace command now and continue using the real output. Do not describe the command instead of running it. If approval is needed, request it and wait.",
    "",
    "```sh",
    normalized,
    "```",
  ].join("\n");
}
