import fs from "node:fs/promises";
import path from "node:path";

export const repoRoot = process.cwd();
const configuredArtifactDir = process.env.DROIDAGENT_PERF_ARTIFACT_DIR?.trim();
export const artifactDir = path.resolve(
  repoRoot,
  configuredArtifactDir || path.join("artifacts", "perf"),
);
export const budgetsPath = path.join(repoRoot, "perf-budgets.json");
export const baselinePath = path.join(artifactDir, "baseline.json");
export const buildManifestPath = path.join(
  repoRoot,
  "apps",
  "web",
  "dist",
  ".vite",
  "manifest.json",
);

export function percentile(values, ratio) {
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

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export async function loadE2EArtifacts() {
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

export async function loadBuildManifest() {
  return await readJson(buildManifestPath).catch(() => null);
}

export function resolveServerMetric(serverArtifact, rule) {
  const metric = (serverArtifact.metrics ?? []).find(
    (entry) =>
      (typeof rule.name === "string" && entry.name === rule.name) ||
      (typeof rule.path === "string" && entry.pathname === rule.path),
  );
  if (!metric || !metric.summary) {
    return null;
  }
  return metric.summary[rule.stat] ?? null;
}

export function resolveServerDiagnosticsMetric(serverArtifact, rule) {
  const metric = (serverArtifact.diagnostics?.metrics ?? []).find(
    (entry) => entry.name === rule.name,
  );
  if (!metric || !metric.summary) {
    return null;
  }
  return metric.summary[rule.stat] ?? null;
}

export function resolveServerColdMetric(serverArtifact, rule) {
  const metric = (serverArtifact.coldMetrics ?? []).find(
    (entry) => entry.pathname === rule.path,
  );
  if (!metric) {
    return null;
  }
  return metric[rule.stat] ?? null;
}

export function resolveE2EMetric(e2eArtifacts, rule) {
  const values = [];
  for (const artifact of e2eArtifacts) {
    const metric = (artifact.metrics ?? []).find(
      (entry) => entry.name === rule.name,
    );
    if (metric && typeof metric.durationMs === "number") {
      values.push(metric.durationMs);
    }
  }
  if (values.length === 0) {
    return null;
  }
  return rule.aggregate === "p95"
    ? percentile(values, 0.95)
    : percentile(values, 0.5);
}

export async function resolveBuildMetric(buildManifest, rule) {
  if (!buildManifest) {
    return null;
  }

  const entryKey =
    typeof rule.entry === "string"
      ? rule.entry
      : typeof rule.keyPrefix === "string"
        ? Object.keys(buildManifest).find((key) =>
            key.startsWith(rule.keyPrefix),
          )
        : typeof rule.keyIncludes === "string"
          ? Object.keys(buildManifest).find((key) =>
              key.includes(rule.keyIncludes),
            )
          : null;
  if (!entryKey) {
    return null;
  }

  const entry = buildManifest[entryKey];
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const asset =
    rule.asset === "css"
      ? Array.isArray(entry.css) && typeof entry.css[0] === "string"
        ? entry.css[0]
        : null
      : typeof entry.file === "string"
        ? entry.file
        : null;
  if (!asset) {
    return null;
  }

  const assetPath = path.join(repoRoot, "apps", "web", "dist", asset);
  const stat = await fs.stat(assetPath).catch(() => null);
  if (!stat) {
    return null;
  }

  if (rule.stat === "sizeBytes") {
    return stat.size;
  }

  return null;
}

export async function resolveMetricValue(
  rule,
  { serverArtifact, e2eArtifacts, buildManifest },
) {
  if (rule.source === "server") {
    return resolveServerMetric(serverArtifact, rule);
  }
  if (rule.source === "serverCold") {
    return resolveServerColdMetric(serverArtifact, rule);
  }
  if (rule.source === "serverDiagnostics") {
    return resolveServerDiagnosticsMetric(serverArtifact, rule);
  }
  if (rule.source === "e2e") {
    return resolveE2EMetric(e2eArtifacts, rule);
  }
  if (rule.source === "build") {
    return await resolveBuildMetric(buildManifest, rule);
  }
  return null;
}

export function metricBudget(rule) {
  if (typeof rule.budgetBytes === "number") {
    return rule.budgetBytes;
  }
  if (typeof rule.budgetMs === "number") {
    return rule.budgetMs;
  }
  return null;
}

export function metricUnit(rule) {
  return typeof rule.budgetBytes === "number" ? "bytes" : "ms";
}

export function formatMetricValue(value, unit) {
  if (unit === "bytes") {
    if (value >= 1_000_000) {
      return `${(value / 1_000_000).toFixed(2)} MB`;
    }
    if (value >= 1_000) {
      return `${(value / 1_000).toFixed(2)} kB`;
    }
    return `${Math.round(value)} B`;
  }

  return `${Number(value).toFixed(2)} ms`;
}
