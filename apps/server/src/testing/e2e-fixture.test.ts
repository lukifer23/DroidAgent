import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  isSafeE2ERoot,
  isWithinDir,
} from "./e2e-fixture.js";

describe("e2e fixture safety helpers", () => {
  it("accepts only dedicated temp E2E roots", () => {
    const safeRoot = path.join(os.tmpdir(), "droidagent-e2e-safe-123");
    const repoRoot = path.join(
      os.tmpdir(),
      "other-parent",
      "DroidAgent",
    );

    expect(isSafeE2ERoot(safeRoot, repoRoot)).toBe(true);
    expect(isSafeE2ERoot(repoRoot, repoRoot)).toBe(false);
    expect(
      isSafeE2ERoot(path.join(os.tmpdir(), "not-droidagent"), repoRoot),
    ).toBe(false);
  });

  it("detects whether a path stays within a root", () => {
    const root = path.join(os.tmpdir(), "droidagent-e2e-safe-123");

    expect(isWithinDir(root, path.join(root, "workspace", "notes.txt"))).toBe(
      true,
    );
    expect(isWithinDir(root, root)).toBe(true);
    expect(isWithinDir(root, path.join(root, "..", "outside"))).toBe(false);
  });
});
