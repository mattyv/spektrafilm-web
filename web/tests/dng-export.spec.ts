import { expect, test } from "./test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dng = process.env.SPEKTRAFILM_E2E_DNG ?? fileURLToPath(new URL("./fixtures/canon-a410-chdk.dng", import.meta.url));
const leicaDng = process.env.SPEKTRAFILM_E2E_LEICA_DNG ?? fileURLToPath(new URL("./fixtures/L1002126.DNG", import.meta.url));
const stockDng = readFileSync(new URL("./fixtures/canon-a410-chdk.dng", import.meta.url));
const jpeg = readFileSync(new URL("../public/icon.jpg", import.meta.url));
const appVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

function withTiffOrientation(source: Buffer, orientation: number) {
  const bytes = Buffer.from(source);
  expect(bytes.subarray(0, 2).toString()).toBe("II");
  const ifd = bytes.readUInt32LE(4);
  const entries = bytes.readUInt16LE(ifd);
  for (let entry = 0; entry < entries; entry += 1) {
    const offset = ifd + 2 + entry * 12;
    if (bytes.readUInt16LE(offset) === 0x0112) {
      bytes.writeUInt16LE(orientation, offset + 8);
      return bytes;
    }
  }
  throw new Error("DNG fixture has no orientation tag");
}

async function displayedImage(page: import("@playwright/test").Page) {
  return page.locator("#preview-image").evaluate(async (image: HTMLImageElement) => {
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    let hash = 2166136261;
    for (const byte of context.getImageData(0, 0, canvas.width, canvas.height).data) hash = Math.imul(hash ^ byte, 16777619);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let light = 0;
    for (let offset = 0; offset < data.length; offset += 4) light += data[offset] + data[offset + 1] + data[offset + 2];
    return { src: image.src, width: image.naturalWidth, height: image.naturalHeight, hash: hash >>> 0, light: light / (data.length / 4 * 3) };
  });
}

async function displayedToneStats(page: import("@playwright/test").Page) {
  return page.locator("#preview-image").evaluate(async (image: HTMLImageElement) => {
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
    const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    return {
      blacks: average(tones.slice(0, quarter)),
      shadows: average(tones.slice(0, quarter)),
      highlights: average(tones.slice(-quarter)),
      whites: average(tones.slice(-quarter)),
    };
  });
}

async function decodedDownload(page: import("@playwright/test").Page, path: string) {
  const source = `data:image/jpeg;base64,${readFileSync(path).toString("base64")}`;
  return page.evaluate(async (url) => {
    const image = new Image();
    image.src = url;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  }, source);
}

test("develops a sharp desktop DNG preview with working live controls", async ({ page }) => {
  test.setTimeout(30 * 60_000);
  page.on("console", (message) => console.log(`browser: ${message.text()}`));

  await page.goto("/");
  await expect(page.locator("#engine-state")).toContainText("Local engine", { timeout: 60_000 });
  await page.locator("#file-input").setInputFiles(dng);
  await expect(page.locator("#preview-meta")).toContainText("MP", { timeout: 60_000 });
  const safeSize = page.getByRole("button", { name: /^Use safe/ });
  if (await safeSize.isVisible()) await safeSize.click();
  await expect(page.locator("#preview-meta")).toContainText(/Safe to process locally|Approved/);
  await expect.poll(() => page.locator("#preview-image").evaluate((image: HTMLImageElement) => image.naturalWidth), { timeout: 60_000 }).toBeGreaterThan(0);

  const before = await displayedImage(page);
  await page.getByRole("button", { name: "Fast GPU", exact: true }).click();
  const compare = page.locator("#compare");
  if (await compare.textContent() !== "Show before") await compare.click();
  await expect(page.getByRole("button", { name: "Show before" })).toBeVisible({ timeout: 3 * 60_000 });
  await expect.poll(() => page.locator("#preview-image").getAttribute("src")).not.toBe(before.src);
  const firstAfter = await displayedImage(page);
  expect(firstAfter.hash).not.toBe(before.hash);
  await page.getByRole("button", { name: "Reference Quality" }).click();
  expect((await displayedImage(page)).src).toBe(firstAfter.src);
  await page.getByRole("button", { name: "Fast GPU", exact: true }).click();
  expect((await displayedImage(page)).src).toBe(firstAfter.src);
  await page.getByRole("button", { name: "Show before" }).click();
  await expect(page.locator("#preview-image")).toHaveAttribute("src", before.src);
  expect((await displayedImage(page)).hash).toBe(before.hash);

  await page.locator("#exposure").fill("2");
  await expect(page.getByRole("button", { name: "Show before" })).toBeVisible({ timeout: 3 * 60_000 });
  await expect.poll(async () => {
    const exposed = await displayedImage(page);
    return exposed.src !== before.src && exposed.src !== firstAfter.src && Math.abs(exposed.light - firstAfter.light) > 8;
  }, { timeout: 3 * 60_000 }).toBe(true);

  const exposed = await displayedImage(page);
  await page.locator("#warmth").fill("100");
  await expect.poll(() => page.locator("#preview-image").getAttribute("src"), { timeout: 3 * 60_000 }).not.toBe(exposed.src);
  expect((await displayedImage(page)).hash).not.toBe(exposed.hash);
});

