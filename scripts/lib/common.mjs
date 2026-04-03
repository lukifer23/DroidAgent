import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const repoRoot = process.cwd();
export const appDir = path.join(os.homedir(), ".droidagent");
export const maintenanceStatePath = path.join(
  appDir,
  "state",
  "maintenance-status.json",
);

export async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveE2EStatePath(port) {
  return path.join(repoRoot, "artifacts", "e2e", `state-${port}.json`);
}

export function resolvePerfReadyPath(rootDir) {
  return path.join(rootDir, ".perf-ready");
}

export async function readJsonIfExists(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export async function readMaintenanceStatus() {
  return await readJsonIfExists(maintenanceStatePath, null);
}

export async function fetchJsonWithTimeout(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
    });
    return {
      ok: response.ok,
      status: response.status,
      payload: response.ok ? await response.json() : null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function waitForHealth(baseUrl, options = {}) {
  const attempts = options.attempts ?? 40;
  const intervalMs = options.intervalMs ?? 250;
  const pathname = options.pathname ?? "/api/health";

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}${pathname}`);
      if (response.ok) {
        return;
      }
    } catch {
      // retry
    }
    await sleep(intervalMs);
  }

  throw new Error(`Timed out waiting for ${baseUrl}${pathname}`);
}

export async function waitForFile(filePath, options = {}) {
  const attempts = options.attempts ?? 240;
  const intervalMs = options.intervalMs ?? 250;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      // retry
    }
    await sleep(intervalMs);
  }

  throw new Error(`Timed out waiting for ${filePath}`);
}
