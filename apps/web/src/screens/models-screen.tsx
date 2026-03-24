import type { ProviderProfile, RuntimeStatus } from "@droidagent/shared";

import { useDroidAgentApp } from "../app-context";
import { postJson } from "../lib/api";

export function ModelsScreen() {
  const { dashboard, runAction, refreshDashboard } = useDroidAgentApp();

  return (
    <section className="stack-list">
      {(dashboard?.runtimes ?? []).map((runtime: RuntimeStatus) => (
        <article key={runtime.id} className="panel-card">
          <h3>{runtime.label}</h3>
          <p>{runtime.healthMessage}</p>
          <div className="button-row">
            {!runtime.installed && runtime.id !== "openclaw" ? (
              <button
                onClick={() =>
                  void runAction(async () => {
                    await postJson(`/api/runtime/${runtime.id}/install`, {});
                    await refreshDashboard();
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
                  await refreshDashboard();
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
                  await refreshDashboard();
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
