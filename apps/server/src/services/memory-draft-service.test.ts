import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  draftRecords,
  memoryDraftsTable,
  db,
  resetDb,
  openclawMocks,
  performanceStart,
} = vi.hoisted(() => {
  const draftRecords: Array<Record<string, unknown>> = [];
  const memoryDraftsTable = {
    table: "memoryDrafts",
    id: "id",
  };

  const db = {
    query: {
      memoryDrafts: {
        findMany: vi.fn(async () => [...draftRecords]),
        findFirst: vi.fn(async (args?: { where?: { value?: string } }) => {
          const draftId = args?.where?.value;
          if (!draftId) {
            return draftRecords[0] ?? null;
          }
          return (
            draftRecords.find((record) => record.id === draftId) ?? null
          );
        }),
      },
    },
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (record: Record<string, unknown>) => {
        if (table === memoryDraftsTable) {
          draftRecords.push({ ...record });
        }
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((patch: Record<string, unknown>) => ({
        where: vi.fn(async (where: { value?: string }) => {
          if (table !== memoryDraftsTable) {
            return;
          }
          const target = draftRecords.find((record) => record.id === where.value);
          if (target) {
            Object.assign(target, patch);
          }
        }),
      })),
    })),
  };

  const openclawMocks = {
    prepareWorkspaceContext: vi.fn(),
    memoryStatus: vi.fn(),
    ensureTodayMemoryNote: vi.fn(),
    reindexMemory: vi.fn(),
  };

  const performanceStart = vi.fn(() => ({
    finish: vi.fn(),
  }));

  return {
    draftRecords,
    memoryDraftsTable,
    db,
    resetDb: () => {
      draftRecords.splice(0, draftRecords.length);
      db.query.memoryDrafts.findMany.mockClear();
      db.query.memoryDrafts.findFirst.mockClear();
      db.insert.mockClear();
      db.update.mockClear();
      openclawMocks.prepareWorkspaceContext.mockReset();
      openclawMocks.memoryStatus.mockReset();
      openclawMocks.ensureTodayMemoryNote.mockReset();
      openclawMocks.reindexMemory.mockReset();
      performanceStart.mockClear();
    },
    openclawMocks,
    performanceStart,
  };
});

vi.mock("drizzle-orm", () => ({
  desc: (column: unknown) => ({ column, direction: "desc" }),
  eq: (column: unknown, value: string) => ({ column, value }),
}));

vi.mock("../db/index.js", () => ({
  db,
  schema: {
    memoryDrafts: memoryDraftsTable,
  },
}));

vi.mock("./openclaw-service.js", () => ({
  openclawService: openclawMocks,
}));

vi.mock("./performance-service.js", () => ({
  performanceService: {
    start: performanceStart,
  },
}));

import {
  MemoryDraftNotFoundError,
  MemoryDraftService,
  MemoryDraftStateError,
  MemoryDraftStaleError,
} from "./memory-draft-service.js";

