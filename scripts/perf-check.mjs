#!/usr/bin/env node
import path from "node:path";

import {
  artifactDir,
  baselinePath,
  budgetsPath,
  formatMetricValue,
  loadBuildManifest,
  loadE2EArtifacts,
  metricBudget,
  metricUnit,
  readJson,
  resolveMetricValue,
} from "./perf-utils.mjs";

async function main() {
  const [budgets, serverArtifact, e2eArtifacts, buildManifest] =
    await Promise.all([
      readJson(budgetsPath),
      readJson(path.join(artifactDir, "server-latest.json")),
      loadE2EArtifacts(),
      loadBuildManifest(),
    ]);
  const baseline = await readJson(baselinePath).catch(() => null);
  const maxRegressionRatio =
    typeof budgets.maxRegressionRatio === "number"
      ? budgets.maxRegressionRatio
      : 0.1;
  const failures = [];

  console.log("Performance budget check");
  for (const rule of budgets.metrics ?? []) {
    const value = await resolveMetricValue(rule, {
      serverArtifact,
      e2eArtifacts,
      buildManifest,
    });
    const budget = metricBudget(rule);
    const unit = metricUnit(rule);
    if (typeof value !== "number") {
      if (!rule.optional) {
        failures.push(`Missing metric: ${rule.id}`);
      }
      console.log(`- ${rule.id}: missing${rule.optional ? " (optional)" : ""}`);
      continue;
    }
    if (typeof budget !== "number") {
      failures.push(`Missing budget value: ${rule.id}`);
      console.log(`- ${rule.id}: missing budget`);
      continue;
    }

    const overBudget = value > budget;
    let overRegression = false;
    const baselineValue = baseline?.metrics?.[rule.id];
    const skipRegression = rule.skipRegression === true || rule.optional === true;
    const regressionLimit =
      !skipRegression && typeof baselineValue === "number"
        ? baselineValue * (1 + maxRegressionRatio)
        : null;
    if (regressionLimit !== null && value > regressionLimit) {
      overRegression = true;
    }

    const budgetStatus = overBudget ? "FAIL" : "PASS";
    const regressionLabel =
      regressionLimit === null
        ? "n/a"
        : `${formatMetricValue(regressionLimit, unit)} max (${Math.round(
            maxRegressionRatio * 100,
          )}% over baseline)`;
    console.log(
      `- ${rule.id}: ${formatMetricValue(value, unit)} (budget ${formatMetricValue(
        budget,
        unit,
      )}) [${budgetStatus}] regression ${regressionLabel}`,
    );

    if (overBudget) {
      failures.push(
        `${rule.id} exceeded budget: ${formatMetricValue(value, unit)} > ${formatMetricValue(budget, unit)}`,
      );
    }
    if (overRegression && regressionLimit !== null) {
      failures.push(
        `${rule.id} exceeded regression threshold: ${formatMetricValue(value, unit)} > ${formatMetricValue(regressionLimit, unit)}`,
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
