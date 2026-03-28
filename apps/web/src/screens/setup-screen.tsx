import { useEffect, useMemo, useRef, useState } from "react";
import type {
  BootstrapLink,
  QuickstartResult,
  StartupDiagnostic,
} from "@droidagent/shared";
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
import { formatTokenBudget } from "../lib/formatters";

const DEFAULT_OLLAMA_MODEL = "qwen3.5:4b";

interface ReadinessItem {
  label: string;
  value: string;
  detail: string;
  ready: boolean;
}

function summarizeHealth(ok: boolean, ready: string, pending: string) {
  return ok ? ready : pending;
}

function progressPercent(items: { ready: boolean }[]): number {
  if (items.length === 0) {
    return 0;
  }

  const readyCount = items.filter((item) => item.ready).length;
  return Math.round((readyCount / items.length) * 100);
}

export function SetupScreen() {
  const queryClient = useQueryClient();
  const autoPrepareTriggeredRef = useRef(false);
  const bootstrapIssuedRef = useRef(false);
  const { runAction, setNotice, setErrorMessage } = useDroidAgentApp();
  const dashboardQuery = useDashboardQuery(true);
  const startupDiagnosticsQuery = useStartupDiagnosticsQuery(true);
  const accessQuery = useAccessQuery();
  const dashboard = dashboardQuery.data;
  const access = accessQuery.data;

  const [workspaceInput, setWorkspaceInput] = useState(".");
  const [setupModel, setSetupModel] = useState(DEFAULT_OLLAMA_MODEL);
  const [llamaModel, setLlamaModel] = useState("gemma-3-1b-it");
  const [phoneUrl, setPhoneUrl] = useState<string | null>(null);
  const [bootstrapLink, setBootstrapLink] = useState<BootstrapLink | null>(
    null,
  );
  const [phoneQr, setPhoneQr] = useState<string | null>(null);
  const [quickstartResult, setQuickstartResult] =
    useState<QuickstartResult | null>(null);
  const [activeAction, setActiveAction] = useState<
    "idle" | "quickstart" | "workspace" | "model" | "llama"
  >("idle");

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
    setPhoneUrl(access?.canonicalOrigin?.origin ?? null);
  }, [access?.canonicalOrigin?.origin]);

  const localhostHostnames = useMemo(
    () => new Set(["localhost", "127.0.0.1", "::1", "[::1]"]),
    [],
  );
  const localhostMaintenance = localhostHostnames.has(window.location.hostname);
  const enrollmentUrl = bootstrapLink?.bootstrapUrl ?? null;
  const phoneLaunchUrl = enrollmentUrl ?? phoneUrl;

  useEffect(() => {
    if (!phoneLaunchUrl) {
      setPhoneQr(null);
      return;
    }

    void QRCode.toDataURL(phoneLaunchUrl, {
      margin: 1,
      width: 280,
    }).then(setPhoneQr);
  }, [phoneLaunchUrl]);

  const ollamaRuntime = dashboard?.runtimes.find(
    (runtime) => runtime.id === "ollama",
  );
  const openclawRuntime = dashboard?.runtimes.find(
    (runtime) => runtime.id === "openclaw",
  );
  const ollamaProvider = dashboard?.providers.find(
    (provider) => provider.id === "ollama-default",
  );
  const memoryStatus = dashboard?.memory;
  const diagnostics =
    startupDiagnosticsQuery.data ?? dashboard?.startupDiagnostics ?? [];

  const passkeyConfigured = Boolean(dashboard?.setup.passkeyConfigured);
  const workspaceReady = Boolean(dashboard?.setup.workspaceRoot);
  const memoryReady = Boolean(memoryStatus?.ready);
  const ollamaReady = ollamaRuntime?.state === "running";
  const openclawReady = openclawRuntime?.state === "running";
  const providerSelected = ollamaProvider?.enabled === true;
  const providerModelMatches = ollamaProvider?.model === setupModel;
  const hostReady =
    workspaceReady &&
    memoryReady &&
    ollamaReady &&
    openclawReady &&
    providerSelected &&
    providerModelMatches;
  const tailscaleReady = Boolean(access?.tailscaleStatus.authenticated);
  const remoteReady = Boolean(
    access?.serveStatus.enabled && access?.canonicalOrigin?.origin,
  );
  const canIssueEnrollmentLink =
    localhostMaintenance && passkeyConfigured && remoteReady;

  const readinessSteps = useMemo<ReadinessItem[]>(
    () => [
      {
        label: "Owner Access",
        value: passkeyConfigured ? "Passkey enrolled" : "Passkey required",
        detail: passkeyConfigured
          ? "The owner login is already configured for this DroidAgent instance."
          : "Sign in with the owner passkey first so DroidAgent can finish the rest automatically.",
        ready: passkeyConfigured,
      },
      {
        label: "This Mac",
        value: hostReady ? "Ready" : "Needs prep",
        detail: hostReady
          ? "Workspace, memory, Ollama, OpenClaw, and the default model are in place."
          : "DroidAgent can prepare the common local path for you.",
        ready: hostReady,
      },
      {
        label: "Tailscale",
        value: tailscaleReady ? "Connected" : "Not signed in",
        detail: tailscaleReady
          ? "This Mac is authenticated to the tailnet."
          : "Sign in to Tailscale on this Mac to unlock the private phone URL.",
        ready: tailscaleReady,
      },
      {
        label: "Phone URL",
        value: remoteReady ? "Live" : "Waiting",
        detail: remoteReady
          ? (access?.canonicalOrigin?.origin ?? "Phone URL ready")
          : tailscaleReady
            ? "DroidAgent can publish the Tailscale phone URL now."
            : "The phone URL appears after Tailscale is connected.",
        ready: remoteReady,
      },
    ],
    [
      access?.canonicalOrigin?.origin,
      hostReady,
      passkeyConfigured,
      remoteReady,
      tailscaleReady,
    ],
  );

  const hostChecklist = useMemo<ReadinessItem[]>(
    () => [
      {
        label: "Workspace",
        value: summarizeHealth(
          workspaceReady,
          dashboard?.setup.workspaceRoot ?? "Ready",
          "Will default to this repo",
        ),
        detail: workspaceReady
          ? "Files, jobs, and editing are already scoped to the selected workspace."
          : "DroidAgent will use this repo root unless you override it below.",
        ready: workspaceReady,
      },
      {
        label: "Workspace Memory",
        value: summarizeHealth(
          memoryReady,
          "Bootstrapped",
          "Will be created automatically",
        ),
        detail: memoryReady
          ? `MEMORY.md, skills, and daily notes are ready under ${memoryStatus?.effectiveWorkspaceRoot ?? dashboard?.setup.workspaceRoot ?? "the workspace"}.`
          : "DroidAgent will seed durable memory files, daily notes, and workspace skills for you.",
        ready: memoryReady,
      },
      {
        label: "Ollama",
        value: summarizeHealth(
          ollamaReady,
          "Running",
          ollamaRuntime?.healthMessage ?? "Will start automatically",
        ),
        detail: ollamaReady
          ? "The default local runtime is up."
          : "The quickstart path will start Ollama and check the selected model.",
        ready: ollamaReady,
      },
      {
        label: "OpenClaw",
        value: summarizeHealth(
          openclawReady,
          "Ready",
          openclawRuntime?.healthMessage ?? "Will start automatically",
        ),
        detail: openclawReady
          ? "The agent harness is ready for live sessions."
          : "DroidAgent will prepare the local harness automatically.",
        ready: openclawReady,
      },
      {
        label: "Default Model",
        value: summarizeHealth(
          providerModelMatches && providerSelected,
          setupModel,
          "Will prepare automatically",
        ),
        detail:
          providerModelMatches && providerSelected
            ? `The default Ollama provider is already pointing at the chosen model with a ${formatTokenBudget(
                ollamaProvider?.contextWindow,
              )} context budget.`
            : "DroidAgent will pin this model for the first chat.",
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
      memoryReady,
      memoryStatus?.effectiveWorkspaceRoot,
      workspaceReady,
    ],
  );

  const remoteChecklist = useMemo<ReadinessItem[]>(
    () => [
      {
        label: "Tailnet Sign-In",
        value: tailscaleReady ? "Authenticated" : "Required",
        detail: tailscaleReady
          ? "This Mac can now publish a private remote URL over Tailscale."
          : (access?.tailscaleStatus.healthMessage ??
            "Finish Tailscale sign-in on this Mac first."),
        ready: tailscaleReady,
      },
      {
        label: "Private Phone URL",
        value: remoteReady ? "Published" : "Not published yet",
        detail: remoteReady
          ? (access?.canonicalOrigin?.origin ?? "Remote URL ready")
          : "DroidAgent uses Tailscale Serve for the phone URL in the guided path.",
        ready: remoteReady,
      },
      {
        label: "Phone Sign-In",
        value:
          remoteReady && passkeyConfigured
            ? "Ready now"
            : "Waiting for the URL",
        detail:
          remoteReady && passkeyConfigured
            ? "Open the phone URL. If this device does not already have an owner passkey, use a one-time device enrollment link first."
            : "Once the URL is live, DroidAgent is ready for the phone browser or PWA shell.",
        ready: remoteReady && passkeyConfigured,
      },
    ],
    [
      access?.canonicalOrigin?.origin,
      access?.tailscaleStatus.healthMessage,
      passkeyConfigured,
      remoteReady,
      tailscaleReady,
    ],
  );

  const readinessPercent = progressPercent(readinessSteps);
  const hostPercent = progressPercent(hostChecklist);
  const remotePercent = progressPercent(remoteChecklist);
  const readyCount = readinessSteps.filter((item) => item.ready).length;

  const primaryActionLabel = !hostReady
    ? "Prepare This Mac"
    : remoteReady
      ? "Everything Looks Ready"
      : "Finish Phone Access";

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
      const requestedWorkspaceRoot =
        workspaceInput.trim() === "." && dashboard?.setup.workspaceRoot
          ? dashboard.setup.workspaceRoot
          : workspaceInput;
      const result = await postJson<QuickstartResult>("/api/setup/quickstart", {
        workspaceRoot: requestedWorkspaceRoot,
        modelId: setupModel,
      });
      setQuickstartResult(result);
      setPhoneUrl(result.phoneUrl);
      if (!result.remoteReady) {
        setBootstrapLink(null);
        bootstrapIssuedRef.current = false;
      }
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

    const shouldAutoPrepare = !hostReady || (tailscaleReady && !remoteReady);
    if (!shouldAutoPrepare) {
      return;
    }

    autoPrepareTriggeredRef.current = true;
    void runAction(async () => {
      await executeQuickstart();
    });
  }, [access, dashboard, hostReady, remoteReady, runAction, tailscaleReady]);

  useEffect(() => {
    if (
      !canIssueEnrollmentLink ||
      bootstrapLink ||
      bootstrapIssuedRef.current
    ) {
      return;
    }

    bootstrapIssuedRef.current = true;
    void postJson<BootstrapLink>("/api/access/bootstrap", {})
      .then((link) => {
        setBootstrapLink(link);
      })
      .catch(() => {
        bootstrapIssuedRef.current = false;
      });
  }, [bootstrapLink, canIssueEnrollmentLink]);

  async function copyLink(value: string, message: string) {
    if (!value) {
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      setNotice(message);
    } catch {
      setErrorMessage("Clipboard access failed. Copy the remote URL manually.");
    }
  }

  return (
    <section className="stack-list setup-screen">
      <section className="panel-card quickstart-hero">
        <div className="setup-hero-heading">
          <div className="panel-heading">
            <div className="eyebrow">Quickstart</div>
            <h2>Make this Mac and your phone ready.</h2>
            <p className="setup-intro">
              DroidAgent should handle the normal path in one pass: shared
              workspace, Ollama, OpenClaw, a 65k local context budget, then the
              private Tailscale phone URL and a clean memory scaffold.
            </p>
          </div>
          <div className="setup-hero-stats">
            <strong>
              {readyCount}/{readinessSteps.length} core checks live
            </strong>
            <small>
              {remoteReady
                ? "You can move straight into chat and phone access."
                : tailscaleReady
                  ? "Only the phone URL is left."
                  : "This Mac still needs Tailscale sign-in for phone access."}
            </small>
          </div>
        </div>

        <div className="health-meter hero-meter">
          <span style={{ width: `${readinessPercent}%` }} />
        </div>

        <div className="status-chip-row">
          {readinessSteps.map((item) => (
            <div
              key={item.label}
              className={`status-chip${item.ready ? " ready" : ""}`}
            >
              {item.label}
            </div>
          ))}
        </div>

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
          {hostReady ? (
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

        <div className="link-preview-card phone-launch-card">
          <div className="phone-launch-head">
            <strong>{enrollmentUrl ? "Add This Phone" : "Phone URL"}</strong>
            {remoteReady ? (
              <span className="status-chip ready">Live</span>
            ) : (
              <span className="status-chip">Waiting</span>
            )}
          </div>
          {phoneLaunchUrl ? (
            <>
              <div className="link-preview-row">
                <input value={phoneLaunchUrl} readOnly />
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    void copyLink(
                      phoneLaunchUrl,
                      enrollmentUrl
                        ? "Phone enrollment link copied."
                        : "Phone URL copied.",
                    )
                  }
                >
                  Copy
                </button>
              </div>
              {enrollmentUrl ? (
                <>
                  <small>
                    Scan this QR from the Mac or open this one-time link on the
                    Fold. It adds a passkey on that phone directly, so daily
                    sign-in can happen there without the Mac passkey.
                  </small>
                  {phoneUrl ? (
                    <div className="link-preview-row secondary-row">
                      <input value={phoneUrl} readOnly />
                      <button
                        type="button"
                        className="secondary"
                        onClick={() =>
                          void copyLink(phoneUrl, "Daily phone URL copied.")
                        }
                      >
                        Copy Daily URL
                      </button>
                    </div>
                  ) : null}
                  <small>
                    After enrollment, daily use is just the Tailscale URL
                    above. The one-time device link can be discarded.
                  </small>
                </>
              ) : (
                <small>
                  Open this on the phone and sign in with the owner passkey.
                  Additional device passkeys can be added later from Settings.
                </small>
              )}
              {phoneQr ? (
                <img
                  className="setup-qr"
                  src={phoneQr}
                  alt={
                    enrollmentUrl
                      ? "Phone device enrollment QR code"
                      : "Remote sign-in URL QR code"
                  }
                />
              ) : null}
            </>
          ) : (
            <small>
              {tailscaleReady
                ? "DroidAgent can publish the phone URL now. Run the quickstart again if it has not appeared yet."
                : "Sign in to Tailscale on this Mac first. DroidAgent will keep the remote path private and tailnet-scoped."}
            </small>
          )}
        </div>
      </section>

      <section className="setup-overview-grid">
        <article
          className={`panel-card compact status-section-card${hostReady ? " active-card" : ""}`}
        >
          <div className="status-section-header">
            <div>
              <div className="journey-kicker">Local Readiness</div>
              <h3>This Mac</h3>
            </div>
            <strong className="status-counter">
              {hostChecklist.filter((item) => item.ready).length}/
              {hostChecklist.length}
            </strong>
          </div>
          <div className="health-meter">
            <span style={{ width: `${hostPercent}%` }} />
          </div>
          <div className="status-list">
            {hostChecklist.map((item) => (
              <article
                key={item.label}
                className={`health-row${item.ready ? " ready" : ""}`}
              >
                <div className="health-row-top">
                  <strong>{item.label}</strong>
                  <span className={`status-chip${item.ready ? " ready" : ""}`}>
                    {item.value}
                  </span>
                </div>
                <small>{item.detail}</small>
              </article>
            ))}
          </div>
        </article>

        <article
          className={`panel-card compact status-section-card${remoteReady ? " active-card" : ""}`}
        >
          <div className="status-section-header">
            <div>
              <div className="journey-kicker">Phone Access</div>
              <h3>Tailscale Path</h3>
            </div>
            <strong className="status-counter">
              {remoteChecklist.filter((item) => item.ready).length}/
              {remoteChecklist.length}
            </strong>
          </div>
          <div className="health-meter">
            <span style={{ width: `${remotePercent}%` }} />
          </div>
          <div className="status-list">
            {remoteChecklist.map((item) => (
              <article
                key={item.label}
                className={`health-row${item.ready ? " ready" : ""}`}
              >
                <div className="health-row-top">
                  <strong>{item.label}</strong>
                  <span className={`status-chip${item.ready ? " ready" : ""}`}>
                    {item.value}
                  </span>
                </div>
                <small>{item.detail}</small>
              </article>
            ))}
          </div>
        </article>
      </section>

      <details className="panel-card details-card">
        <summary>Manual Controls</summary>
        <div className="advanced-stack">
          <article className="panel-card compact">
            <h3>Workspace and Local Model</h3>
            <p>
              Override the default workspace or local model only when you need
              something different than the quickstart path.
            </p>
            <small>
              Local default: {setupModel} with{" "}
              {formatTokenBudget(ollamaProvider?.contextWindow)} context, smart
              trimming, and workspace memory bootstrap.
            </small>
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
                        const requestedWorkspaceRoot =
                          workspaceInput.trim() === "." &&
                          dashboard?.setup.workspaceRoot
                            ? dashboard.setup.workspaceRoot
                            : workspaceInput;
                        await postJson("/api/setup/workspace", {
                          workspaceRoot: requestedWorkspaceRoot,
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
            <h3>Diagnostics</h3>
            <div className="status-list">
              {diagnostics.map((diagnostic: StartupDiagnostic) => (
                <article
                  key={diagnostic.id}
                  className={`health-row${diagnostic.health === "ok" ? " ready" : ""}`}
                >
                  <div className="health-row-top">
                    <strong>{diagnostic.id}</strong>
                    <span
                      className={`status-chip${diagnostic.health === "ok" ? " ready" : ""}`}
                    >
                      {diagnostic.health === "ok" ? "OK" : "Needs review"}
                    </span>
                  </div>
                  <small>{diagnostic.message}</small>
                </article>
              ))}
            </div>
          </article>
        </div>
      </details>
    </section>
  );
}
