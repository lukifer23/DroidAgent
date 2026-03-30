import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatSendRequest } from "@droidagent/shared";

const mocks = vi.hoisted(() => ({
  observeSession: vi.fn(),
  sendMessage: vi.fn(),
  abortMessage: vi.fn(),
}));

vi.mock("./session-lifecycle-service.js", () => ({
  sessionLifecycleService: {
    observeSession: mocks.observeSession,
  },
}));

vi.mock("./harness-service.js", () => ({
  harnessService: {
    sendMessage: mocks.sendMessage,
    abortMessage: mocks.abortMessage,
  },
}));

import { ChatRunCoordinator } from "./chat-run-coordinator.js";

function createPublisher() {
  return {
    publishChatDelta: vi.fn(),
    publishChatRun: vi.fn(),
    publishChatDone: vi.fn(),
    publishChatError: vi.fn(),
    pushChatHistory: vi.fn(async () => {}),
    publishSessionsUpdated: vi.fn(async () => {}),
    publishPerformanceUpdated: vi.fn(async () => {}),
  };
}

describe("ChatRunCoordinator", () => {
  const request: ChatSendRequest = {
    text: "hello",
    attachments: [],
  };

  beforeEach(() => {
    mocks.observeSession.mockReset();
    mocks.sendMessage.mockReset();
    mocks.abortMessage.mockReset();
  });

  it("uses a single send path and converges on done", async () => {
    const coordinator = new ChatRunCoordinator();
    const publisher = createPublisher();
    mocks.sendMessage.mockImplementation(async (_sessionId, _request, relay) => {
      await relay.onState?.({
        stage: "streaming",
        label: "Streaming",
      });
      await relay.onDelta("first");
      await relay.onDone();
      return { runId: "run-1" };
    });

    const result = await coordinator.send({
      publisher,
      transport: "ws",
      sessionId: "web:operator",
      request,
    });

    expect(result.runId).toBe("run-1");
    expect(mocks.observeSession).toHaveBeenCalledWith("web:operator", {
      restore: true,
    });
    expect(publisher.publishChatDone).toHaveBeenCalledWith("web:operator", "run-1");
    expect(publisher.pushChatHistory).toHaveBeenCalledWith("web:operator");
    expect(publisher.publishSessionsUpdated).toHaveBeenCalledTimes(1);
    expect(publisher.publishPerformanceUpdated).toHaveBeenCalledTimes(2);
  });

  it("uses the same convergence path for abort", async () => {
    const coordinator = new ChatRunCoordinator();
    const publisher = createPublisher();

    await coordinator.abort({
      publisher,
      sessionId: "web:operator",
    });

    expect(mocks.abortMessage).toHaveBeenCalledWith("web:operator");
    expect(publisher.pushChatHistory).toHaveBeenCalledWith("web:operator");
    expect(publisher.publishSessionsUpdated).toHaveBeenCalledTimes(1);
    expect(publisher.publishPerformanceUpdated).toHaveBeenCalledTimes(1);
  });
});
