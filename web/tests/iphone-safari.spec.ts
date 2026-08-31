import { expect, test } from "./test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dng = process.env.SPEKTRAFILM_E2E_DNG ?? fileURLToPath(new URL("./fixtures/canon-a410-chdk.dng", import.meta.url));
const leicaDng = fileURLToPath(new URL("./fixtures/L1002126.DNG", import.meta.url));

async function thumbnail(page: import("@playwright/test").Page, source: string) {
  return page.evaluate(async (url) => {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 36;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return [...context.getImageData(0, 0, canvas.width, canvas.height).data];
  }, source);
}

async function displayedTone(page: import("@playwright/test").Page, tone: "blacks" | "shadows" | "highlights" | "whites") {
  return page.locator("#preview-image").evaluate(async (image: HTMLImageElement, selectedTone) => {
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const tones = [];
    for (let offset = 0; offset < data.length; offset += 4) {
      tones.push(0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2]);
    }
    tones.sort((left, right) => left - right);
    const quarter = Math.floor(tones.length / 4);
    const selected = selectedTone === "blacks" || selectedTone === "shadows"
      ? tones.slice(0, quarter)
      : tones.slice(-quarter);
    return selected.reduce((sum, value) => sum + value, 0) / selected.length;
  }, tone);
}

function encodedDimensions(bytes: Buffer, format: "jpeg" | "png" | "tiff") {
  if (format === "png") return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (format === "jpeg") {
    for (let offset = 2; offset < bytes.length;) {
      if (bytes[offset++] !== 0xff) continue;
      const marker = bytes[offset++];
      if (marker >= 0xc0 && marker <= 0xc3) return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
      offset += bytes.readUInt16BE(offset);
    }
    throw new Error("JPEG dimensions not found");
  }
  const littleEndian = bytes.toString("ascii", 0, 2) === "II";
  const u16 = (offset: number) => littleEndian ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
  const u32 = (offset: number) => littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  const directory = u32(4);
  let width = 0;
  let height = 0;
  for (let entry = 0; entry < u16(directory); entry++) {
    const offset = directory + 2 + entry * 12;
    const tag = u16(offset);
    if (tag === 256 || tag === 257) {
      const value = u16(offset + 2) === 3 ? u16(offset + 8) : u32(offset + 8);
      if (tag === 256) width = value;
      else height = value;
    }
  }
  if (!width || !height) throw new Error("TIFF dimensions not found");
  return { width, height };
}

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
  await page.locator("#language").selectOption("zh-Hant");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hant");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("讓底片重現生命。");
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

for (const control of ["blacks", "shadows", "highlights", "whites"] as const) {
  test(`positive ${control} brightens ${control} in iPhone Reference Quality`, async ({ page }) => {
    test.setTimeout(10 * 60_000);
    await page.goto("/");
    await expect(page.locator("#engine-state")).toContainText("Local engine", { timeout: 60_000 });
    await page.locator("#file-input").setInputFiles(dng);
    await expect(page.getByRole("button", { name: "Show before" })).toBeVisible({ timeout: 3 * 60_000 });
    await page.getByRole("button", { name: "Reference Quality", exact: true }).click();
    await page.locator(".controls > details > summary").click();
    const render = async (value: number) => {
      const previous = await page.locator("#preview-image").getAttribute("src");
      await page.locator(`#${control}`).fill(String(value));
      await expect.poll(() => page.locator("#preview-image").getAttribute("src"), { timeout: 3 * 60_000 }).not.toBe(previous);
      return displayedTone(page, control);
    };
    expect(await render(100)).toBeGreaterThan(await render(-100));
  });
}

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

