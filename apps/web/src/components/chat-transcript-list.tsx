import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import type { ApprovalRecord, ChatMessage } from "@droidagent/shared";

import {
  CopyButton,
  MessageMemoryActions,
  MessagePartView,
  formatMessageTime,
  type ExpandedImageState,
  shouldShowCopyButton,
} from "./chat-message-parts";
import { roleLabel } from "../lib/formatters";
import {
  computeTranscriptWindow,
  estimateChatMessageHeight,
} from "../lib/transcript-windowing";

const STICKY_BOTTOM_THRESHOLD_PX = 120;

function readGapPx(container: HTMLElement): number {
  const styles = window.getComputedStyle(container);
  const rowGap =
    styles.rowGap && styles.rowGap !== "normal"
      ? Number.parseFloat(styles.rowGap)
      : Number.NaN;
  const fallbackGap =
    styles.gap && styles.gap !== "normal"
      ? Number.parseFloat(styles.gap)
      : Number.NaN;
  const nextGap = Number.isFinite(rowGap) ? rowGap : fallbackGap;
  return Number.isFinite(nextGap) ? nextGap : 0;
}

function measureBottomGap(container: HTMLElement): number {
  return container.scrollHeight - container.scrollTop - container.clientHeight;
}

interface TranscriptMessageCardProps {
  message: ChatMessage;
  approvals: ApprovalRecord[];
  approvalsById: Map<string, ApprovalRecord>;
  pressureBlocks: boolean;
  hostPressureMessage: string | null | undefined;
  runAction: (
    work: () => Promise<void>,
    successMessage?: string,
  ) => Promise<void>;
  onCreateMemoryDraft: (
    target: "memory" | "preferences" | "todayNote",
    message: ChatMessage,
  ) => Promise<void>;
  onRunCommandFromMessage: (command: string) => void;
  onOpenInTerminal: (command: string) => void;
  onOpenImage: (image: ExpandedImageState) => void;
  onResolveApprovalAction: (
    approvalId: string,
    resolution: "approved" | "denied",
  ) => void;
  onMeasure?: ((messageId: string, height: number) => void) | undefined;
}

const TranscriptMessageCard = memo(
  function TranscriptMessageCard({
    approvals,
    approvalsById,
    hostPressureMessage,
    message,
    onCreateMemoryDraft,
    onMeasure,
    onOpenImage,
    onOpenInTerminal,
    onResolveApprovalAction,
    onRunCommandFromMessage,
    pressureBlocks,
    runAction,
  }: TranscriptMessageCardProps) {
    const articleRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
      if (!onMeasure) {
        return;
      }

      const article = articleRef.current;
      if (!article) {
        return;
      }

      const reportHeight = () => {
        onMeasure(
          message.id,
          Math.max(1, Math.round(article.getBoundingClientRect().height)),
        );
      };

      reportHeight();
      if (typeof ResizeObserver === "undefined") {
        return;
      }

      const observer = new ResizeObserver(() => {
        reportHeight();
      });
      observer.observe(article);
      return () => {
        observer.disconnect();
      };
    }, [message, onMeasure]);

    const parts =
      message.parts.length > 0
        ? message.parts
        : [
            {
              type: "markdown",
              text: message.text,
            } as const,
          ];

    return (
      <article ref={articleRef} className={`message-card ${message.role}`}>
        <div className="message-meta">
          <div className="message-meta-copy">
            <header>{roleLabel(message.role)}</header>
            <span>{formatMessageTime(message.createdAt)}</span>
          </div>
          {shouldShowCopyButton(message) ? (
            <CopyButton text={message.text} />
          ) : null}
        </div>

        <div className="message-part-stack">
          {parts.map((part, index) => {
            const approval =
              part.type === "approval_request"
                ? ((part.approvalId
                    ? (approvalsById.get(part.approvalId) ?? null)
                    : null) ?? (approvals.length === 1 ? approvals[0]! : null))
                : null;

            return (
              <MessagePartView
                key={`${message.id}-${part.type}-${index}`}
                approval={approval}
                commandActionDisabledReason={
                  pressureBlocks
                    ? (hostPressureMessage ??
                      "Host pressure is critical. New agent runs are paused.")
                    : null
                }
                commandActionsEnabled={!pressureBlocks}
                onOpenImage={onOpenImage}
                onOpenInTerminal={onOpenInTerminal}
                onResolveApproval={onResolveApprovalAction}
                onRunCommand={onRunCommandFromMessage}
                part={part}
              />
            );
          })}
        </div>

        {message.text.trim() ? (
          <MessageMemoryActions
            onAddMemory={() =>
              void runAction(async () => {
                await onCreateMemoryDraft("memory", message);
              }, "Draft added to durable memory.")
            }
            onAddPreferences={() =>
              void runAction(async () => {
                await onCreateMemoryDraft("preferences", message);
              }, "Draft added to preferences.")
            }
            onAddTodayNote={() =>
              void runAction(async () => {
                await onCreateMemoryDraft("todayNote", message);
              }, "Draft added to today's note.")
            }
          />
        ) : null}
      </article>
    );
  },
  (previousProps, nextProps) => {
    return (
      previousProps.message === nextProps.message &&
      previousProps.approvals === nextProps.approvals &&
      previousProps.approvalsById === nextProps.approvalsById &&
      previousProps.pressureBlocks === nextProps.pressureBlocks &&
      previousProps.hostPressureMessage === nextProps.hostPressureMessage &&
      Boolean(previousProps.onMeasure) === Boolean(nextProps.onMeasure)
    );
  },
);

