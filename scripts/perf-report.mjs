#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const artifactDir = path.join(repoRoot, "artifacts", "perf");

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function main() {
  const files = await fs.readdir(artifactDir).catch(() => []);
  const serverPath = path.join(artifactDir, "server-latest.json");
  const e2ePaths = files.filter((name) => name.startsWith("e2e-") && name.endsWith(".json")).map((name) => path.join(artifactDir, name));

  try {
    const server = await readJson(serverPath);
    console.log("Server benchmarks");
    for (const metric of server.metrics ?? []) {
      console.log(`- ${metric.pathname}: p95 ${metric.summary.p95Ms} ms, avg ${metric.summary.avgMs} ms`);
    }
  } catch {
    console.log("Server benchmarks: no artifact found");
  }

  if (e2ePaths.length === 0) {
    console.log("E2E benchmarks: no artifact found");
    return;
  }

  console.log("E2E benchmarks");
  for (const filePath of e2ePaths) {
    const artifact = await readJson(filePath);
    console.log(`- ${path.basename(filePath)} (${artifact.project})`);
    for (const metric of artifact.metrics ?? []) {
      console.log(`  ${metric.name}: ${metric.durationMs} ms`);
    }
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
