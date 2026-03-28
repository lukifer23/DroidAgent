import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { Context } from "hono";

import {
  BootstrapStateSchema,
  CanonicalOriginSchema,
  ServeStatusSchema,
  nowIso,
  type BootstrapState,
  type CanonicalOrigin,
  type ServeStatus
} from "@droidagent/shared";

import { SERVER_PORT } from "../env.js";
import { TtlCache } from "../lib/ttl-cache.js";
import { appStateService } from "./app-state-service.js";
import { authService } from "./auth-service.js";
import {
  cloudflareRemoteAccessProvider,
  tailscaleRemoteAccessProvider
} from "./remote-access-service.js";

const BOOTSTRAP_TOKEN_TTL_MS = 1000 * 60 * 15;
const ACCESS_SNAPSHOT_TTL_MS = 5_000;

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

export class AccessService {
  private readonly bootstrapStateCache = new TtlCache<BootstrapState>(ACCESS_SNAPSHOT_TTL_MS);
  private readonly accessSnapshotCache = new TtlCache<{
    canonicalUrl: string | null;
    canonicalOrigin: CanonicalOrigin | null;
    accessMode: "loopback" | "tailscale" | "cloudflare";
    tailscaleStatus: Awaited<ReturnType<AccessService["getTailscaleStatus"]>>;
    cloudflareStatus: Awaited<ReturnType<AccessService["getCloudflareStatus"]>>;
    serveStatus: ServeStatus;
    bootstrapRequired: boolean;
  }>(ACCESS_SNAPSHOT_TTL_MS);

  invalidateCache(): void {
    this.bootstrapStateCache.invalidate();
    this.accessSnapshotCache.invalidate();
    tailscaleRemoteAccessProvider.invalidateStatus();
    cloudflareRemoteAccessProvider.invalidateStatus();
  }

  private buildServeStatus(
    accessMode: "loopback" | "tailscale" | "cloudflare",
    tailscale: Awaited<ReturnType<AccessService["getTailscaleStatus"]>>,
    cloudflare: Awaited<ReturnType<AccessService["getCloudflareStatus"]>>
  ): ServeStatus {
    const activeSource = accessMode === "cloudflare" ? "cloudflare" : accessMode === "tailscale" ? "tailscale" : "none";

    if (activeSource === "cloudflare" && cloudflare.canonicalUrl && cloudflare.running) {
      return ServeStatusSchema.parse({
        enabled: true,
        health: cloudflare.health,
        healthMessage: `Cloudflare Tunnel is proxying to http://127.0.0.1:${SERVER_PORT}.`,
        source: "cloudflare",
        url: cloudflare.canonicalUrl,
        target: `http://127.0.0.1:${SERVER_PORT}`,
        lastCheckedAt: cloudflare.lastCheckedAt
      });
    }

    if (tailscale.httpsEnabled && tailscale.canonicalUrl) {
      return ServeStatusSchema.parse({
        enabled: true,
        health: tailscale.health,
        healthMessage: `Serve is proxying to http://127.0.0.1:${SERVER_PORT}.`,
        source: "tailscale",
        url: tailscale.canonicalUrl,
        target: `http://127.0.0.1:${SERVER_PORT}`,
        lastCheckedAt: tailscale.lastCheckedAt
      });
    }

    return ServeStatusSchema.parse({
      enabled: false,
      health: cloudflare.configured || tailscale.authenticated ? "warn" : "warn",
      healthMessage: "No remote provider is exposing DroidAgent yet.",
      source: "none",
      url: null,
      target: null,
      lastCheckedAt: nowIso()
    });
  }

  private async assertCanonicalOriginReadyForBootstrap(canonicalOrigin: CanonicalOrigin): Promise<void> {
    if (canonicalOrigin.source === "tailscaleServe") {
      const tailscale = await this.getTailscaleStatus();
      if (
        !tailscale.installed ||
        !tailscale.running ||
        !tailscale.authenticated ||
        !tailscale.magicDnsEnabled ||
        !tailscale.httpsEnabled ||
        !tailscale.canonicalUrl ||
        normalizeOrigin(tailscale.canonicalUrl) !== canonicalOrigin.origin
      ) {
        throw new Error(
          "The canonical Tailscale URL is not currently reachable. Re-enable Tailscale Serve or switch the canonical DroidAgent URL before generating a phone bootstrap link."
        );
      }
      return;
    }

    if (canonicalOrigin.source === "cloudflareTunnel") {
      const cloudflare = await this.getCloudflareStatus();
      if (
        !cloudflare.installed ||
        !cloudflare.configured ||
        !cloudflare.tokenStored ||
        !cloudflare.running ||
        !cloudflare.canonicalUrl ||
        normalizeOrigin(cloudflare.canonicalUrl) !== canonicalOrigin.origin
      ) {
        throw new Error(
          "The canonical Cloudflare URL is not currently reachable. Re-enable the named tunnel or switch the canonical DroidAgent URL before generating a phone bootstrap link."
        );
      }
    }
  }

