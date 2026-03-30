import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";

import {
  ChannelConfigSummarySchema,
  ChannelStatusSchema,
  SignalHealthCheckSchema,
  SignalPendingPairingSchema,
  type MemoryStatus,
  type ChannelConfigSummary,
  type ChannelStatus,
} from "@droidagent/shared";

import {
  OPENCLAW_GATEWAY_URL,
  OPENCLAW_PROFILE,
  baseEnv,
  paths,
  resolveOpenClawBin,
} from "../env.js";
import { CommandError, runCommand } from "../lib/process.js";
import { ollamaModelSupportsVision } from "../lib/ollama.js";
import { TtlCache } from "../lib/ttl-cache.js";
import {
  DEFAULT_OLLAMA_VISION_MODEL,
  appStateService,
} from "./app-state-service.js";
import { keychainService } from "./keychain-service.js";
import {
  configValueEquals,
  getConfigPathValue,
  setConfigPathValue,
  stringifyConfigValue,
} from "./openclaw-config.js";
import {
  openClawChatMethods,
  type OpenClawChatMethods,
} from "./openclaw-service-chat.js";
import {
  openClawGatewayMethods,
  type OpenClawGatewayMethods,
} from "./openclaw-service-gateway.js";
import {
  openClawMemoryMethods,
  type OpenClawMemoryMethods,
} from "./openclaw-service-memory.js";
import {
  CHANNEL_STATUS_TTL_MS,
  MEMORY_STATUS_TTL_MS,
  OPERATOR_EXEC_ALLOWLIST_PATTERNS,
  buildContextManagementConfig,
  buildContextPruningConfig,
  buildMemorySearchConfigFromSettings,
  type OpenClawMemoryStatusEntry,
} from "./openclaw-service-support.js";
import { WORKSPACE_BOOTSTRAP_FILES } from "./openclaw-workspace.js";
import type { HarnessRuntimeModelConfig } from "./harness-service.js";

export class OpenClawService {
  gatewayProcess: ChildProcess | null = null;
  private gatewayLogStream: fs.WriteStream | null = null;
  private gatewayLogQueue: Promise<void> = Promise.resolve();
  private gatewayToken: string | null = null;
  ensureConfiguredPromise: Promise<void> | null = null;
  private ensureExecAllowlistPromise: Promise<void> | null = null;
  private cachedConfig: Record<string, unknown> | null = null;
  cachedConfigMtimeMs = -1;
  lastConfiguredHash: string | null = null;
  lastConfiguredConfigMtimeMs = -1;
  private cachedEnvContent: string | null = null;
  lastKnownMemoryStatus: Awaited<
    ReturnType<OpenClawMemoryMethods["currentMemoryStatus"]>
  > | null = null;
  activeRuns = new Map<
    string,
    { controller: AbortController; runId: string }
  >();
  private readonly channelStatusesCache = new TtlCache<{
    statuses: ChannelStatus[];
    config: ChannelConfigSummary;
  }>(CHANNEL_STATUS_TTL_MS);
  readonly memoryStatusCache = new TtlCache<MemoryStatus>(MEMORY_STATUS_TTL_MS);

  invalidateChannelStatusCache(): void {
    this.channelStatusesCache.invalidate();
  }

  invalidateMemoryStatusCache(): void {
    this.memoryStatusCache.invalidate();
  }

  private ensureGatewayLogStream(): fs.WriteStream {
    if (this.gatewayLogStream) {
      return this.gatewayLogStream;
    }
    this.gatewayLogStream = fs.createWriteStream(`${paths.logsDir}/openclaw.log`, {
      flags: "a",
      encoding: "utf8",
    });
    this.gatewayLogStream.on("error", () => {
      // Ignore log stream errors; they should not crash the gateway.
    });
    return this.gatewayLogStream;
  }

  queueGatewayLogWrite(chunk: string | Buffer): void {
    const payload = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    this.gatewayLogQueue = this.gatewayLogQueue
      .then(
        () =>
          new Promise<void>((resolve) => {
            const stream = this.ensureGatewayLogStream();
            stream.write(payload, () => resolve());
          }),
      )
      .catch(() => {});
  }

  closeGatewayLogStream(): void {
    const stream = this.gatewayLogStream;
    this.gatewayLogStream = null;
    if (!stream) {
      return;
    }
    this.gatewayLogQueue = this.gatewayLogQueue
      .then(
        () =>
          new Promise<void>((resolve) => {
            stream.end(() => resolve());
          }),
      )
      .catch(() => {});
  }

