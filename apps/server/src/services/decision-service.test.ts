import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApprovalRecord, MemoryDraft } from "@droidagent/shared";

const mocks = vi.hoisted(() => {
  const decisionRows: Array<Record<string, unknown>> = [];
  const decisionRecordsTable = { table: "decisionRecords", id: "id" };
  const approvals: ApprovalRecord[] = [];
  const drafts: MemoryDraft[] = [];
  const pairings: Array<{
    code: string;
    from: string;
    requestedAt: string | null;
  }> = [];

  const upsertDecision = (record: Record<string, unknown>) => {
    const existing = decisionRows.find((row) => row.id === record.id);
    if (existing) {
      Object.assign(existing, record);
      return;
    }
    decisionRows.push({ ...record });
  };

  const db = {
    query: {
      decisionRecords: {
        findMany: vi.fn(async () => [...decisionRows]),
        findFirst: vi.fn(async (args?: { where?: { value?: string } }) => {
          const id = args?.where?.value;
          if (!id) {
            return decisionRows[0] ?? null;
          }
          return decisionRows.find((row) => row.id === id) ?? null;
        }),
      },
    },
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((record: Record<string, unknown>) => ({
        onConflictDoUpdate: vi.fn(async (args: {
          set: Record<string, unknown>;
        }) => {
          if (table !== decisionRecordsTable) {
            return;
          }
          upsertDecision({ ...record, ...args.set });
        }),
      })),
    })),
  };

  return {
    decisionRows,
    decisionRecordsTable,
    approvals,
    drafts,
    pairings,
    db,
    listApprovals: vi.fn(async () => [...approvals]),
    listChannels: vi.fn(async () => ({
      statuses: [],
      config: {
        signal: {
          pendingPairings: [...pairings],
        },
      },
    })),
    resolveApproval: vi.fn(async () => undefined),
    listDrafts: vi.fn(async () => [...drafts]),
    getDraft: vi.fn(async (draftId: string) =>
      drafts.find((draft) => draft.id === draftId) ?? null,
    ),
    applyDraft: vi.fn(async (draftId: string) => {
      const draft = drafts.find((entry) => entry.id === draftId)!;
      const next = {
        ...draft,
        status: "applied" as const,
        appliedAt: "2026-03-30T00:00:05.000Z",
        updatedAt: "2026-03-30T00:00:05.000Z",
      };
      drafts.splice(
        drafts.findIndex((entry) => entry.id === draftId),
        1,
        next,
      );
      return {
        draft: next,
        outcome: "applied" as const,
        memory: {
          effectiveWorkspaceRoot: "/workspace",
          memoryFilePath: "/workspace/MEMORY.md",
          todayNotePath: "/workspace/memory/2026-03-30.md",
        },
        reindexMode: "incremental" as const,
      };
    }),
    dismissDraft: vi.fn(async (draftId: string) => {
      const draft = drafts.find((entry) => entry.id === draftId)!;
      const next = {
        ...draft,
        status: "dismissed" as const,
        dismissedAt: "2026-03-30T00:00:05.000Z",
        updatedAt: "2026-03-30T00:00:05.000Z",
      };
      drafts.splice(
        drafts.findIndex((entry) => entry.id === draftId),
        1,
        next,
      );
      return {
        draft: next,
        outcome: "dismissed" as const,
      };
    }),
    resolveSignalPairing: vi.fn(async () => undefined),
    reset() {
      decisionRows.splice(0, decisionRows.length);
      approvals.splice(0, approvals.length);
      drafts.splice(0, drafts.length);
      pairings.splice(0, pairings.length);
      db.query.decisionRecords.findMany.mockClear();
      db.query.decisionRecords.findFirst.mockClear();
      db.insert.mockClear();
      this.listApprovals.mockClear();
      this.listChannels.mockClear();
      this.resolveApproval.mockClear();
      this.listDrafts.mockClear();
      this.getDraft.mockClear();
      this.applyDraft.mockClear();
      this.dismissDraft.mockClear();
      this.resolveSignalPairing.mockClear();
    },
  };
});

vi.mock("drizzle-orm", () => ({
  desc: (column: unknown) => ({ column, direction: "desc" }),
  eq: (column: unknown, value: string) => ({ column, value }),
}));

vi.mock("../db/index.js", () => ({
  db: mocks.db,
  schema: {
    decisionRecords: mocks.decisionRecordsTable,
  },
}));

vi.mock("./harness-service.js", () => ({
  harnessService: {
    listApprovals: mocks.listApprovals,
    listChannels: mocks.listChannels,
    resolveApproval: mocks.resolveApproval,
  },
}));

