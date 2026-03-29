import { randomUUID } from "node:crypto";

import { z } from "zod";
import { SessionSummarySchema, nowIso, type ChatMessage, type SessionSummary } from "@droidagent/shared";

import { appStateService } from "./app-state-service.js";
import { harnessService } from "./harness-service.js";

const SESSION_REGISTRY_KEY = "sessionRegistry";
const DEFAULT_WEB_SESSION_ID = "web:operator";

const PersistedSessionRecordSchema = z.object({
  id: z.string(),
  title: z.string(),
  scope: SessionSummarySchema.shape.scope,
  createdAt: z.string(),
  updatedAt: z.string(),
  unreadCount: z.number().int().nonnegative().default(0),
  lastMessagePreview: z.string().default(""),
  archivedAt: z.string().nullable().default(null),
});
type PersistedSessionRecord = z.infer<typeof PersistedSessionRecordSchema>;

const PersistedSessionRegistrySchema = z.array(PersistedSessionRecordSchema);

function compareSessions(left: { updatedAt: string }, right: { updatedAt: string }): number {
  return right.updatedAt.localeCompare(left.updatedAt);
}

function titleFromSessionId(sessionId: string): string {
  return sessionId === DEFAULT_WEB_SESSION_ID ? "Operator Chat" : sessionId;
}

function toSummary(record: PersistedSessionRecord): SessionSummary {
  return SessionSummarySchema.parse({
    id: record.id,
    title: record.title,
    scope: record.scope,
    updatedAt: record.updatedAt,
    unreadCount: record.unreadCount,
    lastMessagePreview: record.lastMessagePreview,
  });
}

export class SessionLifecycleService {
  private async loadRegistry(): Promise<PersistedSessionRecord[]> {
    const records = await appStateService.getJsonSetting(SESSION_REGISTRY_KEY, []);
    return PersistedSessionRegistrySchema.parse(records);
  }

  private async saveRegistry(records: PersistedSessionRecord[]): Promise<void> {
    const next = [...records].sort(compareSessions);
    await appStateService.setJsonSetting(SESSION_REGISTRY_KEY, next);
  }

  private createRecord(
    sessionId: string,
    partial?: Partial<PersistedSessionRecord>,
  ): PersistedSessionRecord {
    const observedAt = partial?.updatedAt ?? partial?.createdAt ?? nowIso();
    return PersistedSessionRecordSchema.parse({
      id: sessionId,
      title: partial?.title ?? titleFromSessionId(sessionId),
      scope: partial?.scope ?? (sessionId.startsWith("web:") ? "web" : "main"),
      createdAt: partial?.createdAt ?? observedAt,
      updatedAt: observedAt,
      unreadCount: partial?.unreadCount ?? 0,
      lastMessagePreview: partial?.lastMessagePreview ?? "",
      archivedAt: partial?.archivedAt ?? null,
    });
  }

  private mergeHarnessSessions(
    registry: PersistedSessionRecord[],
    harnessSessions: SessionSummary[],
  ): PersistedSessionRecord[] {
    const recordsById = new Map(registry.map((record) => [record.id, record]));

    for (const harnessSession of harnessSessions) {
      const current = recordsById.get(harnessSession.id);
      recordsById.set(
        harnessSession.id,
        this.createRecord(harnessSession.id, {
          createdAt: current?.createdAt ?? harnessSession.updatedAt,
          updatedAt:
            current && current.updatedAt.localeCompare(harnessSession.updatedAt) > 0
              ? current.updatedAt
              : harnessSession.updatedAt,
          title: current?.title ?? harnessSession.title,
          scope: current?.scope ?? harnessSession.scope,
          unreadCount: harnessSession.unreadCount,
          lastMessagePreview:
            harnessSession.lastMessagePreview || current?.lastMessagePreview || "",
          archivedAt: current?.archivedAt ?? null,
        }),
      );
    }

    if (!recordsById.has(DEFAULT_WEB_SESSION_ID)) {
      recordsById.set(DEFAULT_WEB_SESSION_ID, this.createRecord(DEFAULT_WEB_SESSION_ID));
    }

    return [...recordsById.values()].sort(compareSessions);
  }

