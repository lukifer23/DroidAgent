#!/usr/bin/env node
import { spawn } from "node:child_process";

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: {
        ...process.env,
        ...env
      }
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
  const perfPort = process.env.DROIDAGENT_E2E_PORT ?? String(4421);
  await run("pnpm", ["build"], {
    DROIDAGENT_E2E_PORT: perfPort
  });
  await run("pnpm", ["exec", "playwright", "test", "tests/perf/app.perf.spec.ts", "--config", "playwright.perf.config.ts"], {
    DROIDAGENT_E2E_PORT: perfPort
  });
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
