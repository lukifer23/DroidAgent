import type {
  ChangeEventHandler,
  ClipboardEventHandler,
  FormEventHandler,
  RefObject,
} from "react";
import { type NavigateFn } from "@tanstack/react-router";

import type {
  ApprovalRecord,
  ChatAttachment,
  ChatMessage,
  DecisionRecord,
  HostPressureContributor,
  HostPressureStatus,
  SessionSummary,
} from "@droidagent/shared";

import type { ChatSessionFeedback } from "../app-context";
import {
  ApprovalCard,
  CopyButton,
  type ExpandedImageState,
  formatHostRatio,
  formatMessageTime,
  MessageMemoryActions,
  MessagePartView,
  PendingAttachmentList,
  PressureContributorBadge,
  shouldShowCopyButton,
  StreamingMarkdown,
} from "./chat-message-parts";
import {
  type RunBreakdown,
  PendingAssistantCard,
  RecentRunSummaryCard,
  RunActivityTrail,
} from "./chat-run-panels";
import type { ChatRunViewState } from "../lib/chat-run-store";
import { formatHostBytes, roleLabel } from "../lib/formatters";

interface MetricChip {
  label: string;
  value: string;
}

export type ChatActionRunner = (
  work: () => Promise<void>,
  successMessage?: string,
) => Promise<void>;

export interface ChatScreenShellProps {
  threadRef: RefObject<HTMLDivElement | null>;
  activeSession: SessionSummary | null;
  headerFacts: string[];
  agentReady: boolean;
  maintenanceActive: boolean;
  pressureBlocks: boolean;
  harnessReady: boolean;
  transportReady: boolean;
  memoryIndexed: boolean;
  pendingDecisionCount: number;
  availableToolsCount: number;
  visibleLiveMetrics: MetricChip[];
  showHeaderHostPressureMetric: boolean;
  hostPressureLevel: string;
  messages: ChatMessage[];
  showStreamingCard: boolean;
  showTranscriptAlerts: boolean;
  maintenanceMessage: string | null | undefined;
  maintenancePhase: string | null | undefined;
  historyLoading: boolean;
  historyError: boolean;
  historyFetching: boolean;
  activeRun: ChatRunViewState | null;
  liveChatFeedback: ChatSessionFeedback | null;
  terminalChatFeedback: ChatSessionFeedback | null;
  approvals: ApprovalRecord[];
  approvalsById: Map<string, ApprovalRecord>;
  activeRunApproval: ApprovalRecord | null;
  currentRunBreakdown: RunBreakdown;
  showPendingAssistantCard: boolean;
  sessionDecisions: DecisionRecord[];
  runAction: ChatActionRunner;
  resolveDecision: (
    decision: DecisionRecord,
    resolution: "approved" | "denied",
    expectedUpdatedAt?: string,
  ) => Promise<void>;
  navigate: NavigateFn;
  expandedMemoryMessageId: string | null;
  onToggleMessageMemory: (messageId: string | null) => void;
  onCreateMemoryDraft: (
    target: "memory" | "preferences" | "todayNote",
    message: ChatMessage,
  ) => Promise<void>;
  onRunCommandFromMessage: (command: string) => void;
  onOpenInTerminal: (command: string) => void;
  onOpenImage: (image: ExpandedImageState) => void;
  onResolveApprovalAction: (
    approvalId: string,
    resolution: "approved" | "denied",
  ) => void;
  streamingText: string;
  showRecentRunSummaryCard: boolean;
  showSessionSwitcher: boolean;
  sessionOptions: SessionSummary[];
  selectedSessionKey: string;
  sessionSecondaryStatus: string;
  onSelectSession: (sessionId: string) => Promise<void>;
  onStartFreshSession: () => Promise<void>;
  onCloseCurrentSession: () => Promise<void>;
  archivedSessions: SessionSummary[];
  onRestoreSession: (sessionId: string) => Promise<void>;
  hostPressure: HostPressureStatus | undefined;
  visiblePressureContributors: HostPressureContributor[];
  onAbortRun: () => Promise<void>;
  onRecoverHostPressure: (params?: {
    abortSessionRun?: boolean;
    cancelActiveJobs?: boolean;
    closeTerminalSession?: boolean;
  }) => Promise<unknown>;
  showRailRunCard: boolean;
  pendingAttachments: ChatAttachment[];
  onRemovePendingAttachment: (attachmentId: string) => void;
  chatInput: string;
  onChatInputChange: ChangeEventHandler<HTMLTextAreaElement>;
  onComposerPaste: ClipboardEventHandler<HTMLTextAreaElement>;
  uploadingAttachments: boolean;
  composerStatusMessage: string;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onAttachFilesChange: ChangeEventHandler<HTMLInputElement>;
  onAttachClick: () => void;
  composerStateLabel: string;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onStopActiveRun: () => void;
  sendDisabled: boolean;
  sendTitle?: string | undefined;
  expandedImage: ExpandedImageState | null;
  onCloseExpandedImage: () => void;
}

