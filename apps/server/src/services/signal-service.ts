import fs from "node:fs";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { nowIso } from "@droidagent/shared";

import { SIGNAL_DAEMON_PORT, SIGNAL_DAEMON_URL, baseEnv, paths } from "../env.js";
import { CommandError, runCommand } from "../lib/process.js";
import { appStateService } from "./app-state-service.js";
import { openclawService } from "./openclaw-service.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function appendSignalLog(chunk: Buffer | string): void {
  fs.appendFileSync(paths.signalDaemonLogPath, chunk);
}

function looksLikeE164(value: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(value);
}

const SIGNAL_STATE_TTL_MS = 30_000;
const SIGNAL_COMMAND_TIMEOUT_MS = 1500;
const SIGNAL_BREW_TIMEOUT_MS = 1500;
const SIGNAL_DAEMON_TIMEOUT_MS = 1500;

export class SignalService {
  private linkProcess: ChildProcess | null = null;
  private daemonProcess: ChildProcess | null = null;
  private lastRefreshedAt = 0;
  private refreshPromise: Promise<void> | null = null;

  invalidateStateCache(): void {
    this.lastRefreshedAt = 0;
    openclawService.invalidateChannelStatusCache();
  }

  private async which(binary: string): Promise<string | null> {
    try {
      const result = await runCommand("which", [binary]);
      return result.stdout.trim().split("\n")[0] || null;
    } catch {
      return null;
    }
  }

  private async detectCliPath(): Promise<string | null> {
    const settings = await appStateService.getRuntimeSettings();
    if (settings.signalCliPath && fs.existsSync(settings.signalCliPath)) {
      return settings.signalCliPath;
    }
    return await this.which("signal-cli");
  }

  private async detectJavaHome(): Promise<string | null> {
    const settings = await appStateService.getRuntimeSettings();
    const candidates = [
      "/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home",
      "/usr/local/opt/openjdk/libexec/openjdk.jdk/Contents/Home",
      settings.signalJavaHome,
      process.env.SIGNAL_JAVA_HOME,
      process.env.JAVA_HOME
    ].filter((value): value is string => Boolean(value));

    for (const candidate of candidates) {
      if (fs.existsSync(`${candidate}/bin/java`)) {
        return candidate;
      }
    }

    return null;
  }

  private async ensureSignalRuntime(): Promise<{ cliPath: string; javaHome: string }> {
    const cliPath = await this.detectCliPath();
    if (!cliPath) {
      throw new Error("signal-cli is not installed yet.");
    }

    const javaHome = await this.detectJavaHome();
    if (!javaHome) {
      throw new Error("A compatible Java runtime for signal-cli was not found.");
    }

    await appStateService.updateRuntimeSettings({
      signalCliPath: cliPath,
      signalJavaHome: javaHome
    });

    return { cliPath, javaHome };
  }

  private async detectCliVersion(cliPath: string, javaHome: string): Promise<string | null> {
    try {
      const result = await runCommand(cliPath, ["--version"], {
        env: {
          ...baseEnv(),
          JAVA_HOME: javaHome
        },
        timeoutMs: SIGNAL_COMMAND_TIMEOUT_MS
      });
      return result.stdout.trim().split("\n")[0] || null;
    } catch {
      return null;
    }
  }

  private async detectCompatibilityWarning(): Promise<string | null> {
    try {
      const brewPath = await this.which("brew");
      if (!brewPath) {
        return null;
      }

      const result = await runCommand("brew", ["outdated", "signal-cli"], {
        okExitCodes: [0],
        timeoutMs: SIGNAL_BREW_TIMEOUT_MS
      });
      if (result.stdout.trim()) {
        return "signal-cli is older than the current Homebrew formula. Upgrade it soon; upstream Signal changes can break older builds.";
      }
      return null;
    } catch {
      return null;
    }
  }

  private async signalEnv(): Promise<NodeJS.ProcessEnv> {
    const { javaHome } = await this.ensureSignalRuntime();
    return {
      ...baseEnv(),
      JAVA_HOME: javaHome
    };
  }

