import { defineConfig, devices } from "@playwright/test";

const demoEnvironment = {
  ...process.env,
  DATABASE_PATH: "./test-results/playwright/signalcourt-e2e.sqlite",
  PORT: "8787",
  RYO_MCP_KEY: "",
  TAVILY_API_KEY: "",
  LLM_BASE_URL: "",
  LLM_API_KEY: "",
  LLM_MODEL: "",
  PUBLISHER_REGISTRY_JSON: "",
};

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results/playwright",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [["line"]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "npm exec tsx -- src/server/index.ts",
      url: "http://127.0.0.1:8787/api/health",
      env: demoEnvironment,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "npm run dev:client -- --host 127.0.0.1 --port 5173 --strictPort",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], browserName: "chromium" },
    },
  ],
});
