import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON as BrowserRegistrationOptions,
} from "@simplewebauthn/browser";
import { useQueryClient } from "@tanstack/react-query";

import type {
  BootstrapLink,
  CloudProviderSummary,
  DashboardState,
  HostPressureStatus,
  MemoryDraft,
  MemoryDraftApplyResult,
  MemoryDraftDismissResult,
  MemoryDraftTarget,
  PerformanceSnapshot,
} from "@droidagent/shared";

import {
  useAuthQuery,
  useAccessQuery,
  useDashboardQuery,
  usePasskeysQuery,
  usePerformanceQuery,
} from "../app-data";
import { useClientPerformanceSnapshot, useDroidAgentApp } from "../app-context";
import { ApiError, api, patchJson, postJson } from "../lib/api";
import { clientPerformance } from "../lib/client-performance";
import { formatTokenBudget } from "../lib/formatters";

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
  const ageMs = metric.summary.sampleAgeMs;
  const ageLabel =
    typeof ageMs === "number"
      ? ageMs >= 60_000
        ? `${Math.round(ageMs / 60_000)}m old`
        : ageMs >= 1_000
          ? `${Math.round(ageMs / 1_000)}s old`
          : `${Math.round(ageMs)}ms old`
      : "age unknown";
  const outcomeBits = [
    `${metric.summary.count} samples`,
    metric.summary.errorCount > 0 ? `${metric.summary.errorCount} errors` : null,
    metric.summary.warnCount > 0 ? `${metric.summary.warnCount} warns` : null,
  ]
    .filter(Boolean)
    .join(" • ");
  return `${label}: p95 ${p95 ?? 0} ms • last ${last ?? 0} ms • ${outcomeBits} • ${ageLabel}`;
}

function formatHostBytes(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "unknown";
  }
  if (value >= 1024 ** 3) {
    return `${(value / 1024 ** 3).toFixed(1)} GiB`;
  }
  return `${Math.round(value / 1024 ** 2)} MiB`;
}

function hostPressureTone(
  hostPressure: HostPressureStatus | undefined,
): "good" | "warn" | "critical" | "muted" {
  if (!hostPressure) {
    return "muted";
  }
  if (hostPressure.level === "critical") {
    return "critical";
  }
  if (hostPressure.level === "warn" || hostPressure.level === "unknown") {
    return "warn";
  }
  return "good";
}

function upsertDashboardMemoryDraft(
  dashboard: DashboardState,
  nextDraft: MemoryDraft,
): DashboardState {
  const memoryDrafts = dashboard.memoryDrafts.some(
    (draft) => draft.id === nextDraft.id,
  )
    ? dashboard.memoryDrafts.map((draft) =>
        draft.id === nextDraft.id ? nextDraft : draft,
      )
    : [nextDraft, ...dashboard.memoryDrafts];

  memoryDrafts.sort(
    (left, right) =>
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
  );

  return {
    ...dashboard,
    memoryDrafts,
  };
}

