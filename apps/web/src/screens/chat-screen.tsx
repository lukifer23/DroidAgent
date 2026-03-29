import {
  type ClipboardEvent,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type {
  ApprovalRecord,
  ChatAttachment,
  ChatMessage,
  ChatMessagePart,
  ChatRunState,
  DashboardState,
  HostPressureContributor,
  HostPressureRecoveryResult,
  JobRecord,
  JobOutputSnapshot,
  LatencySummary,
  SessionSummary,
} from "@droidagent/shared";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { useAuthQuery, useDashboardQuery } from "../app-data";
import {
  type ChatSessionFeedback,
  useClientPerformanceSnapshot,
  useDroidAgentApp,
} from "../app-context";
import { api, postFormData, postJson } from "../lib/api";
import { extractRunnableCommand } from "../lib/command-suggestions";
import { useChatRuns } from "../lib/chat-run-store";
import { useStreamingRuns } from "../lib/chat-stream-store";
import { formatTokenBudget } from "../lib/formatters";

const TERMINAL_PREFILL_STORAGE_KEY = "droidagent-terminal-prefill";

interface ExpandedImageState {
  src: string;
  alt: string;
  label?: string;
}

function roleLabel(role: ChatMessage["role"]): string {
  if (role === "tool") {
    return "Tool";
  }

  if (role === "system") {
    return "System";
  }

  return role === "assistant" ? "DroidAgent" : "You";
}

function formatMessageTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function formatLatency(summary: LatencySummary | undefined): string {
  const value = summary?.lastDurationMs ?? summary?.p95DurationMs ?? null;
  if (!value || !Number.isFinite(value)) {
    return "Awaiting run";
  }

  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}s`;
  }

  return `${Math.round(value)} ms`;
}

function formatDurationMs(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "Waiting...";
  }

  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}s`;
  }

  return `${Math.round(value)} ms`;
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  if (value >= 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${value} B`;
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

function formatHostRatio(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "unknown";
  }
  return `${Math.round(value * 100)}%`;
}

function renderLogTail(value: string, maxChars = 8_000): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `...log trimmed in browser (${value.length - maxChars} chars hidden)\n${value.slice(-maxChars)}`;
}

function buildCommandRelayPrompt(
  job: JobRecord,
  output: JobOutputSnapshot,
): string {
  const sections = [
    "Approved workspace command finished. Use the real command result below to continue the same task and answer the operator directly.",
    `Command: \`${job.command}\``,
    `Exit code: ${job.exitCode ?? "unknown"}`,
  ];

  if (output.stdout.trim()) {
    sections.push(
      `Stdout:\n\`\`\`text\n${renderLogTail(output.stdout, 3_200)}\n\`\`\``,
    );
  } else {
    sections.push("Stdout: (empty)");
  }

  if (output.stderr.trim()) {
    sections.push(
      `Stderr:\n\`\`\`text\n${renderLogTail(output.stderr, 2_000)}\n\`\`\``,
    );
  }

  if (output.truncated) {
    sections.push(
      "Note: output was truncated for chat context. Use the result that is present instead of claiming a command failed silently.",
    );
  }

  sections.push(
    "Do not claim you already ran any additional command unless you actually invoke another tool or command now.",
  );

  return sections.join("\n\n");
}

function describeChatFeedback(
  feedback: ChatSessionFeedback | null | undefined,
): { firstToken: string; reply: string } {
  if (!feedback) {
    return {
      firstToken: "Awaiting run",
      reply: "Awaiting run",
    };
  }

  return {
    firstToken:
      feedback.firstTokenMs !== null
        ? formatDurationMs(feedback.firstTokenMs)
        : feedback.status === "error"
          ? "Failed"
          : "Waiting...",
    reply:
      feedback.completedMs !== null
        ? formatDurationMs(feedback.completedMs)
        : feedback.status === "error"
          ? "Failed"
          : feedback.status === "done"
            ? "Done"
            : "In progress",
  };
}

function commandRelayTone(
  commandJob: JobRecord,
  commandRelayStatus: CommandRelayStatus,
): "active" | "complete" | "failed" {
  if (
    commandJob.status === "failed" ||
    commandJob.status === "cancelled" ||
    commandRelayStatus === "failed"
  ) {
    return "failed";
  }

  if (commandRelayStatus === "complete") {
    return "complete";
  }

  return "active";
}

function commandRelaySummary(
  commandJob: JobRecord,
  commandRelayStatus: CommandRelayStatus,
): { title: string; detail: string } {
  if (commandJob.status === "queued") {
    return {
      title: "Workspace command queued",
      detail:
        "DroidAgent queued the approved command and will feed the result back into this chat when it finishes.",
    };
  }

  if (commandJob.status === "running") {
    return {
      title: "Workspace command running",
      detail:
        "The approved command is running in the workspace. Live output is shown here and the finished result will be handed back to DroidAgent.",
    };
  }

  if (commandRelayStatus === "relaying") {
    return {
      title: "Sending command result back into DroidAgent",
      detail:
        "The workspace command finished. DroidAgent is posting the real command output back into the same chat so the agent can continue.",
    };
  }

  if (commandRelayStatus === "complete") {
    return {
      title: "Command result returned to chat",
      detail:
        "The finished workspace command was handed back into DroidAgent. The next assistant reply should continue from that real output.",
    };
  }

  if (commandJob.status === "cancelled") {
    return {
      title: "Workspace command cancelled",
      detail:
        "The approved command was cancelled before the result could be handed back into chat.",
    };
  }

  return {
    title: "Workspace command failed",
    detail:
      "The approved command failed. Review the output below before deciding whether to retry or continue manually.",
  };
}

