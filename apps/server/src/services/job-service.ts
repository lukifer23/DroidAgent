import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";

import { JobRecordSchema, nowIso } from "@droidagent/shared";

import { baseEnv } from "../env.js";
import { appStateService } from "./app-state-service.js";

interface JobOutputEvent {
  jobId: string;
  stream: "stdout" | "stderr";
  chunk: string;
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

  async startJob(command: string, cwd: string) {
    if (/\bsudo\b/.test(command)) {
      throw new Error("`sudo` is not allowed from DroidAgent jobs.");
    }

    const record = await appStateService.createJob(command, cwd);
    const child = spawn("/bin/zsh", ["-lc", command], {
      cwd,
      env: baseEnv(),
      stdio: ["ignore", "pipe", "pipe"]
    });

    await appStateService.updateJob(record.id, {
      status: "running",
      startedAt: nowIso()
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const onChunk = async (stream: "stdout" | "stderr", chunk: string) => {
      const trimmed = chunk.trim().split("\n").filter(Boolean).at(-1) ?? "";
      if (trimmed) {
        await appStateService.updateJob(record.id, {
          lastLine: trimmed
        });
      }
      this.emit("output", {
        jobId: record.id,
        stream,
        chunk
      });
    };

    child.stdout.on("data", (chunk: string) => {
      void onChunk("stdout", chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      void onChunk("stderr", chunk);
    });
    child.on("close", (code) => {
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

