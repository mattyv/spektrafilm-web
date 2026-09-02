const CACHE = "spektra-mobile-v0.2.29";
const SHELL = ["/", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const manifest = await fetch("/asset-manifest.json");
    if (!manifest.ok) throw new Error("Asset manifest unavailable");
    const assets = await manifest.json();
    const shell = await fetch("/");
    const html = await shell.clone().text();
    const bundles = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
    const nestedBundles = [];
    for (const bundle of bundles.filter((path) => path.endsWith(".js"))) {
      const source = await fetch(bundle).then((response) => response.text());
      nestedBundles.push(...[...source.matchAll(/\/assets\/[A-Za-z0-9_.-]+/g)].map((match) => match[0]));
    }
    await cache.put("/", shell);
    await cache.addAll([...new Set([...SHELL.slice(1), "/asset-manifest.json", ...bundles, ...nestedBundles, ...assets])]);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== location.origin) return;
  const immutable = new URL(event.request.url).pathname.startsWith("/assets/");
  event.respondWith((async () => {
    const cached = await caches.match(event.request, { ignoreVary: true });
    if (immutable && cached) return cached;
    try {
      const response = await fetch(event.request);
      if (!response.ok && cached) return cached;
      if (response.ok) await (await caches.open(CACHE)).put(event.request, response.clone());
      return response;
    } catch (error) {
      if (cached) return cached;
      throw error;
    }
  })());
});
