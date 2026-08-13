import { describe, expect, it } from "vitest";
import { rawPreviewPolicy, referenceThreadCount } from "./runtime";

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
    expect(rawPreviewPolicy(true, "ppg")).toEqual({ developSensorData: true, demosaic: "superpixel" });
    expect(rawPreviewPolicy(false, "ppg")).toEqual({ developSensorData: true, demosaic: "ppg" });
    expect(rawPreviewPolicy(false, "superpixel")).toEqual({ developSensorData: true, demosaic: "superpixel" });
  });
});
