import type { QueryClient } from "@tanstack/react-query";

import type { ChatMessage } from "@droidagent/shared";

import { api } from "./api";

export function sessionMessagesQueryKey(sessionId: string) {
  return ["sessions", sessionId, "messages"] as const;
}

export function sessionMessagesQueryOptions(sessionId: string) {
  return {
    queryKey: sessionMessagesQueryKey(sessionId),
    queryFn: () =>
      api<ChatMessage[]>(
        `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
      ),
    staleTime: 15_000,
  };
}

export function getCachedSessionMessages(
  queryClient: QueryClient,
  sessionId: string | null | undefined,
): ChatMessage[] {
  if (!sessionId) {
    return [];
  }
  return (
    queryClient.getQueryData<ChatMessage[]>(sessionMessagesQueryKey(sessionId)) ??
    []
  );
}

export function setCachedSessionMessages(
  queryClient: QueryClient,
  sessionId: string,
  messages: ChatMessage[],
): void {
  queryClient.setQueryData<ChatMessage[]>(
    sessionMessagesQueryKey(sessionId),
    messages,
  );
}

export async function prefetchSessionMessages(
  queryClient: QueryClient,
  sessionId: string,
): Promise<void> {
  await queryClient.prefetchQuery(sessionMessagesQueryOptions(sessionId));
}

export async function invalidateChatSessionIndexes(
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
