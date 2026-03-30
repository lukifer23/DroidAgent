import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getRuntimeSettings } = vi.hoisted(() => ({
  getRuntimeSettings: vi.fn()
}));

vi.mock("./app-state-service.js", () => ({
  appStateService: {
    getRuntimeSettings: getRuntimeSettings
  }
}));

const { prepareWorkspaceScaffold } = vi.hoisted(() => ({
  prepareWorkspaceScaffold: vi.fn(),
}));

vi.mock("./openclaw-service.js", () => ({
  openclawService: {
    prepareWorkspaceScaffold,
  },
}));

import { FileConflictError, fileService } from "./file-service.js";

describe("FileService", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "droidagent-files-"));
    getRuntimeSettings.mockResolvedValue({
      workspaceRoot
    });
    prepareWorkspaceScaffold.mockReset();
    prepareWorkspaceScaffold.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    getRuntimeSettings.mockReset();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("lists workspace entries with relative paths", async () => {
    await fs.mkdir(path.join(workspaceRoot, "src"));
    await fs.writeFile(path.join(workspaceRoot, "README.md"), "# DroidAgent\n", "utf8");

    const entries = await fileService.listDirectory(".");

    expect(entries.map((entry) => entry.path)).toEqual(["src", "README.md"]);
  });

  it("skips entries that disappear during directory listing", async () => {
    await fs.mkdir(path.join(workspaceRoot, "src"));
    const readmePath = path.join(workspaceRoot, "README.md");
    await fs.writeFile(readmePath, "# DroidAgent\n", "utf8");
    const originalStat = fs.stat.bind(fs);
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (target) => {
      if (typeof target === "string" && path.basename(target) === "README.md") {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return await originalStat(target);
    });
    try {
      const entries = await fileService.listDirectory(".");

      expect(entries.map((entry) => entry.path)).toEqual(["src"]);
    } finally {
      statSpy.mockRestore();
    }
  });

  it("reads and writes text files with relative paths", async () => {
    const filePath = path.join(workspaceRoot, "notes.txt");
    await fs.writeFile(filePath, "first pass", "utf8");

    const loaded = await fileService.readFile("notes.txt");
    expect(loaded.path).toBe("notes.txt");
    expect(loaded.content).toBe("first pass");

    const saved = await fileService.writeFile("notes.txt", "second pass", loaded.modifiedAt);
    expect(saved.path).toBe("notes.txt");
    expect(saved.content).toBe("second pass");
  });

  it("repairs the workspace scaffold before opening first-class memory files", async () => {
    const memoryFilePath = path.join(workspaceRoot, "MEMORY.md");
    prepareWorkspaceScaffold.mockImplementation(async () => {
      await fs.writeFile(memoryFilePath, "# Durable Memory\n", "utf8");
    });

    const loaded = await fileService.readFile("MEMORY.md");

    expect(prepareWorkspaceScaffold).toHaveBeenCalledTimes(1);
    expect(loaded.path).toBe("MEMORY.md");
    expect(loaded.content).toContain("Durable Memory");
  });

  it("rejects stale writes when the file changed on disk", async () => {
    const filePath = path.join(workspaceRoot, "notes.txt");
    await fs.writeFile(filePath, "first pass", "utf8");

    const loaded = await fileService.readFile("notes.txt");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await fs.writeFile(filePath, "external edit", "utf8");

    await expect(fileService.writeFile("notes.txt", "second pass", loaded.modifiedAt)).rejects.toBeInstanceOf(FileConflictError);
  });

  it("rejects binary files from the editor surface", async () => {
    await fs.writeFile(path.join(workspaceRoot, "blob.bin"), Buffer.from([0xff, 0xfe, 0xfd]));
    await expect(fileService.readFile("blob.bin")).rejects.toThrow(/UTF-8 text files/);
  });

  it("rejects writes through a symlinked parent that escapes the workspace", async () => {
    const outside = path.join(path.dirname(workspaceRoot), "outside-write");
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, path.join(workspaceRoot, "escape"));

    await expect(fileService.writeFile("escape/secrets.txt", "nope", null)).rejects.toThrow(/outside the configured workspace root/);
  });

  it("rejects directory creation through a symlinked parent that escapes the workspace", async () => {
    const outside = path.join(path.dirname(workspaceRoot), "outside-dir");
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, path.join(workspaceRoot, "escape-dir"));

    await expect(fileService.createDirectory("escape-dir/new-folder")).rejects.toThrow(/outside the configured workspace root/);
  });

  it("rejects empty directory creation requests", async () => {
    await expect(fileService.createDirectory("   ")).rejects.toThrow(/directory path is required/i);
  });
});
