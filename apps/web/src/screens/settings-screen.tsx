import { useEffect, useState } from "react";
import { startRegistration, type PublicKeyCredentialCreationOptionsJSON as BrowserRegistrationOptions } from "@simplewebauthn/browser";
import { useQueryClient } from "@tanstack/react-query";

import type { BootstrapLink, CloudProviderSummary, PerformanceSnapshot } from "@droidagent/shared";

import { useAccessQuery, useDashboardQuery, usePasskeysQuery, usePerformanceQuery } from "../app-data";
import { useClientPerformanceSnapshot, useDroidAgentApp } from "../app-context";
import { api, postJson } from "../lib/api";

function metricDescription(snapshot: PerformanceSnapshot | undefined, name: string, label: string): string {
  const metric = snapshot?.metrics.find((entry) => entry.name === name);
  if (!metric) {
    return `${label}: no samples yet`;
  }

  const p95 = metric.summary.p95DurationMs ?? metric.summary.lastDurationMs;
  const last = metric.summary.lastDurationMs;
  return `${label}: p95 ${p95 ?? 0} ms • last ${last ?? 0} ms`;
}

export function SettingsScreen() {
  const queryClient = useQueryClient();
  const { canInstallApp, installApp, runAction } = useDroidAgentApp();
  const dashboardQuery = useDashboardQuery(true);
  const accessQuery = useAccessQuery();
  const passkeysQuery = usePasskeysQuery(true);
  const performanceQuery = usePerformanceQuery(true);
  const clientPerformanceSnapshot = useClientPerformanceSnapshot();
  const dashboard = dashboardQuery.data;
  const access = accessQuery.data;
  const [providerApiKeys, setProviderApiKeys] = useState<Record<string, string>>({});
  const [providerModels, setProviderModels] = useState<Record<string, string>>({});
  const [bootstrapLink, setBootstrapLink] = useState<BootstrapLink | null>(null);
  const [cloudflareHostname, setCloudflareHostname] = useState(access?.cloudflareStatus.hostname ?? "");
  const [cloudflareToken, setCloudflareToken] = useState("");
  const canEnableCloudflare = cloudflareHostname.trim().length > 0 && (cloudflareToken.trim().length > 0 || Boolean(access?.cloudflareStatus.tokenStored));
  const canGeneratePhoneLink = Boolean(access?.canonicalOrigin);

  useEffect(() => {
    if (access?.cloudflareStatus.hostname) {
      setCloudflareHostname(access.cloudflareStatus.hostname);
    }
  }, [access?.cloudflareStatus.hostname]);

  async function handleAddPasskey() {
    const options = await postJson<PublicKeyCredentialCreationOptionsJSON>("/api/auth/passkeys/register/options", {});
    const response = await startRegistration({ optionsJSON: options as BrowserRegistrationOptions });
    await postJson("/api/auth/passkeys/register/verify", response);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["passkeys"] }),
      queryClient.invalidateQueries({ queryKey: ["auth"] })
    ]);
  }

  return (
    <section className="stack-list">
      <article className="panel-card">
        <h3>Workspace</h3>
        <p>{dashboard?.setup.workspaceRoot ?? "Not configured yet."}</p>
      </article>

      <article className="panel-card">
        <h3>LaunchAgent</h3>
        <p>{dashboard?.launchAgent.healthMessage}</p>
        <small>{dashboard?.launchAgent.plistPath}</small>
        <div className="button-row">
          <button
            onClick={() =>
              void runAction(async () => {
                await postJson("/api/service/launch-agent/install", {});
              }, "LaunchAgent plist installed.")
            }
          >
            Install
          </button>
          <button
            className="secondary"
            onClick={() =>
              void runAction(async () => {
                await postJson("/api/service/launch-agent/start", {});
              }, "LaunchAgent start requested.")
            }
          >
            Start
          </button>
          <button
            className="secondary"
            onClick={() =>
              void runAction(async () => {
                await postJson("/api/service/launch-agent/stop", {});
              }, "LaunchAgent stop requested.")
            }
          >
            Stop
          </button>
          <button
            className="secondary"
            onClick={() =>
              void runAction(async () => {
                await postJson("/api/service/launch-agent/uninstall", {});
              }, "LaunchAgent removed.")
            }
          >
            Uninstall
          </button>
        </div>
      </article>

      <article className="panel-card">
        <h3>Passkeys</h3>
        <div className="button-row">
          <button onClick={() => void runAction(handleAddPasskey, "Additional passkey enrolled.")}>Add Current Device</button>
        </div>
        <div className="stack-list">
          {(passkeysQuery.data ?? []).map((passkey) => (
            <article key={passkey.id} className="panel-card compact">
              <strong>{passkey.deviceType}</strong>
              <small>Created {new Date(passkey.createdAt).toLocaleString()}</small>
              <small>{passkey.lastUsedAt ? `Last used ${new Date(passkey.lastUsedAt).toLocaleString()}` : "Never used yet"}</small>
            </article>
          ))}
        </div>
      </article>

      <article className="panel-card">
        <h3>Cloud Providers</h3>
        <p>API keys are stored in the macOS login keychain. Only provider metadata stays inside DroidAgent.</p>
        <div className="stack-list">
          {(dashboard?.cloudProviders ?? []).map((provider: CloudProviderSummary) => {
            const apiKey = providerApiKeys[provider.id] ?? "";
            const defaultModel = providerModels[provider.id] ?? provider.defaultModel ?? "";
            return (
              <article key={provider.id} className={`panel-card compact${provider.active ? " active-card" : ""}`}>
                <strong>{provider.label}</strong>
                <small>{provider.healthMessage}</small>
                <label>
                  API key
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(event) => setProviderApiKeys((current) => ({ ...current, [provider.id]: event.target.value }))}
                    placeholder={provider.stored ? "Stored in Keychain" : provider.envVar}
                  />
                </label>
                <label>
                  Default model
                  <input
                    value={defaultModel}
                    onChange={(event) => setProviderModels((current) => ({ ...current, [provider.id]: event.target.value }))}
                    placeholder={provider.defaultModel ?? ""}
                  />
                </label>
                <div className="button-row">
                  <button
                    onClick={() =>
                      void runAction(async () => {
                        await postJson("/api/providers/secrets", {
                          providerId: provider.id,
                          apiKey,
                          defaultModel
                        });
                        setProviderApiKeys((current) => ({ ...current, [provider.id]: "" }));
                      }, `${provider.label} key stored in Keychain.`)
                    }
                  >
                    Save Secret
                  </button>
                  <button
                    className="secondary"
                    onClick={() =>
                      void runAction(async () => {
                        await postJson(`/api/providers/${provider.id}/select`, {
                          modelId: defaultModel
                        });
                      }, `${provider.label} activated.`)
                    }
                  >
                    Activate
                  </button>
                  <button
                    className="secondary"
                    onClick={() =>
                      void runAction(async () => {
                        await api(`/api/providers/secrets/${provider.id}`, { method: "DELETE" });
                      }, `${provider.label} secret removed.`)
                    }
                  >
                    Delete
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </article>

      <article className="panel-card">
        <h3>Remote Access</h3>
        <p>Private-first by default. Daily use stays on whichever canonical remote URL you choose.</p>
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
                Enable
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
                Make Canonical
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
                  Enable
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
                  Make Canonical
                </button>
                <button
                  className="secondary"
                  onClick={() =>
                    void runAction(async () => {
                      await postJson("/api/access/cloudflare/stop", {});
                    }, "Cloudflare tunnel stopped.")
                  }
                >
                  Stop
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
                const link = await postJson<BootstrapLink>("/api/access/bootstrap", {});
                setBootstrapLink(link);
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
        <h3>Smart Context Management</h3>
        <p>Let DroidAgent configure OpenClaw compaction, pruning, and pre-compaction memory flush with safe defaults.</p>
        <div className="button-row">
          <button
            onClick={() =>
              void runAction(async () => {
                await postJson("/api/runtime/context-management", {
                  enabled: !dashboard?.contextManagement.enabled
                });
              }, dashboard?.contextManagement.enabled ? "Smart context management disabled." : "Smart context management enabled.")
            }
          >
            {dashboard?.contextManagement.enabled ? "Disable" : "Enable"}
          </button>
        </div>
        <small>
          Compaction: {dashboard?.contextManagement.compactionMode ?? "unknown"} • Pruning: {dashboard?.contextManagement.pruningMode ?? "unknown"} • Memory flush: {dashboard?.contextManagement.memoryFlushEnabled ? "on" : "off"}
        </small>
      </article>

      <article className="panel-card">
        <h3>PWA Install</h3>
        <p>Add DroidAgent to the home screen to get a full-screen shell on the phone.</p>
        <button disabled={!canInstallApp} onClick={() => void runAction(installApp, "Install prompt opened.")}>
          Install App
        </button>
      </article>

      <article className="panel-card">
        <h3>Performance Diagnostics</h3>
        <p>Recent local UI timings and server timings stay advisory for this pass. Use them to spot regressions before you trust a baseline.</p>
        <div className="stack-list">
          <article className="panel-card compact">
            <strong>Client</strong>
            <small>{metricDescription(clientPerformanceSnapshot, "client.route.switch", "Route switch")}</small>
            <small>{metricDescription(clientPerformanceSnapshot, "client.chat.submit_to_first_token", "Chat to first token")}</small>
            <small>{metricDescription(clientPerformanceSnapshot, "client.chat.submit_to_done", "Chat to done")}</small>
            <small>{metricDescription(clientPerformanceSnapshot, "client.ws.reconnect_to_resync", "Reconnect to resync")}</small>
            <small>{metricDescription(clientPerformanceSnapshot, "client.file.save", "File save")}</small>
            <small>{metricDescription(clientPerformanceSnapshot, "client.job.start_to_first_output", "Job to first output")}</small>
          </article>
          <article className="panel-card compact">
            <strong>Server</strong>
            <small>{metricDescription(performanceQuery.data, "http.get./api/access", "GET /api/access")}</small>
            <small>{metricDescription(performanceQuery.data, "http.get./api/dashboard", "GET /api/dashboard")}</small>
            <small>{metricDescription(performanceQuery.data, "chat.stream.firstDeltaRelay", "Relay to first delta")}</small>
            <small>{metricDescription(performanceQuery.data, "file.write", "File write")}</small>
            <small>{metricDescription(performanceQuery.data, "job.firstOutput", "Job first output")}</small>
          </article>
        </div>
      </article>
    </section>
  );
}
