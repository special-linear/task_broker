import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(".cache/ms-playwright");
export default defineConfig({
  testDir: "tests/browser",
  timeout: 45000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:8787",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
});
