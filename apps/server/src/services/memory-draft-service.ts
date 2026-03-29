import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { desc, eq } from "drizzle-orm";

import {
  MemoryDraftApplyResultSchema,
  MemoryDraftCreateRequestSchema,
  MemoryDraftSchema,
  MemoryDraftUpdateRequestSchema,
  nowIso,
  type MemoryDraft,
  type MemoryDraftApplyResult,
  type MemoryDraftCreateRequest,
  type MemoryDraftUpdateRequest,
} from "@droidagent/shared";

import { db, schema } from "../db/index.js";
import { performanceService } from "./performance-service.js";
import { openclawService } from "./openclaw-service.js";

function sourceKindLabel(kind: MemoryDraft["sourceKind"]): string {
  if (kind === "chatMessage") {
    return "chat message";
  }
  if (kind === "fileSelection") {
    return "file selection";
  }
  if (kind === "memoryFlush") {
    return "memory flush";
  }
  return "manual";
}

function defaultDraftTitle(draft: Pick<MemoryDraft, "target">): string {
  if (draft.target === "preferences") {
    return "Preference Update";
  }
  if (draft.target === "todayNote") {
    return "Captured Note";
  }
  return "Durable Memory Capture";
}

function appendMarkdownBlock(existing: string, block: string): string {
  const trimmedExisting = existing.replace(/\s+$/u, "");
  const trimmedBlock = block.trim();
  if (!trimmedExisting) {
    return `${trimmedBlock}\n`;
  }
  return `${trimmedExisting}\n\n${trimmedBlock}\n`;
}

