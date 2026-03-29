import { beforeEach, describe, expect, it, vi } from "vitest";

const ONE_GIB = 1024 ** 3;

const mocks = vi.hoisted(() => {
  const os = {
    platform: vi.fn(() => "darwin"),
    homedir: vi.fn(() => "/tmp"),
    loadavg: vi.fn(() => [0.42, 0.31, 0.25]),
    availableParallelism: vi.fn(() => 8),
    cpus: vi.fn(() => Array.from({ length: 8 }, () => ({}))),
    totalmem: vi.fn(() => 16 * ONE_GIB),
    freemem: vi.fn(() => 8 * ONE_GIB),
  };
  const runCommand = vi.fn();
  const listJobs = vi.fn();
  const getSnapshot = vi.fn();
  const performanceFinish = vi.fn();
  const performanceStart = vi.fn(() => ({
    finish: performanceFinish,
  }));

  return {
    os,
    runCommand,
    listJobs,
    getSnapshot,
    performanceFinish,
    performanceStart,
  };
});

vi.mock("node:os", () => ({
  default: mocks.os,
}));

vi.mock("../lib/process.js", () => ({
  CommandError: class CommandError extends Error {
    constructor(
      message: string,
      public readonly stdout: string,
      public readonly stderr: string,
      public readonly exitCode: number | null,
    ) {
      super(message);
    }
  },
  runCommand: mocks.runCommand,
}));

vi.mock("./job-service.js", () => ({
  jobService: {
    listJobs: mocks.listJobs,
  },
}));

vi.mock("./terminal-service.js", () => ({
  terminalService: {
    getSnapshot: mocks.getSnapshot,
  },
}));

vi.mock("./performance-service.js", () => ({
  performanceService: {
    start: mocks.performanceStart,
  },
}));

import {
  HostPressureBlockedError,
  HostPressureService,
} from "./host-pressure-service.js";

