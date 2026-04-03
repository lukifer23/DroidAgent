import path from "node:path";

import type { SetupState } from "@droidagent/shared";

import { appStateService } from "./app-state-service.js";
import { harnessService } from "./harness-service.js";

export interface ApplyLlamaCppProfileOptions {
  hfRepo: string;
  contextWindow?: number | null;
  afterApply?: (() => Promise<void> | void) | null;
  setupStep?: SetupState["currentStep"];
}

function normalizeHuggingFaceRepoUrl(hfRepo: string): string | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(hfRepo);
  } catch {
    return null;
  }

  if (!/^huggingface\.co$/i.test(parsedUrl.hostname)) {
    return null;
  }

  const segments = parsedUrl.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length < 5 || segments[2] !== "resolve") {
    return null;
  }

  const owner = segments[0];
  const repo = segments[1];
  const fileName = segments.at(-1) ?? "";
  const quantMatch = fileName.match(/-([A-Za-z0-9_]+)\.gguf$/i);
  if (!owner || !repo || !quantMatch?.[1]) {
    return null;
  }

  return `${owner}/${repo}:${quantMatch[1].toUpperCase()}`;
}

function normalizeHfRepo(hfRepo: string): string {
  const normalized = hfRepo.trim();
  if (!normalized) {
    throw new Error("A llama.cpp Hugging Face repo is required.");
  }
  return normalizeHuggingFaceRepoUrl(normalized) ?? normalized;
}

function normalizeContextWindow(
  contextWindow: number | null | undefined,
  fallback: number,
): number {
  if (contextWindow == null) {
    return fallback;
  }
  if (!Number.isFinite(contextWindow)) {
    throw new Error("Context window must be a finite number.");
  }
  const normalized = Math.floor(contextWindow);
  if (normalized < 2048) {
    throw new Error("Context window must be at least 2048 tokens.");
  }
  return normalized;
}

export function llamaCppProfileModelId(hfRepo: string): string {
  return path.basename(normalizeHfRepo(hfRepo).replace(/\/+$/u, "")).toLowerCase();
}

export async function applyLlamaCppProfile(
  options: ApplyLlamaCppProfileOptions,
): Promise<{ hfRepo: string; contextWindow: number; modelId: string }> {
  const hfRepo = normalizeHfRepo(options.hfRepo);
  const currentSettings = await appStateService.getRuntimeSettings();
  const contextWindow = normalizeContextWindow(
    options.contextWindow,
    currentSettings.llamaCppContextWindow,
  );
  const modelId = llamaCppProfileModelId(hfRepo);

  await appStateService.updateRuntimeSettings({
    selectedRuntime: "llamaCpp",
    activeProviderId: "llamacpp-default",
    llamaCppModel: hfRepo,
    llamaCppContextWindow: contextWindow,
  });
  await harnessService.configureRuntimeModel({
    providerId: "llamacpp-default",
    modelId,
    contextWindow,
  });
  await appStateService.markSetupStepCompleted(options.setupStep ?? "models", {
    selectedRuntime: "llamaCpp",
    selectedModel: hfRepo,
  });

  if (options.afterApply) {
    await options.afterApply();
  }

  return {
    hfRepo,
    contextWindow,
    modelId,
  };
}
