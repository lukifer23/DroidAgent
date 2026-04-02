import { beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryStatusSchema, type MemoryStatus } from "@droidagent/shared";

const mocks = vi.hoisted(() => {
  const state = {
    prepareStatus: {
      state: "idle" as const,
      startedAt: null as string | null,
      finishedAt: null as string | null,
      progressLabel: null as string | null,
      error: null as string | null,
      lastDurationMs: null as number | null,
      updatedAt: "2026-03-29T00:00:00.000Z",
    },
    memoryStatus: null as unknown,
  };

  return {
    state,
    getMemoryPrepareStatus: vi.fn(async () => state.prepareStatus),
    updateMemoryPrepareStatus: vi.fn(async (update) => {
      state.prepareStatus = {
        ...state.prepareStatus,
        ...update,
        updatedAt: "2026-03-29T00:00:01.000Z",
      };
    }),
    getJsonSetting: vi.fn(async () => null as string | null),
    setJsonSetting: vi.fn(async () => undefined),
    getRuntimeSettings: vi.fn(async () => ({
      selectedRuntime: "ollama" as const,
      ollamaEmbeddingModel: "embeddinggemma:300m-qat-q8_0",
    })),
    memoryStatus: vi.fn(async () => state.memoryStatus),
    memoryStatusQuick: vi.fn(async () => state.memoryStatus),
    prepareSemanticMemory: vi.fn(async () => state.memoryStatus),
    invalidateMemoryStatusCache: vi.fn(),
    startRuntime: vi.fn(async () => undefined),
    ensureOllamaModel: vi.fn(async () => undefined),
    performanceStart: vi.fn(() => ({
      finish: vi.fn(),
    })),
  };
});

vi.mock("./app-state-service.js", () => ({
  appStateService: {
    getMemoryPrepareStatus: mocks.getMemoryPrepareStatus,
    updateMemoryPrepareStatus: mocks.updateMemoryPrepareStatus,
    getJsonSetting: mocks.getJsonSetting,
    setJsonSetting: mocks.setJsonSetting,
    getRuntimeSettings: mocks.getRuntimeSettings,
  },
}));

vi.mock("./openclaw-service.js", () => ({
  openclawService: {
    memoryStatus: mocks.memoryStatus,
    memoryStatusQuick: mocks.memoryStatusQuick,
    prepareSemanticMemory: mocks.prepareSemanticMemory,
    invalidateMemoryStatusCache: mocks.invalidateMemoryStatusCache,
  },
}));

vi.mock("./runtime-service.js", () => ({
  runtimeService: {
    startRuntime: mocks.startRuntime,
    ensureOllamaModel: mocks.ensureOllamaModel,
  },
}));

vi.mock("./performance-service.js", () => ({
  performanceService: {
    start: mocks.performanceStart,
  },
}));

import { MemoryPrepareService } from "./memory-prepare-service.js";
import { computeMemorySourceFingerprint } from "../lib/memory-fingerprint.js";

function makeMemoryStatus(overrides: Partial<MemoryStatus> = {}): MemoryStatus {
  return MemoryStatusSchema.parse({
    configuredWorkspaceRoot: "/workspace",
    effectiveWorkspaceRoot: "/workspace",
    ready: true,
    semanticReady: true,
    memoryDirectory: "/workspace/memory",
    memoryDirectoryReady: true,
    skillsDirectory: "/workspace/skills",
    skillsDirectoryReady: true,
    memoryFilePath: "/workspace/MEMORY.md",
    todayNotePath: "/workspace/memory/2026-03-29.md",
    bootstrapFiles: [],
    bootstrapFilesReady: 0,
    bootstrapFilesTotal: 0,
    memorySearchEnabled: true,
    sessionMemoryEnabled: true,
    embeddingProvider: "ollama",
    embeddingRequestedProvider: "ollama",
    embeddingFallback: null,
    embeddingModel: "embeddinggemma:300m-qat-q8_0",
    indexedFiles: 4,
    indexedChunks: 16,
    dirty: false,
    vectorEnabled: true,
    vectorAvailable: true,
    embeddingProbeOk: true,
    embeddingProbeError: null,
    sourceCounts: [],
    contextWindow: 65536,
    prepareState: "idle",
    prepareStartedAt: null,
    prepareFinishedAt: null,
    prepareProgressLabel: null,
    prepareError: null,
    lastPrepareDurationMs: null,
    ...overrides,
  });
}

