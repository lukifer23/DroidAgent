import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import { DashboardStateSchema, SetupStateSchema, nowIso, type SetupState } from "@droidagent/shared";

import { db, schema } from "../db/index.js";

interface RuntimeSettings {
  selectedRuntime: "ollama" | "llamaCpp";
  ollamaModel: string;
  llamaCppModel: string;
  llamaCppContextWindow: number;
  workspaceRoot: string | null;
  signalPhoneNumber: string | null;
  signalCliPath: string | null;
  remoteAccessEnabled: boolean;
  launchAgentInstalled: boolean;
}

const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  selectedRuntime: "ollama",
  ollamaModel: "gpt-oss:20b",
  llamaCppModel: "ggml-org/gemma-3-1b-it-GGUF",
  llamaCppContextWindow: 8192,
  workspaceRoot: null,
  signalPhoneNumber: null,
  signalCliPath: null,
  remoteAccessEnabled: false,
  launchAgentInstalled: false
};

const DEFAULT_SETUP_STATE: SetupState = {
  completedSteps: [],
  currentStep: "hostScan",
  passkeyConfigured: false,
  workspaceRoot: null,
  selectedRuntime: "ollama",
  selectedModel: "gpt-oss:20b",
  remoteAccessEnabled: false,
  signalEnabled: false
};

function deserializeJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class AppStateService {
  async getJsonSetting<T>(key: string, fallback: T): Promise<T> {
    const row = await db.query.appSettings.findFirst({
      where: eq(schema.appSettings.key, key)
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
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: schema.appSettings.key,
        set: {
          value: JSON.stringify(value),
          updatedAt: now
        }
      });
  }

  async getRuntimeSettings(): Promise<RuntimeSettings> {
    return await this.getJsonSetting("runtimeSettings", DEFAULT_RUNTIME_SETTINGS);
  }

  async updateRuntimeSettings(update: Partial<RuntimeSettings>): Promise<RuntimeSettings> {
    const current = await this.getRuntimeSettings();
    const next = { ...current, ...update };
    await this.setJsonSetting("runtimeSettings", next);
    return next;
  }

  async getSetupState(): Promise<SetupState> {
    const current = await this.getJsonSetting("setupState", DEFAULT_SETUP_STATE);
    return SetupStateSchema.parse(current);
  }

  async updateSetupState(update: Partial<SetupState>): Promise<SetupState> {
    const current = await this.getSetupState();
    const merged = SetupStateSchema.parse({
      ...current,
      ...update
    });
    await this.setJsonSetting("setupState", merged);
    return merged;
  }

  async markSetupStepCompleted(step: SetupState["currentStep"], patch: Partial<SetupState> = {}): Promise<SetupState> {
    const current = await this.getSetupState();
    const completedSteps = current.completedSteps.includes(step)
      ? current.completedSteps
      : [...current.completedSteps, step];
    const nextStep = this.resolveNextStep(step);
    return await this.updateSetupState({
      ...patch,
      completedSteps,
      currentStep: nextStep
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
      limit
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
      lastLine: ""
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
    }>
  ): Promise<void> {
    await db
      .update(schema.jobs)
      .set(update)
      .where(eq(schema.jobs.id, jobId));
  }
}

export const appStateService = new AppStateService();
