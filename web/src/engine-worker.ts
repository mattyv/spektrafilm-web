/// <reference lib="webworker" />

import { replaceAfterReady } from "./engine-transaction";
import { referenceThreadCount } from "./runtime";

type EngineModule = typeof import("../public/wasm/spektrafilm_web.js") & {
  initThreadPool?: typeof import("../public/wasm-threaded/spektrafilm_web.js")["initThreadPool"];
};

export type EngineMessage =
  | { type: "init" }
  | { type: "inspect"; bytes: ArrayBuffer; limits?: string }
  | { type: "preview"; bytes: ArrayBuffer; developSensorData: boolean; rawWhiteBalance: string; rawDemosaic: string }
  | { type: "configure"; film: string; print: string; settings: string; rawWhiteBalance: string; rawDemosaic: string }
  | { type: "process"; bytes: ArrayBuffer; format: string; quality: number; scale: number; mode: "reference" | "fast"; preserveMetadata?: boolean; rotation?: number };

type EngineRequest = EngineMessage & { id: number };

let engine: EngineModule | undefined;
let processor: InstanceType<EngineModule["BrowserEngine"]> | undefined;
let filtersAsset: Uint8Array | undefined;
let lutAsset: Uint8Array | undefined;
let currentFilm = "kodak_portra_400";
let currentPrint = "kodak_portra_endura";

async function bytes(path: string): Promise<Uint8Array> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Could not load ${path}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function loadEngine(): Promise<EngineModule> {
  if (!engine) {
    const threads = referenceThreadCount(navigator.hardwareConcurrency, /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent), self.crossOriginIsolated, typeof SharedArrayBuffer !== "undefined");
    const directory = threads > 1 ? "wasm-threaded" : "wasm";
    const enginePath = `/${directory}/${__APP_VERSION__}`;
    const modulePath = new URL(`${enginePath}/spektrafilm_web.js`, self.location.origin).href;
    const loaded = (await import(/* @vite-ignore */ modulePath)) as EngineModule;
    await loaded.default(new URL(`${enginePath}/spektrafilm_web_bg.wasm`, self.location.origin));
    if (threads > 1) await loaded.initThreadPool!(threads);
    if (loaded.version() !== __APP_VERSION__) {
      throw new Error(`Web ${__APP_VERSION__} loaded Rust engine ${loaded.version()}`);
    }
    engine = loaded;
  }
  return engine;
}

let jobs = Promise.resolve();

self.onmessage = ({ data }: MessageEvent<EngineRequest>) => {
  jobs = jobs.then(() => handle(data));
};

async function handle(data: EngineRequest) {
  try {
    const api = await loadEngine();
    let value: unknown;
    if (data.type === "init") {
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
      value = {
          version: __APP_VERSION__,
          gpu,
          limits: JSON.parse(api.portable_limits_json()),
          settings: JSON.parse(api.default_settings_json()),
          referenceThreads: referenceThreadCount(navigator.hardwareConcurrency, /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent), self.crossOriginIsolated, typeof SharedArrayBuffer !== "undefined"),
      };
    } else if (data.type === "inspect") {
      value = JSON.parse(api.inspect_image(new Uint8Array(data.bytes), data.limits));
    } else if (data.type === "preview") {
      value = api.raw_preview(new Uint8Array(data.bytes), 2400, data.developSensorData, data.rawWhiteBalance !== "uncorrected", data.rawDemosaic);
    } else if (data.type === "configure") {
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
      value = "configured";
    } else {
      if (!processor) throw new Error("Engine is not initialized");
      value = data.mode === "fast"
        ? await processor.process_fast_rotated(new Uint8Array(data.bytes), data.format, data.quality, data.scale, data.preserveMetadata !== false, data.rotation ?? 0)
        : processor.process_reference_rotated(new Uint8Array(data.bytes), data.format, data.quality, data.scale, data.rotation ?? 0);
    }
    const transfer = value instanceof Uint8Array ? [value.buffer] : [];
    self.postMessage({ id: data.id, ok: true, value }, transfer);
  } catch (error) {
    self.postMessage({
      id: data.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
