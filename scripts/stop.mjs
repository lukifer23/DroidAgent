#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  maintenanceStatePath,
  readMaintenanceStatus,
  repoRoot,
} from "./lib/common.mjs";

const execFileAsync = promisify(execFile);

const homeDir = os.homedir();
const profile = process.env.DROIDAGENT_OPENCLAW_PROFILE ?? "droidagent";
const launchAgentLabel = "com.droidagent.server";
const launchAgentPath = path.join(
  homeDir,
  "Library",
  "LaunchAgents",
  `${launchAgentLabel}.plist`,
);
const openclawStateDir = path.join(homeDir, `.openclaw-${profile}`);
const tailscaleSocketPath = path.join(
  homeDir,
  ".droidagent",
  "tailscale",
  "tailscaled.sock",
);

const quiet = process.argv.includes("--quiet");
const coreOnly = process.argv.includes("--core-only");

function log(message) {
  if (!quiet) {
    console.log(message);
  }
}

async function run(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      timeout: options.timeout ?? 5000,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    if (options.allowFailure) {
      return { stdout: "", stderr: String(error) };
    }
    throw error;
  }
}

async function listProcesses() {
  const { stdout } = await run("ps", ["-ax", "-o", "pid=", "-o", "command="]);
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (!match) {
        return null;
      }
      return {
        pid: Number(match[1]),
        command: match[2].trim(),
      };
    })
    .filter(Boolean);
}

function isManagedServer(command) {
  return command.includes(path.join(repoRoot, "apps", "server", "dist", "index.js"));
}

function isManagedOpenClaw(command) {
  return (
    /openclaw/i.test(command) &&
    (command.includes(`--profile ${profile}`) ||
      command.includes(openclawStateDir) ||
      command.includes(repoRoot) ||
      command.includes("ai.openclaw.droidagent"))
  );
}

function isManagedLlama(command) {
  return (
    /llama-server/i.test(command) &&
    command.includes("--port 8012")
  );
}

function isManagedTailscale(command) {
  return (
    /tailscaled/i.test(command) &&
    command.includes(tailscaleSocketPath)
  );
}

async function bootoutLaunchAgent() {
  if (!fs.existsSync(launchAgentPath)) {
    return;
  }

  const uid = process.getuid?.();
  if (typeof uid !== "number") {
    return;
  }

  await run(
    "launchctl",
    ["bootout", `gui/${uid}`, launchAgentPath],
    { allowFailure: true },
  );
}

async function terminatePids(pids) {
  const uniquePids = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (uniquePids.length === 0) {
    return;
  }

  for (const pid of uniquePids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore
    }
  }

  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const live = (await listProcesses())
      .filter((entry) => uniquePids.includes(entry.pid))
      .map((entry) => entry.pid);
    if (live.length === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  for (const pid of uniquePids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore
    }
  }
}

await bootoutLaunchAgent();
const maintenance = await readMaintenanceStatus();

if (maintenance?.active) {
  log(
    `Maintenance marker found (${maintenance.current?.phase ?? "active"}). Proceeding with explicit stop and clearing the stale marker afterwards.`,
  );
}

const processes = await listProcesses();
const managed = processes.filter((entry) => {
  if (entry.pid === process.pid) {
    return false;
  }

  if (isManagedServer(entry.command) || isManagedOpenClaw(entry.command)) {
    return true;
  }

  if (coreOnly) {
    return false;
  }

  return isManagedLlama(entry.command) || isManagedTailscale(entry.command);
});

if (managed.length === 0) {
  if (maintenance) {
    await fs.promises.rm(maintenanceStatePath, { force: true }).catch(() => {});
    log("No managed DroidAgent processes found. Cleared maintenance marker.");
    process.exit(0);
  }
  log("No managed DroidAgent processes found.");
  process.exit(0);
}

await terminatePids(managed.map((entry) => entry.pid));
await fs.promises.rm(maintenanceStatePath, { force: true }).catch(() => {});
log(`Stopped ${managed.length} managed DroidAgent process${managed.length === 1 ? "" : "es"}.`);
