import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAccessSettings, updateAccessSettings, getNamedSecret, hasNamedSecret, setNamedSecret, spawnMock, runCommandMock } = vi.hoisted(() => ({
  getAccessSettings: vi.fn(),
  updateAccessSettings: vi.fn(),
  getNamedSecret: vi.fn(),
  hasNamedSecret: vi.fn(),
  runCommandMock: vi.fn(),
  spawnMock: vi.fn(),
  setNamedSecret: vi.fn()
}));

vi.mock("./app-state-service.js", () => ({
  appStateService: {
    getAccessSettings,
    updateAccessSettings
  }
}));

vi.mock("./keychain-service.js", () => ({
  keychainService: {
    getNamedSecret,
    hasNamedSecret,
    setNamedSecret
  }
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock
}));

vi.mock("../lib/process.js", () => ({
  CommandError: class CommandError extends Error {
    stdout = "";
    stderr = "";
    exitCode: number | null = 1;
  },
  runCommand: runCommandMock
}));

import { CommandError } from "../lib/process.js";
import { cloudflareRemoteAccessProvider, tailscaleRemoteAccessProvider } from "./remote-access-service.js";

describe("CloudflareRemoteAccessProvider", () => {
  beforeEach(() => {
    getAccessSettings.mockResolvedValue({
      cloudflareHostname: "agent.example.com",
      cloudflareLastStartedAt: null
    });
    updateAccessSettings.mockResolvedValue(undefined);
    getNamedSecret.mockResolvedValue(null);
    hasNamedSecret.mockResolvedValue(false);
    setNamedSecret.mockResolvedValue(undefined);
    runCommandMock.mockReset();
    spawnMock.mockReset();
    tailscaleRemoteAccessProvider.invalidateStatus();
    cloudflareRemoteAccessProvider.invalidateStatus();
  });

  it("normalizes the hostname, reuses the stored token, and restarts the tunnel", async () => {
    const binarySpy = vi.spyOn(cloudflareRemoteAccessProvider as never, "binaryPath" as never).mockResolvedValue(
      "/opt/homebrew/bin/cloudflared"
    );
    const stopSpy = vi.spyOn(cloudflareRemoteAccessProvider, "stop").mockResolvedValue();
    const startSpy = vi.spyOn(cloudflareRemoteAccessProvider, "start").mockResolvedValue();
    getNamedSecret.mockResolvedValue("stored-token");

    await cloudflareRemoteAccessProvider.enable({
      hostname: "https://Agent.Example.com/",
      tunnelToken: ""
    });

    expect(setNamedSecret).toHaveBeenCalledWith("cloudflareTunnelToken", "stored-token");
    expect(updateAccessSettings).toHaveBeenCalledWith({
      cloudflareHostname: "agent.example.com"
    });
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledTimes(1);

    binarySpy.mockRestore();
    stopSpy.mockRestore();
    startSpy.mockRestore();
  });

  it("rejects hostnames that include a path", async () => {
    await expect(
      cloudflareRemoteAccessProvider.enable({
        hostname: "agent.example.com/path",
        tunnelToken: "token"
      })
    ).rejects.toThrow(/must not include a path/);
  });

  it("requires a token when no stored token exists", async () => {
    const binarySpy = vi.spyOn(cloudflareRemoteAccessProvider as never, "binaryPath" as never).mockResolvedValue(
      "/opt/homebrew/bin/cloudflared"
    );

    await expect(
      cloudflareRemoteAccessProvider.enable({
        hostname: "agent.example.com",
        tunnelToken: ""
      })
    ).rejects.toThrow(/tunnel token is required/);

    binarySpy.mockRestore();
  });

  it("starts cloudflared without exposing the tunnel token in argv", async () => {
    const binarySpy = vi.spyOn(cloudflareRemoteAccessProvider as never, "binaryPath" as never).mockResolvedValue(
      "/opt/homebrew/bin/cloudflared"
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true
    } as Response);
    const stdout = { on: vi.fn() };
    const stderr = { on: vi.fn() };
    const child = {
      stdout,
      stderr,
      on: vi.fn(),
      exitCode: null,
      pid: 4242
    };
    getNamedSecret.mockResolvedValue("secret-token");
    spawnMock.mockReturnValue(child as never);

    await cloudflareRemoteAccessProvider.start();

    expect(spawnMock).toHaveBeenCalledWith(
      "/opt/homebrew/bin/cloudflared",
      ["tunnel", "--no-autoupdate", "run"],
      expect.objectContaining({
        env: expect.objectContaining({
          TUNNEL_TOKEN: "secret-token"
        })
      })
    );
    expect(spawnMock.mock.calls[0]?.[1]).not.toContain("secret-token");

    binarySpy.mockRestore();
    fetchSpy.mockRestore();
  });
});

describe("TailscaleRemoteAccessProvider", () => {
  beforeEach(() => {
    runCommandMock.mockReset();
    spawnMock.mockReset();
    tailscaleRemoteAccessProvider.invalidateStatus();
    Object.assign(tailscaleRemoteAccessProvider as never, {
      process: null,
      activeSocketPath: null
    });
  });

  it("falls back to a userspace daemon when the system daemon requires root", async () => {
    const systemError = new CommandError("tailscale status --json failed", "", "failed to connect to local Tailscale service", 1);
    const statusJson = JSON.stringify({
      BackendState: "NeedsLogin",
      Self: {
        HostName: "droidagent-mac"
      },
      CurrentTailnet: {}
    });
    const hasBinarySpy = vi.spyOn(tailscaleRemoteAccessProvider as never, "hasBinary" as never).mockResolvedValue(true);
    const userspaceSpy = vi
      .spyOn(tailscaleRemoteAccessProvider as never, "ensureUserspaceDaemon" as never)
      .mockResolvedValue("/tmp/droidagent-tailscaled.sock");
    const fallbackSpy = vi
      .spyOn(tailscaleRemoteAccessProvider as never, "isUserspaceFallbackError" as never)
      .mockReturnValue(true);

    runCommandMock
      .mockResolvedValueOnce({ stdout: "1.96.3\n", stderr: "", exitCode: 0 })
      .mockRejectedValueOnce(systemError)
      .mockResolvedValueOnce({ stdout: statusJson, stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "{}", stderr: "", exitCode: 0 });

    const status = await tailscaleRemoteAccessProvider.getStatus();

    expect(runCommandMock).toHaveBeenCalledWith(
      "tailscale",
      ["--socket", "/tmp/droidagent-tailscaled.sock", "status", "--json"],
      expect.any(Object)
    );
    expect(status.installed).toBe(true);
    expect(status.running).toBe(true);
    expect(status.authenticated).toBe(false);
    expect(status.healthMessage).toContain("userspace daemon");

    hasBinarySpy.mockRestore();
    userspaceSpy.mockRestore();
    fallbackSpy.mockRestore();
  });
});
