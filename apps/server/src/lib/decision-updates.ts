import type { DecisionRecord } from "@droidagent/shared";

interface DecisionPublisher {
  publishApprovalsUpdated(): Promise<void>;
  publishMemoryDraftsUpdated(): Promise<void>;
  publishMemoryUpdated(): Promise<void>;
  publishChannelUpdated(): Promise<void>;
  publishDecisionsUpdated(): Promise<void>;
}

export async function publishDecisionEffects(
  publisher: DecisionPublisher,
  decision: DecisionRecord,
): Promise<void> {
  if (decision.kind === "execApproval") {
    await publisher.publishApprovalsUpdated();
    return;
  }

  if (decision.kind === "memoryDraftReview") {
    await Promise.all([
      publisher.publishMemoryDraftsUpdated(),
      publisher.publishMemoryUpdated(),
    ]);
    return;
  }

  if (decision.kind === "channelPairing") {
    await publisher.publishChannelUpdated();
    return;
  }

  await publisher.publishDecisionsUpdated();
}
