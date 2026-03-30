import { X } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { DecisionRecord } from "@droidagent/shared";

export interface HostStatusItem {
  label: string;
  value: string;
  detail: string;
  tone: "good" | "warn" | "critical";
}

function decisionRoute(decision: DecisionRecord): string {
  if (decision.kind === "memoryDraftReview") {
    return "/settings";
  }
  if (decision.kind === "channelPairing") {
    return "/channels";
  }
  return "/chat";
}

function decisionKindLabel(decision: DecisionRecord): string {
  if (decision.kind === "memoryDraftReview") {
    return "Memory review";
  }
  if (decision.kind === "channelPairing") {
    return "Signal pairing";
  }
  if (decision.kind === "execApproval") {
    return "OpenClaw approval";
  }
  return "Decision";
}

function decisionPrimaryActionLabel(decision: DecisionRecord): string {
  return decision.kind === "memoryDraftReview" ? "Apply" : "Approve";
}

function decisionSecondaryActionLabel(decision: DecisionRecord): string {
  return decision.kind === "memoryDraftReview" ? "Dismiss" : "Deny";
}

export function decisionResolutionNotice(
  decision: DecisionRecord,
  resolution: "approved" | "denied",
): string {
  if (decision.kind === "memoryDraftReview") {
    return resolution === "approved"
      ? "Memory draft applied."
      : "Memory draft dismissed.";
  }
  if (decision.kind === "channelPairing") {
    return resolution === "approved"
      ? "Signal pairing approved."
      : "Signal pairing denied.";
  }
  return resolution === "approved" ? "Decision approved." : "Decision denied.";
}

export function HostStatusDrawer({
  hostStatusItems,
  onClose,
  operatorReady,
}: {
  hostStatusItems: HostStatusItem[];
  onClose(): void;
  operatorReady: boolean;
}) {
  return (
    <div className="drawer-backdrop" onClick={onClose} role="presentation">
      <aside
        className="host-drawer panel-card"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="drawer-header">
          <div>
            <div className="eyebrow">Host Status</div>
            <h2>Mac, runtime, and remote access</h2>
          </div>
          <button
            type="button"
            className="ghost-button"
            onClick={onClose}
            aria-label="Close host status"
          >
            <X size={18} />
          </button>
        </div>

        <div className="host-status-list">
          {hostStatusItems.map((item) => (
            <article key={item.label} className={`host-status-row ${item.tone}`}>
              <div>
                <strong>{item.label}</strong>
                <span>{item.value}</span>
              </div>
              <small>{item.detail}</small>
            </article>
          ))}
        </div>

        <div className="drawer-actions">
          <Link className="button-link secondary" to="/terminal">
            Rescue terminal
          </Link>
          {!operatorReady ? (
            <Link className="button-link secondary" to="/setup">
              Finish setup
            </Link>
          ) : null}
          <Link className="button-link secondary" to="/settings">
            Open settings
          </Link>
        </div>
      </aside>
    </div>
  );
}

export function DecisionInboxDrawer({
  onClose,
  onResolveDecision,
  pendingDecisions,
  recentDecisions,
}: {
  onClose(): void;
  onResolveDecision(
    decision: DecisionRecord,
    resolution: "approved" | "denied",
  ): void;
  pendingDecisions: DecisionRecord[];
  recentDecisions: DecisionRecord[];
}) {
  return (
    <div className="drawer-backdrop" onClick={onClose} role="presentation">
      <aside
        className="host-drawer panel-card decision-drawer"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="drawer-header">
          <div>
            <div className="eyebrow">Decision Inbox</div>
            <h2>Owner approvals, saves, and pairings</h2>
          </div>
          <button
            type="button"
            className="ghost-button"
            onClick={onClose}
            aria-label="Close decision inbox"
          >
            <X size={18} />
          </button>
        </div>

        <div className="stack-list">
          <article className="panel-card compact">
            <strong>
              {pendingDecisions.length > 0
                ? `${pendingDecisions.length} pending decision${pendingDecisions.length === 1 ? "" : "s"}`
                : "Decision queue clear"}
            </strong>
            <small>
              DroidAgent shows one owner-facing queue across OpenClaw approvals,
              durable memory review, and Signal pairing.
            </small>
          </article>

          {pendingDecisions.length === 0 ? (
            <article className="panel-card compact">
              No pending decisions. New owner-gated actions will appear here.
            </article>
          ) : null}

          {pendingDecisions.map((decision) => (
            <article key={decision.id} className="panel-card compact decision-card">
              <div className="decision-card-header">
                <strong>{decision.title}</strong>
                <span className="status-chip">{decisionKindLabel(decision)}</span>
              </div>
              <small>{decision.summary}</small>
              {decision.details ? (
                <details className="message-details">
                  <summary>Inspect details</summary>
                  <pre>{decision.details}</pre>
                </details>
              ) : null}
              <small>
                Requested {new Date(decision.requestedAt).toLocaleString()}
                {decision.deviceLabel ? ` • ${decision.deviceLabel}` : ""}
              </small>
              <div className="button-row">
                <button
                  onClick={() => onResolveDecision(decision, "approved")}
                >
                  {decisionPrimaryActionLabel(decision)}
                </button>
                <button
                  className="secondary"
                  onClick={() => onResolveDecision(decision, "denied")}
                >
                  {decisionSecondaryActionLabel(decision)}
                </button>
                <Link className="button-link secondary" to={decisionRoute(decision)}>
                  Open
                </Link>
              </div>
            </article>
          ))}

          {recentDecisions.length > 0 ? (
            <article className="panel-card">
              <div className="panel-heading">
                <h3>Recent decisions</h3>
                <p>Latest resolved owner actions across the control plane.</p>
              </div>
              <div className="stack-list">
                {recentDecisions.slice(0, 6).map((decision) => (
                  <article key={decision.id} className="panel-card compact decision-card">
                    <div className="decision-card-header">
                      <strong>{decision.title}</strong>
                      <span className="status-chip ready">
                        {decision.resolution ?? decision.status}
                      </span>
                    </div>
                    <small>{decision.summary}</small>
                    <small>
                      {decision.actorLabel ?? "Owner"} •{" "}
                      {new Date(
                        decision.resolvedAt ?? decision.requestedAt,
                      ).toLocaleString()}
                    </small>
                  </article>
                ))}
              </div>
            </article>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
