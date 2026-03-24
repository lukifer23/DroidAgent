import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import {
  ApprovalRecordSchema,
  ChannelConfigSummarySchema,
  ChannelStatusSchema,
  ChatMessageSchema,
  RuntimeStatusSchema,
  SessionSummarySchema,
  nowIso,
  type ApprovalRecord,
  type ChannelConfigSummary,
  type ChannelStatus,
  type ChatMessage,
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

function stringifyConfigValue(value: unknown): string {
  return JSON.stringify(value);
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

export class OpenClawService {
  private gatewayProcess: ChildProcess | null = null;
  private gatewayToken: string | null = null;
  private activeRuns = new Map<string, { controller: AbortController; runId: string }>();

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

    const desiredConfig: Array<[string, unknown]> = [
      ["gateway.mode", "local"],
      ["gateway.port", OPENCLAW_GATEWAY_PORT],
      ["gateway.bind", "loopback"],
      ["gateway.auth.mode", "token"],
      ["gateway.http.endpoints.chatCompletions.enabled", true],
      ["agents.defaults.model.primary", "ollama/gpt-oss:20b"],
      ["tools.exec.host", "gateway"],
      ["tools.exec.security", "allowlist"],
      ["tools.exec.ask", "on-miss"],
      ["channels.signal.dmPolicy", "pairing"],
      ["channels.signal.groupPolicy", "disabled"]
    ];

    for (const [key, value] of desiredConfig) {
      await this.execOpenClaw(["config", "set", key, stringifyConfigValue(value), "--strict-json"]);
    }

    await this.execOpenClaw([
      "config",
      "set",
      "gateway.auth.token",
      stringifyConfigValue(await this.ensureGatewayToken()),
      "--strict-json"
    ]);
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
      const output = await this.execOpenClaw([
        "gateway",
        "health",
        "--json",
        "--timeout",
        "1500",
        "--url",
        OPENCLAW_GATEWAY_URL,
        "--token",
        await this.ensureGatewayToken()
      ]);
      const parsed = JSON.parse(output) as { version?: unknown };
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
      return RuntimeStatusSchema.parse({
        id: "openclaw",
        label: "OpenClaw Gateway",
        state: this.gatewayProcess ? "starting" : "stopped",
        enabled: true,
        installMethod: "bundledNpm",
        detectedVersion: null,
        binaryPath: openclawBin,
        health: "warn",
        healthMessage: error instanceof Error ? error.message : "Gateway is not yet reachable.",
        endpoint: OPENCLAW_GATEWAY_URL,
        installed: true,
        lastStartedAt: await appStateService.getJsonSetting<string | null>("openclawStartedAt", null),
        metadata: {}
      });
    }
  }

  async health() {
    return await this.status();
  }

  async startGateway(): Promise<void> {
    await this.ensureConfigured();
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
        await this.execOpenClaw([
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
        return;
      } catch {
        if (i === GATEWAY_READY_RETRIES - 1) {
          throw new Error("OpenClaw gateway did not become ready in time.");
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

    let pairingPending = 0;
    let approvedPeers: string[] = [];
    try {
      const output = await this.execOpenClaw(["pairing", "list", "signal", "--json"], true);
      const parsed = JSON.parse(output) as { pending?: Array<Record<string, unknown>> };
      pairingPending = Array.isArray(parsed.pending) ? parsed.pending.length : 0;
      approvedPeers = Array.isArray(parsed.pending)
        ? parsed.pending.map((item) => String(item.from ?? item.target ?? "")).filter(Boolean)
        : [];
    } catch {
      pairingPending = 0;
      approvedPeers = [];
    }

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
          registrationMode: runtimeSettings.signalRegistrationMode,
          registrationState: runtimeSettings.signalRegistrationState,
          daemonState: runtimeSettings.signalDaemonState,
          daemonUrl: runtimeSettings.signalDaemonUrl,
          dmPolicy: "pairing",
          allowGroups: false,
          pairingPending,
          approvedPeers,
          linkUri: runtimeSettings.signalLinkUri,
          lastError: runtimeSettings.signalLastError,
          lastStartedAt: runtimeSettings.signalLastStartedAt
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
      return;
    }

    if (config.providerId === "llamacpp-default") {
      await this.registerLlamaCppProvider(config.modelId, config.contextWindow ?? 8192);
      return;
    }

    await this.selectPrimaryModel(config.modelId);
  }
}

export const openclawService = new OpenClawService();
