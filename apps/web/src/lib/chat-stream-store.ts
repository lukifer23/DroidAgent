import { useSyncExternalStore } from "react";

import {
  chatSessionStore,
  type StreamingRun,
} from "./chat-session-store";

type StreamingSnapshot = Record<string, StreamingRun>;
type Listener = () => void;

let cachedStreaming: StreamingSnapshot = {};
let cachedSessions = chatSessionStore.getSnapshot().sessions;

function deriveStreaming(): StreamingSnapshot {
  const { sessions } = chatSessionStore.getSnapshot();
  if (sessions === cachedSessions) {
    return cachedStreaming;
  }

  const nextStreaming: StreamingSnapshot = {};
  let changed = false;

  for (const [sessionId, session] of Object.entries(sessions)) {
    if (session.streaming) {
      nextStreaming[sessionId] = session.streaming;
    }
    if (cachedStreaming[sessionId] !== nextStreaming[sessionId]) {
      changed = true;
    }
  }

  if (!changed) {
    const nextKeys = Object.keys(nextStreaming);
    const cachedKeys = Object.keys(cachedStreaming);
    changed = nextKeys.length !== cachedKeys.length;
  }

  cachedSessions = sessions;
  if (!changed) {
    return cachedStreaming;
  }

  cachedStreaming = nextStreaming;
  return cachedStreaming;
}

class ChatStreamStoreFacade {
  subscribe(listener: Listener): () => void {
    return chatSessionStore.subscribe(listener);
  }

  getSnapshot(): StreamingSnapshot {
    return deriveStreaming();
  }

  setRuns(next: StreamingSnapshot): void {
    const current = deriveStreaming();
    for (const sessionId of Object.keys(current)) {
      if (!(sessionId in next)) {
        chatSessionStore.clearStreaming(sessionId);
      }
    }
    for (const [sessionId, run] of Object.entries(next)) {
      chatSessionStore.setStreaming(sessionId, run);
    }
  }

  clear(sessionId: string): void {
    chatSessionStore.clearStreaming(sessionId);
  }
}

export const chatStreamStore = new ChatStreamStoreFacade();

export function useStreamingRuns() {
  const emptySnapshot: StreamingSnapshot = {};
  return useSyncExternalStore(
    (listener) => chatStreamStore.subscribe(listener),
    () => chatStreamStore.getSnapshot(),
    () => emptySnapshot,
  );
}

export type { StreamingRun };
