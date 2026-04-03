import { nowIso, type MemoryStatus } from "@droidagent/shared";

import { computeMemorySourceFingerprint } from "../lib/memory-fingerprint.js";
import { appStateService } from "./app-state-service.js";
import { openclawMemoryFacet } from "./openclaw-service-facets.js";
import { performanceService } from "./performance-service.js";
import { runtimeService } from "./runtime-service.js";

type Listener = () => void;

export class MemoryPrepareService {
  private activePrepare: Promise<MemoryStatus> | null = null;
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitUpdate(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private async persistStatus(
    update: Parameters<typeof appStateService.updateMemoryPrepareStatus>[0],
  ): Promise<void> {
    await appStateService.updateMemoryPrepareStatus(update);
    openclawMemoryFacet.invalidateMemoryStatusCache();
    this.emitUpdate();
  }

  private trackJoinedPrepare(params: {
    resume?: boolean;
    source?: "operator" | "resume" | "prewarm";
  }): void {
    if (!this.activePrepare) {
      return;
    }

    const metric = performanceService.start("server", "memory.prepare.complete", {
      resume: params.resume === true,
      source: params.source ?? (params.resume ? "resume" : "operator"),
      joined: true,
    });

    void this.activePrepare
      .then((status) => {
        metric.finish({
          outcome: "ok",
          joined: true,
          semanticReady: status.semanticReady,
          indexedFiles: status.indexedFiles,
          indexedChunks: status.indexedChunks,
        });
      })
      .catch(() => {
        metric.finish({
          outcome: "error",
          joined: true,
        });
      });
  }

  async triggerPrepare(params: {
    resume?: boolean;
    source?: "operator" | "resume" | "prewarm";
  } = {}): Promise<{
    status: MemoryStatus;
    started: boolean;
  }> {
    if (this.activePrepare) {
      this.trackJoinedPrepare(params);
      return {
        status: await openclawMemoryFacet.memoryStatusQuick(),
        started: false,
      };
    }

    if (!params.resume) {
      await this.persistStatus({
        state: "queued",
        startedAt: null,
        finishedAt: null,
        progressLabel: "Queued semantic memory prepare.",
        error: null,
      });
    }

    this.activePrepare = this.runPrepare(params).finally(() => {
      this.activePrepare = null;
    });

    return {
      status: await openclawMemoryFacet.memoryStatusQuick(),
      started: true,
    };
  }

  async resumePendingPrepare(): Promise<void> {
    const current = await appStateService.getMemoryPrepareStatus();
    if (current.state !== "queued" && current.state !== "running") {
      return;
    }
    await this.triggerPrepare({ resume: true, source: "resume" });
  }

  private async runPrepare(params: {
    resume?: boolean;
    source?: "operator" | "resume" | "prewarm";
  }): Promise<MemoryStatus> {
    const current = await appStateService.getMemoryPrepareStatus();
    const startedAt =
      params.resume && current.startedAt ? current.startedAt : nowIso();
    const metric = performanceService.start("server", "memory.prepare.complete", {
      resume: params.resume === true,
      source: params.source ?? (params.resume ? "resume" : "operator"),
    });
    const markFinished = () => {
      const finishedAt = nowIso();
      return {
        finishedAt,
        lastDurationMs: Math.max(
          0,
          Number(
            (
              new Date(finishedAt).getTime() - new Date(startedAt).getTime()
            ).toFixed(2),
          ),
        ),
      };
    };

    try {
      await this.persistStatus({
        state: "running",
        startedAt,
        finishedAt: null,
        progressLabel: params.resume
          ? "Resuming semantic memory prepare after restart."
          : "Preparing semantic memory.",
        error: null,
      });

      const settings = await appStateService.getRuntimeSettings();
      if (settings.selectedRuntime === "ollama") {
        await this.persistStatus({
          state: "running",
          startedAt,
          progressLabel: "Starting Ollama runtime.",
          error: null,
        });
        await runtimeService.startRuntime("ollama");
        await this.persistStatus({
          state: "running",
          startedAt,
          progressLabel: `Ensuring embedding model ${settings.ollamaEmbeddingModel}.`,
          error: null,
        });
        await runtimeService.ensureOllamaModel(settings.ollamaEmbeddingModel);
      }

      const currentStatus = await openclawMemoryFacet.memoryStatusQuick();
      const currentFingerprint = await computeMemorySourceFingerprint({
        workspaceRoot: currentStatus.effectiveWorkspaceRoot,
        memoryDirectory: currentStatus.memoryDirectory,
        memoryFilePath: currentStatus.memoryFilePath,
      });
      const previousFingerprint = await appStateService.getJsonSetting<string | null>(
        "memoryPrepareFingerprint",
        null,
      );
      if (
        currentStatus.semanticReady &&
        previousFingerprint === currentFingerprint
      ) {
        const finished = markFinished();
        metric.finish({
          outcome: "ok",
          skipped: true,
          semanticReady: currentStatus.semanticReady,
          indexedFiles: currentStatus.indexedFiles,
          indexedChunks: currentStatus.indexedChunks,
        });
        await this.persistStatus({
          state: "completed",
          startedAt,
          ...finished,
          progressLabel:
            "Semantic memory prepare skipped (fingerprint current).",
          error: null,
        });
        return currentStatus;
      }

      await this.persistStatus({
        state: "running",
        startedAt,
        progressLabel: "Refreshing semantic memory index.",
        error: null,
      });
      const status = await openclawMemoryFacet.prepareSemanticMemory({
        reindex: true,
      });
      const fingerprint = await computeMemorySourceFingerprint({
        workspaceRoot: status.effectiveWorkspaceRoot,
        memoryDirectory: status.memoryDirectory,
        memoryFilePath: status.memoryFilePath,
      });
      await appStateService.setJsonSetting("memoryPrepareFingerprint", fingerprint);
      const finished = markFinished();
      metric.finish({
        outcome: "ok",
        semanticReady: status.semanticReady,
        indexedFiles: status.indexedFiles,
        indexedChunks: status.indexedChunks,
      });
      await this.persistStatus({
        state: "completed",
        startedAt,
        ...finished,
        progressLabel: status.semanticReady
          ? "Semantic memory is ready."
          : "Semantic memory prepare completed.",
        error: null,
      });
      return status;
    } catch (error) {
      const finished = markFinished();
      metric.finish({
        outcome: "error",
      });
      await this.persistStatus({
        state: "failed",
        startedAt,
        ...finished,
        progressLabel: "Semantic memory prepare failed.",
        error:
          error instanceof Error
            ? error.message
            : "Semantic memory prepare failed.",
      });
      return await openclawMemoryFacet.memoryStatus();
    }
  }
}

export const memoryPrepareService = new MemoryPrepareService();
