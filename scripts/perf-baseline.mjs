#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const artifactDir = path.join(repoRoot, "artifacts", "perf");
const budgetsPath = path.join(repoRoot, "perf-budgets.json");
const outputPath = path.join(artifactDir, "baseline.json");

function percentile(values, ratio) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return Number(sorted[index].toFixed(2));
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function loadE2EArtifacts() {
  const files = await fs.readdir(artifactDir).catch(() => []);
  const e2eFiles = files.filter(
    (name) => name.startsWith("e2e-") && name.endsWith(".json"),
  );
  const artifacts = [];
  for (const fileName of e2eFiles) {
    artifacts.push(await readJson(path.join(artifactDir, fileName)));
  }
  return artifacts;
}

function metricValue(rule, serverArtifact, e2eArtifacts) {
  if (rule.source === "server") {
    const metric = (serverArtifact.metrics ?? []).find(
      (entry) => entry.pathname === rule.path,
    );
    return metric?.summary?.[rule.stat] ?? null;
  }
  if (rule.source === "serverDiagnostics") {
    const metric = (serverArtifact.diagnostics?.metrics ?? []).find(
      (entry) => entry.name === rule.name,
    );
    return metric?.summary?.[rule.stat] ?? null;
  }
  if (rule.source === "e2e") {
    const values = [];
    for (const artifact of e2eArtifacts) {
      const metric = (artifact.metrics ?? []).find((entry) => entry.name === rule.name);
      if (metric && typeof metric.durationMs === "number") {
        values.push(metric.durationMs);
      }
    }
    if (values.length === 0) {
      return null;
    }
    return rule.aggregate === "p95" ? percentile(values, 0.95) : percentile(values, 0.5);
  }
  return null;
}

async function main() {
  const [budgets, serverArtifact, e2eArtifacts] = await Promise.all([
    readJson(budgetsPath),
    readJson(path.join(artifactDir, "server-latest.json")),
    loadE2EArtifacts(),
  ]);

  const metrics = {};
  for (const rule of budgets.metrics ?? []) {
    const value = metricValue(rule, serverArtifact, e2eArtifacts);
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
