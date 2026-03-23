import fs from "node:fs/promises";
import path from "node:path";

import { WorkspaceEntrySchema } from "@droidagent/shared";

import { appStateService } from "./app-state-service.js";

export class FileService {
  private async workspaceRoot(): Promise<string> {
    const settings = await appStateService.getRuntimeSettings();
    if (!settings.workspaceRoot) {
      throw new Error("A workspace root has not been configured yet.");
    }
    return settings.workspaceRoot;
  }

  private async resolveWithinRoot(target = "."): Promise<string> {
    const root = await this.workspaceRoot();
    const resolved = path.resolve(root, target);
    const normalizedRoot = path.resolve(root);
    if (!resolved.startsWith(normalizedRoot)) {
      throw new Error("Requested path falls outside the configured workspace root.");
    }
    return resolved;
  }

  async listDirectory(target = ".") {
    const directoryPath = await this.resolveWithinRoot(target);
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    return await Promise.all(
      entries
        .filter((entry) => !entry.name.startsWith("."))
        .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name))
        .map(async (entry) => {
          const absolutePath = path.join(directoryPath, entry.name);
          const stats = await fs.stat(absolutePath);
          return WorkspaceEntrySchema.parse({
            path: absolutePath,
            name: entry.name,
            kind: entry.isDirectory() ? "directory" : "file",
            size: entry.isDirectory() ? null : stats.size,
            modifiedAt: stats.mtime.toISOString()
          });
        })
    );
  }

  async readFile(target: string): Promise<string> {
    const filePath = await this.resolveWithinRoot(target);
    return await fs.readFile(filePath, "utf8");
  }

  async createDirectory(target: string): Promise<void> {
    const dirPath = await this.resolveWithinRoot(target);
    await fs.mkdir(dirPath, { recursive: true });
  }
}

export const fileService = new FileService();