function CommandRelayCard({
  commandJob,
  commandRelayError,
  commandRelayStatus,
  onClear,
  output,
}: {
  commandJob: JobRecord;
  commandRelayError: string | null;
  commandRelayStatus: CommandRelayStatus;
  onClear: () => void;
  output: JobOutputSnapshot | undefined;
}) {
  const summary = commandRelaySummary(commandJob, commandRelayStatus);
  const tone = commandRelayTone(commandJob, commandRelayStatus);

  return (
    <article className={`run-state-card chat-inline-job-card ${tone}`}>
      <div className="chat-inline-job-head">
        <div>
          <strong>{summary.title}</strong>
          <p>{commandJob.command}</p>
        </div>
        <button type="button" className="secondary" onClick={onClear}>
          Clear
        </button>
      </div>
      <div className="chat-inline-job-meta">
        <span>
          {commandJob.status} • {commandJob.cwd}
        </span>
        {commandJob.lastLine ? <span>{commandJob.lastLine}</span> : null}
      </div>
      <div className="operator-side-inline-meta">
        <span>{summary.detail}</span>
        {commandRelayError ? <span>{commandRelayError}</span> : null}
      </div>
      {output?.stdout || output?.stderr ? (
        <pre className="chat-inline-job-output">
          {renderLogTail(
            [
              output.stdout ? `$ ${commandJob.command}\n${output.stdout}` : `$ ${commandJob.command}`,
              output.stderr ? `stderr:\n${output.stderr}` : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
          )}
        </pre>
      ) : null}
    </article>
  );
}

function PendingAssistantCard({
  activeRun,
  approval,
  chatFeedback,
  onResolveApproval,
}: {
  activeRun: ChatRunState | null;
  approval: ApprovalRecord | null;
  chatFeedback: ChatSessionFeedback | null;
  onResolveApproval: (approvalId: string, resolution: "approved" | "denied") => void;
}) {
  const feedback = describeChatFeedback(chatFeedback);
  const stage = activeRun?.stage ?? "waiting";
  const label = activeRun?.label ?? "DroidAgent is preparing a reply";
  const detail =
    activeRun?.detail ??
    (chatFeedback?.status === "error"
      ? chatFeedback.errorMessage ?? "The last request failed before DroidAgent could respond."
      : "The request was accepted and DroidAgent is still working.");

  return (
    <article className="message-card assistant pending">
      <div className="message-meta">
        <div className="message-meta-copy">
          <header>DroidAgent</header>
          <span>{stage}</span>
        </div>
      </div>

      <div className="message-part-stack">
        <div className={`operator-run-strip ${stage}`}>
          <strong>{label}</strong>
          <span>
            {detail}
          </span>
          <div className="operator-side-inline-meta">
            <span>First token: {feedback.firstToken}</span>
            <span>Reply: {feedback.reply}</span>
          </div>
        </div>
        {activeRun?.stage === "approval_required" ? (
          <ApprovalCard approval={approval} onResolve={onResolveApproval} />
        ) : null}
      </div>
    </article>
  );
}

type CommandRelayStatus =
  | "idle"
  | "awaiting_job"
  | "relaying"
  | "complete"
  | "failed";

function shouldShowCopyButton(message: ChatMessage): boolean {
  if (!message.text.trim()) {
    return false;
  }

  if (message.role === "user") {
    return message.text.trim().length >= 180;
  }

  return true;
}

function CopyButton({
  text,
  label = "Copy",
}: {
  text: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="message-copy-button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

function MarkdownCodeBlock({
  text,
  className,
  onRunCommand,
  onOpenInTerminal,
  commandActionsEnabled = true,
  commandActionDisabledReason,
}: {
  text: string;
  className: string | undefined;
  onRunCommand?: ((command: string) => void) | null | undefined;
  onOpenInTerminal?: ((command: string) => void) | null | undefined;
  commandActionsEnabled?: boolean;
  commandActionDisabledReason?: string | null | undefined;
}) {
  const runnableCommand = extractRunnableCommand(
    className?.replace("language-", "") ?? null,
    text,
  );

  return (
    <div className="markdown-code-shell">
      <div className="markdown-code-toolbar">
        <span>{className?.replace("language-", "") || "code"}</span>
        <CopyButton text={text} label="Copy code" />
      </div>
      <pre className="markdown-pre">
        <code className={className}>{text}</code>
      </pre>
      {runnableCommand && onRunCommand && onOpenInTerminal ? (
        <>
          <div className="message-action-row">
            <button
              type="button"
              className="secondary"
              disabled={!commandActionsEnabled}
              title={
                commandActionsEnabled
                  ? undefined
                  : (commandActionDisabledReason ?? undefined)
              }
              onClick={() => onRunCommand(runnableCommand)}
            >
              Run in Chat
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => onOpenInTerminal(runnableCommand)}
            >
              Open in Terminal
            </button>
          </div>
          {!commandActionsEnabled && commandActionDisabledReason ? (
            <p className="message-action-note">{commandActionDisabledReason}</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ChatMarkdown({
  text,
  onRunCommand,
  onOpenInTerminal,
  onOpenImage,
  commandActionsEnabled = true,
  commandActionDisabledReason,
}: {
  text: string;
  onRunCommand?: ((command: string) => void) | null | undefined;
  onOpenInTerminal?: ((command: string) => void) | null | undefined;
  onOpenImage?: ((image: ExpandedImageState) => void) | null | undefined;
  commandActionsEnabled?: boolean;
  commandActionDisabledReason?: string | null | undefined;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a(props) {
          return <a {...props} rel="noreferrer" target="_blank" />;
        },
        code({ children, className }) {
          const content = String(children).replace(/\n$/, "");
          const blockLike = Boolean(className) || content.includes("\n");

          return blockLike ? (
            <MarkdownCodeBlock
              className={className}
              commandActionDisabledReason={commandActionDisabledReason}
              commandActionsEnabled={commandActionsEnabled}
              onOpenInTerminal={onOpenInTerminal}
              onRunCommand={onRunCommand}
              text={content}
            />
          ) : (
            <code className="markdown-inline-code">{content}</code>
          );
        },
        pre({ children }) {
          return <>{children}</>;
        },
        img(props) {
          const src = props.src ?? "";
          const alt = props.alt ?? "Chat image";
          if (!src) {
            return null;
          }
          return (
            <button
              type="button"
              className="message-inline-image"
              onClick={() =>
                onOpenImage?.({
                  src,
                  alt,
                  label: alt,
                })
              }
            >
              <img alt={alt} loading="lazy" src={src} />
              <span>Expand image</span>
            </button>
          );
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

function StreamingMarkdown({
  text,
  onOpenImage,
}: {
  text: string;
  onOpenImage?: ((image: ExpandedImageState) => void) | null | undefined;
}) {
  if (!text.includes("\n") && !/[`*_#[\]-]/.test(text)) {
    return <p>{text}</p>;
  }

  return (
    <div className="message-markdown">
      <ChatMarkdown onOpenImage={onOpenImage} text={text} />
    </div>
  );
}

function AttachmentPart({
  attachments,
  onOpenImage,
}: {
  attachments: ChatAttachment[];
  onOpenImage?: ((image: ExpandedImageState) => void) | null | undefined;
}) {
  const imageAttachments = attachments.filter(
    (attachment) => attachment.kind === "image",
  );
  const fileAttachments = attachments.filter(
    (attachment) => attachment.kind !== "image",
  );

  return (
    <div className="attachment-stack">
      {imageAttachments.length > 0 ? (
        <div className="attachment-image-grid">
          {imageAttachments.map((attachment) => (
            <button
              key={attachment.id}
              type="button"
              className="attachment-image-card"
              onClick={() =>
                onOpenImage?.({
                  src: attachment.url,
                  alt: attachment.name,
                  label: attachment.name,
                })
              }
            >
              <img alt={attachment.name} loading="lazy" src={attachment.url} />
              <span>{attachment.name}</span>
            </button>
          ))}
        </div>
      ) : null}

      {fileAttachments.length > 0 ? (
        <div className="attachment-chip-row">
          {fileAttachments.map((attachment) => (
            <a
              key={attachment.id}
              className="attachment-chip"
              href={attachment.url}
              rel="noreferrer"
              target="_blank"
            >
              <strong>{attachment.kind}</strong>
              <span>{attachment.name}</span>
              <small>{formatBytes(attachment.size)}</small>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: ApprovalRecord | null;
  onResolve: (approvalId: string, resolution: "approved" | "denied") => void;
}) {
  if (!approval) {
    return null;
  }

  return (
    <div className="inline-approval-card">
      <div className="inline-approval-copy">
        <strong>{approval.title}</strong>
        <p>{approval.details}</p>
      </div>
      <div className="button-row compact-actions">
        <button
          type="button"
          className="secondary"
          onClick={() => onResolve(approval.id, "denied")}
        >
          Deny
        </button>
        <button type="button" onClick={() => onResolve(approval.id, "approved")}>
          Approve
        </button>
      </div>
    </div>
  );
}

const MessagePartView = memo(function MessagePartView({
  part,
  approval,
  onResolveApproval,
  onRunCommand,
  onOpenInTerminal,
  onOpenImage,
  commandActionsEnabled,
  commandActionDisabledReason,
}: {
  part: ChatMessagePart;
  approval: ApprovalRecord | null;
  onResolveApproval: (approvalId: string, resolution: "approved" | "denied") => void;
  onRunCommand: (command: string) => void;
  onOpenInTerminal: (command: string) => void;
  onOpenImage: (image: ExpandedImageState) => void;
  commandActionsEnabled: boolean;
  commandActionDisabledReason?: string | null | undefined;
}) {
  if (part.type === "markdown") {
    return (
      <div className="message-markdown">
        <ChatMarkdown
          commandActionDisabledReason={commandActionDisabledReason}
          commandActionsEnabled={commandActionsEnabled}
          onOpenImage={onOpenImage}
          onOpenInTerminal={onOpenInTerminal}
          onRunCommand={onRunCommand}
          text={part.text}
        />
      </div>
    );
  }

  if (part.type === "attachments") {
    return (
      <AttachmentPart
        attachments={part.attachments}
        onOpenImage={onOpenImage}
      />
    );
  }

  if (part.type === "code_block") {
    return (
      <MarkdownCodeBlock
        className={part.language ?? undefined}
        commandActionDisabledReason={commandActionDisabledReason}
        commandActionsEnabled={commandActionsEnabled}
        onOpenInTerminal={onOpenInTerminal}
        onRunCommand={onRunCommand}
        text={part.code}
      />
    );
  }

  if (part.type === "tool_call_summary") {
    return (
      <div className="message-inline-card tool">
        <strong>{part.summary}</strong>
        <span>{part.toolName}</span>
        {part.details ? (
          <details className="message-details">
            <summary>Inspect details</summary>
            <pre>{part.details}</pre>
          </details>
        ) : null}
      </div>
    );
  }

  if (part.type === "tool_result_summary") {
    return (
      <div className="message-inline-card result">
        <strong>{part.summary}</strong>
        {part.toolName ? <span>{part.toolName}</span> : null}
        {part.details ? (
          <details className="message-details">
            <summary>Inspect details</summary>
            <pre>{part.details}</pre>
          </details>
        ) : null}
      </div>
    );
  }

  if (part.type === "approval_request") {
    return (
      <ApprovalCard
        approval={approval}
        onResolve={onResolveApproval}
      />
    );
  }

  return (
    <div className="message-inline-card error">
      <strong>{part.message}</strong>
      {part.details ? <span>{part.details}</span> : null}
    </div>
  );
});

function PendingAttachmentList({
  attachments,
  onRemove,
}: {
  attachments: ChatAttachment[];
  onRemove: (attachmentId: string) => void;
}) {
  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className="composer-attachment-list">
      {attachments.map((attachment) => (
        <div key={attachment.id} className="composer-attachment-chip">
          <div>
            <strong>{attachment.name}</strong>
            <span>
              {attachment.kind} • {formatBytes(attachment.size)}
            </span>
          </div>
          <button
            type="button"
            className="ghost-button"
            onClick={() => onRemove(attachment.id)}
          >
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}

function MessageMemoryActions({
  onAddMemory,
  onAddPreferences,
  onAddTodayNote,
}: {
  onAddMemory: () => void;
  onAddPreferences: () => void;
  onAddTodayNote: () => void;
}) {
  return (
    <details className="message-utility-tray">
      <summary title="Create a memory draft from this message">Save memory</summary>
      <div className="message-action-row compact">
        <button type="button" className="secondary" onClick={onAddMemory}>
          Memory
        </button>
        <button type="button" className="secondary" onClick={onAddPreferences}>
          Preferences
        </button>
        <button type="button" className="secondary" onClick={onAddTodayNote}>
          Today Note
        </button>
      </div>
    </details>
  );
}

function PressureContributorBadge({
  contributor,
}: {
  contributor: HostPressureContributor;
}) {
  return (
    <div
      className={`pressure-contributor-badge ${contributor.severity}`.trim()}
      title={contributor.detail}
    >
      <strong>{contributor.label}</strong>
      <span>{contributor.value}</span>
    </div>
  );
}

export function ChatScreen() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const {
    chatFeedbackBySessionId,
    selectedSessionId,
    setSelectedSessionId,
    sendRealtimeCommand,
    trackChatSubmit,
    trackChatFailure,
    trackJobStart,
    runAction,
    wsStatus,
  } = useDroidAgentApp();
  const authQuery = useAuthQuery();
  const dashboardQuery = useDashboardQuery(Boolean(authQuery.data?.user));
  const dashboard = dashboardQuery.data;
  const clientPerformanceSnapshot = useClientPerformanceSnapshot();
  const streamingRuns = useStreamingRuns();
  const runStates = useChatRuns();
  const [chatInput, setChatInput] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>(
    [],
  );
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [commandJobId, setCommandJobId] = useState<string | null>(null);
  const [commandRelaySessionId, setCommandRelaySessionId] = useState<
    string | null
  >(null);
  const [commandRelayStatus, setCommandRelayStatus] = useState<
    CommandRelayStatus
  >("idle");
  const [commandRelayError, setCommandRelayError] = useState<string | null>(
    null,
  );
  const [expandedImage, setExpandedImage] = useState<ExpandedImageState | null>(
    null,
  );
  const relayedCommandJobsRef = useRef<Set<string>>(new Set());

  const dashboardSessions = dashboard?.sessions ?? [];
  const archivedSessionsQuery = useQuery({
    queryKey: ["sessions", "archived"],
    queryFn: () => api<SessionSummary[]>("/api/sessions/archived"),
    enabled: Boolean(authQuery.data?.user),
    staleTime: 15_000,
  });
  const approvals = dashboard?.approvals ?? [];
  const providers = dashboard?.providers ?? [];
  const runtimes = dashboard?.runtimes ?? [];
  const jobs = dashboard?.jobs ?? [];
  const sessions = dashboardSessions;
  const archivedSessions = archivedSessionsQuery.data ?? [];
  const activeSession =
    sessions.find((session) => session.id === selectedSessionId) ??
    sessions[0] ??
    null;
  const selectedSessionKey = activeSession?.id ?? selectedSessionId;
  const activeRun = selectedSessionKey ? runStates[selectedSessionKey] : null;
  const chatFeedback = selectedSessionKey
    ? chatFeedbackBySessionId[selectedSessionKey] ?? null
    : null;
  const streaming = selectedSessionKey
    ? streamingRuns[selectedSessionKey]
    : undefined;
  const activeProvider = providers.find((provider) => provider.enabled);
  const openclawRuntime = runtimes.find(
    (runtime) => runtime.id === "openclaw",
  );
  const harness = dashboard?.harness;
  const maintenance = dashboard?.maintenance;
  const hostPressure = dashboard?.hostPressure;
  const memoryDrafts = dashboard?.memoryDrafts ?? [];
  const availableTools = harness?.availableTools ?? [];
  const memory = dashboard?.memory;
  const transportReady = wsStatus === "connected" && Boolean(selectedSessionKey);
  const maintenanceActive = Boolean(maintenance?.blocksNewWork);
  const hostPressureLevel = hostPressure?.level ?? "unknown";
  const pressureElevated =
    hostPressureLevel === "critical" || hostPressureLevel === "warn";
  const pressureBlocks = Boolean(hostPressure?.blocksAgentRuns);
  const harnessReady =
    openclawRuntime?.state === "running" &&
    Boolean(activeProvider?.enabled) &&
    Boolean(harness?.configured) &&
    !maintenanceActive;
  const agentReady = harnessReady && !pressureBlocks;
  const approvalCount = approvals.length;
  const pendingDraftCount = memoryDrafts.filter(
    (draft) => draft.status === "pending",
  ).length;
  const commandJob = jobs.find((job) => job.id === commandJobId) ?? null;
  const sessionOptions = useMemo(() => [...sessions], [sessions]);
  const showSessionSwitcher = sessionOptions.length > 1;
  const showTranscriptAlerts = maintenanceActive;
  const approvalsById = useMemo(
    () => new Map(approvals.map((approval) => [approval.id, approval])),
    [approvals],
  );
  const visiblePressureContributors = useMemo(
    () =>
      (hostPressure?.contributors ?? []).filter(
        (contributor) => contributor.severity !== "ok",
      ),
    [hostPressure?.contributors],
  );
  const activeRunApproval =
    activeRun?.stage === "approval_required"
      ? ((activeRun.approvalId
          ? approvalsById.get(activeRun.approvalId) ?? null
          : null) ?? (approvals.length === 1 ? approvals[0]! : null))
      : null;

  function updateDashboardSessions(
    updater: (sessions: SessionSummary[]) => SessionSummary[],
  ) {
    queryClient.setQueryData<DashboardState | undefined>(
      ["dashboard"],
      (current) =>
        current
          ? {
              ...current,
              sessions: updater(current.sessions),
            }
          : current,
    );
  }

  function updateArchivedSessions(
    updater: (sessions: SessionSummary[]) => SessionSummary[],
  ) {
    queryClient.setQueryData<SessionSummary[]>(
      ["sessions", "archived"],
      (current) => updater(current ?? []),
    );
  }

  const historyQuery = useQuery({
    queryKey: ["sessions", selectedSessionKey, "messages"],
    queryFn: () =>
      api<ChatMessage[]>(
        `/api/sessions/${encodeURIComponent(selectedSessionKey)}/messages`,
      ),
    enabled: Boolean(authQuery.data?.user && selectedSessionKey),
    staleTime: 15_000,
  });
  const cachedMessages = selectedSessionKey
    ? (queryClient.getQueryData<ChatMessage[]>([
        "sessions",
        selectedSessionKey,
        "messages",
      ]) ?? [])
    : [];

  const commandJobOutputQuery = useQuery({
    queryKey: ["jobs", commandJobId, "output"],
    queryFn: () =>
      api<JobOutputSnapshot>(
        `/api/jobs/${encodeURIComponent(commandJobId ?? "")}/output`,
      ),
    enabled: Boolean(commandJobId),
    refetchInterval:
      commandJob &&
      (commandJob.status === "queued" || commandJob.status === "running")
        ? 1_000
        : false,
    staleTime: 1_000,
  });

  const messages = useMemo(
    () => historyQuery.data ?? cachedMessages,
    [cachedMessages, historyQuery.data],
  );
  const liveMetricMap = useMemo(
    () => new Map(clientPerformanceSnapshot.metrics.map((metric) => [metric.name, metric])),
    [clientPerformanceSnapshot.metrics],
  );
  const selectedRunFeedback = useMemo(
    () => describeChatFeedback(chatFeedback),
    [chatFeedback],
  );
  const showPendingAssistantCard = Boolean(
    !streaming &&
      (activeRun?.active ||
        chatFeedback?.status === "waiting_first_token" ||
        chatFeedback?.status === "error"),
  );

  const liveMetrics = useMemo(
    () => {
      const metrics = [];

      if (activeRun?.active || streaming || chatFeedback) {
        metrics.push({
          label: "First token",
          value: selectedRunFeedback.firstToken,
        });
        metrics.push({
          label: "Reply",
          value: selectedRunFeedback.reply,
        });
      }

      const reconnectValue = formatLatency(
        liveMetricMap.get("client.ws.reconnect_to_resync")?.summary,
      );
      if (reconnectValue !== "Awaiting run") {
        metrics.push({
          label: "Reconnect",
          value: reconnectValue,
        });
      }

      if (commandJob) {
        metrics.push({
          label: "Command",
          value: commandJob.status,
        });
      }

      return metrics;
    },
    [
      activeRun?.active,
      chatFeedback,
      commandJob,
      liveMetricMap,
      selectedRunFeedback.firstToken,
      selectedRunFeedback.reply,
      streaming,
    ],
  );
  const visibleLiveMetrics = useMemo(
    () => liveMetrics.filter((metric) => metric.value !== "Awaiting run"),
    [liveMetrics],
  );
  const normalizedActiveModel =
    harness?.activeModel?.replace(/^ollama\//, "") ??
    activeProvider?.model ??
    null;
  const normalizedImageModel =
    harness?.imageModel?.replace(/^ollama\//, "") ?? null;

  const headerFacts = [
    activeProvider?.model ?? "No active model",
    activeProvider?.contextWindow
      ? formatTokenBudget(activeProvider.contextWindow)
      : "context pending",
    memory?.semanticReady ? "memory indexed" : "memory pending",
    pendingDraftCount > 0
      ? `${pendingDraftCount} draft${pendingDraftCount === 1 ? "" : "s"} pending`
      : "drafts clear",
    hostPressureLevel === "critical"
      ? "pressure critical"
      : hostPressureLevel === "warn"
        ? "pressure elevated"
        : null,
    harness?.attachmentsEnabled
      ? normalizedImageModel && normalizedActiveModel
        ? normalizedImageModel === normalizedActiveModel
          ? "multimodal ready"
          : `vision ${normalizedImageModel}`
        : "attachments ready"
      : "attachments unavailable",
  ].filter(Boolean) as string[];

  useEffect(() => {
    setCommandJobId(null);
    setCommandRelaySessionId(null);
    setCommandRelayStatus("idle");
    setCommandRelayError(null);
  }, [selectedSessionKey]);

  useEffect(() => {
    const container = threadRef.current;
    if (!container) {
      return;
    }

    const bottomGap =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    if (bottomGap > 120) {
      return;
    }

    const handle = window.requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
    return () => {
      window.cancelAnimationFrame(handle);
    };
  }, [messages.length, selectedSessionKey, streaming?.text, activeRun?.updatedAt]);

  useEffect(() => {
    if (!commandJobId || !commandJob || !commandRelaySessionId) {
      return;
    }

    if (
      commandJob.status === "queued" ||
      commandJob.status === "running" ||
      commandRelayStatus === "relaying" ||
      commandRelayStatus === "complete" ||
      relayedCommandJobsRef.current.has(commandJobId)
    ) {
      return;
    }

    let cancelled = false;
    setCommandRelayStatus("relaying");
    setCommandRelayError(null);

    void (async () => {
      try {
        trackChatSubmit(commandRelaySessionId);
        const output = await queryClient.fetchQuery({
          queryKey: ["jobs", commandJobId, "output"],
          queryFn: () =>
            api<JobOutputSnapshot>(
              `/api/jobs/${encodeURIComponent(commandJobId)}/output`,
            ),
          staleTime: 0,
        });

        await postJson(`/api/sessions/${encodeURIComponent(commandRelaySessionId)}/messages`, {
          text: buildCommandRelayPrompt(commandJob, output),
          attachments: [],
        });

        relayedCommandJobsRef.current.add(commandJobId);
        if (cancelled) {
          return;
        }
        setCommandRelayStatus("complete");
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
          queryClient.invalidateQueries({
            queryKey: ["sessions", commandRelaySessionId, "messages"],
          }),
        ]);
      } catch (error) {
        if (cancelled) {
          return;
        }
        trackChatFailure(
          commandRelaySessionId,
          error instanceof Error
            ? error.message
            : "Failed to send command output back into chat.",
        );
        setCommandRelayStatus("failed");
        setCommandRelayError(
          error instanceof Error
            ? error.message
            : "Failed to send command output back into chat.",
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    commandJob,
    commandJobId,
    commandRelaySessionId,
    commandRelayStatus,
    queryClient,
    trackChatFailure,
    trackChatSubmit,
  ]);

  async function uploadFiles(files: File[]) {
    if (files.length === 0) {
      return;
    }

    const formData = new FormData();
    for (const file of files) {
      formData.append("files", file);
    }

    setUploadingAttachments(true);
    try {
      const response = await postFormData<{ attachments: ChatAttachment[] }>(
        "/api/chat/uploads",
        formData,
      );
      setPendingAttachments((current) => {
        const next = [...current];
        for (const attachment of response.attachments) {
          if (!next.some((entry) => entry.id === attachment.id)) {
            next.push(attachment);
          }
        }
        return next;
      });
    } finally {
      setUploadingAttachments(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  async function handleResolveApproval(
    approvalId: string,
    resolution: "approved" | "denied",
  ) {
    if (
      transportReady &&
      sendRealtimeCommand({
        type: "approval.resolve",
        payload: {
          approvalId,
          resolution,
        },
      })
    ) {
      return;
    }

    await postJson(`/api/approvals/${encodeURIComponent(approvalId)}`, {
      resolution,
    });
  }

  async function handleAbortRun() {
    if (!selectedSessionKey) {
      return;
    }

    if (
      transportReady &&
      sendRealtimeCommand({
        type: "chat.abort",
        payload: {
          sessionId: selectedSessionKey,
        },
      })
    ) {
      return;
    }

    await postJson(`/api/sessions/${encodeURIComponent(selectedSessionKey)}/abort`, {});
  }

  async function handleCreateMemoryDraft(
    target: "memory" | "preferences" | "todayNote",
    message: ChatMessage,
  ) {
    await postJson("/api/memory/drafts", {
      target,
      title:
        message.role === "assistant"
          ? "Assistant Capture"
          : message.role === "user"
            ? "Operator Capture"
            : "Message Capture",
      content: message.text.trim(),
      sourceKind: "chatMessage",
      sourceLabel: `${roleLabel(message.role)} • ${activeSession?.title ?? "Operator Chat"}`,
      sourceRef: message.id,
      sessionId: selectedSessionKey,
    });
  }

  async function handleRunSuggestedCommand(command: string) {
    if (pressureBlocks) {
      throw new Error(
        hostPressure?.message ??
          "Host pressure is critical. New jobs are paused until the Mac settles.",
      );
    }
    if (!selectedSessionKey) {
      throw new Error("Pick a chat session before running a command.");
    }
    const response = await postJson<{ jobId: string }>("/api/jobs", {
      command,
      cwd: ".",
    });
    trackJobStart(response.jobId);
    setCommandJobId(response.jobId);
    setCommandRelaySessionId(selectedSessionKey);
    setCommandRelayStatus("awaiting_job");
    setCommandRelayError(null);
    await queryClient.invalidateQueries({ queryKey: ["jobs"] });
  }

  function handleOpenInTerminal(command: string) {
    window.sessionStorage.setItem(TERMINAL_PREFILL_STORAGE_KEY, command);
    void navigate({ to: "/terminal" });
  }

  async function handleSelectSession(sessionId: string) {
    if (!sessionId || sessionId === selectedSessionKey) {
      return;
    }
    if (
      !queryClient.getQueryData<ChatMessage[]>([
        "sessions",
        sessionId,
        "messages",
      ])
    ) {
      await queryClient.prefetchQuery({
        queryKey: ["sessions", sessionId, "messages"],
        queryFn: () =>
          api<ChatMessage[]>(
            `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
          ),
        staleTime: 15_000,
      });
    }
    setSelectedSessionId(sessionId);
  }

  async function handleRecoverHostPressure(params?: {
    abortSessionRun?: boolean;
    cancelActiveJobs?: boolean;
    closeTerminalSession?: boolean;
  }) {
    const response = await postJson<HostPressureRecoveryResult>(
      "/api/diagnostics/host-pressure/recover",
      {
        sessionId: selectedSessionKey,
        abortSessionRun: params?.abortSessionRun ?? true,
        cancelActiveJobs: params?.cancelActiveJobs ?? true,
        closeTerminalSession: params?.closeTerminalSession ?? true,
      },
    );
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      queryClient.invalidateQueries({ queryKey: ["jobs"] }),
      queryClient.invalidateQueries({ queryKey: ["terminal"] }),
      selectedSessionKey
        ? queryClient.invalidateQueries({
            queryKey: ["sessions", selectedSessionKey, "messages"],
          })
        : Promise.resolve(),
    ]);
    return response;
  }

  async function handleStartFreshSession() {
    const freshSession = await postJson<SessionSummary>("/api/sessions", {});
    updateDashboardSessions((currentSessions) => {
      const next = [
        freshSession,
        ...currentSessions.filter((session) => session.id !== freshSession.id),
      ];
      return next;
    });
    queryClient.setQueryData<ChatMessage[]>(
      ["sessions", freshSession.id, "messages"],
      [],
    );
    setSelectedSessionId(freshSession.id);
    setChatInput("");
    setPendingAttachments([]);
    setCommandJobId(null);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      queryClient.invalidateQueries({ queryKey: ["sessions", "archived"] }),
      queryClient.prefetchQuery({
        queryKey: ["sessions", freshSession.id, "messages"],
        queryFn: () =>
          api<ChatMessage[]>(
            `/api/sessions/${encodeURIComponent(freshSession.id)}/messages`,
          ),
        staleTime: 15_000,
      }),
    ]);
  }

  async function handleCloseCurrentSession() {
    if (!selectedSessionKey) {
      return;
    }
    const closingSessionId = selectedSessionKey;
    const siblingSession =
      sessionOptions.find((session) => session.id !== closingSessionId) ?? null;
    let replacementSession = siblingSession;

    if (!replacementSession) {
      replacementSession = await postJson<SessionSummary>("/api/sessions", {});
      queryClient.setQueryData<ChatMessage[]>(
        ["sessions", replacementSession.id, "messages"],
        [],
      );
      updateDashboardSessions((currentSessions) => [
        replacementSession!,
        ...currentSessions.filter(
          (session) =>
            session.id !== closingSessionId &&
            session.id !== replacementSession!.id,
        ),
      ]);
    } else {
      updateDashboardSessions((currentSessions) =>
        currentSessions.filter((session) => session.id !== closingSessionId),
      );
    }

    setSelectedSessionId(replacementSession.id);
    setChatInput("");
    setPendingAttachments([]);
    setCommandJobId(null);
    setCommandRelaySessionId(null);
    setCommandRelayStatus("idle");
    setCommandRelayError(null);

    const archivedSession = await postJson<SessionSummary>(
      `/api/sessions/${encodeURIComponent(closingSessionId)}/archive`,
      {},
    );
    updateDashboardSessions((currentSessions) =>
      currentSessions.filter((session) => session.id !== closingSessionId),
    );
    updateArchivedSessions((currentSessions) => [
      archivedSession,
      ...currentSessions.filter((session) => session.id !== closingSessionId),
    ]);
    queryClient.removeQueries({
      queryKey: ["sessions", closingSessionId, "messages"],
      exact: true,
    });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      queryClient.invalidateQueries({ queryKey: ["sessions", "archived"] }),
      queryClient.prefetchQuery({
        queryKey: ["sessions", replacementSession.id, "messages"],
        queryFn: () =>
          api<ChatMessage[]>(
            `/api/sessions/${encodeURIComponent(replacementSession.id)}/messages`,
          ),
        staleTime: 15_000,
      }),
    ]);
  }

  async function handleRestoreSession(sessionId: string) {
    const restored = await postJson<SessionSummary>(
      `/api/sessions/${encodeURIComponent(sessionId)}/restore`,
      {},
    );
    updateDashboardSessions((currentSessions) => [
      restored,
      ...currentSessions.filter((session) => session.id !== restored.id),
    ]);
    updateArchivedSessions((currentSessions) =>
      currentSessions.filter((session) => session.id !== restored.id),
    );
    setSelectedSessionId(restored.id);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      queryClient.invalidateQueries({ queryKey: ["sessions", "archived"] }),
      queryClient.prefetchQuery({
        queryKey: ["sessions", restored.id, "messages"],
        queryFn: () =>
          api<ChatMessage[]>(
            `/api/sessions/${encodeURIComponent(restored.id)}/messages`,
          ),
        staleTime: 15_000,
      }),
    ]);
  }

  async function handleSendChat() {
    const nextText = chatInput.trim();
    const nextAttachments = pendingAttachments;
    if ((!nextText && nextAttachments.length === 0) || !selectedSessionKey) {
      return;
    }

    const previousMessages = messages;
    const previousInput = chatInput;
    const previousAttachments = pendingAttachments;
    const optimisticMessage: ChatMessage = {
      id: `optimistic-${Date.now()}`,
      sessionId: selectedSessionKey,
      role: "user",
      text: nextText || "Inspect the attached files.",
      parts: [
        ...(nextAttachments.length > 0
          ? [
              {
                type: "attachments" as const,
                attachments: nextAttachments,
              },
            ]
          : []),
        {
          type: "markdown" as const,
          text: nextText || "Inspect the attached files.",
        },
      ],
      attachments: nextAttachments,
      createdAt: new Date().toISOString(),
      status: "complete",
      source: "web",
    };

    queryClient.setQueryData<ChatMessage[]>(
      ["sessions", selectedSessionKey, "messages"],
      [...messages, optimisticMessage],
    );

    trackChatSubmit(selectedSessionKey);
    setChatInput("");
    setPendingAttachments([]);

    try {
      const sentLive =
        transportReady &&
        sendRealtimeCommand({
          type: "chat.send",
          payload: {
            sessionId: selectedSessionKey,
            text: nextText,
            attachments: nextAttachments,
          },
        });
      if (!sentLive) {
        await postJson(
          `/api/sessions/${encodeURIComponent(selectedSessionKey)}/messages`,
          {
            text: nextText,
            attachments: nextAttachments,
          },
        );
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({
          queryKey: ["sessions", selectedSessionKey, "messages"],
        }),
      ]);
    } catch (error) {
      trackChatFailure(
        selectedSessionKey,
        error instanceof Error
          ? error.message
          : "Failed to send the message to DroidAgent.",
      );
      queryClient.setQueryData<ChatMessage[]>(
        ["sessions", selectedSessionKey, "messages"],
        previousMessages,
      );
      setChatInput(previousInput);
      setPendingAttachments(previousAttachments);
      throw error;
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void runAction(async () => {
      await handleSendChat();
    });
  }

  function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files ?? []);
    if (files.length === 0) {
      return;
    }

    event.preventDefault();
    void runAction(async () => {
      await uploadFiles(files);
    });
  }

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
            <span
              className={`status-chip${memory?.semanticReady ? " ready" : ""}`}
            >
              {memory?.semanticReady ? "Memory indexed" : "Memory pending"}
            </span>
            <span className={`status-chip${approvalCount > 0 ? "" : " ready"}`}>
              {approvalCount > 0
                ? `${approvalCount} approval${approvalCount === 1 ? "" : "s"}`
                : `${availableTools.length} tools ready`}
            </span>
          </div>

          {visibleLiveMetrics.length > 0 || hostPressureLevel !== "unknown" ? (
            <div className="metric-strip operator-metrics">
              {visibleLiveMetrics.map((metric) => (
                <div key={metric.label} className="metric-chip">
                  <strong>{metric.label}</strong>
                  <span>{metric.value}</span>
                </div>
              ))}
              {hostPressureLevel !== "unknown" ? (
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
        <article className="operator-thread-window panel-card compact">
          <div className="operator-window-head">
            <div className="operator-window-copy">
              <div className="journey-kicker">Transcript</div>
              <h3>Transcript</h3>
            </div>
            <small>
              {activeSession?.title ?? "Operator Chat"} • {messages.length}
              {streaming ? "+" : ""} message{messages.length === 1 ? "" : "s"}
            </small>
          </div>

          <div className="operator-window-surface operator-thread-surface">
            {showTranscriptAlerts ? (
              <div className="operator-transcript-alerts">
                {maintenanceActive ? (
                  <div className="operator-run-strip failed">
                    <strong>
                      {maintenance?.current?.message ?? "Maintenance in progress"}
                    </strong>
                    <span>
                      {maintenance?.current?.phase
                        ? `New work is blocked while the host is ${maintenance.current.phase}.`
                        : "New work is blocked until maintenance completes."}
                    </span>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div ref={threadRef} className="chat-message-list operator-thread">
              {historyQuery.isLoading ? (
                <article className="panel-card compact">
                  Loading session history...
                </article>
              ) : null}
              {historyQuery.isError ? (
                <article className="panel-card compact conflict-card">
                  Failed to load session history. Reconnect and try again.
                </article>
              ) : null}
              {!historyQuery.isLoading &&
              !historyQuery.isError &&
              messages.length === 0 &&
              !streaming &&
              !activeRun?.active &&
              !chatFeedback &&
              !commandJob ? (
                <article className="panel-card compact">
                  This chat is empty. Start with a prompt, attach files, or restore an archived chat from the rail.
                </article>
              ) : null}
              {messages.map((message) => (
                <article
                  key={message.id}
                  className={`message-card ${message.role}`}
                >
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
                              : null) ??
                            (approvals.length === 1 ? approvals[0]! : null))
                          : null;

                  return (
                        <MessagePartView
                          key={`${message.id}-${part.type}-${index}`}
                          part={part}
                          approval={approval}
                          commandActionDisabledReason={
                            pressureBlocks
                              ? hostPressure?.message ??
                                "Host pressure is critical. New jobs are paused."
                              : null
                          }
                          commandActionsEnabled={!pressureBlocks}
                          onRunCommand={(command) => {
                            void runAction(async () => {
                              await handleRunSuggestedCommand(command);
                            }, "Command running in chat. DroidAgent will relay the real output back into this session.");
                          }}
                          onOpenInTerminal={(command) => {
                            handleOpenInTerminal(command);
                          }}
                          onOpenImage={(image) => {
                            setExpandedImage(image);
                          }}
                          onResolveApproval={(approvalId, resolution) => {
                            void runAction(async () => {
                              await handleResolveApproval(
                                approvalId,
                                resolution,
                              );
                            });
                          }}
                        />
                      );
                    })}
                  </div>

                  {message.text.trim() ? (
                    <MessageMemoryActions
                      onAddMemory={() =>
                        void runAction(async () => {
                          await handleCreateMemoryDraft("memory", message);
                        }, "Draft added to durable memory.")
                      }
                      onAddPreferences={() =>
                        void runAction(async () => {
                          await handleCreateMemoryDraft(
                            "preferences",
                            message,
                          );
                        }, "Draft added to preferences.")
                      }
                      onAddTodayNote={() =>
                        void runAction(async () => {
                          await handleCreateMemoryDraft("todayNote", message);
                        }, "Draft added to today's note.")
                      }
                    />
                  ) : null}
                </article>
              ))}

              {showPendingAssistantCard ? (
                <PendingAssistantCard
                  activeRun={activeRun ?? null}
                  approval={activeRunApproval}
                  chatFeedback={chatFeedback}
                  onResolveApproval={(approvalId, resolution) => {
                    void runAction(async () => {
                      await handleResolveApproval(approvalId, resolution);
                    });
                  }}
                />
              ) : null}

              {commandJob ? (
                <CommandRelayCard
                  commandJob={commandJob}
                  commandRelayError={commandRelayError}
                  commandRelayStatus={commandRelayStatus}
                  onClear={() => {
                    setCommandJobId(null);
                    setCommandRelaySessionId(null);
                    setCommandRelayStatus("idle");
                    setCommandRelayError(null);
                  }}
                  output={commandJobOutputQuery.data}
                />
              ) : null}

              {streaming ? (
                <article className="message-card assistant streaming">
                  <div className="message-meta">
                    <div className="message-meta-copy">
                      <header>DroidAgent</header>
                      <span>Live</span>
                    </div>
                  </div>
                  <div className="message-markdown">
                    <StreamingMarkdown
                      onOpenImage={(image) => {
                        setExpandedImage(image);
                      }}
                      text={
                        streaming.text ||
                        "Working through the live OpenClaw run..."
                      }
                    />
                  </div>
                </article>
              ) : null}
            </div>
          </div>
        </article>

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
                      void handleSelectSession(event.target.value);
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
                  <span>{messages.length + (streaming ? 1 : 0)} visible items</span>
                  <span>{transportReady ? "WebSocket live" : "HTTP fallback"}</span>
                </div>
              )}
              <div className="message-action-row compact">
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    void runAction(async () => {
                      await handleStartFreshSession();
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
                      await handleCloseCurrentSession();
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
                    <div
                      key={session.id}
                      className="operator-session-archive-card"
                    >
                      <div>
                        <strong>{session.title}</strong>
                        <span>{session.lastMessagePreview || "No preview yet"}</span>
                      </div>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() =>
                          void runAction(async () => {
                            await handleRestoreSession(session.id);
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
                        await handleAbortRun();
                      }, "Live run stopped.")
                    }
                  >
                    Stop run
                  </button>
                ) : null}
                {hostPressure?.activeJobs ? (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      void runAction(async () => {
                        await handleRecoverHostPressure({
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
                        await handleRecoverHostPressure({
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
                <button
                  type="button"
                  className={hostPressureLevel === "critical" ? "" : "secondary"}
                  onClick={() =>
                    void runAction(async () => {
                      await handleRecoverHostPressure();
                    }, "Recovery cycle completed.")
                  }
                >
                  Cleanup cycle
                </button>
              </div>
            </section>

            {activeRun ? (
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
                  </div>
                  {activeRun.stage === "approval_required" ? (
                    <ApprovalCard
                      approval={activeRunApproval}
                      onResolve={(approvalId, resolution) => {
                        void runAction(async () => {
                          await handleResolveApproval(approvalId, resolution);
                        });
                      }}
                    />
                  ) : null}
                </div>
              </section>
            ) : null}

          </div>
        </aside>
      </section>

      <form className="operator-composer-window panel-card compact" onSubmit={handleSubmit}>
        <div className="operator-window-head">
          <div className="operator-window-copy">
            <div className="journey-kicker">Compose</div>
            <h3>Ask DroidAgent</h3>
          </div>
          <small>
            {commandJob
              ? "Command relay active"
              : activeRun?.active
              ? "Live run"
              : maintenanceActive
                ? "Maintenance active"
                : pressureBlocks
                  ? "Type preserved • sending paused"
                  : harnessReady
                    ? "Ready to send"
                    : "Agent unavailable"}
          </small>
        </div>

        <div className="composer-shell operator-window-surface operator-composer-surface">
          <PendingAttachmentList
            attachments={pendingAttachments}
            onRemove={(attachmentId) =>
              setPendingAttachments((current) =>
                current.filter((entry) => entry.id !== attachmentId),
              )
            }
          />

          <textarea
            value={chatInput}
            onChange={(event) => setChatInput(event.target.value)}
            onPaste={handleComposerPaste}
            placeholder="Ask DroidAgent to inspect code, summarize a PDF, analyze an image, edit files, or run a command..."
            disabled={uploadingAttachments || maintenanceActive}
          />

          <div className="composer-footer">
            <small className="composer-status">
              {commandJob
                ? `${commandRelaySummary(commandJob, commandRelayStatus).title} • ${
                    commandJob.lastLine || commandRelaySummary(commandJob, commandRelayStatus).detail
                  }`
                : activeRun?.active
                ? `${activeRun.label}${activeRun.detail ? ` • ${activeRun.detail}` : ""}`
                : maintenanceActive
                  ? maintenance?.current?.message ??
                    "Maintenance is active. New work is temporarily blocked."
                : pressureBlocks
                  ? `${
                      hostPressure?.message ??
                      "Host pressure is critical. New chat runs are temporarily paused."
                    } Use Cleanup cycle, stop jobs, or start a fresh chat while you wait.`
                : harnessReady
                  ? `${availableTools.length} tools ready. Paste or attach files below.`
                  : "The live OpenClaw path is not ready yet."}
            </small>

            <div className="composer-actions">
              <input
                ref={fileInputRef}
                className="hidden-file-input"
                type="file"
                multiple
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  void runAction(async () => {
                    await uploadFiles(files);
                  });
                }}
              />
              <button
                type="button"
                className="secondary"
                disabled={uploadingAttachments}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploadingAttachments ? "Attaching..." : "Attach"}
              </button>
              {activeRun?.active ? (
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    void runAction(async () => {
                      await handleAbortRun();
                    })
                  }
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
                    : undefined
                }
                disabled={
                  !harnessReady ||
                  pressureBlocks ||
                  uploadingAttachments ||
                  (!chatInput.trim() && pendingAttachments.length === 0)
                }
              >
                Send
              </button>
            </div>
          </div>
        </div>
      </form>
      </section>
      {expandedImage ? (
        <div
          className="image-lightbox"
          role="dialog"
          aria-modal="true"
          onClick={() => setExpandedImage(null)}
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
                onClick={() => setExpandedImage(null)}
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
      ) : null}
    </>
  );
}
