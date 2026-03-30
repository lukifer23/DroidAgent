import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import {
  MaintenanceOperationSchema,
  MaintenanceStatusSchema,
  nowIso,
  type MaintenanceAction,
  type MaintenanceOperation,
  type MaintenanceScope,
  type MaintenanceStatus,
} from "@droidagent/shared";

import { db, schema } from "../db/index.js";
import { baseEnv, paths, SERVER_PORT } from "../env.js";
import { openclawService } from "./openclaw-service.js";
import { runtimeService } from "./runtime-service.js";
import { launchAgentService } from "./launch-agent-service.js";
import { jobService } from "./job-service.js";
import { terminalService } from "./terminal-service.js";
import { harnessService } from "./harness-service.js";
import { tailscaleRemoteAccessProvider } from "./remote-access-service.js";

const MAINTENANCE_RECENT_LIMIT = 10;
const SERVER_READY_TIMEOUT_MS = 25_000;
const SERVICE_READY_POLL_MS = 500;
const MAINTENANCE_LOG_PATH = path.join(paths.logsDir, "maintenance.log");
const MAINTENANCE_STATE_PATH = path.join(
  paths.stateDir,
  "maintenance-status.json",
);
const MAINTENANCE_STALE_OPERATION_MS = 3 * 60_000;

function appendMaintenanceLog(message: string): void {
  fs.appendFileSync(
    MAINTENANCE_LOG_PATH,
    `${new Date().toISOString()}\t${message}\n`,
  );
}

function toOperation(
  record: typeof schema.maintenanceOperations.$inferSelect,
): MaintenanceOperation {
  return MaintenanceOperationSchema.parse({
    id: record.id,
    scope: record.scope,
    action: record.action,
    phase: record.phase,
    active: record.active,
    requestedAt: record.requestedAt,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    finishedAt: record.finishedAt,
    requestedByUserId: record.requestedByUserId,
    requestedFromLocalhost: record.requestedFromLocalhost,
    message: record.message,
    lastError: record.lastError,
  });
}

async function waitForHealthcheck(url: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, {
        redirect: "manual",
      });
      if (response.ok) {
        return;
      }
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, SERVICE_READY_POLL_MS));
  }

  throw new Error(`Timed out waiting for ${url}.`);
}

async function stopDirectServerProcesses(): Promise<void> {
  const serverEntrypoint = path.join(paths.serverRoot, "dist", "index.js");
  const processes = await (
    await import("../lib/process.js")
  ).findProcesses(
    (processInfo) =>
      processInfo.pid !== process.pid &&
      processInfo.command.includes(serverEntrypoint),
  );
  await (await import("../lib/process.js")).terminateProcesses(
    processes.map((processInfo) => processInfo.pid),
    {
      timeoutMs: 2_000,
    },
  );
}

async function startManagedServer(): Promise<void> {
  const launchAgentStatus = await launchAgentService.status();
  if (launchAgentStatus.installed) {
    await launchAgentService.start();
    return;
  }

  const serverEntrypoint = path.join(paths.serverRoot, "dist", "index.js");
  if (!fs.existsSync(serverEntrypoint)) {
    throw new Error(
      "Server build output is missing. Run `pnpm build` before maintenance restart.",
    );
  }

  const logPath = path.join(paths.logsDir, "maintenance-server.log");
  const stdoutFd = fs.openSync(logPath, "a");
  const stderrFd = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, [serverEntrypoint], {
    cwd: paths.workspaceRoot,
    detached: true,
    env: {
      ...baseEnv(),
      NODE_ENV: "production",
      DROIDAGENT_PORT: String(SERVER_PORT),
    },
    stdio: ["ignore", stdoutFd, stderrFd],
  });
  child.unref();
}

type StartDetachedRunner = (operationId: string) => Promise<void>;

export class MaintenanceBlockedError extends Error {}

export class MaintenanceConflictError extends Error {}

export class MaintenanceLocalhostRequiredError extends Error {}

