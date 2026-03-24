import fs from "node:fs";
import path from "node:path";

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { WebSocketServer } from "ws";

import { accessService } from "./services/access-service.js";
import { authService } from "./services/auth-service.js";
import { dashboardService } from "./services/dashboard-service.js";
import { FileConflictError, fileService } from "./services/file-service.js";
import { harnessService } from "./services/harness-service.js";
import { jobService } from "./services/job-service.js";
import { keychainService } from "./services/keychain-service.js";
import { launchAgentService } from "./services/launch-agent-service.js";
import { openclawService } from "./services/openclaw-service.js";
import { runtimeService } from "./services/runtime-service.js";
import { appStateService } from "./services/app-state-service.js";
import { signalService } from "./services/signal-service.js";
import { websocketHub } from "./websocket-hub.js";
import { SERVER_PORT, ensureAppDirs, paths } from "./env.js";

ensureAppDirs();

type AppVariables = {
  user: Awaited<ReturnType<typeof authService.getCurrentUser>>;
};

const app = new Hono<{ Variables: AppVariables }>();
app.use("*", logger());
app.use("/api/*", cors());
app.onError((error, c) => {
  console.error(error);
  if (error instanceof FileConflictError) {
    return c.json(
      {
        error: error.message,
        currentModifiedAt: error.currentModifiedAt
      },
      409
    );
  }
  return c.json(
    {
      error: error instanceof Error ? error.message : "Unhandled DroidAgent error."
    },
    500
  );
});

app.use("/api/*", async (c, next) => {
  c.set("user", await authService.getCurrentUser(c));
  await next();
});

async function requireUser(c: Context<{ Variables: AppVariables }>) {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return null;
}

async function requireOwnerOrLocalBootstrap(c: Context<{ Variables: AppVariables }>) {
  const ownerExists = await authService.hasUser();
  if (ownerExists) {
    return await requireUser(c);
  }

  try {
    await accessService.assertLocalhostBootstrapRequest(c);
    return null;
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Bootstrap action is not allowed."
      },
      403
    );
  }
}

async function mutationGuard(c: Context<{ Variables: AppVariables }>): Promise<Response | null> {
  try {
    await accessService.assertCanonicalMutation(c, true);
    return null;
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Origin mismatch." },
      403
    );
  }
}

function expandHomePath(input: string): string {
  if (input === "~") {
    return process.env.HOME ?? input;
  }
  if (input.startsWith("~/")) {
    return path.join(process.env.HOME ?? "", input.slice(2));
  }
  return input;
}

app.get("/api/health", async (c) => {
  await signalService.refreshState();
  const [runtimeSummary, setup, launchAgent, channels] = await Promise.all([
    runtimeService.getRuntimeStatuses(),
    appStateService.getSetupState(),
    launchAgentService.status(),
    harnessService.listChannels()
  ]);
  return c.json({
    ok: true,
    timestamp: new Date().toISOString(),
    runtimeSummary,
    setup,
    launchAgent,
    channels
  });
});

app.get("/api/auth/me", async (c) => {
  const user = c.get("user");
  return c.json({
    user,
    hasUser: await authService.hasUser()
  });
});

app.post("/api/auth/register/options", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  return c.json(await authService.beginRegistration(c));
});

app.post("/api/auth/register/verify", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const body = await c.req.json();
  const user = await authService.finishRegistration(c, body);
  return c.json({ user });
});

app.post("/api/auth/login/options", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  return c.json(await authService.beginAuthenticationFromContext(c));
});

app.post("/api/auth/login/verify", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const body = await c.req.json();
  const user = await authService.finishAuthenticationFromContext(c, body);
  return c.json({ user });
});

app.post("/api/auth/logout", async (c) => {
  await authService.clearSession(c);
  return c.json({ ok: true });
});

app.get("/api/auth/passkeys", async (c) => {
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const user = c.get("user");
  return c.json(await authService.listPasskeys(user!));
});

app.post("/api/auth/passkeys/register/options", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const user = c.get("user");
  return c.json(await authService.beginAdditionalRegistrationFromContext(c, user!));
});

app.post("/api/auth/passkeys/register/verify", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const user = c.get("user");
  const body = await c.req.json();
  return c.json({
    user: await authService.finishAdditionalRegistrationFromContext(c, user!, body),
    passkeys: await authService.listPasskeys(user!)
  });
});

app.get("/api/access", async (c) => {
  return c.json(await accessService.getBootstrapState());
});

app.post("/api/access/tailscale/enable", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const gate = await requireOwnerOrLocalBootstrap(c);
  if (gate) return gate;
  const result = await accessService.enableTailscaleServe();
  await websocketHub.refreshAll();
  return c.json(result);
});

