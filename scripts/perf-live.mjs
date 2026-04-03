#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";

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
      reject(
        new Error(`${command} ${args.join(" ")} exited with ${code ?? 1}`),
      );
    });
  });
}

async function main() {
  const env = {
    DROIDAGENT_PERF_LIVE: "1",
    DROIDAGENT_E2E_REAL_RUNTIME: "1",
    DROIDAGENT_PERF_ARTIFACT_DIR:
      process.env.DROIDAGENT_PERF_ARTIFACT_DIR ??
      path.join("artifacts", "perf", "live", "current"),
  };
  await run("pnpm", ["perf:server"], env);
  await run("pnpm", ["perf:e2e"], env);
  await run("pnpm", ["perf:report"], env);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
