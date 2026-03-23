import fs from "node:fs/promises";
import path from "node:path";

import { WorkspaceEntrySchema } from "@droidagent/shared";

import { appStateService } from "./app-state-service.js";

const MAX_PATH_COMPONENTS = 64;
const MAX_FILE_PREVIEW_BYTES = 512 * 1024;

function normalizePathSegment(segment: string): string {
  return segment.replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "") || ".";
}

export class FileService {
  private async workspaceRoot(): Promise<string> {
    const settings = await appStateService.getRuntimeSettings();
    if (!settings.workspaceRoot) {
      throw new Error("A workspace root has not been configured yet.");
    }
    const root = path.resolve(settings.workspaceRoot);
    const realRoot = await fs.realpath(root).catch(() => root);
    return realRoot;
  }

  private async resolveWithinRoot(target = "."): Promise<string> {
    const root = await this.workspaceRoot();
    const normalized = normalizePathSegment(target);
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length > MAX_PATH_COMPONENTS) {
      throw new Error("Path exceeds maximum depth.");
    }
    const resolved = path.resolve(root, ...parts);
    const realResolved = await fs.realpath(resolved).catch(() => resolved);
    if (!realResolved.startsWith(root) && !path.relative(root, realResolved).startsWith("..")) {
      const relative = path.relative(root, realResolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("Requested path falls outside the configured workspace root.");
      }
    }
    const relative = path.relative(root, realResolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Requested path falls outside the configured workspace root.");
    }
    return realResolved;
  }

  async listDirectory(target = ".") {
    const directoryPath = await this.resolveWithinRoot(target);
    const stat = await fs.stat(directoryPath);
    if (!stat.isDirectory()) {
      throw new Error("Target is not a directory.");
    }
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    return await Promise.all(
      entries
        .filter((entry) => !entry.name.startsWith("."))
        .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name))
        .map(async (entry) => {
          const absolutePath = path.join(directoryPath, entry.name);
          const entryReal = await fs.realpath(absolutePath).catch(() => absolutePath);
          const root = await this.workspaceRoot();
          const rel = path.relative(root, entryReal);
          if (rel.startsWith("..") || path.isAbsolute(rel)) {
            return null;
          }
          const stats = await fs.stat(entryReal);
          return WorkspaceEntrySchema.parse({
            path: entryReal,
            name: entry.name,
            kind: entry.isDirectory() ? "directory" : "file",
            size: entry.isDirectory() ? null : stats.size,
            modifiedAt: stats.mtime.toISOString()
          });
        })
    ).then((arr) => arr.filter((e): e is NonNullable<typeof e> => e !== null));
  }

  async readFile(target: string): Promise<string> {
    const filePath = await this.resolveWithinRoot(target);
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      throw new Error("Target is a directory, not a file.");
    }
    if (stat.size > MAX_FILE_PREVIEW_BYTES) {
      const buffer = Buffer.alloc(MAX_FILE_PREVIEW_BYTES);
      const fd = await fs.open(filePath, "r");
      try {
        await fd.read(buffer, 0, MAX_FILE_PREVIEW_BYTES, 0);
        return buffer.toString("utf8", 0, buffer.indexOf(0) >= 0 ? buffer.indexOf(0) : buffer.length) + "\n\n[…truncated…]";
      } finally {
        await fd.close();
      }
    }
    return await fs.readFile(filePath, "utf8");
  }

  async createDirectory(target: string): Promise<void> {
    const dirPath = await this.resolveWithinRoot(target);
    await fs.mkdir(dirPath, { recursive: true });
  }
}

export const fileService = new FileService();