  get openclawBin(): string {
    const bin = resolveOpenClawBin();
    if (!bin) {
      throw new Error("OpenClaw binary was not found in this workspace.");
    }
    return bin;
  }

  profileArgs(extra: string[] = []): string[] {
    return ["--profile", OPENCLAW_PROFILE, ...extra];
  }

  async ensureGatewayToken(): Promise<string> {
    if (this.gatewayToken) {
      return this.gatewayToken;
    }

    const existing = await appStateService.getJsonSetting<string | null>(
      "openclawGatewayToken",
      null,
    );
    if (existing) {
      this.gatewayToken = existing;
      return existing;
    }

    const next = randomUUID();
    this.gatewayToken = next;
    await appStateService.setJsonSetting("openclawGatewayToken", next);
    return next;
  }

  async execOpenClaw(
    args: string[],
    allowFailure = false,
    timeoutMs?: number,
  ): Promise<string> {
    try {
      const result = await runCommand(this.openclawBin, this.profileArgs(args), {
        env: await this.openclawEnv(),
        ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
      });
      return result.stdout;
    } catch (error) {
      if (allowFailure && error instanceof CommandError) {
        return error.stdout || error.stderr;
      }
      throw error;
    }
  }

  async ensureOperatorExecAllowlist(): Promise<void> {
    if (this.ensureExecAllowlistPromise) {
      await this.ensureExecAllowlistPromise;
      return;
    }

    this.ensureExecAllowlistPromise = this.seedOperatorExecAllowlist().finally(
      () => {
        this.ensureExecAllowlistPromise = null;
      },
    );
    await this.ensureExecAllowlistPromise;
  }

  private async seedOperatorExecAllowlist(): Promise<void> {
    const seededVersion = await appStateService.getJsonSetting<string | null>(
      "openclawExecAllowlistSeedVersion",
      null,
    );
    if (seededVersion === "v2") {
      return;
    }

    const token = await this.ensureGatewayToken();
    await Promise.all(
      OPERATOR_EXEC_ALLOWLIST_PATTERNS.map(async (pattern) => {
        await this.execOpenClaw([
          "approvals",
          "allowlist",
          "add",
          pattern,
          "--agent",
          "main",
          "--gateway",
          "--url",
          OPENCLAW_GATEWAY_URL,
          "--token",
          token,
        ]);
      }),
    );

    await appStateService.setJsonSetting(
      "openclawExecAllowlistSeedVersion",
      "v2",
    );
  }

  async openclawEnv(): Promise<NodeJS.ProcessEnv> {
    return {
      ...baseEnv(),
      ...(await keychainService.getProcessEnv()),
      OPENCLAW_GATEWAY_TOKEN: await this.ensureGatewayToken(),
      OLLAMA_API_KEY: "ollama-local",
    };
  }

  async gatewayHeaders(sessionKey: string): Promise<HeadersInit> {
    return {
      accept: "text/event-stream",
      authorization: `Bearer ${await this.ensureGatewayToken()}`,
      "content-type": "application/json",
      "x-openclaw-agent-id": "main",
      "x-openclaw-session-key": sessionKey,
    };
  }

  resolveWorkspaceRoot(
    runtimeSettings: Awaited<ReturnType<typeof appStateService.getRuntimeSettings>>,
  ): string {
    return path.resolve(runtimeSettings.workspaceRoot ?? paths.workspaceRoot);
  }

  async ensureWorkspaceScaffold(workspaceRoot: string): Promise<void> {
    const memoryDir = path.join(workspaceRoot, "memory");
    const skillsDir = path.join(workspaceRoot, "skills");

    await fs.promises.mkdir(memoryDir, { recursive: true });
    await fs.promises.mkdir(skillsDir, { recursive: true });

    for (const [relativePath, contents] of WORKSPACE_BOOTSTRAP_FILES) {
      const targetPath = path.join(workspaceRoot, relativePath);
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
      try {
        await fs.promises.access(targetPath, fs.constants.F_OK);
      } catch {
        await fs.promises.writeFile(targetPath, contents, "utf8");
      }
    }
  }

