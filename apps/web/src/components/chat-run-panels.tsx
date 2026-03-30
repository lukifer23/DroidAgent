import type {
  ApprovalRecord,
  LatencySample,
  PerformanceSnapshot,
} from "@droidagent/shared";

import type { ChatSessionFeedback } from "../app-context";
import type {
  ChatRunActivity,
  ChatRunViewState,
} from "../lib/chat-run-store";
import { formatDurationMs } from "../lib/formatters";
import { ApprovalCard, formatMessageTime } from "./chat-message-parts";

const RECENT_RUN_SAMPLE_MAX_AGE_MS = 90_000;

interface RunBreakdownItem {
  label: string;
  value: string;
  tone?: "neutral" | "warn" | "good";
}

export interface RunBreakdown {
  items: RunBreakdownItem[];
  note: string | null;
}

function recentSessionSample(
  snapshot: PerformanceSnapshot | undefined,
  name: string,
  sessionId: string | null | undefined,
): LatencySample | null {
  if (!snapshot || !sessionId) {
    return null;
  }

  const metric = snapshot.metrics.find((entry) => entry.name === name);
  if (!metric) {
    return null;
  }

  const sample =
    [...metric.recentSamples]
      .reverse()
      .find((entry) => entry.context.sessionId === sessionId) ?? null;
  if (!sample) {
    return null;
  }

  const ageMs = Date.now() - new Date(sample.endedAt).getTime();
  return ageMs <= RECENT_RUN_SAMPLE_MAX_AGE_MS ? sample : null;
}

export function buildRunBreakdown(params: {
  sessionId: string | null | undefined;
  activeRun: ChatRunViewState | null;
  chatFeedback: ChatSessionFeedback | null;
  clientSnapshot: PerformanceSnapshot;
  serverSnapshot: PerformanceSnapshot | undefined;
}): RunBreakdown {
  if (!params.sessionId) {
    return {
      items: [],
      note: null,
    };
  }

  const serverAccept = recentSessionSample(
    params.serverSnapshot,
    "chat.send.submitToAccepted",
    params.sessionId,
  );
  const modelWait = recentSessionSample(
    params.serverSnapshot,
    "chat.stream.acceptedToFirstDelta",
    params.sessionId,
  );
  const relayForward = recentSessionSample(
    params.serverSnapshot,
    "chat.stream.firstDeltaForward",
    params.sessionId,
  );
  const relayComplete = recentSessionSample(
    params.serverSnapshot,
    "chat.stream.acceptedToCompleteRelay",
    params.sessionId,
  );
  const toolWait = recentSessionSample(
    params.serverSnapshot,
    "chat.run.toolWait",
    params.sessionId,
  );
  const clientFirstToken = recentSessionSample(
    params.clientSnapshot,
    "client.chat.submit_to_first_token",
    params.sessionId,
  );
  const clientComplete = recentSessionSample(
    params.clientSnapshot,
    "client.chat.submit_to_done",
    params.sessionId,
  );

  const items: RunBreakdownItem[] = [
    {
      label: "Server accept",
      value: serverAccept ? formatDurationMs(serverAccept.durationMs) : "Waiting...",
      tone: serverAccept && serverAccept.durationMs > 250 ? "warn" : "neutral",
    },
    {
      label: "Model/tool wait",
      value: modelWait ? formatDurationMs(modelWait.durationMs) : "Waiting...",
      tone: modelWait && modelWait.durationMs > 2_000 ? "warn" : "neutral",
    },
    {
      label: "Relay first token",
      value: relayForward ? formatDurationMs(relayForward.durationMs) : "Waiting...",
      tone: relayForward && relayForward.durationMs > 120 ? "warn" : "good",
    },
    {
      label: "Client first token",
      value:
        params.chatFeedback?.firstTokenMs !== null
          ? formatDurationMs(params.chatFeedback?.firstTokenMs)
          : clientFirstToken
            ? formatDurationMs(clientFirstToken.durationMs)
            : "Waiting...",
      tone:
        (params.chatFeedback?.firstTokenMs ?? clientFirstToken?.durationMs ?? 0) >
        2_000
          ? "warn"
          : "neutral",
    },
    {
      label: "Full reply",
      value:
        params.chatFeedback?.completedMs !== null
          ? formatDurationMs(params.chatFeedback?.completedMs)
          : clientComplete
            ? formatDurationMs(clientComplete.durationMs)
            : relayComplete
              ? formatDurationMs(relayComplete.durationMs)
              : "In progress",
      tone:
        params.chatFeedback?.status === "done" ||
        params.chatFeedback?.status === "streaming"
          ? "good"
          : "neutral",
    },
  ];
  if (toolWait) {
    items.splice(2, 0, {
      label: "Tool wait",
      value: formatDurationMs(toolWait.durationMs),
      tone: toolWait.durationMs > 2_000 ? "warn" : "neutral",
    });
  }

  let note: string | null = null;
  if (
    params.chatFeedback?.status === "error" &&
    params.chatFeedback.firstTokenMs === null
  ) {
    note =
      "This run failed before the model or tool path produced a token. Check gateway health, approvals, or provider readiness.";
  } else if (params.chatFeedback?.status === "error") {
    note =
      "The run failed after the live path started. Use the timings below to see whether the failure was in the Mac tool/model work or after the relay.";
  } else if (params.activeRun?.stage === "tool_call" && params.activeRun.toolName) {
    note = `DroidAgent is currently waiting on ${params.activeRun.toolName} on the Mac.`;
  } else if (params.activeRun?.stage === "approval_required") {
    note = "The run is paused on approval. Once approved, DroidAgent continues in the same live turn.";
  } else if (
    modelWait &&
    serverAccept &&
    modelWait.durationMs >
      Math.max(
        (serverAccept.durationMs ?? 0) + (relayForward?.durationMs ?? 0) + 300,
        2_000,
      )
  ) {
    note =
      "Most of the delay is inside the live model/tool run on the Mac, not the web relay.";
  } else if (serverAccept && serverAccept.durationMs > 400) {
    note =
      "The gateway accepted this turn slowly. Check host pressure, runtime health, or maintenance activity.";
  }

  return {
    items,
    note,
  };
}

