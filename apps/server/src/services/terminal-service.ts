import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { spawn as spawnPty, type IPty, type IDisposable } from "@lydell/node-pty";
import {
  TerminalSessionSummarySchema,
  TerminalSnapshotSchema,
  nowIso,
  type TerminalScope,
  type TerminalSessionSummary,
  type TerminalSnapshot,
} from "@droidagent/shared";

import { baseEnv, paths } from "../env.js";
import { resolveCwdWithinWorkspace } from "../lib/job-policy.js";
import { appStateService } from "./app-state-service.js";
import { performanceService } from "./performance-service.js";

const TERMINAL_TRANSCRIPT_MAX_BYTES = 256 * 1024;
const TERMINAL_IDLE_TIMEOUT_MS = 1000 * 60 * 15;
const DEFAULT_TERMINAL_COLS = 120;
const DEFAULT_TERMINAL_ROWS = 34;
const AUDIT_LOG_PATH = path.join(paths.terminalLogsDir, "terminal-audit.log");

type TerminalOutputEvent = {
  sessionId: string;
  data: string;
};

type TerminalClosedEvent = {
  sessionId: string;
  reason: string | null;
};

type CreatePty = typeof spawnPty;

type TerminalSessionRecord = {
  summary: TerminalSessionSummary;
  pty: IPty;
  transcript: string;
  transcriptPath: string;
  closeReason: string | null;
  closed: boolean;
  firstOutputRecorded: boolean;
  firstOutputMetric: ReturnType<typeof performanceService.start>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  listeners: IDisposable[];
  writeQueue: Promise<void>;
};

function transcriptPathFor(sessionId: string): string {
  return path.join(paths.terminalLogsDir, `${sessionId}.log`);
}

function trimTranscript(transcript: string): {
  transcript: string;
  truncated: boolean;
} {
  const bytes = Buffer.byteLength(transcript, "utf8");
  if (bytes <= TERMINAL_TRANSCRIPT_MAX_BYTES) {
    return {
      transcript,
      truncated: false,
    };
  }

  const buffer = Buffer.from(transcript, "utf8");
  return {
    transcript: buffer.subarray(bytes - TERMINAL_TRANSCRIPT_MAX_BYTES).toString(
      "utf8",
    ),
    truncated: true,
  };
}

function expandHomePath(input: string): string {
  if (input === "~") {
    return process.env.HOME ?? input;
  }
  if (input.startsWith("~/")) {
    return path.join(process.env.HOME ?? "", input.slice(2));
  }
  return input;
}

async function resolveHostDirectory(input: string | undefined): Promise<string> {
  const candidate = expandHomePath(input?.trim() || process.env.HOME || "~");
  const resolved = path.resolve(candidate);
  const realResolved = await fs.realpath(resolved).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new Error("Host working directory does not exist.");
    }
    throw error;
  });
  const stat = await fs.stat(realResolved);
  if (!stat.isDirectory()) {
    throw new Error("Host working directory must be a directory.");
  }
  return realResolved;
}

async function appendAuditLog(message: string): Promise<void> {
  const line = `${nowIso()}\t${message}\n`;
  await fs.appendFile(AUDIT_LOG_PATH, line, "utf8").catch(() => {});
}

