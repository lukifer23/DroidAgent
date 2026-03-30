import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ClientCommand, DashboardState, JobOutputSnapshot, ServerEvent } from "@droidagent/shared";

import { chatStreamStore } from "../lib/chat-stream-store";
import { chatRunStore } from "../lib/chat-run-store";
import { clientPerformance } from "../lib/client-performance";

const INITIAL_DELAY_MS = 500;
const MAX_DELAY_MS = 30000;
const SNAPSHOT_URL = "/api/dashboard";
const DASHBOARD_SYNC_DEBOUNCE_MS = 180;

export interface UseWebSocketOptions {
  enabled: boolean;
  onMessage?: (event: ServerEvent) => void;
}

function updateDashboardState(current: DashboardState | undefined, event: ServerEvent): DashboardState | undefined {
  if (!current) {
    return current;
  }

  if (event.type === "setup.updated") {
    return {
      ...current,
      setup: event.payload
    };
  }

  if (event.type === "access.updated") {
    return {
      ...current,
      canonicalUrl: event.payload.canonicalOrigin?.origin ?? null,
      tailscaleStatus: event.payload.tailscaleStatus,
      cloudflareStatus: event.payload.cloudflareStatus,
      serveStatus: event.payload.serveStatus,
      bootstrapRequired: event.payload.bootstrapRequired
    };
  }

  if (event.type === "runtime.updated") {
    return {
      ...current,
      runtimes: event.payload
    };
  }

  if (event.type === "providers.updated") {
    return {
      ...current,
      providers: event.payload.providers,
      cloudProviders: event.payload.cloudProviders
    };
  }

  if (event.type === "channel.updated") {
    return {
      ...current,
      channels: event.payload.statuses,
      channelConfig: event.payload.config
    };
  }

  if (event.type === "launchAgent.updated") {
    return {
      ...current,
      launchAgent: event.payload
    };
  }

  if (event.type === "context.updated") {
    return {
      ...current,
      contextManagement: event.payload
    };
  }

  if (event.type === "memory.updated") {
    return {
      ...current,
      memory: event.payload
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
      sessions: event.payload
    };
  }

  if (event.type === "job.updated") {
    return {
      ...current,
      jobs: current.jobs.some((job) => job.id === event.payload.id)
        ? current.jobs.map((job) => (job.id === event.payload.id ? event.payload : job))
        : [event.payload, ...current.jobs]
    };
  }

  if (event.type === "decision.updated") {
    return {
      ...current,
      decisions: current.decisions.some((decision) => decision.id === event.payload.id)
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
      approvals: current.approvals.some((approval) => approval.id === event.payload.id)
        ? current.approvals.map((approval) => (approval.id === event.payload.id ? event.payload : approval))
        : [event.payload, ...current.approvals]
    };
  }

  if (event.type === "approvals.updated") {
    return {
      ...current,
      approvals: event.payload
    };
  }

  return current;
}

