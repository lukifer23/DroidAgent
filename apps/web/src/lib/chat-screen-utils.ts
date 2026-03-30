import type { QueryClient } from "@tanstack/react-query";
import type {
  ChatAttachment,
  ChatMessage,
  DashboardState,
  SessionSummary,
} from "@droidagent/shared";

export function updateDashboardSessionCache(
  queryClient: QueryClient,
  updater: (sessions: SessionSummary[]) => SessionSummary[],
): void {
  queryClient.setQueryData<DashboardState | undefined>(
    ["dashboard"],
    (current) =>
      current
        ? {
            ...current,
            sessions: updater(current.sessions),
          }
        : current,
  );
}

export function updateArchivedSessionCache(
  queryClient: QueryClient,
  updater: (sessions: SessionSummary[]) => SessionSummary[],
): void {
  queryClient.setQueryData<SessionSummary[]>(
    ["sessions", "archived"],
    (current) => updater(current ?? []),
  );
}

export function buildOptimisticChatMessage(params: {
  sessionId: string;
  text: string;
  attachments: ChatAttachment[];
}): ChatMessage {
  const text = params.text.trim() || "Inspect the attached files.";
  const attachments = params.attachments;

  return {
    id: `optimistic-${Date.now()}`,
    sessionId: params.sessionId,
    role: "user",
    text,
    parts: [
      ...(attachments.length > 0
        ? [
            {
              type: "attachments" as const,
              attachments,
            },
          ]
        : []),
      {
        type: "markdown" as const,
        text,
      },
    ],
    attachments,
    createdAt: new Date().toISOString(),
    status: "complete",
    source: "web",
  };
}
