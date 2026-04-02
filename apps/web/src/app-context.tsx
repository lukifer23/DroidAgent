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
import type { ClientCommand, ServerEvent } from "@droidagent/shared";

import { useAccessQuery, useAuthQuery, useDashboardQuery, usePasskeysQuery } from "./app-data";
import { useWebSocket } from "./hooks/use-websocket";
import { clientPerformance } from "./lib/client-performance";
import { prefetchSessionMessages } from "./lib/chat-session-cache";
import {
  chatSessionStore,
  type ChatSessionFeedback,
} from "./lib/chat-session-store";
export type { ChatSessionFeedback } from "./lib/chat-session-store";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
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

const DroidAgentAppContext = createContext<DroidAgentAppContextValue | null>(null);

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
  const pendingJobMetricsRef = useRef<Map<string, ReturnType<typeof clientPerformance.start>>>(new Map());

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

  const trackChatSubmit = useEffectEvent((sessionId: string) => {
    chatSessionStore.trackSubmit(sessionId);
  });

  const trackChatFailure = useEffectEvent(
    (sessionId: string, message: string) => {
      chatSessionStore.trackFailure(sessionId, message);
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
      chatSessionStore.getSessionSnapshot(targetSessionId).historyStatus !== "ready"
    ) {
      void prefetchSessionMessages(queryClient, targetSessionId);
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
    (listener) => chatSessionStore.subscribe(listener),
    () => {
      const snapshot = chatSessionStore.getSnapshot();
      const liveBySessionId: Record<string, ChatSessionFeedback> = {};
      const recentBySessionId: Record<string, ChatSessionFeedback> = {};
      for (const [sessionId, session] of Object.entries(snapshot.sessions)) {
        if (session.liveFeedback) {
          liveBySessionId[sessionId] = session.liveFeedback;
        }
        if (session.recentFeedback) {
          recentBySessionId[sessionId] = session.recentFeedback;
        }
      }
      return {
        liveBySessionId,
        recentBySessionId,
      };
    },
    () => ({
      liveBySessionId: {},
      recentBySessionId: {},
    }),
  );
}
