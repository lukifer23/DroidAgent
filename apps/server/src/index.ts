import fs from "node:fs";
import path from "node:path";

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { WebSocketServer } from "ws";
import {
  ChatSendRequestSchema,
  DecisionResolveRequestSchema,
} from "@droidagent/shared";

import { db, schema } from "./db/index.js";
import { accessService } from "./services/access-service.js";
import {
  AttachmentNotFoundError,
  AttachmentValidationError,
  attachmentService,
} from "./services/attachment-service.js";
import { authService } from "./services/auth-service.js";
import { dashboardService } from "./services/dashboard-service.js";
import { decisionService } from "./services/decision-service.js";
import { FileConflictError, fileService } from "./services/file-service.js";
import { harnessService } from "./services/harness-service.js";
import { jobService } from "./services/job-service.js";
import { keychainService } from "./services/keychain-service.js";
import { launchAgentService } from "./services/launch-agent-service.js";
import {
  MaintenanceBlockedError,
  MaintenanceConflictError,
  MaintenanceLocalhostRequiredError,
  maintenanceService,
} from "./services/maintenance-service.js";
import {
  MemoryDraftNotFoundError,
  MemoryDraftStateError,
  MemoryDraftStaleError,
} from "./services/memory-draft-service.js";
import { memoryPrepareService } from "./services/memory-prepare-service.js";
import { openclawService } from "./services/openclaw-service.js";
import { runtimeService } from "./services/runtime-service.js";
import { appStateService } from "./services/app-state-service.js";
import { buildInfoService } from "./services/build-info-service.js";
import {
  HostPressureBlockedError,
  hostPressureService,
} from "./services/host-pressure-service.js";
import { sessionLifecycleService } from "./services/session-lifecycle-service.js";
import { signalService } from "./services/signal-service.js";
import { startupService } from "./services/startup-service.js";
import { terminalService } from "./services/terminal-service.js";
import { testHarnessService } from "./services/test-harness-service.js";
import {
  clearDirectoryContents,
  isSafeE2ERoot,
  isWithinDir,
  readE2EFixtureState,
  writeE2EWorkspaceFiles,
} from "./testing/e2e-fixture.js";
import { websocketHub } from "./websocket-hub.js";
import { SERVER_PORT, TEST_MODE, ensureAppDirs, paths } from "./env.js";
import { performanceService } from "./services/performance-service.js";
import { createMeasuredStreamRelay } from "./lib/chat-relay-metrics.js";
import { publishDecisionEffects } from "./lib/decision-updates.js";
import { registerAccessRoutes } from "./http/access-routes.js";
import { registerAuthRoutes } from "./http/auth-routes.js";
import { registerChannelRoutes } from "./http/channel-routes.js";
import { registerOperationsRoutes } from "./http/operations-routes.js";
import {
  getDecisionActor,
  mutationGuard,
  requireUser,
  type AppVariables,
} from "./http/route-support.js";

ensureAppDirs();

const app = new Hono<{ Variables: AppVariables }>();
app.use("*", logger());
app.use("/api/*", cors());
const requestPathWarmupPromise = warmRequestPathCaches(true);

function isExpectedAppError(error: unknown): boolean {
  return (
    error instanceof FileConflictError ||
    error instanceof AttachmentValidationError ||
    error instanceof AttachmentNotFoundError ||
    error instanceof MaintenanceBlockedError ||
    error instanceof HostPressureBlockedError ||
    error instanceof MaintenanceConflictError ||
    error instanceof MaintenanceLocalhostRequiredError ||
    error instanceof MemoryDraftNotFoundError ||
    error instanceof MemoryDraftStateError ||
    error instanceof MemoryDraftStaleError
  );
}

app.onError((error, c) => {
  if (!isExpectedAppError(error)) {
    console.error(error);
  }
  if (error instanceof FileConflictError) {
    return c.json(
      {
        error: error.message,
        currentModifiedAt: error.currentModifiedAt,
      },
      409,
    );
  }
  if (error instanceof AttachmentValidationError) {
    return c.json({ error: error.message }, 400);
  }
  if (error instanceof AttachmentNotFoundError) {
    return c.json({ error: error.message }, 404);
  }
  if (error instanceof MaintenanceBlockedError) {
    return c.json({ error: error.message }, 423);
  }
  if (error instanceof HostPressureBlockedError) {
    return c.json({ error: error.message }, 503);
  }
  if (
    error instanceof MaintenanceConflictError ||
    error instanceof MemoryDraftStateError ||
    error instanceof MemoryDraftStaleError
  ) {
    return c.json({ error: error.message }, 409);
  }
  if (
    error instanceof MaintenanceLocalhostRequiredError
  ) {
    return c.json({ error: error.message }, 403);
  }
  if (error instanceof MemoryDraftNotFoundError) {
    return c.json({ error: error.message }, 404);
  }
  return c.json(
    {
      error:
        error instanceof Error ? error.message : "Unhandled DroidAgent error.",
    },
    500,
  );
});

