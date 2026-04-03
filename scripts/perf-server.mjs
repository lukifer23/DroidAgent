#!/usr/bin/env node
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawn, spawnSync } from "node:child_process";

import {
  repoRoot,
  resolvePerfReadyPath,
  resolveE2EStatePath,
  sleep,
  waitForFile,
  waitForHealth,
} from "./lib/common.mjs";

const artifactDir = path.resolve(
  repoRoot,
  process.env.DROIDAGENT_PERF_ARTIFACT_DIR?.trim() ||
    path.join("artifacts", "perf"),
);

function average(values) {
  return Number(
    (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2),
  );
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return Number(sorted[index].toFixed(2));
}

async function ensureHarnessServer() {
  if (process.env.DROIDAGENT_PERF_BASE_URL) {
    return {
      baseUrl: process.env.DROIDAGENT_PERF_BASE_URL,
      sessionToken: process.env.DROIDAGENT_PERF_SESSION_COOKIE ?? null,
      stop: async () => {},
    };
  }

  const harnessPort = process.env.DROIDAGENT_PERF_PORT ?? String(4420);
  const cleanupResult = spawnSync(
    "node",
    [path.join(repoRoot, "scripts", "cleanup-e2e-server.mjs")],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        DROIDAGENT_E2E_PORT: harnessPort,
      },
      encoding: "utf8",
    },
  );
  if (cleanupResult.status !== 0) {
    throw new Error(
      `Failed to clean up the perf harness on port ${harnessPort}: ${cleanupResult.stderr || cleanupResult.stdout || "unknown error"}`.trim(),
    );
  }
  const e2eStatePath = resolveE2EStatePath(harnessPort);
  await fs.rm(e2eStatePath, { force: true }).catch(() => undefined);
  const child = spawn(
    "node",
    [path.join(repoRoot, "apps", "server", "dist", "testing", "e2e-server.js")],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        DROIDAGENT_E2E_PORT: harnessPort,
        DROIDAGENT_PERF_MODE: "1",
      },
    },
  );

  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const state = JSON.parse(await fs.readFile(e2eStatePath, "utf8"));
        if (state.rootDir && state.mode === "live-runtime") {
          await waitForFile(resolvePerfReadyPath(state.rootDir));
        }
        await waitForHealth(state.baseUrl);
        if (state.rootDir && state.mode !== "live-runtime") {
          await waitForFile(resolvePerfReadyPath(state.rootDir));
        }
        return {
          baseUrl: state.baseUrl,
          sessionToken: state.sessionToken,
          stop: async () => {
            if (child.exitCode === null) {
              child.kill("SIGTERM");
            }
          },
        };
      } catch {
        await sleep(250);
      }
    }
  } catch (error) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }
    throw error;
  }

  if (child.exitCode === null) {
    child.kill("SIGTERM");
  }
  throw new Error("Timed out waiting for the deterministic perf harness.");
}

async function requestText(targetUrl, headers = {}) {
  return await request(targetUrl, {
    headers,
  });
}

async function request(targetUrl, options = {}) {
  const url = targetUrl instanceof URL ? targetUrl : new URL(targetUrl);
  const transport = url.protocol === "https:" ? https : http;

  return await new Promise((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: options.method ?? "GET",
        headers: options.headers ?? {},
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({
            ok:
              (response.statusCode ?? 500) >= 200 &&
              (response.statusCode ?? 500) < 300,
            status: response.statusCode ?? 500,
            body,
          });
        });
      },
    );

    request.on("error", reject);
    if (typeof options.body === "string") {
      request.write(options.body);
    }
    request.end();
  });
}

async function requestJson(targetUrl, options = {}) {
  const response = await request(targetUrl, options);
  return {
    ...response,
    json: response.body ? JSON.parse(response.body) : null,
  };
}

async function measureEndpoint(
  baseUrl,
  sessionToken,
  pathname,
  iterations,
  authenticated = false,
) {
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    const response = await requestText(
      new URL(pathname, baseUrl),
      authenticated && sessionToken
        ? { Cookie: `droidagent_session=${sessionToken}` }
        : {},
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
      maxMs: Math.max(...samples),
    },
  };
}

async function measureSingleRequest(
  baseUrl,
  sessionToken,
  pathname,
  authenticated = false,
) {
  const startedAt = performance.now();
  const response = await requestText(
    new URL(pathname, baseUrl),
    authenticated && sessionToken
      ? { Cookie: `droidagent_session=${sessionToken}` }
      : {},
  );
  if (!response.ok) {
    throw new Error(`${pathname} returned ${response.status}`);
  }

  return {
    pathname,
    durationMs: Number((performance.now() - startedAt).toFixed(2)),
  };
}

