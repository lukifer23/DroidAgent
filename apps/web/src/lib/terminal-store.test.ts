import { afterEach, describe, expect, it } from "vitest";

import type { TerminalSnapshot, TerminalSessionSummary } from "@droidagent/shared";

import { terminalStore } from "./terminal-store";

const baseSession: TerminalSessionSummary = {
  id: "terminal-session",
  scope: "workspace",
  cwd: "/tmp",
  shell: "zsh",
  title: "Workspace",
  status: "running",
  pid: 1234,
  createdAt: "2026-03-29T00:00:00.000Z",
  updatedAt: "2026-03-29T00:00:00.000Z",
  idleExpiresAt: null,
  transcriptBytes: 0,
};

function replaceSnapshot(snapshot: Partial<TerminalSnapshot> = {}): void {
  terminalStore.replace({
    session: baseSession,
    transcript: "",
    truncated: false,
    maxBytes: 256 * 1024,
    closeReason: null,
    ...snapshot,
  });
}

afterEach(() => {
  terminalStore.replace({
    session: null,
    transcript: "",
    truncated: false,
    maxBytes: 256 * 1024,
    closeReason: null,
  });
});

describe("terminalStore", () => {
  it("keeps a byte-bounded UTF-8 safe transcript tail", () => {
    replaceSnapshot();

    terminalStore.appendOutput(baseSession.id, "🙂".repeat(70_000));

    const snapshot = terminalStore.getSnapshot();
    const transcriptBytes = new TextEncoder().encode(snapshot.transcript).length;

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.transcript.endsWith("🙂")).toBe(true);
    expect(snapshot.transcript).not.toContain("\uFFFD");
    expect(transcriptBytes).toBeLessThanOrEqual(snapshot.maxBytes);
    expect(snapshot.transcriptBytes).toBe(transcriptBytes);
  });
});