export function SettingsScreen() {
  const queryClient = useQueryClient();
  const {
    canInstallApp,
    installApp,
    resolvedTheme,
    runAction,
    setThemePreference,
    themePreference,
  } = useDroidAgentApp();
  const authQuery = useAuthQuery();
  const dashboardQuery = useDashboardQuery(Boolean(authQuery.data?.user));
  const accessQuery = useAccessQuery();
  const passkeysQuery = usePasskeysQuery(Boolean(authQuery.data?.user));
  const performanceQuery = usePerformanceQuery(Boolean(authQuery.data?.user));
  const clientPerformanceSnapshot = useClientPerformanceSnapshot();
  const dashboard = dashboardQuery.data;
  const access = accessQuery.data;
  const setup = dashboard?.setup;
  const launchAgent = dashboard?.launchAgent;
  const maintenance = dashboard?.maintenance;
  const memory = dashboard?.memory;
  const hostPressure = dashboard?.hostPressure;
  const memoryDrafts = dashboard?.memoryDrafts ?? [];
  const harness = dashboard?.harness;
  const build = dashboard?.build;
  const contextManagement = dashboard?.contextManagement;
  const runtimes = dashboard?.runtimes ?? [];
  const cloudProviders = dashboard?.cloudProviders ?? [];
  const tailscaleStatus = access?.tailscaleStatus;
  const [providerApiKeys, setProviderApiKeys] = useState<
    Record<string, string>
  >({});
  const [providerModels, setProviderModels] = useState<Record<string, string>>(
    {},
  );
  const [bootstrapLink, setBootstrapLink] = useState<BootstrapLink | null>(
    null,
  );
  const [draftEdits, setDraftEdits] = useState<
    Record<
      string,
      {
        target: MemoryDraftTarget;
        title: string;
        content: string;
      }
    >
  >({});

  const passkeyCount = passkeysQuery.data?.length ?? 0;
  const runtimeCount = runtimes.filter((runtime) => runtime.state === "running")
    .length;
  const tailscaleReady = Boolean(tailscaleStatus?.authenticated);
  const remoteReady = Boolean(access?.canonicalOrigin?.origin);
  const canGeneratePhoneLink = Boolean(access?.canonicalOrigin);
  const memoryReady = Boolean(memory?.semanticReady);
  const normalizedActiveModel =
    harness?.activeModel?.replace(/^ollama\//, "") ?? null;
  const normalizedImageModel =
    harness?.imageModel?.replace(/^ollama\//, "") ?? null;
  const pendingMemoryDrafts = memoryDrafts.filter(
    (draft) => draft.status === "pending",
  );
  const localhostMaintenance = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    window.location.hostname,
  );

  const overviewCards = [
    {
      key: "host",
      label: "Host",
      value: launchAgent?.running ? "Live" : "Needs attention",
      detail:
        launchAgent?.healthMessage ??
        "LaunchAgent health is still loading.",
      progress: launchAgent?.running ? 100 : 45,
      tone: launchAgent?.running ? "good" : "warn",
    },
    {
      key: "remote",
      label: "Phone Access",
      value: remoteReady ? "Tailscale live" : "Local only",
      detail: remoteReady
        ? (access?.canonicalOrigin?.origin ?? "Remote URL ready")
        : tailscaleStatus?.healthMessage ??
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
      key: "pressure",
      label: "Host Pressure",
      value:
        hostPressure?.level === "critical"
          ? "Critical"
          : hostPressure?.level === "warn"
            ? "Elevated"
            : hostPressure?.level === "unknown"
              ? "Fallback"
              : "Normal",
      detail:
        hostPressure?.message ??
        "Host pressure telemetry is still loading.",
      progress:
        hostPressure?.level === "critical"
          ? 98
          : hostPressure?.level === "warn" || hostPressure?.level === "unknown"
            ? 68
            : 18,
      tone: hostPressureTone(hostPressure),
    },
    {
      key: "runtime",
      label: "Runtime",
      value: runtimeCount > 0 ? `${runtimeCount} live` : "Not running",
      detail: setup?.selectedModel
        ? `${setup.selectedModel} • ${formatTokenBudget(memory?.contextWindow)} context • ${memoryReady ? "semantic memory live" : "semantic memory pending"}`
        : "No default model is selected yet for the common local path.",
      progress: runtimeCount > 0 ? 100 : 26,
      tone: runtimeCount > 0 ? "good" : "warn",
    },
    {
      key: "maintenance",
      label: "Maintenance",
      value: maintenance?.active ? maintenance.current?.phase ?? "Active" : "Idle",
      detail: maintenance?.active
        ? maintenance.current?.message ?? "Maintenance is blocking new work."
        : "No maintenance workflow is active.",
      progress: maintenance?.active ? 60 : 100,
      tone: maintenance?.active ? "warn" : "good",
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

  async function handlePrepareMemory() {
    const metric = clientPerformance.start("client.memory.prepare", {
      embeddingModel: memory?.embeddingModel ?? "pending",
    });

    try {
      await postJson("/api/memory/prepare", {});
      metric.finish({
        outcome: "ok",
      });
    } catch (error) {
      metric.finish({
        outcome: "error",
      });
      throw error;
    }
  }

  async function handleRunMaintenance(
    scope: "app" | "runtime" | "remote",
    action: "restart" | "drain-only",
  ) {
    await postJson("/api/maintenance/run", {
      scope,
      action,
    });
    await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  }

  async function handleApplyDraft(draft: MemoryDraft) {
    try {
      const result = await postJson<MemoryDraftApplyResult>(
        `/api/memory/drafts/${encodeURIComponent(draft.id)}/apply`,
        {
          expectedUpdatedAt: draft.updatedAt,
        },
      );
      queryClient.setQueryData<DashboardState | undefined>(
        ["dashboard"],
        (current) =>
          current ? upsertDashboardMemoryDraft(current, result.draft) : current,
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      }
      throw error;
    }
    await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  }

  async function handleUpdateDraft(draft: MemoryDraft) {
    const edit = draftEdits[draft.id];
    if (!edit) {
      return;
    }
    try {
      const updatedDraft = await patchJson<MemoryDraft>(
        `/api/memory/drafts/${encodeURIComponent(draft.id)}`,
        {
          expectedUpdatedAt: draft.updatedAt,
          target: edit.target,
          title: edit.title.trim() || null,
          content: edit.content.trim(),
        },
      );
      queryClient.setQueryData<DashboardState | undefined>(
        ["dashboard"],
        (current) =>
          current
            ? upsertDashboardMemoryDraft(current, updatedDraft)
            : current,
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      }
      throw error;
    }
    setDraftEdits((current) => {
      const next = { ...current };
      delete next[draft.id];
      return next;
    });
    await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  }

  async function handleDismissDraft(draft: MemoryDraft) {
    try {
      const result = await postJson<MemoryDraftDismissResult>(
        `/api/memory/drafts/${encodeURIComponent(draft.id)}/dismiss`,
        {
          expectedUpdatedAt: draft.updatedAt,
        },
      );
      queryClient.setQueryData<DashboardState | undefined>(
        ["dashboard"],
        (current) =>
          current ? upsertDashboardMemoryDraft(current, result.draft) : current,
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      }
      throw error;
    }
    await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  }

  function beginDraftEdit(draft: MemoryDraft) {
    setDraftEdits((current) => ({
      ...current,
      [draft.id]: {
        target: draft.target,
        title: draft.title ?? "",
        content: draft.content,
      },
    }));
  }

  function cancelDraftEdit(draftId: string) {
    setDraftEdits((current) => {
      const next = { ...current };
      delete next[draftId];
      return next;
    });
  }

  function updateDraftEdit(
    draftId: string,
    patch: Partial<{
      target: MemoryDraftTarget;
      title: string;
      content: string;
    }>,
  ) {
    setDraftEdits((current) => {
      const existing = current[draftId];
      if (!existing) {
        return current;
      }
      return {
        ...current,
        [draftId]: {
          ...existing,
          ...patch,
        },
      };
    });
  }

  return (
    <section className="stack-list">
      {dashboardQuery.isLoading ? (
        <article className="panel-card compact">Loading system settings...</article>
      ) : null}
      {dashboardQuery.isError ? (
        <article className="panel-card compact conflict-card">
          Settings are temporarily unavailable. Check host connectivity and retry.
        </article>
      ) : null}

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
              className={`health-row${setup?.workspaceRoot ? " ready" : ""}`}
            >
              <div className="health-row-top">
                <strong>Workspace</strong>
                <span
                  className={`status-chip${setup?.workspaceRoot ? " ready" : ""}`}
                >
                  {setup?.workspaceRoot ? "Set" : "Pending"}
                </span>
              </div>
              <small>
                {setup?.workspaceRoot ?? "Not configured yet."}
              </small>
            </article>
            <article
              className={`health-row${launchAgent?.running ? " ready" : ""}`}
            >
              <div className="health-row-top">
                <strong>LaunchAgent</strong>
                <span
                  className={`status-chip${launchAgent?.running ? " ready" : ""}`}
                >
                  {launchAgent?.running ? "Running" : "Stopped"}
                </span>
              </div>
              <small>{launchAgent?.healthMessage ?? "LaunchAgent health is still loading."}</small>
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
                {setup?.selectedRuntime
                  ? `Selected runtime: ${setup.selectedRuntime}`
                  : "No runtime selected yet."}
              </small>
            </article>
            <article
              className={`health-row${
                hostPressure?.level === "critical"
                  ? " critical"
                  : hostPressure?.level === "warn" ||
                      hostPressure?.level === "unknown"
                    ? " warn"
                    : " ready"
              }`}
            >
              <div className="health-row-top">
                <strong>Host pressure</strong>
                <span
                  className={`status-chip${
                    hostPressure?.level === "critical"
                      ? ""
                      : " ready"
                  }`}
                >
                  {hostPressure?.level === "critical"
                    ? "Critical"
                    : hostPressure?.level === "warn"
                      ? "Elevated"
                      : hostPressure?.level === "unknown"
                        ? "Fallback"
                        : "Normal"}
                </span>
              </div>
              <small>
                {hostPressure?.message ??
                  "Host pressure telemetry is still loading."}
              </small>
            </article>
          </div>
          <div className="button-row">
            <Link className="button-link secondary" to="/terminal">
              Rescue Terminal
            </Link>
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
          <small>{launchAgent?.plistPath ?? "LaunchAgent path unavailable."}</small>
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
                {tailscaleStatus?.healthMessage ?? "Checking Tailscale…"}
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
              disabled={!tailscaleStatus?.canonicalUrl}
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
                }, "Phone enrollment link generated.")
              }
            >
              Add a Phone
            </button>
          </div>
        </article>

        <article className="panel-card">
          <div className="panel-heading">
            <h3>Maintenance</h3>
            <p>
              Drain live work, restart managed services in order, and keep the
              maintenance state visible while DroidAgent recovers.
            </p>
          </div>
          <div className="status-list">
            <article
              className={`health-row${maintenance?.active ? "" : " ready"}`}
            >
              <div className="health-row-top">
                <strong>Current operation</strong>
                <span className={`status-chip${maintenance?.active ? "" : " ready"}`}>
                  {maintenance?.active
                    ? maintenance.current?.phase ?? "Active"
                    : "Idle"}
                </span>
              </div>
              <small>
                {maintenance?.current?.message ??
                  "No maintenance workflow is active."}
              </small>
            </article>
            <article className="health-row ready">
              <div className="health-row-top">
                <strong>Scope guard</strong>
                <span className="status-chip ready">
                  {localhostMaintenance ? "Localhost" : "Remote session"}
                </span>
              </div>
              <small>
                Remote-scope maintenance is localhost-only because it can sever
                the canonical phone URL.
              </small>
            </article>
          </div>
          <div className="button-row">
            <button
              disabled={Boolean(maintenance?.active)}
              onClick={() =>
                void runAction(async () => {
                  await handleRunMaintenance("app", "restart");
                }, "App maintenance restart requested.")
              }
            >
              Restart App Scope
            </button>
            <button
              className="secondary"
              disabled={Boolean(maintenance?.active)}
              onClick={() =>
                void runAction(async () => {
                  await handleRunMaintenance("runtime", "restart");
                }, "Runtime maintenance restart requested.")
              }
            >
              Restart Runtime Scope
            </button>
            <button
              className="secondary"
              disabled={Boolean(maintenance?.active) || !localhostMaintenance}
              onClick={() =>
                void runAction(async () => {
                  await handleRunMaintenance("remote", "restart");
                }, "Remote maintenance restart requested.")
              }
            >
              Restart Remote Scope
            </button>
            <button
              className="secondary"
              disabled={Boolean(maintenance?.active)}
              onClick={() =>
                void runAction(async () => {
                  await handleRunMaintenance("app", "drain-only");
                }, "Drain-only maintenance requested.")
              }
            >
              Drain Only
            </button>
          </div>
          <small>
            New chat, job, and terminal work is blocked while maintenance is
            active. Existing state recovers through websocket resync after the
            host is steady again.
          </small>
        </article>

        <article className="panel-card">
          <div className="panel-heading">
            <h3>Pressure & Cleanup</h3>
            <p>
              Keep the Mac responsive. DroidAgent now samples host pressure and
              pauses new chat runs and jobs if RAM, swap, or CPU pressure turns
              critical.
            </p>
          </div>
          <div className="status-list">
            <article
              className={`health-row${
                hostPressure?.level === "critical"
                  ? " critical"
                  : hostPressure?.level === "warn" ||
                      hostPressure?.level === "unknown"
                    ? " warn"
                    : " ready"
              }`}
            >
              <div className="health-row-top">
                <strong>Current pressure</strong>
                <span
                  className={`status-chip${
                    hostPressure?.level === "critical" ? "" : " ready"
                  }`}
                >
                  {hostPressure?.level ?? "unknown"}
                </span>
              </div>
              <small>{hostPressure?.message ?? "No sample yet."}</small>
            </article>
            <article className="health-row ready">
              <div className="health-row-top">
                <strong>Reclaimable memory</strong>
                <span className="status-chip ready">
                  {formatHostBytes(hostPressure?.memoryAvailableBytes)}
                </span>
              </div>
              <small>
                Total RAM {formatHostBytes(hostPressure?.memoryTotalBytes)} •
                compressed {formatHostBytes(hostPressure?.compressedBytes)} •
                swap {formatHostBytes(hostPressure?.swapUsedBytes)}
              </small>
            </article>
            <article className="health-row ready">
              <div className="health-row-top">
                <strong>Live work</strong>
                <span className="status-chip ready">
                  {hostPressure?.activeJobs ?? 0} job
                  {(hostPressure?.activeJobs ?? 0) === 1 ? "" : "s"}
                </span>
              </div>
              <small>
                Terminal session:{" "}
                {hostPressure?.activeTerminalSession ? "open" : "idle"} •
                load ratio {hostPressure?.loadRatio ?? "unknown"} •
                {hostPressure?.cpuLogicalCores ?? "unknown"} logical cores
              </small>
            </article>
            {hostPressure?.recommendations.map((recommendation: string) => (
              <article key={recommendation} className="health-row ready">
                <div className="health-row-top">
                  <strong>Operator guidance</strong>
                  <span className="status-chip ready">Action</span>
                </div>
                <small>{recommendation}</small>
              </article>
            ))}
          </div>
          <small>
            Rescue Terminal remains available even if agent runs are paused, so
            you still have a direct recovery path.
          </small>
        </article>
      </section>

      <section className="settings-grid">
        <article className="panel-card">
          <div className="panel-heading">
            <h3>Workspace Memory</h3>
            <p>
              DroidAgent keeps both a durable workspace scaffold and a local
              semantic index so the smaller local model can stay personal and
              useful.
            </p>
          </div>
          <div className="status-list">
            <article className={`health-row${memoryReady ? " ready" : ""}`}>
              <div className="health-row-top">
                <strong>Semantic memory</strong>
                <span className={`status-chip${memoryReady ? " ready" : ""}`}>
                  {memoryReady ? "Live" : "Needs prep"}
                </span>
              </div>
              <small>
                {memory?.embeddingModel
                  ? `${memory.embeddingProvider ?? "unknown"}/${memory.embeddingModel} • ${memory.indexedFiles} files • ${memory.indexedChunks} chunks`
                  : "No local embedding model is configured yet."}
              </small>
            </article>
            <article className="health-row ready">
              <div className="health-row-top">
                <strong>Multimodal attachments</strong>
                <span
                  className={`status-chip${harness?.attachmentsEnabled ? " ready" : ""}`}
                >
                  {harness?.attachmentsEnabled ? "Live" : "Pending"}
                </span>
              </div>
              <small>
                {harness?.imageModel
                  ? normalizedImageModel && normalizedActiveModel
                    ? normalizedImageModel === normalizedActiveModel
                      ? `${normalizedActiveModel} handles text, image, and PDF analysis directly.`
                      : `${normalizedImageModel} powers image and PDF analysis separately from ${normalizedActiveModel}.`
                    : `${harness.imageModel} powers image and PDF analysis for the chat composer.`
                  : "No local multimodal model is configured yet."}
              </small>
            </article>
            <article className="health-row ready">
              <div className="health-row-top">
                <strong>Workspace scaffold</strong>
                <span className="status-chip ready">Prepared</span>
              </div>
              <small>
                {memory?.effectiveWorkspaceRoot
                  ? `${memory.bootstrapFilesReady}/${memory.bootstrapFilesTotal} bootstrap files are in place under ${memory.effectiveWorkspaceRoot}.`
                  : "No workspace root is configured yet."}
              </small>
            </article>
            <article className="health-row ready">
              <div className="health-row-top">
                <strong>Personal profile</strong>
                <span className="status-chip ready">Editable</span>
              </div>
              <small>
                Keep stable operator preferences in{" "}
                {memory?.effectiveWorkspaceRoot
                  ? `${memory.effectiveWorkspaceRoot}/PREFERENCES.md`
                  : "PREFERENCES.md"}
                . The semantic index pulls that file, workspace skills, and
                session memory in automatically.
              </small>
            </article>
          </div>
          <div className="button-row">
            <button
              className="secondary"
              onClick={() =>
                void runAction(async () => {
                  await handlePrepareMemory();
                }, "Workspace memory prepared.")
              }
            >
              Prepare / Reindex Memory
            </button>
            <Link className="button-link secondary" to="/files">
              Open Memory Files
            </Link>
          </div>
          <small>
            Session memory: {memory?.sessionMemoryEnabled ? "on" : "off"} • Fallback: {memory?.embeddingFallback ?? "none"} • Context: {formatTokenBudget(memory?.contextWindow)}
          </small>
          {memory?.embeddingProbeError ? (
            <small className="error-copy">
              {memory.embeddingProbeError}
            </small>
          ) : null}
        </article>

        <article className="panel-card">
          <div className="panel-heading">
            <h3>Personalization</h3>
            <p>
              Smaller local models become more useful when DroidAgent keeps the
              long-lived operator context explicit, local, and searchable.
            </p>
          </div>
          <div className="status-list">
            <article className="health-row ready">
              <div className="health-row-top">
                <strong>Preferences</strong>
                <span className="status-chip ready">Loaded</span>
              </div>
              <small>
                PREFERENCES.md is part of semantic recall, so response style,
                workflow habits, and tool preferences can stay personal over
                time.
              </small>
            </article>
            <article className="health-row ready">
              <div className="health-row-top">
                <strong>Durable memory</strong>
                <span className="status-chip ready">Loaded</span>
              </div>
              <small>
                MEMORY.md and the daily memory notes stay on-device and feed the
                local embedding index without falling back to a cloud provider.
              </small>
            </article>
          </div>
          <div className="button-row">
            <Link className="button-link secondary" to="/files">
              Review Memory Files
            </Link>
          </div>
        </article>

        <article className="panel-card">
          <div className="panel-heading">
            <h3>Memory Draft Queue</h3>
            <p>
              Durable memory stays approval-gated. Review pending drafts here,
              then apply them to the right file tier or dismiss them.
            </p>
          </div>
          <div className="stack-list">
            {pendingMemoryDrafts.length === 0 ? (
              <article className="panel-card compact">
                No pending memory drafts. Capture from Chat or Files when you
                want to retain something durable.
              </article>
            ) : null}
            {pendingMemoryDrafts.map((draft) => (
              <article key={draft.id} className="panel-card compact">
                <strong>{draft.title ?? "Untitled draft"}</strong>
                <small>
                  {draft.target} • {draft.sourceLabel ?? draft.sourceKind} •{" "}
                  {new Date(draft.updatedAt).toLocaleString()}
                </small>
                {draftEdits[draft.id] ? (
                  <div className="stack-list">
                    <select
                      value={draftEdits[draft.id]!.target}
                      onChange={(event) =>
                        updateDraftEdit(draft.id, {
                          target: event.target.value as MemoryDraftTarget,
                        })
                      }
                    >
                      <option value="memory">MEMORY.md</option>
                      <option value="preferences">PREFERENCES.md</option>
                      <option value="todayNote">Today note</option>
                    </select>
                    <input
                      value={draftEdits[draft.id]!.title}
                      onChange={(event) =>
                        updateDraftEdit(draft.id, {
                          title: event.target.value,
                        })
                      }
                      placeholder="Draft title"
                    />
                    <textarea
                      value={draftEdits[draft.id]!.content}
                      onChange={(event) =>
                        updateDraftEdit(draft.id, {
                          content: event.target.value,
                        })
                      }
                      rows={8}
                    />
                    <div className="button-row">
                      <button
                        disabled={!draftEdits[draft.id]!.content.trim()}
                        onClick={() =>
                          void runAction(async () => {
                            await handleUpdateDraft(draft);
                          }, "Memory draft updated.")
                        }
                      >
                        Save Draft
                      </button>
                      <button
                        className="secondary"
                        onClick={() => cancelDraftEdit(draft.id)}
                      >
                        Cancel Edit
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <small>{draft.content}</small>
                    <div className="button-row">
                      <button
                        onClick={() =>
                          void runAction(async () => {
                            await handleApplyDraft(draft);
                          }, "Memory draft applied.")
                        }
                      >
                        Apply
                      </button>
                      <button
                        className="secondary"
                        onClick={() => beginDraftEdit(draft)}
                      >
                        Edit
                      </button>
                      <button
                        className="secondary"
                        onClick={() =>
                          void runAction(async () => {
                            await handleDismissDraft(draft);
                          }, "Memory draft dismissed.")
                        }
                      >
                        Dismiss
                      </button>
                    </div>
                  </>
                )}
              </article>
            ))}
          </div>
          <small>
            Pending drafts: {pendingMemoryDrafts.length}. Applied drafts append
            to the workspace files and trigger a local semantic-memory reindex.
          </small>
        </article>

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
            Current theme: {resolvedTheme}. Chat is optimized for a compact
            dedicated viewport with a sticky composer and responsive message
            width.
          </small>
        </article>

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
              Install the PWA when you want the cleaner full-screen phone shell.
              The core operator path stays in Setup, Chat, Files, Jobs, Models,
              and Settings.
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
          </div>
          <small>
            Signal remains optional and secondary. The default experience is the
            web shell plus the Tailscale phone URL.
          </small>
        </article>

        <article className="panel-card">
          <div className="panel-heading">
            <h3>Build Identity</h3>
            <p>
              One version string for the Mac, the phone shell, the docs, and
              the repo. Use this when you compare screenshots, logs, or bug
              reports.
            </p>
          </div>
          <div className="status-list">
            <article className="health-row ready">
              <div className="health-row-top">
                <strong>Version</strong>
                <span className="status-chip ready">
                  v{build?.version ?? "unknown"}
                </span>
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
              <small>
                {build?.packageManager ??
                  "Package manager metadata unavailable."}
              </small>
            </article>
          </div>
        </article>
      </section>

      <article className="panel-card">
        <h3>Cloud Providers</h3>
        <p>
          API keys are stored in the macOS login keychain. Only provider
          metadata stays inside DroidAgent. These are optional advanced paths;
          the guided local-first flow stays on Ollama plus Tailscale.
        </p>
        <div className="stack-list">
          {cloudProviders.map(
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
          Compaction: {contextManagement?.compactionMode ?? "unknown"}
          {" • "}
          Pruning: {contextManagement?.pruningMode ?? "unknown"}
          {" • "}
          Memory flush:{" "}
          {contextManagement?.memoryFlushEnabled ? "on" : "off"}
          {" • "}
          Session memory: {memory?.sessionMemoryEnabled ? "on" : "off"}
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
                "client.memory.prepare",
                "Memory prepare",
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
                "host.pressure.sample",
                "Host pressure sample",
              )}
            </small>
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
                "chat.send.submitToAccepted",
                "Submit to accepted",
              )}
            </small>
            <small>
              {metricDescription(
                performanceQuery.data,
                "chat.stream.acceptedToFirstDelta",
                "Accepted to first delta",
              )}
            </small>
            <small>
              {metricDescription(
                performanceQuery.data,
                "chat.stream.firstDeltaForward",
                "First delta forward",
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
            <small>
              {metricDescription(
                performanceQuery.data,
                "memory.prepare",
                "Memory prepare",
              )}
            </small>
            <small>
              {metricDescription(
                performanceQuery.data,
                "memory.reindex",
                "Memory reindex",
              )}
            </small>
            <small>
              {metricDescription(
                performanceQuery.data,
                "memory.draft.apply",
                "Memory draft apply",
              )}
            </small>
            <small>
              {metricDescription(
                performanceQuery.data,
                "memory.todayNote",
                "Today note",
              )}
            </small>
          </article>
        </div>
      </article>
    </section>
  );
}
