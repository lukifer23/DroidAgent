import { describe, expect, it } from "vitest";

import { chatStreamStore } from "./chat-stream-store";

describe("chatStreamStore", () => {
  it("does not emit when the streaming snapshot is unchanged", () => {
    const sessionId = "test-stream-session";
    const events: number[] = [];
    const unsubscribe = chatStreamStore.subscribe(() => {
      events.push(events.length + 1);
    });

    try {
      chatStreamStore.clear(sessionId);
      const snapshot = {
        [sessionId]: {
          runId: "run-1",
          text: "partial reply",
        },
      };

      chatStreamStore.setRuns(snapshot);
      chatStreamStore.setRuns(snapshot);

      expect(events).toHaveLength(1);
    } finally {
      unsubscribe();
      chatStreamStore.clear(sessionId);
    }
  });
});
