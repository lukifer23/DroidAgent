import { z } from "zod";

export const RuntimeIdSchema = z.enum(["openclaw", "ollama", "llamaCpp"]);
export type RuntimeId = z.infer<typeof RuntimeIdSchema>;

export const RuntimeInstallMethodSchema = z.enum(["brew", "bundledNpm", "external"]);
export type RuntimeInstallMethod = z.infer<typeof RuntimeInstallMethodSchema>;

export const RuntimeStateSchema = z.enum(["missing", "installed", "starting", "running", "stopped", "error"]);
export type RuntimeState = z.infer<typeof RuntimeStateSchema>;

export const ChannelIdSchema = z.enum(["web", "signal"]);
export type ChannelId = z.infer<typeof ChannelIdSchema>;

export const HealthStateSchema = z.enum(["ok", "warn", "error"]);
export type HealthState = z.infer<typeof HealthStateSchema>;

export const CloudProviderIdSchema = z.enum([
  "openai",
  "anthropic",
  "openrouter",
  "gemini",
  "groq",
  "together",
  "xai"
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
  "launchAgent"
]);
export type SetupStepId = z.infer<typeof SetupStepIdSchema>;

export const SignalRegistrationModeSchema = z.enum(["none", "register", "link"]);
export type SignalRegistrationMode = z.infer<typeof SignalRegistrationModeSchema>;

export const SignalRegistrationStateSchema = z.enum([
  "unconfigured",
  "awaitingVerification",
  "awaitingLink",
  "registered",
  "error"
]);
export type SignalRegistrationState = z.infer<typeof SignalRegistrationStateSchema>;

export const SignalDaemonStateSchema = z.enum(["stopped", "starting", "running", "error"]);
export type SignalDaemonState = z.infer<typeof SignalDaemonStateSchema>;

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
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({})
});
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>;

export const ProviderProfileSchema = z.object({
  id: z.string(),
  provider: z.enum(["ollama", "llamaCpp", "openaiCompatible", "cloud"]),
  label: z.string(),
  model: z.string(),
  baseUrl: z.string().nullable(),
  enabled: z.boolean(),
  toolSupport: z.boolean(),
  health: HealthStateSchema,
  healthMessage: z.string()
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
  lastUpdatedAt: z.string().nullable()
});
export type CloudProviderSummary = z.infer<typeof CloudProviderSummarySchema>;

export const ChannelStatusSchema = z.object({
  id: ChannelIdSchema,
  label: z.string(),
  enabled: z.boolean(),
  configured: z.boolean(),
  health: HealthStateSchema,
  healthMessage: z.string(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({})
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
  healthMessage: z.string()
});
export type LaunchAgentStatus = z.infer<typeof LaunchAgentStatusSchema>;

export const ChannelConfigSummarySchema = z.object({
  signal: z.object({
    installed: z.boolean(),
    binaryPath: z.string().nullable(),
    javaHome: z.string().nullable(),
    accountId: z.string().nullable(),
    phoneNumber: z.string().nullable(),
    deviceName: z.string().nullable(),
    registrationMode: SignalRegistrationModeSchema,
    registrationState: SignalRegistrationStateSchema,
    daemonState: SignalDaemonStateSchema,
    daemonUrl: z.string().nullable(),
    dmPolicy: z.enum(["pairing", "allowlist", "open"]),
    allowGroups: z.boolean(),
    pairingPending: z.number(),
    approvedPeers: z.array(z.string()),
    linkUri: z.string().nullable(),
    lastError: z.string().nullable(),
    lastStartedAt: z.string().nullable()
  })
});
export type ChannelConfigSummary = z.infer<typeof ChannelConfigSummarySchema>;

export const SessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  scope: z.enum(["main", "signal", "web", "global"]).default("main"),
  updatedAt: z.string(),
  unreadCount: z.number().int().nonnegative().default(0),
  lastMessagePreview: z.string().default("")
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const ChatRoleSchema = z.enum(["user", "assistant", "system", "tool"]);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

export const ChatMessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: ChatRoleSchema,
  text: z.string(),
  createdAt: z.string(),
  status: z.enum(["streaming", "complete", "error"]).default("complete"),
  source: z.enum(["web", "signal", "openclaw"]).default("web")
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const JobStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
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
  lastLine: z.string().default("")
});
export type JobRecord = z.infer<typeof JobRecordSchema>;

