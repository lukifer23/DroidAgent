import { randomUUID } from "node:crypto";

import {
  ApprovalRecordSchema,
  ChatSendRequestSchema,
  SessionSummarySchema,
  type ApprovalRecord,
  type ChatSendRequest,
} from "@droidagent/shared";

import { OPENCLAW_GATEWAY_URL } from "../env.js";
import { attachmentService } from "./attachment-service.js";
import type { StreamRelayCallbacks } from "./harness-service.js";
import {
  buildAttachmentPrompt,
  resolveIsoTimestamp,
  type GatewayAttachmentRecord,
} from "./openclaw-message-parts.js";
import { performanceService } from "./performance-service.js";
import {
  DEFAULT_WEB_SESSION_ID,
  OPENCLAW_STREAM_TIMEOUT_MS,
  RELAY_QUEUE_SOFT_LIMIT,
  isInternalSessionRecord,
  operatorSession,
  parseHistoryMessage,
  renderPreviewValue,
  resolveSessionScope,
} from "./openclaw-service-support.js";
import type { OpenClawService } from "./openclaw-service.js";

type OpenClawChatService = OpenClawService & {
  activeRuns: Map<string, { controller: AbortController; runId: string }>;
  ensureConfigured(): Promise<void>;
  ensureOperatorExecAllowlist(): Promise<void>;
  callGateway<T>(
    method: string,
    params?: Record<string, unknown>,
    expectFinal?: boolean,
  ): Promise<T>;
  execOpenClaw(
    args: string[],
    allowFailure?: boolean,
    timeoutMs?: number,
  ): Promise<string>;
  ensureGatewayToken(): Promise<string>;
  subscribeToLiveGatewayEvents(
    listener: (event: {
      event: string;
      payload: unknown;
      seq?: number;
    }) => void,
  ): () => void;
  requestLiveGateway<T>(
    method: string,
    params?: unknown,
    opts?: {
      expectFinal?: boolean;
      timeoutMs?: number | null;
    },
  ): Promise<T>;
  streamMessageRun(
    sessionKey: string,
    message: string,
    runId: string,
    controller: AbortController,
    relay: StreamRelayCallbacks,
  ): Promise<void>;
};

type GatewayChatEventRecord = {
  runId?: unknown;
  sessionKey?: unknown;
  state?: unknown;
  message?: unknown;
  errorMessage?: unknown;
};

type GatewayAgentEventRecord = {
  runId?: unknown;
  stream?: unknown;
  data?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function collectStringBlocks(
  content: unknown,
  blockType: string,
  valueKey: string,
): string[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (!record || record.type !== blockType) {
      continue;
    }
    const value = record[valueKey];
    if (typeof value === "string" && value.trim()) {
      parts.push(value.trim());
    }
  }

  return parts;
}

function extractTextFromGatewayMessage(message: unknown): string {
  const record = asRecord(message);
  if (!record) {
    return "";
  }

  const content = record.content;
  if (typeof content === "string") {
    return content.trim();
  }

  const textBlocks = collectStringBlocks(content, "text", "text");
  if (textBlocks.length > 0) {
    return textBlocks.join("\n").trim();
  }

  if (record.stopReason === "error" && typeof record.errorMessage === "string") {
    return record.errorMessage.trim();
  }

  return "";
}

function isCommandMessage(message: unknown): boolean {
  const record = asRecord(message);
  return record?.command === true;
}

function approvalIdFromText(text: string): string | null {
  return text.match(/Approval required\s+\(id\s+([^)]+)\)/i)?.[1]?.trim() ?? null;
}

class GatewayStreamAssembler {
  private readonly runs = new Map<string, string>();

  ingestDelta(runId: string, message: unknown): string | null {
    const previous = this.runs.get(runId) ?? "";
    const next = extractTextFromGatewayMessage(message);
    if (!next || next === previous) {
      return null;
    }
    this.runs.set(runId, next);
    if (next.startsWith(previous)) {
      const delta = next.slice(previous.length);
      return delta || null;
    }
    return null;
  }

  finalize(runId: string, message: unknown): string | null {
    const previous = this.runs.get(runId) ?? "";
    const next = extractTextFromGatewayMessage(message);
    this.runs.delete(runId);
    if (!next || next === previous) {
      return null;
    }
    if (next.startsWith(previous)) {
      const delta = next.slice(previous.length);
      return delta || null;
    }
    return null;
  }
}