app.use("/api/*", async (c, next) => {
  c.set("user", await authService.getCurrentUser(c));
  await next();
});

app.use("/api/*", async (c, next) => {
  const metric = performanceService.start(
    "server",
    `http.${c.req.method.toLowerCase()}.${c.req.path}`,
    {
      method: c.req.method,
      path: c.req.path,
    },
  );

  try {
    await next();
  } finally {
    const sample = metric.finish({
      status: c.res.status,
    });
    c.header("server-timing", `app;dur=${sample.durationMs.toFixed(2)}`);
  }
});


app.get("/api/health", async (c) => {
  if (PERF_READY_FILE && !fs.existsSync(PERF_READY_FILE)) {
    return c.json(
      {
        ok: false,
        warming: true,
      },
      503,
    );
  }
  signalService.refreshStateInBackground();
  const [runtimeSummary, setup, launchAgent, channels, harness] =
    await Promise.all([
    runtimeService.getRuntimeStatuses(),
    appStateService.getSetupState(),
    launchAgentService.status(),
    harnessService.listChannels(),
    harnessService.harnessStatus(),
  ]);
  return c.json({
    ok: true,
    timestamp: new Date().toISOString(),
    build: buildInfoService.getBuildInfo(),
    runtimeSummary,
    setup,
    launchAgent,
    channels,
    harnessSummary: {
      configured: harness.configured,
      activeModel: harness.activeModel,
      contextWindow: harness.contextWindow,
      toolProfile: harness.toolProfile,
      attachmentsEnabled: harness.attachmentsEnabled,
      imageModel: harness.imageModel,
      pdfModel: harness.pdfModel,
      memorySearchEnabled: harness.memorySearchEnabled,
      sessionMemoryEnabled: harness.sessionMemoryEnabled,
    },
  });
});
registerAuthRoutes(app);
registerAccessRoutes(app);
registerOperationsRoutes(app);
registerChannelRoutes(app);

app.get("/api/sessions", async (c) => {
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  return c.json(await sessionLifecycleService.listActiveSessions());
});

app.get("/api/sessions/archived", async (c) => {
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  return c.json(await sessionLifecycleService.listArchivedSessions());
});

app.post("/api/sessions", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const session = await sessionLifecycleService.createSession();
  await websocketHub.publishSessionsUpdated();
  return c.json(session, 201);
});

app.post("/api/sessions/:sessionId/archive", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const session = await sessionLifecycleService.archiveSession(
    c.req.param("sessionId"),
  );
  await websocketHub.publishSessionsUpdated();
  return c.json(session);
});

app.post("/api/sessions/:sessionId/restore", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const session = await sessionLifecycleService.restoreSession(
    c.req.param("sessionId"),
  );
  await websocketHub.publishSessionsUpdated();
  return c.json(session);
});

app.get("/api/sessions/:sessionId/messages", async (c) => {
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const sessionId = c.req.param("sessionId");
  const messages = await harnessService.loadHistory(sessionId);
  await sessionLifecycleService.observeSession(sessionId, {
    messages,
  });
  return c.json(messages);
});

app.post("/api/chat/uploads", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const formData = await c.req.formData();
  const files = formData
    .getAll("files")
    .filter((entry): entry is File => entry instanceof File);
  if (files.length === 0) {
    return c.json({ error: "Attach at least one file." }, 400);
  }

  const uploads = await Promise.all(
    files.map(async (file) => {
      const stored = await attachmentService.saveUpload(file);
      return {
        id: stored.id,
        name: stored.name,
        kind: stored.kind,
        mimeType: stored.mimeType,
        size: stored.size,
        url: stored.url,
      };
    }),
  );

  return c.json({ attachments: uploads }, 201);
});

app.get("/api/chat/uploads/:attachmentId", async (c) => {
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const attachment = await attachmentService.get(c.req.param("attachmentId"));
  const body = await fs.promises.readFile(attachment.filePath);
  c.header("content-type", attachment.mimeType);
  c.header("content-length", String(attachment.size));
  c.header(
    "content-disposition",
    `inline; filename="${attachment.name.replace(/"/g, "")}"`,
  );
  c.header("cache-control", "private, max-age=31536000, immutable");
  return c.body(body);
});

