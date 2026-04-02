import { describe, expect, it, vi } from "vitest";

import { chatRunStore } from "./chat-run-store";

describe("chatRunStore", () => {
  it("does not emit when the incoming run state is unchanged", async () => {
    const sessionId = "test-run-session";
    const events: number[] = [];
    const unsubscribe = chatRunStore.subscribe(() => {
      events.push(events.length + 1);
    });

    try {
      chatRunStore.clear(sessionId);
      const run = {
        sessionId,
        runId: "run-1",
        stage: "streaming" as const,
        label: "Reply streaming",
        detail: "The model started replying.",
        toolName: null,
        approvalId: null,
        active: true,
        updatedAt: "2026-03-29T00:00:00.000Z",
      };

      chatRunStore.setRun(run);
      chatRunStore.setRun(run);

      await vi.waitFor(() => {
        expect(events).toHaveLength(1);
      });
    } finally {
      unsubscribe();
      chatRunStore.clear(sessionId);
    }
  });

  it("accumulates a short activity trail for one live run", () => {
    const sessionId = "test-run-activity-session";

    try {
      chatRunStore.clear(sessionId);
      chatRunStore.setRun({
        sessionId,
        runId: "run-2",
        stage: "accepted",
        label: "Run accepted",
        detail: "Starting the live run.",
        toolName: null,
        approvalId: null,
        active: true,
        updatedAt: "2026-03-29T00:00:00.000Z",
      });
      chatRunStore.setRun({
        sessionId,
        runId: "run-2",
        stage: "tool_call",
        label: "Using read",
        detail: "OpenClaw called the read tool.",
        toolName: "read",
        approvalId: null,
        active: true,
        updatedAt: "2026-03-29T00:00:01.000Z",
      });

      const snapshot = chatRunStore.getSnapshot()[sessionId];
      expect(snapshot?.activities).toEqual([
        expect.objectContaining({
          stage: "accepted",
        }),
        expect.objectContaining({
          stage: "tool_call",
          toolName: "read",
        }),
      ]);
    } finally {
      chatRunStore.clear(sessionId);
    }
  });
});
