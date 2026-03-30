import {
  createContext,
  startTransition,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ChatMessage, ClientCommand, ServerEvent } from "@droidagent/shared";

import { useAccessQuery, useAuthQuery, useDashboardQuery, usePasskeysQuery } from "./app-data";
import { useWebSocket } from "./hooks/use-websocket";
import { api } from "./lib/api";
import { clientPerformance } from "./lib/client-performance";
import { terminalStore } from "./lib/terminal-store";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export interface ChatSessionFeedback {
  sessionId: string;
  status: "waiting_first_token" | "streaming" | "done" | "error";
  firstTokenMs: number | null;
  completedMs: number | null;
  errorMessage: string | null;
  updatedAt: string;
}

interface DroidAgentAppContextValue {
  notice: string | null;
  setNotice: (value: string | null) => void;
  errorMessage: string | null;
  setErrorMessage: (value: string | null) => void;
  isOnline: boolean;
  wsStatus: "disconnected" | "connecting" | "connected";
  refreshQueries: () => Promise<void>;
  runAction: (work: () => Promise<void>, successMessage?: string) => Promise<void>;
  selectedSessionId: string;
  setSelectedSessionId: (sessionId: string) => void;
  sendRealtimeCommand: (command: ClientCommand) => boolean;
  themePreference: "system" | "dark" | "light";
  resolvedTheme: "dark" | "light";
  setThemePreference: (value: "system" | "dark" | "light") => void;
  canInstallApp: boolean;
  installApp: () => Promise<void>;
  beginRouteTransition: (path: string) => void;
  finishRouteTransition: (path: string) => void;
  trackChatSubmit: (sessionId: string) => void;
  trackChatFailure: (sessionId: string, message: string) => void;
  trackJobStart: (jobId: string) => void;
}

interface ChatFeedbackSnapshot {
  liveBySessionId: Record<string, ChatSessionFeedback>;
  recentBySessionId: Record<string, ChatSessionFeedback>;
}

const DroidAgentAppContext = createContext<DroidAgentAppContextValue | null>(null);
const chatFeedbackListeners = new Set<() => void>();
let chatFeedbackSnapshot: ChatFeedbackSnapshot = {
  liveBySessionId: {},
  recentBySessionId: {},
};

function updateChatFeedbackSnapshot(
  updater: (current: ChatFeedbackSnapshot) => ChatFeedbackSnapshot,
): void {
  chatFeedbackSnapshot = updater(chatFeedbackSnapshot);
  for (const listener of chatFeedbackListeners) {
    listener();
  }
}

function getChatFeedbackSnapshot(): ChatFeedbackSnapshot {
  return chatFeedbackSnapshot;
}

function subscribeChatFeedback(listener: () => void): () => void {
  chatFeedbackListeners.add(listener);
  return () => {
    chatFeedbackListeners.delete(listener);
  };
}

