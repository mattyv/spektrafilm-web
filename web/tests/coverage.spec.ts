import { expect, test } from "./test";
import { readFileSync } from "node:fs";

const jpeg = readFileSync(new URL("../public/icon.jpg", import.meta.url));

async function ready(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.locator("#engine-state")).toContainText("Local engine", { timeout: 60_000 });
}

test("reports missing WebGPU", async ({ page }) => {
  await page.addInitScript(() => delete (Navigator.prototype as unknown as { gpu?: unknown }).gpu);
  await page.goto("/");
  await expect(page.locator("#engine-state")).toContainText("WebGPU required");
});

test("reports worker startup failures", async ({ page }) => {
  await page.route("**/src/engine-worker.ts*", (route) => route.fulfill({ contentType: "text/javascript", body: "throw new Error('worker boom')" }));
  await page.goto("/");
  await expect(page.locator("#engine-state")).toContainText("Engine failed to start", { timeout: 60_000 });
  await page.locator("#photo-input").setInputFiles({ name: "early.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect(page.locator("#toast")).toContainText("still starting");
});

test("renders after immediately when comparison beats the preview debounce", async ({ page }) => {
  await ready(page);
  await page.locator("#photo-input").setInputFiles({ name: "compare.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect(page.locator("#compare")).toBeEnabled({ timeout: 60_000 });
  await page.locator("#compare").click();
  await expect(page.getByRole("button", { name: "Show before" })).toBeVisible({ timeout: 60_000 });
});

test("stops exports immediately after a worker message failure", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = Worker;
    class ObservableWorker extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        (window as typeof window & { engineWorker?: Worker }).engineWorker = this;
      }
    }
    Object.defineProperty(window, "Worker", { configurable: true, value: ObservableWorker });
  });
  await ready(page);
  await page.locator("#photo-input").setInputFiles({ name: "worker.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect(page.locator("#export")).toBeEnabled({ timeout: 60_000 });
  await page.evaluate(() => {
    (window as typeof window & { engineWorker: Worker }).engineWorker.onmessageerror?.(new MessageEvent("messageerror"));
  });
  await expect(page.locator("#engine-state")).toContainText("Engine stopped");
  await expect(page.locator("#export")).toBeDisabled();
});

test("opens, captures, cancels, and reports failures from the in-app camera", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => new MediaStream() },
    });
    Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 2 });
    Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get: () => 2 });
    HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} }) as unknown as CanvasRenderingContext2D;
    HTMLCanvasElement.prototype.toBlob = function (callback) { callback(new Blob(["camera"], { type: "image/jpeg" })); };
  });
  await ready(page);
  await page.getByRole("button", { name: "Take photo" }).click();
  await expect(page.locator("#camera-dialog")).toHaveAttribute("open", "");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("#camera-dialog")).not.toHaveAttribute("open", "");

  await page.getByRole("button", { name: "Take photo" }).click();
  await page.evaluate(() => Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 0 }));
  await page.getByRole("button", { name: "Use photo" }).click();
  await expect(page.locator("#toast")).toContainText("not ready");
  await page.evaluate(() => Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 2 }));
  await page.getByRole("button", { name: "Use photo" }).click();
  await expect(page.locator(".queue-item")).toHaveCount(1);

  await page.locator("#camera-dialog").evaluate((dialog) => (dialog as HTMLDialogElement).showModal());
  await page.locator("#camera-dialog").dispatchEvent("cancel");
  await expect(page.locator("#camera-dialog")).not.toHaveAttribute("open", "");
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new Error("camera denied"); };
  });
  await page.locator("#camera-open").evaluate((button) => (button as HTMLButtonElement).click());
  await expect(page.locator("#toast")).toContainText("camera denied");
});

test("handles invalid images and approves an oversized mobile photo", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "userAgent", { value: "iPhone", configurable: true }));
  await ready(page);
  await page.locator("#photo-input").setInputFiles({ name: "broken.jpg", mimeType: "image/jpeg", buffer: Buffer.from("broken") });
  await expect(page.locator("#preview-meta")).toContainText("unsupported or damaged", { timeout: 60_000 });
  await page.locator("#file-input").setInputFiles({ name: "broken.dng", mimeType: "", buffer: Buffer.from("broken") });
  await page.locator(".queue-select").last().click();
  await expect(page.locator("#preview-meta")).toContainText("unsupported or damaged", { timeout: 60_000 });
  await page.locator(".controls > details > summary").click();
  await page.locator("#raw-white-balance").evaluate((select: HTMLSelectElement) => {
    select.value = "uncorrected";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator("#toast")).toContainText(/RAW preview failed|unsupported or damaged/, { timeout: 60_000 });

  const large = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 12_000;
    canvas.height = 1_000;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#864";
    context.fillRect(0, 0, canvas.width, canvas.height);
    return [...new Uint8Array(await (await fetch(canvas.toDataURL("image/jpeg", 0.5))).arrayBuffer())];
  }));
  await page.locator("#photo-input").setInputFiles({ name: "large.jpg", mimeType: "image/jpeg", buffer: large });
  await page.locator(".queue-select").last().click();
  const approve = page.getByRole("button", { name: /^Use safe/ });
  await expect(approve).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(500);
  await approve.click();
  await expect(page.locator("#preview-meta")).toContainText("Approved");
  await expect(page.getByRole("button", { name: "Show before" })).toBeVisible({ timeout: 3 * 60_000 });
});

