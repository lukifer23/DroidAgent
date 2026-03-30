import { desc, eq } from "drizzle-orm";

import {
  DecisionRecordSchema,
  type ApprovalRecord,
  type DecisionRecord,
  type DecisionResolution,
  type DecisionResolveRequest,
  type MemoryDraft,
  type SignalPendingPairing,
  nowIso,
} from "@droidagent/shared";

import { db, schema } from "../db/index.js";
import type { AuthUser, CurrentAuthSession } from "./auth-service.js";
import { harnessService } from "./harness-service.js";
import { memoryDraftService } from "./memory-draft-service.js";
import { openclawService } from "./openclaw-service.js";

const RECENT_RESOLVED_LIMIT = 20;

export interface DecisionActor {
  user: AuthUser;
  authSession: CurrentAuthSession | null;
}

function execDecisionId(approvalId: string): string {
  return `exec:${approvalId}`;
}

function memoryDraftDecisionId(draftId: string): string {
  return `memory-draft:${draftId}`;
}

function channelPairingDecisionId(code: string): string {
  return `channel-pairing:signal:${code}`;
}

function parseDecisionId(decisionId: string):
  | { kind: "execApproval"; sourceRef: string }
  | { kind: "memoryDraftReview"; sourceRef: string }
  | { kind: "channelPairing"; sourceRef: string } {
  if (decisionId.startsWith("exec:")) {
    return {
      kind: "execApproval",
      sourceRef: decisionId.slice("exec:".length),
    };
  }
  if (decisionId.startsWith("memory-draft:")) {
    return {
      kind: "memoryDraftReview",
      sourceRef: decisionId.slice("memory-draft:".length),
    };
  }
  if (decisionId.startsWith("channel-pairing:signal:")) {
    return {
      kind: "channelPairing",
      sourceRef: decisionId.slice("channel-pairing:signal:".length),
    };
  }
  throw new Error(`Unknown decision id: ${decisionId}`);
}

function buildActorLabel(actor: DecisionActor): string {
  return actor.user.displayName || actor.user.username;
}

