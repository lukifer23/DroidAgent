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

  const [exitCode] = (await once(child, "close")) as [number];
  const okExitCodes = options.okExitCodes ?? [0];

  if (!okExitCodes.includes(exitCode)) {
    throw new CommandError(`${command} ${args.join(" ")} failed`, stdout, stderr, exitCode);
  }

  return { stdout, stderr, exitCode };
}