function TranscriptWindow(props: ChatScreenShellProps) {
  const {
    activeSession,
    activeRun,
    activeRunApproval,
    approvals,
    approvalsById,
    currentRunBreakdown,
    expandedMemoryMessageId,
    historyError,
    historyLoading,
    historyFetching,
    liveChatFeedback,
    maintenanceActive,
    maintenanceMessage,
    maintenancePhase,
    messages,
    navigate,
    onCreateMemoryDraft,
    onOpenImage,
    onOpenInTerminal,
    onResolveApprovalAction,
    onRunCommandFromMessage,
    onToggleMessageMemory,
    pressureBlocks,
    runAction,
    sessionDecisions,
    showPendingAssistantCard,
    showRecentRunSummaryCard,
    showStreamingCard,
    showTranscriptAlerts,
    streamingText,
    terminalChatFeedback,
    resolveDecision,
  } = props;

  return (
    <article className="operator-thread-window panel-card compact">
      <div className="operator-window-head">
        <div className="operator-window-copy">
          <div className="journey-kicker">Transcript</div>
          <h3>Transcript</h3>
        </div>
        <small>
          {activeSession?.title ?? "Operator Chat"} • {messages.length}
          {showStreamingCard ? "+" : ""} message{messages.length === 1 ? "" : "s"}
        </small>
      </div>

      <div className="operator-window-surface operator-thread-surface">
        {showTranscriptAlerts ? (
          <div className="operator-transcript-alerts">
            {maintenanceActive ? (
              <div className="operator-run-strip failed">
                <strong>{maintenanceMessage ?? "Maintenance in progress"}</strong>
                <span>
                  {maintenancePhase
                    ? `New work is blocked while the host is ${maintenancePhase}.`
                    : "New work is blocked until maintenance completes."}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        <div
          ref={props.threadRef}
          className="chat-message-list operator-thread"
        >
          {historyLoading ? (
            <article className="panel-card compact">
              Loading session history...
            </article>
          ) : null}
          {historyError ? (
            <article className="panel-card compact conflict-card">
              Failed to load session history. Reconnect and try again.
            </article>
          ) : null}
          {!historyLoading &&
          !historyError &&
          messages.length === 0 &&
          !showStreamingCard &&
          !activeRun?.active &&
          !liveChatFeedback &&
          !terminalChatFeedback ? (
            <article className="panel-card compact">
              This chat is empty. Start with a prompt, attach files, or restore an
              archived chat from the rail.
            </article>
          ) : null}
          {messages.map((message) => (
            <article key={message.id} className={`message-card ${message.role}`}>
              <div className="message-meta">
                <div className="message-meta-copy">
                  <header>{roleLabel(message.role)}</header>
                  <span>{formatMessageTime(message.createdAt)}</span>
                </div>
                {shouldShowCopyButton(message) ? (
                  <CopyButton text={message.text} />
                ) : null}
              </div>

              <div className="message-part-stack">
                {((message.parts ?? []).length > 0
                  ? message.parts ?? []
                  : [
                      {
                        type: "markdown",
                        text: message.text,
                      } as const,
                    ]
                ).map((part, index) => {
                  const approval =
                    part.type === "approval_request"
                      ? ((part.approvalId
                          ? approvalsById.get(part.approvalId) ?? null
                          : null) ?? (approvals.length === 1 ? approvals[0]! : null))
                      : null;

                  return (
                    <MessagePartView
                      key={`${message.id}-${part.type}-${index}`}
                      approval={approval}
                      commandActionDisabledReason={
                        pressureBlocks
                          ? props.hostPressure?.message ??
                            "Host pressure is critical. New agent runs are paused."
                          : null
                      }
                      commandActionsEnabled={!pressureBlocks}
                      onOpenImage={onOpenImage}
                      onOpenInTerminal={onOpenInTerminal}
                      onResolveApproval={onResolveApprovalAction}
                      onRunCommand={onRunCommandFromMessage}
                      part={part}
                    />
                  );
                })}
              </div>

              {message.text.trim() ? (
                <MessageMemoryActions
                  expanded={expandedMemoryMessageId === message.id}
                  onAddMemory={() =>
                    void runAction(async () => {
                      onToggleMessageMemory(null);
                      await onCreateMemoryDraft("memory", message);
                    }, "Draft added to durable memory.")
                  }
                  onAddPreferences={() =>
                    void runAction(async () => {
                      onToggleMessageMemory(null);
                      await onCreateMemoryDraft("preferences", message);
                    }, "Draft added to preferences.")
                  }
                  onAddTodayNote={() =>
                    void runAction(async () => {
                      onToggleMessageMemory(null);
                      await onCreateMemoryDraft("todayNote", message);
                    }, "Draft added to today's note.")
                  }
                  onToggle={() =>
                    onToggleMessageMemory(
                      expandedMemoryMessageId === message.id ? null : message.id,
                    )
                  }
                />
              ) : null}
            </article>
          ))}

          {showPendingAssistantCard ? (
            <PendingAssistantCard
              activeRun={activeRun ?? null}
              approval={activeRunApproval}
              breakdown={currentRunBreakdown}
              chatFeedback={liveChatFeedback}
              onResolveApproval={onResolveApprovalAction}
            />
          ) : null}

          {sessionDecisions.length > 0 ? (
            <article className="panel-card compact decision-stack-card">
              <strong>Session decisions</strong>
              <small>
                Pending owner actions tied to this conversation or live OpenClaw
                run.
              </small>
              <div className="stack-list">
                {sessionDecisions.map((decision) => (
                  <article key={decision.id} className="panel-card compact">
                    <strong>{decision.title}</strong>
                    <small>{decision.summary}</small>
                    <div className="button-row">
                      <button
                        onClick={() =>
                          void runAction(async () => {
                            await resolveDecision(decision, "approved");
                          }, decision.kind === "memoryDraftReview"
                            ? "Memory draft applied."
                            : "Decision approved.")
                        }
                      >
                        {decision.kind === "memoryDraftReview" ? "Apply" : "Approve"}
                      </button>
                      <details className="message-details">
                        <summary>More</summary>
                        <div className="button-row">
                          <button
                            className="secondary"
                            onClick={() =>
                              void runAction(async () => {
                                await resolveDecision(decision, "denied");
                              }, decision.kind === "memoryDraftReview"
                                ? "Memory draft dismissed."
                                : "Decision denied.")
                            }
                          >
                            {decision.kind === "memoryDraftReview" ? "Dismiss" : "Deny"}
                          </button>
                          {decision.kind === "memoryDraftReview" ? (
                            <button
                              className="secondary"
                              onClick={() => {
                                void navigate({ to: "/settings" });
                              }}
                            >
                              Review
                            </button>
                          ) : null}
                        </div>
                      </details>
                    </div>
                  </article>
                ))}
              </div>
            </article>
          ) : null}

          {showRecentRunSummaryCard && terminalChatFeedback ? (
            <RecentRunSummaryCard
              breakdown={currentRunBreakdown}
              chatFeedback={terminalChatFeedback}
              historySettled={!historyFetching && !showStreamingCard}
            />
          ) : null}

          {showStreamingCard ? (
            <article className="message-card assistant streaming">
              <div className="message-meta">
                <div className="message-meta-copy">
                  <header>DroidAgent</header>
                  <span>Live</span>
                </div>
              </div>
              <div className="message-markdown">
                <StreamingMarkdown
                  onOpenImage={onOpenImage}
                  text={streamingText || "Working through the live OpenClaw run..."}
                />
              </div>
            </article>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function SidebarRail(props: ChatScreenShellProps) {
  const {
    activeRun,
    activeRunApproval,
    activeSession,
    archivedSessions,
    hostPressure,
    hostPressureLevel,
    messages,
    onAbortRun,
    onRecoverHostPressure,
    onResolveApprovalAction,
    onRestoreSession,
    onSelectSession,
    onStartFreshSession,
    onCloseCurrentSession,
    runAction,
    selectedSessionKey,
    sessionOptions,
    sessionSecondaryStatus,
    showRailRunCard,
    showSessionSwitcher,
    showStreamingCard,
    visiblePressureContributors,
  } = props;

  return (
    <aside className="operator-sidebar-window panel-card compact">
      <div className="operator-window-head">
        <div className="operator-window-copy">
          <div className="journey-kicker">Host rail</div>
          <h3>Status</h3>
        </div>
        <small>Runs, pressure, and session controls</small>
      </div>

      <div className="operator-window-surface operator-sidebar-surface">
        <section className="operator-side-module">
          <div className="operator-side-module-head">
            <strong>Session</strong>
            <span>{activeSession?.title ?? "Operator Chat"}</span>
          </div>
          {showSessionSwitcher ? (
            <label className="operator-session-picker rail">
              <span>Active</span>
              <select
                value={selectedSessionKey ?? ""}
                onChange={(event) => {
                  void onSelectSession(event.target.value);
                }}
              >
                {sessionOptions.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.title}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="operator-side-inline-meta">
              <span>{messages.length + (showStreamingCard ? 1 : 0)} visible items</span>
              <span>{sessionSecondaryStatus}</span>
            </div>
          )}
          <div className="message-action-row compact">
            <button
              type="button"
              className="secondary"
              onClick={() =>
                void runAction(async () => {
                  await onStartFreshSession();
                }, "New chat ready.")
              }
            >
              New chat
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() =>
                void runAction(async () => {
                  await onCloseCurrentSession();
                }, "Chat closed.")
              }
            >
              Close chat
            </button>
          </div>
        </section>

        <section className="operator-side-module">
          <div className="operator-side-module-head">
            <strong>Archived chats</strong>
            <span>{archivedSessions.length}</span>
          </div>
          {archivedSessions.length > 0 ? (
            <div className="operator-session-archive-list">
              {archivedSessions.slice(0, 6).map((session) => (
                <div key={session.id} className="operator-session-archive-card">
                  <div>
                    <strong>{session.title}</strong>
                    <span>{session.lastMessagePreview || "No preview yet"}</span>
                  </div>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      void runAction(async () => {
                        await onRestoreSession(session.id);
                      }, "Archived chat restored.")
                    }
                  >
                    Restore
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="operator-side-copy">
              Closed chats stay here until you restore them.
            </p>
          )}
        </section>

        <section className="operator-side-module">
          <div className="operator-side-module-head">
            <strong>Host pressure</strong>
            <span>{hostPressureLevel}</span>
          </div>
          <p className="operator-side-copy">
            {hostPressure?.message ?? "Host pressure telemetry is updating."}
          </p>
          {visiblePressureContributors.length > 0 ? (
            <div className="operator-pressure-breakdown rail">
              {visiblePressureContributors.map((contributor) => (
                <PressureContributorBadge
                  key={contributor.id}
                  contributor={contributor}
                />
              ))}
            </div>
          ) : null}
          <div className="operator-pressure-summary rail">
            <span>
              Reclaimable {formatHostBytes(hostPressure?.memoryAvailableBytes)}
            </span>
            <span>RAM {formatHostRatio(hostPressure?.memoryUsedRatio)}</span>
            <span>Swap {formatHostBytes(hostPressure?.swapUsedBytes)}</span>
            <span>
              Load {hostPressure?.load1m ?? "unknown"} /{" "}
              {hostPressure?.cpuLogicalCores ?? "unknown"} cores
            </span>
            <span>{hostPressure?.activeJobs ?? 0} active jobs</span>
            <span>
              Terminal {hostPressure?.activeTerminalSession ? "open" : "idle"}
            </span>
          </div>
          <div className="message-action-row compact operator-pressure-actions rail">
            {activeRun?.active ? (
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  void runAction(async () => {
                    await onAbortRun();
                  }, "Live run stopped.")
                }
              >
                Stop run
              </button>
            ) : null}
            <button
              type="button"
              className={hostPressureLevel === "critical" ? "" : "secondary"}
              onClick={() =>
                void runAction(async () => {
                  await onRecoverHostPressure();
                }, "Recovery cycle completed.")
              }
            >
              Cleanup cycle
            </button>
            {hostPressure?.activeJobs || hostPressure?.activeTerminalSession ? (
              <details className="message-details">
                <summary>More recovery</summary>
                <div className="message-action-row compact">
                  {hostPressure?.activeJobs ? (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        void runAction(async () => {
                          await onRecoverHostPressure({
                            abortSessionRun: false,
                            cancelActiveJobs: true,
                            closeTerminalSession: false,
                          });
                        }, "Active jobs cancelled for recovery.")
                      }
                    >
                      Cancel jobs
                    </button>
                  ) : null}
                  {hostPressure?.activeTerminalSession ? (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        void runAction(async () => {
                          await onRecoverHostPressure({
                            abortSessionRun: false,
                            cancelActiveJobs: false,
                            closeTerminalSession: true,
                          });
                        }, "Rescue terminal closed for recovery.")
                      }
                    >
                      Close terminal
                    </button>
                  ) : null}
                </div>
              </details>
            ) : null}
          </div>
        </section>

        {showRailRunCard && activeRun ? (
          <section className="operator-side-module">
            <div className="operator-side-module-head">
              <strong>Live run</strong>
              <span>{activeRun.stage}</span>
            </div>
            <div
              className={`run-state-card ${activeRun.active ? "active" : "complete"} ${activeRun.stage}`}
            >
              <div>
                <strong>{activeRun.label}</strong>
                {activeRun.detail ? <p>{activeRun.detail}</p> : null}
                {activeRun.activities.length > 0 ? (
                  <RunActivityTrail activities={activeRun.activities} />
                ) : null}
              </div>
              {activeRun.stage === "approval_required" ? (
                <ApprovalCard
                  approval={activeRunApproval}
                  onResolve={(
                    approvalId: string,
                    resolution: "approved" | "denied",
                  ) => {
                    onResolveApprovalAction(approvalId, resolution);
                  }}
                />
              ) : null}
            </div>
          </section>
        ) : null}
      </div>
    </aside>
  );
}

function ComposerWindow(props: ChatScreenShellProps) {
  const {
    activeRun,
    chatInput,
    composerStateLabel,
    composerStatusMessage,
    fileInputRef,
    harnessReady,
    hostPressure,
    maintenanceActive,
    onAttachClick,
    onAttachFilesChange,
    onChatInputChange,
    onComposerPaste,
    onRemovePendingAttachment,
    onStopActiveRun,
    onSubmit,
    pendingAttachments,
    pressureBlocks,
    sendDisabled,
    sendTitle,
    uploadingAttachments,
  } = props;

  return (
    <form className="operator-composer-window panel-card compact" onSubmit={onSubmit}>
      <div className="operator-window-head">
        <div className="operator-window-copy">
          <div className="journey-kicker">Compose</div>
          <h3>Ask DroidAgent</h3>
        </div>
        <small>{composerStateLabel}</small>
      </div>

      <div className="composer-shell operator-window-surface operator-composer-surface">
        <PendingAttachmentList
          attachments={pendingAttachments}
          onRemove={onRemovePendingAttachment}
        />

        <textarea
          value={chatInput}
          onChange={onChatInputChange}
          onPaste={onComposerPaste}
          placeholder="Ask DroidAgent to inspect code, summarize a PDF, analyze an image, edit files, or run a command..."
          disabled={uploadingAttachments || maintenanceActive}
        />

        <div className="composer-footer">
          <small className="composer-status">{composerStatusMessage}</small>

          <div className="composer-actions">
            <input
              ref={fileInputRef}
              className="hidden-file-input"
              type="file"
              multiple
              onChange={onAttachFilesChange}
            />
            <button
              type="button"
              className="secondary"
              disabled={uploadingAttachments}
              onClick={onAttachClick}
            >
              {uploadingAttachments ? "Attaching..." : "Attach"}
            </button>
            {activeRun?.active ? (
              <button
                type="button"
                className="secondary"
                onClick={onStopActiveRun}
              >
                Stop
              </button>
            ) : null}
            <button
              type="submit"
              title={
                pressureBlocks
                  ? hostPressure?.message ??
                    "Host pressure is critical. Sending is paused until cleanup completes."
                  : sendTitle
              }
              disabled={sendDisabled || !harnessReady}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}

function ImageLightbox({
  expandedImage,
  onClose,
}: {
  expandedImage: ExpandedImageState | null;
  onClose: () => void;
}) {
  if (!expandedImage) {
    return null;
  }

  return (
    <div
      className="image-lightbox"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="image-lightbox-card"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="image-lightbox-head">
          <strong>{expandedImage.label ?? expandedImage.alt}</strong>
          <button
            type="button"
            className="secondary"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <img
          alt={expandedImage.alt}
          className="image-lightbox-image"
          src={expandedImage.src}
        />
      </div>
    </div>
  );
}

export function ChatScreenShell(props: ChatScreenShellProps) {
  const {
    activeSession,
    agentReady,
    availableToolsCount,
    headerFacts,
    hostPressureLevel,
    memoryIndexed,
    pendingDecisionCount,
    pressureBlocks,
    harnessReady,
    maintenanceActive,
    showHeaderHostPressureMetric,
    transportReady,
    visibleLiveMetrics,
  } = props;

  return (
    <>
      <section className="operator-chat-shell">
        <article className="operator-chat-overview panel-card compact">
          <div className="operator-chat-overview-copy">
            <div className="journey-kicker">Live operator session</div>
            <h2>{activeSession?.title ?? "Operator Chat"}</h2>

            <div className="operator-fact-row">
              {headerFacts.map((fact) => (
                <span key={fact} className="operator-fact-chip">
                  {fact}
                </span>
              ))}
            </div>
          </div>

          <div className="operator-chat-overview-meta">
            <div className="status-chip-row">
              <span className={`status-chip${agentReady ? " ready" : ""}`}>
                {maintenanceActive
                  ? "Maintenance active"
                  : pressureBlocks
                    ? "Agent paused"
                    : harnessReady
                      ? "Agent live"
                      : "Agent unavailable"}
              </span>
              <span className={`status-chip${transportReady ? " ready" : ""}`}>
                {transportReady ? "WebSocket live" : "HTTP fallback"}
              </span>
              <span className={`status-chip${memoryIndexed ? " ready" : ""}`}>
                {memoryIndexed ? "Memory indexed" : "Memory pending"}
              </span>
              <span className={`status-chip${pendingDecisionCount > 0 ? "" : " ready"}`}>
                {pendingDecisionCount > 0
                  ? `${pendingDecisionCount} decision${pendingDecisionCount === 1 ? "" : "s"}`
                  : `${availableToolsCount} tools ready`}
              </span>
            </div>

            {visibleLiveMetrics.length > 0 || showHeaderHostPressureMetric ? (
              <div className="metric-strip operator-metrics">
                {visibleLiveMetrics.map((metric) => (
                  <div key={metric.label} className="metric-chip">
                    <strong>{metric.label}</strong>
                    <span>{metric.value}</span>
                  </div>
                ))}
                {showHeaderHostPressureMetric ? (
                  <div className="metric-chip">
                    <strong>Host pressure</strong>
                    <span>{hostPressureLevel}</span>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </article>

        <section className="operator-chat-workbench">
          <TranscriptWindow {...props} />
          <SidebarRail {...props} />
        </section>

        <ComposerWindow {...props} />
      </section>
      <ImageLightbox
        expandedImage={props.expandedImage}
        onClose={props.onCloseExpandedImage}
      />
    </>
  );
}
