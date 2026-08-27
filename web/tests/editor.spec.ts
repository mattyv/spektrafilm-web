import { expect, test } from "./test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const jpeg = readFileSync(new URL("../public/icon.jpg", import.meta.url));
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

async function ready(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.locator("#engine-state")).toContainText("Local engine", { timeout: 60_000 });
  await expect(page.locator("#product-version")).toHaveText(/^v\d+\.\d+\.\d+$/);
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
    return { src: image.src, width: image.naturalWidth, height: image.naturalHeight, hash: hash >>> 0 };
  });
}

async function portraitMetadataJpeg(page: import("@playwright/test").Page) {
  const jpeg = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 80;
    canvas.height = 40;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#c40";
    context.fillRect(0, 0, 40, 40);
    context.fillStyle = "#04c";
    context.fillRect(40, 0, 40, 40);
    return [...new Uint8Array(await (await fetch(canvas.toDataURL("image/jpeg"))).arrayBuffer())];
  }));
  const exif = Buffer.from([
    0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00,
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  return Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]);
}

async function decodedDownload(page: import("@playwright/test").Page, download: import("@playwright/test").Download) {
  const path = await download.path();
  expect(path).not.toBeNull();
  const url = `data:image/jpeg;base64,${readFileSync(path!).toString("base64")}`;
  return page.evaluate(async (source) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let channelSpread = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      channelSpread += Math.abs(pixels[offset] - pixels[offset + 1]) + Math.abs(pixels[offset + 1] - pixels[offset + 2]);
    }
    let hash = 2166136261;
    for (const byte of pixels) hash = Math.imul(hash ^ byte, 16777619);
    return { width: image.naturalWidth, height: image.naturalHeight, channelSpread: channelSpread / (pixels.length / 4), hash: hash >>> 0 };
  }, url);
}

