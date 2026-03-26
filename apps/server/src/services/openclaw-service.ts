import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

import {
  ApprovalRecordSchema,
  ChannelConfigSummarySchema,
  ChannelStatusSchema,
  ChatMessageSchema,
  ContextManagementStatusSchema,
  RuntimeStatusSchema,
  SignalHealthCheckSchema,
  SignalPendingPairingSchema,
  SessionSummarySchema,
  nowIso,
  type ApprovalRecord,
  type ChannelConfigSummary,
  type ChannelStatus,
  type ChatMessage,
  type ContextManagementStatus,
  type SessionSummary
} from "@droidagent/shared";

import {
  OPENCLAW_GATEWAY_HTTP_URL,
  OPENCLAW_GATEWAY_PORT,
  OPENCLAW_GATEWAY_URL,
  OPENCLAW_PROFILE,
  baseEnv,
  paths,
  resolveOpenClawBin
} from "../env.js";
import { CommandError, runCommand } from "../lib/process.js";
import { appStateService } from "./app-state-service.js";
import type { HarnessRuntimeModelConfig, StreamRelayCallbacks } from "./harness-service.js";
import { keychainService } from "./keychain-service.js";

const GATEWAY_READY_RETRIES = 5;
const GATEWAY_READY_DELAY_MS = 800;
const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
const DEFAULT_CONTEXT_WINDOW = 200000;

function stringifyConfigValue(value: unknown): string {
  return JSON.stringify(value);
}

function getConfigPathValue(source: Record<string, unknown> | null, dottedPath: string): unknown {
  if (!source) {
    return undefined;
  }

  let current: unknown = source;
  for (const segment of dottedPath.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !(segment in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function setConfigPathValue(target: Record<string, unknown>, dottedPath: string, value: unknown): void {
  const segments = dottedPath.split(".");
  let current: Record<string, unknown> = target;

  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }

  current[segments.at(-1) ?? dottedPath] = value;
}

function configValueEquals(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

function extractEventData(block: string): string | null {
  const lines = block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());

  if (lines.length === 0) {
    return null;
  }

  return lines.join("\n");
}

function extractDeltaText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const choices = Array.isArray((payload as { choices?: unknown }).choices)
    ? ((payload as { choices: Array<Record<string, unknown>> }).choices ?? [])
    : [];
  const delta = choices[0]?.delta;

  if (typeof delta === "string") {
    return delta;
  }

  if (delta && typeof delta === "object") {
    const content = (delta as { content?: unknown }).content;
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") {
            return part;
          }
          if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
            return (part as { text: string }).text;
          }
          return "";
        })
        .join("");
    }
  }

  return "";
}

function parseHistoryMessage(sessionKey: string, message: Record<string, unknown>, index: number): ChatMessage {
  return ChatMessageSchema.parse({
    id: String(message.id ?? `${sessionKey}-${index}`),
    sessionId: sessionKey,
    role: message.role === "assistant" || message.role === "system" || message.role === "tool" ? message.role : "user",
    text:
      typeof message.content === "string"
        ? message.content
        : typeof message.text === "string"
          ? message.text
          : JSON.stringify(message.content ?? ""),
    createdAt: new Date(Number(message.ts ?? message.createdAtMs ?? Date.now())).toISOString(),
    status: "complete",
    source: "openclaw"
  });
}

function isAnthropicPruningCandidate(providerId: string, modelId: string): boolean {
  if (providerId === "anthropic") {
    return true;
  }

  if (providerId === "openrouter") {
    return /anthropic\//i.test(modelId);
  }

  return false;
}

function resolveContextWindow(params: {
  providerId: string;
  contextWindow?: number;
  runtimeSettings: Awaited<ReturnType<typeof appStateService.getRuntimeSettings>>;
}): number {
  if (typeof params.contextWindow === "number" && Number.isFinite(params.contextWindow) && params.contextWindow > 0) {
    return params.contextWindow;
  }

  if (params.providerId === "llamacpp-default") {
    return params.runtimeSettings.llamaCppContextWindow;
  }

  return DEFAULT_CONTEXT_WINDOW;
}

function buildContextManagementStatus(params: {
  enabled: boolean;
  providerId: string;
  modelId: string;
  contextWindow: number;
}): ContextManagementStatus {
  const reserveTokensFloor = Math.min(24000, Math.max(2048, Math.floor(params.contextWindow * 0.25)));
  const softThresholdTokens = Math.min(6000, Math.max(512, Math.floor(params.contextWindow * 0.08)));
  const pruningMode = params.enabled && isAnthropicPruningCandidate(params.providerId, params.modelId) ? "cache-ttl" : "off";

  return ContextManagementStatusSchema.parse({
    enabled: params.enabled,
    compactionMode: params.enabled ? "safeguard" : "default",
    pruningMode,
    memoryFlushEnabled: params.enabled,
    reserveTokensFloor,
    softThresholdTokens
  });
}

