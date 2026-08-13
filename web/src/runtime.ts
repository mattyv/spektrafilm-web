export function referenceThreadCount(hardwareConcurrency: number, mobile: boolean, isolated: boolean, sharedMemory: boolean) {
  if (!isolated || !sharedMemory) return 1;
  return Math.max(1, Math.min(mobile ? 2 : 4, Math.floor(hardwareConcurrency) || 1));
}

export function rawPreviewPolicy(mobile: boolean, demosaic: string) {
  return { developSensorData: true, demosaic: mobile ? "superpixel" : demosaic };
}
