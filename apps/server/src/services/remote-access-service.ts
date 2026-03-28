import fs from "node:fs";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import {
  CloudflareStatusSchema,
  TailscaleStatusSchema,
  nowIso,
  type CloudflareStatus,
  type TailscaleStatus
} from "@droidagent/shared";

import { SERVER_PORT, baseEnv, ensureAppDirs, paths } from "../env.js";
import { CommandError, runCommand } from "../lib/process.js";
import { TtlCache } from "../lib/ttl-cache.js";
import { appStateService } from "./app-state-service.js";
import { keychainService } from "./keychain-service.js";

const REMOTE_STATUS_TTL_MS = 5_000;
const TAILSCALE_STATUS_TIMEOUT_MS = 1_500;
const STATUS_VERSION_TIMEOUT_MS = 1_000;
const BINARY_METADATA_TTL_MS = 86_400_000;

function recursiveStrings(value: unknown, result: string[] = []): string[] {
  if (typeof value === "string") {
    result.push(value);
    return result;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      recursiveStrings(item, result);
    }
    return result;
  }

  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      recursiveStrings(item, result);
    }
  }

  return result;
}

function cleanDnsName(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  return value.replace(/\.$/, "");
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function extractServeTarget(raw: unknown): string | null {
  const strings = recursiveStrings(raw);
  return (
    strings.find((value) => value.includes(`127.0.0.1:${SERVER_PORT}`)) ??
    strings.find((value) => value.includes(`localhost:${SERVER_PORT}`)) ??
    null
  );
}

function extractServeUrl(raw: unknown): string | null {
  const strings = recursiveStrings(raw);
  return strings.find((value) => /^https:\/\/.+\.ts\.net\/?$/i.test(value.trim())) ?? null;
}

function extractTailscaleServeEnableUrl(output: string): string | null {
  const match = output.match(/https:\/\/login\.tailscale\.com\/f\/serve\?[^\s]+/i);
  return match?.[0] ?? null;
}

async function healthcheck(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(new URL("/api/health", url), {
      redirect: "follow",
      signal: controller.signal
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function appendCloudflareLog(chunk: Buffer | string): void {
  fs.appendFileSync(paths.cloudflareLogPath, chunk);
}

function appendTailscaleLog(chunk: Buffer | string): void {
  fs.appendFileSync(paths.tailscaleLogPath, chunk);
}

function normalizeCloudflareHostname(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("A public Cloudflare hostname is required.");
  }

  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Cloudflare hostname must be a valid hostname like agent.example.com.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Cloudflare hostname must use a standard hostname without a custom protocol.");
  }
  if (!url.hostname || url.username || url.password || url.port) {
    throw new Error("Cloudflare hostname must be a bare hostname without credentials or port.");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Cloudflare hostname must not include a path, query string, or fragment.");
  }

  return url.hostname.toLowerCase();
}

export interface RemoteAccessProvider<TStatus> {
  getStatus(): Promise<TStatus>;
}

type TailscaleRawStatus = {
  version: string | null;
  statusRaw: unknown;
  serveRaw: unknown;
  running: boolean;
  mode: "system" | "userspace";
  socketPath: string | null;
};

export class TailscaleRemoteAccessProvider implements RemoteAccessProvider<TailscaleStatus> {
  private process: ChildProcess | null = null;
  private activeSocketPath: string | null = null;
  private lastStatus: TailscaleStatus | null = null;
  private readonly statusCache = new TtlCache<TailscaleStatus>(REMOTE_STATUS_TTL_MS);
  private readonly binaryPathCache = new TtlCache<string | null>(BINARY_METADATA_TTL_MS);
  private readonly daemonBinaryPathCache = new TtlCache<string | null>(BINARY_METADATA_TTL_MS);
  private readonly versionCache = new TtlCache<string | null>(BINARY_METADATA_TTL_MS);

  invalidateStatus(): void {
    this.statusCache.invalidate();
  }

  private async binaryPath(): Promise<string | null> {
    return await this.binaryPathCache.get(async () => {
      try {
        const result = await runCommand("which", ["tailscale"]);
        return result.stdout.trim().split("\n")[0] || null;
      } catch {
        return null;
      }
    });
  }

  private async hasBinary(): Promise<boolean> {
    return Boolean(await this.binaryPath());
  }

  private async detectedVersion(): Promise<string | null> {
    return await this.versionCache.get(async () => {
      try {
        return (
          await runCommand("tailscale", ["version"], {
            okExitCodes: [0, 1],
            timeoutMs: STATUS_VERSION_TIMEOUT_MS
          })
        ).stdout.trim().split("\n")[0] || null;
      } catch {
        return null;
      }
    });
  }

  private async daemonBinaryPath(): Promise<string | null> {
    return await this.daemonBinaryPathCache.get(async () => {
      try {
        const result = await runCommand("which", ["tailscaled"]);
        return result.stdout.trim().split("\n")[0] || null;
      } catch {
        return null;
      }
    });
  }

  private isUserspaceFallbackError(error: unknown): boolean {
    if (!(error instanceof CommandError)) {
      return false;
    }

    const combined = `${error.message}\n${error.stdout}\n${error.stderr}`.toLowerCase();
    return (
      combined.includes("timed out") ||
      combined.includes("failed to connect to local tailscale service") ||
      combined.includes("requires root") ||
      combined.includes("no such file") ||
      combined.includes("connection refused")
    );
  }

  private async wakeSystemApp(): Promise<boolean> {
    try {
      await runCommand("open", ["-g", "-a", "Tailscale"], {
        timeoutMs: 2_000
      });
      return true;
    } catch {
      return false;
    }
  }

  private async waitForSystemDaemon(version: string | null): Promise<TailscaleRawStatus | null> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        return await this.readRawStatusWithSocket({
          version,
          socketPath: null,
          mode: "system"
        });
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    return null;
  }

  private async runTailscale(
    args: string[],
    socketPath?: string | null,
    options: {
      okExitCodes?: number[];
      timeoutMs?: number;
    } = {}
  ) {
    const socketArgs = socketPath ? ["--socket", socketPath] : [];
    const commandOptions: {
      okExitCodes?: number[];
      timeoutMs?: number;
    } = {};
    if (options.okExitCodes) {
      commandOptions.okExitCodes = options.okExitCodes;
    }
    if (typeof options.timeoutMs === "number") {
      commandOptions.timeoutMs = options.timeoutMs;
    }
    return await runCommand(
      "tailscale",
      [...socketArgs, ...args],
      commandOptions
    );
  }

  private async readRawStatusWithSocket(params: {
    version: string | null;
    socketPath: string | null;
    mode: "system" | "userspace";
  }): Promise<TailscaleRawStatus> {
    const statusOutput = await this.runTailscale(["status", "--json"], params.socketPath, {
      timeoutMs: TAILSCALE_STATUS_TIMEOUT_MS
    });
    const serveOutput = await this.runTailscale(["serve", "status", "--json"], params.socketPath, {
      okExitCodes: [0, 1],
      timeoutMs: TAILSCALE_STATUS_TIMEOUT_MS
    });
    return {
      version: params.version,
      statusRaw: safeJsonParse(statusOutput.stdout),
      serveRaw: safeJsonParse(serveOutput.stdout),
      running: true,
      mode: params.mode,
      socketPath: params.socketPath
    };
  }

  private async ensureUserspaceDaemon(): Promise<string | null> {
    ensureAppDirs();
    const daemonPath = await this.daemonBinaryPath();
    if (!daemonPath) {
      return null;
    }

    if (this.process && this.process.exitCode === null && fs.existsSync(paths.tailscaleSocketPath)) {
      return paths.tailscaleSocketPath;
    }

    try {
      await this.runTailscale(["status", "--json"], paths.tailscaleSocketPath);
      return paths.tailscaleSocketPath;
    } catch {
      // start a local userspace daemon below
    }

    fs.rmSync(paths.tailscaleSocketPath, { force: true });

    this.process = spawn(
      daemonPath,
      [
        "--tun=userspace-networking",
        "--socket",
        paths.tailscaleSocketPath,
        "--state",
        paths.tailscaleStatePath,
        "--statedir",
        paths.tailscaleDir
      ],
      {
        env: baseEnv(),
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    this.process.stdout?.on("data", appendTailscaleLog);
    this.process.stderr?.on("data", appendTailscaleLog);
    this.process.on("exit", () => {
      this.process = null;
      this.invalidateStatus();
    });

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const currentProcess = this.process;
      if (!currentProcess || currentProcess.exitCode !== null) {
        return null;
      }

      try {
        await this.runTailscale(["status", "--json"], paths.tailscaleSocketPath);
        return paths.tailscaleSocketPath;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    return null;
  }

  private async readRawStatus(
    options: { allowUserspaceStart?: boolean } = {},
  ): Promise<TailscaleRawStatus> {
    if (!(await this.hasBinary())) {
      return {
        version: null,
        statusRaw: null,
        serveRaw: null,
        running: false,
        mode: "system",
        socketPath: null
      };
    }

    let version: string | null = null;
    version = await this.detectedVersion();

    const preferredSocketPath =
      this.activeSocketPath && fs.existsSync(this.activeSocketPath)
        ? this.activeSocketPath
        : fs.existsSync(paths.tailscaleSocketPath)
          ? paths.tailscaleSocketPath
          : null;

    if (preferredSocketPath) {
      try {
        return await this.readRawStatusWithSocket({
          version,
          socketPath: preferredSocketPath,
          mode: "userspace"
        });
      } catch {
        if (preferredSocketPath === this.activeSocketPath) {
          this.activeSocketPath = null;
        }
      }
    }

    try {
      return await this.readRawStatusWithSocket({
        version,
        socketPath: null,
        mode: "system"
      });
    } catch (error) {
      if (!this.isUserspaceFallbackError(error)) {
        if (error instanceof CommandError) {
          return {
            version,
            statusRaw: safeJsonParse(error.stdout),
            serveRaw: null,
            running: false,
            mode: "system",
            socketPath: null
          };
        }
        throw error;
      }

      const systemStatus = (await this.wakeSystemApp()) ? await this.waitForSystemDaemon(version) : null;
      if (systemStatus) {
        return systemStatus;
      }

      if (!options.allowUserspaceStart) {
        return {
          version,
          statusRaw: null,
          serveRaw: null,
          running: false,
          mode: "system",
          socketPath: null
        };
      }

      const socketPath = await this.ensureUserspaceDaemon();
      if (!socketPath) {
        return {
          version,
          statusRaw: null,
          serveRaw: null,
          running: false,
          mode: "userspace",
          socketPath: null
        };
      }

      try {
        return await this.readRawStatusWithSocket({
          version,
          socketPath,
          mode: "userspace"
        });
      } catch (userspaceError) {
        if (userspaceError instanceof CommandError) {
          return {
            version,
            statusRaw: safeJsonParse(userspaceError.stdout),
            serveRaw: null,
            running: false,
            mode: "userspace",
            socketPath
          };
        }
        throw userspaceError;
      }
    }
  }

  async enableServe(): Promise<void> {
    const socketPath = this.activeSocketPath ?? (await this.ensureUserspaceDaemon());
    try {
      await this.runTailscale(["serve", "--bg", "--https=443", String(SERVER_PORT)], socketPath, {
        timeoutMs: 5_000
      });
    } catch (error) {
      if (error instanceof CommandError) {
        const combined = `${error.stdout}\n${error.stderr}`;
        if (combined.includes("Serve is not enabled on your tailnet.")) {
          const enableUrl = extractTailscaleServeEnableUrl(combined);
          throw new Error(
            enableUrl
              ? `Tailscale Serve is disabled for this tailnet. Enable it here first: ${enableUrl}`
              : "Tailscale Serve is disabled for this tailnet. Enable it in the Tailscale admin console first."
          );
        }

        if (error.message.includes("timed out")) {
          throw new Error("Timed out while enabling Tailscale Serve. Check tailnet policy and local Tailscale health, then try again.");
        }
      }
      throw error;
    }
    this.invalidateStatus();
  }

  async getStatus(): Promise<TailscaleStatus> {
    return await this.statusCache.get(async () => {
      try {
        const [installed, accessSettings] = await Promise.all([
          this.hasBinary(),
          appStateService.getAccessSettings(),
        ]);
        if (!installed) {
          const status = TailscaleStatusSchema.parse({
            installed: false,
            running: false,
            authenticated: false,
            health: "warn",
            healthMessage: "Tailscale is not installed on this host.",
            version: null,
            deviceName: null,
            tailnetName: null,
            dnsName: null,
            magicDnsEnabled: false,
            httpsEnabled: false,
            serveCommand: null,
            canonicalUrl: null,
            lastCheckedAt: nowIso()
          });
          this.lastStatus = status;
          return status;
        }

        const shouldAllowUserspaceStart =
          accessSettings.mode === "tailscale" ||
          Boolean(this.activeSocketPath) ||
          fs.existsSync(paths.tailscaleSocketPath);
        const { version, statusRaw, serveRaw, running, mode, socketPath } = await this.readRawStatus({
          allowUserspaceStart: shouldAllowUserspaceStart
        });
        this.activeSocketPath = mode === "userspace" ? socketPath : null;
        const status = (statusRaw ?? {}) as Record<string, unknown>;
        const self = (status.Self ?? {}) as Record<string, unknown>;
        const currentTailnet = (status.CurrentTailnet ?? {}) as Record<string, unknown>;
        const backendState = typeof status.BackendState === "string" ? status.BackendState : null;
        const dnsName = cleanDnsName(self.DNSName ?? status.DNSName);
        const deviceName = typeof self.HostName === "string" ? self.HostName : dnsName?.split(".")[0] ?? null;
        const tailnetName =
          typeof currentTailnet.Name === "string"
            ? currentTailnet.Name
            : dnsName && dnsName.split(".").length > 2
              ? dnsName.split(".").slice(1).join(".")
              : null;
        const magicDnsEnabled = Boolean(currentTailnet.MagicDNSEnabled) || Boolean(dnsName);
        const authenticated = running && backendState !== "NeedsLogin" && backendState !== "NoState" && backendState !== "Stopped";
        const serveTarget = extractServeTarget(serveRaw);
        const serveUrl = extractServeUrl(serveRaw) ?? (dnsName ? `https://${dnsName}` : null);
        const httpsEnabled = Boolean(serveTarget && serveUrl);

        const daemonLabel = mode === "userspace" ? "Tailscale userspace daemon" : "Tailscale";
        const healthMessage = !running
          ? mode === "userspace"
            ? "Tailscale userspace daemon is not responding yet."
            : "Tailscale is installed but not currently running."
          : !authenticated
            ? `${daemonLabel} is running but this device is not authenticated into a tailnet.`
            : !magicDnsEnabled
              ? `${daemonLabel} is connected, but MagicDNS is not available for a stable HTTPS host.`
              : httpsEnabled
                ? `${daemonLabel} Serve is exposing DroidAgent at ${serveUrl}.`
                : `${daemonLabel} is connected, but Serve is not yet exposing DroidAgent.`;

        const parsed = TailscaleStatusSchema.parse({
          installed: true,
          running,
          authenticated,
          health: httpsEnabled ? "ok" : authenticated ? "warn" : "warn",
          healthMessage,
          version,
          deviceName,
          tailnetName,
          dnsName,
          magicDnsEnabled,
          httpsEnabled,
          serveCommand: authenticated ? `tailscale serve --bg --https=443 ${SERVER_PORT}` : null,
          canonicalUrl: authenticated && magicDnsEnabled ? serveUrl : null,
          lastCheckedAt: nowIso()
        });
        this.lastStatus = parsed;
        return parsed;
      } catch {
        if (this.lastStatus) {
          return this.lastStatus;
        }
        throw new Error("Tailscale status could not be determined.");
      }
    });
  }
}

export class CloudflareRemoteAccessProvider implements RemoteAccessProvider<CloudflareStatus> {
  private process: ChildProcess | null = null;
  private lastStatus: CloudflareStatus | null = null;
  private readonly statusCache = new TtlCache<CloudflareStatus>(REMOTE_STATUS_TTL_MS);
  private readonly binaryPathCache = new TtlCache<string | null>(BINARY_METADATA_TTL_MS);
  private readonly versionCache = new TtlCache<string | null>(BINARY_METADATA_TTL_MS);

  invalidateStatus(): void {
    this.statusCache.invalidate();
  }

  private async binaryPath(): Promise<string | null> {
    return await this.binaryPathCache.get(async () => {
      try {
        const result = await runCommand("which", ["cloudflared"]);
        return result.stdout.trim().split("\n")[0] || null;
      } catch {
        return null;
      }
    });
  }

  private async detectedVersion(binaryPath: string | null): Promise<string | null> {
    if (!binaryPath) {
      return null;
    }

    return await this.versionCache.get(async () => {
      try {
        return (
          await runCommand(binaryPath, ["--version"], {
            timeoutMs: STATUS_VERSION_TIMEOUT_MS
          })
        ).stdout.trim().split("\n")[0] || null;
      } catch {
        return null;
      }
    });
  }

  async install(): Promise<void> {
    await runCommand("brew", ["install", "cloudflared"]);
    this.binaryPathCache.invalidate();
    this.versionCache.invalidate();
  }

  async enable(params: { hostname: string; tunnelToken: string }): Promise<void> {
    const hostname = normalizeCloudflareHostname(params.hostname);
    if (!(await this.binaryPath())) {
      await this.install();
    }

    const existingToken = await keychainService.getNamedSecret("cloudflareTunnelToken");
    const tunnelToken = params.tunnelToken.trim() || existingToken;
    if (!tunnelToken) {
      throw new Error("A Cloudflare named tunnel token is required the first time this tunnel is enabled.");
    }

    await this.stop();
    await keychainService.setNamedSecret("cloudflareTunnelToken", tunnelToken);
    await appStateService.updateAccessSettings({
      cloudflareHostname: hostname
    });
    this.invalidateStatus();
    await this.start();
  }

  async start(): Promise<void> {
    const binaryPath = await this.binaryPath();
    if (!binaryPath) {
      throw new Error("cloudflared is not installed on this host.");
    }

    const accessSettings = await appStateService.getAccessSettings();
    const hostname = accessSettings.cloudflareHostname;
    const tunnelToken = await keychainService.getNamedSecret("cloudflareTunnelToken");
    if (!hostname || !tunnelToken) {
      throw new Error("Cloudflare hostname and tunnel token must be configured first.");
    }

    if (this.process && this.process.exitCode === null) {
      return;
    }

    const child = spawn(binaryPath, ["tunnel", "--no-autoupdate", "run"], {
      env: {
        ...baseEnv(),
        TUNNEL_TOKEN: tunnelToken
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.on("data", (chunk) => appendCloudflareLog(chunk));
    child.stderr.on("data", (chunk) => appendCloudflareLog(chunk));
    child.on("exit", () => {
      this.process = null;
    });

    this.process = child;
    await appStateService.updateAccessSettings({
      cloudflareLastStartedAt: nowIso()
    });
    this.invalidateStatus();

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await healthcheck(`https://${hostname}`)) {
        return;
      }
      if (child.exitCode !== null) {
        throw new Error("cloudflared exited before the public hostname became reachable.");
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(`Cloudflare tunnel did not make https://${hostname} reachable in time.`);
  }

  async stop(): Promise<void> {
    if (this.process && this.process.exitCode === null) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
    this.invalidateStatus();
  }

  async getStatus(): Promise<CloudflareStatus> {
    return await this.statusCache.get(async () => {
      try {
        const [accessSettings, tokenStored] = await Promise.all([
          appStateService.getAccessSettings(),
          keychainService.hasNamedSecret("cloudflareTunnelToken")
        ]);
        const hostname = accessSettings.cloudflareHostname;
        const binaryPath = await this.binaryPath();
        const configuredOrActive =
          Boolean(hostname) ||
          tokenStored ||
          Boolean(this.process && this.process.exitCode === null) ||
          Boolean(this.lastStatus?.configured || this.lastStatus?.running);

        const version = configuredOrActive
          ? await this.detectedVersion(binaryPath)
          : this.lastStatus?.version ?? null;

        const canonicalUrl = hostname ? `https://${hostname}` : null;
        const reachable = canonicalUrl && configuredOrActive ? await healthcheck(canonicalUrl) : false;
        const running = reachable || Boolean(this.process && this.process.exitCode === null);

        const healthMessage = !binaryPath
          ? "cloudflared is not installed on this host."
          : !hostname || !tokenStored
            ? "Cloudflare tunnel is not configured yet."
            : reachable
              ? `Cloudflare Tunnel is exposing DroidAgent at ${canonicalUrl}.`
              : "Cloudflare tunnel is configured but the public hostname is not reachable yet.";

        const parsed = CloudflareStatusSchema.parse({
          installed: Boolean(binaryPath),
          configured: Boolean(hostname),
          running,
          tokenStored,
          health: reachable ? "ok" : hostname && tokenStored ? "warn" : "warn",
          healthMessage,
          version,
          hostname,
          canonicalUrl,
          lastStartedAt: accessSettings.cloudflareLastStartedAt,
          lastCheckedAt: nowIso()
        });
        this.lastStatus = parsed;
        return parsed;
      } catch {
        if (this.lastStatus) {
          return this.lastStatus;
        }
        throw new Error("Cloudflare status could not be determined.");
      }
    });
  }
}

export const tailscaleRemoteAccessProvider = new TailscaleRemoteAccessProvider();
export const cloudflareRemoteAccessProvider = new CloudflareRemoteAccessProvider();
