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

export const AccessModeSchema = z.enum(["loopback", "tailscale"]);
export type AccessMode = z.infer<typeof AccessModeSchema>;

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

export const PasskeyEnrollmentStateSchema = z.enum(["notStarted", "bootstrapPending", "ready", "complete"]);
export type PasskeyEnrollmentState = z.infer<typeof PasskeyEnrollmentStateSchema>;

export const CanonicalOriginSchema = z.object({
  accessMode: AccessModeSchema,
  origin: z.string().url(),
  rpId: z.string(),
  hostname: z.string(),
  source: z.enum(["tailscaleServe", "manual"]),
  updatedAt: z.string()
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
  lastCheckedAt: z.string().nullable()
});
export type TailscaleStatus = z.infer<typeof TailscaleStatusSchema>;

export const ServeStatusSchema = z.object({
  enabled: z.boolean(),
  health: HealthStateSchema,
  healthMessage: z.string(),
  source: z.enum(["tailscale", "none"]),
  url: z.string().url().nullable(),
  target: z.string().nullable(),
  lastCheckedAt: z.string().nullable()
});
export type ServeStatus = z.infer<typeof ServeStatusSchema>;

export const BootstrapStateSchema = z.object({
  ownerExists: z.boolean(),
  bootstrapRequired: z.boolean(),
  enrollmentState: PasskeyEnrollmentStateSchema,
  accessMode: AccessModeSchema,
  canonicalOrigin: CanonicalOriginSchema.nullable(),
  tailscaleStatus: TailscaleStatusSchema,
  serveStatus: ServeStatusSchema,
  bootstrapTokenIssuedAt: z.string().nullable(),
  bootstrapTokenExpiresAt: z.string().nullable(),
  bootstrapUrl: z.string().url().nullable(),
  localhostOnlyMessage: z.string()
});
export type BootstrapState = z.infer<typeof BootstrapStateSchema>;

export const StartupDiagnosticSchema = z.object({
  id: z.enum(["tailscale", "openclaw", "ollama", "llamaCpp", "signal", "cloudProviders"]),
  health: HealthStateSchema,
  message: z.string(),
  blocking: z.boolean(),
  action: z.string().nullable()
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
  lastLine: z.string().default(""),
  hasOutput: z.boolean().default(false),
  stdoutBytes: z.number().int().nonnegative().default(0),
  stderrBytes: z.number().int().nonnegative().default(0)
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

export const FileContentSchema = z.object({
  path: z.string(),
  content: z.string(),
  modifiedAt: z.string(),
  size: z.number().int().nonnegative(),
  truncated: z.boolean(),
  mimeType: z.string(),
  encoding: z.literal("utf-8")
});
export type FileContent = z.infer<typeof FileContentSchema>;

export const JobOutputSnapshotSchema = z.object({
  jobId: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  stdoutBytes: z.number().int().nonnegative(),
  stderrBytes: z.number().int().nonnegative()
});
export type JobOutputSnapshot = z.infer<typeof JobOutputSnapshotSchema>;

export const PasskeySummarySchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  deviceType: z.string(),
  backedUp: z.boolean()
});
export type PasskeySummary = z.infer<typeof PasskeySummarySchema>;

export const BootstrapLinkSchema = z.object({
  token: z.string(),
  issuedAt: z.string(),
  expiresAt: z.string(),
  canonicalOrigin: CanonicalOriginSchema,
  bootstrapUrl: z.string().url()
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
  signalEnabled: z.boolean()
});
export type SetupState = z.infer<typeof SetupStateSchema>;

export const DashboardStateSchema = z.object({
  setup: SetupStateSchema,
  canonicalUrl: z.string().url().nullable(),
  tailscaleStatus: TailscaleStatusSchema,
  serveStatus: ServeStatusSchema,
  bootstrapRequired: z.boolean(),
  startupDiagnostics: z.array(StartupDiagnosticSchema),
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
    type: z.literal("chat.abort"),
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
    type: z.literal("chat.stream.delta"),
    payload: z.object({
      sessionId: z.string(),
      runId: z.string(),
      delta: z.string()
    })
  }),
  z.object({
    type: z.literal("chat.stream.done"),
    payload: z.object({
      sessionId: z.string(),
      runId: z.string()
    })
  }),
  z.object({
    type: z.literal("chat.stream.error"),
    payload: z.object({
      sessionId: z.string(),
      runId: z.string(),
      message: z.string()
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
    type: z.literal("job.updated"),
    payload: JobRecordSchema
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
