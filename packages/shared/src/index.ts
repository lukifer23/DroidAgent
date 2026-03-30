import { z } from "zod";
import { DecisionRecordSchema } from "./decisions.js";

export {
  DecisionKindSchema,
  DecisionRecordSchema,
  DecisionResolveRequestSchema,
  DecisionResolutionSchema,
  DecisionStatusSchema,
} from "./decisions.js";
export type {
  DecisionKind,
  DecisionRecord,
  DecisionResolveRequest,
  DecisionResolution,
  DecisionStatus,
} from "./decisions.js";

export { Utf8TailBuffer } from "./utf8-tail-buffer.js";

export const RuntimeIdSchema = z.enum(["openclaw", "ollama", "llamaCpp"]);
export type RuntimeId = z.infer<typeof RuntimeIdSchema>;

export const RuntimeInstallMethodSchema = z.enum([
  "brew",
  "bundledNpm",
  "external",
]);
export type RuntimeInstallMethod = z.infer<typeof RuntimeInstallMethodSchema>;

export const RuntimeStateSchema = z.enum([
  "missing",
  "installed",
  "starting",
  "running",
  "stopped",
  "error",
]);
export type RuntimeState = z.infer<typeof RuntimeStateSchema>;

export const ChannelIdSchema = z.enum(["web", "signal"]);
export type ChannelId = z.infer<typeof ChannelIdSchema>;

export const HealthStateSchema = z.enum(["ok", "warn", "error"]);
export type HealthState = z.infer<typeof HealthStateSchema>;

export const AccessModeSchema = z.enum(["loopback", "tailscale", "cloudflare"]);
export type AccessMode = z.infer<typeof AccessModeSchema>;

export const CloudProviderIdSchema = z.enum([
  "openai",
  "anthropic",
  "openrouter",
  "gemini",
  "groq",
  "together",
  "xai",
]);
export type CloudProviderId = z.infer<typeof CloudProviderIdSchema>;

export const SetupStepIdSchema = z.enum([
  "hostScan",
  "auth",
  "workspace",
  "openclaw",
  "runtime",
  "models",
  "providerRegistration",
  "cloudProviders",
  "remoteAccess",
  "signal",
  "launchAgent",
]);
export type SetupStepId = z.infer<typeof SetupStepIdSchema>;

export const SignalRegistrationModeSchema = z.enum([
  "none",
  "register",
  "link",
]);
export type SignalRegistrationMode = z.infer<
  typeof SignalRegistrationModeSchema
>;

export const SignalRegistrationStateSchema = z.enum([
  "unconfigured",
  "awaitingVerification",
  "awaitingLink",
  "registered",
  "error",
]);
export type SignalRegistrationState = z.infer<
  typeof SignalRegistrationStateSchema
>;

export const SignalDaemonStateSchema = z.enum([
  "stopped",
  "starting",
  "running",
  "error",
]);
export type SignalDaemonState = z.infer<typeof SignalDaemonStateSchema>;

export const PasskeyEnrollmentStateSchema = z.enum([
  "notStarted",
  "bootstrapPending",
  "ready",
  "complete",
]);
export type PasskeyEnrollmentState = z.infer<
  typeof PasskeyEnrollmentStateSchema
>;

export const CanonicalOriginSchema = z.object({
  accessMode: AccessModeSchema,
  origin: z.string().url(),
  rpId: z.string(),
  hostname: z.string(),
  source: z.enum(["tailscaleServe", "cloudflareTunnel", "manual"]),
  updatedAt: z.string(),
});
export type CanonicalOrigin = z.infer<typeof CanonicalOriginSchema>;

export const TailscaleStatusSchema = z.object({
  installed: z.boolean(),
  running: z.boolean(),
  authenticated: z.boolean(),
  health: HealthStateSchema,
  healthMessage: z.string(),
  version: z.string().nullable(),
  deviceName: z.string().nullable(),
  tailnetName: z.string().nullable(),
  dnsName: z.string().nullable(),
  magicDnsEnabled: z.boolean(),
  httpsEnabled: z.boolean(),
  serveCommand: z.string().nullable(),
  canonicalUrl: z.string().url().nullable(),
  lastCheckedAt: z.string().nullable(),
});
export type TailscaleStatus = z.infer<typeof TailscaleStatusSchema>;

