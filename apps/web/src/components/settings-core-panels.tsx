import { Link } from "@tanstack/react-router";

import type {
  BootstrapLink,
  MemoryDraft,
  MemoryDraftTarget,
} from "@droidagent/shared";

import { postJson } from "../lib/api";
import { formatHostBytes, formatTokenBudget } from "../lib/formatters";
import type { SettingsCorePanelsProps } from "./settings-panel-types";

function memoryTargetLabel(target: MemoryDraft["target"]): string {
  if (target === "preferences") {
    return "PREFERENCES.md";
  }
  if (target === "todayNote") {
    return "Today note";
  }
  return "MEMORY.md";
}

function memorySourceLabel(draft: MemoryDraft): string {
  if (draft.sourceLabel?.trim()) {
    return draft.sourceLabel.trim();
  }
  if (draft.sourceKind === "chatMessage") {
    return "Chat message";
  }
  if (draft.sourceKind === "fileSelection") {
    return "File selection";
  }
  if (draft.sourceKind === "memoryFlush") {
    return "Memory flush";
  }
  return "Manual";
}

function SettingsOverviewRail({
  overviewCards,
}: Pick<SettingsCorePanelsProps, "overviewCards">) {
  return (
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
  );
}

function HostControlsPanel({
  setup,
  launchAgent,
  runtimeCount,
  hostPressure,
  runAction,
}: Pick<
  SettingsCorePanelsProps,
  "setup" | "launchAgent" | "runtimeCount" | "hostPressure" | "runAction"
>) {
  return (
    <article className="panel-card">
      <div className="panel-heading">
        <h3>Host Controls</h3>
        <p>
          Keep the Mac steady. These controls cover the workspace, the
          LaunchAgent, and the always-on local server path.
        </p>
      </div>
      <div className="status-list">
        <article className={`health-row${setup?.workspaceRoot ? " ready" : ""}`}>
          <div className="health-row-top">
            <strong>Workspace</strong>
            <span className={`status-chip${setup?.workspaceRoot ? " ready" : ""}`}>
              {setup?.workspaceRoot ? "Set" : "Pending"}
            </span>
          </div>
          <small>{setup?.workspaceRoot ?? "Not configured yet."}</small>
        </article>
        <article className={`health-row${launchAgent?.running ? " ready" : ""}`}>
          <div className="health-row-top">
            <strong>LaunchAgent</strong>
            <span className={`status-chip${launchAgent?.running ? " ready" : ""}`}>
              {launchAgent?.running ? "Running" : "Stopped"}
            </span>
          </div>
          <small>{launchAgent?.healthMessage ?? "LaunchAgent health is still loading."}</small>
        </article>
        <article className={`health-row${runtimeCount > 0 ? " ready" : ""}`}>
          <div className="health-row-top">
            <strong>Local Runtime</strong>
            <span className={`status-chip${runtimeCount > 0 ? " ready" : ""}`}>
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
                hostPressure?.level === "critical" ? "" : " ready"
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
            {hostPressure?.message ?? "Host pressure telemetry is still loading."}
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
  );
}

function PhoneAccessPanel({
  tailscaleReady,
  remoteReady,
  tailscaleStatus,
  access,
  bootstrapLink,
  canGeneratePhoneLink,
  setBootstrapLink,
  runAction,
}: Pick<
  SettingsCorePanelsProps,
  | "tailscaleReady"
  | "remoteReady"
  | "tailscaleStatus"
  | "access"
  | "bootstrapLink"
  | "canGeneratePhoneLink"
  | "setBootstrapLink"
  | "runAction"
>) {
  return (
    <article className="panel-card">
      <div className="panel-heading">
        <h3>Tailscale Phone Access</h3>
        <p>
          DroidAgent now uses the private Tailscale path in the main UI. If the
          tailnet is healthy, the phone URL should be a one-tap flow.
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
          <small>{tailscaleStatus?.healthMessage ?? "Checking Tailscale…"}</small>
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
  );
}

