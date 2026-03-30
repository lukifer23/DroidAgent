import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { JobOutputSnapshotSchema, JobRecordSchema, nowIso, type JobRecord } from "@droidagent/shared";

import { baseEnv, paths } from "../env.js";
import { BufferedOutputPipeline } from "../lib/buffered-output-pipeline.js";
import { JOB_MAX_OUTPUT_BYTES, JOB_TIMEOUT_MS, resolveCwdWithinWorkspace, validateCommand } from "../lib/job-policy.js";
import { appStateService } from "./app-state-service.js";
import { performanceService } from "./performance-service.js";

interface JobOutputEvent {
  jobId: string;
  stream: "stdout" | "stderr";
  chunk: string;
}

type MutableJobRecord = {
  id: string;
  command: string;
  cwd: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  lastLine: string;
};

const AUDIT_LOG_PATH = path.join(paths.logsDir, "jobs-audit.log");
const OUTPUT_FLUSH_DELAY_MS = 24;

async function auditLog(jobId: string, command: string, cwd: string, userId?: string): Promise<void> {
  const line = `${nowIso()}\t${jobId}\t${userId ?? "unknown"}\t${JSON.stringify(command)}\t${cwd}\n`;
  await fs.appendFile(AUDIT_LOG_PATH, line).catch(() => {});
}

function stdoutPath(jobId: string): string {
  return path.join(paths.jobsLogsDir, `${jobId}.stdout.log`);
}

function stderrPath(jobId: string): string {
  return path.join(paths.jobsLogsDir, `${jobId}.stderr.log`);
}

function truncatedMarkerPath(jobId: string): string {
  return path.join(paths.jobsLogsDir, `${jobId}.truncated`);
}

async function fileSize(filePath: string): Promise<number> {
  try {
    const stat = await fs.stat(filePath);
    return stat.size;
  } catch {
    return 0;
  }
}