export class OpenClawService {
  private gatewayProcess: ChildProcess | null = null;
  private gatewayToken: string | null = null;
  private activeRuns = new Map<string, { controller: AbortController; runId: string }>();

  private async gatewayHealthProbe(): Promise<{ version?: string }> {
    const output = await this.execOpenClaw([
      "gateway",
      "health",
      "--json",
      "--timeout",
      "2000",
      "--url",
      OPENCLAW_GATEWAY_URL,
      "--token",
      await this.ensureGatewayToken()
    ]);

    return JSON.parse(output) as { version?: string };
  }

  private async inspectGatewayPortOwner(): Promise<{ pid: number; command: string } | null> {
    const result = await runCommand(
      "lsof",
      ["-nP", `-iTCP:${OPENCLAW_GATEWAY_PORT}`, "-sTCP:LISTEN", "-Fp"],
      { okExitCodes: [0, 1] }
    );
    const pid = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("p"))
      ?.slice(1);

    if (!pid) {
      return null;
    }

    try {
      const processInfo = await runCommand("ps", ["-o", "command=", "-p", pid], { okExitCodes: [0, 1] });
      const command = processInfo.stdout.trim() || "process";
      return {
        pid: Number(pid),
        command
      };
    } catch {
      return {
        pid: Number(pid),
        command: "process"
      };
    }
  }

  private buildGatewayPortConflictMessage(owner: { pid: number; command: string }): string {
    const portDetails = `Port ${OPENCLAW_GATEWAY_PORT} is owned by ${owner.command} (pid ${owner.pid}).`;
    const guidance = /openclaw/i.test(owner.command)
      ? "A different OpenClaw service is already using the configured DroidAgent gateway port. Stop the conflicting service or change DROIDAGENT_OPENCLAW_PORT."
      : "Another local process is already using the configured DroidAgent gateway port. Stop the conflicting service or change DROIDAGENT_OPENCLAW_PORT.";

    return `${guidance} ${portDetails}`;
  }

  private async explainGatewayFailure(
    error: unknown,
    options: { expectedPid?: number | null; includePortConflicts?: boolean } = {}
  ): Promise<{ message: string; portOwner: { pid: number; command: string } | null }> {
    const fallbackMessage = error instanceof Error ? error.message : "Gateway is not yet reachable.";
    const shouldInspectPort = options.includePortConflicts && /token mismatch|abnormal closure|connect failed|not yet reachable/i.test(fallbackMessage);

    if (!shouldInspectPort) {
      return {
        message: fallbackMessage,
        portOwner: null
      };
    }

    const owner = await this.inspectGatewayPortOwner();
    if (!owner) {
      return {
        message: fallbackMessage,
        portOwner: null
      };
    }

    if (options.expectedPid && owner.pid === options.expectedPid) {
      return {
        message: fallbackMessage,
        portOwner: owner
      };
    }

    return {
      message: this.buildGatewayPortConflictMessage(owner),
      portOwner: owner
    };
  }

  private get openclawBin(): string {
    const bin = resolveOpenClawBin();
    if (!bin) {
      throw new Error("OpenClaw binary was not found in this workspace.");
    }
    return bin;
  }

  private profileArgs(extra: string[] = []): string[] {
    return ["--profile", OPENCLAW_PROFILE, ...extra];
  }

  private async ensureGatewayToken(): Promise<string> {
    if (this.gatewayToken) {
      return this.gatewayToken;
    }

    const existing = await appStateService.getJsonSetting<string | null>("openclawGatewayToken", null);
    if (existing) {
      this.gatewayToken = existing;
      return existing;
    }

    const next = randomUUID();
    this.gatewayToken = next;
    await appStateService.setJsonSetting("openclawGatewayToken", next);
    return next;
  }

  private async execOpenClaw(args: string[], allowFailure = false): Promise<string> {
    try {
      const result = await runCommand(this.openclawBin, this.profileArgs(args), {
        env: await this.openclawEnv()
      });
      return result.stdout;
    } catch (error) {
      if (allowFailure && error instanceof CommandError) {
        return error.stdout || error.stderr;
      }
      throw error;
    }
  }

  private async openclawEnv(): Promise<NodeJS.ProcessEnv> {
    return {
      ...baseEnv(),
      ...(await keychainService.getProcessEnv()),
      OPENCLAW_GATEWAY_TOKEN: await this.ensureGatewayToken(),
      OLLAMA_API_KEY: "ollama-local"
    };
  }

  private async gatewayHeaders(sessionKey: string): Promise<HeadersInit> {
    return {
      accept: "text/event-stream",
      authorization: `Bearer ${await this.ensureGatewayToken()}`,
      "content-type": "application/json",
      "x-openclaw-agent-id": "main",
      "x-openclaw-session-key": sessionKey
    };
  }

  private resolvePrimaryModel(runtimeSettings: Awaited<ReturnType<typeof appStateService.getRuntimeSettings>>): string {
    if (runtimeSettings.activeProviderId === "ollama-default") {
      return `ollama/${runtimeSettings.ollamaModel}`;
    }

    if (runtimeSettings.activeProviderId === "llamacpp-default") {
      return `llamacpp/${path.basename(runtimeSettings.llamaCppModel).toLowerCase()}`;
    }

    return runtimeSettings.cloudProviders[runtimeSettings.activeProviderId as keyof typeof runtimeSettings.cloudProviders]?.defaultModel
      ?? `ollama/${runtimeSettings.ollamaModel}`;
  }

  private async currentContextManagementStatus(overrides: Partial<HarnessRuntimeModelConfig> = {}): Promise<ContextManagementStatus> {
    const runtimeSettings = await appStateService.getRuntimeSettings();
    const providerId = overrides.providerId ?? runtimeSettings.activeProviderId;
    const modelId =
      overrides.modelId ??
      (providerId === "ollama-default"
        ? runtimeSettings.ollamaModel
        : providerId === "llamacpp-default"
          ? path.basename(runtimeSettings.llamaCppModel).toLowerCase()
          : runtimeSettings.cloudProviders[providerId as keyof typeof runtimeSettings.cloudProviders]?.defaultModel ?? "");
    const contextWindow = resolveContextWindow({
      providerId,
      ...(typeof overrides.contextWindow === "number" ? { contextWindow: overrides.contextWindow } : {}),
      runtimeSettings
    });

    return buildContextManagementStatus({
      enabled: runtimeSettings.smartContextManagementEnabled,
      providerId,
      modelId,
      contextWindow
    });
  }

  private readCurrentConfig(): Record<string, unknown> | null {
    try {
      if (!fs.existsSync(paths.openClawConfigPath)) {
        return null;
      }

      const raw = fs.readFileSync(paths.openClawConfigPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  private async setConfigValueIfNeeded(
    currentConfig: Record<string, unknown> | null,
    key: string,
    value: unknown
  ): Promise<Record<string, unknown>> {
    if (configValueEquals(getConfigPathValue(currentConfig, key), value)) {
      return currentConfig ?? {};
    }

    await this.execOpenClaw(["config", "set", key, stringifyConfigValue(value), "--strict-json"]);
    const nextConfig = currentConfig ? { ...currentConfig } : {};
    setConfigPathValue(nextConfig, key, value);
    return nextConfig;
  }

  private async applyContextManagementPolicy(
    overrides: Partial<HarnessRuntimeModelConfig> = {},
    currentConfig: Record<string, unknown> | null = this.readCurrentConfig()
  ): Promise<Record<string, unknown>> {
    const runtimeSettings = await appStateService.getRuntimeSettings();
    const providerId = overrides.providerId ?? runtimeSettings.activeProviderId;
    const modelId =
      overrides.modelId ??
      (providerId === "ollama-default"
        ? runtimeSettings.ollamaModel
        : providerId === "llamacpp-default"
          ? path.basename(runtimeSettings.llamaCppModel).toLowerCase()
          : runtimeSettings.cloudProviders[providerId as keyof typeof runtimeSettings.cloudProviders]?.defaultModel ?? "");
    const status = await this.currentContextManagementStatus(overrides);

    const compaction =
      status.enabled
        ? {
            mode: "safeguard",
            timeoutSeconds: 900,
            reserveTokensFloor: status.reserveTokensFloor,
            identifierPolicy: "strict",
            postCompactionSections: ["Session Startup", "Red Lines"],
            memoryFlush: {
              enabled: true,
              softThresholdTokens: status.softThresholdTokens,
              systemPrompt: "Session nearing compaction. Store durable memories now.",
              prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store."
            }
          }
        : {
            mode: "default",
            timeoutSeconds: 900,
            reserveTokensFloor: status.reserveTokensFloor,
            identifierPolicy: "strict",
            postCompactionSections: ["Session Startup", "Red Lines"],
            memoryFlush: {
              enabled: false,
              softThresholdTokens: status.softThresholdTokens,
              systemPrompt: "Session nearing compaction. Store durable memories now.",
              prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store."
            }
          };

    const contextPruning =
      status.pruningMode === "cache-ttl" && isAnthropicPruningCandidate(providerId, modelId)
        ? {
            mode: "cache-ttl",
            ttl: "30m",
            keepLastAssistants: 3,
            softTrimRatio: 0.3,
            hardClearRatio: 0.5,
            minPrunableToolChars: 50000,
            softTrim: {
              maxChars: 4000,
              headChars: 1500,
              tailChars: 1500
            },
            hardClear: {
              enabled: true,
              placeholder: "[Old tool result content cleared]"
            },
            tools: {
              deny: ["browser", "canvas"]
            }
          }
        : {
            mode: "off"
          };

    let nextConfig = currentConfig;
    nextConfig = await this.setConfigValueIfNeeded(nextConfig, "agents.defaults.compaction", compaction);
    nextConfig = await this.setConfigValueIfNeeded(nextConfig, "agents.defaults.contextPruning", contextPruning);
    return nextConfig;
  }

  private pairingStorePath(channel = "signal"): string {
    return path.join(paths.openClawStateDir, "credentials", `${channel}-pairing.json`);
  }

  private async listPendingPairings(channel = "signal") {
    try {
      const output = await this.execOpenClaw(["pairing", "list", channel, "--json"], true);
      const parsed = JSON.parse(output) as { pending?: Array<Record<string, unknown>> };
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
                : null
        })
      );
    } catch {
      return [];
    }
  }

  private async denyPendingPairingCode(channel: string, code: string): Promise<void> {
    const filePath = this.pairingStorePath(channel);
    const raw = await fs.promises.readFile(filePath, "utf8").catch(() => "");
    if (!raw) {
      return;
    }

    const parsed = JSON.parse(raw) as { version?: unknown; requests?: Array<Record<string, unknown>> };
    const requests = Array.isArray(parsed.requests) ? parsed.requests : [];
    const next = requests.filter((entry) => String(entry.code ?? "").trim().toUpperCase() !== code.trim().toUpperCase());
    if (next.length === requests.length) {
      return;
    }

    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, JSON.stringify({ version: 1, requests: next }, null, 2), "utf8");
  }

  private async streamMessageRun(
    sessionKey: string,
    message: string,
    runId: string,
    controller: AbortController,
    relay: StreamRelayCallbacks
  ): Promise<void> {
    try {
      const response = await fetch(`${OPENCLAW_GATEWAY_HTTP_URL}${CHAT_COMPLETIONS_PATH}`, {
        method: "POST",
        headers: await this.gatewayHeaders(sessionKey),
        body: JSON.stringify({
          model: "openclaw",
          stream: true,
          messages: [
            {
              role: "user",
              content: message
            }
          ]
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const responseText = await response.text().catch(() => response.statusText);
        throw new Error(responseText || `OpenClaw stream failed with ${response.status}.`);
      }

      if (!response.body) {
        throw new Error("OpenClaw stream did not provide a response body.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? "";

        for (const block of blocks) {
          const rawData = extractEventData(block);
          if (!rawData || rawData === "[DONE]") {
            continue;
          }

          try {
            const parsed = JSON.parse(rawData) as unknown;
            const delta = extractDeltaText(parsed);
            if (delta) {
              await relay.onDelta(delta);
            }
          } catch {
            // Ignore malformed SSE frames from the local gateway and keep the stream alive.
          }
        }
      }

      const trailing = extractEventData(buffer);
      if (trailing && trailing !== "[DONE]") {
        try {
          const parsed = JSON.parse(trailing) as unknown;
          const delta = extractDeltaText(parsed);
          if (delta) {
            await relay.onDelta(delta);
          }
        } catch {
          // ignore malformed trailing data
        }
      }

      await relay.onDone();
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") {
        await relay.onDone();
        return;
      }

      await relay.onError(error instanceof Error ? error.message : "OpenClaw stream failed.");
    } finally {
      const active = this.activeRuns.get(sessionKey);
      if (active?.runId === runId) {
        this.activeRuns.delete(sessionKey);
      }
    }
  }

  async ensureConfigured(): Promise<void> {
    fs.mkdirSync(paths.openClawStateDir, { recursive: true });
    fs.writeFileSync(paths.openClawEnvPath, "OLLAMA_API_KEY=ollama-local\n", { encoding: "utf8" });
    const runtimeSettings = await appStateService.getRuntimeSettings();
    let currentConfig = this.readCurrentConfig();

    const desiredConfig: Array<[string, unknown]> = [
      ["gateway.mode", "local"],
      ["gateway.port", OPENCLAW_GATEWAY_PORT],
      ["gateway.bind", "loopback"],
      ["gateway.auth.mode", "token"],
      ["gateway.http.endpoints.chatCompletions.enabled", true],
      ["agents.defaults.model.primary", this.resolvePrimaryModel(runtimeSettings)],
      ["agents.defaults.thinkingDefault", "off"],
      ["tools.exec.host", "gateway"],
      ["tools.exec.security", "allowlist"],
      ["tools.exec.ask", "on-miss"],
      ["channels.signal.dmPolicy", "pairing"],
      ["channels.signal.groupPolicy", "disabled"]
    ];

    for (const [key, value] of desiredConfig) {
      currentConfig = await this.setConfigValueIfNeeded(currentConfig, key, value);
    }

    currentConfig = await this.setConfigValueIfNeeded(currentConfig, "gateway.auth.token", await this.ensureGatewayToken());

    await this.applyContextManagementPolicy({}, currentConfig);
  }

  async status() {
    const openclawBin = resolveOpenClawBin();
    const installed = Boolean(openclawBin);

    if (!installed) {
      return RuntimeStatusSchema.parse({
        id: "openclaw",
        label: "OpenClaw Gateway",
        state: "missing",
        enabled: true,
        installMethod: "bundledNpm",
        detectedVersion: null,
        binaryPath: null,
        health: "error",
        healthMessage: "The local OpenClaw CLI binary could not be found.",
        endpoint: null,
        installed: false,
        lastStartedAt: null,
        metadata: {}
      });
    }

    try {
      const parsed = await this.gatewayHealthProbe();
      return RuntimeStatusSchema.parse({
        id: "openclaw",
        label: "OpenClaw Gateway",
        state: "running",
        enabled: true,
        installMethod: "bundledNpm",
        detectedVersion: typeof parsed.version === "string" ? parsed.version : null,
        binaryPath: openclawBin,
        health: "ok",
        healthMessage: "Gateway reachable on loopback.",
        endpoint: OPENCLAW_GATEWAY_URL,
        installed: true,
        lastStartedAt: await appStateService.getJsonSetting<string | null>("openclawStartedAt", null),
        metadata: {}
      });
    } catch (error) {
      const failure = await this.explainGatewayFailure(error, { includePortConflicts: true });

      return RuntimeStatusSchema.parse({
        id: "openclaw",
        label: "OpenClaw Gateway",
        state: this.gatewayProcess ? "starting" : "stopped",
        enabled: true,
        installMethod: "bundledNpm",
        detectedVersion: null,
        binaryPath: openclawBin,
        health: "warn",
        healthMessage: failure.message,
        endpoint: OPENCLAW_GATEWAY_URL,
        installed: true,
        lastStartedAt: await appStateService.getJsonSetting<string | null>("openclawStartedAt", null),
        metadata: failure.portOwner
          ? {
              portOwnerPid: failure.portOwner.pid,
              portOwnerCommand: failure.portOwner.command
            }
          : {}
      });
    }
  }

  async health() {
    return await this.status();
  }

  async contextManagementStatus(): Promise<ContextManagementStatus> {
    return await this.currentContextManagementStatus();
  }

  async startGateway(): Promise<void> {
    await this.ensureConfigured();

    try {
      await this.gatewayHealthProbe();
      return;
    } catch (error) {
      const failure = await this.explainGatewayFailure(error, { includePortConflicts: true });
      if (failure.portOwner && (!this.gatewayProcess || failure.portOwner.pid !== this.gatewayProcess.pid)) {
        throw new Error(failure.message);
      }
    }

    if (this.gatewayProcess && this.gatewayProcess.exitCode === null) {
      return;
    }

    const child = spawn(
      this.openclawBin,
      this.profileArgs([
        "gateway",
        "run",
        "--allow-unconfigured",
        "--bind",
        "loopback",
        "--auth",
        "token",
        "--token",
        await this.ensureGatewayToken(),
        "--port",
        String(OPENCLAW_GATEWAY_PORT)
      ]),
      {
        env: await this.openclawEnv(),
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    child.stdout.on("data", (chunk) => {
      fs.appendFileSync(`${paths.logsDir}/openclaw.log`, chunk);
    });
    child.stderr.on("data", (chunk) => {
      fs.appendFileSync(`${paths.logsDir}/openclaw.log`, chunk);
    });
    child.on("exit", () => {
      this.gatewayProcess = null;
    });

    this.gatewayProcess = child;
    await appStateService.setJsonSetting("openclawStartedAt", nowIso());

    for (let i = 0; i < GATEWAY_READY_RETRIES; i++) {
      await new Promise((resolve) => setTimeout(resolve, GATEWAY_READY_DELAY_MS * (i + 1)));
      if (this.gatewayProcess?.exitCode !== null) {
        throw new Error("OpenClaw gateway process exited before becoming ready.");
      }
      try {
        await this.gatewayHealthProbe();
        return;
      } catch (error) {
        if (i === GATEWAY_READY_RETRIES - 1) {
          const failure = await this.explainGatewayFailure(error, {
            expectedPid: child.pid ?? null,
            includePortConflicts: true
          });
          throw new Error(failure.message === (error instanceof Error ? error.message : "") ? "OpenClaw gateway did not become ready in time." : failure.message);
        }
      }
    }
  }

  async stopGateway(): Promise<void> {
    if (this.gatewayProcess && this.gatewayProcess.exitCode === null) {
      this.gatewayProcess.kill("SIGTERM");
      this.gatewayProcess = null;
    }
  }

  async callGateway<T>(method: string, params: Record<string, unknown> = {}, expectFinal = false): Promise<T> {
    const args = [
      "gateway",
      "call",
      method,
      "--json",
      "--url",
      OPENCLAW_GATEWAY_URL,
      "--token",
      await this.ensureGatewayToken(),
      "--params",
      JSON.stringify(params)
    ];

    if (expectFinal) {
      args.splice(3, 0, "--expect-final");
    }

    const output = await this.execOpenClaw(args);
    const parsed = JSON.parse(output) as Record<string, unknown>;
    if ("error" in parsed && parsed.error) {
      const errorDetails = parsed.error as { message?: unknown };
      throw new Error(typeof errorDetails?.message === "string" ? errorDetails.message : "OpenClaw gateway call failed.");
    }
    return parsed as T;
  }

  async listSessions(): Promise<SessionSummary[]> {
    try {
      const response = (await this.callGateway<unknown>("sessions.list", {
        limit: 24,
        includeDerivedTitles: true,
        includeLastMessage: true
      })) as Array<Record<string, unknown>>;
      const list = Array.isArray(response) ? response : [];
      return list
        .map((item) => {
          const sessionKey = String(item.key ?? item.sessionKey ?? item.id ?? "main");
          return SessionSummarySchema.parse({
            id: sessionKey,
            title: String(item.title ?? item.derivedTitle ?? sessionKey),
            scope: sessionKey.startsWith("signal") ? "signal" : "main",
            updatedAt: new Date(Number(item.updatedAtMs ?? item.updatedAt ?? Date.now())).toISOString(),
            unreadCount: Number(item.unreadCount ?? 0),
            lastMessagePreview: String(
              item.lastMessagePreview ?? (item.lastMessage as { text?: unknown } | undefined)?.text ?? ""
            )
          });
        })
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    } catch {
      return [];
    }
  }

  async loadHistory(sessionKey: string): Promise<ChatMessage[]> {
    const response = await this.callGateway<{ messages?: Array<Record<string, unknown>> }>("chat.history", {
      sessionKey,
      limit: 150
    });

    const messages = Array.isArray(response.messages) ? response.messages : [];
    return messages.map((message, index) => parseHistoryMessage(sessionKey, message, index));
  }

  async loadChatHistory(sessionKey: string) {
    return await this.loadHistory(sessionKey);
  }

  async sendMessage(sessionKey: string, message: string, relay: StreamRelayCallbacks): Promise<{ runId: string }> {
    await this.ensureConfigured();
    await this.abortMessage(sessionKey);

    const runId = randomUUID();
    const controller = new AbortController();
    this.activeRuns.set(sessionKey, { controller, runId });
    void this.streamMessageRun(sessionKey, message, runId, controller, relay);
    return { runId };
  }

  async sendChat(sessionKey: string, message: string): Promise<void> {
    await this.callGateway(
      "chat.send",
      {
        sessionKey,
        message,
        idempotencyKey: randomUUID()
      },
      true
    );
  }

  async abortMessage(sessionKey: string): Promise<void> {
    const active = this.activeRuns.get(sessionKey);
    if (active) {
      active.controller.abort();
      this.activeRuns.delete(sessionKey);
    }

    try {
      await this.callGateway("chat.abort", { sessionKey }, true);
    } catch {
      // Some gateway builds may not expose chat.abort; the local abort controller still ends the relay.
    }
  }

  async listApprovals(): Promise<ApprovalRecord[]> {
    try {
      const output = await this.execOpenClaw([
        "approvals",
        "get",
        "--gateway",
        "--json",
        "--url",
        OPENCLAW_GATEWAY_URL,
        "--token",
        await this.ensureGatewayToken()
      ]);
      const parsed = JSON.parse(output) as { pending?: Array<Record<string, unknown>> };
      const pending = Array.isArray(parsed.pending) ? parsed.pending : [];
      return pending.map((item) =>
        ApprovalRecordSchema.parse({
          id: String(item.id ?? randomUUID()),
          kind: "exec",
          title: "Exec approval required",
          details: JSON.stringify(item.request ?? item),
          createdAt: new Date(Number(item.createdAtMs ?? Date.now())).toISOString(),
          status: "pending",
          source: "openclaw"
        })
      );
    } catch {
      return [];
    }
  }

  async resolveApproval(approvalId: string, resolution: "approved" | "denied"): Promise<void> {
    await this.callGateway("exec.approval.resolve", {
      id: approvalId,
      decision: resolution === "approved" ? "allow-once" : "deny"
    });
  }

  async getChannelStatuses(): Promise<{ statuses: ChannelStatus[]; config: ChannelConfigSummary }> {
    const runtimeSettings = await appStateService.getRuntimeSettings();
    const statuses: ChannelStatus[] = [
      ChannelStatusSchema.parse({
        id: "web",
        label: "Web/PWA",
        enabled: true,
        configured: true,
        health: "ok",
        healthMessage: "Primary DroidAgent interface.",
        metadata: {}
      })
    ];

    try {
      const output = await this.execOpenClaw(["channels", "status", "--probe", "--json"]);
      const parsed = JSON.parse(output) as { channels?: Array<Record<string, unknown>> };
      const signalRows = (Array.isArray(parsed.channels) ? parsed.channels : []).filter((row) => row.channel === "signal");
      statuses.push(
        ChannelStatusSchema.parse({
          id: "signal",
          label: "Signal",
          enabled: signalRows.some((row) => row.enabled !== false) || runtimeSettings.signalRegistrationState === "registered",
          configured: signalRows.length > 0 || Boolean(runtimeSettings.signalAccountId),
          health:
            runtimeSettings.signalRegistrationState === "registered" && runtimeSettings.signalDaemonState === "running"
              ? "ok"
              : runtimeSettings.signalLastError
                ? "warn"
                : signalRows.some((row) => row.ok === false)
                  ? "warn"
                  : "warn",
          healthMessage:
            runtimeSettings.signalRegistrationState === "registered" && runtimeSettings.signalDaemonState === "running"
              ? "Signal is linked through the local signal-cli HTTP daemon."
              : runtimeSettings.signalLastError ??
                (signalRows.length > 0 ? "Signal channel detected in OpenClaw." : "Signal is not configured yet."),
          metadata: {
            daemonRunning: runtimeSettings.signalDaemonState === "running",
            hasAccount: Boolean(runtimeSettings.signalAccountId)
          }
        })
      );
    } catch {
      statuses.push(
        ChannelStatusSchema.parse({
          id: "signal",
          label: "Signal",
          enabled: runtimeSettings.signalRegistrationState === "registered",
          configured: Boolean(runtimeSettings.signalAccountId),
          health: "warn",
          healthMessage: runtimeSettings.signalLastError ?? "Signal is not configured yet.",
          metadata: {
            daemonRunning: runtimeSettings.signalDaemonState === "running",
            hasAccount: Boolean(runtimeSettings.signalAccountId)
          }
        })
      );
    }

    const pendingPairings = await this.listPendingPairings("signal");
    const healthChecks = [
      SignalHealthCheckSchema.parse({
        id: "cli",
        label: "signal-cli",
        health: runtimeSettings.signalCliPath && runtimeSettings.signalCliVersion ? "ok" : "warn",
        message:
          runtimeSettings.signalCliPath && runtimeSettings.signalCliVersion
            ? `signal-cli ${runtimeSettings.signalCliVersion}`
            : "signal-cli is not installed yet."
      }),
      SignalHealthCheckSchema.parse({
        id: "java",
        label: "Java",
        health: runtimeSettings.signalJavaHome ? "ok" : "warn",
        message: runtimeSettings.signalJavaHome ? runtimeSettings.signalJavaHome : "A compatible Java runtime is not configured."
      }),
      SignalHealthCheckSchema.parse({
        id: "account",
        label: "Account",
        health: runtimeSettings.signalAccountId ? "ok" : "warn",
        message: runtimeSettings.signalAccountId ?? "No Signal account is configured yet."
      }),
      SignalHealthCheckSchema.parse({
        id: "daemon",
        label: "Daemon",
        health:
          runtimeSettings.signalDaemonState === "running"
            ? "ok"
            : runtimeSettings.signalRegistrationState === "registered"
              ? "warn"
              : "warn",
        message:
          runtimeSettings.signalDaemonState === "running"
            ? runtimeSettings.signalDaemonUrl ?? "Signal daemon is reachable."
            : runtimeSettings.signalLastError ?? "Signal daemon is not running."
      }),
      SignalHealthCheckSchema.parse({
        id: "channel",
        label: "OpenClaw Channel",
        health:
          runtimeSettings.signalRegistrationState === "registered" && runtimeSettings.signalDaemonState === "running"
            ? "ok"
            : "warn",
        message:
          runtimeSettings.signalRegistrationState === "registered" && runtimeSettings.signalDaemonState === "running"
            ? "Signal is configured in OpenClaw."
            : "OpenClaw Signal channel is not fully operational yet."
      }),
      SignalHealthCheckSchema.parse({
        id: "pairing",
        label: "Pairing Queue",
        health: pendingPairings.length > 0 ? "warn" : "ok",
        message: pendingPairings.length > 0 ? `${pendingPairings.length} pending pairing request(s).` : "No pending Signal pairing requests."
      }),
      SignalHealthCheckSchema.parse({
        id: "compatibility",
        label: "Compatibility",
        health: runtimeSettings.signalCompatibilityWarning ? "warn" : "ok",
        message: runtimeSettings.signalCompatibilityWarning ?? "signal-cli version looks current enough for routine use."
      })
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
          channelConfigured: runtimeSettings.signalRegistrationState === "registered",
          pendingPairings,
          linkUri: runtimeSettings.signalLinkUri,
          lastError: runtimeSettings.signalLastError,
          lastStartedAt: runtimeSettings.signalLastStartedAt,
          compatibilityWarning: runtimeSettings.signalCompatibilityWarning,
          healthChecks
        }
      })
    };
  }

  async listChannels(): Promise<{ statuses: ChannelStatus[]; config: ChannelConfigSummary }> {
    return await this.getChannelStatuses();
  }

  async configureSignal(params: { cliPath: string; accountId: string; httpUrl?: string }): Promise<void> {
    const args = [
      "channels",
      "add",
      "--channel",
      "signal",
      "--cli-path",
      params.cliPath,
      "--signal-number",
      params.accountId
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
      "--strict-json"
    ]);
    await appStateService.updateRuntimeSettings({
      signalCliPath: params.cliPath,
      signalAccountId: params.accountId,
      signalPhoneNumber: params.accountId.startsWith("+") ? params.accountId : null,
      signalDaemonUrl: params.httpUrl ?? null
    });
  }

  async removeSignalChannel(): Promise<void> {
    await this.execOpenClaw(["channels", "remove", "--channel", "signal", "--delete"], true);
  }

  async approveSignalPairing(code: string): Promise<void> {
    await this.execOpenClaw(["pairing", "approve", "signal", code, "--notify"]);
  }

  async resolveSignalPairing(code: string, resolution: "approved" | "denied"): Promise<void> {
    if (resolution === "approved") {
      await this.approveSignalPairing(code);
      return;
    }

    await this.denyPendingPairingCode("signal", code);
  }

  async setSmartContextManagement(enabled: boolean): Promise<ContextManagementStatus> {
    await appStateService.updateRuntimeSettings({
      smartContextManagementEnabled: enabled
    });
    await this.applyContextManagementPolicy();
    return await this.contextManagementStatus();
  }

  async registerLlamaCppProvider(modelId: string, contextWindow: number): Promise<void> {
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
          maxTokens: contextWindow
        }
      ]
    };

    await this.execOpenClaw(["config", "set", "models.providers.llamacpp", stringifyConfigValue(provider), "--strict-json"]);
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

  async configureRuntimeModel(config: HarnessRuntimeModelConfig): Promise<void> {
    if (config.providerId === "ollama-default") {
      const modelId = config.modelId.startsWith("ollama/") ? config.modelId.slice("ollama/".length) : config.modelId;
      await this.selectOllamaModel(modelId);
      await this.applyContextManagementPolicy({
        providerId: "ollama-default",
        modelId,
        ...(typeof config.contextWindow === "number" ? { contextWindow: config.contextWindow } : {})
      });
      return;
    }

    if (config.providerId === "llamacpp-default") {
      await this.registerLlamaCppProvider(config.modelId, config.contextWindow ?? 8192);
      await this.applyContextManagementPolicy({
        providerId: "llamacpp-default",
        modelId: config.modelId,
        contextWindow: config.contextWindow ?? 8192
      });
      return;
    }

    await this.selectPrimaryModel(config.modelId);
    await this.applyContextManagementPolicy(config);
  }
}

export const openclawService = new OpenClawService();