  async resolveOllamaMultimodalConfig(
    runtimeSettings: Awaited<ReturnType<typeof appStateService.getRuntimeSettings>>,
  ): Promise<{
    attachmentModelId: string;
    providerConfig: Record<string, unknown>;
  }> {
    const modelId = runtimeSettings.ollamaModel;
    const contextWindow = runtimeSettings.ollamaContextWindow;
    const primarySupportsVision = await ollamaModelSupportsVision(modelId);
    const attachmentModelId = primarySupportsVision
      ? modelId
      : DEFAULT_OLLAMA_VISION_MODEL;
    const providerModels = [
      {
        id: modelId,
        name: modelId,
        reasoning: /r1|reasoning|think/i.test(modelId),
        input: primarySupportsVision ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: contextWindow,
      },
    ];

    if (attachmentModelId !== modelId) {
      providerModels.push({
        id: attachmentModelId,
        name: attachmentModelId,
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 65536,
        maxTokens: 65536,
      });
    }

    return {
      attachmentModelId,
      providerConfig: {
        baseUrl: "http://127.0.0.1:11434",
        api: "ollama",
        apiKey: "ollama-local",
        models: providerModels,
      },
    };
  }

  buildMemorySearchConfig(
    runtimeSettings: Awaited<ReturnType<typeof appStateService.getRuntimeSettings>>,
  ) {
    return buildMemorySearchConfigFromSettings(runtimeSettings);
  }

  private parseMemoryStatusEntry(raw: string): OpenClawMemoryStatusEntry | null {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return null;
      }

      const mainEntry =
        parsed.find(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            (entry as { agentId?: unknown }).agentId === "main",
        ) ?? parsed[0];

