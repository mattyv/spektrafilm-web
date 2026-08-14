export function referenceThreadCount(hardwareConcurrency: number, mobile: boolean, isolated: boolean, sharedMemory: boolean) {
  if (!isolated || !sharedMemory) return 1;
  return Math.max(1, Math.min(mobile ? 2 : 4, Math.floor(hardwareConcurrency) || 1));
}

export function rawPreviewPolicy(mobile: boolean, demosaic: string, megapixels = 0) {
  const bounded = mobile || megapixels > 24;
  return { developSensorData: !bounded, demosaic: bounded ? "superpixel" : demosaic };
}

export function safeExportMegapixels(mobile: boolean, mode: "reference" | "fast", deviceSafe: number, storageSafe: number) {
  return mode === "fast" ? Math.min(deviceSafe, storageSafe, mobile ? 2 : Infinity) : mobile ? Math.min(deviceSafe, 1) : deviceSafe;
}

export function exportScale(megapixels: number, safeMegapixels: number) {
  return Math.min(1, Math.sqrt(safeMegapixels / megapixels));
}
