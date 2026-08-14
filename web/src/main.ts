import "./style.css";
import { cloneRecipe, isRuntimeSettings, parseRecipe, pushHistory, type Recipe } from "./editor-state";
import { autoWhiteBalance, neutralWhiteBalance } from "./white-balance";
import { exportScale, rawPreviewPolicy, safeExportMegapixels } from "./runtime";

type Inspection = {
  width: number;
  height: number;
  megapixels: number;
  estimatedWorkingBytes: number;
  requiresResize: boolean;
  maximumSafeMegapixels: number;
};

type QueueItem = {
  id: string;
  file: File;
  url: string;
  inspection?: Inspection;
  error?: string;
  approvedScale?: number;
  processedUrl?: string;
  retiredProcessedUrl?: string;
  result?: { storedAs: string; downloadAs: string; mime: string };
  recipe?: Recipe;
  rotation: number;
  zoom: number;
  panX: number;
  panY: number;
  sourceBytes?: ArrayBuffer;
};

const app = document.querySelector<HTMLElement>("#app")!;
app.innerHTML = `
  <header class="topbar">
    <a class="brand" href="/" aria-label="Spektra Mobile home"><span class="mark">S</span><span>Spektra <i>Mobile</i></span><small id="product-version">v…</small></a>
    <div class="engine-state" id="engine-state" role="status"><span></span>Checking WebGPU</div>
    <div class="top-actions"><label class="quiet add-files">Open more<input id="add-input" type="file" multiple accept="image/*,.dng,.cr2,.cr3,.nef,.nrw,.arw,.raf,.orf,.rw2,.pef,.srw,.x3f,.iiq,.3fr" /></label><button class="quiet" id="undo" type="button" disabled>Undo</button><button class="quiet" id="rotate" type="button" disabled>Rotate</button><button class="quiet" id="reset-view" type="button" disabled>Reset view</button><button class="quiet" id="compare" type="button" disabled>Before / After</button></div>
  </header>
  <section class="workspace">
    <div class="stage" id="drop-zone">
      <div class="empty-state" id="empty-state">
        <span class="aperture" aria-hidden="true">✦</span>
        <h1>Bring your negatives to life.</h1>
        <p>RAW development and a complete film → print → scan simulation. Your photos stay on this device.</p>
        <div class="picker-actions">
          <label class="primary-button">Open photos<input id="photo-input" type="file" multiple accept="image/*" /></label>
          <button class="primary-button" id="camera-open" type="button">Take photo</button>
          <label class="primary-button secondary-button" id="open-label">Open RAW files<input id="file-input" type="file" multiple accept=".dng,.cr2,.cr3,.nef,.nrw,.arw,.raf,.orf,.rw2,.pef,.srw,.x3f,.iiq,.3fr" /></label>
        </div>
        <small>RAW · JPEG · PNG · TIFF<br />For Apple ProRAW, shoot with RAW enabled in Camera, then choose it from Photos.</small>
      </div>
      <dialog class="camera-dialog" id="camera-dialog">
        <video id="camera-preview" autoplay playsinline muted></video>
        <div><button class="primary-button" id="camera-capture" type="button">Use photo</button><button class="quiet visible-quiet" id="camera-cancel" type="button">Cancel</button></div>
      </dialog>
      <figure class="preview" id="preview" hidden>
        <img id="preview-image" alt="Current photo preview" />
        <div class="preview-meta" id="preview-meta"></div>
      </figure>
    </div>
    <aside class="controls" aria-label="Film controls">
      <div class="mode-switch" role="group" aria-label="Export quality">
        <button type="button" data-mode="reference" aria-pressed="false">Reference Quality</button>
        <button type="button" data-mode="fast" aria-pressed="true">Fast GPU</button>
      </div>
      <section>
        <p class="eyebrow">Negative</p>
        <label>Film stock<select id="film-stock">
          <optgroup label="Kodak">
            <option value="kodak_portra_160">Portra 160</option>
            <option value="kodak_portra_400" selected>Portra 400</option>
            <option value="kodak_portra_800">Portra 800</option>
            <option value="kodak_portra_800_push1">Portra 800 — Push 1</option>
            <option value="kodak_portra_800_push2">Portra 800 — Push 2</option>
            <option value="kodak_gold_200">Gold 200</option>
            <option value="kodak_ultramax_400">Ultramax 400</option>
            <option value="kodak_ektar_100">Ektar 100</option>
            <option value="kodak_vision3_50d">Vision3 50D</option>
            <option value="kodak_vision3_200t">Vision3 200T</option>
            <option value="kodak_vision3_250d">Vision3 250D</option>
            <option value="kodak_vision3_500t">Vision3 500T</option>
            <option value="kodak_verita_200d">Verita 200D</option>
            <option value="kodak_doublex">Double-X 5222 (B&amp;W)</option>
            <option value="kodak_ektachrome_100" data-scan-target="film">Ektachrome 100 (reversal)</option>
            <option value="kodak_kodachrome_64" data-scan-target="film">Kodachrome 64 (reversal)</option>
            <option value="kodak_trix" data-scan-target="film">Tri-X 7266 (B&amp;W reversal)</option>
          </optgroup>
          <optgroup label="Fujifilm">
            <option value="fujifilm_c200">C200</option>
            <option value="fujifilm_xtra_400">X-Tra 400</option>
            <option value="fujifilm_pro_400h">Pro 400H</option>
            <option value="fujifilm_provia_100f" data-scan-target="film">Provia 100F (reversal)</option>
            <option value="fujifilm_velvia_100" data-scan-target="film">Velvia 100 (reversal)</option>
          </optgroup>
        </select></label>
        <label class="range-label"><span><b id="exposure-label">Exposure compensation</b><output id="exposure-output">0.0 EV</output></span><input id="exposure" type="range" min="-3" max="3" step="0.1" value="0" /></label>
      </section>
      <section>
        <p class="eyebrow">Print</p>
        <label>Print stock<select id="print-stock">
          <option value="none">None — scan film directly</option>
          <optgroup label="Kodak">
            <option value="kodak_portra_endura" selected>Professional Portra Endura</option>
            <option value="kodak_supra_endura">Professional Supra Endura</option>
            <option value="kodak_ultra_endura">Professional Ultra Endura</option>
            <option value="kodak_endura_premier">Professional Endura Premier</option>
            <option value="kodak_ektacolor_edge">Ektacolor Edge</option>
            <option value="kodak_2383">Vision 2383 Print Film</option>
            <option value="kodak_2393">Vision Premier 2393 Print Film</option>
            <option value="kodak_2302">2302 B&amp;W Print Film</option>
          </optgroup>
          <optgroup label="Fujifilm">
            <option value="fujifilm_crystal_archive_typeii">Crystal Archive Type II</option>
          </optgroup>
        </select></label>
        <label class="range-label"><span>Warmth <output id="warmth-output">0</output></span><input id="warmth" type="range" min="-100" max="100" value="0" /></label>
        <label class="range-label"><span>Print exposure <output>0.0 EV</output></span><input class="adjustment-control" id="print-exposure" type="range" min="-3" max="3" step="0.1" value="0" /></label>
        <label class="range-label"><span>Print contrast <output>0</output></span><input class="adjustment-control" id="print-contrast" type="range" min="-100" max="100" value="0" /></label>
      </section>
      <details>
        <summary>Advanced controls</summary>
        <p class="eyebrow">Light</p>
        <label>White balance<select id="white-balance-mode"><option value="as-shot">As Shot</option><option value="auto">Auto</option><option value="picker">Pick neutral point</option><option value="manual">Manual</option></select></label>
        <label>RAW white balance<select id="raw-white-balance"><option value="camera">Camera As Shot</option><option value="uncorrected">Uncorrected</option></select></label>
        <label>RAW demosaic<select id="raw-demosaic"><option value="ppg">PPG quality</option><option value="superpixel">Superpixel fast</option></select></label>
        <button class="quiet visible-quiet white-balance-picker" id="white-balance-picker" type="button" aria-pressed="false">Pick neutral point</button>
        <label class="range-label"><span>Temperature <output>0</output></span><input class="adjustment-control" id="temperature" type="range" min="-100" max="100" value="0" /></label>
        <label class="range-label"><span>Tint <output>0</output></span><input class="adjustment-control" id="tint" type="range" min="-100" max="100" value="0" /></label>
        <label class="range-label"><span>Contrast <output>0</output></span><input class="adjustment-control" id="contrast" type="range" min="-100" max="100" value="0" /></label>
        <label class="range-label"><span>Highlights <output>0</output></span><input class="adjustment-control" id="highlights" type="range" min="-100" max="100" value="0" /></label>
        <label class="range-label"><span>Shadows <output>0</output></span><input class="adjustment-control" id="shadows" type="range" min="-100" max="100" value="0" /></label>
        <label class="range-label"><span>Whites <output>0</output></span><input class="adjustment-control" id="whites" type="range" min="-100" max="100" value="0" /></label>
        <label class="range-label"><span>Blacks <output>0</output></span><input class="adjustment-control" id="blacks" type="range" min="-100" max="100" value="0" /></label>
        <label class="range-label"><span>Saturation <output>0</output></span><input class="adjustment-control" id="saturation" type="range" min="-100" max="100" value="0" /></label>
        <label class="range-label"><span>Vibrance <output>0</output></span><input class="adjustment-control" id="vibrance" type="range" min="-100" max="100" value="0" /></label>
        <label class="range-label"><span>Clarity <output>0</output></span><input class="adjustment-control" id="clarity" type="range" min="-100" max="100" value="0" /></label>
        <label class="range-label"><span>Dehaze <output>0</output></span><input class="adjustment-control" id="dehaze" type="range" min="-100" max="100" value="0" /></label>
        <p class="eyebrow">Film effects</p>
        <label class="check-label"><input id="auto-exposure" type="checkbox" checked /> Auto exposure</label>
        <label>Scan target<select id="scan-target"><option value="print">Printed paper</option><option value="film">Film negative</option></select></label>
        <label>Output colour<select id="output-colour"><option value="sRGB">sRGB</option><option value="ProPhoto RGB">ProPhoto RGB</option><option value="Rec. 2020">Rec. 2020</option><option value="ACES2065-1">ACES2065-1</option></select></label>
        <label class="check-label"><input id="gamut-lightness-active" type="checkbox" checked /> Gamut lightness compression</label>
        <label class="range-label"><span>Lightness threshold <output>0.7</output></span><input class="adjustment-control" id="gamut-lightness-threshold" type="range" min="0" max="1" step="0.01" value="0.7" /></label>
        <label class="range-label"><span>Lightness limit <output>1</output></span><input class="adjustment-control" id="gamut-lightness-limit" type="range" min="0" max="2" step="0.01" value="1" /></label>
        <label class="range-label"><span>Lightness power <output>2.2</output></span><input class="adjustment-control" id="gamut-lightness-power" type="range" min="0.1" max="5" step="0.1" value="2.2" /></label>
        <label class="range-label"><span>Grain <output>100%</output></span><input id="grain" type="range" min="0" max="200" value="100" /></label>
        <label class="range-label"><span>Halation <output>100%</output></span><input id="halation" type="range" min="0" max="200" value="100" /></label>
        <label class="range-label"><span>Halation size <output>100%</output></span><input class="adjustment-control" id="halation-size" type="range" min="25" max="300" value="100" /></label>
        <label class="range-label"><span>Light scatter <output>100%</output></span><input class="adjustment-control" id="scatter" type="range" min="0" max="200" value="100" /></label>
        <label class="range-label"><span>Scatter size <output>100%</output></span><input class="adjustment-control" id="scatter-size" type="range" min="25" max="300" value="100" /></label>
        <label class="range-label"><span>Highlight boost <output>0.0 EV</output></span><input class="adjustment-control" id="halation-highlight-boost" type="range" min="0" max="3" step="0.1" value="0" /></label>
        <label class="range-label"><span>Sharpness <output>70%</output></span><input id="sharpness" type="range" min="0" max="200" value="70" /></label>
        <p class="eyebrow">Composition</p>
        <label class="range-label"><span>Straighten <output>0.0°</output></span><input class="adjustment-control" id="straighten" type="range" min="-45" max="45" step="0.1" value="0" /></label>
        <label>Crop preset<select class="adjustment-control" id="crop-aspect"><option value="original">Original</option><option value="1:1">Square · Instagram</option><option value="4:5">4:5 portrait · Instagram</option><option value="5:4">5:4 landscape · Instagram</option><option value="3:2">3:2 landscape</option><option value="2:3">2:3 portrait</option><option value="16:9">16:9 landscape</option></select></label>
        <label class="range-label"><span>Crop size <output>100%</output></span><input class="adjustment-control" id="crop-scale" type="range" min="10" max="100" value="100" /></label>
        <label class="range-label"><span>Crop horizontal <output>0</output></span><input class="adjustment-control" id="crop-x" type="range" min="-100" max="100" value="0" /></label>
        <label class="range-label"><span>Crop vertical <output>0</output></span><input class="adjustment-control" id="crop-y" type="range" min="-100" max="100" value="0" /></label>
        <label class="range-label"><span>White border <output>0%</output></span><input class="adjustment-control" id="border" type="range" min="0" max="40" value="0" /></label>
        <p class="eyebrow">Post-crop vignette</p>
        <label class="range-label"><span>Amount <output>0</output></span><input class="adjustment-control" id="vignette-amount" type="range" min="-100" max="100" value="0" /></label>
        <label class="range-label"><span>Midpoint <output>50</output></span><input class="adjustment-control" id="vignette-midpoint" type="range" min="0" max="100" value="50" /></label>
        <label class="range-label"><span>Roundness <output>0</output></span><input class="adjustment-control" id="vignette-roundness" type="range" min="-100" max="100" value="0" /></label>
        <label class="range-label"><span>Feather <output>50</output></span><input class="adjustment-control" id="vignette-feather" type="range" min="0" max="100" value="50" /></label>
        <label class="range-label"><span>Highlights <output>0</output></span><input class="adjustment-control" id="vignette-highlights" type="range" min="0" max="100" value="0" /></label>
        <label>Apply adjustments<select id="adjustment-scope"><option value="all">All photos</option><option value="photo">This photo only</option></select></label>
        <details class="expert"><summary>Super advanced</summary><div id="super-advanced"></div></details>
        <div class="recipe-tools"><input id="recipe-name" type="text" value="My recipe" aria-label="Recipe name" /><button class="quiet visible-quiet" id="save-recipe" type="button">Save recipe</button><select id="saved-recipes" aria-label="Saved recipes"><option value="">Saved recipes…</option></select><button class="quiet visible-quiet" id="export-recipe" type="button">Export recipe</button><label class="quiet visible-quiet import-recipe">Import recipe<input id="import-recipe" type="file" accept="application/json,.json" /></label></div>
      </details>
      <label class="output-format">Output format<select id="output-format"><option value="tiff">16-bit TIFF</option><option value="jpeg">JPEG</option><option value="png">PNG</option></select></label>
      <label class="range-label" id="quality-label" hidden><span>JPEG quality <output>95%</output></span><input id="jpeg-quality" type="range" min="1" max="100" value="95" /></label>
      <button class="export-button" id="export" type="button" disabled>Export with Fast GPU</button>
      <button class="quiet batch-button" id="cancel-export" type="button" hidden>Cancel current export</button>
      <div class="batch-progress" id="export-progress" hidden>
        <div><span id="export-label">Preparing export…</span><strong id="export-percent">0%</strong></div>
        <progress id="export-meter" aria-label="Export progress" value="0" max="100"></progress>
      </div>
      <button class="quiet batch-button" id="export-queue" type="button" disabled>Export safe queue</button>
      <div class="batch-progress" id="batch-progress" hidden>
        <div><span id="batch-label">Preparing queue…</span><button class="quiet" id="cancel-batch" type="button">Stop after current</button></div>
        <progress id="batch-meter" value="0" max="1"></progress>
      </div>
      <p class="privacy">Files, processing, and temporary results stay on this device.</p>
    </aside>
  </section>
  <footer class="queue" id="queue" aria-label="Photo queue"></footer>
  <footer class="credits">
    Built from
    <a href="https://github.com/andreavolpato/spektrafilm" target="_blank" rel="noreferrer">Spektrafilm</a>,
    <a href="https://github.com/turbasvin/spektrafilm-rs" target="_blank" rel="noreferrer">spektrafilm-rs</a>, and
    <a href="https://github.com/mattyv/spektrafilm-web" target="_blank" rel="noreferrer">Spektra Mobile</a>.
    <a href="/third-party-notices.txt">Third-party notices</a>.
  </footer>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
`;

