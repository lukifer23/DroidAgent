import type { Hono } from "hono";

import { authService } from "../services/auth-service.js";
import {
  mutationGuard,
  requireUser,
  type AppVariables,
} from "./route-support.js";

export function registerAuthRoutes(app: Hono<{ Variables: AppVariables }>) {
  app.get("/api/auth/me", async (c) => {
    const user = c.get("user");
    return c.json({
      user,
      hasUser: await authService.hasUser(),
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
    return c.json(
      await authService.beginAdditionalRegistrationFromContext(c, user!),
    );
  });

  app.post("/api/auth/passkeys/register/verify", async (c) => {
    const blocked = await mutationGuard(c);
    if (blocked) return blocked;
    const unauthorized = await requireUser(c);
    if (unauthorized) return unauthorized;
    const user = c.get("user");
    const body = await c.req.json();
    return c.json({
      user: await authService.finishAdditionalRegistrationFromContext(
        c,
        user!,
        body,
      ),
      passkeys: await authService.listPasskeys(user!),
    });
  });
}
