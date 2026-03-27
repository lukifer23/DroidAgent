#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const port = process.env.DROIDAGENT_E2E_PORT ?? "4418";

function listPidsForPort(targetPort) {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${targetPort}`, "-sTCP:LISTEN", "-t"], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const pids = listPidsForPort(port).filter((pid) => pid !== process.pid);

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore already-dead processes
    }
  }

  if (pids.length > 0) {
    await wait(300);
  }

  for (const pid of pids) {
    if (!isAlive(pid)) {
      continue;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore already-dead processes
    }
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
