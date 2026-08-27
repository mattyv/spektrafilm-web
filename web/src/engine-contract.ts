/**
 * The single source of truth for everything that crosses the WebAssembly boundary.
 *
 * Three layers keep it honest, so a mismatch fails the build instead of the browser:
 *
 *  1. `ENGINE_CONTRACT` records every `#[wasm_bindgen]` export with its parameter
 *     count. `engine-contract.test.ts` parses `crates/spektrafilm-web/src/lib.rs`
 *     and fails when the two disagree — a Rust rename, a removed export or an
 *     added argument breaks CI.
 *  2. The `Assert*` aliases at the foot of this file make `tsc` prove that the
 *     hand-written signatures below cover exactly the names and arities recorded
 *     in `ENGINE_CONTRACT`. The two halves cannot drift apart silently.
 *  3. `EngineRequests`/`EngineResults` type the worker protocol as a discriminated
 *     union, so `askEngine` checks the request it is given and the value it
 *     returns. Nothing on this boundary is an `as` cast any more.
 *
 * Adding a Rust export is therefore a four-line change: the entry here, the
 * signature below, and the call site. Forgetting any of them stops the build.
 */

/** Names and parameter counts of the Rust exports, verified against `lib.rs` by the contract test. */
export const ENGINE_CONTRACT = {
  functions: {
    version: 0,
    initialize_webgpu: 0,
    default_settings_json: 0,
    portable_limits_json: 0,
    inspect_image: 2,
    raw_preview: 5,
    encode_rgb8: 5,
    calibrate_pipeline: 5,
  },
  engine: {
    new: 5,
    update_settings: 1,
    set_raw_development: 2,
    enable_gpu: 0,
    process_reference: 4,
    process_reference_rotated: 5,
    process_fast: 5,
    process_fast_rotated: 6,
  },
} as const;

/** Free functions exported by the crate. `Option<String>` arguments map to optional parameters. */
export type EngineFunctions = {
  version(): string;
  initialize_webgpu(): Promise<string>;
  default_settings_json(): string;
  portable_limits_json(): string;
  inspect_image(bytes: Uint8Array, limits?: string): string;
  raw_preview(
    bytes: Uint8Array,
    maximumSize: number,
    developSensorData: boolean,
    cameraWhiteBalance: boolean,
    demosaic: string,
  ): Uint8Array;
  encode_rgb8(width: number, height: number, pixels: Uint8Array, format: string, quality: number): Uint8Array;
  calibrate_pipeline(
    film: Uint8Array,
    print: Uint8Array,
    filters: Uint8Array,
    lut: Uint8Array,
    settings?: string,
  ): string;
};

/** Methods on a constructed `BrowserEngine`. `free` is wasm-bindgen glue, not a Rust export. */
export type EngineHandle = {
  update_settings(settings: string): void;
  set_raw_development(whiteBalance: string, demosaic: string): void;
  enable_gpu(): Promise<string>;
  process_reference(input: Uint8Array, format: string, quality: number, scale: number): Uint8Array;
  process_reference_rotated(
    input: Uint8Array,
    format: string,
    quality: number,
    scale: number,
    rotation: number,
  ): Uint8Array;
  process_fast(
    input: Uint8Array,
    format: string,
    quality: number,
    scale: number,
    preserveMetadata: boolean,
  ): Promise<Uint8Array>;
  process_fast_rotated(
    input: Uint8Array,
    format: string,
    quality: number,
    scale: number,
    preserveMetadata: boolean,
    rotation: number,
  ): Promise<Uint8Array>;
  free?(): void;
};

export type EngineConstructor = new (
  film: Uint8Array,
  print: Uint8Array,
  filters: Uint8Array,
  lut: Uint8Array,
  settings?: string,
) => EngineHandle;

/** The shape wasm-pack's generated module must satisfy for the worker to drive it. */
export type EngineModule = EngineFunctions & {
  default(moduleOrPath?: string | URL): Promise<unknown>;
  /** Present only in the `threads` build. */
  initThreadPool?(threads: number): Promise<void>;
  BrowserEngine: EngineConstructor;
};

export type Inspection = {
  width: number;
  height: number;
  megapixels: number;
  estimatedWorkingBytes: number;
  requiresResize: boolean;
  maximumSafeMegapixels: number;
};

export type PortableLimits = {
  memoryBudgetBytes: number;
  maxStorageBindingBytes: number;
  maxWorkgroupInvocations: number;
};

export type EngineConfiguration = {
  film: string;
  print: string;
  settings: string;
  rawWhiteBalance: string;
  rawDemosaic: string;
};

