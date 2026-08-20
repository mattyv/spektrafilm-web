export type Recipe = {
  version: 1;
  name: string;
  film: string;
  print: string;
  settings: Record<string, unknown>;
};

export function cloneRecipe(recipe: Recipe): Recipe {
  return structuredClone(recipe);
}

export function parseRecipe(text: string): Recipe {
  const value = JSON.parse(text) as Partial<Recipe>;
  if (value.version !== 1 || typeof value.name !== "string" || typeof value.film !== "string"
    || typeof value.print !== "string" || !isRuntimeSettings(value.settings)) {
    throw new Error("Not a Spektra Mobile recipe");
  }
  return value as Recipe;
}

export function isRuntimeSettings(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const settings = value as Record<string, unknown>;
  const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
  const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  if (!["camera", "enlarger", "scanner", "film_render", "print_render", "io", "settings"].every((key) => object(settings[key]))) return false;
  const film = settings.film_render as Record<string, unknown>;
  return object(film.grain) && Array.isArray(film.grain.agx_particle_scale) && finite(film.grain.agx_particle_scale[0])
    && object(film.halation) && finite(film.halation.halation_amount)
    && Array.isArray((settings.scanner as Record<string, unknown>).unsharp_mask)
    && finite(((settings.scanner as Record<string, unknown>).unsharp_mask as unknown[])[0])
    && finite((settings.camera as Record<string, unknown>).exposure_compensation_ev)
    && typeof (settings.camera as Record<string, unknown>).auto_exposure === "boolean"
    && finite((settings.enlarger as Record<string, unknown>).y_filter_shift)
    && typeof (settings.io as Record<string, unknown>).scan_film === "boolean"
    && typeof (settings.io as Record<string, unknown>).output_color_space === "string";
}

export function pushHistory(history: Recipe[], recipe: Recipe, limit = 50): Recipe[] {
  return [...(limit > 1 ? history.slice(-(limit - 1)) : []), cloneRecipe(recipe)];
}

let storedResults = 0;

/**
 * A distinct OPFS name for each stored export. Downloads stream from the stored file and
 * report no completion, so reusing a name lets a re-export overwrite a file a download is
 * still reading. The item id stays a prefix so an item's results can be reclaimed together.
 */
export function nextStoredResultName(itemId: string, downloadAs: string): string {
  storedResults += 1;
  return `${itemId}-${storedResults}-${downloadAs}`;
}