app.post("/api/access/bootstrap", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const gate = await requireOwnerOrLocalBootstrap(c);
  if (gate) return gate;
  return c.json(await accessService.createBootstrapToken());
});

app.post("/api/access/bootstrap/consume", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const body = (await c.req.json()) as { token: string };
  await accessService.consumeBootstrapToken(body.token);
  return c.json({ ok: true });
});

app.get("/api/dashboard", async (c) => {
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  return c.json(await dashboardService.getDashboardState());
});

app.get("/api/setup", async (c) => {
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  return c.json(await appStateService.getSetupState());
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
  const state = await appStateService.markSetupStepCompleted("workspace", {
    workspaceRoot
  });
  await websocketHub.refreshAll();
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
    selectedRuntime: body.runtimeId
  });
  const state = await appStateService.markSetupStepCompleted("runtime", {
    selectedRuntime: body.runtimeId
  });
  await websocketHub.refreshAll();
  return c.json(state);
});

app.post("/api/setup/model", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const body = (await c.req.json()) as { runtimeId: "ollama" | "llamaCpp"; modelId: string };
  await runtimeService.pullModel(body.runtimeId, body.modelId);
  await openclawService.startGateway();
  const state = await appStateService.markSetupStepCompleted("providerRegistration", {});
  await websocketHub.refreshAll();
  return c.json(state);
});

app.post("/api/setup/signal", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const body = (await c.req.json()) as { phoneNumber: string; autoInstall?: boolean; useVoice?: boolean; captcha?: string };
  const registrationRequest: {
    phoneNumber: string;
    autoInstall?: boolean;
    useVoice?: boolean;
    captcha?: string;
  } = {
    phoneNumber: body.phoneNumber
  };
  if (typeof body.autoInstall === "boolean") {
    registrationRequest.autoInstall = body.autoInstall;
  }
  if (typeof body.useVoice === "boolean") {
    registrationRequest.useVoice = body.useVoice;
  }
  if (body.captcha?.trim()) {
    registrationRequest.captcha = body.captcha.trim();
  }
  await signalService.startRegistration(registrationRequest);
  const state = await appStateService.updateSetupState({
    signalEnabled: true
  });
  await websocketHub.refreshAll();
  return c.json(state);
});

app.get("/api/runtime", async (c) => {
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  return c.json(await runtimeService.getRuntimeStatuses());
});

app.post("/api/runtime/:runtimeId/install", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  await runtimeService.installRuntime(c.req.param("runtimeId") as "ollama" | "llamaCpp" | "openclaw");
  await websocketHub.refreshAll();
  return c.json({ ok: true });
});

app.post("/api/runtime/:runtimeId/start", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  await runtimeService.startRuntime(c.req.param("runtimeId") as "ollama" | "llamaCpp" | "openclaw");
  await websocketHub.refreshAll();
  return c.json({ ok: true });
});

app.post("/api/runtime/:runtimeId/stop", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  await runtimeService.stopRuntime(c.req.param("runtimeId") as "ollama" | "llamaCpp" | "openclaw");
  await websocketHub.refreshAll();
  return c.json({ ok: true });
});

app.post("/api/runtime/:runtimeId/models", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const body = (await c.req.json()) as { modelId: string };
  await runtimeService.pullModel(c.req.param("runtimeId") as "ollama" | "llamaCpp", body.modelId);
  await websocketHub.refreshAll();
  return c.json({ ok: true });
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
    providerId: "openai" | "anthropic" | "openrouter" | "gemini" | "groq" | "together" | "xai";
    apiKey: string;
    defaultModel?: string;
  };
  await keychainService.setProviderSecret(body.providerId, body.apiKey);
  if (body.defaultModel?.trim()) {
    await keychainService.updateProviderModel(body.providerId, body.defaultModel.trim());
  }
  await appStateService.markSetupStepCompleted("cloudProviders");
  await runtimeService.startRuntime("openclaw");
  await websocketHub.refreshAll();
  return c.json(await keychainService.listProviderSummaries());
});

app.delete("/api/providers/secrets/:providerId", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const providerId = c.req.param("providerId") as "openai" | "anthropic" | "openrouter" | "gemini" | "groq" | "together" | "xai";
  const settings = await appStateService.getRuntimeSettings();
  await keychainService.deleteProviderSecret(providerId);

  if (settings.activeProviderId === providerId) {
    if (settings.selectedRuntime === "ollama") {
      await appStateService.updateRuntimeSettings({ activeProviderId: "ollama-default" });
      await harnessService.configureRuntimeModel({
        providerId: "ollama-default",
        modelId: settings.ollamaModel
      });
    } else {
      await appStateService.updateRuntimeSettings({ activeProviderId: "llamacpp-default" });
      await harnessService.configureRuntimeModel({
        providerId: "llamacpp-default",
        modelId: path.basename(settings.llamaCppModel).toLowerCase(),
        contextWindow: settings.llamaCppContextWindow
      });
    }
  }

  await runtimeService.startRuntime("openclaw");
  await websocketHub.refreshAll();
  return c.json(await keychainService.listProviderSummaries());
});