app.post("/api/sessions/:sessionId/messages", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  await maintenanceService.assertAllowsNewWork("chat");
  await hostPressureService.assertAllowsAgentRuns("chat");
  const body = ChatSendRequestSchema.parse(await c.req.json());
  const sessionId = c.req.param("sessionId");
  await sessionLifecycleService.observeSession(sessionId, {
    restore: true,
  });
  let runId = "";
  const measuredRelay = createMeasuredStreamRelay("http", sessionId, {
    onDelta: async (delta) => {
      websocketHub.publishChatDelta(sessionId, runId, delta);
    },
    onState: async (state) => {
      websocketHub.publishChatRun({
        sessionId,
        runId,
        ...state,
      });
    },
    onDone: async () => {
      websocketHub.publishChatDone(sessionId, runId);
      await websocketHub.pushChatHistory(sessionId);
      await websocketHub.publishSessionsUpdated();
      await websocketHub.publishPerformanceUpdated();
    },
    onError: async (message) => {
      websocketHub.publishChatError(sessionId, runId, message);
      await websocketHub.pushChatHistory(sessionId);
      await websocketHub.publishSessionsUpdated();
      await websocketHub.publishPerformanceUpdated();
    },
  });
  const run = await harnessService.sendMessage(sessionId, body, measuredRelay.relay);
  runId = run.runId;
  measuredRelay.markAccepted();
  websocketHub.publishChatRun({
    sessionId,
    runId,
    stage: "accepted",
    label: "Run accepted",
    detail: "OpenClaw accepted the request and is starting the live run.",
    active: true,
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
  await websocketHub.publishSessionsUpdated();
  return c.json({ ok: true });
});

app.get("/api/approvals", async (c) => {
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  return c.json(await decisionService.listLegacyApprovals());
});

app.post("/api/approvals/:approvalId", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const actor = await getDecisionActor(c);
  const body = (await c.req.json()) as { resolution: "approved" | "denied" };
  const approvalId = c.req.param("approvalId");
  await decisionService.resolveApprovalDecision(
    approvalId,
    body.resolution,
    actor,
  );
  await websocketHub.publishApprovalsUpdated();
  return c.json({ ok: true });
});

app.get("/api/decisions", async (c) => {
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  return c.json(await decisionService.listDecisions());
});

app.post("/api/decisions/:decisionId/resolve", async (c) => {
  const blocked = await mutationGuard(c);
  if (blocked) return blocked;
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  const actor = await getDecisionActor(c);
  const body = DecisionResolveRequestSchema.parse(await c.req.json());
  const decision = await decisionService.resolveDecision(
    c.req.param("decisionId"),
    body,
    actor,
  );
  await publishDecisionEffects(websocketHub, decision);
  return c.json(decision);
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
  const body = (await c.req.json()) as {
    path: string;
    content: string;
    expectedModifiedAt: string | null;
  };
  const saved = await fileService.writeFile(
    body.path,
    body.content,
    body.expectedModifiedAt ?? null,
  );
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
  await maintenanceService.assertAllowsNewWork("job");
  await hostPressureService.assertAllowsAgentRuns("job");
  const user = c.get("user");
  const body = (await c.req.json()) as { command: string; cwd: string };
  const jobId = await jobService.startJob(
    body.command,
    body.cwd ?? ".",
    user?.id,
  );
  return c.json({ jobId });
});

app.get("/api/models/:runtimeId", async (c) => {
  const unauthorized = await requireUser(c);
  if (unauthorized) return unauthorized;
  return c.json(
    await runtimeService.listModels(
      c.req.param("runtimeId") as "ollama" | "llamaCpp" | "openclaw",
    ),
  );
});

const E2E_RESET_TOKEN = process.env.DROIDAGENT_E2E_RESET_TOKEN ?? null;
const E2E_STATE_PATH = process.env.DROIDAGENT_E2E_STATE_PATH ?? null;
const E2E_ROOT_DIR = process.env.DROIDAGENT_E2E_ROOT_DIR ?? null;
const PERF_READY_FILE = process.env.DROIDAGENT_PERF_READY_FILE ?? null;

