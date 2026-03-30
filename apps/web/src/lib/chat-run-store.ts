import { useSyncExternalStore } from "react";
import type { ChatRunState } from "@droidagent/shared";

type Listener = () => void;

function sameRunState(left: ChatRunState | undefined, right: ChatRunState): boolean {
  return (
    left?.sessionId === right.sessionId &&
    left.runId === right.runId &&
    left.stage === right.stage &&
    left.label === right.label &&
    left.detail === right.detail &&
    left.toolName === right.toolName &&
    left.approvalId === right.approvalId &&
    left.active === right.active &&
    left.updatedAt === right.updatedAt
  );
}

class ChatRunStore {
  private readonly listeners = new Set<Listener>();
  private runs: Record<string, ChatRunState> = {};

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): Record<string, ChatRunState> {
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

    this.runs = {
      ...this.runs,
      [run.sessionId]: run,
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
  const emptySnapshot: Record<string, ChatRunState> = {};
  return useSyncExternalStore(
    (listener) => chatRunStore.subscribe(listener),
    () => chatRunStore.getSnapshot(),
    () => emptySnapshot,
  );
}
