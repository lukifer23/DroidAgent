import fs from "node:fs";

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { WebSocketServer } from "ws";

import { authService } from "./services/auth-service.js";
import { dashboardService } from "./services/dashboard-service.js";
import { fileService } from "./services/file-service.js";
import { jobService } from "./services/job-service.js";
import { openclawService } from "./services/openclaw-service.js";
import { runtimeService } from "./services/runtime-service.js";
import { appStateService } from "./services/app-state-service.js";
import { websocketHub } from "./websocket-hub.js";
import { SERVER_PORT, ensureAppDirs, paths } from "./env.js";

ensureAppDirs();

type AppVariables = {
  user: Awaited<ReturnType<typeof authService.getCurrentUser>>;
};

const app = new Hono<{ Variables: AppVariables }>();
app.use("*", logger());
app.use("/api/*", cors());

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

function mutationGuard(c: Context<{ Variables: AppVariables }>) {
  const origin = c.req.header("origin");
  if (!origin) {
    return null;
  }
  const requestUrl = new URL(c.req.url);
  const expected = `${requestUrl.protocol}//${requestUrl.host}`;
  if (origin !== expected) {
    return c.json({ error: "Origin mismatch." }, 403);
  }
  return null;
}

app.get("/api/health", async (c) => {
  const [runtimeSummary, setup] = await Promise.all([
    runtimeService.getRuntimeStatuses(),
    appStateService.getSetupState()
  ]);
  return c.json({
    ok: true,
    timestamp: new Date().toISOString(),
    runtimeSummary,
    setup
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
  const blocked = mutationGuard(c);
  if (blocked) return blocked;
  return c.json(await authService.beginRegistration(c));
});

app.post("/api/auth/register/verify", async (c) => {
  const blocked = mutationGuard(c);
  if (blocked) return blocked;
  const body = await c.req.json();
  const user = await authService.finishRegistration(c, body);
  return c.json({ user });
});

app.post("/api/auth/login/options", async (c) => {
  const blocked = mutationGuard(c);
  if (blocked) return blocked;
  return c.json(await authService.beginAuthentication(c));
});

app.post("/api/auth/login/verify", async (c) => {
  const blocked = mutationGuard(c);
  if (blocked) return blocked;
  const body = await c.req.json();
  const user = await authService.finishAuthentication(c, body);
  return c.json({ user });
});

app.post("/api/auth/logout", async (c) => {
  await authService.clearSession(c);
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
  const blocked = mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const body = (await c.req.json()) as { workspaceRoot: string };
  if (!body.workspaceRoot || !fs.existsSync(body.workspaceRoot)) {
    return c.json({ error: "Workspace root does not exist." }, 400);
  }
  await appStateService.updateRuntimeSettings({ workspaceRoot: body.workspaceRoot });
  const state = await appStateService.markSetupStepCompleted("workspace", {
    workspaceRoot: body.workspaceRoot
  });
  await websocketHub.refreshAll();
  return c.json(state);
});

app.post("/api/setup/runtime", async (c) => {
  const blocked = mutationGuard(c);
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
  const blocked = mutationGuard(c);
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
  const blocked = mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const body = (await c.req.json()) as { phoneNumber: string; autoInstall?: boolean; cliPath?: string };
  let cliPath = body.cliPath ?? null;
  if (body.autoInstall) {
    cliPath = await runtimeService.installSignalCli();
  }
  if (!cliPath) {
    return c.json({ error: "signal-cli path is required." }, 400);
  }
  await openclawService.configureSignal({
    cliPath,
    phoneNumber: body.phoneNumber
  });
  const state = await appStateService.markSetupStepCompleted("signal", {
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
  const blocked = mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  await runtimeService.installRuntime(c.req.param("runtimeId") as "ollama" | "llamaCpp" | "openclaw");
  await websocketHub.refreshAll();
  return c.json({ ok: true });
});

app.post("/api/runtime/:runtimeId/start", async (c) => {
  const blocked = mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  await runtimeService.startRuntime(c.req.param("runtimeId") as "ollama" | "llamaCpp" | "openclaw");
  await websocketHub.refreshAll();
  return c.json({ ok: true });
});

app.post("/api/runtime/:runtimeId/stop", async (c) => {
  const blocked = mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  await runtimeService.stopRuntime(c.req.param("runtimeId") as "ollama" | "llamaCpp" | "openclaw");
  await websocketHub.refreshAll();
  return c.json({ ok: true });
});

app.post("/api/runtime/:runtimeId/models", async (c) => {
  const blocked = mutationGuard(c);
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

app.get("/api/channels", async (c) => {
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  return c.json(await openclawService.getChannelStatuses());
});

app.post("/api/channels/signal/pairing/approve", async (c) => {
  const blocked = mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const body = (await c.req.json()) as { code: string };
  await openclawService.approveSignalPairing(body.code);
  await websocketHub.refreshAll();
  return c.json({ ok: true });
});

app.get("/api/sessions", async (c) => {
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  return c.json(await openclawService.listSessions());
});

app.get("/api/sessions/:sessionId/messages", async (c) => {
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  return c.json(await openclawService.loadChatHistory(c.req.param("sessionId")));
});

app.post("/api/sessions/:sessionId/messages", async (c) => {
  const blocked = mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const body = (await c.req.json()) as { text: string };
  await openclawService.sendChat(c.req.param("sessionId"), body.text);
  const messages = await openclawService.loadChatHistory(c.req.param("sessionId"));
  await websocketHub.refreshAll();
  return c.json({ messages });
});

app.get("/api/approvals", async (c) => {
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  return c.json(await openclawService.listApprovals());
});

app.post("/api/approvals/:approvalId", async (c) => {
  const blocked = mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const body = (await c.req.json()) as { resolution: "approved" | "denied" };
  await openclawService.resolveApproval(c.req.param("approvalId"), body.resolution);
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
  return c.json({ content: await fileService.readFile(target) });
});

app.post("/api/files/directory", async (c) => {
  const blocked = mutationGuard(c);
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

app.post("/api/jobs", async (c) => {
  const blocked = mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const body = (await c.req.json()) as { command: string; cwd: string };
  const jobId = await jobService.startJob(body.command, body.cwd);
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
