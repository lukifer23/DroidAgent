import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const serverUrl = "http://localhost:4318/api/health";
const maintenanceStatePath = path.join(
  os.homedir(),
  ".droidagent",
  "state",
  "maintenance-status.json",
);

async function readMaintenanceStatus() {
  try {
    return JSON.parse(await fs.readFile(maintenanceStatePath, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  const maintenance = await readMaintenanceStatus();

  try {
    const response = await fetch(serverUrl, {
      redirect: "manual",
    });
    if (response.ok) {
      if (maintenance?.active) {
        console.log(
          `DroidAgent is already running at http://localhost:4318 (maintenance: ${maintenance.current?.phase ?? "active"}).`,
        );
      } else {
        console.log("DroidAgent is already running at http://localhost:4318");
      }
      process.exit(0);
    }
  } catch {
    // fall through to the actionable error below
  }

  if (maintenance?.active) {
    console.error(
      `DroidAgent maintenance is ${maintenance.current?.phase ?? "active"}. Wait for the host to steady before trying to start another instance.`,
    );
    process.exit(1);
  }

  console.error(
    "No managed DroidAgent host is running. Use `pnpm bootstrap` to start or restore the local host.",
  );
  process.exit(1);
}

void main();