test("keeps an opened RAW readable after the picker file becomes unavailable", async ({ page }) => {
  await ready(page);
  await page.locator("#file-input").setInputFiles({
    name: "picker-once.dng",
    mimeType: "image/x-adobe-dng",
    buffer: readFileSync(new URL("./fixtures/canon-a410-chdk.dng", import.meta.url)),
  });
  await expect(page.locator("#export")).toBeEnabled({ timeout: 60_000 });
  await page.evaluate(() => {
    File.prototype.arrayBuffer = () => Promise.reject(new DOMException("The I/O read operation failed.", "NotReadableError"));
  });
  await page.locator("#output-format").selectOption("jpeg");
  const pending = page.waitForEvent("download");
  await page.locator("#export").click();
  expect((await pending).suggestedFilename()).toBe("picker-once-spektra.jpg");
  await expect(page.locator("#toast")).not.toContainText("NotReadableError");
});

test("resets a slider with a mobile double-tap", async ({ page }) => {
  await ready(page);
  const exposure = page.locator("#exposure");
  await exposure.fill("2");
  await exposure.dispatchEvent("pointerup", { pointerType: "touch" });
  await exposure.dispatchEvent("pointerup", { pointerType: "touch" });
  await expect(exposure).toHaveValue("0");
});

test("imports, exports, loads, and rejects recipes", async ({ page }) => {
  await ready(page);
  await page.locator(".controls > details > summary").click();
  await page.locator("#recipe-name").fill("Coverage recipe");
  await page.locator("#save-recipe").click();
  await page.locator("#saved-recipes").selectOption("0");

  const download = page.waitForEvent("download");
  await page.locator("#export-recipe").click();
  const exported = await download;
  expect(exported.suggestedFilename()).toBe("coverage-recipe.json");

  const settings = JSON.parse(await (await import("node:fs/promises")).readFile(await exported.path() as string, "utf8")).settings;
  settings.camera.exposure_compensation_ev = 1;
  const recipe = JSON.stringify({ version: 1, name: "Imported", film: "kodak_portra_400", print: "kodak_portra_endura", settings });
  await page.locator("#import-recipe").setInputFiles({ name: "valid.json", mimeType: "application/json", buffer: Buffer.from(recipe) });
  await expect(page.locator("#exposure")).toHaveValue("1");
  await expect(page.locator("#import-recipe")).toHaveValue("");
  await page.locator("#import-recipe").setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from("{}") });
  await expect(page.locator("#toast")).toContainText("Not a Spektra Mobile recipe");

});

test("recovers from corrupt saved recipe storage", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("spektra-recipes", "broken"));
  await ready(page);
  await expect(page.locator("#saved-recipes option")).toHaveCount(1);
});

