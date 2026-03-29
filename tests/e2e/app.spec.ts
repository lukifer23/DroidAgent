import fs from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

import { gotoSignedIn } from "./support";

async function expectNoHorizontalOverflow(page: Page) {
  const hasOverflow = await page.evaluate(() => {
    return document.documentElement.scrollWidth > document.documentElement.clientWidth;
  });
  expect(hasOverflow).toBe(false);
}

test("shows the passkey auth screen before sign-in", async ({
  page,
  baseURL,
}) => {
  await page.goto(baseURL ?? "http://127.0.0.1:4418");

  await expect(
    page.getByRole("heading", {
      name: /Sign in to DroidAgent|Set up owner access/i,
    }),
  ).toBeVisible();
  await expect(page.getByText(/Passkey Readiness/i)).toBeVisible();
});

test("loads the signed-in shell and bottom-nav routes", async ({ page }) => {
  await gotoSignedIn(page, "/chat");

  await expect(page.locator(".topbar-copy h1")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Host$/i }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole("link", { name: "Files" }).click();
  await expect(
    page.getByRole("button", { name: "Create Directory" }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(
    page.getByRole("heading", { name: "Performance Diagnostics" }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("loads the simplified setup screen", async ({ page }) => {
  await gotoSignedIn(page, "/setup");

  await expect(
    page.getByRole("heading", {
      name: /Prepare this Mac, then add your phone/i,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: /Preparing DroidAgent|Prepare host|Refresh status/i,
    }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("starts a rescue terminal session and streams PTY output", async ({
  page,
}) => {
  const state = await gotoSignedIn(page, "/terminal");

  await expect(
    page.getByRole("heading", { name: /Recover permissions, auth, and host state directly/i }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.getByRole("button", { name: "Start Workspace Shell" }).click();
  await expect(page.getByText(/Workspace rescue shell/i)).toBeVisible();

  await page.locator(".terminal-canvas").click();
  await page.keyboard.type("printf 'term-ok'\\r");

  await expect
    .poll(async () => {
      const response = await page.request.get(
        new URL("/api/terminal/session", state.baseUrl).toString(),
      );
      const body = (await response.json()) as { transcript?: string };
      return body.transcript?.includes("term-ok") ?? false;
    })
    .toBe(true);
});

test("streams chat replies through the real websocket path", async ({
  page,
}, testInfo) => {
  await gotoSignedIn(page, "/chat");
  const prompt = `hello from e2e ${testInfo.project.name}`;
  const sendButton = page.getByRole("button", { name: "Send" });

  await page
    .getByPlaceholder(
      "Ask DroidAgent to inspect code, summarize a PDF, analyze an image, edit files, or run a command...",
    )
    .fill(prompt);
  await expect(sendButton).toBeEnabled();
  await sendButton.click();

  await expect(page.getByText(prompt, { exact: true })).toBeVisible();
  await expect(
    page.getByText(`Test harness reply: ${prompt}`, { exact: true }).last(),
  ).toBeVisible();
  await expect(
    page.locator(".metric-chip span").filter({ hasText: /ms|s/ }).first(),
  ).toBeVisible();
});

test("uploads chat attachments and shows them in the live thread", async ({
  page,
}) => {
  await gotoSignedIn(page, "/chat");

  await page.locator('input[type="file"]').setInputFiles([
    {
      name: "notes.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Notes\n"),
    },
  ]);
  await expect(page.getByText(/notes\.md/i)).toBeVisible();

  await page.getByRole("button", { name: "Send" }).click();

  await expect(
    page.locator(".message-card.user .attachment-chip").filter({
      hasText: /notes\.md/i,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(/Test harness reply: Inspect the attached files\. \(1 attachment\)/i).last(),
  ).toBeVisible();
  await expect(
    page.locator(".run-state-card, .message-card.assistant").filter({
      hasText: /1 attachment/i,
    }).last(),
  ).toBeVisible();
});

test("surfaces file conflicts from disk changes and allows reload", async ({
  page,
}) => {
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
  const reconnectBanner = page.getByText(
    /You are offline|Reconnecting to DroidAgent/i,
  );
  const prompt = "reconnect check";

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
  await expect(page.locator(".topbar-copy h1")).toBeVisible();
  const sendButton = page.getByRole("button", { name: "Send" });
  await page
    .getByPlaceholder(
      "Ask DroidAgent to inspect code, summarize a PDF, analyze an image, edit files, or run a command...",
    )
    .fill(prompt);
  await expect(sendButton).toBeEnabled();
  await sendButton.click();
  await expect(
    page.getByText(`Test harness reply: ${prompt}`, { exact: true }).last(),
  ).toBeVisible();
});