app.post("/api/providers/:providerId/select", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const providerId = c.req.param("providerId") as "openai" | "anthropic" | "openrouter" | "gemini" | "groq" | "together" | "xai";
  const body = (await c.req.json()) as { modelId?: string };
  await keychainService.assertConfigured(providerId);
  const settings = await appStateService.getRuntimeSettings();
  const modelId = body.modelId?.trim() || settings.cloudProviders[providerId].defaultModel;
  if (!modelId) {
    return c.json({ error: "A model id is required for the selected cloud provider." }, 400);
  }

  await keychainService.updateProviderModel(providerId, modelId);
  await appStateService.updateRuntimeSettings({
    activeProviderId: providerId
  });
  await harnessService.configureRuntimeModel({
    providerId,
    modelId
  });
  await appStateService.markSetupStepCompleted("cloudProviders", {
    selectedModel: modelId
  });
  await websocketHub.refreshAll();
  return c.json(await runtimeService.listProviderProfiles());
});

app.get("/api/channels", async (c) => {
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  await signalService.refreshState();
  return c.json(await harnessService.listChannels());
});

app.post("/api/channels/signal/install", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  await signalService.installCli();
  await websocketHub.refreshAll();
  return c.json(await harnessService.listChannels());
});

app.post("/api/channels/signal/register/start", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const body = (await c.req.json()) as {
    phoneNumber: string;
    useVoice?: boolean;
    captcha?: string;
    reregister?: boolean;
    autoInstall?: boolean;
  };
  const signalRegistrationRequest: {
    phoneNumber: string;
    useVoice?: boolean;
    captcha?: string;
    reregister?: boolean;
    autoInstall?: boolean;
  } = {
    phoneNumber: body.phoneNumber
  };
  if (typeof body.useVoice === "boolean") {
    signalRegistrationRequest.useVoice = body.useVoice;
  }
  if (body.captcha?.trim()) {
    signalRegistrationRequest.captcha = body.captcha.trim();
  }
  if (typeof body.reregister === "boolean") {
    signalRegistrationRequest.reregister = body.reregister;
  }
  if (typeof body.autoInstall === "boolean") {
    signalRegistrationRequest.autoInstall = body.autoInstall;
  }
  await signalService.startRegistration(signalRegistrationRequest);
  await websocketHub.refreshAll();
  return c.json(await harnessService.listChannels());
});

app.post("/api/channels/signal/register/verify", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const body = (await c.req.json()) as { verificationCode: string; pin?: string };
  await signalService.verifyRegistration(body);
  await websocketHub.refreshAll();
  return c.json(await harnessService.listChannels());
});

app.post("/api/channels/signal/link/start", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const body = (await c.req.json()) as { deviceName?: string };
  const result = await signalService.startLink(body.deviceName?.trim() || "DroidAgent");
  await websocketHub.refreshAll();
  return c.json(result);
});

app.post("/api/channels/signal/link/cancel", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  await signalService.cancelLink();
  await websocketHub.refreshAll();
  return c.json(await harnessService.listChannels());
});

app.post("/api/channels/signal/daemon/start", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  await signalService.startDaemon();
  await websocketHub.refreshAll();
  return c.json(await harnessService.listChannels());
});

app.post("/api/channels/signal/daemon/stop", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  await signalService.stopDaemon();
  await websocketHub.refreshAll();
  return c.json(await harnessService.listChannels());
});

app.post("/api/channels/signal/disconnect", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const body = (await c.req.json()) as { unregister?: boolean; deleteAccount?: boolean; clearLocalData?: boolean };
  const disconnectRequest: {
    unregister: boolean;
    deleteAccount?: boolean;
    clearLocalData?: boolean;
  } = {
    unregister: body.unregister ?? false,
  };
  if (typeof body.deleteAccount === "boolean") {
    disconnectRequest.deleteAccount = body.deleteAccount;
  }
  if (typeof body.clearLocalData === "boolean") {
    disconnectRequest.clearLocalData = body.clearLocalData;
  }
  await signalService.disconnect(disconnectRequest);
  await websocketHub.refreshAll();
  return c.json(await harnessService.listChannels());
});

app.post("/api/channels/signal/pairing/approve", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const body = (await c.req.json()) as { code: string };
  await openclawService.approveSignalPairing(body.code);
  await websocketHub.refreshAll();
  return c.json({ ok: true });
});

app.get("/api/service/launch-agent", async (c) => {
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  return c.json(await launchAgentService.status());
});

