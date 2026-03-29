import { useSyncExternalStore } from "react";
import type { TerminalSessionSummary, TerminalSnapshot } from "@droidagent/shared";

type Listener = () => void;

interface TerminalStoreState {
  session: TerminalSessionSummary | null;
  transcript: string;
  truncated: boolean;
  maxBytes: number;
  closeReason: string | null;
}

const emptyState: TerminalStoreState = {
  session: null,
  transcript: "",
  truncated: false,
  maxBytes: 256 * 1024,
  closeReason: null,
};

const textEncoder = new TextEncoder();

class TerminalStore {
  private readonly listeners = new Set<Listener>();
  private state: TerminalStoreState = emptyState;

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

  replace(snapshot: TerminalSnapshot): void {
    this.state = {
      session: snapshot.session,
      transcript: snapshot.transcript,
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
      closeReason: null,
    };
    this.emit();
  }

  appendOutput(sessionId: string, data: string): void {
    if (!this.state.session || this.state.session.id !== sessionId) {
      return;
    }

    const nextTranscript = `${this.state.transcript}${data}`;
    const maxBytes = this.state.maxBytes;
    const encoded = textEncoder.encode(nextTranscript);
    const truncated = encoded.byteLength > maxBytes;
    this.state = {
      ...this.state,
      transcript: truncated
        ? new TextDecoder().decode(
            encoded.subarray(encoded.byteLength - maxBytes),
          )
        : nextTranscript,
      truncated,
    };
    this.emit();
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
    this.emit();
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
