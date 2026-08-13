import { expect, test } from "./test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dng = process.env.SPEKTRAFILM_E2E_DNG ?? fileURLToPath(new URL("./fixtures/canon-a410-chdk.dng", import.meta.url));

test("fits the iPhone Safari viewport and exposes distinct photo and RAW filters", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => new MediaStream() },
  }));
  await page.goto("/");
  await expect(page.locator("#engine-state")).toContainText("Local engine", { timeout: 60_000 });
  await expect(page.locator("#product-version")).toBeVisible();
  await expect(page.locator("#product-version")).toHaveText(/^v\d+\.\d+\.\d+$/);
  await expect(page.getByText("Open photos", { exact: true })).toBeVisible();
  await expect(page.getByText("Open RAW files", { exact: true })).toBeVisible();
  await expect(page.locator("#photo-input")).toHaveAttribute("accept", "image/*");
  await page.getByRole("button", { name: "Take photo" }).click();
  await expect(page.locator("#camera-dialog")).toHaveAttribute("open", "");
  await expect(page.locator("#camera-input")).toHaveCount(0);
  await expect(page.locator("#file-input")).toHaveAttribute("accept", /^\.dng,/);
  await expect(page.locator("#add-input")).toHaveAttribute("multiple", "");
  await expect(page.locator("body")).toHaveCSS("min-width", "320px");
  expect((await page.locator("body").boundingBox())!.width).toBeLessThanOrEqual(393);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(393);
});

test("double-taps a slider to reset it on iPhone", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#engine-state")).toContainText("Local engine", { timeout: 60_000 });
  const exposure = page.locator("#exposure");
  await exposure.fill("2");
  await exposure.dispatchEvent("pointerup", { pointerType: "touch" });
  await exposure.dispatchEvent("pointerup", { pointerType: "touch" });
  await expect(exposure).toHaveValue("0");
  await expect(page.locator("#exposure-output")).toHaveText("0.0 EV");
});

test("renders a mobile DNG after switching print off and back on", async ({ page }) => {
  test.setTimeout(10 * 60_000);
  await page.goto("/");
  await expect(page.locator("#engine-state")).toContainText("Local engine", { timeout: 60_000 });
  await page.locator("#file-input").setInputFiles({ name: "mobile.dng", mimeType: "image/x-adobe-dng", buffer: readFileSync(dng) });
  await expect(page.locator("#preview-meta")).toContainText("MP", { timeout: 60_000 });
  const safeSize = page.getByRole("button", { name: /^Use safe/ });
  if (await safeSize.isVisible()) await safeSize.click();
  await expect(page.getByRole("button", { name: "Show before" })).toBeVisible({ timeout: 3 * 60_000 });
  await page.locator("#raw-white-balance").evaluate((select: HTMLSelectElement) => {
    select.value = "uncorrected";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator("#toast")).not.toContainText(/unreachable/i);
  await page.locator("#print-stock").selectOption("none");
  await expect(page.getByRole("button", { name: "Show before" })).toBeVisible({ timeout: 3 * 60_000 });
  await expect(page.locator("#toast")).not.toContainText(/unreachable/i);
  await page.locator("#print-stock").selectOption("kodak_portra_endura");
  await expect(page.getByRole("button", { name: "Show before" })).toBeVisible({ timeout: 3 * 60_000 });
  await expect(page.locator("#preview-image")).toBeVisible();
});