if (TEST_MODE && E2E_RESET_TOKEN && E2E_STATE_PATH && E2E_ROOT_DIR) {
  app.post("/api/testing/e2e/reset", async (c) => {
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;

    const requestToken = c.req.header("x-droidagent-e2e-reset-token");
    if (requestToken !== E2E_RESET_TOKEN) {
      return c.json({ error: "Unauthorized E2E reset request." }, 403);
    }

    const fixture = await readE2EFixtureState(E2E_STATE_PATH);
    const resolvedFixtureRoot = path.resolve(fixture.rootDir);
    const resolvedConfiguredRoot = path.resolve(E2E_ROOT_DIR);
    if (
      resolvedFixtureRoot !== resolvedConfiguredRoot ||
      !isSafeE2ERoot(resolvedFixtureRoot, paths.workspaceRoot)
    ) {
      throw new Error("Refusing to reset outside the dedicated E2E root.");
    }

    const runtimeSettings = await appStateService.getRuntimeSettings();
    const guardedPaths = [
      paths.appDir,
      paths.dbPath,
      paths.logsDir,
      paths.jobsLogsDir,
      paths.tempDir,
      paths.stateDir,
      paths.uploadsDir,
      paths.signalCliConfigDir,
      paths.tailscaleDir,
      paths.openClawStateDir,
      runtimeSettings.workspaceRoot ?? fixture.workspaceRoot,
    ];
    if (
      !guardedPaths.every((targetPath) =>
        isWithinDir(resolvedFixtureRoot, targetPath),
      )
    ) {
      throw new Error("Refusing to reset paths outside the dedicated E2E root.");
    }

    if (
      path.resolve(fixture.workspaceRoot) !==
      path.resolve(runtimeSettings.workspaceRoot ?? fixture.workspaceRoot)
    ) {
      throw new Error(
        "Refusing to reset because the current workspace root drifted from the E2E fixture.",
      );
    }

    testHarnessService.reset();
    performanceService.reset();

    const terminalSnapshot = await terminalService.getSnapshot();
    if (terminalSnapshot.session) {
      await terminalService.closeSession(
        terminalSnapshot.session.id,
        "The rescue terminal session is no longer active.",
      );
    }
    await jobService.cancelActiveJobs("Cancelled during E2E reset.");

    await db.delete(schema.authChallenges);
    await db.delete(schema.jobs);
    await db.delete(schema.memoryDrafts);
    await db.delete(schema.decisionRecords);
    await db.delete(schema.maintenanceOperations);
    await appStateService.setJsonSetting(
      "runtimeSettings",
      fixture.seed.runtimeSettings,
    );
    await appStateService.setJsonSetting("setupState", fixture.seed.setupState);
    await appStateService.setJsonSetting(
      "accessSettings",
      fixture.seed.accessSettings,
    );
    await appStateService.setJsonSetting(
      "openclawGatewayToken",
      fixture.seed.openclawGatewayToken,
    );
    await appStateService.setJsonSetting("sessionRegistry", []);

    await Promise.all([
      clearDirectoryContents(paths.jobsLogsDir),
      fs.promises.rm(path.join(paths.logsDir, "jobs-audit.log"), {
        force: true,
      }),
      clearDirectoryContents(fixture.workspaceRoot),
    ]);

    await writeE2EWorkspaceFiles(
      fixture.workspaceRoot,
      fixture.seed.workspaceFiles,
    );

    await websocketHub.refreshAll();
    return c.json({ ok: true });
  });
}

if (fs.existsSync(paths.webDistDir)) {
  app.use("/*", serveStatic({ root: paths.webDistDir }));

  const indexHtmlPath = path.join(paths.webDistDir, "index.html");
  const indexHtml = fs.existsSync(indexHtmlPath)
    ? fs.readFileSync(indexHtmlPath, "utf8")
    : null;

  app.get("*", (c) => {
    const pathname = new URL(c.req.url).pathname;
    if (!indexHtml) {
      return c.notFound();
    }
    if (
      pathname.startsWith("/api/") ||
      pathname === "/api" ||
      pathname === "/ws"
    ) {
      return c.notFound();
    }
    if (path.extname(pathname)) {
      return c.notFound();
    }
    return c.html(indexHtml);
  });
}

if (!TEST_MODE) {
  void openclawService.ensureConfigured().catch((error) => {
    console.error("Failed to seed OpenClaw configuration", error);
  });
}

async function warmRequestPathCaches(resetPerf = false): Promise<void> {
  try {
    await Promise.allSettled([
      accessService.getBootstrapState(),
      accessService.getAccessSnapshot(),
      runtimeService.getRuntimeStatuses(),
      runtimeService.listProviderProfiles(),
      keychainService.listProviderSummaries(),
      dashboardService.getDashboardState(),
    ]);
    if (resetPerf) {
      performanceService.reset();
    }
  } catch (error) {
    console.error("Failed to warm request-path caches", error);
  }
}

void (async () => {
  try {
    if (TEST_MODE) {
      await startupService.getDiagnostics();
    } else {
      await startupService.restore();
    }
    await memoryPrepareService.resumePendingPrepare();
    await requestPathWarmupPromise;
    void warmRequestPathCaches(false);
  } catch (error) {
    console.error("Failed to warm DroidAgent caches", error);
  }
})();

const server = serve(
  {
    fetch: app.fetch,
    port: SERVER_PORT,
  },
  (info) => {
    console.log(`DroidAgent server listening on http://localhost:${info.port}`);
  },
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
