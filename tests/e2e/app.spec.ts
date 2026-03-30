import fs from "node:fs/promises";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { gotoSignedIn } from "./support";

async function expectNoHorizontalOverflow(page: Page) {
  const hasOverflow = await page.evaluate(() => {
    return document.documentElement.scrollWidth > document.documentElement.clientWidth;
  });
  expect(hasOverflow).toBe(false);
}

async function clickWithDetachRetry(locator: Locator): Promise<void> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await locator.click();
      return;
    } catch (error) {
      lastError = error;
      if (!(error instanceof Error) || !/detached from the DOM/i.test(error.message)) {
        throw error;
      }
    }
  }

  throw lastError;
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
  await page.getByRole("link", { name: "Files", exact: true }).click();
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
  await expect(page.getByText("Latest run finished")).toBeVisible();
  await expect(page.getByText("Model/tool wait")).toBeVisible();
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

test("captures a chat message as a memory draft, edits it, and applies it", async ({
  page,
}) => {
  const state = await gotoSignedIn(page, "/chat");
  const prompt = "remember that the operator prefers local-first tooling";

  await page
    .getByPlaceholder(
      "Ask DroidAgent to inspect code, summarize a PDF, analyze an image, edit files, or run a command...",
    )
    .fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();

  const userMessage = page.locator(".message-card.user").filter({
    hasText: prompt,
  });
  await expect(userMessage).toBeVisible();
  await userMessage.locator(".message-utility-tray summary").click();
  await clickWithDetachRetry(
    page
      .locator(".message-card.user")
      .filter({ hasText: prompt })
      .getByRole("button", { name: "Memory" }),
  );

  await page.getByRole("link", { name: "Settings" }).click();
  const draftCard = page.locator(".panel-card.compact").filter({
    hasText: prompt,
  });
  await expect(draftCard).toBeVisible();
  await draftCard.getByRole("button", { name: "Edit" }).click();
  await draftCard.getByPlaceholder("Draft title").fill("Local-first preference");
  await draftCard
    .locator("textarea")
    .fill("The operator prefers local-first tooling for daily work.");
  await page.getByRole("button", { name: "Save Draft" }).click();

  const updatedDraftCard = page.locator(".panel-card.compact").filter({
    hasText: "Local-first preference",
  });
  await expect(updatedDraftCard).toBeVisible();
  await updatedDraftCard.getByRole("button", { name: "Apply" }).click();
  await expect
    .poll(async () => {
      const response = await page.request.get(
        new URL("/api/files/content?path=MEMORY.md", state.baseUrl).toString(),
      );
      const body = (await response.json()) as { content?: string };
      return (
        body.content?.includes(
          "The operator prefers local-first tooling for daily work.",
        ) ?? false
      );
    })
    .toBe(true);
});

test("repairs missing workspace memory files before opening them", async ({
  page,
}) => {
  const state = await gotoSignedIn(page, "/files");

  await fs.rm(`${state.workspaceRoot}/MEMORY.md`, { force: true });

  await page.getByRole("button", { name: "Open MEMORY.md" }).click();
  await expect(page.locator(".editor-textarea")).toContainText(
    "Durable Memory",
  );
});

