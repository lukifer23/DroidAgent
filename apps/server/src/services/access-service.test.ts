import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAccessSettings, updateAccessSettings, hasUser } = vi.hoisted(() => ({
  getAccessSettings: vi.fn(),
  updateAccessSettings: vi.fn(),
  hasUser: vi.fn()
}));

vi.mock("./app-state-service.js", () => ({
  appStateService: {
    getAccessSettings,
    updateAccessSettings,
    markSetupStepCompleted: vi.fn()
  }
}));

vi.mock("./auth-service.js", () => ({
  authService: {
    hasUser
  }
}));

vi.mock("../lib/process.js", () => ({
  CommandError: class CommandError extends Error {
    stdout = "";
    stderr = "";
    exitCode: number | null = 1;
  },
  runCommand: vi.fn()
}));

import { accessService } from "./access-service.js";

describe("AccessService", () => {
  let accessSettings: {
    mode: "loopback" | "tailscale";
    canonicalOrigin: {
      accessMode: "tailscale";
      origin: string;
      rpId: string;
      hostname: string;
      source: "manual";
      updatedAt: string;
    } | null;
    bootstrapTokenHash: string | null;
    bootstrapTokenIssuedAt: string | null;
    bootstrapTokenExpiresAt: string | null;
  };

  beforeEach(() => {
    accessSettings = {
      mode: "tailscale",
      canonicalOrigin: {
        accessMode: "tailscale",
        origin: "https://droidagent.example.ts.net",
        rpId: "droidagent.example.ts.net",
        hostname: "droidagent.example.ts.net",
        source: "manual",
        updatedAt: new Date().toISOString()
      },
      bootstrapTokenHash: null,
      bootstrapTokenIssuedAt: null,
      bootstrapTokenExpiresAt: null
    };

    getAccessSettings.mockImplementation(async () => accessSettings);
    updateAccessSettings.mockImplementation(async (update: Record<string, unknown>) => {
      accessSettings = {
        ...accessSettings,
        ...update
      };
      return accessSettings;
    });
    hasUser.mockResolvedValue(true);
  });

  it("issues, validates, and consumes a bootstrap token", async () => {
    const bootstrap = await accessService.createBootstrapToken();

    expect(bootstrap.bootstrapUrl).toContain("https://droidagent.example.ts.net");
    expect(await accessService.validateBootstrapToken(bootstrap.token)).toBe(true);

    await accessService.consumeBootstrapToken(bootstrap.token);
    expect(await accessService.validateBootstrapToken(bootstrap.token)).toBe(false);
  });

  it("rejects mutations from the wrong canonical origin", async () => {
    const context = {
      req: {
        url: "https://droidagent.example.ts.net/api/runtime",
        header: (name: string) => (name === "origin" ? "https://wrong.example.ts.net" : undefined)
      }
    } as never;

    await expect(accessService.assertCanonicalMutation(context, false)).rejects.toThrow(/Origin mismatch/);
  });

  it("allows localhost maintenance mutations when explicitly enabled", async () => {
    const context = {
      req: {
        url: "http://127.0.0.1:4318/api/runtime",
        header: (name: string) => (name === "origin" ? "http://127.0.0.1:4318" : undefined)
      }
    } as never;

    await expect(accessService.assertCanonicalMutation(context, true)).resolves.toBeUndefined();
  });
});