interface ChatTranscriptListProps {
  threadRef: RefObject<HTMLDivElement | null>;
  sessionId: string;
  messages: ChatMessage[];
  approvals: ApprovalRecord[];
  approvalsById: Map<string, ApprovalRecord>;
  pressureBlocks: boolean;
  hostPressureMessage: string | null | undefined;
  runAction: (
    work: () => Promise<void>,
    successMessage?: string,
  ) => Promise<void>;
  onCreateMemoryDraft: (
    target: "memory" | "preferences" | "todayNote",
    message: ChatMessage,
  ) => Promise<void>;
  onRunCommandFromMessage: (command: string) => void;
  onOpenInTerminal: (command: string) => void;
  onOpenImage: (image: ExpandedImageState) => void;
  onResolveApprovalAction: (
    approvalId: string,
    resolution: "approved" | "denied",
  ) => void;
  activeRunUpdatedAt?: string | null | undefined;
  streamingText: string;
}

export function ChatTranscriptList({
  activeRunUpdatedAt,
  approvals,
  approvalsById,
  hostPressureMessage,
  messages,
  onCreateMemoryDraft,
  onOpenImage,
  onOpenInTerminal,
  onResolveApprovalAction,
  onRunCommandFromMessage,
  pressureBlocks,
  runAction,
  sessionId,
  streamingText,
  threadRef,
}: ChatTranscriptListProps) {
  const itemHeightsRef = useRef(new Map<string, number>());
  const previousSessionIdRef = useRef(sessionId);
  const layoutFrameRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const stickToBottomRef = useRef(true);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [scrollState, setScrollState] = useState({
    scrollTop: 0,
    viewportHeight: 0,
    gapPx: 0,
  });

  const scheduleLayoutRefresh = useCallback(() => {
    if (layoutFrameRef.current !== null) {
      return;
    }
    layoutFrameRef.current = window.requestAnimationFrame(() => {
      layoutFrameRef.current = null;
      setLayoutVersion((current) => current + 1);
    });
  }, []);

  const updateScrollState = useCallback(() => {
    const container = threadRef.current;
    if (!container) {
      return;
    }
    stickToBottomRef.current =
      measureBottomGap(container) <= STICKY_BOTTOM_THRESHOLD_PX;
    const nextState = {
      scrollTop: container.scrollTop,
      viewportHeight: container.clientHeight,
      gapPx: readGapPx(container),
    };
    setScrollState((current) =>
      current.scrollTop === nextState.scrollTop &&
      current.viewportHeight === nextState.viewportHeight &&
      current.gapPx === nextState.gapPx
        ? current
        : nextState,
    );
  }, [threadRef]);

  const scheduleScrollStateUpdate = useCallback(() => {
    if (scrollFrameRef.current !== null) {
      return;
    }
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      updateScrollState();
    });
  }, [updateScrollState]);

  const recordMeasuredHeight = useCallback(
    (messageId: string, height: number) => {
      const roundedHeight = Math.max(1, Math.round(height));
      const currentHeight = itemHeightsRef.current.get(messageId);
      if (
        currentHeight !== undefined &&
        Math.abs(currentHeight - roundedHeight) <= 1
      ) {
        return;
      }
      itemHeightsRef.current.set(messageId, roundedHeight);
      scheduleLayoutRefresh();
    },
    [scheduleLayoutRefresh],
  );

  useEffect(() => {
    const container = threadRef.current;
    if (!container) {
      return;
    }

    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            scheduleScrollStateUpdate();
          })
        : null;
    resizeObserver?.observe(container);
    updateScrollState();
    container.addEventListener("scroll", scheduleScrollStateUpdate, {
      passive: true,
    });

    return () => {
      resizeObserver?.disconnect();
      container.removeEventListener("scroll", scheduleScrollStateUpdate);
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [scheduleScrollStateUpdate, threadRef, updateScrollState]);

  useEffect(() => {
    if (previousSessionIdRef.current === sessionId) {
      return;
    }
    previousSessionIdRef.current = sessionId;
    itemHeightsRef.current.clear();
    stickToBottomRef.current = true;
    setLayoutVersion((current) => current + 1);
  }, [sessionId]);

  useEffect(() => {
    const activeMessageIds = new Set(messages.map((message) => message.id));
    let changed = false;
    for (const messageId of itemHeightsRef.current.keys()) {
      if (activeMessageIds.has(messageId)) {
        continue;
      }
      itemHeightsRef.current.delete(messageId);
      changed = true;
    }
    if (changed) {
      scheduleLayoutRefresh();
    }
  }, [messages, scheduleLayoutRefresh]);

  useEffect(() => {
    const container = threadRef.current;
    if (!container) {
      return;
    }
    if (!stickToBottomRef.current) {
      return;
    }

    const frameHandle = window.requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
      updateScrollState();
    });
    return () => {
      window.cancelAnimationFrame(frameHandle);
    };
  }, [
    activeRunUpdatedAt,
    layoutVersion,
    messages.length,
    sessionId,
    streamingText,
    threadRef,
    updateScrollState,
  ]);

  const windowedLayout = useMemo(
    () =>
      computeTranscriptWindow({
        count: messages.length,
        scrollTop: scrollState.scrollTop,
        viewportHeight: scrollState.viewportHeight,
        gapPx: scrollState.gapPx,
        getItemHeight: (index) =>
          itemHeightsRef.current.get(messages[index]!.id) ??
          estimateChatMessageHeight(messages[index]!),
      }),
    [
      layoutVersion,
      messages,
      scrollState.gapPx,
      scrollState.scrollTop,
      scrollState.viewportHeight,
    ],
  );

  const visibleMessages = windowedLayout.enabled
    ? messages.slice(windowedLayout.startIndex, windowedLayout.endIndex)
    : messages;

  return (
    <>
      {windowedLayout.enabled && windowedLayout.topSpacerPx > 0 ? (
        <div
          aria-hidden="true"
          className="chat-virtual-spacer"
          style={{ height: `${windowedLayout.topSpacerPx}px` }}
        />
      ) : null}
      {visibleMessages.map((message) => (
        <TranscriptMessageCard
          key={message.id}
          approvals={approvals}
          approvalsById={approvalsById}
          hostPressureMessage={hostPressureMessage}
          message={message}
          onCreateMemoryDraft={onCreateMemoryDraft}
          onMeasure={windowedLayout.enabled ? recordMeasuredHeight : undefined}
          onOpenImage={onOpenImage}
          onOpenInTerminal={onOpenInTerminal}
          onResolveApprovalAction={onResolveApprovalAction}
          onRunCommandFromMessage={onRunCommandFromMessage}
          pressureBlocks={pressureBlocks}
          runAction={runAction}
        />
      ))}
      {windowedLayout.enabled && windowedLayout.bottomSpacerPx > 0 ? (
        <div
          aria-hidden="true"
          className="chat-virtual-spacer"
          style={{ height: `${windowedLayout.bottomSpacerPx}px` }}
        />
      ) : null}
    </>
  );
}