for (const mode of ["Fast GPU", "Reference Quality"] as const) {
for (const control of ["Blacks", "Shadows", "Highlights", "Whites"] as const) {
  test(`positive ${control} visibly brightens the ${mode} rendered ${control.toLowerCase()}`, async ({ page }) => {
    test.setTimeout(10 * 60_000);
    await page.goto("/");
    await expect(page.locator("#engine-state")).toContainText("Local engine", { timeout: 60_000 });
    await page.locator("#file-input").setInputFiles(dng);
    await expect(page.getByRole("button", { name: "Show before" })).toBeVisible({ timeout: 3 * 60_000 });
    await page.getByRole("button", { name: mode, exact: true }).click();
    await page.locator(".controls > details > summary").click();

    const render = async (value: number) => {
      const previous = await page.locator("#preview-image").getAttribute("src");
      await page.locator(`#${control.toLowerCase()}`).fill(String(value));
      await expect.poll(() => page.locator("#preview-image").getAttribute("src"), { timeout: 3 * 60_000 }).not.toBe(previous);
      return displayedToneStats(page);
    };

    const lowered = await render(-100);
    const raised = await render(100);
    expect(raised[control.toLowerCase() as keyof Awaited<ReturnType<typeof displayedToneStats>>])
      .toBeGreaterThan(lowered[control.toLowerCase() as keyof Awaited<ReturnType<typeof displayedToneStats>>]);
  });
}
}

test("renders the full-size Leica DNG on desktop without trapping Wasm", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#engine-state")).toContainText("Local engine", { timeout: 60_000 });
  await page.locator("#file-input").setInputFiles(leicaDng);
  await expect(page.locator("#preview-meta")).toContainText("MP", { timeout: 3 * 60_000 });
  await expect.poll(() => page.locator("#preview-image").evaluate((image: HTMLImageElement) => image.naturalWidth), { timeout: 3 * 60_000 }).toBeGreaterThan(1000);
  await expect(page.locator("#toast")).not.toContainText(/unreachable|memory/i);
});

