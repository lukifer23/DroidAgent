import { useSyncExternalStore } from "react";
import type { ChatRunStage, ChatRunState } from "@droidagent/shared";

type Listener = () => void;

const MAX_RUN_ACTIVITIES = 6;

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

function sameRunState(left: ChatRunViewState | undefined, right: ChatRunState): boolean {
  return (
    left?.sessionId === right.sessionId &&
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

class ChatRunStore {
  private readonly listeners = new Set<Listener>();
  private runs: Record<string, ChatRunViewState> = {};

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): Record<string, ChatRunViewState> {
    return this.runs;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  setRun(run: ChatRunState): void {
    if (sameRunState(this.runs[run.sessionId], run)) {
      return;
    }

    const current = this.runs[run.sessionId];
    const next: ChatRunViewState = {
      ...run,
      startedAt:
        current && current.runId === run.runId
          ? current.startedAt
          : run.updatedAt,
      activities:
        current && current.runId === run.runId
          ? appendActivity(current.activities, activityFromRun(run))
          : [activityFromRun(run)],
    };

    this.runs = {
      ...this.runs,
      [run.sessionId]: next,
    };
    this.emit();
  }

  clear(sessionId: string): void {
    if (!(sessionId in this.runs)) {
      return;
    }

    const next = { ...this.runs };
    delete next[sessionId];
    this.runs = next;
    this.emit();
  }
}

export const chatRunStore = new ChatRunStore();

export function useChatRuns() {
  const emptySnapshot: Record<string, ChatRunViewState> = {};
  return useSyncExternalStore(
    (listener) => chatRunStore.subscribe(listener),
    () => chatRunStore.getSnapshot(),
    () => emptySnapshot,
  );
}