export function isTerminalChatFeedback(
  feedback: ChatSessionFeedback | null | undefined,
): feedback is ChatSessionFeedback {
  return feedback?.status === "done" || feedback?.status === "error";
}

function RunBreakdownPanel({ breakdown }: { breakdown: RunBreakdown }) {
  if (breakdown.items.length === 0 && !breakdown.note) {
    return null;
  }

  return (
    <div className="run-breakdown-panel">
      <div className="run-breakdown-grid">
        {breakdown.items.map((item) => (
          <div
            key={item.label}
            className={`run-breakdown-chip${item.tone ? ` ${item.tone}` : ""}`}
          >
            <strong>{item.label}</strong>
            <span>{item.value}</span>
          </div>
        ))}
      </div>
      {breakdown.note ? <p className="run-breakdown-note">{breakdown.note}</p> : null}
    </div>
  );
}

export function RunActivityTrail({
  activities,
}: {
  activities: ChatRunActivity[];
}) {
  if (activities.length === 0) {
    return null;
  }

  const visibleActivities = activities.slice(-4);

  return (
    <div className="run-activity-trail">
      {visibleActivities.map((activity, index) => (
        <div
          key={`${activity.stage}-${activity.at}-${index}`}
          className={`run-activity-item ${activity.stage}`}
        >
          <div className="run-activity-head">
            <strong>{activity.label}</strong>
            <span>{formatMessageTime(activity.at)}</span>
          </div>
          {activity.detail ? <p>{activity.detail}</p> : null}
        </div>
      ))}
    </div>
  );
}

export function describeChatFeedback(
  feedback: ChatSessionFeedback | null | undefined,
): { firstToken: string; reply: string } {
  if (!feedback) {
    return {
      firstToken: "Awaiting run",
      reply: "Awaiting run",
    };
  }

  return {
    firstToken:
      feedback.firstTokenMs !== null
        ? formatDurationMs(feedback.firstTokenMs)
        : feedback.status === "error"
          ? "Failed"
          : "Waiting...",
    reply:
      feedback.completedMs !== null
        ? formatDurationMs(feedback.completedMs)
        : feedback.status === "error"
          ? "Failed"
          : feedback.status === "done"
            ? "Done"
            : "In progress",
  };
}

export function PendingAssistantCard({
  activeRun,
  approval,
  breakdown,
  chatFeedback,
  onResolveApproval,
}: {
  activeRun: ChatRunViewState | null;
  approval: ApprovalRecord | null;
  breakdown: RunBreakdown;
  chatFeedback: ChatSessionFeedback | null;
  onResolveApproval: (approvalId: string, resolution: "approved" | "denied") => void;
}) {
  const feedback = describeChatFeedback(chatFeedback);
  const stage = activeRun?.stage ?? "waiting";
  const label = activeRun?.label ?? "DroidAgent is preparing a reply";
  const detail =
    activeRun?.detail ??
    (chatFeedback?.status === "error"
      ? chatFeedback.errorMessage ??
        "The last request failed before DroidAgent could respond."
      : "The request was accepted and DroidAgent is still working.");

  return (
    <article className="message-card assistant pending">
      <div className="message-meta">
        <div className="message-meta-copy">
          <header>DroidAgent</header>
          <span>{stage}</span>
        </div>
      </div>

      <div className="message-part-stack">
        <div className={`operator-run-strip ${stage}`}>
          <strong>{label}</strong>
          <span>{detail}</span>
          <div className="operator-side-inline-meta">
            <span>First token: {feedback.firstToken}</span>
            <span>Reply: {feedback.reply}</span>
          </div>
          {activeRun?.activities.length ? (
            <RunActivityTrail activities={activeRun.activities} />
          ) : null}
          <RunBreakdownPanel breakdown={breakdown} />
        </div>
        {activeRun?.stage === "approval_required" ? (
          <ApprovalCard approval={approval} onResolve={onResolveApproval} />
        ) : null}
      </div>
    </article>
  );
}

export function RecentRunSummaryCard({
  breakdown,
  chatFeedback,
  historySettled,
}: {
  breakdown: RunBreakdown;
  chatFeedback: ChatSessionFeedback;
  historySettled: boolean;
}) {
  const feedback = describeChatFeedback(chatFeedback);
  const failed = chatFeedback.status === "error";

  return (
    <article className="message-card assistant pending">
      <div className="message-meta">
        <div className="message-meta-copy">
          <header>DroidAgent</header>
          <span>recent run</span>
        </div>
      </div>

      <div className="message-part-stack">
        <div className={`operator-run-strip ${failed ? "failed" : "completed"}`}>
          <strong>{failed ? "Latest run failed" : "Latest run finished"}</strong>
          <span>
            {failed
              ? "The live run ended with an error. Use the timing breakdown below to locate whether the failure happened before first token, in the Mac tool/model path, or after the relay."
              : historySettled
                ? "The transcript is settled. Use the timing breakdown below to judge whether the wait was in the Mac, the model/tool path, or the relay."
                : "The live run finished and the transcript is still settling. The timing breakdown below is already final for this run."}
          </span>
          <div className="operator-side-inline-meta">
            <span>First token: {feedback.firstToken}</span>
            <span>Reply: {feedback.reply}</span>
          </div>
          <RunBreakdownPanel breakdown={breakdown} />
        </div>
      </div>
    </article>
  );
}
