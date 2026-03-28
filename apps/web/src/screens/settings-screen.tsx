import { useState } from "react";
import {
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON as BrowserRegistrationOptions,
} from "@simplewebauthn/browser";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";

import type {
  BootstrapLink,
  CloudProviderSummary,
  PerformanceSnapshot,
} from "@droidagent/shared";

import {
  useAccessQuery,
  useDashboardQuery,
  usePasskeysQuery,
  usePerformanceQuery,
} from "../app-data";
import { useClientPerformanceSnapshot, useDroidAgentApp } from "../app-context";
import { api, postJson } from "../lib/api";

function metricDescription(
  snapshot: PerformanceSnapshot | undefined,
  name: string,
  label: string,
): string {
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
  const [providerApiKeys, setProviderApiKeys] = useState<
    Record<string, string>
  >({});
  const [providerModels, setProviderModels] = useState<Record<string, string>>(
    {},
  );
  const [bootstrapLink, setBootstrapLink] = useState<BootstrapLink | null>(
    null,
  );

  const passkeyCount = passkeysQuery.data?.length ?? 0;
  const runtimeCount =
    dashboard?.runtimes.filter((runtime) => runtime.state === "running")
      .length ?? 0;
  const tailscaleReady = Boolean(access?.tailscaleStatus.authenticated);
  const remoteReady = Boolean(access?.canonicalOrigin?.origin);
  const canGeneratePhoneLink = Boolean(access?.canonicalOrigin);

  const overviewCards = [
    {
      key: "host",
      label: "Host",
      value: dashboard?.launchAgent.running ? "Live" : "Needs attention",
      detail:
        dashboard?.launchAgent.healthMessage ??
        "LaunchAgent health is still loading.",
      progress: dashboard?.launchAgent.running ? 100 : 45,
      tone: dashboard?.launchAgent.running ? "good" : "warn",
    },
    {
      key: "remote",
      label: "Phone Access",
      value: remoteReady ? "Tailscale live" : "Local only",
      detail: remoteReady
        ? (access?.canonicalOrigin?.origin ?? "Remote URL ready")
        : access?.tailscaleStatus.healthMessage ??
          "Enable the Tailscale URL to finish phone access.",
      progress: remoteReady ? 100 : tailscaleReady ? 70 : 24,
      tone: remoteReady ? "good" : tailscaleReady ? "warn" : "muted",
    },
    {
      key: "security",
      label: "Passkeys",
      value:
        passkeyCount > 0 ? `${passkeyCount} enrolled` : "Needs a device",
      detail:
        passkeyCount > 0
          ? "Owner access is already protected by passkeys."
          : "Add another current device so recovery stays simple.",
      progress: passkeyCount > 0 ? 100 : 20,
      tone: passkeyCount > 0 ? "good" : "warn",
    },
    {
      key: "runtime",
      label: "Runtime",
      value: runtimeCount > 0 ? `${runtimeCount} live` : "Not running",
      detail:
        dashboard?.setup.selectedModel ??
        "No default model is selected yet for the common local path.",
      progress: runtimeCount > 0 ? 100 : 26,
      tone: runtimeCount > 0 ? "good" : "warn",
    },
  ] as const;

  async function handleAddPasskey() {
    const options = await postJson<PublicKeyCredentialCreationOptionsJSON>(
      "/api/auth/passkeys/register/options",
      {},
    );
    const response = await startRegistration({
      optionsJSON: options as BrowserRegistrationOptions,
    });
    await postJson("/api/auth/passkeys/register/verify", response);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["passkeys"] }),
      queryClient.invalidateQueries({ queryKey: ["auth"] }),
    ]);
  }

  return (
    <section className="stack-list">
      <section className="system-rail settings-rail">
        {overviewCards.map((card) => (
          <article
            key={card.key}
            className={`panel-card compact system-rail-card ${card.tone}`}
          >
            <div className="system-rail-head">
              <span>{card.label}</span>
            </div>
            <strong>{card.value}</strong>
            <div className="health-meter">
              <span style={{ width: `${card.progress}%` }} />
            </div>
            <small>{card.detail}</small>
          </article>
        ))}
      </section>

      <section className="settings-grid">
        <article className="panel-card">
          <div className="panel-heading">
            <h3>Host Controls</h3>
            <p>
              Keep the Mac steady. These controls cover the workspace, the
              LaunchAgent, and the always-on local server path.
            </p>
          </div>
          <div className="status-list">
            <article
              className={`health-row${dashboard?.setup.workspaceRoot ? " ready" : ""}`}
            >
              <div className="health-row-top">
                <strong>Workspace</strong>
                <span
                  className={`status-chip${dashboard?.setup.workspaceRoot ? " ready" : ""}`}
                >
                  {dashboard?.setup.workspaceRoot ? "Set" : "Pending"}
                </span>
              </div>
              <small>
                {dashboard?.setup.workspaceRoot ?? "Not configured yet."}
              </small>
            </article>
            <article
              className={`health-row${dashboard?.launchAgent.running ? " ready" : ""}`}
            >
              <div className="health-row-top">
                <strong>LaunchAgent</strong>
                <span
                  className={`status-chip${dashboard?.launchAgent.running ? " ready" : ""}`}
                >
                  {dashboard?.launchAgent.running ? "Running" : "Stopped"}
                </span>
              </div>
              <small>{dashboard?.launchAgent.healthMessage}</small>
            </article>
            <article
              className={`health-row${runtimeCount > 0 ? " ready" : ""}`}
            >
              <div className="health-row-top">
                <strong>Local Runtime</strong>
                <span
                  className={`status-chip${runtimeCount > 0 ? " ready" : ""}`}
                >
                  {runtimeCount > 0 ? "Live" : "Idle"}
                </span>
              </div>
              <small>
                {dashboard?.setup.selectedRuntime
                  ? `Selected runtime: ${dashboard.setup.selectedRuntime}`
                  : "No runtime selected yet."}
              </small>
            </article>
          </div>
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
          <small>{dashboard?.launchAgent.plistPath}</small>
        </article>

        <article className="panel-card">
          <div className="panel-heading">
            <h3>Tailscale Phone Access</h3>
            <p>
              DroidAgent now uses the private Tailscale path in the main UI. If
              the tailnet is healthy, the phone URL should be a one-tap flow.
            </p>
          </div>
          <div className="status-list">
            <article className={`health-row${tailscaleReady ? " ready" : ""}`}>
              <div className="health-row-top">
                <strong>Tailscale</strong>
                <span className={`status-chip${tailscaleReady ? " ready" : ""}`}>
                  {tailscaleReady ? "Authenticated" : "Needs sign-in"}
                </span>
              </div>
              <small>
                {access?.tailscaleStatus.healthMessage ?? "Checking Tailscale…"}
              </small>
            </article>
            <article className={`health-row${remoteReady ? " ready" : ""}`}>
              <div className="health-row-top">
                <strong>Canonical URL</strong>
                <span className={`status-chip${remoteReady ? " ready" : ""}`}>
                  {remoteReady ? "Live" : "Not published"}
                </span>
              </div>
              <small>
                {access?.canonicalOrigin?.origin ??
                  "Enable the Tailscale URL to publish the phone entrypoint."}
              </small>
            </article>
            {bootstrapLink ? (
              <article className="health-row ready">
                <div className="health-row-top">
                  <strong>Latest Device Enrollment Link</strong>
                  <span className="status-chip ready">Issued</span>
                </div>
                <small>{bootstrapLink.bootstrapUrl}</small>
              </article>
            ) : null}
          </div>
          <div className="button-row">
            <button
              onClick={() =>
                void runAction(async () => {
                  await postJson("/api/access/tailscale/enable", {});
                }, "Tailscale URL enabled.")
              }
            >
              Enable Tailscale URL
            </button>
            <button
              className="secondary"
              disabled={!access?.tailscaleStatus.canonicalUrl}
              onClick={() =>
                void runAction(async () => {
                  await postJson("/api/access/canonical", {
                    source: "tailscale",
                  });
                }, "Tailscale set as canonical.")
              }
            >
              Make Canonical
            </button>
            <button
              className="secondary"
              disabled={!canGeneratePhoneLink}
              onClick={() =>
                void runAction(async () => {
                  const link = await postJson<BootstrapLink>(
                    "/api/access/bootstrap",
                    {},
                  );
                  setBootstrapLink(link);
                }, "Device enrollment link generated.")
              }
            >
              Generate Device Link
            </button>
          </div>
        </article>
      </section>

      <section className="settings-grid">
        <article className="panel-card">
          <div className="panel-heading">
            <h3>Passkeys</h3>
            <p>
              Keep at least one more device enrolled so the phone path and host
              recovery stay simple.
            </p>
          </div>
          <div className="button-row">
            <button
              onClick={() =>
                void runAction(
                  handleAddPasskey,
                  "Additional passkey enrolled.",
                )
              }
            >
              Add Current Device
            </button>
          </div>
          <div className="stack-list">
            {(passkeysQuery.data ?? []).map((passkey) => (
              <article key={passkey.id} className="panel-card compact">
                <strong>{passkey.deviceType}</strong>
                <small>
                  Created {new Date(passkey.createdAt).toLocaleString()}
                </small>
                <small>
                  {passkey.lastUsedAt
                    ? `Last used ${new Date(passkey.lastUsedAt).toLocaleString()}`
                    : "Never used yet"}
                </small>
              </article>
            ))}
          </div>
        </article>

        <article className="panel-card">
          <div className="panel-heading">
            <h3>App Shell</h3>
            <p>
              Install the PWA when you want a cleaner full-screen phone shell,
              then use Channels only if you actually need Signal.
            </p>
          </div>
          <div className="button-row">
            <button
              disabled={!canInstallApp}
              onClick={() =>
                void runAction(installApp, "Install prompt opened.")
              }
            >
              Install App
            </button>
            <Link className="button-link secondary" to="/channels">
              Open Optional Channels
            </Link>
          </div>
          <small>
            The core operator flow is Setup, Chat, Files, Jobs, Models, and
            Settings. Signal stays secondary.
          </small>
        </article>
      </section>

      <article className="panel-card">
        <h3>Cloud Providers</h3>
        <p>
          API keys are stored in the macOS login keychain. Only provider
          metadata stays inside DroidAgent.
        </p>
        <div className="stack-list">
          {(dashboard?.cloudProviders ?? []).map(
            (provider: CloudProviderSummary) => {
              const apiKey = providerApiKeys[provider.id] ?? "";
              const defaultModel =
                providerModels[provider.id] ?? provider.defaultModel ?? "";
              return (
                <article
                  key={provider.id}
                  className={`panel-card compact${provider.active ? " active-card" : ""}`}
                >
                  <strong>{provider.label}</strong>
                  <small>{provider.healthMessage}</small>
                  <label>
                    API key
                    <input
                      type="password"
                      value={apiKey}
                      onChange={(event) =>
                        setProviderApiKeys((current) => ({
                          ...current,
                          [provider.id]: event.target.value,
                        }))
                      }
                      placeholder={
                        provider.stored
                          ? "Stored in Keychain"
                          : provider.envVar
                      }
                    />
                  </label>
                  <label>
                    Default model
                    <input
                      value={defaultModel}
                      onChange={(event) =>
                        setProviderModels((current) => ({
                          ...current,
                          [provider.id]: event.target.value,
                        }))
                      }
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
                            defaultModel,
                          });
                          setProviderApiKeys((current) => ({
                            ...current,
                            [provider.id]: "",
                          }));
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
                            modelId: defaultModel,
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
                          await api(`/api/providers/secrets/${provider.id}`, {
                            method: "DELETE",
                          });
                        }, `${provider.label} secret removed.`)
                      }
                    >
                      Delete
                    </button>
                  </div>
                </article>
              );
            },
          )}
        </div>
      </article>

      <article className="panel-card">
        <h3>Smart Context Management</h3>
        <p>
          Let DroidAgent configure OpenClaw compaction, pruning, and
          pre-compaction memory flush with safe defaults.
        </p>
        <div className="button-row">
          <button
            onClick={() =>
              void runAction(async () => {
                await postJson("/api/runtime/context-management", {
                  enabled: !dashboard?.contextManagement.enabled,
                });
              }, dashboard?.contextManagement.enabled
                ? "Smart context management disabled."
                : "Smart context management enabled.")
            }
          >
            {dashboard?.contextManagement.enabled ? "Disable" : "Enable"}
          </button>
        </div>
        <small>
          Compaction: {dashboard?.contextManagement.compactionMode ?? "unknown"}
          {" • "}
          Pruning: {dashboard?.contextManagement.pruningMode ?? "unknown"}
          {" • "}
          Memory flush:{" "}
          {dashboard?.contextManagement.memoryFlushEnabled ? "on" : "off"}
        </small>
      </article>

      <article className="panel-card">
        <h3>Performance Diagnostics</h3>
        <p>
          Recent local UI timings and server timings stay advisory. Use them to
          spot regressions before you trust a baseline.
        </p>
        <div className="stack-list">
          <article className="panel-card compact">
            <strong>Client</strong>
            <small>
              {metricDescription(
                clientPerformanceSnapshot,
                "client.route.switch",
                "Route switch",
              )}
            </small>
            <small>
              {metricDescription(
                clientPerformanceSnapshot,
                "client.chat.submit_to_first_token",
                "Chat to first token",
              )}
            </small>
            <small>
              {metricDescription(
                clientPerformanceSnapshot,
                "client.chat.submit_to_done",
                "Chat to done",
              )}
            </small>
            <small>
              {metricDescription(
                clientPerformanceSnapshot,
                "client.ws.reconnect_to_resync",
                "Reconnect to resync",
              )}
            </small>
            <small>
              {metricDescription(
                clientPerformanceSnapshot,
                "client.file.save",
                "File save",
              )}
            </small>
            <small>
              {metricDescription(
                clientPerformanceSnapshot,
                "client.job.start_to_first_output",
                "Job to first output",
              )}
            </small>
          </article>
          <article className="panel-card compact">
            <strong>Server</strong>
            <small>
              {metricDescription(
                performanceQuery.data,
                "http.get./api/access",
                "GET /api/access",
              )}
            </small>
            <small>
              {metricDescription(
                performanceQuery.data,
                "http.get./api/dashboard",
                "GET /api/dashboard",
              )}
            </small>
            <small>
              {metricDescription(
                performanceQuery.data,
                "chat.stream.firstDeltaRelay",
                "Relay to first delta",
              )}
            </small>
            <small>
              {metricDescription(
                performanceQuery.data,
                "file.write",
                "File write",
              )}
            </small>
            <small>
              {metricDescription(
                performanceQuery.data,
                "job.firstOutput",
                "Job first output",
              )}
            </small>
          </article>
        </div>
      </article>
    </section>
  );
}
