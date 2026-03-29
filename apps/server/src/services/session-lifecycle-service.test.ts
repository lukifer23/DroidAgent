import { beforeEach, describe, expect, it, vi } from "vitest";

import { nowIso, type ChatMessage, type SessionSummary } from "@droidagent/shared";

const mocks = vi.hoisted(() => {
  let registry: unknown[] = [];
  let harnessSessions: SessionSummary[] = [];

  return {
    getRegistry: () => registry,
    setRegistry: (value: unknown[]) => {
      registry = value;
    },
    getHarnessSessions: () => harnessSessions,
    setHarnessSessions: (value: SessionSummary[]) => {
      harnessSessions = value;
    },
    getJsonSetting: vi.fn(async (_key: string, fallback: unknown) => {
      return registry.length > 0 ? registry : fallback;
    }),
    setJsonSetting: vi.fn(async (_key: string, value: unknown) => {
      registry = JSON.parse(JSON.stringify(value)) as unknown[];
    }),
    listSessions: vi.fn(async () => harnessSessions),
  };
});

vi.mock("./app-state-service.js", () => ({
  appStateService: {
    getJsonSetting: mocks.getJsonSetting,
    setJsonSetting: mocks.setJsonSetting,
  },
}));

vi.mock("./harness-service.js", () => ({
  harnessService: {
    listSessions: mocks.listSessions,
  },
}));

import { SessionLifecycleService } from "./session-lifecycle-service.js";

describe("SessionLifecycleService", () => {
  let service: SessionLifecycleService;

  beforeEach(() => {
    service = new SessionLifecycleService();
    mocks.setRegistry([]);
    mocks.setHarnessSessions([]);
    mocks.getJsonSetting.mockClear();
    mocks.setJsonSetting.mockClear();
    mocks.listSessions.mockClear();
    mocks.listSessions.mockImplementation(async () => mocks.getHarnessSessions());
  });

  it("creates a real persisted web session and keeps it in the active list", async () => {
    const session = await service.createSession();
    const active = await service.listActiveSessions();

    expect(session.id.startsWith("web:")).toBe(true);
    expect(active.some((entry) => entry.id === session.id)).toBe(true);
    expect(active.some((entry) => entry.id === "web:operator")).toBe(true);
  });

  it("archives and restores a session without deleting its history record", async () => {
    const created = await service.createSession();

    await service.archiveSession(created.id);
    const archived = await service.listArchivedSessions();
    const activeAfterArchive = await service.listActiveSessions();

    expect(archived.some((entry) => entry.id === created.id)).toBe(true);
    expect(activeAfterArchive.some((entry) => entry.id === created.id)).toBe(
      false,
    );

    await service.restoreSession(created.id);
    const activeAfterRestore = await service.listActiveSessions();

    expect(activeAfterRestore.some((entry) => entry.id === created.id)).toBe(
      true,
    );
  });

  it("keeps archived sessions out of the active list even when the harness still reports them", async () => {
    const created = await service.createSession();
    mocks.setHarnessSessions([created]);

    await service.archiveSession(created.id);

    const active = await service.listActiveSessions();
    const archived = await service.listArchivedSessions();

    expect(active.some((entry) => entry.id === created.id)).toBe(false);
    expect(archived.some((entry) => entry.id === created.id)).toBe(true);
  });

  it("merges harness sessions into the registry and updates previews from observed messages", async () => {
    mocks.setHarnessSessions([
      {
        id: "signal:+15551234567",
        title: "SMS Pairing",
        scope: "signal",
        updatedAt: "2026-03-29T18:00:00.000Z",
        unreadCount: 0,
        lastMessagePreview: "Incoming hello",
      },
    ]);

    const active = await service.listActiveSessions();

    expect(active.some((entry) => entry.id === "signal:+15551234567")).toBe(
      true,
    );

    const messages: ChatMessage[] = [
      {
        id: "msg-1",
        sessionId: "signal:+15551234567",
        role: "assistant",
        text: "Updated preview",
        parts: [
          {
            type: "markdown",
            text: "Updated preview",
          },
        ],
        attachments: [],
        createdAt: nowIso(),
        status: "complete",
        source: "openclaw",
      },
    ];

    const observed = await service.observeSession("signal:+15551234567", {
      messages,
    });

    expect(observed.lastMessagePreview).toBe("Updated preview");
  });
});
