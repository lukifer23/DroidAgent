import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import type { TerminalSnapshot } from "@droidagent/shared";

import "@xterm/xterm/css/xterm.css";

import { useAuthQuery, useDashboardQuery } from "../app-data";
import { useDroidAgentApp } from "../app-context";
import { useViewportMeasure } from "../hooks/use-viewport-measure";
import { api, deleteJson, postJson } from "../lib/api";
import { TERMINAL_PREFILL_STORAGE_KEY } from "../lib/constants";
import { useTerminalState, terminalStore } from "../lib/terminal-store";

function terminalTheme(theme: "dark" | "light") {
  return theme === "light"
    ? {
        background: "#ffffff",
        foreground: "#17202b",
        cursor: "#2457dc",
        selectionBackground: "rgba(36, 108, 255, 0.18)",
        black: "#17202b",
        blue: "#2457dc",
        cyan: "#0d8bb1",
        green: "#168762",
        red: "#cb5a49",
        yellow: "#9f7a42",
        brightBlack: "#647384",
        brightWhite: "#ffffff",
      }
    : {
        background: "#10161f",
        foreground: "#edf2f7",
        cursor: "#5f95ff",
        selectionBackground: "rgba(95, 149, 255, 0.2)",
        black: "#0b1016",
        blue: "#5f95ff",
        cyan: "#56c7d9",
        green: "#50bf91",
        red: "#ea705f",
        yellow: "#d6bc90",
        brightBlack: "#99a4b2",
        brightWhite: "#f7fbff",
      };
}

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

  const connectionTone = wsStatus === "connected" ? "ready" : "";
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
      <article className="terminal-header panel-card compact">
        <div className="terminal-header-copy">
          <div className="journey-kicker">Rescue Terminal</div>
          <h2>Recover permissions, auth, and host state directly.</h2>
          <p>
            This is a real PTY on the Mac, separate from Jobs. Use the workspace
            shell first. Only open the full host shell when DroidAgent needs a
            direct recovery step outside the workspace.
          </p>
          <div className="operator-fact-row">
            {sessionFacts.map((fact) => (
              <span key={fact} className="operator-fact-chip">
                {fact}
              </span>
            ))}
          </div>
        </div>

        <div className="terminal-header-meta">
          <span className={`status-chip ${connectionTone}`.trim()}>
            {wsStatus === "connected" ? "Terminal live" : "Reconnecting"}
          </span>
          <span className={`status-chip${terminalReady ? " ready" : ""}`}>
            {terminalReady ? "Session running" : "Session idle"}
          </span>
          {session?.idleExpiresAt ? (
            <span className="status-chip">
              idle closes {new Date(session.idleExpiresAt).toLocaleTimeString()}
            </span>
          ) : null}
        </div>
      </article>

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
        <article className="panel-card compact terminal-control-card">
          <div className="panel-heading">
            <h3>Session controls</h3>
            <p>
              Workspace shell is the safe default. Host shell is a deliberate
              recovery escape hatch.
            </p>
          </div>

          <div className="button-row compact-actions">
            <button
              type="button"
              onClick={() =>
                void runAction(async () => {
                  await startSession("workspace");
                }, "Workspace rescue terminal started.")
              }
            >
              Start Workspace Shell
            </button>
            {!confirmHostAccess ? (
              <button
                type="button"
                className="secondary"
                onClick={() => setConfirmHostAccess(true)}
              >
                Enable Host Shell
              </button>
            ) : (
              <button
                type="button"
                onClick={() =>
                  void runAction(async () => {
                    await startSession("host");
                  }, "Host rescue terminal started.")
                }
              >
                Confirm Host Shell
              </button>
            )}
            {confirmHostAccess ? (
              <button
                type="button"
                className="secondary"
                onClick={() => setConfirmHostAccess(false)}
              >
                Cancel Host Shell
              </button>
            ) : null}
            {session ? (
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  void runAction(async () => {
                    await closeSession();
                  }, "Rescue terminal closed.")
                }
              >
                Close Terminal
              </button>
            ) : null}
            {session ? (
              <button
                type="button"
                className="secondary"
                disabled={wsStatus !== "connected"}
                onClick={() => {
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
              >
                Send Ctrl+C
              </button>
            ) : null}
          </div>

          {confirmHostAccess ? (
            <div className="terminal-warning-card">
              <strong>Host shell confirmation required</strong>
              <p>
                The host shell is not workspace-scoped. Use it only when
                DroidAgent is blocked on a system-level fix, install, login, or
                permission step.
              </p>
            </div>
          ) : null}

          {terminalState.closeReason ? (
            <div className="terminal-warning-card muted">
              <strong>Last close reason</strong>
              <p>{terminalState.closeReason}</p>
            </div>
          ) : null}

          {prefillLoadedSessionId === session?.id ? (
            <div className="terminal-warning-card muted">
              <strong>Suggested command loaded</strong>
              <p>
                DroidAgent inserted a suggested command into this shell without
                executing it.
              </p>
            </div>
          ) : null}

          <small>
            Transcript and audit logs are stored locally under
            <code> ~/.droidagent/logs/terminal</code>.
          </small>
        </article>

        <article className="panel-card compact terminal-panel">
          <div className="terminal-panel-top">
            <div>
              <strong>{session?.title ?? "No terminal session yet"}</strong>
              <small>{session?.cwd ?? "Start a shell to begin."}</small>
            </div>
            <div className="terminal-panel-actions">
              <Link className="button-link secondary" to="/settings">
                Settings
              </Link>
            </div>
          </div>

          <div className="terminal-surface">
            <div
              ref={terminalContainerRef}
              className={`terminal-canvas${session ? "" : " idle"}`}
            />
            {!session ? (
              <div className="terminal-empty-state">
                <strong>Start a workspace rescue shell.</strong>
                <p>
                  The terminal is owner-only and stays separate from Jobs so you
                  can recover from permission or login blocks without losing the
                  regular audit trail.
                </p>
              </div>
            ) : null}
          </div>

          <div className="terminal-footer">
            <small>
              {terminalState.truncated
                ? "The in-app transcript is trimmed to the most recent output. Full logs stay on the Mac."
                : "Live PTY output is streamed directly from the Mac."}
            </small>
          </div>
        </article>
      </section>
    </section>
  );
}