export function useWebSocket(options: UseWebSocketOptions) {
  const { enabled, onMessage } = options;
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<"disconnected" | "connecting" | "connected">("disconnected");
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onMessageRef = useRef(onMessage);
  const reconnectStartedAtRef = useRef<number | null>(null);
  const flushHandleRef = useRef<number | ReturnType<typeof setTimeout> | null>(null);
  const pendingStreamRunsRef = useRef<Record<string, { runId: string; text: string }>>({});
  const pendingStreamClearTimeoutsRef = useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map());
  const pendingJobOutputRef = useRef<Map<string, { stdout: string; stderr: string; stdoutBytes: number; stderrBytes: number }>>(
    new Map()
  );
  const dashboardSyncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  onMessageRef.current = onMessage;

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
    flushHandleRef.current = null;

    const pendingRuns = pendingStreamRunsRef.current;
    const hasRuns = Object.keys(pendingRuns).length > 0;
    if (hasRuns) {
      chatStreamStore.setRuns({
        ...chatStreamStore.getSnapshot(),
        ...pendingRuns
      });
      pendingStreamRunsRef.current = {};
    }

    if (pendingJobOutputRef.current.size > 0) {
      for (const [jobId, pending] of pendingJobOutputRef.current.entries()) {
        queryClient.setQueryData<JobOutputSnapshot | undefined>(["jobs", jobId, "output"], (current) => {
          if (!current) {
            return {
              jobId,
              stdout: pending.stdout,
              stderr: pending.stderr,
              truncated: false,
              stdoutBytes: pending.stdoutBytes,
              stderrBytes: pending.stderrBytes
            };
          }

          return {
            ...current,
            stdout: `${current.stdout}${pending.stdout}`,
            stderr: `${current.stderr}${pending.stderr}`,
            stdoutBytes: current.stdoutBytes + pending.stdoutBytes,
            stderrBytes: current.stderrBytes + pending.stderrBytes
          };
        });
      }
      pendingJobOutputRef.current.clear();
    }
  }, [queryClient]);

  const clearDeferredStreamClear = useCallback((sessionId: string) => {
    const timeoutId = pendingStreamClearTimeoutsRef.current.get(sessionId);
    if (!timeoutId) {
      return;
    }
    clearTimeout(timeoutId);
    pendingStreamClearTimeoutsRef.current.delete(sessionId);
  }, []);

  const scheduleDeferredStreamClear = useCallback(
    (sessionId: string, runId: string) => {
      clearDeferredStreamClear(sessionId);
      const timeoutId = setTimeout(() => {
        pendingStreamClearTimeoutsRef.current.delete(sessionId);
        const activeRun = chatStreamStore.getSnapshot()[sessionId];
        if (activeRun?.runId !== runId) {
          return;
        }
        chatStreamStore.clear(sessionId);
      }, 4_000);
      pendingStreamClearTimeoutsRef.current.set(sessionId, timeoutId);
    },
    [clearDeferredStreamClear],
  );

  const scheduleFlush = useCallback(() => {
    if (flushHandleRef.current !== null) {
      return;
    }

    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
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

  const connect = useCallback(() => {
    if (!enabled) return;

    setStatus("connecting");
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      const reconnectStartedAt = reconnectStartedAtRef.current;
      retryRef.current = 0;
      setStatus("connected");
      if (reconnectStartedAt !== null) {
        clientPerformance.record("client.ws.reconnect_to_socket", performance.now() - reconnectStartedAt, {
          attempt: retryRef.current
        }, reconnectStartedAt);
        reconnectStartedAtRef.current = null;
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
          clearDeferredStreamClear(payload.payload.sessionId);
          chatStreamStore.clear(payload.payload.sessionId);
          queryClient.setQueryData(["sessions", payload.payload.sessionId, "messages"], payload.payload.messages);
        }
        if (payload.type === "chat.stream.delta") {
          clearDeferredStreamClear(payload.payload.sessionId);
          const existing = pendingStreamRunsRef.current[payload.payload.sessionId] ?? chatStreamStore.getSnapshot()[payload.payload.sessionId];
          const nextRun = {
            runId: payload.payload.runId,
            text: `${existing?.runId === payload.payload.runId ? existing.text : ""}${payload.payload.delta}`
          };
          if (!existing || existing.runId !== payload.payload.runId) {
            chatStreamStore.setRuns({
              ...chatStreamStore.getSnapshot(),
              [payload.payload.sessionId]: nextRun
            });
            delete pendingStreamRunsRef.current[payload.payload.sessionId];
          } else {
            pendingStreamRunsRef.current[payload.payload.sessionId] = nextRun;
            scheduleFlush();
          }
        }
        if (payload.type === "chat.stream.done" || payload.type === "chat.stream.error") {
          if (flushHandleRef.current !== null) {
            flushPendingRealtimeState();
          }
          delete pendingStreamRunsRef.current[payload.payload.sessionId];
          scheduleDeferredStreamClear(
            payload.payload.sessionId,
            payload.payload.runId,
          );
        }
        if (payload.type === "chat.run") {
          chatRunStore.setRun(payload.payload);
          if (!payload.payload.active) {
            if (
              payload.payload.stage === "completed" ||
              payload.payload.stage === "failed"
            ) {
              window.setTimeout(() => {
                chatRunStore.clear(payload.payload.sessionId);
              }, 4000);
            }
          }
        }
        if (payload.type === "job.output") {
          const chunkBytes = new TextEncoder().encode(payload.payload.chunk).length;
          const existing = pendingJobOutputRef.current.get(payload.payload.jobId) ?? {
            stdout: "",
            stderr: "",
            stdoutBytes: 0,
            stderrBytes: 0
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
        if (
          payload.type === "setup.updated" ||
          payload.type === "access.updated" ||
          payload.type === "runtime.updated" ||
          payload.type === "providers.updated" ||
          payload.type === "channel.updated" ||
          payload.type === "launchAgent.updated" ||
          payload.type === "memory.updated" ||
          payload.type === "memoryDrafts.updated" ||
          payload.type === "context.updated" ||
          payload.type === "harness.updated" ||
          payload.type === "maintenance.updated" ||
          payload.type === "sessions.updated" ||
          payload.type === "job.updated" ||
          payload.type === "decision.updated" ||
          payload.type === "decisions.updated" ||
          payload.type === "approval.updated" ||
          payload.type === "approvals.updated"
        ) {
          queryClient.setQueryData<DashboardState | undefined>(["dashboard"], (current) => updateDashboardState(current, payload));
          if (payload.type === "sessions.updated") {
            void queryClient.invalidateQueries({ queryKey: ["sessions", "archived"] });
          }
          if (
            payload.type === "runtime.updated" ||
            payload.type === "providers.updated" ||
            payload.type === "channel.updated" ||
            payload.type === "context.updated" ||
            payload.type === "memory.updated" ||
            payload.type === "memoryDrafts.updated" ||
            payload.type === "decision.updated" ||
            payload.type === "decisions.updated" ||
            payload.type === "approval.updated" ||
            payload.type === "approvals.updated" ||
            payload.type === "maintenance.updated"
          ) {
            syncDashboardSnapshot();
          }
          if (
            payload.type === "setup.updated" ||
            payload.type === "access.updated" ||
            payload.type === "runtime.updated" ||
            payload.type === "providers.updated" ||
            payload.type === "channel.updated" ||
            payload.type === "launchAgent.updated" ||
            payload.type === "memory.updated" ||
            payload.type === "memoryDrafts.updated" ||
            payload.type === "decision.updated" ||
            payload.type === "decisions.updated" ||
            payload.type === "context.updated"
          ) {
            void queryClient.invalidateQueries({ queryKey: ["startupDiagnostics"] });
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
      setStatus("disconnected");
      reconnectStartedAtRef.current = performance.now();

      if (!enabled) return;

      const delay = Math.min(INITIAL_DELAY_MS * Math.pow(2, retryRef.current), MAX_DELAY_MS);
      retryRef.current += 1;

      timeoutRef.current = setTimeout(async () => {
        try {
          const [dashboardResponse, accessResponse] = await Promise.all([
            fetch(SNAPSHOT_URL, { credentials: "include" }),
            fetch("/api/access", { credentials: "include" })
          ]);
          if (dashboardResponse.ok) {
            const data = await dashboardResponse.json();
            queryClient.setQueryData(["dashboard"], data);
          }
          if (accessResponse.ok) {
            const access = await accessResponse.json();
            queryClient.setQueryData(["access"], access);
          }
          if (reconnectStartedAtRef.current !== null) {
            clientPerformance.record(
              "client.ws.reconnect_to_resync",
              performance.now() - reconnectStartedAtRef.current,
              {
                attempt: retryRef.current
              },
              reconnectStartedAtRef.current
            );
          }
        } catch {
          // ignore
        }
        connect();
      }, delay);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [
    clearDeferredStreamClear,
    enabled,
    flushPendingRealtimeState,
    queryClient,
    scheduleDeferredStreamClear,
    syncDashboardSnapshot,
  ]);

  useEffect(() => {
    connect();
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      if (dashboardSyncTimeoutRef.current) {
        clearTimeout(dashboardSyncTimeoutRef.current);
        dashboardSyncTimeoutRef.current = null;
      }
      if (flushHandleRef.current !== null) {
        if (typeof flushHandleRef.current === "number" && typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
          window.cancelAnimationFrame(flushHandleRef.current);
        } else {
          clearTimeout(flushHandleRef.current as ReturnType<typeof setTimeout>);
        }
        flushHandleRef.current = null;
      }
      for (const timeoutId of pendingStreamClearTimeoutsRef.current.values()) {
        clearTimeout(timeoutId);
      }
      pendingStreamClearTimeoutsRef.current.clear();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect, flushPendingRealtimeState]);

  return {
    status,
    send
  };
}
