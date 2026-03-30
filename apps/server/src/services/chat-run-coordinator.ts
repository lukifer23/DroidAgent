import type { ChatSendRequest } from "@droidagent/shared";

import { createMeasuredStreamRelay } from "../lib/chat-relay-metrics.js";
import { harnessService } from "./harness-service.js";
import { sessionLifecycleService } from "./session-lifecycle-service.js";

export interface ChatRunPublisher {
  publishChatDelta(sessionId: string, runId: string, delta: string): void;
  publishChatRun(params: {
    sessionId: string;
    runId: string;
    stage:
      | "accepted"
      | "streaming"
      | "tool_call"
      | "tool_result"
      | "approval_required"
      | "completed"
      | "failed";
    label: string;
    detail?: string | null;
    toolName?: string | null;
    approvalId?: string | null;
    active?: boolean;
  }): void;
  publishChatDone(sessionId: string, runId: string): void;
  publishChatError(sessionId: string, runId: string, message: string): void;
  pushChatHistory(sessionId: string): Promise<void>;
  publishSessionsUpdated(): Promise<void>;
  publishPerformanceUpdated(): Promise<void>;
}

async function convergePostRun(
  publisher: ChatRunPublisher,
  sessionId: string,
): Promise<void> {
  await publisher.pushChatHistory(sessionId);
  await publisher.publishSessionsUpdated();
  await publisher.publishPerformanceUpdated();
}

export class ChatRunCoordinator {
  async send(params: {
    publisher: ChatRunPublisher;
    transport: "http" | "ws";
    sessionId: string;
    request: ChatSendRequest;
  }): Promise<{ runId: string }> {
    const { publisher, request, sessionId, transport } = params;
    await sessionLifecycleService.observeSession(sessionId, {
      restore: true,
    });

    let runId = "";
    const pendingRunEvents: Array<(resolvedRunId: string) => Promise<void>> = [];
    const runWithResolvedId = async (
      work: (resolvedRunId: string) => Promise<void>,
    ): Promise<void> => {
      if (!runId) {
        pendingRunEvents.push(work);
        return;
      }
      await work(runId);
    };
    const measuredRelay = createMeasuredStreamRelay(transport, sessionId, {
      onState: async (state) => {
        await runWithResolvedId(async (resolvedRunId) => {
          publisher.publishChatRun({
            sessionId,
            runId: resolvedRunId,
            ...state,
          });
        });
      },
      onFirstDelta: async () => {
        await publisher.publishPerformanceUpdated();
      },
      onDelta: async (delta) => {
        await runWithResolvedId(async (resolvedRunId) => {
          publisher.publishChatDelta(sessionId, resolvedRunId, delta);
        });
      },
      onDone: async () => {
        await runWithResolvedId(async (resolvedRunId) => {
          publisher.publishChatDone(sessionId, resolvedRunId);
          await convergePostRun(publisher, sessionId);
        });
      },
      onError: async (message) => {
        await runWithResolvedId(async (resolvedRunId) => {
          publisher.publishChatError(sessionId, resolvedRunId, message);
          await convergePostRun(publisher, sessionId);
        });
      },
    });

    const run = await harnessService.sendMessage(sessionId, request, measuredRelay.relay);
    runId = run.runId;
    for (const pendingRunEvent of pendingRunEvents.splice(0)) {
      await pendingRunEvent(run.runId);
    }
    measuredRelay.markAccepted();
    publisher.publishChatRun({
      sessionId,
      runId,
      stage: "accepted",
      label: "Run accepted",
      detail: "OpenClaw accepted the request and is starting the live run.",
      active: true,
    });
    return { runId };
  }

  async abort(params: {
    publisher: ChatRunPublisher;
    sessionId: string;
  }): Promise<void> {
    await harnessService.abortMessage(params.sessionId);
    await convergePostRun(params.publisher, params.sessionId);
  }
}

export const chatRunCoordinator = new ChatRunCoordinator();
