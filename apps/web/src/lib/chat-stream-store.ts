import { useSyncExternalStore } from "react";

export interface StreamingRun {
  runId: string;
  text: string;
}

type Listener = () => void;

function sameStreamingRun(
  left: StreamingRun | undefined,
  right: StreamingRun | undefined,
): boolean {
  if (!left && !right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return left.runId === right.runId && left.text === right.text;
}

function sameStreamingSnapshot(
  left: Record<string, StreamingRun>,
  right: Record<string, StreamingRun>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every((key) => sameStreamingRun(left[key], right[key]));
}

class ChatStreamStore {
  private readonly listeners = new Set<Listener>();
  private runs: Record<string, StreamingRun> = {};

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): Record<string, StreamingRun> {
    return this.runs;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  setRuns(next: Record<string, StreamingRun>): void {
    if (sameStreamingSnapshot(this.runs, next)) {
      return;
    }

    this.runs = next;
    this.emit();
  }

  clear(sessionId: string): void {
    if (!(sessionId in this.runs)) {
      return;
    }
    const next = { ...this.runs };
    delete next[sessionId];
    this.setRuns(next);
  }
}

export const chatStreamStore = new ChatStreamStore();

export function useStreamingRuns() {
  const emptySnapshot: Record<string, StreamingRun> = {};
  return useSyncExternalStore(
    (listener) => chatStreamStore.subscribe(listener),
    () => chatStreamStore.getSnapshot(),
    () => emptySnapshot
  );
}
