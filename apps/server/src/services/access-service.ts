import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { Context } from "hono";

import {
  BootstrapStateSchema,
  CanonicalOriginSchema,
  ServeStatusSchema,
  TailscaleStatusSchema,
  nowIso,
  type BootstrapState,
  type CanonicalOrigin,
  type ServeStatus,
  type TailscaleStatus
} from "@droidagent/shared";

import { SERVER_PORT } from "../env.js";
import { CommandError, runCommand } from "../lib/process.js";
import { appStateService } from "./app-state-service.js";
import { authService } from "./auth-service.js";

const BOOTSTRAP_TOKEN_TTL_MS = 1000 * 60 * 15;

function normalizeOrigin(value: string): string {
  return new URL(value).origin;
}

function hashTokenHex(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

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

export class AccessService {
  private async hasTailscaleBinary(): Promise<boolean> {
    try {
      await runCommand("which", ["tailscale"]);
      return true;
    } catch {
      return false;
    }
  }

  getRequestUrl(c: Context): URL {
    return new URL(c.req.url);
  }

  getRequestOrigin(c: Context): string {
    return this.getRequestUrl(c).origin;
  }

  isLocalhostRequest(c: Context): boolean {
    return isLoopbackHostname(this.getRequestUrl(c).hostname);
  }

  private async readTailscaleRawStatus(): Promise<{
    version: string | null;
    statusRaw: unknown;
    serveRaw: unknown;
    running: boolean;
  }> {
    if (!(await this.hasTailscaleBinary())) {
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

  async getTailscaleStatus(): Promise<TailscaleStatus> {
    if (!(await this.hasTailscaleBinary())) {
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

    const { version, statusRaw, serveRaw, running } = await this.readTailscaleRawStatus();
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
  }

  async getServeStatus(): Promise<ServeStatus> {
    const tailscale = await this.getTailscaleStatus();
    return ServeStatusSchema.parse({
      enabled: tailscale.httpsEnabled,
      health: tailscale.httpsEnabled ? "ok" : tailscale.authenticated ? "warn" : "warn",
      healthMessage: tailscale.httpsEnabled
        ? `Serve is proxying to http://127.0.0.1:${SERVER_PORT}.`
        : "Serve is not exposing DroidAgent yet.",
      source: tailscale.httpsEnabled ? "tailscale" : "none",
      url: tailscale.canonicalUrl,
      target: tailscale.httpsEnabled ? `http://127.0.0.1:${SERVER_PORT}` : null,
      lastCheckedAt: tailscale.lastCheckedAt
    });
  }

  private canonicalFromUrl(url: string, source: CanonicalOrigin["source"]): CanonicalOrigin {
    const parsed = new URL(url);
    return CanonicalOriginSchema.parse({
      accessMode: "tailscale",
      origin: parsed.origin,
      rpId: parsed.hostname,
      hostname: parsed.hostname,
      source,
      updatedAt: nowIso()
    });
  }

  async refreshCanonicalOriginFromTailscale(): Promise<CanonicalOrigin> {
    const tailscale = await this.getTailscaleStatus();
    if (!tailscale.installed || !tailscale.running || !tailscale.authenticated) {
      throw new Error("Tailscale must be installed, running, and authenticated before enabling DroidAgent phone access.");
    }
    if (!tailscale.magicDnsEnabled || !tailscale.canonicalUrl) {
      throw new Error("MagicDNS and a stable ts.net hostname are required before passkey enrollment can move to the phone.");
    }

    const canonicalOrigin = this.canonicalFromUrl(tailscale.canonicalUrl, "tailscaleServe");
    await appStateService.updateAccessSettings({
      mode: "tailscale",
      canonicalOrigin
    });
    await appStateService.markSetupStepCompleted("remoteAccess", {
      remoteAccessEnabled: true
    });
    return canonicalOrigin;
  }

  async setCanonicalOrigin(url: string, source: CanonicalOrigin["source"] = "manual"): Promise<CanonicalOrigin> {
    const canonicalOrigin = this.canonicalFromUrl(url, source);
    await appStateService.updateAccessSettings({
      mode: canonicalOrigin.accessMode,
      canonicalOrigin
    });
    return canonicalOrigin;
  }

  async enableTailscaleServe(): Promise<{ canonicalOrigin: CanonicalOrigin; tailscale: TailscaleStatus; serve: ServeStatus }> {
    const tailscale = await this.getTailscaleStatus();
    if (!tailscale.installed) {
      throw new Error("Install Tailscale first, then sign this Mac into your tailnet.");
    }
    if (!tailscale.running || !tailscale.authenticated) {
      throw new Error("Tailscale must be running and authenticated before enabling DroidAgent phone access.");
    }

    await runCommand("tailscale", ["serve", "--bg", "--https=443", String(SERVER_PORT)]);
    const canonicalOrigin = await this.refreshCanonicalOriginFromTailscale();
    const refreshedTailscale = await this.getTailscaleStatus();
    const serve = await this.getServeStatus();
    return { canonicalOrigin, tailscale: refreshedTailscale, serve };
  }

  async getCanonicalOrigin(): Promise<CanonicalOrigin | null> {
    return (await appStateService.getAccessSettings()).canonicalOrigin;
  }

  async ensureCanonicalOrigin(): Promise<CanonicalOrigin> {
    const configured = await this.getCanonicalOrigin();
    if (!configured) {
      throw new Error("No canonical DroidAgent origin is configured yet. Complete the localhost bootstrap flow first.");
    }
    return configured;
  }

  async createBootstrapToken(): Promise<{
    token: string;
    issuedAt: string;
    expiresAt: string;
    canonicalOrigin: CanonicalOrigin;
    bootstrapUrl: string;
  }> {
    const canonicalOrigin = await this.ensureCanonicalOrigin();
    const token = randomBytes(24).toString("base64url");
    const issuedAt = nowIso();
    const expiresAt = new Date(Date.now() + BOOTSTRAP_TOKEN_TTL_MS).toISOString();
    await appStateService.updateAccessSettings({
      bootstrapTokenHash: hashTokenHex(token),
      bootstrapTokenIssuedAt: issuedAt,
      bootstrapTokenExpiresAt: expiresAt
    });
    return {
      token,
      issuedAt,
      expiresAt,
      canonicalOrigin,
      bootstrapUrl: `${canonicalOrigin.origin}/?bootstrap=${encodeURIComponent(token)}`
    };
  }

  async clearBootstrapToken(): Promise<void> {
    await appStateService.updateAccessSettings({
      bootstrapTokenHash: null,
      bootstrapTokenIssuedAt: null,
      bootstrapTokenExpiresAt: null
    });
  }

  async validateBootstrapToken(token: string): Promise<boolean> {
    if (!token.trim()) {
      return false;
    }
    const settings = await appStateService.getAccessSettings();
    if (!settings.bootstrapTokenHash || !settings.bootstrapTokenExpiresAt) {
      return false;
    }
    if (new Date(settings.bootstrapTokenExpiresAt).getTime() <= Date.now()) {
      await this.clearBootstrapToken();
      return false;
    }
    return hashEquals(settings.bootstrapTokenHash, hashTokenHex(token));
  }

  async consumeBootstrapToken(token: string): Promise<void> {
    const isValid = await this.validateBootstrapToken(token);
    if (!isValid) {
      throw new Error("The bootstrap token is missing, invalid, or expired.");
    }
    await this.clearBootstrapToken();
  }

  async getBootstrapState(): Promise<BootstrapState> {
    const [ownerExists, accessSettings, tailscaleStatus, serveStatus] = await Promise.all([
      authService.hasUser(),
      appStateService.getAccessSettings(),
      this.getTailscaleStatus(),
      this.getServeStatus()
    ]);

    const enrollmentState = ownerExists
      ? "complete"
      : accessSettings.bootstrapTokenHash && accessSettings.canonicalOrigin
        ? "ready"
        : accessSettings.canonicalOrigin
          ? "bootstrapPending"
          : "notStarted";

    return BootstrapStateSchema.parse({
      ownerExists,
      bootstrapRequired: !ownerExists,
      enrollmentState,
      accessMode: accessSettings.mode,
      canonicalOrigin: accessSettings.canonicalOrigin,
      tailscaleStatus,
      serveStatus,
      bootstrapTokenIssuedAt: accessSettings.bootstrapTokenIssuedAt,
      bootstrapTokenExpiresAt: accessSettings.bootstrapTokenExpiresAt,
      bootstrapUrl: null,
      localhostOnlyMessage:
        ownerExists && accessSettings.canonicalOrigin
          ? `Daily sign-in is locked to ${accessSettings.canonicalOrigin.origin}. Use localhost only for maintenance and bootstrap tasks.`
          : "Use localhost on the Mac to enable Tailscale and generate the one-time phone enrollment link."
    });
  }

  async getAccessSnapshot() {
    const [accessSettings, tailscaleStatus, serveStatus, ownerExists] = await Promise.all([
      appStateService.getAccessSettings(),
      this.getTailscaleStatus(),
      this.getServeStatus(),
      authService.hasUser()
    ]);

    return {
      canonicalUrl: accessSettings.canonicalOrigin?.origin ?? null,
      canonicalOrigin: accessSettings.canonicalOrigin,
      accessMode: accessSettings.mode,
      tailscaleStatus,
      serveStatus,
      bootstrapRequired: !ownerExists
    };
  }

  async assertLocalhostBootstrapRequest(c: Context): Promise<void> {
    if (!this.isLocalhostRequest(c)) {
      throw new Error("This bootstrap action must be started from localhost on the Mac that hosts DroidAgent.");
    }
    if (await authService.hasUser()) {
      throw new Error("Bootstrap registration is already complete. Use the canonical DroidAgent URL for daily sign-in.");
    }
  }

  async assertBootstrapRegistrationRequest(c: Context, token: string): Promise<CanonicalOrigin> {
    if (!(await this.validateBootstrapToken(token))) {
      throw new Error("The bootstrap token is missing, invalid, or expired.");
    }
    const canonicalOrigin = await this.ensureCanonicalOrigin();
    if (normalizeOrigin(this.getRequestOrigin(c)) !== canonicalOrigin.origin) {
      throw new Error(`Complete owner passkey enrollment from ${canonicalOrigin.origin}.`);
    }
    return canonicalOrigin;
  }

  async assertCanonicalAuthenticatedRequest(c: Context): Promise<CanonicalOrigin | null> {
    const ownerExists = await authService.hasUser();
    const canonicalOrigin = await this.getCanonicalOrigin();
    if (!ownerExists || !canonicalOrigin) {
      return canonicalOrigin;
    }
    if (normalizeOrigin(this.getRequestOrigin(c)) !== canonicalOrigin.origin) {
      throw new Error(`Use the canonical DroidAgent URL instead: ${canonicalOrigin.origin}`);
    }
    return canonicalOrigin;
  }

  async assertCanonicalMutation(c: Context, allowLocalhostMaintenance = false): Promise<void> {
    const origin = c.req.header("origin");
    if (!origin) {
      return;
    }

    const ownerExists = await authService.hasUser();
    const canonicalOrigin = await this.getCanonicalOrigin();
    if (ownerExists && canonicalOrigin) {
      const expectedOrigin = allowLocalhostMaintenance && this.isLocalhostRequest(c) ? this.getRequestOrigin(c) : canonicalOrigin.origin;
      if (normalizeOrigin(origin) !== expectedOrigin) {
        throw new Error(`Origin mismatch. Use ${expectedOrigin} for this action.`);
      }
      return;
    }

    const requestOrigin = this.getRequestOrigin(c);
    if (normalizeOrigin(origin) !== requestOrigin) {
      throw new Error("Origin mismatch.");
    }
  }
}

export const accessService = new AccessService();
