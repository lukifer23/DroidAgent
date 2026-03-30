import { useMemo } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";

import type { ChatMessage } from "@droidagent/shared";

import { api } from "../lib/api";
import { useChatRuns } from "../lib/chat-run-store";
import { useStreamingRuns } from "../lib/chat-stream-store";
import type { ChatSessionFeedback } from "../app-context";

export function useChatSessionState(params: {
  selectedSessionKey: string;
  queryClient: QueryClient;
  enabled: boolean;
  liveBySessionId: Record<string, ChatSessionFeedback | null | undefined>;
  recentBySessionId: Record<string, ChatSessionFeedback | null | undefined>;
}) {
  const runStates = useChatRuns();
  const streamingRuns = useStreamingRuns();
  const historyQuery = useQuery({
    queryKey: ["sessions", params.selectedSessionKey, "messages"],
    queryFn: () =>
      api<ChatMessage[]>(
        `/api/sessions/${encodeURIComponent(params.selectedSessionKey)}/messages`,
      ),
    enabled: Boolean(params.enabled && params.selectedSessionKey),
    staleTime: 15_000,
  });
  const cachedMessages = params.selectedSessionKey
    ? (params.queryClient.getQueryData<ChatMessage[]>([
        "sessions",
        params.selectedSessionKey,
        "messages",
      ]) ?? [])
    : [];
  const messages = useMemo(
    () => historyQuery.data ?? cachedMessages,
    [cachedMessages, historyQuery.data],
  );

  return {
    historyQuery,
    messages,
    activeRun: params.selectedSessionKey
      ? runStates[params.selectedSessionKey] ?? null
      : null,
    streaming: params.selectedSessionKey
      ? streamingRuns[params.selectedSessionKey]
      : undefined,
    liveChatFeedback: params.selectedSessionKey
      ? params.liveBySessionId[params.selectedSessionKey] ?? null
      : null,
    recentChatFeedback: params.selectedSessionKey
      ? params.recentBySessionId[params.selectedSessionKey] ?? null
      : null,
  };
}
