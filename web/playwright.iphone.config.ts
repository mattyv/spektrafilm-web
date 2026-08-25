import { defineConfig, devices } from "@playwright/test";

const remote = process.env.SPEKTRAFILM_E2E_BASE_URL;

export default defineConfig({
  testDir: "./tests",
  testMatch: "iphone-safari.spec.ts",
  use: {
    ...devices["iPhone 15"],
    browserName: "webkit",
    baseURL: remote ?? "http://127.0.0.1:4173",
  },
  webServer: remote ? undefined : {
    command: "npm run build && npx vite preview --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 5 * 60_000,
  },
});
