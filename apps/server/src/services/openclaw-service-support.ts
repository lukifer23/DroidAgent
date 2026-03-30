import type {
  ContextManagementStatus,
  HarnessStatus,
  ChatMessage,
  SessionSummary,
} from "@droidagent/shared";
import {
  ChatMessageSchema,
  ContextManagementStatusSchema,
  SessionSummarySchema,
  nowIso,
} from "@droidagent/shared";

import { appStateService } from "./app-state-service.js";
import { getConfigPathValue } from "./openclaw-config.js";
import {
  dedupeMessageParts,
  extractAttachmentPayload,
  parseMessageParts,
  publicAttachmentsFromPayload,
  renderHistoryContent,
  resolveIsoTimestamp,
  resolveMessageRole,
  stripGeneratedAttachmentInstructions,
  structuredPartsFromContent,
} from "./openclaw-message-parts.js";
import {
  CODING_PROFILE_TOOLS,
  MEMORY_FLUSH_PROMPT,
  MEMORY_FLUSH_SYSTEM_PROMPT,
  MEMORY_RECALL_EXTRA_PATHS,
  MESSAGING_PROFILE_TOOLS,
  MINIMAL_PROFILE_TOOLS,
} from "./openclaw-workspace.js";

export const GATEWAY_READY_RETRIES = 5;
export const GATEWAY_READY_DELAY_MS = 800;
export const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
export const OPENCLAW_STREAM_TIMEOUT_MS = 60_000;
export const OPENCLAW_GATEWAY_CALL_TIMEOUT_MS = 20_000;
export const RELAY_QUEUE_SOFT_LIMIT = 24;
export const DEFAULT_CONTEXT_WINDOW = 200000;
export const CHANNEL_STATUS_TTL_MS = 5_000;
export const MEMORY_STATUS_TTL_MS = 5_000;
export const DEFAULT_WEB_SESSION_ID = "web:operator";
export const INTERNAL_SESSION_IDS = new Set(["agent:main:main"]);
export const OPERATOR_EXEC_ALLOWLIST_PATTERNS = [
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

export interface OpenClawMemorySourceCount {
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

export interface OpenClawMemoryStatusEntry {
  agentId?: string;
  status?: OpenClawMemoryStatusRecord;
  embeddingProbe?: {
    ok?: boolean;
    error?: string;
  };
}

export function extractEventData(block: string): string | null {
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

export function extractDeltaText(payload: unknown): string {
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

export function extractDeltaToolNames(payload: unknown): string[] {
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
    ? ((delta as { tool_calls: Array<Record<string, unknown>> }).tool_calls ??
      [])
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

export function extractStreamError(payload: unknown): string | null {
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

export function renderPreviewValue(
  preview: unknown,
  lastMessage: unknown,
): string {
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

export function isInternalSessionRecord(
  item: Record<string, unknown>,
  sessionKey: string,
): boolean {
  if (INTERNAL_SESSION_IDS.has(sessionKey)) {
    return true;
  }

  const displayName = String(item.displayName ?? item.title ?? "").toLowerCase();
  const origin = item.origin as Record<string, unknown> | undefined;
  const originProvider = String(origin?.provider ?? "").toLowerCase();
  const originLabel = String(origin?.label ?? "").toLowerCase();

  return (
    displayName === "heartbeat" ||
    originProvider === "heartbeat" ||
    originLabel === "heartbeat"
  );
}

export function resolveSessionScope(
  sessionKey: string,
): SessionSummary["scope"] {
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

export function operatorSession(updatedAt = nowIso()): SessionSummary {
  return SessionSummarySchema.parse({
    id: DEFAULT_WEB_SESSION_ID,
    title: "Operator Chat",
    scope: "web",
    updatedAt,
    unreadCount: 0,
    lastMessagePreview: "Start a fresh DroidAgent session.",
  });
}

export function resolveHarnessToolProfile(
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

export function resolveModelRef(value: unknown): string | null {
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

export function resolveProfileTools(
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
  const allowed = getConfigPathValue(currentConfig, "tools.allow") ?? [];
  if (Array.isArray(allowed)) {
    for (const entry of allowed) {
      if (typeof entry === "string" && entry.trim()) {
        tools.push(entry);
      }
    }
  }

  return [...new Set(tools)];
}

export function parseHistoryMessage(
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

export function isAnthropicPruningCandidate(
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

export function resolveContextWindow(params: {
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

export function buildContextManagementStatus(params: {
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

export function todayMemoryNoteTemplate(date: string): string {
  return `# ${date}\n\n- Durable notes for this day.\n`;
}

export function buildContextManagementConfig(status: ContextManagementStatus) {
  return status.enabled
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
}

export function buildContextPruningConfig(params: {
  status: ContextManagementStatus;
  providerId: string;
  modelId: string;
}) {
  if (
    params.status.pruningMode !== "cache-ttl" ||
    !isAnthropicPruningCandidate(params.providerId, params.modelId)
  ) {
    return {
      mode: "off",
    };
  }

  return {
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
  };
}

export function buildMemorySearchConfigFromSettings(
  runtimeSettings: Awaited<ReturnType<typeof appStateService.getRuntimeSettings>>,
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
