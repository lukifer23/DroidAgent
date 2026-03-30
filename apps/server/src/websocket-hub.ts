import { WebSocketServer, type WebSocket } from "ws";

import { ClientCommandSchema, ServerEventSchema } from "@droidagent/shared";

import { accessService } from "./services/access-service.js";
import { appStateService } from "./services/app-state-service.js";
import { dashboardService } from "./services/dashboard-service.js";
import { harnessService } from "./services/harness-service.js";
import { jobService } from "./services/job-service.js";
import { keychainService } from "./services/keychain-service.js";
import { launchAgentService } from "./services/launch-agent-service.js";
import { maintenanceService } from "./services/maintenance-service.js";
import { memoryDraftService } from "./services/memory-draft-service.js";
import { openclawService } from "./services/openclaw-service.js";
import { performanceService } from "./services/performance-service.js";
import { runtimeService } from "./services/runtime-service.js";
import { sessionLifecycleService } from "./services/session-lifecycle-service.js";
import { hostPressureService } from "./services/host-pressure-service.js";
import { startupService } from "./services/startup-service.js";
import { terminalService } from "./services/terminal-service.js";

function send(ws: WebSocket, payload: unknown): void {
  ws.send(JSON.stringify(payload));
}

export class WebsocketHub {
  private sockets = new Set<WebSocket>();
  private hostPressureInterval: ReturnType<typeof setInterval> | null = null;
  private pendingChatDeltas = new Map<string, { sessionId: string; runId: string; delta: string }>();
  private pendingTerminalOutputs = new Map<string, { sessionId: string; data: string }>();
  private pendingFlushHandle: ReturnType<typeof setImmediate> | null = null;

