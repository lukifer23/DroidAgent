import path from "node:path";

import type { Context } from "hono";
import type { authService } from "../services/auth-service.js";

import { accessService } from "../services/access-service.js";
import { authService as authServiceInstance } from "../services/auth-service.js";

export type AppVariables = {
  user: Awaited<ReturnType<typeof authService.getCurrentUser>>;
};

export type AppRouteContext = Context<{ Variables: AppVariables }>;

export async function requireUser(c: AppRouteContext) {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return null;
}

export async function getDecisionActor(c: AppRouteContext) {
  const user = c.get("user");
  if (!user) {
    throw new Error("Decision actor is unavailable.");
  }
  const authSession = await authServiceInstance.getCurrentSession(c);
  return {
    user,
    authSession,
  };
}

export async function requireOwnerOrLocalBootstrap(c: AppRouteContext) {
  const ownerExists = await authServiceInstance.hasUser();
  if (ownerExists) {
    return await requireUser(c);
  }

  try {
    await accessService.assertLocalhostBootstrapRequest(c);
    return null;
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Bootstrap action is not allowed.",
      },
      403,
    );
  }
}

export async function mutationGuard(
  c: AppRouteContext,
): Promise<Response | null> {
  try {
    await accessService.assertCanonicalMutation(c, true);
    return null;
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Origin mismatch." },
      403,
    );
  }
}

export function expandHomePath(input: string): string {
  if (input === "~") {
    return process.env.HOME ?? input;
  }
  if (input.startsWith("~/")) {
    return path.join(process.env.HOME ?? "", input.slice(2));
  }
  return input;
}
