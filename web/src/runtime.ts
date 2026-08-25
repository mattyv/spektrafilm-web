export function referenceThreadCount(hardwareConcurrency: number, mobile: boolean, isolated: boolean, sharedMemory: boolean) {
  if (mobile || !isolated || !sharedMemory) return 1;
  return Math.max(1, Math.min(4, Math.floor(hardwareConcurrency) || 1));
}

export function rawPreviewPolicy(mobile: boolean, demosaic: string, megapixels = 0) {
  const bounded = mobile || megapixels > 24;
  return { developSensorData: !bounded, demosaic: bounded ? "superpixel" : demosaic };
}

export function isWebKitUserAgent(userAgent: string) {
  return /AppleWebKit/i.test(userAgent) && !/(Chrome|Chromium|CriOS|Edg|OPR)/i.test(userAgent);
}

export function safeExportMegapixels(mobile: boolean, mode: "reference" | "fast", deviceSafe: number, storageSafe: number, webkit = false, unlimited = false) {
  if (unlimited) return Infinity;
  return mode === "fast" ? Math.min(deviceSafe, storageSafe, mobile ? 2 : Infinity) : Math.min(deviceSafe, storageSafe, mobile || webkit ? 1 : 4);
}

export function exportScale(megapixels: number, safeMegapixels: number) {
  return Math.min(1, Math.sqrt(safeMegapixels / megapixels));
}
