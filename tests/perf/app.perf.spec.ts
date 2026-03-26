import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { expect, test } from "@playwright/test";

import { gotoSignedIn } from "../e2e/support";

const artifactDir = path.resolve(process.cwd(), "artifacts", "perf");

test("captures end-to-end UX timings", async ({ page, browserName }, testInfo) => {
  const projectName = testInfo.project.name;
  const metrics = [];

  const loadStart = performance.now();
  await gotoSignedIn(page, "/chat");
  await expect(page.getByRole("heading", { name: "Operator Console" })).toBeVisible();
  metrics.push({
    name: "initial_load_ms",
    durationMs: Number((performance.now() - loadStart).toFixed(2))
  });

  const routeStart = performance.now();
  await page.getByRole("link", { name: "Files" }).click();
  await expect(page.getByRole("button", { name: "Create Directory" })).toBeVisible();
  metrics.push({
    name: "route_switch_ms",
    durationMs: Number((performance.now() - routeStart).toFixed(2))
  });

  await page.getByRole("link", { name: "Chat" }).click();
  await expect(page.getByPlaceholder("Send a message to the current OpenClaw session...")).toBeVisible();

  const prompt = `perf-${projectName}`;
  const assistantMessages = page.locator(".chat-thread .message-card.assistant p");
  await page.getByPlaceholder("Send a message to the current OpenClaw session...").fill(prompt);
  const sendStart = performance.now();
  await page.getByRole("button", { name: "Send" }).click();
  await expect(assistantMessages.filter({ hasText: /^Test harness reply:/ }).last()).toBeVisible();
  metrics.push({
    name: "chat_first_token_ms",
    durationMs: Number((performance.now() - sendStart).toFixed(2))
  });
  await expect(
    assistantMessages.filter({ hasText: new RegExp(`^Test harness reply: ${prompt}$`) }).last()
  ).toBeVisible();
  metrics.push({
    name: "chat_done_ms",
    durationMs: Number((performance.now() - sendStart).toFixed(2))
  });

  const reconnectStart = performance.now();
  const reconnectBanner = page.getByText(/You are offline|Reconnecting to DroidAgent/i);
  await page.context().setOffline(true);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("offline"));
  });
  await expect(reconnectBanner).toBeVisible();
  await page.context().setOffline(false);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("online"));
  });
  await expect(reconnectBanner).toHaveCount(0);
  metrics.push({
    name: "reconnect_resync_ms",
    durationMs: Number((performance.now() - reconnectStart).toFixed(2))
  });

  await fs.mkdir(artifactDir, { recursive: true });
  const outputPath = path.join(artifactDir, `e2e-${browserName}-${projectName}.json`);
  await fs.writeFile(
    outputPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        browserName,
        project: projectName,
        metrics
      },
      null,
      2
    ),
    "utf8"
  );
});
