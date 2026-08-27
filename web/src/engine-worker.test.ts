import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineHandle, EngineModule } from "./engine-contract";

type Delivered = { data: unknown };
type Posted = { id: number; ok: boolean; error?: string; value?: unknown };

const LIMITS = { memoryBudgetBytes: 1, maxStorageBindingBytes: 2, maxWorkgroupInvocations: 3 };
const DEFAULT_SETTINGS = { camera: { exposure_compensation_ev: 0 } };
const CONFIG = { film: "kodak_portra_400", print: "kodak_portra_endura", settings: "{}", rawWhiteBalance: "camera", rawDemosaic: "ppg" };

/** A desktop, cross-origin-isolated environment resolves to more than one reference thread. */
const THREADED = { hardwareConcurrency: 8, userAgent: "Mozilla/5.0 (X11; Linux x86_64)", isolated: true };
const SINGLE_THREADED = { ...THREADED, isolated: false };

function fakeHandle(overrides: Partial<EngineHandle> = {}) {
  return {
    update_settings: vi.fn(),
    set_raw_development: vi.fn(),
    enable_gpu: vi.fn(async () => "webgpu"),
    process_reference: vi.fn(() => new Uint8Array([1])),
    process_reference_rotated: vi.fn(() => new Uint8Array([1])),
    process_fast: vi.fn(async () => new Uint8Array([2])),
    process_fast_rotated: vi.fn(async () => new Uint8Array([2])),
    free: vi.fn(),
    ...overrides,
  } as EngineHandle & { free: ReturnType<typeof vi.fn> };
}

function fakeModule(handle: EngineHandle, overrides: Partial<EngineModule> = {}) {
  const construct = vi.fn(() => handle);
  return {
    module: {
      default: vi.fn(async () => undefined),
      initThreadPool: vi.fn(async () => undefined),
      BrowserEngine: construct as unknown as EngineModule["BrowserEngine"],
      version: () => "test",
      initialize_webgpu: async () => "webgpu",
      default_settings_json: () => JSON.stringify(DEFAULT_SETTINGS),
      portable_limits_json: () => JSON.stringify(LIMITS),
      inspect_image: vi.fn(() => JSON.stringify({ width: 4, height: 4 })),
      raw_preview: vi.fn(() => new Uint8Array([3])),
      encode_rgb8: vi.fn(() => new Uint8Array([4])),
      calibrate_pipeline: vi.fn(() => "{}"),
      ...overrides,
    } as unknown as EngineModule,
    construct,
  };
}

type WorkerHarness = {
  deliver(data: unknown): void;
  settle(): Promise<unknown>;
  request(data: unknown): Promise<Posted>;
  posted: Posted[];
  load: ReturnType<typeof vi.fn>;
  fetched: string[];
};

/**
 * Imports the worker against stub globals. The engine module URL is only built at runtime,
 * so the import is intercepted through `engineLoader`.
 */
