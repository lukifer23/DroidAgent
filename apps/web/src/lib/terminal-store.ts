import { useSyncExternalStore } from "react";
import type { TerminalSessionSummary, TerminalSnapshot } from "@droidagent/shared";

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

const textEncoder = new TextEncoder();

class TerminalStore {
  private readonly listeners = new Set<Listener>();
  private state: TerminalStoreState = emptyState;
  private emitHandle: number | ReturnType<typeof setTimeout> | null = null;

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
    this.state = {
      session: snapshot.session,
      transcript: snapshot.transcript,
      transcriptBytes:
        snapshot.session?.transcriptBytes ??
        textEncoder.encode(snapshot.transcript).length,
      truncated: snapshot.truncated,
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

    const maxBytes = this.state.maxBytes;
    const chunkBytes = textEncoder.encode(data).length;
    const nextBytes = this.state.transcriptBytes + chunkBytes;
    let nextTranscript = `${this.state.transcript}${data}`;
    let nextTranscriptBytes = nextBytes;
    let truncated = nextBytes > maxBytes;

    if (truncated) {
      const overflow = nextBytes - maxBytes;
      const estimatedCharsToTrim = Math.max(
        64,
        Math.ceil(
          (overflow / Math.max(chunkBytes, 1)) * Math.max(data.length, 1),
        ),
      );
      nextTranscript = nextTranscript.slice(estimatedCharsToTrim);
      nextTranscriptBytes = textEncoder.encode(nextTranscript).length;

      while (nextTranscriptBytes > maxBytes && nextTranscript.length > 0) {
        nextTranscript = nextTranscript.slice(
          Math.min(
            nextTranscript.length,
            Math.max(1, Math.ceil(nextTranscript.length * 0.1)),
          ),
        );
        nextTranscriptBytes = textEncoder.encode(nextTranscript).length;
      }
    }

    this.state = {
      ...this.state,
      transcript: nextTranscript,
      transcriptBytes: nextTranscriptBytes,
      truncated,
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