export const CloudflareStatusSchema = z.object({
  installed: z.boolean(),
  configured: z.boolean(),
  running: z.boolean(),
  tokenStored: z.boolean(),
  health: HealthStateSchema,
  healthMessage: z.string(),
  version: z.string().nullable(),
  hostname: z.string().nullable(),
  canonicalUrl: z.string().url().nullable(),
  lastStartedAt: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
});
export type CloudflareStatus = z.infer<typeof CloudflareStatusSchema>;

export const ServeStatusSchema = z.object({
  enabled: z.boolean(),
  health: HealthStateSchema,
  healthMessage: z.string(),
  source: z.enum(["tailscale", "cloudflare", "none"]),
  url: z.string().url().nullable(),
  target: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
});
export type ServeStatus = z.infer<typeof ServeStatusSchema>;

export const BootstrapStateSchema = z.object({
  ownerExists: z.boolean(),
  bootstrapRequired: z.boolean(),
  enrollmentState: PasskeyEnrollmentStateSchema,
  accessMode: AccessModeSchema,
  canonicalOrigin: CanonicalOriginSchema.nullable(),
  tailscaleStatus: TailscaleStatusSchema,
  cloudflareStatus: CloudflareStatusSchema,
  serveStatus: ServeStatusSchema,
  bootstrapTokenIssuedAt: z.string().nullable(),
  bootstrapTokenExpiresAt: z.string().nullable(),
  bootstrapUrl: z.string().url().nullable(),
  localhostOnlyMessage: z.string(),
});
export type BootstrapState = z.infer<typeof BootstrapStateSchema>;

export const StartupDiagnosticSchema = z.object({
  id: z.enum([
    "tailscale",
    "cloudflare",
    "openclaw",
    "ollama",
    "llamaCpp",
    "signal",
    "cloudProviders",
  ]),
  health: HealthStateSchema,
  message: z.string(),
  blocking: z.boolean(),
  action: z.string().nullable(),
});
export type StartupDiagnostic = z.infer<typeof StartupDiagnosticSchema>;

export const RuntimeStatusSchema = z.object({
  id: RuntimeIdSchema,
  label: z.string(),
  state: RuntimeStateSchema,
  enabled: z.boolean(),
  installMethod: RuntimeInstallMethodSchema,
  detectedVersion: z.string().nullable(),
  binaryPath: z.string().nullable(),
  health: HealthStateSchema,
  healthMessage: z.string(),
  endpoint: z.string().nullable(),
  installed: z.boolean(),
  lastStartedAt: z.string().nullable(),
  metadata: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .default({}),
});
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>;

export const ProviderProfileSchema = z.object({
  id: z.string(),
  provider: z.enum(["ollama", "llamaCpp", "openaiCompatible", "cloud"]),
  label: z.string(),
  model: z.string(),
  contextWindow: z.number().int().positive().nullable().default(null),
  baseUrl: z.string().nullable(),
  enabled: z.boolean(),
  toolSupport: z.boolean(),
  health: HealthStateSchema,
  healthMessage: z.string(),
});
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;

export const CloudProviderSummarySchema = z.object({
  id: CloudProviderIdSchema,
  label: z.string(),
  envVar: z.string(),
  stored: z.boolean(),
  active: z.boolean(),
  defaultModel: z.string().nullable(),
  health: HealthStateSchema,
  healthMessage: z.string(),
  lastUpdatedAt: z.string().nullable(),
});
export type CloudProviderSummary = z.infer<typeof CloudProviderSummarySchema>;

export const ChannelStatusSchema = z.object({
  id: ChannelIdSchema,
  label: z.string(),
  enabled: z.boolean(),
  configured: z.boolean(),
  health: HealthStateSchema,
  healthMessage: z.string(),
  metadata: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .default({}),
});
export type ChannelStatus = z.infer<typeof ChannelStatusSchema>;

export const LaunchAgentStatusSchema = z.object({
  label: z.string(),
  plistPath: z.string(),
  stdoutPath: z.string(),
  stderrPath: z.string(),
  installed: z.boolean(),
  loaded: z.boolean(),
  running: z.boolean(),
  pid: z.number().int().positive().nullable(),
  lastExitStatus: z.number().int().nullable(),
  health: HealthStateSchema,
  healthMessage: z.string(),
});
export type LaunchAgentStatus = z.infer<typeof LaunchAgentStatusSchema>;

export const SignalHealthCheckSchema = z.object({
  id: z.enum([
    "cli",
    "java",
    "account",
    "daemon",
    "channel",
    "pairing",
    "compatibility",
  ]),
  label: z.string(),
  health: HealthStateSchema,
  message: z.string(),
});
export type SignalHealthCheck = z.infer<typeof SignalHealthCheckSchema>;

