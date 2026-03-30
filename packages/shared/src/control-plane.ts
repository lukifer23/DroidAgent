import { z } from "zod";

import { DecisionRecordSchema } from "./decisions.js";
import {
  ApprovalRecordSchema,
  BootstrapStateSchema,
  BuildInfoSchema,
  ChannelConfigSummarySchema,
  ChannelStatusSchema,
  ChatMessageSchema,
  ChatRunStateSchema,
  ChatSendRequestBodySchema,
  CloudProviderSummarySchema,
  CloudflareStatusSchema,
  HealthStateSchema,
  JobRecordSchema,
  LaunchAgentStatusSchema,
  MemoryDraftSchema,
  ProviderProfileSchema,
  RuntimeStatusSchema,
  ServeStatusSchema,
  SessionSummarySchema,
  SetupStateSchema,
  StartupDiagnosticSchema,
  TailscaleStatusSchema,
  TerminalSessionSummarySchema,
} from "./core.js";

export const MaintenanceScopeSchema = z.enum(["app", "runtime", "remote"]);
export type MaintenanceScope = z.infer<typeof MaintenanceScopeSchema>;

export const MaintenanceActionSchema = z.enum(["restart", "drain-only"]);
export type MaintenanceAction = z.infer<typeof MaintenanceActionSchema>;

export const MaintenancePhaseSchema = z.enum([
  "idle",
  "queued",
  "draining",
  "stopping",
  "starting",
  "verifying",
  "completed",
  "failed",
]);
export type MaintenancePhase = z.infer<typeof MaintenancePhaseSchema>;

export const MaintenanceOperationSchema = z.object({
  id: z.string(),
  scope: MaintenanceScopeSchema,
  action: MaintenanceActionSchema,
  phase: MaintenancePhaseSchema,
  active: z.boolean(),
  requestedAt: z.string(),
  startedAt: z.string().nullable(),
  updatedAt: z.string(),
  finishedAt: z.string().nullable(),
  requestedByUserId: z.string().nullable(),
  requestedFromLocalhost: z.boolean(),
  message: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type MaintenanceOperation = z.infer<typeof MaintenanceOperationSchema>;

export const MaintenanceStatusSchema = z.object({
  active: z.boolean(),
  blocksNewWork: z.boolean(),
  current: MaintenanceOperationSchema.nullable(),
  recent: z.array(MaintenanceOperationSchema),
  updatedAt: z.string(),
});
export type MaintenanceStatus = z.infer<typeof MaintenanceStatusSchema>;

export const MaintenanceRunRequestSchema = z.object({
  scope: MaintenanceScopeSchema,
  action: MaintenanceActionSchema,
});
export type MaintenanceRunRequest = z.infer<typeof MaintenanceRunRequestSchema>;

export const WorkspaceBootstrapFileStatusSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
});
export type WorkspaceBootstrapFileStatus = z.infer<
  typeof WorkspaceBootstrapFileStatusSchema
>;

export const MemorySourceCountSchema = z.object({
  source: z.string(),
  files: z.number().int().nonnegative(),
  chunks: z.number().int().nonnegative(),
});
export type MemorySourceCount = z.infer<typeof MemorySourceCountSchema>;

export const MemoryPrepareStateSchema = z.enum([
  "idle",
  "queued",
  "running",
  "completed",
  "failed",
]);
export type MemoryPrepareState = z.infer<typeof MemoryPrepareStateSchema>;

