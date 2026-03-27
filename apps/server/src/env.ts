import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_PORT = Number(process.env.DROIDAGENT_PORT ?? 4318);
export const OPENCLAW_GATEWAY_PORT = Number(process.env.DROIDAGENT_OPENCLAW_PORT ?? 18789);
export const LLAMA_CPP_PORT = Number(process.env.DROIDAGENT_LLAMA_CPP_PORT ?? 8012);
export const LLAMA_CPP_GPU_LAYERS = Number(process.env.DROIDAGENT_LLAMA_CPP_GPU_LAYERS ?? 999);
export const LLAMA_CPP_BATCH_SIZE = Number(process.env.DROIDAGENT_LLAMA_CPP_BATCH_SIZE ?? 1024);
export const LLAMA_CPP_UBATCH_SIZE = Number(process.env.DROIDAGENT_LLAMA_CPP_UBATCH_SIZE ?? 512);
export const LLAMA_CPP_FLASH_ATTN = process.env.DROIDAGENT_LLAMA_CPP_FLASH_ATTN ?? "auto";
export const SIGNAL_DAEMON_PORT = Number(process.env.DROIDAGENT_SIGNAL_PORT ?? 8091);
export const OPENCLAW_PROFILE = process.env.DROIDAGENT_OPENCLAW_PROFILE ?? "droidagent";
export const TEST_MODE = process.env.DROIDAGENT_TEST_MODE === "1";
export const OPENCLAW_GATEWAY_URL = `ws://127.0.0.1:${OPENCLAW_GATEWAY_PORT}`;
export const OPENCLAW_GATEWAY_HTTP_URL = `http://127.0.0.1:${OPENCLAW_GATEWAY_PORT}`;
export const SIGNAL_DAEMON_URL = `http://127.0.0.1:${SIGNAL_DAEMON_PORT}`;
export const LAUNCH_AGENT_LABEL = "com.droidagent.server";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(thisDir, "..");
const workspaceRoot = path.resolve(serverRoot, "..", "..");

export const paths = {
  workspaceRoot,
  serverRoot,
  appDir: path.join(os.homedir(), ".droidagent"),
  dbPath: path.join(os.homedir(), ".droidagent", "droidagent.sqlite"),
  logsDir: path.join(os.homedir(), ".droidagent", "logs"),
  jobsLogsDir: path.join(os.homedir(), ".droidagent", "logs", "jobs"),
  tempDir: path.join(os.homedir(), ".droidagent", "tmp"),
  uploadsDir: path.join(os.homedir(), ".droidagent", "uploads"),
  stateDir: path.join(os.homedir(), ".droidagent", "state"),
  launchAgentPath: path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`),
  launchAgentStdoutPath: path.join(os.homedir(), ".droidagent", "logs", "launch-agent.stdout.log"),
  launchAgentStderrPath: path.join(os.homedir(), ".droidagent", "logs", "launch-agent.stderr.log"),
  cloudflareLogPath: path.join(os.homedir(), ".droidagent", "logs", "cloudflared.log"),
  tailscaleDir: path.join(os.homedir(), ".droidagent", "tailscale"),
  tailscaleSocketPath: path.join(os.homedir(), ".droidagent", "tailscale", "tailscaled.sock"),
  tailscaleStatePath: path.join(os.homedir(), ".droidagent", "tailscale", "tailscaled.state"),
  tailscaleLogPath: path.join(os.homedir(), ".droidagent", "logs", "tailscaled.log"),
  openClawStateDir: path.join(os.homedir(), `.openclaw-${OPENCLAW_PROFILE}`),
  openClawConfigPath: path.join(os.homedir(), `.openclaw-${OPENCLAW_PROFILE}`, "openclaw.json"),
  openClawEnvPath: path.join(os.homedir(), `.openclaw-${OPENCLAW_PROFILE}`, ".env"),
  signalCliConfigDir: path.join(os.homedir(), ".droidagent", "signal-cli"),
  signalDaemonLogPath: path.join(os.homedir(), ".droidagent", "logs", "signal-daemon.log"),
  appsServerBin: path.join(workspaceRoot, "apps", "server", "node_modules", ".bin", "openclaw"),
  webDistDir: path.join(workspaceRoot, "apps", "web", "dist")
};

export function ensureAppDirs(): void {
  for (const dir of [paths.appDir, paths.logsDir, paths.jobsLogsDir, paths.tempDir, paths.uploadsDir, paths.stateDir, paths.signalCliConfigDir, paths.tailscaleDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function resolveOpenClawBin(): string | null {
  const candidates = [
    process.env.DROIDAGENT_OPENCLAW_BIN,
    path.join(serverRoot, "node_modules", ".bin", "openclaw"),
    paths.appsServerBin,
    path.join(workspaceRoot, "node_modules", ".bin", "openclaw")
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function baseEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: os.homedir(),
    PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN
  };
}
