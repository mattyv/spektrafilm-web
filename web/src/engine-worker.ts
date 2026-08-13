/// <reference lib="webworker" />

import { replaceAfterReady } from "./engine-transaction";
import { referenceThreadCount } from "./runtime";

type EngineModule = {
  default: (moduleOrPath?: string | URL) => Promise<unknown>;
  initThreadPool?: (threads: number) => Promise<void>;
  BrowserEngine: new (
    film: Uint8Array,
    print: Uint8Array,
    filters: Uint8Array,
    lut: Uint8Array,
    settings?: string,
  ) => {
    enable_gpu(): Promise<string>;
    update_settings(settings: string): void;
    set_raw_development(whiteBalance: string, demosaic: string): void;
    process_reference(input: Uint8Array, format: string, quality: number, scale: number): Uint8Array;
    process_reference_rotated(input: Uint8Array, format: string, quality: number, scale: number, rotation: number): Uint8Array;
    process_fast(input: Uint8Array, format: string, quality: number, scale: number, preserveMetadata: boolean): Promise<Uint8Array>;
    process_fast_rotated(input: Uint8Array, format: string, quality: number, scale: number, preserveMetadata: boolean, rotation: number): Promise<Uint8Array>;
    free?: () => void;
  };
  default_settings_json: () => string;
  inspect_image: (bytes: Uint8Array, limits?: string) => string;
  raw_preview: (bytes: Uint8Array, maximumSize: number, developSensorData: boolean, cameraWhiteBalance: boolean, demosaic: string) => Uint8Array;
  initialize_webgpu: () => Promise<string>;
  portable_limits_json: () => string;
  version: () => string;
};

type EngineRequest =
  | { id: number; type: "init" }
  | { id: number; type: "inspect"; bytes: ArrayBuffer; limits?: string }
  | { id: number; type: "preview"; bytes: ArrayBuffer; developSensorData: boolean; rawWhiteBalance: string; rawDemosaic: string }
  | { id: number; type: "configure"; film: string; print: string; settings: string; rawWhiteBalance: string; rawDemosaic: string }
  | { id: number; type: "process"; bytes: ArrayBuffer; format: string; quality: number; scale: number; mode: "reference" | "fast"; preserveMetadata?: boolean; rotation?: number };

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