/** Payload each worker request carries, keyed by its discriminant. */
export type EngineRequests = {
  init: Record<never, never>;
  inspect: { bytes: ArrayBuffer; limits?: string };
  preview: { bytes: ArrayBuffer; maximumDimension: number; developSensorData: boolean; rawWhiteBalance: string; rawDemosaic: string };
  configure: EngineConfiguration;
  process: EngineConfiguration & {
    bytes: ArrayBuffer;
    format: string;
    quality: number;
    scale: number;
    mode: "reference" | "fast";
    preserveMetadata?: boolean;
    rotation?: number;
  };
};

/** Value each request resolves to. Paired with `EngineRequests` by key, so neither side can drift. */
export type EngineResults = {
  init: {
    version: string;
    gpu: string;
    limits: PortableLimits;
    settings: Record<string, unknown>;
    referenceThreads: number;
  };
  inspect: Inspection;
  /** Non-shared: wasm-bindgen copies the returned `Vec<u8>` out of wasm memory. */
  preview: Uint8Array<ArrayBuffer>;
  configure: "configured";
  process: Uint8Array<ArrayBuffer>;
};

export type EngineRequestType = keyof EngineRequests;

/** A request as it travels over `postMessage`. */
export type EngineRequest<K extends EngineRequestType = EngineRequestType> = K extends EngineRequestType
  ? { id: number; type: K } & EngineRequests[K]
  : never;

export type EngineResponse =
  | { id: number; ok: true; value: EngineResults[EngineRequestType] }
  | { id: number; ok: false; error: string };

/** The request types the worker knows how to handle, for an exhaustive runtime guard. */
export const ENGINE_REQUEST_TYPES = ["init", "inspect", "preview", "configure", "process"] as const;

/**
 * Narrows an incoming worker message to a known request type.
 *
 * The worker used to dispatch with an if/else chain whose final branch was
 * `process`, so a typo'd or renamed request was silently run as an image job.
 * Anything unrecognised now fails loudly, naming the offending type.
 */
export function engineRequestType(message: unknown): EngineRequestType {
  const type = (message as { type?: unknown } | null | undefined)?.type;
  if (typeof type === "string" && (ENGINE_REQUEST_TYPES as readonly string[]).includes(type)) {
    return type as EngineRequestType;
  }
  throw new Error(`Unknown engine request: ${JSON.stringify(type)}`);
}

// ---------------------------------------------------------------------------
// Compile-time proof that the signatures above match ENGINE_CONTRACT exactly.
// These aliases carry no runtime code; `tsc` rejects the file if any disagree.
// ---------------------------------------------------------------------------

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

/** Fails with a message naming the drift and printing both sides, instead of a bare `false`. */
type Expect<Description extends string, Declared, Recorded> = Equal<Declared, Recorded> extends true
  ? true
  : { contractDrift: Description; declared: Declared; recorded: Recorded };

/** Declared parameter count, counting optional parameters the way Rust counts `Option<T>`. */
type Arity<F> = F extends (...args: infer A) => unknown ? Required<A>["length"] : never;

/** Drops the `readonly` that `as const` adds, so recorded and declared shapes compare by identity. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

type RecordedFunctions = Mutable<typeof ENGINE_CONTRACT.functions>;
type RecordedEngine = Mutable<typeof ENGINE_CONTRACT.engine>;

/** `new` lives on the constructor and `free` is generated glue, so map handle keys onto Rust's view. */
type DeclaredEngineKeys = Exclude<keyof EngineHandle, "free"> | "new";

export type AssertFunctionNames = Assert<
  Expect<"free functions declared here vs ENGINE_CONTRACT.functions", keyof EngineFunctions, keyof RecordedFunctions>
>;
export type AssertFunctionArities = Assert<
  Expect<
    "free function parameter counts vs ENGINE_CONTRACT.functions",
    { [K in keyof EngineFunctions]: Arity<EngineFunctions[K]> },
    RecordedFunctions
  >
>;
export type AssertEngineNames = Assert<
  Expect<"BrowserEngine members declared here vs ENGINE_CONTRACT.engine", DeclaredEngineKeys, keyof RecordedEngine>
>;
export type AssertEngineArities = Assert<
  Expect<
    "BrowserEngine parameter counts vs ENGINE_CONTRACT.engine",
    {
      [K in DeclaredEngineKeys]: K extends "new"
        ? Required<ConstructorParameters<EngineConstructor>>["length"]
        : K extends Exclude<keyof EngineHandle, "free">
          ? Arity<Required<EngineHandle>[K]>
          : never;
    },
    RecordedEngine
  >
>;
export type AssertRequestTypes = Assert<
  Expect<"ENGINE_REQUEST_TYPES vs the EngineRequests keys", (typeof ENGINE_REQUEST_TYPES)[number], EngineRequestType>
>;