vi.mock("./memory-draft-service.js", () => ({
  memoryDraftService: {
    listDrafts: mocks.listDrafts,
    getDraft: mocks.getDraft,
    applyDraft: mocks.applyDraft,
    dismissDraft: mocks.dismissDraft,
  },
}));

vi.mock("./openclaw-service.js", () => ({
  openclawService: {
    resolveSignalPairing: mocks.resolveSignalPairing,
  },
}));

import { decisionService } from "./decision-service.js";

describe("DecisionService", () => {
  beforeEach(() => {
    mocks.reset();
  });

  it("normalizes live approvals, memory review, and pairing into one pending list", async () => {
    mocks.approvals.push({
      id: "approval-1",
      kind: "exec",
      title: "Exec approval required",
      details: JSON.stringify({
        command: "pnpm test",
        sessionKey: "web:operator",
      }),
      createdAt: "2026-03-30T00:00:00.000Z",
      status: "pending",
      source: "openclaw",
    });
    mocks.drafts.push({
      id: "draft-1",
      target: "memory",
      status: "pending",
      title: "Memory capture",
      content: "Remember this detail.",
      sourceKind: "chatMessage",
      sourceLabel: "Chat",
      sourceRef: "msg-1",
      sessionId: "web:operator",
      createdAt: "2026-03-30T00:00:01.000Z",
      updatedAt: "2026-03-30T00:00:01.000Z",
      appliedAt: null,
      dismissedAt: null,
      failedAt: null,
      lastError: null,
      appliedPath: null,
    });
    mocks.pairings.push({
      code: "pair-1",
      from: "+15555550123",
      requestedAt: "2026-03-30T00:00:02.000Z",
    });

    const decisions = await decisionService.listDecisions();

    expect(decisions.map((decision) => decision.kind)).toEqual([
      "channelPairing",
      "memoryDraftReview",
      "execApproval",
    ]);
    expect(decisions.find((decision) => decision.kind === "execApproval"))
      .toMatchObject({
        sourceRef: "approval-1",
        sessionId: "web:operator",
      });
  });

  it("resolves a memory draft decision and stamps actor metadata", async () => {
    mocks.drafts.push({
      id: "draft-2",
      target: "preferences",
      status: "pending",
      title: "Preference update",
      content: "Keep responses concise.",
      sourceKind: "manual",
      sourceLabel: "Settings",
      sourceRef: null,
      sessionId: "web:operator",
      createdAt: "2026-03-30T00:00:01.000Z",
      updatedAt: "2026-03-30T00:00:01.000Z",
      appliedAt: null,
      dismissedAt: null,
      failedAt: null,
      lastError: null,
      appliedPath: null,
    });

    const resolved = await decisionService.resolveDecision(
      "memory-draft:draft-2",
      {
        resolution: "approved",
        expectedUpdatedAt: "2026-03-30T00:00:01.000Z",
      },
      {
        user: {
          id: "owner-1",
          username: "owner",
          displayName: "DroidAgent Owner",
        },
        authSession: {
          id: "auth-session-1",
          userId: "owner-1",
          expiresAt: "2026-03-31T00:00:00.000Z",
          createdAt: "2026-03-30T00:00:00.000Z",
          origin: "https://device.example.com",
          deviceLabel: "iPhone Safari",
          userAgent: "Mobile Safari",
        },
      },
    );

    expect(mocks.applyDraft).toHaveBeenCalledWith("draft-2", {
      expectedUpdatedAt: "2026-03-30T00:00:01.000Z",
    });
    expect(resolved).toMatchObject({
      status: "approved",
      resolution: "approved",
      actorUserId: "owner-1",
      actorSessionId: "auth-session-1",
      deviceLabel: "iPhone Safari",
    });
  });

  it("keeps the legacy approval id path mapped to the same decision ledger", async () => {
    mocks.approvals.push({
      id: "approval-compat-1",
      kind: "exec",
      title: "Exec approval required",
      details: JSON.stringify({
        command: "pnpm test",
        sessionKey: "web:operator",
      }),
      createdAt: "2026-03-30T00:00:00.000Z",
      status: "pending",
      source: "openclaw",
    });

    const resolved = await decisionService.resolveApprovalDecision(
      "approval-compat-1",
      "denied",
      {
        user: {
          id: "owner-1",
          username: "owner",
          displayName: "DroidAgent Owner",
        },
        authSession: null,
      },
    );

    expect(mocks.resolveApproval).toHaveBeenCalledWith(
      "approval-compat-1",
      "denied",
    );
    expect(resolved).toMatchObject({
      id: "exec:approval-compat-1",
      sourceRef: "approval-compat-1",
      status: "denied",
      resolution: "denied",
    });
  });
});
