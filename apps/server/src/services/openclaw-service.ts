import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import {
  ApprovalRecordSchema,
  ChannelConfigSummarySchema,
  ChannelStatusSchema,
  ChatMessageSchema,
  ChatSendRequestSchema,
  ContextManagementStatusSchema,
  HarnessStatusSchema,
  MemoryStatusSchema,
  RuntimeStatusSchema,
  SignalHealthCheckSchema,
  SignalPendingPairingSchema,
  SessionSummarySchema,
  nowIso,
  type ApprovalRecord,
  type ChannelConfigSummary,
  type ChannelStatus,
  type ChatMessage,
  type ChatSendRequest,
  type ContextManagementStatus,
  type HarnessStatus,
  type MemoryStatus,
  type SessionSummary,
} from "@droidagent/shared";

import {
  OPENCLAW_GATEWAY_HTTP_URL,
  OPENCLAW_GATEWAY_PORT,
  OPENCLAW_GATEWAY_URL,
  OPENCLAW_PROFILE,
  baseEnv,
  paths,
  resolveOpenClawBin,
} from "../env.js";
import {
  CommandError,
  findProcesses,
  runCommand,
  terminateProcesses,
} from "../lib/process.js";
import { ollamaModelSupportsVision } from "../lib/ollama.js";
import { TtlCache } from "../lib/ttl-cache.js";
import {
  DEFAULT_OLLAMA_VISION_MODEL,
  appStateService,
} from "./app-state-service.js";
import { attachmentService } from "./attachment-service.js";
import type {
  HarnessRuntimeModelConfig,
  StreamRelayCallbacks,
} from "./harness-service.js";
import { keychainService } from "./keychain-service.js";
import {
  buildAttachmentPrompt,
  dedupeMessageParts,
  extractAttachmentPayload,
  parseMessageParts,
  publicAttachmentsFromPayload,
  renderHistoryContent,
  resolveIsoTimestamp,
  resolveMessageRole,
  stripGeneratedAttachmentInstructions,
  structuredPartsFromContent,
  type GatewayAttachmentRecord,
} from "./openclaw-message-parts.js";
import {
  configValueEquals,
  getConfigPathValue,
  hashConfigFingerprint,
  setConfigPathValue,
  stringifyConfigValue,
} from "./openclaw-config.js";
import { performanceService } from "./performance-service.js";
import {
  CODING_PROFILE_TOOLS,
  MEMORY_FLUSH_PROMPT,
  MEMORY_FLUSH_SYSTEM_PROMPT,
  MEMORY_RECALL_EXTRA_PATHS,
  MESSAGING_PROFILE_TOOLS,
  MINIMAL_PROFILE_TOOLS,
  WORKSPACE_BOOTSTRAP_EXTRA_FILES,
  WORKSPACE_BOOTSTRAP_FILES,
} from "./openclaw-workspace.js";

const GATEWAY_READY_RETRIES = 5;
const GATEWAY_READY_DELAY_MS = 800;
const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
const OPENCLAW_STREAM_TIMEOUT_MS = 60_000;
const OPENCLAW_GATEWAY_CALL_TIMEOUT_MS = 20_000;
const RELAY_QUEUE_SOFT_LIMIT = 24;
const DEFAULT_CONTEXT_WINDOW = 200000;
const CHANNEL_STATUS_TTL_MS = 5_000;
const MEMORY_STATUS_TTL_MS = 5_000;
const DEFAULT_WEB_SESSION_ID = "web:operator";
const INTERNAL_SESSION_IDS = new Set(["agent:main:main"]);
const OPERATOR_EXEC_ALLOWLIST_PATTERNS = [
  "df*",
  "/bin/df*",
  "/usr/bin/df*",
  "du*",
  "/usr/bin/du*",
  "stat*",
  "/usr/bin/stat*",
  "uname*",
  "/usr/bin/uname*",
  "diskutil*",
  "/usr/sbin/diskutil*",
  "system_profiler*",
  "/usr/sbin/system_profiler*",
  "sysctl*",
  "/usr/sbin/sysctl*",
  "ls*",
  "/bin/ls*",
  "/usr/bin/ls*",
  "pwd*",
  "/bin/pwd*",
  "/usr/bin/pwd*",
  "whoami*",
  "/usr/bin/whoami*",
  "mount*",
  "/sbin/mount*",
  "/usr/sbin/mount*",
] as const;

interface OpenClawMemorySourceCount {
  source: string;
  files: number;
  chunks: number;
}

interface OpenClawMemoryStatusRecord {
  files?: number;
  chunks?: number;
  dirty?: boolean;
  provider?: string;
  model?: string;
  requestedProvider?: string;
  providerUnavailableReason?: string;
  sourceCounts?: Array<{
    source?: string;
    files?: number;
    chunks?: number;
  }>;
  vector?: {
    enabled?: boolean;
    available?: boolean;
  };
}

interface OpenClawMemoryStatusEntry {
  agentId?: string;
  status?: OpenClawMemoryStatusRecord;
  embeddingProbe?: {
    ok?: boolean;
    error?: string;
  };
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
          if (
            part &&
            typeof part === "object" &&
            typeof (part as { text?: unknown }).text === "string"
          ) {
            return (part as { text: string }).text;
          }
          return "";
        })
        .join("");
    }
  }

  return "";
}

function extractDeltaToolNames(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const choices = Array.isArray((payload as { choices?: unknown }).choices)
    ? ((payload as { choices: Array<Record<string, unknown>> }).choices ?? [])
    : [];
  const delta = choices[0]?.delta;
  if (!delta || typeof delta !== "object") {
    return [];
  }

  const toolCalls = Array.isArray(
    (delta as { tool_calls?: unknown; toolCalls?: unknown }).tool_calls,
  )
    ? ((delta as { tool_calls: Array<Record<string, unknown>> }).tool_calls ?? [])
    : Array.isArray((delta as { toolCalls?: unknown }).toolCalls)
      ? ((delta as { toolCalls: Array<Record<string, unknown>> }).toolCalls ??
        [])
      : [];

  return toolCalls
    .map((entry) => {
      const name =
        typeof entry?.name === "string"
          ? entry.name
          : typeof entry?.function === "object" &&
              entry.function &&
              typeof (entry.function as { name?: unknown }).name === "string"
            ? ((entry.function as { name: string }).name ?? null)
            : null;
      return name?.trim() || null;
    })
    .filter((value): value is string => Boolean(value));
}

function extractStreamError(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (
    "error" in payload &&
    payload.error &&
    typeof payload.error === "object" &&
    typeof (payload.error as { message?: unknown }).message === "string"
  ) {
    return (payload.error as { message: string }).message;
  }

  return null;
}

function formatStructuredValue(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2);
      } catch {
        return value;
      }
    }
    return value;
  }

  if (value === null || value === undefined) {
    return "";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function collectTextParts(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim() ? [value] : [];
  }

  if (value === null || value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectTextParts(entry));
  }

  if (typeof value !== "object") {
    return [String(value)];
  }

  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : null;

  if (type === "text" && typeof record.text === "string") {
    return record.text.trim() ? [record.text] : [];
  }

  if (type === "toolCall") {
    const name = typeof record.name === "string" ? record.name : "tool";
    const renderedArguments = formatStructuredValue(record.arguments);
    return renderedArguments
      ? [`Tool call: ${name}\n${renderedArguments}`]
      : [`Tool call: ${name}`];
  }

  if (type === "toolResult") {
    const lines = collectTextParts(
      record.content ?? record.text ?? record.result ?? record.output,
    );
    if (lines.length > 0) {
      return [`Tool result\n${lines.join("\n\n")}`];
    }
    const renderedResult = formatStructuredValue(
      record.result ?? record.output ?? record.content,
    );
    return renderedResult ? [`Tool result\n${renderedResult}`] : [];
  }

  if (typeof record.text === "string") {
    return record.text.trim() ? [record.text] : [];
  }

  if ("content" in record) {
    const contentLines = collectTextParts(record.content);
    if (contentLines.length > 0) {
      return contentLines;
    }
  }

  if ("result" in record || "output" in record) {
    const rendered = formatStructuredValue(record.result ?? record.output);
    return rendered ? [rendered] : [];
  }

  return [formatStructuredValue(record)];
}

