import { startTransition, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChatMessage, LatencySummary } from "@droidagent/shared";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { useAuthQuery, useDashboardQuery, usePerformanceQuery } from "../app-data";
import { useDroidAgentApp } from "../app-context";
import { api, postJson } from "../lib/api";
import { useStreamingRuns } from "../lib/chat-stream-store";
import { formatTokenBudget } from "../lib/formatters";

function roleLabel(role: ChatMessage["role"]): string {
  if (role === "tool") {
    return "tool result";
  }

  return role;
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

function ChatMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a(props) {
          return (
            <a {...props} rel="noreferrer" target="_blank" />
          );
        },
        code({ children, className }) {
          const inline = !className;
          return inline ? (
            <code className="markdown-inline-code">{children}</code>
          ) : (
            <code className={className}>{children}</code>
          );
        },
        pre({ children }) {
          return <pre className="markdown-pre">{children}</pre>;
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

export function ChatScreen() {
  const queryClient = useQueryClient();
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
  const performanceQuery = usePerformanceQuery(Boolean(authQuery.data?.user));
  const dashboard = dashboardQuery.data;
  const performance = performanceQuery.data;
  const streamingRuns = useStreamingRuns();
  const [chatInput, setChatInput] = useState("");
  const [pendingRun, setPendingRun] = useState<{
    sessionId: string;
    sentAt: number;
  } | null>(null);

  const sessions = dashboard?.sessions ?? [];
  const activeSession =
    sessions.find((session) => session.id === selectedSessionId) ?? sessions[0];
  const selectedSessionKey = activeSession?.id ?? selectedSessionId;
  const streaming = selectedSessionKey ? streamingRuns[selectedSessionKey] : undefined;
  const transportReady = wsStatus === "connected" && Boolean(selectedSessionKey);
  const activeProvider = dashboard?.providers.find((provider) => provider.enabled);
  const openclawRuntime = dashboard?.runtimes.find(
    (runtime) => runtime.id === "openclaw",
  );
  const signalChannel = dashboard?.channels.find((channel) => channel.id === "signal");
  const harness = dashboard?.harness;
  const hasMultipleSessions = sessions.length > 1;

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
  const capabilityChips = useMemo(
    () =>
      [
        {
          label: "Harness",
          value:
            openclawRuntime?.state === "running"
              ? `OpenClaw • ${harness?.agentId ?? "main"}`
              : "Harness down",
          tone: openclawRuntime?.state === "running" ? "good" : "warn",
        },
        {
          label: "Session",
          value: selectedSessionKey || harness?.defaultSessionId || "No session",
          tone: selectedSessionKey ? "good" : "warn",
        },
        {
          label: "Runtime",
          value: activeProvider
            ? `${activeProvider.label} • ${activeProvider.model}`
            : "No active model",
          tone: activeProvider ? "good" : "warn",
        },
        {
          label: "Context",
          value: formatTokenBudget(
            activeProvider?.contextWindow ??
              harness?.contextWindow ??
              dashboard?.memory.contextWindow,
          ),
          tone: "neutral",
        },
        {
          label: "Auth",
          value:
            harness?.gatewayAuthMode === "token"
              ? "Gateway token + session key"
              : "Auth path not ready",
          tone: harness?.gatewayAuthMode === "token" ? "good" : "warn",
        },
        {
          label: "Tools",
          value: harness
            ? `${harness.toolProfile} profile • ${harness.availableTools.length} tools`
            : "Tool policy unknown",
          tone: harness ? "good" : "warn",
        },
        {
          label: "Exec",
          value:
            harness?.execHost && harness?.execSecurity && harness?.execAsk
              ? `${harness.execHost} • ${harness.execSecurity} • ${harness.execAsk}`
              : "Exec policy unavailable",
          tone:
            harness?.execHost && harness?.execSecurity && harness?.execAsk
              ? "good"
              : "warn",
        },
        {
          label: "Memory",
          value: dashboard?.memory.semanticReady
            ? "Semantic + session memory on"
            : "Memory indexing pending",
          tone: dashboard?.memory.semanticReady ? "good" : "warn",
        },
        {
          label: "Workspace",
          value:
            harness?.workspaceOnlyFs && dashboard?.setup.workspaceRoot
              ? "Scoped to active repo"
              : "Workspace guard missing",
          tone:
            harness?.workspaceOnlyFs && dashboard?.setup.workspaceRoot
              ? "good"
              : "warn",
        },
        ...(signalChannel?.configured
          ? [
              {
                label: "Signal",
                value: "Linked",
                tone: "neutral" as const,
              },
            ]
          : []),
      ] as const,
    [
      activeProvider,
      dashboard?.memory.contextWindow,
      dashboard?.memory.semanticReady,
      dashboard?.setup.workspaceRoot,
      harness,
      openclawRuntime?.state,
      selectedSessionKey,
      signalChannel?.configured,
    ],
  );
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
        label: "Reply complete",
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

  async function handleSendChat() {
    const nextMessage = chatInput.trim();
    if (!nextMessage || !selectedSessionKey) {
      return;
    }

    const optimisticMessage: ChatMessage = {
      id: `optimistic-${Date.now()}`,
      sessionId: selectedSessionKey,
      role: "user",
      text: nextMessage,
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
            text: nextMessage,
          },
        });
      if (!sentLive) {
        await postJson(
          `/api/sessions/${encodeURIComponent(selectedSessionKey)}/messages`,
          {
            text: nextMessage,
          },
        );
      }
    } catch (error) {
      setPendingRun(null);
      throw error;
    }
    setChatInput("");
  }

  return (
    <section
      className={`chat-panel${hasMultipleSessions ? "" : " single-session"}`}
    >
      <article className="panel-card compact chat-ops-card">
        <div className="chat-ops-header">
          <div>
            <div className="journey-kicker">Live Agent Console</div>
            <h3>{activeSession?.title ?? "Operator Chat"}</h3>
          </div>
          <div className="status-chip-row">
            <span className={`status-chip${agentReady ? " ready" : ""}`}>
              {agentReady ? "Agent live" : "Agent unavailable"}
            </span>
            <span className={`status-chip${transportReady ? " ready" : ""}`}>
              {transportReady ? "WebSocket live" : "Reconnecting"}
            </span>
          </div>
        </div>
        <p className="chat-ops-copy">
          {agentReady
            ? "This tab is bound to the live OpenClaw gateway on your Mac, using the configured token-auth path and session key."
            : "The shell is loaded, but the live OpenClaw path is not fully ready yet."}
        </p>
        <div className="capability-grid">
          {capabilityChips.map((chip) => (
            <article
              key={`${chip.label}-${chip.value}`}
              className={`capability-chip ${chip.tone}`}
            >
              <strong>{chip.label}</strong>
              <span>{chip.value}</span>
            </article>
          ))}
        </div>
        {harness?.availableTools.length ? (
          <div className="tool-pill-grid" aria-label="Available tools">
            {harness.availableTools.map((tool) => (
              <span key={tool} className="tool-pill">
                {formatToolName(tool)}
              </span>
            ))}
          </div>
        ) : null}
      </article>

      {hasMultipleSessions ? (
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

      <div className="chat-thread">
        <article className="panel-card compact thread-header">
          <div className="thread-header-row">
            <div>
              <div className="journey-kicker">Current Session</div>
              <h3>{activeSession?.title ?? "Operator Chat"}</h3>
            </div>
            <div className="status-chip-row">
              <span className={`status-chip${transportReady ? " ready" : ""}`}>
                {transportReady ? "Connected" : "Reconnecting"}
              </span>
              <span
                className={`status-chip${
                  dashboard?.memory.semanticReady ? " ready" : ""
                }`}
              >
                {dashboard?.memory.semanticReady
                  ? "Memory ready"
                  : "Memory pending"}
              </span>
            </div>
          </div>
          <small>
            {activeProvider
              ? `${activeProvider.label} • ${activeProvider.model} • ${formatTokenBudget(activeProvider.contextWindow)} context`
              : activeSession?.lastMessagePreview ||
                "Start a clean operator conversation from the web shell."}
          </small>
          <div className="metric-strip">
            {metrics.map((metric) => (
              <article key={metric.label} className="metric-chip">
                <strong>{metric.label}</strong>
                <span>{metric.value}</span>
              </article>
            ))}
          </div>
        </article>

        {(dashboard?.approvals ?? []).length > 0 ? (
          <article className="panel-card">
            <h3>Approvals</h3>
            <div className="stack-list">
              {dashboard?.approvals.map((approval) => (
                <article key={approval.id} className="panel-card compact">
                  <strong>{approval.title}</strong>
                  <small>{approval.details}</small>
                  <div className="button-row">
                    <button
                      onClick={() =>
                        void runAction(async () => {
                          await postJson(`/api/approvals/${approval.id}`, {
                            resolution: "approved",
                          });
                        }, "Approval granted.")
                      }
                    >
                      Approve
                    </button>
                    <button
                      className="secondary"
                      onClick={() =>
                        void runAction(async () => {
                          await postJson(`/api/approvals/${approval.id}`, {
                            resolution: "denied",
                          });
                        }, "Approval denied.")
                      }
                    >
                      Deny
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </article>
        ) : null}

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
              This session is scoped to the active workspace and the real
              OpenClaw agent on your Mac. Ask it to inspect files, edit code,
              search the repo, or run approved commands.
            </small>
          </article>
        ) : null}

        {messages.map((message) => (
          <article key={message.id} className={`message-card ${message.role}`}>
            <div className="message-meta">
              <header>{roleLabel(message.role)}</header>
              <span>{formatMessageTime(message.createdAt)}</span>
            </div>
            <MessageBody message={message} />
          </article>
        ))}
        {streaming ? (
          <article className="message-card assistant streaming">
            <div className="message-meta">
              <header>assistant</header>
              <span>live</span>
            </div>
            <p>{streaming.text || "Starting the run..."}</p>
          </article>
        ) : pendingRun?.sessionId === selectedSessionKey ? (
          <article className="message-card assistant streaming pending">
            <div className="message-meta">
              <header>assistant</header>
              <span>queued</span>
            </div>
            <p>Starting the OpenClaw run…</p>
          </article>
        ) : null}
      </div>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void runAction(handleSendChat);
        }}
      >
        <textarea
          value={chatInput}
          onChange={(event) => setChatInput(event.target.value)}
          placeholder="Ask DroidAgent to inspect, edit, search, or operate on this Mac..."
          disabled={!selectedSessionKey}
        />
        <small className="composer-status">
          {agentReady
            ? `Live OpenClaw session ready. ${harness?.toolProfile ?? "coding"} tools, ${harness?.execAsk ?? "on-miss"} exec approvals, and ${dashboard?.memory.semanticReady ? "semantic memory" : "memory indexing"} are active.`
            : "The live agent path is not fully ready yet. Fix the harness/runtime path before sending the next run."}
        </small>
        <div className="button-row">
          <button type="submit" disabled={!agentReady || !chatInput.trim()}>
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
    </section>
  );
}