test("exposes every engine section, undo, recipes, and attribution", async ({ page }) => {
  await ready(page);
  const expectedThreads = await page.evaluate(() => Math.max(1, Math.min(4, Math.floor(navigator.hardwareConcurrency) || 1)));
  await expect(page.locator("#engine-state")).toContainText(`${expectedThreads} Reference ${expectedThreads === 1 ? "thread" : "threads"}`);
  await expect(page.getByRole("button", { name: "Fast GPU", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Reference Quality", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#export")).toHaveText("Export with Fast GPU");
  await page.locator(".controls > details > summary").click();
  await expect(page.locator("#super-advanced input")).not.toHaveCount(0);
  await expect(page.locator("#exposure-label")).toHaveText("Exposure compensation");
  await expect(page.locator("#print-stock option").first()).toHaveText("None — scan film directly");
  await expect(page.locator("#print-stock")).toHaveValue("kodak_portra_endura");
  await expect(page.locator("#scan-target")).toHaveValue("print");
  await page.locator("#print-stock").selectOption("none");
  await expect(page.locator("#scan-target")).toHaveValue("film");
  await page.locator("#print-stock").selectOption("kodak_portra_endura");
  await expect(page.locator("#scan-target")).toHaveValue("print");
  await page.locator("#auto-exposure").uncheck();
  await expect(page.locator("#exposure-label")).toHaveText("Exposure");
  await page.locator("#auto-exposure").check();

  for (const [id, changed, reset] of [
    ["exposure", "1", "0"],
    ["warmth", "20", "0"],
    ["grain", "150", "100"],
    ["halation", "150", "100"],
    ["halation-size", "150", "100"],
    ["sharpness", "150", "70"],
    ["temperature", "50", "0"],
    ["print-exposure", "1", "0"],
    ["straighten", "5", "0"],
    ["crop-scale", "50", "100"],
    ["border", "10", "0"],
  ]) {
    await page.locator(`#${id}`).fill(changed);
    await page.locator(`#${id}`).dblclick();
    await expect(page.locator(`#${id}`)).toHaveValue(reset);
  }
  await page.locator("#output-format").selectOption("jpeg");
  await page.locator("#jpeg-quality").fill("50");
  await page.locator("#jpeg-quality").dblclick();
  await expect(page.locator("#jpeg-quality")).toHaveValue("95");

  await page.locator("#exposure").fill("1");
  await expect(page.locator("#undo")).toBeEnabled();
  await page.locator("#undo").click();
  await expect(page.locator("#exposure")).toHaveValue("0");

  await page.locator("#recipe-name").fill("Browser recipe");
  await page.locator("#save-recipe").click();
  await expect(page.locator("#saved-recipes option")).toContainText(["Saved recipes…", "Browser recipe"]);
  for (const href of [
    "https://github.com/andreavolpato/spektrafilm",
    "https://github.com/turbasvin/spektrafilm-rs",
    "https://github.com/mattyv/spektrafilm-web",
  ]) await expect(page.locator(`.credits a[href="${href}"]`)).toHaveCount(1);
});

test("switches the main screen to Traditional Chinese and remembers the choice", async ({ page }) => {
  await ready(page);
  await page.locator("#language").selectOption("zh-Hant");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hant");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("讓底片重現生命。");
  await expect(page.getByText("開啟照片", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "拍攝照片" })).toBeVisible();
  await expect(page.getByText("開啟 RAW 檔案", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "參考品質" })).toBeVisible();
  await expect(page.getByText("輸出格式", { exact: true })).toBeVisible();
  await page.locator(".controls > details > summary").click();
  await expect(page.locator("#film-stock")).toHaveValue("kodak_portra_400");
  await expect(page.locator("#film-stock option:checked")).toHaveText("Portra 400");
  for (const label of [
    "底片種類", "曝光補償", "相紙種類", "色溫", "相紙曝光", "相紙對比",
    "白平衡", "RAW 白平衡", "RAW 去馬賽克", "溫度", "色調", "對比",
    "高光", "陰影", "白色", "黑色", "飽和度", "自然飽和度", "清晰度", "去霧",
    "掃描目標", "輸出色彩", "顆粒", "光暈", "銳利度", "校正水平", "裁切預設",
    "白色邊框", "暈影量", "套用調整", "JPEG 品質",
  ]) await expect(page.locator("label").filter({ hasText: label }).first()).toBeVisible();
  for (const [id, text] of [
    ["undo", "復原"], ["rotate", "旋轉"], ["reset-view", "重設檢視"], ["compare", "前後比較"],
    ["camera-capture", "使用照片"], ["camera-cancel", "取消"], ["white-balance-picker", "選取中性點"],
    ["save-recipe", "儲存配方"], ["export-recipe", "匯出配方"], ["export", "使用快速 GPU 匯出"],
    ["cancel-export", "取消目前匯出"], ["export-queue", "匯出安全佇列"], ["cancel-batch", "完成目前項目後停止"],
    ["lightroom-signin", "連接 Lightroom"], ["lightroom-create-album", "建立"],
    ["lightroom-upload-queue", "將完成照片儲存到 Lightroom"], ["lightroom-signout", "中斷連接"],
  ]) await expect(page.locator(`#${id}`)).toHaveText(text);
  await page.locator("#photo-input").setInputFiles({ name: "中文按鈕.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect(page.locator(".queue-discard")).toHaveText("移除");
  await expect(page.locator("#compare")).toHaveText(/渲染效果|顯示原圖/, { timeout: 60_000 });
  await page.locator("#export-queue").click();
  await expect(page.locator(".queue-save").first()).toHaveText("儲存", { timeout: 60_000 });
  await page.reload();
  await expect(page.locator("#language")).toHaveValue("zh-Hant");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("讓底片重現生命。");
  await page.locator("#language").selectOption("en");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Bring your negatives to life.");
  await expect(page.locator("label").filter({ hasText: "Film stock" }).first()).toBeVisible();
});

test("exposes remaining engine settings as controls instead of JSON", async ({ page }) => {
  await ready(page);
  await expect(page.locator("#expert-settings")).toHaveCount(0);
  await page.locator(".controls > details > summary").click();
  await page.getByText("Super advanced", { exact: true }).click();
  const exact = page.locator('[data-setting="camera.lens_blur_um"][type="number"]');
  const slider = page.locator('[data-setting="camera.lens_blur_um"][type="range"]');
  await expect(exact).toBeVisible();
  await exact.fill("1");
  await expect(slider).toHaveValue("1");
  await exact.press("Enter");
  await slider.dblclick();
  await expect(exact).toHaveValue("0");
  const integerSettings = [
    "film_render.grain.n_sub_layers",
    "film_render.grain.seed",
    "film_render.halation.halation_n_bounces",
    "film_render.glare.seed",
    "print_render.glare.seed",
    "settings.lut_resolution",
    "settings.preview_max_size",
  ];
  for (const path of integerSettings) {
    await expect(page.locator(`[data-setting="${path}"][type="number"]`)).toHaveAttribute("step", "1");
  }
  const grainSeed = page.locator('[data-setting="film_render.grain.seed"][type="number"]');
  await grainSeed.fill("12.5");
  await grainSeed.dispatchEvent("change");
  await expect(grainSeed).toHaveValue("13");
  await expect(page.locator("#toast")).not.toContainText(/expected u\d+|invalid type/i);
  await page.locator('[data-setting="camera.diffusion_filter.active"]').check();
  await page.locator('[data-setting="camera.auto_exposure_method"]').selectOption("mean");
  const illuminant = page.locator('[data-setting="enlarger.illuminant"]');
  await illuminant.fill(await illuminant.inputValue());
  await illuminant.press("Enter");
  await expect(page.locator("#super-advanced input")).not.toHaveCount(0);
});

test("offers RAW development and optional gamut lightness controls", async ({ page }) => {
  await ready(page);
  await page.locator(".controls > details > summary").click();
  await expect(page.locator("#raw-white-balance option")).toHaveText(["Camera As Shot", "Uncorrected"]);
  await expect(page.locator("#raw-demosaic option")).toHaveText(["PPG quality", "Superpixel fast"]);
  await expect(page.locator("#gamut-lightness-active")).toBeChecked();
  await expect(page.locator("#gamut-lightness-threshold")).toHaveValue("0.7");
  await expect(page.locator("#gamut-lightness-limit")).toHaveValue("1");
  await expect(page.locator("#gamut-lightness-power")).toHaveValue("2.2");
  await page.locator("#gamut-lightness-active").uncheck();
  await expect(page.locator("#gamut-lightness-threshold")).toBeDisabled();
  await page.locator("#gamut-lightness-active").check();
  await page.locator("#gamut-lightness-threshold").fill("0.6");
  await page.locator("#file-input").setInputFiles(fileURLToPath(new URL("./fixtures/canon-a410-chdk.dng", import.meta.url)));
  await expect.poll(() => page.locator("#preview-image").evaluate((image: HTMLImageElement) => image.naturalWidth), { timeout: 60_000 }).toBeGreaterThan(0);
  const quality = await displayedImage(page);
  await page.locator("#raw-white-balance").selectOption("uncorrected");
  await expect.poll(() => page.locator("#preview-image").getAttribute("src"), { timeout: 60_000 }).not.toBe(quality.src);
  const uncorrected = await displayedImage(page);
  expect(uncorrected.hash).not.toBe(quality.hash);
  await page.locator("#raw-demosaic").selectOption("superpixel");
  await expect.poll(() => page.locator("#preview-image").getAttribute("src"), { timeout: 60_000 }).not.toBe(uncorrected.src);
  expect((await displayedImage(page)).hash).not.toBe(uncorrected.hash);
});

test("stops a sequential batch after the active file", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "wakeLock", {
    configurable: true,
    value: { request: () => Promise.reject(new Error("Wake lock unavailable")) },
  }));
  await ready(page);
  await page.locator("#file-input").setInputFiles(["one", "two", "three"].map((name) => ({
    name: `${name}.jpg`, mimeType: "image/jpeg", buffer: jpeg,
  })));
  await expect(page.locator("#export-queue")).toBeEnabled({ timeout: 60_000 });
  await page.getByRole("button", { name: "Fast GPU", exact: true }).click();
  await page.locator("#export-queue").click();
  await expect(page.locator("#batch-label")).toContainText("1 of 3");
  await expect(page.locator("#exposure")).toBeDisabled();
  await expect(page.locator("#rotate")).toBeDisabled();
  await expect(page.locator("#output-format")).toBeDisabled();
  await expect(page.locator("#jpeg-quality")).toBeDisabled();
  await expect(page.locator(".queue-select").nth(1)).toBeDisabled();
  await page.locator("#cancel-batch").click();
  await expect(page.locator("#batch-progress")).toBeHidden({ timeout: 3 * 60_000 });
  await expect(page.locator("#exposure")).toBeEnabled();
  await expect(page.locator(".queue-save", { hasText: "Save" })).toHaveCount(1);
});