let requestId = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

function stopEngine(message: string) {
  for (const request of pending.values()) request.reject(new Error(message));
  pending.clear();
  gpuReady = false;
  state.classList.add("error");
  state.lastChild!.textContent = "Engine stopped — reload to recover";
  setEditingDisabled(true);
  const selected = queue.find((item) => item.id === selectedId);
  if (selected) renderSelected(selected);
  renderQueue();
}

function createWorker() {
  const instance = new Worker(new URL("./engine-worker.ts", import.meta.url), { type: "module" });
  instance.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    data.ok ? request.resolve(data.value) : request.reject(new Error(data.error));
  };
  instance.onerror = (event) => stopEngine(event.message || "Processing worker stopped");
  instance.onmessageerror = () => stopEngine("Worker message failed");
  return instance;
}

let worker = createWorker();

function askEngine<T>(message: object, transfer: Transferable[] = []): Promise<T> {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    worker.postMessage({ id, ...message }, transfer);
  });
}

const state = document.querySelector<HTMLElement>("#engine-state")!;
const productVersion = document.querySelector<HTMLElement>("#product-version")!;
const input = document.querySelector<HTMLInputElement>("#file-input")!;
const photoInput = document.querySelector<HTMLInputElement>("#photo-input")!;
const cameraOpen = document.querySelector<HTMLButtonElement>("#camera-open")!;
const cameraDialog = document.querySelector<HTMLDialogElement>("#camera-dialog")!;
const cameraPreview = document.querySelector<HTMLVideoElement>("#camera-preview")!;
const cameraCapture = document.querySelector<HTMLButtonElement>("#camera-capture")!;
const cameraCancel = document.querySelector<HTMLButtonElement>("#camera-cancel")!;
const addInput = document.querySelector<HTMLInputElement>("#add-input")!;
const preview = document.querySelector<HTMLElement>("#preview")!;
const previewImage = document.querySelector<HTMLImageElement>("#preview-image")!;
const previewMeta = document.querySelector<HTMLElement>("#preview-meta")!;
const empty = document.querySelector<HTMLElement>("#empty-state")!;
const queueElement = document.querySelector<HTMLElement>("#queue")!;
const exportButton = document.querySelector<HTMLButtonElement>("#export")!;
const exportProgress = document.querySelector<HTMLElement>("#export-progress")!;
const exportLabel = document.querySelector<HTMLElement>("#export-label")!;
const exportPercent = document.querySelector<HTMLElement>("#export-percent")!;
const exportMeter = document.querySelector<HTMLProgressElement>("#export-meter")!;
const exportQueueButton = document.querySelector<HTMLButtonElement>("#export-queue")!;
const batchProgress = document.querySelector<HTMLElement>("#batch-progress")!;
const batchLabel = document.querySelector<HTMLElement>("#batch-label")!;
const batchMeter = document.querySelector<HTMLProgressElement>("#batch-meter")!;
const cancelBatchButton = document.querySelector<HTMLButtonElement>("#cancel-batch")!;
const toast = document.querySelector<HTMLElement>("#toast")!;
const compareButton = document.querySelector<HTMLButtonElement>("#compare")!;
const rotateButton = document.querySelector<HTMLButtonElement>("#rotate")!;
const resetViewButton = document.querySelector<HTMLButtonElement>("#reset-view")!;
const undoButton = document.querySelector<HTMLButtonElement>("#undo")!;
const superAdvanced = document.querySelector<HTMLElement>("#super-advanced")!;
const savedRecipes = document.querySelector<HTMLSelectElement>("#saved-recipes")!;
const cancelExportButton = document.querySelector<HTMLButtonElement>("#cancel-export")!;
const whiteBalancePicker = document.querySelector<HTMLButtonElement>("#white-balance-picker")!;
const whiteBalanceMode = document.querySelector<HTMLSelectElement>("#white-balance-mode")!;
let queue: QueueItem[] = [];
let selectedId = "";
let gpuReady = false;
let settings: Record<string, any> | undefined;
let configuration = Promise.resolve();
let batchRunning = false;
let cancelBatch = false;
let engineGeneration = 0;
let exportMode: "reference" | "fast" = "fast";
let showingAfter = false;
let previewRevision = 0;
let previewRendering = false;
let previewTimer = 0;
let sharedRecipe: Recipe | undefined;
let history: Recipe[] = [];
let restoring = false;
let cameraStream: MediaStream | undefined;
let pickingWhiteBalance = false;
let exportActivityTimer = 0;
const viewPointers = new Map<number, { x: number; y: number }>();
let viewGesture = { distance: 0, centerX: 0, centerY: 0, zoom: 1, panX: 0, panY: 0 };
const rawExtensions = new Set(["dng", "cr2", "cr3", "nef", "nrw", "arw", "raf", "orf", "rw2", "pef", "srw", "x3f", "iiq", "3fr"]);
const desktop = !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
const desktopLimits = JSON.stringify({ memoryBudgetBytes: 8 * 1024 ** 3, maxStorageBindingBytes: 2 * 1024 ** 3 });

