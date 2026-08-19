/**
 * The single source of truth for the shape of `RuntimeParams`, the settings tree that
 * crosses the WebAssembly boundary as opaque JSON (`default_settings_json` -> UI ->
 * `update_settings`). `settings-contract.test.ts` parses `crates/spektrafilm-core/src/params.rs`
 * and fails the build when a Rust field is renamed, retyped, added or removed without a
 * matching update here.
 *
 * `serializeSettings` then uses this map to validate a settings tree *before* it reaches
 * the WASM boundary: an unknown key (a typo'd or renamed control) and a value of the wrong
 * shape (a non-finite number, a fractional or negative value for a Rust `u32`/`u64` field)
 * are both silently tolerated by serde's `#[serde(default)]` fields or turn into a hard
 * runtime error that leaves the engine on stale settings. Both are caught here instead,
 * with an error that names the offending path.
 */

/** The Rust scalar types every leaf of `RuntimeParams` bottoms out at. */
export type ScalarKind = "bool" | "string" | "f32" | "f64" | "u32" | "u64";

/** A Rust fixed-size array field, e.g. `[f32; 3]`. */
export type ArrayKind = { array: ScalarKind; length: number };

/** A Rust `Option<T>` field, where `T` is a scalar or fixed-size array. */
export type OptionKind = { option: ScalarKind | ArrayKind };

export type FieldKind = ScalarKind | ArrayKind | OptionKind;

/** Every settings path (dot-joined, matching JSON nesting) mapped to its Rust type. */
export type SettingsContract = Record<string, FieldKind>;

/**
 * Map of every `RuntimeParams` field path to its Rust type kind, verified against
 * `crates/spektrafilm-core/src/params.rs` by `settings-contract.test.ts`.
 */
