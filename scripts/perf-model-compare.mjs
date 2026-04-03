#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  artifactDir as defaultArtifactDir,
  percentile,
  readJson,
  repoRoot,
} from "./perf-utils.mjs";
import {
  formatPerfModelProfile,
  profileArtifactDir,
  resolvePerfModelProfiles,
} from "./perf-model-profiles.mjs";

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        ...env,
      },
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(`${command} ${args.join(" ")} exited with ${code ?? 1}`),
      );
    });
  });
}

function resolveE2EP95Metric(artifacts, metricName) {
  const samples = artifacts.flatMap((artifact) =>
    (artifact.metrics ?? [])
      .filter((entry) => entry.name === metricName)
      .map((entry) => entry.durationMs)
      .filter((value) => typeof value === "number"),
  );
  if (samples.length === 0) {
    return null;
  }
  return percentile(samples, 0.95);
}

function resolveServerPathP95(serverArtifact, pathname) {
  return (
    serverArtifact.metrics?.find((entry) => entry.pathname === pathname)
      ?.summary?.p95Ms ?? null
  );
}

function resolveServerDiagnosticLast(serverArtifact, metricName) {
  return (
    serverArtifact.diagnostics?.metrics?.find(
      (entry) => entry.name === metricName,
    )?.summary?.lastDurationMs ?? null
  );
}

function deltaSummary(baselineValue, candidateValue) {
  if (
    typeof baselineValue !== "number" ||
    typeof candidateValue !== "number" ||
    baselineValue === 0
  ) {
    return null;
  }
  const deltaMs = Number((candidateValue - baselineValue).toFixed(2));
  const deltaPct = Number(
    (((candidateValue - baselineValue) / baselineValue) * 100).toFixed(2),
  );
  return {
    deltaMs,
    deltaPct,
  };
}

function profileEnv(profile, laneArtifactDir) {
  const env = {
    DROIDAGENT_PERF_LIVE: "1",
    DROIDAGENT_E2E_REAL_RUNTIME: "1",
    DROIDAGENT_E2E_RUNTIME_PROVIDER: profile.provider,
    DROIDAGENT_PERF_PORT: String(profile.appPort),
    DROIDAGENT_E2E_PORT: String(profile.appPort),
    DROIDAGENT_OPENCLAW_PORT: String(profile.openclawPort),
    DROIDAGENT_PERF_ARTIFACT_DIR: laneArtifactDir,
    DROIDAGENT_PERF_PROFILE_ID: profile.id,
  };
  if (profile.provider === "llamaCpp") {
    return {
      ...env,
      DROIDAGENT_E2E_LLAMACPP_MODEL: profile.modelRef,
      DROIDAGENT_E2E_LLAMACPP_CONTEXT_WINDOW: String(profile.contextWindow),
    };
  }
  return {
    ...env,
    DROIDAGENT_E2E_OLLAMA_MODEL: profile.modelRef,
    DROIDAGENT_E2E_OLLAMA_CONTEXT_WINDOW: String(profile.contextWindow),
  };
}