async function defaultStartDetachedRunner(operationId: string): Promise<void> {
  const distRunnerPath = path.join(paths.serverRoot, "dist", "maintenance-runner.js");
  const srcRunnerPath = path.join(paths.serverRoot, "src", "maintenance-runner.ts");
  const args = fs.existsSync(distRunnerPath)
    ? [distRunnerPath, operationId]
    : ["--import", "tsx", srcRunnerPath, operationId];
  const child = spawn(process.execPath, args, {
    cwd: paths.workspaceRoot,
    detached: true,
    env: {
      ...baseEnv(),
      DROIDAGENT_MAINTENANCE_RUNNER: "1",
    },
    stdio: "ignore",
  });
  child.unref();
}

export class MaintenanceService {
  constructor(private readonly startDetachedRunner: StartDetachedRunner = defaultStartDetachedRunner) {}

  private async writeStatusMirror(): Promise<void> {
    const status = await this.getStatus();
    await fs.promises.mkdir(path.dirname(MAINTENANCE_STATE_PATH), {
      recursive: true,
    });
    await fs.promises.writeFile(
      MAINTENANCE_STATE_PATH,
      JSON.stringify(status, null, 2),
      "utf8",
    );
  }

  async listRecentOperations(limit = MAINTENANCE_RECENT_LIMIT): Promise<MaintenanceOperation[]> {
    const records = await db.query.maintenanceOperations.findMany({
      orderBy: (operations, { desc }) => [desc(operations.updatedAt)],
      limit,
    });
    return records.map((record) => toOperation(record));
  }

  async getOperation(operationId: string): Promise<MaintenanceOperation> {
    const record = await db.query.maintenanceOperations.findFirst({
      where: eq(schema.maintenanceOperations.id, operationId),
    });
    if (!record) {
      throw new Error("Maintenance operation not found.");
    }
    return toOperation(record);
  }

  async getCurrentOperation(): Promise<MaintenanceOperation | null> {
    const record = await db.query.maintenanceOperations.findFirst({
      where: eq(schema.maintenanceOperations.active, true),
      orderBy: (operations, { desc }) => [desc(operations.updatedAt)],
    });
    return record ? toOperation(record) : null;
  }

  async getStatus(): Promise<MaintenanceStatus> {
    const [current, recent] = await Promise.all([
      this.getCurrentOperation(),
      this.listRecentOperations(),
    ]);
    return MaintenanceStatusSchema.parse({
      active: Boolean(current?.active),
      blocksNewWork: Boolean(current?.active),
      current,
      recent,
      updatedAt: current?.updatedAt ?? recent[0]?.updatedAt ?? nowIso(),
    });
  }

  private isOperationStale(operation: MaintenanceOperation): boolean {
    const updatedAtMs = Date.parse(operation.updatedAt);
    if (!Number.isFinite(updatedAtMs)) {
      return true;
    }
    return Date.now() - updatedAtMs > MAINTENANCE_STALE_OPERATION_MS;
  }

  async reconcileStartupState(): Promise<MaintenanceOperation | null> {
    const current = await this.getCurrentOperation();
    if (!current?.active) {
      return null;
    }
    if (!this.isOperationStale(current)) {
      return current;
    }
    return await this.failOperation(
      current.id,
      new Error(
        "Recovered stale maintenance state after restart. Retry maintenance from the dashboard.",
      ),
    );
  }

  async assertAllowsNewWork(kind: "chat" | "job" | "terminal"): Promise<void> {
    const current = await this.getCurrentOperation();
    if (!current?.active) {
      return;
    }

    const phaseLabel =
      current.phase === "draining" || current.phase === "queued"
        ? "draining"
        : current.phase === "verifying"
          ? "verifying"
          : "restarting";
    throw new MaintenanceBlockedError(
      `Maintenance is ${phaseLabel}. New ${kind} work is temporarily blocked until the host is steady again.`,
    );
  }