export const SETTINGS_CONTRACT: SettingsContract = {
  "adjustments.blacks": "f32",
  "adjustments.clarity": "f32",
  "adjustments.contrast": "f32",
  "adjustments.dehaze": "f32",
  "adjustments.highlights": "f32",
  "adjustments.saturation": "f32",
  "adjustments.shadows": "f32",
  "adjustments.temperature": "f32",
  "adjustments.tint": "f32",
  "adjustments.vibrance": "f32",
  "adjustments.whites": "f32",
  "camera.auto_exposure": "bool",
  "camera.auto_exposure_method": "string",
  "camera.diffusion_filter.active": "bool",
  "camera.diffusion_filter.bloom_intensity": "f32",
  "camera.diffusion_filter.bloom_size": "f32",
  "camera.diffusion_filter.core_intensity": "f32",
  "camera.diffusion_filter.core_size": "f32",
  "camera.diffusion_filter.filter_family": "string",
  "camera.diffusion_filter.halo_intensity": "f32",
  "camera.diffusion_filter.halo_size": "f32",
  "camera.diffusion_filter.halo_warmth": "f32",
  "camera.diffusion_filter.spatial_scale": "f32",
  "camera.diffusion_filter.strength": "f32",
  "camera.exposure_compensation_ev": "f32",
  "camera.film_format_mm": "f32",
  "camera.filter_ir": { array: "f32", length: 3 },
  "camera.filter_uv": { array: "f32", length: 3 },
  "camera.lens_blur_um": "f32",
  "composition.aspect": "string",
  "composition.border": "f32",
  "composition.crop_scale": "f32",
  "composition.crop_x": "f32",
  "composition.crop_y": "f32",
  "composition.straighten_degrees": "f32",
  "composition.vignette_amount": "f32",
  "composition.vignette_feather": "f32",
  "composition.vignette_highlights": "f32",
  "composition.vignette_midpoint": "f32",
  "composition.vignette_roundness": "f32",
  "enlarger.c_filter_neutral": "f32",
  "enlarger.diffusion_filter.active": "bool",
  "enlarger.diffusion_filter.bloom_intensity": "f32",
  "enlarger.diffusion_filter.bloom_size": "f32",
  "enlarger.diffusion_filter.core_intensity": "f32",
  "enlarger.diffusion_filter.core_size": "f32",
  "enlarger.diffusion_filter.filter_family": "string",
  "enlarger.diffusion_filter.halo_intensity": "f32",
  "enlarger.diffusion_filter.halo_size": "f32",
  "enlarger.diffusion_filter.halo_warmth": "f32",
  "enlarger.diffusion_filter.spatial_scale": "f32",
  "enlarger.diffusion_filter.strength": "f32",
  "enlarger.illuminant": "string",
  "enlarger.lens_blur": "f32",
  "enlarger.m_filter_neutral": "f32",
  "enlarger.m_filter_shift": "f32",
  "enlarger.normalize_print_exposure": "bool",
  "enlarger.preflash_exposure": "f32",
  "enlarger.preflash_m_filter_shift": "f32",
  "enlarger.preflash_y_filter_shift": "f32",
  "enlarger.print_exposure": "f32",
  "enlarger.print_exposure_compensation": "bool",
  "enlarger.y_filter_neutral": "f32",
  "enlarger.y_filter_shift": "f32",
  "film_render.density_curve_gamma": "f32",
  "film_render.development_time": { option: "f64" },
  "film_render.dir_couplers.active": "bool",
  "film_render.dir_couplers.amount": "f64",
  "film_render.dir_couplers.diffusion_size_um": "f64",
  "film_render.dir_couplers.diffusion_tail_um": "f64",
  "film_render.dir_couplers.diffusion_tail_weight": "f64",
  "film_render.dir_couplers.gamma_interlayer_b_to_rg": { array: "f64", length: 2 },
  "film_render.dir_couplers.gamma_interlayer_g_to_rb": { array: "f64", length: 2 },
  "film_render.dir_couplers.gamma_interlayer_r_to_gb": { array: "f64", length: 2 },
  "film_render.dir_couplers.gamma_samelayer_rgb": { array: "f64", length: 3 },
  "film_render.dir_couplers.inhibition_interlayer": "f64",
  "film_render.dir_couplers.inhibition_samelayer": "f64",
  "film_render.glare.active": "bool",
  "film_render.glare.blur": "f32",
  "film_render.glare.percent": "f32",
  "film_render.glare.roughness": "f32",
  "film_render.glare.seed": "u64",
  "film_render.grain.active": "bool",
  "film_render.grain.agx_particle_area_um2": "f64",
  "film_render.grain.agx_particle_scale": { array: "f64", length: 3 },
  "film_render.grain.agx_particle_scale_layers": { array: "f64", length: 3 },
  "film_render.grain.blur": "f32",
  "film_render.grain.blur_dye_clouds_um": "f32",
  "film_render.grain.density_min": { array: "f64", length: 3 },
  "film_render.grain.micro_structure": { array: "f32", length: 2 },
  "film_render.grain.monochrome": "bool",
  "film_render.grain.n_sub_layers": "u32",
  "film_render.grain.seed": "u64",
  "film_render.grain.sublayers_active": "bool",
  "film_render.grain.uniformity": { array: "f64", length: 3 },
  "film_render.halation.active": "bool",
  "film_render.halation.boost_ev": "f32",
  "film_render.halation.boost_range": "f32",
  "film_render.halation.halation_amount": "f64",
  "film_render.halation.halation_bounce_decay": "f64",
  "film_render.halation.halation_first_sigma_um": { array: "f64", length: 3 },
  "film_render.halation.halation_n_bounces": "u32",
  "film_render.halation.halation_renormalize": "bool",
  "film_render.halation.halation_spatial_scale": "f64",
  "film_render.halation.halation_strength": { array: "f64", length: 3 },
  "film_render.halation.protect_ev": "f32",
  "film_render.halation.scatter_amount": "f64",
  "film_render.halation.scatter_core_um": { array: "f64", length: 3 },
  "film_render.halation.scatter_spatial_scale": "f64",
  "film_render.halation.scatter_tail_um": { array: "f64", length: 3 },
  "film_render.halation.scatter_tail_weight": { array: "f64", length: 3 },
  "io.crop": "bool",
  "io.crop_center": { array: "f32", length: 2 },
  "io.crop_size": { array: "f32", length: 2 },
  "io.input_cctf_decoding": "bool",
  "io.input_color_space": "string",
  "io.input_gamut_compress.algorithm": "string",
  "io.input_gamut_compress.knee": { array: "f32", length: 3 },
  "io.output_cctf_encoding": "bool",
  "io.output_color_space": "string",
  "io.output_gamut_compress.algorithm": "string",
  "io.output_gamut_compress.knee": { array: "f32", length: 3 },
  "io.output_gamut_compress.lightness_compression": { option: { array: "f32", length: 3 } },
  "io.scan_film": "bool",
  "io.upscale_factor": "f32",
  "print_render.density_curve_gamma": "f32",
  "print_render.density_curves_morph.active": "bool",
  "print_render.density_curves_morph.developer_exhaustion": "f64",
  "print_render.density_curves_morph.gamma_factor": "f64",
  "print_render.density_curves_morph.gamma_factor_blue": "f64",
  "print_render.density_curves_morph.gamma_factor_fast": "f64",
  "print_render.density_curves_morph.gamma_factor_green": "f64",
  "print_render.density_curves_morph.gamma_factor_red": "f64",
  "print_render.density_curves_morph.gamma_factor_slow": "f64",
  "print_render.development_time": { option: "f64" },
  "print_render.glare.active": "bool",
  "print_render.glare.blur": "f32",
  "print_render.glare.percent": "f32",
  "print_render.glare.roughness": "f32",
  "print_render.glare.seed": "u64",
  "scanner.black_correction": "bool",
  "scanner.black_level": "f32",
  "scanner.lens_blur": "f32",
  "scanner.unsharp_mask": { array: "f32", length: 2 },
  "scanner.white_correction": "bool",
  "scanner.white_level": "f32",
  "settings.apply_hanatos2025_adaptation_surface": "bool",
  "settings.apply_hanatos2025_adaptation_window": "bool",
  "settings.lut_resolution": "u32",
  "settings.neutral_print_filters_from_database": "bool",
  "settings.preview_max_size": "u32",
  "settings.preview_mode": "bool",
  "settings.rgb_to_raw_method": "string",
  "settings.spectral_gaussian_blur": "f32",
  "settings.use_cat16": "bool",
  "settings.use_enlarger_lut": "bool",
  "settings.use_fast_stats": "bool",
  "settings.use_scanner_lut": "bool",
};

