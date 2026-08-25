import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("deployment assets", () => {
  it("revalidates stable engine assets and keeps the offline cache version in sync", () => {
    const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
    expect(headers).not.toMatch(/\/(?:wasm|data)[\s\S]*?immutable/);
    expect(headers).toMatch(/\/wasm\/\*\s+Cache-Control: no-cache/);
    expect(headers).toMatch(/\/sw\.js\s+Cache-Control: no-cache, no-store, must-revalidate/);
    expect(headers).toMatch(/\/wasm\/\*\.wasm\s+Content-Type: application\/wasm/);
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const serviceWorker = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
    const assetBuilder = readFileSync(new URL("../scripts/copy-assets.mjs", import.meta.url), "utf8");
    expect(serviceWorker).toContain(`spektra-mobile-v${version}`);
    expect(assetBuilder).toContain("spektra-mobile-v${packageJson.version}");
    expect(serviceWorker).not.toContain("ignoreSearch: true");
    expect(serviceWorker).toContain("if (!response.ok && cached) return cached");
    expect(readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8"))
      .toContain("__APP_VERSION__");
    const engineWorker = readFileSync(new URL("./engine-worker.ts", import.meta.url), "utf8");
    expect(engineWorker).toContain("`/${directory}/${__APP_VERSION__}`");
    expect(engineWorker).toContain("`${enginePath}/spektrafilm_web.js`");
    expect(engineWorker).toContain("`${enginePath}/spektrafilm_web_bg.wasm`");
    expect(engineWorker.indexOf("await loaded.default("))
      .toBeLessThan(engineWorker.indexOf("engine = loaded"));
    const assets = readFileSync(new URL("../scripts/copy-assets.mjs", import.meta.url), "utf8");
    expect(assets).toContain('for (const directory of ["wasm", "wasm-threaded"])');
    expect(assets).toContain("packageJson.version");
    expect(assets).toContain("recursive: entry.isDirectory()");
    expect(assets).toContain('resolve("public/wasm", packageJson.version)');
    expect(assets).toContain('resolve("public/wasm-threaded", packageJson.version)');
    expect(assets).toContain("item.name !== packageJson.version");
    expect(serviceWorker).toContain("new Set(");
    expect(serviceWorker).toContain("if (!manifest.ok)");
    const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    expect(main).toContain("`v${__APP_VERSION__}`");
    expect(main).toContain('["localhost", "127.0.0.1"].includes(location.hostname)');
    expect(main).toContain("registration.unregister()");
    const playwrightConfig = readFileSync(new URL("../playwright.config.ts", import.meta.url), "utf8");
    expect(playwrightConfig).toContain("process.env.SPEKTRAFILM_E2E_BASE_URL");
    const iphoneConfig = readFileSync(new URL("../playwright.iphone.config.ts", import.meta.url), "utf8");
    expect(iphoneConfig).toContain('browserName: "webkit"');
    const deploy = readFileSync(new URL("../scripts/deploy-cloudflare.sh", import.meta.url), "utf8");
    expect(deploy).toContain("npm run release:verify");
    expect(deploy).toContain("https://spektra-mobile.pages.dev/sw.js");
    expect(deploy).toContain('spektra-mobile-v$VERSION');
    expect(deploy).toContain("SPEKTRAFILM_E2E_BASE_URL=https://spektra-mobile.pages.dev");
    expect(deploy).toContain("auto-rotates portrait DNG pixels and exports them once");
    expect(deploy).toContain("renders a mobile DNG after switching print off and back on");
    expect(deploy).toContain("keeps a Leica Fast GPU export inside the real iPhone memory budget");
  });
});