  private async runSignal(
    args: string[],
    okExitCodes = [0],
    options: {
      timeoutMs?: number;
    } = {}
  ) {
    const { cliPath } = await this.ensureSignalRuntime();
    return await runCommand(cliPath, ["-c", paths.signalCliConfigDir, ...args], {
      env: await this.signalEnv(),
      okExitCodes,
      ...(typeof options.timeoutMs === "number" ? { timeoutMs: options.timeoutMs } : {})
    });
  }

  private async resolveAccountId(): Promise<string | null> {
    const settings = await appStateService.getRuntimeSettings();
    if (settings.signalAccountId) {
      return settings.signalAccountId;
    }

    const accounts = await this.listAccounts();
    return accounts[0] ?? null;
  }

  private async updateRegistrationState(message: Partial<Awaited<ReturnType<typeof appStateService.getRuntimeSettings>>>) {
    await appStateService.updateRuntimeSettings(message);
  }

  private async daemonHealthcheck(url = SIGNAL_DAEMON_URL): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SIGNAL_DAEMON_TIMEOUT_MS);
    try {
      const response = await fetch(`${url}/api/v1/check`, {
        signal: controller.signal
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async installCli(): Promise<{ cliPath: string; javaHome: string }> {
    await runCommand("brew", ["install", "openjdk", "signal-cli"]);
    const runtime = await this.ensureSignalRuntime();
    this.invalidateStateCache();
    await this.refreshState();
    return runtime;
  }

  async listAccounts(): Promise<string[]> {
    try {
      const output = await this.runSignal(["-o", "json", "listAccounts"], [0], {
        timeoutMs: SIGNAL_COMMAND_TIMEOUT_MS
      });
      const parsed = JSON.parse(output.stdout) as unknown;
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
    } catch {
      return [];
    }
  }

  private beginRefresh(): Promise<void> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.refreshStateInternal().finally(() => {
      this.lastRefreshedAt = Date.now();
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  async refreshState(): Promise<void> {
    if (this.refreshPromise) {
      await this.refreshPromise;
      return;
    }
    if (Date.now() - this.lastRefreshedAt < SIGNAL_STATE_TTL_MS) {
      return;
    }

    await this.beginRefresh();
  }

  refreshStateInBackground(): void {
    if (this.refreshPromise || Date.now() - this.lastRefreshedAt < SIGNAL_STATE_TTL_MS) {
      return;
    }

    void this.beginRefresh().catch((error) => {
      console.error("Signal background refresh failed", error);
    });
  }

  private async refreshStateInternal(): Promise<void> {
    const settings = await appStateService.getRuntimeSettings();
    const cliPath = await this.detectCliPath();
    const javaHome = await this.detectJavaHome();

    let lastError = settings.signalLastError;
    let registrationState = settings.signalRegistrationState;
    let daemonState = settings.signalDaemonState;
    let accountId = settings.signalAccountId;
    let phoneNumber = settings.signalPhoneNumber;
    let cliVersion = settings.signalCliVersion;
    let compatibilityWarning = settings.signalCompatibilityWarning;

    if (!cliPath || !javaHome) {
      await appStateService.updateRuntimeSettings({
        signalCliPath: cliPath,
        signalJavaHome: javaHome,
        signalCliVersion: null,
        signalCompatibilityWarning: null,
        signalDaemonState: "stopped"
      });
      return;
    }

    try {
      cliVersion = await this.detectCliVersion(cliPath, javaHome);
      compatibilityWarning = await this.detectCompatibilityWarning();
      lastError = null;
      if (settings.signalRegistrationMode === "none" && settings.signalRegistrationState === "error") {
        registrationState = "unconfigured";
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : "signal-cli could not be executed.";
      registrationState = settings.signalRegistrationState === "awaitingLink" ? "awaitingLink" : "error";
    }

    const accounts = await this.listAccounts();
    if (accounts.length > 0) {
      accountId = accounts[0] ?? null;
      if (!phoneNumber && accountId && looksLikeE164(accountId)) {
        phoneNumber = accountId;
      }
      registrationState = "registered";
      lastError = null;
    }

    if (this.linkProcess && this.linkProcess.exitCode === null) {
      registrationState = "awaitingLink";
    }

    const daemonUrl = settings.signalDaemonUrl ?? SIGNAL_DAEMON_URL;
    const daemonReachable = await this.daemonHealthcheck(daemonUrl);
    if (daemonReachable) {
      daemonState = "running";
    } else if (this.daemonProcess && this.daemonProcess.exitCode === null) {
      daemonState = "starting";
    } else if (settings.signalDaemonState === "error") {
      daemonState = "error";
    } else {
      daemonState = "stopped";
    }

    await appStateService.updateRuntimeSettings({
      signalCliPath: cliPath,
      signalJavaHome: javaHome,
      signalCliVersion: cliVersion,
      signalAccountId: accountId,
      signalPhoneNumber: phoneNumber,
      signalReceiveMode: "persistent",
      signalRegistrationState: registrationState,
      signalDaemonState: daemonState,
      signalDaemonUrl: daemonUrl,
      signalLastError: lastError,
      signalCompatibilityWarning: compatibilityWarning
    });
  }

  async startRegistration(params: {
    phoneNumber: string;
    useVoice?: boolean;
    captcha?: string;
    reregister?: boolean;
    autoInstall?: boolean;
  }): Promise<void> {
    this.invalidateStateCache();
    if (!looksLikeE164(params.phoneNumber)) {
      throw new Error("Signal registration requires an E.164 number like +15555550123.");
    }

    if (params.autoInstall) {
      await this.installCli();
    } else {
      await this.ensureSignalRuntime();
    }

    const args = ["-a", params.phoneNumber, "register"];
    if (params.useVoice) {
      args.push("--voice");
    }
    if (params.captcha?.trim()) {
      args.push("--captcha", params.captcha.trim());
    }
    if (params.reregister) {
      args.push("--reregister");
    }

    try {
      await this.runSignal(args);
      await this.updateRegistrationState({
        signalPhoneNumber: params.phoneNumber,
        signalAccountId: params.phoneNumber,
        signalRegistrationMode: "register",
        signalRegistrationState: "awaitingVerification",
        signalLinkUri: null,
        signalLastError: null
      });
    } catch (error) {
      await this.updateRegistrationState({
        signalPhoneNumber: params.phoneNumber,
        signalAccountId: params.phoneNumber,
        signalRegistrationMode: "register",
        signalRegistrationState: "error",
        signalLastError: error instanceof Error ? error.message : "Signal registration failed."
      });
      throw error;
    }
  }

  async verifyRegistration(params: { verificationCode: string; pin?: string }): Promise<void> {
    this.invalidateStateCache();
    const accountId = await this.resolveAccountId();
    if (!accountId) {
      throw new Error("No Signal account is pending verification.");
    }

    const args = ["-a", accountId, "verify"];
    if (params.pin?.trim()) {
      args.push("--pin", params.pin.trim());
    }
    args.push(params.verificationCode.trim());

    try {
      await this.runSignal(args);
      await this.updateRegistrationState({
        signalAccountId: accountId,
        signalPhoneNumber: looksLikeE164(accountId) ? accountId : null,
        signalRegistrationMode: "register",
        signalRegistrationState: "registered",
        signalLinkUri: null,
        signalLastError: null
      });
      await appStateService.markSetupStepCompleted("signal", {
        signalEnabled: true
      });
      await this.startDaemon();
    } catch (error) {
      await this.updateRegistrationState({
        signalRegistrationState: "error",
        signalLastError: error instanceof Error ? error.message : "Signal verification failed."
      });
      throw error;
    }
  }

  async startLink(deviceName: string): Promise<{ linkUri: string }> {
    this.invalidateStateCache();
    if (this.linkProcess && this.linkProcess.exitCode === null) {
      const current = await appStateService.getRuntimeSettings();
      if (current.signalLinkUri) {
        return { linkUri: current.signalLinkUri };
      }
      throw new Error("A Signal link flow is already in progress.");
    }

    const { cliPath } = await this.ensureSignalRuntime();
    const env = await this.signalEnv();

    await this.updateRegistrationState({
      signalRegistrationMode: "link",
      signalRegistrationState: "awaitingLink",
      signalDeviceName: deviceName,
      signalLinkUri: null,
      signalLastError: null
    });

    let discoveredUri: string | null = null;
    let outputBuffer = "";
    let resolveLink!: (value: string) => void;
    let rejectLink!: (reason?: unknown) => void;

    const waitForLinkUri = new Promise<string>((resolve, reject) => {
      resolveLink = resolve;
      rejectLink = reject;
      setTimeout(() => {
        if (!discoveredUri) {
          reject(new Error("Timed out while waiting for the Signal link URI."));
        }
      }, 15000);
    });

    const child = spawn(cliPath, ["-c", paths.signalCliConfigDir, "link", "--name", deviceName], {
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    this.linkProcess = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const onChunk = (chunk: string) => {
      outputBuffer += chunk;
      appendSignalLog(chunk);
      const match = outputBuffer.match(/sgnl:\/\/linkdevice[^\s]+/);
      if (match?.[0] && !discoveredUri) {
        discoveredUri = match[0];
        void this.updateRegistrationState({
          signalLinkUri: discoveredUri,
          signalLastError: null
        });
        resolveLink(discoveredUri);
      }
    };

    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    child.on("exit", (code) => {
      this.linkProcess = null;
      void (async () => {
        const accounts = await this.listAccounts();
        const accountId = accounts[0] ?? null;
        if (accountId) {
          await this.updateRegistrationState({
            signalAccountId: accountId,
            signalPhoneNumber: looksLikeE164(accountId) ? accountId : null,
            signalRegistrationMode: "link",
            signalRegistrationState: "registered",
            signalLinkUri: null,
            signalLastError: null
          });
          await appStateService.markSetupStepCompleted("signal", {
            signalEnabled: true
          });
          await this.startDaemon().catch(async (error) => {
            await this.updateRegistrationState({
              signalLastError: error instanceof Error ? error.message : "Signal daemon startup failed after linking."
            });
          });
          return;
        }

        const message =
          code === 130
            ? "Signal link was cancelled."
            : outputBuffer.trim() || "Signal link finished before an account was created.";
        await this.updateRegistrationState({
          signalRegistrationState: "error",
          signalLastError: message
        });
        if (!discoveredUri) {
          rejectLink(new Error(message));
        }
      })();
    });

    return {
      linkUri: await waitForLinkUri
    };
  }

  async cancelLink(): Promise<void> {
    this.invalidateStateCache();
    if (this.linkProcess && this.linkProcess.exitCode === null) {
      this.linkProcess.kill("SIGTERM");
      this.linkProcess = null;
    }
    await this.updateRegistrationState({
      signalRegistrationState: "unconfigured",
      signalRegistrationMode: "none",
      signalLinkUri: null,
      signalLastError: null
    });
  }

  async startDaemon(): Promise<void> {
    this.invalidateStateCache();
    const settings = await appStateService.getRuntimeSettings();
    const accountId = settings.signalAccountId ?? (await this.resolveAccountId());
    if (!accountId) {
      throw new Error("A registered Signal account is required before starting the daemon.");
    }

    if (await this.daemonHealthcheck(settings.signalDaemonUrl ?? SIGNAL_DAEMON_URL)) {
      await this.updateRegistrationState({
        signalDaemonState: "running",
        signalDaemonUrl: settings.signalDaemonUrl ?? SIGNAL_DAEMON_URL
      });
      return;
    }

    if (this.daemonProcess && this.daemonProcess.exitCode === null) {
      await this.waitForDaemon();
      return;
    }

    const { cliPath } = await this.ensureSignalRuntime();
    const env = await this.signalEnv();
    const child = spawn(
      cliPath,
      [
        "-c",
        paths.signalCliConfigDir,
        "-a",
        accountId,
        "daemon",
        "--http",
        `127.0.0.1:${SIGNAL_DAEMON_PORT}`,
        "--ignore-stories",
        "--ignore-avatars"
      ],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    this.daemonProcess = child;
    child.stdout.on("data", (chunk) => appendSignalLog(chunk));
    child.stderr.on("data", (chunk) => appendSignalLog(chunk));
    child.on("exit", (code) => {
      this.daemonProcess = null;
      void this.updateRegistrationState({
        signalDaemonPid: null,
        signalDaemonState: code === 0 ? "stopped" : "error",
        signalLastError: code === 0 ? null : `signal-cli daemon exited with status ${code ?? -1}.`
      });
    });

    await this.updateRegistrationState({
      signalAccountId: accountId,
      signalDaemonUrl: SIGNAL_DAEMON_URL,
      signalDaemonPid: child.pid ?? null,
      signalDaemonState: "starting",
      signalReceiveMode: "persistent",
      signalLastError: null
    });

    await this.waitForDaemon();
    await openclawService.configureSignal({
      cliPath: settings.signalCliPath ?? (await this.detectCliPath()) ?? cliPath,
      accountId,
      httpUrl: SIGNAL_DAEMON_URL
    });
    await appStateService.markSetupStepCompleted("signal", {
      signalEnabled: true
    });
  }

  private async waitForDaemon(): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await this.daemonHealthcheck()) {
        await this.updateRegistrationState({
          signalDaemonState: "running",
          signalDaemonUrl: SIGNAL_DAEMON_URL,
          signalReceiveMode: "persistent",
          signalLastStartedAt: nowIso(),
          signalLastError: null
        });
        return;
      }
      await sleep(500);
    }

    await this.updateRegistrationState({
      signalDaemonState: "error",
      signalLastError: "signal-cli daemon did not become healthy on time."
    });
    throw new Error("signal-cli daemon did not become healthy on time.");
  }

  async stopDaemon(): Promise<void> {
    this.invalidateStateCache();
    const settings = await appStateService.getRuntimeSettings();
    const pid = this.daemonProcess?.pid ?? settings.signalDaemonPid ?? null;

    if (this.daemonProcess && this.daemonProcess.exitCode === null) {
      this.daemonProcess.kill("SIGTERM");
      this.daemonProcess = null;
    } else if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // ignore stale pid data
      }
    }

    await this.updateRegistrationState({
      signalDaemonPid: null,
      signalDaemonState: "stopped"
    });
  }

  async disconnect(params: { unregister: boolean; deleteAccount?: boolean; clearLocalData?: boolean }): Promise<void> {
    this.invalidateStateCache();
    const accountId = await this.resolveAccountId();

    if (this.linkProcess && this.linkProcess.exitCode === null) {
      await this.cancelLink();
    }

    await this.stopDaemon();
    await openclawService.removeSignalChannel();

    if (accountId && params.unregister) {
      const unregisterArgs = ["-a", accountId, "unregister"];
      if (params.deleteAccount) {
        unregisterArgs.push("--delete-account");
      }
      await this.runSignal(unregisterArgs);
    }

    if (accountId && params.clearLocalData) {
      await this.runSignal(["-a", accountId, "deleteLocalAccountData", "--ignore-registered"], [0, 1]);
    }

    fs.rmSync(paths.signalCliConfigDir, { recursive: true, force: true });
    fs.mkdirSync(paths.signalCliConfigDir, { recursive: true });

    await this.updateRegistrationState({
      signalPhoneNumber: null,
      signalAccountId: null,
      signalDeviceName: null,
      signalReceiveMode: "persistent",
      signalRegistrationMode: "none",
      signalRegistrationState: "unconfigured",
      signalLinkUri: null,
      signalDaemonUrl: SIGNAL_DAEMON_URL,
      signalDaemonPid: null,
      signalDaemonState: "stopped",
      signalLastError: null,
      signalCompatibilityWarning: null
    });
    await appStateService.updateSetupState({
      signalEnabled: false
    });
  }

  async sendTestMessage(params: { target: string; text: string }): Promise<void> {
    this.invalidateStateCache();
    const accountId = await this.resolveAccountId();
    if (!accountId) {
      throw new Error("A registered Signal account is required before sending a test message.");
    }
    if (!params.target.trim()) {
      throw new Error("A Signal recipient is required.");
    }
    if (!params.text.trim()) {
      throw new Error("A Signal test message cannot be empty.");
    }

    await this.runSignal(["-a", accountId, "send", "-m", params.text.trim(), params.target.trim()]);
  }
}

export const signalService = new SignalService();