app.post("/api/service/launch-agent/install", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const status = await launchAgentService.install();
  await websocketHub.refreshAll();
  return c.json(status);
});

app.post("/api/service/launch-agent/start", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const status = await launchAgentService.start();
  await websocketHub.refreshAll();
  return c.json(status);
});

app.post("/api/service/launch-agent/stop", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const status = await launchAgentService.stop();
  await websocketHub.refreshAll();
  return c.json(status);
});

app.post("/api/service/launch-agent/uninstall", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const status = await launchAgentService.uninstall();
  await websocketHub.refreshAll();
  return c.json(status);
});

app.get("/api/sessions", async (c) => {
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  return c.json(await harnessService.listSessions());
});

app.get("/api/sessions/:sessionId/messages", async (c) => {
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  return c.json(await harnessService.loadHistory(c.req.param("sessionId")));
});

app.post("/api/sessions/:sessionId/messages", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const body = (await c.req.json()) as { text: string };
  const sessionId = c.req.param("sessionId");
  const run = await harnessService.sendMessage(sessionId, body.text, {
    onDelta: async (delta) => {
      websocketHub.publishChatDelta(sessionId, run.runId, delta);
    },
    onDone: async () => {
      websocketHub.publishChatDone(sessionId, run.runId);
      await websocketHub.pushChatHistory(sessionId);
      await websocketHub.refreshAll();
    },
    onError: async (message) => {
      websocketHub.publishChatError(sessionId, run.runId, message);
      await websocketHub.pushChatHistory(sessionId);
      await websocketHub.refreshAll();
    }
  });
  return c.json({ ok: true, runId: run.runId }, 202);
});

app.post("/api/sessions/:sessionId/abort", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const sessionId = c.req.param("sessionId");
  await harnessService.abortMessage(sessionId);
  await websocketHub.pushChatHistory(sessionId);
  await websocketHub.refreshAll();
  return c.json({ ok: true });
});

app.get("/api/approvals", async (c) => {
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  return c.json(await harnessService.listApprovals());
});

app.post("/api/approvals/:approvalId", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const body = (await c.req.json()) as { resolution: "approved" | "denied" };
  await harnessService.resolveApproval(c.req.param("approvalId"), body.resolution);
  await websocketHub.refreshAll();
  return c.json({ ok: true });
});

app.get("/api/files", async (c) => {
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const target = c.req.query("path") ?? ".";
  return c.json(await fileService.listDirectory(target));
});

app.get("/api/files/content", async (c) => {
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const target = c.req.query("path");
  if (!target) {
    return c.json({ error: "path is required." }, 400);
  }
  return c.json(await fileService.readFile(target));
});

app.put("/api/files/content", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const body = (await c.req.json()) as { path: string; content: string; expectedModifiedAt: string | null };
  const saved = await fileService.writeFile(body.path, body.content, body.expectedModifiedAt ?? null);
  await websocketHub.refreshAll();
  return c.json(saved);
});

app.post("/api/files/directory", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const body = (await c.req.json()) as { path: string };
  await fileService.createDirectory(body.path);
  return c.json({ ok: true });
});

app.get("/api/jobs", async (c) => {
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  return c.json(await jobService.listJobs());
});

app.get("/api/jobs/:jobId/output", async (c) => {
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  return c.json(await jobService.readJobOutput(c.req.param("jobId")));
});

app.post("/api/jobs", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const user = c.get("user");
  const body = (await c.req.json()) as { command: string; cwd: string };
  const jobId = await jobService.startJob(body.command, body.cwd ?? ".", user?.id);
  await websocketHub.refreshAll();
  return c.json({ jobId });
});

app.get("/api/models/:runtimeId", async (c) => {
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  return c.json(await runtimeService.listModels(c.req.param("runtimeId") as "ollama" | "llamaCpp" | "openclaw"));
});

if (fs.existsSync(paths.webDistDir)) {
  app.use("/*", serveStatic({ root: paths.webDistDir }));
}

void openclawService.ensureConfigured().catch((error) => {
  console.error("Failed to seed OpenClaw configuration", error);
});

const server = serve(
  {
    fetch: app.fetch,
    port: SERVER_PORT
  },
  (info) => {
    console.log(`DroidAgent server listening on http://127.0.0.1:${info.port}`);
  }
);

const wss = new WebSocketServer({ noServer: true });
websocketHub.attach(wss);

server.on("upgrade", async (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const rawCookie = request.headers.cookie;
  const token = rawCookie
    ?.split(";")
    .map((part: string) => part.trim())
    .find((part: string) => part.startsWith("droidagent_session="))
    ?.split("=")[1];
  const user = await authService.getCurrentUserBySessionToken(token);
  if (!user) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});
