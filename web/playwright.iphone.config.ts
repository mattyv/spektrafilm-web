import { defineConfig, devices } from "@playwright/test";

const remote = process.env.SPEKTRAFILM_E2E_BASE_URL;

export default defineConfig({
  testDir: "./tests",
  testMatch: "iphone-safari.spec.ts",
  use: {
    ...devices["iPhone 15"],
    baseURL: remote ?? "http://127.0.0.1:4173",
  },
  webServer: remote ? undefined : {
    command: "npm run build && npx vite preview --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    // Same cold-build cost as the coverage config, plus typecheck and the vite build.
    timeout: 15 * 60_000,
  },
});
