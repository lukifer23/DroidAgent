import { randomUUID } from "node:crypto";

import {
  ApprovalRecordSchema,
  ChatSendRequestSchema,
  SessionSummarySchema,
  type ApprovalRecord,
  type ChatSendRequest,
} from "@droidagent/shared";

import {
  OPENCLAW_GATEWAY_HTTP_URL,
  OPENCLAW_GATEWAY_URL,
} from "../env.js";
import { attachmentService } from "./attachment-service.js";
import type { StreamRelayCallbacks } from "./harness-service.js";
import {
  buildAttachmentPrompt,
  resolveIsoTimestamp,
  type GatewayAttachmentRecord,
} from "./openclaw-message-parts.js";
import { performanceService } from "./performance-service.js";
import {
  CHAT_COMPLETIONS_PATH,
  DEFAULT_WEB_SESSION_ID,
  OPENCLAW_STREAM_TIMEOUT_MS,
  RELAY_QUEUE_SOFT_LIMIT,
  extractDeltaText,
  extractDeltaToolNames,
  extractEventData,
  extractStreamError,
  isInternalSessionRecord,
  operatorSession,
  parseHistoryMessage,
  renderPreviewValue,
  resolveSessionScope,
} from "./openclaw-service-support.js";
import type { OpenClawService } from "./openclaw-service.js";

type OpenClawChatService = OpenClawService & {
  activeRuns: Map<string, { controller: AbortController; runId: string }>;
  gatewayHeaders(sessionKey: string): Promise<HeadersInit>;
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
  streamMessageRun(
    sessionKey: string,
    message: string,
    runId: string,
    controller: AbortController,
    relay: StreamRelayCallbacks,
  ): Promise<void>;
};

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

      const response = await fetch(
        `${OPENCLAW_GATEWAY_HTTP_URL}${CHAT_COMPLETIONS_PATH}`,
        {
          method: "POST",
          headers: await service.gatewayHeaders(sessionKey),
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
        const responseText = await response.text().catch(() => response.statusText);
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

              if (!approvalRaised && /Approval required/i.test(delta)) {
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
          if (!(error instanceof SyntaxError)) {
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
          label: seenToolNames.size > 0 ? "Tool output received" : "Reply complete",
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
        detail: error instanceof Error ? error.message : "OpenClaw stream failed.",
        active: false,
      });
      await relay.onError(
        error instanceof Error ? error.message : "OpenClaw stream failed.",
      );
    } finally {
      clearTimeout(timeoutHandle);
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
    await service.callGateway(
      "chat.send",
      {
        sessionKey,
        message,
        idempotencyKey: randomUUID(),
      },
      true,
    );
  },

  async abortMessage(this: OpenClawService, sessionKey: string) {
    const service = this as unknown as OpenClawChatService;
    const active = service.activeRuns.get(sessionKey);
    if (active) {
      active.controller.abort();
      service.activeRuns.delete(sessionKey);
    }

    try {
      await service.callGateway("chat.abort", { sessionKey }, true);
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