test("exports the safely resized Leica DNG with extreme tones as Reference TIFF", async ({ page, browserName }) => {
  test.setTimeout(30 * 60_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  await expect(page.locator("#engine-state")).toContainText("Local engine", { timeout: 60_000 });
  await page.locator("#file-input").setInputFiles(leicaDng);
  await expect(page.locator("#preview-meta")).toContainText("36.6 MP", { timeout: 60_000 });
  const safeSize = page.getByRole("button", { name: /^Use safe/ });
  await expect(safeSize).toBeVisible();
  await safeSize.click();
  await expect(page.locator("#preview-meta")).toContainText("Approved");
  await expect(page.getByRole("button", { name: "Show before" })).toBeVisible({ timeout: 3 * 60_000 });
  const initialAfter = await page.locator("#preview-image").getAttribute("src");
  await page.getByRole("button", { name: "Reference Quality", exact: true }).click();
  const referenceMegapixels = browserName === "webkit" ? 1 : 4;
  await expect(page.locator("#preview-meta")).toContainText(`Reference ${referenceMegapixels.toFixed(1)} MP`);
  await page.locator(".controls > details > summary").click();
  await page.locator("#shadows").fill("100");
  await page.locator("#highlights").fill("100");
  await expect.poll(async () => {
    const message = await page.locator("#toast").textContent();
    if (/unreachable|memory|allocation/i.test(message ?? "")) return `error: ${message}`;
    return await page.locator("#preview-image").getAttribute("src") !== initialAfter ? "adjusted" : "waiting";
  }, { timeout: 2 * 60_000 }).toBe("adjusted");
  await page.locator("#output-format").selectOption("tiff");
  await expect(page.locator("#export")).toBeEnabled();

  const pending = page.waitForEvent("download", { timeout: 10 * 60_000 });
  await page.locator("#export").click();
  const toast = page.locator("#toast");
  await expect.poll(() => toast.textContent(), { timeout: 10 * 60_000 })
    .toMatch(/Reference Quality export complete|unreachable|memory|allocation/i);
  await expect(toast).not.toContainText(/unreachable|memory|allocation/i);
  await expect(toast).toContainText("Reference Quality export complete");
  const path = await (await pending).path();
  expect(path).not.toBeNull();
  const output = readFileSync(path!);
  expect(["II", "MM"]).toContain(output.subarray(0, 2).toString());
  expect(output.byteLength).toBeGreaterThan(referenceMegapixels * 5_700_000);
  expect(pageErrors).toEqual([]);
});

test("loads a photo-library image and the CC0 DNG on an iPhone budget", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
  });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.locator("#engine-state")).toContainText("Local engine", { timeout: 60_000 });
  await expect(page.locator("#photo-input")).toHaveAttribute("accept", "image/*");
  await expect(page.locator("#file-input")).toHaveAttribute("accept", /^\.dng,/);
  await page.locator("#photo-input").setInputFiles({ name: "library-photo.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect(page.locator(".queue-item")).toHaveCount(1);
  await page.locator("#file-input").setInputFiles(dng);
  await expect(page.locator(".queue-item")).toHaveCount(2);
  await page.locator(".queue-select").nth(1).click();
  await expect(page.locator("#preview-meta")).toContainText("MP", { timeout: 60_000 });
  await expect(page.locator("#export")).toBeEnabled();
  await expect(page.getByRole("button", { name: "Show before" })).toBeVisible({ timeout: 3 * 60_000 });
  const baseline = await displayedImage(page);
  expect(Math.max(baseline.width, baseline.height)).toBeGreaterThanOrEqual(1_200);
  await page.locator("#exposure").fill("2");
  await expect.poll(() => page.locator("#preview-image").getAttribute("src"), { timeout: 3 * 60_000 }).not.toBe(baseline.src);
  expect(Math.abs((await displayedImage(page)).light - baseline.light)).toBeGreaterThan(8);
  await page.locator(".controls > details > summary").click();
  for (const [control, value] of [["#grain", "0"], ["#halation", "0"]]) {
    const before = await displayedImage(page);
    await page.locator(control).fill(value);
    await expect.poll(() => page.locator("#preview-image").getAttribute("src"), { timeout: 3 * 60_000 }).not.toBe(before.src);
    expect((await displayedImage(page)).hash).not.toBe(before.hash);
  }
  await context.close();
});

test("exports the CC0 DNG as a decodable full-size JPEG", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#engine-state")).toContainText("Local engine", { timeout: 60_000 });
  await page.locator("#file-input").setInputFiles(dng);
  await expect(page.locator("#export")).toBeEnabled({ timeout: 60_000 });
  await page.getByRole("button", { name: "Fast GPU", exact: true }).click();
  await page.locator("#output-format").selectOption("jpeg");
  const pending = page.waitForEvent("download");
  await page.locator("#export").click();
  const download = await pending;
  const path = await download.path();
  expect(path).not.toBeNull();
  const image = await decodedDownload(page, path!);
  expect(image.width).toBeGreaterThan(1_000);
  expect(image.height).toBeGreaterThan(1_000);
});

