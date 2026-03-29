import { useEffect, useMemo, useRef, useState } from "react";
import type { BootstrapLink, QuickstartResult } from "@droidagent/shared";
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

interface SetupStep {
  label: string;
  value: string;
  detail: string;
  ready: boolean;
}

export function SetupScreen() {
  const queryClient = useQueryClient();
  const autoPrepareTriggeredRef = useRef(false);
  const bootstrapIssuedRef = useRef(false);
  const { runAction, setErrorMessage, setNotice } = useDroidAgentApp();
  const dashboardQuery = useDashboardQuery(true);
  const diagnosticsQuery = useStartupDiagnosticsQuery(true);
  const accessQuery = useAccessQuery();
  const dashboard = dashboardQuery.data;
  const access = accessQuery.data;

  const [workspaceInput, setWorkspaceInput] = useState(".");
  const [setupModel, setSetupModel] = useState(DEFAULT_OLLAMA_MODEL);
  const [activeAction, setActiveAction] = useState<
    "idle" | "quickstart"
  >("idle");
  const [quickstartResult, setQuickstartResult] =
    useState<QuickstartResult | null>(null);
  const [bootstrapLink, setBootstrapLink] = useState<BootstrapLink | null>(
    null,
  );
  const [phoneQr, setPhoneQr] = useState<string | null>(null);

  useEffect(() => {
    if (dashboard?.setup.workspaceRoot) {
      setWorkspaceInput(dashboard.setup.workspaceRoot);
    }
  }, [dashboard?.setup.workspaceRoot]);

  useEffect(() => {
    const provider = dashboard?.providers.find(
      (entry) => entry.id === "ollama-default",
    );
    setSetupModel(
      provider?.model ?? dashboard?.setup.selectedModel ?? DEFAULT_OLLAMA_MODEL,
    );
  }, [dashboard?.providers, dashboard?.setup.selectedModel]);

  const passkeyReady = Boolean(dashboard?.setup.passkeyConfigured);
  const workspaceReady = Boolean(dashboard?.setup.workspaceRoot);
  const runtimeReady =
    dashboard?.runtimes.find((runtime) => runtime.id === "ollama")?.state ===
      "running" &&
    dashboard?.runtimes.find((runtime) => runtime.id === "openclaw")?.state ===
      "running";
  const memoryReady = Boolean(dashboard?.memory.semanticReady);
  const tailscaleReady = Boolean(access?.tailscaleStatus.authenticated);
  const remoteReady = Boolean(access?.canonicalOrigin?.origin);
  const localhostMaintenance = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    window.location.hostname,
  );

  const steps = useMemo<SetupStep[]>(
    () => [
      {
        label: "Owner access",
        value: passkeyReady ? "Ready" : "Required",
        detail: passkeyReady
          ? "Owner passkey is enrolled."
          : "Create or add the owner passkey first.",
        ready: passkeyReady,
      },
      {
        label: "This Mac",
        value: workspaceReady && runtimeReady && memoryReady ? "Prepared" : "Needs prep",
        detail:
          workspaceReady && runtimeReady && memoryReady
            ? "Workspace, local runtime, OpenClaw, and semantic memory are ready."
            : "DroidAgent can prepare the normal local path in one pass.",
        ready: workspaceReady && runtimeReady && memoryReady,
      },
      {
        label: "Tailnet",
        value: tailscaleReady ? "Connected" : "Not signed in",
        detail: tailscaleReady
          ? "This Mac is authenticated to Tailscale."
          : access?.tailscaleStatus.healthMessage ??
            "Sign in to Tailscale on this Mac.",
        ready: tailscaleReady,
      },
      {
        label: "Phone access",
        value: remoteReady ? "Live" : "Waiting",
        detail:
          access?.canonicalOrigin?.origin ??
          "Publish the private phone URL after the Mac is prepared.",
        ready: remoteReady,
      },
    ],
    [
      access?.canonicalOrigin?.origin,
      access?.tailscaleStatus.healthMessage,
      memoryReady,
      passkeyReady,
      remoteReady,
      runtimeReady,
      tailscaleReady,
      workspaceReady,
    ],
  );

  const readyCount = steps.filter((step) => step.ready).length;
  const phoneLaunchUrl = bootstrapLink?.bootstrapUrl ?? access?.canonicalOrigin?.origin ?? null;
  const canIssueEnrollmentLink =
    localhostMaintenance && passkeyReady && remoteReady;

  useEffect(() => {
    if (!phoneLaunchUrl) {
      setPhoneQr(null);
      return;
    }

    void QRCode.toDataURL(phoneLaunchUrl, {
      margin: 1,
      width: 240,
    }).then(setPhoneQr);
  }, [phoneLaunchUrl]);

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
      if (!result.remoteReady) {
        setBootstrapLink(null);
        bootstrapIssuedRef.current = false;
      }
      await refreshSetupQueries();
      setNotice(
        result.remoteReady
          ? "DroidAgent is ready."
          : result.remotePendingReason ?? "This Mac is ready.",
      );
    } finally {
      setActiveAction("idle");
    }
  }

  useEffect(() => {
    if (!dashboard || !access || autoPrepareTriggeredRef.current) {
      return;
    }

    if ((workspaceReady && runtimeReady && memoryReady) && (!tailscaleReady || remoteReady)) {
      return;
    }

    autoPrepareTriggeredRef.current = true;
    void runAction(async () => {
      await executeQuickstart();
    });
  }, [
    access,
    dashboard,
    memoryReady,
    remoteReady,
    runAction,
    runtimeReady,
    tailscaleReady,
    workspaceReady,
  ]);

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

  async function copyValue(value: string, successMessage: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(successMessage);
    } catch {
      setErrorMessage("Clipboard access failed. Copy the value manually.");
    }
  }

  return (
    <section className="setup-wizard">
      <article className="panel-card setup-wizard-hero">
        <div className="setup-wizard-copy">
          <div className="eyebrow">Quickstart</div>
          <h2>Get this Mac and your phone ready.</h2>
          <p>
            One pass should handle the normal path: workspace, Ollama, OpenClaw,
            65k local context, semantic memory, then the private Tailscale URL.
          </p>
        </div>

        <div className="setup-wizard-actions">
          <strong>
            {readyCount}/{steps.length} setup steps ready
          </strong>
          <div className="button-row compact-actions">
            <button
              type="button"
              disabled={activeAction !== "idle"}
              onClick={() =>
                void runAction(async () => {
                  await executeQuickstart();
                })
              }
            >
              {activeAction === "quickstart"
                ? "Preparing DroidAgent..."
                : remoteReady
                  ? "Refresh status"
                  : "Prepare host"}
            </button>
            {workspaceReady && runtimeReady ? (
              <Link className="button-link secondary" to="/chat">
                Open chat
              </Link>
            ) : null}
          </div>
        </div>
      </article>

      <section className="setup-step-list">
        {steps.map((step) => (
          <article
            key={step.label}
            className={`setup-step-card ${step.ready ? "ready" : ""}`}
          >
            <div>
              <strong>{step.label}</strong>
              <span>{step.value}</span>
            </div>
            <p>{step.detail}</p>
          </article>
        ))}
      </section>

      <section className="setup-wizard-grid">
        <article className="panel-card compact setup-phone-card">
          <div className="panel-heading">
            <h3>Phone access</h3>
            <p>
              Use a one-time enrollment link for a new device, then use the
              normal Tailscale URL for daily sign-in.
            </p>
          </div>

          {phoneLaunchUrl ? (
            <div className="setup-phone-shell">
              <div className="link-preview-card">
                <strong>
                  {bootstrapLink ? "Device enrollment link" : "Daily phone URL"}
                </strong>
                <input value={phoneLaunchUrl} readOnly />
                <div className="button-row compact-actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void copyValue(phoneLaunchUrl, "Phone link copied.")}
                  >
                    Copy link
                  </button>
                  {bootstrapLink ? (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        void runAction(async () => {
                          const link = await postJson<BootstrapLink>(
                            "/api/access/bootstrap",
                            {},
                          );
                          setBootstrapLink(link);
                        })
                      }
                    >
                      Refresh enrollment link
                    </button>
                  ) : null}
                </div>
              </div>
              {phoneQr ? (
                <img
                  alt="Phone enrollment QR code"
                  className="setup-qr"
                  src={phoneQr}
                />
              ) : null}
            </div>
          ) : (
            <div className="journey-check">
              <strong>Waiting for phone URL</strong>
              <span>
                Finish Tailscale sign-in on this Mac and run the host prep once.
              </span>
            </div>
          )}
        </article>

        <article className="panel-card compact">
          <div className="panel-heading">
            <h3>What DroidAgent handled</h3>
            <p>
              The quickstart should stay automatic. Advanced inputs remain here,
              but they are not the primary path.
            </p>
          </div>

          {quickstartResult ? (
            <div className="journey-checklist">
              {quickstartResult.actions.map((action) => (
                <div key={action} className="journey-check ready">
                  <span>{action}</span>
                </div>
              ))}
            </div>
          ) : null}

          <div className="field-stack">
            <label>
              Workspace root
              <input
                value={workspaceInput}
                onChange={(event) => setWorkspaceInput(event.target.value)}
              />
            </label>
            <label>
              Default model
              <input
                value={setupModel}
                onChange={(event) => setSetupModel(event.target.value)}
              />
            </label>
          </div>

          {diagnosticsQuery.data?.length ? (
            <div className="journey-checklist">
              {diagnosticsQuery.data
                .filter((diagnostic) => diagnostic.health !== "ok")
                .map((diagnostic) => (
                  <div key={diagnostic.id} className="journey-check">
                    <strong>{diagnostic.id}</strong>
                    <span>{diagnostic.message}</span>
                  </div>
                ))}
            </div>
          ) : null}
        </article>
      </section>
    </section>
  );
}
