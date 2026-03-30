import { spawn } from "node:child_process";

import { RuntimeStatusSchema, nowIso } from "@droidagent/shared";

import {
  OPENCLAW_PROFILE,
  OPENCLAW_GATEWAY_PORT,
  OPENCLAW_GATEWAY_URL,
  paths,
  resolveOpenClawBin,
} from "../env.js";
import { findProcesses, runCommand, terminateProcesses } from "../lib/process.js";
import { appStateService } from "./app-state-service.js";
import {
  GATEWAY_READY_DELAY_MS,
  GATEWAY_READY_RETRIES,
} from "./openclaw-service-support.js";
import type { OpenClawService } from "./openclaw-service.js";

type OpenClawGatewayService = OpenClawService & {
  gatewayProcess: import("node:child_process").ChildProcess | null;
  gatewayHealthProbe(): Promise<{ version?: string }>;
  explainGatewayFailure(
    error: unknown,
    options?: {
      expectedPid?: number | null;
      includePortConflicts?: boolean;
    },
  ): Promise<{
    message: string;
    portOwner: { pid: number; command: string } | null;
  }>;
  ensureConfigured(): Promise<void>;
  ensureOperatorExecAllowlist(): Promise<void>;
  cleanupManagedOpenClawProcesses(params?: {
    excludePids?: number[];
    includeTrackedGateway?: boolean;
  }): Promise<void>;
  openclawBin: string;
  profileArgs(extra?: string[]): string[];
  ensureGatewayToken(): Promise<string>;
  openclawEnv(): Promise<NodeJS.ProcessEnv>;
  queueGatewayLogWrite(chunk: string | Buffer): void;
  closeGatewayLogStream(): void;
  execOpenClaw(
    args: string[],
    allowFailure?: boolean,
    timeoutMs?: number,
  ): Promise<string>;
};