export function DroidAgentAppProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  const [selectedSessionId, setSelectedSessionId] = useState("web:operator");
  const [themePreference, setThemePreference] = useState<
    "system" | "dark" | "light"
  >(() => {
    if (typeof window === "undefined") {
      return "system";
    }
    const saved = window.localStorage.getItem("droidagent-theme");
    return saved === "dark" || saved === "light" || saved === "system"
      ? saved
      : "system";
  });
  const [installPromptEvent, setInstallPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [resolvedTheme, setResolvedTheme] = useState<"dark" | "light">(() => {
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: light)").matches
    ) {
      return "light";
    }
    return "dark";
  });

  const routeTransitionRef = useRef<{ path: string; metric: ReturnType<typeof clientPerformance.start> } | null>(null);
  const pendingChatMetricsRef = useRef<
    Map<
      string,
      {
        startedAt: number;
        firstToken: ReturnType<typeof clientPerformance.start>;
        firstTokenFinished: boolean;
        completed: ReturnType<typeof clientPerformance.start>;
      }
    >
  >(new Map());
  const pendingJobMetricsRef = useRef<Map<string, ReturnType<typeof clientPerformance.start>>>(new Map());
  const chatFeedbackTimeoutsRef = useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map());

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPromptEvent(event as BeforeInstallPromptEvent);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    };
  }, []);

  useEffect(() => {
    if (!notice) {
      return;
    }

    const timer = window.setTimeout(() => {
      setNotice(null);
    }, 2800);

    return () => {
      window.clearTimeout(timer);
    };
  }, [notice]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem("droidagent-theme", themePreference);
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const applyTheme = () => {
      const nextTheme =
        themePreference === "system"
          ? media.matches
            ? "light"
            : "dark"
          : themePreference;
      setResolvedTheme(nextTheme);
      document.documentElement.dataset.theme = nextTheme;
      document.documentElement.style.colorScheme = nextTheme;
      const themeMeta = document.querySelector('meta[name="theme-color"]');
      if (themeMeta) {
        themeMeta.setAttribute(
          "content",
          nextTheme === "light" ? "#f3f1ec" : "#0d1116",
        );
      }
    };

    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => {
      media.removeEventListener("change", applyTheme);
    };
  }, [themePreference]);

  useEffect(() => {
    return () => {
      for (const timeoutId of chatFeedbackTimeoutsRef.current.values()) {
        clearTimeout(timeoutId);
      }
      chatFeedbackTimeoutsRef.current.clear();
    };
  }, []);

  const refreshQueries = useEffectEvent(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      queryClient.invalidateQueries({ queryKey: ["access"] }),
      queryClient.invalidateQueries({ queryKey: ["passkeys"] }),
      queryClient.invalidateQueries({ queryKey: ["performance"] }),
      queryClient.invalidateQueries({ queryKey: ["sessions"] }),
      queryClient.invalidateQueries({ queryKey: ["files"] }),
      queryClient.invalidateQueries({ queryKey: ["jobs"] }),
      queryClient.invalidateQueries({ queryKey: ["terminal"] }),
    ]);
  });

  const runAction = useEffectEvent(async (work: () => Promise<void>, successMessage?: string) => {
    setErrorMessage(null);
    try {
      await work();
      if (successMessage) {
        setNotice(successMessage);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "DroidAgent action failed.");
    }
  });

  const beginRouteTransition = useEffectEvent((path: string) => {
    routeTransitionRef.current = {
      path,
      metric: clientPerformance.start("client.route.switch", {
        path
      })
    };
  });

  const finishRouteTransition = useEffectEvent((path: string) => {
    const current = routeTransitionRef.current;
    if (!current || current.path !== path) {
      return;
    }

    current.metric.finish({
      outcome: "ok"
    });
    routeTransitionRef.current = null;
  });

  const clearChatFeedbackTimeout = useEffectEvent((sessionId: string) => {
    const timeoutId = chatFeedbackTimeoutsRef.current.get(sessionId);
    if (timeoutId) {
      clearTimeout(timeoutId);
      chatFeedbackTimeoutsRef.current.delete(sessionId);
    }
  });

  const scheduleChatFeedbackClear = useEffectEvent(
    (sessionId: string, delayMs = 12_000) => {
      clearChatFeedbackTimeout(sessionId);
      const timeoutId = setTimeout(() => {
        chatFeedbackTimeoutsRef.current.delete(sessionId);
        updateChatFeedbackSnapshot((current) => {
          if (!(sessionId in current.liveBySessionId)) {
            return current;
          }
          const nextLive = { ...current.liveBySessionId };
          delete nextLive[sessionId];
          return {
            ...current,
            liveBySessionId: nextLive,
          };
        });
      }, delayMs);
      chatFeedbackTimeoutsRef.current.set(sessionId, timeoutId);
    },
  );

  const trackChatSubmit = useEffectEvent((sessionId: string) => {
    clearChatFeedbackTimeout(sessionId);
    pendingChatMetricsRef.current.set(sessionId, {
      startedAt: performance.now(),
      firstToken: clientPerformance.start("client.chat.submit_to_first_token", {
        sessionId
      }),
      firstTokenFinished: false,
      completed: clientPerformance.start("client.chat.submit_to_done", {
        sessionId
      })
    });
    updateChatFeedbackSnapshot((current) => ({
      ...current,
      liveBySessionId: {
        ...current.liveBySessionId,
        [sessionId]: {
        sessionId,
        status: "waiting_first_token",
        firstTokenMs: null,
        completedMs: null,
        errorMessage: null,
        updatedAt: new Date().toISOString(),
        },
      },
    }));
    updateChatFeedbackSnapshot((current) => {
      if (!(sessionId in current.recentBySessionId)) {
        return current;
      }
      const next = { ...current.recentBySessionId };
      delete next[sessionId];
      return {
        ...current,
        recentBySessionId: next,
      };
    });
  });

  const trackChatFailure = useEffectEvent(
    (sessionId: string, message: string) => {
      const tracked = pendingChatMetricsRef.current.get(sessionId);
      const nextCompletedMs = tracked
        ? Number((performance.now() - tracked.startedAt).toFixed(2))
        : null;
      if (tracked && !tracked.firstTokenFinished) {
        tracked.firstToken.finish({
          outcome: "error",
        });
        tracked.firstTokenFinished = true;
      }
      tracked?.completed.finish({
        outcome: "error",
      });
      pendingChatMetricsRef.current.delete(sessionId);
      updateChatFeedbackSnapshot((current) => ({
        ...current,
        liveBySessionId: {
          ...current.liveBySessionId,
          [sessionId]: {
          sessionId,
          status: "error",
          firstTokenMs: current.liveBySessionId[sessionId]?.firstTokenMs ?? null,
          completedMs:
            nextCompletedMs ??
            current.liveBySessionId[sessionId]?.completedMs ??
            null,
          errorMessage: message,
          updatedAt: new Date().toISOString(),
          },
        },
      }));
      updateChatFeedbackSnapshot((current) => {
        const live = current.liveBySessionId[sessionId] ?? null;
        const recent = current.recentBySessionId[sessionId] ?? null;
        return {
          ...current,
          recentBySessionId: {
            ...current.recentBySessionId,
            [sessionId]: {
              sessionId,
              status: "error",
              firstTokenMs: live?.firstTokenMs ?? recent?.firstTokenMs ?? null,
              completedMs:
                nextCompletedMs ??
                live?.completedMs ??
                recent?.completedMs ??
                null,
              errorMessage: message,
              updatedAt: new Date().toISOString(),
            },
          },
        };
      });
      scheduleChatFeedbackClear(sessionId);
      setErrorMessage(message);
    },
  );

  const trackJobStart = useEffectEvent((jobId: string) => {
    pendingJobMetricsRef.current.set(
      jobId,
      clientPerformance.start("client.job.start_to_first_output", {
        jobId
      })
    );
  });

  const handleSocketMessage = useEffectEvent((event: ServerEvent) => {
    if (event.type === "chat.stream.delta") {
      const tracked = pendingChatMetricsRef.current.get(event.payload.sessionId);
      const firstTokenMs = tracked
        ? Number((performance.now() - tracked.startedAt).toFixed(2))
        : null;
      if (tracked && !tracked.firstTokenFinished) {
        tracked.firstToken.finish({
          runId: event.payload.runId
        });
        tracked.firstTokenFinished = true;
      }
      clearChatFeedbackTimeout(event.payload.sessionId);
      updateChatFeedbackSnapshot((current) => ({
        ...current,
        liveBySessionId: {
          ...current.liveBySessionId,
          [event.payload.sessionId]: {
          sessionId: event.payload.sessionId,
          status: "streaming",
          firstTokenMs:
            current.liveBySessionId[event.payload.sessionId]?.firstTokenMs ??
            firstTokenMs,
          completedMs: null,
          errorMessage: null,
          updatedAt: new Date().toISOString(),
          },
        },
      }));
      return;
    }

    if (event.type === "chat.stream.done") {
      const tracked = pendingChatMetricsRef.current.get(event.payload.sessionId);
      const nextCompletedMs = tracked
        ? Number((performance.now() - tracked.startedAt).toFixed(2))
        : null;
      if (tracked && !tracked.firstTokenFinished) {
        tracked.firstToken.finish({
          runId: event.payload.runId,
          outcome: "no-delta"
        });
        tracked.firstTokenFinished = true;
      }
      tracked?.completed.finish({
        runId: event.payload.runId,
        outcome: "done"
      });
      pendingChatMetricsRef.current.delete(event.payload.sessionId);
      updateChatFeedbackSnapshot((current) => ({
        ...current,
        liveBySessionId: {
          ...current.liveBySessionId,
          [event.payload.sessionId]: {
          sessionId: event.payload.sessionId,
          status: "done",
          firstTokenMs:
            current.liveBySessionId[event.payload.sessionId]?.firstTokenMs ??
            null,
          completedMs:
            nextCompletedMs ??
            current.liveBySessionId[event.payload.sessionId]?.completedMs ??
            null,
          errorMessage: null,
          updatedAt: new Date().toISOString(),
          },
        },
      }));
      updateChatFeedbackSnapshot((current) => {
        const live = current.liveBySessionId[event.payload.sessionId] ?? null;
        const recent = current.recentBySessionId[event.payload.sessionId] ?? null;
        return {
          ...current,
          recentBySessionId: {
            ...current.recentBySessionId,
            [event.payload.sessionId]: {
              sessionId: event.payload.sessionId,
              status: "done",
              firstTokenMs: live?.firstTokenMs ?? recent?.firstTokenMs ?? null,
              completedMs:
                nextCompletedMs ??
                live?.completedMs ??
                recent?.completedMs ??
                null,
              errorMessage: null,
              updatedAt: new Date().toISOString(),
            },
          },
        };
      });
      scheduleChatFeedbackClear(event.payload.sessionId);
      return;
    }

    if (event.type === "chat.stream.error") {
      const tracked = pendingChatMetricsRef.current.get(event.payload.sessionId);
      const nextCompletedMs = tracked
        ? Number((performance.now() - tracked.startedAt).toFixed(2))
        : null;
      if (tracked && !tracked.firstTokenFinished) {
        tracked.firstToken.finish({
          runId: event.payload.runId,
          outcome: "error"
        });
        tracked.firstTokenFinished = true;
      }
      tracked?.completed.finish({
        runId: event.payload.runId,
        outcome: "error"
      });
      pendingChatMetricsRef.current.delete(event.payload.sessionId);
      updateChatFeedbackSnapshot((current) => ({
        ...current,
        liveBySessionId: {
          ...current.liveBySessionId,
          [event.payload.sessionId]: {
          sessionId: event.payload.sessionId,
          status: "error",
          firstTokenMs:
            current.liveBySessionId[event.payload.sessionId]?.firstTokenMs ??
            null,
          completedMs:
            nextCompletedMs ??
            current.liveBySessionId[event.payload.sessionId]?.completedMs ??
            null,
          errorMessage: event.payload.message,
          updatedAt: new Date().toISOString(),
          },
        },
      }));
      updateChatFeedbackSnapshot((current) => {
        const live = current.liveBySessionId[event.payload.sessionId] ?? null;
        const recent = current.recentBySessionId[event.payload.sessionId] ?? null;
        return {
          ...current,
          recentBySessionId: {
            ...current.recentBySessionId,
            [event.payload.sessionId]: {
              sessionId: event.payload.sessionId,
              status: "error",
              firstTokenMs: live?.firstTokenMs ?? recent?.firstTokenMs ?? null,
              completedMs:
                nextCompletedMs ??
                live?.completedMs ??
                recent?.completedMs ??
                null,
              errorMessage: event.payload.message,
              updatedAt: new Date().toISOString(),
            },
          },
        };
      });
      scheduleChatFeedbackClear(event.payload.sessionId);
      setErrorMessage(event.payload.message);
      return;
    }

    if (event.type === "job.output") {
      const tracked = pendingJobMetricsRef.current.get(event.payload.jobId);
      if (tracked) {
        tracked.finish({
          stream: event.payload.stream
        });
        pendingJobMetricsRef.current.delete(event.payload.jobId);
      }
      return;
    }

    if (event.type === "terminal.updated") {
      terminalStore.updateSession(event.payload);
      return;
    }

    if (event.type === "terminal.output") {
      terminalStore.appendOutput(event.payload.sessionId, event.payload.data);
      return;
    }

    if (event.type === "terminal.closed") {
      terminalStore.close(event.payload.sessionId, event.payload.reason);
      return;
    }

    if (event.type === "error") {
      setErrorMessage(event.payload.message);
    }
  });

  const authQuery = useAuthQuery();
  const dashboardQuery = useDashboardQuery(Boolean(authQuery.data?.user));
  const dashboardSessions = dashboardQuery.data?.sessions ?? [];
  usePasskeysQuery(Boolean(authQuery.data?.user));
  useAccessQuery();

  const { status: wsStatus, send: sendRealtimeCommand } = useWebSocket({
    enabled: Boolean(authQuery.data?.user),
    onMessage: handleSocketMessage
  });

  const authReadyRecordedRef = useRef(false);
  const dashboardReadyRecordedRef = useRef(false);

  useEffect(() => {
    if (authQuery.isSuccess && !authReadyRecordedRef.current) {
      authReadyRecordedRef.current = true;
      clientPerformance.record("client.auth.ready", performance.now(), {
        hasUser: Boolean(authQuery.data?.user)
      });
    }
  }, [authQuery.data?.user, authQuery.isSuccess]);

  useEffect(() => {
    if (dashboardQuery.isSuccess && !dashboardReadyRecordedRef.current) {
      dashboardReadyRecordedRef.current = true;
      clientPerformance.record("client.dashboard.ready", performance.now(), {
        sessions: dashboardSessions.length
      });
    }
  }, [dashboardQuery.isSuccess, dashboardSessions.length]);

  useEffect(() => {
    if (dashboardSessions.length === 0) {
      return;
    }
    if (dashboardSessions.some((session) => session.id === selectedSessionId)) {
      return;
    }
    startTransition(() => {
      setSelectedSessionId(dashboardSessions[0]!.id);
    });
  }, [dashboardSessions, selectedSessionId]);

  useEffect(() => {
    if (!authQuery.data?.user) {
      return;
    }

    const targetSessionId = dashboardSessions.some((session) => session.id === selectedSessionId)
      ? selectedSessionId
      : dashboardSessions[0]?.id;
    if (
      targetSessionId &&
      !queryClient.getQueryData<ChatMessage[]>([
        "sessions",
        targetSessionId,
        "messages",
      ])
    ) {
      void queryClient.prefetchQuery({
        queryKey: ["sessions", targetSessionId, "messages"],
        queryFn: () => api<ChatMessage[]>(`/api/sessions/${encodeURIComponent(targetSessionId)}/messages`)
      });
    }
  }, [authQuery.data?.user, dashboardSessions, queryClient, selectedSessionId]);

  const installApp = useEffectEvent(async () => {
    if (!installPromptEvent) {
      return;
    }
    await installPromptEvent.prompt();
    await installPromptEvent.userChoice.catch(() => undefined);
    setInstallPromptEvent(null);
  });

  const value = useMemo<DroidAgentAppContextValue>(
    () => ({
      notice,
      setNotice,
      errorMessage,
      setErrorMessage,
      isOnline,
      wsStatus,
      refreshQueries,
      runAction,
      selectedSessionId,
      setSelectedSessionId,
      sendRealtimeCommand,
      themePreference,
      resolvedTheme,
      setThemePreference,
      canInstallApp: Boolean(installPromptEvent),
      installApp,
      beginRouteTransition,
      finishRouteTransition,
      trackChatSubmit,
      trackChatFailure,
      trackJobStart,
    }),
    [
      beginRouteTransition,
      errorMessage,
      finishRouteTransition,
      installApp,
      installPromptEvent,
      isOnline,
      notice,
      refreshQueries,
      runAction,
      selectedSessionId,
      sendRealtimeCommand,
      themePreference,
      resolvedTheme,
      trackChatSubmit,
      trackChatFailure,
      trackJobStart,
      wsStatus,
    ]
  );

  return <DroidAgentAppContext.Provider value={value}>{children}</DroidAgentAppContext.Provider>;
}

export function useDroidAgentApp() {
  const context = useContext(DroidAgentAppContext);
  if (!context) {
    throw new Error("useDroidAgentApp must be used within DroidAgentAppProvider.");
  }
  return context;
}

export function useClientPerformanceSnapshot() {
  return useSyncExternalStore(
    (listener) => clientPerformance.subscribe(listener),
    () => clientPerformance.snapshot(),
    () => clientPerformance.snapshot()
  );
}

export function useChatFeedbackSnapshot() {
  return useSyncExternalStore(
    subscribeChatFeedback,
    getChatFeedbackSnapshot,
    getChatFeedbackSnapshot,
  );
}
