import { describe, expect, it } from "vitest";
import { autoWhiteBalance, neutralWhiteBalance } from "./white-balance";

describe("neutral white balance", () => {
  it("leaves neutral pixels alone and corrects blue/green casts", () => {
    expect(neutralWhiteBalance(128, 128, 128)).toEqual({ temperature: 0, tint: 0 });
    expect(neutralWhiteBalance(120, 100, 140)).toEqual({ temperature: 83, tint: 100 });
    expect(neutralWhiteBalance(1, 1, 255)).toEqual({ temperature: 100, tint: 100 });
  });

  it("estimates a scene correction from unclipped midtones", () => {
    expect(autoWhiteBalance(new Uint8ClampedArray([
      120, 100, 140, 255,
      122, 102, 142, 255,
      0, 0, 0, 255,
      255, 255, 255, 255,
    ]))).toEqual({ temperature: 82, tint: 100 });
    expect(autoWhiteBalance(new Uint8ClampedArray([0, 0, 0, 255]))).toEqual({ temperature: 0, tint: 0 });
  });
});