function MaintenancePanel({
  maintenance,
  localhostMaintenance,
  runAction,
  handleRunMaintenance,
  handleMaintenanceRecoveryAction,
}: Pick<
  SettingsCorePanelsProps,
  | "maintenance"
  | "localhostMaintenance"
  | "runAction"
  | "handleRunMaintenance"
  | "handleMaintenanceRecoveryAction"
>) {
  return (
    <article className="panel-card">
      <div className="panel-heading">
        <h3>Maintenance</h3>
        <p>
          Drain live work, restart managed services in order, and keep the
          maintenance state visible while DroidAgent recovers.
        </p>
      </div>
      <div className="status-list">
        <article className={`health-row${maintenance?.active ? "" : " ready"}`}>
          <div className="health-row-top">
            <strong>Current operation</strong>
            <span className={`status-chip${maintenance?.active ? "" : " ready"}`}>
              {maintenance?.active ? maintenance.current?.phase ?? "Active" : "Idle"}
            </span>
          </div>
          <small>
            {maintenance?.current?.message ?? "No maintenance workflow is active."}
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
            Remote-scope maintenance is localhost-only because it can sever the
            canonical phone URL.
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
      <details className="message-details">
        <summary>Recovery actions</summary>
        <div className="button-row">
          <button
            className="secondary"
            onClick={() =>
              void runAction(async () => {
                await handleMaintenanceRecoveryAction("retryVerify");
              }, "Verification retry requested.")
            }
          >
            Retry verify
          </button>
          <button
            className="secondary"
            onClick={() =>
              void runAction(async () => {
                await handleMaintenanceRecoveryAction("refreshHarnessHealth");
              }, "Harness health refresh requested.")
            }
          >
            Refresh harness health
          </button>
          <button
            className="secondary"
            onClick={() =>
              void runAction(async () => {
                await handleMaintenanceRecoveryAction("reconnectResync");
              }, "Realtime resync requested.")
            }
          >
            Reconnect/resync
          </button>
          <button
            className="secondary"
            onClick={() =>
              void runAction(async () => {
                await handleMaintenanceRecoveryAction("clearStaleMaintenanceState");
              }, "Stale maintenance state cleared.")
            }
          >
            Clear stale state
          </button>
          <button
            className="secondary"
            onClick={() =>
              void runAction(async () => {
                await handleMaintenanceRecoveryAction("restartRuntime");
              }, "Runtime restart requested.")
            }
          >
            Restart runtime
          </button>
          <button
            className="secondary"
            disabled={!localhostMaintenance}
            onClick={() =>
              void runAction(async () => {
                await handleMaintenanceRecoveryAction("restartAppShell");
              }, "App shell restart requested.")
            }
          >
            Restart app shell
          </button>
        </div>
      </details>
      <small>
        New chat, job, and terminal work is blocked while maintenance is active.
        Existing state recovers through websocket resync after the host is steady
        again.
      </small>
    </article>
  );
}

