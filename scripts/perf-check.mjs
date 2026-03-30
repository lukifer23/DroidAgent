#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const artifactDir = path.join(repoRoot, "artifacts", "perf");
const budgetsPath = path.join(repoRoot, "perf-budgets.json");
const baselinePath = path.join(artifactDir, "baseline.json");

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

function formatMs(value) {
  return `${Number(value).toFixed(2)} ms`;
}

function resolveServerMetric(serverArtifact, rule) {
  const metric = (serverArtifact.metrics ?? []).find(
    (entry) => entry.pathname === rule.path,
  );
  if (!metric || !metric.summary) {
    return null;
  }
  return metric.summary[rule.stat] ?? null;
}

function resolveServerDiagnosticsMetric(serverArtifact, rule) {
  const metric = (serverArtifact.diagnostics?.metrics ?? []).find(
    (entry) => entry.name === rule.name,
  );
  if (!metric || !metric.summary) {
    return null;
  }
  return metric.summary[rule.stat] ?? null;
}

function resolveE2EMetric(e2eArtifacts, rule) {
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
  if (rule.aggregate === "p95") {
    return percentile(values, 0.95);
  }
  return percentile(values, 0.5);
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

async function main() {
  const [budgets, serverArtifact, e2eArtifacts] = await Promise.all([
    readJson(budgetsPath),
    readJson(path.join(artifactDir, "server-latest.json")),
    loadE2EArtifacts(),
  ]);
  const baseline = await readJson(baselinePath).catch(() => null);
  const maxRegressionRatio =
    typeof budgets.maxRegressionRatio === "number" ? budgets.maxRegressionRatio : 0.1;
  const failures = [];

  console.log("Performance budget check");
  for (const rule of budgets.metrics ?? []) {
    let value = null;
    if (rule.source === "server") {
      value = resolveServerMetric(serverArtifact, rule);
    } else if (rule.source === "serverDiagnostics") {
      value = resolveServerDiagnosticsMetric(serverArtifact, rule);
    } else if (rule.source === "e2e") {
      value = resolveE2EMetric(e2eArtifacts, rule);
    }

    if (typeof value !== "number") {
      if (!rule.optional) {
        failures.push(`Missing metric: ${rule.id}`);
      }
      console.log(`- ${rule.id}: missing${rule.optional ? " (optional)" : ""}`);
      continue;
    }

    const overBudget = value > rule.budgetMs;
    let overRegression = false;
    const baselineValue = baseline?.metrics?.[rule.id];
    const regressionLimit =
      typeof baselineValue === "number"
        ? baselineValue * (1 + maxRegressionRatio)
        : null;
    if (regressionLimit !== null && value > regressionLimit) {
      overRegression = true;
    }

    const budgetStatus = overBudget ? "FAIL" : "PASS";
    const regressionLabel =
      regressionLimit === null
        ? "n/a"
        : `${formatMs(regressionLimit)} max (${Math.round(maxRegressionRatio * 100)}% over baseline)`;
    console.log(
      `- ${rule.id}: ${formatMs(value)} (budget ${formatMs(rule.budgetMs)}) [${budgetStatus}] regression ${regressionLabel}`,
    );

    if (overBudget) {
      failures.push(
        `${rule.id} exceeded budget: ${formatMs(value)} > ${formatMs(rule.budgetMs)}`,
      );
    }
    if (overRegression) {
      failures.push(
        `${rule.id} exceeded regression threshold: ${formatMs(value)} > ${formatMs(regressionLimit)}`,
      );
    }
  }

  if (failures.length > 0) {
    console.error("\nBudget check failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log("\nAll perf budgets passed.");
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
