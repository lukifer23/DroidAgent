import type { DashboardState, DecisionRecord, MemoryDraft } from "@droidagent/shared";

export function getPendingDecisions(
  decisions: DecisionRecord[],
): DecisionRecord[] {
  return decisions.filter((decision) => decision.status === "pending");
}

export function getResolvedDecisions(
  decisions: DecisionRecord[],
): DecisionRecord[] {
  return decisions.filter((decision) => decision.status !== "pending");
}

export function getPendingDecisionCount(
  dashboard: DashboardState | undefined,
): number {
  return getPendingDecisions(dashboard?.decisions ?? []).length;
}

export function getPendingMemoryDraftDecisions(
  decisions: DecisionRecord[],
): DecisionRecord[] {
  return decisions.filter(
    (decision) =>
      decision.status === "pending" && decision.kind === "memoryDraftReview",
  );
}

export function getMemoryDraftDecisionMap(
  decisions: DecisionRecord[],
): Map<string, DecisionRecord> {
  return new Map(
    getPendingMemoryDraftDecisions(decisions).map((decision) => [
      decision.sourceRef,
      decision,
    ]),
  );
}

export function getPendingMemoryDrafts(
  dashboard: DashboardState | undefined,
): MemoryDraft[] {
  const memoryDrafts = dashboard?.memoryDrafts ?? [];
  const draftDecisions = getMemoryDraftDecisionMap(dashboard?.decisions ?? []);
  return [...draftDecisions.keys()]
    .map((draftId) => memoryDrafts.find((draft) => draft.id === draftId) ?? null)
    .filter((draft): draft is MemoryDraft => Boolean(draft));
}

export function getPendingPairingDecisions(
  dashboard: DashboardState | undefined,
): DecisionRecord[] {
  return (dashboard?.decisions ?? []).filter(
    (decision) =>
      decision.status === "pending" && decision.kind === "channelPairing",
  );
}

export function getDecisionByApprovalId(
  decisions: DecisionRecord[],
  approvalId: string,
): DecisionRecord | null {
  return (
    decisions.find(
      (decision) =>
        decision.kind === "execApproval" && decision.sourceRef === approvalId,
    ) ?? null
  );
}

export function getSessionDecisions(
  decisions: DecisionRecord[],
  sessionId: string | null | undefined,
): DecisionRecord[] {
  if (!sessionId) {
    return [];
  }

  return decisions.filter(
    (decision) =>
      decision.status === "pending" &&
      decision.sessionId === sessionId &&
      (decision.kind === "execApproval" ||
        decision.kind === "memoryDraftReview"),
  );
}
