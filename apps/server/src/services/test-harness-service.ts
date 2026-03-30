import { randomUUID } from "node:crypto";

import {
  ChannelConfigSummarySchema,
  ChannelStatusSchema,
  ChatMessageSchema,
  HarnessStatusSchema,
  RuntimeStatusSchema,
  SessionSummarySchema,
  nowIso,
  type ApprovalRecord,
  type ChannelConfigSummary,
  type ChannelStatus,
  type ChatMessage,
  type ChatSendRequest,
  type HarnessStatus,
  type RuntimeStatus,
  type SessionSummary
} from "@droidagent/shared";

import { appStateService } from "./app-state-service.js";
import type { HarnessAdapter, HarnessRuntimeModelConfig, StreamRelayCallbacks } from "./harness-service.js";

const STREAM_CHUNK_INTERVAL_MS = 24;

interface ActiveRun {
  timer: ReturnType<typeof setTimeout> | null;
  aborted: boolean;
}

function chunkText(input: string, size = 14): string[] {
  const parts: string[] = [];
  for (let index = 0; index < input.length; index += size) {
    parts.push(input.slice(index, index + size));
  }
  return parts.length > 0 ? parts : [input];
}

function cloneMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ChatMessageSchema.parse({ ...message }));
}

function buildHarnessReply(message: string, attachmentCount: number): string {
  const runInChatMatch = message.match(
    /Run this exact workspace command now and continue using the real output[\s\S]*?```(?:bash|console|shell|sh|zsh)\n([\s\S]*?)\n```/i,
  );
  if (runInChatMatch) {
    const command = runInChatMatch[1]?.trim() ?? "";
    const printfMatch = command.match(/printf\s+['"]([^'"]+)['"]/i);
    const output = printfMatch?.[1] ?? `Executed: ${command}`;
    return [
      "I ran the exact command and continued from the real result.",
      "",
      "Command:",
      "```sh",
      command,
      "```",
      "",
      "Output:",
      "```text",
      output,
      "```",
    ].join("\n");
  }

  if (/shell block/i.test(message)) {
    return [
      "Runnable shell example:",
      "",
      "```sh",
      "printf 'suggested-job-ok'",
      "```",
    ].join("\n");
  }

  return attachmentCount > 0
    ? `Test harness reply: ${message} (${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"})`
    : `Test harness reply: ${message}`;
}

export class TestHarnessService implements HarnessAdapter {
  private readonly sessions = new Map<string, ChatMessage[]>();
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor() {
    this.reset();
  }

  reset(): void {
    for (const activeRun of this.activeRuns.values()) {
      if (activeRun.timer) {
        clearTimeout(activeRun.timer);
      }
    }
    this.activeRuns.clear();
    this.sessions.clear();

    const seededMessage = ChatMessageSchema.parse({
      id: randomUUID(),
      sessionId: "web:operator",
      role: "assistant",
      text: "DroidAgent test harness is ready.",
      parts: [
        {
          type: "markdown",
          text: "DroidAgent test harness is ready.",
        },
      ],
      createdAt: nowIso(),
      status: "complete",
      source: "openclaw"
    });
    this.sessions.set("web:operator", [seededMessage]);
  }

  async health(): Promise<RuntimeStatus> {
    return RuntimeStatusSchema.parse({
      id: "openclaw",
      label: "OpenClaw Test Harness",
      state: "running",
      enabled: true,
      installMethod: "bundledNpm",
      detectedVersion: "test-harness",
      binaryPath: null,
      health: "ok",
      healthMessage: "Deterministic harness is serving test sessions.",
      endpoint: null,
      installed: true,
      lastStartedAt: nowIso(),
      metadata: {
        testMode: true
      }
    });
  }