describe("MemoryDraftService", () => {
  let tempDir: string;
  let service: MemoryDraftService;
  let memoryFilePath: string;
  let todayNotePath: string;

  beforeEach(async () => {
    resetDb();
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "droidagent-memory-draft-"),
    );
    memoryFilePath = path.join(tempDir, "MEMORY.md");
    todayNotePath = path.join(tempDir, "memory", "2026-03-29.md");
    service = new MemoryDraftService();

    openclawMocks.prepareWorkspaceContext.mockResolvedValue(undefined);
    openclawMocks.memoryStatus.mockResolvedValue({
      effectiveWorkspaceRoot: tempDir,
      memoryFilePath,
      todayNotePath,
    });
    openclawMocks.ensureTodayMemoryNote.mockResolvedValue(todayNotePath);
    openclawMocks.reindexMemory.mockResolvedValue({
      effectiveWorkspaceRoot: tempDir,
      memoryFilePath,
      todayNotePath,
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("creates and updates a pending memory draft", async () => {
    const created = await service.createDraft({
      target: "memory",
      title: "Initial",
      content: "Remember this",
      sourceKind: "manual",
      sourceLabel: null,
      sourceRef: null,
      sessionId: null,
    });

    const updated = await service.updateDraft(created.id, {
      expectedUpdatedAt: created.updatedAt,
      target: "preferences",
      title: "Updated",
      content: "Prefer concise replies",
    });

    expect(updated.target).toBe("preferences");
    expect(updated.title).toBe("Updated");
    expect(updated.content).toBe("Prefer concise replies");
  });

  it("applies a draft to MEMORY.md atomically and reindexes incrementally", async () => {
    draftRecords.push({
      id: "draft-1",
      target: "memory",
      status: "pending",
      title: "Stable fact",
      content: "The operator prefers local-first tools.",
      sourceKind: "chatMessage",
      sourceLabel: "Assistant",
      sourceRef: "msg-1",
      sessionId: "web:operator",
      createdAt: "2026-03-29T12:00:00.000Z",
      updatedAt: "2026-03-29T12:00:00.000Z",
      appliedAt: null,
      dismissedAt: null,
      failedAt: null,
      lastError: null,
      appliedPath: null,
    });

    const result = await service.applyDraft("draft-1", {
      expectedUpdatedAt: "2026-03-29T12:00:00.000Z",
    });

    const written = await fs.readFile(memoryFilePath, "utf8");
    expect(written).toContain("## Stable fact");
    expect(written).toContain("The operator prefers local-first tools.");
    expect(result.draft.status).toBe("applied");
    expect(result.outcome).toBe("applied");
    expect(result.draft.appliedPath).toBe(memoryFilePath);
    expect(openclawMocks.reindexMemory).toHaveBeenCalledTimes(1);
    expect(openclawMocks.reindexMemory).toHaveBeenCalledWith({ force: false });
    expect(result.reindexMode).toBe("incremental");

    const tempEntries = (await fs.readdir(tempDir)).filter((entry) =>
      entry.startsWith(".droidagent-memory-"),
    );
    expect(tempEntries).toHaveLength(0);
  });

  it("falls back to a forced reindex for today notes", async () => {
    draftRecords.push({
      id: "draft-2",
      target: "todayNote",
      status: "pending",
      title: "Today",
      content: "Tracked in the daily note.",
      sourceKind: "memoryFlush",
      sourceLabel: "Compaction suggestion",
      sourceRef: "flush-1",
      sessionId: null,
      createdAt: "2026-03-29T13:00:00.000Z",
      updatedAt: "2026-03-29T13:00:00.000Z",
      appliedAt: null,
      dismissedAt: null,
      failedAt: null,
      lastError: null,
      appliedPath: null,
    });
    openclawMocks.reindexMemory
      .mockRejectedValueOnce(new Error("incremental failed"))
      .mockResolvedValueOnce({
        effectiveWorkspaceRoot: tempDir,
        memoryFilePath,
        todayNotePath,
      });

    const result = await service.applyDraft("draft-2", {
      expectedUpdatedAt: "2026-03-29T13:00:00.000Z",
    });

    const written = await fs.readFile(todayNotePath, "utf8");
    expect(written).toContain("Tracked in the daily note.");
    expect(openclawMocks.ensureTodayMemoryNote).toHaveBeenCalledTimes(1);
    expect(openclawMocks.reindexMemory).toHaveBeenNthCalledWith(1, {
      force: false,
    });
    expect(openclawMocks.reindexMemory).toHaveBeenNthCalledWith(2, {
      force: true,
    });
    expect(result.reindexMode).toBe("force");
  });

  it("returns idempotent results for repeated apply and dismiss actions", async () => {
    draftRecords.push({
      id: "draft-3",
      target: "preferences",
      status: "applied",
      title: "Applied",
      content: "Already durable.",
      sourceKind: "manual",
      sourceLabel: null,
      sourceRef: null,
      sessionId: null,
      createdAt: "2026-03-29T14:00:00.000Z",
      updatedAt: "2026-03-29T14:00:00.000Z",
      appliedAt: "2026-03-29T14:05:00.000Z",
      dismissedAt: null,
      failedAt: null,
      lastError: null,
      appliedPath: path.join(tempDir, "PREFERENCES.md"),
    });

    const applyResult = await service.applyDraft("draft-3", {
      expectedUpdatedAt: "2026-03-29T14:00:00.000Z",
    });

    expect(applyResult.outcome).toBe("alreadyApplied");
    expect(applyResult.reindexMode).toBeNull();

    draftRecords.push({
      id: "draft-4",
      target: "memory",
      status: "dismissed",
      title: "Dismissed",
      content: "Already dropped.",
      sourceKind: "manual",
      sourceLabel: null,
      sourceRef: null,
      sessionId: null,
      createdAt: "2026-03-29T15:00:00.000Z",
      updatedAt: "2026-03-29T15:05:00.000Z",
      appliedAt: null,
      dismissedAt: "2026-03-29T15:05:00.000Z",
      failedAt: null,
      lastError: null,
      appliedPath: null,
    });

    const dismissResult = await service.dismissDraft("draft-4", {
      expectedUpdatedAt: "2026-03-29T15:00:00.000Z",
    });

    expect(dismissResult.outcome).toBe("alreadyDismissed");
  });

  it("rejects stale draft edits and incompatible final states", async () => {
    draftRecords.push({
      id: "draft-5",
      target: "preferences",
      status: "pending",
      title: "Pending",
      content: "Current content",
      sourceKind: "manual",
      sourceLabel: null,
      sourceRef: null,
      sessionId: null,
      createdAt: "2026-03-29T14:00:00.000Z",
      updatedAt: "2026-03-29T14:05:00.000Z",
      appliedAt: null,
      dismissedAt: null,
      failedAt: null,
      lastError: null,
      appliedPath: null,
    });

    await expect(
      service.updateDraft("draft-5", {
        expectedUpdatedAt: "2026-03-29T14:00:00.000Z",
        content: "Changed",
      }),
    ).rejects.toBeInstanceOf(MemoryDraftStaleError);

    draftRecords.push({
      id: "draft-6",
      target: "preferences",
      status: "applied",
      title: "Applied",
      content: "Already durable.",
      sourceKind: "manual",
      sourceLabel: null,
      sourceRef: null,
      sessionId: null,
      createdAt: "2026-03-29T16:00:00.000Z",
      updatedAt: "2026-03-29T16:05:00.000Z",
      appliedAt: "2026-03-29T16:05:00.000Z",
      dismissedAt: null,
      failedAt: null,
      lastError: null,
      appliedPath: path.join(tempDir, "PREFERENCES.md"),
    });
    draftRecords.push({
      id: "draft-7",
      target: "memory",
      status: "dismissed",
      title: "Dismissed",
      content: "Already dropped.",
      sourceKind: "manual",
      sourceLabel: null,
      sourceRef: null,
      sessionId: null,
      createdAt: "2026-03-29T17:00:00.000Z",
      updatedAt: "2026-03-29T17:05:00.000Z",
      appliedAt: null,
      dismissedAt: "2026-03-29T17:05:00.000Z",
      failedAt: null,
      lastError: null,
      appliedPath: null,
    });

    await expect(
      service.dismissDraft("draft-6", {
        expectedUpdatedAt: "2026-03-29T16:05:00.000Z",
      }),
    ).rejects.toBeInstanceOf(MemoryDraftStateError);
    await expect(
      service.updateDraft("draft-6", {
        expectedUpdatedAt: "2026-03-29T16:05:00.000Z",
        content: "Changed",
      }),
    ).rejects.toBeInstanceOf(MemoryDraftStateError);
    await expect(
      service.applyDraft("draft-7", {
        expectedUpdatedAt: "2026-03-29T17:05:00.000Z",
      }),
    ).rejects.toBeInstanceOf(MemoryDraftStateError);
  });

  it("raises a typed not-found error for unknown drafts", async () => {
    await expect(service.getDraft("missing")).rejects.toBeInstanceOf(
      MemoryDraftNotFoundError,
    );
  });
});
