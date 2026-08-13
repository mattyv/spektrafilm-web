import { describe, expect, it } from "vitest";
import { cloneRecipe, isRuntimeSettings, parseRecipe, pushHistory, type Recipe } from "./editor-state";

const recipe: Recipe = { version: 1, name: "Portra", film: "film", print: "paper", settings: {
  camera: { exposure_compensation_ev: 1, auto_exposure: true },
  enlarger: { y_filter_shift: 0 }, scanner: { unsharp_mask: [0.7] },
  film_render: { grain: { agx_particle_scale: [1.6] }, halation: { halation_amount: 1 } },
  print_render: {}, io: { scan_film: false, output_color_space: "sRGB" }, settings: {},
} };

describe("editor state", () => {
  it("round-trips recipes and rejects unrelated JSON", () => {
    expect(parseRecipe(JSON.stringify(recipe))).toEqual(recipe);
    expect(() => parseRecipe("{}")) .toThrow("Not a Spektra Mobile recipe");
    expect(() => parseRecipe(JSON.stringify({ ...recipe, settings: { ...recipe.settings, film_render: {} } })))
      .toThrow("Not a Spektra Mobile recipe");
    expect(() => parseRecipe(JSON.stringify({ ...recipe, settings: { ...recipe.settings,
      film_render: { grain: { agx_particle_scale: [] }, halation: { halation_amount: 1 } },
    } }))).toThrow("Not a Spektra Mobile recipe");
    expect(() => parseRecipe(JSON.stringify({ ...recipe, settings: { ...recipe.settings,
      camera: { exposure_compensation_ev: null, auto_exposure: true },
    } }))).toThrow("Not a Spektra Mobile recipe");
    expect(isRuntimeSettings(null)).toBe(false);
    expect(isRuntimeSettings([])).toBe(false);
  });

  it("keeps bounded immutable undo history", () => {
    const history = pushHistory([], recipe, 1);
    const copy = cloneRecipe(recipe);
    (copy.settings.camera as { exposure: number }).exposure = 2;
    expect(history).toEqual([recipe]);
    expect(pushHistory(history, copy, 1)).toEqual([copy]);
    expect(pushHistory(history, copy, 2)).toEqual([recipe, copy]);
  });
});
