import fs from "node:fs";
import path from "node:path";

import type { Hono } from "hono";

import {
  MaintenanceRunRequestSchema,
  MemoryDraftApplyRequestSchema,
  MemoryDraftCreateRequestSchema,
  MemoryDraftDismissRequestSchema,
  MemoryDraftUpdateRequestSchema,
} from "@droidagent/shared";
import { z } from "zod";

import { accessService } from "../services/access-service.js";
import { appStateService } from "../services/app-state-service.js";
import { decisionService } from "../services/decision-service.js";
import { harnessService } from "../services/harness-service.js";
import { keychainService } from "../services/keychain-service.js";
import { maintenanceService } from "../services/maintenance-service.js";
import { memoryDraftService } from "../services/memory-draft-service.js";
import { memoryPrepareService } from "../services/memory-prepare-service.js";
import { openclawOperationsFacet } from "../services/openclaw-service-facets.js";
import { performanceService } from "../services/performance-service.js";
import { quickstartService } from "../services/quickstart-service.js";
import { runtimeService } from "../services/runtime-service.js";
import { signalService } from "../services/signal-service.js";
import { startupService } from "../services/startup-service.js";
import { terminalService } from "../services/terminal-service.js";
import { websocketHub } from "../websocket-hub.js";
import {
  expandHomePath,
  getDecisionActor,
  mutationGuard,
  requireUser,
  type AppVariables,
} from "./route-support.js";

type CloudProviderId =
  | "openai"
  | "anthropic"
  | "openrouter"
  | "gemini"
  | "groq"
  | "together"
  | "xai";

type RuntimeId = "ollama" | "llamaCpp" | "openclaw";

const MaintenanceRecoveryActionSchema = z.enum([
  "retryVerify",
  "refreshHarnessHealth",
  "reconnectResync",
  "clearStaleMaintenanceState",
  "restartRuntime",
  "restartAppShell",
]);

const OllamaProfileRequestSchema = z.object({
  modelId: z.string().trim().min(1),
  contextWindow: z.number().int().min(2048).max(262144).optional(),
  pull: z.boolean().optional(),
});

const LlamaCppProfileRequestSchema = z.object({
  hfRepo: z.string().trim().min(1),
  contextWindow: z.number().int().min(2048).max(262144).optional(),
});

function buildSignalRegistrationRequest(body: {
  phoneNumber: string;
  autoInstall?: boolean;
  useVoice?: boolean;
  captcha?: string;
  reregister?: boolean;
}) {
  const request: {
    phoneNumber: string;
    autoInstall?: boolean;
    useVoice?: boolean;
    captcha?: string;
    reregister?: boolean;
  } = {
    phoneNumber: body.phoneNumber,
  };
  if (typeof body.autoInstall === "boolean") {
    request.autoInstall = body.autoInstall;
  }
  if (typeof body.useVoice === "boolean") {
    request.useVoice = body.useVoice;
  }
  if (body.captcha?.trim()) {
    request.captcha = body.captcha.trim();
  }
  if (typeof body.reregister === "boolean") {
    request.reregister = body.reregister;
  }
  return request;
}

