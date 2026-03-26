import { startTransition, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { ChatMessage } from "@droidagent/shared";

import { useAuthQuery, useDashboardQuery } from "../app-data";
import { useDroidAgentApp } from "../app-context";
import { api, postJson } from "../lib/api";
import { useStreamingRuns } from "../lib/chat-stream-store";

export function ChatScreen() {
  const queryClient = useQueryClient();
  const {
    selectedSessionId,
    setSelectedSessionId,
    trackChatSubmit,
    runAction
  } = useDroidAgentApp();
  const authQuery = useAuthQuery();
  const dashboardQuery = useDashboardQuery(Boolean(authQuery.data?.user));
  const dashboard = dashboardQuery.data;
  const streamingRuns = useStreamingRuns();
  const [chatInput, setChatInput] = useState("");

  const sessions = dashboard?.sessions ?? [];
  const streaming = streamingRuns[selectedSessionId];

  const messagesQuery = useQuery({
    queryKey: ["sessions", selectedSessionId, "messages"],
    queryFn: () => api<ChatMessage[]>(`/api/sessions/${encodeURIComponent(selectedSessionId)}/messages`),
    enabled: Boolean(authQuery.data?.user && selectedSessionId)
  });

  const messages = useMemo(() => messagesQuery.data ?? [], [messagesQuery.data]);

  async function handleSendChat() {
    if (!chatInput.trim()) {
      return;
    }

    const optimisticMessage: ChatMessage = {
      id: `optimistic-${Date.now()}`,
      sessionId: selectedSessionId,
      role: "user",
      text: chatInput.trim(),
      createdAt: new Date().toISOString(),
      status: "complete",
      source: "web"
    };

    queryClient.setQueryData<ChatMessage[]>(["sessions", selectedSessionId, "messages"], [
      ...messages,
      optimisticMessage
    ]);

    trackChatSubmit(selectedSessionId);
    await postJson(`/api/sessions/${encodeURIComponent(selectedSessionId)}/messages`, {
      text: chatInput
    });
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
                            resolution: "approved"
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
                            resolution: "denied"
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

        {messages.map((message) => (
          <article key={message.id} className={`message-card ${message.role}`}>
            <header>{message.role}</header>
            <p>{message.text}</p>
          </article>
        ))}
        {streaming ? (
          <article className="message-card assistant streaming">
            <header>assistant</header>
            <p>{streaming.text || "Thinking..."}</p>
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
        />
        <div className="button-row">
          <button type="submit">Send</button>
          {streaming ? (
            <button
              type="button"
              className="secondary"
              onClick={() =>
                void runAction(async () => {
                  await postJson(`/api/sessions/${encodeURIComponent(selectedSessionId)}/abort`, {});
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
