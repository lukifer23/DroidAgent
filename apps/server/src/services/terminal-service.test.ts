import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "@lydell/node-pty";

const { getRuntimeSettings, envState } = vi.hoisted(() => ({
  getRuntimeSettings: vi.fn(),
  envState: {
    terminalLogsDir: "/tmp/droidagent-terminal-tests",
  },
}));

vi.mock("./app-state-service.js", () => ({
  appStateService: {
    getRuntimeSettings,
  },
}));

vi.mock("../env.js", () => ({
  baseEnv: () => ({
    HOME: process.env.HOME ?? "",
    PATH: process.env.PATH ?? "",
  }),
  paths: envState,
}));

import { TerminalService } from "./terminal-service.js";

class FakePty implements IPty {
  pid = 4242;
  cols: number;
  rows: number;
  process = "zsh";
  handleFlowControl = false;
  writes: Array<string | Buffer> = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<
    (event: { exitCode: number; signal?: number }) => void
  >();

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }

  readonly onData = (listener: (data: string) => void) => {
    this.dataListeners.add(listener);
    return {
      dispose: () => {
        this.dataListeners.delete(listener);
      },
    };
  };

  readonly onExit = (
    listener: (event: { exitCode: number; signal?: number }) => void,
  ) => {
    this.exitListeners.add(listener);
    return {
      dispose: () => {
        this.exitListeners.delete(listener);
      },
    };
  };

  resize(columns: number, rows: number): void {
    this.cols = columns;
    this.rows = rows;
  }

  clear(): void {}

  write(data: string | Buffer): void {
    this.writes.push(data);
  }

  kill(): void {
    this.emitExit({ exitCode: 0 });
  }

  pause(): void {}

  resume(): void {}

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitExit(event: { exitCode: number; signal?: number }): void {
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}

describe("TerminalService", () => {
  let workspaceRoot: string;
  let fakePty: FakePty;
  let terminalService: TerminalService;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "droidagent-terminal-workspace-"),
    );
    envState.terminalLogsDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "droidagent-terminal-logs-"),
    );
    getRuntimeSettings.mockResolvedValue({
      workspaceRoot,
    });
    fakePty = new FakePty(120, 34);
    terminalService = new TerminalService(
      (() => fakePty) as unknown as typeof import("@lydell/node-pty").spawn,
    );
  });

  afterEach(async () => {
    getRuntimeSettings.mockReset();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(envState.terminalLogsDir, { recursive: true, force: true });
  });

  it("creates a workspace session and streams transcript output", async () => {
    const snapshot = await terminalService.createSession({
      scope: "workspace",
      userId: "owner-id",
    });
    const realWorkspaceRoot = await fs.realpath(workspaceRoot);

    expect(snapshot.session?.scope).toBe("workspace");
    expect(snapshot.session?.cwd).toBe(realWorkspaceRoot);

    fakePty.emitData("term-ok\r\n");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const active = await terminalService.getSnapshot();
    expect(active.transcript).toContain("term-ok");

    terminalService.writeInput(snapshot.session!.id, "printf 'ok'\n");
    expect(fakePty.writes).toContain("printf 'ok'\n");

    const logPath = path.join(
      envState.terminalLogsDir,
      `${snapshot.session!.id}.log`,
    );
    expect(await fs.readFile(logPath, "utf8")).toContain("term-ok");
  });

  it("requires explicit confirmation before opening a host shell", async () => {
    await expect(
      terminalService.createSession({
        scope: "host",
      }),
    ).rejects.toThrow(/explicit confirmation/i);
  });

  it("closes the active session and clears the snapshot", async () => {
    const snapshot = await terminalService.createSession({
      scope: "workspace",
      userId: "owner-id",
    });

    await terminalService.closeSession(snapshot.session!.id);

    const active = await terminalService.getSnapshot();
    expect(active.session).toBeNull();
  });
});
