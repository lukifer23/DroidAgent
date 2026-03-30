import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import type { TerminalSnapshot } from "@droidagent/shared";

import "@xterm/xterm/css/xterm.css";

import { useAuthQuery, useDashboardQuery } from "../app-data";
import { useDroidAgentApp } from "../app-context";
import {
  TerminalControlsCard,
  TerminalHeaderCard,
  TerminalSurfaceCard,
} from "../components/terminal-panels";
import { useViewportMeasure } from "../hooks/use-viewport-measure";
import { api, deleteJson, postJson } from "../lib/api";
import { TERMINAL_PREFILL_STORAGE_KEY } from "../lib/constants";
import { terminalTheme } from "../lib/terminal-theme";
import { useTerminalState, terminalStore } from "../lib/terminal-store";

export function TerminalScreen() {
  const queryClient = useQueryClient();
  const { resolvedTheme, runAction, sendRealtimeCommand, wsStatus } =
    useDroidAgentApp();
  const authQuery = useAuthQuery();
  const dashboardQuery = useDashboardQuery(Boolean(authQuery.data?.user));
  const hostPressure = dashboardQuery.data?.hostPressure;
  const terminalState = useTerminalState();
  const [confirmHostAccess, setConfirmHostAccess] = useState(false);
  const [prefillLoadedSessionId, setPrefillLoadedSessionId] = useState<string | null>(null);
  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const renderedSessionIdRef = useRef<string | null>(null);
  const renderedTranscriptRef = useRef("");
  const prefillAttemptedRef = useRef(false);
  const prefillSentForSessionRef = useRef<string | null>(null);
  const sendRealtimeCommandRef = useRef(sendRealtimeCommand);
  const wsStatusRef = useRef(wsStatus);
  const terminalSessionIdRef = useRef<string | null>(terminalState.session?.id ?? null);
  const lastResizeSentRef = useRef<{
    sessionId: string;
    cols: number;
    rows: number;
  } | null>(null);

  sendRealtimeCommandRef.current = sendRealtimeCommand;
  wsStatusRef.current = wsStatus;
  terminalSessionIdRef.current = terminalState.session?.id ?? null;

  const snapshotQuery = useQuery({
    queryKey: ["terminal"],
    queryFn: () => api<TerminalSnapshot>("/api/terminal/session"),
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!snapshotQuery.data) {
      return;
    }
    const current = terminalStore.getSnapshot();
    if (current.session && !snapshotQuery.data.session) {
      return;
    }
    terminalStore.replace(snapshotQuery.data);
  }, [snapshotQuery.data]);

  useEffect(() => {
    const pendingPrefill = window.sessionStorage.getItem(
      TERMINAL_PREFILL_STORAGE_KEY,
    );
    if (!pendingPrefill || terminalState.session || prefillAttemptedRef.current) {
      return;
    }

    prefillAttemptedRef.current = true;
    void runAction(async () => {
      await startSession("workspace");
    }, "Workspace rescue terminal started.");
  }, [runAction, terminalState.session]);

  useEffect(() => {
    const pendingPrefill = window.sessionStorage.getItem(
      TERMINAL_PREFILL_STORAGE_KEY,
    );
    if (
      !pendingPrefill ||
      !terminalState.session ||
      wsStatus !== "connected" ||
      prefillSentForSessionRef.current === terminalState.session.id
    ) {
      return;
    }

    sendRealtimeCommand({
      type: "terminal.input",
      payload: {
        sessionId: terminalState.session.id,
        data: pendingPrefill,
      },
    });
    prefillSentForSessionRef.current = terminalState.session.id;
    setPrefillLoadedSessionId(terminalState.session.id);
    window.sessionStorage.removeItem(TERMINAL_PREFILL_STORAGE_KEY);
  }, [sendRealtimeCommand, terminalState.session, wsStatus]);

  const syncSize = useCallback(() => {
    const terminal = xtermRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) {
      return;
    }

    fitAddon.fit();
    const sessionId = terminalStore.getSnapshot().session?.id;
    if (!sessionId || wsStatusRef.current !== "connected") {
      return;
    }
    const previous = lastResizeSentRef.current;
    if (
      previous &&
      previous.sessionId === sessionId &&
      previous.cols === terminal.cols &&
      previous.rows === terminal.rows
    ) {
      return;
    }
    lastResizeSentRef.current = {
      sessionId,
      cols: terminal.cols,
      rows: terminal.rows,
    };
    sendRealtimeCommandRef.current({
      type: "terminal.resize",
      payload: {
        sessionId,
        cols: terminal.cols,
        rows: terminal.rows,
      },
    });
  }, []);
  const viewportRefs = useMemo(() => [terminalContainerRef], []);
  useViewportMeasure({
    refs: viewportRefs,
    onMeasure: syncSize,
  });

  useEffect(() => {
    const container = terminalContainerRef.current;
    if (!container) {
      return;
    }

    let active = true;
    let terminal: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let dataDisposable: { dispose: () => void } | null = null;

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (!active) {
        return;
      }

      terminal = new Terminal({
        allowTransparency: true,
        convertEol: false,
        cursorBlink: true,
        fontFamily:
          '"SFMono-Regular", "Cascadia Code", "JetBrains Mono", ui-monospace, monospace',
        fontSize: 13,
        lineHeight: 1.25,
        scrollback: 3000,
        theme: terminalTheme(resolvedTheme),
      });
      fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(container);
      xtermRef.current = terminal;
      fitAddonRef.current = fitAddon;
      syncSize();
      terminal.focus();

      dataDisposable = terminal.onData((data) => {
        const sessionId = terminalSessionIdRef.current;
        if (!sessionId || wsStatusRef.current !== "connected") {
          return;
        }
        sendRealtimeCommandRef.current({
          type: "terminal.input",
          payload: {
            sessionId,
            data,
          },
        });
      });
    })();

    return () => {
      active = false;
      dataDisposable?.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      terminal?.dispose();
    };
  }, [resolvedTheme, syncSize]);

  useEffect(() => {
    const terminal = xtermRef.current;
    if (!terminal) {
      return;
    }
    terminal.options.theme = terminalTheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    const terminal = xtermRef.current;
    if (!terminal) {
      return;
    }

    const nextSessionId = terminalState.session?.id ?? null;
    const nextTranscript = terminalState.transcript;
    const sessionChanged = renderedSessionIdRef.current !== nextSessionId;

    if (sessionChanged) {
      terminal.reset();
      renderedSessionIdRef.current = nextSessionId;
      renderedTranscriptRef.current = "";
    }

    if (nextTranscript === renderedTranscriptRef.current) {
      return;
    }

    if (
      nextTranscript.startsWith(renderedTranscriptRef.current) &&
      renderedTranscriptRef.current.length > 0
    ) {
      terminal.write(nextTranscript.slice(renderedTranscriptRef.current.length));
    } else {
      terminal.reset();
      terminal.write(nextTranscript);
    }
    renderedTranscriptRef.current = nextTranscript;
    fitAddonRef.current?.fit();
  }, [terminalState.session?.id, terminalState.transcript]);

  useEffect(() => {
    const sessionId = terminalState.session?.id ?? null;
    if (!sessionId || wsStatus !== "connected") {
      return;
    }
    const terminal = xtermRef.current;
    if (!terminal) {
      return;
    }
    lastResizeSentRef.current = null;
    sendRealtimeCommand({
      type: "terminal.resize",
      payload: {
        sessionId,
        cols: terminal.cols,
        rows: terminal.rows,
      },
    });
  }, [sendRealtimeCommand, terminalState.session?.id, wsStatus]);

  const session = terminalState.session;
  const terminalReady = Boolean(session && session.status === "running");
  const sessionFacts = useMemo(
    () =>
      [
        session ? `${session.scope} shell` : "no active shell",
        session?.cwd ?? "cwd pending",
        wsStatus === "connected" ? "websocket live" : "websocket reconnecting",
      ].filter(Boolean),
    [session, wsStatus],
  );

  async function startSession(scope: "workspace" | "host") {
    const snapshot = await postJson<TerminalSnapshot>("/api/terminal/session", {
      scope,
      confirmHostAccess: scope === "host",
    });
    terminalStore.replace(snapshot);
    setConfirmHostAccess(false);
    await queryClient.invalidateQueries({ queryKey: ["terminal"] });
  }

  async function closeSession() {
    if (!session) {
      return;
    }
    await deleteJson(`/api/terminal/session/${encodeURIComponent(session.id)}`);
    const emptySnapshot = await api<TerminalSnapshot>("/api/terminal/session");
    terminalStore.replace(emptySnapshot);
    await queryClient.invalidateQueries({ queryKey: ["terminal"] });
  }

  return (
    <section className="terminal-shell">
      <TerminalHeaderCard
        idleExpiresAt={session?.idleExpiresAt}
        sessionFacts={sessionFacts}
        terminalReady={terminalReady}
        wsStatus={wsStatus}
      />

      {hostPressure?.level === "critical" || hostPressure?.level === "warn" ? (
        <article className="panel-card compact">
          <strong>
            {hostPressure.level === "critical"
              ? "Host pressure is critical"
              : "Host pressure is elevated"}
          </strong>
          <p>{hostPressure.message}</p>
        </article>
      ) : null}

      <section className="terminal-workspace">
        <TerminalControlsCard
          closeReason={terminalState.closeReason}
          confirmHostAccess={confirmHostAccess}
          prefillLoaded={prefillLoadedSessionId === session?.id}
          session={session}
          wsStatus={wsStatus}
          onCancelHost={() => setConfirmHostAccess(false)}
          onCloseTerminal={() =>
            void runAction(async () => {
              await closeSession();
            }, "Rescue terminal closed.")
          }
          onConfirmHost={() =>
            void runAction(async () => {
              await startSession("host");
            }, "Host rescue terminal started.")
          }
          onEnableHost={() => setConfirmHostAccess(true)}
          onSendInterrupt={() => {
            if (!session || wsStatus !== "connected") {
              return;
            }
            sendRealtimeCommand({
              type: "terminal.input",
              payload: {
                sessionId: session.id,
                data: "\u0003",
              },
            });
          }}
          onStartWorkspace={() =>
            void runAction(async () => {
              await startSession("workspace");
            }, "Workspace rescue terminal started.")
          }
        />

        <TerminalSurfaceCard
          session={session}
          terminalContainerRef={terminalContainerRef}
          truncated={terminalState.truncated}
        />
      </section>
    </section>
  );
}
