import { WebSocketServer, type WebSocket } from "ws";

import {
  ClientCommandSchema,
  ServerEventSchema,
  type ServerEvent,
} from "@droidagent/shared";

import { accessService } from "./services/access-service.js";
import { appStateService } from "./services/app-state-service.js";
import { authService } from "./services/auth-service.js";
import {
  dashboardService,
  type DashboardSliceKey,
} from "./services/dashboard-service.js";
import {
  decisionService,
  type DecisionActor,
} from "./services/decision-service.js";
import { harnessService } from "./services/harness-service.js";
import { jobService } from "./services/job-service.js";
import { keychainService } from "./services/keychain-service.js";
import { launchAgentService } from "./services/launch-agent-service.js";
import { maintenanceService } from "./services/maintenance-service.js";
import { memoryDraftService } from "./services/memory-draft-service.js";
import { memoryPrepareService } from "./services/memory-prepare-service.js";
import { openclawService } from "./services/openclaw-service.js";
import { performanceService } from "./services/performance-service.js";
import { runtimeService } from "./services/runtime-service.js";
import { sessionLifecycleService } from "./services/session-lifecycle-service.js";
import { hostPressureService } from "./services/host-pressure-service.js";
import { startupService } from "./services/startup-service.js";
import { terminalService } from "./services/terminal-service.js";
import { chatRunCoordinator } from "./services/chat-run-coordinator.js";
import { publishDecisionEffects } from "./lib/decision-updates.js";
import {
  RealtimeMutationQueue,
  type RealtimeMutationLoad,
} from "./lib/realtime-mutation-queue.js";

type MutationBuild = (
  load: RealtimeMutationLoad,
) => Promise<ServerEvent | ServerEvent[]>;

function send(ws: WebSocket, payload: unknown): void {
  ws.send(JSON.stringify(payload));
}

function parseSessionToken(rawCookie: string | undefined): string | undefined {
  return rawCookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("droidagent_session="))
    ?.split("=")[1];
}

export class WebsocketHub {
  private sockets = new Set<WebSocket>();
  private socketActors = new WeakMap<WebSocket, DecisionActor>();
  private hostPressureInterval: ReturnType<typeof setInterval> | null = null;
  private pendingChatDeltas = new Map<string, { sessionId: string; runId: string; delta: string }>();
  private pendingJobOutputs = new Map<string, { jobId: string; stream: "stdout" | "stderr"; chunk: string }>();
  private pendingTerminalOutputs = new Map<string, { sessionId: string; data: string }>();
  private pendingFlushHandle: ReturnType<typeof setImmediate> | null = null;
  private pendingRealtimeBytes = 0;
  private readonly maxPendingRealtimeBytes = 256 * 1024;
  private readonly mutationQueue = new RealtimeMutationQueue<
    ServerEvent,
    DashboardSliceKey
  >({
    invalidate: (slices, options) => {
      this.invalidateDashboard(slices, options);
    },
    emit: async (event) => {
      this.broadcastEvent(event);
    },
  });

  private invalidateDashboard(
    slices: DashboardSliceKey[] = [],
    options: { startup?: boolean } = {},
  ): void {
    dashboardService.invalidate(...slices);
    if (options.startup) {
      startupService.invalidate();
    }
  }

  private broadcastEvent(event: ServerEvent): void {
    this.broadcast(ServerEventSchema.parse(event));
  }

  private queueMutation(options: {
    slices?: DashboardSliceKey[];
    startup?: boolean;
    build: MutationBuild;
  }): Promise<void> {
    return this.mutationQueue.enqueue({
      ...(options.slices ? { slices: options.slices } : {}),
      ...(options.startup === undefined ? {} : { startup: options.startup }),
      build: options.build,
    });
  }

  async publishUpdates(
    ...kinds: Array<
      | "setup"
      | "access"
      | "runtime"
      | "providers"
      | "channel"
      | "launchAgent"
      | "context"
      | "memory"
      | "hostPressure"
      | "memoryDrafts"
      | "maintenance"
      | "sessions"
      | "approvals"
      | "decisions"
      | "dashboard"
    >
  ): Promise<void> {
    await Promise.all(kinds.map((kind) => this.publishUpdate(kind)));
  }

