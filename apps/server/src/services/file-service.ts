import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { FileContentSchema, WorkspaceEntrySchema } from "@droidagent/shared";

import { appStateService } from "./app-state-service.js";

const MAX_PATH_COMPONENTS = 64;
const MAX_FILE_PREVIEW_BYTES = 512 * 1024;
const MAX_FILE_WRITE_BYTES = 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".mjs": "text/javascript",
  ".sh": "text/plain",
  ".svg": "image/svg+xml",
  ".toml": "text/plain",
  ".ts": "application/typescript",
  ".tsx": "application/typescript",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml"
};

function normalizeClientPath(input = "."): string {
  const trimmed = input.trim();
  if (!trimmed || trimmed === "." || trimmed === "/") {
    return ".";
  }

  const normalized = trimmed.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return normalized || ".";
}

function toPosixRelative(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath);
  return relative ? relative.split(path.sep).join("/") : ".";
}

function mimeTypeFor(target: string): string {
  return MIME_TYPES[path.extname(target).toLowerCase()] ?? "text/plain";
}

export class FileConflictError extends Error {
  constructor(
    message: string,
    public readonly currentModifiedAt: string
  ) {
    super(message);
  }
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

  private async resolveWithinRoot(target = "."): Promise<{ root: string; absolutePath: string; clientPath: string }> {
    const root = await this.workspaceRoot();
    const normalized = normalizeClientPath(target);
    const parts = normalized === "." ? [] : normalized.split("/").filter(Boolean);
    if (parts.length > MAX_PATH_COMPONENTS) {
      throw new Error("Path exceeds maximum depth.");
    }

    const absolutePath = path.resolve(root, ...parts);
    const realResolved = await fs.realpath(absolutePath).catch(() => absolutePath);
    const relative = path.relative(root, realResolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Requested path falls outside the configured workspace root.");
    }

    return {
      root,
      absolutePath: realResolved,
      clientPath: toPosixRelative(root, realResolved)
    };
  }

  async listDirectory(target = ".") {
    const { root, absolutePath } = await this.resolveWithinRoot(target);
    const stat = await fs.stat(absolutePath);
    if (!stat.isDirectory()) {
      throw new Error("Target is not a directory.");
    }

    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    return await Promise.all(
      entries
        .filter((entry) => !entry.name.startsWith("."))
        .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name))
        .map(async (entry) => {
          const entryAbsolute = path.join(absolutePath, entry.name);
          const entryReal = await fs.realpath(entryAbsolute).catch(() => entryAbsolute);
          const relative = path.relative(root, entryReal);
          if (relative.startsWith("..") || path.isAbsolute(relative)) {
            return null;
          }

          const stats = await fs.stat(entryReal);
          return WorkspaceEntrySchema.parse({
            path: toPosixRelative(root, entryReal),
            name: entry.name,
            kind: entry.isDirectory() ? "directory" : "file",
            size: entry.isDirectory() ? null : stats.size,
            modifiedAt: stats.mtime.toISOString()
          });
        })
    ).then((items) => items.filter((entry): entry is NonNullable<typeof entry> => entry !== null));
  }

  async readFile(target: string) {
    const { absolutePath, clientPath } = await this.resolveWithinRoot(target);
    const stat = await fs.stat(absolutePath);
    if (stat.isDirectory()) {
      throw new Error("Target is a directory, not a file.");
    }

    const buffer = await fs.readFile(absolutePath);
    if (!isUtf8(buffer)) {
      throw new Error("Only UTF-8 text files can be viewed or edited from DroidAgent.");
    }

    const truncated = buffer.length > MAX_FILE_PREVIEW_BYTES;
    const content = (truncated ? buffer.subarray(0, MAX_FILE_PREVIEW_BYTES) : buffer).toString("utf8");

    return FileContentSchema.parse({
      path: clientPath,
      content,
      modifiedAt: stat.mtime.toISOString(),
      size: stat.size,
      truncated,
      mimeType: mimeTypeFor(absolutePath),
      encoding: "utf-8"
    });
  }

  async writeFile(target: string, content: string, expectedModifiedAt: string | null) {
    const normalizedTarget = normalizeClientPath(target);
    const { absolutePath, clientPath } = await this.resolveWithinRoot(normalizedTarget);
    const byteLength = Buffer.byteLength(content, "utf8");
    if (byteLength > MAX_FILE_WRITE_BYTES) {
      throw new Error("File exceeds the maximum editable size.");
    }

    let existingStat: Awaited<ReturnType<typeof fs.stat>> | null = null;
    try {
      existingStat = await fs.stat(absolutePath);
      if (existingStat.isDirectory()) {
        throw new Error("Target is a directory, not a file.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    if (existingStat) {
      const currentModifiedAt = existingStat.mtime.toISOString();
      if (!expectedModifiedAt) {
        throw new Error("expectedModifiedAt is required when overwriting an existing file.");
      }
      if (currentModifiedAt !== expectedModifiedAt) {
        throw new FileConflictError("The file changed on disk after it was loaded.", currentModifiedAt);
      }
    }

    const parentDirectory = path.dirname(absolutePath);
    await fs.mkdir(parentDirectory, { recursive: true });

    const tempPath = path.join(parentDirectory, `.droidagent-${randomUUID()}.tmp`);
    await fs.writeFile(tempPath, content, "utf8");
    await fs.rename(tempPath, absolutePath);

    const nextStat = await fs.stat(absolutePath);
    return FileContentSchema.parse({
      path: clientPath,
      content,
      modifiedAt: nextStat.mtime.toISOString(),
      size: nextStat.size,
      truncated: false,
      mimeType: mimeTypeFor(absolutePath),
      encoding: "utf-8"
    });
  }

  async createDirectory(target: string): Promise<void> {
    const normalizedTarget = normalizeClientPath(target);
    const { absolutePath } = await this.resolveWithinRoot(normalizedTarget);
    await fs.mkdir(absolutePath, { recursive: true });
  }
}

export const fileService = new FileService();
