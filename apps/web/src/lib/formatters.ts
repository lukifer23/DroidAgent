import type {
  ChatMessage,
  LatencySummary,
  PerformanceSnapshot,
} from "@droidagent/shared";

export function formatTokenBudget(value: number | null | undefined): string {
  const normalized =
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : 65_536;

  return `${Math.max(1, Math.floor(normalized / 1_000))}k`;
}

export function formatDurationMs(
  value: number | null | undefined,
  emptyLabel = "unknown",
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return emptyLabel;
  }

  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}s`;
  }

  return `${Math.round(value)} ms`;
}

export function formatLatency(summary: LatencySummary | undefined): string {
  const value = summary?.lastDurationMs ?? summary?.p95DurationMs ?? null;
  if (!value || !Number.isFinite(value)) {
    return "Awaiting run";
  }

  return formatDurationMs(value);
}

export function formatBytes(value: number): string {
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  if (value >= 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${value} B`;
}

export function formatHostBytes(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "unknown";
  }
  if (value >= 1024 ** 3) {
    return `${(value / 1024 ** 3).toFixed(1)} GiB`;
  }
  return `${Math.round(value / 1024 ** 2)} MiB`;
}

export function formatTimeLabel(
  value: string | null | undefined,
): string | null {
  if (!value) {
    return null;
  }

  return new Date(value).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function roleLabel(role: ChatMessage["role"]): string {
  if (role === "tool") {
    return "Tool";
  }

  if (role === "system") {
    return "System";
  }

  return role === "assistant" ? "DroidAgent" : "You";
}

export function metricDescription(
  snapshot: PerformanceSnapshot | undefined,
  name: string,
  label: string,
): string {
  const metric = snapshot?.metrics.find((entry) => entry.name === name);
  if (!metric) {
    return `${label}: no samples yet`;
  }

  const p95 = metric.summary.p95DurationMs ?? metric.summary.lastDurationMs;
  const last = metric.summary.lastDurationMs;
  const ageMs = metric.summary.sampleAgeMs;
  const ageLabel =
    typeof ageMs === "number"
      ? ageMs >= 60_000
        ? `${Math.round(ageMs / 60_000)}m old`
        : ageMs >= 1_000
          ? `${Math.round(ageMs / 1_000)}s old`
          : `${Math.round(ageMs)}ms old`
      : "age unknown";
  const outcomeBits = [
    `${metric.summary.count} samples`,
    metric.summary.errorCount > 0 ? `${metric.summary.errorCount} errors` : null,
    metric.summary.warnCount > 0 ? `${metric.summary.warnCount} warns` : null,
  ]
    .filter(Boolean)
    .join(" • ");
  return `${label}: p95 ${p95 ?? 0} ms • last ${last ?? 0} ms • ${outcomeBits} • ${ageLabel}`;
}
