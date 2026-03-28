import fs from "node:fs";

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

import { paths } from "../env.js";
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
    const wakeSystemAppSpy = vi
      .spyOn(tailscaleRemoteAccessProvider as never, "wakeSystemApp" as never)
      .mockResolvedValue(false);
    const existsSyncSpy = vi.spyOn(fs, "existsSync").mockImplementation((value) => {
      if (value === paths.tailscaleSocketPath) {
        return false;
      }
      return true;
    });
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
    wakeSystemAppSpy.mockRestore();
    existsSyncSpy.mockRestore();
    userspaceSpy.mockRestore();
    fallbackSpy.mockRestore();
  });

  it("falls back to the userspace daemon when the system status probe times out", async () => {
    const timeoutError = new CommandError("tailscale status --json timed out", "", "", null);
    const statusJson = JSON.stringify({
      BackendState: "Running",
      Self: {
        HostName: "droidagent-mac",
        DNSName: "droidagent-mac.taila06290.ts.net."
      },
      CurrentTailnet: {
        Name: "taila06290.ts.net",
        MagicDNSEnabled: true
      }
    });
    const hasBinarySpy = vi.spyOn(tailscaleRemoteAccessProvider as never, "hasBinary" as never).mockResolvedValue(true);
    const wakeSystemAppSpy = vi
      .spyOn(tailscaleRemoteAccessProvider as never, "wakeSystemApp" as never)
      .mockResolvedValue(false);
    const existsSyncSpy = vi.spyOn(fs, "existsSync").mockImplementation((value) => {
      if (value === paths.tailscaleSocketPath) {
        return false;
      }
      return true;
    });
    const userspaceSpy = vi
      .spyOn(tailscaleRemoteAccessProvider as never, "ensureUserspaceDaemon" as never)
      .mockResolvedValue("/tmp/droidagent-tailscaled.sock");

    runCommandMock
      .mockResolvedValueOnce({ stdout: "1.96.3\n", stderr: "", exitCode: 0 })
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce({ stdout: statusJson, stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: JSON.stringify(["https://droidagent-mac.taila06290.ts.net", "http://127.0.0.1:4318"]), stderr: "", exitCode: 0 });

    const status = await tailscaleRemoteAccessProvider.getStatus();

    expect(status.installed).toBe(true);
    expect(status.running).toBe(true);
    expect(status.authenticated).toBe(true);
    expect(status.canonicalUrl).toBe("https://droidagent-mac.taila06290.ts.net");
    expect(userspaceSpy).toHaveBeenCalledTimes(1);

    hasBinarySpy.mockRestore();
    wakeSystemAppSpy.mockRestore();
    existsSyncSpy.mockRestore();
    userspaceSpy.mockRestore();
  });

  it("surfaces the tailnet serve enable URL instead of hanging when Serve is disabled", async () => {
    const serveDisabledError = new CommandError("tailscale serve --bg --https=443 4318 timed out", "", "", null);
    Object.assign(serveDisabledError as { stdout: string; stderr: string; exitCode: number | null }, {
      stdout: "Serve is not enabled on your tailnet.\nTo enable, visit:\n\nhttps://login.tailscale.com/f/serve?node=test-node\n",
      stderr: "",
      exitCode: null
    });
    const userspaceSpy = vi
      .spyOn(tailscaleRemoteAccessProvider as never, "ensureUserspaceDaemon" as never)
      .mockResolvedValue("/tmp/droidagent-tailscaled.sock");

    runCommandMock.mockRejectedValueOnce(serveDisabledError);

    await expect(tailscaleRemoteAccessProvider.enableServe()).rejects.toThrow(
      "Tailscale Serve is disabled for this tailnet. Enable it here first: https://login.tailscale.com/f/serve?node=test-node"
    );

    userspaceSpy.mockRestore();
  });

  it("falls back to the last known Tailscale status when a fresh probe fails", async () => {
    const hasBinarySpy = vi.spyOn(tailscaleRemoteAccessProvider as never, "hasBinary" as never).mockResolvedValue(true);
    const readRawStatusSpy = vi.spyOn(tailscaleRemoteAccessProvider as never, "readRawStatus" as never);

    readRawStatusSpy.mockResolvedValueOnce({
      version: "1.96.3",
      running: true,
      mode: "system",
      socketPath: null,
      statusRaw: {
        BackendState: "Running",
        Self: {
          HostName: "mac",
          DNSName: "mac.taila06290.ts.net."
        },
        CurrentTailnet: {
          Name: "taila06290.ts.net",
          MagicDNSEnabled: true
        }
      },
      serveRaw: ["https://mac.taila06290.ts.net", "http://127.0.0.1:4318"]
    });

    const first = await tailscaleRemoteAccessProvider.getStatus();
    tailscaleRemoteAccessProvider.invalidateStatus();

    readRawStatusSpy.mockRejectedValueOnce(new Error("probe failed"));

    const second = await tailscaleRemoteAccessProvider.getStatus();

    expect(first.canonicalUrl).toBe("https://mac.taila06290.ts.net");
    expect(second.canonicalUrl).toBe(first.canonicalUrl);
    expect(second.healthMessage).toBe(first.healthMessage);

    hasBinarySpy.mockRestore();
    readRawStatusSpy.mockRestore();
  });
});