export const MemoryStatusSchema = z.object({
  configuredWorkspaceRoot: z.string().nullable(),
  effectiveWorkspaceRoot: z.string(),
  ready: z.boolean(),
  semanticReady: z.boolean(),
  memoryDirectory: z.string(),
  memoryDirectoryReady: z.boolean(),
  skillsDirectory: z.string(),
  skillsDirectoryReady: z.boolean(),
  memoryFilePath: z.string(),
  todayNotePath: z.string(),
  bootstrapFiles: z.array(WorkspaceBootstrapFileStatusSchema),
  bootstrapFilesReady: z.number().int().nonnegative(),
  bootstrapFilesTotal: z.number().int().nonnegative(),
  memorySearchEnabled: z.boolean(),
  sessionMemoryEnabled: z.boolean(),
  embeddingProvider: z.string().nullable(),
  embeddingRequestedProvider: z.string().nullable(),
  embeddingFallback: z.string().nullable(),
  embeddingModel: z.string().nullable(),
  indexedFiles: z.number().int().nonnegative(),
  indexedChunks: z.number().int().nonnegative(),
  dirty: z.boolean(),
  vectorEnabled: z.boolean(),
  vectorAvailable: z.boolean(),
  embeddingProbeOk: z.boolean().nullable(),
  embeddingProbeError: z.string().nullable(),
  sourceCounts: z.array(MemorySourceCountSchema),
  contextWindow: z.number().int().positive(),
  prepareState: MemoryPrepareStateSchema,
  prepareStartedAt: z.string().nullable(),
  prepareFinishedAt: z.string().nullable(),
  prepareProgressLabel: z.string().nullable(),
  prepareError: z.string().nullable(),
  lastPrepareDurationMs: z.number().nonnegative().nullable(),
});
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

export const ContextManagementStatusSchema = z.object({
  enabled: z.boolean(),
  compactionMode: z.enum(["off", "default", "safeguard"]),
  pruningMode: z.enum(["off", "cache-ttl"]),
  memoryFlushEnabled: z.boolean(),
  reserveTokensFloor: z.number().int().nonnegative(),
  softThresholdTokens: z.number().int().nonnegative(),
});
export type ContextManagementStatus = z.infer<
  typeof ContextManagementStatusSchema
>;

export const HarnessToolProfileSchema = z.enum([
  "minimal",
  "coding",
  "messaging",
  "full",
  "custom",
  "unknown",
]);
export type HarnessToolProfile = z.infer<typeof HarnessToolProfileSchema>;

export const HarnessStatusSchema = z.object({
  configured: z.boolean(),
  agentId: z.string(),
  defaultSessionId: z.string(),
  gatewayAuthMode: z.string().nullable(),
  gatewayBind: z.string().nullable(),
  activeModel: z.string().nullable(),
  contextWindow: z.number().int().positive().nullable(),
  thinkingDefault: z.string().nullable(),
  imageModel: z.string().nullable(),
  pdfModel: z.string().nullable(),
  workspaceRoot: z.string().nullable(),
  toolProfile: HarnessToolProfileSchema,
  availableTools: z.array(z.string()),
  workspaceOnlyFs: z.boolean(),
  memorySearchEnabled: z.boolean(),
  sessionMemoryEnabled: z.boolean(),
  attachmentsEnabled: z.boolean(),
  execHost: z.string().nullable(),
  execSecurity: z.string().nullable(),
  execAsk: z.string().nullable(),
});
export type HarnessStatus = z.infer<typeof HarnessStatusSchema>;

export const LatencySourceSchema = z.enum(["server", "client"]);
export type LatencySource = z.infer<typeof LatencySourceSchema>;

export const LatencySampleSchema = z.object({
  id: z.string(),
  name: z.string(),
  source: LatencySourceSchema,
  startedAt: z.string(),
  endedAt: z.string(),
  durationMs: z.number().nonnegative(),
  context: z.record(z.string(), z.string()).default({}),
});
export type LatencySample = z.infer<typeof LatencySampleSchema>;