async function ensureChatRelayMetric(baseUrl, sessionToken) {
  const authHeaders = sessionToken
    ? { Cookie: `droidagent_session=${sessionToken}` }
    : {};
  const createdSession = await requestJson(new URL("/api/sessions", baseUrl), {
    method: "POST",
    headers: authHeaders,
  });
  if (!createdSession.ok || !createdSession.json?.id) {
    throw new Error("Failed to create a session for the perf relay probe.");
  }
  const sessionId = createdSession.json.id;

  try {
    const sendStartedAtMs = Date.now();
    const sendResponse = await request(
      new URL(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, baseUrl),
      {
        method: "POST",
        headers: {
          ...authHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "Reply with exactly OK.",
          attachments: [],
        }),
      },
    );
    if (!sendResponse.ok) {
      throw new Error(
        `Perf relay probe returned ${sendResponse.status} while sending a chat message.`,
      );
    }

    const relayAttempts =
      process.env.DROIDAGENT_E2E_REAL_RUNTIME === "1" ? 240 : 40;
    const relayIntervalMs =
      process.env.DROIDAGENT_E2E_REAL_RUNTIME === "1" ? 500 : 250;
    for (let attempt = 0; attempt < relayAttempts; attempt += 1) {
      const diagnosticsResponse = await requestJson(
        new URL("/api/diagnostics/performance", baseUrl),
        {
          headers: authHeaders,
        },
      );
      const metrics = diagnosticsResponse.json?.metrics ?? [];
      const findRecentSample = (name) => {
        const metric = metrics.find((entry) => entry.name === name);
        return metric?.recentSamples?.find((sample) => {
          if (sample.context?.sessionId !== sessionId) {
            return false;
          }
          const endedAtMs = sample.endedAt
            ? Date.parse(sample.endedAt)
            : Number.NaN;
          return Number.isFinite(endedAtMs) && endedAtMs >= sendStartedAtMs;
        });
      };

      const firstDeltaForward = findRecentSample("chat.stream.firstDeltaForward");
      if (firstDeltaForward?.durationMs != null) {
        return;
      }

      const firstDelta = findRecentSample("chat.stream.acceptedToFirstDelta");
      const completion = findRecentSample("chat.stream.acceptedToCompleteRelay");
      if (firstDelta?.context?.outcome === "error") {
        throw new Error(
          `Perf relay probe failed before first delta for ${sessionId}.`,
        );
      }
      if (completion?.context?.outcome === "error") {
        throw new Error(`Perf relay probe failed for ${sessionId}.`);
      }
      if (
        firstDelta?.context?.outcome === "no-delta" &&
        completion?.context?.outcome === "done"
      ) {
        return;
      }

      await sleep(relayIntervalMs);
    }

    throw new Error(
      `Timed out waiting for the server chat relay metric for ${sessionId}.`,
    );
  } finally {
    await request(
      new URL(`/api/sessions/${encodeURIComponent(sessionId)}/archive`, baseUrl),
      {
        method: "POST",
        headers: {
          ...authHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
    ).catch(() => undefined);
  }
}

async function main() {
  await fs.mkdir(artifactDir, { recursive: true });
  const harness = await ensureHarnessServer();

  try {
    const coldMetrics = [];
    coldMetrics.push(
      await measureSingleRequest(
        harness.baseUrl,
        harness.sessionToken,
        "/api/access",
      ),
    );
    coldMetrics.push(
      await measureSingleRequest(
        harness.baseUrl,
        harness.sessionToken,
        "/api/dashboard",
        true,
      ),
    );

    const [accessMetric, dashboardMetric] = await Promise.all([
      measureEndpoint(harness.baseUrl, harness.sessionToken, "/api/access", 20),
      measureEndpoint(
        harness.baseUrl,
        harness.sessionToken,
        "/api/dashboard",
        20,
        true,
      ),
    ]);

    await ensureChatRelayMetric(harness.baseUrl, harness.sessionToken);

    const diagnosticsResponse = await requestText(
      new URL("/api/diagnostics/performance", harness.baseUrl),
      harness.sessionToken
        ? { Cookie: `droidagent_session=${harness.sessionToken}` }
        : {},
    );
    const diagnostics = diagnosticsResponse.ok
      ? JSON.parse(diagnosticsResponse.body)
      : null;
    const healthResponse = await requestJson(
      new URL("/api/health", harness.baseUrl),
      harness.sessionToken
        ? {
            headers: {
              Cookie: `droidagent_session=${harness.sessionToken}`,
            },
          }
        : {},
    );

    const artifact = {
      generatedAt: new Date().toISOString(),
      mode: process.env.DROIDAGENT_PERF_BASE_URL
        ? "live-base-url"
        : process.env.DROIDAGENT_E2E_REAL_RUNTIME === "1"
          ? "live-runtime"
          : "seeded-harness",
      profileId: process.env.DROIDAGENT_PERF_PROFILE_ID?.trim() || null,
      baseUrl: harness.baseUrl,
      harnessSummary: healthResponse.ok
        ? (healthResponse.json?.harnessSummary ?? null)
        : null,
      coldMetrics,
      metrics: [accessMetric, dashboardMetric],
      diagnostics,
    };

    const outputPath = path.join(artifactDir, "server-latest.json");
    await fs.writeFile(outputPath, JSON.stringify(artifact, null, 2), "utf8");
    console.log(`Wrote ${path.relative(repoRoot, outputPath)}`);
    for (const metric of artifact.coldMetrics) {
      console.log(`${metric.pathname} cold: ${metric.durationMs} ms`);
    }
    for (const metric of artifact.metrics) {
      console.log(
        `${metric.pathname}: p95 ${metric.summary.p95Ms} ms, avg ${metric.summary.avgMs} ms`,
      );
    }
  } finally {
    await harness.stop();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
