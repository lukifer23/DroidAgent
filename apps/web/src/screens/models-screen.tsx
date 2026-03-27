import type { ProviderProfile, RuntimeStatus } from "@droidagent/shared";

import { useDashboardQuery } from "../app-data";
import { useDroidAgentApp } from "../app-context";
import { postJson } from "../lib/api";

function runtimeMetadata(runtime: RuntimeStatus) {
  const labels: Record<string, string> = {
    accelerationBackend: "Backend",
    gpuModel: "GPU",
    metalSupport: "Metal",
    activeProcessor: "Active Processor",
    gpuLayers: "GPU Layers",
    flashAttention: "Flash Attention",
    batchSize: "Batch",
    ubatchSize: "Ubatch"
  };

  return Object.entries(runtime.metadata)
    .filter(([, value]) => value !== "" && value !== false)
    .map(([key, value]) => ({
      key,
      label: labels[key] ?? key,
      value: String(value)
    }));
}

export function ModelsScreen() {
  const { runAction } = useDroidAgentApp();
  const dashboardQuery = useDashboardQuery(true);
  const dashboard = dashboardQuery.data;

  return (
    <section className="stack-list">
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
        <article key={provider.id} className={`panel-card compact${provider.enabled ? " active-card" : ""}`}>
          <strong>{provider.label}</strong>
          <span>{provider.model}</span>
          <small>{provider.healthMessage}</small>
        </article>
      ))}
    </section>
  );
}