  async harnessStatus(): Promise<HarnessStatus> {
    const runtimeSettings = await appStateService.getRuntimeSettings();
    return HarnessStatusSchema.parse({
      configured: true,
      agentId: "main",
      defaultSessionId: "web:operator",
      gatewayAuthMode: "token",
      gatewayBind: "loopback",
      activeModel: `ollama/${runtimeSettings.ollamaModel}`,
      contextWindow: runtimeSettings.ollamaContextWindow,
      thinkingDefault: "off",
      imageModel: `ollama/${runtimeSettings.ollamaModel}`,
      pdfModel: `ollama/${runtimeSettings.ollamaModel}`,
      workspaceRoot: runtimeSettings.workspaceRoot,
      toolProfile: "coding",
      availableTools: [
        "read",
        "write",
        "edit",
        "apply_patch",
        "exec",
        "process",
        "sessions_list",
        "sessions_history",
        "sessions_send",
        "sessions_spawn",
        "sessions_yield",
        "session_status",
        "subagents",
        "memory_search",
        "memory_get",
        "image",
        "pdf"
      ],
      workspaceOnlyFs: true,
      memorySearchEnabled: true,
      sessionMemoryEnabled: true,
      attachmentsEnabled: true,
      execHost: "gateway",
      execSecurity: "allowlist",
      execAsk: "on-miss"
    });
  }

  private ensureSession(sessionKey: string): ChatMessage[] {
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      return existing;
    }

