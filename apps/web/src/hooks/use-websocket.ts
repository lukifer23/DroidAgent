import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  ClientCommand,
  DashboardState,
  JobOutputSnapshot,
  ServerEvent,
} from "@droidagent/shared";

import { clientPerformance } from "../lib/client-performance";
import { chatSessionStore } from "../lib/chat-session-store";
import { terminalStore } from "../lib/terminal-store";

const INITIAL_DELAY_MS = 500;
const MAX_DELAY_MS = 30000;
const SNAPSHOT_URL = "/api/dashboard";
const DASHBOARD_SYNC_DEBOUNCE_MS = 180;
const UTF8_ENCODER = new TextEncoder();
const DASHBOARD_PATCH_EVENT_TYPES = new Set<ServerEvent["type"]>([
  "setup.updated",
  "access.updated",
  "runtime.updated",
  "providers.updated",
  "channel.updated",
  "launchAgent.updated",
  "memory.updated",
  "hostPressure.updated",
  "memoryDrafts.updated",
  "context.updated",
  "harness.updated",
  "maintenance.updated",
  "sessions.updated",
  "job.updated",
  "decision.updated",
  "decisions.updated",
  "approval.updated",
  "approvals.updated",
]);
const DASHBOARD_RESYNC_EVENT_TYPES = new Set<ServerEvent["type"]>([
  "runtime.updated",
  "providers.updated",
  "channel.updated",
  "context.updated",
  "memory.updated",
  "memoryDrafts.updated",
  "decision.updated",
  "decisions.updated",
  "approval.updated",
  "approvals.updated",
  "maintenance.updated",
]);
const STARTUP_DIAGNOSTIC_EVENT_TYPES = new Set<ServerEvent["type"]>([
  "setup.updated",
  "access.updated",
  "runtime.updated",
  "providers.updated",
  "channel.updated",
  "launchAgent.updated",
  "memory.updated",
  "memoryDrafts.updated",
  "decision.updated",
  "decisions.updated",
  "context.updated",
]);

function shouldPatchDashboard(event: ServerEvent): boolean {
  return DASHBOARD_PATCH_EVENT_TYPES.has(event.type);
}

function shouldResyncDashboard(event: ServerEvent): boolean {
  return DASHBOARD_RESYNC_EVENT_TYPES.has(event.type);
}

function shouldRefreshStartupDiagnostics(event: ServerEvent): boolean {
  return STARTUP_DIAGNOSTIC_EVENT_TYPES.has(event.type);
}

export interface UseWebSocketOptions {
  enabled: boolean;
  onMessage?: (event: ServerEvent) => void;
}

function updateDashboardState(
  current: DashboardState | undefined,
  event: ServerEvent,
): DashboardState | undefined {
  if (!current) {
    return current;
  }

  if (event.type === "setup.updated") {
    return {
      ...current,
      setup: event.payload,
    };
  }

  if (event.type === "access.updated") {
    return {
      ...current,
      canonicalUrl: event.payload.canonicalOrigin?.origin ?? null,
      tailscaleStatus: event.payload.tailscaleStatus,
      cloudflareStatus: event.payload.cloudflareStatus,
      serveStatus: event.payload.serveStatus,
      bootstrapRequired: event.payload.bootstrapRequired,
    };
  }

  if (event.type === "runtime.updated") {
    return {
      ...current,
      runtimes: event.payload,
    };
  }

  if (event.type === "providers.updated") {
    return {
      ...current,
      providers: event.payload.providers,
      cloudProviders: event.payload.cloudProviders,
    };
  }

  if (event.type === "channel.updated") {
    return {
      ...current,
      channels: event.payload.statuses,
      channelConfig: event.payload.config,
    };
  }

  if (event.type === "launchAgent.updated") {
    return {
      ...current,
      launchAgent: event.payload,
    };
  }

  if (event.type === "context.updated") {
    return {
      ...current,
      contextManagement: event.payload,
    };
  }

  if (event.type === "memory.updated") {
    return {
      ...current,
      memory: event.payload,
    };
  }

  if (event.type === "hostPressure.updated") {
    return {
      ...current,
      hostPressure: event.payload,
    };
  }

  if (event.type === "memoryDrafts.updated") {
    return {
      ...current,
      memoryDrafts: event.payload,
    };
  }

  if (event.type === "harness.updated") {
    return {
      ...current,
      harness: event.payload,
    };
  }

  if (event.type === "maintenance.updated") {
    return {
      ...current,
      maintenance: event.payload,
    };
  }

  if (event.type === "sessions.updated") {
    return {
      ...current,
      sessions: event.payload,
    };
  }

  if (event.type === "job.updated") {
    return {
      ...current,
      jobs: current.jobs.some((job) => job.id === event.payload.id)
        ? current.jobs.map((job) =>
            job.id === event.payload.id ? event.payload : job,
          )
        : [event.payload, ...current.jobs],
    };
  }

  if (event.type === "decision.updated") {
    return {
      ...current,
      decisions: current.decisions.some(
        (decision) => decision.id === event.payload.id,
      )
        ? current.decisions.map((decision) =>
            decision.id === event.payload.id ? event.payload : decision,
          )
        : [event.payload, ...current.decisions],
    };
  }

  if (event.type === "decisions.updated") {
    return {
      ...current,
      decisions: event.payload,
    };
  }

  if (event.type === "approval.updated") {
    return {
      ...current,
      approvals: current.approvals.some(
        (approval) => approval.id === event.payload.id,
      )
        ? current.approvals.map((approval) =>
            approval.id === event.payload.id ? event.payload : approval,
          )
        : [event.payload, ...current.approvals],
    };
  }

  if (event.type === "approvals.updated") {
    return {
      ...current,
      approvals: event.payload,
    };
  }

  return current;
}

