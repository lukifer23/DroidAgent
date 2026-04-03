import { describe, expect, it } from "vitest";

import { baseEnv, paths } from "./env.js";

describe("baseEnv", () => {
  it("pins OpenClaw home to the DroidAgent profile state directory", () => {
    expect(baseEnv().OPENCLAW_HOME).toBe(paths.openClawHomeDir);
  });
});
