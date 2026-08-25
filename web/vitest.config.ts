import { defineConfig } from "vitest/config";

export default defineConfig({
  // vite.config.ts injects this from package.json; engine-worker.ts reports it as the
  // engine version, so the unit run needs its own value.
  define: { __APP_VERSION__: JSON.stringify("test") },
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // main.ts is gated by scripts/report-browser-coverage.mjs instead, which measures it
      // through the real browser flows; everything else executable belongs here.
      include: ["src/editor-state.ts", "src/engine-contract.ts", "src/engine-transaction.ts", "src/engine-worker.ts", "src/runtime.ts", "src/settings-contract.ts", "src/white-balance.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text", "lcov"],
      thresholds: { lines: 100 },
    },
  },
});
