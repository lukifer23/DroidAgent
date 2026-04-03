import fs from "node:fs";
import path from "node:path";

import {
  HarnessStatusSchema,
  MemoryStatusSchema,
  type ContextManagementStatus,
  type HarnessStatus,
  type MemoryStatus,
} from "@droidagent/shared";

import { OPENCLAW_GATEWAY_PORT, OPENCLAW_GATEWAY_URL, paths } from "../env.js";
import {
  getConfigPathValue,
  hashConfigFingerprint,
} from "./openclaw-config.js";
import { performanceService } from "./performance-service.js";
import {
  WORKSPACE_BOOTSTRAP_EXTRA_FILES,
  WORKSPACE_BOOTSTRAP_FILES,
} from "./openclaw-workspace.js";
import { appStateService } from "./app-state-service.js";
import type { HarnessRuntimeModelConfig } from "./harness-service.js";
import {
  buildContextManagementStatus,
  DEFAULT_WEB_SESSION_ID,
  resolveContextWindow,
  resolveHarnessToolProfile,
  resolveModelRef,
  resolveProfileTools,
  todayMemoryNoteName,
  todayMemoryNoteTemplate,
} from "./openclaw-service-support.js";
import type {
  OpenClawMemorySourceCount,
  OpenClawMemoryStatusEntry,
} from "./openclaw-service-support.js";
import type { OpenClawService } from "./openclaw-service.js";

type OpenClawMemoryService = OpenClawService & {
  ensureConfiguredPromise: Promise<void> | null;
  lastConfiguredHash: string | null;
  lastConfiguredConfigMtimeMs: number;
  cachedConfigMtimeMs: number;
  lastKnownMemoryStatus: MemoryStatus | null;
  memoryStatusCache: {
    get<T>(loader: () => Promise<T>): Promise<T>;
    invalidate(): void;
  };
  resolveWorkspaceRoot(
    runtimeSettings: Awaited<
      ReturnType<typeof appStateService.getRuntimeSettings>
    >,
  ): string;
  ensureWorkspaceScaffold(workspaceRoot: string): Promise<void>;
  resolveOllamaMultimodalConfig(
    runtimeSettings: Awaited<
      ReturnType<typeof appStateService.getRuntimeSettings>
    >,
  ): Promise<{
    attachmentModelId: string;
    providerConfig: Record<string, unknown>;
  }>;
  ensureGatewayToken(): Promise<string>;
  resolvePrimaryModel(
    runtimeSettings: Awaited<
      ReturnType<typeof appStateService.getRuntimeSettings>
    >,
  ): string;
  buildMemorySearchConfig(
    runtimeSettings: Awaited<
      ReturnType<typeof appStateService.getRuntimeSettings>
    >,
  ): unknown;
  readCurrentConfig(): Record<string, unknown> | null;
  setConfigValueIfNeeded(
    currentConfig: Record<string, unknown> | null,
    key: string,
    value: unknown,
  ): Promise<Record<string, unknown>>;
  ensureOpenClawEnvFile(content: string): Promise<void>;
  applyContextManagementPolicy(
    overrides?: Partial<HarnessRuntimeModelConfig>,
    currentConfig?: Record<string, unknown> | null,
  ): Promise<Record<string, unknown>>;
  invalidateMemoryStatusCache(): void;
  currentMemoryStatus(params?: {
    liveQuery?: "deep" | "shallow" | "skip";
  }): Promise<MemoryStatus>;
  loadOpenClawMemoryStatus(params?: {
    deep?: boolean;
    index?: boolean;
  }): Promise<OpenClawMemoryStatusEntry | null>;
  currentContextManagementStatus(
    overrides?: Partial<HarnessRuntimeModelConfig>,
  ): Promise<ContextManagementStatus>;
  execOpenClaw(
    args: string[],
    allowFailure?: boolean,
    timeoutMs?: number,
  ): Promise<string>;
  selectOllamaModel(modelId: string): Promise<void>;
  selectPrimaryModel(modelId: string): Promise<void>;
  registerLlamaCppProvider(
    modelId: string,
    contextWindow: number,
  ): Promise<void>;
};

