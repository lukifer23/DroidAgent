import { useState } from "react";
import {
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON as BrowserRegistrationOptions,
} from "@simplewebauthn/browser";
import { useQueryClient } from "@tanstack/react-query";

import type {
  BootstrapLink,
  DashboardState,
  HostPressureStatus,
  MemoryDraft,
  MemoryDraftTarget,
} from "@droidagent/shared";

import {
  useAuthQuery,
  useAccessQuery,
  useDashboardQuery,
  usePasskeysQuery,
  usePerformanceQuery,
} from "../app-data";
import { useClientPerformanceSnapshot, useDroidAgentApp } from "../app-context";
import { ApiError, patchJson, postJson } from "../lib/api";
import { clientPerformance } from "../lib/client-performance";
import { SettingsAdminPanels } from "../components/settings-admin-panels";
import { SettingsCorePanels } from "../components/settings-core-panels";
import { useDecisionActions } from "../hooks/use-decision-actions";
import {
  getMemoryDraftDecisionMap,
  getPendingMemoryDrafts,
} from "../lib/dashboard-selectors";
import {
  formatDurationMs,
  formatTimeLabel,
  formatTokenBudget,
} from "../lib/formatters";

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
    wsStatus,
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
  const decisions = dashboard?.decisions ?? [];
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
  const memoryPrepareState = memory?.prepareState ?? "idle";
  const memoryPrepareActive =
    memoryPrepareState === "queued" || memoryPrepareState === "running";
  const memoryPrepareRowClass =
    memoryPrepareState === "failed"
      ? " critical"
      : memoryPrepareActive
        ? " warn"
        : memoryReady
          ? " ready"
          : "";
  const memoryPrepareChipClass =
    memoryPrepareState === "completed" || memoryReady ? " ready" : "";
  const memoryPrepareChipLabel =
    memoryPrepareState === "queued"
      ? "Queued"
      : memoryPrepareState === "running"
        ? "Indexing"
        : memoryPrepareState === "failed"
          ? "Failed"
          : memoryReady
            ? "Live"
            : "Needs prep";
  const memoryPrepareActivityLabel =
    memory?.prepareProgressLabel ??
    (memoryPrepareState === "completed"
      ? "Semantic memory is ready."
      : memoryPrepareState === "failed"
        ? "The last semantic memory prepare failed."
        : memory?.embeddingModel
          ? `${memory.embeddingProvider ?? "unknown"}/${memory.embeddingModel} • ${memory.indexedFiles} files • ${memory.indexedChunks} chunks`
          : "No local embedding model is configured yet.");
  const memoryPrepareTimingBits = [
    memoryPrepareState === "running" || memoryPrepareState === "queued"
      ? formatTimeLabel(memory?.prepareStartedAt)
        ? `started ${formatTimeLabel(memory?.prepareStartedAt)}`
        : null
      : formatTimeLabel(memory?.prepareFinishedAt)
        ? `finished ${formatTimeLabel(memory?.prepareFinishedAt)}`
        : null,
    typeof memory?.lastPrepareDurationMs === "number"
      ? `last run ${formatDurationMs(memory.lastPrepareDurationMs)}`
      : null,
  ].filter((value): value is string => Boolean(value));
  const normalizedActiveModel =
    harness?.activeModel?.replace(/^ollama\//, "") ?? null;
  const normalizedImageModel =
    harness?.imageModel?.replace(/^ollama\//, "") ?? null;
  const memoryDraftDecisionById = getMemoryDraftDecisionMap(decisions);
  const pendingMemoryDrafts = getPendingMemoryDrafts(dashboard);
  const { resolveDecision } = useDecisionActions(decisions);
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
    if (wsStatus !== "connected") {
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    }
  }

  async function handleApplyDraft(draft: MemoryDraft) {
    const decision = memoryDraftDecisionById.get(draft.id);
    if (!decision) {
      throw new Error("This memory review is no longer pending.");
    }
    await resolveDecision(decision, "approved", draft.updatedAt);
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
    if (wsStatus !== "connected") {
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    }
  }

  async function handleDismissDraft(draft: MemoryDraft) {
    const decision = memoryDraftDecisionById.get(draft.id);
    if (!decision) {
      throw new Error("This memory review is no longer pending.");
    }
    await resolveDecision(decision, "denied", draft.updatedAt);
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
      <SettingsCorePanels
        access={access}
        beginDraftEdit={beginDraftEdit}
        bootstrapLink={bootstrapLink}
        canGeneratePhoneLink={canGeneratePhoneLink}
        cancelDraftEdit={cancelDraftEdit}
        draftEdits={draftEdits}
        handleApplyDraft={handleApplyDraft}
        handleDismissDraft={handleDismissDraft}
        handlePrepareMemory={handlePrepareMemory}
        handleRunMaintenance={handleRunMaintenance}
        handleUpdateDraft={handleUpdateDraft}
        harness={harness}
        hostPressure={hostPressure}
        launchAgent={launchAgent}
        localhostMaintenance={localhostMaintenance}
        maintenance={maintenance}
        memory={memory}
        memoryDraftDecisionById={memoryDraftDecisionById}
        memoryPrepareActive={memoryPrepareActive}
        memoryPrepareActivityLabel={memoryPrepareActivityLabel}
        memoryPrepareChipClass={memoryPrepareChipClass}
        memoryPrepareChipLabel={memoryPrepareChipLabel}
        memoryPrepareRowClass={memoryPrepareRowClass}
        memoryPrepareState={memoryPrepareState}
        memoryPrepareTimingBits={memoryPrepareTimingBits}
        memoryReady={memoryReady}
        normalizedActiveModel={normalizedActiveModel}
        normalizedImageModel={normalizedImageModel}
        overviewCards={overviewCards}
        pendingMemoryDrafts={pendingMemoryDrafts}
        remoteReady={remoteReady}
        runAction={runAction}
        runtimeCount={runtimeCount}
        setBootstrapLink={setBootstrapLink}
        setup={setup}
        tailscaleReady={tailscaleReady}
        tailscaleStatus={tailscaleStatus}
        updateDraftEdit={updateDraftEdit}
      />
      <SettingsAdminPanels
        build={build}
        canInstallApp={canInstallApp}
        clientPerformanceSnapshot={clientPerformanceSnapshot}
        cloudProviders={cloudProviders}
        contextManagement={contextManagement}
        handleAddPasskey={handleAddPasskey}
        installApp={installApp}
        memory={memory}
        passkeys={passkeysQuery.data ?? []}
        performanceSnapshot={performanceQuery.data}
        providerApiKeys={providerApiKeys}
        providerModels={providerModels}
        resolvedTheme={resolvedTheme}
        runAction={runAction}
        setProviderApiKeys={setProviderApiKeys}
        setProviderModels={setProviderModels}
        setThemePreference={setThemePreference}
        themePreference={themePreference}
      />
    </section>
  );
}
