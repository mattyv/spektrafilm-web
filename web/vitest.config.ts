import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/editor-state.ts", "src/engine-contract.ts", "src/engine-transaction.ts", "src/settings-contract.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text", "lcov"],
      thresholds: { lines: 100 },
    },
  },
});
