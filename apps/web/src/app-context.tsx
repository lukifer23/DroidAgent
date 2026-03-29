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
import type { ChatMessage, ClientCommand, ServerEvent, WorkspaceEntry } from "@droidagent/shared";

import { useAccessQuery, useAuthQuery, useDashboardQuery, usePasskeysQuery, usePerformanceQuery } from "./app-data";
import { useWebSocket } from "./hooks/use-websocket";
import { api } from "./lib/api";
import { clientPerformance } from "./lib/client-performance";
import { terminalStore } from "./lib/terminal-store";

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
  const pendingChatMetricsRef = useRef<
    Map<string, { firstToken: ReturnType<typeof clientPerformance.start>; completed: ReturnType<typeof clientPerformance.start> }>
  >(new Map());
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
      queryClient.invalidateQueries({ queryKey: ["performance"] })
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
    pendingChatMetricsRef.current.set(sessionId, {
      firstToken: clientPerformance.start("client.chat.submit_to_first_token", {
        sessionId
      }),
      completed: clientPerformance.start("client.chat.submit_to_done", {
        sessionId
      })
    });
  });

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
      tracked?.firstToken.finish({
        runId: event.payload.runId
      });
      return;
    }

    if (event.type === "chat.stream.done") {
      const tracked = pendingChatMetricsRef.current.get(event.payload.sessionId);
      tracked?.completed.finish({
        runId: event.payload.runId,
        outcome: "done"
      });
      pendingChatMetricsRef.current.delete(event.payload.sessionId);
      return;
    }

    if (event.type === "chat.stream.error") {
      const tracked = pendingChatMetricsRef.current.get(event.payload.sessionId);
      tracked?.firstToken.finish({
        runId: event.payload.runId,
        outcome: "error"
      });
      tracked?.completed.finish({
        runId: event.payload.runId,
        outcome: "error"
      });
      pendingChatMetricsRef.current.delete(event.payload.sessionId);
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
  usePerformanceQuery(Boolean(authQuery.data?.user));

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

    const workspaceRoot = dashboardQuery.data?.setup?.workspaceRoot;
    const targetSessionId = dashboardSessions.some((session) => session.id === selectedSessionId)
      ? selectedSessionId
      : dashboardSessions[0]?.id;
    if (targetSessionId) {
      void queryClient.prefetchQuery({
        queryKey: ["sessions", targetSessionId, "messages"],
        queryFn: () => api<ChatMessage[]>(`/api/sessions/${encodeURIComponent(targetSessionId)}/messages`)
      });
    }

    if (workspaceRoot) {
      void queryClient.prefetchQuery({
        queryKey: ["files", "."],
        queryFn: () => api<WorkspaceEntry[]>("/api/files?path=.")
      });
    }
  }, [authQuery.data?.user, dashboardSessions, dashboardQuery.data?.setup?.workspaceRoot, queryClient, selectedSessionId]);

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
      trackJobStart
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
      trackJobStart,
      wsStatus
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
