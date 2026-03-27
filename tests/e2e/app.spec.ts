import fs from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { gotoSignedIn } from "./support";

test("shows the passkey auth screen before sign-in", async ({ page, baseURL }) => {
  await page.goto(baseURL ?? "http://127.0.0.1:4418");

  await expect(page.getByRole("heading", { name: /Mobile-first control/i })).toBeVisible();
  await expect(page.getByText(/Passkey Readiness/i)).toBeVisible();
});

test("loads the signed-in shell and bottom-nav routes", async ({ page }) => {
  await gotoSignedIn(page, "/chat");

  await expect(page.getByRole("heading", { name: "Operator Console" })).toBeVisible();
  await page.getByRole("link", { name: "Files" }).click();
  await expect(page.getByRole("button", { name: "Create Directory" })).toBeVisible();
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Performance Diagnostics" })).toBeVisible();
});

test("streams chat replies through the real websocket path", async ({ page }, testInfo) => {
  await gotoSignedIn(page, "/chat");
  const prompt = `hello from e2e ${testInfo.project.name}`;
  const assistantReply = page.locator(".chat-thread .message-card.assistant p").filter({
    hasText: new RegExp(`^Test harness reply: ${prompt}$`)
  });
  const sendButton = page.getByRole("button", { name: "Send" });

  await page.getByPlaceholder("Send a message to the current OpenClaw session...").fill(prompt);
  await expect(sendButton).toBeEnabled();
  await sendButton.click();

  await expect(page.locator(".message-card.user p").filter({ hasText: new RegExp(`^${prompt}$`) })).toBeVisible();
  await expect(assistantReply.last()).toBeVisible();
});

test("surfaces file conflicts from disk changes and allows reload", async ({ page }) => {
  const state = await gotoSignedIn(page, "/files");

  await page.getByRole("button", { name: /notes.txt/i }).click();
  await expect(page.locator(".editor-textarea")).toHaveValue("first pass");

  await fs.writeFile(state.sampleFilePath, "external edit", "utf8");

  await page.locator(".editor-textarea").fill("edited in browser");
  await page.getByRole("button", { name: /^Save$/ }).click();

  await expect(page.getByText(/Remote file changed on disk/i)).toBeVisible();
  await page.getByRole("button", { name: "Reload Remote Copy" }).click();
  await expect(page.locator(".editor-textarea")).toHaveValue("external edit");
});

test("runs owner jobs and replays output", async ({ page }) => {
  await gotoSignedIn(page, "/jobs");
  const stdoutPanel = page.locator(".job-output-grid .viewer-panel").first();

  await page.getByLabel("Command").fill("printf 'job-ok'");
  await page.getByRole("button", { name: "Run" }).click();

  await expect(stdoutPanel).toContainText("job-ok");
});

test("reconnects after a temporary offline period", async ({ page }) => {
  await gotoSignedIn(page, "/chat");
  const reconnectBanner = page.getByText(/You are offline|Reconnecting to DroidAgent/i);
  const prompt = "reconnect check";
  const assistantReply = page.locator(".chat-thread .message-card.assistant p").filter({
    hasText: new RegExp(`^Test harness reply: ${prompt}$`)
  });

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
  await expect(page.getByRole("heading", { name: "Operator Console" })).toBeVisible();
  const sendButton = page.getByRole("button", { name: "Send" });
  await page.getByPlaceholder("Send a message to the current OpenClaw session...").fill(prompt);
  await expect(sendButton).toBeEnabled();
  await sendButton.click();
  await expect(assistantReply.last()).toBeVisible();
});