  private publishUpdate(
    kind:
      | "setup"
      | "access"
      | "runtime"
      | "providers"
      | "channel"
      | "launchAgent"
      | "context"
      | "memory"
      | "hostPressure"
      | "memoryDrafts"
      | "maintenance"
      | "sessions"
      | "approvals"
      | "decisions"
      | "dashboard",
  ): Promise<void> {
    if (kind === "dashboard") {
      return this.queueMutation({
        startup: true,
        build: async (load) => ({
          type: "dashboard.state",
          payload: await load("dashboard.state", () =>
            dashboardService.getDashboardState(),
          ),
        }),
      });
    }

    if (kind === "setup") {
      return this.queueMutation({
        slices: ["setup"],
        startup: true,
        build: async (load) => ({
          type: "setup.updated",
          payload: await load("setup.updated", () => appStateService.getSetupState()),
        }),
      });
    }

    if (kind === "access") {
      return this.queueMutation({
        slices: ["access"],
        startup: true,
        build: async (load) => ({
          type: "access.updated",
          payload: await load("access.updated", () =>
            accessService.getBootstrapState(),
          ),
        }),
      });
    }

    if (kind === "runtime") {
      return this.queueMutation({
        slices: ["runtimes", "harness"],
        startup: true,
        build: async (load) => [
          {
            type: "runtime.updated",
            payload: await load("runtime.updated", () =>
              runtimeService.getRuntimeStatuses(),
            ),
          },
          {
            type: "harness.updated",
            payload: await load("harness.updated", () =>
              harnessService.harnessStatus(),
            ),
          },
        ],
      });
    }

    if (kind === "providers") {
      return this.queueMutation({
        slices: ["providers", "harness"],
        startup: true,
        build: async (load) => [
          {
            type: "providers.updated",
            payload: {
              providers: await load("providers.updated.providers", () =>
                runtimeService.listProviderProfiles(),
              ),
              cloudProviders: await load("providers.updated.cloud", () =>
                keychainService.listProviderSummaries(),
              ),
            },
          },
          {
            type: "harness.updated",
            payload: await load("harness.updated", () =>
              harnessService.harnessStatus(),
            ),
          },
        ],
      });
    }

    if (kind === "channel") {
      return this.queueMutation({
        slices: ["channels", "harness", "decisions"],
        startup: true,
        build: async (load) => [
          {
            type: "channel.updated",
            payload: await load("channel.updated", () =>
              harnessService.listChannels(),
            ),
          },
          {
            type: "harness.updated",
            payload: await load("harness.updated", () =>
              harnessService.harnessStatus(),
            ),
          },
          {
            type: "decisions.updated",
            payload: await load("decisions.updated", () =>
              decisionService.listDecisions(),
            ),
          },
        ],
      });
    }

    if (kind === "launchAgent") {
      return this.queueMutation({
        slices: ["launchAgent"],
        startup: true,
        build: async (load) => ({
          type: "launchAgent.updated",
          payload: await load("launchAgent.updated", () =>
            launchAgentService.status(),
          ),
        }),
      });
    }

    if (kind === "context") {
      return this.queueMutation({
        slices: ["contextManagement", "harness"],
        startup: true,
        build: async (load) => [
          {
            type: "context.updated",
            payload: await load("context.updated", () =>
              openclawService.contextManagementStatus(),
            ),
          },
          {
            type: "harness.updated",
            payload: await load("harness.updated", () =>
              harnessService.harnessStatus(),
            ),
          },
        ],
      });
    }

    if (kind === "memory") {
      return this.queueMutation({
        slices: ["memory", "harness"],
        startup: true,
        build: async (load) => [
          {
            type: "memory.updated",
            payload: await load("memory.updated", () =>
              openclawService.memoryStatus(),
            ),
          },
          {
            type: "harness.updated",
            payload: await load("harness.updated", () =>
              harnessService.harnessStatus(),
            ),
          },
        ],
      });
    }

    if (kind === "hostPressure") {
      return this.queueMutation({
        slices: ["hostPressure"],
        build: async (load) => ({
          type: "hostPressure.updated",
          payload: await load("hostPressure.updated", () =>
            hostPressureService.getStatus(true),
          ),
        }),
      });
    }

    if (kind === "memoryDrafts") {
      return this.queueMutation({
        slices: ["memoryDrafts", "decisions"],
        build: async (load) => [
          {
            type: "memoryDrafts.updated",
            payload: await load("memoryDrafts.updated", () =>
              memoryDraftService.listDrafts(),
            ),
          },
          {
            type: "decisions.updated",
            payload: await load("decisions.updated", () =>
              decisionService.listDecisions(),
            ),
          },
        ],
      });
    }

    if (kind === "maintenance") {
      return this.queueMutation({
        slices: ["maintenance"],
        build: async (load) => ({
          type: "maintenance.updated",
          payload: await load("maintenance.updated", () =>
            maintenanceService.getStatus(),
          ),
        }),
      });
    }

    if (kind === "sessions") {
      return this.queueMutation({
        slices: ["sessions"],
        build: async (load) => ({
          type: "sessions.updated",
          payload: await load("sessions.updated", () =>
            sessionLifecycleService.listActiveSessions(),
          ),
        }),
      });
    }

    if (kind === "approvals") {
      return this.queueMutation({
        slices: ["approvals", "decisions"],
        build: async (load) => [
          {
            type: "approvals.updated",
            payload: await load("approvals.updated", () =>
              harnessService.listApprovals(),
            ),
          },
          {
            type: "decisions.updated",
            payload: await load("decisions.updated", () =>
              decisionService.listDecisions(),
            ),
          },
        ],
      });
    }

    return this.queueMutation({
      slices: ["decisions"],
      build: async (load) => ({
        type: "decisions.updated",
        payload: await load("decisions.updated", () =>
          decisionService.listDecisions(),
        ),
      }),
    });
  }

