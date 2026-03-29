import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { TerminalSnapshot } from "@droidagent/shared";

import "@xterm/xterm/css/xterm.css";

import { useDroidAgentApp } from "../app-context";
import { api, deleteJson, postJson } from "../lib/api";
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
  const terminalState = useTerminalState();
  const [confirmHostAccess, setConfirmHostAccess] = useState(false);
  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const renderedSessionIdRef = useRef<string | null>(null);
  const renderedTranscriptRef = useRef("");

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
    terminalStore.replace(snapshotQuery.data);
  }, [snapshotQuery.data]);

  useEffect(() => {
    const container = terminalContainerRef.current;
    if (!container) {
      return;
    }

    const terminal = new Terminal({
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
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    fitAddon.fit();
    terminal.focus();

    const dataDisposable = terminal.onData((data) => {
      const sessionId = terminalState.session?.id;
      if (!sessionId || wsStatus !== "connected") {
        return;
      }
      sendRealtimeCommand({
        type: "terminal.input",
        payload: {
          sessionId,
          data,
        },
      });
    });

    const syncSize = () => {
      fitAddon.fit();
      const sessionId = terminalStore.getSnapshot().session?.id;
      if (!sessionId || wsStatus !== "connected") {
        return;
      }
      sendRealtimeCommand({
        type: "terminal.resize",
        payload: {
          sessionId,
          cols: terminal.cols,
          rows: terminal.rows,
        },
      });
    };

    const resizeObserver = new ResizeObserver(() => {
      syncSize();
    });
    resizeObserver.observe(container);

    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", syncSize);
    window.addEventListener("resize", syncSize);

    xtermRef.current = terminal;
    fitAddonRef.current = fitAddon;

    return () => {
      resizeObserver.disconnect();
      viewport?.removeEventListener("resize", syncSize);
      window.removeEventListener("resize", syncSize);
      dataDisposable.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      terminal.dispose();
    };
  }, [resolvedTheme, sendRealtimeCommand, terminalState.session?.id, wsStatus]);

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
