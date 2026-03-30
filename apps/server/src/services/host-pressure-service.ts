import os from "node:os";

import {
  HostPressureStatusSchema,
  type HostPressureStatus,
  type HostPressureContributor,
} from "@droidagent/shared";

import { TEST_MODE } from "../env.js";
import { TtlCache } from "../lib/ttl-cache.js";
import { CommandError, runCommand } from "../lib/process.js";
import { jobService } from "./job-service.js";
import { performanceService } from "./performance-service.js";
import { terminalService } from "./terminal-service.js";

const HOST_PRESSURE_TTL_MS = 12_000;
const ONE_GIB = 1024 ** 3;
const ONE_MIB = 1024 ** 2;

interface MemorySample {
  totalBytes: number | null;
  availableBytes: number | null;
  usedBytes: number | null;
  usedRatio: number | null;
  compressedBytes: number | null;
  swapTotalBytes: number | null;
  swapUsedBytes: number | null;
  swapUsedRatio: number | null;
}

interface LoadSample {
  cpuLogicalCores: number | null;
  load1m: number | null;
  load5m: number | null;
  load15m: number | null;
  loadRatio: number | null;
}

function round(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  return Number(value.toFixed(2));
}

function clampBytes(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.round(value));
}

function formatBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "unknown";
  }
  if (value >= ONE_GIB) {
    return `${(value / ONE_GIB).toFixed(1)} GiB`;
  }
  return `${Math.round(value / ONE_MIB)} MiB`;
}

function formatRatio(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "unknown";
  }
  return `${(value * 100).toFixed(value >= 0.1 ? 0 : 1)}%`;
}

function formatLoad(load1m: number | null, cpuLogicalCores: number | null): string {
  if (
    load1m === null ||
    !Number.isFinite(load1m) ||
    cpuLogicalCores === null ||
    !Number.isFinite(cpuLogicalCores)
  ) {
    return "unknown";
  }
  return `${load1m.toFixed(2)} / ${cpuLogicalCores} cores`;
}

function parsePageCount(raw: string): number | null {
  const normalized = raw.replace(/[.]/g, "").replace(/,/g, "").trim();
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseVmStat(raw: string): {
  pageSize: number | null;
  availablePages: number | null;
  compressedPages: number | null;
} {
  const pageSizeMatch = raw.match(/page size of\s+(\d+)\s+bytes/i);
  const pageSize = pageSizeMatch
    ? Number.parseInt(pageSizeMatch[1] ?? "", 10)
    : null;

  const metrics = new Map<string, number>();
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^"?(.*?)"?:\s+([0-9.,]+)\.?$/);
    if (!match) {
      continue;
    }
    const key = String(match[1] ?? "").trim().toLowerCase();
    const value = parsePageCount(match[2] ?? "");
    if (!key || value === null) {
      continue;
    }
    metrics.set(key, value);
  }

  const freePages = metrics.get("pages free") ?? 0;
  const speculativePages = metrics.get("pages speculative") ?? 0;
  const inactivePages = metrics.get("pages inactive") ?? 0;
  const purgeablePages = metrics.get("pages purgeable") ?? 0;
  const compressedPages =
    metrics.get("pages occupied by compressor") ??
    metrics.get("pages stored in compressor") ??
    0;

  return {
    pageSize,
    availablePages: freePages + speculativePages + inactivePages + purgeablePages,
    compressedPages,
  };
}

function parseHumanBytes(raw: string): number | null {
  const match = raw.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMGTP])?B?$/i);
  if (!match) {
    return null;
  }
  const value = Number.parseFloat(match[1] ?? "");
  if (!Number.isFinite(value)) {
    return null;
  }
  const unit = (match[2] ?? "").toUpperCase();
  const scale =
    unit === "T"
      ? 1024 ** 4
      : unit === "G"
        ? 1024 ** 3
        : unit === "M"
          ? 1024 ** 2
          : unit === "K"
            ? 1024
            : 1;
  return Math.round(value * scale);
}

