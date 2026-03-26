#!/usr/bin/env node
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";

const repoRoot = process.cwd();
const artifactDir = path.join(repoRoot, "artifacts", "perf");
const e2eStatePath = path.join(repoRoot, "artifacts", "e2e", "state.json");

function average(values) {
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return Number(sorted[index].toFixed(2));
}

async function waitForHealth(baseUrl) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${baseUrl}/api/health`);
}

async function ensureHarnessServer() {
  if (process.env.DROIDAGENT_PERF_BASE_URL) {
    return {
      baseUrl: process.env.DROIDAGENT_PERF_BASE_URL,
      sessionToken: process.env.DROIDAGENT_PERF_SESSION_COOKIE ?? null,
      stop: async () => {}
    };
  }

  await fs.rm(e2eStatePath, { force: true }).catch(() => undefined);
  const harnessPort = process.env.DROIDAGENT_PERF_PORT ?? String(4420);
  const child = spawn("node", [path.join(repoRoot, "apps", "server", "dist", "testing", "e2e-server.js")], {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      DROIDAGENT_E2E_PORT: harnessPort
    }
  });

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const state = JSON.parse(await fs.readFile(e2eStatePath, "utf8"));
      await waitForHealth(state.baseUrl);
      return {
        baseUrl: state.baseUrl,
        sessionToken: state.sessionToken,
        stop: async () => {
          if (child.exitCode === null) {
            child.kill("SIGTERM");
          }
        }
      };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new Error("Timed out waiting for the deterministic perf harness.");
}

async function requestText(targetUrl, headers = {}) {
  const url = targetUrl instanceof URL ? targetUrl : new URL(targetUrl);
  const transport = url.protocol === "https:" ? https : http;

  return await new Promise((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: "GET",
        headers
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({
            ok: (response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300,
            status: response.statusCode ?? 500,
            body
          });
        });
      }
    );

    request.on("error", reject);
    request.end();
  });
}

async function measureEndpoint(baseUrl, sessionToken, pathname, iterations, authenticated = false) {
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    const response = await requestText(
      new URL(pathname, baseUrl),
      authenticated && sessionToken ? { Cookie: `droidagent_session=${sessionToken}` } : {}
    );
    if (!response.ok) {
      throw new Error(`${pathname} returned ${response.status}`);
    }
    samples.push(Number((performance.now() - startedAt).toFixed(2)));
  }

  return {
    pathname,
    iterations,
    samples,
    summary: {
      avgMs: average(samples),
      p50Ms: percentile(samples, 0.5),
      p95Ms: percentile(samples, 0.95),
      maxMs: Math.max(...samples)
    }
  };
}

async function main() {
  await fs.mkdir(artifactDir, { recursive: true });
  const harness = await ensureHarnessServer();

  try {
    const [accessMetric, dashboardMetric] = await Promise.all([
      measureEndpoint(harness.baseUrl, harness.sessionToken, "/api/access", 20),
      measureEndpoint(harness.baseUrl, harness.sessionToken, "/api/dashboard", 20, true)
    ]);

    const diagnosticsResponse = await requestText(
      new URL("/api/diagnostics/performance", harness.baseUrl),
      harness.sessionToken ? { Cookie: `droidagent_session=${harness.sessionToken}` } : {}
    );
    const diagnostics = diagnosticsResponse.ok ? JSON.parse(diagnosticsResponse.body) : null;

    const artifact = {
      generatedAt: new Date().toISOString(),
      mode: process.env.DROIDAGENT_PERF_BASE_URL ? "live" : "seeded-harness",
      baseUrl: harness.baseUrl,
      metrics: [accessMetric, dashboardMetric],
      diagnostics
    };

    const outputPath = path.join(artifactDir, "server-latest.json");
    await fs.writeFile(outputPath, JSON.stringify(artifact, null, 2), "utf8");
    console.log(`Wrote ${path.relative(repoRoot, outputPath)}`);
    for (const metric of artifact.metrics) {
      console.log(`${metric.pathname}: p95 ${metric.summary.p95Ms} ms, avg ${metric.summary.avgMs} ms`);
    }
  } finally {
    await harness.stop();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
