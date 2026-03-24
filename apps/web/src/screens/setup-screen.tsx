import { useEffect, useState } from "react";

import type { BootstrapLink } from "@droidagent/shared";

import { useDroidAgentApp } from "../app-context";
import { postJson } from "../lib/api";

export function SetupScreen() {
  const { dashboard, access, runAction, refreshDashboard } = useDroidAgentApp();
  const [workspaceInput, setWorkspaceInput] = useState(".");
  const [setupModel, setSetupModel] = useState("gpt-oss:20b");
  const [llamaModel, setLlamaModel] = useState("gemma-3-1b-it");
  const [bootstrapLink, setBootstrapLink] = useState<BootstrapLink | null>(null);

  useEffect(() => {
    if (dashboard?.setup.workspaceRoot) {
      setWorkspaceInput(dashboard.setup.workspaceRoot);
    }
  }, [dashboard?.setup.workspaceRoot]);

  return (
    <section className="stack-list">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">Onboarding</div>
          <h2>Lock in the host before daily use</h2>
        </div>
      </div>

      <article className="panel-card">
        <h3>Workspace Root</h3>
        <p>Choose the directory DroidAgent can browse, edit, and run owner jobs inside.</p>
        <input value={workspaceInput} onChange={(event) => setWorkspaceInput(event.target.value)} />
        <button
          onClick={() =>
            void runAction(async () => {
              await postJson("/api/setup/workspace", {
                workspaceRoot: workspaceInput
              });
              await refreshDashboard();
            }, "Workspace updated.")
          }
        >
          Save Workspace
        </button>
      </article>

      <article className="panel-card">
        <h3>Default Runtime</h3>
        <p>Ollama stays the default local path. llama.cpp remains the advanced local route.</p>
        <div className="button-row">
          <button
            onClick={() =>
              void runAction(async () => {
                await postJson("/api/setup/runtime", { runtimeId: "ollama" });
                await refreshDashboard();
              }, "Ollama installed and started.")
            }
          >
            Install + Start Ollama
          </button>
          <button
            className="secondary"
            onClick={() =>
              void runAction(async () => {
                await postJson("/api/setup/runtime", { runtimeId: "llamaCpp" });
                await refreshDashboard();
              }, "llama.cpp installed.")
            }
          >
            Install llama.cpp
          </button>
        </div>
      </article>

      <article className="panel-card">
        <h3>Models</h3>
        <p>Pull an Ollama model or select the advanced llama.cpp preset.</p>
        <div className="field-stack">
          <label>
            Ollama model
            <input value={setupModel} onChange={(event) => setSetupModel(event.target.value)} />
          </label>
          <button
            onClick={() =>
              void runAction(async () => {
                await postJson("/api/setup/model", {
                  runtimeId: "ollama",
                  modelId: setupModel
                });
                await refreshDashboard();
              }, "Ollama model pulled.")
            }
          >
            Pull Ollama Model
          </button>
        </div>
        <div className="field-stack">
          <label>
            llama.cpp preset
            <select value={llamaModel} onChange={(event) => setLlamaModel(event.target.value)}>
              <option value="gemma-3-1b-it">Gemma 3 1B IT</option>
              <option value="qwen3-8b-instruct">Qwen3 8B Instruct</option>
            </select>
          </label>
          <button
            className="secondary"
            onClick={() =>
              void runAction(async () => {
                await postJson("/api/runtime/llamaCpp/models", {
                  modelId: llamaModel
                });
                await refreshDashboard();
              }, "llama.cpp provider updated.")
            }
          >
            Select llama.cpp Preset
          </button>
        </div>
      </article>

      <article className="panel-card">
        <h3>Remote Phone Access</h3>
        <p>Tailscale is the supported internet path. Keep DroidAgent on loopback and publish only through Tailscale Serve.</p>
        <div className="button-row">
          <button
            onClick={() =>
              void runAction(async () => {
                await postJson("/api/access/tailscale/enable", {});
                await refreshDashboard();
              }, "Tailscale Serve enabled.")
            }
          >
            Enable Tailscale Serve
          </button>
          <button
            className="secondary"
            onClick={() =>
              void runAction(async () => {
                const result = await postJson<BootstrapLink>("/api/access/bootstrap", {});
                setBootstrapLink(result);
                await refreshDashboard();
              }, "Phone bootstrap link generated.")
            }
          >
            Generate Phone Link
          </button>
        </div>
        {access ? <pre>{JSON.stringify(access, null, 2)}</pre> : null}
        {bootstrapLink ? <pre>{bootstrapLink.bootstrapUrl}</pre> : null}
      </article>

      <article className="panel-card">
        <h3>Startup Diagnostics</h3>
        <div className="stack-list">
          {(dashboard?.startupDiagnostics ?? []).map((diagnostic) => (
            <article key={diagnostic.id} className="panel-card compact">
              <strong>{diagnostic.id}</strong>
              <small>{diagnostic.message}</small>
              {diagnostic.action ? <small>{diagnostic.action}</small> : null}
            </article>
          ))}
        </div>
      </article>

      <article className="panel-card compact">
        <strong>Optional</strong>
        <small>Signal stays available from the Channels route, but setup is complete without it.</small>
      </article>
    </section>
  );
}
