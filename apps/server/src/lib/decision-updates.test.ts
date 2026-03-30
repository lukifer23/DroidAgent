import { describe, expect, it, vi } from "vitest";

import type { DecisionRecord } from "@droidagent/shared";

import { publishDecisionEffects } from "./decision-updates.js";

function createPublisher() {
  return {
    publishApprovalsUpdated: vi.fn(async () => undefined),
    publishMemoryDraftsUpdated: vi.fn(async () => undefined),
    publishMemoryUpdated: vi.fn(async () => undefined),
    publishChannelUpdated: vi.fn(async () => undefined),
    publishDecisionsUpdated: vi.fn(async () => undefined),
  };
}

function createDecision(
  kind: DecisionRecord["kind"],
  overrides: Partial<DecisionRecord> = {},
): DecisionRecord {
  return {
    id: `${kind}:1`,
    kind,
    sourceSystem: "droidagent",
    sourceRef: `${kind}:source`,
    title: "Decision",
    summary: "Decision summary",
    details: null,
    status: "pending",
    requestedAt: "2026-03-30T00:00:00.000Z",
    resolvedAt: null,
    actorUserId: null,
    actorLabel: null,
    sessionId: null,
    actorSessionId: null,
    deviceLabel: null,
    resolution: null,
    sourceUpdatedAt: null,
    ...overrides,
  };
}

describe("publishDecisionEffects", () => {
  it("publishes decisions and approval updates for exec approvals", async () => {
    const publisher = createPublisher();

    await publishDecisionEffects(publisher, createDecision("execApproval"));

    expect(publisher.publishApprovalsUpdated).toHaveBeenCalledTimes(1);
    expect(publisher.publishDecisionsUpdated).toHaveBeenCalledTimes(1);
    expect(publisher.publishMemoryDraftsUpdated).not.toHaveBeenCalled();
    expect(publisher.publishMemoryUpdated).not.toHaveBeenCalled();
    expect(publisher.publishChannelUpdated).not.toHaveBeenCalled();
  });

  it("publishes decisions, memory, and draft updates for memory review decisions", async () => {
    const publisher = createPublisher();

    await publishDecisionEffects(
      publisher,
      createDecision("memoryDraftReview"),
    );

    expect(publisher.publishMemoryDraftsUpdated).toHaveBeenCalledTimes(1);
    expect(publisher.publishMemoryUpdated).toHaveBeenCalledTimes(1);
    expect(publisher.publishDecisionsUpdated).toHaveBeenCalledTimes(1);
    expect(publisher.publishApprovalsUpdated).not.toHaveBeenCalled();
    expect(publisher.publishChannelUpdated).not.toHaveBeenCalled();
  });

  it("publishes decisions and channel updates for pairing decisions", async () => {
    const publisher = createPublisher();

    await publishDecisionEffects(
      publisher,
      createDecision("channelPairing"),
    );

    expect(publisher.publishChannelUpdated).toHaveBeenCalledTimes(1);
    expect(publisher.publishDecisionsUpdated).toHaveBeenCalledTimes(1);
    expect(publisher.publishApprovalsUpdated).not.toHaveBeenCalled();
    expect(publisher.publishMemoryDraftsUpdated).not.toHaveBeenCalled();
    expect(publisher.publishMemoryUpdated).not.toHaveBeenCalled();
  });

  it("falls back to the generic decision update path for unknown future kinds", async () => {
    const publisher = createPublisher();

    await publishDecisionEffects(
      publisher,
      createDecision("ownerConfirmation"),
    );

    expect(publisher.publishDecisionsUpdated).toHaveBeenCalledTimes(1);
    expect(publisher.publishApprovalsUpdated).not.toHaveBeenCalled();
    expect(publisher.publishMemoryDraftsUpdated).not.toHaveBeenCalled();
    expect(publisher.publishMemoryUpdated).not.toHaveBeenCalled();
    expect(publisher.publishChannelUpdated).not.toHaveBeenCalled();
  });
});