  private async updateOperation(
    operationId: string,
    patch: Partial<typeof schema.maintenanceOperations.$inferInsert>,
  ): Promise<MaintenanceOperation> {
    await db
      .update(schema.maintenanceOperations)
      .set({
        ...patch,
        updatedAt: patch.updatedAt ?? nowIso(),
      })
      .where(eq(schema.maintenanceOperations.id, operationId));
    const operation = await this.getOperation(operationId);
    await this.writeStatusMirror();
    return operation;
  }

  async beginOperation(
    params: {
      scope: MaintenanceScope;
      action: MaintenanceAction;
      requestedByUserId?: string | null;
      requestedFromLocalhost: boolean;
    },
  ): Promise<MaintenanceOperation> {
    const active = await this.getCurrentOperation();
    if (active?.active) {
      throw new MaintenanceConflictError(
        "A maintenance operation is already in progress.",
      );
    }

    const timestamp = nowIso();
    const record: typeof schema.maintenanceOperations.$inferInsert = {
      id: randomUUID(),
      scope: params.scope,
      action: params.action,
      phase: "queued",
      active: true,
      requestedAt: timestamp,
      startedAt: null,
      updatedAt: timestamp,
      finishedAt: null,
      requestedByUserId: params.requestedByUserId ?? null,
      requestedFromLocalhost: params.requestedFromLocalhost,
      message: "Maintenance queued.",
      lastError: null,
    };
    await db.insert(schema.maintenanceOperations).values(record);
    const operation = await this.getOperation(record.id);
    await this.writeStatusMirror();
    return operation;
  }

  async markPhase(
    operationId: string,
    phase: MaintenanceOperation["phase"],
    message: string,
  ): Promise<MaintenanceOperation> {
    const current = await this.getOperation(operationId);
    const startedAt =
      current.startedAt ?? (phase === "queued" ? null : nowIso());
    appendMaintenanceLog(`${operationId}\t${phase}\t${message}`);
    return await this.updateOperation(operationId, {
      phase,
      active: !["completed", "failed"].includes(phase),
      startedAt,
      finishedAt:
        phase === "completed" || phase === "failed" ? nowIso() : null,
      message,
      lastError: phase === "failed" ? message : null,
    });
  }

  async completeOperation(operationId: string, message: string): Promise<MaintenanceOperation> {
    appendMaintenanceLog(`${operationId}\tcompleted\t${message}`);
    return await this.updateOperation(operationId, {
      phase: "completed",
      active: false,
      finishedAt: nowIso(),
      message,
      lastError: null,
    });
  }

  async failOperation(operationId: string, error: unknown): Promise<MaintenanceOperation> {
    const message =
      error instanceof Error ? error.message : "Maintenance operation failed.";
    appendMaintenanceLog(`${operationId}\tfailed\t${message}`);
    return await this.updateOperation(operationId, {
      phase: "failed",
      active: false,
      finishedAt: nowIso(),
      message: "Maintenance failed.",
      lastError: message,
    });
  }

