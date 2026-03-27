import { useEffect, useMemo, useRef, useState } from "react";
import type { QuickstartResult } from "@droidagent/shared";
import QRCode from "qrcode";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";

import {
  useAccessQuery,
  useDashboardQuery,
  useStartupDiagnosticsQuery,
} from "../app-data";
import { useDroidAgentApp } from "../app-context";
import { postJson } from "../lib/api";

const DEFAULT_OLLAMA_MODEL = "qwen3.5:4b";

function summarizeHealth(ok: boolean, ready: string, pending: string) {
  return ok ? ready : pending;
}

export function SetupScreen() {
  const queryClient = useQueryClient();
  const autoPrepareTriggeredRef = useRef(false);
  const { runAction, setNotice, setErrorMessage } = useDroidAgentApp();
  const dashboardQuery = useDashboardQuery(true);
  const startupDiagnosticsQuery = useStartupDiagnosticsQuery(true);
  const accessQuery = useAccessQuery();
  const dashboard = dashboardQuery.data;
  const access = accessQuery.data;

  const [workspaceInput, setWorkspaceInput] = useState(".");
  const [setupModel, setSetupModel] = useState(DEFAULT_OLLAMA_MODEL);
  const [llamaModel, setLlamaModel] = useState("gemma-3-1b-it");
  const [cloudflareHostname, setCloudflareHostname] = useState("");
  const [cloudflareToken, setCloudflareToken] = useState("");
  const [phoneUrl, setPhoneUrl] = useState<string | null>(null);
  const [phoneQr, setPhoneQr] = useState<string | null>(null);
  const [quickstartResult, setQuickstartResult] =
    useState<QuickstartResult | null>(null);
  const [activeAction, setActiveAction] = useState<
    "idle" | "quickstart" | "workspace" | "model" | "llama" | "cloudflare"
  >("idle");

  const canEnableCloudflare =
    cloudflareHostname.trim().length > 0 &&
    (cloudflareToken.trim().length > 0 ||
      Boolean(access?.cloudflareStatus.tokenStored));

  useEffect(() => {
    if (dashboard?.setup.workspaceRoot) {
      setWorkspaceInput(dashboard.setup.workspaceRoot);
    }
  }, [dashboard?.setup.workspaceRoot]);

  useEffect(() => {
    const ollamaProvider = dashboard?.providers.find(
      (provider) => provider.id === "ollama-default",
    );
    const nextModel =
      ollamaProvider?.model ??
      dashboard?.setup.selectedModel ??
      DEFAULT_OLLAMA_MODEL;
    setSetupModel(nextModel);
  }, [dashboard?.providers, dashboard?.setup.selectedModel]);

  useEffect(() => {
    if (access?.cloudflareStatus.hostname) {
      setCloudflareHostname(access.cloudflareStatus.hostname);
    }
  }, [access?.cloudflareStatus.hostname]);

  useEffect(() => {
    setPhoneUrl(access?.canonicalOrigin?.origin ?? null);
  }, [access?.canonicalOrigin?.origin]);

  useEffect(() => {
    if (!phoneUrl) {
      setPhoneQr(null);
      return;
    }

    void QRCode.toDataURL(phoneUrl, {
      margin: 1,
      width: 280,
    }).then(setPhoneQr);
  }, [phoneUrl]);

  const ollamaRuntime = dashboard?.runtimes.find(
    (runtime) => runtime.id === "ollama",
  );
  const openclawRuntime = dashboard?.runtimes.find(
    (runtime) => runtime.id === "openclaw",
  );
  const ollamaProvider = dashboard?.providers.find(
    (provider) => provider.id === "ollama-default",
  );

  const workspaceReady = Boolean(dashboard?.setup.workspaceRoot);
  const ollamaReady = ollamaRuntime?.state === "running";
  const openclawReady = openclawRuntime?.state === "running";
  const providerSelected = ollamaProvider?.enabled === true;
  const providerModelMatches = ollamaProvider?.model === setupModel;
  const hostReady =
    workspaceReady &&
    ollamaReady &&
    openclawReady &&
    providerSelected &&
    providerModelMatches;
  const remoteReady = Boolean(
    access?.serveStatus.enabled && access?.canonicalOrigin,
  );
  const remoteCapable = Boolean(
    access?.tailscaleStatus.authenticated ||
    (access?.cloudflareStatus.running && access.cloudflareStatus.canonicalUrl),
  );

  const hostChecklist = useMemo(
    () => [
      {
        label: "Workspace",
        value: summarizeHealth(
          workspaceReady,
          dashboard?.setup.workspaceRoot ?? "Ready",
          "Will default to this repo",
        ),
        ready: workspaceReady,
      },
      {
        label: "Ollama",
        value: summarizeHealth(
          ollamaReady,
          "Running",
          ollamaRuntime?.healthMessage ?? "Will start automatically",
        ),
        ready: ollamaReady,
      },
      {
        label: "Agent runtime",
        value: summarizeHealth(
          openclawReady,
          "OpenClaw ready",
          openclawRuntime?.healthMessage ?? "Will start automatically",
        ),
        ready: openclawReady,
      },
      {
        label: "Default model",
        value: summarizeHealth(
          providerModelMatches && providerSelected,
          setupModel,
          "Will prepare automatically",
        ),
        ready: providerModelMatches && providerSelected,
      },
    ],
    [
      dashboard?.setup.workspaceRoot,
      ollamaReady,
      ollamaRuntime?.healthMessage,
      openclawReady,
      openclawRuntime?.healthMessage,
      providerModelMatches,
      providerSelected,
      setupModel,
      workspaceReady,
    ],
  );

  const remoteChecklist = useMemo(
    () => [
      {
        label: "Remote provider",
        value: access?.tailscaleStatus.authenticated
          ? "Tailscale authenticated on this Mac"
          : access?.cloudflareStatus.running
            ? "Cloudflare tunnel is already live"
            : "Tailscale sign-in still needed on this Mac",
        ready: remoteCapable,
      },
      {
        label: "Phone URL",
        value: remoteReady
          ? (access?.canonicalOrigin?.origin ?? "Ready")
          : "Not published yet",
        ready: remoteReady,
      },
      {
        label: "Phone sign-in",
        value: remoteReady
          ? "Open the remote URL on the phone and sign in with your passkey."
          : "DroidAgent will create the phone URL automatically when the remote provider is ready.",
        ready: remoteReady,
      },
    ],
    [
      access?.canonicalOrigin?.origin,
      access?.cloudflareStatus.running,
      access?.tailscaleStatus.authenticated,
      remoteCapable,
      remoteReady,
    ],
  );

  const setupStatusCards = useMemo(
    () => [
      {
        label: "This Mac",
        value: hostReady ? "Ready" : "Needs Prep",
        detail: hostReady
          ? "Workspace, local runtime, and model are in place."
          : "DroidAgent can prepare the default local path automatically.",
      },
      {
        label: "Phone Access",
        value: remoteReady
          ? "Ready"
          : remoteCapable
            ? "Almost There"
            : "Waiting",
        detail: remoteReady
          ? (phoneUrl ?? "Phone URL is ready.")
          : remoteCapable
            ? "The phone URL can be created automatically now."
            : "Sign in to Tailscale on this Mac to create the phone URL automatically.",
      },
      {
        label: "Local Model",
        value: setupModel,
        detail: providerModelMatches
          ? "Selected for the default Ollama provider."
          : "DroidAgent will use this for the first local chat.",
      },
    ],
    [
      hostReady,
      phoneUrl,
      providerModelMatches,
      remoteCapable,
      remoteReady,
      setupModel,
    ],
  );

  const primaryActionLabel =
    remoteCapable && !remoteReady
      ? "Finish Setup"
      : hostReady && remoteReady
        ? "Refresh Setup"
        : "Prepare DroidAgent";

  async function refreshSetupQueries() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      queryClient.invalidateQueries({ queryKey: ["access"] }),
      queryClient.invalidateQueries({ queryKey: ["startupDiagnostics"] }),
    ]);
  }

  async function executeQuickstart() {
    setActiveAction("quickstart");
    try {
      const result = await postJson<QuickstartResult>("/api/setup/quickstart", {
        workspaceRoot: workspaceInput,
        modelId: setupModel,
      });
      setQuickstartResult(result);
      setPhoneUrl(result.phoneUrl);
      await refreshSetupQueries();
      setNotice(
        result.remoteReady
          ? "DroidAgent is ready."
          : (result.remotePendingReason ?? "This Mac is ready."),
      );
    } finally {
      setActiveAction("idle");
    }
  }

  useEffect(() => {
    if (!dashboard || !access || autoPrepareTriggeredRef.current) {
      return;
    }

    const shouldAutoPrepare = !hostReady || (remoteCapable && !remoteReady);
    if (!shouldAutoPrepare) {
      return;
    }

    autoPrepareTriggeredRef.current = true;
    void runAction(async () => {
      await executeQuickstart();
    });
  }, [access, dashboard, hostReady, remoteCapable, remoteReady, runAction]);

  async function copyPhoneUrl() {
    if (!phoneUrl) {
      return;
    }

    try {
      await navigator.clipboard.writeText(phoneUrl);
      setNotice("Phone URL copied.");
    } catch {
      setErrorMessage("Clipboard access failed. Copy the remote URL manually.");
    }
  }

  return (
    <section className="stack-list setup-screen">
      <section className="panel-card quickstart-hero">
        <div className="panel-heading">
          <div>
            <div className="eyebrow">Quickstart</div>
            <h2>Make this Mac and your phone ready.</h2>
            <p className="setup-intro">
              After passkey sign-in, DroidAgent should handle the common path
              automatically: workspace, Ollama, OpenClaw, the default local
              model, then the phone URL.
            </p>
          </div>
        </div>

        <section className="setup-status-grid">
          {setupStatusCards.map((item) => (
            <article
              key={item.label}
              className="summary-card setup-status-card"
            >
              <span>{item.label}</span>
              <strong>{item.value}</strong>
              <small>{item.detail}</small>
            </article>
          ))}
        </section>

        <div className="button-row quickstart-actions">
          <button
            disabled={activeAction !== "idle"}
            onClick={() =>
              void runAction(async () => {
                await executeQuickstart();
              })
            }
          >
            {activeAction === "quickstart"
              ? "Preparing DroidAgent..."
              : primaryActionLabel}
          </button>
          {remoteReady ? (
            <Link className="button-link secondary" to="/chat">
              Open Chat
            </Link>
          ) : null}
        </div>

        {quickstartResult ? (
          <section className="quickstart-activity">
            <strong>What DroidAgent just handled</strong>
            <div className="journey-checklist">
              {quickstartResult.actions.map((action) => (
                <div key={action} className="journey-check ready">
                  <span>{action}</span>
                </div>
              ))}
            </div>
            {quickstartResult.remotePendingReason ? (
              <small>{quickstartResult.remotePendingReason}</small>
            ) : null}
          </section>
        ) : null}

        {phoneUrl ? (
          <div className="link-preview-card">
            <strong>Phone URL</strong>
            <div className="link-preview-row">
              <input value={phoneUrl} readOnly />
              <button
                type="button"
                className="secondary"
                onClick={() => void copyPhoneUrl()}
              >
                Copy
              </button>
            </div>
            <small>
              Open this on the phone and sign in with your passkey. Additional
              device passkeys can be added later from Settings.
            </small>
            {phoneQr ? (
              <img
                className="setup-qr"
                src={phoneQr}
                alt="Remote sign-in URL QR code"
              />
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="quickstart-grid">
        <article
          className={`panel-card journey-card${hostReady ? " active-card" : ""}`}
        >
          <div className="journey-kicker">Local Status</div>
          <h3>This Mac</h3>
          <div className="journey-checklist">
            {hostChecklist.map((item) => (
              <div
                key={item.label}
                className={`journey-check${item.ready ? " ready" : ""}`}
              >
                <strong>{item.label}</strong>
                <span>{item.value}</span>
              </div>
            ))}
          </div>
        </article>

        <article
          className={`panel-card journey-card${remoteReady ? " active-card" : ""}`}
        >
          <div className="journey-kicker">Remote Status</div>
          <h3>Phone Access</h3>
          <div className="journey-checklist">
            {remoteChecklist.map((item) => (
              <div
                key={item.label}
                className={`journey-check${item.ready ? " ready" : ""}`}
              >
                <strong>{item.label}</strong>
                <span>{item.value}</span>
              </div>
            ))}
          </div>
        </article>
      </section>

      <details className="panel-card details-card">
        <summary>Advanced</summary>
        <div className="advanced-stack">
          <article className="panel-card compact">
            <h3>Workspace and Local Model</h3>
            <p>
              Override the default workspace or local model when you need a
              different baseline than the automatic path.
            </p>
            <div className="field-stack">
              <label>
                Workspace root
                <input
                  value={workspaceInput}
                  onChange={(event) => setWorkspaceInput(event.target.value)}
                />
              </label>
              <label>
                Ollama model
                <input
                  value={setupModel}
                  onChange={(event) => setSetupModel(event.target.value)}
                />
              </label>
              <div className="button-row">
                <button
                  disabled={activeAction !== "idle"}
                  onClick={() =>
                    void runAction(async () => {
                      setActiveAction("workspace");
                      try {
                        await postJson("/api/setup/workspace", {
                          workspaceRoot: workspaceInput,
                        });
                        await refreshSetupQueries();
                      } finally {
                        setActiveAction("idle");
                      }
                    }, "Workspace updated.")
                  }
                >
                  Save Workspace
                </button>
                <button
                  className="secondary"
                  disabled={activeAction !== "idle"}
                  onClick={() =>
                    void runAction(async () => {
                      setActiveAction("model");
                      try {
                        await postJson("/api/setup/model", {
                          runtimeId: "ollama",
                          modelId: setupModel,
                        });
                        await refreshSetupQueries();
                      } finally {
                        setActiveAction("idle");
                      }
                    }, "Ollama model updated.")
                  }
                >
                  Use This Model
                </button>
              </div>
            </div>
          </article>

          <article className="panel-card compact">
            <h3>Alternative Runtime</h3>
            <p>
              llama.cpp remains the advanced local path when you want a smaller
              direct runtime with Metal defaults.
            </p>
            <div className="field-stack">
              <label>
                llama.cpp preset
                <select
                  value={llamaModel}
                  onChange={(event) => setLlamaModel(event.target.value)}
                >
                  <option value="gemma-3-1b-it">Gemma 3 1B IT</option>
                  <option value="qwen3-8b-instruct">Qwen3 8B Instruct</option>
                </select>
              </label>
              <div className="button-row">
                <button
                  className="secondary"
                  disabled={activeAction !== "idle"}
                  onClick={() =>
                    void runAction(async () => {
                      setActiveAction("llama");
                      try {
                        await postJson("/api/setup/runtime", {
                          runtimeId: "llamaCpp",
                        });
                        await postJson("/api/runtime/llamaCpp/models", {
                          modelId: llamaModel,
                        });
                        await refreshSetupQueries();
                      } finally {
                        setActiveAction("idle");
                      }
                    }, "llama.cpp prepared.")
                  }
                >
                  Prepare llama.cpp
                </button>
              </div>
            </div>
          </article>

          <article className="panel-card compact">
            <h3>Cloudflare Fallback</h3>
            <p>
              Use this only when you need a stable public hostname instead of
              the default Tailscale path.
            </p>
            <div className="field-stack">
              <label>
                Public hostname
                <input
                  value={cloudflareHostname}
                  onChange={(event) =>
                    setCloudflareHostname(event.target.value)
                  }
                  placeholder="agent.example.com"
                />
              </label>
              <label>
                Tunnel token
                <input
                  type="password"
                  value={cloudflareToken}
                  onChange={(event) => setCloudflareToken(event.target.value)}
                  placeholder={
                    access?.cloudflareStatus.tokenStored
                      ? "Stored in Keychain"
                      : "Paste Cloudflare tunnel token"
                  }
                />
              </label>
              <div className="button-row">
                <button
                  disabled={!canEnableCloudflare || activeAction !== "idle"}
                  onClick={() =>
                    void runAction(async () => {
                      setActiveAction("cloudflare");
                      try {
                        await postJson("/api/access/cloudflare/enable", {
                          hostname: cloudflareHostname,
                          tunnelToken: cloudflareToken,
                        });
                        setCloudflareToken("");
                        await refreshSetupQueries();
                      } finally {
                        setActiveAction("idle");
                      }
                    }, "Cloudflare tunnel enabled.")
                  }
                >
                  Enable Cloudflare
                </button>
                <button
                  className="secondary"
                  disabled={
                    !access?.cloudflareStatus.canonicalUrl ||
                    activeAction !== "idle"
                  }
                  onClick={() =>
                    void runAction(async () => {
                      setActiveAction("cloudflare");
                      try {
                        await postJson("/api/access/canonical", {
                          source: "cloudflare",
                        });
                        await refreshSetupQueries();
                      } finally {
                        setActiveAction("idle");
                      }
                    }, "Cloudflare set as canonical.")
                  }
                >
                  Use Cloudflare URL
                </button>
              </div>
            </div>
          </article>

          <article className="panel-card compact">
            <h3>Diagnostics</h3>
            <div className="journey-checklist diagnostics-list">
              {(
                startupDiagnosticsQuery.data ??
                dashboard?.startupDiagnostics ??
                []
              ).map((diagnostic) => (
                <div
                  key={diagnostic.id}
                  className={`journey-check${diagnostic.health === "ok" ? " ready" : ""}`}
                >
                  <strong>{diagnostic.id}</strong>
                  <span>{diagnostic.message}</span>
                </div>
              ))}
            </div>
          </article>
        </div>
      </details>
    </section>
  );
}
