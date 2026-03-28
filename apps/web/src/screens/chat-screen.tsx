import { startTransition, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { ChatMessage } from "@droidagent/shared";

import { useAuthQuery, useDashboardQuery } from "../app-data";
import { useDroidAgentApp } from "../app-context";
import { api, postJson } from "../lib/api";
import { useStreamingRuns } from "../lib/chat-stream-store";

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

  const sessions = dashboard?.sessions ?? [];
  const activeSession =
    sessions.find((session) => session.id === selectedSessionId) ?? sessions[0];
  const streaming = streamingRuns[selectedSessionId];
  const transportReady = wsStatus === "connected" && Boolean(selectedSessionId);

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
    setChatInput("");
  }

  return (
    <section className="chat-panel">
      <aside className="session-strip">
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

      <div className="chat-thread">
        <article className="panel-card compact thread-header">
          <div className="thread-header-row">
            <div>
              <div className="journey-kicker">Current Session</div>
              <h3>{activeSession?.title ?? "Operator Chat"}</h3>
            </div>
            <span className={`status-chip${transportReady ? " ready" : ""}`}>
              {transportReady ? "Live" : "Reconnecting"}
            </span>
          </div>
          <small>
            {activeSession?.lastMessagePreview ||
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
          placeholder="Send a message to the current OpenClaw session..."
          disabled={!selectedSessionId}
        />
        <small className="composer-status">
          {transportReady
            ? "Live connection ready."
            : "Live connection is reconnecting before the next run can start."}
        </small>
        <div className="button-row">
          <button type="submit" disabled={!transportReady || !chatInput.trim()}>
            Send
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
