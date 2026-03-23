import { WebSocketServer, type WebSocket } from "ws";

import { ClientCommandSchema, ServerEventSchema, type DashboardState } from "@droidagent/shared";

import { dashboardService } from "./services/dashboard-service.js";
import { jobService } from "./services/job-service.js";
import { openclawService } from "./services/openclaw-service.js";

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
      this.broadcast({
        type: "job.output",
        payload: event
      });
    });
  }

  async refreshAll(): Promise<void> {
    const state = await dashboardService.getDashboardState();
    this.broadcast({
      type: "dashboard.state",
      payload: state
    });
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
        const messages = await openclawService.loadChatHistory(command.payload.sessionId);
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
        await openclawService.sendChat(command.payload.sessionId, command.payload.text);
        const messages = await openclawService.loadChatHistory(command.payload.sessionId);
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
        await this.refreshAll();
        return;
      }

      if (command.type === "approval.resolve") {
        await openclawService.resolveApproval(command.payload.approvalId, command.payload.resolution);
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