  private flushPendingRealtimeEvents(): void {
    const pendingChat = this.pendingChatDeltas.size;
    const pendingJobs = this.pendingJobOutputs.size;
    const pendingTerminal = this.pendingTerminalOutputs.size;
    const flushMetric = performanceService.start("server", "ws.patch.flush", {
      chatPatches: pendingChat,
      jobPatches: pendingJobs,
      terminalPatches: pendingTerminal,
    });
    this.pendingFlushHandle = null;
    if (pendingChat > 0) {
      for (const pending of this.pendingChatDeltas.values()) {
        this.broadcastEvent({
          type: "chat.stream.delta",
          payload: pending,
        });
      }
      this.pendingChatDeltas.clear();
    }
    if (pendingJobs > 0) {
      for (const pending of this.pendingJobOutputs.values()) {
        this.broadcastEvent({
          type: "job.output",
          payload: pending,
        });
      }
      this.pendingJobOutputs.clear();
    }
    if (pendingTerminal > 0) {
      for (const pending of this.pendingTerminalOutputs.values()) {
        this.broadcastEvent({
          type: "terminal.output",
          payload: pending,
        });
      }
      this.pendingTerminalOutputs.clear();
    }
    this.pendingRealtimeBytes = 0;
    flushMetric.finish({
      chatPatches: pendingChat,
      jobPatches: pendingJobs,
      terminalPatches: pendingTerminal,
      outcome: "ok",
    });
  }

  private schedulePendingFlush(): void {
    if (this.pendingFlushHandle !== null) {
      return;
    }
    this.pendingFlushHandle = setImmediate(() => {
      this.flushPendingRealtimeEvents();
    });
  }

  private flushPendingSession(sessionId: string): void {
    if (this.pendingChatDeltas.has(sessionId) || this.pendingTerminalOutputs.has(sessionId)) {
      this.flushPendingRealtimeEvents();
    }
  }

  attach(wss: WebSocketServer): void {
    if (!this.hostPressureInterval) {
      this.hostPressureInterval = setInterval(() => {
        if (this.sockets.size === 0) {
          return;
        }
        void this.publishHostPressureUpdated(true);
      }, 15_000);
      this.hostPressureInterval.unref?.();
    }

    wss.on("connection", (ws, request) => {
      this.sockets.add(ws);
      void this.pushDashboard(ws);
      void (async () => {
        const token = parseSessionToken(request.headers.cookie);
        if (!token) {
          return;
        }
        const [user, authSession] = await Promise.all([
          authService.getCurrentUserBySessionToken(token),
          authService.getCurrentSessionByToken(token),
        ]);
        if (user) {
          this.socketActors.set(ws, { user, authSession });
        }
      })();

      ws.on("message", (raw) => {
        void this.handleMessage(ws, raw.toString());
      });
      ws.on("close", () => {
        this.sockets.delete(ws);
      });
    });

    jobService.on("output", (event) => {
      const key = `${event.jobId}:${event.stream}`;
      const existing = this.pendingJobOutputs.get(key);
      this.pendingRealtimeBytes += Buffer.byteLength(event.chunk, "utf8");
      this.pendingJobOutputs.set(key, {
        jobId: event.jobId,
        stream: event.stream,
        chunk: `${existing?.chunk ?? ""}${event.chunk}`,
      });
      if (this.pendingRealtimeBytes >= this.maxPendingRealtimeBytes) {
        this.flushPendingRealtimeEvents();
        return;
      }
      this.schedulePendingFlush();
    });

    jobService.on("updated", (job) => {
      this.invalidateDashboard(["jobs"]);
      this.broadcastEvent({
        type: "job.updated",
        payload: job,
      });
    });

    terminalService.on("updated", (session) => {
      this.broadcast(
        ServerEventSchema.parse({
          type: "terminal.updated",
          payload: session,
        }),
      );
    });

    terminalService.on("output", (event) => {
      const existing = this.pendingTerminalOutputs.get(event.sessionId);
      this.pendingRealtimeBytes += Buffer.byteLength(event.data, "utf8");
      this.pendingTerminalOutputs.set(event.sessionId, {
        sessionId: event.sessionId,
        data: `${existing?.data ?? ""}${event.data}`,
      });
      if (this.pendingRealtimeBytes >= this.maxPendingRealtimeBytes) {
        this.flushPendingRealtimeEvents();
        return;
      }
      this.schedulePendingFlush();
    });

    terminalService.on("closed", (event) => {
      this.flushPendingSession(event.sessionId);
      this.broadcastEvent({
        type: "terminal.closed",
        payload: event,
      });
    });

    memoryPrepareService.subscribe(() => {
      void this.publishMemoryUpdated();
    });
  }

