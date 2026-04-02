import { useSyncExternalStore } from "react";
import type { ChatMessage, ChatRunStage, ChatRunState } from "@droidagent/shared";

import { clientPerformance } from "./client-performance";

type Listener = () => void;

const RUN_CLEAR_DELAY_MS = 4_000;
const STREAM_CLEAR_DELAY_MS = 4_000;
const FEEDBACK_CLEAR_DELAY_MS = 12_000;

export interface ChatSessionFeedback {
  sessionId: string;
  status: "waiting_first_token" | "streaming" | "done" | "error";
  firstTokenMs: number | null;
  completedMs: number | null;
  errorMessage: string | null;
  updatedAt: string;
}

export interface StreamingRun {
  runId: string;
  text: string;
}

export interface ChatRunActivity {
  stage: ChatRunStage;
  label: string;
  detail: string | null;
  toolName: string | null;
  at: string;
}

export interface ChatRunViewState extends ChatRunState {
  startedAt: string;
  activities: ChatRunActivity[];
}

export interface PendingChatSendState {
  optimisticMessageId: string | null;
  submittedAt: string;
}

export interface ChatSessionClientState {
  messages: ChatMessage[];
  historyStatus: "idle" | "loading" | "ready" | "error" | "resyncing";
  switching: boolean;
  pendingSend: PendingChatSendState | null;
  activeRun: ChatRunViewState | null;
  streaming: StreamingRun | null;
  liveFeedback: ChatSessionFeedback | null;
  recentFeedback: ChatSessionFeedback | null;
}

interface PendingChatMetric {
  startedAt: number;
  firstToken: ReturnType<typeof clientPerformance.start>;
  firstTokenFinished: boolean;
  completed: ReturnType<typeof clientPerformance.start>;
}

interface ChatSessionStoreSnapshot {
  sessions: Record<string, ChatSessionClientState>;
}

const EMPTY_SESSION_STATE: ChatSessionClientState = Object.freeze({
  messages: [],
  historyStatus: "idle",
  switching: false,
  pendingSend: null,
  activeRun: null,
  streaming: null,
  liveFeedback: null,
  recentFeedback: null,
});

const EMPTY_STORE_SNAPSHOT: ChatSessionStoreSnapshot = Object.freeze({
  sessions: {},
});

const MAX_RUN_ACTIVITIES = 6;

function sameMessages(left: ChatMessage[], right: ChatMessage[]): boolean {
  if (left === right) {
    return true;
  }

  if (left.length !== right.length) {
    return false;
  }

  return left.every((message, index) => {
    const other = right[index];
    if (!other) {
      return false;
    }
    return (
      message.id === other.id &&
      message.role === other.role &&
      message.text === other.text &&
      message.status === other.status &&
      message.createdAt === other.createdAt &&
      message.parts.length === other.parts.length &&
      message.attachments.length === other.attachments.length
    );
  });
}

