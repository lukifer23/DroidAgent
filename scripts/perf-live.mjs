#!/usr/bin/env node
import { spawn } from "node:child_process";

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: {
        ...process.env,
        ...env,
      },
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? 1}`));
    });
  });
}

async function main() {
  const env = {
    DROIDAGENT_PERF_LIVE: "1",
  };
  await run("pnpm", ["perf:server"], env);
  await run("pnpm", ["perf:e2e"], env);
  await run("pnpm", ["perf:report"], env);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
