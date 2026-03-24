import { describe, expect, it } from "vitest";
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
  const root = "/Users/test/workspace";

  it("resolves . to workspace root", () => {
    expect(resolveCwdWithinWorkspace(".", root)).toBe(root);
  });

  it("resolves subdir within workspace", () => {
    expect(resolveCwdWithinWorkspace("subdir", root)).toBe(
      "/Users/test/workspace/subdir"
    );
  });

  it("rejects path escaping workspace", () => {
    expect(() =>
      resolveCwdWithinWorkspace("../etc", root)
    ).toThrow("inside the workspace root");
  });

  it("rejects absolute path outside workspace", () => {
    expect(() =>
      resolveCwdWithinWorkspace("/tmp", root)
    ).toThrow("inside the workspace root");
  });
});