test("rejects stale memory draft mutations with a conflict response", async ({
  page,
}) => {
  const state = await gotoSignedIn(page, "/chat");
  const prompt = "remember the stale draft path";

  await page
    .getByPlaceholder(
      "Ask DroidAgent to inspect code, summarize a PDF, analyze an image, edit files, or run a command...",
    )
    .fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();

  const userMessage = page.locator(".message-card.user").filter({
    hasText: prompt,
  });
  await expect(userMessage).toBeVisible();
  await userMessage.locator(".message-utility-tray summary").click();
  await clickWithDetachRetry(
    page
      .locator(".message-card.user")
      .filter({ hasText: prompt })
      .getByRole("button", { name: "Memory" }),
  );

  const draftsResponse = await page.request.get(
    new URL("/api/memory/drafts", state.baseUrl).toString(),
  );
  expect(draftsResponse.ok()).toBe(true);
  const drafts = (await draftsResponse.json()) as Array<{
    id: string;
    updatedAt: string;
  }>;
  const draft = drafts[0];
  expect(draft).toBeTruthy();

  const firstUpdate = await page.request.patch(
    new URL(`/api/memory/drafts/${encodeURIComponent(draft!.id)}`, state.baseUrl).toString(),
    {
      data: {
        expectedUpdatedAt: draft!.updatedAt,
        title: "Fresh title",
      },
    },
  );
  expect(firstUpdate.ok()).toBe(true);

  const staleUpdate = await page.request.patch(
    new URL(`/api/memory/drafts/${encodeURIComponent(draft!.id)}`, state.baseUrl).toString(),
    {
      data: {
        expectedUpdatedAt: draft!.updatedAt,
        title: "Stale title",
      },
    },
  );
  expect(staleUpdate.status()).toBe(409);
  await expect(staleUpdate.json()).resolves.toMatchObject({
    error: expect.stringMatching(/changed since it was loaded/i),
  });
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

test("runs a suggested shell block inside chat", async ({ page }) => {
  await gotoSignedIn(page, "/chat");

  await page
    .getByPlaceholder(
      "Ask DroidAgent to inspect code, summarize a PDF, analyze an image, edit files, or run a command...",
    )
    .fill("show a shell block");
  await page.getByRole("button", { name: "Send" }).click();

  const assistantMessage = page.locator(".message-card.assistant").filter({
    hasText: "Runnable shell example:",
  });
  await expect(assistantMessage).toBeVisible();
  await assistantMessage.getByRole("button", { name: "Run in Chat" }).click();

  await expect(
    page.locator(".message-card.assistant").filter({
      hasText: /suggested-job-ok/i,
    }).last(),
  ).toBeVisible();
  await expect(page.locator(".chat-inline-job-card")).toHaveCount(0);
});

test("creates, closes, and restores chat sessions from the rail", async ({
  page,
}) => {
  await gotoSignedIn(page, "/chat");

  await page.getByRole("button", { name: "New chat" }).click();
  await expect(page.getByText("New chat ready.")).toBeVisible();

  const sessionPicker = page.locator(".operator-session-picker select");
  await expect(sessionPicker).toBeVisible();
  await expect(sessionPicker.locator("option")).toHaveCount(2);

  await page.getByRole("button", { name: "Close chat" }).click();
  await expect(page.getByText("Chat closed.")).toBeVisible();

  const archivedCard = page.locator(".operator-session-archive-card").first();
  await expect(archivedCard).toBeVisible();
  await archivedCard.getByRole("button", { name: "Restore" }).click();

  await expect(page.getByText("Archived chat restored.")).toBeVisible();
  await expect(sessionPicker.locator("option")).toHaveCount(2);
});

test("closes the main operator chat and immediately replaces it", async ({
  page,
}) => {
  await gotoSignedIn(page, "/chat");

  await expect(page.locator(".operator-chat-overview-copy h2")).toHaveText(
    "Operator Chat",
  );
  await page.getByRole("button", { name: "Close chat" }).click();
  await expect(page.getByText("Chat closed.")).toBeVisible();

  await expect(page.locator(".operator-chat-overview-copy h2")).toHaveText(
    "Operator Chat 2",
  );
  await expect(
    page.locator(".operator-session-archive-card").filter({
      hasText: "Operator Chat",
    }),
  ).toBeVisible();
});

test("runs a suggested shell block inside a newly created chat session", async ({
  page,
}) => {
  await gotoSignedIn(page, "/chat");

  await page.getByRole("button", { name: "New chat" }).click();
  await expect(page.getByText("New chat ready.")).toBeVisible();

  const sessionPicker = page.locator(".operator-session-picker select");
  await expect(sessionPicker).toBeVisible();
  const activeSessionValue = await sessionPicker.inputValue();
  expect(activeSessionValue).not.toBe("web:operator");

  await page
    .getByPlaceholder(
      "Ask DroidAgent to inspect code, summarize a PDF, analyze an image, edit files, or run a command...",
    )
    .fill("show a shell block");
  await page.getByRole("button", { name: "Send" }).click();

  const assistantMessage = page.locator(".message-card.assistant").filter({
    hasText: "Runnable shell example:",
  });
  await expect(assistantMessage).toBeVisible();
  await assistantMessage.getByRole("button", { name: "Run in Chat" }).click();

  await expect(
    page.locator(".message-card.assistant").filter({
      hasText: /suggested-job-ok/i,
    }).last(),
  ).toBeVisible();
  await expect(page.locator(".chat-inline-job-card")).toHaveCount(0);
  await expect(sessionPicker).toHaveValue(activeSessionValue);
});

test("opens a suggested shell block in the terminal without executing it", async ({
  page,
}) => {
  await gotoSignedIn(page, "/chat");

  await page
    .getByPlaceholder(
      "Ask DroidAgent to inspect code, summarize a PDF, analyze an image, edit files, or run a command...",
    )
    .fill("show a shell block");
  await page.getByRole("button", { name: "Send" }).click();

  const assistantMessage = page.locator(".message-card.assistant").filter({
    hasText: "Runnable shell example:",
  });
  await expect(assistantMessage).toBeVisible();
  await assistantMessage.getByRole("button", { name: "Open in Terminal" }).click();

  await expect(
    page.getByRole("heading", {
      name: /Recover permissions, auth, and host state directly/i,
    }),
  ).toBeVisible();
  await expect(page.getByText("Suggested command loaded")).toBeVisible();
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
