import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { JobRecordSchema, nowIso } from "@droidagent/shared";

import { baseEnv, paths } from "../env.js";
import { JOB_MAX_OUTPUT_BYTES, JOB_TIMEOUT_MS, resolveCwdWithinWorkspace, validateCommand } from "../lib/job-policy.js";
import { appStateService } from "./app-state-service.js";

interface JobOutputEvent {
  jobId: string;
  stream: "stdout" | "stderr";
  chunk: string;
}

const AUDIT_LOG_PATH = path.join(paths.logsDir, "jobs-audit.log");

async function auditLog(jobId: string, command: string, cwd: string, userId?: string): Promise<void> {
  const line = `${nowIso()}\t${jobId}\t${userId ?? "unknown"}\t${JSON.stringify(command)}\t${cwd}\n`;
  await fs.appendFile(AUDIT_LOG_PATH, line).catch(() => {});
}

export class JobService extends EventEmitter<{
  output: [JobOutputEvent];
}> {
  async listJobs() {
    const records = await appStateService.listRecentJobs(30);
    return records.map((record) =>
      JobRecordSchema.parse({
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
    );
  }

  async startJob(command: string, cwd: string, userId?: string) {
    validateCommand(command);

    const settings = await appStateService.getRuntimeSettings();
    if (!settings.workspaceRoot) {
      throw new Error("Workspace root must be configured before running jobs.");
    }
    const jailedCwd = resolveCwdWithinWorkspace(cwd, settings.workspaceRoot);

    const record = await appStateService.createJob(command, jailedCwd);
    void auditLog(record.id, command, jailedCwd, userId);

    const child = spawn("/bin/zsh", ["-lc", command], {
      cwd: jailedCwd,
      env: baseEnv(),
      stdio: ["ignore", "pipe", "pipe"]
    });

    await appStateService.updateJob(record.id, {
      status: "running",
      startedAt: nowIso()
    });

    let outputBytes = 0;
    const timeoutId = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      void appStateService.updateJob(record.id, {
        status: "failed",
        finishedAt: nowIso(),
        exitCode: 124,
        lastLine: "Job timed out."
      });
    }, JOB_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const onChunk = async (stream: "stdout" | "stderr", chunk: string) => {
      const bytes = Buffer.byteLength(chunk, "utf8");
      outputBytes += bytes;
      if (outputBytes > JOB_MAX_OUTPUT_BYTES) {
        return;
      }
      const trimmed = chunk.trim().split("\n").filter(Boolean).at(-1) ?? "";
      if (trimmed) {
        await appStateService.updateJob(record.id, {
          lastLine: trimmed.length > 512 ? trimmed.slice(0, 509) + "…" : trimmed
        });
      }
      this.emit("output", {
        jobId: record.id,
        stream,
        chunk: outputBytes <= JOB_MAX_OUTPUT_BYTES ? chunk : ""
      });
    };

    child.stdout.on("data", (chunk: string) => {
      void onChunk("stdout", chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      void onChunk("stderr", chunk);
    });
    child.on("close", (code) => {
      clearTimeout(timeoutId);
      void appStateService.updateJob(record.id, {
        status: code === 0 ? "succeeded" : "failed",
        finishedAt: nowIso(),
        exitCode: code
      });
    });

    return record.id;
  }
}

export const jobService = new JobService();

