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

import { SERVER_PORT, baseEnv, paths } from "../env.js";
import { CommandError, runCommand } from "../lib/process.js";
import { TtlCache } from "../lib/ttl-cache.js";
import { appStateService } from "./app-state-service.js";
import { keychainService } from "./keychain-service.js";

const REMOTE_STATUS_TTL_MS = 5000;

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

export class TailscaleRemoteAccessProvider implements RemoteAccessProvider<TailscaleStatus> {
  private readonly statusCache = new TtlCache<TailscaleStatus>(REMOTE_STATUS_TTL_MS);

  invalidateStatus(): void {
    this.statusCache.invalidate();
  }

  private async hasBinary(): Promise<boolean> {
    try {
      await runCommand("which", ["tailscale"]);
      return true;
    } catch {
      return false;
    }
  }

  private async readRawStatus(): Promise<{
    version: string | null;
    statusRaw: unknown;
    serveRaw: unknown;
    running: boolean;
  }> {
    if (!(await this.hasBinary())) {
      return {
        version: null,
        statusRaw: null,
        serveRaw: null,
        running: false
      };
    }

    let version: string | null = null;
    try {
      version = (await runCommand("tailscale", ["version"], { okExitCodes: [0, 1] })).stdout.trim().split("\n")[0] || null;
    } catch {
      version = null;
    }

    try {
      const statusOutput = await runCommand("tailscale", ["status", "--json"]);
      const serveOutput = await runCommand("tailscale", ["serve", "status", "--json"], { okExitCodes: [0, 1] });
      return {
        version,
        statusRaw: safeJsonParse(statusOutput.stdout),
        serveRaw: safeJsonParse(serveOutput.stdout),
        running: true
      };
    } catch (error) {
      if (error instanceof CommandError) {
        return {
          version,
          statusRaw: safeJsonParse(error.stdout),
          serveRaw: null,
          running: false
        };
      }
      throw error;
    }
  }

  async enableServe(): Promise<void> {
    await runCommand("tailscale", ["serve", "--bg", "--https=443", String(SERVER_PORT)]);
    this.invalidateStatus();
  }

  async getStatus(): Promise<TailscaleStatus> {
    return await this.statusCache.get(async () => {
      if (!(await this.hasBinary())) {
        return TailscaleStatusSchema.parse({
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
      }

      const { version, statusRaw, serveRaw, running } = await this.readRawStatus();
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

      const healthMessage = !running
        ? "Tailscale is installed but not currently running."
        : !authenticated
          ? "Tailscale is running but this device is not authenticated into a tailnet."
          : !magicDnsEnabled
            ? "Tailscale is connected, but MagicDNS is not available for a stable HTTPS host."
            : httpsEnabled
              ? `Tailscale Serve is exposing DroidAgent at ${serveUrl}.`
              : "Tailscale is connected, but Serve is not yet exposing DroidAgent.";

      return TailscaleStatusSchema.parse({
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
    });
  }
}

export class CloudflareRemoteAccessProvider implements RemoteAccessProvider<CloudflareStatus> {
  private process: ChildProcess | null = null;
  private readonly statusCache = new TtlCache<CloudflareStatus>(REMOTE_STATUS_TTL_MS);

  invalidateStatus(): void {
    this.statusCache.invalidate();
  }

  private async binaryPath(): Promise<string | null> {
    try {
      const result = await runCommand("which", ["cloudflared"]);
      return result.stdout.trim().split("\n")[0] || null;
    } catch {
      return null;
    }
  }

  async install(): Promise<void> {
    await runCommand("brew", ["install", "cloudflared"]);
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
      const [binaryPath, accessSettings, tokenStored] = await Promise.all([
        this.binaryPath(),
        appStateService.getAccessSettings(),
        keychainService.hasNamedSecret("cloudflareTunnelToken")
      ]);
      const hostname = accessSettings.cloudflareHostname;

      let version: string | null = null;
      if (binaryPath) {
        try {
          version = (await runCommand(binaryPath, ["--version"])).stdout.trim().split("\n")[0] || null;
        } catch {
          version = null;
        }
      }

      const canonicalUrl = hostname ? `https://${hostname}` : null;
      const reachable = canonicalUrl ? await healthcheck(canonicalUrl) : false;
      const running = reachable || Boolean(this.process && this.process.exitCode === null);

      const healthMessage = !binaryPath
        ? "cloudflared is not installed on this host."
        : !hostname || !tokenStored
          ? "Cloudflare tunnel is not configured yet."
          : reachable
            ? `Cloudflare Tunnel is exposing DroidAgent at ${canonicalUrl}.`
            : "Cloudflare tunnel is configured but the public hostname is not reachable yet.";

      return CloudflareStatusSchema.parse({
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
    });
  }
}

export const tailscaleRemoteAccessProvider = new TailscaleRemoteAccessProvider();
export const cloudflareRemoteAccessProvider = new CloudflareRemoteAccessProvider();
