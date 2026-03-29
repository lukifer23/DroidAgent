import { WebSocketServer, type WebSocket } from "ws";

import { ClientCommandSchema, ServerEventSchema } from "@droidagent/shared";

import { accessService } from "./services/access-service.js";
import { appStateService } from "./services/app-state-service.js";
import { dashboardService } from "./services/dashboard-service.js";
import { harnessService } from "./services/harness-service.js";
import { jobService } from "./services/job-service.js";
import { keychainService } from "./services/keychain-service.js";
import { launchAgentService } from "./services/launch-agent-service.js";
import { openclawService } from "./services/openclaw-service.js";
import { performanceService } from "./services/performance-service.js";
import { runtimeService } from "./services/runtime-service.js";
import { startupService } from "./services/startup-service.js";

function send(ws: WebSocket, payload: unknown): void {
  ws.send(JSON.stringify(payload));
}

export class WebsocketHub {
  private sockets = new Set<WebSocket>();

  attach(wss: WebSocketServer): void {
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
    this.broadcast(
      ServerEventSchema.parse({
        type: "runtime.updated",
        payload: await runtimeService.getRuntimeStatuses()
      })
    );
  }

  async publishProvidersUpdated(): Promise<void> {
    dashboardService.invalidate();
    startupService.invalidate();
    const [providers, cloudProviders] = await Promise.all([
      runtimeService.listProviderProfiles(),
      keychainService.listProviderSummaries()
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
  }

  async publishChannelUpdated(): Promise<void> {
    dashboardService.invalidate();
    startupService.invalidate();
    this.broadcast(
      ServerEventSchema.parse({
        type: "channel.updated",
        payload: await harnessService.listChannels()
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
    this.broadcast(
      ServerEventSchema.parse({
        type: "context.updated",
        payload: await openclawService.contextManagementStatus()
      })
    );
  }

  async publishMemoryUpdated(): Promise<void> {
    dashboardService.invalidate();
    startupService.invalidate();
    this.broadcast(
      ServerEventSchema.parse({
        type: "memory.updated",
        payload: await openclawService.memoryStatus()
      })
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
        payload: await harnessService.listSessions()
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
    this.broadcast(
      ServerEventSchema.parse({
        type: "chat.stream.delta",
        payload: {
          sessionId,
          runId,
          delta
        }
      })
    );
  }

  publishChatDone(sessionId: string, runId: string): void {
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
        const { sessionId, text, attachments } = command.payload;
        const enqueueMetric = performanceService.start("server", "chat.send.enqueue", {
          transport: "ws",
          sessionId
        });
        const firstDeltaMetric = performanceService.start("server", "chat.stream.firstDeltaRelay", {
          transport: "ws",
          sessionId
        });
        const streamMetric = performanceService.start("server", "chat.stream.completeRelay", {
          transport: "ws",
          sessionId
        });
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
            if (!firstDeltaRecorded) {
              firstDeltaRecorded = true;
              firstDeltaMetric.finish();
            }
            this.publishChatDelta(sessionId, runId, delta);
          },
          onDone: async () => {
            if (!firstDeltaRecorded) {
              firstDeltaRecorded = true;
              firstDeltaMetric.finish({
                outcome: "no-delta"
              });
            }
            if (!finished) {
              finished = true;
              streamMetric.finish({
                outcome: "done"
              });
            }
            this.publishChatDone(sessionId, runId);
            await this.pushChatHistory(sessionId);
            await this.publishSessionsUpdated();
          },
          onError: async (message) => {
            if (!firstDeltaRecorded) {
              firstDeltaRecorded = true;
              firstDeltaMetric.finish({
                outcome: "no-delta"
              });
            }
            if (!finished) {
              finished = true;
              streamMetric.finish({
                outcome: "error"
              });
            }
            this.publishChatError(sessionId, runId, message);
            await this.pushChatHistory(sessionId);
            await this.publishSessionsUpdated();
          }
        });
        runId = run.runId;
        enqueueMetric.finish();
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
