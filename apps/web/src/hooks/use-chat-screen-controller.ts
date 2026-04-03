import {
  type ClipboardEvent,
  type FormEvent,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type {
  ChatAttachment,
  ChatMessage,
  DashboardState,
  HostPressureRecoveryResult,
  SessionSummary,
} from "@droidagent/shared";

import {
  useAuthQuery,
  useDashboardQuery,
  usePerformanceSubscription,
} from "../app-data";
import { useClientPerformanceSnapshot, useDroidAgentApp } from "../app-context";
import type { ExpandedImageState } from "../components/chat-message-parts";
import type { ChatScreenShellProps } from "../components/chat-screen-shell";
import {
  buildRunBreakdown,
  describeChatFeedback,
  isTerminalChatFeedback,
} from "../components/chat-run-panels";
import { useDecisionActions } from "./use-decision-actions";
import { api, postFormData, postJson } from "../lib/api";
import { buildRunInChatPrompt } from "../lib/command-suggestions";
import { TERMINAL_PREFILL_STORAGE_KEY } from "../lib/constants";
import { buildOptimisticChatMessage } from "../lib/chat-screen-utils";
import {
  prefetchSessionMessages,
  setCachedSessionMessages,
} from "../lib/chat-session-cache";
import { chatSessionStore } from "../lib/chat-session-store";
import {
  getPendingDecisions,
  getSessionDecisions,
} from "../lib/dashboard-selectors";
import { formatLatency, formatTokenBudget, roleLabel } from "../lib/formatters";
import { clientPerformance } from "../lib/client-performance";
import {
  closeCurrentSession,
  restoreSession,
  startFreshSession,
} from "../lib/chat-session-actions";
import { useChatSessionState } from "./use-chat-session-state";

interface ChatDashboardSlice {
  approvals: DashboardState["approvals"];
  decisions: DashboardState["decisions"];
  harness: DashboardState["harness"];
  hostPressure: DashboardState["hostPressure"];
  maintenance: DashboardState["maintenance"];
  memory: DashboardState["memory"];
  providers: DashboardState["providers"];
  runtimes: DashboardState["runtimes"];
  sessions: DashboardState["sessions"];
}

function selectChatDashboard(data: DashboardState): ChatDashboardSlice {
  return {
    approvals: data.approvals,
    decisions: data.decisions,
    harness: data.harness,
    hostPressure: data.hostPressure,
    maintenance: data.maintenance,
    memory: data.memory,
    providers: data.providers,
    runtimes: data.runtimes,
    sessions: data.sessions,
  };
}

export function useChatScreenController(): ChatScreenShellProps {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const {
    selectedSessionId,
    setSelectedSessionId,
    sendRealtimeCommand,
    trackChatSubmit,
    trackChatFailure,
    runAction,
    wsStatus,
  } = useDroidAgentApp();
  const authQuery = useAuthQuery();
  const dashboardQuery = useDashboardQuery(
    Boolean(authQuery.data?.user),
    selectChatDashboard,
  );
  const performanceQuery = usePerformanceSubscription();
  const dashboard = dashboardQuery.data;
  const clientPerformanceSnapshot = useClientPerformanceSnapshot();
  const [chatInput, setChatInput] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<
    ChatAttachment[]
  >([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImageState | null>(
    null,
  );

  const dashboardSessions = dashboard?.sessions ?? [];
  const archivedSessionsQuery = useQuery({
    queryKey: ["sessions", "archived"],
    queryFn: () => api<SessionSummary[]>("/api/sessions/archived"),
    enabled: Boolean(authQuery.data?.user),
    staleTime: 15_000,
  });
  const approvals = dashboard?.approvals ?? [];
  const providers = dashboard?.providers ?? [];
  const runtimes = dashboard?.runtimes ?? [];
  const sessions = dashboardSessions;
  const archivedSessions = archivedSessionsQuery.data ?? [];
  const activeSession =
    sessions.find((session) => session.id === selectedSessionId) ??
    sessions[0] ??
    null;
  const selectedSessionKey = activeSession?.id ?? selectedSessionId;
  const sessionState = useChatSessionState({
    selectedSessionKey,
    enabled: Boolean(authQuery.data?.user),
  });
  const activeRun = sessionState.activeRun;
  const liveChatFeedback = sessionState.liveChatFeedback;
  const recentChatFeedback = sessionState.recentChatFeedback;
  const streaming = sessionState.streaming;
  const activeProvider = providers.find((provider) => provider.enabled);
  const openclawRuntime = runtimes.find((runtime) => runtime.id === "openclaw");
  const harness = dashboard?.harness;
  const maintenance = dashboard?.maintenance;
  const hostPressure = dashboard?.hostPressure;
  const decisions = dashboard?.decisions ?? [];
  const availableTools = harness?.availableTools ?? [];
  const memory = dashboard?.memory;
  const transportReady =
    wsStatus === "connected" && Boolean(selectedSessionKey);
  const maintenanceActive = Boolean(maintenance?.blocksNewWork);
  const hostPressureLevel = hostPressure?.level ?? "unknown";
  const pressureBlocks = Boolean(hostPressure?.blocksAgentRuns);
  const harnessReady =
    openclawRuntime?.state === "running" &&
    Boolean(activeProvider?.enabled) &&
    Boolean(harness?.configured) &&
    !maintenanceActive;
  const agentReady = harnessReady && !pressureBlocks;
  const pendingDecisionCount = getPendingDecisions(decisions).length;
  const sessionDecisions = getSessionDecisions(decisions, selectedSessionKey);
  const pendingDraftCount = sessionDecisions.filter(
    (decision) => decision.kind === "memoryDraftReview",
  ).length;
  const sessionOptions = useMemo(() => [...sessions], [sessions]);
  const showSessionSwitcher = sessionOptions.length > 1;
  const showTranscriptAlerts = maintenanceActive;
  const approvalsById = useMemo(
    () => new Map(approvals.map((approval) => [approval.id, approval])),
    [approvals],
  );
  const visiblePressureContributors = useMemo(
    () =>
      (hostPressure?.contributors ?? []).filter(
        (contributor) => contributor.severity !== "ok",
      ),
    [hostPressure?.contributors],
  );
  const activeRunApproval =
    activeRun?.stage === "approval_required"
      ? ((activeRun.approvalId
          ? (approvalsById.get(activeRun.approvalId) ?? null)
          : null) ?? (approvals.length === 1 ? approvals[0]! : null))
      : null;
  const { resolveDecision, resolveApproval } = useDecisionActions(decisions);

  const historyQuery = sessionState.historyQuery;
  const messages = sessionState.messages;
  const terminalChatFeedback =
    recentChatFeedback ??
    (isTerminalChatFeedback(liveChatFeedback) ? liveChatFeedback : null);
  const feedbackForMetrics = liveChatFeedback ?? terminalChatFeedback;
  const liveMetricMap = useMemo(
    () =>
      new Map(
        clientPerformanceSnapshot.metrics.map((metric) => [
          metric.name,
          metric,
        ]),
      ),
    [clientPerformanceSnapshot.metrics],
  );
  const selectedRunFeedback = useMemo(
    () => describeChatFeedback(feedbackForMetrics),
    [feedbackForMetrics],
  );
  const currentRunBreakdown = useMemo(
    () =>
      buildRunBreakdown({
        sessionId: selectedSessionKey,
        activeRun: activeRun ?? null,
        chatFeedback: feedbackForMetrics,
        clientSnapshot: clientPerformanceSnapshot,
        serverSnapshot: performanceQuery.data,
      }),
    [
      activeRun,
      feedbackForMetrics,
      clientPerformanceSnapshot,
      performanceQuery.data,
      selectedSessionKey,
    ],
  );
  const showStreamingCard = Boolean(
    streaming && !isTerminalChatFeedback(liveChatFeedback),
  );
  const showPendingAssistantCard = Boolean(
    !showStreamingCard &&
    (activeRun?.active || liveChatFeedback?.status === "waiting_first_token"),
  );
  const showRecentRunSummaryCard = Boolean(
    terminalChatFeedback &&
    !activeRun?.active &&
    currentRunBreakdown.items.length > 0,
  );

  const liveMetrics = useMemo(() => {
    const metrics: Array<{ label: string; value: string }> = [];

    if (activeRun?.active || showStreamingCard || feedbackForMetrics) {
      metrics.push({
        label: "First token",
        value: selectedRunFeedback.firstToken,
      });
      metrics.push({
        label: "Reply",
        value: selectedRunFeedback.reply,
      });
      const modelWait = currentRunBreakdown.items.find(
        (item) => item.label === "Model/tool wait",
      );
      if (modelWait && modelWait.value !== "Waiting...") {
        metrics.push({
          label: "Model/tool",
          value: modelWait.value,
        });
      }
      const toolWait = currentRunBreakdown.items.find(
        (item) => item.label === "Tool wait",
      );
      if (toolWait) {
        metrics.push({
          label: "Tool wait",
          value: toolWait.value,
        });
      }
    }

    const reconnectValue = formatLatency(
      liveMetricMap.get("client.ws.reconnect_to_resync")?.summary,
    );
    if (reconnectValue !== "Awaiting run") {
      metrics.push({
        label: "Reconnect",
        value: reconnectValue,
      });
    }

    return metrics;
  }, [
    activeRun?.active,
    feedbackForMetrics,
    currentRunBreakdown.items,
    liveMetricMap,
    selectedRunFeedback.firstToken,
    selectedRunFeedback.reply,
    showStreamingCard,
  ]);
  const visibleLiveMetrics = useMemo(
    () => liveMetrics.filter((metric) => metric.value !== "Awaiting run"),
    [liveMetrics],
  );
  const showHeaderHostPressureMetric =
    hostPressureLevel !== "unknown" && hostPressureLevel !== "ok";
  const composerStateLabel = activeRun?.active
    ? "Live run"
    : showStreamingCard
      ? "Streaming reply"
      : liveChatFeedback?.status === "waiting_first_token"
        ? "Waiting on first token"
        : liveChatFeedback?.status === "error"
          ? "Run failed"
          : maintenanceActive
            ? "Maintenance active"
            : pressureBlocks
              ? "Type preserved • sending paused"
              : harnessReady
                ? "Ready to send"
                : "Agent unavailable";
  const composerStatusMessage = activeRun?.active
    ? `${activeRun.label}${activeRun.detail ? ` • ${activeRun.detail}` : ""}`
    : showStreamingCard
      ? "DroidAgent is streaming the live reply back into this chat."
      : liveChatFeedback?.status === "waiting_first_token"
        ? "The request was accepted. The Mac is working through the model/tool path before first token."
        : liveChatFeedback?.status === "error"
          ? (liveChatFeedback.errorMessage ??
            "The last run failed before DroidAgent could finish the reply.")
          : terminalChatFeedback
            ? `Last run ${terminalChatFeedback.status === "error" ? "failed" : "finished"} • first token ${selectedRunFeedback.firstToken} • reply ${selectedRunFeedback.reply}.`
            : maintenanceActive
              ? (maintenance?.current?.message ??
                "Maintenance is active. New work is temporarily blocked.")
              : pressureBlocks
                ? `${
                    hostPressure?.message ??
                    "Host pressure is critical. New chat runs are temporarily paused."
                  } Use Cleanup cycle, stop jobs, or start a fresh chat while you wait.`
                : harnessReady
                  ? `${availableTools.length} tools ready. Paste or attach files below.`
                  : "The live OpenClaw path is not ready yet.";
  const normalizedActiveModel =
    harness?.activeModel?.replace(/^ollama\//, "") ??
    activeProvider?.model ??
    null;
  const normalizedImageModel =
    harness?.imageModel?.replace(/^ollama\//, "") ?? null;

  const headerFacts = [
    ...new Set(
      [
        activeProvider?.model ?? "No active model",
        activeProvider?.contextWindow
          ? formatTokenBudget(activeProvider.contextWindow)
          : "context pending",
        pendingDraftCount > 0
          ? `${pendingDraftCount} draft${pendingDraftCount === 1 ? "" : "s"} pending`
          : "drafts clear",
        hostPressureLevel === "critical"
          ? "pressure critical"
          : hostPressureLevel === "warn"
            ? "pressure elevated"
            : null,
        harness?.attachmentsEnabled
          ? normalizedImageModel && normalizedActiveModel
            ? normalizedImageModel === normalizedActiveModel
              ? "multimodal ready"
              : `vision ${normalizedImageModel}`
            : "attachments ready"
          : "attachments unavailable",
      ].filter(Boolean),
    ),
  ] as string[];
  const sessionSecondaryStatus = sessionState.switching
    ? "Opening chat"
    : sessionState.historyStatus === "loading"
      ? "Loading history"
      : sessionState.historyStatus === "resyncing" || historyQuery.isFetching
        ? "Syncing history"
        : sessionState.historyStatus === "error"
          ? "History failed"
          : "History synced";
  const showRailRunCard = Boolean(activeRun?.active);

  async function uploadFiles(files: File[]) {
    if (files.length === 0) {
      return;
    }

    const formData = new FormData();
    for (const file of files) {
      formData.append("files", file);
    }

    setUploadingAttachments(true);
    try {
      const response = await postFormData<{ attachments: ChatAttachment[] }>(
        "/api/chat/uploads",
        formData,
      );
      setPendingAttachments((current) => {
        const next = [...current];
        for (const attachment of response.attachments) {
          if (!next.some((entry) => entry.id === attachment.id)) {
            next.push(attachment);
          }
        }
        return next;
      });
    } finally {
      setUploadingAttachments(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  const handleResolveApproval = useCallback(
    async (approvalId: string, resolution: "approved" | "denied") => {
      await resolveApproval(approvalId, resolution);
    },
    [resolveApproval],
  );

  async function handleAbortRun() {
    if (!selectedSessionKey) {
      return;
    }

    if (
      transportReady &&
      sendRealtimeCommand({
        type: "chat.abort",
        payload: {
          sessionId: selectedSessionKey,
        },
      })
    ) {
      return;
    }

    await postJson(
      `/api/sessions/${encodeURIComponent(selectedSessionKey)}/abort`,
      {},
    );
  }

  async function handleCreateMemoryDraft(
    target: "memory" | "preferences" | "todayNote",
    message: ChatMessage,
  ) {
    await postJson("/api/memory/drafts", {
      target,
      title:
        message.role === "assistant"
          ? "Assistant Capture"
          : message.role === "user"
            ? "Operator Capture"
            : "Message Capture",
      content: message.text.trim(),
      sourceKind: "chatMessage",
      sourceLabel: `${roleLabel(message.role)} • ${activeSession?.title ?? "Operator Chat"}`,
      sourceRef: message.id,
      sessionId: selectedSessionKey,
    });
  }

  const handleRunSuggestedCommand = useCallback(
    async (command: string) => {
      if (pressureBlocks) {
        throw new Error(
          hostPressure?.message ??
            "Host pressure is critical. New agent runs are paused until the Mac settles.",
        );
      }
      if (!selectedSessionKey) {
        throw new Error("Pick a chat session before running a command.");
      }
      await sendChatMessage({
        text: buildRunInChatPrompt(command),
        attachments: [],
        clearComposer: false,
      });
    },
    [hostPressure?.message, pressureBlocks, selectedSessionKey],
  );

  const handleOpenInTerminal = useCallback(
    (command: string) => {
      window.sessionStorage.setItem(TERMINAL_PREFILL_STORAGE_KEY, command);
      void navigate({ to: "/terminal" });
    },
    [navigate],
  );

  async function handleSelectSession(sessionId: string) {
    if (!sessionId || sessionId === selectedSessionKey) {
      return;
    }
    const nextSession = chatSessionStore.getSessionSnapshot(sessionId);
    if (nextSession.historyStatus !== "ready") {
      chatSessionStore.markSessionSwitching(sessionId, true);
      const switchMetric = clientPerformance.start(
        "client.chat.session_switch",
        {
          sessionId,
        },
      );
      try {
        await prefetchSessionMessages(queryClient, sessionId);
        switchMetric.finish({
          sessionId,
          outcome: "ok",
        });
      } catch (error) {
        chatSessionStore.markSessionSwitching(sessionId, false);
        switchMetric.finish({
          sessionId,
          outcome: "error",
        });
        throw error;
      }
    }
    setSelectedSessionId(sessionId);
    chatSessionStore.markSessionSwitching(sessionId, false);
  }

  async function handleRecoverHostPressure(params?: {
    abortSessionRun?: boolean;
    cancelActiveJobs?: boolean;
    closeTerminalSession?: boolean;
  }) {
    const response = await postJson<HostPressureRecoveryResult>(
      "/api/diagnostics/host-pressure/recover",
      {
        sessionId: selectedSessionKey,
        abortSessionRun: params?.abortSessionRun ?? true,
        cancelActiveJobs: params?.cancelActiveJobs ?? true,
        closeTerminalSession: params?.closeTerminalSession ?? true,
      },
    );
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      queryClient.invalidateQueries({ queryKey: ["jobs"] }),
      queryClient.invalidateQueries({ queryKey: ["terminal"] }),
      selectedSessionKey
        ? queryClient.invalidateQueries({
            queryKey: ["sessions", selectedSessionKey, "messages"],
          })
        : Promise.resolve(),
    ]);
    return response;
  }

  async function handleStartFreshSession() {
    await startFreshSession({
      queryClient,
      wsStatus,
      setSelectedSessionId,
      setChatInput,
      setPendingAttachments,
    });
  }

  async function handleCloseCurrentSession() {
    if (!selectedSessionKey) {
      return;
    }
    await closeCurrentSession({
      queryClient,
      wsStatus,
      selectedSessionId: selectedSessionKey,
      sessionOptions,
      setSelectedSessionId,
      setChatInput,
      setPendingAttachments,
    });
  }

  async function handleRestoreSession(sessionId: string) {
    await restoreSession({
      queryClient,
      wsStatus,
      sessionId,
      setSelectedSessionId,
      setChatInput,
      setPendingAttachments,
    });
  }

  async function sendChatMessage(params: {
    text: string;
    attachments: ChatAttachment[];
    clearComposer: boolean;
  }) {
    const nextText = params.text.trim();
    const nextAttachments = params.attachments;
    if ((!nextText && nextAttachments.length === 0) || !selectedSessionKey) {
      return;
    }

    const previousMessages = messages;
    const previousInput = chatInput;
    const previousAttachments = pendingAttachments;
    const optimisticMessage = buildOptimisticChatMessage({
      sessionId: selectedSessionKey,
      text: nextText,
      attachments: nextAttachments,
    });

    const optimisticMessages = [...messages, optimisticMessage];
    setCachedSessionMessages(
      queryClient,
      selectedSessionKey,
      optimisticMessages,
    );
    chatSessionStore.appendOptimisticMessage(
      selectedSessionKey,
      optimisticMessage,
    );

    trackChatSubmit(selectedSessionKey);
    if (params.clearComposer) {
      setChatInput("");
      setPendingAttachments([]);
    }

    try {
      const sentLive =
        transportReady &&
        sendRealtimeCommand({
          type: "chat.send",
          payload: {
            sessionId: selectedSessionKey,
            text: nextText,
            attachments: nextAttachments,
          },
        });
      if (!sentLive) {
        await postJson(
          `/api/sessions/${encodeURIComponent(selectedSessionKey)}/messages`,
          {
            text: nextText,
            attachments: nextAttachments,
          },
        );
        if (wsStatus !== "connected") {
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
            queryClient.invalidateQueries({
              queryKey: ["sessions", selectedSessionKey, "messages"],
            }),
          ]);
        }
      }
    } catch (error) {
      trackChatFailure(
        selectedSessionKey,
        error instanceof Error
          ? error.message
          : "Failed to send the message to DroidAgent.",
      );
      setCachedSessionMessages(
        queryClient,
        selectedSessionKey,
        previousMessages,
      );
      chatSessionStore.primeMessages(selectedSessionKey, previousMessages);
      if (params.clearComposer) {
        setChatInput(previousInput);
        setPendingAttachments(previousAttachments);
      }
      throw error;
    }
  }

  async function handleSendChat() {
    await sendChatMessage({
      text: chatInput,
      attachments: pendingAttachments,
      clearComposer: true,
    });
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void runAction(async () => {
      await handleSendChat();
    });
  }

  function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files ?? []);
    if (files.length === 0) {
      return;
    }

    event.preventDefault();
    void runAction(async () => {
      await uploadFiles(files);
    });
  }

  const handleRunCommandFromMessage = useCallback(
    (command: string) => {
      void runAction(async () => {
        await handleRunSuggestedCommand(command);
      }, "Command sent back into this chat. DroidAgent will execute it inside the live harness.");
    },
    [handleRunSuggestedCommand, runAction],
  );

  const handleResolveApprovalAction = useCallback(
    (approvalId: string, resolution: "approved" | "denied") => {
      void runAction(async () => {
        await handleResolveApproval(approvalId, resolution);
      });
    },
    [handleResolveApproval, runAction],
  );

  const handleOpenImage = useCallback(
    (image: ExpandedImageState) => setExpandedImage(image),
    [],
  );
  const handleResolveDecision = useCallback<
    ChatScreenShellProps["resolveDecision"]
  >(
    async (decision, resolution, expectedUpdatedAt) => {
      await resolveDecision(decision, resolution, expectedUpdatedAt);
    },
    [resolveDecision],
  );

  const sendDisabled =
    !harnessReady ||
    pressureBlocks ||
    uploadingAttachments ||
    (!chatInput.trim() && pendingAttachments.length === 0);

  return {
    threadRef,
    activeSession,
    headerFacts,
    agentReady,
    maintenanceActive,
    pressureBlocks,
    harnessReady,
    transportReady,
    memoryIndexed: Boolean(memory?.semanticReady),
    pendingDecisionCount,
    availableToolsCount: availableTools.length,
    visibleLiveMetrics,
    showHeaderHostPressureMetric,
    hostPressureLevel,
    messages,
    showStreamingCard,
    showTranscriptAlerts,
    maintenanceMessage: maintenance?.current?.message,
    maintenancePhase: maintenance?.current?.phase ?? null,
    historyLoading:
      sessionState.historyStatus === "loading" && messages.length === 0,
    historyError: sessionState.historyStatus === "error",
    historyFetching:
      sessionState.historyStatus === "loading" ||
      sessionState.historyStatus === "resyncing" ||
      historyQuery.isFetching,
    activeRun: activeRun ?? null,
    liveChatFeedback,
    terminalChatFeedback,
    approvals,
    approvalsById,
    activeRunApproval,
    currentRunBreakdown,
    showPendingAssistantCard,
    sessionDecisions,
    runAction,
    resolveDecision: handleResolveDecision,
    navigate,
    onCreateMemoryDraft: handleCreateMemoryDraft,
    onRunCommandFromMessage: handleRunCommandFromMessage,
    onOpenInTerminal: handleOpenInTerminal,
    onOpenImage: handleOpenImage,
    onResolveApprovalAction: handleResolveApprovalAction,
    streamingText: streaming?.text ?? "",
    showRecentRunSummaryCard,
    showSessionSwitcher,
    sessionOptions,
    selectedSessionKey,
    sessionSecondaryStatus,
    onSelectSession: handleSelectSession,
    onStartFreshSession: handleStartFreshSession,
    onCloseCurrentSession: handleCloseCurrentSession,
    archivedSessions,
    onRestoreSession: handleRestoreSession,
    hostPressure,
    visiblePressureContributors,
    onAbortRun: handleAbortRun,
    onRecoverHostPressure: handleRecoverHostPressure,
    showRailRunCard,
    pendingAttachments,
    onRemovePendingAttachment: (attachmentId: string) =>
      setPendingAttachments((current) =>
        current.filter((entry) => entry.id !== attachmentId),
      ),
    chatInput,
    onChatInputChange: (event) => setChatInput(event.target.value),
    onComposerPaste: handleComposerPaste,
    uploadingAttachments,
    composerStatusMessage,
    fileInputRef,
    onAttachFilesChange: (event) => {
      const files = Array.from(event.target.files ?? []);
      void runAction(async () => {
        await uploadFiles(files);
      });
    },
    onAttachClick: () => fileInputRef.current?.click(),
    composerStateLabel,
    onSubmit: handleSubmit,
    onStopActiveRun: () => {
      void runAction(async () => {
        await handleAbortRun();
      });
    },
    sendDisabled,
    sendTitle: pressureBlocks
      ? (hostPressure?.message ??
        "Host pressure is critical. Sending is paused until cleanup completes.")
      : undefined,
    expandedImage,
    onCloseExpandedImage: () => setExpandedImage(null),
  };
}
