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