function collapsePreview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 140);
}

function renderPreviewValue(preview: unknown, lastMessage: unknown): string {
  if (typeof preview === "string" && preview.trim()) {
    return collapsePreview(stripGeneratedAttachmentInstructions(preview));
  }

  if (typeof lastMessage === "string" && lastMessage.trim()) {
    return collapsePreview(lastMessage);
  }

  if (
    lastMessage &&
    typeof lastMessage === "object" &&
    !Array.isArray(lastMessage)
  ) {
    return collapsePreview(
      renderHistoryContent(lastMessage as Record<string, unknown>),
    );
  }

  if (Array.isArray(lastMessage)) {
    return collapsePreview(
      stripGeneratedAttachmentInstructions(
        collectTextParts(lastMessage).join("\n\n"),
      ),
    );
  }

  return "";
}
function isInternalSessionRecord(
  item: Record<string, unknown>,
  sessionKey: string,
): boolean {
  if (INTERNAL_SESSION_IDS.has(sessionKey)) {
    return true;
  }

  const displayName = String(
    item.displayName ?? item.title ?? "",
  ).toLowerCase();
  const origin = item.origin as Record<string, unknown> | undefined;
  const originProvider = String(origin?.provider ?? "").toLowerCase();
  const originLabel = String(origin?.label ?? "").toLowerCase();

  return (
    displayName === "heartbeat" ||
    originProvider === "heartbeat" ||
    originLabel === "heartbeat"
  );
}

function resolveSessionScope(sessionKey: string): SessionSummary["scope"] {
  if (sessionKey.startsWith("signal")) {
    return "signal";
  }
  if (sessionKey.startsWith("web:")) {
    return "web";
  }
  if (sessionKey.startsWith("global:")) {
    return "global";
  }
  return "main";
}

function operatorSession(updatedAt = nowIso()): SessionSummary {
  return SessionSummarySchema.parse({
    id: DEFAULT_WEB_SESSION_ID,
    title: "Operator Chat",
    scope: "web",
    updatedAt,
    unreadCount: 0,
    lastMessagePreview: "Start a fresh DroidAgent session.",
  });
}

function resolveHarnessToolProfile(
  profile: unknown,
): HarnessStatus["toolProfile"] {
  if (
    profile === "minimal" ||
    profile === "coding" ||
    profile === "messaging" ||
    profile === "full"
  ) {
    return profile;
  }

  if (profile === null || profile === undefined || profile === "") {
    return "unknown";
  }

  return "custom";
}

function resolveModelRef(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value;
  }

  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { primary?: unknown }).primary === "string"
  ) {
    return (value as { primary: string }).primary;
  }

  return null;
}

function resolveProfileTools(
  profile: HarnessStatus["toolProfile"],
  currentConfig: Record<string, unknown> | null,
): string[] {
  const tools: string[] =
    profile === "minimal"
      ? [...MINIMAL_PROFILE_TOOLS]
      : profile === "coding"
        ? [...CODING_PROFILE_TOOLS]
        : profile === "messaging"
          ? [...MESSAGING_PROFILE_TOOLS]
          : [];
  const allowed =
    getConfigPathValue(currentConfig, "tools.allow") ?? [];
  if (Array.isArray(allowed)) {
    for (const entry of allowed) {
      if (typeof entry === "string" && entry.trim()) {
        tools.push(entry);
      }
    }
  }

  return [...new Set(tools)];
}

function parseHistoryMessage(
  sessionKey: string,
  message: Record<string, unknown>,
  index: number,
): ChatMessage {
  const role = resolveMessageRole(message.role);
  const rawContent = message.content ?? message.text;
  const renderedText = renderHistoryContent(message);
  const { payload } = extractAttachmentPayload(
    collectTextParts(rawContent).join("\n\n") ||
      (typeof message.text === "string" ? message.text : ""),
  );
  const attachments = publicAttachmentsFromPayload(payload);
  const structuredParts =
    typeof rawContent === "string"
      ? role === "tool" && renderedText.trim()
        ? [
            {
              type: "tool_result_summary" as const,
              toolName: null,
              summary: "Tool returned output",
              details: renderedText.trim(),
            },
          ]
        : []
      : structuredPartsFromContent(rawContent, role);
  const parts =
    structuredParts.length > 0
      ? dedupeMessageParts([
          ...(attachments.length > 0
            ? [
                {
                  type: "attachments" as const,
                  attachments,
                },
              ]
            : []),
          ...structuredParts,
        ])
      : dedupeMessageParts(parseMessageParts({
          text: renderedText,
          attachments,
          role,
          status: "complete",
        }));

  return ChatMessageSchema.parse({
    id: String(message.id ?? `${sessionKey}-${index}`),
    sessionId: sessionKey,
    role,
    text: renderedText,
    parts,
    attachments,
    createdAt: resolveIsoTimestamp(message),
    status: "complete",
    source: "openclaw",
  });
}

function isAnthropicPruningCandidate(
  providerId: string,
  modelId: string,
): boolean {
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
  runtimeSettings: Awaited<
    ReturnType<typeof appStateService.getRuntimeSettings>
  >;
}): number {
  if (
    typeof params.contextWindow === "number" &&
    Number.isFinite(params.contextWindow) &&
    params.contextWindow > 0
  ) {
    return params.contextWindow;
  }

  if (params.providerId === "llamacpp-default") {
    return params.runtimeSettings.llamaCppContextWindow;
  }

  if (params.providerId === "ollama-default") {
    return params.runtimeSettings.ollamaContextWindow;
  }

  return DEFAULT_CONTEXT_WINDOW;
}

function buildContextManagementStatus(params: {
  enabled: boolean;
  providerId: string;
  modelId: string;
  contextWindow: number;
}): ContextManagementStatus {
  const reserveTokensFloor = Math.min(
    24000,
    Math.max(2048, Math.floor(params.contextWindow * 0.25)),
  );
  const softThresholdTokens = Math.min(
    6000,
    Math.max(512, Math.floor(params.contextWindow * 0.08)),
  );
  const pruningMode =
    params.enabled &&
    isAnthropicPruningCandidate(params.providerId, params.modelId)
      ? "cache-ttl"
      : "off";

  return ContextManagementStatusSchema.parse({
    enabled: params.enabled,
    compactionMode: params.enabled ? "safeguard" : "default",
    pruningMode,
    memoryFlushEnabled: params.enabled,
    reserveTokensFloor,
    softThresholdTokens,
  });
}

export function todayMemoryNoteName(): string {
  return new Date().toISOString().slice(0, 10);
}

function todayMemoryNoteTemplate(date: string): string {
  return `# ${date}\n\n- Durable notes for this day.\n`;
}

export class OpenClawService {
  private gatewayProcess: ChildProcess | null = null;
  private gatewayLogStream: fs.WriteStream | null = null;
  private gatewayLogQueue: Promise<void> = Promise.resolve();
  private gatewayToken: string | null = null;
  private ensureConfiguredPromise: Promise<void> | null = null;
  private ensureExecAllowlistPromise: Promise<void> | null = null;
  private cachedConfig: Record<string, unknown> | null = null;
  private cachedConfigMtimeMs = -1;
  private lastConfiguredHash: string | null = null;
  private lastConfiguredConfigMtimeMs = -1;
  private cachedEnvContent: string | null = null;
  private lastKnownMemoryStatus: MemoryStatus | null = null;
  private activeRuns = new Map<
    string,
    { controller: AbortController; runId: string }
  >();
  private readonly channelStatusesCache = new TtlCache<{
    statuses: ChannelStatus[];
    config: ChannelConfigSummary;
  }>(CHANNEL_STATUS_TTL_MS);
  private readonly memoryStatusCache = new TtlCache<MemoryStatus>(
    MEMORY_STATUS_TTL_MS,
  );

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