export const SignalPendingPairingSchema = z.object({
  code: z.string(),
  from: z.string(),
  requestedAt: z.string().nullable(),
});
export type SignalPendingPairing = z.infer<typeof SignalPendingPairingSchema>;

export const ChannelConfigSummarySchema = z.object({
  signal: z.object({
    installed: z.boolean(),
    binaryPath: z.string().nullable(),
    javaHome: z.string().nullable(),
    accountId: z.string().nullable(),
    phoneNumber: z.string().nullable(),
    deviceName: z.string().nullable(),
    cliVersion: z.string().nullable(),
    registrationMode: SignalRegistrationModeSchema,
    registrationState: SignalRegistrationStateSchema,
    daemonState: SignalDaemonStateSchema,
    daemonUrl: z.string().nullable(),
    receiveMode: z.enum(["persistent", "on-start", "unknown"]),
    dmPolicy: z.enum(["pairing", "allowlist", "open"]),
    allowGroups: z.boolean(),
    channelConfigured: z.boolean(),
    pendingPairings: z.array(SignalPendingPairingSchema),
    linkUri: z.string().nullable(),
    lastError: z.string().nullable(),
    lastStartedAt: z.string().nullable(),
    compatibilityWarning: z.string().nullable(),
    healthChecks: z.array(SignalHealthCheckSchema),
  }),
});
export type ChannelConfigSummary = z.infer<typeof ChannelConfigSummarySchema>;

export const SessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  scope: z.enum(["main", "signal", "web", "global"]).default("main"),
  updatedAt: z.string(),
  unreadCount: z.number().int().nonnegative().default(0),
  lastMessagePreview: z.string().default(""),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const ChatRoleSchema = z.enum(["user", "assistant", "system", "tool"]);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

export const ChatAttachmentKindSchema = z.enum([
  "image",
  "pdf",
  "markdown",
  "text",
  "code",
  "json",
]);
export type ChatAttachmentKind = z.infer<typeof ChatAttachmentKindSchema>;

export const ChatAttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: ChatAttachmentKindSchema,
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  url: z.string(),
});
export type ChatAttachment = z.infer<typeof ChatAttachmentSchema>;

export const ChatMessagePartSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("markdown"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("attachments"),
    attachments: z.array(ChatAttachmentSchema),
  }),
  z.object({
    type: z.literal("tool_call_summary"),
    toolName: z.string(),
    summary: z.string(),
    details: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal("tool_result_summary"),
    toolName: z.string().nullable().default(null),
    summary: z.string(),
    details: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal("approval_request"),
    approvalId: z.string().nullable().default(null),
    title: z.string(),
    details: z.string(),
    resolution: z.enum(["pending", "approved", "denied"]).default("pending"),
  }),
  z.object({
    type: z.literal("code_block"),
    language: z.string().nullable().default(null),
    code: z.string(),
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
    details: z.string().nullable().default(null),
  }),
]);
export type ChatMessagePart = z.infer<typeof ChatMessagePartSchema>;

export const ChatMessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: ChatRoleSchema,
  text: z.string(),
  parts: z.array(ChatMessagePartSchema).default([]),
  attachments: z.array(ChatAttachmentSchema).default([]),
  createdAt: z.string(),
  status: z.enum(["streaming", "complete", "error"]).default("complete"),
  source: z.enum(["web", "signal", "openclaw"]).default("web"),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatRunStageSchema = z.enum([
  "accepted",
  "streaming",
  "tool_call",
  "tool_result",
  "approval_required",
  "completed",
  "failed",
]);
export type ChatRunStage = z.infer<typeof ChatRunStageSchema>;

export const ChatRunStateSchema = z.object({
  sessionId: z.string(),
  runId: z.string(),
  stage: ChatRunStageSchema,
  label: z.string(),
  detail: z.string().nullable().default(null),
  toolName: z.string().nullable().default(null),
  approvalId: z.string().nullable().default(null),
  active: z.boolean().default(true),
  updatedAt: z.string(),
});
export type ChatRunState = z.infer<typeof ChatRunStateSchema>;

const ChatSendRequestBodySchema = z.object({
  text: z.string().default(""),
  attachments: z.array(ChatAttachmentSchema).default([]),
});