export class TerminalService extends EventEmitter<{
  updated: [TerminalSessionSummary];
  output: [TerminalOutputEvent];
  closed: [TerminalClosedEvent];
}> {
  private activeSession: TerminalSessionRecord | null = null;

  constructor(private readonly createPty: CreatePty = spawnPty) {
    super();
  }

  private cloneSummary(summary: TerminalSessionSummary): TerminalSessionSummary {
    return TerminalSessionSummarySchema.parse({
      ...summary,
    });
  }

  private scheduleIdleTimeout(
    session: TerminalSessionRecord,
    broadcast: boolean,
  ): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
    }

    const idleExpiresAt = new Date(Date.now() + TERMINAL_IDLE_TIMEOUT_MS).toISOString();
    session.summary.idleExpiresAt = idleExpiresAt;
    session.summary.updatedAt = nowIso();
    session.idleTimer = setTimeout(() => {
      void this.closeSession(session.summary.id, "Closed after terminal idle timeout.");
    }, TERMINAL_IDLE_TIMEOUT_MS);
    session.idleTimer.unref();

    if (broadcast) {
      this.emit("updated", this.cloneSummary(session.summary));
    }
  }

  private async finalizeSession(
    session: TerminalSessionRecord,
    params: {
      status: "closed" | "error";
      reason: string | null;
      killProcess: boolean;
    },
  ): Promise<void> {
    if (session.closed) {
      return;
    }
    session.closed = true;
    session.closeReason = params.reason;
    if (!session.firstOutputRecorded) {
      session.firstOutputMetric.finish({
        outcome: "no-output",
      });
    }
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    for (const listener of session.listeners) {
      listener.dispose();
    }
    session.listeners = [];
    if (params.killProcess) {
      try {
        session.pty.kill();
      } catch {
        // ignore kill failures for already-exited PTYs
      }
    }
    session.summary.status = params.status;
    session.summary.updatedAt = nowIso();
    session.summary.idleExpiresAt = null;
    if (this.activeSession?.summary.id === session.summary.id) {
      this.activeSession = null;
    }
    this.emit("updated", this.cloneSummary(session.summary));
    this.emit("closed", {
      sessionId: session.summary.id,
      reason: params.reason,
    });
    await appendAuditLog(
      `${session.summary.id}\t${session.summary.scope}\tclosed\t${JSON.stringify(params.reason ?? "")}`,
    );
  }

  private async recordOutput(
    session: TerminalSessionRecord,
    data: string,
  ): Promise<void> {
    if (session.closed || data.length === 0) {
      return;
    }

    if (!session.firstOutputRecorded) {
      session.firstOutputRecorded = true;
      session.firstOutputMetric.finish({
        sessionId: session.summary.id,
        scope: session.summary.scope,
      });
    }

    session.summary.transcriptBytes += Buffer.byteLength(data, "utf8");
    const trimmed = trimTranscript(`${session.transcript}${data}`);
    session.transcript = trimmed.transcript;
    this.scheduleIdleTimeout(session, false);
    this.emit("output", {
      sessionId: session.summary.id,
      data,
    });
    session.writeQueue = session.writeQueue
      .then(async () => {
        await fs.appendFile(session.transcriptPath, data, "utf8");
      })
      .catch(() => {});
  }

  async getSnapshot(): Promise<TerminalSnapshot> {
    return TerminalSnapshotSchema.parse({
      session: this.activeSession
        ? this.cloneSummary(this.activeSession.summary)
        : null,
      transcript: this.activeSession?.transcript ?? "",
      truncated: this.activeSession
        ? this.activeSession.summary.transcriptBytes >
          Buffer.byteLength(this.activeSession.transcript, "utf8")
        : false,
      maxBytes: TERMINAL_TRANSCRIPT_MAX_BYTES,
      closeReason: this.activeSession?.closeReason ?? null,
    });
  }

  async createSession(params: {
    scope: TerminalScope;
    cwd?: string | undefined;
    cols?: number | undefined;
    rows?: number | undefined;
    confirmHostAccess?: boolean | undefined;
    userId?: string | undefined;
  }): Promise<TerminalSnapshot> {
    if (this.activeSession) {
      await this.closeSession(
        this.activeSession.summary.id,
        "Replaced by a new rescue terminal session.",
      );
    }

    const settings = await appStateService.getRuntimeSettings();
    const cwd =
      params.scope === "workspace"
        ? settings.workspaceRoot
          ? await resolveCwdWithinWorkspace(
              params.cwd?.trim() || settings.workspaceRoot,
              settings.workspaceRoot,
            )
          : (() => {
              throw new Error(
                "Configure a workspace before starting the workspace rescue terminal.",
              );
            })()
        : params.confirmHostAccess
          ? await resolveHostDirectory(params.cwd)
          : (() => {
              throw new Error(
                "Host shell access requires explicit confirmation.",
              );
            })();

    const sessionId = randomUUID();
    const transcriptPath = transcriptPathFor(sessionId);
    await fs.writeFile(transcriptPath, "", "utf8");

    const shell = process.env.SHELL || "/bin/zsh";
    const startMetric = performanceService.start("server", "terminal.session.start", {
      scope: params.scope,
      cwd,
    });
    const pty = this.createPty(shell, [], {
      name: "xterm-256color",
      cols: params.cols ?? DEFAULT_TERMINAL_COLS,
      rows: params.rows ?? DEFAULT_TERMINAL_ROWS,
      cwd,
      env: {
        ...baseEnv(),
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        DROIDAGENT_TERMINAL_SCOPE: params.scope,
        DROIDAGENT_TERMINAL_SESSION_ID: sessionId,
      },
    });
    startMetric.finish({
      sessionId,
      scope: params.scope,
      pid: pty.pid,
    });

    const createdAt = nowIso();
    const summary = TerminalSessionSummarySchema.parse({
      id: sessionId,
      scope: params.scope,
      cwd,
      shell,
      title: params.scope === "host" ? "Host rescue shell" : "Workspace rescue shell",
      status: "running",
      pid: pty.pid,
      createdAt,
      updatedAt: createdAt,
      idleExpiresAt: null,
      transcriptBytes: 0,
    });

    const session: TerminalSessionRecord = {
      summary,
      pty,
      transcript: "",
      transcriptPath,
      closeReason: null,
      closed: false,
      firstOutputRecorded: false,
      firstOutputMetric: performanceService.start("server", "terminal.firstOutput", {
        sessionId,
        scope: params.scope,
      }),
      idleTimer: null,
      listeners: [],
      writeQueue: Promise.resolve(),
    };

    session.listeners.push(
      pty.onData((data: string) => {
        void this.recordOutput(session, data);
      }),
    );
    session.listeners.push(
      pty.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
        const reason =
          exitCode === 0
            ? "Terminal session exited."
            : `Terminal exited with code ${exitCode}${signal ? ` (signal ${signal})` : ""}.`;
        void this.finalizeSession(session, {
          status: exitCode === 0 ? "closed" : "error",
          reason,
          killProcess: false,
        });
      }),
    );

    this.activeSession = session;
    this.scheduleIdleTimeout(session, false);
    this.emit("updated", this.cloneSummary(session.summary));
    await appendAuditLog(
      `${sessionId}\t${params.scope}\tcreated\t${JSON.stringify(cwd)}\t${params.userId ?? "unknown"}`,
    );
    return await this.getSnapshot();
  }

  writeInput(sessionId: string, data: string): void {
    const session = this.activeSession;
    if (!session || session.summary.id !== sessionId || session.closed) {
      throw new Error("The rescue terminal session is no longer active.");
    }
    session.pty.write(data);
    this.scheduleIdleTimeout(session, false);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.activeSession;
    if (!session || session.summary.id !== sessionId || session.closed) {
      throw new Error("The rescue terminal session is no longer active.");
    }
    session.pty.resize(cols, rows);
    session.summary.updatedAt = nowIso();
  }

  async closeSession(
    sessionId: string,
    reason: string | null = "Closed by the operator.",
  ): Promise<void> {
    const session = this.activeSession;
    if (!session || session.summary.id !== sessionId) {
      return;
    }
    await this.finalizeSession(session, {
      status: "closed",
      reason,
      killProcess: true,
    });
  }
}

export const terminalService = new TerminalService();
