import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getAccessSettings,
  updateAccessSettings,
  markSetupStepCompleted,
  hasUser,
  tailscaleGetStatus,
  tailscaleEnableServe,
  tailscaleInvalidateStatus,
  cloudflareGetStatus,
  cloudflareEnable,
  cloudflareStop,
  cloudflareInvalidateStatus
} = vi.hoisted(() => ({
  getAccessSettings: vi.fn(),
  updateAccessSettings: vi.fn(),
  markSetupStepCompleted: vi.fn(),
  hasUser: vi.fn(),
  tailscaleGetStatus: vi.fn(),
  tailscaleEnableServe: vi.fn(),
  tailscaleInvalidateStatus: vi.fn(),
  cloudflareGetStatus: vi.fn(),
  cloudflareEnable: vi.fn(),
  cloudflareStop: vi.fn(),
  cloudflareInvalidateStatus: vi.fn()
}));

vi.mock("./app-state-service.js", () => ({
  appStateService: {
    getAccessSettings,
    updateAccessSettings,
    markSetupStepCompleted
  }
}));

vi.mock("./auth-service.js", () => ({
  authService: {
    hasUser
  }
}));

vi.mock("./remote-access-service.js", () => ({
  tailscaleRemoteAccessProvider: {
    getStatus: tailscaleGetStatus,
    enableServe: tailscaleEnableServe,
    invalidateStatus: tailscaleInvalidateStatus
  },
  cloudflareRemoteAccessProvider: {
    getStatus: cloudflareGetStatus,
    enable: cloudflareEnable,
    stop: cloudflareStop,
    invalidateStatus: cloudflareInvalidateStatus
  }
}));

import { accessService } from "./access-service.js";

describe("AccessService", () => {
  let accessSettings: {
    mode: "loopback" | "tailscale" | "cloudflare";
    canonicalOrigin: {
      accessMode: "loopback" | "tailscale" | "cloudflare";
      origin: string;
      rpId: string;
      hostname: string;
      source: "manual" | "tailscaleServe" | "cloudflareTunnel";
      updatedAt: string;
    } | null;
    bootstrapTokenHash: string | null;
    bootstrapTokenIssuedAt: string | null;
    bootstrapTokenExpiresAt: string | null;
    cloudflareHostname: string | null;
    cloudflareLastStartedAt: string | null;
  };

  beforeEach(() => {
    accessSettings = {
      mode: "tailscale",
      canonicalOrigin: {
        accessMode: "tailscale",
        origin: "https://droidagent.example.ts.net",
        rpId: "droidagent.example.ts.net",
        hostname: "droidagent.example.ts.net",
        source: "tailscaleServe",
        updatedAt: new Date().toISOString()
      },
      bootstrapTokenHash: null,
      bootstrapTokenIssuedAt: null,
      bootstrapTokenExpiresAt: null,
      cloudflareHostname: null,
      cloudflareLastStartedAt: null
    };

    getAccessSettings.mockImplementation(async () => accessSettings);
    updateAccessSettings.mockImplementation(async (update: Record<string, unknown>) => {
      accessSettings = {
        ...accessSettings,
        ...update
      };
      return accessSettings;
    });
    markSetupStepCompleted.mockResolvedValue(undefined);
    hasUser.mockResolvedValue(true);

    tailscaleGetStatus.mockResolvedValue({
      installed: true,
      running: true,
      authenticated: true,
      health: "ok",
      healthMessage: "Tailscale is exposing DroidAgent.",
      version: "1.80.0",
      deviceName: "droidagent-mac",
      tailnetName: "example.ts.net",
      dnsName: "droidagent.example.ts.net",
      magicDnsEnabled: true,
      httpsEnabled: true,
      serveCommand: "tailscale serve --bg --https=443 4318",
      canonicalUrl: "https://droidagent.example.ts.net",
      lastCheckedAt: new Date().toISOString()
    });
    tailscaleEnableServe.mockResolvedValue(undefined);
    tailscaleInvalidateStatus.mockReset();

    cloudflareGetStatus.mockResolvedValue({
      installed: true,
      configured: true,
      running: true,
      tokenStored: true,
      health: "ok",
      healthMessage: "Cloudflare is exposing DroidAgent.",
      version: "2026.3.0",
      hostname: "agent.example.com",
      canonicalUrl: "https://agent.example.com",
      lastStartedAt: new Date().toISOString(),
      lastCheckedAt: new Date().toISOString()
    });
    cloudflareEnable.mockResolvedValue(undefined);
    cloudflareStop.mockResolvedValue(undefined);
    cloudflareInvalidateStatus.mockReset();
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

  it("enables a Cloudflare tunnel and returns the new access snapshot", async () => {
    const result = await accessService.enableCloudflareTunnel({
      hostname: "agent.example.com",
      tunnelToken: "secret-token"
    });

    expect(cloudflareEnable).toHaveBeenCalledWith({
      hostname: "agent.example.com",
      tunnelToken: "secret-token"
    });
    expect(result.cloudflare.canonicalUrl).toBe("https://agent.example.com");
    expect(result.serve.source).toBe("tailscale");
  });

  it("switches the canonical origin to Cloudflare", async () => {
    const canonical = await accessService.setCanonicalSource("cloudflare");

    expect(canonical.origin).toBe("https://agent.example.com");
    expect(canonical.source).toBe("cloudflareTunnel");
    expect(accessSettings.mode).toBe("cloudflare");
  });

  it("rejects bootstrap links when the canonical provider is no longer reachable", async () => {
    accessSettings = {
      ...accessSettings,
      mode: "cloudflare",
      canonicalOrigin: {
        accessMode: "cloudflare",
        origin: "https://agent.example.com",
        rpId: "agent.example.com",
        hostname: "agent.example.com",
        source: "cloudflareTunnel",
        updatedAt: new Date().toISOString()
      }
    };
    cloudflareGetStatus.mockResolvedValue({
      installed: true,
      configured: true,
      running: false,
      tokenStored: true,
      health: "warn",
      healthMessage: "Cloudflare tunnel is configured but unreachable.",
      version: "2026.3.0",
      hostname: "agent.example.com",
      canonicalUrl: "https://agent.example.com",
      lastStartedAt: new Date().toISOString(),
      lastCheckedAt: new Date().toISOString()
    });

    await expect(accessService.createBootstrapToken()).rejects.toThrow(/canonical Cloudflare URL is not currently reachable/i);
  });

  it("refuses to stop Cloudflare while it is still the canonical URL for an enrolled owner", async () => {
    accessSettings = {
      ...accessSettings,
      mode: "cloudflare",
      canonicalOrigin: {
        accessMode: "cloudflare",
        origin: "https://agent.example.com",
        rpId: "agent.example.com",
        hostname: "agent.example.com",
        source: "cloudflareTunnel",
        updatedAt: new Date().toISOString()
      }
    };

    await expect(accessService.stopCloudflareTunnel()).rejects.toThrow(/canonical DroidAgent URL/i);
    expect(cloudflareStop).not.toHaveBeenCalled();
  });

  it("includes Cloudflare state in the bootstrap snapshot", async () => {
    const state = await accessService.getBootstrapState();

    expect(state.cloudflareStatus.hostname).toBe("agent.example.com");
    expect(state.serveStatus.source).toBe("tailscale");
  });
});
