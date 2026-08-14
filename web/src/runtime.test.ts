import { describe, expect, it } from "vitest";
import { exportScale, rawPreviewPolicy, referenceThreadCount, safeExportMegapixels } from "./runtime";

describe("Reference Quality threads", () => {
  it("uses a bounded pool only when shared-memory isolation is available", () => {
    expect(referenceThreadCount(12, false, true, true)).toBe(4);
    expect(referenceThreadCount(8, true, true, true)).toBe(2);
    expect(referenceThreadCount(1, false, true, true)).toBe(1);
    expect(referenceThreadCount(8, false, false, true)).toBe(1);
    expect(referenceThreadCount(8, false, true, false)).toBe(1);
  });
});

describe("RAW preview policy", () => {
  it("uses sensor data and bounds mobile demosaic memory", () => {
    expect(rawPreviewPolicy(true, "ppg", 12)).toEqual({ developSensorData: false, demosaic: "superpixel" });
    expect(rawPreviewPolicy(false, "ppg", 12)).toEqual({ developSensorData: true, demosaic: "ppg" });
    expect(rawPreviewPolicy(false, "superpixel", 12)).toEqual({ developSensorData: true, demosaic: "superpixel" });
  });

  it("bounds memory for a full-resolution desktop RAW preview", () => {
    expect(rawPreviewPolicy(false, "ppg", 36.6)).toEqual({ developSensorData: false, demosaic: "superpixel" });
  });
});

describe("export memory budget", () => {
  it("caps iPhone Reference exports below the GPU budget", () => {
    expect(safeExportMegapixels(true, "reference", 10.1, 11.1)).toBe(1);
    expect(safeExportMegapixels(true, "fast", 10.1, 11.1)).toBe(2);
    expect(safeExportMegapixels(false, "reference", 26.8, 11.1)).toBe(26.8);
    expect(exportScale(12, 1)).toBeCloseTo(Math.sqrt(1 / 12));
    expect(exportScale(0.5, 1)).toBe(1);
  });
});
