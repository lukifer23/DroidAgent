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
  useClientPerformanceSnapshot,
  useDroidAgentApp,
} from "../app-context";
import { api, postFormData, postJson } from "../lib/api";
import { extractRunnableCommand } from "../lib/command-suggestions";
import { useChatRuns } from "../lib/chat-run-store";
import { useStreamingRuns } from "../lib/chat-stream-store";
import { formatTokenBudget } from "../lib/formatters";

const TERMINAL_PREFILL_STORAGE_KEY = "droidagent-terminal-prefill";

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

function createFreshSessionSummary(sessionId?: string): SessionSummary {
  const createdAt = new Date().toISOString();
  return {
    id: sessionId ?? `web:fresh:${Date.now().toString(36)}`,
    title: "Fresh Operator Chat",
    scope: "web",
    updatedAt: createdAt,
    unreadCount: 0,
    lastMessagePreview: "Fresh chat ready. Type when you are ready to retry.",
  };
}

function isFreshSessionId(sessionId: string | null | undefined): boolean {
  return typeof sessionId === "string" && sessionId.startsWith("web:fresh:");
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
      ) : null}
    </div>
  );
}

function ChatMarkdown({
  text,
  onRunCommand,
  onOpenInTerminal,
  commandActionsEnabled = true,
  commandActionDisabledReason,
}: {
  text: string;
  onRunCommand?: ((command: string) => void) | null | undefined;
  onOpenInTerminal?: ((command: string) => void) | null | undefined;
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
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

function StreamingMarkdown({ text }: { text: string }) {
  if (!text.includes("\n") && !/[`*_#[\]-]/.test(text)) {
    return <p>{text}</p>;
  }

  return (
    <div className="message-markdown">
      <ChatMarkdown text={text} />
    </div>
  );
}

function AttachmentPart({
  attachments,
}: {
  attachments: ChatAttachment[];
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
            <a
              key={attachment.id}
              className="attachment-image-card"
              href={attachment.url}
              rel="noreferrer"
              target="_blank"
            >
              <img alt={attachment.name} loading="lazy" src={attachment.url} />
              <span>{attachment.name}</span>
            </a>
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
  commandActionsEnabled,
  commandActionDisabledReason,
}: {
  part: ChatMessagePart;
  approval: ApprovalRecord | null;
  onResolveApproval: (approvalId: string, resolution: "approved" | "denied") => void;
  onRunCommand: (command: string) => void;
  onOpenInTerminal: (command: string) => void;
  commandActionsEnabled: boolean;
  commandActionDisabledReason?: string | null | undefined;
}) {
  if (part.type === "markdown") {
    return (
      <div className="message-markdown">
        <ChatMarkdown
          commandActionDisabledReason={commandActionDisabledReason}
          commandActionsEnabled={commandActionsEnabled}
          onOpenInTerminal={onOpenInTerminal}
          onRunCommand={onRunCommand}
          text={part.text}
        />
      </div>
    );
  }

  if (part.type === "attachments") {
    return <AttachmentPart attachments={part.attachments} />;
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
      <summary>Save</summary>
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
    selectedSessionId,
    setSelectedSessionId,
    sendRealtimeCommand,
    trackChatSubmit,
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
    "idle" | "running" | "complete" | "failed"
  >("idle");
  const [commandRelayError, setCommandRelayError] = useState<string | null>(
    null,
  );
  const relayedCommandJobsRef = useRef<Set<string>>(new Set());

  const dashboardSessions = dashboard?.sessions ?? [];
  const approvals = dashboard?.approvals ?? [];
  const providers = dashboard?.providers ?? [];
  const runtimes = dashboard?.runtimes ?? [];
  const jobs = dashboard?.jobs ?? [];
  const sessions = dashboardSessions;
  const selectedDashboardSession =
    sessions.find((session) => session.id === selectedSessionId) ?? null;
  const activeSession =
    selectedDashboardSession ??
    (isFreshSessionId(selectedSessionId)
      ? createFreshSessionSummary(selectedSessionId)
      : sessions[0]);
  const selectedSessionKey = activeSession?.id ?? selectedSessionId;
  const activeRun = selectedSessionKey ? runStates[selectedSessionKey] : null;
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
  const isLocalSession =
    isFreshSessionId(selectedSessionKey) && !selectedDashboardSession;
  const sessionOptions = useMemo(() => {
    const next = [...sessions];
    if (
      activeSession &&
      !next.some((session) => session.id === activeSession.id)
    ) {
      next.unshift(activeSession);
    }
    return next;
  }, [activeSession, sessions]);
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

  const historyQuery = useQuery({
    queryKey: ["sessions", selectedSessionKey, "messages"],
    queryFn: () =>
      api<ChatMessage[]>(
        `/api/sessions/${encodeURIComponent(selectedSessionKey)}/messages`,
      ),
    enabled: Boolean(authQuery.data?.user && selectedSessionKey),
    staleTime: 15_000,
  });

  const commandJobOutputQuery = useQuery({
    queryKey: ["jobs", commandJobId, "output"],
    queryFn: () =>
      api<JobOutputSnapshot>(
        `/api/jobs/${encodeURIComponent(commandJobId ?? "")}/output`,
      ),
    enabled: Boolean(commandJobId),
    refetchInterval:
      commandJob &&
      (commandJob.status === "queued" || commandJob.status === "running") &&
      wsStatus !== "connected"
        ? 1_000
        : false,
    staleTime: 1_000,
  });

  const messages = useMemo(() => historyQuery.data ?? [], [historyQuery.data]);
  const liveMetricMap = useMemo(
    () => new Map(clientPerformanceSnapshot.metrics.map((metric) => [metric.name, metric])),
    [clientPerformanceSnapshot.metrics],
  );

  const liveMetrics = useMemo(
    () => [
      {
        label: "First token",
        value: formatLatency(
          liveMetricMap.get("client.chat.submit_to_first_token")?.summary,
        ),
      },
      {
        label: "Reply done",
        value: formatLatency(
          liveMetricMap.get("client.chat.submit_to_done")?.summary,
        ),
      },
      {
        label: "Reconnect",
        value: formatLatency(
          liveMetricMap.get("client.ws.reconnect_to_resync")?.summary,
        ),
      },
    ],
    [liveMetricMap],
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
      commandRelayStatus === "running" ||
      commandRelayStatus === "complete" ||
      relayedCommandJobsRef.current.has(commandJobId)
    ) {
      return;
    }

    let cancelled = false;
    setCommandRelayStatus("running");
    setCommandRelayError(null);

    void (async () => {
      try {
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
    setCommandRelayStatus("idle");
    setCommandRelayError(null);
    await queryClient.invalidateQueries({ queryKey: ["jobs"] });
  }

  function handleOpenInTerminal(command: string) {
    window.sessionStorage.setItem(TERMINAL_PREFILL_STORAGE_KEY, command);
    void navigate({ to: "/terminal" });
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

  function handleStartFreshSession() {
    const freshSession = createFreshSessionSummary();
    setSelectedSessionId(freshSession.id);
    setChatInput("");
    setPendingAttachments([]);
    setCommandJobId(null);
    queryClient.setQueryData<ChatMessage[]>(
      ["sessions", freshSession.id, "messages"],
      [],
    );
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
              !streaming ? (
                <article className="panel-card compact">
                  {isLocalSession
                    ? "Fresh session ready. Type a prompt, attach files, or wait for host pressure cleanup to finish."
                    : "This session is empty. Start with a prompt or attach files."}
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
                            }, "Command started as a workspace job.");
                          }}
                          onOpenInTerminal={(command) => {
                            handleOpenInTerminal(command);
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
                    onChange={(event) => setSelectedSessionId(event.target.value)}
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
                  onClick={() => handleStartFreshSession()}
                >
                  Fresh chat
                </button>
              </div>
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
                      approval={
                        approvals.find(
                          (approval) =>
                            activeRun.approvalId &&
                            approval.id === activeRun.approvalId,
                        ) ?? (approvals.length === 1 ? approvals[0]! : null)
                      }
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

            {commandJob ? (
              <section className="operator-side-module">
                <div className="operator-side-module-head">
                  <strong>Command relay</strong>
                  <span>{commandJob.status}</span>
                </div>
                <article
                  className={`run-state-card chat-inline-job-card ${
                    commandJob.status === "failed"
                      ? "failed"
                      : commandJob.status === "running" ||
                          commandJob.status === "queued"
                        ? "active"
                        : "complete"
                  }`}
                >
                  <div className="chat-inline-job-head">
                    <div>
                      <strong>
                        {commandJob.status === "queued"
                          ? "Command queued in chat"
                          : commandJob.status === "running"
                            ? "Running command in chat"
                            : commandJob.status === "succeeded"
                              ? "Command finished"
                              : commandJob.status === "cancelled"
                                ? "Command cancelled"
                                : "Command failed"}
                      </strong>
                      <p>{commandJob.command}</p>
                    </div>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        setCommandJobId(null);
                        setCommandRelaySessionId(null);
                        setCommandRelayStatus("idle");
                        setCommandRelayError(null);
                      }}
                    >
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
                    <span>
                      {commandRelayStatus === "running"
                        ? "Sending result back into chat"
                        : commandRelayStatus === "complete"
                          ? "Result relayed into chat"
                          : commandRelayStatus === "failed"
                            ? "Relay failed"
                            : "Awaiting command completion"}
                    </span>
                    {commandRelayError ? <span>{commandRelayError}</span> : null}
                  </div>
                  {(commandJobOutputQuery.data?.stdout ||
                    commandJobOutputQuery.data?.stderr) ? (
                    <pre className="chat-inline-job-output">
                      {renderLogTail(
                        [
                          commandJobOutputQuery.data.stdout
                            ? `$ ${commandJob.command}\n${commandJobOutputQuery.data.stdout}`
                            : `$ ${commandJob.command}`,
                          commandJobOutputQuery.data.stderr
                            ? `stderr:\n${commandJobOutputQuery.data.stderr}`
                            : "",
                        ]
                          .filter(Boolean)
                          .join("\n\n"),
                      )}
                    </pre>
                  ) : null}
                </article>
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
            {activeRun?.active
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
              {activeRun?.active
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
  );
}