test("converts a 30-photo queue sequentially", async ({ page }) => {
  test.setTimeout(5 * 60_000);
  await ready(page);
  await page.locator("#file-input").setInputFiles(Array.from({ length: 30 }, (_, index) => ({
    name: `bulk-${index + 1}.jpg`, mimeType: "image/jpeg", buffer: jpeg,
  })));
  await expect(page.locator(".queue-item")).toHaveCount(30);
  await expect(page.locator("#export-queue")).toBeEnabled({ timeout: 60_000 });
  await page.locator("#output-format").selectOption("jpeg");
  await page.getByRole("button", { name: "Fast GPU", exact: true }).click();
  await page.locator("#export-queue").click();
  await expect(page.locator(".queue-save", { hasText: "Save" })).toHaveCount(30, { timeout: 5 * 60_000 });
  await expect(page.locator("#toast")).toContainText("30 files ready to save");
});

test("adds more files while an existing photo remains open", async ({ page }) => {
  await ready(page);
  await page.locator("#photo-input").setInputFiles({ name: "first.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect(page.locator(".queue-item")).toHaveCount(1);
  await page.locator("#add-input").setInputFiles(["second", "third"].map((name) => ({
    name: `${name}.jpg`, mimeType: "image/jpeg", buffer: jpeg,
  })));
  await expect(page.locator(".queue-item")).toHaveCount(3);
  await expect(page.locator(".queue-item.selected")).toContainText("first.jpg");
});

test("can reopen the same file after discarding it", async ({ page }) => {
  await ready(page);
  const file = { name: "again.jpg", mimeType: "image/jpeg", buffer: jpeg };
  await page.locator("#photo-input").setInputFiles(file);
  await expect(page.locator(".queue-item")).toHaveCount(1);
  await page.locator(".queue-discard").click();
  await expect(page.locator(".queue-item")).toHaveCount(0);
  await page.locator("#photo-input").setInputFiles(file);
  await expect(page.locator(".queue-item")).toHaveCount(1);
});

test("keeps the right photo selected while removing from a multi-image queue", async ({ page }) => {
  await ready(page);
  await page.locator("#photo-input").setInputFiles(["first", "second", "third"].map((name) => ({
    name: `${name}.jpg`, mimeType: "image/jpeg", buffer: jpeg,
  })));
  await expect(page.locator(".queue-item")).toHaveCount(3);
  await page.locator(".queue-select").nth(2).click();
  await page.getByRole("button", { name: "Remove third.jpg" }).click();
  await expect(page.locator(".queue-item.selected")).toContainText("second.jpg");
  await expect(page.locator("#preview-image")).toHaveAttribute("alt", "Preview of second.jpg");
  await page.getByRole("button", { name: "Remove first.jpg" }).click();
  await expect(page.locator(".queue-item.selected")).toContainText("second.jpg");
  await page.locator("#photo-input").setInputFiles(["fourth", "fifth"].map((name) => ({
    name: `${name}.jpg`, mimeType: "image/jpeg", buffer: jpeg,
  })));
  await expect(page.locator(".queue-item")).toHaveCount(3);
  await page.getByRole("button", { name: "Remove second.jpg" }).click();
  await expect(page.locator(".queue-item.selected")).toContainText("fourth.jpg");
});

test("keeps per-photo edits isolated while shared edits reach the other files", async ({ page }) => {
  await ready(page);
  await page.locator("#add-input").setInputFiles(["first", "second", "third"].map((name) => ({
    name: `${name}.jpg`, mimeType: "image/jpeg", buffer: jpeg,
  })));
  await expect(page.locator(".queue-item")).toHaveCount(3);
  await page.locator(".controls > details > summary").click();
  await page.locator(".queue-select").nth(1).click();
  await page.locator("#adjustment-scope").selectOption("photo");
  await page.locator("#exposure").fill("1");
  await page.locator(".queue-select").nth(0).click();
  await expect(page.locator("#exposure")).toHaveValue("0");
  await page.locator("#warmth").fill("20");
  await page.locator(".queue-select").nth(2).click();
  await expect(page.locator("#warmth")).toHaveValue("20");
  await page.locator(".queue-select").nth(1).click();
  await expect(page.locator("#exposure")).toHaveValue("1");
  await expect(page.locator("#warmth")).toHaveValue("0");
});

test("renders a decodable live preview after an adjustment", async ({ page }) => {
  await ready(page);
  await expect(page.locator("#temperature,#tint,#contrast,#highlights,#shadows,#whites,#blacks,#saturation,#vibrance,#clarity,#dehaze,#print-exposure,#print-contrast,#halation-size,#scatter,#scatter-size,#halation-highlight-boost,#straighten,#crop-aspect,#crop-scale,#crop-x,#crop-y,#border,#vignette-amount,#vignette-midpoint,#vignette-roundness,#vignette-feather,#vignette-highlights")).toHaveCount(28);
  await page.locator("#file-input").setInputFiles({ name: "preview.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect(page.locator("#export")).toBeEnabled({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Show before" })).toBeVisible({ timeout: 3 * 60_000 });
  await page.locator(".controls > details > summary").click();

  const expectPreviewUpdate = async (name: string, change: () => Promise<unknown>) => {
    const before = await displayedImage(page);
    await change();
    await expect.poll(() => page.locator("#preview-image").getAttribute("src"), { timeout: 3 * 60_000 }).not.toBe(before.src);
    const after = await displayedImage(page);
    expect(after.width).toBeGreaterThan(0);
    expect(after.hash, name).not.toBe(before.hash);
  };

  const beforeRelease = await displayedImage(page);
  await page.locator("#exposure").evaluate((range: HTMLInputElement) => {
    range.value = "1";
    range.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(500);
  expect((await displayedImage(page)).src).toBe(beforeRelease.src);
  await page.locator("#exposure").dispatchEvent("change");
  await expect.poll(() => page.locator("#preview-image").getAttribute("src"), { timeout: 3 * 60_000 }).not.toBe(beforeRelease.src);

  for (const [name, change] of [
    ["film", () => page.locator("#film-stock").selectOption("kodak_gold_200")],
    ["print stock", () => page.locator("#print-stock").selectOption("kodak_supra_endura")],
    ["warmth", () => page.locator("#warmth").fill("100")],
    ["auto exposure", () => page.locator("#auto-exposure").uncheck()],
    ["output colour", () => page.locator("#output-colour").selectOption("ProPhoto RGB")],
    ...["grain", "halation", "scatter"].map((id) => [id, () => page.locator(`#${id}`).fill("50")]),
    ...["halation-size", "scatter-size"].map((id) => [id, () => page.locator(`#${id}`).fill("150")]),
    ["halation boost", () => page.locator("#halation-highlight-boost").fill("1")],
    ["sharpness", () => page.locator("#sharpness").fill("100")],
    ...["temperature", "tint", "contrast", "highlights", "shadows", "whites", "blacks", "saturation", "vibrance", "clarity", "dehaze"].map((id) => [id, () => page.locator(`#${id}`).fill("75")]),
    ["print exposure", () => page.locator("#print-exposure").fill("1")],
    ["print contrast", () => page.locator("#print-contrast").fill("50")],
    ["scan target", () => page.locator("#scan-target").selectOption("film")],
    ["straighten", () => page.locator("#straighten").fill("5")],
    ["crop aspect", () => page.locator("#crop-aspect").selectOption("4:5")],
    ["crop scale", () => page.locator("#crop-scale").fill("75")],
    ["crop x", () => page.locator("#crop-x").fill("50")],
    ["crop y", () => page.locator("#crop-y").fill("-50")],
    ["border", () => page.locator("#border").fill("10")],
    ["vignette amount", () => page.locator("#vignette-amount").fill("-100")],
    ["vignette midpoint", () => page.locator("#vignette-midpoint").fill("20")],
    ["vignette roundness", () => page.locator("#vignette-roundness").fill("100")],
    ["vignette feather", () => page.locator("#vignette-feather").fill("100")],
    ["vignette highlights", () => page.locator("#vignette-highlights").fill("100")],
  ] as [string, () => Promise<unknown>][]) await expectPreviewUpdate(name, change);
});

test("re-renders None and restores the selected print stock", async ({ page }) => {
  await ready(page);
  await page.locator("#file-input").setInputFiles({ name: "preview.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect(page.getByRole("button", { name: "Show before" })).toBeVisible({ timeout: 3 * 60_000 });
  const printed = await displayedImage(page);
  await page.locator("#print-stock").selectOption("none");
  await expect.poll(() => displayedImage(page).then((image) => image.hash), { timeout: 3 * 60_000 }).not.toBe(printed.hash);
  await page.locator("#print-stock").selectOption("kodak_portra_endura");
  await expect.poll(() => displayedImage(page).then((image) => image.hash), { timeout: 3 * 60_000 }).toBe(printed.hash);
});

test("opening advanced controls does not move the preview", async ({ page }) => {
  await ready(page);
  await page.locator("#file-input").setInputFiles({ name: "preview.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect(page.locator("#preview-image")).toBeVisible({ timeout: 60_000 });
  const before = await page.locator("#preview-image").boundingBox();
  await page.locator(".controls > details > summary").click();
  const after = await page.locator("#preview-image").boundingBox();
  expect(after).toEqual(before);
});

test("rotates the selected photo without reallocating its pixels", async ({ page }) => {
  await ready(page);
  await page.locator("#file-input").setInputFiles({ name: "preview.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect(page.locator("#rotate")).toBeEnabled({ timeout: 60_000 });
  await page.locator("#rotate").click();
  await expect(page.locator("#preview-image")).toHaveCSS("rotate", "90deg");
  await expect(page.locator(".queue-item img")).toHaveCSS("rotate", "90deg");
});

test("keeps camera metadata orientation in the rendered preview", async ({ page }) => {
  await ready(page);
  await page.locator("#photo-input").setInputFiles({
    name: "portrait.jpg", mimeType: "image/jpeg", buffer: await portraitMetadataJpeg(page),
  });
  await expect(page.getByRole("button", { name: "Show before" })).toBeVisible({ timeout: 3 * 60_000 });
  const rendered = await displayedImage(page);
  expect(rendered.height).toBeGreaterThan(rendered.width);
});

test("samples a neutral point to set white balance and rerender", async ({ page }) => {
  await ready(page);
  const sample = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 80;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "rgb(120 100 140)";
    context.fillRect(0, 0, 80, 80);
    return [...new Uint8Array(await (await fetch(canvas.toDataURL("image/jpeg"))).arrayBuffer())];
  }));
  await page.locator("#photo-input").setInputFiles({ name: "white-balance.jpg", mimeType: "image/jpeg", buffer: sample });
  await expect(page.getByRole("button", { name: "Show before" })).toBeVisible({ timeout: 3 * 60_000 });
  const before = await displayedImage(page);
  await page.locator(".controls > details > summary").click();
  await expect(page.locator("#white-balance-mode option")).toHaveText(["As Shot", "Auto", "Pick neutral point", "Manual"]);
  await page.locator("#white-balance-mode").selectOption("auto");
  await expect(page.locator("#temperature")).not.toHaveValue("0");
  await page.locator("#white-balance-mode").selectOption("as-shot");
  await expect(page.locator("#temperature")).toHaveValue("0");
  await expect(page.locator("#tint")).toHaveValue("0");
  await page.getByRole("button", { name: "Pick neutral point" }).click();
  await page.locator("#preview-image").click({ position: { x: 10, y: 10 } });
  await expect(page.locator("#temperature")).not.toHaveValue("0");
  await expect.poll(async () => (await displayedImage(page)).src).not.toBe(before.src);
  await expect(page.getByRole("button", { name: "Pick neutral point" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#white-balance-mode")).toHaveValue("picker");
  await page.locator("#temperature").fill("10");
  await page.locator("#temperature").dispatchEvent("change");
  await expect(page.locator("#white-balance-mode")).toHaveValue("manual");
});

test("zooms, pans, pinches, and resets the preview without changing the export", async ({ page }) => {
  await ready(page);
  await page.locator("#photo-input").setInputFiles({ name: "zoom.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect(page.locator("#preview-image")).toBeVisible();
  await page.locator("#preview-image").hover();
  await page.mouse.wheel(0, -400);
  await expect.poll(async () => Number(await page.locator("#preview-image").evaluate((image) => (image as HTMLElement).style.scale))).toBeGreaterThan(1);
  const image = page.locator("#preview-image");
  const box = (await image.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 20);
  await page.mouse.up();
  await expect(image).not.toHaveCSS("translate", "none");
  await page.getByRole("button", { name: "Reset view" }).click();
  await expect.poll(async () => image.evaluate((node) => (node as HTMLElement).style.scale)).toBe("1");
  await image.dispatchEvent("pointerdown", { pointerId: 1, clientX: 100, clientY: 100 });
  await image.dispatchEvent("pointerdown", { pointerId: 2, clientX: 200, clientY: 100 });
  await image.dispatchEvent("pointermove", { pointerId: 2, clientX: 260, clientY: 100 });
  await expect.poll(async () => Number(await image.evaluate((node) => (node as HTMLElement).style.scale))).toBeGreaterThan(1);
});

test("shows elapsed activity instead of a fake Reference percentage", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = Worker;
    class DelayedWorker extends NativeWorker {
      postMessage(message: unknown, transfer?: StructuredSerializeOptions | Transferable[]) {
        if ((message as { type?: string }).type === "process") setTimeout(() => super.postMessage(message, transfer as Transferable[]), 1500);
        else super.postMessage(message, transfer as Transferable[]);
      }
    }
    Object.defineProperty(window, "Worker", { configurable: true, value: DelayedWorker });
  });
  await ready(page);
  await page.locator("#photo-input").setInputFiles({ name: "progress.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect(page.locator("#export")).toBeEnabled({ timeout: 60_000 });
  await page.getByRole("button", { name: "Reference Quality", exact: true }).click();
  await page.locator("#output-format").selectOption("jpeg");
  const download = page.waitForEvent("download");
  await page.locator("#export").click();
  await expect(page.locator("#export-meter")).not.toHaveAttribute("value");
  await expect(page.locator("#export-label")).toContainText("Reference Quality processing locally");
  await expect(page.locator("#export-percent")).toHaveText(/\d+s elapsed/, { timeout: 3_000 });
  await download;
});

test("reopens with the full local engine while offline", async ({ page, context }) => {
  await ready(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>((resolve) =>
      navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
  });
  const cached = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async (name) =>
    (await (await caches.open(name)).keys()).map((request) => new URL(request.url).pathname)))).flat());
  expect(cached).toEqual(expect.arrayContaining([
    expect.stringMatching(/^\/assets\/index-.*\.js$/),
    expect.stringMatching(/^\/assets\/engine-worker-.*\.js$/),
    `/wasm/${version}/spektrafilm_web_bg.wasm`,
  ]));
  await page.evaluate(async () => {
    const cache = await caches.open((await caches.keys())[0]);
    await cache.put("/wasm/spektrafilm_web_bg.wasm?v=old", new Response(new Uint8Array([0])));
  });
  await page.reload();
  await expect(page.locator("#engine-state")).toContainText("Local engine", { timeout: 60_000 });
  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.locator("#engine-state")).toContainText("Local engine", { timeout: 60_000 });
  } finally {
    await context.setOffline(false);
  }
});

test("runs Fast and Reference exports and keeps batch results separate", async ({ page }) => {
  await ready(page);
  await page.locator("#file-input").setInputFiles([
    { name: "one.jpg", mimeType: "image/jpeg", buffer: jpeg },
    { name: "two.jpg", mimeType: "image/jpeg", buffer: jpeg },
  ]);
  await expect(page.locator(".queue-item")).toHaveCount(2);
  await expect(page.locator("#export")).toBeEnabled({ timeout: 60_000 });
  await page.locator("#output-format").selectOption("jpeg");

  await page.getByRole("button", { name: "Fast GPU", exact: true }).click();
  const fastDownload = page.waitForEvent("download");
  await page.locator("#export").click();
  await expect(page.locator("#export-progress")).toBeVisible();
  await expect(page.locator("#export-percent")).toHaveText(/^\d+%$/);
  await expect(page.locator("#export-meter")).toHaveAttribute("value", /^\d+$/);
  const fast = await fastDownload;
  await expect(page.locator("#export-progress")).toBeHidden();
  expect(fast.suggestedFilename()).toBe("one-spektra.jpg");
  expect((await decodedDownload(page, fast)).width).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Reference Quality" }).click();
  const referenceDownload = page.waitForEvent("download");
  await page.locator("#export").click();
  const reference = await referenceDownload;
  expect(reference.suggestedFilename()).toBe("one-spektra.jpg");
  expect((await decodedDownload(page, reference)).width).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Fast GPU", exact: true }).click();
  await page.locator("#export-queue").click();
  await expect(page.locator(".queue-save", { hasText: "Save" })).toHaveCount(2, { timeout: 3 * 60_000 });
  const saved = page.waitForEvent("download");
  await page.locator(".queue-save", { hasText: "Save" }).first().click();
  expect((await saved).suggestedFilename()).toMatch(/-spektra\.jpg$/);
  await expect(page.locator(".queue-save", { hasText: "Save" })).toHaveCount(1);
});

test("exports the selected film pipeline and invalidates stale queue results", async ({ page }) => {
  await ready(page);
  await page.locator("#photo-input").setInputFiles({ name: "film.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect(page.locator("#export")).toBeEnabled({ timeout: 60_000 });
  await page.locator("#film-stock").selectOption("kodak_trix");
  await page.locator("#print-stock").selectOption("kodak_2302");
  await page.locator("#output-format").selectOption("jpeg");

  for (const mode of ["Fast GPU", "Reference Quality"]) {
    await page.getByRole("button", { name: mode, exact: true }).click();
    const pending = page.waitForEvent("download");
    await page.locator("#export").click();
    expect((await decodedDownload(page, await pending)).channelSpread, mode).toBeLessThan(3);
  }

  await page.locator("#export-queue").click();
  await expect(page.locator(".queue-save", { hasText: "Save" })).toHaveCount(1, { timeout: 3 * 60_000 });
  await page.locator("#film-stock").selectOption("kodak_portra_400");
  await expect(page.locator(".queue-save", { hasText: "Save" })).toHaveCount(0);
});

test("keeps the export film snapshot when the editor changes while reading the photo", async ({ page }) => {
  await ready(page);
  await page.locator("#photo-input").setInputFiles({ name: "film-race.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect(page.locator("#export")).toBeEnabled({ timeout: 60_000 });
  await page.locator("#output-format").selectOption("jpeg");
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = async function () {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return read.call(this);
    };
  });

  for (const mode of ["Fast GPU", "Reference Quality"]) {
    await page.getByRole("button", { name: mode, exact: true }).click();
    await page.locator("#film-stock").selectOption("kodak_trix");
    await page.locator("#print-stock").selectOption("kodak_2302");
    const pending = page.waitForEvent("download");
    await page.locator("#export").click();
    await page.locator("#film-stock").selectOption("kodak_portra_400");
    expect((await decodedDownload(page, await pending)).channelSpread, mode).toBeLessThan(3);
    await expect(page.locator("#export")).toBeEnabled({ timeout: 60_000 });
  }
});

test("commits an in-progress adjustment before JPEG export", async ({ page }) => {
  await ready(page);
  await page.locator("#photo-input").setInputFiles({ name: "pending-adjustment.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect(page.locator("#export")).toBeEnabled({ timeout: 60_000 });
  await page.locator("#output-format").selectOption("jpeg");

  for (const mode of ["Fast GPU", "Reference Quality"]) {
    await page.getByRole("button", { name: mode, exact: true }).click();
    await page.locator("#vignette-amount").evaluate((control: HTMLInputElement) => {
      control.value = "0";
      control.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const baselinePending = page.waitForEvent("download");
    await page.locator("#export").click();
    const baseline = await decodedDownload(page, await baselinePending);
    await expect(page.locator("#export")).toBeEnabled({ timeout: 60_000 });

    await page.locator("#vignette-amount").evaluate((control: HTMLInputElement) => {
      control.value = "-100";
      control.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const adjustedPending = page.waitForEvent("download");
    await page.locator("#export").click();
    const adjusted = await decodedDownload(page, await adjustedPending);

    expect(adjusted.hash, mode).not.toBe(baseline.hash);
    await expect(page.locator("#export")).toBeEnabled({ timeout: 60_000 });
  }
});

test("exports the same photo twice without reopening it", async ({ page }) => {
  await ready(page);
  test.setTimeout(10 * 60_000);
  await page.locator("#file-input").setInputFiles(fileURLToPath(new URL("./fixtures/canon-a410-chdk.dng", import.meta.url)));
  await expect(page.locator("#export")).toBeEnabled({ timeout: 60_000 });
  await page.locator("#output-format").selectOption("jpeg");
  await page.getByRole("button", { name: "Reference Quality", exact: true }).click();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pending = page.waitForEvent("download");
    await page.locator("#export").click();
    const exported = await pending;
    expect(exported.suggestedFilename()).toBe("canon-a410-chdk-spektra.jpg");
    expect((await decodedDownload(page, exported)).width).toBeGreaterThan(0);
    await expect(page.locator("#engine-state")).toContainText("Local engine", { timeout: 60_000 });
    await expect(page.locator("#export")).toBeEnabled({ timeout: 60_000 });
  }
});
