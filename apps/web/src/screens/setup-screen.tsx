import { useEffect, useState } from "react";

import type { BootstrapLink } from "@droidagent/shared";

import { useAccessQuery, useDashboardQuery } from "../app-data";
import { useDroidAgentApp } from "../app-context";
import { postJson } from "../lib/api";

export function SetupScreen() {
  const { runAction } = useDroidAgentApp();
  const dashboardQuery = useDashboardQuery(true);
  const accessQuery = useAccessQuery();
  const dashboard = dashboardQuery.data;
  const access = accessQuery.data;
  const [workspaceInput, setWorkspaceInput] = useState(".");
  const [setupModel, setSetupModel] = useState("gpt-oss:20b");
  const [llamaModel, setLlamaModel] = useState("gemma-3-1b-it");
  const [bootstrapLink, setBootstrapLink] = useState<BootstrapLink | null>(null);
  const [cloudflareHostname, setCloudflareHostname] = useState("");
  const [cloudflareToken, setCloudflareToken] = useState("");
  const canEnableCloudflare = cloudflareHostname.trim().length > 0 && (cloudflareToken.trim().length > 0 || Boolean(access?.cloudflareStatus.tokenStored));
  const canGeneratePhoneLink = Boolean(access?.canonicalOrigin);

  useEffect(() => {
    if (dashboard?.setup.workspaceRoot) {
      setWorkspaceInput(dashboard.setup.workspaceRoot);
    }
  }, [dashboard?.setup.workspaceRoot]);

  useEffect(() => {
    if (access?.cloudflareStatus.hostname) {
      setCloudflareHostname(access.cloudflareStatus.hostname);
    }
  }, [access?.cloudflareStatus.hostname]);

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
              }, "llama.cpp provider updated.")
            }
          >
            Select llama.cpp Preset
          </button>
        </div>
      </article>

      <article className="panel-card">
        <h3>Remote Phone Access</h3>
        <p>Keep DroidAgent on loopback. Use either Tailscale Serve or a named Cloudflare Tunnel when you need phone access away from home.</p>
        <div className="stack-list">
          <article className="panel-card compact">
            <strong>Tailscale</strong>
            <small>{access?.tailscaleStatus.healthMessage ?? "Checking Tailscale..."}</small>
            <div className="button-row">
              <button
                onClick={() =>
                  void runAction(async () => {
                    await postJson("/api/access/tailscale/enable", {});
                  }, "Tailscale Serve enabled.")
                }
              >
                Enable Tailscale Serve
              </button>
              <button
                className="secondary"
                disabled={!access?.tailscaleStatus.canonicalUrl}
                onClick={() =>
                  void runAction(async () => {
                    await postJson("/api/access/canonical", { source: "tailscale" });
                  }, "Tailscale set as canonical.")
                }
              >
                Use Tailscale URL
              </button>
            </div>
          </article>

          <article className="panel-card compact">
            <strong>Cloudflare Tunnel</strong>
            <small>{access?.cloudflareStatus.healthMessage ?? "Checking Cloudflare..."}</small>
            <div className="field-stack">
              <label>
                Public hostname
                <input value={cloudflareHostname} onChange={(event) => setCloudflareHostname(event.target.value)} placeholder="agent.example.com" />
              </label>
              <label>
                Tunnel token
                <input
                  type="password"
                  value={cloudflareToken}
                  onChange={(event) => setCloudflareToken(event.target.value)}
                  placeholder={access?.cloudflareStatus.tokenStored ? "Stored in Keychain" : "Paste Cloudflare tunnel token"}
                />
              </label>
              <div className="button-row">
                <button
                  disabled={!canEnableCloudflare}
                  onClick={() =>
                    void runAction(async () => {
                      await postJson("/api/access/cloudflare/enable", {
                        hostname: cloudflareHostname,
                        tunnelToken: cloudflareToken
                      });
                      setCloudflareToken("");
                    }, "Cloudflare tunnel enabled.")
                  }
                >
                  Enable Cloudflare Tunnel
                </button>
                <button
                  className="secondary"
                  disabled={!access?.cloudflareStatus.canonicalUrl}
                  onClick={() =>
                  void runAction(async () => {
                    await postJson("/api/access/canonical", { source: "cloudflare" });
                  }, "Cloudflare set as canonical.")
                }
              >
                  Use Cloudflare URL
                </button>
              </div>
            </div>
          </article>
        </div>
        <div className="button-row">
          <button
            disabled={!canGeneratePhoneLink}
            onClick={() =>
              void runAction(async () => {
                const result = await postJson<BootstrapLink>("/api/access/bootstrap", {});
                setBootstrapLink(result);
              }, "Phone bootstrap link generated.")
            }
          >
            Generate Phone Link
          </button>
        </div>
        {access?.canonicalOrigin ? <small>Canonical URL: {access.canonicalOrigin.origin}</small> : null}
        {bootstrapLink ? <small>Bootstrap link: {bootstrapLink.bootstrapUrl}</small> : null}
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
