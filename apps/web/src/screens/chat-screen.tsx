import {
  type ClipboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ApprovalRecord,
  ChatAttachment,
  ChatMessage,
  ChatMessagePart,
  LatencySummary,
} from "@droidagent/shared";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { useAuthQuery, useDashboardQuery } from "../app-data";
import {
  useClientPerformanceSnapshot,
  useDroidAgentApp,
} from "../app-context";
import { api, postFormData, postJson } from "../lib/api";
import { useChatRuns } from "../lib/chat-run-store";
import { useStreamingRuns } from "../lib/chat-stream-store";
import { formatTokenBudget } from "../lib/formatters";

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
}: {
  text: string;
  className: string | undefined;
}) {
  return (
    <div className="markdown-code-shell">
      <div className="markdown-code-toolbar">
        <span>{className?.replace("language-", "") || "code"}</span>
        <CopyButton text={text} label="Copy code" />
      </div>
      <pre className="markdown-pre">
        <code className={className}>{text}</code>
      </pre>
    </div>
  );
}

function ChatMarkdown({ text }: { text: string }) {
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
            <MarkdownCodeBlock className={className} text={content} />
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

function MessagePartView({
  part,
  approval,
  onResolveApproval,
}: {
  part: ChatMessagePart;
  approval: ApprovalRecord | null;
  onResolveApproval: (approvalId: string, resolution: "approved" | "denied") => void;
}) {
  if (part.type === "markdown") {
    return (
      <div className="message-markdown">
        <ChatMarkdown text={part.text} />
      </div>
    );
  }

  if (part.type === "attachments") {
    return <AttachmentPart attachments={part.attachments} />;
  }

  if (part.type === "code_block") {
    return <MarkdownCodeBlock className={part.language ?? undefined} text={part.code} />;
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
}

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

export function ChatScreen() {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const {
    selectedSessionId,
    setSelectedSessionId,
    sendRealtimeCommand,
    trackChatSubmit,
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

  const sessions = dashboard?.sessions ?? [];
  const activeSession =
    sessions.find((session) => session.id === selectedSessionId) ?? sessions[0];
  const selectedSessionKey = activeSession?.id ?? selectedSessionId;
  const activeRun = selectedSessionKey ? runStates[selectedSessionKey] : null;
  const streaming = selectedSessionKey
    ? streamingRuns[selectedSessionKey]
    : undefined;
  const activeProvider = dashboard?.providers.find((provider) => provider.enabled);
  const openclawRuntime = dashboard?.runtimes.find(
    (runtime) => runtime.id === "openclaw",
  );
  const harness = dashboard?.harness;
  const transportReady = wsStatus === "connected" && Boolean(selectedSessionKey);
  const agentReady =
    openclawRuntime?.state === "running" &&
    Boolean(activeProvider?.enabled) &&
    Boolean(harness?.configured);
  const approvalCount = dashboard?.approvals.length ?? 0;

  const historyQuery = useQuery({
    queryKey: ["sessions", selectedSessionKey, "messages"],
    queryFn: () =>
      api<ChatMessage[]>(
        `/api/sessions/${encodeURIComponent(selectedSessionKey)}/messages`,
      ),
    enabled: Boolean(authQuery.data?.user && selectedSessionKey),
    staleTime: 15_000,
  });

  const messages = useMemo(() => historyQuery.data ?? [], [historyQuery.data]);
  const liveMetrics = useMemo(
    () => [
      {
        label: "First token",
        value: formatLatency(
          clientPerformanceSnapshot.metrics.find(
            (metric) => metric.name === "client.chat.submit_to_first_token",
          )?.summary,
        ),
      },
      {
        label: "Reply done",
        value: formatLatency(
          clientPerformanceSnapshot.metrics.find(
            (metric) => metric.name === "client.chat.submit_to_done",
          )?.summary,
        ),
      },
      {
        label: "Reconnect",
        value: formatLatency(
          clientPerformanceSnapshot.metrics.find(
            (metric) => metric.name === "client.ws.reconnect_to_resync",
          )?.summary,
        ),
      },
    ],
    [clientPerformanceSnapshot.metrics],
  );

  const headerFacts = [
    activeProvider?.model ?? "No active model",
    activeProvider?.contextWindow
      ? formatTokenBudget(activeProvider.contextWindow)
      : "context pending",
    dashboard?.memory.semanticReady ? "memory indexed" : "memory pending",
    harness?.attachmentsEnabled && harness?.imageModel
      ? `vision ${harness.imageModel.replace(/^ollama\//, "")}`
      : "attachments unavailable",
  ];

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

    container.scrollTop = container.scrollHeight;
  }, [messages.length, selectedSessionKey, streaming?.text, activeRun?.updatedAt]);

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

  async function handleSendChat() {
    const nextText = chatInput.trim();
    const nextAttachments = pendingAttachments;
    if ((!nextText && nextAttachments.length === 0) || !selectedSessionKey) {
      return;
    }

    const previousMessages = messages;
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
      setChatInput("");
      setPendingAttachments([]);
    } catch (error) {
      queryClient.setQueryData<ChatMessage[]>(
        ["sessions", selectedSessionKey, "messages"],
        previousMessages,
      );
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
      <article className="operator-chat-header panel-card compact">
        <div className="operator-chat-copy">
          <div className="journey-kicker">Live operator session</div>
          <h2>{activeSession?.title ?? "Operator Chat"}</h2>
          <p>
            Real OpenClaw session on your Mac with local tools, workspace
            access, approvals, semantic memory, and multimodal attachments.
          </p>

          <div className="operator-fact-row">
            {headerFacts.map((fact) => (
              <span key={fact} className="operator-fact-chip">
                {fact}
              </span>
            ))}
          </div>
        </div>

        <div className="operator-chat-meta">
          <div
            className={`operator-run-strip${activeRun?.stage ? ` ${activeRun.stage}` : ""}`}
          >
            <strong>
              {activeRun?.label ??
                (agentReady ? "Ready for a live run" : "OpenClaw is not ready")}
            </strong>
            <span>
              {activeRun?.detail ??
                (agentReady
                  ? "Messages, tools, and attachments route through the live harness."
                  : "Finish local runtime and gateway startup before sending a request.")}
            </span>
          </div>

          <div className="status-chip-row">
            <span className={`status-chip${agentReady ? " ready" : ""}`}>
              {agentReady ? "Agent live" : "Agent unavailable"}
            </span>
            <span className={`status-chip${transportReady ? " ready" : ""}`}>
              {transportReady ? "WebSocket live" : "HTTP fallback"}
            </span>
            <span
              className={`status-chip${dashboard?.memory.semanticReady ? " ready" : ""}`}
            >
              {dashboard?.memory.semanticReady ? "Memory indexed" : "Memory pending"}
            </span>
            <span className={`status-chip${approvalCount > 0 ? "" : " ready"}`}>
              {approvalCount > 0
                ? `${approvalCount} approval${approvalCount === 1 ? "" : "s"}`
                : `${harness?.availableTools.length ?? 0} tools ready`}
            </span>
          </div>

          <div className="metric-strip operator-metrics">
            {liveMetrics.map((metric) => (
              <div key={metric.label} className="metric-chip">
                <strong>{metric.label}</strong>
                <span>{metric.value}</span>
              </div>
            ))}
          </div>
        </div>
      </article>

      {sessions.length > 1 ? (
        <div className="session-strip operator-session-strip">
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className={`session-pill${session.id === selectedSessionKey ? " active" : ""}`}
              onClick={() => setSelectedSessionId(session.id)}
            >
              <strong>{session.title}</strong>
              <span>{session.lastMessagePreview}</span>
            </button>
          ))}
        </div>
      ) : null}

      <details className="chat-tools-panel operator-tools-panel">
        <summary>Capabilities and permissions</summary>
        <div className="tool-pill-grid">
          {harness?.availableTools.map((tool) => (
            <span key={tool} className="tool-pill">
              {tool.replace(/[_:]/g, " ")}
            </span>
          ))}
        </div>
        <div className="operator-tools-copy">
          <small>
            Exec host: {harness?.execHost ?? "unknown"} • security:{" "}
            {harness?.execSecurity ?? "unknown"} • ask policy:{" "}
            {harness?.execAsk ?? "unknown"}
          </small>
          <small>
            Workspace-only FS: {harness?.workspaceOnlyFs ? "yes" : "no"} •
            session memory: {harness?.sessionMemoryEnabled ? "on" : "off"}
          </small>
        </div>
      </details>

      <article className="chat-thread-panel panel-card compact">
        <div ref={threadRef} className="chat-message-list operator-thread">
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
                {message.text ? <CopyButton text={message.text} /> : null}
              </div>

              <div className="message-part-stack">
                {(message.parts.length > 0
                  ? message.parts
                  : [
                      {
                        type: "markdown",
                        text: message.text,
                      } as const,
                    ]
                ).map((part, index) => {
                  const approval =
                    part.type === "approval_request"
                      ? dashboard?.approvals.find(
                          (entry) =>
                            part.approvalId && entry.id === part.approvalId,
                        ) ??
                        (dashboard?.approvals.length === 1
                          ? dashboard.approvals[0]!
                          : null)
                      : null;

                  return (
                    <MessagePartView
                      key={`${message.id}-${part.type}-${index}`}
                      part={part}
                      approval={approval}
                      onResolveApproval={(approvalId, resolution) => {
                        void runAction(async () => {
                          await handleResolveApproval(approvalId, resolution);
                        });
                      }}
                    />
                  );
                })}
              </div>
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
                <ChatMarkdown
                  text={
                    streaming.text ||
                    "Working through the live OpenClaw run..."
                  }
                />
              </div>
            </article>
          ) : null}

          {activeRun ? (
            <article
              className={`run-state-card ${activeRun.active ? "active" : "complete"} ${activeRun.stage}`}
            >
              <div>
                <strong>{activeRun.label}</strong>
                {activeRun.detail ? <p>{activeRun.detail}</p> : null}
              </div>
              {activeRun.stage === "approval_required" ? (
                <ApprovalCard
                  approval={
                    dashboard?.approvals.find(
                      (approval) =>
                        activeRun.approvalId &&
                        approval.id === activeRun.approvalId,
                    ) ?? (dashboard?.approvals.length === 1
                      ? dashboard.approvals[0]!
                      : null)
                  }
                  onResolve={(approvalId, resolution) => {
                    void runAction(async () => {
                      await handleResolveApproval(approvalId, resolution);
                    });
                  }}
                />
              ) : null}
            </article>
          ) : null}
        </div>
      </article>

      <form className="composer composer-rich operator-composer" onSubmit={handleSubmit}>
        <div className="composer-shell">
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
            disabled={!agentReady || uploadingAttachments}
          />

          <div className="composer-footer">
            <small className="composer-status">
              {activeRun?.active
                ? `${activeRun.label}${activeRun.detail ? ` • ${activeRun.detail}` : ""}`
                : agentReady
                  ? `Live OpenClaw session ready. ${harness?.availableTools.length ?? 0} tools available. Paste images or files directly into the composer, or attach them below.`
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
                disabled={
                  !agentReady ||
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
