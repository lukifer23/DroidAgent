import { useSyncExternalStore } from "react";
import {
  Utf8TailBuffer,
  type TerminalSessionSummary,
  type TerminalSnapshot,
} from "@droidagent/shared";

type Listener = () => void;

interface TerminalStoreState {
  session: TerminalSessionSummary | null;
  transcript: string;
  transcriptBytes: number;
  truncated: boolean;
  maxBytes: number;
  closeReason: string | null;
}

const emptyState: TerminalStoreState = {
  session: null,
  transcript: "",
  transcriptBytes: 0,
  truncated: false,
  maxBytes: 256 * 1024,
  closeReason: null,
};

class TerminalStore {
  private readonly listeners = new Set<Listener>();
  private state: TerminalStoreState = emptyState;
  private emitHandle: number | ReturnType<typeof setTimeout> | null = null;
  private readonly transcriptBuffer = new Utf8TailBuffer(emptyState.maxBytes);

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): TerminalStoreState {
    return this.state;
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
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
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

  replace(snapshot: TerminalSnapshot): void {
    const replaced = this.transcriptBuffer.replace(snapshot.transcript);
    this.state = {
      session: snapshot.session,
      transcript: this.transcriptBuffer.snapshot(),
      transcriptBytes:
        snapshot.session?.transcriptBytes ?? replaced.bytes,
      truncated: snapshot.truncated || replaced.truncated,
      maxBytes: snapshot.maxBytes,
      closeReason: snapshot.closeReason,
    };
    this.emit();
  }

  updateSession(session: TerminalSessionSummary): void {
    this.state = {
      ...this.state,
      session,
      transcriptBytes: session.transcriptBytes,
      closeReason: null,
    };
    this.scheduleEmit();
  }

  appendOutput(sessionId: string, data: string): void {
    if (!this.state.session || this.state.session.id !== sessionId) {
      return;
    }

    const next = this.transcriptBuffer.append(data);

    this.state = {
      ...this.state,
      transcript: this.transcriptBuffer.snapshot(),
      transcriptBytes: next.bytes,
      truncated: this.state.truncated || next.truncated,
    };
    this.scheduleEmit();
  }

  close(sessionId: string, reason: string | null): void {
    if (!this.state.session || this.state.session.id !== sessionId) {
      return;
    }

    this.state = {
      ...this.state,
      session: {
        ...this.state.session,
        status: "closed",
        idleExpiresAt: null,
      },
      closeReason: reason,
    };
    this.scheduleEmit();
  }
}

export const terminalStore = new TerminalStore();

export function useTerminalState(): TerminalStoreState {
  return useSyncExternalStore(
    (listener) => terminalStore.subscribe(listener),
    () => terminalStore.getSnapshot(),
    () => emptyState,
  );
}