async function readLaneMetrics(profile) {
  const laneDir = path.resolve(repoRoot, profileArtifactDir(profile));
  const serverArtifact = await readJson(
    path.join(laneDir, "server-latest.json"),
  );
  const e2eFiles = (await fs.readdir(laneDir))
    .filter((name) => name.startsWith("e2e-") && name.endsWith(".json"))
    .sort();
  const e2eArtifacts = await Promise.all(
    e2eFiles.map((fileName) => readJson(path.join(laneDir, fileName))),
  );
  return {
    laneDir,
    serverArtifact,
    e2eArtifacts,
    summary: {
      harnessModel:
        serverArtifact.harnessSummary?.activeModel ??
        e2eArtifacts[0]?.harnessSummary?.activeModel ??
        null,
      contextWindow:
        serverArtifact.harnessSummary?.contextWindow ??
        e2eArtifacts[0]?.harnessSummary?.contextWindow ??
        null,
      serverAccessP95Ms: resolveServerPathP95(serverArtifact, "/api/access"),
      serverDashboardP95Ms: resolveServerPathP95(
        serverArtifact,
        "/api/dashboard",
      ),
      serverAcceptedToFirstDeltaMs: resolveServerDiagnosticLast(
        serverArtifact,
        "chat.stream.acceptedToFirstDelta",
      ),
      serverAcceptedToDoneMs: resolveServerDiagnosticLast(
        serverArtifact,
        "chat.stream.acceptedToCompleteRelay",
      ),
      serverFirstDeltaForwardMs: resolveServerDiagnosticLast(
        serverArtifact,
        "chat.stream.firstDeltaForward",
      ),
      routeSwitchP95Ms: resolveE2EP95Metric(e2eArtifacts, "route_switch_ms"),
      chatFirstTokenP95Ms: resolveE2EP95Metric(
        e2eArtifacts,
        "chat_first_token_visible_ms",
      ),
      chatDoneP95Ms: resolveE2EP95Metric(e2eArtifacts, "chat_done_ms"),
      reconnectP95Ms: resolveE2EP95Metric(e2eArtifacts, "reconnect_resync_ms"),
      memoryPrepareCompletionP95Ms: resolveE2EP95Metric(
        e2eArtifacts,
        "memory_prepare_completion_ms",
      ),
    },
  };
}

async function main() {
  const profiles = resolvePerfModelProfiles();
  const compareRoot = path.join("artifacts", "perf", "model-compare");
  await fs.mkdir(path.resolve(repoRoot, compareRoot), { recursive: true });

  await run("pnpm", ["build"]);

  for (const profile of profiles) {
    const laneArtifactDir = profileArtifactDir(profile);
    const env = profileEnv(profile, laneArtifactDir);
    console.log(`\nRunning ${formatPerfModelProfile(profile)}`);
    await run("pnpm", ["perf:server"], env);
    await run("pnpm", ["perf:e2e"], env);
    await run("pnpm", ["perf:report"], env);
  }

  const lanes = [];
  for (const profile of profiles) {
    lanes.push({
      profile,
      ...(await readLaneMetrics(profile)),
    });
  }

  const baselineLane = lanes[0];
  const comparisons = lanes.slice(1).map((lane) => ({
    baselineProfileId: baselineLane.profile.id,
    profileId: lane.profile.id,
    metrics: Object.fromEntries(
      Object.entries(lane.summary).map(([metricName, value]) => [
        metricName,
        {
          baseline: baselineLane.summary[metricName] ?? null,
          candidate: value ?? null,
          delta: deltaSummary(baselineLane.summary[metricName], value) ?? null,
        },
      ]),
    ),
  }));

  const summaryPath = path.resolve(compareRoot, "compare-summary.json");
  await fs.writeFile(
    summaryPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        profiles: lanes.map((lane) => ({
          ...lane.profile,
          laneDir: path.relative(repoRoot, lane.laneDir),
          summary: lane.summary,
        })),
        comparisons,
        deterministicArtifactDir: path.relative(repoRoot, defaultArtifactDir),
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(
    `\nComparison summary written to ${path.relative(repoRoot, summaryPath)}`,
  );
  for (const comparison of comparisons) {
    const candidateLane = lanes.find(
      (lane) => lane.profile.id === comparison.profileId,
    );
    if (!candidateLane) {
      continue;
    }
    console.log(
      `\n${formatPerfModelProfile(baselineLane.profile)} -> ${formatPerfModelProfile(candidateLane.profile)}`,
    );
    for (const metricName of [
      "serverAcceptedToFirstDeltaMs",
      "serverAcceptedToDoneMs",
      "chatFirstTokenP95Ms",
      "chatDoneP95Ms",
      "routeSwitchP95Ms",
    ]) {
      const metric = comparison.metrics[metricName];
      const delta = metric?.delta;
      if (
        typeof metric?.baseline !== "number" ||
        typeof metric?.candidate !== "number" ||
        !delta
      ) {
        continue;
      }
      console.log(
        `- ${metricName}: ${metric.baseline} ms -> ${metric.candidate} ms (${delta.deltaMs >= 0 ? "+" : ""}${delta.deltaMs} ms, ${delta.deltaPct >= 0 ? "+" : ""}${delta.deltaPct}%)`,
      );
    }
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
