import { test as base, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    const enabled = process.env.E2E_COVERAGE === "1";
    if (enabled) await page.coverage.startJSCoverage();
    await use(page);
    if (enabled && !page.isClosed()) {
      const coverage = await page.coverage.stopJSCoverage();
      await mkdir("coverage/e2e-raw", { recursive: true });
      const name = `${testInfo.workerIndex}-${testInfo.testId.replace(/[^a-z0-9]+/gi, "-")}.json`;
      await writeFile(`coverage/e2e-raw/${name}`, JSON.stringify(coverage));
    }
  },
});

export { expect };
