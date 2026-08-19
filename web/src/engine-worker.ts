/// <reference lib="webworker" />

import {
  engineRequestType,
  type EngineHandle,
  type EngineModule,
  type EngineRequest,
  type EngineResponse,
  type EngineResults,
} from "./engine-contract";
import { replaceAfterReady } from "./engine-transaction";
import { referenceThreadCount } from "./runtime";

let engine: EngineModule | undefined;
let processor: EngineHandle | undefined;
let filtersAsset: Uint8Array | undefined;
let lutAsset: Uint8Array | undefined;
let currentFilm = "kodak_portra_400";
let currentPrint = "kodak_portra_endura";

async function bytes(path: string): Promise<Uint8Array> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Could not load ${path}`);
  return new Uint8Array(await response.arrayBuffer());
}

function threadCount() {
  return referenceThreadCount(navigator.hardwareConcurrency, /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent), self.crossOriginIsolated, typeof SharedArrayBuffer !== "undefined");
}

async function loadEngine(): Promise<EngineModule> {
  if (!engine) {
    const threads = threadCount();
    const directory = threads > 1 ? "wasm-threaded" : "wasm";
    const enginePath = `/${directory}/${__APP_VERSION__}`;
    const modulePath = new URL(`${enginePath}/spektrafilm_web.js`, self.location.origin).href;
    // The module URL is only known at runtime, so this is the one unavoidable cast on the
    // boundary. `EngineModule` is not hand-maintained guesswork: `engine-contract.test.ts`
    // pins it to the Rust exports and `engine-bindings.check.ts` proves wasm-pack's generated
    // bindings satisfy it, so the cast asserts something both halves of the build verify.
    const loaded = (await import(/* @vite-ignore */ modulePath)) as EngineModule;
    await loaded.default(new URL(`${enginePath}/spektrafilm_web_bg.wasm`, self.location.origin));
    if (threads > 1) {
      if (!loaded.initThreadPool) throw new Error(`Engine build at ${enginePath} cannot start ${threads} threads`);
      await loaded.initThreadPool(threads);
    }
    engine = loaded;
  }
  return engine;
}

async function initialize(api: EngineModule): Promise<EngineResults["init"]> {
  const [film, print, filters, lut] = await Promise.all([
    bytes("/data/profiles/kodak_portra_400.json"),
    bytes("/data/profiles/kodak_portra_endura.json"),
    bytes("/data/filters/neutral_print_filters.json"),
    bytes("/data/luts/spectral_upsampling/irradiance_xy_tc.npy"),
  ]);
  filtersAsset = filters;
  lutAsset = lut;
  processor = new api.BrowserEngine(film, print, filters, lut);
  const gpu = await processor.enable_gpu();
  return {
    version: __APP_VERSION__,
    gpu,
    limits: JSON.parse(api.portable_limits_json()),
    settings: JSON.parse(api.default_settings_json()),
    referenceThreads: threadCount(),
  };
}

async function configure(api: EngineModule, data: EngineRequest<"configure">): Promise<EngineResults["configure"]> {
  if (!filtersAsset || !lutAsset) throw new Error("Engine assets are not initialized");
  if (processor && data.film === currentFilm && data.print === currentPrint) {
    processor.update_settings(data.settings);
    processor.set_raw_development(data.rawWhiteBalance, data.rawDemosaic);
  } else {
    const [film, print] = await Promise.all([
      bytes(`/data/profiles/${data.film}.json`),
      bytes(`/data/profiles/${data.print}.json`),
    ]);
    const replacement = new api.BrowserEngine(film, print, filtersAsset, lutAsset, data.settings);
    replacement.set_raw_development(data.rawWhiteBalance, data.rawDemosaic);
    processor = await replaceAfterReady(processor, replacement, (candidate) => candidate.enable_gpu());
    currentFilm = data.film;
    currentPrint = data.print;
  }
  return "configured";
}

/**
 * wasm-bindgen copies a returned `Vec<u8>` into a freshly allocated, non-shared
 * ArrayBuffer, so the generated `Uint8Array<ArrayBufferLike>` is always owned here.
 * The protocol records that narrower fact because it is what survives `postMessage`.
 */
function owned(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return value as Uint8Array<ArrayBuffer>;
}

async function process(data: EngineRequest<"process">): Promise<EngineResults["process"]> {
  if (!processor) throw new Error("Engine is not initialized");
  return data.mode === "fast"
    ? owned(await processor.process_fast_rotated(new Uint8Array(data.bytes), data.format, data.quality, data.scale, data.preserveMetadata !== false, data.rotation ?? 0))
    : owned(processor.process_reference_rotated(new Uint8Array(data.bytes), data.format, data.quality, data.scale, data.rotation ?? 0));
}

async function handle(data: EngineRequest): Promise<EngineResults[keyof EngineResults]> {
  // Rejects anything the switch below has no arm for, rather than letting it reach a handler.
  engineRequestType(data);
  const api = await loadEngine();
  switch (data.type) {
    case "init":
      return await initialize(api);
    case "inspect":
      return JSON.parse(api.inspect_image(new Uint8Array(data.bytes), data.limits));
    case "preview":
      return owned(api.raw_preview(new Uint8Array(data.bytes), 2400, data.developSensorData, data.rawWhiteBalance !== "uncorrected", data.rawDemosaic));
    case "configure":
      return await configure(api, data);
    case "process":
      return await process(data);
  }
}

let jobs = Promise.resolve();

self.onmessage = ({ data }: MessageEvent<EngineRequest>) => {
  jobs = jobs.then(() => respond(data));
};

async function respond(data: EngineRequest) {
  let response: EngineResponse;
  let transfer: Transferable[] = [];
  try {
    const value = await handle(data);
    response = { id: data.id, ok: true, value };
    if (value instanceof Uint8Array) transfer = [value.buffer];
  } catch (error) {
    response = { id: data.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  self.postMessage(response, transfer);
}