function sameStreamingRun(
  left: StreamingRun | null | undefined,
  right: StreamingRun | null | undefined,
): boolean {
  if (!left && !right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return left.runId === right.runId && left.text === right.text;
}

function sameFeedback(
  left: ChatSessionFeedback | null | undefined,
  right: ChatSessionFeedback | null | undefined,
): boolean {
  if (!left && !right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.sessionId === right.sessionId &&
    left.status === right.status &&
    left.firstTokenMs === right.firstTokenMs &&
    left.completedMs === right.completedMs &&
    left.errorMessage === right.errorMessage
  );
}

function samePendingSend(
  left: PendingChatSendState | null | undefined,
  right: PendingChatSendState | null | undefined,
): boolean {
  if (!left && !right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.optimisticMessageId === right.optimisticMessageId &&
    left.submittedAt === right.submittedAt
  );
}

function sameRunState(
  left: ChatRunViewState | null | undefined,
  right: ChatRunState,
): boolean {
  if (!left) {
    return false;
  }

  return (
    left.sessionId === right.sessionId &&
    left.runId === right.runId &&
    left.stage === right.stage &&
    left.label === right.label &&
    left.detail === right.detail &&
    left.toolName === right.toolName &&
    left.approvalId === right.approvalId &&
    left.active === right.active
  );
}

function activitySignature(activity: ChatRunActivity): string {
  return `${activity.stage}:${activity.label}:${activity.detail ?? ""}:${activity.toolName ?? ""}`;
}

function activityFromRun(run: ChatRunState): ChatRunActivity {
  return {
    stage: run.stage,
    label: run.label,
    detail: run.detail ?? null,
    toolName: run.toolName ?? null,
    at: run.updatedAt,
  };
}

function appendActivity(
  current: ChatRunActivity[],
  next: ChatRunActivity,
): ChatRunActivity[] {
  const last = current.at(-1);
  if (last && activitySignature(last) === activitySignature(next)) {
    return current;
  }

  const combined = [...current, next];
  if (combined.length <= MAX_RUN_ACTIVITIES) {
    return combined;
  }

  return combined.slice(combined.length - MAX_RUN_ACTIVITIES);
}

function nowIso(): string {
  return new Date().toISOString();
}

class ChatSessionStore {
  private readonly listeners = new Set<Listener>();
  private snapshot: ChatSessionStoreSnapshot = EMPTY_STORE_SNAPSHOT;
  private emitHandle: number | ReturnType<typeof setTimeout> | null = null;
  private readonly pendingChatMetrics = new Map<string, PendingChatMetric>();
  private readonly feedbackClearTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly streamClearTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly runClearTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): ChatSessionStoreSnapshot {
    return this.snapshot;
  }

  getSessionSnapshot(sessionId: string | null | undefined): ChatSessionClientState {
    if (!sessionId) {
      return EMPTY_SESSION_STATE;
    }
    return this.snapshot.sessions[sessionId] ?? EMPTY_SESSION_STATE;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private scheduleEmit(): void {
    if (this.emitHandle !== null) {
      return;
    }

    if (
      typeof window !== "undefined" &&
      typeof window.requestAnimationFrame === "function"
    ) {
      this.emitHandle = window.requestAnimationFrame(() => {
        this.emitHandle = null;
        this.emit();
      });
      return;
    }

    this.emitHandle = setTimeout(() => {
      this.emitHandle = null;
      this.emit();
    }, 16);
  }

  private emitChange(defer: boolean): void {
    if (defer) {
      this.scheduleEmit();
      return;
    }

    if (this.emitHandle !== null) {
      if (
        typeof window !== "undefined" &&
        typeof window.cancelAnimationFrame === "function" &&
        typeof this.emitHandle === "number"
      ) {
        window.cancelAnimationFrame(this.emitHandle);
      } else {
        clearTimeout(this.emitHandle as ReturnType<typeof setTimeout>);
      }
      this.emitHandle = null;
    }
    this.emit();
  }

  private clearTimeoutFor(
    timeouts: Map<string, ReturnType<typeof setTimeout>>,
    sessionId: string,
  ): void {
    const timeoutId = timeouts.get(sessionId);
    if (!timeoutId) {
      return;
    }
    clearTimeout(timeoutId);
    timeouts.delete(sessionId);
  }

  private updateSession(
    sessionId: string,
    updater: (current: ChatSessionClientState) => ChatSessionClientState,
    options: { defer?: boolean } = {},
  ): void {
    const current =
      this.snapshot.sessions[sessionId] ?? EMPTY_SESSION_STATE;
    const next = updater(current);
    if (next === current) {
      return;
    }

    this.snapshot = {
      sessions: {
        ...this.snapshot.sessions,
        [sessionId]: next,
      },
    };
    this.emitChange(options.defer === true);
  }

  private scheduleFeedbackClear(sessionId: string): void {
    this.clearTimeoutFor(this.feedbackClearTimeouts, sessionId);
    const timeoutId = setTimeout(() => {
      this.feedbackClearTimeouts.delete(sessionId);
      this.updateSession(
        sessionId,
        (current) => {
          if (!current.liveFeedback) {
            return current;
          }
          return {
            ...current,
            liveFeedback: null,
          };
        },
        { defer: true },
      );
    }, FEEDBACK_CLEAR_DELAY_MS);
    this.feedbackClearTimeouts.set(sessionId, timeoutId);
  }

  private scheduleRunClear(sessionId: string, runId: string): void {
    this.clearTimeoutFor(this.runClearTimeouts, sessionId);
    const timeoutId = setTimeout(() => {
      this.runClearTimeouts.delete(sessionId);
      this.updateSession(
        sessionId,
        (current) => {
          if (current.activeRun?.runId !== runId || current.activeRun.active) {
            return current;
          }
          return {
            ...current,
            activeRun: null,
          };
        },
        { defer: true },
      );
    }, RUN_CLEAR_DELAY_MS);
    this.runClearTimeouts.set(sessionId, timeoutId);
  }

  private scheduleStreamClear(sessionId: string, runId: string): void {
    this.clearTimeoutFor(this.streamClearTimeouts, sessionId);
    const timeoutId = setTimeout(() => {
      this.streamClearTimeouts.delete(sessionId);
      this.updateSession(
        sessionId,
        (current) => {
          if (current.streaming?.runId !== runId) {
            return current;
          }
          return {
            ...current,
            streaming: null,
          };
        },
        { defer: true },
      );
    }, STREAM_CLEAR_DELAY_MS);
    this.streamClearTimeouts.set(sessionId, timeoutId);
  }

  private finalizeTrackedRun(
    sessionId: string,
    params: {
      runId?: string;
      status: "done" | "error";
      message?: string | null;
      noDelta?: boolean;
    },
  ): ChatSessionFeedback {
    const tracked = this.pendingChatMetrics.get(sessionId);
    const nextCompletedMs = tracked
      ? Number((performance.now() - tracked.startedAt).toFixed(2))
      : null;

    if (tracked && !tracked.firstTokenFinished) {
      tracked.firstToken.finish({
        runId: params.runId,
        outcome: params.noDelta
          ? "no-delta"
          : params.status === "error"
            ? "error"
            : "done",
      });
      tracked.firstTokenFinished = true;
    }

    tracked?.completed.finish({
      runId: params.runId,
      outcome: params.status === "error" ? "error" : "done",
    });
    this.pendingChatMetrics.delete(sessionId);

    const current = this.getSessionSnapshot(sessionId);
    return {
      sessionId,
      status: params.status,
      firstTokenMs: current.liveFeedback?.firstTokenMs ?? current.recentFeedback?.firstTokenMs ?? null,
      completedMs:
        nextCompletedMs ??
        current.liveFeedback?.completedMs ??
        current.recentFeedback?.completedMs ??
        null,
      errorMessage: params.status === "error" ? params.message ?? "DroidAgent run failed." : null,
      updatedAt: nowIso(),
    };
  }

  markHistoryLoading(
    sessionId: string,
    options: { resync?: boolean } = {},
  ): void {
    this.updateSession(sessionId, (current) => {
      const nextHistoryStatus = options.resync ? "resyncing" : "loading";
      if (
        current.historyStatus === nextHistoryStatus &&
        current.switching === false
      ) {
        return current;
      }
      return {
        ...current,
        historyStatus: nextHistoryStatus,
        switching: false,
      };
    });
  }

  markHistoryReady(
    sessionId: string,
    messages: ChatMessage[],
    options: { authoritative?: boolean } = {},
  ): void {
    if (options.authoritative) {
      this.clearTimeoutFor(this.streamClearTimeouts, sessionId);
    }
    this.updateSession(sessionId, (current) => {
      if (
        current.historyStatus === "ready" &&
        current.switching === false &&
        (!options.authoritative || current.pendingSend === null) &&
        (!options.authoritative || current.streaming === null) &&
        sameMessages(current.messages, messages)
      ) {
        return current;
      }
      return {
        ...current,
        messages,
        historyStatus: "ready",
        switching: false,
        pendingSend: options.authoritative ? null : current.pendingSend,
        streaming: options.authoritative ? null : current.streaming,
      };
    });
  }

  markHistoryError(sessionId: string): void {
    this.updateSession(sessionId, (current) => {
      if (current.historyStatus === "error" && current.switching === false) {
        return current;
      }
      return {
        ...current,
        historyStatus: "error",
        switching: false,
      };
    });
  }

  primeMessages(sessionId: string, messages: ChatMessage[]): void {
    this.updateSession(sessionId, (current) => {
      if (sameMessages(current.messages, messages) && current.historyStatus === "ready") {
        return current;
      }
      return {
        ...current,
        messages,
        historyStatus: "ready",
      };
    });
  }

  appendOptimisticMessage(sessionId: string, message: ChatMessage): void {
    this.updateSession(sessionId, (current) => {
      const alreadyPresent = current.messages.some((entry) => entry.id === message.id);
      const nextMessages = alreadyPresent
        ? current.messages
        : [...current.messages, message];
      const nextPendingSend: PendingChatSendState = {
        optimisticMessageId: message.id,
        submittedAt: nowIso(),
      };
      if (
        sameMessages(current.messages, nextMessages) &&
        samePendingSend(current.pendingSend, nextPendingSend) &&
        current.historyStatus === "ready"
      ) {
        return current;
      }
      return {
        ...current,
        messages: nextMessages,
        historyStatus: "ready",
        pendingSend: nextPendingSend,
      };
    });
  }

  trackSubmit(sessionId: string): void {
    this.clearTimeoutFor(this.feedbackClearTimeouts, sessionId);
    this.pendingChatMetrics.set(sessionId, {
      startedAt: performance.now(),
      firstToken: clientPerformance.start("client.chat.submit_to_first_token", {
        sessionId,
      }),
      firstTokenFinished: false,
      completed: clientPerformance.start("client.chat.submit_to_done", {
        sessionId,
      }),
    });

    this.updateSession(sessionId, (current) => ({
      ...current,
      pendingSend: current.pendingSend ?? {
        optimisticMessageId: null,
        submittedAt: nowIso(),
      },
      liveFeedback: {
        sessionId,
        status: "waiting_first_token",
        firstTokenMs: null,
        completedMs: null,
        errorMessage: null,
        updatedAt: nowIso(),
      },
      recentFeedback: null,
    }));
  }

  trackFailure(sessionId: string, message: string): void {
    const feedback = this.finalizeTrackedRun(sessionId, {
      status: "error",
      message,
    });
    this.updateSession(sessionId, (current) => ({
      ...current,
      pendingSend: null,
      liveFeedback: feedback,
      recentFeedback: feedback,
    }));
    this.scheduleFeedbackClear(sessionId);
  }

  handleHistoryEvent(payload: {
    sessionId: string;
    messages: ChatMessage[];
  }): void {
    const historyMetric = clientPerformance.start("client.chat.history_resync", {
      sessionId: payload.sessionId,
    });
    this.markHistoryReady(payload.sessionId, payload.messages, {
      authoritative: true,
    });
    historyMetric.finish({
      sessionId: payload.sessionId,
      messageCount: payload.messages.length,
      outcome: "ok",
    });
  }

  handleRunEvent(run: ChatRunState): void {
    this.clearTimeoutFor(this.runClearTimeouts, run.sessionId);
    this.updateSession(
      run.sessionId,
      (current) => {
        if (sameRunState(current.activeRun, run)) {
          return current;
        }

        const nextRun: ChatRunViewState = {
          ...run,
          startedAt:
            current.activeRun && current.activeRun.runId === run.runId
              ? current.activeRun.startedAt
              : run.updatedAt,
          activities:
            current.activeRun && current.activeRun.runId === run.runId
              ? appendActivity(current.activeRun.activities, activityFromRun(run))
              : [activityFromRun(run)],
        };

        return {
          ...current,
          activeRun: nextRun,
        };
      },
      { defer: true },
    );

    if (
      !run.active &&
      (run.stage === "completed" || run.stage === "failed")
    ) {
      this.scheduleRunClear(run.sessionId, run.runId);
    }
  }

  clearRun(sessionId: string): void {
    this.clearTimeoutFor(this.runClearTimeouts, sessionId);
    this.updateSession(
      sessionId,
      (current) => {
        if (!current.activeRun) {
          return current;
        }
        return {
          ...current,
          activeRun: null,
        };
      },
      { defer: true },
    );
  }

  handleStreamDelta(payload: {
    sessionId: string;
    runId: string;
    delta: string;
  }): void {
    this.clearTimeoutFor(this.streamClearTimeouts, payload.sessionId);
    this.clearTimeoutFor(this.feedbackClearTimeouts, payload.sessionId);
    const tracked = this.pendingChatMetrics.get(payload.sessionId);
    const firstTokenMs = tracked
      ? Number((performance.now() - tracked.startedAt).toFixed(2))
      : null;
    if (tracked && !tracked.firstTokenFinished) {
      tracked.firstToken.finish({
        runId: payload.runId,
      });
      tracked.firstTokenFinished = true;
    }

    this.updateSession(
      payload.sessionId,
      (current) => {
        const nextStreaming: StreamingRun = {
          runId: payload.runId,
          text:
            current.streaming?.runId === payload.runId
              ? `${current.streaming.text}${payload.delta}`
              : payload.delta,
        };
        const nextLiveFeedback: ChatSessionFeedback = {
          sessionId: payload.sessionId,
          status: "streaming",
          firstTokenMs: current.liveFeedback?.firstTokenMs ?? firstTokenMs,
          completedMs: null,
          errorMessage: null,
          updatedAt: nowIso(),
        };
        if (
          sameStreamingRun(current.streaming, nextStreaming) &&
          sameFeedback(current.liveFeedback, nextLiveFeedback)
        ) {
          return current;
        }
        return {
          ...current,
          streaming: nextStreaming,
          liveFeedback: nextLiveFeedback,
        };
      },
      { defer: true },
    );
  }

  handleStreamDone(payload: { sessionId: string; runId: string }): void {
    this.clearTimeoutFor(this.streamClearTimeouts, payload.sessionId);
    const feedback = this.finalizeTrackedRun(payload.sessionId, {
      runId: payload.runId,
      status: "done",
      noDelta: this.getSessionSnapshot(payload.sessionId).liveFeedback?.firstTokenMs === null,
    });
    this.updateSession(payload.sessionId, (current) => ({
      ...current,
      pendingSend: null,
      liveFeedback: feedback,
      recentFeedback: feedback,
    }));
    this.scheduleFeedbackClear(payload.sessionId);
    this.scheduleStreamClear(payload.sessionId, payload.runId);
  }

  handleStreamError(payload: {
    sessionId: string;
    runId: string;
    message: string;
  }): void {
    this.clearTimeoutFor(this.streamClearTimeouts, payload.sessionId);
    const feedback = this.finalizeTrackedRun(payload.sessionId, {
      runId: payload.runId,
      status: "error",
      message: payload.message,
      noDelta: this.getSessionSnapshot(payload.sessionId).liveFeedback?.firstTokenMs === null,
    });
    this.updateSession(payload.sessionId, (current) => ({
      ...current,
      pendingSend: null,
      liveFeedback: feedback,
      recentFeedback: feedback,
    }));
    this.scheduleFeedbackClear(payload.sessionId);
    this.scheduleStreamClear(payload.sessionId, payload.runId);
  }

  setStreaming(sessionId: string, streaming: StreamingRun | null): void {
    if (!streaming) {
      this.clearStreaming(sessionId);
      return;
    }

    this.clearTimeoutFor(this.streamClearTimeouts, sessionId);
    this.updateSession(
      sessionId,
      (current) => {
        if (sameStreamingRun(current.streaming, streaming)) {
          return current;
        }
        return {
          ...current,
          streaming,
        };
      },
      { defer: true },
    );
  }

  clearStreaming(sessionId: string): void {
    this.clearTimeoutFor(this.streamClearTimeouts, sessionId);
    this.updateSession(
      sessionId,
      (current) => {
        if (!current.streaming) {
          return current;
        }
        return {
          ...current,
          streaming: null,
        };
      },
      { defer: true },
    );
  }

  markSessionSwitching(sessionId: string, switching: boolean): void {
    this.updateSession(sessionId, (current) => {
      if (current.switching === switching) {
        return current;
      }
      return {
        ...current,
        switching,
      };
    });
  }

  clearSession(sessionId: string): void {
    this.clearTimeoutFor(this.feedbackClearTimeouts, sessionId);
    this.clearTimeoutFor(this.streamClearTimeouts, sessionId);
    this.clearTimeoutFor(this.runClearTimeouts, sessionId);
    this.pendingChatMetrics.delete(sessionId);
    if (!(sessionId in this.snapshot.sessions)) {
      return;
    }
    const nextSessions = { ...this.snapshot.sessions };
    delete nextSessions[sessionId];
    this.snapshot = {
      sessions: nextSessions,
    };
    this.emit();
  }

  reset(): void {
    for (const sessionId of this.feedbackClearTimeouts.keys()) {
      this.clearTimeoutFor(this.feedbackClearTimeouts, sessionId);
    }
    for (const sessionId of this.streamClearTimeouts.keys()) {
      this.clearTimeoutFor(this.streamClearTimeouts, sessionId);
    }
    for (const sessionId of this.runClearTimeouts.keys()) {
      this.clearTimeoutFor(this.runClearTimeouts, sessionId);
    }
    this.pendingChatMetrics.clear();
    if (this.emitHandle !== null) {
      if (
        typeof window !== "undefined" &&
        typeof window.cancelAnimationFrame === "function" &&
        typeof this.emitHandle === "number"
      ) {
        window.cancelAnimationFrame(this.emitHandle);
      } else {
        clearTimeout(this.emitHandle as ReturnType<typeof setTimeout>);
      }
      this.emitHandle = null;
    }
    this.snapshot = EMPTY_STORE_SNAPSHOT;
    this.emit();
  }
}

export const chatSessionStore = new ChatSessionStore();

export function useChatSessionSnapshot(
  sessionId: string | null | undefined,
): ChatSessionClientState {
  return useSyncExternalStore(
    (listener) => chatSessionStore.subscribe(listener),
    () => chatSessionStore.getSessionSnapshot(sessionId),
    () => EMPTY_SESSION_STATE,
  );
}
