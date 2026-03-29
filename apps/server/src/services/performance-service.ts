import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

import {
  LatencyMetricSchema,
  LatencySampleSchema,
  LatencySummarySchema,
  PerformanceSnapshotSchema,
  nowIso,
  type LatencyMetric,
  type LatencySample,
  type LatencySource,
  type PerformanceSnapshot
} from "@droidagent/shared";

const MAX_SAMPLES_PER_METRIC = 40;
const MAX_RECENT_SAMPLES = 120;

export interface MeasureHandle {
  finish(context?: Record<string, string | number | boolean | null | undefined>): LatencySample;
}

function normalizeContext(
  context: Record<string, string | number | boolean | null | undefined> | undefined
): Record<string, string> {
  if (!context) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(context)
      .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined && entry[1] !== null)
      .map(([key, value]) => [key, String(value)])
  );
}

function percentile(sortedValues: number[], ratio: number): number | null {
  if (sortedValues.length === 0) {
    return null;
  }

  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * ratio) - 1));
  return Number(sortedValues[index]!.toFixed(2));
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

function summarize(name: string, source: LatencySource, samples: LatencySample[]) {
  const values = samples.map((sample) => sample.durationMs).sort((left, right) => left - right);
  const lastSample = samples.at(-1) ?? null;
  const lastDurationMs = lastSample?.durationMs ?? null;
  const lastEndedAt = lastSample?.endedAt ?? null;
  const okCount = samples.filter((sample) => sample.context.outcome !== "error" && sample.context.outcome !== "warn").length;
  const warnCount = samples.filter((sample) => sample.context.outcome === "warn").length;
  const errorCount = samples.filter((sample) => sample.context.outcome === "error").length;
  const sampleAgeMs = lastEndedAt
    ? Math.max(0, Date.now() - new Date(lastEndedAt).getTime())
    : null;
  return LatencySummarySchema.parse({
    name,
    source,
    count: samples.length,
    okCount,
    warnCount,
    errorCount,
    lastDurationMs,
    lastEndedAt,
    sampleAgeMs: sampleAgeMs === null ? null : Number(sampleAgeMs.toFixed(2)),
    minDurationMs: values[0] ?? null,
    maxDurationMs: values.at(-1) ?? null,
    avgDurationMs: average(values),
    p50DurationMs: percentile(values, 0.5),
    p95DurationMs: percentile(values, 0.95)
  });
}

export class PerformanceService {
  private readonly metrics = new Map<string, LatencySample[]>();
  private readonly recentSamples: LatencySample[] = [];

  private metricKey(source: LatencySource, name: string): string {
    return `${source}:${name}`;
  }

  record(
    source: LatencySource,
    name: string,
    durationMs: number,
    context?: Record<string, string | number | boolean | null | undefined>,
    startedAt = nowIso(),
    endedAt = nowIso()
  ): LatencySample {
    const normalizedDuration = Number(Math.max(0, durationMs).toFixed(2));
    const sample = LatencySampleSchema.parse({
      id: randomUUID(),
      name,
      source,
      startedAt,
      endedAt,
      durationMs: normalizedDuration,
      context: normalizeContext(context)
    });

    const key = this.metricKey(source, name);
    const current = this.metrics.get(key) ?? [];
    current.push(sample);
    if (current.length > MAX_SAMPLES_PER_METRIC) {
      current.splice(0, current.length - MAX_SAMPLES_PER_METRIC);
    }
    this.metrics.set(key, current);

    this.recentSamples.push(sample);
    if (this.recentSamples.length > MAX_RECENT_SAMPLES) {
      this.recentSamples.splice(0, this.recentSamples.length - MAX_RECENT_SAMPLES);
    }

    return sample;
  }

  start(
    source: LatencySource,
    name: string,
    context?: Record<string, string | number | boolean | null | undefined>
  ): MeasureHandle {
    const startedAt = nowIso();
    const startedAtMs = performance.now();

    return {
      finish: (finishContext) =>
        this.record(source, name, performance.now() - startedAtMs, { ...context, ...finishContext }, startedAt, nowIso())
    };
  }

  snapshot(source?: LatencySource): PerformanceSnapshot {
    const metrics: LatencyMetric[] = [];

    for (const [key, samples] of this.metrics.entries()) {
      const [metricSource, name] = key.split(":", 2) as [LatencySource, string];
      if (source && metricSource !== source) {
        continue;
      }

      metrics.push(
        LatencyMetricSchema.parse({
          name,
          source: metricSource,
          summary: summarize(name, metricSource, samples),
          recentSamples: samples
        })
      );
    }

    metrics.sort((left, right) => left.name.localeCompare(right.name));

    return PerformanceSnapshotSchema.parse({
      generatedAt: nowIso(),
      metrics,
      recentSamples: source ? this.recentSamples.filter((sample) => sample.source === source) : this.recentSamples
    });
  }

  serverSnapshot(): PerformanceSnapshot {
    return this.snapshot("server");
  }

  reset(): void {
    this.metrics.clear();
    this.recentSamples.splice(0, this.recentSamples.length);
  }
}

export const performanceService = new PerformanceService();
