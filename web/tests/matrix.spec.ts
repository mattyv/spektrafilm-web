import { expect, test } from "./test";

const targets = ["print", "film"];
const colours = ["sRGB", "ProPhoto RGB", "Rec. 2020", "ACES2065-1"];

async function toneRamp(page: import("@playwright/test").Page) {
  return Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 32;
    const context = canvas.getContext("2d")!;
    const gradient = context.createLinearGradient(0, 0, canvas.width, 0);
    gradient.addColorStop(0, "black");
    gradient.addColorStop(1, "white");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    return [...new Uint8Array(await (await fetch(canvas.toDataURL("image/png"))).arrayBuffer())];
  }));
}

async function decoded(page: import("@playwright/test").Page) {
  return page.locator("#preview-image").evaluate(async (image: HTMLImageElement) => {
    await image.decode();
    return { src: image.src, width: image.naturalWidth, height: image.naturalHeight };
  });
}

test("renders every film and print-stock pair plus every scan and colour option", async ({ page }) => {
  test.setTimeout(30 * 60_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator("#engine-state")).toContainText("Local engine", { timeout: 60_000 });
  await page.locator("#file-input").setInputFiles({ name: "tone-ramp.png", mimeType: "image/png", buffer: await toneRamp(page) });
  await expect(page.getByRole("button", { name: "Show before" })).toBeVisible({ timeout: 3 * 60_000 });
  await page.locator(".controls > details > summary").click();

  const films = await page.locator("#film-stock option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  const papers = await page.locator("#print-stock option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  expect(films).toHaveLength(22);
  expect(papers).toHaveLength(10);

  for (const film of films) for (const paper of papers) {
    const before = await decoded(page);
    const changed = await page.locator("#film-stock").inputValue() !== film
      || await page.locator("#print-stock").inputValue() !== paper;
    await page.locator("#film-stock").selectOption(film);
    await page.locator("#print-stock").selectOption(paper);
    if (changed) await expect.poll(() => page.locator("#preview-image").getAttribute("src"), {
        message: `${film} + ${paper}`,
        timeout: 3 * 60_000,
      }).not.toBe(before.src);
    const after = await decoded(page);
    expect(after.width, `${film} + ${paper}`).toBeGreaterThan(0);
    expect(after.height, `${film} + ${paper}`).toBeGreaterThan(0);
  }

  for (const target of targets) for (const colour of colours) {
    const before = await decoded(page);
    const changed = await page.locator("#scan-target").inputValue() !== target
      || await page.locator("#output-colour").inputValue() !== colour;
    await page.locator("#scan-target").selectOption(target);
    await page.locator("#output-colour").selectOption(colour);
    if (changed) await expect.poll(() => page.locator("#preview-image").getAttribute("src"), {
        message: `${target} + ${colour}`,
        timeout: 3 * 60_000,
      }).not.toBe(before.src);
    expect((await decoded(page)).width, `${target} + ${colour}`).toBeGreaterThan(0);
  }
  expect(errors).toEqual([]);
});

test("exports every engine and output-format combination", async ({ page }) => {
  test.setTimeout(30 * 60_000);
  await page.goto("/");
  await expect(page.locator("#engine-state")).toContainText("Local engine", { timeout: 60_000 });
  await page.locator("#file-input").setInputFiles({ name: "tone-ramp.png", mimeType: "image/png", buffer: await toneRamp(page) });
  await expect(page.locator("#export")).toBeEnabled({ timeout: 60_000 });

  for (const mode of ["Fast GPU", "Reference Quality"]) for (const format of ["jpeg", "png", "tiff"]) {
    await page.getByRole("button", { name: mode, exact: true }).click();
    await page.locator("#output-format").selectOption(format);
    const pending = page.waitForEvent("download");
    await page.locator("#export").click();
    const download = await pending;
    const bytes = await (await import("node:fs/promises")).readFile(await download.path() as string);
    expect(bytes.length, `${mode} ${format}`).toBeGreaterThan(100);
    if (format === "jpeg") expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    if (format === "png") expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    if (format === "tiff") expect(bytes.subarray(0, 4).toString("hex")).toMatch(/^(49492a00|4d4d002a)$/);
    await expect(page.locator("#engine-state")).toContainText("Local engine", { timeout: 60_000 });
  }
});

test("groups the catalogue by manufacturer and selects direct scan for reversal film", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#engine-state")).toContainText("Local engine", { timeout: 60_000 });
  await page.locator(".controls > details > summary").click();
  await expect(page.locator('#film-stock optgroup[label="Kodak"] option')).toHaveCount(17);
  await expect(page.locator('#film-stock optgroup[label="Fujifilm"] option')).toHaveCount(5);
  await expect(page.locator('#print-stock optgroup[label="Kodak"] option')).toHaveCount(8);
  await expect(page.locator('#print-stock optgroup[label="Fujifilm"] option')).toHaveCount(1);
  for (const film of ["kodak_ektachrome_100", "kodak_kodachrome_64", "kodak_trix", "fujifilm_provia_100f", "fujifilm_velvia_100"]) {
    await page.locator("#film-stock").selectOption(film);
    await expect(page.locator("#scan-target")).toHaveValue("film");
  }
  await page.locator("#film-stock").selectOption("kodak_portra_400");
  await expect(page.locator("#scan-target")).toHaveValue("print");
  await page.locator("#scan-target").selectOption("film");
  await page.locator("#print-stock").selectOption("kodak_2302");
  await expect(page.locator("#scan-target")).toHaveValue("print");
});
