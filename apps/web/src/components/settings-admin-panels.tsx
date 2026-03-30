import type { CloudProviderSummary } from "@droidagent/shared";

import { api, postJson } from "../lib/api";
import { metricDescription } from "../lib/formatters";
import type { SettingsAdminPanelsProps } from "./settings-panel-types";

function AppearancePanel({
  resolvedTheme,
  themePreference,
  setThemePreference,
}: Pick<
  SettingsAdminPanelsProps,
  "resolvedTheme" | "themePreference" | "setThemePreference"
>) {
  return (
    <article className="panel-card">
      <div className="panel-heading">
        <h3>Appearance</h3>
        <p>
          Keep the shell readable on the Mac and the Fold. Theme preference
          applies immediately and stays local to this browser.
        </p>
      </div>
      <div className="button-row theme-toggle-row">
        {(["system", "dark", "light"] as const).map((option) => (
          <button
            key={option}
            className={themePreference === option ? "" : "secondary"}
            onClick={() => setThemePreference(option)}
            type="button"
          >
            {option === "system"
              ? `System (${resolvedTheme})`
              : option.charAt(0).toUpperCase() + option.slice(1)}
          </button>
        ))}
      </div>
      <small>
        Current theme: {resolvedTheme}. Chat is optimized for a compact dedicated
        viewport with a sticky composer and responsive message width.
      </small>
    </article>
  );
}

function PasskeysPanel({
  passkeys,
  runAction,
  handleAddPasskey,
}: Pick<SettingsAdminPanelsProps, "passkeys" | "runAction" | "handleAddPasskey">) {
  return (
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
            void runAction(handleAddPasskey, "Additional passkey enrolled.")
          }
        >
          Add Current Device
        </button>
      </div>
      <div className="stack-list">
        {passkeys.map((passkey) => (
          <article key={passkey.id} className="panel-card compact">
            <strong>{passkey.deviceType}</strong>
            <small>Created {new Date(passkey.createdAt).toLocaleString()}</small>
            <small>
              {passkey.lastUsedAt
                ? `Last used ${new Date(passkey.lastUsedAt).toLocaleString()}`
                : "Never used yet"}
            </small>
          </article>
        ))}
      </div>
    </article>
  );
}

function AppShellPanel({
  canInstallApp,
  installApp,
  runAction,
}: Pick<SettingsAdminPanelsProps, "canInstallApp" | "installApp" | "runAction">) {
  return (
    <article className="panel-card">
      <div className="panel-heading">
        <h3>App Shell</h3>
        <p>
          Install the PWA when you want the cleaner full-screen phone shell. The
          core operator path stays in Setup, Chat, Files, Jobs, Models, and
          Settings.
        </p>
      </div>
      <div className="button-row">
        <button
          disabled={!canInstallApp}
          onClick={() => void runAction(installApp, "Install prompt opened.")}
        >
          Install App
        </button>
      </div>
      <small>
        Signal remains optional and secondary. The default experience is the web
        shell plus the Tailscale phone URL.
      </small>
    </article>
  );
}

function BuildIdentityPanel({
  build,
}: Pick<SettingsAdminPanelsProps, "build">) {
  return (
    <article className="panel-card">
      <div className="panel-heading">
        <h3>Build Identity</h3>
        <p>
          One version string for the Mac, the phone shell, the docs, and the
          repo. Use this when you compare screenshots, logs, or bug reports.
        </p>
      </div>
      <div className="status-list">
        <article className="health-row ready">
          <div className="health-row-top">
            <strong>Version</strong>
            <span className="status-chip ready">v{build?.version ?? "unknown"}</span>
          </div>
          <small>
            {build?.gitCommit
              ? `Commit ${build.gitCommit}`
              : "Git commit unavailable on this host."}
          </small>
        </article>
        <article className="health-row ready">
          <div className="health-row-top">
            <strong>Runtime</strong>
            <span className="status-chip ready">
              {build?.nodeVersion ?? "unknown"}
            </span>
          </div>
          <small>{build?.packageManager ?? "Package manager metadata unavailable."}</small>
        </article>
      </div>
    </article>
  );
}

function CloudProvidersPanel({
  cloudProviders,
  providerApiKeys,
  setProviderApiKeys,
  providerModels,
  setProviderModels,
  runAction,
}: Pick<
  SettingsAdminPanelsProps,
  | "cloudProviders"
  | "providerApiKeys"
  | "setProviderApiKeys"
  | "providerModels"
  | "setProviderModels"
  | "runAction"
>) {
  return (
    <article className="panel-card">
      <h3>Cloud Providers</h3>
      <p>
        API keys are stored in the macOS login keychain. Only provider metadata
        stays inside DroidAgent. These are optional advanced paths; the guided
        local-first flow stays on Ollama plus Tailscale.
      </p>
      <div className="stack-list">
        {cloudProviders.map((provider: CloudProviderSummary) => {
          const apiKey = providerApiKeys[provider.id] ?? "";
          const defaultModel = providerModels[provider.id] ?? provider.defaultModel ?? "";
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
                  placeholder={provider.stored ? "Stored in Keychain" : provider.envVar}
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
        })}
      </div>
    </article>
  );
}

