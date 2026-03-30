import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  maintenanceOperationsTable,
  db,
  resetDb,
  envState,
  dependencyMocks,
  processMocks,
} = vi.hoisted(() => {
  const operationRecords: Array<Record<string, unknown>> = [];
  const maintenanceOperationsTable = {
    table: "maintenanceOperations",
    id: "id",
    active: "active",
  };

  const db = {
    query: {
      maintenanceOperations: {
        findMany: vi.fn(async () =>
          [...operationRecords].sort((left, right) =>
            String(right.updatedAt).localeCompare(String(left.updatedAt)),
          ),
        ),
        findFirst: vi.fn(
          async (args?: { where?: { column?: string; value?: string | boolean } }) => {
            if (args?.where?.column === "active") {
              return (
                operationRecords.find(
                  (record) => record.active === args.where?.value,
                ) ?? null
              );
            }
            if (args?.where?.column === "id") {
              return (
                operationRecords.find((record) => record.id === args.where?.value) ??
                null
              );
            }
            return operationRecords[0] ?? null;
          },
        ),
      },
    },
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (record: Record<string, unknown>) => {
        if (table === maintenanceOperationsTable) {
          operationRecords.push({ ...record });
        }
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((patch: Record<string, unknown>) => ({
        where: vi.fn(async (where: { value?: string | boolean }) => {
          if (table !== maintenanceOperationsTable) {
            return;
          }
          const target = operationRecords.find(
            (record) => record.id === where.value,
          );
          if (target) {
            Object.assign(target, patch);
          }
        }),
      })),
    })),
  };

  const envState = {
    workspaceRoot: "/tmp/droidagent-maintenance-workspace",
    serverRoot: "/tmp/droidagent-maintenance-server",
    logsDir: "/tmp/droidagent-maintenance-logs",
    stateDir: "/tmp/droidagent-maintenance-state",
  };

  const dependencyMocks = {
    openclawService: {
      stopGateway: vi.fn(),
      status: vi.fn(),
    },
    runtimeService: {
      stopRuntime: vi.fn(),
      startRuntime: vi.fn(),
    },
    launchAgentService: {
      status: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    },
    jobService: {
      cancelActiveJobs: vi.fn(),
    },
    terminalService: {
      getSnapshot: vi.fn(),
      closeSession: vi.fn(),
    },
    harnessService: {
      listSessions: vi.fn(),
      abortMessage: vi.fn(),
    },
    tailscaleRemoteAccessProvider: {
      stopManagedUserspaceDaemon: vi.fn(),
      restartManagedUserspaceServe: vi.fn(),
    },
    appStateService: {
      getRuntimeSettings: vi.fn(),
    },
  };

  const processMocks = {
    findProcesses: vi.fn(),
    terminateProcesses: vi.fn(),
  };

  return {
    maintenanceOperationsTable,
    db,
    resetDb: () => {
      operationRecords.splice(0, operationRecords.length);
      db.query.maintenanceOperations.findMany.mockClear();
      db.query.maintenanceOperations.findFirst.mockClear();
      db.insert.mockClear();
      db.update.mockClear();
      for (const group of Object.values(dependencyMocks)) {
        for (const value of Object.values(group)) {
          value.mockReset();
        }
      }
      processMocks.findProcesses.mockReset();
      processMocks.terminateProcesses.mockReset();
    },
    envState,
    dependencyMocks,
    processMocks,
  };
});

vi.mock("drizzle-orm", () => ({
  eq: (column: string, value: string | boolean) => ({ column, value }),
}));

vi.mock("../db/index.js", () => ({
  db,
  schema: {
    maintenanceOperations: maintenanceOperationsTable,
  },
}));

vi.mock("../env.js", () => ({
  SERVER_PORT: 4318,
  baseEnv: () => ({
    PATH: process.env.PATH ?? "",
  }),
  paths: envState,
}));

vi.mock("./openclaw-service.js", () => ({
  openclawService: dependencyMocks.openclawService,
}));

vi.mock("./runtime-service.js", () => ({
  runtimeService: dependencyMocks.runtimeService,
}));

vi.mock("./launch-agent-service.js", () => ({
  launchAgentService: dependencyMocks.launchAgentService,
}));

vi.mock("./job-service.js", () => ({
  jobService: dependencyMocks.jobService,
}));

vi.mock("./terminal-service.js", () => ({
  terminalService: dependencyMocks.terminalService,
}));