      return mainEntry &&
        typeof mainEntry === "object" &&
        !Array.isArray(mainEntry)
        ? (mainEntry as OpenClawMemoryStatusEntry)
        : null;
    } catch {
      return null;
    }
  }

  async loadOpenClawMemoryStatus(
    params: {
      deep?: boolean;
      index?: boolean;
    } = {},
  ): Promise<OpenClawMemoryStatusEntry | null> {
    try {
      const args = ["memory", "status"];
      if (params.index) {
        args.push("--index");
      } else if (params.deep) {
        args.push("--deep");
      }
      args.push("--json");

      const output = await this.execOpenClaw(args, true);
      return this.parseMemoryStatusEntry(output);
    } catch {
      return null;
    }
  }

  resolvePrimaryModel(
    runtimeSettings: Awaited<ReturnType<typeof appStateService.getRuntimeSettings>>,
  ): string {
    if (runtimeSettings.activeProviderId === "ollama-default") {
      return `ollama/${runtimeSettings.ollamaModel}`;
    }

    if (runtimeSettings.activeProviderId === "llamacpp-default") {
      return `llamacpp/${path.basename(runtimeSettings.llamaCppModel).toLowerCase()}`;
    }

    return (
      runtimeSettings.cloudProviders[
        runtimeSettings.activeProviderId as keyof typeof runtimeSettings.cloudProviders
      ]?.defaultModel ?? `ollama/${runtimeSettings.ollamaModel}`
    );
  }

  readCurrentConfig(): Record<string, unknown> | null {
    try {
      if (!fs.existsSync(paths.openClawConfigPath)) {
        this.cachedConfig = null;
        this.cachedConfigMtimeMs = -1;
        return null;
      }

      const stat = fs.statSync(paths.openClawConfigPath);
      if (
        this.cachedConfigMtimeMs >= 0 &&
        stat.mtimeMs === this.cachedConfigMtimeMs
      ) {
        return this.cachedConfig;
      }

      const raw = fs.readFileSync(paths.openClawConfigPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      this.cachedConfigMtimeMs = stat.mtimeMs;
      this.cachedConfig =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      return this.cachedConfig;
    } catch {
      this.cachedConfig = null;
      this.cachedConfigMtimeMs = -1;
      return null;
    }
  }

  async ensureOpenClawEnvFile(content: string): Promise<void> {
    if (this.cachedEnvContent === content && fs.existsSync(paths.openClawEnvPath)) {
      return;
    }

    const currentContent = fs.existsSync(paths.openClawEnvPath)
      ? fs.readFileSync(paths.openClawEnvPath, "utf8")
      : null;
    if (currentContent === content) {
      this.cachedEnvContent = content;
      return;
    }

    fs.writeFileSync(paths.openClawEnvPath, content, {
      encoding: "utf8",
    });
    this.cachedEnvContent = content;
  }

  private updateCachedConfig(nextConfig: Record<string, unknown> | null): void {
    this.cachedConfig = nextConfig;
    this.cachedConfigMtimeMs = fs.existsSync(paths.openClawConfigPath)
      ? fs.statSync(paths.openClawConfigPath).mtimeMs
      : -1;
  }

  async setConfigValueIfNeeded(
    currentConfig: Record<string, unknown> | null,
    key: string,
    value: unknown,
  ): Promise<Record<string, unknown>> {
    if (configValueEquals(getConfigPathValue(currentConfig, key), value)) {
      return currentConfig ?? {};
    }

    await this.execOpenClaw([
      "config",
      "set",
      key,
      stringifyConfigValue(value),
      "--strict-json",
    ]);
    const nextConfig = currentConfig ? { ...currentConfig } : {};
    setConfigPathValue(nextConfig, key, value);
    this.updateCachedConfig(nextConfig);
    return nextConfig;
  }

  async applyContextManagementPolicy(
    overrides: Partial<HarnessRuntimeModelConfig> = {},
    currentConfig: Record<string, unknown> | null = this.readCurrentConfig(),
  ): Promise<Record<string, unknown>> {
    const runtimeSettings = await appStateService.getRuntimeSettings();
    const providerId = overrides.providerId ?? runtimeSettings.activeProviderId;
    const modelId =
      overrides.modelId ??
      (providerId === "ollama-default"
        ? runtimeSettings.ollamaModel
        : providerId === "llamacpp-default"
          ? path.basename(runtimeSettings.llamaCppModel).toLowerCase()
          : (runtimeSettings.cloudProviders[
              providerId as keyof typeof runtimeSettings.cloudProviders
            ]?.defaultModel ?? ""));
    const status = await this.currentContextManagementStatus(overrides);

    let nextConfig = currentConfig;
    nextConfig = await this.setConfigValueIfNeeded(
      nextConfig,
      "agents.defaults.compaction",
      buildContextManagementConfig(status),
    );
    nextConfig = await this.setConfigValueIfNeeded(
      nextConfig,
      "agents.defaults.contextPruning",
      buildContextPruningConfig({
        status,
        providerId,
        modelId,
      }),
    );
    return nextConfig;
  }

  pairingStorePath(channel = "signal"): string {
    return path.join(paths.openClawStateDir, "credentials", `${channel}-pairing.json`);
  }

  async listPendingPairings(channel = "signal") {
    try {
      const output = await this.execOpenClaw(
        ["pairing", "list", channel, "--json"],
        true,
      );
      const parsed = JSON.parse(output) as {
        pending?: Array<Record<string, unknown>>;
      };
      const pending = Array.isArray(parsed.pending) ? parsed.pending : [];
      return pending.map((item) =>
        SignalPendingPairingSchema.parse({
          code: String(item.code ?? ""),
          from: String(item.from ?? item.target ?? item.id ?? "Unknown sender"),
          requestedAt:
            typeof item.createdAt === "string"
              ? item.createdAt
              : typeof item.createdAtMs === "number"
                ? new Date(item.createdAtMs).toISOString()
                : null,
        }),
      );
    } catch {
      return [];
    }
  }

  async denyPendingPairingCode(
    channel: string,
    code: string,
  ): Promise<void> {
    const filePath = this.pairingStorePath(channel);
    const raw = await fs.promises.readFile(filePath, "utf8").catch(() => "");
    if (!raw) {
      return;
    }

    const parsed = JSON.parse(raw) as {
      version?: unknown;
      requests?: Array<Record<string, unknown>>;
    };
    const requests = Array.isArray(parsed.requests) ? parsed.requests : [];
    const next = requests.filter(
      (entry) =>
        String(entry.code ?? "")
          .trim()
          .toUpperCase() !== code.trim().toUpperCase(),
    );
    if (next.length === requests.length) {
      return;
    }

    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(
      filePath,
      JSON.stringify({ version: 1, requests: next }, null, 2),
      "utf8",
    );
  }

  async getChannelStatuses(): Promise<{
    statuses: ChannelStatus[];
    config: ChannelConfigSummary;
  }> {
    return await this.channelStatusesCache.get(async () => {
      const runtimeSettings = await appStateService.getRuntimeSettings();
      const statuses: ChannelStatus[] = [
        ChannelStatusSchema.parse({
          id: "web",
          label: "Web/PWA",
          enabled: true,
          configured: true,
          health: "ok",
          healthMessage: "Primary DroidAgent interface.",
          metadata: {},
        }),
      ];

      try {
        const output = await this.execOpenClaw([
          "channels",
          "status",
          "--probe",
          "--json",
        ]);
        const parsed = JSON.parse(output) as {
          channels?: Array<Record<string, unknown>>;
        };
        const signalRows = (Array.isArray(parsed.channels) ? parsed.channels : []).filter(
          (row) => row.channel === "signal",
        );
        statuses.push(
          ChannelStatusSchema.parse({
            id: "signal",
            label: "Signal",
            enabled:
              signalRows.some((row) => row.enabled !== false) ||
              runtimeSettings.signalRegistrationState === "registered",
            configured:
              signalRows.length > 0 || Boolean(runtimeSettings.signalAccountId),
            health:
              runtimeSettings.signalRegistrationState === "registered" &&
              runtimeSettings.signalDaemonState === "running"
                ? "ok"
                : "warn",
            healthMessage:
              runtimeSettings.signalRegistrationState === "registered" &&
              runtimeSettings.signalDaemonState === "running"
                ? "Signal is linked through the local signal-cli HTTP daemon."
                : (runtimeSettings.signalLastError ??
                  (signalRows.length > 0
                    ? "Signal channel detected in OpenClaw."
                    : "Signal is not configured yet.")),
            metadata: {
              daemonRunning: runtimeSettings.signalDaemonState === "running",
              hasAccount: Boolean(runtimeSettings.signalAccountId),
            },
          }),
        );
      } catch {
        statuses.push(
          ChannelStatusSchema.parse({
            id: "signal",
            label: "Signal",
            enabled: runtimeSettings.signalRegistrationState === "registered",
            configured: Boolean(runtimeSettings.signalAccountId),
            health: "warn",
            healthMessage:
              runtimeSettings.signalLastError ?? "Signal is not configured yet.",
            metadata: {
              daemonRunning: runtimeSettings.signalDaemonState === "running",
              hasAccount: Boolean(runtimeSettings.signalAccountId),
            },
          }),
        );
      }

      const pendingPairings = await this.listPendingPairings("signal");
      const healthChecks = [
        SignalHealthCheckSchema.parse({
          id: "cli",
          label: "signal-cli",
          health:
            runtimeSettings.signalCliPath && runtimeSettings.signalCliVersion
              ? "ok"
              : "warn",
          message:
            runtimeSettings.signalCliPath && runtimeSettings.signalCliVersion
              ? `signal-cli ${runtimeSettings.signalCliVersion}`
              : "signal-cli is not installed yet.",
        }),
        SignalHealthCheckSchema.parse({
          id: "java",
          label: "Java",
          health: runtimeSettings.signalJavaHome ? "ok" : "warn",
          message: runtimeSettings.signalJavaHome
            ? runtimeSettings.signalJavaHome
            : "A compatible Java runtime is not configured.",
        }),
        SignalHealthCheckSchema.parse({
          id: "account",
          label: "Account",
          health: runtimeSettings.signalAccountId ? "ok" : "warn",
          message:
            runtimeSettings.signalAccountId ??
            "No Signal account is configured yet.",
        }),
        SignalHealthCheckSchema.parse({
          id: "daemon",
          label: "Daemon",
          health:
            runtimeSettings.signalDaemonState === "running" ? "ok" : "warn",
          message:
            runtimeSettings.signalDaemonState === "running"
              ? (runtimeSettings.signalDaemonUrl ?? "Signal daemon is reachable.")
              : (runtimeSettings.signalLastError ??
                "Signal daemon is not running."),
        }),
        SignalHealthCheckSchema.parse({
          id: "channel",
          label: "OpenClaw Channel",
          health:
            runtimeSettings.signalRegistrationState === "registered" &&
            runtimeSettings.signalDaemonState === "running"
              ? "ok"
              : "warn",
          message:
            runtimeSettings.signalRegistrationState === "registered" &&
            runtimeSettings.signalDaemonState === "running"
              ? "Signal is configured in OpenClaw."
              : "OpenClaw Signal channel is not fully operational yet.",
        }),
        SignalHealthCheckSchema.parse({
          id: "pairing",
          label: "Pairing Queue",
          health: pendingPairings.length > 0 ? "warn" : "ok",
          message:
            pendingPairings.length > 0
              ? `${pendingPairings.length} pending pairing request(s).`
              : "No pending Signal pairing requests.",
        }),
        SignalHealthCheckSchema.parse({
          id: "compatibility",
          label: "Compatibility",
          health: runtimeSettings.signalCompatibilityWarning ? "warn" : "ok",
          message:
            runtimeSettings.signalCompatibilityWarning ??
            "signal-cli version looks current enough for routine use.",
        }),
      ];

      return {
        statuses,
        config: ChannelConfigSummarySchema.parse({
          signal: {
            installed: Boolean(runtimeSettings.signalCliPath),
            binaryPath: runtimeSettings.signalCliPath,
            javaHome: runtimeSettings.signalJavaHome,
            accountId: runtimeSettings.signalAccountId,
            phoneNumber: runtimeSettings.signalPhoneNumber,
            deviceName: runtimeSettings.signalDeviceName,
            cliVersion: runtimeSettings.signalCliVersion,
            registrationMode: runtimeSettings.signalRegistrationMode,
            registrationState: runtimeSettings.signalRegistrationState,
            daemonState: runtimeSettings.signalDaemonState,
            daemonUrl: runtimeSettings.signalDaemonUrl,
            receiveMode: runtimeSettings.signalReceiveMode,
            dmPolicy: "pairing",
            allowGroups: false,
            channelConfigured:
              runtimeSettings.signalRegistrationState === "registered",
            pendingPairings,
            linkUri: runtimeSettings.signalLinkUri,
            lastError: runtimeSettings.signalLastError,
            lastStartedAt: runtimeSettings.signalLastStartedAt,
            compatibilityWarning: runtimeSettings.signalCompatibilityWarning,
            healthChecks,
          },
        }),
      };
    });
  }

  async listChannels(): Promise<{
    statuses: ChannelStatus[];
    config: ChannelConfigSummary;
  }> {
    return await this.getChannelStatuses();
  }

  async configureSignal(params: {
    cliPath: string;
    accountId: string;
    httpUrl?: string;
  }): Promise<void> {
    const args = [
      "channels",
      "add",
      "--channel",
      "signal",
      "--cli-path",
      params.cliPath,
      "--signal-number",
      params.accountId,
    ];

    if (params.httpUrl) {
      args.push("--http-url", params.httpUrl);
    }

    await this.execOpenClaw(args);
    await this.execOpenClaw([
      "config",
      "set",
      "channels.signal.autoStart",
      stringifyConfigValue(!params.httpUrl),
      "--strict-json",
    ]);
    await appStateService.updateRuntimeSettings({
      signalCliPath: params.cliPath,
      signalAccountId: params.accountId,
      signalPhoneNumber: params.accountId.startsWith("+")
        ? params.accountId
        : null,
      signalDaemonUrl: params.httpUrl ?? null,
    });
    this.invalidateChannelStatusCache();
  }

  async removeSignalChannel(): Promise<void> {
    await this.execOpenClaw(
      ["channels", "remove", "--channel", "signal", "--delete"],
      true,
    );
    this.invalidateChannelStatusCache();
  }

  async approveSignalPairing(code: string): Promise<void> {
    await this.execOpenClaw(["pairing", "approve", "signal", code, "--notify"]);
    this.invalidateChannelStatusCache();
  }

  async resolveSignalPairing(
    code: string,
    resolution: "approved" | "denied",
  ): Promise<void> {
    if (resolution === "approved") {
      await this.approveSignalPairing(code);
      return;
    }

    await this.denyPendingPairingCode("signal", code);
  }

  async registerLlamaCppProvider(
    modelId: string,
    contextWindow: number,
  ): Promise<void> {
    const provider = {
      baseUrl: `http://127.0.0.1:${process.env.DROIDAGENT_LLAMA_CPP_PORT ?? 8012}/v1`,
      api: "openai-completions",
      apiKey: "llama-local",
      models: [
        {
          id: modelId,
          name: modelId,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow,
          maxTokens: contextWindow,
        },
      ],
    };

    await this.execOpenClaw([
      "config",
      "set",
      "models.providers.llamacpp",
      stringifyConfigValue(provider),
      "--strict-json",
    ]);
    await this.execOpenClaw(["models", "set", `llamacpp/${modelId}`]);
  }

  async selectOllamaModel(modelId: string): Promise<void> {
    await this.ensureConfigured();
    await this.selectPrimaryModel(`ollama/${modelId}`);
  }

  async selectPrimaryModel(modelId: string): Promise<void> {
    await this.ensureConfigured();
    await this.execOpenClaw(["models", "set", modelId]);
  }
}

export interface OpenClawService
  extends OpenClawGatewayMethods,
    OpenClawChatMethods,
    OpenClawMemoryMethods {}

Object.assign(
  OpenClawService.prototype,
  openClawGatewayMethods,
  openClawChatMethods,
  openClawMemoryMethods,
);

export const openclawService = new OpenClawService();
