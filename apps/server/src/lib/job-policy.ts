import fs from "node:fs/promises";
import path from "node:path";

export const JOB_TIMEOUT_MS = 1000 * 60 * 5;
export const JOB_MAX_OUTPUT_BYTES = 1024 * 1024;

const FORBIDDEN_PATTERNS = [
  /\bsudo\b/,
  /\bsu\s/,
  /\bsu\s*$/,
  /\bdoas\b/,
  /\bchmod\s+[0-7]*[67][67][67]/,
  /\bchmod\s+-R\s+[0-7]*[67][67][67]/,
  /\brm\s+(-rf?|--recursive|--force)\s+(\/|\.\.)/,
  /\brm\s+-rf?\s+/,
  /\bmkfs\./,
  /\bdd\s+if=/,
  /\b:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/,
  /\bwget\s+.*\|\s*(bash|sh|zsh)\b/,
  /\bcurl\s+.*\|\s*(bash|sh|zsh)\b/,
  /;\s*(rm|mkfs|dd)\s/,
  /\|\s*(rm|mkfs|dd)\s/,
  /\$\(.*(rm|chmod|sudo|su).*\)/
];

export function validateCommand(command: string): void {
  const trimmed = command.trim();
  if (!trimmed.length) {
    throw new Error("Command cannot be empty.");
  }
  if (trimmed.length > 4096) {
    throw new Error("Command exceeds maximum length.");
  }
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new Error("Command contains forbidden operation.");
    }
  }
}

export async function resolveCwdWithinWorkspace(cwd: string, workspaceRoot: string): Promise<string> {
  const expanded = cwd.startsWith("~/")
    ? path.join(process.env.HOME ?? "", cwd.slice(2))
    : cwd.startsWith("~")
      ? process.env.HOME ?? cwd
      : cwd;
  const resolved = path.resolve(workspaceRoot, expanded);
  const normalizedRoot = await fs.realpath(path.resolve(workspaceRoot)).catch(() => path.resolve(workspaceRoot));
  const realResolved = await fs.realpath(resolved).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new Error("Working directory does not exist inside the workspace root.");
    }
    throw error;
  });
  const stat = await fs.stat(realResolved);
  if (!stat.isDirectory()) {
    throw new Error("Working directory must be a directory inside the workspace root.");
  }
  const relative = path.relative(normalizedRoot, realResolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Working directory must be inside the workspace root.");
  }
  return realResolved;
}
