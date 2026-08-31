import { defineConfig } from "@playwright/test";

const remote = process.env.SPEKTRAFILM_E2E_BASE_URL;

export default defineConfig({
  testDir: "./tests",
  testIgnore: "iphone-safari.spec.ts",
  timeout: 10 * 60_000,
  workers: 1,
  use: {
    baseURL: remote ?? "http://127.0.0.1:4173",
    channel: "chrome",
    launchOptions: { args: ["--enable-unsafe-webgpu"] },
  },
  webServer: remote ? undefined : {
    command: "npm run build && npx vite preview --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 5 * 60_000,
  },
});
