import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4418",
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
    url: "http://127.0.0.1:4418",
    reuseExistingServer: false,
    timeout: 120000
  }
});
