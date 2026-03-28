import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import {
  AccessModeSchema,
  CanonicalOriginSchema,
  SetupStateSchema,
  type CanonicalOrigin,
  nowIso,
  type AccessMode,
  type CloudProviderId,
  type SetupState,
  type SignalDaemonState,
  type SignalRegistrationMode,
  type SignalRegistrationState,
} from "@droidagent/shared";

import { db, schema } from "../db/index.js";

export interface CloudProviderPreference {
  defaultModel: string;
  lastUpdatedAt: string | null;
}

export type CloudProviderPreferences = Record<
  CloudProviderId,
  CloudProviderPreference
>;

export interface AccessSettings {
  mode: AccessMode;
  canonicalOrigin: CanonicalOrigin | null;
  bootstrapTokenHash: string | null;
  bootstrapTokenIssuedAt: string | null;
  bootstrapTokenExpiresAt: string | null;
  cloudflareHostname: string | null;
  cloudflareLastStartedAt: string | null;
}

export interface RuntimeSettings {
  selectedRuntime: "ollama" | "llamaCpp";
  activeProviderId: string;
  ollamaModel: string;
  ollamaEmbeddingModel: string;
  ollamaContextWindow: number;
  llamaCppModel: string;
  llamaCppContextWindow: number;
  workspaceRoot: string | null;
  remoteAccessEnabled: boolean;
  launchAgentInstalled: boolean;
  signalCliPath: string | null;
  signalJavaHome: string | null;
  signalPhoneNumber: string | null;
  signalAccountId: string | null;
  signalDeviceName: string | null;
  signalCliVersion: string | null;
  signalReceiveMode: "persistent" | "on-start" | "unknown";
  signalRegistrationMode: SignalRegistrationMode;
  signalRegistrationState: SignalRegistrationState;
  signalLinkUri: string | null;
  signalDaemonUrl: string | null;
  signalDaemonPid: number | null;
  signalDaemonState: SignalDaemonState;
  signalLastError: string | null;
  signalLastStartedAt: string | null;
  signalCompatibilityWarning: string | null;
  smartContextManagementEnabled: boolean;
  cloudProviders: CloudProviderPreferences;
}

const DEFAULT_ACCESS_SETTINGS: AccessSettings = {
  mode: "loopback",
  canonicalOrigin: null,
  bootstrapTokenHash: null,
  bootstrapTokenIssuedAt: null,
  bootstrapTokenExpiresAt: null,
  cloudflareHostname: null,
  cloudflareLastStartedAt: null,
};

export const DEFAULT_CLOUD_PROVIDER_PREFERENCES: CloudProviderPreferences = {
  openai: {
    defaultModel: "openai/gpt-5.4",
    lastUpdatedAt: null,
  },
  anthropic: {
    defaultModel: "anthropic/claude-sonnet-4-5",
    lastUpdatedAt: null,
  },
  openrouter: {
    defaultModel: "openrouter/anthropic/claude-sonnet-4-5",
    lastUpdatedAt: null,
  },
  gemini: {
    defaultModel: "gemini/gemini-2.5-pro",
    lastUpdatedAt: null,
  },
  groq: {
    defaultModel: "groq/llama-3.3-70b-versatile",
    lastUpdatedAt: null,
  },
  together: {
    defaultModel: "together/deepseek-ai/DeepSeek-R1-Distill-Llama-70B-free",
    lastUpdatedAt: null,
  },
  xai: {
    defaultModel: "xai/grok-4-fast",
    lastUpdatedAt: null,
  },
};

export const DEFAULT_OLLAMA_MODEL = "qwen3.5:4b";
export const DEFAULT_OLLAMA_EMBEDDING_MODEL = "embeddinggemma:300m-qat-q8_0";

const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  selectedRuntime: "ollama",
  activeProviderId: "ollama-default",
  ollamaModel: DEFAULT_OLLAMA_MODEL,
  ollamaEmbeddingModel: DEFAULT_OLLAMA_EMBEDDING_MODEL,
  ollamaContextWindow: 65536,
  llamaCppModel: "ggml-org/gemma-3-1b-it-GGUF",
  llamaCppContextWindow: 8192,
  workspaceRoot: null,
  remoteAccessEnabled: false,
  launchAgentInstalled: false,
  signalCliPath: null,
  signalJavaHome: null,
  signalPhoneNumber: null,
  signalAccountId: null,
  signalDeviceName: null,
  signalCliVersion: null,
  signalReceiveMode: "persistent",
  signalRegistrationMode: "none",
  signalRegistrationState: "unconfigured",
  signalLinkUri: null,
  signalDaemonUrl: null,
  signalDaemonPid: null,
  signalDaemonState: "stopped",
  signalLastError: null,
  signalLastStartedAt: null,
  signalCompatibilityWarning: null,
  smartContextManagementEnabled: true,
  cloudProviders: DEFAULT_CLOUD_PROVIDER_PREFERENCES,
};

const DEFAULT_SETUP_STATE: SetupState = {
  completedSteps: [],
  currentStep: "hostScan",
  passkeyConfigured: false,
  workspaceRoot: null,
  selectedRuntime: "ollama",
  selectedModel: "qwen3.5:4b",
  remoteAccessEnabled: false,
  signalEnabled: false,
};

function deserializeJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mergeRuntimeSettings(
  update: Partial<RuntimeSettings>,
  current: RuntimeSettings,
): RuntimeSettings {
  return {
    ...current,
    ...update,
    cloudProviders: {
      ...current.cloudProviders,
      ...(update.cloudProviders ?? {}),
    },
  };
}

function mergeAccessSettings(
  update: Partial<AccessSettings>,
  current: AccessSettings,
): AccessSettings {
  return {
    ...current,
    ...update,
    canonicalOrigin:
      update.canonicalOrigin === undefined
        ? current.canonicalOrigin
        : update.canonicalOrigin,
  };
}

export class AppStateService {
  async getJsonSetting<T>(key: string, fallback: T): Promise<T> {
    const row = await db.query.appSettings.findFirst({
      where: eq(schema.appSettings.key, key),
    });
    if (!row) {
      return fallback;
    }
    return deserializeJson<T>(row.value, fallback);
  }

  async setJsonSetting(key: string, value: unknown): Promise<void> {
    const now = nowIso();
    await db
      .insert(schema.appSettings)
      .values({
        key,
        value: JSON.stringify(value),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.appSettings.key,
        set: {
          value: JSON.stringify(value),
          updatedAt: now,
        },
      });
  }

  async getRuntimeSettings(): Promise<RuntimeSettings> {
    const current = await this.getJsonSetting(
      "runtimeSettings",
      DEFAULT_RUNTIME_SETTINGS,
    );
    return mergeRuntimeSettings(current, DEFAULT_RUNTIME_SETTINGS);
  }

  async getAccessSettings(): Promise<AccessSettings> {
    const current = await this.getJsonSetting(
      "accessSettings",
      DEFAULT_ACCESS_SETTINGS,
    );
    return mergeAccessSettings(
      {
        ...current,
        canonicalOrigin: current.canonicalOrigin
          ? CanonicalOriginSchema.parse(current.canonicalOrigin)
          : null,
        mode: AccessModeSchema.parse(
          current.mode ?? DEFAULT_ACCESS_SETTINGS.mode,
        ),
      },
      DEFAULT_ACCESS_SETTINGS,
    );
  }

  async updateAccessSettings(
    update: Partial<AccessSettings>,
  ): Promise<AccessSettings> {
    const current = await this.getAccessSettings();
    const next = mergeAccessSettings(update, current);
    await this.setJsonSetting("accessSettings", next);
    return next;
  }

  async updateRuntimeSettings(
    update: Partial<RuntimeSettings>,
  ): Promise<RuntimeSettings> {
    const current = await this.getRuntimeSettings();
    const next = mergeRuntimeSettings(update, current);
    await this.setJsonSetting("runtimeSettings", next);
    return next;
  }

  async updateCloudProviderPreference(
    providerId: CloudProviderId,
    update: Partial<CloudProviderPreference>,
  ): Promise<RuntimeSettings> {
    const current = await this.getRuntimeSettings();
    return await this.updateRuntimeSettings({
      cloudProviders: {
        ...current.cloudProviders,
        [providerId]: {
          ...current.cloudProviders[providerId],
          ...update,
        },
      },
    });
  }

  async getSetupState(): Promise<SetupState> {
    const current = await this.getJsonSetting(
      "setupState",
      DEFAULT_SETUP_STATE,
    );
    return SetupStateSchema.parse(current);
  }

  async updateSetupState(update: Partial<SetupState>): Promise<SetupState> {
    const current = await this.getSetupState();
    const merged = SetupStateSchema.parse({
      ...current,
      ...update,
    });
    await this.setJsonSetting("setupState", merged);
    return merged;
  }

  async markSetupStepCompleted(
    step: SetupState["currentStep"],
    patch: Partial<SetupState> = {},
  ): Promise<SetupState> {
    const current = await this.getSetupState();
    const completedSteps = current.completedSteps.includes(step)
      ? current.completedSteps
      : [...current.completedSteps, step];
    const nextStep = this.resolveNextStep(step);
    return await this.updateSetupState({
      ...patch,
      completedSteps,
      currentStep: nextStep,
    });
  }

  resolveNextStep(step: SetupState["currentStep"]): SetupState["currentStep"] {
    const ordered = SetupStateSchema.shape.currentStep.options;
    const index = ordered.indexOf(step);
    return ordered[Math.min(index + 1, ordered.length - 1)] ?? step;
  }

  async listRecentJobs(limit = 20) {
    return await db.query.jobs.findMany({
      orderBy: (jobs, { desc }) => [desc(jobs.createdAt)],
      limit,
    });
  }

  async createJob(command: string, cwd: string) {
    const record = {
      id: randomUUID(),
      command,
      cwd,
      status: "queued",
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      lastLine: "",
    } as const;

    await db.insert(schema.jobs).values(record);
    return record;
  }

  async updateJob(
    jobId: string,
    update: Partial<{
      status: string;
      startedAt: string | null;
      finishedAt: string | null;
      exitCode: number | null;
      lastLine: string;
    }>,
  ): Promise<void> {
    await db.update(schema.jobs).set(update).where(eq(schema.jobs.id, jobId));
  }
}

export const appStateService = new AppStateService();
