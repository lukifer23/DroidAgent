import type { Dispatch, SetStateAction } from "react";
import type { QueryClient } from "@tanstack/react-query";

import type { ChatAttachment, SessionSummary } from "@droidagent/shared";

import { postJson } from "./api";
import {
  invalidateChatSessionIndexes,
  prefetchSessionMessages,
  setCachedSessionMessages,
} from "./chat-session-cache";
import { chatSessionStore } from "./chat-session-store";
import {
  updateArchivedSessionCache,
  updateDashboardSessionCache,
} from "./chat-screen-utils";

interface SessionActionContext {
  queryClient: QueryClient;
  wsStatus: string;
  setSelectedSessionId: (sessionId: string) => void;
  setChatInput: Dispatch<SetStateAction<string>>;
  setPendingAttachments: Dispatch<SetStateAction<ChatAttachment[]>>;
}

function clearComposer(context: SessionActionContext): void {
  context.setChatInput("");
  context.setPendingAttachments([]);
}

export async function startFreshSession(
  context: SessionActionContext,
): Promise<void> {
  const freshSession = await postJson<SessionSummary>("/api/sessions", {});
  updateDashboardSessionCache(context.queryClient, (currentSessions) => {
    const next = [
      freshSession,
      ...currentSessions.filter((session) => session.id !== freshSession.id),
    ];
    return next;
  });
  setCachedSessionMessages(context.queryClient, freshSession.id, []);
  chatSessionStore.primeMessages(freshSession.id, []);
  context.setSelectedSessionId(freshSession.id);
  clearComposer(context);
  await prefetchSessionMessages(context.queryClient, freshSession.id);
  chatSessionStore.markSessionSwitching(freshSession.id, false);
  await invalidateChatSessionIndexes(context.queryClient, context.wsStatus);
}

export async function closeCurrentSession(params: SessionActionContext & {
  selectedSessionId: string;
  sessionOptions: SessionSummary[];
}): Promise<void> {
  const { selectedSessionId } = params;
  const siblingSession =
    params.sessionOptions.find((session) => session.id !== selectedSessionId) ??
    null;
  let replacementSession = siblingSession;

  if (!replacementSession) {
    replacementSession = await postJson<SessionSummary>("/api/sessions", {});
    setCachedSessionMessages(params.queryClient, replacementSession.id, []);
    chatSessionStore.primeMessages(replacementSession.id, []);
    updateDashboardSessionCache(params.queryClient, (currentSessions) => [
      replacementSession!,
      ...currentSessions.filter(
        (session) =>
          session.id !== selectedSessionId &&
          session.id !== replacementSession!.id,
      ),
    ]);
  } else {
    updateDashboardSessionCache(params.queryClient, (currentSessions) =>
      currentSessions.filter((session) => session.id !== selectedSessionId),
    );
  }

  params.setSelectedSessionId(replacementSession.id);
  clearComposer(params);
  chatSessionStore.markSessionSwitching(replacementSession.id, false);

  const archivedSession = await postJson<SessionSummary>(
    `/api/sessions/${encodeURIComponent(selectedSessionId)}/archive`,
    {},
  );
  updateDashboardSessionCache(params.queryClient, (currentSessions) =>
    currentSessions.filter((session) => session.id !== selectedSessionId),
  );
  updateArchivedSessionCache(params.queryClient, (currentSessions) => [
    archivedSession,
    ...currentSessions.filter((session) => session.id !== selectedSessionId),
  ]);
  params.queryClient.removeQueries({
    queryKey: ["sessions", selectedSessionId, "messages"],
    exact: true,
  });
  chatSessionStore.clearSession(selectedSessionId);
  await prefetchSessionMessages(params.queryClient, replacementSession.id);
  await invalidateChatSessionIndexes(params.queryClient, params.wsStatus);
}

export async function restoreSession(
  params: SessionActionContext & { sessionId: string },
): Promise<void> {
  const restored = await postJson<SessionSummary>(
    `/api/sessions/${encodeURIComponent(params.sessionId)}/restore`,
    {},
  );
  updateDashboardSessionCache(params.queryClient, (currentSessions) => [
    restored,
    ...currentSessions.filter((session) => session.id !== restored.id),
  ]);
  updateArchivedSessionCache(params.queryClient, (currentSessions) =>
    currentSessions.filter((session) => session.id !== restored.id),
  );
  params.setSelectedSessionId(restored.id);
  chatSessionStore.markSessionSwitching(restored.id, false);
  await prefetchSessionMessages(params.queryClient, restored.id);
  await invalidateChatSessionIndexes(params.queryClient, params.wsStatus);
}