export const openClawMemoryMethods = {
  async currentContextManagementStatus(
    this: OpenClawService,
    overrides: Partial<HarnessRuntimeModelConfig> = {},
  ): Promise<ContextManagementStatus> {
    const runtimeSettings = await appStateService.getRuntimeSettings();
    const providerId = overrides.providerId ?? runtimeSettings.activeProviderId;
    const modelId =
      overrides.modelId ??
      (providerId === "ollama-default"
        ? runtimeSettings.ollamaModel
        : providerId === "llamacpp-default"
          ? path.basename(runtimeSettings.llamaCppModel).toLowerCase()
          : (runtimeSettings.cloudProviders[
              providerId as keyof typeof runtimeSettings.cloudProviders
            ]?.defaultModel ?? ""));
    const contextWindow = resolveContextWindow({
      providerId,
      ...(typeof overrides.contextWindow === "number"
        ? { contextWindow: overrides.contextWindow }
        : {}),
      runtimeSettings,
    });

    return buildContextManagementStatus({
      enabled: runtimeSettings.smartContextManagementEnabled,
      providerId,
      modelId,
      contextWindow,
    });
  },

  async currentMemoryStatus(
    this: OpenClawService,
    params: {
      liveQuery?: "deep" | "shallow" | "skip";
    } = {},
  ): Promise<MemoryStatus> {
    const service = this as unknown as OpenClawMemoryService;
    const runtimeSettings = await appStateService.getRuntimeSettings();
    const workspaceRoot = service.resolveWorkspaceRoot(runtimeSettings);
    const currentConfig = service.readCurrentConfig();
    const previousStatus = service.lastKnownMemoryStatus;
    const bootstrapFiles = WORKSPACE_BOOTSTRAP_FILES.map(([relativePath]) => {
      const targetPath = path.join(workspaceRoot, relativePath);
      return {
        path: relativePath,
        exists: fs.existsSync(targetPath),
      };
    });
    const memoryDirectory = path.join(workspaceRoot, "memory");
    const skillsDirectory = path.join(workspaceRoot, "skills");
    const memoryDirectoryReady = fs.existsSync(memoryDirectory);
    const skillsDirectoryReady = fs.existsSync(skillsDirectory);
    const bootstrapFilesReady = bootstrapFiles.filter(
      (file) => file.exists,
    ).length;
    const memorySearchConfig = getConfigPathValue(
      currentConfig,
      "agents.defaults.memorySearch",
    ) as Record<string, unknown> | undefined;
    const cacheConfig =
      memorySearchConfig &&
      typeof memorySearchConfig === "object" &&
      !Array.isArray(memorySearchConfig)
        ? (memorySearchConfig.cache as Record<string, unknown> | undefined)
        : undefined;
    const experimentalConfig =
      memorySearchConfig &&
      typeof memorySearchConfig === "object" &&
      !Array.isArray(memorySearchConfig)
        ? (memorySearchConfig.experimental as
            | Record<string, unknown>
            | undefined)
        : undefined;
    const contextWindow = resolveContextWindow({
      providerId: runtimeSettings.activeProviderId,
      runtimeSettings,
    });
    const configuredProvider =
      typeof memorySearchConfig?.provider === "string"
        ? memorySearchConfig.provider
        : null;
    const configuredModel =
      typeof memorySearchConfig?.model === "string"
        ? memorySearchConfig.model
        : null;
    const configuredFallback =
      typeof memorySearchConfig?.fallback === "string"
        ? memorySearchConfig.fallback
        : null;
    const liveMemoryStatus =
      params.liveQuery === "skip"
        ? null
        : await service.loadOpenClawMemoryStatus(
            params.liveQuery === "deep"
              ? {
                  deep: true,
                }
              : {},
          );
    const liveStatus = liveMemoryStatus?.status;
    const sourceCounts: OpenClawMemorySourceCount[] =
      liveStatus?.sourceCounts?.map(
        (entry: { source?: string; files?: number; chunks?: number }) => ({
          source: entry.source ?? "unknown",
          files:
            typeof entry.files === "number" && Number.isFinite(entry.files)
              ? Math.max(0, Math.trunc(entry.files))
              : 0,
          chunks:
            typeof entry.chunks === "number" && Number.isFinite(entry.chunks)
              ? Math.max(0, Math.trunc(entry.chunks))
              : 0,
        }),
      ) ??
      previousStatus?.sourceCounts ??
      [];
    const indexedFiles =
      typeof liveStatus?.files === "number" && Number.isFinite(liveStatus.files)
        ? Math.max(0, Math.trunc(liveStatus.files))
        : (previousStatus?.indexedFiles ??
          sourceCounts.reduce((total, entry) => total + entry.files, 0));
    const indexedChunks =
      typeof liveStatus?.chunks === "number" &&
      Number.isFinite(liveStatus.chunks)
        ? Math.max(0, Math.trunc(liveStatus.chunks))
        : (previousStatus?.indexedChunks ??
          sourceCounts.reduce((total, entry) => total + entry.chunks, 0));
    const embeddingProvider =
      typeof liveStatus?.provider === "string"
        ? liveStatus.provider
        : (previousStatus?.embeddingProvider ?? configuredProvider);
    const embeddingRequestedProvider =
      typeof liveStatus?.requestedProvider === "string"
        ? liveStatus.requestedProvider
        : (previousStatus?.embeddingRequestedProvider ?? configuredProvider);
    const embeddingModel =
      typeof liveStatus?.model === "string"
        ? liveStatus.model
        : (previousStatus?.embeddingModel ?? configuredModel);
    const embeddingProbeOk =
      typeof liveMemoryStatus?.embeddingProbe?.ok === "boolean"
        ? liveMemoryStatus.embeddingProbe.ok
        : (previousStatus?.embeddingProbeOk ?? null);
    const embeddingProbeError =
      typeof liveMemoryStatus?.embeddingProbe?.error === "string"
        ? liveMemoryStatus.embeddingProbe.error
        : typeof liveStatus?.providerUnavailableReason === "string"
          ? liveStatus.providerUnavailableReason
          : (previousStatus?.embeddingProbeError ?? null);
    const vectorEnabled =
      liveStatus?.vector?.enabled ?? previousStatus?.vectorEnabled ?? false;
    const vectorAvailable =
      liveStatus?.vector?.available ?? previousStatus?.vectorAvailable ?? false;
    const prepareStatus = await appStateService.getMemoryPrepareStatus();
    const scaffoldReady =
      memoryDirectoryReady &&
      skillsDirectoryReady &&
      bootstrapFilesReady === bootstrapFiles.length;
    const semanticReady =
      scaffoldReady &&
      cacheConfig?.enabled === true &&
      embeddingProvider === "ollama" &&
      embeddingRequestedProvider === "ollama" &&
      Boolean(embeddingModel) &&
      vectorEnabled &&
      vectorAvailable &&
      embeddingProbeOk !== false &&
      !embeddingProbeError;

    const status = MemoryStatusSchema.parse({
      configuredWorkspaceRoot: runtimeSettings.workspaceRoot ?? null,
      effectiveWorkspaceRoot: workspaceRoot,
      ready: scaffoldReady,
      semanticReady,
      memoryDirectory,
      memoryDirectoryReady,
      skillsDirectory,
      skillsDirectoryReady,
      memoryFilePath: path.join(workspaceRoot, "MEMORY.md"),
      todayNotePath: path.join(memoryDirectory, `${todayMemoryNoteName()}.md`),
      bootstrapFiles,
      bootstrapFilesReady,
      bootstrapFilesTotal: bootstrapFiles.length,
      memorySearchEnabled: cacheConfig?.enabled === true,
      sessionMemoryEnabled: experimentalConfig?.sessionMemory === true,
      embeddingProvider,
      embeddingRequestedProvider,
      embeddingFallback: configuredFallback,
      embeddingModel,
      indexedFiles,
      indexedChunks,
      dirty: liveStatus?.dirty ?? previousStatus?.dirty ?? false,
      vectorEnabled,
      vectorAvailable,
      embeddingProbeOk,
      embeddingProbeError,
      sourceCounts,
      contextWindow,
      prepareState: prepareStatus.state,
      prepareStartedAt: prepareStatus.startedAt,
      prepareFinishedAt: prepareStatus.finishedAt,
      prepareProgressLabel: prepareStatus.progressLabel,
      prepareError: prepareStatus.error,
      lastPrepareDurationMs: prepareStatus.lastDurationMs,
    });
    service.lastKnownMemoryStatus = status;
    return status;
  },

  async ensureConfigured(this: OpenClawService): Promise<void> {
    const service = this as unknown as OpenClawMemoryService;
    if (service.ensureConfiguredPromise) {
      await service.ensureConfiguredPromise;
      return;
    }

    service.ensureConfiguredPromise = service
      .ensureConfiguredInternal()
      .finally(() => {
        service.ensureConfiguredPromise = null;
      });
    await service.ensureConfiguredPromise;
  },

  async ensureConfiguredInternal(this: OpenClawService): Promise<void> {
    const service = this as unknown as OpenClawMemoryService;
    fs.mkdirSync(paths.openClawHomeDir, { recursive: true });
    fs.mkdirSync(paths.openClawStateDir, { recursive: true });
    await service.ensureOpenClawEnvFile("OLLAMA_API_KEY=ollama-local\n");
    const runtimeSettings = await appStateService.getRuntimeSettings();
    const workspaceRoot = service.resolveWorkspaceRoot(runtimeSettings);
    await service.ensureWorkspaceScaffold(workspaceRoot);
    const multimodalConfig =
      await service.resolveOllamaMultimodalConfig(runtimeSettings);
    const gatewayToken = await service.ensureGatewayToken();

    const desiredConfig: Array<[string, unknown]> = [
      ["gateway.mode", "local"],
      ["gateway.port", OPENCLAW_GATEWAY_PORT],
      ["gateway.bind", "loopback"],
      ["gateway.auth.mode", "token"],
      ["gateway.remote.url", OPENCLAW_GATEWAY_URL],
      ["gateway.tailscale.mode", "off"],
      ["gateway.http.endpoints.chatCompletions.enabled", true],
      ["agents.defaults.workspace", workspaceRoot],
      [
        "agents.defaults.model.primary",
        service.resolvePrimaryModel(runtimeSettings),
      ],
      [
        "agents.defaults.imageModel.primary",
        `ollama/${multimodalConfig.attachmentModelId}`,
      ],
      [
        "agents.defaults.pdfModel.primary",
        `ollama/${multimodalConfig.attachmentModelId}`,
      ],
      ["agents.defaults.thinkingDefault", "off"],
      ["tools.profile", "coding"],
      ["tools.allow", ["pdf"]],
      ["models.providers.ollama", multimodalConfig.providerConfig],
      [
        "agents.defaults.memorySearch",
        service.buildMemorySearchConfig(runtimeSettings),
      ],
      ["tools.exec.host", "gateway"],
      ["tools.exec.security", "allowlist"],
      ["tools.exec.ask", "on-miss"],
      ["tools.fs.workspaceOnly", true],
      [
        "hooks.internal.entries.bootstrap-extra-files.paths",
        WORKSPACE_BOOTSTRAP_EXTRA_FILES,
      ],
      ["channels.signal.dmPolicy", "pairing"],
      ["channels.signal.groupPolicy", "disabled"],
      [
        "channels.signal.enabled",
        runtimeSettings.signalRegistrationState === "registered",
      ],
    ];

    const currentConfig = service.readCurrentConfig();
    const desiredFingerprint = hashConfigFingerprint({
      desiredConfig,
      gatewayToken,
      runtimeSettings: {
        activeProviderId: runtimeSettings.activeProviderId,
        ollamaModel: runtimeSettings.ollamaModel,
        ollamaContextWindow: runtimeSettings.ollamaContextWindow,
        llamaCppModel: runtimeSettings.llamaCppModel,
        llamaCppContextWindow: runtimeSettings.llamaCppContextWindow,
        smartContextManagementEnabled:
          runtimeSettings.smartContextManagementEnabled,
        cloudProviders: runtimeSettings.cloudProviders,
      },
    });

    if (
      currentConfig &&
      service.lastConfiguredHash === desiredFingerprint &&
      service.lastConfiguredConfigMtimeMs === service.cachedConfigMtimeMs
    ) {
      service.invalidateMemoryStatusCache();
      return;
    }

    let nextConfig = currentConfig;
    for (const [key, value] of desiredConfig) {
      nextConfig = await service.setConfigValueIfNeeded(nextConfig, key, value);
    }

    nextConfig = await service.setConfigValueIfNeeded(
      nextConfig,
      "gateway.auth.token",
      gatewayToken,
    );
    nextConfig = await service.setConfigValueIfNeeded(
      nextConfig,
      "gateway.remote.token",
      gatewayToken,
    );

    await service.applyContextManagementPolicy({}, nextConfig);
    service.lastConfiguredHash = desiredFingerprint;
    service.lastConfiguredConfigMtimeMs = service.cachedConfigMtimeMs;
    service.invalidateMemoryStatusCache();
  },

  async prepareWorkspaceContext(this: OpenClawService): Promise<MemoryStatus> {
    const service = this as unknown as OpenClawMemoryService;
    await service.prepareWorkspaceScaffold();
    return await service.currentMemoryStatus();
  },

  async prepareWorkspaceScaffold(this: OpenClawService) {
    const service = this as unknown as OpenClawMemoryService;
    const runtimeSettings = await appStateService.getRuntimeSettings();
    const workspaceRoot = service.resolveWorkspaceRoot(runtimeSettings);
    await service.ensureWorkspaceScaffold(workspaceRoot);
    service.invalidateMemoryStatusCache();
    const memoryDirectory = path.join(workspaceRoot, "memory");
    return {
      workspaceRoot,
      memoryDirectory,
      memoryFilePath: path.join(workspaceRoot, "MEMORY.md"),
      preferencesFilePath: path.join(workspaceRoot, "PREFERENCES.md"),
      todayNotePath: path.join(memoryDirectory, `${todayMemoryNoteName()}.md`),
    };
  },

  async prepareSemanticMemory(
    this: OpenClawService,
    params: { reindex?: boolean } = {},
  ): Promise<MemoryStatus> {
    const service = this as unknown as OpenClawMemoryService;
    const runtimeSettings = await appStateService.getRuntimeSettings();
    const workspaceRoot = service.resolveWorkspaceRoot(runtimeSettings);
    await service.ensureWorkspaceScaffold(workspaceRoot);
    await service.ensureConfigured();
    await service.loadOpenClawMemoryStatus({
      deep: true,
      index: params.reindex ?? false,
    });
    service.invalidateMemoryStatusCache();
    return await service.currentMemoryStatus({
      liveQuery: "deep",
    });
  },

  async reindexMemory(
    this: OpenClawService,
    params: { force?: boolean } = {},
  ): Promise<MemoryStatus> {
    const service = this as unknown as OpenClawMemoryService;
    const runtimeSettings = await appStateService.getRuntimeSettings();
    const workspaceRoot = service.resolveWorkspaceRoot(runtimeSettings);
    await service.ensureWorkspaceScaffold(workspaceRoot);
    await service.ensureConfigured();
    const metric = performanceService.start("server", "memory.reindex", {
      force: params.force === true,
    });
    const args = ["memory", "index"];
    if (params.force) {
      args.push("--force");
    }
    try {
      await service.execOpenClaw(args, true);
      service.invalidateMemoryStatusCache();
      const status = await service.currentMemoryStatus({
        liveQuery: "deep",
      });
      metric.finish({
        outcome: "ok",
        indexedFiles: status.indexedFiles,
        indexedChunks: status.indexedChunks,
        dirty: status.dirty,
      });
      return status;
    } catch (error) {
      metric.finish({ outcome: "error" });
      throw error;
    }
  },

  async memoryStatus(this: OpenClawService): Promise<MemoryStatus> {
    const service = this as unknown as OpenClawMemoryService;
    return await service.memoryStatusCache.get(async () => {
      const runtimeSettings = await appStateService.getRuntimeSettings();
      const workspaceRoot = service.resolveWorkspaceRoot(runtimeSettings);
      await service.ensureWorkspaceScaffold(workspaceRoot);
      return await service.currentMemoryStatus({
        liveQuery: "shallow",
      });
    });
  },

  async memoryStatusQuick(this: OpenClawService): Promise<MemoryStatus> {
    const service = this as unknown as OpenClawMemoryService;
    const runtimeSettings = await appStateService.getRuntimeSettings();
    const workspaceRoot = service.resolveWorkspaceRoot(runtimeSettings);
    await service.ensureWorkspaceScaffold(workspaceRoot);
    return await service.currentMemoryStatus({
      liveQuery: "skip",
    });
  },

  async ensureTodayMemoryNote(this: OpenClawService): Promise<string> {
    const service = this as unknown as OpenClawMemoryService;
    const runtimeSettings = await appStateService.getRuntimeSettings();
    const workspaceRoot = service.resolveWorkspaceRoot(runtimeSettings);
    await service.ensureWorkspaceScaffold(workspaceRoot);
    const date = todayMemoryNoteName();
    const notePath = path.join(workspaceRoot, "memory", `${date}.md`);
    try {
      await fs.promises.access(notePath, fs.constants.F_OK);
    } catch {
      await fs.promises.writeFile(
        notePath,
        todayMemoryNoteTemplate(date),
        "utf8",
      );
    }
    service.invalidateMemoryStatusCache();
    return notePath;
  },

  async harnessStatus(this: OpenClawService): Promise<HarnessStatus> {
    const service = this as unknown as OpenClawMemoryService;
    const runtimeSettings = await appStateService.getRuntimeSettings();
    const currentConfig = service.readCurrentConfig();
    const toolProfile = resolveHarnessToolProfile(
      getConfigPathValue(currentConfig, "tools.profile") ?? "coding",
    );
    const memorySearchConfig = getConfigPathValue(
      currentConfig,
      "agents.defaults.memorySearch",
    ) as Record<string, unknown> | null;
    const cacheConfig =
      memorySearchConfig &&
      typeof memorySearchConfig === "object" &&
      !Array.isArray(memorySearchConfig)
        ? (memorySearchConfig.cache as Record<string, unknown> | undefined)
        : undefined;
    const experimentalConfig =
      memorySearchConfig &&
      typeof memorySearchConfig === "object" &&
      !Array.isArray(memorySearchConfig)
        ? (memorySearchConfig.experimental as
            | Record<string, unknown>
            | undefined)
        : undefined;

    return HarnessStatusSchema.parse({
      configured: currentConfig !== null,
      agentId: "main",
      defaultSessionId: DEFAULT_WEB_SESSION_ID,
      gatewayAuthMode:
        typeof getConfigPathValue(currentConfig, "gateway.auth.mode") ===
        "string"
          ? (getConfigPathValue(currentConfig, "gateway.auth.mode") as string)
          : "token",
      gatewayBind:
        typeof getConfigPathValue(currentConfig, "gateway.bind") === "string"
          ? (getConfigPathValue(currentConfig, "gateway.bind") as string)
          : "loopback",
      activeModel: service.resolvePrimaryModel(runtimeSettings),
      contextWindow: resolveContextWindow({
        providerId: runtimeSettings.activeProviderId,
        runtimeSettings,
      }),
      thinkingDefault:
        typeof getConfigPathValue(
          currentConfig,
          "agents.defaults.thinkingDefault",
        ) === "string"
          ? (getConfigPathValue(
              currentConfig,
              "agents.defaults.thinkingDefault",
            ) as string)
          : "off",
      imageModel: resolveModelRef(
        getConfigPathValue(currentConfig, "agents.defaults.imageModel"),
      ),
      pdfModel: resolveModelRef(
        getConfigPathValue(currentConfig, "agents.defaults.pdfModel"),
      ),
      workspaceRoot: service.resolveWorkspaceRoot(runtimeSettings),
      toolProfile,
      availableTools: resolveProfileTools(toolProfile, currentConfig),
      workspaceOnlyFs:
        getConfigPathValue(currentConfig, "tools.fs.workspaceOnly") === true,
      memorySearchEnabled: cacheConfig?.enabled === true,
      sessionMemoryEnabled: experimentalConfig?.sessionMemory === true,
      attachmentsEnabled:
        resolveModelRef(
          getConfigPathValue(currentConfig, "agents.defaults.imageModel"),
        ) !== null,
      execHost:
        typeof getConfigPathValue(currentConfig, "tools.exec.host") === "string"
          ? (getConfigPathValue(currentConfig, "tools.exec.host") as string)
          : null,
      execSecurity:
        typeof getConfigPathValue(currentConfig, "tools.exec.security") ===
        "string"
          ? (getConfigPathValue(currentConfig, "tools.exec.security") as string)
          : null,
      execAsk:
        typeof getConfigPathValue(currentConfig, "tools.exec.ask") === "string"
          ? (getConfigPathValue(currentConfig, "tools.exec.ask") as string)
          : null,
    });
  },

  async contextManagementStatus(
    this: OpenClawService,
  ): Promise<ContextManagementStatus> {
    const service = this as unknown as OpenClawMemoryService;
    return await service.currentContextManagementStatus();
  },

  async setSmartContextManagement(
    this: OpenClawService,
    enabled: boolean,
  ): Promise<ContextManagementStatus> {
    const service = this as unknown as OpenClawMemoryService;
    await appStateService.updateRuntimeSettings({
      smartContextManagementEnabled: enabled,
    });
    await service.applyContextManagementPolicy();
    return await service.contextManagementStatus();
  },

  async configureRuntimeModel(
    this: OpenClawService,
    config: HarnessRuntimeModelConfig,
  ): Promise<void> {
    const service = this as unknown as OpenClawMemoryService;
    if (config.providerId === "ollama-default") {
      const modelId = config.modelId.startsWith("ollama/")
        ? config.modelId.slice("ollama/".length)
        : config.modelId;
      const runtimeSettings = await appStateService.getRuntimeSettings();
      const contextWindow =
        typeof config.contextWindow === "number"
          ? config.contextWindow
          : runtimeSettings.ollamaContextWindow;
      await appStateService.updateRuntimeSettings({
        ollamaModel: modelId,
        ollamaContextWindow: contextWindow,
      });
      let nextConfig = service.readCurrentConfig();
      const multimodalConfig = await service.resolveOllamaMultimodalConfig({
        ...runtimeSettings,
        ollamaModel: modelId,
        ollamaContextWindow: contextWindow,
      });
      nextConfig = await service.setConfigValueIfNeeded(
        nextConfig,
        "agents.defaults.model.primary",
        `ollama/${modelId}`,
      );
      nextConfig = await service.setConfigValueIfNeeded(
        nextConfig,
        "agents.defaults.imageModel.primary",
        `ollama/${multimodalConfig.attachmentModelId}`,
      );
      nextConfig = await service.setConfigValueIfNeeded(
        nextConfig,
        "agents.defaults.pdfModel.primary",
        `ollama/${multimodalConfig.attachmentModelId}`,
      );
      await service.setConfigValueIfNeeded(
        nextConfig,
        "models.providers.ollama",
        multimodalConfig.providerConfig,
      );
      await service.selectOllamaModel(modelId);
      await service.applyContextManagementPolicy({
        providerId: "ollama-default",
        modelId,
        contextWindow,
      });
      return;
    }

    if (config.providerId === "llamacpp-default") {
      await service.registerLlamaCppProvider(
        config.modelId,
        config.contextWindow ?? 8192,
      );
      await service.applyContextManagementPolicy({
        providerId: "llamacpp-default",
        modelId: config.modelId,
        contextWindow: config.contextWindow ?? 8192,
      });
      return;
    }

    await service.selectPrimaryModel(config.modelId);
    await service.applyContextManagementPolicy(config);
  },
};

export type OpenClawMemoryMethods = typeof openClawMemoryMethods;