  private async syncRegistry(): Promise<PersistedSessionRecord[]> {
    const [registry, harnessSessions] = await Promise.all([
      this.loadRegistry(),
      harnessService.listSessions(),
    ]);
    const merged = this.mergeHarnessSessions(registry, harnessSessions);
    const changed =
      merged.length !== registry.length ||
      merged.some((record, index) => JSON.stringify(record) !== JSON.stringify(registry[index]));
    if (changed) {
      await this.saveRegistry(merged);
    }
    return merged;
  }

  private nextWebSessionTitle(records: PersistedSessionRecord[]): string {
    const nextNumber =
      records.filter((record) => record.scope === "web").length + 1;
    return nextNumber <= 1 ? "Operator Chat" : `Operator Chat ${nextNumber}`;
  }

  async listActiveSessions(): Promise<SessionSummary[]> {
    const registry = await this.syncRegistry();
    return registry.filter((record) => !record.archivedAt).map(toSummary);
  }

  async listArchivedSessions(): Promise<SessionSummary[]> {
    const registry = await this.syncRegistry();
    return registry.filter((record) => Boolean(record.archivedAt)).map(toSummary);
  }

  async createSession(input?: { title?: string | null; scope?: SessionSummary["scope"] }): Promise<SessionSummary> {
    const registry = await this.syncRegistry();
    const createdAt = nowIso();
    const record = this.createRecord(`web:${randomUUID()}`, {
      title: input?.title?.trim() || this.nextWebSessionTitle(registry),
      scope: input?.scope ?? "web",
      createdAt,
      updatedAt: createdAt,
      lastMessagePreview: "Fresh chat ready. Type when you are ready to retry.",
    });
    await this.saveRegistry([record, ...registry]);
    return toSummary(record);
  }

  async archiveSession(sessionId: string): Promise<SessionSummary> {
    const registry = await this.syncRegistry();
    const now = nowIso();
    const current = registry.find((record) => record.id === sessionId);
    const nextRecord = this.createRecord(sessionId, {
      ...(current ?? {}),
      updatedAt: now,
      archivedAt: now,
    });
    const next = [nextRecord, ...registry.filter((record) => record.id !== sessionId)];
    await this.saveRegistry(next);
    return toSummary(nextRecord);
  }

  async restoreSession(sessionId: string): Promise<SessionSummary> {
    const registry = await this.syncRegistry();
    const now = nowIso();
    const current = registry.find((record) => record.id === sessionId);
    const nextRecord = this.createRecord(sessionId, {
      ...(current ?? {}),
      updatedAt: now,
      archivedAt: null,
    });
    const next = [nextRecord, ...registry.filter((record) => record.id !== sessionId)];
    await this.saveRegistry(next);
    return toSummary(nextRecord);
  }

  async observeSession(
    sessionId: string,
    options?: {
      title?: string;
      restore?: boolean;
      messages?: ChatMessage[];
    },
  ): Promise<SessionSummary> {
    const registry = await this.syncRegistry();
    const current = registry.find((record) => record.id === sessionId);
    const lastMessage = options?.messages?.at(-1) ?? null;
    const updatedAt = lastMessage?.createdAt ?? current?.updatedAt ?? nowIso();
    const nextTitle = options?.title ?? current?.title;
    const nextRecord = this.createRecord(sessionId, {
      ...(current ?? {}),
      ...(nextTitle ? { title: nextTitle } : {}),
      updatedAt,
      lastMessagePreview: lastMessage?.text ?? current?.lastMessagePreview ?? "",
      archivedAt: options?.restore ? null : current?.archivedAt ?? null,
    });
    const next = [nextRecord, ...registry.filter((record) => record.id !== sessionId)];
    await this.saveRegistry(next);
    return toSummary(nextRecord);
  }
}

export const sessionLifecycleService = new SessionLifecycleService();