async function readUtf8OrEmpty(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function writeAtomicUtf8(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const tempPath = path.join(directory, `.droidagent-memory-${randomUUID()}.tmp`);
  await fs.writeFile(tempPath, content, "utf8");
  await fs.rename(tempPath, filePath);
}

function toDraft(record: typeof schema.memoryDrafts.$inferSelect): MemoryDraft {
  return MemoryDraftSchema.parse({
    id: record.id,
    target: record.target,
    status: record.status,
    title: record.title,
    content: record.content,
    sourceKind: record.sourceKind,
    sourceLabel: record.sourceLabel,
    sourceRef: record.sourceRef,
    sessionId: record.sessionId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    appliedAt: record.appliedAt,
    dismissedAt: record.dismissedAt,
    failedAt: record.failedAt,
    lastError: record.lastError,
    appliedPath: record.appliedPath,
  });
}

function formatDraftBlock(draft: MemoryDraft): string {
  const title = draft.title?.trim() || defaultDraftTitle(draft);
  const sourceBits = [
    sourceKindLabel(draft.sourceKind),
    draft.sourceLabel?.trim() || null,
  ].filter(Boolean);
  const lines = [`## ${title}`, `Captured: ${draft.createdAt}`];
  if (sourceBits.length > 0) {
    lines.push(`Source: ${sourceBits.join(" • ")}`);
  }
  if (draft.sessionId) {
    lines.push(`Session: ${draft.sessionId}`);
  }
  lines.push("", draft.content.trim());
  return lines.join("\n");
}

export class MemoryDraftNotFoundError extends Error {}

export class MemoryDraftStateError extends Error {}

export class MemoryDraftService {
  async listDrafts(limit = 20): Promise<MemoryDraft[]> {
    const records = await db.query.memoryDrafts.findMany({
      orderBy: (drafts) => [desc(drafts.updatedAt)],
      limit,
    });
    return records.map((record) => toDraft(record));
  }

  async getDraft(draftId: string): Promise<MemoryDraft> {
    const record = await db.query.memoryDrafts.findFirst({
      where: eq(schema.memoryDrafts.id, draftId),
    });
    if (!record) {
      throw new MemoryDraftNotFoundError("Memory draft not found.");
    }
    return toDraft(record);
  }

  async createDraft(input: MemoryDraftCreateRequest): Promise<MemoryDraft> {
    const parsed = MemoryDraftCreateRequestSchema.parse(input);
    const timestamp = nowIso();
    const record: typeof schema.memoryDrafts.$inferInsert = {
      id: randomUUID(),
      target: parsed.target,
      status: "pending",
      title: parsed.title ?? null,
      content: parsed.content.trim(),
      sourceKind: parsed.sourceKind,
      sourceLabel: parsed.sourceLabel ?? null,
      sourceRef: parsed.sourceRef ?? null,
      sessionId: parsed.sessionId ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
      appliedAt: null,
      dismissedAt: null,
      failedAt: null,
      lastError: null,
      appliedPath: null,
    };

    await db.insert(schema.memoryDrafts).values(record);
    return await this.getDraft(record.id);
  }

  async updateDraft(
    draftId: string,
    input: MemoryDraftUpdateRequest,
  ): Promise<MemoryDraft> {
    const draft = await this.getDraft(draftId);
    if (draft.status !== "pending") {
      throw new MemoryDraftStateError(
        "Only pending memory drafts can be edited.",
      );
    }

    const parsed = MemoryDraftUpdateRequestSchema.parse(input);
    await db
      .update(schema.memoryDrafts)
      .set({
        target: parsed.target ?? draft.target,
        title:
          parsed.title === undefined
            ? draft.title
            : (parsed.title?.trim() ?? null),
        content: parsed.content?.trim() ?? draft.content,
        updatedAt: nowIso(),
      })
      .where(eq(schema.memoryDrafts.id, draft.id));

    return await this.getDraft(draft.id);
  }

  async dismissDraft(draftId: string): Promise<MemoryDraft> {
    const draft = await this.getDraft(draftId);
    if (draft.status !== "pending") {
      throw new MemoryDraftStateError(
        "Only pending memory drafts can be dismissed.",
      );
    }
    const timestamp = nowIso();
    await db
      .update(schema.memoryDrafts)
      .set({
        status: "dismissed",
        updatedAt: timestamp,
        dismissedAt: timestamp,
        lastError: null,
      })
      .where(eq(schema.memoryDrafts.id, draft.id));
    return await this.getDraft(draft.id);
  }

  async applyDraft(draftId: string): Promise<MemoryDraftApplyResult> {
    const draft = await this.getDraft(draftId);
    if (draft.status !== "pending") {
      throw new MemoryDraftStateError(
        "Only pending memory drafts can be applied.",
      );
    }

    const metric = performanceService.start("server", "memory.draft.apply", {
      target: draft.target,
      sourceKind: draft.sourceKind,
    });

    await openclawService.prepareWorkspaceContext();
    const memoryStatus = await openclawService.memoryStatus();

    const targetPath =
      draft.target === "preferences"
        ? path.join(memoryStatus.effectiveWorkspaceRoot, "PREFERENCES.md")
        : draft.target === "todayNote"
          ? await openclawService.ensureTodayMemoryNote()
          : memoryStatus.memoryFilePath;
    const existingContent = await readUtf8OrEmpty(targetPath);
    const nextContent = appendMarkdownBlock(
      existingContent,
      formatDraftBlock(draft),
    );
    await writeAtomicUtf8(targetPath, nextContent);

    let reindexMode: "incremental" | "force" = "incremental";
    let reindexError: Error | null = null;
    try {
      await openclawService.reindexMemory({ force: false });
    } catch (error) {
      reindexMode = "force";
      try {
        await openclawService.reindexMemory({ force: true });
      } catch (forceError) {
        reindexError =
          forceError instanceof Error
            ? forceError
            : new Error("Memory reindex failed after write.");
      }
    }

    const timestamp = nowIso();
    await db
      .update(schema.memoryDrafts)
      .set({
        status: "applied",
        updatedAt: timestamp,
        appliedAt: timestamp,
        failedAt: null,
        lastError: reindexError?.message ?? null,
        appliedPath: targetPath,
      })
      .where(eq(schema.memoryDrafts.id, draft.id));

    const appliedDraft = await this.getDraft(draft.id);
    metric.finish({
      target: appliedDraft.target,
      reindexMode,
      reindexOutcome: reindexError ? "warning" : "ok",
    });

    return MemoryDraftApplyResultSchema.parse({
      draft: appliedDraft,
      memory: {
        effectiveWorkspaceRoot: memoryStatus.effectiveWorkspaceRoot,
        memoryFilePath: memoryStatus.memoryFilePath,
        todayNotePath: memoryStatus.todayNotePath,
      },
      reindexMode,
    });
  }
}

export const memoryDraftService = new MemoryDraftService();