describe("HostPressureService", () => {
  let service: HostPressureService;

  beforeEach(() => {
    service = new HostPressureService();
    mocks.os.platform.mockReturnValue("darwin");
    mocks.os.loadavg.mockReturnValue([0.42, 0.31, 0.25]);
    mocks.os.availableParallelism.mockReturnValue(8);
    mocks.os.totalmem.mockReturnValue(16 * ONE_GIB);
    mocks.os.freemem.mockReturnValue(8 * ONE_GIB);
    mocks.runCommand.mockReset();
    mocks.listJobs.mockReset();
    mocks.getSnapshot.mockReset();
    mocks.performanceFinish.mockReset();
    mocks.performanceStart.mockClear();
    mocks.listJobs.mockResolvedValue([]);
    mocks.getSnapshot.mockResolvedValue({ session: null });
  });

  it("marks the host critical and blocks new runs when RAM, swap, and load are saturated", async () => {
    mocks.os.loadavg.mockReturnValue([11, 8, 7]);
    mocks.runCommand
      .mockResolvedValueOnce({
        stdout: `${16 * ONE_GIB}\n`,
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               2000.
Pages active:                           250000.
Pages inactive:                          12000.
Pages speculative:                         500.
Pages wired down:                       140000.
Pages purgeable:                          3000.
Pages occupied by compressor:            40000.
`,
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout:
          "vm.swapusage: total = 4.00G  used = 2.50G  free = 1.50G  (encrypted)\n",
        stderr: "",
        exitCode: 0,
      });
    mocks.listJobs.mockResolvedValue([
      { status: "running" },
      { status: "queued" },
    ]);
    mocks.getSnapshot.mockResolvedValue({
      session: {
        id: "term-1",
        status: "running",
      },
    });

    const status = await service.getStatus(true);

    expect(status.level).toBe("critical");
    expect(status.blocksAgentRuns).toBe(true);
    expect(status.activeJobs).toBe(2);
    expect(status.activeTerminalSession).toBe(true);
    expect(status.swapUsedBytes).toBeGreaterThan(2 * ONE_GIB);
    expect(status.contributors.some((entry) => entry.severity === "critical")).toBe(
      true,
    );
    expect(status.recommendations.length).toBeGreaterThan(0);
  });

  it("falls back to coarse metrics and stays non-blocking when mac sampling fails", async () => {
    mocks.runCommand.mockRejectedValue(new Error("vm_stat failed"));
    mocks.os.totalmem.mockReturnValue(16 * ONE_GIB);
    mocks.os.freemem.mockReturnValue(9 * ONE_GIB);

    const status = await service.getStatus(true);

    expect(status.level).toBe("unknown");
    expect(status.health).toBe("warn");
    expect(status.blocksAgentRuns).toBe(false);
    expect(status.lastError).toContain("vm_stat failed");
    expect(status.memoryAvailableBytes).toBe(9 * ONE_GIB);
  });

  it("keeps new runs available when swap is high but RAM and CPU are otherwise healthy", async () => {
    mocks.os.loadavg.mockReturnValue([2.82, 2.1, 1.9]);
    mocks.runCommand
      .mockResolvedValueOnce({
        stdout: `${18 * ONE_GIB}\n`,
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                              120000.
Pages active:                           180000.
Pages inactive:                         180000.
Pages speculative:                       20000.
Pages wired down:                       110000.
Pages purgeable:                        150000.
Pages occupied by compressor:            28000.
`,
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout:
          "vm.swapusage: total = 8.00G  used = 2.70G  free = 5.30G  (encrypted)\n",
        stderr: "",
        exitCode: 0,
      });

    const status = await service.getStatus(true);

    expect(status.level).toBe("warn");
    expect(status.blocksAgentRuns).toBe(false);
    expect(
      status.contributors.find((entry) => entry.id === "swapUsage")?.severity,
    ).toBe("warn");
  });

  it("throws when critical host pressure blocks new agent work", async () => {
    vi.spyOn(service, "getStatus").mockResolvedValue({
      observedAt: new Date().toISOString(),
      health: "error",
      level: "critical",
      message: "Host pressure is critical.",
      blocksAgentRuns: true,
      cpuLogicalCores: 8,
      load1m: 10,
      load5m: 8,
      load15m: 7,
      loadRatio: 1.25,
      memoryTotalBytes: 16 * ONE_GIB,
      memoryUsedBytes: 15 * ONE_GIB,
      memoryAvailableBytes: ONE_GIB,
      memoryUsedRatio: 0.94,
      compressedBytes: 512 * 1024 ** 2,
      swapTotalBytes: 4 * ONE_GIB,
      swapUsedBytes: 2 * ONE_GIB,
      swapUsedRatio: 0.5,
      activeJobs: 1,
      activeTerminalSession: false,
      contributors: [
        {
          id: "reclaimableMemory",
          label: "Reclaimable memory",
          severity: "critical",
          value: "1.0 GiB",
          detail: "Free RAM is very low and new model work is likely to stall or swap.",
        },
        {
          id: "ramUsage",
          label: "RAM usage",
          severity: "critical",
          value: "94%",
          detail: "RAM is saturated.",
        },
        {
          id: "swapUsage",
          label: "Swap",
          severity: "critical",
          value: "2.0 GiB",
          detail: "Swap pressure is high and the Mac is paging heavily.",
        },
        {
          id: "cpuLoad",
          label: "CPU load",
          severity: "critical",
          value: "10.00 / 8 cores",
          detail: "The 1 minute load is above available core capacity.",
        },
        {
          id: "activeJobs",
          label: "Workspace jobs",
          severity: "info",
          value: "1",
          detail: "One workspace job is still active.",
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

    await expect(service.assertAllowsAgentRuns("chat")).rejects.toBeInstanceOf(
      HostPressureBlockedError,
    );
  });
});