test("exports Lightroom adjustments and an Instagram portrait canvas in both modes", async ({ page }) => {
  test.setTimeout(10 * 60_000);
  await page.goto("/");
  await expect(page.locator("#engine-state")).toContainText("Local engine", { timeout: 60_000 });
  await page.locator("#photo-input").setInputFiles({ name: "composition.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect(page.locator("#export")).toBeEnabled({ timeout: 60_000 });
  await page.locator(".controls > details > summary").click();
  await page.locator("#saturation").fill("40");
  await page.locator("#straighten").fill("3");
  await page.locator("#crop-aspect").selectOption("4:5");
  await page.locator("#border").fill("10");
  await page.locator("#output-format").selectOption("jpeg");
  for (const mode of ["Fast GPU", "Reference Quality"]) {
    await page.getByRole("button", { name: mode, exact: true }).click();
    const pending = page.waitForEvent("download");
    await page.locator("#export").click();
    const path = await (await pending).path();
    expect(path).not.toBeNull();
    const output = await decodedDownload(page, path!);
    expect(output.width / output.height).toBeCloseTo(0.8, 2);
    await expect(page.locator("#engine-state")).toContainText("Local engine", { timeout: 60_000 });
  }
});

test("auto-rotates portrait DNG pixels and exports them once", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#engine-state")).toContainText("Local engine", { timeout: 60_000 });
  await expect(page.locator("#product-version")).toHaveText(`v${appVersion}`);
  await page.locator("#file-input").setInputFiles({
    name: "portrait.dng",
    mimeType: "image/x-adobe-dng",
    buffer: withTiffOrientation(stockDng, 6),
  });
  await expect(page.locator("#export")).toBeEnabled({ timeout: 60_000 });
  await expect.poll(async () => {
    const preview = await displayedImage(page);
    return preview.height > preview.width;
  }).toBe(true);

  await page.getByRole("button", { name: "Fast GPU", exact: true }).click();
  await expect(page.getByRole("button", { name: "Show before" })).toBeVisible({ timeout: 3 * 60_000 });
  const rendered = await displayedImage(page);
  expect(rendered.height).toBeGreaterThan(rendered.width);

  await page.locator("#output-format").selectOption("jpeg");
  const pending = page.waitForEvent("download");
  await page.locator("#export").click();
  const path = await (await pending).path();
  expect(path).not.toBeNull();
  const output = await decodedDownload(page, path!);
  expect(output.height).toBeGreaterThan(output.width);
});

test("renders and exports B&W paper with Fast GPU", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#engine-state")).toContainText("Local engine", { timeout: 60_000 });
  await page.locator("#file-input").setInputFiles(dng);
  await expect(page.locator("#export")).toBeEnabled({ timeout: 60_000 });
  await page.getByRole("button", { name: "Fast GPU", exact: true }).click();
  await page.locator("#print-stock").selectOption("kodak_2302");
  await expect(page.getByRole("button", { name: "Show before" })).toBeVisible({ timeout: 3 * 60_000 });
  await page.locator("#output-format").selectOption("jpeg");
  const pending = page.waitForEvent("download");
  await page.locator("#export").click();
  const output = await (await import("node:fs/promises")).readFile(await (await pending).path() as string);
  expect(output.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
});

test("exports the CC0 DNG queue as a separate saved JPEG", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "wakeLock", {
    configurable: true,
    value: { request: () => Promise.reject(new Error("Wake lock unavailable")) },
  }));
  await page.goto("/");
  await expect(page.locator("#engine-state")).toContainText("Local engine", { timeout: 60_000 });
  await page.locator("#file-input").setInputFiles(dng);
  await expect(page.locator("#export-queue")).toBeEnabled({ timeout: 60_000 });
  await page.getByRole("button", { name: "Fast GPU", exact: true }).click();
  await page.locator("#output-format").selectOption("jpeg");
  await page.locator("#export-queue").click();
  await expect(page.locator(".queue-save", { hasText: "Save" })).toHaveCount(1, { timeout: 3 * 60_000 });
  const pending = page.waitForEvent("download");
  await page.locator(".queue-save", { hasText: "Save" }).click();
  const download = await pending;
  const path = await download.path();
  expect(path).not.toBeNull();
  const image = await decodedDownload(page, path!);
  expect(image.width).toBeGreaterThan(1_000);
  expect(image.height).toBeGreaterThan(1_000);
});