function isRaw(file: File) {
  return rawExtensions.has(file.name.split(".").pop()?.toLowerCase() ?? "");
}

function closeCamera() {
  for (const track of cameraStream?.getTracks() ?? []) track.stop();
  cameraStream = undefined;
  cameraPreview.srcObject = null;
  if (cameraDialog.open) cameraDialog.close();
}

cameraOpen.addEventListener("click", async () => {
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    cameraPreview.srcObject = cameraStream;
    cameraDialog.showModal();
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error));
  }
});

cameraCapture.addEventListener("click", async () => {
  try {
    if (!cameraStream || !cameraPreview.videoWidth || !cameraPreview.videoHeight) throw new Error("Camera is not ready yet");
    const canvas = document.createElement("canvas");
    canvas.width = cameraPreview.videoWidth;
    canvas.height = cameraPreview.videoHeight;
    canvas.getContext("2d")!.drawImage(cameraPreview, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Camera capture failed")), "image/jpeg", 0.95));
    closeCamera();
    await addFiles([new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" })]);
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error));
  }
});

cameraCancel.addEventListener("click", closeCamera);
cameraDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeCamera();
});

async function initialize(cleanup = true, ready = true) {
  if (!("gpu" in navigator)) {
    state.classList.add("error");
    state.lastChild!.textContent = "WebGPU required";
    input.disabled = true;
    return;
  }
  const info = await askEngine<{ version: string; settings: Record<string, any>; referenceThreads: number }>({ type: "init" });
  if (cleanup) await clearStoredResults().catch(() => undefined);
  settings = info.settings;
  sharedRecipe = currentRecipe("Default");
  renderSuperAdvanced();
  refreshSavedRecipes();
  gpuReady = ready;
  state.classList.toggle("ready", ready);
  state.dataset.readyText = `Local engine · ${info.referenceThreads} Reference ${info.referenceThreads === 1 ? "thread" : "threads"}`;
  state.lastChild!.textContent = ready ? state.dataset.readyText : "Restarting local engine";
  productVersion.textContent = `v${__APP_VERSION__}`;
}

async function restartEngine() {
  engineGeneration += 1;
  const selected = queue.find((item) => item.id === selectedId);
  const activeRecipe = selected ? recipeForItem(selected) : sharedRecipe && cloneRecipe(sharedRecipe);
  worker.terminate();
  for (const request of pending.values()) request.reject(new Error("Export cancelled"));
  pending.clear();
  configuration = Promise.resolve();
  gpuReady = false;
  state.classList.remove("ready", "error");
  state.lastChild!.textContent = "Restarting local engine";
  worker = createWorker();
  await initialize(false, false);
  if (activeRecipe) {
    sharedRecipe = activeRecipe;
    await queueConfiguration(activeRecipe);
  }
  gpuReady = true;
  state.classList.add("ready");
  state.lastChild!.textContent = state.dataset.readyText!;
  if (selected) renderSelected(selected);
  renderQueue();
}

function notify(message: string) {
  toast.textContent = message;
  toast.classList.add("visible");
  window.setTimeout(() => toast.classList.remove("visible"), 3200);
}

function currentRecipe(name = "Current"): Recipe {
  return {
    version: 1,
    name,
    film: document.querySelector<HTMLSelectElement>("#film-stock")!.value,
    print: document.querySelector<HTMLSelectElement>("#print-stock")!.value,
    settings: structuredClone(settings ?? {}),
  };
}

function recipeForItem(item: QueueItem): Recipe {
  return cloneRecipe(item.recipe ?? sharedRecipe ?? currentRecipe());
}

function queueConfiguration(recipe: Recipe) {
  configuration = configuration.catch(() => undefined).then(() => askEngine({
    type: "configure",
    film: recipe.film,
    print: recipe.print === "none" ? "kodak_portra_endura" : recipe.print,
    settings: JSON.stringify(recipe.settings),
    rawWhiteBalance: document.querySelector<HTMLSelectElement>("#raw-white-balance")!.value,
    rawDemosaic: document.querySelector<HTMLSelectElement>("#raw-demosaic")!.value,
  })).then(() => undefined);
  void configuration.catch((error) => notify(error instanceof Error ? error.message : String(error)));
  return configuration;
}

function pushUndo() {
  if (restoring || !settings) return;
  history = pushHistory(history, currentRecipe());
  undoButton.disabled = false;
}

const coveredSettings = new Set([
  "camera.exposure_compensation_ev", "camera.auto_exposure", "enlarger.y_filter_shift", "enlarger.m_filter_shift",
  "enlarger.print_exposure", "enlarger.print_exposure_compensation", "film_render.grain.active", "film_render.grain.agx_particle_scale",
  "film_render.halation.active", "film_render.halation.halation_amount", "film_render.halation.halation_spatial_scale",
  "film_render.halation.scatter_amount", "film_render.halation.scatter_spatial_scale", "film_render.halation.boost_ev",
  "print_render.density_curve_gamma", "scanner.unsharp_mask", "io.scan_film", "io.output_color_space",
  "io.output_gamut_compress.lightness_compression",
  ...["temperature", "tint", "contrast", "highlights", "shadows", "whites", "blacks", "saturation", "vibrance", "clarity", "dehaze"].map((name) => `adjustments.${name}`),
  ...["straighten_degrees", "aspect", "crop_scale", "crop_x", "crop_y", "border", "vignette_amount", "vignette_midpoint", "vignette_roundness", "vignette_feather", "vignette_highlights"].map((name) => `composition.${name}`),
]);