export const LatencySummarySchema = z.object({
  name: z.string(),
  source: LatencySourceSchema,
  count: z.number().int().nonnegative(),
  okCount: z.number().int().nonnegative(),
  warnCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  lastDurationMs: z.number().nonnegative().nullable(),
  lastEndedAt: z.string().nullable(),
  sampleAgeMs: z.number().nonnegative().nullable(),
  minDurationMs: z.number().nonnegative().nullable(),
  maxDurationMs: z.number().nonnegative().nullable(),
  avgDurationMs: z.number().nonnegative().nullable(),
  p50DurationMs: z.number().nonnegative().nullable(),
  p95DurationMs: z.number().nonnegative().nullable(),
});
export type LatencySummary = z.infer<typeof LatencySummarySchema>;

export const LatencyMetricSchema = z.object({
  name: z.string(),
  source: LatencySourceSchema,
  summary: LatencySummarySchema,
  recentSamples: z.array(LatencySampleSchema),
});
export type LatencyMetric = z.infer<typeof LatencyMetricSchema>;

export const PerformanceSnapshotSchema = z.object({
  generatedAt: z.string(),
  metrics: z.array(LatencyMetricSchema),
  recentSamples: z.array(LatencySampleSchema),
});
export type PerformanceSnapshot = z.infer<typeof PerformanceSnapshotSchema>;

export const HostPressureLevelSchema = z.enum([
  "ok",
  "warn",
  "critical",
  "unknown",
]);
export type HostPressureLevel = z.infer<typeof HostPressureLevelSchema>;

export const HostPressureContributorIdSchema = z.enum([
  "reclaimableMemory",
  "ramUsage",
  "swapUsage",
  "cpuLoad",
  "activeJobs",
  "terminalSession",
]);
export type HostPressureContributorId = z.infer<
  typeof HostPressureContributorIdSchema
>;

export const HostPressureContributorSeveritySchema = z.enum([
  "ok",
  "info",
  "warn",
  "critical",
]);
export type HostPressureContributorSeverity = z.infer<
  typeof HostPressureContributorSeveritySchema
>;

export const HostPressureContributorSchema = z.object({
  id: HostPressureContributorIdSchema,
  label: z.string(),
  severity: HostPressureContributorSeveritySchema,
  value: z.string(),
  detail: z.string(),
});
export type HostPressureContributor = z.infer<
  typeof HostPressureContributorSchema
>;

export const HostPressureStatusSchema = z.object({
  observedAt: z.string(),
  health: HealthStateSchema,
  level: HostPressureLevelSchema,
  message: z.string(),
  blocksAgentRuns: z.boolean(),
  cpuLogicalCores: z.number().int().positive().nullable(),
  load1m: z.number().nonnegative().nullable(),
  load5m: z.number().nonnegative().nullable(),
  load15m: z.number().nonnegative().nullable(),
  loadRatio: z.number().nonnegative().nullable(),
  memoryTotalBytes: z.number().int().nonnegative().nullable(),
  memoryUsedBytes: z.number().int().nonnegative().nullable(),
  memoryAvailableBytes: z.number().int().nonnegative().nullable(),
  memoryUsedRatio: z.number().nonnegative().nullable(),
  compressedBytes: z.number().int().nonnegative().nullable(),
  swapTotalBytes: z.number().int().nonnegative().nullable(),
  swapUsedBytes: z.number().int().nonnegative().nullable(),
  swapUsedRatio: z.number().nonnegative().nullable(),
  activeJobs: z.number().int().nonnegative(),
  activeTerminalSession: z.boolean(),
  contributors: z.array(HostPressureContributorSchema),
  recommendations: z.array(z.string()),
  lastError: z.string().nullable(),
});
export type HostPressureStatus = z.infer<typeof HostPressureStatusSchema>;

export const HostPressureRecoveryRequestSchema = z.object({
  sessionId: z.string().nullable().default(null),
  abortSessionRun: z.boolean().default(true),
  cancelActiveJobs: z.boolean().default(true),
  closeTerminalSession: z.boolean().default(true),
});
export type HostPressureRecoveryRequest = z.infer<
  typeof HostPressureRecoveryRequestSchema
>;

