import { useSyncExternalStore } from "react";

export interface StreamingRun {
  runId: string;
  text: string;
}

type Listener = () => void;

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