export const ChatSendRequestSchema = ChatSendRequestBodySchema
  .superRefine((value, ctx) => {
    if (value.text.trim().length > 0 || value.attachments.length > 0) {
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["text"],
      message: "Provide a message or at least one attachment.",
    });
  });
export type ChatSendRequest = z.infer<typeof ChatSendRequestSchema>;

export const JobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobRecordSchema = z.object({
  id: z.string(),
  command: z.string(),
  cwd: z.string(),
  status: JobStatusSchema,
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  exitCode: z.number().nullable(),
  lastLine: z.string().default(""),
  hasOutput: z.boolean().default(false),
  stdoutBytes: z.number().int().nonnegative().default(0),
  stderrBytes: z.number().int().nonnegative().default(0),
});
export type JobRecord = z.infer<typeof JobRecordSchema>;

export const ApprovalRecordSchema = z.object({
  id: z.string(),
  kind: z.enum(["exec", "channelPairing"]),
  title: z.string(),
  details: z.string(),
  createdAt: z.string(),
  status: z.enum(["pending", "approved", "denied"]),
  source: z.string(),
});
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

export const WorkspaceEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  kind: z.enum(["file", "directory"]),
  size: z.number().nullable(),
  modifiedAt: z.string(),
});
export type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>;

export const FileContentSchema = z.object({
  path: z.string(),
  content: z.string(),
  modifiedAt: z.string(),
  size: z.number().int().nonnegative(),
  truncated: z.boolean(),
  mimeType: z.string(),
  encoding: z.literal("utf-8"),
});
export type FileContent = z.infer<typeof FileContentSchema>;

export const FileConflictResponseSchema = z.object({
  error: z.string(),
  currentModifiedAt: z.string(),
});
export type FileConflictResponse = z.infer<typeof FileConflictResponseSchema>;

export const JobOutputSnapshotSchema = z.object({
  jobId: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  stdoutBytes: z.number().int().nonnegative(),
  stderrBytes: z.number().int().nonnegative(),
});
export type JobOutputSnapshot = z.infer<typeof JobOutputSnapshotSchema>;

export const TerminalScopeSchema = z.enum(["workspace", "host"]);
export type TerminalScope = z.infer<typeof TerminalScopeSchema>;

export const TerminalSessionStatusSchema = z.enum([
  "starting",
  "running",
  "closed",
  "error",
]);
export type TerminalSessionStatus = z.infer<
  typeof TerminalSessionStatusSchema
>;

export const TerminalSessionSummarySchema = z.object({
  id: z.string(),
  scope: TerminalScopeSchema,
  cwd: z.string(),
  shell: z.string(),
  title: z.string(),
  status: TerminalSessionStatusSchema,
  pid: z.number().int().positive().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  idleExpiresAt: z.string().nullable(),
  transcriptBytes: z.number().int().nonnegative(),
});
export type TerminalSessionSummary = z.infer<
  typeof TerminalSessionSummarySchema
>;

export const TerminalSnapshotSchema = z.object({
  session: TerminalSessionSummarySchema.nullable(),
  transcript: z.string(),
  truncated: z.boolean(),
  maxBytes: z.number().int().positive(),
  closeReason: z.string().nullable(),
});
export type TerminalSnapshot = z.infer<typeof TerminalSnapshotSchema>;

export const PasskeySummarySchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  deviceType: z.string(),
  backedUp: z.boolean(),
});
export type PasskeySummary = z.infer<typeof PasskeySummarySchema>;

export const BootstrapLinkSchema = z.object({
  token: z.string(),
  issuedAt: z.string(),
  expiresAt: z.string(),
  canonicalOrigin: CanonicalOriginSchema,
  bootstrapUrl: z.string().url(),
});
export type BootstrapLink = z.infer<typeof BootstrapLinkSchema>;

export const SetupStateSchema = z.object({
  completedSteps: z.array(SetupStepIdSchema),
  currentStep: SetupStepIdSchema,
  passkeyConfigured: z.boolean(),
  workspaceRoot: z.string().nullable(),
  selectedRuntime: RuntimeIdSchema.nullable(),
  selectedModel: z.string().nullable(),
  remoteAccessEnabled: z.boolean(),
  signalEnabled: z.boolean(),
});
export type SetupState = z.infer<typeof SetupStateSchema>;

export const BuildInfoSchema = z.object({
  productName: z.string(),
  version: z.string(),
  gitCommit: z.string().nullable(),
  packageManager: z.string().nullable(),
  nodeVersion: z.string(),
});
export type BuildInfo = z.infer<typeof BuildInfoSchema>;

