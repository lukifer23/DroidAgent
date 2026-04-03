import fs from "node:fs";
import path from "node:path";

import {
  QuickstartResultSchema,
  type QuickstartResult,
} from "@droidagent/shared";

import {
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_VISION_MODEL,
  appStateService,
} from "./app-state-service.js";
import { ollamaModelSupportsVision } from "../lib/ollama.js";
import { accessService } from "./access-service.js";
import {
  openclawMemoryFacet,
  openclawRuntimeFacet,
  openclawWorkspaceFacet,
} from "./openclaw-service-facets.js";
import { runtimeService } from "./runtime-service.js";

function expandHomePath(input: string): string {
  if (input === "~") {
    return process.env.HOME ?? input;
  }
  if (input.startsWith("~/")) {
    return path.join(process.env.HOME ?? "~", input.slice(2));
  }
  return input;
}

function resolveWorkspaceRoot(
  input: string | null | undefined,
  current: string | null,
): string {
  const trimmedInput = input?.trim() ?? "";
  const candidate =
    (trimmedInput === "." && current ? current : trimmedInput) ||
    current ||
    process.cwd();
  return path.resolve(expandHomePath(candidate));
}

function isDirectory(input: string): boolean {
  try {
    return fs.statSync(input).isDirectory();
  } catch {
    return false;
  }
}

