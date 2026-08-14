import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import packageJson from "../package.json" with { type: "json" };

const source = resolve("../data");
const target = resolve("public/data");
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(resolve(source, "profiles"), resolve(target, "profiles"), { recursive: true });
mkdirSync(resolve(target, "filters"), { recursive: true });
cpSync(resolve(source, "filters/neutral_print_filters.json"), resolve(target, "filters/neutral_print_filters.json"));
cpSync(resolve(source, "luts/spectral_upsampling"), resolve(target, "luts/spectral_upsampling"), { recursive: true });
cpSync(resolve("../assets/spektrafilm-icon.jpg"), resolve("public/icon.jpg"));
for (const directory of ["wasm", "wasm-threaded"]) {
  const source = resolve("public", directory);
  for (const entry of readdirSync(source, { withFileTypes: true }).filter((item) => /^\d+\.\d+\.\d+$/.test(item.name) && item.name !== packageJson.version)) {
    rmSync(resolve(source, entry.name), { recursive: true, force: true });
  }
  const target = resolve(source, packageJson.version);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true }).filter((item) => !/^\d+\.\d+\.\d+$/.test(item.name))) {
    cpSync(resolve(source, entry.name), resolve(target, entry.name), { recursive: entry.isDirectory() });
  }
}

function files(directory, base, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = `${prefix}/${entry.name}`;
    return entry.isDirectory() ? files(resolve(directory, entry.name), base, relative) : [`${base}${relative}`];
  });
}

writeFileSync(resolve("public/asset-manifest.json"), JSON.stringify([
  ...files(target, "/data"),
  ...files(resolve("public/wasm", packageJson.version), `/wasm/${packageJson.version}`),
  ...files(resolve("public/wasm-threaded", packageJson.version), `/wasm-threaded/${packageJson.version}`),
]));
