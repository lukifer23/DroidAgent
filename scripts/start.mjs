import { readMaintenanceStatus } from "./lib/common.mjs";

const serverUrl = "http://localhost:4318/api/health";

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
