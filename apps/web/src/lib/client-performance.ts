import {
  LatencyMetricSchema,
  LatencySampleSchema,
  LatencySummarySchema,
  PerformanceSnapshotSchema,
  type LatencyMetric,
  type LatencySample,
  type PerformanceSnapshot
} from "@droidagent/shared";

const MAX_SAMPLES_PER_METRIC = 40;
const MAX_RECENT_SAMPLES = 120;

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

function summary(name: string, samples: LatencySample[]) {
  const values = samples.map((sample) => sample.durationMs).sort((left, right) => left - right);
  return LatencySummarySchema.parse({
    name,
    source: "client",
    count: samples.length,
    lastDurationMs: samples.at(-1)?.durationMs ?? null,
    minDurationMs: values[0] ?? null,
    maxDurationMs: values.at(-1) ?? null,
    avgDurationMs: average(values),
    p50DurationMs: percentile(values, 0.5),
    p95DurationMs: percentile(values, 0.95)
  });
}

type Listener = () => void;

class ClientPerformanceStore {
  private readonly metrics = new Map<string, LatencySample[]>();
  private readonly recentSamples: LatencySample[] = [];
  private readonly listeners = new Set<Listener>();
  private cachedSnapshot = PerformanceSnapshotSchema.parse({
    generatedAt: new Date().toISOString(),
    metrics: [],
    recentSamples: []
  });

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private rebuildSnapshot(): void {
    const metrics: LatencyMetric[] = [...this.metrics.entries()]
      .map(([name, samples]) =>
        LatencyMetricSchema.parse({
          name,
          source: "client",
          summary: summary(name, samples),
          recentSamples: samples
        })
      )
      .sort((left, right) => left.name.localeCompare(right.name));

    this.cachedSnapshot = PerformanceSnapshotSchema.parse({
      generatedAt: new Date().toISOString(),
      metrics,
      recentSamples: [...this.recentSamples]
    });
  }

  record(
    name: string,
    durationMs: number,
    context?: Record<string, string | number | boolean | null | undefined>,
    startedAtMs?: number,
    endedAtMs = performance.now()
  ): LatencySample {
    const startedAt = new Date(performance.timeOrigin + (startedAtMs ?? Math.max(0, endedAtMs - durationMs))).toISOString();
    const endedAt = new Date(performance.timeOrigin + endedAtMs).toISOString();
    const sample = LatencySampleSchema.parse({
      id: `${name}-${endedAtMs.toFixed(2)}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      source: "client",
      startedAt,
      endedAt,
      durationMs: Number(Math.max(0, durationMs).toFixed(2)),
      context: normalizeContext(context)
    });

    const current = this.metrics.get(name) ?? [];
    current.push(sample);
    if (current.length > MAX_SAMPLES_PER_METRIC) {
      current.splice(0, current.length - MAX_SAMPLES_PER_METRIC);
    }
    this.metrics.set(name, current);

    this.recentSamples.push(sample);
    if (this.recentSamples.length > MAX_RECENT_SAMPLES) {
      this.recentSamples.splice(0, this.recentSamples.length - MAX_RECENT_SAMPLES);
    }

    this.rebuildSnapshot();
    this.emit();
    return sample;
  }

  start(name: string, context?: Record<string, string | number | boolean | null | undefined>) {
    const startedAtMs = performance.now();
    let finished = false;
    return {
      finish: (finishContext?: Record<string, string | number | boolean | null | undefined>) => {
        if (finished) {
          return null;
        }
        finished = true;
        return this.record(name, performance.now() - startedAtMs, { ...context, ...finishContext }, startedAtMs);
      }
    };
  }

  snapshot(): PerformanceSnapshot {
    return this.cachedSnapshot;
  }
}

export const clientPerformance = new ClientPerformanceStore();
