import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { FileContentSchema, WorkspaceEntrySchema } from "@droidagent/shared";

import { appStateService } from "./app-state-service.js";
import { openclawWorkspaceFacet } from "./openclaw-service-facets.js";
import { performanceService } from "./performance-service.js";

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

function isFirstClassMemoryPath(target: string): boolean {
  return target === "MEMORY.md" || target === "PREFERENCES.md";
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
  private assertInsideRoot(root: string, targetPath: string): string {
    const relative = path.relative(root, targetPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Requested path falls outside the configured workspace root.");
    }
    return targetPath;
  }

  private async workspaceRoot(): Promise<string> {
    const settings = await appStateService.getRuntimeSettings();
    if (!settings.workspaceRoot) {
      throw new Error("A workspace root has not been configured yet.");
    }
    const root = path.resolve(settings.workspaceRoot);
    const realRoot = await fs.realpath(root).catch(() => root);
    return realRoot;
  }

  private async resolveWithinRoot(
    target = ".",
    options: { allowMissingTarget?: boolean } = {}
  ): Promise<{
    root: string;
    absolutePath: string;
    clientPath: string;
    existingParentPath: string;
    missingParts: string[];
  }> {
    const root = await this.workspaceRoot();
    const normalized = normalizeClientPath(target);
    const parts = normalized === "." ? [] : normalized.split("/").filter(Boolean);
    if (parts.length > MAX_PATH_COMPONENTS) {
      throw new Error("Path exceeds maximum depth.");
    }

    let resolved = root;
    let consumed = 0;

    for (; consumed < parts.length; consumed += 1) {
      const next = path.join(resolved, parts[consumed]!);
      try {
        await fs.lstat(next);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && options.allowMissingTarget) {
          break;
        }
        throw error;
      }
      resolved = this.assertInsideRoot(root, await fs.realpath(next));
    }

    const missingParts = parts.slice(consumed);
    const absolutePath =
      missingParts.length === 0 ? resolved : this.assertInsideRoot(root, path.resolve(resolved, ...missingParts));
    const existingParentPath =
      parts.length === 0
        ? root
        : missingParts.length === 0
        ? this.assertInsideRoot(root, await fs.realpath(path.dirname(absolutePath)).catch(() => path.dirname(absolutePath)))
        : resolved;

    return {
      root,
      absolutePath,
      clientPath: normalized,
      existingParentPath,
      missingParts
    };
  }

  private async ensureDirectoryChain(root: string, existingParentPath: string, missingParts: string[]): Promise<string> {
    let current = this.assertInsideRoot(root, existingParentPath);
    for (const part of missingParts) {
      const next = path.join(current, part);
      try {
        await fs.mkdir(next);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }

      const stat = await fs.lstat(next);
      if (!stat.isDirectory()) {
        throw new Error("Requested path collides with a non-directory entry inside the workspace.");
      }

      current = this.assertInsideRoot(root, await fs.realpath(next).catch(() => next));
    }

    return current;
  }

  async listDirectory(target = ".") {
    const metric = performanceService.start("server", "file.list", {
      target
    });
    try {
      const { root, absolutePath } = await this.resolveWithinRoot(target);
      const stat = await fs.stat(absolutePath);
      if (!stat.isDirectory()) {
        throw new Error("Target is not a directory.");
      }

      const directoryEntries = await fs.readdir(absolutePath, { withFileTypes: true });
      const entries = await Promise.all(
        directoryEntries
          .filter((entry) => !entry.name.startsWith("."))
          .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name))
          .map(async (entry) => {
            const entryAbsolute = path.join(absolutePath, entry.name);
            const entryReal = await fs.realpath(entryAbsolute).catch(() => entryAbsolute);
            try {
              this.assertInsideRoot(root, entryReal);
            } catch {
              return null;
            }

            let stats: Awaited<ReturnType<typeof fs.stat>>;
            try {
              stats = await fs.stat(entryReal);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return null;
              }
              throw error;
            }
            return WorkspaceEntrySchema.parse({
              path: toPosixRelative(root, entryAbsolute),
              name: entry.name,
              kind: entry.isDirectory() ? "directory" : "file",
              size: entry.isDirectory() ? null : stats.size,
              modifiedAt: stats.mtime.toISOString()
            });
          })
      ).then((items) => items.filter((entry): entry is NonNullable<typeof entry> => entry !== null));
      metric.finish({
        count: entries.length,
        outcome: "ok"
      });
      return entries;
    } catch (error) {
      metric.finish({
        outcome: "error"
      });
      throw error;
    }
  }

  async readFile(target: string) {
    const metric = performanceService.start("server", "file.read", {
      target
    });
    try {
      const normalizedTarget = normalizeClientPath(target);
      if (isFirstClassMemoryPath(normalizedTarget)) {
        await openclawWorkspaceFacet.prepareWorkspaceScaffold();
      }
      const { absolutePath, clientPath } = await this.resolveWithinRoot(normalizedTarget);
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

      const parsed = FileContentSchema.parse({
        path: clientPath,
        content,
        modifiedAt: stat.mtime.toISOString(),
        size: stat.size,
        truncated,
        mimeType: mimeTypeFor(absolutePath),
        encoding: "utf-8"
      });
      metric.finish({
        bytes: stat.size,
        truncated,
        outcome: "ok"
      });
      return parsed;
    } catch (error) {
      metric.finish({
        outcome: "error"
      });
      throw error;
    }
  }

  async writeFile(target: string, content: string, expectedModifiedAt: string | null) {
    const metric = performanceService.start("server", "file.write", {
      target
    });
    try {
      const normalizedTarget = normalizeClientPath(target);
      if (normalizedTarget === ".") {
        throw new Error("A file path is required.");
      }

      const targetParts = normalizedTarget.split("/").filter(Boolean);
      const parentTarget = targetParts.slice(0, -1).join("/") || ".";
      const fileName = targetParts.at(-1);
      if (!fileName) {
        throw new Error("A file path is required.");
      }

      const {
        root,
        absolutePath: parentAbsolutePath,
        existingParentPath,
        missingParts
      } = await this.resolveWithinRoot(parentTarget, { allowMissingTarget: true });
      const parentDirectory =
        missingParts.length === 0
          ? this.assertInsideRoot(root, parentAbsolutePath)
          : await this.ensureDirectoryChain(root, existingParentPath, missingParts);
      const absolutePath = this.assertInsideRoot(root, path.join(parentDirectory, fileName));
      const byteLength = Buffer.byteLength(content, "utf8");
      if (byteLength > MAX_FILE_WRITE_BYTES) {
        throw new Error("File exceeds the maximum editable size.");
      }

      let existingStat: Awaited<ReturnType<typeof fs.stat>> | null = null;
      try {
        const existingEntry = await fs.lstat(absolutePath);
        if (existingEntry.isSymbolicLink()) {
          throw new Error("DroidAgent will not overwrite symlinked files from the editor surface.");
        }
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

      const tempPath = path.join(parentDirectory, `.droidagent-${randomUUID()}.tmp`);
      await fs.writeFile(tempPath, content, "utf8");
      await fs.rename(tempPath, absolutePath);

      const nextStat = await fs.stat(absolutePath);
      const parsed = FileContentSchema.parse({
        path: normalizedTarget,
        content,
        modifiedAt: nextStat.mtime.toISOString(),
        size: nextStat.size,
        truncated: false,
        mimeType: mimeTypeFor(absolutePath),
        encoding: "utf-8"
      });
      metric.finish({
        bytes: nextStat.size,
        outcome: "ok"
      });
      return parsed;
    } catch (error) {
      metric.finish({
        outcome: error instanceof FileConflictError ? "conflict" : "error"
      });
      throw error;
    }
  }

  async createDirectory(target: string): Promise<void> {
    const metric = performanceService.start("server", "file.mkdir", {
      target
    });
    try {
      const normalizedTarget = normalizeClientPath(target);
      if (normalizedTarget === ".") {
        throw new Error("A directory path is required.");
      }

      const { root, absolutePath, existingParentPath, missingParts } = await this.resolveWithinRoot(normalizedTarget, {
        allowMissingTarget: true
      });

      if (missingParts.length === 0) {
        const stat = await fs.lstat(absolutePath);
        if (!stat.isDirectory()) {
          throw new Error("Target already exists and is not a directory.");
        }
        metric.finish({
          created: 0,
          outcome: "noop"
        });
        return;
      }

      await this.ensureDirectoryChain(root, existingParentPath, missingParts);
      metric.finish({
        created: missingParts.length,
        outcome: "ok"
      });
    } catch (error) {
      metric.finish({
        outcome: "error"
      });
      throw error;
    }
  }
}

export const fileService = new FileService();
