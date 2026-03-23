import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import {
  ApprovalRecordSchema,
  ChannelConfigSummarySchema,
  ChannelStatusSchema,
  RuntimeStatusSchema,
  SessionSummarySchema,
  nowIso,
  type ApprovalRecord,
  type ChannelConfigSummary,
  type ChannelStatus,
  type SessionSummary
} from "@droidagent/shared";

import { OPENCLAW_GATEWAY_PORT, OPENCLAW_GATEWAY_URL, OPENCLAW_PROFILE, baseEnv, paths, resolveOpenClawBin } from "../env.js";
import { CommandError, runCommand } from "../lib/process.js";
import { appStateService } from "./app-state-service.js";

function stringifyConfigValue(value: unknown): string {
  return JSON.stringify(value);
}

export class OpenClawService {
  private gatewayProcess: ChildProcess | null = null;
  private gatewayToken: string | null = null;

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
        env: { OPENCLAW_GATEWAY_TOKEN: await this.ensureGatewayToken() }
      });
      return result.stdout;
    } catch (error) {
      if (allowFailure && error instanceof CommandError) {
        return error.stdout || error.stderr;
      }
      throw error;
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

    await this.execOpenClaw(["config", "set", "gateway.auth.token", stringifyConfigValue(await this.ensureGatewayToken()), "--strict-json"]);
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
      const parsed = JSON.parse(output);
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
        env: {
          ...baseEnv(),
          OLLAMA_API_KEY: "ollama-local"
        },
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
    const parsed = JSON.parse(output);
    if ("error" in parsed && parsed.error) {
      throw new Error(typeof parsed.error?.message === "string" ? parsed.error.message : "OpenClaw gateway call failed.");
    }
    return parsed;
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
            lastMessagePreview: String(item.lastMessagePreview ?? (item.lastMessage as { text?: unknown } | undefined)?.text ?? "")
          });
        })
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    } catch {
      return [];
    }
  }

  async loadChatHistory(sessionKey: string) {
    const response = await this.callGateway<{ messages?: Array<Record<string, unknown>> }>("chat.history", {
      sessionKey,
      limit: 150
    });

    const messages = Array.isArray(response.messages) ? response.messages : [];
    return messages.map((message, index) => ({
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
      status: "complete" as const,
      source: "openclaw" as const
    }));
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
    let statuses: ChannelStatus[] = [
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
          enabled: signalRows.some((row) => row.enabled !== false),
          configured: signalRows.length > 0,
          health: signalRows.some((row) => row.ok === false) ? "warn" : "ok",
          healthMessage: signalRows.length > 0 ? "Signal channel detected in OpenClaw." : "Signal is not configured yet.",
          metadata: {}
        })
      );
    } catch {
      statuses.push(
        ChannelStatusSchema.parse({
          id: "signal",
          label: "Signal",
          enabled: false,
          configured: false,
          health: "warn",
          healthMessage: "Signal is not configured yet.",
          metadata: {}
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
          phoneNumber: runtimeSettings.signalPhoneNumber,
          dmPolicy: "pairing",
          allowGroups: false,
          pairingPending,
          approvedPeers
        }
      })
    };
  }

  async configureSignal(params: { cliPath: string; phoneNumber: string }): Promise<void> {
    await this.execOpenClaw([
      "channels",
      "add",
      "--channel",
      "signal",
      "--cli-path",
      params.cliPath,
      "--signal-number",
      params.phoneNumber
    ]);
    await appStateService.updateRuntimeSettings({
      signalCliPath: params.cliPath,
      signalPhoneNumber: params.phoneNumber
    });
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
    await this.execOpenClaw(["models", "set", `ollama/${modelId}`]);
  }
}

export const openclawService = new OpenClawService();
