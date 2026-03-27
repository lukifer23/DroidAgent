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