  private flushPendingRealtimeEvents(): void {
    this.pendingFlushHandle = null;
    if (this.pendingChatDeltas.size > 0) {
      for (const pending of this.pendingChatDeltas.values()) {
        this.broadcast(
          ServerEventSchema.parse({
            type: "chat.stream.delta",
            payload: pending,
          }),
        );
      }
      this.pendingChatDeltas.clear();
    }
    if (this.pendingTerminalOutputs.size > 0) {
      for (const pending of this.pendingTerminalOutputs.values()) {
        this.broadcast(
          ServerEventSchema.parse({
            type: "terminal.output",
            payload: pending,
          }),
        );
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

    wss.on("connection", (ws) => {
      this.sockets.add(ws);
      void this.pushDashboard(ws);

      ws.on("message", (raw) => {
        void this.handleMessage(ws, raw.toString());
      });
      ws.on("close", () => {
        this.sockets.delete(ws);
      });
    });

    jobService.on("output", (event) => {
      this.broadcast(
        ServerEventSchema.parse({
          type: "job.output",
          payload: event
        })
      );
    });

    jobService.on("updated", (job) => {
      dashboardService.invalidate();
      this.broadcast(
        ServerEventSchema.parse({
          type: "job.updated",
          payload: job
        })
      );
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
      this.broadcast(
        ServerEventSchema.parse({
          type: "terminal.closed",
          payload: event,
        }),
      );
    });
  }

  async refreshAll(): Promise<void> {
    dashboardService.invalidate();
    startupService.invalidate();
    const state = await dashboardService.getDashboardState();
    this.broadcast(
      ServerEventSchema.parse({
        type: "dashboard.state",
        payload: state
      })
    );
  }

  async publishSetupUpdated(): Promise<void> {
    dashboardService.invalidate();
    startupService.invalidate();
    this.broadcast(
      ServerEventSchema.parse({
        type: "setup.updated",
        payload: await appStateService.getSetupState()
      })
    );
  }

  async publishAccessUpdated(): Promise<void> {
    dashboardService.invalidate();
    startupService.invalidate();
    this.broadcast(
      ServerEventSchema.parse({
        type: "access.updated",
        payload: await accessService.getBootstrapState()
      })
    );
  }

  async publishRuntimeUpdated(): Promise<void> {
    dashboardService.invalidate();
    startupService.invalidate();
    const [runtimes, harness] = await Promise.all([
      runtimeService.getRuntimeStatuses(),
      harnessService.harnessStatus(),
    ]);
    this.broadcast(
      ServerEventSchema.parse({
        type: "runtime.updated",
        payload: runtimes
      })
    );
    this.broadcast(
      ServerEventSchema.parse({
        type: "harness.updated",
        payload: harness,
      })
    );
  }

  async publishProvidersUpdated(): Promise<void> {
    dashboardService.invalidate();
    startupService.invalidate();
    const [providers, cloudProviders, harness] = await Promise.all([
      runtimeService.listProviderProfiles(),
      keychainService.listProviderSummaries(),
      harnessService.harnessStatus(),
    ]);
    this.broadcast(
      ServerEventSchema.parse({
        type: "providers.updated",
        payload: {
          providers,
          cloudProviders
        }
      })
    );
    this.broadcast(
      ServerEventSchema.parse({
        type: "harness.updated",
        payload: harness,
      })
    );
  }

  async publishChannelUpdated(): Promise<void> {
    dashboardService.invalidate();
    startupService.invalidate();
    const [channels, harness] = await Promise.all([
      harnessService.listChannels(),
      harnessService.harnessStatus(),
    ]);
    this.broadcast(
      ServerEventSchema.parse({
        type: "channel.updated",
        payload: channels
      })
    );
    this.broadcast(
      ServerEventSchema.parse({
        type: "harness.updated",
        payload: harness,
      })
    );
  }

  async publishLaunchAgentUpdated(): Promise<void> {
    dashboardService.invalidate();
    startupService.invalidate();
    this.broadcast(
      ServerEventSchema.parse({
        type: "launchAgent.updated",
        payload: await launchAgentService.status()
      })
    );
  }

  async publishContextUpdated(): Promise<void> {
    dashboardService.invalidate();
    startupService.invalidate();
    const [context, harness] = await Promise.all([
      openclawService.contextManagementStatus(),
      harnessService.harnessStatus(),
    ]);
    this.broadcast(
      ServerEventSchema.parse({
        type: "context.updated",
        payload: context
      })
    );
    this.broadcast(
      ServerEventSchema.parse({
        type: "harness.updated",
        payload: harness,
      })
    );
  }

  async publishMemoryUpdated(): Promise<void> {
    dashboardService.invalidate();
    startupService.invalidate();
    const [memory, harness] = await Promise.all([
      openclawService.memoryStatus(),
      harnessService.harnessStatus(),
    ]);
    this.broadcast(
      ServerEventSchema.parse({
        type: "memory.updated",
        payload: memory
      })
    );
    this.broadcast(
      ServerEventSchema.parse({
        type: "harness.updated",
        payload: harness,
      })
    );
  }

  async publishHostPressureUpdated(force = false): Promise<void> {
    dashboardService.invalidate();
    this.broadcast(
      ServerEventSchema.parse({
        type: "hostPressure.updated",
        payload: await hostPressureService.getStatus(force),
      }),
    );
  }

  async publishMemoryDraftsUpdated(): Promise<void> {
    dashboardService.invalidate();
    this.broadcast(
      ServerEventSchema.parse({
        type: "memoryDrafts.updated",
        payload: await memoryDraftService.listDrafts(),
      }),
    );
  }

  async publishMaintenanceUpdated(): Promise<void> {
    dashboardService.invalidate();
    this.broadcast(
      ServerEventSchema.parse({
        type: "maintenance.updated",
        payload: await maintenanceService.getStatus(),
      }),
    );
  }

  async publishPerformanceUpdated(): Promise<void> {
    this.broadcast(
      ServerEventSchema.parse({
        type: "performance.updated",
        payload: performanceService.serverSnapshot()
      })
    );
  }

  async publishSessionsUpdated(): Promise<void> {
    dashboardService.invalidate();
    this.broadcast(
      ServerEventSchema.parse({
        type: "sessions.updated",
        payload: await sessionLifecycleService.listActiveSessions()
      })
    );
  }

  publishApprovalUpdated(approval: Awaited<ReturnType<typeof harnessService.listApprovals>>[number]): void {
    dashboardService.invalidate();
    this.broadcast(
      ServerEventSchema.parse({
        type: "approval.updated",
        payload: approval
      })
    );
  }

  async publishApprovalsUpdated(): Promise<void> {
    dashboardService.invalidate();
    this.broadcast(
      ServerEventSchema.parse({
        type: "approvals.updated",
        payload: await harnessService.listApprovals()
      })
    );
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
        const submitToAcceptedMetric = performanceService.start("server", "chat.send.submitToAccepted", {
          transport: "ws",
          sessionId
        });
        let acceptedToFirstDeltaMetric: ReturnType<typeof performanceService.start> | null = null;
        let acceptedToCompleteMetric: ReturnType<typeof performanceService.start> | null = null;
        let firstDeltaRecorded = false;
        let finished = false;
        let runId = "";

        const run = await harnessService.sendMessage(sessionId, {
          text,
          attachments,
        }, {
          onState: async (state) => {
            this.publishChatRun({
              sessionId,
              runId,
              ...state,
            });
          },
          onDelta: async (delta) => {
            const isFirstDelta = !firstDeltaRecorded;
            if (!firstDeltaRecorded) {
              firstDeltaRecorded = true;
              acceptedToFirstDeltaMetric?.finish({
                outcome: "ok"
              });
            }
            const forwardMetric = isFirstDelta
              ? performanceService.start("server", "chat.stream.firstDeltaForward", {
                  transport: "ws",
                  sessionId
                })
              : null;
            this.publishChatDelta(sessionId, runId, delta);
            forwardMetric?.finish({
              outcome: "ok",
              chars: delta.length
            });
            if (isFirstDelta) {
              void this.publishPerformanceUpdated();
            }
          },
          onDone: async () => {
            if (!firstDeltaRecorded) {
              firstDeltaRecorded = true;
              acceptedToFirstDeltaMetric?.finish({
                outcome: "no-delta"
              });
            }
            if (!finished) {
              finished = true;
              acceptedToCompleteMetric?.finish({
                outcome: "done"
              });
            }
            this.publishChatDone(sessionId, runId);
            await this.pushChatHistory(sessionId);
            await this.publishSessionsUpdated();
            await this.publishPerformanceUpdated();
          },
          onError: async (message) => {
            if (!firstDeltaRecorded) {
              firstDeltaRecorded = true;
              acceptedToFirstDeltaMetric?.finish({
                outcome: "error"
              });
            }
            if (!finished) {
              finished = true;
              acceptedToCompleteMetric?.finish({
                outcome: "error"
              });
            }
            this.publishChatError(sessionId, runId, message);
            await this.pushChatHistory(sessionId);
            await this.publishSessionsUpdated();
            await this.publishPerformanceUpdated();
          }
        });
        runId = run.runId;
        submitToAcceptedMetric.finish({
          outcome: "ok"
        });
        acceptedToFirstDeltaMetric = performanceService.start("server", "chat.stream.acceptedToFirstDelta", {
          transport: "ws",
          sessionId
        });
        acceptedToCompleteMetric = performanceService.start("server", "chat.stream.acceptedToCompleteRelay", {
          transport: "ws",
          sessionId
        });
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
        await harnessService.resolveApproval(command.payload.approvalId, command.payload.resolution);
        await this.publishApprovalsUpdated();
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
