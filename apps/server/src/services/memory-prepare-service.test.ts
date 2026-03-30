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
    getJsonSetting: vi.fn(async () => null),
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

    const first = await service.triggerPrepare();
    const second = await service.triggerPrepare();

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
    const result = await service.triggerPrepare();

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
});
