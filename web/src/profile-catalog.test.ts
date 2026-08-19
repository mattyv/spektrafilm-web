import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const workerSource = readFileSync(new URL("./engine-worker.ts", import.meta.url), "utf8");
const libSource = readFileSync(new URL("../../crates/spektrafilm-web/src/lib.rs", import.meta.url), "utf8");
const profilesDir = fileURLToPath(new URL("../../data/profiles/", import.meta.url));

/** Every `<option value="...">` inside the `<select id="selectId">...</select>` block. */
function optionValues(html: string, selectId: string): string[] {
  const start = html.indexOf(`id="${selectId}"`);
  expect(start, `no <select id="${selectId}"> in the source`).toBeGreaterThan(-1);
  const end = html.indexOf("</select>", start);
  expect(end, `<select id="${selectId}"> is never closed`).toBeGreaterThan(-1);
  const segment = html.slice(start, end);
  return [...segment.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
}

describe("film and print stock catalog", () => {
  it("gives every #film-stock option a matching profile file", () => {
    const values = optionValues(mainSource, "film-stock");
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(existsSync(`${profilesDir}${value}.json`), `no data/profiles/${value}.json for #film-stock option "${value}"`).toBe(true);
    }
  });

  it("gives every #print-stock option (other than the film-only 'none') a matching profile file", () => {
    const values = optionValues(mainSource, "print-stock").filter((value) => value !== "none");
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(existsSync(`${profilesDir}${value}.json`), `no data/profiles/${value}.json for #print-stock option "${value}"`).toBe(true);
    }
  });

  it("keeps the engine worker's two hard-coded default profile names pointing at real files", () => {
    const film = /let currentFilm = "([^"]+)"/.exec(workerSource);
    const print = /let currentPrint = "([^"]+)"/.exec(workerSource);
    expect(film, "engine-worker.ts default currentFilm not found").not.toBeNull();
    expect(print, "engine-worker.ts default currentPrint not found").not.toBeNull();
    expect(existsSync(`${profilesDir}${film![1]}.json`)).toBe(true);
    expect(existsSync(`${profilesDir}${print![1]}.json`)).toBe(true);
  });
});

describe("RAW white balance and demosaic option strings", () => {
  it("pins #raw-white-balance option values to the sentinel Rust and the worker actually match on", () => {
    expect(optionValues(mainSource, "raw-white-balance")).toEqual(["camera", "uncorrected"]);
    // engine-worker.ts converts the string to the boolean raw_preview takes.
    expect(workerSource).toContain('data.rawWhiteBalance !== "uncorrected"');
    // BrowserEngine::set_raw_development matches the same sentinel directly.
    expect(libSource).toContain('white_balance != "uncorrected"');
  });

  it("pins #raw-demosaic option values to the strings Rust matches on", () => {
    expect(optionValues(mainSource, "raw-demosaic")).toEqual(["ppg", "superpixel"]);
    const demosaicMatches = [...libSource.matchAll(/demosaic == "superpixel"/g)];
    // Once for the free `raw_preview` function, once for `BrowserEngine::set_raw_development`.
    expect(demosaicMatches.length).toBeGreaterThanOrEqual(2);
  });
});