  getRequestUrl(c: Context): URL {
    return new URL(c.req.url);
  }

  getRequestOrigin(c: Context): string {
    const originHeader = c.req.header("origin");
    if (originHeader) {
      try {
        return normalizeOrigin(originHeader);
      } catch {
        // fall through to request URL
      }
    }
    return this.getRequestUrl(c).origin;
  }

  isLocalhostRequest(c: Context): boolean {
    return isLoopbackHostname(this.getRequestUrl(c).hostname);
  }

  async getTailscaleStatus() {
    return await tailscaleRemoteAccessProvider.getStatus();
  }

  async getCloudflareStatus() {
    return await cloudflareRemoteAccessProvider.getStatus();
  }

  async getServeStatus(): Promise<ServeStatus> {
    const [tailscale, cloudflare, accessSettings] = await Promise.all([
      this.getTailscaleStatus(),
      this.getCloudflareStatus(),
      appStateService.getAccessSettings()
    ]);
    return this.buildServeStatus(accessSettings.mode, tailscale, cloudflare);
  }

  private canonicalFromUrl(
    url: string,
    source: CanonicalOrigin["source"],
    accessMode: CanonicalOrigin["accessMode"]
  ): CanonicalOrigin {
    const parsed = new URL(url);
    return CanonicalOriginSchema.parse({
      accessMode,
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

    const canonicalOrigin = this.canonicalFromUrl(tailscale.canonicalUrl, "tailscaleServe", "tailscale");
    await appStateService.updateAccessSettings({
      mode: "tailscale",
      canonicalOrigin,
      bootstrapTokenHash: null,
      bootstrapTokenIssuedAt: null,
      bootstrapTokenExpiresAt: null
    });
    this.invalidateCache();
    await appStateService.markSetupStepCompleted("remoteAccess", {
      remoteAccessEnabled: true
    });
    return canonicalOrigin;
  }

  async refreshCanonicalOriginFromCloudflare(): Promise<CanonicalOrigin> {
    const cloudflare = await this.getCloudflareStatus();
    if (!cloudflare.installed || !cloudflare.configured || !cloudflare.tokenStored) {
      throw new Error("Cloudflare must be installed and configured before it can become the canonical DroidAgent origin.");
    }
    if (!cloudflare.canonicalUrl || !cloudflare.running) {
      throw new Error("Cloudflare tunnel must be running and the public hostname must be reachable first.");
    }

    const canonicalOrigin = this.canonicalFromUrl(cloudflare.canonicalUrl, "cloudflareTunnel", "cloudflare");
    await appStateService.updateAccessSettings({
      mode: "cloudflare",
      canonicalOrigin,
      bootstrapTokenHash: null,
      bootstrapTokenIssuedAt: null,
      bootstrapTokenExpiresAt: null
    });
    this.invalidateCache();
    await appStateService.markSetupStepCompleted("remoteAccess", {
      remoteAccessEnabled: true
    });
    return canonicalOrigin;
  }

  async setCanonicalOrigin(url: string, source: CanonicalOrigin["source"] = "manual"): Promise<CanonicalOrigin> {
    const accessMode = source === "cloudflareTunnel" ? "cloudflare" : source === "tailscaleServe" ? "tailscale" : "loopback";
    const canonicalOrigin = this.canonicalFromUrl(url, source, accessMode);
    await appStateService.updateAccessSettings({
      mode: canonicalOrigin.accessMode,
      canonicalOrigin,
      bootstrapTokenHash: null,
      bootstrapTokenIssuedAt: null,
      bootstrapTokenExpiresAt: null
    });
    this.invalidateCache();
    return canonicalOrigin;
  }

  async enableTailscaleServe(): Promise<{
    canonicalOrigin: CanonicalOrigin;
    tailscale: Awaited<ReturnType<AccessService["getTailscaleStatus"]>>;
    serve: ServeStatus;
  }> {
    const tailscale = await this.getTailscaleStatus();
    if (!tailscale.installed) {
      throw new Error("Install Tailscale first, then sign this Mac into your tailnet.");
    }
    if (!tailscale.running || !tailscale.authenticated) {
      throw new Error("Tailscale must be running and authenticated before enabling DroidAgent phone access.");
    }

    await tailscaleRemoteAccessProvider.enableServe();
    const canonicalOrigin = await this.refreshCanonicalOriginFromTailscale();
    const refreshedTailscale = await this.getTailscaleStatus();
    const serve = await this.getServeStatus();
    return { canonicalOrigin, tailscale: refreshedTailscale, serve };
  }

  async enableCloudflareTunnel(params: { hostname: string; tunnelToken: string }) {
    await cloudflareRemoteAccessProvider.enable(params);
    this.invalidateCache();
    const cloudflare = await this.getCloudflareStatus();
    const serve = await this.getServeStatus();
    return { cloudflare, serve };
  }

  async stopCloudflareTunnel() {
    const [accessSettings, ownerExists] = await Promise.all([
      appStateService.getAccessSettings(),
      authService.hasUser()
    ]);
    if (accessSettings.canonicalOrigin?.source === "cloudflareTunnel") {
      if (ownerExists) {
        throw new Error(
          "Cloudflare is still the canonical DroidAgent URL. Switch canonical access to Tailscale before stopping this tunnel."
        );
      }

      await appStateService.updateAccessSettings({
        mode: "loopback",
        canonicalOrigin: null,
        bootstrapTokenHash: null,
        bootstrapTokenIssuedAt: null,
        bootstrapTokenExpiresAt: null
      });
      this.invalidateCache();
    }

    await cloudflareRemoteAccessProvider.stop();
    this.invalidateCache();
    const cloudflare = await this.getCloudflareStatus();
    const serve = await this.getServeStatus();
    return { cloudflare, serve };
  }

  async setCanonicalSource(source: "tailscale" | "cloudflare"): Promise<CanonicalOrigin> {
    if (source === "tailscale") {
      return await this.refreshCanonicalOriginFromTailscale();
    }
    return await this.refreshCanonicalOriginFromCloudflare();
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
    await this.assertCanonicalOriginReadyForBootstrap(canonicalOrigin);
    const token = randomBytes(24).toString("base64url");
    const issuedAt = nowIso();
    const expiresAt = new Date(Date.now() + BOOTSTRAP_TOKEN_TTL_MS).toISOString();
    await appStateService.updateAccessSettings({
      bootstrapTokenHash: hashTokenHex(token),
      bootstrapTokenIssuedAt: issuedAt,
      bootstrapTokenExpiresAt: expiresAt
    });
    this.invalidateCache();
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
    this.invalidateCache();
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
    return await this.bootstrapStateCache.get(async () => {
      const [ownerExists, accessSettings, tailscaleStatus, cloudflareStatus] = await Promise.all([
        authService.hasUser(),
        appStateService.getAccessSettings(),
        this.getTailscaleStatus(),
        this.getCloudflareStatus()
      ]);
      const serveStatus = this.buildServeStatus(accessSettings.mode, tailscaleStatus, cloudflareStatus);

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
        cloudflareStatus,
        serveStatus,
        bootstrapTokenIssuedAt: accessSettings.bootstrapTokenIssuedAt,
        bootstrapTokenExpiresAt: accessSettings.bootstrapTokenExpiresAt,
        bootstrapUrl: null,
        localhostOnlyMessage:
          ownerExists && accessSettings.canonicalOrigin
            ? `Daily sign-in is locked to ${accessSettings.canonicalOrigin.origin}. Use localhost only for maintenance and bootstrap tasks.`
            : "Use localhost on the Mac to enable a supported remote provider and generate the one-time phone enrollment link."
      });
    });
  }

  async getAccessSnapshot() {
    return await this.accessSnapshotCache.get(async () => {
      const [accessSettings, tailscaleStatus, cloudflareStatus, ownerExists] = await Promise.all([
        appStateService.getAccessSettings(),
        this.getTailscaleStatus(),
        this.getCloudflareStatus(),
        authService.hasUser()
      ]);
      const serveStatus = this.buildServeStatus(accessSettings.mode, tailscaleStatus, cloudflareStatus);

      return {
        canonicalUrl: accessSettings.canonicalOrigin?.origin ?? null,
        canonicalOrigin: accessSettings.canonicalOrigin,
        accessMode: accessSettings.mode,
        tailscaleStatus,
        cloudflareStatus,
        serveStatus,
        bootstrapRequired: !ownerExists
      };
    });
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
