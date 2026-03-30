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
  const tasks: Array<Promise<void>> = [publisher.publishDecisionsUpdated()];

  if (decision.kind === "execApproval") {
    tasks.push(publisher.publishApprovalsUpdated());
    await Promise.all(tasks);
    return;
  }

  if (decision.kind === "memoryDraftReview") {
    tasks.push(
      publisher.publishMemoryDraftsUpdated(),
      publisher.publishMemoryUpdated(),
    );
    await Promise.all(tasks);
    return;
  }

  if (decision.kind === "channelPairing") {
    tasks.push(publisher.publishChannelUpdated());
    await Promise.all(tasks);
    return;
  }

  await Promise.all(tasks);
}
