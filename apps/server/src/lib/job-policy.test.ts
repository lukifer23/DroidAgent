import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveCwdWithinWorkspace, validateCommand } from "./job-policy.js";

describe("validateCommand", () => {
  it("rejects empty command", () => {
    expect(() => validateCommand("")).toThrow("Command cannot be empty");
    expect(() => validateCommand("   ")).toThrow("Command cannot be empty");
  });

  it("rejects sudo", () => {
    expect(() => validateCommand("sudo ls")).toThrow("forbidden");
    expect(() => validateCommand("echo test | sudo cat")).toThrow("forbidden");
  });

  it("rejects su", () => {
    expect(() => validateCommand("su root")).toThrow("forbidden");
  });

  it("rejects dangerous rm", () => {
    expect(() => validateCommand("rm -rf /")).toThrow("forbidden");
    expect(() => validateCommand("rm -rf /etc")).toThrow("forbidden");
  });

  it("allows safe commands", () => {
    expect(() => validateCommand("ls -la")).not.toThrow();
    expect(() => validateCommand("pwd")).not.toThrow();
    expect(() => validateCommand("echo hello")).not.toThrow();
    expect(() => validateCommand("cd subdir && npm install")).not.toThrow();
  });
});

describe("resolveCwdWithinWorkspace", () => {
  let tempRoot: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "droidagent-job-policy-"));
    workspaceRoot = path.join(tempRoot, "workspace");
    await fs.mkdir(path.join(workspaceRoot, "project"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("resolves . to the real workspace root", async () => {
    await expect(resolveCwdWithinWorkspace(".", workspaceRoot)).resolves.toBe(await fs.realpath(workspaceRoot));
  });

  it("resolves a real subdirectory within the workspace", async () => {
    await expect(resolveCwdWithinWorkspace("project", workspaceRoot)).resolves.toBe(await fs.realpath(path.join(workspaceRoot, "project")));
  });

  it("rejects missing directories", async () => {
    await expect(resolveCwdWithinWorkspace("missing", workspaceRoot)).rejects.toThrow(/does not exist/);
  });

  it("rejects paths escaping the workspace root", async () => {
    await expect(resolveCwdWithinWorkspace("../etc", workspaceRoot)).rejects.toThrow(/inside the workspace root/);
  });

  it("rejects absolute paths outside the workspace", async () => {
    await expect(resolveCwdWithinWorkspace("/tmp", workspaceRoot)).rejects.toThrow(/inside the workspace root/);
  });

  it("rejects symlinked directories that resolve outside the workspace", async () => {
    const outside = path.join(tempRoot, "outside");
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, path.join(workspaceRoot, "escape"));

    await expect(resolveCwdWithinWorkspace("escape", workspaceRoot)).rejects.toThrow(/inside the workspace root/);
  });
});
