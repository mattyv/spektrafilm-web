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
    command: "VITE_ADOBE_CLIENT_ID=test-client npm run build:wasm && VITE_ADOBE_CLIENT_ID=test-client npx vite --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 5 * 60_000,
  },
});