  async refreshAll(): Promise<void> {
    await this.publishUpdates("dashboard");
  }

  async publishSetupUpdated(): Promise<void> {
    await this.publishUpdates("setup");
  }

  async publishAccessUpdated(): Promise<void> {
    await this.publishUpdates("access");
  }

  async publishRuntimeUpdated(): Promise<void> {
    await this.publishUpdates("runtime");
  }

  async publishProvidersUpdated(): Promise<void> {
    await this.publishUpdates("providers");
  }

  async publishChannelUpdated(): Promise<void> {
    await this.publishUpdates("channel");
  }

  async publishLaunchAgentUpdated(): Promise<void> {
    await this.publishUpdates("launchAgent");
  }

  async publishContextUpdated(): Promise<void> {
    await this.publishUpdates("context");
  }

  async publishMemoryUpdated(): Promise<void> {
    await this.publishUpdates("memory");
  }

  async publishHostPressureUpdated(force = false): Promise<void> {
    if (force) {
      hostPressureService.invalidate();
    }
    await this.publishUpdates("hostPressure");
  }

  async publishMemoryDraftsUpdated(): Promise<void> {
    await this.publishUpdates("memoryDrafts");
  }

  async publishMaintenanceUpdated(): Promise<void> {
    await this.publishUpdates("maintenance");
  }

  async publishPerformanceUpdated(): Promise<void> {
    this.broadcastEvent({
      type: "performance.updated",
      payload: performanceService.serverSnapshot(),
    });
  }

  async publishSessionsUpdated(): Promise<void> {
    await this.publishUpdates("sessions");
  }

  publishApprovalUpdated(approval: Awaited<ReturnType<typeof harnessService.listApprovals>>[number]): void {
    void this.queueMutation({
      slices: ["approvals", "decisions"],
      build: async (load) => {
        const decision = await load(
          `approval.decision.${approval.id}`,
          async () =>
            await decisionService.getDecision(
              decisionService.createDecisionIdFromApprovalId(approval.id),
            ),
        );
        return [
          {
            type: "approval.updated" as const,
            payload: approval,
          },
          ...(decision
            ? [
                {
                  type: "decision.updated" as const,
                  payload: decision,
                },
              ]
            : []),
        ];
      },
    });
  }

  async publishApprovalsUpdated(): Promise<void> {
    await this.publishUpdates("approvals");
  }

  async publishDecisionsUpdated(): Promise<void> {
    await this.publishUpdates("decisions");
  }

  publishChatDelta(sessionId: string, runId: string, delta: string): void {
    const existing = this.pendingChatDeltas.get(sessionId);
    this.pendingRealtimeBytes += Buffer.byteLength(delta, "utf8");
    this.pendingChatDeltas.set(sessionId, {
      sessionId,
      runId,
      delta:
        existing && existing.runId === runId
          ? `${existing.delta}${delta}`
          : delta,
    });
    if (this.pendingRealtimeBytes >= this.maxPendingRealtimeBytes) {
      this.flushPendingRealtimeEvents();
      return;
    }
    this.schedulePendingFlush();
  }

  publishChatDone(sessionId: string, runId: string): void {
    this.flushPendingSession(sessionId);
    this.broadcast(
      ServerEventSchema.parse({
        type: "chat.stream.done",
        payload: {
          sessionId,
          runId
        }
      })
    );
  }

  publishChatError(sessionId: string, runId: string, message: string): void {
    this.flushPendingSession(sessionId);
    this.broadcast(
      ServerEventSchema.parse({
        type: "chat.stream.error",
        payload: {
          sessionId,
          runId,
          message
        }
      })
    );
  }