export function registerOperationsRoutes(
  app: Hono<{ Variables: AppVariables }>,
) {
  const perfReadyFile = process.env.DROIDAGENT_PERF_READY_FILE ?? null;

  app.get("/api/terminal/session", async (c) => {
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    return c.json(await terminalService.getSnapshot());
  });

  app.post("/api/terminal/session", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    await maintenanceService.assertAllowsNewWork("terminal");
    const body = (await c.req.json()) as {
      scope?: "workspace" | "host";
      cwd?: string;
      cols?: number;
      rows?: number;
      confirmHostAccess?: boolean;
    };
    if (body.scope === "host" && !body.confirmHostAccess) {
      return c.json(
        {
          error: "Host shell access requires explicit confirmation.",
        },
        400,
      );
    }
    return c.json(
      await terminalService.createSession({
        scope: body.scope === "host" ? "host" : "workspace",
        cwd: body.cwd,
        cols: body.cols,
        rows: body.rows,
        confirmHostAccess: body.confirmHostAccess,
        userId: c.get("user")?.id,
      }),
      201,
    );
  });

  app.delete("/api/terminal/session/:sessionId", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    await terminalService.closeSession(c.req.param("sessionId"));
    return c.json({ ok: true });
  });

  app.get("/api/memory/status", async (c) => {
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    return c.json(await openclawOperationsFacet.prepareWorkspaceContext());
  });

  app.get("/api/memory/prepare-status", async (c) => {
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    return c.json(await appStateService.getMemoryPrepareStatus());
  });

  app.get("/api/memory/drafts", async (c) => {
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    return c.json(await memoryDraftService.listDrafts());
  });

  app.post("/api/memory/drafts", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    const body = MemoryDraftCreateRequestSchema.parse(await c.req.json());
    const draft = await memoryDraftService.createDraft(body);
    await decisionService.syncMemoryDraftDecision(draft);
    await websocketHub.publishMemoryDraftsUpdated();
    return c.json(draft, 201);
  });

  app.patch("/api/memory/drafts/:draftId", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    const body = MemoryDraftUpdateRequestSchema.parse(await c.req.json());
    const draft = await memoryDraftService.updateDraft(
      c.req.param("draftId"),
      body,
    );
    await decisionService.syncMemoryDraftDecision(draft);
    await websocketHub.publishMemoryDraftsUpdated();
    return c.json(draft);
  });

  app.post("/api/memory/drafts/:draftId/apply", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    const body = MemoryDraftApplyRequestSchema.parse(await c.req.json());
    const actor = await getDecisionActor(c);
    const result = await memoryDraftService.applyDraft(
      c.req.param("draftId"),
      body,
    );
    await decisionService.syncResolvedMemoryDraftDecision(result.draft, actor);
    await Promise.all([
      websocketHub.publishMemoryDraftsUpdated(),
      websocketHub.publishMemoryUpdated(),
    ]);
    return c.json(result);
  });

  app.post("/api/memory/drafts/:draftId/dismiss", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    const body = MemoryDraftDismissRequestSchema.parse(await c.req.json());
    const actor = await getDecisionActor(c);
    const draft = await memoryDraftService.dismissDraft(
      c.req.param("draftId"),
      body,
    );
    await decisionService.syncResolvedMemoryDraftDecision(draft.draft, actor);
    await websocketHub.publishMemoryDraftsUpdated();
    return c.json(draft);
  });

  app.post("/api/memory/prepare", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    const settings = await appStateService.getRuntimeSettings();
    const prepareSource =
      perfReadyFile && !fs.existsSync(perfReadyFile) ? "prewarm" : "operator";
    const metric = performanceService.start("server", "memory.prepare", {
      runtime: settings.selectedRuntime,
      embeddingModel: settings.ollamaEmbeddingModel,
      reindex: true,
      source: prepareSource,
    });
    try {
      const { status, started } = await memoryPrepareService.triggerPrepare({
        source: prepareSource,
      });
      metric.finish({
        semanticReady: status.semanticReady,
        indexedFiles: status.indexedFiles,
        indexedChunks: status.indexedChunks,
        dirty: status.dirty,
        started,
      });
      void Promise.all([websocketHub.publishUpdates("memory", "setup")]).catch(
        (error) => {
          console.error("Failed to publish memory prepare updates", error);
        },
      );
      return c.json(status, started ? 202 : 200);
    } catch (error) {
      metric.finish({
        outcome: "error",
      });
      throw error;
    }
  });

  app.post("/api/memory/today-note", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    const metric = performanceService.start("server", "memory.todayNote");
    try {
      const [notePath, status] = await Promise.all([
        openclawOperationsFacet.ensureTodayMemoryNote(),
        openclawOperationsFacet.memoryStatus(),
      ]);
      metric.finish({
        workspaceRoot: status.effectiveWorkspaceRoot,
      });
      await websocketHub.publishMemoryUpdated();
      return c.json({
        path: path.relative(status.effectiveWorkspaceRoot, notePath) || ".",
      });
    } catch (error) {
      metric.finish({
        outcome: "error",
      });
      throw error;
    }
  });

  app.get("/api/maintenance/status", async (c) => {
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    return c.json(await maintenanceService.getStatus());
  });

  app.post("/api/maintenance/run", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    const body = MaintenanceRunRequestSchema.parse(await c.req.json());
    const operation = await maintenanceService.requestOperation({
      scope: body.scope,
      action: body.action,
      requestedByUserId: c.get("user")?.id ?? null,
      requestedFromLocalhost: accessService.isLocalhostRequest(c),
    });
    await Promise.all([
      websocketHub.publishMaintenanceUpdated(),
      websocketHub.publishSessionsUpdated(),
    ]);
    return c.json(operation, 202);
  });

  app.post("/api/maintenance/recover", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    const body = (await c.req.json()) as { action: string };
    const action = MaintenanceRecoveryActionSchema.parse(body.action);

    let result: unknown = null;
    if (action === "retryVerify") {
      result = await maintenanceService.retryVerification();
      await Promise.all([
        websocketHub.publishMaintenanceUpdated(),
        websocketHub.publishSessionsUpdated(),
      ]);
    } else if (action === "refreshHarnessHealth") {
      await openclawOperationsFacet.status();
      await websocketHub.publishRuntimeUpdated();
      result = { refreshed: true };
    } else if (action === "reconnectResync") {
      await websocketHub.refreshAll();
      result = { resynced: true };
    } else if (action === "clearStaleMaintenanceState") {
      result = await maintenanceService.clearStaleState();
      await Promise.all([
        websocketHub.publishMaintenanceUpdated(),
        websocketHub.publishSessionsUpdated(),
      ]);
    } else if (action === "restartRuntime") {
      const settings = await appStateService.getRuntimeSettings();
      await runtimeService.stopRuntime(settings.selectedRuntime);
      await runtimeService.startRuntime(settings.selectedRuntime);
      await Promise.all([
        websocketHub.publishRuntimeUpdated(),
        websocketHub.publishProvidersUpdated(),
      ]);
      result = { runtime: settings.selectedRuntime };
    } else {
      result = await maintenanceService.requestOperation({
        scope: "app",
        action: "restart",
        requestedByUserId: c.get("user")?.id ?? null,
        requestedFromLocalhost: accessService.isLocalhostRequest(c),
      });
      await Promise.all([
        websocketHub.publishMaintenanceUpdated(),
        websocketHub.publishSessionsUpdated(),
      ]);
    }

    return c.json({
      action,
      result,
      maintenance: await maintenanceService.getStatus(),
    });
  });

  app.get("/api/setup", async (c) => {
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    return c.json(await appStateService.getSetupState());
  });

  app.post("/api/setup/quickstart", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    const body = (await c.req.json().catch(() => ({}))) as {
      workspaceRoot?: string;
      modelId?: string;
    };
    const result = await quickstartService.prepare({
      workspaceRoot: body.workspaceRoot ?? null,
      modelId: body.modelId ?? null,
    });
    startupService.invalidate();
    await websocketHub.publishUpdates(
      "setup",
      "access",
      "runtime",
      "providers",
      "memory",
      "context",
    );
    return c.json(result);
  });

  app.post("/api/setup/workspace", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    const body = (await c.req.json()) as { workspaceRoot: string };
    const workspaceRoot = expandHomePath(body.workspaceRoot);
    if (!workspaceRoot || !fs.existsSync(workspaceRoot)) {
      return c.json({ error: "Workspace root does not exist." }, 400);
    }
    await appStateService.updateRuntimeSettings({ workspaceRoot });
    await openclawOperationsFacet.prepareWorkspaceContext();
    const state = await appStateService.markSetupStepCompleted("workspace", {
      workspaceRoot,
    });
    await websocketHub.publishUpdates("setup", "memory");
    return c.json(state);
  });

  app.post("/api/setup/runtime", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    const body = (await c.req.json()) as { runtimeId: "ollama" | "llamaCpp" };
    await runtimeService.installRuntime(body.runtimeId);
    await runtimeService.startRuntime(body.runtimeId);
    await appStateService.updateRuntimeSettings({
      selectedRuntime: body.runtimeId,
    });
    const state = await appStateService.markSetupStepCompleted("runtime", {
      selectedRuntime: body.runtimeId,
    });
    await websocketHub.publishUpdates("setup", "runtime", "providers");
    return c.json(state);
  });

  app.post("/api/setup/model", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    const body = (await c.req.json()) as {
      runtimeId: "ollama" | "llamaCpp";
      modelId: string;
    };
    await runtimeService.pullModel(body.runtimeId, body.modelId);
    await openclawOperationsFacet.startGateway();
    const state = await appStateService.markSetupStepCompleted(
      "providerRegistration",
      {},
    );
    await websocketHub.publishUpdates(
      "setup",
      "runtime",
      "providers",
      "memory",
      "context",
    );
    return c.json(state);
  });

  app.post("/api/setup/signal", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    const body = (await c.req.json()) as {
      phoneNumber: string;
      autoInstall?: boolean;
      useVoice?: boolean;
      captcha?: string;
    };
    await signalService.startRegistration(buildSignalRegistrationRequest(body));
    const state = await appStateService.updateSetupState({
      signalEnabled: true,
    });
    await websocketHub.publishUpdates("setup", "channel");
    return c.json(state);
  });

  app.get("/api/runtime", async (c) => {
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    return c.json(await runtimeService.getRuntimeStatuses());
  });

  app.get("/api/runtime/harness", async (c) => {
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    return c.json(await harnessService.harnessStatus());
  });

  app.post("/api/runtime/:runtimeId/install", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    await runtimeService.installRuntime(c.req.param("runtimeId") as RuntimeId);
    await websocketHub.publishUpdates("runtime", "providers");
    return c.json({ ok: true });
  });

  app.post("/api/runtime/:runtimeId/start", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    await runtimeService.startRuntime(c.req.param("runtimeId") as RuntimeId);
    await websocketHub.publishUpdates("runtime", "providers");
    return c.json({ ok: true });
  });

  app.post("/api/runtime/:runtimeId/stop", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    await runtimeService.stopRuntime(c.req.param("runtimeId") as RuntimeId);
    await websocketHub.publishUpdates("runtime", "providers");
    return c.json({ ok: true });
  });

  app.post("/api/runtime/:runtimeId/models", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    const body = (await c.req.json()) as { modelId: string };
    await runtimeService.pullModel(
      c.req.param("runtimeId") as "ollama" | "llamaCpp",
      body.modelId,
    );
    await websocketHub.publishUpdates(
      "runtime",
      "providers",
      "memory",
      "context",
    );
    return c.json({ ok: true });
  });

  app.post("/api/runtime/ollama/profile", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    const body = OllamaProfileRequestSchema.parse(await c.req.json());
    await runtimeService.configureOllamaProfile({
      modelId: body.modelId,
      ensureModel: body.pull === true,
      ...(body.contextWindow === undefined
        ? {}
        : { contextWindow: body.contextWindow }),
    });
    await websocketHub.publishUpdates(
      "setup",
      "runtime",
      "providers",
      "memory",
      "context",
    );
    return c.json(await runtimeService.listProviderProfiles());
  });

  app.post("/api/runtime/llamacpp/profile", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    const body = LlamaCppProfileRequestSchema.parse(await c.req.json());
    await runtimeService.configureLlamaCppProfile({
      hfRepo: body.hfRepo,
      ...(body.contextWindow === undefined
        ? {}
        : { contextWindow: body.contextWindow }),
    });
    await websocketHub.publishUpdates(
      "setup",
      "runtime",
      "providers",
      "memory",
      "context",
    );
    return c.json(await runtimeService.listProviderProfiles());
  });

  app.post("/api/runtime/context-management", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    const body = (await c.req.json()) as { enabled: boolean };
    const status = await openclawOperationsFacet.setSmartContextManagement(
      body.enabled,
    );
    await websocketHub.publishUpdates("memory", "context");
    return c.json(status);
  });

  app.get("/api/providers", async (c) => {
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    return c.json(await runtimeService.listProviderProfiles());
  });

  app.get("/api/providers/secrets", async (c) => {
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    return c.json(await keychainService.listProviderSummaries());
  });

  app.post("/api/providers/secrets", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    const body = (await c.req.json()) as {
      providerId: CloudProviderId;
      apiKey: string;
      defaultModel?: string;
    };
    await keychainService.setProviderSecret(body.providerId, body.apiKey);
    if (body.defaultModel?.trim()) {
      await keychainService.updateProviderModel(
        body.providerId,
        body.defaultModel.trim(),
      );
    }
    await appStateService.markSetupStepCompleted("cloudProviders");
    await runtimeService.startRuntime("openclaw");
    runtimeService.invalidateCaches();
    await websocketHub.publishUpdates("setup", "runtime", "providers");
    return c.json(await keychainService.listProviderSummaries());
  });

  app.delete("/api/providers/secrets/:providerId", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    const providerId = c.req.param("providerId") as CloudProviderId;
    const settings = await appStateService.getRuntimeSettings();
    await keychainService.deleteProviderSecret(providerId);

    if (settings.activeProviderId === providerId) {
      if (settings.selectedRuntime === "ollama") {
        await appStateService.updateRuntimeSettings({
          activeProviderId: "ollama-default",
        });
        await harnessService.configureRuntimeModel({
          providerId: "ollama-default",
          modelId: settings.ollamaModel,
        });
      } else {
        await appStateService.updateRuntimeSettings({
          activeProviderId: "llamacpp-default",
        });
        await harnessService.configureRuntimeModel({
          providerId: "llamacpp-default",
          modelId: path.basename(settings.llamaCppModel).toLowerCase(),
          contextWindow: settings.llamaCppContextWindow,
        });
      }
    }

    await runtimeService.startRuntime("openclaw");
    runtimeService.invalidateCaches();
    await websocketHub.publishUpdates(
      "runtime",
      "providers",
      "memory",
      "context",
    );
    return c.json(await keychainService.listProviderSummaries());
  });

  app.post("/api/providers/:providerId/select", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    const providerId = c.req.param("providerId") as CloudProviderId;
    const body = (await c.req.json()) as { modelId?: string };
    await keychainService.assertConfigured(providerId);
    const settings = await appStateService.getRuntimeSettings();
    const modelId =
      body.modelId?.trim() || settings.cloudProviders[providerId].defaultModel;
    if (!modelId) {
      return c.json(
        { error: "A model id is required for the selected cloud provider." },
        400,
      );
    }

    await keychainService.updateProviderModel(providerId, modelId);
    await appStateService.updateRuntimeSettings({
      activeProviderId: providerId,
    });
    await harnessService.configureRuntimeModel({
      providerId,
      modelId,
    });
    await appStateService.markSetupStepCompleted("cloudProviders", {
      selectedModel: modelId,
    });
    runtimeService.invalidateCaches();
    await websocketHub.publishUpdates(
      "setup",
      "providers",
      "memory",
      "context",
    );
    return c.json(await runtimeService.listProviderProfiles());
  });
}