  private async verifyCoreServicesHealthy(timeoutMs = SERVER_READY_TIMEOUT_MS): Promise<void> {
    await waitForHealthcheck(
      `http://127.0.0.1:${SERVER_PORT}/api/health`,
      timeoutMs,
    );
    const restoreDeadline = Date.now() + timeoutMs;
    while (Date.now() < restoreDeadline) {
      const openclawStatus = await openclawService.status();
      if (openclawStatus.state === "running") {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, SERVICE_READY_POLL_MS));
    }
    throw new Error("OpenClaw did not report healthy before verification timed out.");
  }

  async retryVerification(): Promise<MaintenanceOperation> {
    const operation = await this.getCurrentOperation();
    if (!operation || operation.phase !== "verifying") {
      throw new Error("No active maintenance verification is pending.");
    }
    await this.verifyCoreServicesHealthy();
    return await this.completeOperation(
      operation.id,
      "Maintenance verification completed and core services are healthy.",
    );
  }

  async clearStaleState(): Promise<MaintenanceOperation | null> {
    const current = await this.getCurrentOperation();
    if (!current?.active) {
      return null;
    }
    if (!this.isOperationStale(current)) {
      throw new Error(
        "Active maintenance is still fresh. Clear stale state is only available for stranded operations.",
      );
    }
    return await this.failOperation(
      current.id,
      new Error(
        "Cleared stale maintenance state by operator action.",
      ),
    );
  }

  async drainLiveWork(operationId: string): Promise<void> {
    await this.markPhase(
      operationId,
      "draining",
      "Draining live chat, jobs, and rescue terminal access.",
    );

    const [terminalSnapshot, sessions] = await Promise.all([
      terminalService.getSnapshot(),
      harnessService.listSessions(),
    ]);

    await Promise.allSettled([
      terminalSnapshot.session
        ? terminalService.closeSession(
            terminalSnapshot.session.id,
            "Closed for maintenance restart.",
          )
        : Promise.resolve(),
      jobService.cancelActiveJobs("Cancelled for maintenance restart."),
      ...sessions.map((session) => harnessService.abortMessage(session.id)),
    ]);
  }

  async requestOperation(params: {
    scope: MaintenanceScope;
    action: MaintenanceAction;
    requestedByUserId?: string | null;
    requestedFromLocalhost: boolean;
  }): Promise<MaintenanceOperation> {
    if (params.scope === "remote" && !params.requestedFromLocalhost) {
      throw new MaintenanceLocalhostRequiredError(
        "Remote maintenance must be started from localhost because it can interrupt the canonical remote path.",
      );
    }

    const operation = await this.beginOperation(params);
    await this.drainLiveWork(operation.id);

    if (params.action === "drain-only") {
      return await this.completeOperation(
        operation.id,
        "Maintenance drain complete. New work may resume.",
      );
    }

    try {
      await this.startDetachedRunner(operation.id);
    } catch (error) {
      await this.failOperation(operation.id, error);
      throw error;
    }

    return await this.getOperation(operation.id);
  }

  async runDetached(operationId: string): Promise<void> {
    const operation = await this.getOperation(operationId);
    if (!operation.active) {
      return;
    }

    try {
      await this.markPhase(operationId, "stopping", "Stopping managed services.");
      if (operation.scope === "remote") {
        await tailscaleRemoteAccessProvider.stopManagedUserspaceDaemon();
      }
      if (operation.scope === "runtime" || operation.scope === "remote") {
        await runtimeService.stopRuntime("ollama");
        await runtimeService.stopRuntime("llamaCpp");
      }
      await openclawService.stopGateway();

      const launchAgentStatus = await launchAgentService.status();
      if (launchAgentStatus.loaded) {
        await launchAgentService.stop();
      }
      await stopDirectServerProcesses();

      await this.markPhase(operationId, "starting", "Starting managed services.");
      if (operation.scope === "runtime" || operation.scope === "remote") {
        const settings = await import("./app-state-service.js").then(
          ({ appStateService }) => appStateService.getRuntimeSettings(),
        );
        if (settings.selectedRuntime === "ollama") {
          await runtimeService.startRuntime("ollama");
        }
      }
      await startManagedServer();

      await this.markPhase(
        operationId,
        "verifying",
        "Waiting for DroidAgent and OpenClaw to become healthy.",
      );
      await this.verifyCoreServicesHealthy();
      const latest = await this.getOperation(operationId);
      if (latest.phase !== "verifying" || !latest.active) {
        throw new Error(
          "Maintenance verification lost operation ownership before completion.",
        );
      }

      if (operation.scope === "remote") {
        await tailscaleRemoteAccessProvider.restartManagedUserspaceServe();
      }

      await this.completeOperation(
        operationId,
        "Maintenance restart completed and core services are healthy.",
      );
    } catch (error) {
      await this.failOperation(operationId, error);
      throw error;
    }
  }
}

export const maintenanceService = new MaintenanceService();