export class QuickstartService {
  async prepare(
    params: { workspaceRoot?: string | null; modelId?: string | null } = {},
  ): Promise<QuickstartResult> {
    const actions: string[] = [];
    const initialSettings = await appStateService.getRuntimeSettings();
    const workspaceRoot = resolveWorkspaceRoot(
      params.workspaceRoot,
      initialSettings.workspaceRoot,
    );
    const modelId =
      params.modelId?.trim() ||
      initialSettings.ollamaModel ||
      DEFAULT_OLLAMA_MODEL;
    const embeddingModelId =
      initialSettings.ollamaEmbeddingModel || DEFAULT_OLLAMA_EMBEDDING_MODEL;
    const visionModelId = DEFAULT_OLLAMA_VISION_MODEL;

    if (!isDirectory(workspaceRoot)) {
      throw new Error("Workspace root must be an existing directory.");
    }

    if (
      !initialSettings.workspaceRoot ||
      path.resolve(initialSettings.workspaceRoot) !== workspaceRoot
    ) {
      await appStateService.updateRuntimeSettings({
        workspaceRoot,
      });
      await appStateService.markSetupStepCompleted("workspace", {
        workspaceRoot,
      });
      actions.push(`Workspace set to ${workspaceRoot}.`);
    }

    await openclawWorkspaceFacet.prepareWorkspaceContext();
    const initialMemoryStatus = await openclawMemoryFacet.memoryStatus();

    let runtimes = await runtimeService.getRuntimeStatuses();
    let ollama = runtimes.find((runtime) => runtime.id === "ollama");
    let openclaw = runtimes.find((runtime) => runtime.id === "openclaw");

    if (!ollama?.installed) {
      await runtimeService.installRuntime("ollama");
      actions.push("Installed Ollama.");
      runtimes = await runtimeService.getRuntimeStatuses();
      ollama = runtimes.find((runtime) => runtime.id === "ollama");
    }

    if (ollama?.state !== "running") {
      await runtimeService.startRuntime("ollama");
      actions.push("Started Ollama.");
    }

    if (openclaw?.state !== "running") {
      await openclawRuntimeFacet.startGateway();
      actions.push("Started OpenClaw.");
    }

    const runtimeSettings = await appStateService.getRuntimeSettings();
    if (runtimeSettings.selectedRuntime !== "ollama") {
      await appStateService.updateRuntimeSettings({
        selectedRuntime: "ollama",
        activeProviderId: "ollama-default",
      });
      actions.push("Selected Ollama as the default runtime.");
    }

    await appStateService.markSetupStepCompleted("runtime", {
      selectedRuntime: "ollama",
    });
    await appStateService.markSetupStepCompleted("openclaw", {
      selectedRuntime: "ollama",
    });

    let providerProfiles = await runtimeService.listProviderProfiles();
    let ollamaProvider = providerProfiles.find(
      (provider) => provider.id === "ollama-default",
    );
    let currentSettings = await appStateService.getRuntimeSettings();
    const modelMatches =
      ollamaProvider?.model === modelId &&
      currentSettings.ollamaModel === modelId;
    const providerSelected =
      ollamaProvider?.enabled === true &&
      currentSettings.activeProviderId === "ollama-default";

    if (!modelMatches) {
      await runtimeService.pullModel("ollama", modelId);
      await appStateService.markSetupStepCompleted("providerRegistration", {
        selectedRuntime: "ollama",
        selectedModel: modelId,
      });
      actions.push(`Prepared local model ${modelId}.`);
    } else if (
      !providerSelected ||
      currentSettings.selectedRuntime !== "ollama"
    ) {
      await runtimeService.configureOllamaProfile({
        modelId,
        contextWindow: currentSettings.ollamaContextWindow,
      });
      await appStateService.markSetupStepCompleted("providerRegistration", {
        selectedRuntime: "ollama",
        selectedModel: modelId,
      });
      actions.push(`Selected local model ${modelId}.`);
    } else {
      await appStateService.markSetupStepCompleted("models", {
        selectedRuntime: "ollama",
        selectedModel: modelId,
      });
      await appStateService.markSetupStepCompleted("providerRegistration", {
        selectedRuntime: "ollama",
        selectedModel: modelId,
      });
    }

    const embeddingPrepared =
      await runtimeService.ensureOllamaModel(embeddingModelId);
    if (embeddingPrepared) {
      actions.push(`Prepared local embedding model ${embeddingModelId}.`);
    }
    const primarySupportsVision = await ollamaModelSupportsVision(modelId);
    if (!primarySupportsVision) {
      const visionPrepared =
        await runtimeService.ensureOllamaModel(visionModelId);
      if (visionPrepared) {
        actions.push(`Prepared local multimodal model ${visionModelId}.`);
      }
    }

    const memoryStatus = await openclawMemoryFacet.prepareSemanticMemory({
      reindex: true,
    });
    if (!initialMemoryStatus.semanticReady && memoryStatus.semanticReady) {
      actions.push(
        `Enabled local semantic memory with ${memoryStatus.embeddingModel ?? embeddingModelId}.`,
      );
    }

    let access = await accessService.getBootstrapState();
    let phoneUrl = access.canonicalOrigin?.origin ?? null;
    let remotePendingReason: string | null = null;

    if (access.tailscaleStatus.authenticated) {
      const tailscaleReady =
        access.serveStatus.enabled &&
        access.serveStatus.source === "tailscale" &&
        access.canonicalOrigin?.source === "tailscaleServe" &&
        Boolean(access.canonicalOrigin.origin);

      if (!tailscaleReady) {
        const result = await accessService.enableTailscaleServe();
        phoneUrl = result.canonicalOrigin.origin;
        actions.push("Created the phone URL through Tailscale.");
      } else {
        phoneUrl =
          access.canonicalOrigin?.origin ?? access.tailscaleStatus.canonicalUrl;
      }
    } else {
      remotePendingReason =
        "Sign in to Tailscale on this Mac to create the phone URL automatically.";
    }

    access = await accessService.getBootstrapState();
    phoneUrl = access.canonicalOrigin?.origin ?? phoneUrl;

    const [finalSettings, finalRuntimes, finalProviders] = await Promise.all([
      appStateService.getRuntimeSettings(),
      runtimeService.getRuntimeStatuses(),
      runtimeService.listProviderProfiles(),
    ]);
    const finalOllama = finalRuntimes.find(
      (runtime) => runtime.id === "ollama",
    );
    const finalOpenclaw = finalRuntimes.find(
      (runtime) => runtime.id === "openclaw",
    );
    const finalOllamaProvider = finalProviders.find(
      (provider) => provider.id === "ollama-default",
    );
    const hostReady = Boolean(
      finalSettings.workspaceRoot &&
      finalSettings.selectedRuntime === "ollama" &&
      finalSettings.activeProviderId === "ollama-default" &&
      finalSettings.ollamaModel === modelId &&
      finalOllama?.state === "running" &&
      finalOpenclaw?.state === "running" &&
      finalOllamaProvider?.enabled &&
      finalOllamaProvider.model === modelId &&
      memoryStatus.semanticReady,
    );
    const remoteReady = Boolean(
      access.canonicalOrigin?.origin &&
      access.serveStatus.enabled &&
      (access.serveStatus.source === "tailscale" ||
        access.serveStatus.source === "cloudflare"),
    );

    if (actions.length === 0) {
      actions.push(
        remoteReady
          ? "DroidAgent was already ready."
          : "This Mac was already ready.",
      );
    }

    return QuickstartResultSchema.parse({
      hostReady,
      remoteReady,
      workspaceRoot,
      modelId,
      phoneUrl,
      actions,
      remotePendingReason: remoteReady ? null : remotePendingReason,
    });
  }
}

export const quickstartService = new QuickstartService();
