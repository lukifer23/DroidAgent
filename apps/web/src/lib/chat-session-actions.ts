import type { Dispatch, SetStateAction } from "react";
import type { QueryClient } from "@tanstack/react-query";

import type { ChatAttachment, ChatMessage, SessionSummary } from "@droidagent/shared";

import { api, postJson } from "./api";
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

async function prefetchMessages(
  queryClient: QueryClient,
  sessionId: string,
): Promise<void> {
  await queryClient.prefetchQuery({
    queryKey: ["sessions", sessionId, "messages"],
    queryFn: () =>
      api<ChatMessage[]>(
        `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
      ),
    staleTime: 15_000,
  });
}

async function syncSessionCachesWhenOffline(
  queryClient: QueryClient,
  wsStatus: string,
): Promise<void> {
  if (wsStatus === "connected") {
    return;
  }
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
    queryClient.invalidateQueries({ queryKey: ["sessions", "archived"] }),
  ]);
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
  context.queryClient.setQueryData<ChatMessage[]>(
    ["sessions", freshSession.id, "messages"],
    [],
  );
  context.setSelectedSessionId(freshSession.id);
  clearComposer(context);
  await prefetchMessages(context.queryClient, freshSession.id);
  await syncSessionCachesWhenOffline(context.queryClient, context.wsStatus);
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
    params.queryClient.setQueryData<ChatMessage[]>(
      ["sessions", replacementSession.id, "messages"],
      [],
    );
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
  await prefetchMessages(params.queryClient, replacementSession.id);
  await syncSessionCachesWhenOffline(params.queryClient, params.wsStatus);
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
  await prefetchMessages(params.queryClient, restored.id);
  await syncSessionCachesWhenOffline(params.queryClient, params.wsStatus);
}
