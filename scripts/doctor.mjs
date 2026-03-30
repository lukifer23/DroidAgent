#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { appDir, fetchJsonWithTimeout, repoRoot } from "./lib/common.mjs";

const baseUrl = process.env.DROIDAGENT_BASE_URL ?? "http://localhost:4318";
const requiredDirs = [
  appDir,
  path.join(appDir, "logs"),
  path.join(appDir, "logs", "jobs"),
  path.join(appDir, "tmp"),
  path.join(appDir, "state"),
  path.join(appDir, "uploads"),
  path.join(appDir, "tailscale")
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

  const bundledOpenclawPath = path.join(repoRoot, "apps", "server", "node_modules", ".bin", "openclaw");
  const openclawOnPath = commandVersion("openclaw");
  const openclawVersion = openclawOnPath ?? commandVersion(bundledOpenclawPath);
  const openclawBinary = openclawOnPath ? "openclaw" : bundledOpenclawPath;
  add(
    "openclaw",
    openclawVersion ? "ok" : "warn",
    openclawVersion ? `${openclawVersion} (${openclawOnPath ? "PATH" : "bundled"})` : "openclaw not found"
  );

  for (const binary of ["ollama", "tailscale", "signal-cli"]) {
    const version = commandVersion(binary);
    add(binary, version ? "ok" : "warn", version ?? `${binary} not found in PATH`);
  }

  for (const dir of requiredDirs) {
    add(path.relative(process.cwd(), dir) || dir, (await checkPath(dir)) ? "ok" : "warn", dir);
  }

  try {
    const response = await fetchJsonWithTimeout(`${baseUrl}/api/health`);
    add("Server health", response.ok ? "ok" : "warn", `${baseUrl}/api/health -> ${response.status}`);
    if (response.ok && response.payload) {
      const health = response.payload;
      add(
        "DroidAgent build",
        health.build?.version ? "ok" : "warn",
        health.build?.gitCommit
          ? `v${health.build.version} (${health.build.gitCommit})`
          : health.build?.version
            ? `v${health.build.version}`
            : "Build metadata unavailable"
      );
      add(
        "LaunchAgent",
        health.launchAgent?.running ? "ok" : health.launchAgent?.installed ? "warn" : "warn",
        health.launchAgent?.healthMessage ?? "LaunchAgent status unavailable"
      );
      add(
        "Passkey bootstrap",
        health.setup?.passkeyConfigured ? "ok" : "warn",
        health.setup?.passkeyConfigured ? "Owner passkey enrolled" : "Owner passkey is not enrolled yet"
      );
      add(
        "Selected runtime",
        health.setup?.selectedRuntime ? "ok" : "warn",
        health.setup?.selectedRuntime ?? "No runtime selected"
      );
      add(
        "Multimodal path",
        health.harnessSummary?.attachmentsEnabled ? "ok" : "warn",
        health.harnessSummary?.imageModel
          ? `${health.harnessSummary.imageModel} • ${health.harnessSummary.pdfModel ? "pdf tool on" : "pdf tool off"}`
          : "No local image/PDF model configured"
      );

      for (const runtime of health.runtimeSummary ?? []) {
        const metadata = runtime.metadata ?? {};
        const accelerationParts = [
          metadata.accelerationBackend ? `backend=${metadata.accelerationBackend}` : null,
          metadata.gpuModel ? `gpu=${metadata.gpuModel}` : null,
          metadata.activeProcessor ? `processor=${metadata.activeProcessor}` : null,
          metadata.flashAttention ? `flash=${metadata.flashAttention}` : null,
          metadata.gpuLayers ? `gpuLayers=${metadata.gpuLayers}` : null
        ].filter(Boolean);
        add(
          `Runtime:${runtime.label}`,
          runtime.health === "ok" ? "ok" : "warn",
          accelerationParts.length > 0
            ? `${runtime.healthMessage} (${accelerationParts.join(", ")})`
            : runtime.healthMessage
        );
      }

      const signal = health.channels?.config?.signal;
      if (signal) {
        add(
          "Signal",
          signal.channelConfigured ? "ok" : "warn",
          signal.channelConfigured ? "Signal channel configured" : signal.healthChecks?.find((entry) => entry.id === "account")?.message ?? "Signal not configured"
        );
      }
    }
  } catch {
    add("Server health", "warn", `No response from ${baseUrl}`);
  }

  try {
    const response = await fetchJsonWithTimeout(`${baseUrl}/api/access`);
    if (response.ok && response.payload) {
      const access = response.payload;
      add(
        "Access mode",
        access.serveStatus?.enabled ? "ok" : "warn",
        access.canonicalOrigin?.origin
          ? `${access.accessMode} -> ${access.canonicalOrigin.origin}`
          : `${access.accessMode} -> no canonical remote URL yet`
      );
      add(
        "Tailscale",
        access.tailscaleStatus?.httpsEnabled ? "ok" : "warn",
        access.tailscaleStatus?.healthMessage ?? "Tailscale status unavailable"
      );
      if (
        access.accessMode === "cloudflare" ||
        access.cloudflareStatus?.configured ||
        access.cloudflareStatus?.running
      ) {
        add(
          "Cloudflare backend",
          access.cloudflareStatus?.running ? "ok" : access.cloudflareStatus?.configured ? "warn" : "warn",
          access.cloudflareStatus?.healthMessage ?? "Cloudflare status unavailable"
        );
      }
    } else {
      add("Access mode", "warn", `${baseUrl}/api/access -> ${response.status}`);
    }
  } catch {
    add("Access mode", "warn", `No response from ${baseUrl}/api/access`);
  }

  if (openclawVersion) {
    try {
      const result = spawnSync(
        openclawBinary,
        ["--profile", "droidagent", "memory", "status", "--deep", "--json"],
        { encoding: "utf8" }
      );
      const payload = JSON.parse(result.stdout || "[]");
      const status = Array.isArray(payload) ? payload[0]?.status : null;
      const probe = Array.isArray(payload) ? payload[0]?.embeddingProbe : null;
      add(
        "Semantic memory",
        status?.provider === "ollama" && probe?.ok !== false ? "ok" : "warn",
        status?.provider
          ? `${status.provider}/${status.model} • ${status.files ?? 0} files • ${status.chunks ?? 0} chunks`
          : probe?.error ?? "Semantic memory is not ready yet"
      );
    } catch {
      add("Semantic memory", "warn", "Unable to read OpenClaw memory status");
    }
  }

  console.log("DroidAgent doctor");
  for (const check of checks) {
    console.log(`[${check.status.toUpperCase()}] ${check.label}: ${check.detail}`);
  }

  process.exit(0);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
