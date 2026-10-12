import { defineConfig, devices } from "@playwright/test";

const gracefulShutdown = {
  signal: "SIGTERM" as const,
  timeout: 5_000,
};

function isolatedServerEnvironment() {
  return {
    ...process.env,
    RYO_MCP_URL: "",
    RYO_MCP_KEY: "",
    TAVILY_API_KEY: "",
    LLM_BASE_URL: "",
    LLM_API_KEY: "",
    LLM_MODEL: "",
    PUBLISHER_REGISTRY_JSON: "",
    DATABASE_PATH: "",
    RUN_RYO_SMOKE: "",
  };
}

function apiServerEnvironment(
  scenario: "supported" | "insufficient",
  port: number,
) {
  return {
    ...isolatedServerEnvironment(),
    E2E_DEMO_SCENARIO: scenario,
    E2E_PORT: String(port),
    E2E_DATABASE_PATH: `./test-results/e2e-data/${scenario}.sqlite`,
  };
}

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
      command: "npm exec tsx -- tests/e2e/test-server.ts",
      url: "http://127.0.0.1:8787/api/health",
      env: apiServerEnvironment("supported", 8787),
      gracefulShutdown,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "npm run dev:client -- --host 127.0.0.1 --port 5173 --strictPort",
      url: "http://127.0.0.1:5173",
      env: {
        ...isolatedServerEnvironment(),
        SIGNALCOURT_API_PROXY_TARGET: "http://127.0.0.1:8787",
      },
      gracefulShutdown,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "npm exec tsx -- tests/e2e/test-server.ts",
      url: "http://127.0.0.1:8788/api/health",
      env: apiServerEnvironment("insufficient", 8788),
      gracefulShutdown,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "npm run dev:client -- --host 127.0.0.1 --port 5174 --strictPort",
      url: "http://127.0.0.1:5174",
      env: {
        ...isolatedServerEnvironment(),
        SIGNALCOURT_API_PROXY_TARGET: "http://127.0.0.1:8788",
      },
      gracefulShutdown,
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
