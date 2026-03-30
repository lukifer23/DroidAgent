import { describe, expect, it } from "vitest";

import { chatRunStore } from "./chat-run-store";

describe("chatRunStore", () => {
  it("does not emit when the incoming run state is unchanged", () => {
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

      expect(events).toHaveLength(1);
    } finally {
      unsubscribe();
      chatRunStore.clear(sessionId);
    }
  });
});