function parseSwapUsage(raw: string): {
  totalBytes: number | null;
  usedBytes: number | null;
} {
  const normalized = raw.replace(/^vm\.swapusage:\s*/i, "").trim();
  const totalMatch = normalized.match(/total\s*=\s*([0-9.]+\s*[KMGTP]?B?)/i);
  const usedMatch = normalized.match(/used\s*=\s*([0-9.]+\s*[KMGTP]?B?)/i);
  return {
    totalBytes: parseHumanBytes(totalMatch?.[1] ?? ""),
    usedBytes: parseHumanBytes(usedMatch?.[1] ?? ""),
  };
}

function normalizedLoadSample(): LoadSample {
  const loadAverages = os.loadavg();
  const load1m = loadAverages[0] ?? 0;
  const load5m = loadAverages[1] ?? 0;
  const load15m = loadAverages[2] ?? 0;
  const cpuLogicalCores =
    typeof os.availableParallelism === "function"
      ? os.availableParallelism()
      : os.cpus().length;
  const loadRatio =
    cpuLogicalCores > 0 && Number.isFinite(load1m)
      ? load1m / cpuLogicalCores
      : null;

  return {
    cpuLogicalCores: cpuLogicalCores > 0 ? cpuLogicalCores : null,
    load1m: Number.isFinite(load1m) ? round(load1m) : null,
    load5m: Number.isFinite(load5m) ? round(load5m) : null,
    load15m: Number.isFinite(load15m) ? round(load15m) : null,
    loadRatio: round(loadRatio),
  };
}

function fallbackMemorySample(): MemorySample {
  const totalBytes = os.totalmem();
  const availableBytes = os.freemem();
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  return {
    totalBytes: clampBytes(totalBytes),
    availableBytes: clampBytes(availableBytes),
    usedBytes: clampBytes(usedBytes),
    usedRatio: round(totalBytes > 0 ? usedBytes / totalBytes : null),
    compressedBytes: null,
    swapTotalBytes: null,
    swapUsedBytes: null,
    swapUsedRatio: null,
  };
}

function macMemorySample(params: {
  totalBytes: number;
  vmStatOutput: string;
  swapUsageOutput: string;
}): MemorySample {
  const vmStat = parseVmStat(params.vmStatOutput);
  const swap = parseSwapUsage(params.swapUsageOutput);
  const availableBytes =
    vmStat.pageSize && vmStat.availablePages !== null
      ? vmStat.pageSize * vmStat.availablePages
      : null;
  const usedBytes =
    availableBytes !== null
      ? Math.max(0, params.totalBytes - availableBytes)
      : null;
  const swapUsedRatio =
    swap.totalBytes && swap.totalBytes > 0 && swap.usedBytes !== null
      ? swap.usedBytes / swap.totalBytes
      : null;

  return {
    totalBytes: clampBytes(params.totalBytes),
    availableBytes: clampBytes(availableBytes),
    usedBytes: clampBytes(usedBytes),
    usedRatio:
      usedBytes !== null && params.totalBytes > 0
        ? round(usedBytes / params.totalBytes)
        : null,
    compressedBytes:
      vmStat.pageSize && vmStat.compressedPages !== null
        ? clampBytes(vmStat.pageSize * vmStat.compressedPages)
        : null,
    swapTotalBytes: clampBytes(swap.totalBytes),
    swapUsedBytes: clampBytes(swap.usedBytes),
    swapUsedRatio: round(swapUsedRatio),
  };
}

function evaluateHostPressure(params: {
  load: LoadSample;
  memory: MemorySample;
  activeJobs: number;
  activeTerminalSession: boolean;
}): Pick<
  HostPressureStatus,
  | "health"
  | "level"
  | "message"
  | "blocksAgentRuns"
  | "contributors"
  | "recommendations"