const settingOptions: Record<string, string[]> = {
  "camera.auto_exposure_method": ["center_weighted", "median", "mean"],
  "camera.diffusion_filter.filter_family": ["black_pro_mist", "glimmerglass", "soft_fx"],
  "enlarger.diffusion_filter.filter_family": ["black_pro_mist", "glimmerglass", "soft_fx"],
  "settings.rgb_to_raw_method": ["hanatos2025", "mallett2019"],
  "io.input_gamut_compress.algorithm": ["xy", "off"],
  "io.output_gamut_compress.algorithm": ["cam16ucs", "off"],
};

function settingAt(path: string) {
  const parts = path.split(".");
  const key = parts.pop()!;
  const parent = parts.reduce((value, part) => value[Number.isNaN(Number(part)) ? part : Number(part)], settings as any);
  return { parent, key: Number.isNaN(Number(key)) ? key : Number(key) };
}

function renderSuperAdvanced() {
  superAdvanced.replaceChildren();
  const leaves: [string, string | number | boolean][] = [];
  const visit = (value: any, path = "") => {
    if (coveredSettings.has(path)) return;
    if (value && typeof value === "object") Object.entries(value).forEach(([key, child]) => visit(child, path ? `${path}.${key}` : key));
    else if (["string", "number", "boolean"].includes(typeof value)) leaves.push([path, value]);
  };
  visit(settings);
  for (const [path, value] of leaves) {
    const label = document.createElement("label");
    label.className = "super-setting";
    const title = document.createElement("span");
    title.textContent = path.replaceAll("_", " ");
    label.append(title);
    const changed = (next: string | number | boolean) => {
      pushUndo();
      const target = settingAt(path);
      target.parent[target.key] = next;
      configure();
    };
    if (typeof value === "boolean") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = value;
      input.dataset.setting = path;
      input.addEventListener("change", () => changed(input.checked));
      label.classList.add("check-label");
      label.prepend(input);
    } else if (typeof value === "number") {
      const pair = document.createElement("div");
      pair.className = "super-number";
      const range = document.createElement("input");
      const exact = document.createElement("input");
      const span = Math.max(Math.abs(value) * 4, 1);
      range.type = "range";
      range.min = String(value < 0 ? -span : 0);
      range.max = String(value === 0 ? 100 : span);
      range.step = String(span <= 10 ? 0.01 : 0.1);
      range.value = exact.value = String(value);
      range.defaultValue = exact.defaultValue = String(value);
      range.dataset.setting = exact.dataset.setting = path;
      exact.type = "number";
      exact.step = range.step;
      range.addEventListener("input", () => { exact.value = range.value; });
      exact.addEventListener("input", () => { range.value = exact.value; });
      range.addEventListener("change", () => changed(Number(range.value)));
      exact.addEventListener("change", () => changed(Number(exact.value)));
      range.addEventListener("dblclick", () => {
        range.value = range.defaultValue;
        exact.value = exact.defaultValue;
        changed(Number(range.value));
      });
      pair.append(range, exact);
      label.append(pair);
    } else if (settingOptions[path]) {
      const select = document.createElement("select");
      select.dataset.setting = path;
      select.replaceChildren(...settingOptions[path].map((option) => new Option(option, option, false, option === value)));
      select.addEventListener("change", () => changed(select.value));
      label.append(select);
    } else {
      const input = document.createElement("input");
      input.type = "text";
      input.value = value;
      input.dataset.setting = path;
      input.addEventListener("change", () => changed(input.value));
      label.append(input);
    }
    superAdvanced.append(label);
  }
}

function setRange(id: string, value: number) {
  const range = document.querySelector<HTMLInputElement>(`#${id}`)!;
  range.value = String(value);
  range.closest("label")!.querySelector("output")!.textContent = rangeOutput(range);
}

function rangeOutput(range: HTMLInputElement) {
  const value = Number(range.value);
  if (["exposure", "print-exposure", "halation-highlight-boost"].includes(range.id)) return `${value.toFixed(1)} EV`;
  if (range.id === "straighten") return `${value.toFixed(1)}°`;
  if (["grain", "halation", "sharpness", "halation-size", "scatter", "scatter-size", "crop-scale", "border", "jpeg-quality"].includes(range.id)) return `${Math.round(value)}%`;
  return String(Math.round(value));
}

function setWhiteBalancePicker(active: boolean) {
  pickingWhiteBalance = active;
  whiteBalancePicker.setAttribute("aria-pressed", String(active));
  preview.classList.toggle("white-balance-picking", active);
}

async function applyAutoWhiteBalance() {
  const item = queue.find((candidate) => candidate.id === selectedId);
  if (!item?.url) return;
  const image = new Image();
  image.src = item.url;
  await image.decode();
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, 256 / Math.max(image.naturalWidth, image.naturalHeight));
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d")!;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const correction = autoWhiteBalance(context.getImageData(0, 0, canvas.width, canvas.height).data);
  setRange("temperature", correction.temperature);
  setRange("tint", correction.tint);
  configure();
}

function sampleWhiteBalance(event: MouseEvent) {
  if (!pickingWhiteBalance || !previewImage.naturalWidth) return;
  const item = queue.find((candidate) => candidate.id === selectedId);
  if (!item) return;
  const quarterTurns = item.rotation % 4;
  const canvas = document.createElement("canvas");
  canvas.width = quarterTurns % 2 ? previewImage.naturalHeight : previewImage.naturalWidth;
  canvas.height = quarterTurns % 2 ? previewImage.naturalWidth : previewImage.naturalHeight;
  const context = canvas.getContext("2d")!;
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate(quarterTurns * Math.PI / 2);
  context.drawImage(previewImage, -previewImage.naturalWidth / 2, -previewImage.naturalHeight / 2);
  const bounds = previewImage.getBoundingClientRect();
  const x = Math.max(0, Math.min(canvas.width - 1, Math.round((event.clientX - bounds.left) / bounds.width * canvas.width)));
  const y = Math.max(0, Math.min(canvas.height - 1, Math.round((event.clientY - bounds.top) / bounds.height * canvas.height)));
  const startX = Math.max(0, x - 2);
  const startY = Math.max(0, y - 2);
  const pixels = context.getImageData(startX, startY, Math.min(5, canvas.width - startX), Math.min(5, canvas.height - startY)).data;
  let red = 0, green = 0, blue = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    red += pixels[offset];
    green += pixels[offset + 1];
    blue += pixels[offset + 2];
  }
  const count = pixels.length / 4;
  const correction = neutralWhiteBalance(red / count, green / count, blue / count);
  pushUndo();
  const currentTemperature = showingAfter ? Number(document.querySelector<HTMLInputElement>("#temperature")!.value) : 0;
  const currentTint = showingAfter ? Number(document.querySelector<HTMLInputElement>("#tint")!.value) : 0;
  setRange("temperature", Math.max(-100, Math.min(100, currentTemperature + correction.temperature)));
  setRange("tint", Math.max(-100, Math.min(100, currentTint + correction.tint)));
  setWhiteBalancePicker(false);
  configure();
  notify("White balance sampled.");
}

function applyView(item: QueueItem) {
  previewImage.style.scale = String(item.zoom);
  previewImage.style.translate = `${item.panX}px ${item.panY}px`;
  previewImage.style.rotate = `${item.rotation * 90}deg`;
  resetViewButton.disabled = item.zoom === 1 && item.panX === 0 && item.panY === 0;
}

function viewMetrics() {
  const pointers = [...viewPointers.values()];
  const centerX = pointers.reduce((sum, point) => sum + point.x, 0) / pointers.length;
  const centerY = pointers.reduce((sum, point) => sum + point.y, 0) / pointers.length;
  const distance = pointers.length > 1 ? Math.hypot(pointers[0].x - pointers[1].x, pointers[0].y - pointers[1].y) : 0;
  return { centerX, centerY, distance };
}

function beginViewGesture(item: QueueItem) {
  const metrics = viewMetrics();
  viewGesture = { ...metrics, zoom: item.zoom, panX: item.panX, panY: item.panY };
}

