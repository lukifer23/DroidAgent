import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { chatSessionStore, useChatSessionSnapshot } from "../lib/chat-session-store";
import {
  getCachedSessionMessages,
  sessionMessagesQueryOptions,
} from "../lib/chat-session-cache";

export function useChatSessionState(params: {
  selectedSessionKey: string;
  enabled: boolean;
}) {
  const queryClient = useQueryClient();
  const session = useChatSessionSnapshot(params.selectedSessionKey);
  const historyQuery = useQuery({
    ...sessionMessagesQueryOptions(params.selectedSessionKey),
    enabled: Boolean(params.enabled && params.selectedSessionKey),
  });

  useEffect(() => {
    if (!params.selectedSessionKey) {
      return;
    }

    if (historyQuery.isError) {
      chatSessionStore.markHistoryError(params.selectedSessionKey);
      return;
    }

    if (historyQuery.data) {
      chatSessionStore.markHistoryReady(
        params.selectedSessionKey,
        historyQuery.data,
      );
      return;
    }

    if (historyQuery.isFetching || historyQuery.isLoading) {
      const hasMessages = session.messages.length > 0;
      chatSessionStore.markHistoryLoading(params.selectedSessionKey, {
        resync: hasMessages,
      });
    }
  }, [
    historyQuery.data,
    historyQuery.isError,
    historyQuery.isFetching,
    historyQuery.isLoading,
    params.selectedSessionKey,
    session.messages.length,
  ]);

  useEffect(() => {
    if (!params.selectedSessionKey || historyQuery.data) {
      return;
    }
    const cachedMessages = getCachedSessionMessages(
      queryClient,
      params.selectedSessionKey,
    );
    if (cachedMessages.length === 0) {
      return;
    }
    chatSessionStore.primeMessages(params.selectedSessionKey, cachedMessages);
  }, [historyQuery.data, params.selectedSessionKey, queryClient]);

  return {
    historyQuery,
    messages: session.messages,
    historyStatus: session.historyStatus,
    switching: session.switching,
    pendingSend: session.pendingSend,
    activeRun: session.activeRun,
    streaming: session.streaming ?? undefined,
    liveChatFeedback: session.liveFeedback,
    recentChatFeedback: session.recentFeedback,
  };
}