> {
  const warnings: string[] = [];
  const criticals: string[] = [];
  const contributors: HostPressureContributor[] = [];
  const memoryCritical =
    params.memory.availableBytes !== null && params.memory.availableBytes < ONE_GIB;
  const memoryWarn =
    params.memory.availableBytes !== null && params.memory.availableBytes < 2 * ONE_GIB;
  const ramCritical =
    params.memory.usedRatio !== null && params.memory.usedRatio >= 0.94;
  const ramWarn =
    params.memory.usedRatio !== null && params.memory.usedRatio >= 0.87;
  const loadCritical =
    params.load.loadRatio !== null && params.load.loadRatio >= 1.25;
  const loadWarn =
    params.load.loadRatio !== null && params.load.loadRatio >= 0.85;
  const swapHigh =
    params.memory.swapUsedBytes !== null &&
    params.memory.swapUsedBytes >= 2 * ONE_GIB;
  const swapWarn =
    params.memory.swapUsedBytes !== null &&
    params.memory.swapUsedBytes >= 768 * ONE_MIB;
  const swapCritical =
    params.memory.swapUsedBytes !== null &&
    (params.memory.swapUsedBytes >= 4 * ONE_GIB ||
      (swapHigh && (memoryWarn || ramWarn || loadWarn)));

  if (memoryCritical) {
    criticals.push("reclaimable memory is below 1 GiB");
  } else if (memoryWarn) {
    warnings.push("reclaimable memory is below 2 GiB");
  }

  if (ramCritical) {
    criticals.push("RAM usage is above 94%");
  } else if (ramWarn) {
    warnings.push("RAM usage is above 87%");
  }

  if (swapCritical) {
    criticals.push("swap usage remains high under active pressure");
  } else if (swapWarn) {
    warnings.push("swap is in active use");
  }

  if (loadCritical) {
    criticals.push("1 minute CPU load is above core capacity");
  } else if (loadWarn) {
    warnings.push("1 minute CPU load is elevated");
  }

  if (params.activeJobs >= 2) {
    warnings.push("multiple workspace jobs are active");
  }

  contributors.push({
    id: "reclaimableMemory",
    label: "Reclaimable memory",
    severity: memoryCritical ? "critical" : memoryWarn ? "warn" : "ok",
    value: formatBytes(params.memory.availableBytes),
    detail: memoryCritical
      ? "Free RAM is very low and new model work is likely to stall or swap."
      : memoryWarn
        ? "Available RAM is getting tight for another local model run."
        : "Available RAM looks healthy.",
  });

  contributors.push({
    id: "ramUsage",
    label: "RAM usage",
    severity: ramCritical ? "critical" : ramWarn ? "warn" : "ok",
    value: formatRatio(params.memory.usedRatio),
    detail: ramCritical
      ? "RAM is saturated."
      : ramWarn
        ? "RAM usage is elevated."
        : "RAM usage is within the normal range.",
  });

  contributors.push({
    id: "swapUsage",
    label: "Swap",
    severity: swapCritical ? "critical" : swapWarn ? "warn" : "ok",
    value: formatBytes(params.memory.swapUsedBytes),
    detail: swapCritical
      ? "Swap remains high while RAM or CPU pressure is still elevated."
      : swapHigh
        ? "Swap is still draining from earlier work, but the host is not otherwise saturated."
        : swapWarn
          ? "Swap is active, which usually means memory pressure was recently real."
          : "Swap usage is negligible.",
  });

  contributors.push({
    id: "cpuLoad",
    label: "CPU load",
    severity: loadCritical ? "critical" : loadWarn ? "warn" : "ok",
    value: formatLoad(params.load.load1m, params.load.cpuLogicalCores),
    detail: loadCritical
      ? "The 1 minute load is above available core capacity."
      : loadWarn
        ? "The host is CPU-heavy right now."
        : "CPU load is within the normal range.",
  });

  contributors.push({
    id: "activeJobs",
    label: "Workspace jobs",
    severity:
      params.activeJobs >= 2 ? "warn" : params.activeJobs > 0 ? "info" : "ok",
    value: `${params.activeJobs}`,
    detail:
      params.activeJobs >= 2
        ? "Multiple workspace jobs are active and adding background load."
        : params.activeJobs === 1
          ? "One workspace job is still active."
          : "No workspace jobs are running.",
  });

  contributors.push({
    id: "terminalSession",
    label: "Rescue terminal",
    severity: params.activeTerminalSession ? "info" : "ok",
    value: params.activeTerminalSession ? "open" : "idle",
    detail: params.activeTerminalSession
      ? "A rescue terminal session is open and can be used to stop stray processes."
      : "No rescue terminal session is open.",
  });

  let level: HostPressureStatus["level"] = "ok";
  let health: HostPressureStatus["health"] = "ok";
  let message = "Host pressure is normal.";
  const recommendations: string[] = [];

  if (criticals.length > 0) {
    level = "critical";
    health = "error";
    message = `Host pressure is critical. ${formatBytes(params.memory.availableBytes)} reclaimable, ${formatBytes(params.memory.swapUsedBytes)} swap used, load ${params.load.load1m ?? 0} on ${params.load.cpuLogicalCores ?? 0} cores. New chat runs and jobs are paused until the host settles.`;
    recommendations.push(
      "Pause new model runs and workspace jobs until RAM and CPU pressure drop.",
    );
  } else if (warnings.length > 0) {
    level = "warn";
    health = "warn";
    message = `Host pressure is elevated. ${formatBytes(params.memory.availableBytes)} reclaimable, RAM ${formatRatio(params.memory.usedRatio)} used, load ${params.load.load1m ?? 0} on ${params.load.cpuLogicalCores ?? 0} cores. Avoid stacking more heavy work right now.`;
    recommendations.push(
      "Avoid concurrent chat runs and long workspace jobs until the host settles.",
    );
  }

  if (params.activeJobs > 0) {
    recommendations.push(
      `Wait for ${params.activeJobs} active job${params.activeJobs === 1 ? "" : "s"} to finish or cancel them before starting more work.`,
    );
  }

  if (
    params.memory.swapUsedBytes !== null &&
    params.memory.swapUsedBytes >= 768 * ONE_MIB
  ) {
    recommendations.push(
      swapCritical
        ? "Restart the local runtime or close other apps if swap use keeps climbing."
        : "Swap may stay elevated for a while after heavy work. Cleanup helps, but sending can resume once RAM and CPU are healthy.",
    );
  }

  if (
    params.memory.availableBytes !== null &&
    params.memory.availableBytes < 2 * ONE_GIB
  ) {
    recommendations.push(
      "Free RAM before another run, or use Runtime Maintenance for a clean restart.",
    );
  }

  if (
    params.load.loadRatio !== null &&
    params.load.loadRatio >= 0.85
  ) {
    recommendations.push(
      "Let CPU-heavy work finish before launching another compile, model run, or indexing pass.",
    );
  }

  if (params.activeTerminalSession && level !== "ok") {
    recommendations.push(
      "Use the rescue terminal to stop stuck processes or confirm runtime health before retrying.",
    );
  }

  return {
    health,
    level,
    message,
    blocksAgentRuns: level === "critical",
    contributors,
    recommendations,
  };
}

