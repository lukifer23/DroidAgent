import { spawn } from "node:child_process";
import { once } from "node:events";

import { baseEnv } from "../env.js";

export class CommandError extends Error {
  constructor(
    message: string,
    public readonly stdout: string,
    public readonly stderr: string,
    public readonly exitCode: number | null
  ) {
    super(message);
  }
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ProcessInfo {
  pid: number;
  command: string;
}

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    okExitCodes?: number[];
    timeoutMs?: number;
  } = {}
): Promise<CommandResult> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...baseEnv(), ...options.env },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  let timedOut = false;
  const timeout =
    options.timeoutMs && options.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, options.timeoutMs)
      : null;

  const [exitCode] = (await once(child, "close")) as [number];
  if (timeout) {
    clearTimeout(timeout);
  }
  const okExitCodes = options.okExitCodes ?? [0];

  if (timedOut) {
    throw new CommandError(`${command} ${args.join(" ")} timed out`, stdout, stderr, exitCode);
  }

  if (!okExitCodes.includes(exitCode)) {
    throw new CommandError(`${command} ${args.join(" ")} failed`, stdout, stderr, exitCode);
  }

  return { stdout, stderr, exitCode };
}

export async function listProcesses(): Promise<ProcessInfo[]> {
  const result = await runCommand(
    "ps",
    ["-ax", "-o", "pid=", "-o", "command="],
    {
      timeoutMs: 5_000,
    },
  );

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (!match) {
        return null;
      }
      const command = match[2];
      if (!command) {
        return null;
      }
      return {
        pid: Number(match[1]),
        command: command.trim(),
      } satisfies ProcessInfo;
    })
    .filter((entry): entry is ProcessInfo => Boolean(entry));
}

export async function findProcesses(
  predicate: (processInfo: ProcessInfo) => boolean,
): Promise<ProcessInfo[]> {
  const processes = await listProcesses();
  return processes.filter(predicate);
}

export async function terminateProcesses(
  pids: number[],
  options: {
    timeoutMs?: number;
    forceAfterTimeout?: boolean;
  } = {},
): Promise<void> {
  const uniquePids = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (uniquePids.length === 0) {
    return;
  }

  const timeoutMs = options.timeoutMs ?? 1_500;
  const forceAfterTimeout = options.forceAfterTimeout ?? true;

  for (const pid of uniquePids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already exited or is otherwise unavailable.
    }
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const remaining = (
      await findProcesses((processInfo) => uniquePids.includes(processInfo.pid))
    ).map((processInfo) => processInfo.pid);

    if (remaining.length === 0) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  if (!forceAfterTimeout) {
    return;
  }

  for (const pid of uniquePids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already exited or is otherwise unavailable.
    }
  }
}
