import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 10 * 60_000,
  workers: 1,
  grepInvert: /offline/,
  testIgnore: "iphone-safari.spec.ts",
  globalSetup: "./tests/coverage-setup.ts",
  use: {
    baseURL: "http://127.0.0.1:4173",
    channel: "chrome",
    launchOptions: { args: ["--enable-unsafe-webgpu"] },
  },
  webServer: {
    command: "npm run build:wasm && npx vite --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    // Cold CI runs compile the crate twice from scratch (plain + threaded build-std),
    // which overran the old 2 min budget and failed the job before any test ran.
    timeout: 15 * 60_000,
  },
});