test("applies Auto white balance to a large RAW without a second image decode", async ({ page }) => {
  test.setTimeout(10 * 60_000);
  await page.goto("/");
  await expect(page.locator("#engine-state")).toContainText("Local engine", { timeout: 60_000 });
  await page.locator("#file-input").setInputFiles(leicaDng);
  await page.getByRole("button", { name: /^Use safe/ }).click();
  await expect(page.getByRole("button", { name: "Show before" })).toBeVisible({ timeout: 3 * 60_000 });
  const previous = await page.locator("#preview-image").getAttribute("src");
  await page.locator(".controls > details > summary").click();
  await page.locator("#white-balance-mode").selectOption("auto");
  await expect.poll(() => page.locator("#preview-image").getAttribute("src"), { timeout: 3 * 60_000 }).not.toBe(previous);
  expect(await page.locator("#preview-image").evaluate((image: HTMLImageElement) => Math.max(image.naturalWidth, image.naturalHeight))).toBeLessThanOrEqual(1200);
  const whiteBalanced = await page.locator("#preview-image").getAttribute("src");
  await page.locator("#exposure").evaluate((slider: HTMLInputElement) => {
    for (const value of ["-1", "-.5", "0", ".5", "1"]) {
      slider.value = value;
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      slider.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await expect.poll(() => page.locator("#preview-image").getAttribute("src"), { timeout: 3 * 60_000 }).not.toBe(whiteBalanced);
  await expect(page.locator("#engine-state")).toContainText("Local engine");
  await expect(page.locator("#toast")).not.toContainText(/unreachable|memory/i);
});

test("bounds a large photo before repeated iPhone slider previews", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#engine-state")).toContainText("Local engine", { timeout: 60_000 });
  const jpeg = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 6000;
    canvas.height = 1000;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#b97a56";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/jpeg", .8));
    canvas.width = canvas.height = 1;
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  await page.locator("#photo-input").setInputFiles({ name: "large.jpg", mimeType: "image/jpeg", buffer: Buffer.from(jpeg) });
  await expect(page.getByRole("button", { name: "Show before" })).toBeVisible({ timeout: 3 * 60_000 });
  expect(await page.locator("#preview-image").evaluate((image: HTMLImageElement) => Math.max(image.naturalWidth, image.naturalHeight))).toBeLessThanOrEqual(1200);
  const previous = await page.locator("#preview-image").getAttribute("src");
  await page.locator("#contrast").evaluate((slider: HTMLInputElement) => {
    for (const value of ["-20", "-10", "0", "10", "20"]) {
      slider.value = value;
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      slider.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await expect.poll(() => page.locator("#preview-image").getAttribute("src"), { timeout: 3 * 60_000 }).not.toBe(previous);
  await expect(page.locator("#engine-state")).toContainText("Local engine");
  await expect(page.locator("#toast")).not.toContainText(/unreachable|memory/i);
  await page.getByRole("button", { name: "Reference Quality", exact: true }).click();
  await page.locator("#film-stock").selectOption("kodak_kodachrome_64");
  await page.locator("#print-stock").selectOption("none");
  const unprocessed = await page.locator("#preview-image").getAttribute("src");
  await expect.poll(() => page.locator("#preview-image").getAttribute("src"), { timeout: 3 * 60_000 }).not.toBe(unprocessed);
  const preview = await thumbnail(page, await page.locator("#preview-image").getAttribute("src") as string);
  await page.locator("#output-format").selectOption("jpeg");
  const pending = page.waitForEvent("download");
  await page.locator("#export").click();
  const exported = readFileSync(await (await pending).path() as string);
  const rendered = await thumbnail(page, `data:image/jpeg;base64,${exported.toString("base64")}`);
  expect(encodedDimensions(exported, "jpeg")).toEqual({ width: 1200, height: 200 });
  expect(preview.reduce((sum, value, index) => sum + Math.abs(value - rendered[index]), 0) / preview.length).toBeLessThan(2);
});

test("keeps every Leica renderer and output format inside the iPhone memory budget", async ({ page }) => {
  test.setTimeout(30 * 60_000);
  await page.goto("/");
  await expect(page.locator("#engine-state")).toContainText("Local engine", { timeout: 60_000 });
  await page.locator("#file-input").setInputFiles(leicaDng);
  await page.getByRole("button", { name: /^Use safe/ }).click();
  await expect(page.locator("#preview-meta")).toContainText("Fast 2.0 MP · Reference 1.0 MP");

  for (const mode of [{ button: "Fast GPU", maxPixels: 2_100_000 }, { button: "Reference Quality", maxPixels: 1_100_000 }]) {
    await page.getByRole("button", { name: mode.button, exact: true }).click();
    for (const format of ["jpeg", "png", "tiff"] as const) {
      await page.locator("#output-format").selectOption(format);
      const pending = page.waitForEvent("download");
      await page.locator("#export").click();
      const bytes = readFileSync(await (await pending).path() as string);
      const dimensions = encodedDimensions(bytes, format);
      expect(dimensions.width * dimensions.height, `${mode.button} ${format}`).toBeLessThanOrEqual(mode.maxPixels);
      await expect.poll(
        () => page.locator("#engine-state").textContent(),
        { message: `${mode.button} ${format} keeps the worker alive`, timeout: 60_000 },
      ).toContain("Local engine");
      await expect(page.locator("#toast")).not.toContainText(/unreachable|memory/i);
    }
  }
});
