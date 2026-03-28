import type { ProviderProfile, RuntimeStatus } from "@droidagent/shared";

import { useDashboardQuery } from "../app-data";
import { useDroidAgentApp } from "../app-context";
import { postJson } from "../lib/api";
import { formatTokenBudget } from "../lib/formatters";

function runtimeMetadata(runtime: RuntimeStatus) {
  const labels: Record<string, string> = {
    accelerationBackend: "Backend",
    gpuModel: "GPU",
    metalSupport: "Metal",
    activeProcessor: "Active Processor",
    gpuLayers: "GPU Layers",
    flashAttention: "Flash Attention",
    batchSize: "Batch",
    ubatchSize: "Ubatch",
  };

  return Object.entries(runtime.metadata)
    .filter(([, value]) => value !== "" && value !== false)
    .map(([key, value]) => ({
      key,
      label: labels[key] ?? key,
      value: String(value),
    }));
}

export function ModelsScreen() {
  const { runAction } = useDroidAgentApp();
  const dashboardQuery = useDashboardQuery(true);
  const dashboard = dashboardQuery.data;
  const localOllamaProvider = dashboard?.providers.find(
    (provider) => provider.id === "ollama-default",
  );

  return (
    <section className="stack-list">
      <article className="panel-card compact active-card">
        <strong>Default Local Path</strong>
        <span>{localOllamaProvider?.model ?? "qwen3.5:4b"}</span>
        <small>
          {formatTokenBudget(localOllamaProvider?.contextWindow)} context •{" "}
          thinking off • smart context trimming{" "}
          {dashboard?.contextManagement.enabled ? "on" : "off"}
        </small>
        <small>
          Session memory {dashboard?.memory.sessionMemoryEnabled ? "on" : "off"}{" "}
          • Workspace notes at {dashboard?.memory.memoryFilePath ?? "MEMORY.md"}
        </small>
      </article>

      <article className="panel-card compact">
        <strong>Semantic Memory</strong>
        <span>
          {dashboard?.memory.semanticReady
            ? "Local semantic search live"
            : "Semantic memory pending"}
        </span>
        <small>
          {dashboard?.memory.embeddingProvider ?? "unknown"}/
          {dashboard?.memory.embeddingModel ?? "unconfigured"} •{" "}
          {dashboard?.memory.indexedFiles ?? 0} files •{" "}
          {dashboard?.memory.indexedChunks ?? 0} chunks
        </small>
        <small>
          {dashboard?.memory.embeddingProbeError
            ? dashboard.memory.embeddingProbeError
            : dashboard?.memory.dirty
              ? "The semantic index is still warming or needs a reindex."
              : "Local embeddings stay on-device and back semantic recall for memory, preferences, skills, and session history."}
        </small>
      </article>

      <article className="panel-card compact">
        <strong>Workspace Context</strong>
        <span>
          {dashboard?.memory.ready
            ? "Scaffold bootstrapped"
            : "Scaffold pending"}
        </span>
        <small>
          {dashboard?.memory.bootstrapFilesReady ?? 0}/
          {dashboard?.memory.bootstrapFilesTotal ?? 0} bootstrap files • daily
          note {dashboard?.memory.todayNotePath ?? "unavailable"}
        </small>
      </article>

      {(dashboard?.runtimes ?? []).map((runtime: RuntimeStatus) => (
        <article key={runtime.id} className="panel-card">
          <h3>{runtime.label}</h3>
          <p>{runtime.healthMessage}</p>
          {runtimeMetadata(runtime).length > 0 ? (
            <div className="meta-grid">
              {runtimeMetadata(runtime).map((entry) => (
                <span key={entry.key} className="meta-chip">
                  <strong>{entry.label}</strong>
                  <span>{entry.value}</span>
                </span>
              ))}
            </div>
          ) : null}
          <div className="button-row">
            {!runtime.installed && runtime.id !== "openclaw" ? (
              <button
                onClick={() =>
                  void runAction(async () => {
                    await postJson(`/api/runtime/${runtime.id}/install`, {});
                  }, `${runtime.label} installed.`)
                }
              >
                Install
              </button>
            ) : null}
            <button
              className="secondary"
              onClick={() =>
                void runAction(async () => {
                  await postJson(`/api/runtime/${runtime.id}/start`, {});
                }, `${runtime.label} start requested.`)
              }
            >
              Start
            </button>
            <button
              className="secondary"
              onClick={() =>
                void runAction(async () => {
                  await postJson(`/api/runtime/${runtime.id}/stop`, {});
                }, `${runtime.label} stop requested.`)
              }
            >
              Stop
            </button>
          </div>
        </article>
      ))}

      {(dashboard?.providers ?? []).map((provider: ProviderProfile) => (
        <article
          key={provider.id}
          className={`panel-card compact${provider.enabled ? " active-card" : ""}`}
        >
          <strong>{provider.label}</strong>
          <span>{provider.model}</span>
          {provider.contextWindow ? (
            <small>
              Context window: {formatTokenBudget(provider.contextWindow)}
            </small>
          ) : null}
          <small>{provider.healthMessage}</small>
        </article>
      ))}
    </section>
  );
}
