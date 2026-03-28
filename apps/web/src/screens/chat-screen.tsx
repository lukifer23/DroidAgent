import { startTransition, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { ChatMessage } from "@droidagent/shared";

import { useAuthQuery, useDashboardQuery } from "../app-data";
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
  const dashboard = dashboardQuery.data;
  const streamingRuns = useStreamingRuns();
  const [chatInput, setChatInput] = useState("");
  const [pendingRun, setPendingRun] = useState<{
    sessionId: string;
    sentAt: number;
  } | null>(null);

  const sessions = dashboard?.sessions ?? [];
  const activeSession =
    sessions.find((session) => session.id === selectedSessionId) ?? sessions[0];
  const streaming = streamingRuns[selectedSessionId];
  const transportReady = wsStatus === "connected" && Boolean(selectedSessionId);
  const activeProvider = dashboard?.providers.find((provider) => provider.enabled);
  const openclawRuntime = dashboard?.runtimes.find(
    (runtime) => runtime.id === "openclaw",
  );
  const signalChannel = dashboard?.channels.find((channel) => channel.id === "signal");
  const hasMultipleSessions = sessions.length > 1;

  const messagesQuery = useQuery({
    queryKey: ["sessions", selectedSessionId, "messages"],
    queryFn: () =>
      api<ChatMessage[]>(
        `/api/sessions/${encodeURIComponent(selectedSessionId)}/messages`,
      ),
    enabled: Boolean(authQuery.data?.user && selectedSessionId),
    staleTime: 15_000,
  });

  const messages = useMemo(
    () => messagesQuery.data ?? [],
    [messagesQuery.data],
  );
  const agentReady =
    openclawRuntime?.state === "running" &&
    Boolean(activeProvider?.enabled) &&
    transportReady;
  const capabilityChips = useMemo(
    () =>
      [
        {
          label: "Harness",
          value:
            openclawRuntime?.state === "running" ? "OpenClaw live" : "Harness down",
          tone: openclawRuntime?.state === "running" ? "good" : "warn",
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
            activeProvider?.contextWindow ?? dashboard?.memory.contextWindow,
          ),
          tone: "neutral",
        },
        {
          label: "Memory",
          value: dashboard?.memory.semanticReady
            ? "Semantic recall on"
            : "Semantic recall pending",
          tone: dashboard?.memory.semanticReady ? "good" : "warn",
        },
        {
          label: "Exec",
          value: activeProvider?.toolSupport
            ? "Approval-gated shell"
            : "Tooling unavailable",
          tone: activeProvider?.toolSupport ? "good" : "warn",
        },
        {
          label: "Skills",
          value: dashboard?.memory.ready ? "Prefs + skills loaded" : "Scaffold pending",
          tone: dashboard?.memory.ready ? "good" : "warn",
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
      dashboard?.memory.ready,
      dashboard?.memory.semanticReady,
      openclawRuntime?.state,
      signalChannel?.configured,
    ],
  );

  useEffect(() => {
    if (!pendingRun || pendingRun.sessionId !== selectedSessionId) {
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
  }, [messages, pendingRun, selectedSessionId, streaming]);

  async function handleSendChat() {
    const nextMessage = chatInput.trim();
    if (!nextMessage || !selectedSessionId) {
      return;
    }

    const optimisticMessage: ChatMessage = {
      id: `optimistic-${Date.now()}`,
      sessionId: selectedSessionId,
      role: "user",
      text: nextMessage,
      createdAt: new Date().toISOString(),
      status: "complete",
      source: "web",
    };

    queryClient.setQueryData<ChatMessage[]>(
      ["sessions", selectedSessionId, "messages"],
      [...messages, optimisticMessage],
    );

    trackChatSubmit(selectedSessionId);
    const startedAt = Date.now();
    setPendingRun({
      sessionId: selectedSessionId,
      sentAt: startedAt,
    });
    try {
      const sentLive =
        transportReady &&
        sendRealtimeCommand({
          type: "chat.send",
          payload: {
            sessionId: selectedSessionId,
            text: nextMessage,
          },
        });
      if (!sentLive) {
        await postJson(
          `/api/sessions/${encodeURIComponent(selectedSessionId)}/messages`,
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
            <div className="journey-kicker">Operator Session</div>
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
            ? "This route is talking to the live OpenClaw harness on your Mac."
            : "The chat shell is up, but the live harness path still needs attention before control feels normal."}
        </p>
        <div className="capability-grid">
          {capabilityChips.map((chip) => (
            <article key={`${chip.label}-${chip.value}`} className={`capability-chip ${chip.tone}`}>
              <strong>{chip.label}</strong>
              <span>{chip.value}</span>
            </article>
          ))}
        </div>
      </article>

      {hasMultipleSessions ? (
        <aside className="session-strip" aria-label="Sessions">
          {sessions.map((session) => (
            <button
              key={session.id}
              className={`session-pill${session.id === selectedSessionId ? " active" : ""}`}
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
              <div className="journey-kicker">Now Running</div>
              <h3>{activeSession?.title ?? "Operator Chat"}</h3>
            </div>
            <div className="status-chip-row">
              <span className={`status-chip${transportReady ? " ready" : ""}`}>
                {transportReady ? "Connected" : "Reconnecting"}
              </span>
              <span
                className={`status-chip${dashboard?.memory.semanticReady ? " ready" : ""}`}
              >
                {dashboard?.memory.semanticReady ? "Memory ready" : "Memory pending"}
              </span>
            </div>
          </div>
          <small>
            {activeProvider
              ? `${activeProvider.label} • ${activeProvider.model} • ${formatTokenBudget(activeProvider.contextWindow)} context`
              : activeSession?.lastMessagePreview ||
                "Start a clean operator conversation from the web shell."}
          </small>
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

        {messages.length === 0 && !streaming ? (
          <article className="panel-card compact empty-thread">
            <strong>Fresh operator thread</strong>
            <small>
              Use this session for direct Mac control. DroidAgent keeps the
              default path local-first with Ollama, OpenClaw, and the shared
              workspace.
            </small>
          </article>
        ) : null}

        {messages.map((message) => (
          <article key={message.id} className={`message-card ${message.role}`}>
            <header>{roleLabel(message.role)}</header>
            <p>{message.text}</p>
          </article>
        ))}
        {streaming ? (
          <article className="message-card assistant streaming">
            <header>assistant</header>
            <p>{streaming.text || "Starting the run..."}</p>
          </article>
        ) : pendingRun?.sessionId === selectedSessionId ? (
          <article className="message-card assistant streaming pending">
            <header>assistant</header>
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
          disabled={!selectedSessionId}
        />
        <small className="composer-status">
          {transportReady
            ? agentReady
              ? "Live agent session ready. File access, semantic memory, and approval-gated shell exec are available."
              : "Connected, but the live harness path needs attention."
            : "Live connection is reconnecting before the next run can start."}
        </small>
        <div className="button-row">
          <button type="submit" disabled={!transportReady || !chatInput.trim()}>
            {pendingRun?.sessionId === selectedSessionId || streaming
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
                        sessionId: selectedSessionId,
                      },
                    });
                  if (!aborted) {
                    await postJson(
                      `/api/sessions/${encodeURIComponent(selectedSessionId)}/abort`,
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
