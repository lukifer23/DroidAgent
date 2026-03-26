import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import Database from "better-sqlite3";

interface E2EState {
  baseUrl: string;
  sessionToken: string;
  workspaceRoot: string;
  sampleFilePath: string;
}

const SERVER_PORT = Number(process.env.DROIDAGENT_E2E_PORT ?? 4418);
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, "..", "..", "..", "..");
const artifactDir = path.join(repoRoot, "artifacts", "e2e");
const statePath = path.join(artifactDir, "state.json");

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function waitForHealth(baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // keep waiting
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error("Timed out waiting for the E2E DroidAgent server.");
}

async function seedEnvironment(rootDir: string): Promise<E2EState> {
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
  const now = new Date().toISOString();

  for (const dir of [homeDir, appDir, logsDir, jobsLogsDir, tempDir, stateDir, uploadsDir, workspaceRoot]) {
    await fs.mkdir(dir, { recursive: true });
  }

  await fs.writeFile(sampleFilePath, "first pass", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "README.md"), "# DroidAgent E2E Workspace\n", "utf8");

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
      created_at TEXT NOT NULL
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
  `);

  sqlite.prepare("INSERT INTO users (id, username, display_name, created_at) VALUES (?, ?, ?, ?)").run(
    userId,
    "owner",
    "DroidAgent Owner",
    now
  );
  sqlite
    .prepare("INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(sessionId, userId, hashToken(sessionToken), new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(), now);

  const runtimeSettings = {
    selectedRuntime: "ollama",
    activeProviderId: "ollama-default",
    ollamaModel: "qwen3.5:4b",
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
      anthropic: { defaultModel: "anthropic/claude-sonnet-4-5", lastUpdatedAt: null },
      openrouter: { defaultModel: "openrouter/anthropic/claude-sonnet-4-5", lastUpdatedAt: null },
      gemini: { defaultModel: "gemini/gemini-2.5-pro", lastUpdatedAt: null },
      groq: { defaultModel: "groq/llama-3.3-70b-versatile", lastUpdatedAt: null },
      together: { defaultModel: "together/deepseek-ai/DeepSeek-R1-Distill-Llama-70B-free", lastUpdatedAt: null },
      xai: { defaultModel: "xai/grok-4-fast", lastUpdatedAt: null }
    }
  };

  const setupState = {
    completedSteps: ["auth", "workspace", "runtime", "models", "providerRegistration"],
    currentStep: "remoteAccess",
    passkeyConfigured: true,
    workspaceRoot,
    selectedRuntime: "ollama",
    selectedModel: "qwen3.5:4b",
    remoteAccessEnabled: false,
    signalEnabled: false
  };

  const accessSettings = {
    mode: "loopback",
    canonicalOrigin: null,
    bootstrapTokenHash: null,
    bootstrapTokenIssuedAt: null,
    bootstrapTokenExpiresAt: null,
    cloudflareHostname: null,
    cloudflareLastStartedAt: null
  };

  const insertSetting = sqlite.prepare(
    "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  );
  insertSetting.run("runtimeSettings", JSON.stringify(runtimeSettings), now);
  insertSetting.run("setupState", JSON.stringify(setupState), now);
  insertSetting.run("accessSettings", JSON.stringify(accessSettings), now);
  insertSetting.run("openclawGatewayToken", JSON.stringify("droidagent-e2e-token"), now);
  sqlite.close();

  await fs.mkdir(artifactDir, { recursive: true });
  const state: E2EState = {
    baseUrl: `http://127.0.0.1:${SERVER_PORT}`,
    sessionToken,
    workspaceRoot,
    sampleFilePath
  };
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
  return state;
}

async function main() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "droidagent-e2e-"));
  const state = await seedEnvironment(rootDir);

  const child = spawn("node", [path.join(repoRoot, "apps", "server", "dist", "index.js")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: path.join(rootDir, "home"),
      DROIDAGENT_PORT: String(SERVER_PORT),
      DROIDAGENT_TEST_MODE: "1"
    },
    stdio: "inherit"
  });

  const cleanup = async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }
    await fs.rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(statePath, { force: true }).catch(() => undefined);
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

  await waitForHealth(state.baseUrl);
  console.log(`DroidAgent E2E server ready at ${state.baseUrl}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