function showRecipe(recipe: Recipe) {
  if (!isRuntimeSettings(recipe.settings)) throw new Error("Not a Spektra Mobile recipe");
  restoring = true;
  settings = structuredClone(recipe.settings);
  settings.adjustments ??= { temperature: 0, tint: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, saturation: 0, vibrance: 0, clarity: 0, dehaze: 0 };
  settings.composition ??= { straighten_degrees: 0, aspect: "original", crop_scale: 100, crop_x: 0, crop_y: 0, border: 0 };
  Object.assign(settings.composition, { vignette_amount: 0, vignette_midpoint: 50, vignette_roundness: 0, vignette_feather: 50, vignette_highlights: 0 }, settings.composition);
  document.querySelector<HTMLSelectElement>("#film-stock")!.value = recipe.film;
  document.querySelector<HTMLSelectElement>("#print-stock")!.value = recipe.print;
  document.querySelector<HTMLInputElement>("#exposure")!.value = String(settings.camera.exposure_compensation_ev);
  document.querySelector<HTMLOutputElement>("#exposure-output")!.value = `${Number(settings.camera.exposure_compensation_ev).toFixed(1)} EV`;
  const warmth = Number(settings.enlarger.y_filter_shift) / .5;
  document.querySelector<HTMLInputElement>("#warmth")!.value = String(warmth);
  document.querySelector<HTMLOutputElement>("#warmth-output")!.value = String(Math.round(warmth));
  setRange("grain", Number(settings.film_render.grain.agx_particle_scale[0]) / 1.6 * 100);
  setRange("halation", Number(settings.film_render.halation.halation_amount) * 100);
  setRange("halation-size", Number(settings.film_render.halation.halation_spatial_scale) * 100);
  setRange("scatter", Number(settings.film_render.halation.scatter_amount) * 100);
  setRange("scatter-size", Number(settings.film_render.halation.scatter_spatial_scale) * 100);
  setRange("halation-highlight-boost", Number(settings.film_render.halation.boost_ev));
  setRange("sharpness", Number(settings.scanner.unsharp_mask[0]) * 100);
  setRange("print-exposure", Math.log2(Number(settings.enlarger.print_exposure)));
  setRange("print-contrast", (Number(settings.print_render.density_curve_gamma) - 1) * 100);
  for (const id of ["temperature", "tint", "contrast", "highlights", "shadows", "whites", "blacks", "saturation", "vibrance", "clarity", "dehaze"]) setRange(id, Number(settings.adjustments[id]));
  setRange("straighten", Number(settings.composition.straighten_degrees));
  document.querySelector<HTMLSelectElement>("#crop-aspect")!.value = settings.composition.aspect;
  for (const id of ["crop-scale", "crop-x", "crop-y", "border"]) setRange(id, Number(settings.composition[id.replace("crop-", "crop_")]));
  for (const id of ["amount", "midpoint", "roundness", "feather", "highlights"]) setRange(`vignette-${id}`, Number(settings.composition[`vignette_${id}`]));
  document.querySelector<HTMLInputElement>("#auto-exposure")!.checked = Boolean(settings.camera.auto_exposure);
  document.querySelector("#exposure-label")!.textContent = settings.camera.auto_exposure ? "Exposure compensation" : "Exposure";
  document.querySelector<HTMLSelectElement>("#scan-target")!.value = settings.io.scan_film ? "film" : "print";
  document.querySelector<HTMLSelectElement>("#output-colour")!.value = settings.io.output_color_space;
  const lightness = settings.io.output_gamut_compress.lightness_compression as number[] | null;
  document.querySelector<HTMLInputElement>("#gamut-lightness-active")!.checked = lightness !== null;
  for (const [id, value] of [
    ["gamut-lightness-threshold", lightness?.[0] ?? 0.7],
    ["gamut-lightness-limit", lightness?.[1] ?? 1],
    ["gamut-lightness-power", lightness?.[2] ?? 2.2],
  ] as const) setRange(id, value);
  setGamutLightnessEnabled(lightness !== null);
  renderSuperAdvanced();
  restoring = false;
  invalidateProcessedPreviews();
  queueConfiguration(recipe);
  scheduleLivePreview();
}

function savedRecipeList(): Recipe[] {
  try {
    const value = JSON.parse(localStorage.getItem("spektra-recipes") ?? "[]");
    return Array.isArray(value) ? value.map((recipe) => parseRecipe(JSON.stringify(recipe))) : [];
  } catch {
    return [];
  }
}

function refreshSavedRecipes() {
  savedRecipes.replaceChildren(new Option("Saved recipes…", ""), ...savedRecipeList().map((recipe, index) => new Option(recipe.name, String(index))));
}

async function addFiles(files: File[]) {
  if (!gpuReady) {
    notify("The local engine is still starting. Try again in a moment.");
    return;
  }
  const additions: QueueItem[] = files.map((file) => ({ id: crypto.randomUUID(), file, url: isRaw(file) ? "" : URL.createObjectURL(file), rotation: 0, zoom: 1, panX: 0, panY: 0 }));
  queue.push(...additions);
  renderQueue();
  if (!selectedId && additions[0]) select(additions[0].id);

  for (const item of additions) {
    try {
      const bytes = await item.file.arrayBuffer();
      item.sourceBytes = bytes.slice(0);
      item.inspection = await askEngine<Inspection>({ type: "inspect", bytes, limits: desktop ? desktopLimits : undefined }, [bytes]);
      if (isRaw(item.file)) {
        const rawBytes = item.sourceBytes.slice(0);
        const previewPolicy = rawPreviewPolicy(!desktop, document.querySelector<HTMLSelectElement>("#raw-demosaic")!.value, item.inspection.megapixels);
        const previewBytes = await askEngine<Uint8Array<ArrayBuffer>>({
          type: "preview",
          bytes: rawBytes,
          developSensorData: previewPolicy.developSensorData,
          rawWhiteBalance: document.querySelector<HTMLSelectElement>("#raw-white-balance")!.value,
          rawDemosaic: previewPolicy.demosaic,
        }, [rawBytes]);
        item.url = URL.createObjectURL(new Blob([previewBytes], { type: "image/jpeg" }));
      }
    } catch (error) {
      item.error = String(error);
    }
    renderQueue();
    if (item.id === selectedId) renderSelected(item);
  }
}

function select(id: string) {
  if (id !== selectedId) {
    history = [];
    undoButton.disabled = true;
  }
  selectedId = id;
  showingAfter = false;
  const item = queue.find((candidate) => candidate.id === id);
  if (item) {
    document.querySelector<HTMLSelectElement>("#adjustment-scope")!.value = item.recipe ? "photo" : "all";
    showRecipe(recipeForItem(item));
    renderSelected(item);
  }
  renderQueue();
}

function renderSelected(item: QueueItem) {
  empty.hidden = true;
  preview.hidden = false;
  const displayedUrl = showingAfter ? item.processedUrl : item.url;
  if (displayedUrl) previewImage.src = displayedUrl;
  else previewImage.removeAttribute("src");
  applyView(item);
  previewImage.alt = `Preview of ${item.file.name}`;
  if (item.inspection) {
    const size = `${item.inspection.width} × ${item.inspection.height} · ${item.inspection.megapixels.toFixed(1)} MP`;
    const fastSafe = Math.min(item.inspection.maximumSafeMegapixels, 128 * 1024 * 1024 / 12 / 1_000_000, isRaw(item.file) && item.inspection.megapixels > 24 ? item.inspection.megapixels / 4 : Infinity, desktop ? Infinity : 2);
    previewMeta.replaceChildren();
    const message = document.createElement("span");
    message.textContent = item.inspection.requiresResize
      ? item.approvedScale
        ? `${size} · Approved · ${desktop ? `${item.inspection.maximumSafeMegapixels.toFixed(1)} MP` : `Fast ${fastSafe.toFixed(1)} MP · Reference 1.0 MP`}`
        : `${size} · Size choice required for this device`
      : `${size} · Safe to process locally`;
    previewMeta.append(message);
    if (item.inspection.requiresResize && !item.approvedScale) {
      const approve = document.createElement("button");
      approve.type = "button";
      approve.textContent = `Use safe ${item.inspection.maximumSafeMegapixels.toFixed(1)} MP`;
      approve.addEventListener("click", () => {
        item.approvedScale = Math.sqrt(item.inspection!.maximumSafeMegapixels / item.inspection!.megapixels);
        renderSelected(item);
        renderQueue();
      });
      previewMeta.append(approve);
    }
    previewMeta.classList.toggle("warning", item.inspection.requiresResize);
  } else {
    previewMeta.textContent = item.error ?? "Reading image locally…";
  }
  exportButton.disabled = !gpuReady || batchRunning || !isProcessable(item);
  compareButton.disabled = batchRunning || !isProcessable(item);
  rotateButton.disabled = batchRunning || !isProcessable(item);
  whiteBalancePicker.disabled = batchRunning || !isProcessable(item);
  compareButton.textContent = item.processedUrl
    ? showingAfter ? "Show before" : "Show after"
    : "Render after";
  if (!item.processedUrl && isProcessable(item) && !previewRendering) scheduleLivePreview();
}