async function readUtf8(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

export class JobService extends EventEmitter<{
  output: [JobOutputEvent];
  updated: [JobRecord];
}> {
  private readonly activeJobs = new Map<
    string,
    {
      child: ReturnType<typeof spawn>;
      finalize: (
        status: "succeeded" | "failed" | "cancelled",
        exitCode: number | null,
        lastLine?: string,
      ) => Promise<void>;
      timeoutId: ReturnType<typeof setTimeout>;
    }
  >();

  getActiveJobCount(): number {
    return this.activeJobs.size;
  }

  private async toJobRecord(record: MutableJobRecord): Promise<JobRecord> {
    const [stdoutBytes, stderrBytes] = await Promise.all([fileSize(stdoutPath(record.id)), fileSize(stderrPath(record.id))]);
    return JobRecordSchema.parse({
      ...record,
      hasOutput: stdoutBytes + stderrBytes > 0,
      stdoutBytes,
      stderrBytes
    });
  }

  private async emitUpdated(record: MutableJobRecord): Promise<void> {
    this.emit("updated", await this.toJobRecord(record));
  }

  async listJobs() {
    const records = await appStateService.listRecentJobs(30);
    return await Promise.all(
      records.map((record) =>
        this.toJobRecord({
          id: record.id,
          command: record.command,
          cwd: record.cwd,
          status: record.status,
          createdAt: record.createdAt,
          startedAt: record.startedAt,
          finishedAt: record.finishedAt,
          exitCode: record.exitCode,
          lastLine: record.lastLine
        })
      )
    );
  }

  async readJobOutput(jobId: string) {
    const metric = performanceService.start("server", "job.output.read", {
      jobId
    });
    const [stdout, stderr, stdoutBytes, stderrBytes, truncated] = await Promise.all([
      readUtf8(stdoutPath(jobId)),
      readUtf8(stderrPath(jobId)),
      fileSize(stdoutPath(jobId)),
      fileSize(stderrPath(jobId)),
      fs
        .stat(truncatedMarkerPath(jobId))
        .then(() => true)
        .catch(() => false)
    ]);

    const snapshot = JobOutputSnapshotSchema.parse({
      jobId,
      stdout,
      stderr,
      truncated,
      stdoutBytes,
      stderrBytes
    });
    metric.finish({
      bytes: stdoutBytes + stderrBytes,
      truncated
    });
    return snapshot;
  }

  async startJob(command: string, cwd: string, userId?: string) {
    const startMetric = performanceService.start("server", "job.start", {
      cwd
    });
    validateCommand(command);

    const settings = await appStateService.getRuntimeSettings();
    if (!settings.workspaceRoot) {
      throw new Error("Workspace root must be configured before running jobs.");
    }
    const jailedCwd = await resolveCwdWithinWorkspace(cwd, settings.workspaceRoot);

    const record = await appStateService.createJob(command, jailedCwd);
    const state: MutableJobRecord = { ...record };

    await Promise.all([
      fs.writeFile(stdoutPath(record.id), "", "utf8"),
      fs.writeFile(stderrPath(record.id), "", "utf8"),
      fs.rm(truncatedMarkerPath(record.id), { force: true })
    ]);

    await this.emitUpdated(state);
    void auditLog(record.id, command, jailedCwd, userId);

    const child = spawn("/bin/zsh", ["-lc", command], {
      cwd: jailedCwd,
      env: baseEnv(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    startMetric.finish({
      jobId: record.id
    });

    state.status = "running";
    state.startedAt = nowIso();
    await appStateService.updateJob(record.id, {
      status: state.status,
      startedAt: state.startedAt
    });
    await this.emitUpdated(state);

    let outputBytes = 0;
    let truncated = false;
    let finalized = false;
    let firstOutputRecorded = false;
    const firstOutputMetric = performanceService.start("server", "job.firstOutput", {
      jobId: record.id
    });

    const markTruncated = async () => {
      if (truncated) {
        return;
      }
      truncated = true;
      await fs.writeFile(truncatedMarkerPath(record.id), "1", "utf8");
      const note = "\n[output truncated]\n";
      outputPipeline.push("stderr", note);
    };

    const updateLastLine = async (chunk: string) => {
      const trimmed = chunk.trim().split("\n").filter(Boolean).at(-1) ?? "";
      if (!trimmed) {
        return;
      }

      const nextLastLine = trimmed.length > 512 ? `${trimmed.slice(0, 509)}...` : trimmed;
      if (nextLastLine === state.lastLine) {
        return;
      }

      state.lastLine = nextLastLine;
      await appStateService.updateJob(record.id, {
        lastLine: nextLastLine
      });
      await this.emitUpdated(state);
    };

    const writeChunk = async (stream: "stdout" | "stderr", chunk: string) => {
      if (truncated) {
        return;
      }

      if (!firstOutputRecorded && chunk.length > 0) {
        firstOutputRecorded = true;
        firstOutputMetric.finish({
          stream
        });
      }

      const bytes = Buffer.byteLength(chunk, "utf8");
      const remaining = JOB_MAX_OUTPUT_BYTES - outputBytes;
      let allowedChunk = chunk;

      if (remaining <= 0) {
        await markTruncated();
        return;
      }

      if (bytes > remaining) {
        allowedChunk = Buffer.from(chunk, "utf8").subarray(0, remaining).toString("utf8");
      }

      outputBytes += Buffer.byteLength(allowedChunk, "utf8");
      outputPipeline.push(stream, allowedChunk);

      if (bytes > remaining) {
        await markTruncated();
      }
    };

    const finalize = async (status: "succeeded" | "failed" | "cancelled", exitCode: number | null, lastLine?: string) => {
      if (finalized) {
        return;
      }
      finalized = true;
      const active = this.activeJobs.get(record.id);
      if (active) {
        clearTimeout(active.timeoutId);
        this.activeJobs.delete(record.id);
      }
      await outputPipeline.close();
      if (!firstOutputRecorded) {
        firstOutputRecorded = true;
        firstOutputMetric.finish({
          stream: "none",
          outcome: "no-output"
        });
      }
      if (lastLine) {
        state.lastLine = lastLine;
      }
      state.status = status;
      state.finishedAt = nowIso();
      state.exitCode = exitCode;
      await appStateService.updateJob(record.id, {
        status,
        finishedAt: state.finishedAt,
        exitCode,
        lastLine: state.lastLine
      });
      await this.emitUpdated(state);
    };

    const timeoutId = setTimeout(() => {
      void fs.appendFile(stderrPath(record.id), "\n[Job timed out]\n", "utf8").catch(() => {});
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      void finalize("failed", 124, "Job timed out.");
    }, JOB_TIMEOUT_MS);

    this.activeJobs.set(record.id, {
      child,
      finalize,
      timeoutId,
    });

    const outputPipeline = new BufferedOutputPipeline<"stdout" | "stderr">({
      flushDelayMs: OUTPUT_FLUSH_DELAY_MS,
      onFlush: async (chunks) => {
        await Promise.all(
          chunks.map(({ channel, chunk }) =>
            fs.appendFile(
              channel === "stdout" ? stdoutPath(record.id) : stderrPath(record.id),
              chunk,
              "utf8",
            ),
          ),
        );
        for (const { channel, chunk } of chunks) {
          await updateLastLine(chunk);
          this.emit("output", {
            jobId: record.id,
            stream: channel,
            chunk,
          });
        }
      },
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      void writeChunk("stdout", chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      void writeChunk("stderr", chunk);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeoutId);
      const exitCode = typeof code === "number" ? code : signal === "SIGTERM" ? 143 : 1;
      void finalize(exitCode === 0 ? "succeeded" : "failed", exitCode);
    });

    return record.id;
  }

  async cancelActiveJobs(reason = "Cancelled by the operator."): Promise<void> {
    const active = [...this.activeJobs.entries()];
    await Promise.all(
      active.map(async ([jobId, handle]) => {
        await fs
          .appendFile(stderrPath(jobId), `\n[${reason}]\n`, "utf8")
          .catch(() => {});
        try {
          handle.child.kill("SIGTERM");
        } catch {
          // ignore if already gone
        }
        setTimeout(() => {
          try {
            handle.child.kill("SIGKILL");
          } catch {
            // ignore if already gone
          }
        }, 2_000).unref();
        await handle.finalize("cancelled", 130, reason);
      }),
    );
  }
}

export const jobService = new JobService();
