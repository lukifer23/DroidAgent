import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SetupState } from "@droidagent/shared";

import type {
  AccessSettings,
  RuntimeSettings,
} from "../services/app-state-service.js";

export interface E2EWorkspaceFile {
  path: string;
  content: string;
}

export interface E2EFixtureSeed {
  runtimeSettings: RuntimeSettings;
  accessSettings: AccessSettings;
  setupState: SetupState;
  openclawGatewayToken: string;
  workspaceFiles: E2EWorkspaceFile[];
}

export interface E2EFixtureState {
  baseUrl: string;
  sessionToken: string;
  workspaceRoot: string;
  sampleFilePath: string;
  resetToken: string;
  rootDir: string;
  homeDir: string;
  appDir: string;
  dbPath: string;
  seed: E2EFixtureSeed;
}

export function isWithinDir(rootDir: string, targetPath: string): boolean {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);
  return (
    resolvedTarget === resolvedRoot ||
    resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

export function isSafeE2ERoot(rootDir: string, repoRoot: string): boolean {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedRepoRoot = path.resolve(repoRoot);
  const tempRoot = path.resolve(os.tmpdir());

  return (
    path.basename(resolvedRoot).startsWith("droidagent-e2e-") &&
    isWithinDir(tempRoot, resolvedRoot) &&
    !isWithinDir(resolvedRoot, resolvedRepoRoot)
  );
}

export async function clearDirectoryContents(dirPath: string): Promise<void> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const targetPath = path.join(dirPath, entry.name);
      await fs.rm(targetPath, {
        recursive: entry.isDirectory(),
        force: true,
      });
    }),
  );
}

export async function readE2EFixtureState(
  statePath: string,
): Promise<E2EFixtureState> {
  const raw = await fs.readFile(statePath, "utf8");
  return JSON.parse(raw) as E2EFixtureState;
}