export const QuickstartResultSchema = z.object({
  hostReady: z.boolean(),
  remoteReady: z.boolean(),
  workspaceRoot: z.string(),
  modelId: z.string(),
  phoneUrl: z.string().url().nullable(),
  actions: z.array(z.string()),
  remotePendingReason: z.string().nullable(),
});
export type QuickstartResult = z.infer<typeof QuickstartResultSchema>;

export const MemoryDraftTargetSchema = z.enum([
  "memory",
  "preferences",
  "todayNote",
]);
export type MemoryDraftTarget = z.infer<typeof MemoryDraftTargetSchema>;

export const MemoryDraftStatusSchema = z.enum([
  "pending",
  "applied",
  "dismissed",
  "failed",
]);
export type MemoryDraftStatus = z.infer<typeof MemoryDraftStatusSchema>;

export const MemoryDraftSourceKindSchema = z.enum([
  "chatMessage",
  "fileSelection",
  "memoryFlush",
  "manual",
]);
export type MemoryDraftSourceKind = z.infer<typeof MemoryDraftSourceKindSchema>;

export const MemoryDraftSchema = z.object({
  id: z.string(),
  target: MemoryDraftTargetSchema,
  status: MemoryDraftStatusSchema,
  title: z.string().nullable(),
  content: z.string(),
  sourceKind: MemoryDraftSourceKindSchema,
  sourceLabel: z.string().nullable(),
  sourceRef: z.string().nullable(),
  sessionId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  appliedAt: z.string().nullable(),
  dismissedAt: z.string().nullable(),
  failedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  appliedPath: z.string().nullable(),
});
export type MemoryDraft = z.infer<typeof MemoryDraftSchema>;

export const MemoryDraftCreateRequestSchema = z.object({
  target: MemoryDraftTargetSchema,
  title: z.string().trim().max(200).nullable().default(null),
  content: z.string().trim().min(1),
  sourceKind: MemoryDraftSourceKindSchema.default("manual"),
  sourceLabel: z.string().trim().max(300).nullable().default(null),
  sourceRef: z.string().trim().max(500).nullable().default(null),
  sessionId: z.string().trim().max(200).nullable().default(null),
});
export type MemoryDraftCreateRequest = z.infer<
  typeof MemoryDraftCreateRequestSchema
>;

export const MemoryDraftRevisionRequestSchema = z.object({
  expectedUpdatedAt: z.string().trim().min(1),
});
export type MemoryDraftRevisionRequest = z.infer<
  typeof MemoryDraftRevisionRequestSchema
>;

export const MemoryDraftUpdateRequestSchema = MemoryDraftRevisionRequestSchema
  .extend({
    target: MemoryDraftTargetSchema.optional(),
    title: z.string().trim().max(200).nullable().optional(),
    content: z.string().trim().min(1).optional(),
  })
  .refine(
    (value) =>
      value.target !== undefined ||
      value.title !== undefined ||
      value.content !== undefined,
    {
      message: "Update at least one draft field.",
    },
  );
export type MemoryDraftUpdateRequest = z.infer<
  typeof MemoryDraftUpdateRequestSchema
>;

export const MemoryDraftApplyRequestSchema = MemoryDraftRevisionRequestSchema;
export type MemoryDraftApplyRequest = z.infer<
  typeof MemoryDraftApplyRequestSchema
>;

export const MemoryDraftDismissRequestSchema = MemoryDraftRevisionRequestSchema;
export type MemoryDraftDismissRequest = z.infer<
  typeof MemoryDraftDismissRequestSchema
>;

export const MemoryDraftApplyResultSchema = z.object({
  draft: MemoryDraftSchema,
  outcome: z.enum(["applied", "alreadyApplied"]),
  memory: z.object({
    effectiveWorkspaceRoot: z.string(),
    memoryFilePath: z.string(),
    todayNotePath: z.string(),
  }),
  reindexMode: z.enum(["incremental", "force"]).nullable(),
});
export type MemoryDraftApplyResult = z.infer<
  typeof MemoryDraftApplyResultSchema
>;

export const MemoryDraftDismissResultSchema = z.object({
  draft: MemoryDraftSchema,
  outcome: z.enum(["dismissed", "alreadyDismissed"]),
});
export type MemoryDraftDismissResult = z.infer<
  typeof MemoryDraftDismissResultSchema
>;

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