  private queueGatewayLogWrite(chunk: string | Buffer): void {
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

  private closeGatewayLogStream(): void {
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
      await this.ensureGatewayToken(),
    ]);

    return JSON.parse(output) as { version?: string };
  }

  private async inspectGatewayPortOwner(): Promise<{
    pid: number;
    command: string;
  } | null> {
    const result = await runCommand(
      "lsof",
      ["-nP", `-iTCP:${OPENCLAW_GATEWAY_PORT}`, "-sTCP:LISTEN", "-Fp"],
      { okExitCodes: [0, 1] },
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
      const processInfo = await runCommand(
        "ps",
        ["-o", "command=", "-p", pid],
        { okExitCodes: [0, 1] },
      );
      const command = processInfo.stdout.trim() || "process";
      return {
        pid: Number(pid),
        command,
      };
    } catch {
      return {
        pid: Number(pid),
        command: "process",
      };
    }
  }

  private isManagedOpenClawCommand(command: string): boolean {
    const normalized = command.trim();
    if (!normalized || !/openclaw/i.test(normalized)) {
      return false;
    }

    const markers = [
      OPENCLAW_PROFILE,
      paths.openClawStateDir,
      paths.openClawConfigPath,
      paths.workspaceRoot,
      "ai.openclaw.droidagent",
      `--profile ${OPENCLAW_PROFILE}`,
    ].filter((value): value is string => Boolean(value));

    return markers.some((marker) => normalized.includes(marker));
  }

  private async cleanupManagedOpenClawProcesses(
    params: {
      excludePids?: number[];
      includeTrackedGateway?: boolean;
    } = {},
  ): Promise<void> {
    const exclude = new Set(
      (params.excludePids ?? [])
        .filter((pid) => Number.isInteger(pid) && pid > 0),
    );
    if (
      params.includeTrackedGateway !== true &&
      this.gatewayProcess?.pid &&
      this.gatewayProcess.exitCode === null
    ) {
      exclude.add(this.gatewayProcess.pid);
    }

    const processes = await findProcesses(
      (processInfo) =>
        processInfo.pid !== process.pid &&
        !exclude.has(processInfo.pid) &&
        this.isManagedOpenClawCommand(processInfo.command),
    );

    if (processes.length === 0) {
      return;
    }

    await terminateProcesses(
      processes.map((processInfo) => processInfo.pid),
      {
        timeoutMs: 2_000,
      },
    );
  }

  private buildGatewayPortConflictMessage(owner: {
    pid: number;
    command: string;
  }): string {
    const portDetails = `Port ${OPENCLAW_GATEWAY_PORT} is owned by ${owner.command} (pid ${owner.pid}).`;
    const guidance = /openclaw/i.test(owner.command)
      ? "A different OpenClaw service is already using the configured DroidAgent gateway port. Stop the conflicting service or change DROIDAGENT_OPENCLAW_PORT."
      : "Another local process is already using the configured DroidAgent gateway port. Stop the conflicting service or change DROIDAGENT_OPENCLAW_PORT.";

    return `${guidance} ${portDetails}`;
  }

  private async explainGatewayFailure(
    error: unknown,
    options: {
      expectedPid?: number | null;
      includePortConflicts?: boolean;
    } = {},
  ): Promise<{
    message: string;
    portOwner: { pid: number; command: string } | null;
  }> {
    const fallbackMessage =
      error instanceof Error ? error.message : "Gateway is not yet reachable.";
    const shouldInspectPort =
      options.includePortConflicts &&
      /token mismatch|abnormal closure|connect failed|not yet reachable/i.test(
        fallbackMessage,
      );

    if (!shouldInspectPort) {
      return {
        message: fallbackMessage,
        portOwner: null,
      };
    }

    const owner = await this.inspectGatewayPortOwner();
    if (!owner) {
      return {
        message: fallbackMessage,
        portOwner: null,
      };
    }

    if (options.expectedPid && owner.pid === options.expectedPid) {
      return {
        message: fallbackMessage,
        portOwner: owner,
      };
    }

    return {
      message: this.buildGatewayPortConflictMessage(owner),
      portOwner: owner,
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

  private async execOpenClaw(
    args: string[],
    allowFailure = false,
    timeoutMs?: number,
  ): Promise<string> {
    try {
      const result = await runCommand(
        this.openclawBin,
        this.profileArgs(args),
        {
          env: await this.openclawEnv(),
          ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
        },
      );
      return result.stdout;
    } catch (error) {
      if (allowFailure && error instanceof CommandError) {
        return error.stdout || error.stderr;
      }
      throw error;
    }
  }

  private async ensureOperatorExecAllowlist(): Promise<void> {
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

  private async openclawEnv(): Promise<NodeJS.ProcessEnv> {
    return {
      ...baseEnv(),
      ...(await keychainService.getProcessEnv()),
      OPENCLAW_GATEWAY_TOKEN: await this.ensureGatewayToken(),
      OLLAMA_API_KEY: "ollama-local",
    };
  }

  private async gatewayHeaders(sessionKey: string): Promise<HeadersInit> {
    return {
      accept: "text/event-stream",
      authorization: `Bearer ${await this.ensureGatewayToken()}`,
      "content-type": "application/json",
      "x-openclaw-agent-id": "main",
      "x-openclaw-session-key": sessionKey,
    };
  }

  private resolveWorkspaceRoot(
    runtimeSettings: Awaited<
      ReturnType<typeof appStateService.getRuntimeSettings>
    >,
  ): string {
    return path.resolve(runtimeSettings.workspaceRoot ?? paths.workspaceRoot);
  }

  private async ensureWorkspaceScaffold(workspaceRoot: string): Promise<void> {
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

  private async resolveOllamaMultimodalConfig(
    runtimeSettings: Awaited<
      ReturnType<typeof appStateService.getRuntimeSettings>
    >,
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

  private buildMemorySearchConfig(
    runtimeSettings: Awaited<
      ReturnType<typeof appStateService.getRuntimeSettings>
    >,
  ) {
    return {
      provider: "ollama",
      fallback: "none",
      model: runtimeSettings.ollamaEmbeddingModel,
      cache: {
        enabled: true,
        maxEntries: 50000,
      },
      experimental: {
        sessionMemory: true,
      },
      extraPaths: [...MEMORY_RECALL_EXTRA_PATHS],
      sources: ["memory", "sessions"],
      sync: {
        sessions: {
          deltaBytes: 100000,
          deltaMessages: 50,
        },
      },
    };
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

  private async loadOpenClawMemoryStatus(params: {
    deep?: boolean;
    index?: boolean;
  } = {}): Promise<OpenClawMemoryStatusEntry | null> {
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

  private resolvePrimaryModel(
    runtimeSettings: Awaited<
      ReturnType<typeof appStateService.getRuntimeSettings>
    >,
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

  private async currentContextManagementStatus(
    overrides: Partial<HarnessRuntimeModelConfig> = {},
  ): Promise<ContextManagementStatus> {
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
    const contextWindow = resolveContextWindow({
      providerId,
      ...(typeof overrides.contextWindow === "number"
        ? { contextWindow: overrides.contextWindow }
        : {}),
      runtimeSettings,
    });

    return buildContextManagementStatus({
      enabled: runtimeSettings.smartContextManagementEnabled,
      providerId,
      modelId,
      contextWindow,
    });
  }

  private async currentMemoryStatus(params: {
    liveQuery?: "deep" | "shallow" | "skip";
  } = {}): Promise<MemoryStatus> {
    const runtimeSettings = await appStateService.getRuntimeSettings();
    const workspaceRoot = this.resolveWorkspaceRoot(runtimeSettings);
    const currentConfig = this.readCurrentConfig();
    const previousStatus = this.lastKnownMemoryStatus;
    const bootstrapFiles = WORKSPACE_BOOTSTRAP_FILES.map(([relativePath]) => {
      const targetPath = path.join(workspaceRoot, relativePath);
      return {
        path: relativePath,
        exists: fs.existsSync(targetPath),
      };
    });
    const memoryDirectory = path.join(workspaceRoot, "memory");
    const skillsDirectory = path.join(workspaceRoot, "skills");
    const memoryDirectoryReady = fs.existsSync(memoryDirectory);
    const skillsDirectoryReady = fs.existsSync(skillsDirectory);
    const bootstrapFilesReady = bootstrapFiles.filter(
      (file) => file.exists,
    ).length;
    const memorySearchConfig = getConfigPathValue(
      currentConfig,
      "agents.defaults.memorySearch",
    ) as Record<string, unknown> | undefined;
    const cacheConfig =
      memorySearchConfig &&
      typeof memorySearchConfig === "object" &&
      !Array.isArray(memorySearchConfig)
        ? (memorySearchConfig.cache as Record<string, unknown> | undefined)
        : undefined;
    const experimentalConfig =
      memorySearchConfig &&
      typeof memorySearchConfig === "object" &&
      !Array.isArray(memorySearchConfig)
        ? (memorySearchConfig.experimental as Record<string, unknown> | undefined)
        : undefined;
    const contextWindow = resolveContextWindow({
      providerId: runtimeSettings.activeProviderId,
      runtimeSettings,
    });
    const configuredProvider =
      memorySearchConfig &&
      typeof memorySearchConfig === "object" &&
      !Array.isArray(memorySearchConfig) &&
      typeof memorySearchConfig.provider === "string"
        ? memorySearchConfig.provider
        : null;
    const configuredModel =
      memorySearchConfig &&
      typeof memorySearchConfig === "object" &&
      !Array.isArray(memorySearchConfig) &&
      typeof memorySearchConfig.model === "string"
        ? memorySearchConfig.model
        : null;
    const configuredFallback =
      memorySearchConfig &&
      typeof memorySearchConfig === "object" &&
      !Array.isArray(memorySearchConfig) &&
      typeof memorySearchConfig.fallback === "string"
        ? memorySearchConfig.fallback
        : null;
    const liveMemoryStatus =
      params.liveQuery === "skip"
        ? null
        : await this.loadOpenClawMemoryStatus(
            params.liveQuery === "deep"
              ? {
                  deep: true,
                }
              : {},
          );
    const liveStatus = liveMemoryStatus?.status;
    const sourceCounts: OpenClawMemorySourceCount[] =
      liveStatus?.sourceCounts?.map((entry) => ({
        source: entry.source ?? "unknown",
        files:
          typeof entry.files === "number" && Number.isFinite(entry.files)
            ? Math.max(0, Math.trunc(entry.files))
            : 0,
        chunks:
          typeof entry.chunks === "number" && Number.isFinite(entry.chunks)
            ? Math.max(0, Math.trunc(entry.chunks))
            : 0,
      })) ?? previousStatus?.sourceCounts ?? [];
    const indexedFiles =
      typeof liveStatus?.files === "number" && Number.isFinite(liveStatus.files)
        ? Math.max(0, Math.trunc(liveStatus.files))
        : previousStatus?.indexedFiles ??
          sourceCounts.reduce((total, entry) => total + entry.files, 0);
    const indexedChunks =
      typeof liveStatus?.chunks === "number" && Number.isFinite(liveStatus.chunks)
        ? Math.max(0, Math.trunc(liveStatus.chunks))
        : previousStatus?.indexedChunks ??
          sourceCounts.reduce((total, entry) => total + entry.chunks, 0);
    const embeddingProvider =
      typeof liveStatus?.provider === "string"
        ? liveStatus.provider
        : previousStatus?.embeddingProvider ?? configuredProvider;
    const embeddingRequestedProvider =
      typeof liveStatus?.requestedProvider === "string"
        ? liveStatus.requestedProvider
        : previousStatus?.embeddingRequestedProvider ?? configuredProvider;
    const embeddingModel =
      typeof liveStatus?.model === "string"
        ? liveStatus.model
        : previousStatus?.embeddingModel ?? configuredModel;
    const embeddingProbeOk =
      typeof liveMemoryStatus?.embeddingProbe?.ok === "boolean"
        ? liveMemoryStatus.embeddingProbe.ok
        : previousStatus?.embeddingProbeOk ?? null;
    const embeddingProbeError =
      typeof liveMemoryStatus?.embeddingProbe?.error === "string"
        ? liveMemoryStatus.embeddingProbe.error
        : typeof liveStatus?.providerUnavailableReason === "string"
          ? liveStatus.providerUnavailableReason
          : previousStatus?.embeddingProbeError ?? null;
    const vectorEnabled =
      liveStatus?.vector?.enabled ?? previousStatus?.vectorEnabled ?? false;
    const vectorAvailable =
      liveStatus?.vector?.available ?? previousStatus?.vectorAvailable ?? false;
    const prepareStatus = await appStateService.getMemoryPrepareStatus();
    const scaffoldReady =
      memoryDirectoryReady &&
      skillsDirectoryReady &&
      bootstrapFilesReady === bootstrapFiles.length;
    const semanticReady =
      scaffoldReady &&
      cacheConfig?.enabled === true &&
      embeddingProvider === "ollama" &&
      embeddingRequestedProvider === "ollama" &&
      Boolean(embeddingModel) &&
      vectorEnabled &&
      vectorAvailable &&
      embeddingProbeOk !== false &&
      !embeddingProbeError;

    const status = MemoryStatusSchema.parse({
      configuredWorkspaceRoot: runtimeSettings.workspaceRoot ?? null,
      effectiveWorkspaceRoot: workspaceRoot,
      ready: scaffoldReady,
      semanticReady,
      memoryDirectory,
      memoryDirectoryReady,
      skillsDirectory,
      skillsDirectoryReady,
      memoryFilePath: path.join(workspaceRoot, "MEMORY.md"),
      todayNotePath: path.join(
        memoryDirectory,
        `${todayMemoryNoteName()}.md`,
      ),
      bootstrapFiles,
      bootstrapFilesReady,
      bootstrapFilesTotal: bootstrapFiles.length,
      memorySearchEnabled: cacheConfig?.enabled === true,
      sessionMemoryEnabled: experimentalConfig?.sessionMemory === true,
      embeddingProvider,
      embeddingRequestedProvider,
      embeddingFallback: configuredFallback,
      embeddingModel,
      indexedFiles,
      indexedChunks,
      dirty: liveStatus?.dirty ?? previousStatus?.dirty ?? false,
      vectorEnabled,
      vectorAvailable,
      embeddingProbeOk,
      embeddingProbeError,
      sourceCounts,
      contextWindow,
      prepareState: prepareStatus.state,
      prepareStartedAt: prepareStatus.startedAt,
      prepareFinishedAt: prepareStatus.finishedAt,
      prepareProgressLabel: prepareStatus.progressLabel,
      prepareError: prepareStatus.error,
      lastPrepareDurationMs: prepareStatus.lastDurationMs,
    });
    this.lastKnownMemoryStatus = status;
    return status;
  }

  private readCurrentConfig(): Record<string, unknown> | null {
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

  private async ensureOpenClawEnvFile(content: string): Promise<void> {
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

  private updateCachedConfig(
    nextConfig: Record<string, unknown> | null,
  ): void {
    this.cachedConfig = nextConfig;
    this.cachedConfigMtimeMs = fs.existsSync(paths.openClawConfigPath)
      ? fs.statSync(paths.openClawConfigPath).mtimeMs
      : -1;
  }

  private async setConfigValueIfNeeded(
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

  private async applyContextManagementPolicy(
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

    const compaction = status.enabled
      ? {
          mode: "safeguard",
          timeoutSeconds: 900,
          reserveTokensFloor: status.reserveTokensFloor,
          identifierPolicy: "strict",
          postCompactionSections: ["Session Startup", "Red Lines"],
          memoryFlush: {
            enabled: true,
            softThresholdTokens: status.softThresholdTokens,
            systemPrompt: MEMORY_FLUSH_SYSTEM_PROMPT,
            prompt: MEMORY_FLUSH_PROMPT,
          },
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
            systemPrompt: MEMORY_FLUSH_SYSTEM_PROMPT,
            prompt: MEMORY_FLUSH_PROMPT,
          },
        };

    const contextPruning =
      status.pruningMode === "cache-ttl" &&
      isAnthropicPruningCandidate(providerId, modelId)
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
              tailChars: 1500,
            },
            hardClear: {
              enabled: true,
              placeholder: "[Old tool result content cleared]",
            },
            tools: {
              deny: ["browser", "canvas"],
            },
          }
        : {
            mode: "off",
          };

    let nextConfig = currentConfig;
    nextConfig = await this.setConfigValueIfNeeded(
      nextConfig,
      "agents.defaults.compaction",
      compaction,
    );
    nextConfig = await this.setConfigValueIfNeeded(
      nextConfig,
      "agents.defaults.contextPruning",
      contextPruning,
    );
    return nextConfig;
  }

  private pairingStorePath(channel = "signal"): string {
    return path.join(
      paths.openClawStateDir,
      "credentials",
      `${channel}-pairing.json`,
    );
  }

  private async listPendingPairings(channel = "signal") {
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

  private async denyPendingPairingCode(
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

  private async streamMessageRun(
    sessionKey: string,
    message: string,
    runId: string,
    controller: AbortController,
    relay: StreamRelayCallbacks,
  ): Promise<void> {
    const seenToolNames = new Set<string>();
    let firstDeltaSeen = false;
    let approvalRaised = false;
    let activeToolWaitMetric: ReturnType<typeof performanceService.start> | null =
      null;
    let activeToolName: string | null = null;

    const finishToolWaitMetric = (
      outcome: "ok" | "warn" | "error",
      phase: "delta" | "done" | "replaced" | "abort" | "error",
    ) => {
      activeToolWaitMetric?.finish({
        outcome,
        phase,
        toolName: activeToolName,
      });
      activeToolWaitMetric = null;
      activeToolName = null;
    };

    const startToolWaitMetric = (toolName: string) => {
      if (activeToolWaitMetric) {
        finishToolWaitMetric("warn", "replaced");
      }
      activeToolName = toolName;
      activeToolWaitMetric = performanceService.start(
        "server",
        "chat.run.toolWait",
        {
          sessionId: sessionKey,
          toolName,
        },
      );
    };

    const timeoutController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      timeoutController.abort(
        new Error(
          `OpenClaw stream exceeded ${OPENCLAW_STREAM_TIMEOUT_MS} ms without completing.`,
        ),
      );
    }, OPENCLAW_STREAM_TIMEOUT_MS);
    timeoutHandle.unref?.();

    try {
      const streamSignal = AbortSignal.any([
        controller.signal,
        timeoutController.signal,
      ]);
      let relayQueue = Promise.resolve();
      let relayQueueDepth = 0;
      let relayFailure: Error | null = null;
      const enqueueRelay = (
        work: () => Promise<void> | void,
      ): Promise<void> => {
        relayQueueDepth += 1;
        relayQueue = relayQueue
          .then(async () => {
            if (relayFailure) {
              return;
            }
            try {
              await work();
            } catch (error) {
              relayFailure =
                error instanceof Error
                  ? error
                  : new Error("OpenClaw relay callback failed.");
            } finally {
              relayQueueDepth = Math.max(0, relayQueueDepth - 1);
            }
          })
          .catch(() => {});

        if (relayQueueDepth >= RELAY_QUEUE_SOFT_LIMIT) {
          return relayQueue;
        }
        return Promise.resolve();
      };
      const throwIfRelayFailed = () => {
        if (relayFailure) {
          throw relayFailure;
        }
      };

      const response = await fetch(
        `${OPENCLAW_GATEWAY_HTTP_URL}${CHAT_COMPLETIONS_PATH}`,
        {
          method: "POST",
          headers: await this.gatewayHeaders(sessionKey),
          body: JSON.stringify({
            model: "openclaw",
            stream: true,
            messages: [
              {
                role: "user",
                content: message,
              },
            ],
          }),
          signal: streamSignal,
        },
      );

      if (!response.ok) {
        const responseText = await response
          .text()
          .catch(() => response.statusText);
        throw new Error(
          responseText || `OpenClaw stream failed with ${response.status}.`,
        );
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
            const streamError = extractStreamError(parsed);
            if (streamError) {
              throw new Error(streamError);
            }

            const toolNames = extractDeltaToolNames(parsed);
            for (const toolName of toolNames) {
              if (seenToolNames.has(toolName)) {
                continue;
              }
              seenToolNames.add(toolName);
              startToolWaitMetric(toolName);
              await enqueueRelay(() =>
                relay.onState?.({
                stage: "tool_call",
                label: `Using ${toolName}`,
                detail: `OpenClaw called the ${toolName} tool.`,
                toolName,
                active: true,
                }),
              );
              throwIfRelayFailed();
            }

            const delta = extractDeltaText(parsed);
            if (delta) {
              if (activeToolWaitMetric) {
                finishToolWaitMetric("ok", "delta");
              }
              if (!firstDeltaSeen) {
                firstDeltaSeen = true;
                await enqueueRelay(() =>
                  relay.onState?.({
                  stage: "streaming",
                  label:
                    seenToolNames.size > 0
                      ? "Working through tool output"
                      : "Reply streaming",
                  detail:
                    seenToolNames.size > 0
                      ? "The live harness is returning output."
                      : "The model started replying.",
                  active: true,
                  }),
                );
                throwIfRelayFailed();
              }

              if (
                !approvalRaised &&
                /Approval required/i.test(delta)
              ) {
                approvalRaised = true;
                const approvalId =
                  delta.match(/Approval required\s+\(id\s+([^)]+)\)/i)?.[1] ??
                  null;
                await enqueueRelay(() =>
                  relay.onState?.({
                  stage: "approval_required",
                  label: "Approval required",
                  detail: delta.trim(),
                  approvalId,
                  active: true,
                  }),
                );
                throwIfRelayFailed();
              }
              await enqueueRelay(() => relay.onDelta(delta));
              throwIfRelayFailed();
            }
          } catch (error) {
            if (error instanceof SyntaxError) {
              // Ignore malformed SSE frames from the local gateway and keep the stream alive.
              continue;
            }
            throw error;
          }
        }
      }

      const trailing = extractEventData(buffer);
      if (trailing && trailing !== "[DONE]") {
        try {
          const parsed = JSON.parse(trailing) as unknown;
          const streamError = extractStreamError(parsed);
          if (streamError) {
            throw new Error(streamError);
          }

          const toolNames = extractDeltaToolNames(parsed);
          for (const toolName of toolNames) {
            if (seenToolNames.has(toolName)) {
              continue;
            }
            seenToolNames.add(toolName);
            startToolWaitMetric(toolName);
            await enqueueRelay(() =>
              relay.onState?.({
              stage: "tool_call",
              label: `Using ${toolName}`,
              detail: `OpenClaw called the ${toolName} tool.`,
              toolName,
              active: true,
              }),
            );
            throwIfRelayFailed();
          }

          const delta = extractDeltaText(parsed);
          if (delta) {
            if (activeToolWaitMetric) {
              finishToolWaitMetric("ok", "delta");
            }
            if (!firstDeltaSeen) {
              firstDeltaSeen = true;
              await enqueueRelay(() =>
                relay.onState?.({
                stage: "streaming",
                label: "Reply streaming",
                detail: "The model started replying.",
                active: true,
                }),
              );
              throwIfRelayFailed();
            }
            await enqueueRelay(() => relay.onDelta(delta));
            throwIfRelayFailed();
          }
        } catch (error) {
          if (error instanceof SyntaxError) {
            // ignore malformed trailing data
          } else {
            throw error;
          }
        }
      }

      if (activeToolWaitMetric) {
        finishToolWaitMetric("ok", "done");
      }
      await enqueueRelay(() =>
        relay.onState?.({
        stage: seenToolNames.size > 0 ? "tool_result" : "completed",
        label:
          seenToolNames.size > 0
            ? "Tool output received"
            : "Reply complete",
        detail:
          seenToolNames.size > 0
            ? "OpenClaw finished the tool-assisted reply."
            : "The live run completed successfully.",
        active: false,
        }),
      );
      await relayQueue;
      throwIfRelayFailed();
      await relay.onDone();
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") {
        if (activeToolWaitMetric) {
          finishToolWaitMetric("warn", "abort");
        }
        await relay.onState?.({
          stage: "completed",
          label: "Run stopped",
          detail: "The active run was cancelled.",
          active: false,
        });
        await relay.onDone();
        return;
      }

      if (activeToolWaitMetric) {
        finishToolWaitMetric("error", "error");
      }
      await relay.onState?.({
        stage: "failed",
        label: "Run failed",
        detail:
          error instanceof Error ? error.message : "OpenClaw stream failed.",
        active: false,
      });
      await relay.onError(
        error instanceof Error ? error.message : "OpenClaw stream failed.",
      );
    } finally {
      clearTimeout(timeoutHandle);
      const active = this.activeRuns.get(sessionKey);
      if (active?.runId === runId) {
        this.activeRuns.delete(sessionKey);
      }
    }
  }

  async ensureConfigured(): Promise<void> {
    if (this.ensureConfiguredPromise) {
      await this.ensureConfiguredPromise;
      return;
    }

    this.ensureConfiguredPromise = this.ensureConfiguredInternal().finally(() => {
      this.ensureConfiguredPromise = null;
    });
    await this.ensureConfiguredPromise;
  }

  private async ensureConfiguredInternal(): Promise<void> {
    fs.mkdirSync(paths.openClawStateDir, { recursive: true });
    await this.ensureOpenClawEnvFile("OLLAMA_API_KEY=ollama-local\n");
    const runtimeSettings = await appStateService.getRuntimeSettings();
    const workspaceRoot = this.resolveWorkspaceRoot(runtimeSettings);
    await this.ensureWorkspaceScaffold(workspaceRoot);
    const multimodalConfig = await this.resolveOllamaMultimodalConfig(
      runtimeSettings,
    );
    const gatewayToken = await this.ensureGatewayToken();

    const desiredConfig: Array<[string, unknown]> = [
      ["gateway.mode", "local"],
      ["gateway.port", OPENCLAW_GATEWAY_PORT],
      ["gateway.bind", "loopback"],
      ["gateway.auth.mode", "token"],
      ["gateway.http.endpoints.chatCompletions.enabled", true],
      ["agents.defaults.workspace", workspaceRoot],
      [
        "agents.defaults.model.primary",
        this.resolvePrimaryModel(runtimeSettings),
      ],
      [
        "agents.defaults.imageModel.primary",
        `ollama/${multimodalConfig.attachmentModelId}`,
      ],
      [
        "agents.defaults.pdfModel.primary",
        `ollama/${multimodalConfig.attachmentModelId}`,
      ],
      ["agents.defaults.thinkingDefault", "off"],
      ["tools.profile", "coding"],
      ["tools.allow", ["pdf"]],
      ["models.providers.ollama", multimodalConfig.providerConfig],
      [
        "agents.defaults.memorySearch",
        this.buildMemorySearchConfig(runtimeSettings),
      ],
      ["tools.exec.host", "gateway"],
      ["tools.exec.security", "allowlist"],
      ["tools.exec.ask", "on-miss"],
      ["tools.fs.workspaceOnly", true],
      [
        "hooks.internal.entries.bootstrap-extra-files.paths",
        WORKSPACE_BOOTSTRAP_EXTRA_FILES,
      ],
      ["channels.signal.dmPolicy", "pairing"],
      ["channels.signal.groupPolicy", "disabled"],
    ];

    const currentConfig = this.readCurrentConfig();
    const desiredFingerprint = hashConfigFingerprint({
      desiredConfig,
      gatewayToken,
      runtimeSettings: {
        activeProviderId: runtimeSettings.activeProviderId,
        ollamaModel: runtimeSettings.ollamaModel,
        ollamaContextWindow: runtimeSettings.ollamaContextWindow,
        llamaCppModel: runtimeSettings.llamaCppModel,
        llamaCppContextWindow: runtimeSettings.llamaCppContextWindow,
        smartContextManagementEnabled:
          runtimeSettings.smartContextManagementEnabled,
        cloudProviders: runtimeSettings.cloudProviders,
      },
    });

    if (
      currentConfig &&
      this.lastConfiguredHash === desiredFingerprint &&
      this.lastConfiguredConfigMtimeMs === this.cachedConfigMtimeMs
    ) {
      this.invalidateMemoryStatusCache();
      return;
    }

    let nextConfig = currentConfig;

    for (const [key, value] of desiredConfig) {
      nextConfig = await this.setConfigValueIfNeeded(
        nextConfig,
        key,
        value,
      );
    }

    nextConfig = await this.setConfigValueIfNeeded(
      nextConfig,
      "gateway.auth.token",
      gatewayToken,
    );

    nextConfig = await this.applyContextManagementPolicy({}, nextConfig);
    this.cachedConfig = nextConfig;
    this.lastConfiguredHash = desiredFingerprint;
    this.lastConfiguredConfigMtimeMs = this.cachedConfigMtimeMs;
    this.invalidateMemoryStatusCache();
  }

  async prepareWorkspaceContext(): Promise<MemoryStatus> {
    await this.prepareWorkspaceScaffold();
    return await this.currentMemoryStatus();
  }

  async prepareWorkspaceScaffold(): Promise<{
    workspaceRoot: string;
    memoryDirectory: string;
    memoryFilePath: string;
    preferencesFilePath: string;
    todayNotePath: string;
  }> {
    const runtimeSettings = await appStateService.getRuntimeSettings();
    const workspaceRoot = this.resolveWorkspaceRoot(runtimeSettings);
    await this.ensureWorkspaceScaffold(workspaceRoot);
    this.invalidateMemoryStatusCache();
    const memoryDirectory = path.join(workspaceRoot, "memory");
    return {
      workspaceRoot,
      memoryDirectory,
      memoryFilePath: path.join(workspaceRoot, "MEMORY.md"),
      preferencesFilePath: path.join(workspaceRoot, "PREFERENCES.md"),
      todayNotePath: path.join(memoryDirectory, `${todayMemoryNoteName()}.md`),
    };
  }

  async prepareSemanticMemory(
    params: { reindex?: boolean } = {},
  ): Promise<MemoryStatus> {
    const runtimeSettings = await appStateService.getRuntimeSettings();
    const workspaceRoot = this.resolveWorkspaceRoot(runtimeSettings);
    await this.ensureWorkspaceScaffold(workspaceRoot);
    await this.ensureConfigured();
    await this.loadOpenClawMemoryStatus({
      deep: true,
      index: params.reindex ?? false,
    });
    this.invalidateMemoryStatusCache();
    return await this.currentMemoryStatus({
      liveQuery: "deep",
    });
  }

  async reindexMemory(params: { force?: boolean } = {}): Promise<MemoryStatus> {
    const runtimeSettings = await appStateService.getRuntimeSettings();
    const workspaceRoot = this.resolveWorkspaceRoot(runtimeSettings);
    await this.ensureWorkspaceScaffold(workspaceRoot);
    await this.ensureConfigured();
    const metric = performanceService.start("server", "memory.reindex", {
      force: params.force === true,
    });
    const args = ["memory", "index"];
    if (params.force) {
      args.push("--force");
    }
    try {
      await this.execOpenClaw(args, true);
      this.invalidateMemoryStatusCache();
      const status = await this.currentMemoryStatus({
        liveQuery: "deep",
      });
      metric.finish({
        outcome: "ok",
        indexedFiles: status.indexedFiles,
        indexedChunks: status.indexedChunks,
        dirty: status.dirty,
      });
      return status;
    } catch (error) {
      metric.finish({
        outcome: "error",
      });
      throw error;
    }
  }

  async memoryStatus(): Promise<MemoryStatus> {
    return await this.memoryStatusCache.get(async () => {
      const runtimeSettings = await appStateService.getRuntimeSettings();
      const workspaceRoot = this.resolveWorkspaceRoot(runtimeSettings);
      await this.ensureWorkspaceScaffold(workspaceRoot);
      return await this.currentMemoryStatus({
        liveQuery: "shallow",
      });
    });
  }

  async memoryStatusQuick(): Promise<MemoryStatus> {
    const runtimeSettings = await appStateService.getRuntimeSettings();
    const workspaceRoot = this.resolveWorkspaceRoot(runtimeSettings);
    await this.ensureWorkspaceScaffold(workspaceRoot);
    return await this.currentMemoryStatus({
      liveQuery: "skip",
    });
  }

  async ensureTodayMemoryNote(): Promise<string> {
    const runtimeSettings = await appStateService.getRuntimeSettings();
    const workspaceRoot = this.resolveWorkspaceRoot(runtimeSettings);
    await this.ensureWorkspaceScaffold(workspaceRoot);
    const date = todayMemoryNoteName();
    const notePath = path.join(workspaceRoot, "memory", `${date}.md`);
    try {
      await fs.promises.access(notePath, fs.constants.F_OK);
    } catch {
      await fs.promises.writeFile(notePath, todayMemoryNoteTemplate(date), "utf8");
    }
    this.invalidateMemoryStatusCache();
    return notePath;
  }

  async harnessStatus(): Promise<HarnessStatus> {
    const runtimeSettings = await appStateService.getRuntimeSettings();
    const currentConfig = this.readCurrentConfig();
    const toolProfile = resolveHarnessToolProfile(
      getConfigPathValue(currentConfig, "tools.profile") ?? "coding",
    );
    const memorySearchConfig = getConfigPathValue(
      currentConfig,
      "agents.defaults.memorySearch",
    ) as Record<string, unknown> | null;
    const cacheConfig =
      memorySearchConfig &&
      typeof memorySearchConfig === "object" &&
      !Array.isArray(memorySearchConfig)
        ? (memorySearchConfig.cache as Record<string, unknown> | undefined)
        : undefined;
    const experimentalConfig =
      memorySearchConfig &&
      typeof memorySearchConfig === "object" &&
      !Array.isArray(memorySearchConfig)
        ? (memorySearchConfig.experimental as Record<string, unknown> | undefined)
        : undefined;

    return HarnessStatusSchema.parse({
      configured: currentConfig !== null,
      agentId: "main",
      defaultSessionId: DEFAULT_WEB_SESSION_ID,
      gatewayAuthMode:
        typeof getConfigPathValue(currentConfig, "gateway.auth.mode") === "string"
          ? (getConfigPathValue(currentConfig, "gateway.auth.mode") as string)
          : "token",
      gatewayBind:
        typeof getConfigPathValue(currentConfig, "gateway.bind") === "string"
          ? (getConfigPathValue(currentConfig, "gateway.bind") as string)
          : "loopback",
      activeModel: this.resolvePrimaryModel(runtimeSettings),
      contextWindow: resolveContextWindow({
        providerId: runtimeSettings.activeProviderId,
        runtimeSettings,
      }),
      thinkingDefault:
        typeof getConfigPathValue(
          currentConfig,
          "agents.defaults.thinkingDefault",
        ) === "string"
          ? (getConfigPathValue(
              currentConfig,
              "agents.defaults.thinkingDefault",
            ) as string)
          : "off",
      imageModel: resolveModelRef(
        getConfigPathValue(currentConfig, "agents.defaults.imageModel"),
      ),
      pdfModel: resolveModelRef(
        getConfigPathValue(currentConfig, "agents.defaults.pdfModel"),
      ),
      workspaceRoot: this.resolveWorkspaceRoot(runtimeSettings),
      toolProfile,
      availableTools: resolveProfileTools(toolProfile, currentConfig),
      workspaceOnlyFs:
        getConfigPathValue(currentConfig, "tools.fs.workspaceOnly") === true,
      memorySearchEnabled: cacheConfig?.enabled === true,
      sessionMemoryEnabled: experimentalConfig?.sessionMemory === true,
      attachmentsEnabled:
        resolveModelRef(
          getConfigPathValue(currentConfig, "agents.defaults.imageModel"),
        ) !== null,
      execHost:
        typeof getConfigPathValue(currentConfig, "tools.exec.host") === "string"
          ? (getConfigPathValue(currentConfig, "tools.exec.host") as string)
          : null,
      execSecurity:
        typeof getConfigPathValue(currentConfig, "tools.exec.security") ===
        "string"
          ? (getConfigPathValue(currentConfig, "tools.exec.security") as string)
          : null,
      execAsk:
        typeof getConfigPathValue(currentConfig, "tools.exec.ask") === "string"
          ? (getConfigPathValue(currentConfig, "tools.exec.ask") as string)
          : null,
    });
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
        metadata: {},
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
        detectedVersion:
          typeof parsed.version === "string" ? parsed.version : null,
        binaryPath: openclawBin,
        health: "ok",
        healthMessage: "Gateway reachable on loopback.",
        endpoint: OPENCLAW_GATEWAY_URL,
        installed: true,
        lastStartedAt: await appStateService.getJsonSetting<string | null>(
          "openclawStartedAt",
          null,
        ),
        metadata: {},
      });
    } catch (error) {
      const failure = await this.explainGatewayFailure(error, {
        includePortConflicts: true,
      });

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
        lastStartedAt: await appStateService.getJsonSetting<string | null>(
          "openclawStartedAt",
          null,
        ),
        metadata: failure.portOwner
          ? {
              portOwnerPid: failure.portOwner.pid,
              portOwnerCommand: failure.portOwner.command,
            }
          : {},
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
    let failedPortOwnerPid: number | null = null;

    try {
      await this.gatewayHealthProbe();
      await this.ensureOperatorExecAllowlist();
      return;
    } catch (error) {
      const failure = await this.explainGatewayFailure(error, {
        includePortConflicts: true,
      });
      if (
        failure.portOwner &&
        (!this.gatewayProcess ||
          failure.portOwner.pid !== this.gatewayProcess.pid)
      ) {
        throw new Error(failure.message);
      }
      failedPortOwnerPid = failure.portOwner?.pid ?? null;
    }

    if (this.gatewayProcess && this.gatewayProcess.exitCode === null) {
      return;
    }

    await this.cleanupManagedOpenClawProcesses({
      excludePids: failedPortOwnerPid ? [failedPortOwnerPid] : [],
    });

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
        String(OPENCLAW_GATEWAY_PORT),
      ]),
      {
        env: await this.openclawEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    child.stdout.on("data", (chunk) => {
      this.queueGatewayLogWrite(chunk);
    });
    child.stderr.on("data", (chunk) => {
      this.queueGatewayLogWrite(chunk);
    });
    child.on("exit", () => {
      this.gatewayProcess = null;
      this.closeGatewayLogStream();
    });

    this.gatewayProcess = child;
    await appStateService.setJsonSetting("openclawStartedAt", nowIso());

    for (let i = 0; i < GATEWAY_READY_RETRIES; i++) {
      await new Promise((resolve) =>
        setTimeout(resolve, GATEWAY_READY_DELAY_MS * (i + 1)),
      );
      if (this.gatewayProcess?.exitCode !== null) {
        throw new Error(
          "OpenClaw gateway process exited before becoming ready.",
        );
      }
      try {
        await this.gatewayHealthProbe();
        await this.ensureOperatorExecAllowlist();
        return;
      } catch (error) {
        if (i === GATEWAY_READY_RETRIES - 1) {
          const failure = await this.explainGatewayFailure(error, {
            expectedPid: child.pid ?? null,
            includePortConflicts: true,
          });
          throw new Error(
            failure.message === (error instanceof Error ? error.message : "")
              ? "OpenClaw gateway did not become ready in time."
              : failure.message,
          );
        }
      }
    }
  }

  async stopGateway(): Promise<void> {
    if (this.gatewayProcess && this.gatewayProcess.exitCode === null) {
      this.gatewayProcess.kill("SIGTERM");
      this.gatewayProcess = null;
    }
    this.closeGatewayLogStream();
    await this.cleanupManagedOpenClawProcesses({
      includeTrackedGateway: true,
    });
  }

  async callGateway<T>(
    method: string,
    params: Record<string, unknown> = {},
    expectFinal = false,
  ): Promise<T> {
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
      JSON.stringify(params),
    ];

    if (expectFinal) {
      args.splice(3, 0, "--expect-final");
    }

    const output = await this.execOpenClaw(
      args,
      false,
      OPENCLAW_GATEWAY_CALL_TIMEOUT_MS,
    );
    const parsed = JSON.parse(output) as Record<string, unknown>;
    if ("error" in parsed && parsed.error) {
      const errorDetails = parsed.error as { message?: unknown };
      throw new Error(
        typeof errorDetails?.message === "string"
          ? errorDetails.message
          : "OpenClaw gateway call failed.",
      );
    }
    return parsed as T;
  }

  async listSessions(): Promise<SessionSummary[]> {
    try {
      const response = (await this.callGateway<unknown>("sessions.list", {
        limit: 24,
        includeDerivedTitles: true,
        includeLastMessage: true,
      })) as Array<Record<string, unknown>>;
      const list = Array.isArray(response) ? response : [];
      const sessions = list
        .filter((item) => {
          const sessionKey = String(
            item.key ?? item.sessionKey ?? item.id ?? "main",
          );
          return !isInternalSessionRecord(item, sessionKey);
        })
        .map((item) => {
          const sessionKey = String(
            item.key ?? item.sessionKey ?? item.id ?? "main",
          );
          return SessionSummarySchema.parse({
            id: sessionKey,
            title:
              sessionKey === DEFAULT_WEB_SESSION_ID
                ? "Operator Chat"
                : String(item.title ?? item.derivedTitle ?? sessionKey),
            scope: resolveSessionScope(sessionKey),
            updatedAt: resolveIsoTimestamp(item),
            unreadCount: Number(item.unreadCount ?? 0),
            lastMessagePreview: renderPreviewValue(
              item.lastMessagePreview,
              item.lastMessage,
            ),
          });
        })
        .sort((left, right) => {
          if (left.id === DEFAULT_WEB_SESSION_ID) {
            return -1;
          }
          if (right.id === DEFAULT_WEB_SESSION_ID) {
            return 1;
          }
          return right.updatedAt.localeCompare(left.updatedAt);
        });

      if (sessions.some((session) => session.id === DEFAULT_WEB_SESSION_ID)) {
        return sessions;
      }

      return [operatorSession(sessions[0]?.updatedAt ?? nowIso()), ...sessions];
    } catch {
      return [operatorSession()];
    }
  }

  async loadHistory(sessionKey: string): Promise<ChatMessage[]> {
    const response = await this.callGateway<{
      messages?: Array<Record<string, unknown>>;
    }>("chat.history", {
      sessionKey,
      limit: 150,
    });

    const messages = Array.isArray(response.messages) ? response.messages : [];
    return messages.map((message, index) =>
      parseHistoryMessage(sessionKey, message, index),
    );
  }

  async loadChatHistory(sessionKey: string) {
    return await this.loadHistory(sessionKey);
  }

  async sendMessage(
    sessionKey: string,
    request: ChatSendRequest,
    relay: StreamRelayCallbacks,
  ): Promise<{ runId: string }> {
    await this.ensureConfigured();
    await this.ensureOperatorExecAllowlist();
    if (this.activeRuns.has(sessionKey)) {
      await this.abortMessage(sessionKey);
    }

    const normalizedRequest = ChatSendRequestSchema.parse(request);
    const attachments = await Promise.all(
      normalizedRequest.attachments.map(async (attachment) => {
        const stored = await attachmentService.get(attachment.id);
        return {
          id: stored.id,
          name: stored.name,
          kind: stored.kind,
          mimeType: stored.mimeType,
          size: stored.size,
          url: stored.url,
          filePath: stored.filePath,
        } satisfies GatewayAttachmentRecord;
      }),
    );
    const message = buildAttachmentPrompt(normalizedRequest, attachments);

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
        idempotencyKey: randomUUID(),
      },
      true,
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
        await this.ensureGatewayToken(),
      ]);
      const parsed = JSON.parse(output) as {
        pending?: Array<Record<string, unknown>>;
      };
      const pending = Array.isArray(parsed.pending) ? parsed.pending : [];
      return pending.map((item) =>
        ApprovalRecordSchema.parse({
          id: String(item.id ?? randomUUID()),
          kind: "exec",
          title: "Exec approval required",
          details: JSON.stringify(item.request ?? item),
          createdAt: new Date(
            Number(item.createdAtMs ?? Date.now()),
          ).toISOString(),
          status: "pending",
          source: "openclaw",
        }),
      );
    } catch {
      return [];
    }
  }

  async resolveApproval(
    approvalId: string,
    resolution: "approved" | "denied",
  ): Promise<void> {
    await this.callGateway("exec.approval.resolve", {
      id: approvalId,
      decision: resolution === "approved" ? "allow-once" : "deny",
    });
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
        const signalRows = (
          Array.isArray(parsed.channels) ? parsed.channels : []
        ).filter((row) => row.channel === "signal");
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
                : runtimeSettings.signalLastError
                  ? "warn"
                  : signalRows.some((row) => row.ok === false)
                    ? "warn"
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
              runtimeSettings.signalLastError ??
              "Signal is not configured yet.",
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
            runtimeSettings.signalDaemonState === "running"
              ? "ok"
              : runtimeSettings.signalRegistrationState === "registered"
                ? "warn"
                : "warn",
          message:
            runtimeSettings.signalDaemonState === "running"
              ? (runtimeSettings.signalDaemonUrl ??
                "Signal daemon is reachable.")
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

  async setSmartContextManagement(
    enabled: boolean,
  ): Promise<ContextManagementStatus> {
    await appStateService.updateRuntimeSettings({
      smartContextManagementEnabled: enabled,
    });
    await this.applyContextManagementPolicy();
    return await this.contextManagementStatus();
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

  async configureRuntimeModel(
    config: HarnessRuntimeModelConfig,
  ): Promise<void> {
    if (config.providerId === "ollama-default") {
      const modelId = config.modelId.startsWith("ollama/")
        ? config.modelId.slice("ollama/".length)
        : config.modelId;
      const runtimeSettings = await appStateService.getRuntimeSettings();
      const contextWindow =
        typeof config.contextWindow === "number"
          ? config.contextWindow
          : runtimeSettings.ollamaContextWindow;
      await appStateService.updateRuntimeSettings({
        ollamaModel: modelId,
        ollamaContextWindow: contextWindow,
      });
      let nextConfig = this.readCurrentConfig();
      const multimodalConfig = await this.resolveOllamaMultimodalConfig({
        ...runtimeSettings,
        ollamaModel: modelId,
        ollamaContextWindow: contextWindow,
      });
      nextConfig = await this.setConfigValueIfNeeded(
        nextConfig,
        "agents.defaults.model.primary",
        `ollama/${modelId}`,
      );
      nextConfig = await this.setConfigValueIfNeeded(
        nextConfig,
        "agents.defaults.imageModel.primary",
        `ollama/${multimodalConfig.attachmentModelId}`,
      );
      nextConfig = await this.setConfigValueIfNeeded(
        nextConfig,
        "agents.defaults.pdfModel.primary",
        `ollama/${multimodalConfig.attachmentModelId}`,
      );
      await this.setConfigValueIfNeeded(
        nextConfig,
        "models.providers.ollama",
        multimodalConfig.providerConfig,
      );
      await this.selectOllamaModel(modelId);
      await this.applyContextManagementPolicy({
        providerId: "ollama-default",
        modelId,
        contextWindow,
      });
      return;
    }

    if (config.providerId === "llamacpp-default") {
      await this.registerLlamaCppProvider(
        config.modelId,
        config.contextWindow ?? 8192,
      );
      await this.applyContextManagementPolicy({
        providerId: "llamacpp-default",
        modelId: config.modelId,
        contextWindow: config.contextWindow ?? 8192,
      });
      return;
    }

    await this.selectPrimaryModel(config.modelId);
    await this.applyContextManagementPolicy(config);
  }
}

export const openclawService = new OpenClawService();
