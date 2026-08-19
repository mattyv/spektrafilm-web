import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SETTINGS_CONTRACT, serializeSettings, SettingsValidationError, type ScalarKind, type SettingsContract } from "./settings-contract";

const paramsSource = readFileSync(new URL("../../crates/spektrafilm-core/src/params.rs", import.meta.url), "utf8");
const webSource = readFileSync(new URL("../../crates/spektrafilm-web/src/lib.rs", import.meta.url), "utf8");

/** The text between the `{` that opens `pub struct Name {` and its matching `}`. */
function structBodies(source: string): Record<string, string> {
  const bodies: Record<string, string> = {};
  for (const match of source.matchAll(/pub struct (\w+)\s*\{/g)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let index = start;
    for (; index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    bodies[match[1]] = source.slice(start, index);
  }
  return bodies;
}

const SCALARS: ReadonlySet<string> = new Set<ScalarKind>(["bool", "string", "f32", "f64", "u32", "u64"]);

/** Maps a Rust type token onto the JS scalar kind it round-trips through JSON as. */
function scalarKind(rustType: string): ScalarKind | null {
  if (rustType === "String") return "string";
  if (SCALARS.has(rustType)) return rustType as ScalarKind;
  return null;
}

function parseArray(rustType: string): ArrayKindLocal | null {
  const match = /^\[(\w+);\s*(\d+)\]$/.exec(rustType);
  if (!match) return null;
  const inner = scalarKind(match[1]);
  if (!inner) throw new Error(`Unsupported array element type: ${match[1]}`);
  return { array: inner, length: Number(match[2]) };
}

type ArrayKindLocal = { array: ScalarKind; length: number };

function parseOption(rustType: string): { option: ScalarKind | ArrayKindLocal } | null {
  const match = /^Option<(.+)>$/.exec(rustType);
  if (!match) return null;
  const inner = match[1].trim();
  const array = parseArray(inner);
  if (array) return { option: array };
  const scalar = scalarKind(inner);
  if (scalar) return { option: scalar };
  throw new Error(`Unsupported Option inner type: ${inner}`);
}

/** Recursively walks `RuntimeParams` (and every struct it nests) into dot-joined field paths. */
function fieldPaths(structName: string, prefix: string, bodies: Record<string, string>): SettingsContract {
  const body = bodies[structName];
  if (body === undefined) throw new Error(`Unknown struct referenced from settings tree: ${structName}`);
  const out: SettingsContract = {};
  for (const match of body.matchAll(/pub (\w+):\s*([^,\n]+),/g)) {
    const field = match[1];
    const rustType = match[2].trim();
    const path = prefix ? `${prefix}.${field}` : field;

    const scalar = scalarKind(rustType);
    if (scalar) {
      out[path] = scalar;
      continue;
    }
    const array = parseArray(rustType);
    if (array) {
      out[path] = array;
      continue;
    }
    const option = parseOption(rustType);
    if (option) {
      out[path] = option;
      continue;
    }
    if (bodies[rustType] !== undefined) {
      Object.assign(out, fieldPaths(rustType, path, bodies));
      continue;
    }
    throw new Error(`Unrecognized Rust type for settings path "${path}": ${rustType}`);
  }
  return out;
}

function realSettingsContract(): SettingsContract {
  return fieldPaths("RuntimeParams", "", structBodies(paramsSource));
}

/** Dot-joined paths `browser_params` (crates/spektrafilm-web/src/lib.rs) forces to a fixed value. */
function browserOverridePaths(): string[] {
  const start = webSource.indexOf("fn browser_params(");
  expect(start).toBeGreaterThan(-1);
  const open = webSource.indexOf("{", start);
  let depth = 1;
  let index = open + 1;
  for (; index < webSource.length; index += 1) {
    if (webSource[index] === "{") depth += 1;
    else if (webSource[index] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = webSource.slice(open + 1, index);
  return [...body.matchAll(/params\.([\w.]+)\s*=/g)].map((match) => match[1]);
}

describe("settings contract", () => {
  it("names exactly the RuntimeParams field paths and Rust types the Rust crate serializes", () => {
    expect(SETTINGS_CONTRACT).toEqual(realSettingsContract());
  });

  it("keeps every browser_params override inside the settings contract", () => {
    const overrides = browserOverridePaths();
    expect(overrides.length).toBeGreaterThan(0);
    for (const path of overrides) {
      expect(Object.prototype.hasOwnProperty.call(SETTINGS_CONTRACT, path)).toBe(true);
    }
  });
});

/** A complete, valid `RuntimeParams` tree (Rust `Default::default()` values) for serializeSettings tests. */
function validSettings(): Record<string, unknown> {
  return structuredClone({
    camera: {
      exposure_compensation_ev: 0,
      auto_exposure: true,
      auto_exposure_method: "center_weighted",
      lens_blur_um: 0,
      film_format_mm: 35,
      filter_uv: [0, 410, 8],
      filter_ir: [0, 675, 15],
      diffusion_filter: {
        active: false,
        filter_family: "black_pro_mist",
        strength: 0.5,
        spatial_scale: 1,
        halo_warmth: 0,
        core_intensity: 1,
        core_size: 1,
        halo_intensity: 1,
        halo_size: 1,
        bloom_intensity: 1,
        bloom_size: 1,
      },
    },
    enlarger: {
      illuminant: "TH-KG3",
      print_exposure: 1,
      print_exposure_compensation: true,
      normalize_print_exposure: true,
      y_filter_shift: 0,
      m_filter_shift: 0,
      y_filter_neutral: 55,
      m_filter_neutral: 65,
      c_filter_neutral: 0,
      lens_blur: 0,
      diffusion_filter: {
        active: false,
        filter_family: "black_pro_mist",
        strength: 0.5,
        spatial_scale: 1,
        halo_warmth: 0,
        core_intensity: 1,
        core_size: 1,
        halo_intensity: 1,
        halo_size: 1,
        bloom_intensity: 1,
        bloom_size: 1,
      },
      preflash_exposure: 0,
      preflash_y_filter_shift: 0,
      preflash_m_filter_shift: 0,
    },
    scanner: {
      lens_blur: 0,
      white_correction: false,
      black_correction: false,
      white_level: 0.98,
      black_level: 0.01,
      unsharp_mask: [0.7, 0.7],
    },
    film_render: {
      density_curve_gamma: 1,
      development_time: null,
      grain: {
        active: true,
        sublayers_active: true,
        agx_particle_area_um2: 0.2,
        agx_particle_scale: [1.6, 1.6, 3.2],
        agx_particle_scale_layers: [2.0, 1.0, 0.5],
        density_min: [0.03, 0.03, 0.03],
        uniformity: [0.97, 0.99, 0.97],
        blur: 0.65,
        blur_dye_clouds_um: 1,
        micro_structure: [0.2, 30],
        n_sub_layers: 1,
        monochrome: false,
        seed: 0,
      },
      halation: {
        active: true,
        scatter_amount: 1,
        scatter_spatial_scale: 1,
        halation_amount: 1,
        halation_spatial_scale: 1,
        scatter_core_um: [2.2, 2.0, 1.6],
        scatter_tail_um: [9.3, 9.7, 9.1],
        scatter_tail_weight: [0.78, 0.65, 0.67],
        boost_ev: 0,
        boost_range: 0.3,
        protect_ev: 4,
        halation_strength: [0.05, 0.015, 0],
        halation_first_sigma_um: [65, 65, 65],
        halation_n_bounces: 3,
        halation_bounce_decay: 0.5,
        halation_renormalize: true,
      },
      dir_couplers: {
        active: true,
        amount: 1,
        inhibition_samelayer: 1,
        inhibition_interlayer: 1,
        gamma_samelayer_rgb: [0.341, 0.324, 0.273],
        gamma_interlayer_r_to_gb: [0.355, 0.305],
        gamma_interlayer_g_to_rb: [0.154, 0.358],
        gamma_interlayer_b_to_rg: [0.171, 0.225],
        diffusion_size_um: 20,
        diffusion_tail_um: 200,
        diffusion_tail_weight: 0.06,
      },
      glare: { active: true, percent: 0.03, roughness: 0.7, blur: 0.5, seed: 42 },
    },
    print_render: {
      density_curve_gamma: 1,
      development_time: null,
      glare: { active: true, percent: 0.03, roughness: 0.7, blur: 0.5, seed: 42 },
      density_curves_morph: {
        active: false,
        gamma_factor: 1,
        gamma_factor_fast: 1,
        gamma_factor_slow: 1,
        gamma_factor_red: 1,
        gamma_factor_green: 1,
        gamma_factor_blue: 1,
        developer_exhaustion: 0,
      },
    },
    io: {
      input_color_space: "ProPhoto RGB",
      input_cctf_decoding: false,
      output_color_space: "sRGB",
      output_cctf_encoding: true,
      crop: false,
      crop_center: [0.5, 0.5],
      crop_size: [0.1, 0.1],
      upscale_factor: 1,
      scan_film: false,
      output_gamut_compress: { algorithm: "cam16ucs", knee: [0, 1, 6], lightness_compression: [0.7, 1.0, 2.2] },
      input_gamut_compress: { algorithm: "xy", knee: [0, 1, 6] },
    },
    settings: {
      rgb_to_raw_method: "hanatos2025",
      apply_hanatos2025_adaptation_window: true,
      apply_hanatos2025_adaptation_surface: false,
      spectral_gaussian_blur: 0,
      use_enlarger_lut: false,
      use_scanner_lut: false,
      lut_resolution: 17,
      use_fast_stats: false,
      preview_max_size: 640,
      preview_mode: false,
      neutral_print_filters_from_database: true,
      use_cat16: true,
    },
    adjustments: {
      temperature: 0,
      tint: 0,
      contrast: 0,
      highlights: 0,
      shadows: 0,
      whites: 0,
      blacks: 0,
      saturation: 0,
      vibrance: 0,
      clarity: 0,
      dehaze: 0,
    },
    composition: {
      straighten_degrees: 0,
      aspect: "original",
      crop_scale: 100,
      crop_x: 0,
      crop_y: 0,
      border: 0,
      vignette_amount: 0,
      vignette_midpoint: 50,
      vignette_roundness: 0,
      vignette_feather: 50,
      vignette_highlights: 0,
    },
  });
}

/** Dot-joined paths of every leaf, treating arrays and `null` options as leaves. */
function leafPaths(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key));
}

describe("serializeSettings", () => {
  // Without this, "round-trips a valid settings tree" would only prove the fixture is
  // self-consistent. SETTINGS_CONTRACT is pinned to params.rs by the tests above, so
  // pinning the fixture to SETTINGS_CONTRACT is what makes the round-trip mean the real
  // settings tree survives validation.
  it("exercises every field the contract declares, so the round-trip covers the real tree", () => {
    expect(leafPaths(validSettings()).sort()).toEqual(Object.keys(SETTINGS_CONTRACT).sort());
  });

  it("round-trips a valid settings tree unchanged", () => {
    const settings = validSettings();
    expect(JSON.parse(serializeSettings(settings))).toEqual(settings);
  });

  it("round-trips option fields whether null or populated", () => {
    const settings = validSettings();
    (settings.film_render as Record<string, unknown>).development_time = 3.5;
    (settings.io as Record<string, unknown> & { output_gamut_compress: Record<string, unknown> }).output_gamut_compress.lightness_compression = null;
    expect(JSON.parse(serializeSettings(settings))).toEqual(settings);
  });

  it("throws naming the path for a fractional u32 value", () => {
    const settings = validSettings();
    (settings.settings as Record<string, unknown>).lut_resolution = 17.1;
    expect(() => serializeSettings(settings)).toThrow(/settings\.lut_resolution/);
  });

  it("throws naming the path for a negative u64 value", () => {
    const settings = validSettings();
    (settings.film_render as Record<string, unknown> & { grain: Record<string, unknown> }).grain.seed = -1;
    expect(() => serializeSettings(settings)).toThrow(/film_render\.grain\.seed/);
  });

  it("throws for an unknown top-level key", () => {
    const settings = validSettings();
    delete (settings as Record<string, unknown>).film_render;
    (settings as Record<string, unknown>).film_rendr = {};
    expect(() => serializeSettings(settings)).toThrow(/film_rendr/);
  });

  it("throws for an unknown nested key", () => {
    const settings = validSettings();
    (settings.camera as Record<string, unknown>).bogus_field = 1;
    expect(() => serializeSettings(settings)).toThrow(/camera\.bogus_field/);
  });

  it("throws SettingsValidationError, naming the path, for a non-finite number", () => {
    const settings = validSettings();
    (settings.camera as Record<string, unknown>).exposure_compensation_ev = Number.POSITIVE_INFINITY;
    expect(() => serializeSettings(settings)).toThrow(SettingsValidationError);
    expect(() => serializeSettings(settings)).toThrow(/camera\.exposure_compensation_ev/);
  });

  it("throws for a NaN number", () => {
    const settings = validSettings();
    (settings.camera as Record<string, unknown>).exposure_compensation_ev = Number.NaN;
    expect(() => serializeSettings(settings)).toThrow(/camera\.exposure_compensation_ev/);
  });

  it("throws for a boolean field given a non-boolean value", () => {
    const settings = validSettings();
    (settings.camera as Record<string, unknown>).auto_exposure = "yes";
    expect(() => serializeSettings(settings)).toThrow(/camera\.auto_exposure/);
  });

  it("throws for a string field given a non-string value", () => {
    const settings = validSettings();
    (settings.camera as Record<string, unknown>).auto_exposure_method = 5;
    expect(() => serializeSettings(settings)).toThrow(/camera\.auto_exposure_method/);
  });

  it("throws for an array field given a non-array value", () => {
    const settings = validSettings();
    (settings.camera as Record<string, unknown>).filter_uv = "nope";
    expect(() => serializeSettings(settings)).toThrow(/camera\.filter_uv/);
  });

  it("throws for an array field given the wrong length", () => {
    const settings = validSettings();
    (settings.camera as Record<string, unknown>).filter_uv = [0, 1];
    expect(() => serializeSettings(settings)).toThrow(/camera\.filter_uv/);
  });

  it("throws naming the element path for a bad array element", () => {
    const settings = validSettings();
    (settings.camera as Record<string, unknown>).filter_uv = [0, "bad", 8];
    expect(() => serializeSettings(settings)).toThrow(/camera\.filter_uv\[1\]/);
  });

  it("throws when a nested settings group is not an object", () => {
    const settings = validSettings();
    (settings as Record<string, unknown>).camera = "nope";
    expect(() => serializeSettings(settings)).toThrow(/camera/);
  });

  it("accepts u32/u64 fields at zero, the lowest valid integer", () => {
    const settings = validSettings();
    (settings.settings as Record<string, unknown>).lut_resolution = 0;
    expect(JSON.parse(serializeSettings(settings))).toMatchObject({ settings: { lut_resolution: 0 } });
  });
});

describe("contract assumptions", () => {
  // The params.rs parser above maps Rust field names straight to JSON keys. Any of these
  // attributes would break that assumption while leaving the pinning test green — and a
  // renamed key would then be emitted by default_settings_json and rejected by
  // serializeSettings, breaking the app with every suite passing.
  it("keeps params.rs free of the serde attributes the parser assumes are absent", () => {
    const offenders = [...paramsSource.matchAll(/#\[serde\([^\]]*\)\]/g)]
      .map((match) => match[0])
      .filter((attribute) => /\b(rename|rename_all|alias|skip|skip_serializing|skip_serializing_if|flatten)\b/.test(attribute));
    expect(offenders).toEqual([]);
  });

  it("rejects an inherited Object.prototype name as an unknown key", () => {
    expect(() => serializeSettings({ constructor: {} } as Record<string, unknown>)).toThrow(/unknown settings key "constructor"/);
  });

  it("keeps main.ts validating settings before they reach the worker", () => {
    const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    expect(main).toContain("settings: serializeSettings(recipe.settings)");
    expect(main).not.toContain("settings: JSON.stringify(recipe.settings)");
  });
});
