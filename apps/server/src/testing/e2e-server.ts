import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import Database from "better-sqlite3";
import type { SetupState } from "@droidagent/shared";

import type { E2EFixtureState, E2EWorkspaceFile } from "./e2e-fixture.js";
import { writeE2EWorkspaceFiles } from "./e2e-fixture.js";
import type {
  AccessSettings,
  RuntimeSettings,
} from "../services/app-state-service.js";
import {
  DEFAULT_OLLAMA_CONTEXT_WINDOW,
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
  DEFAULT_OLLAMA_MODEL,
} from "../services/app-state-service.js";

const OPENCLAW_GATEWAY_TOKEN = "droidagent-e2e-token";

const SERVER_PORT = Number(process.env.DROIDAGENT_E2E_PORT ?? 4418);
const USE_REAL_RUNTIME = process.env.DROIDAGENT_E2E_REAL_RUNTIME === "1";
const PERF_PROFILE_ID = process.env.DROIDAGENT_PERF_PROFILE_ID?.trim() || null;
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, "..", "..", "..", "..");
const artifactDir = path.join(repoRoot, "artifacts", "e2e");
const statePath = path.join(artifactDir, `state-${SERVER_PORT}.json`);

function resolveOllamaModel(): string {
  return (
    process.env.DROIDAGENT_E2E_OLLAMA_MODEL?.trim() || DEFAULT_OLLAMA_MODEL
  );
}

function resolveOllamaContextWindow(): number {
  const raw = Number(process.env.DROIDAGENT_E2E_OLLAMA_CONTEXT_WINDOW ?? "");
  if (Number.isFinite(raw) && raw >= 2048) {
    return Math.floor(raw);
  }
  return DEFAULT_OLLAMA_CONTEXT_WINDOW;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function waitForHealth(
  baseUrl: string,
  pathname = "/api/health",
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}${pathname}`);
      if (response.ok) {
        return;
      }
    } catch {
      // keep waiting
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${baseUrl}${pathname}.`);
}

async function requestJson(
  baseUrl: string,
  pathname: string,
  options: {
    method?: string;
    sessionToken?: string | null;
    body?: unknown;
  } = {},
) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method: options.method ?? "GET",
    headers: {
      ...(options.sessionToken
        ? {
            cookie: `droidagent_session=${options.sessionToken}`,
          }
        : {}),
      ...(options.body === undefined
        ? {}
        : {
            "content-type": "application/json",
          }),
    },
    ...(options.body === undefined
      ? {}
      : {
          body: JSON.stringify(options.body),
        }),
  });
  return {
    ok: response.ok,
    status: response.status,
    json: response.ok ? await response.json() : null,
    text: response.ok ? null : await response.text(),
  };
}

