import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import packageJson from "./package.json" with { type: "json" };

const engineVersion = readFileSync("../Cargo.toml", "utf8").match(/^version = "([^"]+)"/m)?.[1];
if (!engineVersion) throw new Error("Could not read the Rust workspace version");
if (engineVersion !== packageJson.version) throw new Error(`Web ${packageJson.version} and Rust ${engineVersion} versions differ`);

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(packageJson.version) },
  server: { headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } },
  preview: { headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } },
});
