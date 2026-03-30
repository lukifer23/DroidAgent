import type { Hono } from "hono";

import {
  HostPressureRecoveryRequestSchema,
  HostPressureRecoveryResultSchema,
} from "@droidagent/shared";

import { accessService } from "../services/access-service.js";
import { dashboardService } from "../services/dashboard-service.js";
import { harnessService } from "../services/harness-service.js";
import { hostPressureService } from "../services/host-pressure-service.js";
import { jobService } from "../services/job-service.js";
import { performanceService } from "../services/performance-service.js";
import { startupService } from "../services/startup-service.js";
import { terminalService } from "../services/terminal-service.js";
import { websocketHub } from "../websocket-hub.js";
import {
  mutationGuard,
  requireOwnerOrLocalBootstrap,
  requireUser,
  type AppVariables,
} from "./route-support.js";

export function registerAccessRoutes(app: Hono<{ Variables: AppVariables }>) {
  app.get("/api/access", async (c) => {
    return c.json(await accessService.getBootstrapState());
  });

  app.post("/api/access/tailscale/enable", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const gate = await requireOwnerOrLocalBootstrap(c);
    if (gate) return gate;
    const result = await accessService.enableTailscaleServe();
    await websocketHub.publishAccessUpdated();
    await websocketHub.publishSetupUpdated();
    return c.json(result);
  });

  app.post("/api/access/cloudflare/enable", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const gate = await requireOwnerOrLocalBootstrap(c);
    if (gate) return gate;
    const body = (await c.req.json()) as {
      hostname: string;
      tunnelToken: string;
    };
    const result = await accessService.enableCloudflareTunnel(body);
    await websocketHub.publishAccessUpdated();
    return c.json(result);
  });

  app.post("/api/access/cloudflare/stop", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const gate = await requireOwnerOrLocalBootstrap(c);
    if (gate) return gate;
    const result = await accessService.stopCloudflareTunnel();
    await websocketHub.publishAccessUpdated();
    return c.json(result);
  });

  app.post("/api/access/canonical", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const gate = await requireOwnerOrLocalBootstrap(c);
    if (gate) return gate;
    const body = (await c.req.json()) as {
      source: "tailscale" | "cloudflare";
    };
    const canonicalOrigin = await accessService.setCanonicalSource(body.source);
    await websocketHub.publishAccessUpdated();
    await websocketHub.publishSetupUpdated();
    return c.json({ canonicalOrigin });
  });

  app.post("/api/access/bootstrap", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const gate = await requireOwnerOrLocalBootstrap(c);
    if (gate) return gate;
    const result = await accessService.createBootstrapToken();
    await websocketHub.publishAccessUpdated();
    return c.json(result);
  });

  app.post("/api/access/bootstrap/consume", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const body = (await c.req.json()) as { token: string };
    await accessService.consumeBootstrapToken(body.token);
    await websocketHub.publishAccessUpdated();
    return c.json({ ok: true });
  });

  app.get("/api/setup/diagnostics", async (c) => {
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    return c.json(await startupService.getDiagnostics());
  });

  app.get("/api/dashboard", async (c) => {
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    return c.json(await dashboardService.getDashboardState());
  });

  app.get("/api/diagnostics/performance", async (c) => {
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    return c.json(performanceService.serverSnapshot());
  });

  app.get("/api/diagnostics/host-pressure", async (c) => {
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    return c.json(await hostPressureService.getStatus(true));
  });

  app.post("/api/diagnostics/host-pressure/recover", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    const body = HostPressureRecoveryRequestSchema.parse(
      await c.req.json().catch(() => ({})),
    );

    const [jobs, terminalSnapshot] = await Promise.all([
      jobService.listJobs(),
      terminalService.getSnapshot(),
    ]);
    const activeJobs = jobs.filter(
      (job) => job.status === "queued" || job.status === "running",
    );
    const activeTerminalSessionId =
      terminalSnapshot.session?.status === "running"
        ? terminalSnapshot.session.id
        : null;

    if (body.abortSessionRun && body.sessionId) {
      await harnessService.abortMessage(body.sessionId);
    }
    if (body.cancelActiveJobs && activeJobs.length > 0) {
      await jobService.cancelActiveJobs(
        "Cancelled to recover from host pressure.",
      );
    }
    if (body.closeTerminalSession && activeTerminalSessionId) {
      await terminalService.closeSession(
        activeTerminalSessionId,
        "Closed to recover from host pressure.",
      );
    }

    const status = await hostPressureService.getStatus(true);
    await Promise.all([
      body.sessionId
        ? websocketHub.pushChatHistory(body.sessionId)
        : Promise.resolve(),
      body.sessionId
        ? websocketHub.publishSessionsUpdated()
        : Promise.resolve(),
      websocketHub.publishHostPressureUpdated(true),
    ]);

    return c.json(
      HostPressureRecoveryResultSchema.parse({
        recoveredAt: new Date().toISOString(),
        abortedSessionId: body.abortSessionRun ? body.sessionId : null,
        cancelledJobCount: body.cancelActiveJobs ? activeJobs.length : 0,
        closedTerminalSessionId: body.closeTerminalSession
          ? activeTerminalSessionId
          : null,
        hostPressure: status,
      }),
    );
  });
}
