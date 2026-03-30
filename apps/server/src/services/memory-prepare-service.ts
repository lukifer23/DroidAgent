import { nowIso, type MemoryStatus } from "@droidagent/shared";

import { appStateService } from "./app-state-service.js";
import { openclawService } from "./openclaw-service.js";
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
    openclawService.invalidateMemoryStatusCache();
    this.emitUpdate();
  }

  async triggerPrepare(params: { resume?: boolean } = {}): Promise<{
    status: MemoryStatus;
    started: boolean;
  }> {
    if (this.activePrepare) {
      return {
        status: await openclawService.memoryStatusQuick(),
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
      status: await openclawService.memoryStatusQuick(),
      started: true,
    };
  }

  async resumePendingPrepare(): Promise<void> {
    const current = await appStateService.getMemoryPrepareStatus();
    if (current.state !== "queued" && current.state !== "running") {
      return;
    }
    await this.triggerPrepare({ resume: true });
  }

  private async runPrepare(params: {
    resume?: boolean;
  }): Promise<MemoryStatus> {
    const current = await appStateService.getMemoryPrepareStatus();
    const startedAt =
      params.resume && current.startedAt ? current.startedAt : nowIso();
    const metric = performanceService.start("server", "memory.prepare.complete", {
      resume: params.resume === true,
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

      await this.persistStatus({
        state: "running",
        startedAt,
        progressLabel: "Refreshing semantic memory index.",
        error: null,
      });
      const status = await openclawService.prepareSemanticMemory({
        reindex: true,
      });
      const finished = markFinished();
      await this.persistStatus({
        state: "completed",
        startedAt,
        ...finished,
        progressLabel: status.semanticReady
          ? "Semantic memory is ready."
          : "Semantic memory prepare completed.",
        error: null,
      });
      metric.finish({
        outcome: "ok",
        semanticReady: status.semanticReady,
        indexedFiles: status.indexedFiles,
        indexedChunks: status.indexedChunks,
      });
      return status;
    } catch (error) {
      const finished = markFinished();
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
      metric.finish({
        outcome: "error",
      });
      return await openclawService.memoryStatus();
    }
  }
}

export const memoryPrepareService = new MemoryPrepareService();
