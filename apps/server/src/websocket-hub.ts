import { WebSocketServer, type WebSocket } from "ws";

import { ClientCommandSchema, ServerEventSchema } from "@droidagent/shared";

import { dashboardService } from "./services/dashboard-service.js";
import { harnessService } from "./services/harness-service.js";
import { jobService } from "./services/job-service.js";

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
      this.broadcast(
        ServerEventSchema.parse({
          type: "job.updated",
          payload: job
        })
      );
    });
  }

  async refreshAll(): Promise<void> {
    const state = await dashboardService.getDashboardState();
    this.broadcast(
      ServerEventSchema.parse({
        type: "dashboard.state",
        payload: state
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
        const { sessionId, text } = command.payload;
        const run = await harnessService.sendMessage(sessionId, text, {
          onDelta: async (delta) => {
            this.publishChatDelta(sessionId, run.runId, delta);
          },
          onDone: async () => {
            this.publishChatDone(sessionId, run.runId);
            await this.pushChatHistory(sessionId);
            await this.refreshAll();
          },
          onError: async (message) => {
            this.publishChatError(sessionId, run.runId, message);
            await this.pushChatHistory(sessionId);
            await this.refreshAll();
          }
        });
        return;
      }

      if (command.type === "chat.abort") {
        await harnessService.abortMessage(command.payload.sessionId);
        await this.pushChatHistory(command.payload.sessionId);
        await this.refreshAll();
        return;
      }

      if (command.type === "approval.resolve") {
        await harnessService.resolveApproval(command.payload.approvalId, command.payload.resolution);
        await this.refreshAll();
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