async function configureLiveOllamaProfile(
  baseUrl: string,
  sessionToken: string,
  modelId: string,
  contextWindow: number,
): Promise<void> {
  const response = await requestJson(baseUrl, "/api/runtime/ollama/profile", {
    method: "POST",
    sessionToken,
    body: {
      modelId,
      contextWindow,
      pull: true,
    },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to configure live Ollama profile: ${response.status} ${response.text ?? ""}`.trim(),
    );
  }

  const openclawStartResponse = await requestJson(
    baseUrl,
    "/api/runtime/openclaw/start",
    {
      method: "POST",
      sessionToken,
      body: {},
    },
  );
  if (!openclawStartResponse.ok) {
    throw new Error(
      `Failed to start live OpenClaw runtime: ${openclawStartResponse.status} ${openclawStartResponse.text ?? ""}`.trim(),
    );
  }

  for (let attempt = 0; attempt < 240; attempt += 1) {
    const healthResponse = await requestJson(baseUrl, "/api/health");
    const harnessSummary = healthResponse.json as {
      harnessSummary?: {
        activeModel?: string | null;
        contextWindow?: number | null;
      };
    } | null;
    if (
      harnessSummary?.harnessSummary?.activeModel === `ollama/${modelId}` &&
      harnessSummary.harnessSummary.contextWindow === contextWindow
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Timed out waiting for live harness profile ollama/${modelId} at ${contextWindow}.`,
  );
}

async function waitForLiveChatReady(
  baseUrl: string,
  sessionToken: string,
): Promise<void> {
  const createSessionResponse = await requestJson(baseUrl, "/api/sessions", {
    method: "POST",
    sessionToken,
    body: {},
  });
  if (!createSessionResponse.ok || !createSessionResponse.json?.id) {
    throw new Error(
      `Failed to create a live perf probe session: ${createSessionResponse.status} ${createSessionResponse.text ?? ""}`.trim(),
    );
  }

  const sessionId = createSessionResponse.json.id as string;
  try {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const sendResponse = await requestJson(
        baseUrl,
        `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
        {
          method: "POST",
          sessionToken,
          body: {
            text: "live perf readiness ping",
            attachments: [],
          },
        },
      );
      if (sendResponse.ok && sendResponse.status === 202) {
        await requestJson(
          baseUrl,
          `/api/sessions/${encodeURIComponent(sessionId)}/abort`,
          {
            method: "POST",
            sessionToken,
            body: {},
          },
        ).catch(() => undefined);
        return;
      }
      if (sendResponse.status !== 423 && sendResponse.status !== 503) {
        throw new Error(
          `Live chat readiness probe failed: ${sendResponse.status} ${sendResponse.text ?? ""}`.trim(),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error("Timed out waiting for live chat send readiness.");
  } finally {
    await requestJson(
      baseUrl,
      `/api/sessions/${encodeURIComponent(sessionId)}/archive`,
      {
        method: "POST",
        sessionToken,
        body: {},
      },
    ).catch(() => undefined);
  }
}

async function seedEnvironment(rootDir: string): Promise<E2EFixtureState> {
  const homeDir = path.join(rootDir, "home");
  const appDir = path.join(homeDir, ".droidagent");
  const logsDir = path.join(appDir, "logs");
  const jobsLogsDir = path.join(logsDir, "jobs");
  const tempDir = path.join(appDir, "tmp");
  const stateDir = path.join(appDir, "state");
  const uploadsDir = path.join(appDir, "uploads");
  const workspaceRoot = path.join(rootDir, "workspace");
  const sampleFilePath = path.join(workspaceRoot, "notes.txt");
  const dbPath = path.join(appDir, "droidagent.sqlite");
  const userId = randomUUID();
  const sessionToken = randomUUID();
  const sessionId = randomUUID();
  const resetToken = randomUUID();
  const now = new Date().toISOString();
  const ollamaModel = resolveOllamaModel();
  const ollamaContextWindow = resolveOllamaContextWindow();
  const workspaceFiles: E2EWorkspaceFile[] = [
    {
      path: "AGENTS.md",
      content: "# DroidAgent Operator Rules\n",
    },
    {
      path: "TOOLS.md",
      content: "# DroidAgent Tooling Notes\n",
    },
    {
      path: "IDENTITY.md",
      content: "# Identity\n",
    },
    {
      path: "USER.md",
      content: "# User\n",
    },
    {
      path: "SOUL.md",
      content: "# Tone\n",
    },
    {
      path: "MEMORY.md",
      content: "# Durable Memory\n",
    },
    {
      path: "PREFERENCES.md",
      content: "# Personal Preferences\n",
    },
    {
      path: "HEARTBEAT.md",
      content: "# Heartbeat\n",
    },
    {
      path: "memory/README.md",
      content: "# Workspace Memory Notes\n",
    },
    {
      path: "skills/README.md",
      content: "# Workspace Skills\n",
    },
    {
      path: "notes.txt",
      content: "first pass",
    },
    {
      path: "README.md",
      content: "# DroidAgent E2E Workspace\n",
    },
  ];

  for (const dir of [
    homeDir,
    appDir,
    logsDir,
    jobsLogsDir,
    tempDir,
    stateDir,
    uploadsDir,
    workspaceRoot,
  ]) {
    await fs.mkdir(dir, { recursive: true });
  }

  await writeE2EWorkspaceFiles(workspaceRoot, workspaceFiles);

  const sqlite = new Database(dbPath);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      credential_id TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT NOT NULL DEFAULT '[]',
      device_type TEXT NOT NULL DEFAULT 'singleDevice',
      backed_up INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      origin TEXT,
      device_label TEXT,
      user_agent TEXT
    );
    CREATE TABLE IF NOT EXISTS auth_challenges (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      challenge TEXT NOT NULL,
      user_id TEXT,
      rp_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      command TEXT NOT NULL,
      cwd TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      exit_code INTEGER,
      last_line TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS memory_drafts (
      id TEXT PRIMARY KEY,
      target TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_label TEXT,
      source_ref TEXT,
      session_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      applied_at TEXT,
      dismissed_at TEXT,
      failed_at TEXT,
      last_error TEXT,
      applied_path TEXT
    );
    CREATE TABLE IF NOT EXISTS maintenance_operations (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      action TEXT NOT NULL,
      phase TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      requested_at TEXT NOT NULL,
      started_at TEXT,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      requested_by_user_id TEXT,
      requested_from_localhost INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS decision_records (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      source_system TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      details TEXT NOT NULL,
      status TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      resolved_at TEXT,
      actor_user_id TEXT,
      actor_label TEXT,
      session_id TEXT,
      actor_session_id TEXT,
      device_label TEXT,
      resolution TEXT,
      source_updated_at TEXT,
      updated_at TEXT NOT NULL
    );
  `);

  sqlite
    .prepare(
      "INSERT INTO users (id, username, display_name, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(userId, "owner", "DroidAgent Owner", now);
  sqlite
    .prepare(
      "INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at, origin, device_label, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      sessionId,
      userId,
      hashToken(sessionToken),
      new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
      now,
      "http://127.0.0.1:3000",
      "E2E Browser",
      "Playwright",
    );

  const runtimeSettings: RuntimeSettings = {
    selectedRuntime: "ollama",
    activeProviderId: "ollama-default",
    ollamaModel,
    ollamaEmbeddingModel: DEFAULT_OLLAMA_EMBEDDING_MODEL,
    ollamaContextWindow,
    llamaCppModel: "ggml-org/gemma-3-1b-it-GGUF",
    llamaCppContextWindow: 8192,
    workspaceRoot,
    remoteAccessEnabled: false,
    launchAgentInstalled: false,
    signalCliPath: null,
    signalJavaHome: null,
    signalPhoneNumber: null,
    signalAccountId: null,
    signalDeviceName: null,
    signalCliVersion: null,
    signalReceiveMode: "persistent",
    signalRegistrationMode: "none",
    signalRegistrationState: "unconfigured",
    signalLinkUri: null,
    signalDaemonUrl: null,
    signalDaemonPid: null,
    signalDaemonState: "stopped",
    signalLastError: null,
    signalLastStartedAt: null,
    signalCompatibilityWarning: null,
    smartContextManagementEnabled: true,
    cloudProviders: {
      openai: { defaultModel: "openai/gpt-5.4", lastUpdatedAt: null },
      anthropic: {
        defaultModel: "anthropic/claude-sonnet-4-5",
        lastUpdatedAt: null,
      },
      openrouter: {
        defaultModel: "openrouter/anthropic/claude-sonnet-4-5",
        lastUpdatedAt: null,
      },
      gemini: { defaultModel: "gemini/gemini-2.5-pro", lastUpdatedAt: null },
      groq: {
        defaultModel: "groq/llama-3.3-70b-versatile",
        lastUpdatedAt: null,
      },
      together: {
        defaultModel: "together/deepseek-ai/DeepSeek-R1-Distill-Llama-70B-free",
        lastUpdatedAt: null,
      },
      xai: { defaultModel: "xai/grok-4-fast", lastUpdatedAt: null },
    },
  };

  const setupState: SetupState = {
    completedSteps: [
      "auth",
      "workspace",
      "runtime",
      "models",
      "providerRegistration",
    ],
    currentStep: "remoteAccess",
    passkeyConfigured: true,
    workspaceRoot,
    selectedRuntime: "ollama",
    selectedModel: ollamaModel,
    remoteAccessEnabled: false,
    signalEnabled: false,
  };

  const accessSettings: AccessSettings = {
    mode: "loopback",
    canonicalOrigin: null,
    bootstrapTokenHash: null,
    bootstrapTokenIssuedAt: null,
    bootstrapTokenExpiresAt: null,
    cloudflareHostname: null,
    cloudflareLastStartedAt: null,
  };

  const insertSetting = sqlite.prepare(
    "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  );
  insertSetting.run("runtimeSettings", JSON.stringify(runtimeSettings), now);
  insertSetting.run("setupState", JSON.stringify(setupState), now);
  insertSetting.run("accessSettings", JSON.stringify(accessSettings), now);
  insertSetting.run(
    "openclawGatewayToken",
    JSON.stringify(OPENCLAW_GATEWAY_TOKEN),
    now,
  );
  sqlite.close();

  await fs.mkdir(artifactDir, { recursive: true });
  const state: E2EFixtureState = {
    baseUrl: `http://127.0.0.1:${SERVER_PORT}`,
    sessionToken,
    workspaceRoot,
    sampleFilePath,
    resetToken,
    rootDir,
    homeDir,
    appDir,
    dbPath,
    mode: USE_REAL_RUNTIME ? "live-runtime" : "test-harness",
    profileId: PERF_PROFILE_ID,
    seed: {
      runtimeSettings,
      accessSettings,
      setupState,
      openclawGatewayToken: OPENCLAW_GATEWAY_TOKEN,
      workspaceFiles,
    },
  };
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
  return state;
}

async function main() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "droidagent-e2e-"));
  const state = await seedEnvironment(rootDir);
  const perfMode = process.env.DROIDAGENT_PERF_MODE === "1";
  const perfReadyFilePath = path.join(rootDir, ".perf-ready");
  if (perfMode) {
    await fs.rm(perfReadyFilePath, { force: true }).catch(() => undefined);
  }

  const child = spawn(
    "node",
    [path.join(repoRoot, "apps", "server", "dist", "index.js")],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: path.join(rootDir, "home"),
        DROIDAGENT_PORT: String(SERVER_PORT),
        ...(USE_REAL_RUNTIME ? {} : { DROIDAGENT_TEST_MODE: "1" }),
        DROIDAGENT_E2E_ROOT_DIR: rootDir,
        DROIDAGENT_E2E_RESET_TOKEN: state.resetToken,
        DROIDAGENT_E2E_STATE_PATH: statePath,
        ...(perfMode
          ? {
              DROIDAGENT_PERF_READY_FILE: perfReadyFilePath,
            }
          : {}),
        DROIDAGENT_OPENCLAW_BIN: path.join(
          repoRoot,
          "apps",
          "server",
          "node_modules",
          ".bin",
          "openclaw",
        ),
      },
      stdio: "inherit",
    },
  );

  const cleanup = async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }
    await fs
      .rm(rootDir, { recursive: true, force: true })
      .catch(() => undefined);
    await fs.rm(statePath, { force: true }).catch(() => undefined);
    await fs.rm(perfReadyFilePath, { force: true }).catch(() => undefined);
  };

  process.on("SIGINT", () => {
    void cleanup().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void cleanup().finally(() => process.exit(0));
  });
  child.on("exit", (code) => {
    void cleanup().finally(() => process.exit(code ?? 0));
  });

  await waitForHealth(state.baseUrl, perfMode ? "/api/auth/me" : "/api/health");
  if (perfMode && USE_REAL_RUNTIME) {
    await configureLiveOllamaProfile(
      state.baseUrl,
      state.sessionToken,
      state.seed.runtimeSettings.ollamaModel,
      state.seed.runtimeSettings.ollamaContextWindow,
    );
    await waitForLiveChatReady(state.baseUrl, state.sessionToken);
  }
  if (perfMode) {
    const response = await fetch(
      new URL("/api/memory/prepare", state.baseUrl),
      {
        method: "POST",
        headers: {
          cookie: `droidagent_session=${state.sessionToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );
    if (!response.ok) {
      throw new Error(`Failed to prewarm memory prepare: ${response.status}`);
    }

    let prewarmed = false;
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const dashboardResponse = await fetch(
        new URL("/api/dashboard", state.baseUrl),
        {
          headers: {
            cookie: `droidagent_session=${state.sessionToken}`,
          },
        },
      );
      if (!dashboardResponse.ok) {
        throw new Error(
          `Failed to read prewarmed dashboard: ${dashboardResponse.status}`,
        );
      }
      const dashboard = (await dashboardResponse.json()) as {
        memory?: {
          semanticReady?: boolean;
          prepareState?: string | null;
        };
      };
      if (
        dashboard.memory?.semanticReady &&
        dashboard.memory?.prepareState === "completed"
      ) {
        prewarmed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!prewarmed) {
      throw new Error("Timed out waiting for prewarmed semantic memory.");
    }
    await fs.writeFile(perfReadyFilePath, "ready\n", "utf8");
  }
  console.log(`DroidAgent E2E server ready at ${state.baseUrl}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