describe("MemoryPrepareService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.prepareStatus = {
      state: "idle",
      startedAt: null,
      finishedAt: null,
      progressLabel: null,
      error: null,
      lastDurationMs: null,
      updatedAt: "2026-03-29T00:00:00.000Z",
    };
    mocks.state.memoryStatus = makeMemoryStatus();
    mocks.getJsonSetting.mockReset();
    mocks.getJsonSetting.mockResolvedValue(null);
    mocks.setJsonSetting.mockReset();
  });

  it("runs a single background prepare and persists completion state", async () => {
    let resolvePrepare!: (status: MemoryStatus) => void;
    const preparePromise = new Promise<MemoryStatus>((resolve) => {
      resolvePrepare = resolve;
    });
    const finish = vi.fn();
    mocks.performanceStart.mockReturnValue({
      finish,
    });
    mocks.prepareSemanticMemory.mockImplementation(() => preparePromise);

    const service = new MemoryPrepareService();
    const listener = vi.fn();
    service.subscribe(listener);

    const first = await service.triggerPrepare({
      source: "operator",
    });
    const second = await service.triggerPrepare({
      source: "operator",
    });

    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    await vi.waitFor(() => {
      expect(mocks.startRuntime).toHaveBeenCalledTimes(1);
      expect(mocks.ensureOllamaModel).toHaveBeenCalledWith(
        "embeddinggemma:300m-qat-q8_0",
      );
      expect(mocks.prepareSemanticMemory).toHaveBeenCalledTimes(1);
      expect(mocks.state.prepareStatus.state).toBe("running");
    });

    mocks.state.memoryStatus = makeMemoryStatus({
      prepareState: "running",
      prepareStartedAt: "2026-03-29T00:00:01.000Z",
    });
    resolvePrepare(mocks.state.memoryStatus as MemoryStatus);

    await vi.waitFor(() => {
      expect(mocks.state.prepareStatus.state).toBe("completed");
    });

    expect(mocks.state.prepareStatus.progressLabel).toBe(
      "Semantic memory is ready.",
    );
    expect(mocks.invalidateMemoryStatusCache).toHaveBeenCalled();
    expect(listener).toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "ok",
        semanticReady: true,
      }),
    );
  });

  it("records failed prepares and exposes the last error", async () => {
    const finish = vi.fn();
    mocks.performanceStart.mockReturnValue({
      finish,
    });
    mocks.prepareSemanticMemory.mockRejectedValue(new Error("index failed"));

    const service = new MemoryPrepareService();
    const result = await service.triggerPrepare({
      source: "operator",
    });

    expect(result.started).toBe(true);

    await vi.waitFor(() => {
      expect(mocks.state.prepareStatus.state).toBe("failed");
    });

    expect(mocks.state.prepareStatus.error).toBe("index failed");
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "error",
      }),
    );
  });

  it("records an operator completion sample when joining an active prewarm", async () => {
    let resolvePrepare!: (status: MemoryStatus) => void;
    const preparePromise = new Promise<MemoryStatus>((resolve) => {
      resolvePrepare = resolve;
    });
    const prewarmFinish = vi.fn();
    const operatorFinish = vi.fn();
    mocks.performanceStart
      .mockReturnValueOnce({
        finish: prewarmFinish,
      })
      .mockReturnValueOnce({
        finish: operatorFinish,
      });
    mocks.prepareSemanticMemory.mockImplementation(() => preparePromise);

    const service = new MemoryPrepareService();
    const prewarm = await service.triggerPrepare({
      source: "prewarm",
    });

    await vi.waitFor(() => {
      expect(mocks.prepareSemanticMemory).toHaveBeenCalledTimes(1);
    });

    const operator = await service.triggerPrepare({
      source: "operator",
    });

    expect(prewarm.started).toBe(true);
    expect(operator.started).toBe(false);

    resolvePrepare(makeMemoryStatus());

    await vi.waitFor(() => {
      expect(operatorFinish).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: "ok",
          joined: true,
          semanticReady: true,
        }),
      );
    });

    expect(mocks.performanceStart).toHaveBeenNthCalledWith(
      1,
      "server",
      "memory.prepare.complete",
      expect.objectContaining({
        source: "prewarm",
      }),
    );
    expect(mocks.performanceStart).toHaveBeenNthCalledWith(
      2,
      "server",
      "memory.prepare.complete",
      expect.objectContaining({
        source: "operator",
        joined: true,
      }),
    );
  });

  it("marks no-op prepares as ready when the current fingerprint is unchanged", async () => {
    const finish = vi.fn();
    mocks.performanceStart.mockReturnValue({
      finish,
    });
    mocks.state.memoryStatus = makeMemoryStatus({
      dirty: true,
    });
    const fingerprint = await computeMemorySourceFingerprint({
      workspaceRoot: "/workspace",
      memoryDirectory: "/workspace/memory",
      memoryFilePath: "/workspace/MEMORY.md",
    });
    mocks.getJsonSetting.mockResolvedValue(fingerprint);

    const service = new MemoryPrepareService();
    const result = await service.triggerPrepare({
      source: "operator",
    });

    expect(result.started).toBe(true);

    await vi.waitFor(() => {
      expect(mocks.state.prepareStatus.state).toBe("completed");
    });

    expect(mocks.prepareSemanticMemory).not.toHaveBeenCalled();
    expect(mocks.state.prepareStatus.progressLabel).toBe(
      "Semantic memory prepare skipped (fingerprint current).",
    );
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "ok",
        skipped: true,
        semanticReady: true,
      }),
    );
  });

  it("records prewarm prepares separately and finishes metrics before persisting completion", async () => {
    const sequence: string[] = [];
    const fingerprint = await computeMemorySourceFingerprint({
      workspaceRoot: "/workspace",
      memoryDirectory: "/workspace/memory",
      memoryFilePath: "/workspace/MEMORY.md",
    });
    mocks.performanceStart.mockReturnValue({
      finish: vi.fn(() => {
        sequence.push("metric.finish");
      }),
    });
    mocks.getJsonSetting.mockResolvedValue(fingerprint);
    mocks.updateMemoryPrepareStatus.mockImplementation(async (update) => {
      sequence.push(`status:${update.state}`);
      mocks.state.prepareStatus = {
        ...mocks.state.prepareStatus,
        ...update,
        updatedAt: "2026-03-29T00:00:01.000Z",
      };
    });

    const service = new MemoryPrepareService();
    const result = await service.triggerPrepare({
      source: "prewarm",
    });

    expect(result.started).toBe(true);
    await vi.waitFor(() => {
      expect(mocks.state.prepareStatus.state).toBe("completed");
    });

    expect(mocks.performanceStart).toHaveBeenCalledWith(
      "server",
      "memory.prepare.complete",
      expect.objectContaining({
        source: "prewarm",
      }),
    );
    expect(sequence.indexOf("metric.finish")).toBeGreaterThan(-1);
    expect(sequence.indexOf("status:completed")).toBeGreaterThan(-1);
    expect(sequence.indexOf("metric.finish")).toBeLessThan(
      sequence.indexOf("status:completed"),
    );
  });
});
