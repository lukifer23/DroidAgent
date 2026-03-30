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
import { createMeasuredStreamRelay } from "./lib/chat-relay-metrics.js";
import { publishDecisionEffects } from "./lib/decision-updates.js";

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

  private async publishEvents(options: {
    slices?: DashboardSliceKey[];
    startup?: boolean;
    events: ServerEvent[] | Promise<ServerEvent[]>;
  }): Promise<void> {
    this.invalidateDashboard(
      options.slices ?? [],
      options.startup === undefined ? {} : { startup: options.startup },
    );
    const events = await options.events;
    for (const event of events) {
      this.broadcastEvent(event);
    }
  }

  private flushPendingRealtimeEvents(): void {
    this.pendingFlushHandle = null;
    if (this.pendingChatDeltas.size > 0) {
      for (const pending of this.pendingChatDeltas.values()) {
        this.broadcastEvent({
          type: "chat.stream.delta",
          payload: pending,
        });
      }
      this.pendingChatDeltas.clear();
    }
    if (this.pendingJobOutputs.size > 0) {
      for (const pending of this.pendingJobOutputs.values()) {
        this.broadcastEvent({
          type: "job.output",
          payload: pending,
        });
      }
      this.pendingJobOutputs.clear();
    }
    if (this.pendingTerminalOutputs.size > 0) {
      for (const pending of this.pendingTerminalOutputs.values()) {
        this.broadcastEvent({
          type: "terminal.output",
          payload: pending,
        });
      }
      this.pendingTerminalOutputs.clear();
    }
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
      this.pendingJobOutputs.set(key, {
        jobId: event.jobId,
        stream: event.stream,
        chunk: `${existing?.chunk ?? ""}${event.chunk}`,
      });
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
      this.pendingTerminalOutputs.set(event.sessionId, {
        sessionId: event.sessionId,
        data: `${existing?.data ?? ""}${event.data}`,
      });
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
    await this.publishEvents({
      slices: [],
      startup: true,
      events: (async () => [
        {
          type: "dashboard.state",
          payload: await dashboardService.getDashboardState(),
        },
      ])(),
    });
  }

  async publishSetupUpdated(): Promise<void> {
    await this.publishEvents({
      slices: ["setup"],
      startup: true,
      events: [
        {
          type: "setup.updated",
          payload: await appStateService.getSetupState(),
        },
      ],
    });
  }

  async publishAccessUpdated(): Promise<void> {
    await this.publishEvents({
      slices: ["access"],
      startup: true,
      events: [
        {
          type: "access.updated",
          payload: await accessService.getBootstrapState(),
        },
      ],
    });
  }

  async publishRuntimeUpdated(): Promise<void> {
    await this.publishEvents({
      slices: ["runtimes", "harness"],
      startup: true,
      events: (async () => {
        const [runtimes, harness] = await Promise.all([
          runtimeService.getRuntimeStatuses(),
          harnessService.harnessStatus(),
        ]);
        return [
          {
            type: "runtime.updated",
            payload: runtimes,
          },
          {
            type: "harness.updated",
            payload: harness,
          },
        ];
      })(),
    });
  }

  async publishProvidersUpdated(): Promise<void> {
    await this.publishEvents({
      slices: ["providers", "harness"],
      startup: true,
      events: (async () => {
        const [providers, cloudProviders, harness] = await Promise.all([
          runtimeService.listProviderProfiles(),
          keychainService.listProviderSummaries(),
          harnessService.harnessStatus(),
        ]);
        return [
          {
            type: "providers.updated",
            payload: {
              providers,
              cloudProviders,
            },
          },
          {
            type: "harness.updated",
            payload: harness,
          },
        ];
      })(),
    });
  }

  async publishChannelUpdated(): Promise<void> {
    await this.publishEvents({
      slices: ["channels", "harness", "decisions"],
      startup: true,
      events: (async () => {
        const [channels, harness, decisions] = await Promise.all([
          harnessService.listChannels(),
          harnessService.harnessStatus(),
          decisionService.listDecisions(),
        ]);
        return [
          {
            type: "channel.updated",
            payload: channels,
          },
          {
            type: "harness.updated",
            payload: harness,
          },
          {
            type: "decisions.updated",
            payload: decisions,
          },
        ];
      })(),
    });
  }

  async publishLaunchAgentUpdated(): Promise<void> {
    await this.publishEvents({
      slices: ["launchAgent"],
      startup: true,
      events: [
        {
          type: "launchAgent.updated",
          payload: await launchAgentService.status(),
        },
      ],
    });
  }

  async publishContextUpdated(): Promise<void> {
    await this.publishEvents({
      slices: ["contextManagement", "harness"],
      startup: true,
      events: (async () => {
        const [context, harness] = await Promise.all([
          openclawService.contextManagementStatus(),
          harnessService.harnessStatus(),
        ]);
        return [
          {
            type: "context.updated",
            payload: context,
          },
          {
            type: "harness.updated",
            payload: harness,
          },
        ];
      })(),
    });
  }

  async publishMemoryUpdated(): Promise<void> {
    await this.publishEvents({
      slices: ["memory", "harness"],
      startup: true,
      events: (async () => {
        const [memory, harness] = await Promise.all([
          openclawService.memoryStatus(),
          harnessService.harnessStatus(),
        ]);
        return [
          {
            type: "memory.updated",
            payload: memory,
          },
          {
            type: "harness.updated",
            payload: harness,
          },
        ];
      })(),
    });
  }

  async publishHostPressureUpdated(force = false): Promise<void> {
    this.invalidateDashboard(["hostPressure"]);
    this.broadcastEvent({
      type: "hostPressure.updated",
      payload: await hostPressureService.getStatus(force),
    });
  }

  async publishMemoryDraftsUpdated(): Promise<void> {
    await this.publishEvents({
      slices: ["memoryDrafts", "decisions"],
      events: (async () => [
        {
          type: "memoryDrafts.updated",
          payload: await memoryDraftService.listDrafts(),
        },
        {
          type: "decisions.updated",
          payload: await decisionService.listDecisions(),
        },
      ])(),
    });
  }

  async publishMaintenanceUpdated(): Promise<void> {
    await this.publishEvents({
      slices: ["maintenance"],
      events: [
        {
          type: "maintenance.updated",
          payload: await maintenanceService.getStatus(),
        },
      ],
    });
  }

  async publishPerformanceUpdated(): Promise<void> {
    this.broadcastEvent({
      type: "performance.updated",
      payload: performanceService.serverSnapshot(),
    });
  }

  async publishSessionsUpdated(): Promise<void> {
    await this.publishEvents({
      slices: ["sessions"],
      events: [
        {
          type: "sessions.updated",
          payload: await sessionLifecycleService.listActiveSessions(),
        },
      ],
    });
  }

  publishApprovalUpdated(approval: Awaited<ReturnType<typeof harnessService.listApprovals>>[number]): void {
    void this.publishEvents({
      slices: ["approvals", "decisions"],
      events: (async () => {
        const decision =
          await decisionService.getDecision(
            decisionService.createDecisionIdFromApprovalId(approval.id),
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
      })(),
    });
  }

  async publishApprovalsUpdated(): Promise<void> {
    await this.publishEvents({
      slices: ["approvals", "decisions"],
      events: (async () => [
        {
          type: "approvals.updated",
          payload: await harnessService.listApprovals(),
        },
        {
          type: "decisions.updated",
          payload: await decisionService.listDecisions(),
        },
      ])(),
    });
  }

  async publishDecisionsUpdated(): Promise<void> {
    await this.publishEvents({
      slices: ["decisions"],
      events: [
        {
          type: "decisions.updated",
          payload: await decisionService.listDecisions(),
        },
      ],
    });
  }

  publishChatDelta(sessionId: string, runId: string, delta: string): void {
    const existing = this.pendingChatDeltas.get(sessionId);
    this.pendingChatDeltas.set(sessionId, {
      sessionId,
      runId,
      delta:
        existing && existing.runId === runId
          ? `${existing.delta}${delta}`
          : delta,
    });
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
        await sessionLifecycleService.observeSession(sessionId, {
          restore: true,
        });
        let finished = false;
        let runId = "";
        const measuredRelay = createMeasuredStreamRelay("ws", sessionId, {
          onState: async (state) => {
            this.publishChatRun({
              sessionId,
              runId,
              ...state,
            });
          },
          onFirstDelta: async () => {
            await this.publishPerformanceUpdated();
          },
          onDelta: async (delta) => {
            this.publishChatDelta(sessionId, runId, delta);
          },
          onDone: async () => {
            if (!finished) {
              finished = true;
            }
            this.publishChatDone(sessionId, runId);
            await this.pushChatHistory(sessionId);
            await this.publishSessionsUpdated();
            await this.publishPerformanceUpdated();
          },
          onError: async (message) => {
            if (!finished) {
              finished = true;
            }
            this.publishChatError(sessionId, runId, message);
            await this.pushChatHistory(sessionId);
            await this.publishSessionsUpdated();
            await this.publishPerformanceUpdated();
          },
        });

        const run = await harnessService.sendMessage(
          sessionId,
          {
            text,
            attachments,
          },
          measuredRelay.relay,
        );
        runId = run.runId;
        measuredRelay.markAccepted();
        this.publishChatRun({
          sessionId,
          runId,
          stage: "accepted",
          label: "Run accepted",
          detail: "OpenClaw accepted the request and is starting the live run.",
          active: true,
        });
        return;
      }

      if (command.type === "chat.abort") {
        await harnessService.abortMessage(command.payload.sessionId);
        await this.pushChatHistory(command.payload.sessionId);
        await this.publishSessionsUpdated();
        return;
      }

      if (command.type === "approval.resolve") {
        const actor = this.socketActors.get(ws);
        if (actor) {
          await decisionService.resolveApprovalDecision(
            command.payload.approvalId,
            command.payload.resolution,
            actor,
          );
        } else {
          await harnessService.resolveApproval(
            command.payload.approvalId,
            command.payload.resolution,
          );
        }
        await this.publishApprovalsUpdated();
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
