#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

import {
  artifactDir,
  budgetsPath,
  loadBuildManifest,
  loadE2EArtifacts,
  readJson,
  repoRoot,
  resolveMetricValue,
} from "./perf-utils.mjs";

const outputPath = path.join(artifactDir, "baseline.json");

async function main() {
  const [budgets, serverArtifact, e2eArtifacts, buildManifest] =
    await Promise.all([
      readJson(budgetsPath),
      readJson(path.join(artifactDir, "server-latest.json")),
      loadE2EArtifacts(),
      loadBuildManifest(),
    ]);

  const metrics = {};
  for (const rule of budgets.metrics ?? []) {
    const value = await resolveMetricValue(rule, {
      serverArtifact,
      e2eArtifacts,
      buildManifest,
    });
    if (typeof value === "number") {
      metrics[rule.id] = Number(value.toFixed(2));
    }
  }

  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(
    outputPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        metrics,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`Wrote ${path.relative(repoRoot, outputPath)}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
