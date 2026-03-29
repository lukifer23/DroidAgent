import {
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ChatAttachment,
  ChatMessage,
  LatencySummary,
} from "@droidagent/shared";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { useAuthQuery, useDashboardQuery, usePerformanceQuery } from "../app-data";
import { useDroidAgentApp } from "../app-context";
import { api, postFormData, postJson } from "../lib/api";
import { useStreamingRuns } from "../lib/chat-stream-store";
import { formatTokenBudget } from "../lib/formatters";

function roleLabel(role: ChatMessage["role"]): string {
  if (role === "tool") {
    return "Tool output";
  }

  if (role === "system") {
    return "System";
  }

  return role.charAt(0).toUpperCase() + role.slice(1);
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
  if (!summary?.p95DurationMs || !Number.isFinite(summary.p95DurationMs)) {
    return "n/a";
  }

  if (summary.p95DurationMs >= 1000) {
    return `${(summary.p95DurationMs / 1000).toFixed(1)}s`;
  }

  return `${Math.round(summary.p95DurationMs)} ms`;
}

function formatToolName(value: string): string {
  return value
    .split(/[_:]/g)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function isToolTranscript(message: ChatMessage): boolean {
  return (
    message.role === "tool" ||
    message.role === "system" ||
    /^Tool (call|result)/.test(message.text)
  );
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

function MessageAttachments({ attachments }: { attachments: ChatAttachment[] }) {
  if (attachments.length === 0) {
    return null;
  }

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

function MessageBody({ message }: { message: ChatMessage }) {
  if (isToolTranscript(message)) {
    return (
      <details className="message-details" open={message.role === "tool"}>
        <summary>
          {message.role === "tool"
            ? "Inspect tool output"
            : "Inspect tool transcript"}
        </summary>
        <pre>{message.text}</pre>
      </details>
    );
  }

  return (
    <div className="message-markdown">
      <ChatMarkdown text={message.text} />
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
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const {
    selectedSessionId,
    setSelectedSessionId,
    sendRealtimeCommand,
    trackChatSubmit,
    runAction,
    setNotice,
    wsStatus,
  } = useDroidAgentApp();
  const authQuery = useAuthQuery();
  const dashboardQuery = useDashboardQuery(Boolean(authQuery.data?.user));
  const performanceQuery = usePerformanceQuery(Boolean(authQuery.data?.user));
  const dashboard = dashboardQuery.data;
  const performance = performanceQuery.data;
  const streamingRuns = useStreamingRuns();
  const [chatInput, setChatInput] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>(
    [],
  );
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [pendingRun, setPendingRun] = useState<{
    sessionId: string;
    sentAt: number;
  } | null>(null);

  const sessions = dashboard?.sessions ?? [];
  const activeSession =
    sessions.find((session) => session.id === selectedSessionId) ?? sessions[0];
  const selectedSessionKey = activeSession?.id ?? selectedSessionId;
  const streaming = selectedSessionKey
    ? streamingRuns[selectedSessionKey]
    : undefined;
  const transportReady = wsStatus === "connected" && Boolean(selectedSessionKey);
  const activeProvider = dashboard?.providers.find((provider) => provider.enabled);
  const openclawRuntime = dashboard?.runtimes.find(
    (runtime) => runtime.id === "openclaw",
  );
  const harness = dashboard?.harness;

  const messagesQuery = useQuery({
    queryKey: ["sessions", selectedSessionKey, "messages"],
    queryFn: () =>
      api<ChatMessage[]>(
        `/api/sessions/${encodeURIComponent(selectedSessionKey)}/messages`,
      ),
    enabled: Boolean(authQuery.data?.user && selectedSessionKey),
    staleTime: 15_000,
  });

  const messages = useMemo(() => messagesQuery.data ?? [], [messagesQuery.data]);
  const agentReady =
    openclawRuntime?.state === "running" &&
    Boolean(activeProvider?.enabled) &&
    transportReady &&
    Boolean(harness?.configured);
  const metrics = useMemo(
    () => [
      {
        label: "First token",
        value: formatLatency(
          performance?.metrics.find(
            (metric) => metric.name === "client.chat.submit_to_first_token",
          )?.summary,
        ),
      },
      {
        label: "Reply done",
        value: formatLatency(
          performance?.metrics.find(
            (metric) => metric.name === "client.chat.submit_to_done",
          )?.summary,
        ),
      },
      {
        label: "Reconnect",
        value: formatLatency(
          performance?.metrics.find(
            (metric) => metric.name === "client.ws.reconnect_to_resync",
          )?.summary,
        ),
      },
    ],
    [performance?.metrics],
  );
  const capabilitySummary = [
    activeProvider?.model ?? "No active model",
    activeProvider?.contextWindow
      ? `${formatTokenBudget(activeProvider.contextWindow)} context`
      : "Context pending",
    harness?.attachmentsEnabled && harness?.imageModel
      ? `vision ${harness.imageModel.replace(/^ollama\//, "")}`
      : "attachments unavailable",
    dashboard?.memory.semanticReady ? "semantic memory ready" : "memory pending",
    harness?.availableTools.length
      ? `${harness.availableTools.length} tools`
      : "tool policy pending",
  ];

  useEffect(() => {
    if (!pendingRun || pendingRun.sessionId !== selectedSessionKey) {
      return;
    }

    if (streaming) {
      return;
    }

    const hasAssistantReply = messages.some(
      (message) =>
        message.role === "assistant" &&
        new Date(message.createdAt).getTime() >= pendingRun.sentAt,
    );

    if (hasAssistantReply) {
      setPendingRun(null);
    }
  }, [messages, pendingRun, selectedSessionKey, streaming]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });
  }, [messages.length, selectedSessionKey, streaming?.text]);

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
      setNotice(
        `${response.attachments.length} attachment${
          response.attachments.length === 1 ? "" : "s"
        } ready.`,
      );
    } finally {
      setUploadingAttachments(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
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
    const startedAt = Date.now();
    setPendingRun({
      sessionId: selectedSessionKey,
      sentAt: startedAt,
    });

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
      setPendingRun(null);
      throw error;
    }
  }

  return (
    <section className="chat-shell">
      <article className="chat-status-bar panel-card compact">
        <div className="chat-status-copy">
          <div className="journey-kicker">Live OpenClaw Session</div>
          <h2>{activeSession?.title ?? "Operator Chat"}</h2>
          <p>
            {agentReady
              ? "This is the real OpenClaw gateway session on your Mac. Files, edits, exec approvals, semantic memory, and multimodal attachments all flow through the live harness."
              : "The chat shell is loaded, but the live OpenClaw path is not fully ready yet."}
          </p>
        </div>
        <div className="chat-status-meta">
          <div className="status-chip-row">
            <span className={`status-chip${agentReady ? " ready" : ""}`}>
              {agentReady ? "Agent live" : "Agent unavailable"}
            </span>
            <span className={`status-chip${transportReady ? " ready" : ""}`}>
              {transportReady ? "WebSocket live" : "Reconnecting"}
            </span>
            <span
              className={`status-chip${dashboard?.memory.semanticReady ? " ready" : ""}`}
            >
              {dashboard?.memory.semanticReady
                ? "Memory indexed"
                : "Memory pending"}
            </span>
          </div>
          <div className="metric-strip compact">
            {metrics.map((metric) => (
              <article key={metric.label} className="metric-chip">
                <strong>{metric.label}</strong>
                <span>{metric.value}</span>
              </article>
            ))}
          </div>
        </div>
      </article>

      {sessions.length > 1 ? (
        <aside className="session-strip" aria-label="Sessions">
          {sessions.map((session) => (
            <button
              key={session.id}
              className={`session-pill${
                session.id === selectedSessionKey ? " active" : ""
              }`}
              onClick={() =>
                startTransition(() => {
                  setSelectedSessionId(session.id);
                })
              }
            >
              <strong>{session.title}</strong>
              <span>{session.lastMessagePreview || "No messages yet"}</span>
            </button>
          ))}
        </aside>
      ) : null}

      <div className="chat-surface">
        <div className="chat-surface-header">
          <div className="chat-capability-row">
            {capabilitySummary.map((entry) => (
              <span key={entry} className="status-chip ready">
                {entry}
              </span>
            ))}
          </div>
          {harness?.availableTools.length ? (
            <details className="chat-tools-panel">
              <summary>Available tools and permissions</summary>
              <div className="tool-pill-grid">
                {harness.availableTools.map((tool) => (
                  <span key={tool} className="tool-pill">
                    {formatToolName(tool)}
                  </span>
                ))}
              </div>
              <small>
                Exec policy: {harness.execHost} • {harness.execSecurity} •{" "}
                {harness.execAsk}
              </small>
            </details>
          ) : null}
        </div>

        {(dashboard?.approvals ?? []).length > 0 ? (
          <article className="approval-banner panel-card compact">
            <div>
              <strong>Action needed</strong>
              <small>
                The agent is waiting on {dashboard?.approvals.length} approval
                {dashboard?.approvals.length === 1 ? "" : "s"} before it can
                continue a command.
              </small>
            </div>
            <div className="button-row compact-actions">
              {dashboard?.approvals.map((approval) => (
                <button
                  key={approval.id}
                  className="secondary"
                  onClick={() =>
                    void runAction(async () => {
                      await postJson(`/api/approvals/${approval.id}`, {
                        resolution: "approved",
                      });
                    }, "Approval granted.")
                  }
                >
                  Approve {approval.title}
                </button>
              ))}
            </div>
          </article>
        ) : null}

        <div className="chat-message-list">
          {messagesQuery.isLoading && messages.length === 0 ? (
            <article className="panel-card compact empty-thread">
              <strong>Loading the live session</strong>
              <small>Pulling the current OpenClaw thread from the gateway.</small>
            </article>
          ) : null}

          {messages.length === 0 && !streaming && !messagesQuery.isLoading ? (
            <article className="panel-card compact empty-thread">
              <strong>Fresh operator thread</strong>
              <small>
                Ask DroidAgent to inspect code, edit files, summarize a PDF,
                inspect an image, search memory, or run approved commands on
                this Mac.
              </small>
            </article>
          ) : null}

          {messages.map((message) => (
            <article key={message.id} className={`message-card ${message.role}`}>
              <div className="message-meta">
                <div className="message-meta-copy">
                  <header>{roleLabel(message.role)}</header>
                  <span>{formatMessageTime(message.createdAt)}</span>
                </div>
                <CopyButton text={message.text} />
              </div>
              <MessageAttachments attachments={message.attachments} />
              <MessageBody message={message} />
            </article>
          ))}

          {streaming ? (
            <article className="message-card assistant streaming">
              <div className="message-meta">
                <div className="message-meta-copy">
                  <header>Assistant</header>
                  <span>live</span>
                </div>
              </div>
              <p>{streaming.text || "Starting the run..."}</p>
            </article>
          ) : pendingRun?.sessionId === selectedSessionKey ? (
            <article className="message-card assistant streaming pending">
              <div className="message-meta">
                <div className="message-meta-copy">
                  <header>Assistant</header>
                  <span>queued</span>
                </div>
              </div>
              <p>Starting the OpenClaw run…</p>
            </article>
          ) : null}
          <div ref={threadEndRef} />
        </div>

        <form
          className="composer composer-rich"
          onSubmit={(event) => {
            event.preventDefault();
            void runAction(handleSendChat);
          }}
        >
          <div className="composer-shell">
            <PendingAttachmentList
              attachments={pendingAttachments}
              onRemove={(attachmentId) =>
                setPendingAttachments((current) =>
                  current.filter((attachment) => attachment.id !== attachmentId),
                )
              }
            />

            <textarea
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files ?? []);
                if (files.length === 0) {
                  return;
                }
                event.preventDefault();
                void runAction(async () => {
                  await uploadFiles(files);
                });
              }}
              placeholder="Ask DroidAgent to inspect code, summarize a PDF, analyze an image, edit files, or run an approved command..."
              disabled={!selectedSessionKey}
            />
            <small className="composer-status">
              {agentReady
                ? `Live OpenClaw session ready. ${harness?.toolProfile ?? "coding"} tools, ${harness?.execAsk ?? "on-miss"} exec approvals, ${harness?.imageModel ? "multimodal attachments" : "text chat"}, and ${dashboard?.memory.semanticReady ? "semantic memory" : "memory indexing"} are active.`
                : "The live agent path is not fully ready yet. Fix the harness/runtime path before sending the next run."}
            </small>
          </div>

          <div className="composer-actions">
            <input
              ref={fileInputRef}
              accept="image/*,.pdf,.md,.markdown,.txt,.log,.json,.yaml,.yml,.toml,.csv,.xml,.js,.jsx,.ts,.tsx,.py,.rb,.go,.rs,.java,.sh,.zsh"
              className="hidden-file-input"
              multiple
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                void runAction(async () => {
                  await uploadFiles(files);
                });
              }}
              type="file"
            />
            <button
              type="button"
              className="secondary"
              disabled={!agentReady || uploadingAttachments}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploadingAttachments ? "Uploading…" : "Attach"}
            </button>
            <button
              type="submit"
              disabled={
                !agentReady ||
                (!chatInput.trim() && pendingAttachments.length === 0) ||
                uploadingAttachments
              }
            >
              {pendingRun?.sessionId === selectedSessionKey || streaming
                ? "Working…"
                : "Send"}
            </button>
            {streaming ? (
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  void runAction(async () => {
                    const aborted =
                      wsStatus === "connected" &&
                      sendRealtimeCommand({
                        type: "chat.abort",
                        payload: {
                          sessionId: selectedSessionKey,
                        },
                      });
                    if (!aborted) {
                      await postJson(
                        `/api/sessions/${encodeURIComponent(selectedSessionKey)}/abort`,
                        {},
                      );
                    }
                  }, "Run aborted.")
                }
              >
                Abort
              </button>
            ) : null}
          </div>
        </form>
      </div>
    </section>
  );
}
