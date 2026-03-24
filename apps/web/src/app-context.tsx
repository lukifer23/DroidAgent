import {
  createContext,
  startTransition,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  type ReactNode
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { BootstrapState, DashboardState, PasskeySummary, ServerEvent } from "@droidagent/shared";

import { useWebSocket } from "./hooks/use-websocket";
import { api } from "./lib/api";

interface AuthState {
  user: { id: string; username: string; displayName: string } | null;
  hasUser: boolean;
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

interface StreamingRun {
  runId: string;
  text: string;
}

interface DroidAgentAppContextValue {
  authQuery: ReturnType<typeof useQuery<AuthState>>;
  dashboardQuery: ReturnType<typeof useQuery<DashboardState>>;
  accessQuery: ReturnType<typeof useQuery<BootstrapState>>;
  passkeysQuery: ReturnType<typeof useQuery<PasskeySummary[]>>;
  dashboard: DashboardState | undefined;
  access: BootstrapState | undefined;
  notice: string | null;
  setNotice: (value: string | null) => void;
  errorMessage: string | null;
  setErrorMessage: (value: string | null) => void;
  isOnline: boolean;
  wsStatus: "disconnected" | "connecting" | "connected";
  refreshDashboard: () => Promise<void>;
  runAction: (work: () => Promise<void>, successMessage?: string) => Promise<void>;
  selectedSessionId: string;
  setSelectedSessionId: (sessionId: string) => void;
  streamingRuns: Record<string, StreamingRun>;
  canInstallApp: boolean;
  installApp: () => Promise<void>;
}

const DroidAgentAppContext = createContext<DroidAgentAppContextValue | null>(null);

export function DroidAgentAppProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  const [selectedSessionId, setSelectedSessionId] = useState("main");
  const [streamingRuns, setStreamingRuns] = useState<Record<string, StreamingRun>>({});
  const [installPromptEvent, setInstallPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);

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

  const authQuery = useQuery({
    queryKey: ["auth"],
    queryFn: () => api<AuthState>("/api/auth/me")
  });

  const accessQuery = useQuery({
    queryKey: ["access"],
    queryFn: () => api<BootstrapState>("/api/access")
  });

  const dashboardQuery = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api<DashboardState>("/api/dashboard"),
    enabled: Boolean(authQuery.data?.user)
  });

  const passkeysQuery = useQuery({
    queryKey: ["passkeys"],
    queryFn: () => api<PasskeySummary[]>("/api/auth/passkeys"),
    enabled: Boolean(authQuery.data?.user)
  });

  const refreshDashboard = useEffectEvent(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      queryClient.invalidateQueries({ queryKey: ["access"] }),
      queryClient.invalidateQueries({ queryKey: ["passkeys"] })
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

  const handleSocketMessage = useEffectEvent((event: ServerEvent) => {
    if (event.type === "chat.stream.delta") {
      setStreamingRuns((current) => {
        const existing = current[event.payload.sessionId];
        return {
          ...current,
          [event.payload.sessionId]: {
            runId: event.payload.runId,
            text: `${existing?.runId === event.payload.runId ? existing.text : ""}${event.payload.delta}`
          }
        };
      });
      return;
    }

    if (event.type === "chat.stream.done" || event.type === "chat.history") {
      setStreamingRuns((current) => {
        const next = { ...current };
        const sessionId = event.type === "chat.history" ? event.payload.sessionId : event.payload.sessionId;
        delete next[sessionId];
        return next;
      });
      return;
    }

    if (event.type === "chat.stream.error") {
      setErrorMessage(event.payload.message);
      setStreamingRuns((current) => {
        const next = { ...current };
        delete next[event.payload.sessionId];
        return next;
      });
      return;
    }

    if (event.type === "error") {
      setErrorMessage(event.payload.message);
    }
  });

  const { status: wsStatus } = useWebSocket({
    enabled: Boolean(authQuery.data?.user),
    onMessage: handleSocketMessage
  });

  useEffect(() => {
    if (authQuery.data?.user) {
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      void queryClient.invalidateQueries({ queryKey: ["passkeys"] });
    }
  }, [authQuery.data?.user, queryClient]);

  useEffect(() => {
    const sessions = dashboardQuery.data?.sessions ?? [];
    if (sessions.length === 0) {
      return;
    }
    if (sessions.some((session) => session.id === selectedSessionId)) {
      return;
    }
    startTransition(() => {
      setSelectedSessionId(sessions[0]!.id);
    });
  }, [dashboardQuery.data?.sessions, selectedSessionId]);

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
      authQuery,
      dashboardQuery,
      accessQuery,
      passkeysQuery,
      dashboard: dashboardQuery.data,
      access: accessQuery.data,
      notice,
      setNotice,
      errorMessage,
      setErrorMessage,
      isOnline,
      wsStatus,
      refreshDashboard,
      runAction,
      selectedSessionId,
      setSelectedSessionId,
      streamingRuns,
      canInstallApp: Boolean(installPromptEvent),
      installApp
    }),
    [
      accessQuery,
      authQuery,
      dashboardQuery,
      errorMessage,
      installApp,
      installPromptEvent,
      isOnline,
      notice,
      passkeysQuery,
      refreshDashboard,
      runAction,
      selectedSessionId,
      streamingRuns,
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
