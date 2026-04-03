import fs from "node:fs/promises";
import path from "node:path";

import { expect, type BrowserContext, type Page } from "@playwright/test";

export interface E2EState {
  baseUrl: string;
  sessionToken: string;
  workspaceRoot: string;
  sampleFilePath: string;
  resetToken: string;
  rootDir?: string;
  mode?: "test-harness" | "live-runtime";
  profileId?: string | null;
}

const e2ePort = process.env.DROIDAGENT_E2E_PORT ?? "4418";
const statePath = path.resolve(
  process.cwd(),
  "artifacts",
  "e2e",
  `state-${e2ePort}.json`,
);

export async function readE2EState(): Promise<E2EState> {
  const state = JSON.parse(await fs.readFile(statePath, "utf8")) as E2EState;
  if (process.env.DROIDAGENT_PERF_MODE === "1" && state.rootDir) {
    const perfReadyPath = path.join(state.rootDir, ".perf-ready");
    let ready = false;
    for (let attempt = 0; attempt < 240; attempt += 1) {
      try {
        await fs.access(perfReadyPath);
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (!ready) {
      throw new Error(`Timed out waiting for ${perfReadyPath}`);
    }
  }
  return state;
}

export async function signInSeededOwner(
  context: BrowserContext,
): Promise<E2EState> {
  const state = await readE2EState();
  await context.addCookies([
    {
      name: "droidagent_session",
      value: state.sessionToken,
      url: state.baseUrl,
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ]);
  return state;
}

export async function resetE2EState(page: Page): Promise<void> {
  const state = await readE2EState();
  const response = await page.request.post(
    new URL("/api/testing/e2e/reset", state.baseUrl).toString(),
    {
      headers: {
        "x-droidagent-e2e-reset-token": state.resetToken,
      },
    },
  );
  if (!response.ok()) {
    throw new Error(
      `Failed to reset E2E state: ${response.status()} ${await response.text()}`,
    );
  }
}

export async function gotoSignedIn(
  page: Page,
  pathname: string,
): Promise<E2EState> {
  const state = await signInSeededOwner(page.context());
  await resetE2EState(page);
  await page.goto(new URL(pathname, state.baseUrl).toString());
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator(".bottom-nav")).toBeVisible();
  return state;
}
