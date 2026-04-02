import { useSyncExternalStore } from "react";
import type { ChatRunState } from "@droidagent/shared";

import {
  chatSessionStore,
  type ChatRunActivity,
  type ChatRunViewState,
} from "./chat-session-store";

type ChatRunSnapshot = Record<string, ChatRunViewState>;
type Listener = () => void;

let cachedRuns: ChatRunSnapshot = {};
let cachedSessions = chatSessionStore.getSnapshot().sessions;

function deriveRuns(): ChatRunSnapshot {
  const { sessions } = chatSessionStore.getSnapshot();
  if (sessions === cachedSessions) {
    return cachedRuns;
  }

  const nextRuns: ChatRunSnapshot = {};
  let changed = false;

  for (const [sessionId, session] of Object.entries(sessions)) {
    if (session.activeRun) {
      nextRuns[sessionId] = session.activeRun;
    }
    if (cachedRuns[sessionId] !== nextRuns[sessionId]) {
      changed = true;
    }
  }

  if (!changed) {
    const nextKeys = Object.keys(nextRuns);
    const cachedKeys = Object.keys(cachedRuns);
    changed = nextKeys.length !== cachedKeys.length;
  }

  cachedSessions = sessions;
  if (!changed) {
    return cachedRuns;
  }

  cachedRuns = nextRuns;
  return cachedRuns;
}

class ChatRunStoreFacade {
  subscribe(listener: Listener): () => void {
    return chatSessionStore.subscribe(listener);
  }

  getSnapshot(): ChatRunSnapshot {
    return deriveRuns();
  }

  setRun(run: ChatRunState): void {
    chatSessionStore.handleRunEvent(run);
  }

  clear(sessionId: string): void {
    chatSessionStore.clearRun(sessionId);
  }
}

export const chatRunStore = new ChatRunStoreFacade();

export function useChatRuns() {
  const emptySnapshot: ChatRunSnapshot = {};
  return useSyncExternalStore(
    (listener) => chatRunStore.subscribe(listener),
    () => chatRunStore.getSnapshot(),
    () => emptySnapshot,
  );
}

export type { ChatRunActivity, ChatRunViewState };