async function sampleMacMemory(): Promise<MemorySample> {
  const [totalResult, vmStatResult, swapResult] = await Promise.all([
    runCommand("sysctl", ["-n", "hw.memsize"], { timeoutMs: 3_000 }),
    runCommand("vm_stat", [], { timeoutMs: 3_000 }),
    runCommand("sysctl", ["vm.swapusage"], { timeoutMs: 3_000 }),
  ]);

  const totalBytes = Number.parseInt(totalResult.stdout.trim(), 10);
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    throw new CommandError(
      "sysctl -n hw.memsize returned an invalid value",
      totalResult.stdout,
      totalResult.stderr,
      totalResult.exitCode,
    );
  }

  return macMemorySample({
    totalBytes,
    vmStatOutput: vmStatResult.stdout,
    swapUsageOutput: swapResult.stdout,
  });
}

export class HostPressureBlockedError extends Error {}

export class HostPressureService {
  private readonly statusCache = new TtlCache<HostPressureStatus>(
    HOST_PRESSURE_TTL_MS,
  );

  invalidate(): void {
    this.statusCache.invalidate();
  }

  async getStatus(force = false): Promise<HostPressureStatus> {
    return await this.statusCache.get(async () => await this.sampleStatus(), force);
  }

  async assertAllowsAgentRuns(kind: "chat" | "job"): Promise<void> {
    const status = await this.getStatus();
    if (!status.blocksAgentRuns) {
      return;
    }

    throw new HostPressureBlockedError(
      kind === "chat"
        ? "Host pressure is critical. New chat runs are paused until memory and CPU pressure drop. Use Rescue Terminal or Runtime Maintenance to recover."
        : "Host pressure is critical. New jobs are paused until memory and CPU pressure drop. Use Rescue Terminal or Runtime Maintenance to recover.",
    );
  }

