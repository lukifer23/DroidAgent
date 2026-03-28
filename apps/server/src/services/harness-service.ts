import { TEST_MODE } from "../env.js";
import type {
  ApprovalRecord,
  ChannelConfigSummary,
  ChannelStatus,
  ChatMessage,
  HarnessStatus,
  RuntimeStatus,
  SessionSummary
} from "@droidagent/shared";

import { openclawService } from "./openclaw-service.js";
import { testHarnessService } from "./test-harness-service.js";

export interface StreamRelayCallbacks {
  onDelta(delta: string): void | Promise<void>;
  onDone(): void | Promise<void>;
  onError(message: string): void | Promise<void>;
}

export interface HarnessRuntimeModelConfig {
  providerId: string;
  modelId: string;
  baseUrl?: string | null;
  contextWindow?: number;
}

export interface HarnessAdapter {
  health(): Promise<RuntimeStatus>;
  harnessStatus(): Promise<HarnessStatus>;
  listSessions(): Promise<SessionSummary[]>;
  loadHistory(sessionKey: string): Promise<ChatMessage[]>;
  sendMessage(sessionKey: string, message: string, relay: StreamRelayCallbacks): Promise<{ runId: string }>;
  abortMessage(sessionKey: string): Promise<void>;
  listApprovals(): Promise<ApprovalRecord[]>;
  resolveApproval(approvalId: string, resolution: "approved" | "denied"): Promise<void>;
  listChannels(): Promise<{ statuses: ChannelStatus[]; config: ChannelConfigSummary }>;
  configureRuntimeModel(config: HarnessRuntimeModelConfig): Promise<void>;
}

export const harnessService: HarnessAdapter = TEST_MODE ? testHarnessService : openclawService;
