import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  runCommand,
  getRuntimeSettings,
  updateRuntimeSettings,
  markSetupStepCompleted,
  updateSetupState,
  configureSignal,
  removeSignalChannel,
  spawnMock
} = vi.hoisted(() => ({
  runCommand: vi.fn(),
  getRuntimeSettings: vi.fn(),
  updateRuntimeSettings: vi.fn(),
  markSetupStepCompleted: vi.fn(),
  updateSetupState: vi.fn(),
  configureSignal: vi.fn(),
  removeSignalChannel: vi.fn(),
  spawnMock: vi.fn()
}));

vi.mock("../lib/process.js", () => ({
  CommandError: class CommandError extends Error {
    stdout = "";
    stderr = "";
    exitCode: number | null = 1;
  },
  runCommand
}));

vi.mock("./app-state-service.js", () => ({
  appStateService: {
    getRuntimeSettings,
    updateRuntimeSettings,
    markSetupStepCompleted,
    updateSetupState
  }
}));

vi.mock("./openclaw-service.js", () => ({
  openclawService: {
    configureSignal,
    removeSignalChannel
  }
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock
}));

import { SIGNAL_DAEMON_URL, ensureAppDirs } from "../env.js";
import { signalService } from "./signal-service.js";

function createFakeStream() {
  const stream = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void };
  stream.setEncoding = () => {};
  return stream;
}

function createFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: ReturnType<typeof createFakeStream>;
    stderr: ReturnType<typeof createFakeStream>;
    pid: number;
    exitCode: number | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = createFakeStream();
  child.stderr = createFakeStream();
  child.pid = 4242;
  child.exitCode = null;
  child.kill = vi.fn(() => {
    child.exitCode = 0;
    child.emit("exit", 0);
    return true;
  });
  return child;
}

describe("SignalService", () => {
  let runtimeSettings: {
    signalCliPath: string | null;
    signalJavaHome: string | null;
    signalPhoneNumber: string | null;
    signalAccountId: string | null;
    signalDeviceName: string | null;
    signalCliVersion: string | null;
    signalReceiveMode: "persistent" | "on-start" | "unknown";
    signalRegistrationMode: "none" | "register" | "link";
    signalRegistrationState: "unconfigured" | "awaitingVerification" | "awaitingLink" | "registered" | "error";
    signalLinkUri: string | null;
    signalDaemonUrl: string | null;
    signalDaemonPid: number | null;
    signalDaemonState: "stopped" | "starting" | "running" | "error";
    signalLastError: string | null;
    signalLastStartedAt: string | null;
    signalCompatibilityWarning: string | null;
  };

  beforeEach(() => {
    ensureAppDirs();

    runtimeSettings = {
      signalCliPath: "/opt/homebrew/bin/signal-cli",
      signalJavaHome: "/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home",
      signalPhoneNumber: null,
      signalAccountId: "+15555550123",
      signalDeviceName: null,
      signalCliVersion: null,
      signalReceiveMode: "unknown",
      signalRegistrationMode: "none",
      signalRegistrationState: "unconfigured",
      signalLinkUri: null,
      signalDaemonUrl: null,
      signalDaemonPid: null,
      signalDaemonState: "stopped",
      signalLastError: null,
      signalLastStartedAt: null,
      signalCompatibilityWarning: null
    };

    getRuntimeSettings.mockImplementation(async () => runtimeSettings);
    updateRuntimeSettings.mockImplementation(async (update: Record<string, unknown>) => {
      runtimeSettings = {
        ...runtimeSettings,
        ...update
      };
      return runtimeSettings;
    });
    markSetupStepCompleted.mockResolvedValue(undefined);
    updateSetupState.mockResolvedValue(undefined);
    configureSignal.mockResolvedValue(undefined);
    removeSignalChannel.mockResolvedValue(undefined);
    runCommand.mockReset();
    spawnMock.mockReset();
    (signalService as unknown as { linkProcess: unknown; daemonProcess: unknown }).linkProcess = null;
    (signalService as unknown as { linkProcess: unknown; daemonProcess: unknown }).daemonProcess = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records the detected CLI version and compatibility warning during refresh", async () => {
    vi.spyOn(signalService as never, "detectCliPath" as never).mockResolvedValue(runtimeSettings.signalCliPath);
    vi.spyOn(signalService as never, "detectJavaHome" as never).mockResolvedValue(runtimeSettings.signalJavaHome);
    vi.spyOn(signalService as never, "detectCliVersion" as never).mockResolvedValue("signal-cli 0.13.2");
    vi.spyOn(signalService as never, "detectCompatibilityWarning" as never).mockResolvedValue(
      "signal-cli is older than the current Homebrew formula."
    );
    vi.spyOn(signalService, "listAccounts").mockResolvedValue([]);
    vi.spyOn(signalService as never, "daemonHealthcheck" as never).mockResolvedValue(false);

    await signalService.refreshState();

    expect(runtimeSettings.signalCliVersion).toBe("signal-cli 0.13.2");
    expect(runtimeSettings.signalCompatibilityWarning).toMatch(/older than the current Homebrew formula/);
    expect(runtimeSettings.signalReceiveMode).toBe("persistent");
  });

  it("starts the daemon without the deprecated receive-mode flag", async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child as never);

    vi.spyOn(signalService as never, "ensureSignalRuntime" as never).mockResolvedValue({
      cliPath: runtimeSettings.signalCliPath,
      javaHome: runtimeSettings.signalJavaHome
    });
    vi.spyOn(signalService as never, "signalEnv" as never).mockResolvedValue({});
    vi.spyOn(signalService as never, "daemonHealthcheck" as never)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await signalService.startDaemon();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnMock.mock.calls[0]?.[1];
    expect(spawnArgs).toContain("daemon");
    expect(spawnArgs).toContain("--http");
    expect(spawnArgs).not.toContain("--receive-mode");
    expect(configureSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "+15555550123",
        httpUrl: SIGNAL_DAEMON_URL
      })
    );
    expect(runtimeSettings.signalDaemonState).toBe("running");
    expect(runtimeSettings.signalReceiveMode).toBe("persistent");
  });

  it("extracts a Signal link URI from the live link flow", async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child as never);

    vi.spyOn(signalService as never, "ensureSignalRuntime" as never).mockResolvedValue({
      cliPath: runtimeSettings.signalCliPath,
      javaHome: runtimeSettings.signalJavaHome
    });
    vi.spyOn(signalService as never, "signalEnv" as never).mockResolvedValue({});

    const resultPromise = signalService.startLink("DroidAgent");
    setTimeout(() => {
      child.stdout.emit("data", "Use this in Signal: sgnl://linkdevice?uuid=test-device");
    }, 0);

    const result = await resultPromise;

    expect(result.linkUri).toBe("sgnl://linkdevice?uuid=test-device");
    expect(runtimeSettings.signalLinkUri).toBe("sgnl://linkdevice?uuid=test-device");
  }, 10000);

  it("builds the owner test-message command with the registered account", async () => {
    const runSignalSpy = vi.spyOn(signalService as never, "runSignal" as never).mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0
    });
    vi.spyOn(signalService as never, "resolveAccountId" as never).mockResolvedValue("+15555550123");

    await signalService.sendTestMessage({
      target: "+15555550999",
      text: "DroidAgent Signal path is healthy."
    });

    expect(runSignalSpy).toHaveBeenCalledWith([
      "-a",
      "+15555550123",
      "send",
      "-m",
      "DroidAgent Signal path is healthy.",
      "+15555550999"
    ]);
  });
});