export function useWebSocket(options: UseWebSocketOptions) {
  const { enabled, onMessage } = options;
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<
    "disconnected" | "connecting" | "connected"
  >("disconnected");
  const wsRef = useRef<WebSocket | null>(null);
  const connectRef = useRef<() => void>(() => undefined);
  const retryRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onMessageRef = useRef(onMessage);
  const reconnectStartedAtRef = useRef<number | null>(null);
  const reconnectVersionRef = useRef(0);
  const flushHandleRef = useRef<number | ReturnType<typeof setTimeout> | null>(
    null,
  );
  const pendingJobOutputRef = useRef<
    Map<
      string,
      {
        stdout: string;
        stderr: string;
        stdoutBytes: number;
        stderrBytes: number;
      }
    >
  >(new Map());
  const dashboardSyncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const reconnectResyncPromiseRef = useRef<Promise<void> | null>(null);
  const closingRef = useRef(false);
  onMessageRef.current = onMessage;

  const clearReconnectTimeout = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const syncDashboardSnapshot = useCallback(() => {
    if (dashboardSyncTimeoutRef.current) {
      clearTimeout(dashboardSyncTimeoutRef.current);
    }

    dashboardSyncTimeoutRef.current = setTimeout(async () => {
      dashboardSyncTimeoutRef.current = null;
      try {
        const response = await fetch(SNAPSHOT_URL, { credentials: "include" });
        if (!response.ok) {
          return;
        }
        const data = await response.json();
        queryClient.setQueryData(["dashboard"], data);
      } catch {
        // ignored by design; WS patches keep UI mostly current
      }
    }, DASHBOARD_SYNC_DEBOUNCE_MS);
  }, [queryClient]);

  const flushPendingRealtimeState = useCallback(() => {
    const flushMetric = clientPerformance.start("client.ws.patch_flush");
    flushHandleRef.current = null;
    const pendingJobCount = pendingJobOutputRef.current.size;

    if (pendingJobOutputRef.current.size > 0) {
      for (const [jobId, pending] of pendingJobOutputRef.current.entries()) {
        queryClient.setQueryData<JobOutputSnapshot | undefined>(
          ["jobs", jobId, "output"],
          (current) => {
            if (!current) {
              return {
                jobId,
                stdout: pending.stdout,
                stderr: pending.stderr,
                truncated: false,
                stdoutBytes: pending.stdoutBytes,
                stderrBytes: pending.stderrBytes,
              };
            }

            return {
              ...current,
              stdout: `${current.stdout}${pending.stdout}`,
              stderr: `${current.stderr}${pending.stderr}`,
              stdoutBytes: current.stdoutBytes + pending.stdoutBytes,
              stderrBytes: current.stderrBytes + pending.stderrBytes,
            };
          },
        );
      }
      pendingJobOutputRef.current.clear();
    }
    flushMetric.finish({
      jobPatches: pendingJobCount,
      outcome: "ok",
    });
  }, [queryClient]);

  const scheduleFlush = useCallback(() => {
    if (flushHandleRef.current !== null) {
      return;
    }

    if (
      typeof window !== "undefined" &&
      typeof window.requestAnimationFrame === "function"
    ) {
      flushHandleRef.current = window.requestAnimationFrame(() => {
        flushPendingRealtimeState();
      });
      return;
    }

    flushHandleRef.current = setTimeout(() => {
      flushPendingRealtimeState();
    }, 16);
  }, [flushPendingRealtimeState]);

  const send = useCallback((command: ClientCommand) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return false;
    }
    wsRef.current.send(JSON.stringify(command));
    return true;
  }, []);

  const resyncAfterReconnect = useCallback(
    (reconnectVersion: number) => {
      const reconnectStartedAt = reconnectStartedAtRef.current;
      if (reconnectStartedAt === null || reconnectResyncPromiseRef.current) {
        return reconnectResyncPromiseRef.current;
      }

      const reconnectAttempt = retryRef.current;
      reconnectResyncPromiseRef.current = (async () => {
        try {
          const [dashboardResponse, accessResponse] = await Promise.all([
            fetch(SNAPSHOT_URL, { credentials: "include" }),
            fetch("/api/access", { credentials: "include" }),
          ]);

          if (
            reconnectVersion === reconnectVersionRef.current &&
            wsRef.current?.readyState === WebSocket.OPEN
          ) {
            if (dashboardResponse.ok) {
              const data = await dashboardResponse.json();
              queryClient.setQueryData(["dashboard"], data);
            }
            if (accessResponse.ok) {
              const access = await accessResponse.json();
              queryClient.setQueryData(["access"], access);
            }
          }

          if (reconnectStartedAtRef.current === reconnectStartedAt) {
            clientPerformance.record(
              "client.ws.reconnect_to_resync",
              performance.now() - reconnectStartedAt,
              {
                attempt: reconnectAttempt,
                outcome: "ok",
              },
              reconnectStartedAt,
            );
            reconnectStartedAtRef.current = null;
          }
        } catch {
          if (reconnectStartedAtRef.current === reconnectStartedAt) {
            clientPerformance.record(
              "client.ws.reconnect_to_resync",
              performance.now() - reconnectStartedAt,
              {
                attempt: reconnectAttempt,
                outcome: "error",
              },
              reconnectStartedAt,
            );
            reconnectStartedAtRef.current = null;
          }
        } finally {
          reconnectResyncPromiseRef.current = null;
        }
      })();

      return reconnectResyncPromiseRef.current;
    },
    [queryClient],
  );

  const scheduleReconnect = useCallback(
    (delayMs?: number) => {
      if (!enabled || closingRef.current) {
        return;
      }
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        return;
      }
      if (
        wsRef.current &&
        (wsRef.current.readyState === WebSocket.OPEN ||
          wsRef.current.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }

      clearReconnectTimeout();
      const delay =
        delayMs ??
        Math.min(
          INITIAL_DELAY_MS * Math.pow(2, retryRef.current),
          MAX_DELAY_MS,
        );
      if (delay <= 0) {
        connectRef.current();
        return;
      }
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null;
        if (
          closingRef.current ||
          !enabled ||
          (typeof navigator !== "undefined" && navigator.onLine === false)
        ) {
          return;
        }
        connectRef.current();
      }, delay);
    },
    [clearReconnectTimeout, enabled],
  );

  const connect = useCallback(() => {
    if (!enabled || closingRef.current) {
      return;
    }
    if (
      wsRef.current &&
      (wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    clearReconnectTimeout();
    setStatus("connecting");
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      if (closingRef.current) {
        ws.close();
        return;
      }
      const reconnectStartedAt = reconnectStartedAtRef.current;
      const reconnectVersion = reconnectVersionRef.current;
      retryRef.current = 0;
      setStatus("connected");
      if (reconnectStartedAt !== null) {
        clientPerformance.record(
          "client.ws.reconnect_to_socket",
          performance.now() - reconnectStartedAt,
          {
            attempt: retryRef.current,
          },
          reconnectStartedAt,
        );
        void resyncAfterReconnect(reconnectVersion);
      }
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as ServerEvent;
        if (payload.type === "dashboard.state") {
          queryClient.setQueryData(["dashboard"], payload.payload);
        }
        if (payload.type === "access.updated") {
          queryClient.setQueryData(["access"], payload.payload);
        }
        if (payload.type === "chat.history") {
          queryClient.setQueryData(
            ["sessions", payload.payload.sessionId, "messages"],
            payload.payload.messages,
          );
          chatSessionStore.handleHistoryEvent(payload.payload);
        }
        if (payload.type === "chat.stream.delta") {
          chatSessionStore.handleStreamDelta(payload.payload);
        }
        if (payload.type === "chat.stream.done") {
          chatSessionStore.handleStreamDone(payload.payload);
        }
        if (payload.type === "chat.stream.error") {
          chatSessionStore.handleStreamError(payload.payload);
        }
        if (payload.type === "chat.run") {
          chatSessionStore.handleRunEvent(payload.payload);
        }
        if (payload.type === "job.output") {
          const chunkBytes = UTF8_ENCODER.encode(payload.payload.chunk).length;
          const existing = pendingJobOutputRef.current.get(
            payload.payload.jobId,
          ) ?? {
            stdout: "",
            stderr: "",
            stdoutBytes: 0,
            stderrBytes: 0,
          };
          if (payload.payload.stream === "stdout") {
            existing.stdout += payload.payload.chunk;
            existing.stdoutBytes += chunkBytes;
          } else {
            existing.stderr += payload.payload.chunk;
            existing.stderrBytes += chunkBytes;
          }
          pendingJobOutputRef.current.set(payload.payload.jobId, existing);
          scheduleFlush();
        }
        if (payload.type === "terminal.updated") {
          terminalStore.updateSession(payload.payload);
        }
        if (payload.type === "terminal.output") {
          terminalStore.appendOutput(
            payload.payload.sessionId,
            payload.payload.data,
          );
        }
        if (payload.type === "terminal.closed") {
          terminalStore.close(
            payload.payload.sessionId,
            payload.payload.reason,
          );
        }
        if (shouldPatchDashboard(payload)) {
          queryClient.setQueryData<DashboardState | undefined>(
            ["dashboard"],
            (current) => updateDashboardState(current, payload),
          );
          if (payload.type === "sessions.updated") {
            void queryClient.invalidateQueries({
              queryKey: ["sessions", "archived"],
            });
          }
          if (shouldResyncDashboard(payload)) {
            syncDashboardSnapshot();
          }
          if (shouldRefreshStartupDiagnostics(payload)) {
            void queryClient.invalidateQueries({
              queryKey: ["startupDiagnostics"],
            });
          }
        }
        if (payload.type === "performance.updated") {
          queryClient.setQueryData(["performance"], payload.payload);
        }
        onMessageRef.current?.(payload);
      } catch {
        // ignore parse errors
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
      if (closingRef.current) {
        return;
      }
      setStatus("disconnected");
      reconnectVersionRef.current += 1;
      if (!enabled) {
        return;
      }
      if (reconnectStartedAtRef.current === null) {
        reconnectStartedAtRef.current = performance.now();
      }
      retryRef.current += 1;
      scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [
    clearReconnectTimeout,
    enabled,
    queryClient,
    resyncAfterReconnect,
    scheduleReconnect,
    syncDashboardSnapshot,
  ]);
  connectRef.current = connect;

  useEffect(() => {
    closingRef.current = false;
    connect();

    const handleOnline = () => {
      retryRef.current = 0;
      if (reconnectStartedAtRef.current === null) {
        reconnectStartedAtRef.current = performance.now();
      }
      clearReconnectTimeout();
      connectRef.current();
    };

    const handleOffline = () => {
      clearReconnectTimeout();
      if (
        wsRef.current &&
        (wsRef.current.readyState === WebSocket.OPEN ||
          wsRef.current.readyState === WebSocket.CONNECTING)
      ) {
        wsRef.current.close();
      }
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      closingRef.current = true;
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      clearReconnectTimeout();
      if (dashboardSyncTimeoutRef.current) {
        clearTimeout(dashboardSyncTimeoutRef.current);
        dashboardSyncTimeoutRef.current = null;
      }
      if (flushHandleRef.current !== null) {
        if (
          typeof flushHandleRef.current === "number" &&
          typeof window !== "undefined" &&
          typeof window.cancelAnimationFrame === "function"
        ) {
          window.cancelAnimationFrame(flushHandleRef.current);
        } else {
          clearTimeout(flushHandleRef.current as ReturnType<typeof setTimeout>);
        }
        flushHandleRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [clearReconnectTimeout, connect, scheduleReconnect]);

  return {
    status,
    send,
  };
}