export const openClawChatMethods = {
  async streamMessageRun(
    this: OpenClawService,
    sessionKey: string,
    message: string,
    runId: string,
    controller: AbortController,
    relay: StreamRelayCallbacks,
  ): Promise<void> {
    const service = this as unknown as OpenClawChatService;
    const streamAssembler = new GatewayStreamAssembler();
    const seenToolNames = new Set<string>();
    let firstDeltaSeen = false;
    let approvalRaised = false;
    const toolWaitMetrics = new Map<
      string,
      {
        metric: ReturnType<typeof performanceService.start>;
        toolName: string;
      }
    >();

    const finishToolWaitMetric = (
      toolCallId: string,
      outcome: "ok" | "warn" | "error",
      phase: "done" | "abort" | "error",
    ) => {
      const entry = toolWaitMetrics.get(toolCallId);
      if (!entry) {
        return;
      }
      entry.metric.finish({
        outcome,
        phase,
        toolName: entry.toolName,
      });
      toolWaitMetrics.delete(toolCallId);
    };

    const finishAllToolWaitMetrics = (
      outcome: "ok" | "warn" | "error",
      phase: "done" | "abort" | "error",
    ) => {
      for (const toolCallId of [...toolWaitMetrics.keys()]) {
        finishToolWaitMetric(toolCallId, outcome, phase);
      }
    };

    const startToolWaitMetric = (toolCallId: string, toolName: string) => {
      finishToolWaitMetric(toolCallId, "warn", "abort");
      toolWaitMetrics.set(toolCallId, {
        toolName,
        metric: performanceService.start(
          "server",
          "chat.run.toolWait",
          {
            sessionId: sessionKey,
            toolName,
          },
        ),
      });
    };

    let relayQueue = Promise.resolve();
    let relayQueueDepth = 0;
    let relayFailure: Error | null = null;
    const enqueueRelay = (work: () => Promise<void> | void): Promise<void> => {
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

    const emitStreamingState = async () => {
      if (firstDeltaSeen) {
        return;
      }
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
    };

    const emitApprovalIfNeeded = async (text: string) => {
      if (approvalRaised || !/Approval required/i.test(text)) {
        return;
      }
      approvalRaised = true;
      await enqueueRelay(() =>
        relay.onState?.({
          stage: "approval_required",
          label: "Approval required",
          detail: text.trim(),
          approvalId: approvalIdFromText(text),
          active: true,
        }),
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

    let resolveStream: (() => void) | null = null;
    let rejectStream: ((error: Error) => void) | null = null;
    let settled = false;
    const finishStream = (work: () => Promise<void>): void => {
      if (settled) {
        return;
      }
      settled = true;
      void (async () => {
        await work();
        await relayQueue;
        throwIfRelayFailed();
      })()
        .then(() => {
          resolveStream?.();
        })
        .catch((error) => {
          rejectStream?.(
            error instanceof Error
              ? error
              : new Error("OpenClaw stream finalization failed."),
          );
        });
    };

    let gatewayEventQueue = Promise.resolve();
    const queueGatewayEvent = (work: () => Promise<void> | void): void => {
      gatewayEventQueue = gatewayEventQueue
        .then(async () => {
          if (settled) {
            return;
          }
          await work();
        })
        .catch((error) => {
          finishStream(async () => {
            finishAllToolWaitMetrics("error", "error");
            const errorMessage =
              error instanceof Error
                ? error.message
                : "OpenClaw gateway event handling failed.";
            await enqueueRelay(() =>
              relay.onState?.({
                stage: "failed",
                label: "Run failed",
                detail: errorMessage,
                active: false,
              }),
            );
            await enqueueRelay(() => relay.onError(errorMessage));
          });
        });
    };

    const unsubscribe = service.subscribeToLiveGatewayEvents((event) => {
      queueGatewayEvent(async () => {
        const payload = asRecord(event.payload);
        if (!payload) {
          return;
        }

        if (event.event === "agent") {
          const agentEvent = payload as GatewayAgentEventRecord;
          if (agentEvent.runId !== runId || agentEvent.stream !== "tool") {
            return;
          }
          const data = asRecord(agentEvent.data);
          const phase = typeof data?.phase === "string" ? data.phase : "";
          const toolCallId =
            typeof data?.toolCallId === "string" && data.toolCallId.trim()
              ? data.toolCallId.trim()
              : null;
          const toolName =
            typeof data?.name === "string" && data.name.trim()
              ? data.name.trim()
              : "tool";
          if (!toolCallId) {
            return;
          }

          if (phase === "start") {
            seenToolNames.add(toolName);
            startToolWaitMetric(toolCallId, toolName);
            await enqueueRelay(() =>
              relay.onState?.({
                stage: "tool_call",
                label: `Using ${toolName}`,
                detail: `OpenClaw called the ${toolName} tool.`,
                toolName,
                active: true,
              }),
            );
            return;
          }

          if (phase === "result") {
            finishToolWaitMetric(
              toolCallId,
              data?.isError === true ? "error" : "ok",
              data?.isError === true ? "error" : "done",
            );
            await enqueueRelay(() =>
              relay.onState?.({
                stage: "tool_result",
                label: `${toolName} finished`,
                detail:
                  data?.isError === true
                    ? `OpenClaw reported an error from ${toolName}.`
                    : `OpenClaw received output from ${toolName}.`,
                toolName,
                active: false,
              }),
            );
          }
          return;
        }

        if (event.event !== "chat") {
          return;
        }

        const chatEvent = payload as GatewayChatEventRecord;
        if (chatEvent.runId !== runId || chatEvent.sessionKey !== sessionKey) {
          return;
        }

        if (chatEvent.state === "delta") {
          const delta = streamAssembler.ingestDelta(runId, chatEvent.message);
          if (!delta) {
            return;
          }
          await emitStreamingState();
          await emitApprovalIfNeeded(delta);
          await enqueueRelay(() => relay.onDelta(delta));
          return;
        }

        if (chatEvent.state === "final") {
          finishStream(async () => {
            const finalDelta = isCommandMessage(chatEvent.message)
              ? null
              : streamAssembler.finalize(runId, chatEvent.message);
            if (finalDelta) {
              await emitStreamingState();
              await emitApprovalIfNeeded(finalDelta);
              await enqueueRelay(() => relay.onDelta(finalDelta));
            }
            finishAllToolWaitMetrics("ok", "done");
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
            await enqueueRelay(() => relay.onDone());
          });
          return;
        }

        if (chatEvent.state === "aborted") {
          finishStream(async () => {
            finishAllToolWaitMetrics("warn", "abort");
            await enqueueRelay(() =>
              relay.onState?.({
                stage: "completed",
                label: "Run stopped",
                detail: "The active run was cancelled.",
                active: false,
              }),
            );
            await enqueueRelay(() => relay.onDone());
          });
          return;
        }

        if (chatEvent.state === "error") {
          finishStream(async () => {
            finishAllToolWaitMetrics("error", "error");
            const errorMessage =
              typeof chatEvent.errorMessage === "string" &&
              chatEvent.errorMessage.trim()
                ? chatEvent.errorMessage.trim()
                : "OpenClaw stream failed.";
            await enqueueRelay(() =>
              relay.onState?.({
                stage: "failed",
                label: "Run failed",
                detail: errorMessage,
                active: false,
              }),
            );
            await enqueueRelay(() => relay.onError(errorMessage));
          });
        }
      });
    });

    const abortPromise = new Promise<never>((_, reject) => {
      const rejectFromSignal = (signal: AbortSignal) => {
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("OpenClaw stream aborted."),
        );
      };

      if (controller.signal.aborted) {
        rejectFromSignal(controller.signal);
      } else {
        controller.signal.addEventListener(
          "abort",
          () => {
            rejectFromSignal(controller.signal);
          },
          { once: true },
        );
      }

      if (timeoutController.signal.aborted) {
        rejectFromSignal(timeoutController.signal);
      } else {
        timeoutController.signal.addEventListener(
          "abort",
          () => {
            rejectFromSignal(timeoutController.signal);
          },
          { once: true },
        );
      }
    });

    const streamPromise = new Promise<void>((resolve, reject) => {
      resolveStream = resolve;
      rejectStream = reject;
    });

    try {
      await service.requestLiveGateway("chat.send", {
        sessionKey,
        message,
        deliver: false,
        timeoutMs: OPENCLAW_STREAM_TIMEOUT_MS,
        idempotencyKey: runId,
      });
      await Promise.race([streamPromise, abortPromise]);
    } catch (error) {
      if (settled) {
        await streamPromise;
        return;
      }

      if (controller.signal.aborted) {
        finishAllToolWaitMetrics("warn", "abort");
        await enqueueRelay(() =>
          relay.onState?.({
            stage: "completed",
            label: "Run stopped",
            detail: "The active run was cancelled.",
            active: false,
          }),
        );
        await enqueueRelay(() => relay.onDone());
        await relayQueue;
        throwIfRelayFailed();
        return;
      }

      if (timeoutController.signal.aborted) {
        finishAllToolWaitMetrics("error", "error");
        try {
          await service.requestLiveGateway("chat.abort", {
            sessionKey,
            runId,
          });
        } catch {
          // Best effort only. The local relay still closes and the next resync converges history.
        }
        const timeoutMessage =
          error instanceof Error
            ? error.message
            : "OpenClaw stream timed out before completing.";
        await enqueueRelay(() =>
          relay.onState?.({
            stage: "failed",
            label: "Run timed out",
            detail: timeoutMessage,
            active: false,
          }),
        );
        await enqueueRelay(() => relay.onError(timeoutMessage));
        await relayQueue;
        throwIfRelayFailed();
        return;
      }

      finishAllToolWaitMetrics("error", "error");
      const errorMessage =
        error instanceof Error ? error.message : "OpenClaw stream failed.";
      await enqueueRelay(() =>
        relay.onState?.({
          stage: "failed",
          label: "Run failed",
          detail: errorMessage,
          active: false,
        }),
      );
      await enqueueRelay(() => relay.onError(errorMessage));
      await relayQueue;
      throwIfRelayFailed();
    } finally {
      clearTimeout(timeoutHandle);
      unsubscribe();
      const active = service.activeRuns.get(sessionKey);
      if (active?.runId === runId) {
        service.activeRuns.delete(sessionKey);
      }
    }
  },

  async listSessions(this: OpenClawService) {
    const service = this as unknown as OpenClawChatService;
    try {
      const response = (await service.callGateway<unknown>("sessions.list", {
        limit: 24,
        includeDerivedTitles: true,
        includeLastMessage: true,
      })) as Array<Record<string, unknown>>;
      const list = Array.isArray(response) ? response : [];
      const sessions = list
        .filter((item) => {
          const sessionKey = String(item.key ?? item.sessionKey ?? item.id ?? "main");
          return !isInternalSessionRecord(item, sessionKey);
        })
        .map((item) => {
          const sessionKey = String(item.key ?? item.sessionKey ?? item.id ?? "main");
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

      return [operatorSession(sessions[0]?.updatedAt), ...sessions];
    } catch {
      return [operatorSession()];
    }
  },

  async loadHistory(this: OpenClawService, sessionKey: string) {
    const service = this as unknown as OpenClawChatService;
    const response = await service.callGateway<{
      messages?: Array<Record<string, unknown>>;
    }>("chat.history", {
      sessionKey,
      limit: 150,
    });

    const messages = Array.isArray(response.messages) ? response.messages : [];
    return messages.map((message: Record<string, unknown>, index: number) =>
      parseHistoryMessage(sessionKey, message, index),
    );
  },

  async loadChatHistory(this: OpenClawService, sessionKey: string) {
    return await openClawChatMethods.loadHistory.call(this, sessionKey);
  },

  async sendMessage(
    this: OpenClawService,
    sessionKey: string,
    request: ChatSendRequest,
    relay: StreamRelayCallbacks,
  ) {
    const service = this as unknown as OpenClawChatService;
    await service.ensureConfigured();
    await service.ensureOperatorExecAllowlist();
    if (service.activeRuns.has(sessionKey)) {
      await service.abortMessage(sessionKey);
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
    service.activeRuns.set(sessionKey, { controller, runId });
    void service.streamMessageRun(sessionKey, message, runId, controller, relay);
    return { runId };
  },

  async sendChat(this: OpenClawService, sessionKey: string, message: string) {
    const service = this as unknown as OpenClawChatService;
    await service.requestLiveGateway(
      "chat.send",
      {
        sessionKey,
        message,
        idempotencyKey: randomUUID(),
      },
      { expectFinal: true },
    );
  },

  async abortMessage(this: OpenClawService, sessionKey: string) {
    const service = this as unknown as OpenClawChatService;
    const active = service.activeRuns.get(sessionKey);
    if (active) {
      service.activeRuns.delete(sessionKey);
      try {
        active.controller.abort();
      } catch (error) {
        console.warn("Failed to abort the local OpenClaw run controller", error);
      }
    }

    try {
      await service.requestLiveGateway("chat.abort", {
        sessionKey,
        ...(active ? { runId: active.runId } : {}),
      });
    } catch {
      // Some gateway builds may not expose chat.abort; the local abort controller still ends the relay.
    }
  },

  async listApprovals(this: OpenClawService): Promise<ApprovalRecord[]> {
    const service = this as unknown as OpenClawChatService;
    try {
      const output = await service.execOpenClaw([
        "approvals",
        "get",
        "--gateway",
        "--json",
        "--url",
        OPENCLAW_GATEWAY_URL,
        "--token",
        await service.ensureGatewayToken(),
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
  },

  async resolveApproval(
    this: OpenClawService,
    approvalId: string,
    resolution: "approved" | "denied",
  ): Promise<void> {
    const service = this as unknown as OpenClawChatService;
    await service.callGateway("exec.approval.resolve", {
      id: approvalId,
      decision: resolution === "approved" ? "allow-once" : "deny",
    });
  },
};

export type OpenClawChatMethods = typeof openClawChatMethods;