test("connects Lightroom, creates an album, and uploads finished files", async ({ page }) => {
  let uploads = 0;
  let failUpload = false;
  let failAlbum = false;
  await page.addInitScript(() => sessionStorage.setItem("lr_access_token", "test-token"));
  await page.route("https://lr.adobe.io/v2/**", async (route) => {
    const url = route.request().url();
    if (url.endsWith("/catalog")) return route.fulfill({ body: 'while (1) {}{"id":"catalog"}' });
    if (url.endsWith("/account")) return route.fulfill({ body: 'while (1) {}{"id":"account"}' });
    if (url.includes("/albums?") ) return route.fulfill({ body: 'while (1) {}{"resources":[{"id":"album","payload":{"name":"Existing"}}]}' });
    if (url.includes("/albums/") && route.request().method() === "PUT" && !url.endsWith("/assets")) {
      return route.fulfill({ status: failAlbum ? 500 : 200, body: failAlbum ? "album failed" : "{}" });
    }
    if (url.endsWith("/master")) {
      uploads++;
      return route.fulfill({ status: failUpload && uploads % 2 === 0 ? 500 : 200, body: "{}" });
    }
    return route.fulfill({ body: "{}" });
  });
  await ready(page);
  await expect(page.locator("#lightroom-signed-in")).toBeVisible();
  await expect(page.locator("#lightroom-album option")).toContainText(["All photos (no album)", "Existing"]);
  await page.locator("#lightroom-create-album").click();
  await expect(page.locator("#toast")).toContainText("Give the album a name");
  await page.locator("#lightroom-new-album").fill("New album");
  await page.locator("#lightroom-create-album").click();
  await expect(page.locator("#toast")).toContainText("Created album");

  await page.locator("#photo-input").setInputFiles({ name: "adobe.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect(page.locator("#export")).toBeEnabled({ timeout: 60_000 });
  await page.locator("#output-format").selectOption("jpeg");
  await page.locator("#export-queue").click();
  await expect(page.getByRole("button", { name: "Lightroom" })).toBeVisible({ timeout: 3 * 60_000 });
  await page.getByRole("button", { name: "Lightroom" }).click();
  await expect(page.locator("#toast")).toContainText("to Lightroom");

  await page.locator("#export-queue").click();
  await expect(page.locator("#lightroom-upload-queue")).toBeEnabled({ timeout: 3 * 60_000 });
  failUpload = true;
  await page.locator("#add-input").setInputFiles({ name: "adobe-2.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await page.locator("#export-queue").click();
  await page.locator("#lightroom-upload-queue").click();
  await expect(page.locator("#toast")).toContainText(/Saved \d+ to Lightroom, \d+ failed/, { timeout: 3 * 60_000 });

  failAlbum = true;
  await page.locator("#lightroom-new-album").fill("Broken album");
  await page.locator("#lightroom-create-album").click();
  await expect(page.locator("#toast")).toContainText("Could not create album");
  await page.locator("#lightroom-signout").click();
  await expect(page.locator("#lightroom-signin")).toBeVisible();
});

test("reports an incomplete Lightroom redirect", async ({ page }) => {
  await page.goto("/?code=missing-verifier");
  await expect(page.locator("#toast")).toContainText("missing verifier");
});

test("drops and discards files, then handles save and share results", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
    Object.defineProperty(navigator, "share", { configurable: true, value: async () => undefined });
  });
  await ready(page);
  await page.locator("#drop-zone").dispatchEvent("dragover");
  await page.locator("#drop-zone").evaluate((element, bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], "dropped.jpg", { type: "image/jpeg" }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, [...jpeg]);
  await expect(page.locator(".queue-item")).toHaveCount(1);
  await page.locator("#add-input").setInputFiles({ name: "second.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect(page.locator(".queue-item")).toHaveCount(2);
  await page.locator(".queue-discard").first().click();
  await expect(page.locator(".queue-item")).toHaveCount(1);

  await page.getByRole("button", { name: "Fast GPU", exact: true }).click();
  await page.locator("#output-format").selectOption("jpeg");
  await page.locator("#export-queue").click();
  for (const selector of ["#photo-input", "#file-input", "#add-input", "#camera-open", "#undo", "#saved-recipes", "#import-recipe", "[data-mode]", ".queue-select"]) {
    await expect(page.locator(selector).first()).toBeDisabled();
  }
  await expect(page.getByRole("button", { name: "Share" })).toBeVisible({ timeout: 3 * 60_000 });
  await page.getByRole("button", { name: "Share" }).click();
  await expect(page.getByRole("button", { name: "Share" })).toHaveCount(0);

  await page.locator("#export-queue").click();
  await expect(page.getByRole("button", { name: "Save" })).toBeVisible({ timeout: 3 * 60_000 });
  await page.evaluate(() => Object.defineProperty(navigator, "canShare", { configurable: true, value: () => false }));
  await page.getByRole("button", { name: "Share" }).click();
  await expect(page.locator("#toast")).toContainText("sharing is unavailable");
  await page.evaluate(async () => {
    const directory = await navigator.storage.getDirectory();
    const results = await directory.getDirectoryHandle("spektra-results");
    for await (const name of (results as unknown as { keys(): AsyncIterable<string> }).keys()) await results.removeEntry(name);
  });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toContainText(/could not be found|does not exist/i);

  await page.locator(".queue-discard").click();
  await expect(page.locator("#empty-state")).toBeVisible();
});

test("recovers from preview, export, and batch failures", async ({ page }) => {
  await ready(page);
  await page.locator("#photo-input").setInputFiles({ name: "preview.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect(page.locator("#export")).toBeEnabled({ timeout: 60_000 });
  await page.locator("#exposure").fill("1");
  await page.evaluate(() => Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:broken" }));
  await page.getByRole("button", { name: "Render after" }).click();
  await expect(page.locator("#toast")).toContainText("Processed preview could not be loaded", { timeout: 60_000 });
});

test("recovers from export and batch failures", async ({ page }) => {
  await ready(page);
  await page.locator("#photo-input").setInputFiles({ name: "cancel.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect(page.locator("#export")).toBeEnabled({ timeout: 60_000 });
  await page.locator("#export").click();
  await page.locator("#cancel-export").click();
  await expect(page.locator("#toast")).toContainText("Export cancelled");

  await page.evaluate(() => Object.defineProperty(navigator.storage, "getDirectory", {
    configurable: true,
    value: async () => ({
      keys: async function* () {},
      getDirectoryHandle: async () => ({ getFileHandle: async () => { throw new Error("storage failed"); } }),
    }),
  }));
  await page.locator("#export-queue").click();
  await expect(page.locator("#toast")).toContainText("storage failed", { timeout: 3 * 60_000 });
});