export const HostPressureRecoveryResultSchema = z.object({
  recoveredAt: z.string(),
  abortedSessionId: z.string().nullable(),
  cancelledJobCount: z.number().int().nonnegative(),
  closedTerminalSessionId: z.string().nullable(),
  hostPressure: HostPressureStatusSchema,
});
export type HostPressureRecoveryResult = z.infer<
  typeof HostPressureRecoveryResultSchema
>;

export const DashboardStateSchema = z.object({
  build: BuildInfoSchema,
  setup: SetupStateSchema,
  canonicalUrl: z.string().url().nullable(),
  tailscaleStatus: TailscaleStatusSchema,
  cloudflareStatus: CloudflareStatusSchema,
  serveStatus: ServeStatusSchema,
  bootstrapRequired: z.boolean(),
  startupDiagnostics: z.array(StartupDiagnosticSchema),
  runtimes: z.array(RuntimeStatusSchema),
  providers: z.array(ProviderProfileSchema),
  cloudProviders: z.array(CloudProviderSummarySchema),
  channels: z.array(ChannelStatusSchema),
  channelConfig: ChannelConfigSummarySchema,
  harness: HarnessStatusSchema,
  memory: MemoryStatusSchema,
  hostPressure: HostPressureStatusSchema,
  memoryDrafts: z.array(MemoryDraftSchema),
  contextManagement: ContextManagementStatusSchema,
  maintenance: MaintenanceStatusSchema,
  launchAgent: LaunchAgentStatusSchema,
  sessions: z.array(SessionSummarySchema),
  jobs: z.array(JobRecordSchema),
  decisions: z.array(DecisionRecordSchema),
  approvals: z.array(ApprovalRecordSchema),
});
export type DashboardState = z.infer<typeof DashboardStateSchema>;

export const WebSocketEnvelopeSchema = z.object({
  type: z.string(),
  payload: z.unknown(),
});
export type WebSocketEnvelope = z.infer<typeof WebSocketEnvelopeSchema>;

export const ClientCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("chat.send"),
    payload: z.object({
      sessionId: z.string(),
      text: ChatSendRequestBodySchema.shape.text,
      attachments: ChatSendRequestBodySchema.shape.attachments,
    }),
  }),
  z.object({
    type: z.literal("chat.history"),
    payload: z.object({
      sessionId: z.string(),
    }),
  }),
  z.object({
    type: z.literal("chat.abort"),
    payload: z.object({
      sessionId: z.string(),
    }),
  }),
  z.object({
    type: z.literal("job.subscribe"),
    payload: z.object({
      jobId: z.string(),
    }),
  }),
  z.object({
    type: z.literal("approval.resolve"),
    payload: z.object({
      approvalId: z.string(),
      resolution: z.enum(["approved", "denied"]),
    }),
  }),
  z.object({
    type: z.literal("decision.resolve"),
    payload: z.object({
      decisionId: z.string(),
      resolution: z.enum(["approved", "denied"]),
      expectedUpdatedAt: z.string().nullable().default(null),
    }),
  }),
  z.object({
    type: z.literal("runtime.refresh"),
    payload: z.object({}),
  }),
  z.object({
    type: z.literal("terminal.input"),
    payload: z.object({
      sessionId: z.string(),
      data: z.string().min(1),
    }),
  }),
  z.object({
    type: z.literal("terminal.resize"),
    payload: z.object({
      sessionId: z.string(),
      cols: z.number().int().min(20).max(400),
      rows: z.number().int().min(8).max(200),
    }),
  }),
  z.object({
    type: z.literal("terminal.close"),
    payload: z.object({
      sessionId: z.string(),
    }),
  }),
]);
export type ClientCommand = z.infer<typeof ClientCommandSchema>;