async function loadWorker(options: {
  module?: EngineModule;
  environment?: { hardwareConcurrency: number; userAgent: string; isolated: boolean };
  missingAsset?: string;
  postMessage?: (response: Posted) => void;
} = {}): Promise<WorkerHarness> {
  const environment = options.environment ?? THREADED;
  const posted: Posted[] = [];
  const fetched: string[] = [];
  let listener: ((event: Delivered) => void) | undefined;

  vi.stubGlobal("self", {
    set onmessage(value: (event: Delivered) => void) {
      listener = value;
    },
    postMessage: options.postMessage ?? ((response: Posted) => posted.push(response)),
    crossOriginIsolated: environment.isolated,
    location: { origin: "http://localhost" },
  });
  vi.stubGlobal("navigator", {
    hardwareConcurrency: environment.hardwareConcurrency,
    userAgent: environment.userAgent,
  });
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    fetched.push(path);
    if (path === options.missingAsset) return { ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
  }));

  vi.resetModules();
  const worker = await import("./engine-worker");
  const load = vi.fn(async () => options.module ?? fakeModule(fakeHandle()).module);
  worker.engineLoader.load = load as unknown as typeof worker.engineLoader.load;

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    deliver: (data: unknown) => listener!({ data }),
    settle,
    posted,
    load,
    fetched,
    async request(data: unknown) {
      listener!({ data });
      await settle();
      return posted[posted.length - 1];
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("engine worker request chain", () => {
  it("answers a request it cannot handle", async () => {
    const worker = await loadWorker();
    expect(await worker.request({ id: 1, type: "bogus" })).toEqual({ id: 1, ok: false, error: expect.stringContaining("bogus") });
  });

  // A throwing postMessage used to reject `respond`, which left the `jobs` promise rejected
  // so every later request's callback was skipped: the worker went silent and the main
  // thread's pending promise never settled.
  it("keeps serving requests after a postMessage failure", async () => {
    const posted: Posted[] = [];
    let calls = 0;
    const worker = await loadWorker({
      postMessage: (response) => {
        calls += 1;
        if (calls === 1) throw new DOMException("could not be cloned", "DataCloneError");
        posted.push(response);
      },
    });

    worker.deliver({ id: 1, type: "bogus" });
    await worker.settle();
    worker.deliver({ id: 2, type: "bogus" });
    await worker.settle();

    expect(posted.map((response) => response.id)).toContain(2);
  });

  it("still answers the caller when the first send of a response fails", async () => {
    const posted: Posted[] = [];
    let calls = 0;
    const worker = await loadWorker({
      postMessage: (response) => {
        calls += 1;
        if (calls === 1) throw new DOMException("could not be cloned", "DataCloneError");
        posted.push(response);
      },
    });

    worker.deliver({ id: 7, type: "bogus" });
    await worker.settle();

    expect(posted).toEqual([{ id: 7, ok: false, error: expect.stringContaining("cloned") }]);
  });

  // The fallback send absorbs a single failure, so only a request whose response cannot be
  // sent at all makes `respond` reject. That is the case the `jobs` chain guard exists for:
  // without it the rejected chain skips every later callback and the worker goes silent.
  it("keeps serving requests when a response cannot be sent at all", async () => {
    const posted: Posted[] = [];
    let calls = 0;
    const worker = await loadWorker({
      postMessage: (response) => {
        calls += 1;
        // Both the response and its fallback fail, for the first request only.
        if (calls <= 2) throw new DOMException("could not be cloned", "DataCloneError");
        posted.push(response);
      },
    });

    worker.deliver({ id: 1, type: "bogus" });
    await worker.settle();
    worker.deliver({ id: 2, type: "bogus" });
    await worker.settle();

    expect(posted.map((response) => response.id)).toEqual([2]);
  });

  it("transfers an owned buffer alongside the response", async () => {
    const transfers: unknown[][] = [];
    const posted: Posted[] = [];
    const { module } = fakeModule(fakeHandle());
    let listener: ((event: Delivered) => void) | undefined;
    vi.stubGlobal("self", {
      set onmessage(value: (event: Delivered) => void) {
        listener = value;
      },
      postMessage: (response: Posted, transfer: unknown[]) => {
        posted.push(response);
        transfers.push(transfer);
      },
      crossOriginIsolated: true,
      location: { origin: "http://localhost" },
    });
    vi.stubGlobal("navigator", { hardwareConcurrency: 8, userAgent: "desktop" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })));
    vi.resetModules();
    const worker = await import("./engine-worker");
    worker.engineLoader.load = (async () => module) as unknown as typeof worker.engineLoader.load;

    listener!({ data: { id: 1, type: "init" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    listener!({ data: { id: 2, type: "preview", bytes: new ArrayBuffer(4), maximumDimension: 1200, developSensorData: true, rawWhiteBalance: "camera", rawDemosaic: "linear" } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(posted[1].ok).toBe(true);
    expect(transfers[1]).toHaveLength(1);
  });
});

describe("engine loading", () => {
  it("initializes a threaded build and reports its thread count", async () => {
    const { module } = fakeModule(fakeHandle());
    const worker = await loadWorker({ module });
    const response = await worker.request({ id: 1, type: "init" });

    expect(response).toEqual({ id: 1, ok: true, value: { version: "test", gpu: "webgpu", limits: LIMITS, settings: DEFAULT_SETTINGS, referenceThreads: 4 } });
    expect(worker.load).toHaveBeenCalledWith(expect.stringContaining("/wasm-threaded/"));
    expect(module.initThreadPool).toHaveBeenCalledWith(4);
  });

  it("uses the single-threaded build when the page is not cross-origin isolated", async () => {
    const { module } = fakeModule(fakeHandle());
    const worker = await loadWorker({ module, environment: SINGLE_THREADED });
    const response = await worker.request({ id: 1, type: "init" });

    expect((response.value as { referenceThreads: number }).referenceThreads).toBe(1);
    expect(worker.load).toHaveBeenCalledWith(expect.stringContaining("/wasm/"));
    expect(module.initThreadPool).not.toHaveBeenCalled();
  });

  it("fails when a threaded build cannot start its pool", async () => {
    const { module } = fakeModule(fakeHandle(), { initThreadPool: undefined });
    const worker = await loadWorker({ module });
    const response = await worker.request({ id: 1, type: "init" });

    expect(response.ok).toBe(false);
    expect(response.error).toContain("cannot start 4 threads");
  });

  it("loads the engine module once across requests", async () => {
    const worker = await loadWorker();
    await worker.request({ id: 1, type: "init" });
    await worker.request({ id: 2, type: "init" });
    expect(worker.load).toHaveBeenCalledTimes(1);
  });

  it("reports an asset that will not load", async () => {
    const worker = await loadWorker({ missingAsset: "/data/luts/spectral_upsampling/irradiance_xy_tc.npy" });
    const response = await worker.request({ id: 1, type: "init" });

    expect(response.ok).toBe(false);
    expect(response.error).toContain("Could not load /data/luts/spectral_upsampling/irradiance_xy_tc.npy");
  });
});

describe("configure", () => {
  it("refuses to configure before the engine assets exist", async () => {
    const worker = await loadWorker();
    const response = await worker.request({ id: 1, type: "configure", film: "a", print: "b", settings: "{}", rawWhiteBalance: "camera", rawDemosaic: "linear" });

    expect(response.ok).toBe(false);
    expect(response.error).toContain("Engine assets are not initialized");
  });

  it("updates the live engine in place when the stocks are unchanged", async () => {
    const handle = fakeHandle();
    const { module, construct } = fakeModule(handle);
    const worker = await loadWorker({ module });
    await worker.request({ id: 1, type: "init" });

    const response = await worker.request({ id: 2, type: "configure", film: "kodak_portra_400", print: "kodak_portra_endura", settings: "{\"a\":1}", rawWhiteBalance: "camera", rawDemosaic: "linear" });

    expect(response).toEqual({ id: 2, ok: true, value: "configured" });
    expect(handle.update_settings).toHaveBeenCalledWith("{\"a\":1}");
    expect(handle.set_raw_development).toHaveBeenCalledWith("camera", "linear");
    expect(construct).toHaveBeenCalledTimes(1);
  });

  it("rebuilds and swaps the engine when a stock changes", async () => {
    const first = fakeHandle();
    const { module, construct } = fakeModule(first);
    const worker = await loadWorker({ module });
    await worker.request({ id: 1, type: "init" });

    const response = await worker.request({ id: 2, type: "configure", film: "fuji_400h", print: "kodak_portra_endura", settings: "{}", rawWhiteBalance: "camera", rawDemosaic: "linear" });

    expect(response.ok).toBe(true);
    expect(construct).toHaveBeenCalledTimes(2);
    expect(worker.fetched).toContain("/data/profiles/fuji_400h.json");
    // The retired engine is released once the replacement reports ready.
    expect(first.free).toHaveBeenCalled();
  });

  it("keeps the previous engine when the replacement cannot start", async () => {
    const first = fakeHandle();
    const broken = fakeHandle({ enable_gpu: vi.fn(async () => { throw new Error("no adapter"); }) });
    let built = 0;
    const { module } = fakeModule(first, {
      BrowserEngine: vi.fn(() => {
        built += 1;
        return built === 1 ? first : broken;
      }) as unknown as EngineModule["BrowserEngine"],
    });
    const worker = await loadWorker({ module });
    await worker.request({ id: 1, type: "init" });

    const response = await worker.request({ id: 2, type: "configure", film: "fuji_400h", print: "kodak_portra_endura", settings: "{}", rawWhiteBalance: "camera", rawDemosaic: "linear" });

    expect(response.ok).toBe(false);
    expect(response.error).toContain("no adapter");
    expect((broken as unknown as { free: ReturnType<typeof vi.fn> }).free).toHaveBeenCalled();
    expect(first.free).not.toHaveBeenCalled();
  });
});

describe("image requests", () => {
  it("inspects an image without initializing the engine", async () => {
    const { module } = fakeModule(fakeHandle());
    const worker = await loadWorker({ module });
    const response = await worker.request({ id: 1, type: "inspect", bytes: new ArrayBuffer(4), limits: JSON.stringify(LIMITS) });

    expect(response).toEqual({ id: 1, ok: true, value: { width: 4, height: 4 } });
    expect(module.inspect_image).toHaveBeenCalled();
  });

  it("refuses to process before the engine is initialized", async () => {
    const worker = await loadWorker();
    const response = await worker.request({ id: 1, type: "process", ...CONFIG, bytes: new ArrayBuffer(4), format: "jpeg", quality: 90, scale: 1, mode: "fast" });

    expect(response.ok).toBe(false);
    expect(response.error).toContain("Engine is not initialized");
  });

  it("routes a fast export through the rotated fast path", async () => {
    const handle = fakeHandle();
    const { module } = fakeModule(handle);
    const worker = await loadWorker({ module });
    await worker.request({ id: 1, type: "init" });

    const response = await worker.request({ id: 2, type: "process", ...CONFIG, bytes: new ArrayBuffer(4), format: "jpeg", quality: 90, scale: 0.5, mode: "fast", rotation: 90, preserveMetadata: false });

    expect(response.ok).toBe(true);
    expect(handle.process_fast_rotated).toHaveBeenCalledWith(expect.any(Uint8Array), "jpeg", 90, 0.5, false, 90);
  });

  it("configures the requested film atomically with an export", async () => {
    const first = fakeHandle();
    const replacement = fakeHandle();
    let built = 0;
    const { module } = fakeModule(first, {
      BrowserEngine: vi.fn(() => built++ === 0 ? first : replacement) as unknown as EngineModule["BrowserEngine"],
    });
    const worker = await loadWorker({ module });
    await worker.request({ id: 1, type: "init" });

    const response = await worker.request({
      id: 2,
      type: "process",
      bytes: new ArrayBuffer(4),
      format: "jpeg",
      quality: 90,
      scale: 1,
      mode: "reference",
      film: "kodak_trix",
      print: "kodak_2302",
      settings: "{\"film_render\":{}}",
      rawWhiteBalance: "camera",
      rawDemosaic: "ppg",
    });

    expect(response.ok).toBe(true);
    expect(worker.fetched).toContain("/data/profiles/kodak_trix.json");
    expect(replacement.process_reference_rotated).toHaveBeenCalled();
    expect(first.process_reference_rotated).not.toHaveBeenCalled();
  });

  it("defaults rotation and metadata preservation on a reference export", async () => {
    const handle = fakeHandle();
    const { module } = fakeModule(handle);
    const worker = await loadWorker({ module });
    await worker.request({ id: 1, type: "init" });

    const response = await worker.request({ id: 2, type: "process", ...CONFIG, bytes: new ArrayBuffer(4), format: "png", quality: 100, scale: 1, mode: "reference" });

    expect(response.ok).toBe(true);
    expect(handle.process_reference_rotated).toHaveBeenCalledWith(expect.any(Uint8Array), "png", 100, 1, 0);
  });
});
