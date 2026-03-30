import { describe, expect, it } from "vitest";

import type { DashboardState, DecisionRecord, MemoryDraft } from "@droidagent/shared";

import {
  getDecisionByApprovalId,
  getMemoryDraftDecisionMap,
  getPendingDecisionCount,
  getPendingDecisions,
  getPendingMemoryDraftDecisions,
  getPendingMemoryDrafts,
  getPendingPairingDecisions,
  getResolvedDecisions,
  getSessionDecisions,
} from "./dashboard-selectors.js";

function createDecision(
  kind: DecisionRecord["kind"],
  overrides: Partial<DecisionRecord> = {},
): DecisionRecord {
  return {
    id: `${kind}:1`,
    kind,
    sourceSystem: kind === "memoryDraftReview" ? "droidagent" : "openclaw",
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

function createDraft(
  id: string,
  overrides: Partial<MemoryDraft> = {},
): MemoryDraft {
  return {
    id,
    target: "memory",
    status: "pending",
    title: "Draft",
    content: "Draft content",
    sourceKind: "chatMessage",
    sourceLabel: "Chat",
    sourceRef: "msg-1",
    sessionId: "session-1",
    createdAt: "2026-03-30T00:00:00.000Z",
    updatedAt: "2026-03-30T00:00:00.000Z",
    appliedAt: null,
    dismissedAt: null,
    failedAt: null,
    lastError: null,
    appliedPath: null,
    ...overrides,
  };
}

function createDashboard(
  decisions: DecisionRecord[],
  memoryDrafts: MemoryDraft[],
): DashboardState {
  return {
    decisions,
    memoryDrafts,
  } as DashboardState;
}

describe("dashboard selectors", () => {
  it("separates pending and resolved decisions", () => {
    const pending = createDecision("execApproval");
    const resolved = createDecision("channelPairing", {
      id: "channelPairing:resolved",
      status: "approved",
      resolution: "approved",
      resolvedAt: "2026-03-30T00:01:00.000Z",
    });
    const decisions = [pending, resolved];

    expect(getPendingDecisions(decisions)).toEqual([pending]);
    expect(getResolvedDecisions(decisions)).toEqual([resolved]);
    expect(getPendingDecisionCount(createDashboard(decisions, []))).toBe(1);
  });

  it("maps pending memory draft decisions back to their drafts", () => {
    const memoryDecision = createDecision("memoryDraftReview", {
      sourceRef: "draft-1",
      sessionId: "session-1",
    });
    const pairedDraft = createDraft("draft-1");
    const unpairedDraft = createDraft("draft-2");
    const dashboard = createDashboard(
      [memoryDecision, createDecision("execApproval")],
      [unpairedDraft, pairedDraft],
    );

    expect(getPendingMemoryDraftDecisions(dashboard.decisions)).toEqual([
      memoryDecision,
    ]);
    expect(getMemoryDraftDecisionMap(dashboard.decisions).get("draft-1")).toBe(
      memoryDecision,
    );
    expect(getPendingMemoryDrafts(dashboard)).toEqual([pairedDraft]);
  });

  it("filters pairing and session-scoped decisions from the same ledger", () => {
    const sessionExec = createDecision("execApproval", {
      id: "execApproval:session",
      sourceRef: "approval-1",
      sessionId: "session-1",
    });
    const sessionMemory = createDecision("memoryDraftReview", {
      id: "memoryDraftReview:session",
      sourceRef: "draft-1",
      sessionId: "session-1",
    });
    const pairing = createDecision("channelPairing", {
      id: "channelPairing:pending",
      sourceRef: "pair-1",
    });
    const resolvedExec = createDecision("execApproval", {
      id: "execApproval:resolved",
      sourceRef: "approval-2",
      sessionId: "session-1",
      status: "denied",
      resolution: "denied",
      resolvedAt: "2026-03-30T00:01:00.000Z",
    });
    const dashboard = createDashboard(
      [sessionExec, sessionMemory, pairing, resolvedExec],
      [],
    );

    expect(getPendingPairingDecisions(dashboard)).toEqual([pairing]);
    expect(getSessionDecisions(dashboard.decisions, "session-1")).toEqual([
      sessionExec,
      sessionMemory,
    ]);
    expect(getDecisionByApprovalId(dashboard.decisions, "approval-1")).toBe(
      sessionExec,
    );
    expect(getDecisionByApprovalId(dashboard.decisions, "approval-missing")).toBeNull();
  });
});