function parseApprovalPayload(details: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(details) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function firstString(
  source: Record<string, unknown> | null,
  keys: string[],
): string | null {
  if (!source) {
    return null;
  }
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function truncateSummary(input: string, limit = 180): string {
  const trimmed = input.trim();
  if (trimmed.length <= limit) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function memoryTargetLabel(target: MemoryDraft["target"]): string {
  if (target === "preferences") {
    return "PREFERENCES.md";
  }
  if (target === "todayNote") {
    return "today note";
  }
  return "MEMORY.md";
}

function decisionStatusForMemoryDraft(
  draft: MemoryDraft,
): "pending" | "resolved" | "failed" {
  if (draft.status === "pending") {
    return "pending";
  }
  if (draft.status === "failed") {
    return "failed";
  }
  return "resolved";
}

function decisionResolutionForMemoryDraft(
  draft: MemoryDraft,
): DecisionResolution | null {
  if (draft.status === "applied") {
    return "applied";
  }
  if (draft.status === "dismissed") {
    return "dismissed";
  }
  if (draft.status === "failed") {
    return "failed";
  }
  return null;
}

function decisionFromRow(
  row: typeof schema.decisionRecords.$inferSelect,
): DecisionRecord {
  return DecisionRecordSchema.parse({
    id: row.id,
    kind: row.kind,
    sourceSystem: row.sourceSystem,
    sourceRef: row.sourceRef,
    title: row.title,
    summary: row.summary,
    details: row.details,
    status: row.status,
    requestedAt: row.requestedAt,
    resolvedAt: row.resolvedAt,
    actorUserId: row.actorUserId,
    actorLabel: row.actorLabel,
    sessionId: row.sessionId,
    actorSessionId: row.actorSessionId,
    deviceLabel: row.deviceLabel,
    resolution: row.resolution,
    sourceUpdatedAt: row.sourceUpdatedAt,
  });
}

export class DecisionService {
  private async persistDecision(record: DecisionRecord): Promise<DecisionRecord> {
    const timestamp = nowIso();
    await db
      .insert(schema.decisionRecords)
      .values({
        id: record.id,
        kind: record.kind,
        sourceSystem: record.sourceSystem,
        sourceRef: record.sourceRef,
        title: record.title,
        summary: record.summary,
        details: record.details,
        status: record.status,
        requestedAt: record.requestedAt,
        resolvedAt: record.resolvedAt,
        actorUserId: record.actorUserId,
        actorLabel: record.actorLabel,
        sessionId: record.sessionId,
        actorSessionId: record.actorSessionId,
        deviceLabel: record.deviceLabel,
        resolution: record.resolution,
        sourceUpdatedAt: record.sourceUpdatedAt,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: schema.decisionRecords.id,
        set: {
          kind: record.kind,
          sourceSystem: record.sourceSystem,
          sourceRef: record.sourceRef,
          title: record.title,
          summary: record.summary,
          details: record.details,
          status: record.status,
          requestedAt: record.requestedAt,
          resolvedAt: record.resolvedAt,
          actorUserId: record.actorUserId,
          actorLabel: record.actorLabel,
          sessionId: record.sessionId,
          actorSessionId: record.actorSessionId,
          deviceLabel: record.deviceLabel,
          resolution: record.resolution,
          sourceUpdatedAt: record.sourceUpdatedAt,
          updatedAt: timestamp,
        },
      });

    const stored = await db.query.decisionRecords.findFirst({
      where: eq(schema.decisionRecords.id, record.id),
    });
    return stored ? decisionFromRow(stored) : record;
  }

  private buildExecDecision(
    approval: ApprovalRecord,
    options: {
      status?: DecisionRecord["status"];
      resolution?: DecisionRecord["resolution"];
      actor?: DecisionActor | null;
      resolvedAt?: string | null;
    } = {},
  ): DecisionRecord {
    const payload = parseApprovalPayload(approval.details);
    const command = firstString(payload, ["command", "cmd", "toolInput"]);
    const sessionId = firstString(payload, [
      "sessionId",
      "sessionKey",
      "conversationId",
    ]);
    return DecisionRecordSchema.parse({
      id: execDecisionId(approval.id),
      kind: "execApproval",
      sourceSystem: "openclaw",
      sourceRef: approval.id,
      title: approval.title,
      summary: truncateSummary(
        command ? `OpenClaw requested exec: ${command}` : approval.title,
      ),
      details: approval.details,
      status: options.status ?? "pending",
      requestedAt: approval.createdAt,
      resolvedAt: options.resolvedAt ?? null,
      actorUserId: options.actor?.user.id ?? null,
      actorLabel: options.actor ? buildActorLabel(options.actor) : null,
      sessionId,
      actorSessionId: options.actor?.authSession?.id ?? null,
      deviceLabel: options.actor?.authSession?.deviceLabel ?? null,
      resolution: options.resolution ?? null,
      sourceUpdatedAt: null,
    });
  }

  private buildMemoryDraftDecision(
    draft: MemoryDraft,
    actor?: Pick<
      DecisionRecord,
      "actorUserId" | "actorLabel" | "actorSessionId" | "deviceLabel"
    >,
  ): DecisionRecord {
    const status = decisionStatusForMemoryDraft(draft);
    const resolution = decisionResolutionForMemoryDraft(draft);
    const resolvedAt =
      draft.appliedAt ?? draft.dismissedAt ?? draft.failedAt ?? null;
    return DecisionRecordSchema.parse({
      id: memoryDraftDecisionId(draft.id),
      kind: "memoryDraftReview",
      sourceSystem: "droidagent",
      sourceRef: draft.id,
      title: draft.title?.trim() || "Durable memory review",
      summary: truncateSummary(
        `${memoryTargetLabel(draft.target)} • ${draft.sourceLabel ?? draft.sourceKind}`,
      ),
      details: draft.content,
      status,
      requestedAt: draft.createdAt,
      resolvedAt,
      actorUserId: actor?.actorUserId ?? null,
      actorLabel: actor?.actorLabel ?? null,
      sessionId: draft.sessionId,
      actorSessionId: actor?.actorSessionId ?? null,
      deviceLabel: actor?.deviceLabel ?? null,
      resolution,
      sourceUpdatedAt: draft.updatedAt,
    });
  }

  private buildChannelPairingDecision(
    pairing: SignalPendingPairing,
    options: {
      status?: DecisionRecord["status"];
      resolution?: DecisionRecord["resolution"];
      actor?: DecisionActor | null;
      resolvedAt?: string | null;
    } = {},
  ): DecisionRecord {
    return DecisionRecordSchema.parse({
      id: channelPairingDecisionId(pairing.code),
      kind: "channelPairing",
      sourceSystem: "openclaw",
      sourceRef: pairing.code,
      title: "Signal pairing request",
      summary: truncateSummary(`${pairing.from} is waiting for owner approval.`),
      details: `From: ${pairing.from}\nCode: ${pairing.code}`,
      status: options.status ?? "pending",
      requestedAt: pairing.requestedAt ?? nowIso(),
      resolvedAt: options.resolvedAt ?? null,
      actorUserId: options.actor?.user.id ?? null,
      actorLabel: options.actor ? buildActorLabel(options.actor) : null,
      sessionId: null,
      actorSessionId: options.actor?.authSession?.id ?? null,
      deviceLabel: options.actor?.authSession?.deviceLabel ?? null,
      resolution: options.resolution ?? null,
      sourceUpdatedAt: pairing.requestedAt ?? null,
    });
  }

  private async listResolvedHistory(
    limit = RECENT_RESOLVED_LIMIT,
  ): Promise<DecisionRecord[]> {
    const rows = await db.query.decisionRecords.findMany({
      where: (records, { ne }) => ne(records.status, "pending"),
      orderBy: (records) => [desc(records.updatedAt)],
      limit,
    });
    return rows.map((row) => decisionFromRow(row));
  }

  private async getChannelPairings(): Promise<SignalPendingPairing[]> {
    const channelState = await harnessService.listChannels();
    return channelState.config.signal.pendingPairings;
  }

  async listDecisions(): Promise<DecisionRecord[]> {
    const [approvals, drafts, pairings, resolvedHistory] = await Promise.all([
      harnessService.listApprovals(),
      memoryDraftService.listDrafts(50),
      this.getChannelPairings(),
      this.listResolvedHistory(),
    ]);

    const liveDecisions = [
      ...approvals.map((approval) => this.buildExecDecision(approval)),
      ...drafts
        .filter((draft) => draft.status === "pending")
        .map((draft) => this.buildMemoryDraftDecision(draft)),
      ...pairings.map((pairing) => this.buildChannelPairingDecision(pairing)),
    ];

    const liveIds = new Set(liveDecisions.map((decision) => decision.id));
    const merged = [
      ...liveDecisions.sort(
        (left, right) =>
          new Date(right.requestedAt).getTime() -
          new Date(left.requestedAt).getTime(),
      ),
      ...resolvedHistory.filter((decision) => !liveIds.has(decision.id)),
    ];

    return merged;
  }

  async listLegacyApprovals(): Promise<ApprovalRecord[]> {
    return (await harnessService.listApprovals()).filter(
      (approval) => approval.kind === "exec",
    );
  }

  async syncMemoryDraftDecision(draft: MemoryDraft): Promise<DecisionRecord> {
    return await this.persistDecision(this.buildMemoryDraftDecision(draft));
  }

  async syncResolvedMemoryDraftDecision(
    draft: MemoryDraft,
    actor: DecisionActor,
  ): Promise<DecisionRecord> {
    return await this.persistDecision(
      this.buildMemoryDraftDecision(draft, {
        actorUserId: actor.user.id,
        actorLabel: buildActorLabel(actor),
        actorSessionId: actor.authSession?.id ?? null,
        deviceLabel: actor.authSession?.deviceLabel ?? null,
      }),
    );
  }

  async resolveApprovalDecision(
    approvalId: string,
    resolution: "approved" | "denied",
    actor: DecisionActor,
  ): Promise<DecisionRecord> {
    const approvals = await harnessService.listApprovals();
    const approval =
      approvals.find((entry) => entry.id === approvalId) ??
      ({
        id: approvalId,
        kind: "exec",
        title: "OpenClaw approval",
        details: "",
        createdAt: nowIso(),
        status: "pending",
        source: "openclaw",
      } satisfies ApprovalRecord);
    await harnessService.resolveApproval(approvalId, resolution);
    return await this.persistDecision(
      this.buildExecDecision(approval, {
        actor,
        status: "resolved",
        resolution,
        resolvedAt: nowIso(),
      }),
    );
  }

  async resolveChannelPairingDecision(
    code: string,
    resolution: "approved" | "denied",
    actor: DecisionActor,
  ): Promise<DecisionRecord> {
    const pairings = await this.getChannelPairings();
    const pairing =
      pairings.find((entry) => entry.code === code) ??
      {
        code,
        from: "Unknown sender",
        requestedAt: nowIso(),
      };
    await openclawService.resolveSignalPairing(code, resolution);
    return await this.persistDecision(
      this.buildChannelPairingDecision(pairing, {
        actor,
        status: "resolved",
        resolution,
        resolvedAt: nowIso(),
      }),
    );
  }

  async resolveDecision(
    decisionId: string,
    request: DecisionResolveRequest,
    actor: DecisionActor,
  ): Promise<DecisionRecord> {
    const parsedId = parseDecisionId(decisionId);
    if (parsedId.kind === "execApproval") {
      return await this.resolveApprovalDecision(
        parsedId.sourceRef,
        request.resolution,
        actor,
      );
    }

    if (parsedId.kind === "channelPairing") {
      return await this.resolveChannelPairingDecision(
        parsedId.sourceRef,
        request.resolution,
        actor,
      );
    }

    const draft = await memoryDraftService.getDraft(parsedId.sourceRef);
    const expectedUpdatedAt = request.expectedUpdatedAt ?? draft.updatedAt;
    const actorFields = {
      actorUserId: actor.user.id,
      actorLabel: buildActorLabel(actor),
      actorSessionId: actor.authSession?.id ?? null,
      deviceLabel: actor.authSession?.deviceLabel ?? null,
    };
    if (request.resolution === "approved") {
      const result = await memoryDraftService.applyDraft(draft.id, {
        expectedUpdatedAt,
      });
      return await this.persistDecision(
        this.buildMemoryDraftDecision(result.draft, actorFields),
      );
    }

    const result = await memoryDraftService.dismissDraft(draft.id, {
      expectedUpdatedAt,
    });
    return await this.persistDecision(
      this.buildMemoryDraftDecision(result.draft, actorFields),
    );
  }

  async getDecision(decisionId: string): Promise<DecisionRecord | null> {
    const decisions = await this.listDecisions();
    return decisions.find((decision) => decision.id === decisionId) ?? null;
  }

  createDecisionIdFromApprovalId(approvalId: string): string {
    return execDecisionId(approvalId);
  }

  createDecisionIdFromMemoryDraftId(draftId: string): string {
    return memoryDraftDecisionId(draftId);
  }

  createDecisionIdFromSignalPairing(code: string): string {
    return channelPairingDecisionId(code);
  }

  createFallbackDecisionRecord(params: {
    decisionId: string;
    kind: DecisionRecord["kind"];
    sourceSystem: DecisionRecord["sourceSystem"];
    sourceRef: string;
    title: string;
  }): DecisionRecord {
    return DecisionRecordSchema.parse({
      id: params.decisionId,
      kind: params.kind,
      sourceSystem: params.sourceSystem,
      sourceRef: params.sourceRef,
      title: params.title,
      summary: params.title,
      details: "",
      status: "pending",
      requestedAt: nowIso(),
      resolvedAt: null,
      actorUserId: null,
      actorLabel: null,
      sessionId: null,
      actorSessionId: null,
      deviceLabel: null,
      resolution: null,
      sourceUpdatedAt: null,
    });
  }
}

export const decisionService = new DecisionService();
