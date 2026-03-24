import { useState } from "react";
import { startRegistration, type PublicKeyCredentialCreationOptionsJSON as BrowserRegistrationOptions } from "@simplewebauthn/browser";
import { useQueryClient } from "@tanstack/react-query";

import type { BootstrapLink, CloudProviderSummary } from "@droidagent/shared";

import { useDroidAgentApp } from "../app-context";
import { api, postJson } from "../lib/api";

export function SettingsScreen() {
  const queryClient = useQueryClient();
  const { dashboard, access, passkeysQuery, canInstallApp, installApp, runAction, refreshDashboard } = useDroidAgentApp();
  const [providerApiKeys, setProviderApiKeys] = useState<Record<string, string>>({});
  const [providerModels, setProviderModels] = useState<Record<string, string>>({});
  const [bootstrapLink, setBootstrapLink] = useState<BootstrapLink | null>(null);

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
        <pre>{JSON.stringify(dashboard?.launchAgent ?? {}, null, 2)}</pre>
        <div className="button-row">
          <button
            onClick={() =>
              void runAction(async () => {
                await postJson("/api/service/launch-agent/install", {});
                await refreshDashboard();
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
                await refreshDashboard();
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
                await refreshDashboard();
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
                await refreshDashboard();
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
                        await refreshDashboard();
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
                        await refreshDashboard();
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
                        await refreshDashboard();
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
        <p>Private-network-first by design. Daily use stays on the canonical Tailscale URL after bootstrap.</p>
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
                const link = await postJson<BootstrapLink>("/api/access/bootstrap", {});
                setBootstrapLink(link);
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
        <h3>PWA Install</h3>
        <p>Add DroidAgent to the home screen to get a full-screen shell on the phone.</p>
        <button disabled={!canInstallApp} onClick={() => void runAction(installApp, "Install prompt opened.")}>
          Install App
        </button>
      </article>
    </section>
  );
}
