import fs from "node:fs/promises";
import path from "node:path";

import { expect, type BrowserContext, type Page } from "@playwright/test";

export interface E2EState {
  baseUrl: string;
  sessionToken: string;
  workspaceRoot: string;
  sampleFilePath: string;
}

const e2ePort = process.env.DROIDAGENT_E2E_PORT ?? "4418";
const statePath = path.resolve(process.cwd(), "artifacts", "e2e", `state-${e2ePort}.json`);

export async function readE2EState(): Promise<E2EState> {
  return JSON.parse(await fs.readFile(statePath, "utf8")) as E2EState;
}

export async function signInSeededOwner(context: BrowserContext): Promise<E2EState> {
  const state = await readE2EState();
  await context.addCookies([
    {
      name: "droidagent_session",
      value: state.sessionToken,
      url: state.baseUrl,
      httpOnly: false,
      secure: false,
      sameSite: "Lax"
    }
  ]);
  return state;
}

export async function resetE2EState(page: Page): Promise<void> {
  const state = await readE2EState();
  const response = await page.request.post(new URL("/api/testing/e2e/reset", state.baseUrl).toString());
  if (!response.ok()) {
    throw new Error(`Failed to reset E2E state: ${response.status()} ${await response.text()}`);
  }
}

export async function gotoSignedIn(page: Page, pathname: string): Promise<E2EState> {
  const state = await signInSeededOwner(page.context());
  await resetE2EState(page);
  await page.goto(new URL(pathname, state.baseUrl).toString());
  await expect(page.getByRole("heading", { name: "Operator Console" })).toBeVisible();
  return state;
}
