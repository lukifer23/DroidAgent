import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ClientCommand, DashboardState, JobOutputSnapshot, ServerEvent } from "@droidagent/shared";

const INITIAL_DELAY_MS = 500;
const MAX_DELAY_MS = 30000;
const SNAPSHOT_URL = "/api/dashboard";

export interface UseWebSocketOptions {
  enabled: boolean;
  onMessage?: (event: ServerEvent) => void;
}

function updateDashboardState(current: DashboardState | undefined, event: ServerEvent): DashboardState | undefined {
  if (!current) {
    return current;
  }

  if (event.type === "job.updated") {
    return {
      ...current,
      jobs: current.jobs.some((job) => job.id === event.payload.id)
        ? current.jobs.map((job) => (job.id === event.payload.id ? event.payload : job))
        : [event.payload, ...current.jobs]
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
  onMessageRef.current = onMessage;

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
      retryRef.current = 0;
      setStatus("connected");
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as ServerEvent;
        if (payload.type === "dashboard.state") {
          queryClient.setQueryData(["dashboard"], payload.payload);
        }
        if (payload.type === "chat.history") {
          queryClient.setQueryData(["sessions", payload.payload.sessionId, "messages"], payload.payload.messages);
        }
        if (payload.type === "job.output") {
          queryClient.setQueryData<JobOutputSnapshot | undefined>(["jobs", payload.payload.jobId, "output"], (current) => {
            const chunkBytes = new TextEncoder().encode(payload.payload.chunk).length;
            if (!current) {
              return {
                jobId: payload.payload.jobId,
                stdout: payload.payload.stream === "stdout" ? payload.payload.chunk : "",
                stderr: payload.payload.stream === "stderr" ? payload.payload.chunk : "",
                truncated: false,
                stdoutBytes: payload.payload.stream === "stdout" ? chunkBytes : 0,
                stderrBytes: payload.payload.stream === "stderr" ? chunkBytes : 0
              };
            }

            return {
              ...current,
              stdout: payload.payload.stream === "stdout" ? `${current.stdout}${payload.payload.chunk}` : current.stdout,
              stderr: payload.payload.stream === "stderr" ? `${current.stderr}${payload.payload.chunk}` : current.stderr,
              stdoutBytes: payload.payload.stream === "stdout" ? current.stdoutBytes + chunkBytes : current.stdoutBytes,
              stderrBytes: payload.payload.stream === "stderr" ? current.stderrBytes + chunkBytes : current.stderrBytes
            };
          });
        }
        if (payload.type === "job.updated" || payload.type === "approval.updated") {
          queryClient.setQueryData<DashboardState | undefined>(["dashboard"], (current) => updateDashboardState(current, payload));
        }
        if (payload.type === "error") {
          queryClient.setQueryData(["lastError"], payload.payload.message);
        }
        onMessageRef.current?.(payload);
      } catch {
        // ignore parse errors
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
      setStatus("disconnected");

      if (!enabled) return;

      const delay = Math.min(INITIAL_DELAY_MS * Math.pow(2, retryRef.current), MAX_DELAY_MS);
      retryRef.current += 1;

      timeoutRef.current = setTimeout(async () => {
        try {
          const res = await fetch(SNAPSHOT_URL, { credentials: "include" });
          if (res.ok) {
            const data = await res.json();
            queryClient.setQueryData(["dashboard"], data);
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
  }, [enabled, queryClient]);

  useEffect(() => {
    connect();
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  return {
    status,
    send
  };
}
