const serverUrl = "http://localhost:4318/api/health";

async function main() {
  try {
    const response = await fetch(serverUrl, {
      redirect: "manual",
    });
    if (response.ok) {
      console.log("DroidAgent is already running at http://localhost:4318");
      process.exit(0);
    }
  } catch {
    // fall through to the actionable error below
  }

  console.error(
    "No managed DroidAgent host is running. Use `pnpm bootstrap` to start or restore the local host.",
  );
  process.exit(1);
}

void main();