function renderQueue() {
  queueElement.replaceChildren(...queue.map((item) => {
    const card = document.createElement("div");
    card.className = `queue-item ${item.id === selectedId ? "selected" : ""} ${item.result ? "ready" : ""}`;
    const choose = document.createElement("button");
    choose.type = "button";
    choose.className = "queue-select";
    choose.ariaLabel = `Edit ${item.file.name}`;
    const thumbnail = document.createElement("img");
    if (item.url) thumbnail.src = item.url;
    thumbnail.style.rotate = `${item.rotation * 90}deg`;
    thumbnail.alt = "";
    const name = document.createElement("span");
    name.textContent = item.file.name;
    const status = document.createElement("i");
    status.textContent = item.result ? "Ready to save" : item.inspection?.requiresResize && !item.approvedScale ? "Choose output size" : item.inspection ? `${item.inspection.megapixels.toFixed(1)} MP` : item.error ? "Needs decoder" : "Reading…";
    choose.append(thumbnail, name, status);
    choose.addEventListener("click", () => select(item.id));
    card.append(choose);
    if (item.result) {
      const save = document.createElement("button");
      save.type = "button";
      save.className = "queue-save";
      save.textContent = "Save";
      save.addEventListener("click", () => void saveStoredResult(item));
      card.append(save);
      if ("share" in navigator) {
        const share = document.createElement("button");
        share.type = "button";
        share.className = "queue-save";
        share.textContent = "Share";
        share.addEventListener("click", () => void shareStoredResult(item));
        card.append(share);
      }
    }
    const discard = document.createElement("button");
    discard.type = "button";
    discard.className = "queue-discard";
    discard.ariaLabel = `Remove ${item.file.name}`;
    discard.textContent = "Remove";
    discard.addEventListener("click", () => void discardItem(item));
    card.append(discard);
    return card;
  }));
  exportQueueButton.disabled = !gpuReady || batchRunning || !queue.some(isProcessable);
}

function isProcessable(item: QueueItem) {
  return Boolean(item.inspection && (!item.inspection.requiresResize || item.approvedScale));
}

function outputDetails(item: QueueItem) {
  const format = document.querySelector<HTMLSelectElement>("#output-format")!.value;
  const extension = format === "jpeg" ? "jpg" : format === "tiff" ? "tif" : "png";
  return {
    format,
    downloadAs: `${item.file.name.replace(/\.[^.]+$/, "")}-spektra.${extension}`,
    mime: format === "jpeg" ? "image/jpeg" : `image/${format}`,
  };
}

async function processItem(item: QueueItem, progress: (value: number, label: string) => void = () => {}) {
  await queueConfiguration(recipeForItem(item));
  progress(10, "Preparing image…");
  const details = outputDetails(item);
  const bytes = item.sourceBytes!.slice(0);
  progress(20, "Loading pixels…");
  const storageSafeMegapixels = 128 * 1024 * 1024 / 12 / 1_000_000;
  const rawSafeMegapixels = isRaw(item.file) && item.inspection!.megapixels > 24 ? item.inspection!.megapixels / 4 : storageSafeMegapixels;
  const safeMegapixels = safeExportMegapixels(!desktop, exportMode, item.inspection!.maximumSafeMegapixels, Math.min(storageSafeMegapixels, rawSafeMegapixels));
  const scale = exportScale(item.inspection!.megapixels, safeMegapixels);
  const quality = Number(document.querySelector<HTMLInputElement>("#jpeg-quality")!.value);
  progress(25, "Processing full pipeline…");
  const output = await askEngine<Uint8Array<ArrayBuffer>>({ type: "process", bytes, format: details.format, quality, scale, mode: exportMode, rotation: item.rotation }, [bytes]);
  progress(90, "Encoding output…");
  return { ...details, bytes: output.buffer };
}

function setExportProgress(value: number, label: string) {
  window.clearInterval(exportActivityTimer);
  exportActivityTimer = 0;
  if (value === 25 && exportMode === "reference") {
    exportMeter.removeAttribute("value");
    exportLabel.textContent = "Reference Quality processing locally…";
    const started = Date.now();
    const update = () => { exportPercent.textContent = `${Math.floor((Date.now() - started) / 1000)}s elapsed`; };
    update();
    exportActivityTimer = window.setInterval(update, 1000);
    return;
  }
  exportMeter.value = value;
  exportPercent.textContent = `${value}%`;
  exportLabel.textContent = label;
}

async function renderAfter(item: QueueItem) {
  const rawPreview = isRaw(item.file) && item.url;
  const bytes = rawPreview ? await (await fetch(item.url)).arrayBuffer() : item.sourceBytes!.slice(0);
  const scale = rawPreview ? 1 : Math.min(1, Math.sqrt(2 / item.inspection!.megapixels));
  const output = await askEngine<Uint8Array<ArrayBuffer>>({ type: "process", bytes, format: "jpeg", quality: 90, scale, mode: "fast", preserveMetadata: !rawPreview }, [bytes]);
  const url = URL.createObjectURL(new Blob([output], { type: "image/jpeg" }));
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Processed preview could not be loaded"));
    };
    image.src = url;
  });
  return url;
}

function setProcessedPreview(item: QueueItem, url: string) {
  const retired = [item.processedUrl, item.retiredProcessedUrl].filter((value): value is string => Boolean(value));
  item.processedUrl = url;
  item.retiredProcessedUrl = undefined;
  window.setTimeout(() => retired.forEach((value) => URL.revokeObjectURL(value)), 0);
}

function invalidateProcessedPreviews() {
  previewRevision += 1;
  for (const item of queue) {
    item.retiredProcessedUrl ??= item.processedUrl;
    item.processedUrl = undefined;
  }
  showingAfter = false;
}

function scheduleLivePreview() {
  window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => void refreshLivePreview(), 350);
}

async function refreshLivePreview() {
  if (previewRendering) return;
  const item = queue.find((candidate) => candidate.id === selectedId);
  if (!item || !isProcessable(item)) return;
  const revision = previewRevision;
  previewRendering = true;
  try {
    await configuration;
    const url = await renderAfter(item);
    if (revision === previewRevision && item.id === selectedId) {
      setProcessedPreview(item, url);
      showingAfter = true;
      renderSelected(item);
    } else {
      URL.revokeObjectURL(url);
    }
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error));
  } finally {
    previewRendering = false;
    if (revision !== previewRevision) scheduleLivePreview();
  }
}

async function resultsDirectory() {
  return (await navigator.storage.getDirectory()).getDirectoryHandle("spektra-results", { create: true });
}

async function storeResult(item: QueueItem, result: Awaited<ReturnType<typeof processItem>>) {
  const storedAs = `${item.id}-${result.downloadAs}`;
  const file = await (await resultsDirectory()).getFileHandle(storedAs, { create: true });
  const writable = await file.createWritable();
  await writable.write(result.bytes);
  await writable.close();
  item.result = { storedAs, downloadAs: result.downloadAs, mime: result.mime };
}

async function saveStoredResult(item: QueueItem) {
  if (!item.result) return;
  try {
    const handle = await (await resultsDirectory()).getFileHandle(item.result.storedAs);
    const file = await handle.getFile();
    download(file, item.result.downloadAs);
    await removeStoredResult(item);
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error));
  }
}

async function shareStoredResult(item: QueueItem) {
  if (!item.result) return;
  try {
    const handle = await (await resultsDirectory()).getFileHandle(item.result.storedAs);
    const stored = await handle.getFile();
    const file = new File([stored], item.result.downloadAs, { type: item.result.mime });
    if (!navigator.canShare?.({ files: [file] })) throw new Error("File sharing is unavailable in this browser");
    await navigator.share({ files: [file], title: item.result.downloadAs });
    await removeStoredResult(item);
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error));
  }
}

async function removeStoredResult(item: QueueItem) {
  if (!item.result) return;
  await (await resultsDirectory()).removeEntry(item.result.storedAs).catch(() => undefined);
  item.result = undefined;
  renderQueue();
}

async function discardItem(item: QueueItem) {
  await removeStoredResult(item);
  URL.revokeObjectURL(item.url);
  if (item.processedUrl) URL.revokeObjectURL(item.processedUrl);
  if (item.retiredProcessedUrl) URL.revokeObjectURL(item.retiredProcessedUrl);
  const index = queue.indexOf(item);
  queue.splice(index, 1);
  if (selectedId === item.id) {
    selectedId = queue[Math.min(index, queue.length - 1)]?.id ?? "";
    const selected = queue.find((candidate) => candidate.id === selectedId);
    if (selected) select(selected.id);
    else {
      preview.hidden = true;
      empty.hidden = false;
    }
  }
  renderQueue();
}

