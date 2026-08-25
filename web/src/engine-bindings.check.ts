/**
 * Compile-time proof that wasm-pack's generated bindings satisfy `EngineModule`.
 *
 * `web/public/wasm` is a build artefact, so this file is deliberately outside the
 * default `tsconfig.json`. `npm run typecheck:bindings` checks it after
 * `build:wasm` has run; CI does that in the job that already builds the crate.
 * Everyday `npm run typecheck` stays fast and needs no Rust toolchain.
 */
import type * as Generated from "../public/wasm/spektrafilm_web";
import type { EngineModule } from "./engine-contract";

type Assert<T extends true> = T;

/** Keys of `T` that are not optional — `initThreadPool` exists only in the threaded build. */
type RequiredKeys<T> = { [K in keyof T]-?: Record<string, never> extends Pick<T, K> ? never : K }[keyof T];

/** Names `EngineModule` requires that the generated module does not provide. */
type MissingExports = Exclude<RequiredKeys<EngineModule>, keyof typeof Generated>;

export type AssertNoMissingExports = Assert<
  [MissingExports] extends [never] ? true : { missingFromGeneratedBindings: MissingExports }
>;

export type AssertGeneratedSatisfiesContract = Assert<
  typeof Generated extends EngineModule ? true : { generatedBindingsNoLongerSatisfy: EngineModule }
>;
