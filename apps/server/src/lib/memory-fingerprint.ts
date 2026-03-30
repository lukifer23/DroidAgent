import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

async function collectFileStats(
  root: string,
  targetPath: string,
  entries: string[],
): Promise<void> {
  try {
    const stat = await fs.stat(targetPath);
    if (stat.isDirectory()) {
      const children = await fs.readdir(targetPath);
      await Promise.all(
        children
          .sort((left, right) => left.localeCompare(right))
          .map((child) =>
            collectFileStats(root, path.join(targetPath, child), entries),
          ),
      );
      return;
    }

    entries.push(
      [
        path.relative(root, targetPath),
        stat.size,
        Math.round(stat.mtimeMs),
      ].join(":"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function computeMemorySourceFingerprint(params: {
  workspaceRoot: string;
  memoryDirectory: string;
  memoryFilePath: string;
}): Promise<string> {
  const entries: string[] = [];
  await Promise.all([
    collectFileStats(params.workspaceRoot, params.memoryFilePath, entries),
    collectFileStats(
      params.workspaceRoot,
      path.join(params.workspaceRoot, "PREFERENCES.md"),
      entries,
    ),
    collectFileStats(params.workspaceRoot, params.memoryDirectory, entries),
  ]);
  entries.sort((left, right) => left.localeCompare(right));
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}