vi.mock("./harness-service.js", () => ({
  harnessService: dependencyMocks.harnessService,
}));

vi.mock("./remote-access-service.js", () => ({
  tailscaleRemoteAccessProvider: dependencyMocks.tailscaleRemoteAccessProvider,
}));

vi.mock("./app-state-service.js", () => ({
  appStateService: dependencyMocks.appStateService,
}));

vi.mock("../lib/process.js", () => processMocks);

import {
  MaintenanceBlockedError,
  MaintenanceConflictError,
  MaintenanceLocalhostRequiredError,
  MaintenanceService,
} from "./maintenance-service.js";

describe("MaintenanceService", () => {
  let tempRoot: string;
  let service: MaintenanceService;
  let startDetachedRunner: ReturnType<typeof vi.fn>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    resetDb();
    tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "droidagent-maintenance-"),
    );
    envState.workspaceRoot = tempRoot;
    envState.serverRoot = tempRoot;
    await fs.mkdir(envState.logsDir, { recursive: true });
    await fs.mkdir(envState.stateDir, { recursive: true });

    startDetachedRunner = vi.fn().mockResolvedValue(undefined);
    service = new MaintenanceService(startDetachedRunner);

    dependencyMocks.terminalService.getSnapshot.mockResolvedValue({
      session: { id: "term-1" },
    });
    dependencyMocks.harnessService.listSessions.mockResolvedValue([
      { id: "web:operator" },
      { id: "web:secondary" },
    ]);
    dependencyMocks.openclawService.stopGateway.mockResolvedValue(undefined);
    dependencyMocks.openclawService.status.mockResolvedValue({
      state: "running",
    });
    dependencyMocks.runtimeService.stopRuntime.mockResolvedValue(undefined);
    dependencyMocks.runtimeService.startRuntime.mockResolvedValue(undefined);
    dependencyMocks.launchAgentService.status.mockResolvedValue({
      installed: true,
      loaded: true,
    });
    dependencyMocks.launchAgentService.start.mockResolvedValue(undefined);
    dependencyMocks.launchAgentService.stop.mockResolvedValue(undefined);
    dependencyMocks.jobService.cancelActiveJobs.mockResolvedValue(undefined);
    dependencyMocks.harnessService.abortMessage.mockResolvedValue(undefined);
    dependencyMocks.terminalService.closeSession.mockResolvedValue(undefined);
    dependencyMocks.tailscaleRemoteAccessProvider.stopManagedUserspaceDaemon.mockResolvedValue(
      undefined,
    );
    dependencyMocks.tailscaleRemoteAccessProvider.restartManagedUserspaceServe.mockResolvedValue(
      undefined,
    );
    dependencyMocks.appStateService.getRuntimeSettings.mockResolvedValue({
      selectedRuntime: "ollama",
    });
    processMocks.findProcesses.mockResolvedValue([]);
    processMocks.terminateProcesses.mockResolvedValue(undefined);

    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("blocks remote-scope maintenance unless the request came from localhost", async () => {
    await expect(
      service.requestOperation({
        scope: "remote",
        action: "restart",
        requestedFromLocalhost: false,
      }),
    ).rejects.toBeInstanceOf(MaintenanceLocalhostRequiredError);
  });

  it("drains live work and completes drain-only maintenance without a detached runner", async () => {
    const operation = await service.requestOperation({
      scope: "app",
      action: "drain-only",
      requestedByUserId: "owner-1",
      requestedFromLocalhost: true,
    });

    expect(operation.phase).toBe("completed");
    expect(operation.active).toBe(false);
    expect(startDetachedRunner).not.toHaveBeenCalled();
    expect(dependencyMocks.terminalService.closeSession).toHaveBeenCalledWith(
      "term-1",
      "Closed for maintenance restart.",
    );
    expect(dependencyMocks.jobService.cancelActiveJobs).toHaveBeenCalledWith(
      "Cancelled for maintenance restart.",
    );
    expect(dependencyMocks.harnessService.abortMessage).toHaveBeenCalledTimes(2);
  });

  it("rejects overlapping maintenance operations", async () => {
    await service.beginOperation({
      scope: "app",
      action: "restart",
      requestedFromLocalhost: true,
    });

    await expect(
      service.beginOperation({
        scope: "runtime",
        action: "restart",
        requestedFromLocalhost: true,
      }),
    ).rejects.toBeInstanceOf(MaintenanceConflictError);
  });

  it("blocks new work while an operation is active", async () => {
    await service.beginOperation({
      scope: "app",
      action: "restart",
      requestedFromLocalhost: true,
    });

    await expect(service.assertAllowsNewWork("chat")).rejects.toBeInstanceOf(
      MaintenanceBlockedError,
    );
  });

  it("runs a restart sequence and marks the operation complete once health returns", async () => {
    const operation = await service.beginOperation({
      scope: "remote",
      action: "restart",
      requestedFromLocalhost: true,
    });

    await service.runDetached(operation.id);

    const completed = await service.getOperation(operation.id);
    expect(completed.phase).toBe("completed");
    expect(completed.active).toBe(false);
    expect(dependencyMocks.tailscaleRemoteAccessProvider.stopManagedUserspaceDaemon).toHaveBeenCalledTimes(
      1,
    );
    expect(dependencyMocks.runtimeService.stopRuntime).toHaveBeenCalledWith(
      "ollama",
    );
    expect(dependencyMocks.runtimeService.stopRuntime).toHaveBeenCalledWith(
      "llamaCpp",
    );
    expect(dependencyMocks.runtimeService.startRuntime).toHaveBeenCalledWith(
      "ollama",
    );
    expect(dependencyMocks.launchAgentService.stop).toHaveBeenCalledTimes(1);
    expect(dependencyMocks.launchAgentService.start).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:4318/api/health",
      expect.any(Object),
    );
    expect(
      dependencyMocks.tailscaleRemoteAccessProvider.restartManagedUserspaceServe,
    ).toHaveBeenCalledTimes(1);
  });

  it("marks the operation failed when a restart step throws", async () => {
    const operation = await service.beginOperation({
      scope: "runtime",
      action: "restart",
      requestedFromLocalhost: true,
    });
    dependencyMocks.runtimeService.stopRuntime.mockRejectedValueOnce(
      new Error("ollama stop failed"),
    );

    await expect(service.runDetached(operation.id)).rejects.toThrow(
      /ollama stop failed/i,
    );

    const failed = await service.getOperation(operation.id);
    expect(failed.phase).toBe("failed");
    expect(failed.active).toBe(false);
    expect(failed.lastError).toMatch(/ollama stop failed/i);
  });

  it("fails restart verification when OpenClaw health checks fail", async () => {
    const operation = await service.beginOperation({
      scope: "runtime",
      action: "restart",
      requestedFromLocalhost: true,
    });
    dependencyMocks.openclawService.status.mockRejectedValueOnce(
      new Error("gateway unavailable"),
    );

    await expect(service.runDetached(operation.id)).rejects.toThrow(
      /gateway unavailable/i,
    );

    const failed = await service.getOperation(operation.id);
    expect(failed.phase).toBe("failed");
    expect(failed.active).toBe(false);
  });

  it("reconciles stale active maintenance on startup", async () => {
    const staleUpdatedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await db.insert(maintenanceOperationsTable).values({
      id: "stale-op",
      scope: "app",
      action: "restart",
      phase: "verifying",
      active: true,
      requestedAt: staleUpdatedAt,
      startedAt: staleUpdatedAt,
      updatedAt: staleUpdatedAt,
      finishedAt: null,
      requestedByUserId: "owner-1",
      requestedFromLocalhost: true,
      message: "stuck",
      lastError: null,
    });

    const reconciled = await service.reconcileStartupState();
    expect(reconciled?.phase).toBe("failed");
    expect(reconciled?.active).toBe(false);
    expect(reconciled?.lastError).toMatch(/stale maintenance state/i);
  });

  it("retries verification for an active verifying operation", async () => {
    const operation = await service.beginOperation({
      scope: "app",
      action: "restart",
      requestedFromLocalhost: true,
    });
    await service.markPhase(operation.id, "verifying", "Waiting for health.");

    const completed = await service.retryVerification();
    expect(completed.phase).toBe("completed");
    expect(completed.active).toBe(false);
  });

  it("rejects clearing stale state for fresh active maintenance", async () => {
    const operation = await service.beginOperation({
      scope: "app",
      action: "restart",
      requestedFromLocalhost: true,
    });

    await expect(service.clearStaleState()).rejects.toThrow(/still fresh/i);
    const current = await service.getOperation(operation.id);
    expect(current.active).toBe(true);
  });
});