async function clearStoredResults() {
  const directory = await resultsDirectory();
  for await (const name of (directory as any).keys()) await directory.removeEntry(name, { recursive: true });
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setEditingDisabled(disabled: boolean) {
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>(
    "#film-stock,#print-stock,#exposure,#warmth,#auto-exposure,#grain,#halation,#sharpness,#scan-target,#output-colour,#adjustment-scope,#rotate,#reset-view,#compare,#white-balance-mode,#white-balance-picker,#raw-white-balance,#raw-demosaic,#gamut-lightness-active,#photo-input,#file-input,#add-input,#camera-open,#undo,#saved-recipes,#import-recipe,#output-format,#jpeg-quality,[data-mode],.adjustment-control,#super-advanced input,#super-advanced select,.queue-select,.queue-discard",
  ).forEach((control) => { control.disabled = disabled; });
}

whiteBalancePicker.addEventListener("click", () => {
  whiteBalanceMode.value = "picker";
  setWhiteBalancePicker(!pickingWhiteBalance);
});
whiteBalanceMode.addEventListener("change", () => {
  pushUndo();
  setWhiteBalancePicker(whiteBalanceMode.value === "picker");
  if (whiteBalanceMode.value === "as-shot") {
    setRange("temperature", 0);
    setRange("tint", 0);
    configure();
  } else if (whiteBalanceMode.value === "auto") {
    void applyAutoWhiteBalance().catch((error) => notify(error instanceof Error ? error.message : String(error)));
  }
});
previewImage.addEventListener("click", sampleWhiteBalance);
previewImage.addEventListener("wheel", (event) => {
  const item = queue.find((candidate) => candidate.id === selectedId);
  if (!item) return;
  event.preventDefault();
  item.zoom = Math.max(1, Math.min(8, item.zoom * Math.exp(-event.deltaY / 500)));
  if (item.zoom === 1) item.panX = item.panY = 0;
  applyView(item);
}, { passive: false });
previewImage.addEventListener("pointerdown", (event) => {
  const item = queue.find((candidate) => candidate.id === selectedId);
  if (!item) return;
  viewPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  beginViewGesture(item);
});
window.addEventListener("pointermove", (event) => {
  if (!viewPointers.has(event.pointerId)) return;
  const item = queue.find((candidate) => candidate.id === selectedId);
  if (!item) return;
  viewPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  const metrics = viewMetrics();
  if (viewPointers.size > 1) item.zoom = Math.max(1, Math.min(8, viewGesture.zoom * metrics.distance / Math.max(1, viewGesture.distance)));
  if (item.zoom > 1) {
    item.panX = viewGesture.panX + metrics.centerX - viewGesture.centerX;
    item.panY = viewGesture.panY + metrics.centerY - viewGesture.centerY;
  }
  applyView(item);
});
window.addEventListener("pointerup", (event) => {
  viewPointers.delete(event.pointerId);
  const item = queue.find((candidate) => candidate.id === selectedId);
  if (item && viewPointers.size) beginViewGesture(item);
});
resetViewButton.addEventListener("click", () => {
  const item = queue.find((candidate) => candidate.id === selectedId);
  if (!item) return;
  item.zoom = 1;
  item.panX = item.panY = 0;
  applyView(item);
});

for (const picker of [input, photoInput, addInput]) picker.addEventListener("change", () => {
  const files = Array.from(picker.files ?? []);
  picker.value = "";
  void addFiles(files);
});
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => event.preventDefault());
document.querySelector("#drop-zone")!.addEventListener("dragover", (event) => event.preventDefault());
document.querySelector("#drop-zone")!.addEventListener("drop", (event) => {
  event.preventDefault();
  addFiles(Array.from((event as DragEvent).dataTransfer?.files ?? []));
});

document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    exportMode = button.dataset.mode as "reference" | "fast";
    document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
    exportButton.textContent = exportMode === "reference" ? "Export reference quality" : "Export with Fast GPU";
    const selected = queue.find((item) => item.id === selectedId);
    if (selected) renderSelected(selected);
  });
});

document.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach((range) => {
  let lastTouch = 0;
  const reset = () => {
    if (range.value === range.defaultValue) return;
    delete range.dataset.editing;
    range.value = range.defaultValue;
    range.dispatchEvent(new Event("input", { bubbles: true }));
    range.dispatchEvent(new Event("change", { bubbles: true }));
  };
  range.addEventListener("input", () => {
    if (range.id !== "jpeg-quality" && !range.dataset.editing) {
      pushUndo();
      range.dataset.editing = "true";
    }
    const output = range.closest("label")?.querySelector("output");
    if (output) output.textContent = rangeOutput(range);
  });
  range.addEventListener("change", () => {
    delete range.dataset.editing;
    if (range.id !== "jpeg-quality") {
      if (range.id === "temperature" || range.id === "tint") whiteBalanceMode.value = "manual";
      configure();
    }
  });
  range.addEventListener("dblclick", reset);
  range.addEventListener("pointerup", (event) => {
    if (event.pointerType !== "touch") return;
    const now = Date.now();
    if (now - lastTouch < 400) reset();
    lastTouch = now;
  });
});

function configure() {
  if (!settings) return;
  invalidateProcessedPreviews();
  settings.camera.exposure_compensation_ev = Number(document.querySelector<HTMLInputElement>("#exposure")!.value);
  settings.enlarger.print_exposure_compensation = settings.camera.exposure_compensation_ev === 0;
  settings.camera.auto_exposure = document.querySelector<HTMLInputElement>("#auto-exposure")!.checked;
  const warmth = Number(document.querySelector<HTMLInputElement>("#warmth")!.value);
  settings.enlarger.y_filter_shift = warmth * 0.5;
  settings.enlarger.m_filter_shift = -warmth * 0.25;
  const grain = Number(document.querySelector<HTMLInputElement>("#grain")!.value) / 100;
  settings.film_render.grain.active = grain > 0;
  settings.film_render.grain.agx_particle_scale = [1.6 * grain, 1.6 * grain, 3.2 * grain];
  const halation = Number(document.querySelector<HTMLInputElement>("#halation")!.value) / 100;
  settings.film_render.halation.active = halation > 0;
  settings.film_render.halation.halation_amount = halation;
  settings.film_render.halation.halation_spatial_scale = Number(document.querySelector<HTMLInputElement>("#halation-size")!.value) / 100;
  settings.film_render.halation.scatter_amount = Number(document.querySelector<HTMLInputElement>("#scatter")!.value) / 100;
  settings.film_render.halation.scatter_spatial_scale = Number(document.querySelector<HTMLInputElement>("#scatter-size")!.value) / 100;
  settings.film_render.halation.boost_ev = Number(document.querySelector<HTMLInputElement>("#halation-highlight-boost")!.value);
  settings.scanner.unsharp_mask[0] = Number(document.querySelector<HTMLInputElement>("#sharpness")!.value) / 100;
  const printExposure = Number(document.querySelector<HTMLInputElement>("#print-exposure")!.value);
  settings.enlarger.print_exposure = 2 ** printExposure;
  settings.enlarger.normalize_print_exposure = printExposure === 0;
  const printContrast = 1 + Number(document.querySelector<HTMLInputElement>("#print-contrast")!.value) / 100;
  settings.print_render.density_curve_gamma = printContrast;
  settings.print_render.density_curves_morph.active = printContrast !== 1;
  settings.print_render.density_curves_morph.gamma_factor = printContrast;
  for (const id of ["temperature", "tint", "contrast", "highlights", "shadows", "whites", "blacks", "saturation", "vibrance", "clarity", "dehaze"]) settings.adjustments[id] = Number(document.querySelector<HTMLInputElement>(`#${id}`)!.value);
  settings.composition.straighten_degrees = Number(document.querySelector<HTMLInputElement>("#straighten")!.value);
  settings.composition.aspect = document.querySelector<HTMLSelectElement>("#crop-aspect")!.value;
  settings.composition.crop_scale = Number(document.querySelector<HTMLInputElement>("#crop-scale")!.value);
  settings.composition.crop_x = Number(document.querySelector<HTMLInputElement>("#crop-x")!.value);
  settings.composition.crop_y = Number(document.querySelector<HTMLInputElement>("#crop-y")!.value);
  settings.composition.border = Number(document.querySelector<HTMLInputElement>("#border")!.value);
  for (const id of ["amount", "midpoint", "roundness", "feather", "highlights"]) settings.composition[`vignette_${id}`] = Number(document.querySelector<HTMLInputElement>(`#vignette-${id}`)!.value);
  settings.io.scan_film = document.querySelector<HTMLSelectElement>("#scan-target")!.value === "film";
  settings.io.output_color_space = document.querySelector<HTMLSelectElement>("#output-colour")!.value;
  settings.io.output_gamut_compress.lightness_compression = document.querySelector<HTMLInputElement>("#gamut-lightness-active")!.checked
    ? ["threshold", "limit", "power"].map((name) => Number(document.querySelector<HTMLInputElement>(`#gamut-lightness-${name}`)!.value))
    : null;
  const recipe = currentRecipe();
  const selected = queue.find((item) => item.id === selectedId);
  if (document.querySelector<HTMLSelectElement>("#adjustment-scope")!.value === "photo" && selected) {
    selected.recipe = cloneRecipe(recipe);
  } else {
    if (selected) selected.recipe = undefined;
    sharedRecipe = cloneRecipe(recipe);
  }
  queueConfiguration(recipe);
  scheduleLivePreview();
  renderQueue();
}