function PressureCleanupPanel({
  hostPressure,
}: Pick<SettingsCorePanelsProps, "hostPressure">) {
  return (
    <article className="panel-card">
      <div className="panel-heading">
        <h3>Pressure & Cleanup</h3>
        <p>
          Keep the Mac responsive. DroidAgent now samples host pressure and pauses
          new chat runs and jobs if RAM, swap, or CPU pressure turns critical.
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
            Total RAM {formatHostBytes(hostPressure?.memoryTotalBytes)} • compressed{" "}
            {formatHostBytes(hostPressure?.compressedBytes)} • swap{" "}
            {formatHostBytes(hostPressure?.swapUsedBytes)}
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
            Terminal session: {hostPressure?.activeTerminalSession ? "open" : "idle"} •
            load ratio {hostPressure?.loadRatio ?? "unknown"} •
            {hostPressure?.cpuLogicalCores ?? "unknown"} logical cores
          </small>
        </article>
        {hostPressure?.recommendations.map((recommendation) => (
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
        Rescue Terminal remains available even if agent runs are paused, so you
        still have a direct recovery path.
      </small>
    </article>
  );
}

function WorkspaceMemoryPanel({
  memory,
  harness,
  memoryPrepareRowClass,
  memoryPrepareChipClass,
  memoryPrepareChipLabel,
  memoryPrepareActivityLabel,
  memoryPrepareTimingBits,
  memoryPrepareActive,
  memoryPrepareState,
  memoryReady,
  normalizedImageModel,
  normalizedActiveModel,
  handlePrepareMemory,
  runAction,
}: Pick<
  SettingsCorePanelsProps,
  | "memory"
  | "harness"
  | "memoryPrepareRowClass"
  | "memoryPrepareChipClass"
  | "memoryPrepareChipLabel"
  | "memoryPrepareActivityLabel"
  | "memoryPrepareTimingBits"
  | "memoryPrepareActive"
  | "memoryPrepareState"
  | "memoryReady"
  | "normalizedImageModel"
  | "normalizedActiveModel"
  | "handlePrepareMemory"
  | "runAction"
>) {
  return (
    <article className="panel-card">
      <div className="panel-heading">
        <h3>Workspace Memory</h3>
        <p>
          DroidAgent keeps both a durable workspace scaffold and a local semantic
          index so the smaller local model can stay personal and useful.
        </p>
      </div>
      <div className="status-list">
        <article className={`health-row${memoryPrepareRowClass}`}>
          <div className="health-row-top">
            <strong>Semantic memory</strong>
            <span className={`status-chip${memoryPrepareChipClass}`}>
              {memoryPrepareChipLabel}
            </span>
          </div>
          <small>{memoryPrepareActivityLabel}</small>
          {memoryPrepareTimingBits.length > 0 ? (
            <small>{memoryPrepareTimingBits.join(" • ")}</small>
          ) : null}
        </article>
        <article className="health-row ready">
          <div className="health-row-top">
            <strong>Multimodal attachments</strong>
            <span className={`status-chip${harness?.attachmentsEnabled ? " ready" : ""}`}>
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
            . The semantic index pulls that file, workspace skills, and session
            memory in automatically.
          </small>
        </article>
      </div>
      <div className="button-row">
        <button
          className="secondary"
          disabled={memoryPrepareActive}
          onClick={() =>
            void runAction(async () => {
              await handlePrepareMemory();
            }, "Workspace memory refresh queued.")
          }
        >
          {memoryPrepareState === "queued"
            ? "Memory Prepare Queued"
            : memoryPrepareState === "running"
              ? "Preparing Memory..."
              : memoryReady
                ? "Reindex Memory"
                : "Prepare / Reindex Memory"}
        </button>
        <Link className="button-link secondary" to="/files">
          Open Memory Files
        </Link>
      </div>
      <small>
        Session memory: {memory?.sessionMemoryEnabled ? "on" : "off"} • Fallback:{" "}
        {memory?.embeddingFallback ?? "none"} • Context:{" "}
        {formatTokenBudget(memory?.contextWindow)}
      </small>
      {memory?.embeddingProbeError ? (
        <small className="error-copy">{memory.embeddingProbeError}</small>
      ) : null}
      {memory?.prepareError ? (
        <small className="error-copy">{memory.prepareError}</small>
      ) : null}
    </article>
  );
}

function PersonalizationPanel() {
  return (
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
            PREFERENCES.md is part of semantic recall, so response style, workflow
            habits, and tool preferences can stay personal over time.
          </small>
        </article>
        <article className="health-row ready">
          <div className="health-row-top">
            <strong>Durable memory</strong>
            <span className="status-chip ready">Loaded</span>
          </div>
          <small>
            MEMORY.md and the daily memory notes stay on-device and feed the local
            embedding index without falling back to a cloud provider.
          </small>
        </article>
      </div>
      <div className="button-row">
        <Link className="button-link secondary" to="/files">
          Review Memory Files
        </Link>
      </div>
    </article>
  );
}

function DraftEditFields({
  draft,
  edit,
  updateDraftEdit,
  cancelDraftEdit,
  handleUpdateDraft,
  runAction,
}: {
  draft: MemoryDraft;
  edit: {
    target: MemoryDraftTarget;
    title: string;
    content: string;
  };
  updateDraftEdit: SettingsCorePanelsProps["updateDraftEdit"];
  cancelDraftEdit: SettingsCorePanelsProps["cancelDraftEdit"];
  handleUpdateDraft: SettingsCorePanelsProps["handleUpdateDraft"];
  runAction: SettingsCorePanelsProps["runAction"];
}) {
  return (
    <div className="stack-list">
      <select
        value={edit.target}
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
        value={edit.title}
        onChange={(event) =>
          updateDraftEdit(draft.id, {
            title: event.target.value,
          })
        }
        placeholder="Draft title"
      />
      <textarea
        value={edit.content}
        onChange={(event) =>
          updateDraftEdit(draft.id, {
            content: event.target.value,
          })
        }
        rows={8}
      />
      <div className="button-row">
        <button
          disabled={!edit.content.trim()}
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
  );
}

function MemoryReviewQueuePanel({
  pendingMemoryDrafts,
  memoryDraftDecisionById,
  draftEdits,
  beginDraftEdit,
  cancelDraftEdit,
  updateDraftEdit,
  handleApplyDraft,
  handleUpdateDraft,
  handleDismissDraft,
  runAction,
}: Pick<
  SettingsCorePanelsProps,
  | "pendingMemoryDrafts"
  | "memoryDraftDecisionById"
  | "draftEdits"
  | "beginDraftEdit"
  | "cancelDraftEdit"
  | "updateDraftEdit"
  | "handleApplyDraft"
  | "handleUpdateDraft"
  | "handleDismissDraft"
  | "runAction"
>) {
  return (
    <article className="panel-card">
      <div className="panel-heading">
        <h3>Memory Review Queue</h3>
        <p>
          Durable memory stays owner-reviewed. Edit the draft here, then resolve
          the shared decision by applying it to the right file tier or dismissing
          it.
        </p>
      </div>
      <div className="stack-list">
        {pendingMemoryDrafts.length === 0 ? (
          <article className="panel-card compact">
            No pending memory drafts. Capture from Chat or Files when you want to
            retain something durable.
          </article>
        ) : null}
        {pendingMemoryDrafts.map((draft) => {
          const edit = draftEdits[draft.id];
          return (
            <article key={draft.id} className="panel-card compact">
              <strong>{draft.title ?? "Untitled draft"}</strong>
              <small>
                Draft created {new Date(draft.createdAt).toLocaleString()} • target{" "}
                {memoryTargetLabel(draft.target)}
              </small>
              <small>
                Source {memorySourceLabel(draft)} •{" "}
                {draft.sourceRef ? `ref ${draft.sourceRef}` : "no source ref"}
                {draft.sessionId ? ` • session ${draft.sessionId}` : ""}
              </small>
              <small>
                Draft status pending • decision{" "}
                {memoryDraftDecisionById.get(draft.id)?.id ?? "pending"}
              </small>
              {edit ? (
                <DraftEditFields
                  cancelDraftEdit={cancelDraftEdit}
                  draft={draft}
                  edit={edit}
                  handleUpdateDraft={handleUpdateDraft}
                  runAction={runAction}
                  updateDraftEdit={updateDraftEdit}
                />
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
          );
        })}
      </div>
      <small>
        Pending drafts: {pendingMemoryDrafts.length}. Applied drafts append to the
        workspace files and trigger a local semantic-memory reindex.
      </small>
    </article>
  );
}

export function SettingsCorePanels(props: SettingsCorePanelsProps) {
  return (
    <>
      <SettingsOverviewRail overviewCards={props.overviewCards} />

      <section className="settings-grid">
        <HostControlsPanel
          hostPressure={props.hostPressure}
          launchAgent={props.launchAgent}
          runAction={props.runAction}
          runtimeCount={props.runtimeCount}
          setup={props.setup}
        />
        <PhoneAccessPanel
          access={props.access}
          bootstrapLink={props.bootstrapLink}
          canGeneratePhoneLink={props.canGeneratePhoneLink}
          remoteReady={props.remoteReady}
          runAction={props.runAction}
          setBootstrapLink={props.setBootstrapLink}
          tailscaleReady={props.tailscaleReady}
          tailscaleStatus={props.tailscaleStatus}
        />
        <MaintenancePanel
          handleMaintenanceRecoveryAction={props.handleMaintenanceRecoveryAction}
          handleRunMaintenance={props.handleRunMaintenance}
          localhostMaintenance={props.localhostMaintenance}
          maintenance={props.maintenance}
          runAction={props.runAction}
        />
        <PressureCleanupPanel hostPressure={props.hostPressure} />
      </section>

      <section className="settings-grid">
        <WorkspaceMemoryPanel
          handlePrepareMemory={props.handlePrepareMemory}
          harness={props.harness}
          memory={props.memory}
          memoryPrepareActive={props.memoryPrepareActive}
          memoryPrepareActivityLabel={props.memoryPrepareActivityLabel}
          memoryPrepareChipClass={props.memoryPrepareChipClass}
          memoryPrepareChipLabel={props.memoryPrepareChipLabel}
          memoryPrepareRowClass={props.memoryPrepareRowClass}
          memoryPrepareState={props.memoryPrepareState}
          memoryPrepareTimingBits={props.memoryPrepareTimingBits}
          memoryReady={props.memoryReady}
          normalizedActiveModel={props.normalizedActiveModel}
          normalizedImageModel={props.normalizedImageModel}
          runAction={props.runAction}
        />
        <PersonalizationPanel />
        <MemoryReviewQueuePanel
          beginDraftEdit={props.beginDraftEdit}
          cancelDraftEdit={props.cancelDraftEdit}
          draftEdits={props.draftEdits}
          handleApplyDraft={props.handleApplyDraft}
          handleDismissDraft={props.handleDismissDraft}
          handleUpdateDraft={props.handleUpdateDraft}
          memoryDraftDecisionById={props.memoryDraftDecisionById}
          pendingMemoryDrafts={props.pendingMemoryDrafts}
          runAction={props.runAction}
          updateDraftEdit={props.updateDraftEdit}
        />
      </section>
    </>
  );
}