  publishChatRun(params: {
    sessionId: string;
    runId: string;
    stage: "accepted" | "streaming" | "tool_call" | "tool_result" | "approval_required" | "completed" | "failed";
    label: string;
    detail?: string | null;
    toolName?: string | null;
    approvalId?: string | null;
    active?: boolean;
  }): void {
    this.broadcast(
      ServerEventSchema.parse({
        type: "chat.run",
        payload: {
          sessionId: params.sessionId,
          runId: params.runId,
          stage: params.stage,
          label: params.label,
          detail: params.detail ?? null,
          toolName: params.toolName ?? null,
          approvalId: params.approvalId ?? null,
          active:
            params.active ??
            (params.stage !== "completed" && params.stage !== "failed"),
          updatedAt: new Date().toISOString(),
        },
      }),
    );
  }

  async pushChatHistory(sessionId: string): Promise<void> {
    const metric = performanceService.start("server", "chat.history.resync", {
      sessionId,
    });
    try {
      const messages = await harnessService.loadHistory(sessionId);
      await sessionLifecycleService.observeSessionFromMessages(sessionId, messages);
      this.broadcast(
        ServerEventSchema.parse({
          type: "chat.history",
          payload: {
            sessionId,
            messages
          }
        })
      );
      metric.finish({
        sessionId,
        messageCount: messages.length,
        outcome: "ok",
      });
    } catch (error) {
      metric.finish({
        sessionId,
        outcome: "error",
      });
      throw error;
    }
  }

  private async pushDashboard(ws: WebSocket): Promise<void> {
    const state = await dashboardService.getDashboardState();
    send(
      ws,
      ServerEventSchema.parse({
        type: "dashboard.state",
        payload: state
      })
    );
  }

  private broadcast(payload: unknown): void {
    const message = JSON.stringify(payload);
    for (const socket of this.sockets) {
      if (socket.readyState === socket.OPEN) {
        socket.send(message);
      }
    }
  }

  private async handleMessage(ws: WebSocket, raw: string): Promise<void> {
    try {
      const command = ClientCommandSchema.parse(JSON.parse(raw));
      if (command.type === "chat.history") {
        const messages = await harnessService.loadHistory(command.payload.sessionId);
        await sessionLifecycleService.observeSessionFromMessages(
          command.payload.sessionId,
          messages,
        );
        send(
          ws,
          ServerEventSchema.parse({
            type: "chat.history",
            payload: {
              sessionId: command.payload.sessionId,
              messages
            }
          })
        );
        return;
      }

      if (command.type === "chat.send") {
        await maintenanceService.assertAllowsNewWork("chat");
        await hostPressureService.assertAllowsAgentRuns("chat");
        const { sessionId, text, attachments } = command.payload;
        await chatRunCoordinator.send({
          publisher: this,
          transport: "ws",
          sessionId,
          request: {
            text,
            attachments,
          },
        });
        return;
      }

      if (command.type === "chat.abort") {
        await chatRunCoordinator.abort({
          publisher: this,
          sessionId: command.payload.sessionId,
        });
        return;
      }

      if (command.type === "approval.resolve") {
        const actor = this.socketActors.get(ws);
        if (!actor) {
          throw new Error("Decision resolution requires an authenticated session.");
        }
        const decision = await decisionService.resolveApprovalDecision(
          command.payload.approvalId,
          command.payload.resolution,
          actor,
        );
        await publishDecisionEffects(this, decision);
        return;
      }

      if (command.type === "decision.resolve") {
        const actor = this.socketActors.get(ws);
        if (!actor) {
          throw new Error("Decision resolution requires an authenticated session.");
        }
        const decision = await decisionService.resolveDecision(
          command.payload.decisionId,
          {
            resolution: command.payload.resolution,
            expectedUpdatedAt: command.payload.expectedUpdatedAt,
          },
          actor,
        );
        await publishDecisionEffects(this, decision);
        return;
      }

      if (command.type === "runtime.refresh") {
        await this.refreshAll();
        return;
      }

      if (command.type === "terminal.input") {
        terminalService.writeInput(
          command.payload.sessionId,
          command.payload.data,
        );
        return;
      }

      if (command.type === "terminal.resize") {
        terminalService.resize(
          command.payload.sessionId,
          command.payload.cols,
          command.payload.rows,
        );
        return;
      }

      if (command.type === "terminal.close") {
        await terminalService.closeSession(command.payload.sessionId);
        return;
      }
    } catch (error) {
      send(
        ws,
        ServerEventSchema.parse({
          type: "error",
          payload: {
            message: error instanceof Error ? error.message : "WebSocket command failed."
          }
        })
      );
    }
  }
}

export const websocketHub = new WebsocketHub();