export const openClawGatewayMethods = {
  async gatewayHealthProbe(this: OpenClawService): Promise<{ version?: string }> {
    const service = this as unknown as OpenClawGatewayService;
    const output = await service.execOpenClaw([
      "gateway",
      "health",
      "--json",
      "--timeout",
      "2000",
      "--url",
      OPENCLAW_GATEWAY_URL,
      "--token",
      await service.ensureGatewayToken(),
    ]);

    return JSON.parse(output) as { version?: string };
  },

  async inspectGatewayPortOwner(this: OpenClawService): Promise<{
    pid: number;
    command: string;
  } | null> {
    const result = await runCommand(
      "lsof",
      ["-nP", `-iTCP:${OPENCLAW_GATEWAY_PORT}`, "-sTCP:LISTEN", "-Fp"],
      { okExitCodes: [0, 1] },
    );
    const pid = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("p"))
      ?.slice(1);

    if (!pid) {
      return null;
    }

    try {
      const processInfo = await runCommand(
        "ps",
        ["-o", "command=", "-p", pid],
        { okExitCodes: [0, 1] },
      );
      const command = processInfo.stdout.trim() || "process";
      return {
        pid: Number(pid),
        command,
      };
    } catch {
      return {
        pid: Number(pid),
        command: "process",
      };
    }
  },

  isManagedOpenClawCommand(this: OpenClawService, command: string): boolean {
    const normalized = command.trim();
    if (!normalized || !/openclaw/i.test(normalized)) {
      return false;
    }

    const markers = [
      OPENCLAW_PROFILE,
      paths.openClawStateDir,
      paths.openClawConfigPath,
      paths.workspaceRoot,
      "ai.openclaw.droidagent",
      `--profile ${OPENCLAW_PROFILE}`,
    ].filter((value): value is string => Boolean(value));

    return markers.some((marker) => normalized.includes(marker));
  },

  async cleanupManagedOpenClawProcesses(
    this: OpenClawService,
    params: {
      excludePids?: number[];
      includeTrackedGateway?: boolean;
    } = {},
  ): Promise<void> {
    const service = this as unknown as OpenClawGatewayService & {
      isManagedOpenClawCommand(command: string): boolean;
    };
    const exclude = new Set(
      (params.excludePids ?? []).filter((pid) => Number.isInteger(pid) && pid > 0),
    );
    if (
      params.includeTrackedGateway !== true &&
      service.gatewayProcess?.pid &&
      service.gatewayProcess.exitCode === null
    ) {
      exclude.add(service.gatewayProcess.pid);
    }

    const processes = await findProcesses(
      (processInfo) =>
        processInfo.pid !== process.pid &&
        !exclude.has(processInfo.pid) &&
        service.isManagedOpenClawCommand(processInfo.command),
    );

    if (processes.length === 0) {
      return;
    }

    await terminateProcesses(
      processes.map((processInfo) => processInfo.pid),
      { timeoutMs: 2_000 },
    );
  },

  buildGatewayPortConflictMessage(
    this: OpenClawService,
    owner: { pid: number; command: string },
  ): string {
    const portDetails = `Port ${OPENCLAW_GATEWAY_PORT} is owned by ${owner.command} (pid ${owner.pid}).`;
    const guidance = /openclaw/i.test(owner.command)
      ? "A different OpenClaw service is already using the configured DroidAgent gateway port. Stop the conflicting service or change DROIDAGENT_OPENCLAW_PORT."
      : "Another local process is already using the configured DroidAgent gateway port. Stop the conflicting service or change DROIDAGENT_OPENCLAW_PORT.";

    return `${guidance} ${portDetails}`;
  },

  async explainGatewayFailure(
    this: OpenClawService,
    error: unknown,
    options: {
      expectedPid?: number | null;
      includePortConflicts?: boolean;
    } = {},
  ): Promise<{
    message: string;
    portOwner: { pid: number; command: string } | null;
  }> {
    const service = this as unknown as OpenClawGatewayService & {
      inspectGatewayPortOwner(): Promise<{ pid: number; command: string } | null>;
      buildGatewayPortConflictMessage(owner: {
        pid: number;
        command: string;
      }): string;
    };
    const fallbackMessage =
      error instanceof Error ? error.message : "Gateway is not yet reachable.";
    const shouldInspectPort =
      options.includePortConflicts &&
      /token mismatch|abnormal closure|connect failed|not yet reachable/i.test(
        fallbackMessage,
      );

    if (!shouldInspectPort) {
      return {
        message: fallbackMessage,
        portOwner: null,
      };
    }

    const owner = await service.inspectGatewayPortOwner();
    if (!owner) {
      return {
        message: fallbackMessage,
        portOwner: null,
      };
    }

    if (options.expectedPid && owner.pid === options.expectedPid) {
      return {
        message: fallbackMessage,
        portOwner: owner,
      };
    }

    return {
      message: service.buildGatewayPortConflictMessage(owner),
      portOwner: owner,
    };
  },

  async status(this: OpenClawService) {
    const service = this as unknown as OpenClawGatewayService;
    const openclawBin = resolveOpenClawBin();
    const installed = Boolean(openclawBin);

    if (!installed) {
      return RuntimeStatusSchema.parse({
        id: "openclaw",
        label: "OpenClaw Gateway",
        state: "missing",
        enabled: true,
        installMethod: "bundledNpm",
        detectedVersion: null,
        binaryPath: null,
        health: "error",
        healthMessage: "The local OpenClaw CLI binary could not be found.",
        endpoint: null,
        installed: false,
        lastStartedAt: null,
        metadata: {},
      });
    }

    try {
      const parsed = await service.gatewayHealthProbe();
      return RuntimeStatusSchema.parse({
        id: "openclaw",
        label: "OpenClaw Gateway",
        state: "running",
        enabled: true,
        installMethod: "bundledNpm",
        detectedVersion: typeof parsed.version === "string" ? parsed.version : null,
        binaryPath: openclawBin,
        health: "ok",
        healthMessage: "Gateway reachable on loopback.",
        endpoint: OPENCLAW_GATEWAY_URL,
        installed: true,
        lastStartedAt: await appStateService.getJsonSetting<string | null>(
          "openclawStartedAt",
          null,
        ),
        metadata: {},
      });
    } catch (error) {
      const failure = await service.explainGatewayFailure(error, {
        includePortConflicts: true,
      });

      return RuntimeStatusSchema.parse({
        id: "openclaw",
        label: "OpenClaw Gateway",
        state: service.gatewayProcess ? "starting" : "stopped",
        enabled: true,
        installMethod: "bundledNpm",
        detectedVersion: null,
        binaryPath: openclawBin,
        health: "warn",
        healthMessage: failure.message,
        endpoint: OPENCLAW_GATEWAY_URL,
        installed: true,
        lastStartedAt: await appStateService.getJsonSetting<string | null>(
          "openclawStartedAt",
          null,
        ),
        metadata: failure.portOwner
          ? {
              portOwnerPid: failure.portOwner.pid,
              portOwnerCommand: failure.portOwner.command,
            }
          : {},
      });
    }
  },

  async health(this: OpenClawService) {
    const service = this as unknown as OpenClawGatewayService;
    return await service.status();
  },

  async startGateway(this: OpenClawService): Promise<void> {
    const service = this as unknown as OpenClawGatewayService;
    await service.ensureConfigured();
    let failedPortOwnerPid: number | null = null;

    try {
      await service.gatewayHealthProbe();
      await service.ensureOperatorExecAllowlist();
      return;
    } catch (error) {
      const failure = await service.explainGatewayFailure(error, {
        includePortConflicts: true,
      });
      if (
        failure.portOwner &&
        (!service.gatewayProcess ||
          failure.portOwner.pid !== service.gatewayProcess.pid)
      ) {
        throw new Error(failure.message);
      }
      failedPortOwnerPid = failure.portOwner?.pid ?? null;
    }

    if (service.gatewayProcess && service.gatewayProcess.exitCode === null) {
      return;
    }

    await service.cleanupManagedOpenClawProcesses({
      excludePids: failedPortOwnerPid ? [failedPortOwnerPid] : [],
    });

    const child = spawn(
      service.openclawBin,
      service.profileArgs([
        "gateway",
        "run",
        "--allow-unconfigured",
        "--bind",
        "loopback",
        "--auth",
        "token",
        "--token",
        await service.ensureGatewayToken(),
        "--port",
        String(OPENCLAW_GATEWAY_PORT),
      ]),
      {
        env: await service.openclawEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    child.stdout.on("data", (chunk) => {
      service.queueGatewayLogWrite(chunk);
    });
    child.stderr.on("data", (chunk) => {
      service.queueGatewayLogWrite(chunk);
    });
    child.on("exit", () => {
      service.gatewayProcess = null;
      service.closeGatewayLogStream();
    });

    service.gatewayProcess = child;
    await appStateService.setJsonSetting("openclawStartedAt", nowIso());

    for (let i = 0; i < GATEWAY_READY_RETRIES; i += 1) {
      await new Promise((resolve) =>
        setTimeout(resolve, GATEWAY_READY_DELAY_MS * (i + 1)),
      );
      if (service.gatewayProcess?.exitCode !== null) {
        throw new Error("OpenClaw gateway process exited before becoming ready.");
      }
      try {
        await service.gatewayHealthProbe();
        await service.ensureOperatorExecAllowlist();
        return;
      } catch (error) {
        if (i === GATEWAY_READY_RETRIES - 1) {
          const failure = await service.explainGatewayFailure(error, {
            expectedPid: child.pid ?? null,
            includePortConflicts: true,
          });
          throw new Error(
            failure.message === (error instanceof Error ? error.message : "")
              ? "OpenClaw gateway did not become ready in time."
              : failure.message,
          );
        }
      }
    }
  },

  async stopGateway(this: OpenClawService): Promise<void> {
    const service = this as unknown as OpenClawGatewayService;
    if (service.gatewayProcess && service.gatewayProcess.exitCode === null) {
      service.gatewayProcess.kill("SIGTERM");
      service.gatewayProcess = null;
    }
    service.closeGatewayLogStream();
    await service.cleanupManagedOpenClawProcesses({
      includeTrackedGateway: true,
    });
  },

  async callGateway<T>(
    this: OpenClawService,
    method: string,
    params: Record<string, unknown> = {},
    expectFinal = false,
  ): Promise<T> {
    const service = this as unknown as OpenClawGatewayService;
    const args = [
      "gateway",
      "call",
      method,
      "--json",
      "--url",
      OPENCLAW_GATEWAY_URL,
      "--token",
      await service.ensureGatewayToken(),
      "--params",
      JSON.stringify(params),
    ];

    if (expectFinal) {
      args.splice(3, 0, "--expect-final");
    }

    const output = await service.execOpenClaw(args, false, 20_000);
    const parsed = JSON.parse(output) as Record<string, unknown>;
    if ("error" in parsed && parsed.error) {
      const errorDetails = parsed.error as { message?: unknown };
      throw new Error(
        typeof errorDetails?.message === "string"
          ? errorDetails.message
          : "OpenClaw gateway call failed.",
      );
    }
    return parsed as T;
  },
};

export type OpenClawGatewayMethods = typeof openClawGatewayMethods;
