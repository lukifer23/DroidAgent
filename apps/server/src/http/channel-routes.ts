import type { Hono } from "hono";

import { decisionService } from "../services/decision-service.js";
import { harnessService } from "../services/harness-service.js";
import { launchAgentService } from "../services/launch-agent-service.js";
import { signalService } from "../services/signal-service.js";
import { publishDecisionEffects } from "../lib/decision-updates.js";
import { websocketHub } from "../websocket-hub.js";
import {
  getDecisionActor,
  mutationGuard,
  requireUser,
  type AppVariables,
} from "./route-support.js";

function buildSignalRegistrationRequest(body: {
  phoneNumber: string;
  useVoice?: boolean;
  captcha?: string;
  reregister?: boolean;
  autoInstall?: boolean;
}) {
  const request: {
    phoneNumber: string;
    useVoice?: boolean;
    captcha?: string;
    reregister?: boolean;
    autoInstall?: boolean;
  } = {
    phoneNumber: body.phoneNumber,
  };
  if (typeof body.useVoice === "boolean") {
    request.useVoice = body.useVoice;
  }
  if (body.captcha?.trim()) {
    request.captcha = body.captcha.trim();
  }
  if (typeof body.reregister === "boolean") {
    request.reregister = body.reregister;
  }
  if (typeof body.autoInstall === "boolean") {
    request.autoInstall = body.autoInstall;
  }
  return request;
}

export function registerChannelRoutes(app: Hono<{ Variables: AppVariables }>) {
  app.get("/api/channels", async (c) => {
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    signalService.refreshStateInBackground();
    return c.json(await harnessService.listChannels());
  });

  app.post("/api/channels/signal/install", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    await signalService.installCli();
    await websocketHub.publishChannelUpdated();
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
    await signalService.startRegistration(buildSignalRegistrationRequest(body));
    await websocketHub.publishChannelUpdated();
    return c.json(await harnessService.listChannels());
  });

  app.post("/api/channels/signal/register/verify", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    const body = (await c.req.json()) as {
      verificationCode: string;
      pin?: string;
    };
    await signalService.verifyRegistration(body);
    await websocketHub.publishChannelUpdated();
    await websocketHub.publishSetupUpdated();
    return c.json(await harnessService.listChannels());
  });

  app.post("/api/channels/signal/link/start", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    const body = (await c.req.json()) as { deviceName?: string };
    const result = await signalService.startLink(
      body.deviceName?.trim() || "DroidAgent",
    );
    await websocketHub.publishChannelUpdated();
    return c.json(result);
  });

  app.post("/api/channels/signal/link/cancel", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    await signalService.cancelLink();
    await websocketHub.publishChannelUpdated();
    return c.json(await harnessService.listChannels());
  });

  app.post("/api/channels/signal/daemon/start", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    await signalService.startDaemon();
    await websocketHub.publishChannelUpdated();
    return c.json(await harnessService.listChannels());
  });

  app.post("/api/channels/signal/daemon/stop", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    await signalService.stopDaemon();
    await websocketHub.publishChannelUpdated();
    return c.json(await harnessService.listChannels());
  });

  app.post("/api/channels/signal/disconnect", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    const body = (await c.req.json()) as {
      unregister?: boolean;
      deleteAccount?: boolean;
      clearLocalData?: boolean;
    };
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
    await websocketHub.publishChannelUpdated();
    await websocketHub.publishSetupUpdated();
    return c.json(await harnessService.listChannels());
  });

  app.post("/api/channels/signal/pairing/resolve", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    const actor = await getDecisionActor(c);
    const body = (await c.req.json()) as {
      code: string;
      resolution: "approved" | "denied";
    };
    const decision = await decisionService.resolveChannelPairingDecision(
      body.code,
      body.resolution,
      actor,
    );
    await publishDecisionEffects(websocketHub, decision);
    return c.json(decision);
  });

  app.post("/api/channels/signal/pairing/approve", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    const actor = await getDecisionActor(c);
    const body = (await c.req.json()) as { code: string };
    const decision = await decisionService.resolveChannelPairingDecision(
      body.code,
      "approved",
      actor,
    );
    await publishDecisionEffects(websocketHub, decision);
    return c.json(decision);
  });

  app.post("/api/channels/signal/test-message", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    const body = (await c.req.json()) as { target: string; text: string };
    await signalService.sendTestMessage(body);
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
    await websocketHub.publishLaunchAgentUpdated();
    await websocketHub.publishSetupUpdated();
    return c.json(status);
  });

  app.post("/api/service/launch-agent/start", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    const status = await launchAgentService.start();
    await websocketHub.publishLaunchAgentUpdated();
    return c.json(status);
  });

  app.post("/api/service/launch-agent/stop", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    const status = await launchAgentService.stop();
    await websocketHub.publishLaunchAgentUpdated();
    return c.json(status);
  });

  app.post("/api/service/launch-agent/uninstall", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    const status = await launchAgentService.uninstall();
    await websocketHub.publishLaunchAgentUpdated();
    return c.json(status);
  });
}
