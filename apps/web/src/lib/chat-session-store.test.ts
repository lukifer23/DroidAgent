import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "@droidagent/shared";

import { chatSessionStore } from "./chat-session-store";

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "message-1",
    sessionId: "session-1",
    role: "assistant",
    text: "reply",
    parts: [],
    attachments: [],
    createdAt: "2026-04-02T00:00:00.000Z",
    status: "complete",
    source: "openclaw",
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  chatSessionStore.reset();
});

describe("chatSessionStore", () => {
  it("tracks send, first token, completion, and recent feedback per session", () => {
    vi.useFakeTimers();
    chatSessionStore.trackSubmit("session-1");

    expect(chatSessionStore.getSessionSnapshot("session-1").liveFeedback).toEqual(
      expect.objectContaining({
        status: "waiting_first_token",
      }),
    );

    chatSessionStore.handleStreamDelta({
      sessionId: "session-1",
      runId: "run-1",
      delta: "partial",
    });

    const streaming = chatSessionStore.getSessionSnapshot("session-1");
    expect(streaming.streaming).toEqual({
      runId: "run-1",
      text: "partial",
    });
    expect(streaming.liveFeedback?.status).toBe("streaming");
    expect(streaming.liveFeedback?.firstTokenMs).not.toBeNull();

    chatSessionStore.handleStreamDone({
      sessionId: "session-1",
      runId: "run-1",
    });

    const completed = chatSessionStore.getSessionSnapshot("session-1");
    expect(completed.pendingSend).toBeNull();
    expect(completed.liveFeedback?.status).toBe("done");
    expect(completed.recentFeedback?.status).toBe("done");

    vi.advanceTimersByTime(12_000);
    expect(chatSessionStore.getSessionSnapshot("session-1").liveFeedback).toBeNull();
    expect(chatSessionStore.getSessionSnapshot("session-1").recentFeedback?.status).toBe("done");
  });

  it("does not clear live streaming during query refreshes, only on authoritative resync", () => {
    const messages = [makeMessage()];

    chatSessionStore.handleStreamDelta({
      sessionId: "session-1",
      runId: "run-1",
      delta: "partial",
    });

    chatSessionStore.markHistoryReady("session-1", messages);
    expect(chatSessionStore.getSessionSnapshot("session-1").streaming).toEqual({
      runId: "run-1",
      text: "partial",
    });

    chatSessionStore.handleHistoryEvent({
      sessionId: "session-1",
      messages,
    });
    expect(chatSessionStore.getSessionSnapshot("session-1").streaming).toBeNull();
  });

  it("tracks switching and history load states independently", () => {
    chatSessionStore.markSessionSwitching("session-1", true);
    expect(chatSessionStore.getSessionSnapshot("session-1").switching).toBe(true);

    chatSessionStore.markHistoryLoading("session-1");
    expect(chatSessionStore.getSessionSnapshot("session-1").historyStatus).toBe("loading");

    chatSessionStore.markHistoryLoading("session-1", { resync: true });
    expect(chatSessionStore.getSessionSnapshot("session-1").historyStatus).toBe("resyncing");

    chatSessionStore.markHistoryReady("session-1", []);
    const ready = chatSessionStore.getSessionSnapshot("session-1");
    expect(ready.historyStatus).toBe("ready");
    expect(ready.switching).toBe(false);
  });
});