export const ApprovalRecordSchema = z.object({
  id: z.string(),
  kind: z.enum(["exec", "channelPairing"]),
  title: z.string(),
  details: z.string(),
  createdAt: z.string(),
  status: z.enum(["pending", "approved", "denied"]),
  source: z.string()
});
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

export const WorkspaceEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  kind: z.enum(["file", "directory"]),
  size: z.number().nullable(),
  modifiedAt: z.string()
});
export type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>;

export const SetupStateSchema = z.object({
  completedSteps: z.array(SetupStepIdSchema),
  currentStep: SetupStepIdSchema,
  passkeyConfigured: z.boolean(),
  workspaceRoot: z.string().nullable(),
  selectedRuntime: RuntimeIdSchema.nullable(),
  selectedModel: z.string().nullable(),
  remoteAccessEnabled: z.boolean(),
  signalEnabled: z.boolean()
});
export type SetupState = z.infer<typeof SetupStateSchema>;

export const DashboardStateSchema = z.object({
  setup: SetupStateSchema,
  runtimes: z.array(RuntimeStatusSchema),
  providers: z.array(ProviderProfileSchema),
  cloudProviders: z.array(CloudProviderSummarySchema),
  channels: z.array(ChannelStatusSchema),
  channelConfig: ChannelConfigSummarySchema,
  launchAgent: LaunchAgentStatusSchema,
  sessions: z.array(SessionSummarySchema),
  jobs: z.array(JobRecordSchema),
  approvals: z.array(ApprovalRecordSchema)
});
export type DashboardState = z.infer<typeof DashboardStateSchema>;

export const WebSocketEnvelopeSchema = z.object({
  type: z.string(),
  payload: z.unknown()
});
export type WebSocketEnvelope = z.infer<typeof WebSocketEnvelopeSchema>;

export const ClientCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("chat.send"),
    payload: z.object({
      sessionId: z.string(),
      text: z.string().min(1)
    })
  }),
  z.object({
    type: z.literal("chat.history"),
    payload: z.object({
      sessionId: z.string()
    })
  }),
  z.object({
    type: z.literal("job.subscribe"),
    payload: z.object({
      jobId: z.string()
    })
  }),
  z.object({
    type: z.literal("approval.resolve"),
    payload: z.object({
      approvalId: z.string(),
      resolution: z.enum(["approved", "denied"])
    })
  }),
  z.object({
    type: z.literal("runtime.refresh"),
    payload: z.object({})
  })
]);
export type ClientCommand = z.infer<typeof ClientCommandSchema>;

export const ServerEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("dashboard.state"),
    payload: DashboardStateSchema
  }),
  z.object({
    type: z.literal("chat.message"),
    payload: ChatMessageSchema
  }),
  z.object({
    type: z.literal("chat.history"),
    payload: z.object({
      sessionId: z.string(),
      messages: z.array(ChatMessageSchema)
    })
  }),
  z.object({
    type: z.literal("job.output"),
    payload: z.object({
      jobId: z.string(),
      stream: z.enum(["stdout", "stderr"]),
      chunk: z.string()
    })
  }),
  z.object({
    type: z.literal("approval.updated"),
    payload: ApprovalRecordSchema
  }),
  z.object({
    type: z.literal("runtime.updated"),
    payload: z.array(RuntimeStatusSchema)
  }),
  z.object({
    type: z.literal("channel.updated"),
    payload: z.object({
      statuses: z.array(ChannelStatusSchema),
      config: ChannelConfigSummarySchema
    })
  }),
  z.object({
    type: z.literal("error"),
    payload: z.object({
      message: z.string()
    })
  })
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;

export function nowIso(): string {
  return new Date().toISOString();
}