export const ServerEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("dashboard.state"),
    payload: DashboardStateSchema,
  }),
  z.object({
    type: z.literal("chat.message"),
    payload: ChatMessageSchema,
  }),
  z.object({
    type: z.literal("chat.history"),
    payload: z.object({
      sessionId: z.string(),
      messages: z.array(ChatMessageSchema),
    }),
  }),
  z.object({
    type: z.literal("chat.stream.delta"),
    payload: z.object({
      sessionId: z.string(),
      runId: z.string(),
      delta: z.string(),
    }),
  }),
  z.object({
    type: z.literal("chat.stream.done"),
    payload: z.object({
      sessionId: z.string(),
      runId: z.string(),
    }),
  }),
  z.object({
    type: z.literal("chat.stream.error"),
    payload: z.object({
      sessionId: z.string(),
      runId: z.string(),
      message: z.string(),
    }),
  }),
  z.object({
    type: z.literal("chat.run"),
    payload: ChatRunStateSchema,
  }),
  z.object({
    type: z.literal("job.output"),
    payload: z.object({
      jobId: z.string(),
      stream: z.enum(["stdout", "stderr"]),
      chunk: z.string(),
    }),
  }),
  z.object({
    type: z.literal("job.updated"),
    payload: JobRecordSchema,
  }),
  z.object({
    type: z.literal("approval.updated"),
    payload: ApprovalRecordSchema,
  }),
  z.object({
    type: z.literal("approvals.updated"),
    payload: z.array(ApprovalRecordSchema),
  }),
  z.object({
    type: z.literal("decision.updated"),
    payload: DecisionRecordSchema,
  }),
  z.object({
    type: z.literal("decisions.updated"),
    payload: z.array(DecisionRecordSchema),
  }),
  z.object({
    type: z.literal("sessions.updated"),
    payload: z.array(SessionSummarySchema),
  }),
  z.object({
    type: z.literal("runtime.updated"),
    payload: z.array(RuntimeStatusSchema),
  }),
  z.object({
    type: z.literal("providers.updated"),
    payload: z.object({
      providers: z.array(ProviderProfileSchema),
      cloudProviders: z.array(CloudProviderSummarySchema),
    }),
  }),
  z.object({
    type: z.literal("setup.updated"),
    payload: SetupStateSchema,
  }),
  z.object({
    type: z.literal("access.updated"),
    payload: BootstrapStateSchema,
  }),
  z.object({
    type: z.literal("launchAgent.updated"),
    payload: LaunchAgentStatusSchema,
  }),
  z.object({
    type: z.literal("channel.updated"),
    payload: z.object({
      statuses: z.array(ChannelStatusSchema),
      config: ChannelConfigSummarySchema,
    }),
  }),
  z.object({
    type: z.literal("context.updated"),
    payload: ContextManagementStatusSchema,
  }),
  z.object({
    type: z.literal("memory.updated"),
    payload: MemoryStatusSchema,
  }),
  z.object({
    type: z.literal("hostPressure.updated"),
    payload: HostPressureStatusSchema,
  }),
  z.object({
    type: z.literal("memoryDrafts.updated"),
    payload: z.array(MemoryDraftSchema),
  }),
  z.object({
    type: z.literal("harness.updated"),
    payload: HarnessStatusSchema,
  }),
  z.object({
    type: z.literal("maintenance.updated"),
    payload: MaintenanceStatusSchema,
  }),
  z.object({
    type: z.literal("error"),
    payload: z.object({
      message: z.string(),
    }),
  }),
  z.object({
    type: z.literal("performance.updated"),
    payload: PerformanceSnapshotSchema,
  }),
  z.object({
    type: z.literal("terminal.updated"),
    payload: TerminalSessionSummarySchema,
  }),
  z.object({
    type: z.literal("terminal.output"),
    payload: z.object({
      sessionId: z.string(),
      data: z.string(),
    }),
  }),
  z.object({
    type: z.literal("terminal.closed"),
    payload: z.object({
      sessionId: z.string(),
      reason: z.string().nullable(),
    }),
  }),
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;

export function nowIso(): string {
  return new Date().toISOString();
}