function SmartContextPanel({
  contextManagement,
  memory,
  runAction,
}: Pick<SettingsAdminPanelsProps, "contextManagement" | "memory" | "runAction">) {
  return (
    <article className="panel-card">
      <h3>Smart Context Management</h3>
      <p>
        Let DroidAgent configure OpenClaw compaction, pruning, and pre-compaction
        memory flush with safe defaults.
      </p>
      <div className="button-row">
        <button
          onClick={() =>
            void runAction(async () => {
              await postJson("/api/runtime/context-management", {
                enabled: !contextManagement?.enabled,
              });
            }, contextManagement?.enabled
              ? "Smart context management disabled."
              : "Smart context management enabled.")
          }
        >
          {contextManagement?.enabled ? "Disable" : "Enable"}
        </button>
      </div>
      <small>
        Compaction: {contextManagement?.compactionMode ?? "unknown"} • Pruning:{" "}
        {contextManagement?.pruningMode ?? "unknown"} • Memory flush:{" "}
        {contextManagement?.memoryFlushEnabled ? "on" : "off"} • Session memory:{" "}
        {memory?.sessionMemoryEnabled ? "on" : "off"}
      </small>
    </article>
  );
}

function PerformanceDiagnosticsPanel({
  clientPerformanceSnapshot,
  performanceSnapshot,
}: Pick<
  SettingsAdminPanelsProps,
  "clientPerformanceSnapshot" | "performanceSnapshot"
>) {
  return (
    <article className="panel-card">
      <h3>Performance Diagnostics</h3>
      <p>
        Recent local UI timings and server timings stay advisory. Use them to
        spot regressions before you trust a baseline.
      </p>
      <div className="stack-list">
        <article className="panel-card compact">
          <strong>Client</strong>
          <small>{metricDescription(clientPerformanceSnapshot, "client.route.switch", "Route switch")}</small>
          <small>{metricDescription(clientPerformanceSnapshot, "client.chat.submit_to_first_token", "Chat to first token")}</small>
          <small>{metricDescription(clientPerformanceSnapshot, "client.chat.submit_to_done", "Chat to done")}</small>
          <small>{metricDescription(clientPerformanceSnapshot, "client.ws.reconnect_to_resync", "Reconnect to resync")}</small>
          <small>{metricDescription(clientPerformanceSnapshot, "client.file.save", "File save")}</small>
          <small>{metricDescription(clientPerformanceSnapshot, "client.memory.prepare", "Memory prepare")}</small>
          <small>{metricDescription(clientPerformanceSnapshot, "client.job.start_to_first_output", "Job to first output")}</small>
        </article>
        <article className="panel-card compact">
          <strong>Server</strong>
          <small>{metricDescription(performanceSnapshot, "host.pressure.sample", "Host pressure sample")}</small>
          <small>{metricDescription(performanceSnapshot, "http.get./api/access", "GET /api/access")}</small>
          <small>{metricDescription(performanceSnapshot, "http.get./api/dashboard", "GET /api/dashboard")}</small>
          <small>{metricDescription(performanceSnapshot, "chat.send.submitToAccepted", "Submit to accepted")}</small>
          <small>{metricDescription(performanceSnapshot, "chat.stream.acceptedToFirstDelta", "Accepted to first delta")}</small>
          <small>{metricDescription(performanceSnapshot, "chat.stream.firstDeltaForward", "First delta forward")}</small>
          <small>{metricDescription(performanceSnapshot, "chat.stream.acceptedToCompleteRelay", "Accepted to complete relay")}</small>
          <small>{metricDescription(performanceSnapshot, "chat.run.toolWait", "Tool wait")}</small>
          <small>{metricDescription(performanceSnapshot, "file.write", "File write")}</small>
          <small>{metricDescription(performanceSnapshot, "job.firstOutput", "Job first output")}</small>
          <small>{metricDescription(performanceSnapshot, "memory.prepare", "Memory prepare")}</small>
          <small>{metricDescription(performanceSnapshot, "memory.reindex", "Memory reindex")}</small>
          <small>{metricDescription(performanceSnapshot, "memory.draft.apply", "Memory draft apply")}</small>
          <small>{metricDescription(performanceSnapshot, "memory.todayNote", "Today note")}</small>
        </article>
      </div>
    </article>
  );
}

export function SettingsAdminPanels(props: SettingsAdminPanelsProps) {
  return (
    <>
      <section className="settings-grid">
        <AppearancePanel
          resolvedTheme={props.resolvedTheme}
          setThemePreference={props.setThemePreference}
          themePreference={props.themePreference}
        />
        <PasskeysPanel
          handleAddPasskey={props.handleAddPasskey}
          passkeys={props.passkeys}
          runAction={props.runAction}
        />
        <AppShellPanel
          canInstallApp={props.canInstallApp}
          installApp={props.installApp}
          runAction={props.runAction}
        />
        <BuildIdentityPanel build={props.build} />
      </section>

      <CloudProvidersPanel
        cloudProviders={props.cloudProviders}
        providerApiKeys={props.providerApiKeys}
        providerModels={props.providerModels}
        runAction={props.runAction}
        setProviderApiKeys={props.setProviderApiKeys}
        setProviderModels={props.setProviderModels}
      />
      <SmartContextPanel
        contextManagement={props.contextManagement}
        memory={props.memory}
        runAction={props.runAction}
      />
      <PerformanceDiagnosticsPanel
        clientPerformanceSnapshot={props.clientPerformanceSnapshot}
        performanceSnapshot={props.performanceSnapshot}
      />
    </>
  );
}