/** A node of `SETTINGS_CONTRACT` folded back into the nested shape the JSON settings tree has. */
type ContractTree = FieldKind | { [key: string]: ContractTree };

function isFieldKind(node: ContractTree): node is FieldKind {
  if (typeof node === "string") return true;
  return "array" in node || "option" in node;
}

function buildContractTree(contract: SettingsContract): ContractTree {
  const root: { [key: string]: ContractTree } = {};
  for (const [path, kind] of Object.entries(contract)) {
    const parts = path.split(".");
    let node = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index];
      const existing = node[part];
      if (existing === undefined) {
        const next: { [key: string]: ContractTree } = {};
        node[part] = next;
        node = next;
      } else {
        node = existing as { [key: string]: ContractTree };
      }
    }
    node[parts[parts.length - 1]] = kind;
  }
  return root;
}

const CONTRACT_TREE: ContractTree = buildContractTree(SETTINGS_CONTRACT);

/** Thrown by `serializeSettings` for an unknown key or a value that does not fit its Rust type. */
export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsValidationError";
  }
}

function validateScalar(value: unknown, kind: ScalarKind, path: string): unknown {
  if (kind === "bool") {
    if (typeof value !== "boolean") throw new SettingsValidationError(`expected a boolean at "${path}", got ${JSON.stringify(value)}`);
    return value;
  }
  if (kind === "string") {
    if (typeof value !== "string") throw new SettingsValidationError(`expected a string at "${path}", got ${JSON.stringify(value)}`);
    return value;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SettingsValidationError(`expected a finite number at "${path}", got ${JSON.stringify(value)}`);
  }
  if ((kind === "u32" || kind === "u64") && (!Number.isInteger(value) || value < 0)) {
    throw new SettingsValidationError(`expected a non-negative integer at "${path}", got ${value}`);
  }
  return value;
}

function validateField(value: unknown, kind: FieldKind, path: string): unknown {
  if (typeof kind === "object" && "option" in kind) {
    if (value === null || value === undefined) return null;
    return validateField(value, kind.option, path);
  }
  if (typeof kind === "object" && "array" in kind) {
    if (!Array.isArray(value) || value.length !== kind.length) {
      throw new SettingsValidationError(`expected an array of ${kind.length} at "${path}", got ${JSON.stringify(value)}`);
    }
    return value.map((item, index) => validateField(item, kind.array, `${path}[${index}]`));
  }
  return validateScalar(value, kind, path);
}

function validateNode(value: unknown, node: ContractTree, path: string): unknown {
  if (isFieldKind(node)) return validateField(value, node, path);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SettingsValidationError(`expected an object at "${path}", got ${JSON.stringify(value)}`);
  }
  const object = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(object)) {
    // hasOwnProperty, not plain indexing: a bare `node[key]` resolves inherited
    // Object.prototype names, so a recipe carrying "constructor" would be walked as a
    // subtree and cross the boundary unvalidated.
    const child = Object.prototype.hasOwnProperty.call(node, key)
      ? (node as { [key: string]: ContractTree })[key]
      : undefined;
    const childPath = path ? `${path}.${key}` : key;
    if (child === undefined) throw new SettingsValidationError(`unknown settings key "${childPath}"`);
    result[key] = validateNode(object[key], child, childPath);
  }
  return result;
}

/**
 * Validates a settings tree against {@link SETTINGS_CONTRACT} and returns it as JSON, so an
 * unknown key or a value the Rust side cannot deserialize (or would silently misinterpret,
 * like a fractional `u32`) fails loudly here instead of at the WASM boundary.
 */
export function serializeSettings(settings: Record<string, unknown>): string {
  return JSON.stringify(validateNode(settings, CONTRACT_TREE, ""));
}