    const seeded = [
      ChatMessageSchema.parse({
        id: randomUUID(),
        sessionId: sessionKey,
        role: "assistant",
        text: `Session ${sessionKey} is ready.`,
        parts: [
          {
            type: "markdown",
            text: `Session ${sessionKey} is ready.`,
          },
        ],
        createdAt: nowIso(),
        status: "complete",
        source: "openclaw"
      })
    ];
    this.sessions.set(sessionKey, seeded);
    return seeded;
  }

  async listSessions(): Promise<SessionSummary[]> {
    return [...this.sessions.entries()]
      .map(([sessionId, messages]) => {
        const lastMessage = messages.at(-1);
        return SessionSummarySchema.parse({
          id: sessionId,
          title: sessionId === "web:operator" ? "Operator Chat" : sessionId,
          scope: sessionId === "web:operator" ? "web" : "main",
          updatedAt: lastMessage?.createdAt ?? nowIso(),
          unreadCount: 0,
          lastMessagePreview: lastMessage?.text ?? ""
        });
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async loadHistory(sessionKey: string): Promise<ChatMessage[]> {
    return cloneMessages(this.ensureSession(sessionKey));
  }

  async sendMessage(sessionKey: string, request: ChatSendRequest, relay: StreamRelayCallbacks): Promise<{ runId: string }> {
    await this.abortMessage(sessionKey);

    const session = this.ensureSession(sessionKey);
    const message = request.text.trim() || "Inspect the attached files.";
    session.push(
      ChatMessageSchema.parse({
        id: randomUUID(),
        sessionId: sessionKey,
        role: "user",
        text: message,
        parts: [
          ...(request.attachments.length > 0
            ? [
                {
                  type: "attachments" as const,
                  attachments: request.attachments,
                },
              ]
            : []),
          {
            type: "markdown" as const,
            text: message,
          },
        ],
        attachments: request.attachments,
        createdAt: nowIso(),
        status: "complete",
        source: "web"
      })
    );

    const runId = randomUUID();
    const responseText = buildHarnessReply(message, request.attachments.length);
    const runInChatMatch = message.match(
      /Run this exact workspace command now and continue using the real output[\s\S]*?```(?:bash|console|shell|sh|zsh)\n([\s\S]*?)\n```/i,
    );
    const chunks = chunkText(responseText);
    const activeRun: ActiveRun = {
      timer: null,
      aborted: false
    };
    this.activeRuns.set(sessionKey, activeRun);
    if (runInChatMatch) {
      await relay.onState?.({
        stage: "tool_call",
        label: "Running suggested command",
        detail: "The test harness is executing the suggested workspace command.",
        toolName: "exec",
        active: true,
      });
    }

    await relay.onState?.({
      stage: "streaming",
      label:
        request.attachments.length > 0
          ? "Analyzing attachments"
          : runInChatMatch
            ? "Returning command output"
            : "Reply streaming",
      detail:
        request.attachments.length > 0
          ? `Inspecting ${request.attachments.length} attachment${request.attachments.length === 1 ? "" : "s"}.`
          : runInChatMatch
            ? "The test harness is returning the real command result back into chat."
            : "The test harness started replying.",
      active: true,
    });

    const streamNext = async (index: number) => {
      const current = this.activeRuns.get(sessionKey);
      if (!current || current.aborted) {
        return;
      }

      if (index >= chunks.length) {
        session.push(
          ChatMessageSchema.parse({
            id: randomUUID(),
            sessionId: sessionKey,
            role: "assistant",
            text: responseText,
            parts: [
              {
                type: "markdown",
                text: responseText,
              },
            ],
            createdAt: nowIso(),
            status: "complete",
            source: "openclaw"
          })
        );
        this.activeRuns.delete(sessionKey);
        await relay.onState?.({
          stage: "completed",
          label: "Reply complete",
          detail: "The test harness completed the response.",
          active: false,
        });
        await relay.onDone();
        return;
      }

      await relay.onDelta(chunks[index]!);
      current.timer = setTimeout(() => {
        void streamNext(index + 1);
      }, STREAM_CHUNK_INTERVAL_MS);
    };

    activeRun.timer = setTimeout(() => {
      void streamNext(0);
    }, 0);
    return { runId };
  }

  async abortMessage(sessionKey: string): Promise<void> {
    const active = this.activeRuns.get(sessionKey);
    if (!active) {
      return;
    }

    active.aborted = true;
    if (active.timer) {
      clearTimeout(active.timer);
    }
    this.activeRuns.delete(sessionKey);
  }

  async listApprovals(): Promise<ApprovalRecord[]> {
    return [];
  }

  async resolveApproval(): Promise<void> {
    return;
  }

  async listChannels(): Promise<{ statuses: ChannelStatus[]; config: ChannelConfigSummary }> {
    const runtimeSettings = await appStateService.getRuntimeSettings();
    return {
      statuses: [
        ChannelStatusSchema.parse({
          id: "web",
          label: "Web/PWA",
          enabled: true,
          configured: true,
          health: "ok",
          healthMessage: "Primary DroidAgent interface.",
          metadata: {}
        }),
        ChannelStatusSchema.parse({
          id: "signal",
          label: "Signal",
          enabled: runtimeSettings.signalRegistrationState === "registered",
          configured: runtimeSettings.signalRegistrationState === "registered",
          health: runtimeSettings.signalRegistrationState === "registered" ? "ok" : "warn",
          healthMessage:
            runtimeSettings.signalRegistrationState === "registered"
              ? "Signal is configured."
              : "Signal is not configured in the deterministic test harness.",
          metadata: {}
        })
      ],
      config: ChannelConfigSummarySchema.parse({
        signal: {
          installed: false,
          binaryPath: null,
          javaHome: null,
          accountId: null,
          phoneNumber: null,
          deviceName: null,
          cliVersion: null,
          registrationMode: "none",
          registrationState: runtimeSettings.signalRegistrationState,
          daemonState: "stopped",
          daemonUrl: null,
          receiveMode: "persistent",
          dmPolicy: "pairing",
          allowGroups: false,
          channelConfigured: false,
          pendingPairings: [],
          linkUri: null,
          lastError: null,
          lastStartedAt: null,
          compatibilityWarning: null,
          healthChecks: []
        }
      })
    };
  }

  async configureRuntimeModel(_config: HarnessRuntimeModelConfig): Promise<void> {
    return;
  }
}

export const testHarnessService = new TestHarnessService();
