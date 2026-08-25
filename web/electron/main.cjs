const { app, BrowserWindow } = require("electron");
const { createReadStream } = require("node:fs");
const { createServer } = require("node:http");
const { extname, join, normalize, sep } = require("node:path");

const root = join(__dirname, "..", "dist");
const mime = {
  ".css": "text/css",
  ".html": "text/html",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".npy": "application/octet-stream",
  ".png": "image/png",
  ".txt": "text/plain",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
};

const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  const file = normalize(join(root, pathname === "/" ? "index.html" : pathname));
  if (file !== root && !file.startsWith(`${root}${sep}`)) {
    response.writeHead(403).end();
    return;
  }
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  response.setHeader("Content-Type", mime[extname(file)] || "application/octet-stream");
  createReadStream(file).on("error", () => response.writeHead(404).end()).pipe(response);
});

app.commandLine.appendSwitch("enable-unsafe-webgpu");
app.userAgentFallback = `${app.userAgentFallback} SpektraElectron`;

async function createWindow() {
  if (!server.listening) await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await window.loadURL(`http://127.0.0.1:${port}`);
}

app.whenReady().then(createWindow);
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => server.close());
