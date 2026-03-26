#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const baseUrl = process.env.DROIDAGENT_BASE_URL ?? "http://127.0.0.1:4318";
const appDir = path.join(os.homedir(), ".droidagent");
const requiredDirs = [
  appDir,
  path.join(appDir, "logs"),
  path.join(appDir, "logs", "jobs"),
  path.join(appDir, "tmp"),
  path.join(appDir, "state")
];

function commandVersion(command, args = ["--version"]) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim() || result.stderr.trim() || "installed";
}

async function checkPath(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const checks = [];
  const add = (label, status, detail) => {
    checks.push({ label, status, detail });
  };

  add("Node", "ok", process.version);
  add("pnpm", commandVersion("pnpm", ["-v"]) ? "ok" : "warn", commandVersion("pnpm", ["-v"]) ?? "pnpm not found");
  add("Homebrew", commandVersion("brew", ["--version"]) ? "ok" : "warn", commandVersion("brew", ["--version"])?.split("\n")[0] ?? "brew not found");

  for (const binary of ["openclaw", "ollama", "tailscale", "cloudflared", "signal-cli"]) {
    const version = commandVersion(binary);
    add(binary, version ? "ok" : "warn", version ?? `${binary} not found in PATH`);
  }

  for (const dir of requiredDirs) {
    add(path.relative(process.cwd(), dir) || dir, (await checkPath(dir)) ? "ok" : "warn", dir);
  }

  try {
    const response = await fetch(`${baseUrl}/api/health`);
    add("Server health", response.ok ? "ok" : "warn", `${baseUrl}/api/health -> ${response.status}`);
  } catch {
    add("Server health", "warn", `No response from ${baseUrl}`);
  }

  console.log("DroidAgent doctor");
  for (const check of checks) {
    console.log(`[${check.status.toUpperCase()}] ${check.label}: ${check.detail}`);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