  private async sampleStatus(): Promise<HostPressureStatus> {
    const metric = performanceService.start("server", "host.pressure.sample");
    try {
      if (TEST_MODE) {
        const status = HostPressureStatusSchema.parse({
          observedAt: new Date().toISOString(),
          health: "ok",
          level: "ok",
          message:
            "Host pressure sampling is pinned to a healthy baseline in deterministic test mode.",
          blocksAgentRuns: false,
          cpuLogicalCores: 8,
          load1m: 0.12,
          load5m: 0.09,
          load15m: 0.08,
          loadRatio: 0.02,
          memoryTotalBytes: 16 * ONE_GIB,
          memoryUsedBytes: 6 * ONE_GIB,
          memoryAvailableBytes: 10 * ONE_GIB,
          memoryUsedRatio: 0.38,
          compressedBytes: 128 * ONE_MIB,
          swapTotalBytes: 4 * ONE_GIB,
          swapUsedBytes: 0,
          swapUsedRatio: 0,
          activeJobs: 0,
          activeTerminalSession: false,
          contributors: [
            {
              id: "reclaimableMemory",
              label: "Reclaimable memory",
              severity: "ok",
              value: "10.0 GiB",
              detail: "Available RAM looks healthy.",
            },
            {
              id: "ramUsage",
              label: "RAM usage",
              severity: "ok",
              value: "38%",
              detail: "RAM usage is within the normal range.",
            },
            {
              id: "swapUsage",
              label: "Swap",
              severity: "ok",
              value: "0 MiB",
              detail: "Swap usage is negligible.",
            },
            {
              id: "cpuLoad",
              label: "CPU load",
              severity: "ok",
              value: "0.12 / 8 cores",
              detail: "CPU load is within the normal range.",
            },
            {
              id: "activeJobs",
              label: "Workspace jobs",
              severity: "ok",
              value: "0",
              detail: "No workspace jobs are running.",
            },
            {
              id: "terminalSession",
              label: "Rescue terminal",
              severity: "ok",
              value: "idle",
              detail: "No rescue terminal session is open.",
            },
          ],
          recommendations: [],
          lastError: null,
        });
        metric.finish({
          level: status.level,
          blocksAgentRuns: status.blocksAgentRuns,
          activeJobs: status.activeJobs,
          testMode: true,
        });
        return status;
      }

      const activeJobs = jobService.getActiveJobCount();
      const activeTerminalSession = terminalService.hasActiveSession();
      const load = normalizedLoadSample();

      let memory: MemorySample;
      let lastError: string | null = null;
      try {
        memory =
          os.platform() === "darwin"
            ? await sampleMacMemory()
            : fallbackMemorySample();
      } catch (error) {
        memory = fallbackMemorySample();
        lastError = error instanceof Error ? error.message : "Unknown host pressure sampling error.";
      }

      const evaluation = evaluateHostPressure({
        load,
        memory,
        activeJobs,
        activeTerminalSession,
      });

      const status = HostPressureStatusSchema.parse({
        observedAt: new Date().toISOString(),
        health: lastError && evaluation.level === "ok" ? "warn" : evaluation.health,
        level: lastError && evaluation.level === "ok" ? "unknown" : evaluation.level,
        message:
          lastError && evaluation.level === "ok"
            ? "Host pressure telemetry fell back to coarse Node metrics. Use Rescue Terminal for a manual check if the host feels slow."
            : evaluation.message,
        blocksAgentRuns:
          !lastError && evaluation.blocksAgentRuns,
        cpuLogicalCores: load.cpuLogicalCores,
        load1m: load.load1m,
        load5m: load.load5m,
        load15m: load.load15m,
        loadRatio: load.loadRatio,
        memoryTotalBytes: memory.totalBytes,
        memoryUsedBytes: memory.usedBytes,
        memoryAvailableBytes: memory.availableBytes,
        memoryUsedRatio: memory.usedRatio,
        compressedBytes: memory.compressedBytes,
        swapTotalBytes: memory.swapTotalBytes,
        swapUsedBytes: memory.swapUsedBytes,
        swapUsedRatio: memory.swapUsedRatio,
        activeJobs,
        activeTerminalSession,
        contributors: evaluation.contributors,
        recommendations:
          lastError && evaluation.recommendations.length === 0
            ? [
                "Use the rescue terminal for a manual `vm_stat` or `top` check if the host feels slow.",
              ]
            : evaluation.recommendations,
        lastError,
      });

      metric.finish({
        level: status.level,
        blocksAgentRuns: status.blocksAgentRuns,
        activeJobs: status.activeJobs,
      });
      return status;
    } catch (error) {
      metric.finish({
        level: "unknown",
        outcome: "error",
      });
      return HostPressureStatusSchema.parse({
        observedAt: new Date().toISOString(),
        health: "warn",
        level: "unknown",
        message:
          "Host pressure telemetry is unavailable right now. Use Rescue Terminal for a manual health check if the host feels slow.",
        blocksAgentRuns: false,
        cpuLogicalCores: null,
        load1m: null,
        load5m: null,
        load15m: null,
        loadRatio: null,
        memoryTotalBytes: null,
        memoryUsedBytes: null,
        memoryAvailableBytes: null,
        memoryUsedRatio: null,
        compressedBytes: null,
        swapTotalBytes: null,
        swapUsedBytes: null,
        swapUsedRatio: null,
        activeJobs: 0,
        activeTerminalSession: false,
        contributors: [
          {
            id: "reclaimableMemory",
            label: "Reclaimable memory",
            severity: "info",
            value: "unknown",
            detail: "Memory sampling is unavailable right now.",
          },
          {
            id: "ramUsage",
            label: "RAM usage",
            severity: "info",
            value: "unknown",
            detail: "Memory sampling is unavailable right now.",
          },
          {
            id: "swapUsage",
            label: "Swap",
            severity: "info",
            value: "unknown",
            detail: "Swap sampling is unavailable right now.",
          },
          {
            id: "cpuLoad",
            label: "CPU load",
            severity: "info",
            value: "unknown",
            detail: "CPU load sampling is unavailable right now.",
          },
          {
            id: "activeJobs",
            label: "Workspace jobs",
            severity: "ok",
            value: "0",
            detail: "No workspace jobs are running.",
          },
          {
            id: "terminalSession",
            label: "Rescue terminal",
            severity: "ok",
            value: "idle",
            detail: "No rescue terminal session is open.",
          },
        ],
        recommendations: [
          "Use the rescue terminal for a manual `vm_stat`, `sysctl vm.swapusage`, or `top` check.",
        ],
        lastError: error instanceof Error ? error.message : "Unknown host pressure error.",
      });
    }
  }
}

export const hostPressureService = new HostPressureService();