rotateButton.addEventListener("click", () => {
  const item = queue.find((candidate) => candidate.id === selectedId);
  if (!item || !isProcessable(item)) return;
  item.rotation = (item.rotation + 1) % 4;
  invalidateProcessedPreviews();
  renderSelected(item);
  renderQueue();
  scheduleLivePreview();
});

compareButton.addEventListener("click", async () => {
  const item = queue.find((candidate) => candidate.id === selectedId);
  if (!item || !isProcessable(item)) return;
  if (!item.processedUrl) {
    compareButton.disabled = true;
    compareButton.textContent = "Rendering after…";
    try {
      await configuration;
      setProcessedPreview(item, await renderAfter(item));
      showingAfter = true;
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    }
  } else {
    showingAfter = !showingAfter;
  }
  renderSelected(item);
});

function setGamutLightnessEnabled(enabled: boolean) {
  for (const name of ["threshold", "limit", "power"]) document.querySelector<HTMLInputElement>(`#gamut-lightness-${name}`)!.disabled = !enabled;
}

for (const id of ["film-stock", "print-stock", "auto-exposure", "scan-target", "output-colour", "crop-aspect", "gamut-lightness-active"]) {
  document.querySelector(`#${id}`)!.addEventListener("change", () => {
    pushUndo();
    if (id === "film-stock") {
      const film = document.querySelector<HTMLSelectElement>("#film-stock")!;
      document.querySelector<HTMLSelectElement>("#scan-target")!.value =
        film.selectedOptions[0]?.dataset.scanTarget ?? "print";
    }
    if (id === "print-stock") {
      document.querySelector<HTMLSelectElement>("#scan-target")!.value =
        document.querySelector<HTMLSelectElement>("#print-stock")!.value === "none" ? "film" : "print";
    }
    if (id === "auto-exposure") {
      document.querySelector("#exposure-label")!.textContent =
        document.querySelector<HTMLInputElement>("#auto-exposure")!.checked ? "Exposure compensation" : "Exposure";
    }
    if (id === "gamut-lightness-active") setGamutLightnessEnabled(document.querySelector<HTMLInputElement>("#gamut-lightness-active")!.checked);
    configure();
  });
}

for (const id of ["raw-white-balance", "raw-demosaic"]) document.querySelector(`#${id}`)!.addEventListener("change", async () => {
  try {
    queueConfiguration(currentRecipe());
    invalidateProcessedPreviews();
    showingAfter = false;
    for (const item of queue.filter((candidate) => isRaw(candidate.file))) {
      const bytes = item.sourceBytes!.slice(0);
      const previewPolicy = rawPreviewPolicy(!desktop, document.querySelector<HTMLSelectElement>("#raw-demosaic")!.value, item.inspection?.megapixels);
      const previewBytes = await askEngine<Uint8Array<ArrayBuffer>>({
        type: "preview",
        bytes,
        developSensorData: previewPolicy.developSensorData,
        rawWhiteBalance: document.querySelector<HTMLSelectElement>("#raw-white-balance")!.value,
        rawDemosaic: previewPolicy.demosaic,
      }, [bytes]);
      const previousUrl = item.url;
      item.url = URL.createObjectURL(new Blob([previewBytes], { type: "image/jpeg" }));
      if (item.id === selectedId) renderSelected(item);
      if (previousUrl) setTimeout(() => URL.revokeObjectURL(previousUrl), 1000);
    }
    scheduleLivePreview();
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error));
  }
});

document.querySelector<HTMLSelectElement>("#output-format")!.addEventListener("change", (event) => {
  document.querySelector<HTMLElement>("#quality-label")!.hidden = (event.currentTarget as HTMLSelectElement).value !== "jpeg";
});

undoButton.addEventListener("click", () => {
  const recipe = history.pop();
  if (!recipe) return;
  const selected = queue.find((item) => item.id === selectedId);
  if (document.querySelector<HTMLSelectElement>("#adjustment-scope")!.value === "photo" && selected) selected.recipe = cloneRecipe(recipe);
  else sharedRecipe = cloneRecipe(recipe);
  showRecipe(recipe);
  undoButton.disabled = history.length === 0;
});

document.querySelector("#save-recipe")!.addEventListener("click", () => {
  const recipe = currentRecipe(document.querySelector<HTMLInputElement>("#recipe-name")!.value.trim() || "Untitled recipe");
  const recipes = savedRecipeList();
  const existing = recipes.findIndex((item) => item.name === recipe.name);
  if (existing >= 0) recipes[existing] = recipe;
  else recipes.push(recipe);
  localStorage.setItem("spektra-recipes", JSON.stringify(recipes));
  refreshSavedRecipes();
  notify(`Saved ${recipe.name}.`);
});

savedRecipes.addEventListener("change", () => {
  if (!savedRecipes.value) return;
  const recipe = savedRecipeList()[Number(savedRecipes.value)];
  if (!recipe) return;
  pushUndo();
  sharedRecipe = cloneRecipe(recipe);
  showRecipe(recipe);
});

document.querySelector("#export-recipe")!.addEventListener("click", () => {
  const recipe = currentRecipe(document.querySelector<HTMLInputElement>("#recipe-name")!.value.trim() || "Spektra recipe");
  download(new Blob([JSON.stringify(recipe, null, 2)], { type: "application/json" }), `${recipe.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.json`);
});

document.querySelector<HTMLInputElement>("#import-recipe")!.addEventListener("change", async (event) => {
  const picker = event.currentTarget as HTMLInputElement;
  const file = picker.files?.[0];
  picker.value = "";
  if (!file) return;
  try {
    const recipe = parseRecipe(await file.text());
    pushUndo();
    sharedRecipe = cloneRecipe(recipe);
    showRecipe(recipe);
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error));
  }
});

exportButton.addEventListener("click", async () => {
  const item = queue.find((candidate) => candidate.id === selectedId);
  if (!item) return;
  exportButton.disabled = true;
  cancelExportButton.hidden = false;
  exportProgress.hidden = false;
  setExportProgress(0, "Preparing export…");
  exportButton.textContent = "Processing full pipeline…";
  const generation = engineGeneration;
  try {
    await configuration;
    if (generation !== engineGeneration) throw new Error("Export cancelled");
    const result = await processItem(item, setExportProgress);
    if (generation !== engineGeneration) throw new Error("Export cancelled");
    setExportProgress(95, "Saving file…");
    download(new Blob([result.bytes], { type: result.mime }), result.downloadAs);
    setExportProgress(100, "Complete");
    notify(`${exportMode === "fast" ? "Fast GPU" : "Reference Quality"} export complete.`);
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error));
  } finally {
    window.clearInterval(exportActivityTimer);
    exportActivityTimer = 0;
    cancelExportButton.hidden = true;
    exportProgress.hidden = true;
    exportButton.textContent = exportMode === "fast" ? "Export with Fast GPU" : "Export reference quality";
    if (generation === engineGeneration) await restartEngine().catch((error) => notify(String(error)));
    renderQueue();
  }
});

cancelExportButton.addEventListener("click", () => {
  cancelExportButton.disabled = true;
  const restarting = restartEngine();
  notify("Export cancelled.");
  void restarting.catch((error) => notify(String(error))).finally(() => {
    cancelExportButton.disabled = false;
  });
});

cancelBatchButton.addEventListener("click", () => {
  cancelBatch = true;
  cancelBatchButton.disabled = true;
  batchLabel.textContent = "Stopping after current photo…";
});

exportQueueButton.addEventListener("click", async () => {
  const items = queue.filter(isProcessable);
  if (!items.length) return;
  batchRunning = true;
  setEditingDisabled(true);
  cancelBatch = false;
  exportQueueButton.disabled = true;
  exportButton.disabled = true;
  cancelBatchButton.disabled = false;
  batchProgress.hidden = false;
  batchMeter.max = items.length;
  batchMeter.value = 0;
  let completed = 0;
  let wakeLock: WakeLockSentinel | undefined;
  try {
    wakeLock = await navigator.wakeLock?.request("screen").catch(() => undefined);
    await configuration;
    for (const item of items) {
      if (cancelBatch) break;
      batchLabel.textContent = `${completed + 1} of ${items.length} · ${item.file.name}`;
      await storeResult(item, await processItem(item));
      completed += 1;
      batchMeter.value = completed;
      renderQueue();
      setEditingDisabled(true);
    }
    notify(cancelBatch ? `Stopped after ${completed} file${completed === 1 ? "" : "s"}.` : `${completed} files ready to save.`);
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error));
  } finally {
    await wakeLock?.release();
    batchRunning = false;
    setEditingDisabled(false);
    batchProgress.hidden = true;
    const selected = queue.find((item) => item.id === selectedId);
    if (selected) renderSelected(selected);
    renderQueue();
  }
});
initialize().catch((error) => {
  state.classList.add("error");
  state.lastChild!.textContent = "Engine failed to start";
  notify(String(error));
});

/* c8 ignore start -- production-only platform registration is covered by the offline production-browser test. */
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch((error) => notify(`Offline install failed: ${error}`));
}
/* c8 ignore stop */
