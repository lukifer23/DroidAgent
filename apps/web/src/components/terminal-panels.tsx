import type { RefObject } from "react";
import { Link } from "@tanstack/react-router";
import type { TerminalSessionSummary } from "@droidagent/shared";

export function TerminalHeaderCard({
  idleExpiresAt,
  sessionFacts,
  terminalReady,
  wsStatus,
}: {
  idleExpiresAt: string | null | undefined;
  sessionFacts: string[];
  terminalReady: boolean;
  wsStatus: "disconnected" | "connecting" | "connected";
}) {
  const connectionTone = wsStatus === "connected" ? "ready" : "";

  return (
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
        {idleExpiresAt ? (
          <span className="status-chip">
            idle closes {new Date(idleExpiresAt).toLocaleTimeString()}
          </span>
        ) : null}
      </div>
    </article>
  );
}

export function TerminalControlsCard({
  closeReason,
  confirmHostAccess,
  prefillLoaded,
  session,
  wsStatus,
  onCancelHost,
  onCloseTerminal,
  onConfirmHost,
  onEnableHost,
  onSendInterrupt,
  onStartWorkspace,
}: {
  closeReason: string | null;
  confirmHostAccess: boolean;
  prefillLoaded: boolean;
  session: TerminalSessionSummary | null;
  wsStatus: "disconnected" | "connecting" | "connected";
  onCancelHost(): void;
  onCloseTerminal(): void;
  onConfirmHost(): void;
  onEnableHost(): void;
  onSendInterrupt(): void;
  onStartWorkspace(): void;
}) {
  return (
    <article className="panel-card compact terminal-control-card">
      <div className="panel-heading">
        <h3>Session controls</h3>
        <p>
          Workspace shell is the safe default. Host shell is a deliberate
          recovery escape hatch.
        </p>
      </div>

      <div className="button-row compact-actions">
        <button type="button" onClick={onStartWorkspace}>
          Start Workspace Shell
        </button>
        {!confirmHostAccess ? (
          <button type="button" className="secondary" onClick={onEnableHost}>
            Enable Host Shell
          </button>
        ) : (
          <button type="button" onClick={onConfirmHost}>
            Confirm Host Shell
          </button>
        )}
        {confirmHostAccess ? (
          <button type="button" className="secondary" onClick={onCancelHost}>
            Cancel Host Shell
          </button>
        ) : null}
        {session ? (
          <button type="button" className="secondary" onClick={onCloseTerminal}>
            Close Terminal
          </button>
        ) : null}
        {session ? (
          <button
            type="button"
            className="secondary"
            disabled={wsStatus !== "connected"}
            onClick={onSendInterrupt}
          >
            Send Ctrl+C
          </button>
        ) : null}
      </div>

      {confirmHostAccess ? (
        <div className="terminal-warning-card">
          <strong>Host shell confirmation required</strong>
          <p>
            The host shell is not workspace-scoped. Use it only when DroidAgent
            is blocked on a system-level fix, install, login, or permission
            step.
          </p>
        </div>
      ) : null}

      {closeReason ? (
        <div className="terminal-warning-card muted">
          <strong>Last close reason</strong>
          <p>{closeReason}</p>
        </div>
      ) : null}

      {prefillLoaded ? (
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
  );
}

export function TerminalSurfaceCard({
  session,
  terminalContainerRef,
  truncated,
}: {
  session: TerminalSessionSummary | null;
  terminalContainerRef: RefObject<HTMLDivElement | null>;
  truncated: boolean;
}) {
  return (
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
              The terminal is owner-only and stays separate from Jobs so you can
              recover from permission or login blocks without losing the regular
              audit trail.
            </p>
          </div>
        ) : null}
      </div>

      <div className="terminal-footer">
        <small>
          {truncated
            ? "The in-app transcript is trimmed to the most recent output. Full logs stay on the Mac."
            : "Live PTY output is streamed directly from the Mac."}
        </small>
      </div>
    </article>
  );
}
