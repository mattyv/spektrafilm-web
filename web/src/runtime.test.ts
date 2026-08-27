import { describe, expect, it } from "vitest";
import { exportScale, isWebKitUserAgent, rawPreviewPolicy, referenceThreadCount, safeExportMegapixels } from "./runtime";

describe("Reference Quality threads", () => {
  it("uses a bounded pool only when shared-memory isolation is available", () => {
    expect(referenceThreadCount(12, false, true, true)).toBe(4);
    expect(referenceThreadCount(8, true, true, true)).toBe(1);
    expect(referenceThreadCount(1, false, true, true)).toBe(1);
    expect(referenceThreadCount(8, false, false, true)).toBe(1);
    expect(referenceThreadCount(8, false, true, false)).toBe(1);
  });
});

describe("RAW preview policy", () => {
  it("uses sensor data and bounds mobile demosaic memory", () => {
    expect(rawPreviewPolicy(true, "ppg", 12)).toEqual({ developSensorData: false, demosaic: "superpixel", maximumDimension: 1200 });
    expect(rawPreviewPolicy(false, "ppg", 12)).toEqual({ developSensorData: true, demosaic: "ppg", maximumDimension: 2400 });
    expect(rawPreviewPolicy(false, "superpixel", 12)).toEqual({ developSensorData: true, demosaic: "superpixel", maximumDimension: 2400 });
  });

  it("bounds memory for a full-resolution desktop RAW preview", () => {
    expect(rawPreviewPolicy(false, "ppg", 36.6)).toEqual({ developSensorData: false, demosaic: "superpixel", maximumDimension: 2400 });
  });
});

describe("export memory budget", () => {
  it("caps Reference exports for mobile and desktop WebKit", () => {
    expect(safeExportMegapixels(true, "reference", 10.1, 11.1)).toBe(1);
    expect(safeExportMegapixels(true, "fast", 10.1, 11.1)).toBe(2);
    expect(safeExportMegapixels(false, "reference", 26.8, 9.15)).toBe(4);
    expect(safeExportMegapixels(false, "reference", 26.8, 9.15, true)).toBe(1);
    expect(safeExportMegapixels(false, "fast", 26.8, 9.15, false, true)).toBe(Infinity);
    expect(isWebKitUserAgent("Mozilla/5.0 AppleWebKit/605.1.15 Version/18.5 Safari/605.1.15")).toBe(true);
    expect(isWebKitUserAgent("Mozilla/5.0 AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36")).toBe(false);
    expect(exportScale(12, 1)).toBeCloseTo(Math.sqrt(1 / 12));
    expect(exportScale(0.5, 1)).toBe(1);
  });
});
