#!/usr/bin/env node
import path from "node:path";

import {
  artifactDir,
  baselinePath,
  budgetsPath,
  formatMetricValue,
  loadBuildManifest,
  loadE2EArtifacts,
  metricUnit,
  readJson,
  resolveMetricValue,
} from "./perf-utils.mjs";

async function main() {
  const serverPath = path.join(artifactDir, "server-latest.json");

  try {
    const server = await readJson(serverPath);
    console.log("Server benchmarks");
    for (const metric of server.coldMetrics ?? []) {
      console.log(`- ${metric.pathname} cold: ${metric.durationMs} ms`);
    }
    for (const metric of server.metrics ?? []) {
      const label = metric.name ?? metric.pathname;
      console.log(
        `- ${label}: p95 ${metric.summary.p95Ms} ms, avg ${metric.summary.avgMs} ms`,
      );
    }
    const coldDashboardMetric = (server.diagnostics?.metrics ?? []).find(
      (entry) => entry.name === "dashboard.snapshot.compose",
    );
    if (typeof coldDashboardMetric?.summary?.maxDurationMs === "number") {
      console.log(
        `- dashboard.snapshot.compose max: ${coldDashboardMetric.summary.maxDurationMs} ms`,
      );
    }
  } catch {
    console.log("Server benchmarks: no artifact found");
  }

  const e2eArtifacts = await loadE2EArtifacts();
  if (e2eArtifacts.length === 0) {
    console.log("E2E benchmarks: no artifact found");
  } else {
    console.log("E2E benchmarks");
    for (const artifact of e2eArtifacts) {
      console.log(`- ${artifact.project} (${artifact.browserName})`);
      for (const metric of artifact.metrics ?? []) {
        console.log(`  ${metric.name}: ${metric.durationMs} ms`);
      }
    }
  }

  try {
    const [budgets, serverArtifact, buildManifest, baseline] =
      await Promise.all([
        readJson(budgetsPath),
        readJson(serverPath),
        loadBuildManifest(),
        readJson(baselinePath).catch(() => null),
      ]);
    console.log("Tracked budgets");
    for (const rule of budgets.metrics ?? []) {
      const value = await resolveMetricValue(rule, {
        serverArtifact,
        e2eArtifacts,
        buildManifest,
      });
      if (typeof value !== "number") {
        continue;
      }
      const baselineValue = baseline?.metrics?.[rule.id];
      const baselineLabel =
        typeof baselineValue === "number"
          ? `baseline ${formatMetricValue(baselineValue, metricUnit(rule))}`
          : "baseline n/a";
      console.log(
        `- ${rule.id}: ${formatMetricValue(value, metricUnit(rule))} (${baselineLabel})`,
      );
    }
  } catch {
    console.log("Tracked budgets: no budget metadata found");
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
