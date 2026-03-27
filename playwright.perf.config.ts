import { defineConfig, devices } from "@playwright/test";

const e2ePort = Number(process.env.DROIDAGENT_E2E_PORT ?? 4419);
const baseURL = `http://127.0.0.1:${e2ePort}`;

export default defineConfig({
  testDir: "./tests",
  timeout: 45000,
  workers: 1,
  use: {
    baseURL,
    trace: "on-first-retry"
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"]
      }
    },
    {
      name: "fold-mobile",
      use: {
        ...devices["Desktop Chrome"],
        viewport: {
          width: 882,
          height: 1104
        },
        isMobile: true,
        hasTouch: true
      }
    }
  ],
  webServer: {
    command: "node ./scripts/cleanup-e2e-server.mjs && node apps/server/dist/testing/e2e-server.js",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120000
  }
});
