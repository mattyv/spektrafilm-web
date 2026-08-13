import { describe, expect, it, vi } from "vitest";
import { replaceAfterReady } from "./engine-transaction";

describe("engine replacement", () => {
  it("keeps the working engine when a replacement fails", async () => {
    const current = { free: vi.fn() };
    const replacement = { free: vi.fn() };
    await expect(replaceAfterReady(current, replacement, async () => { throw new Error("GPU failed"); }))
      .rejects.toThrow("GPU failed");
    expect(current.free).not.toHaveBeenCalled();
    expect(replacement.free).toHaveBeenCalledOnce();
  });

  it("retires the old engine only after its replacement is ready", async () => {
    const current = { free: vi.fn() };
    const replacement = { free: vi.fn() };
    await expect(replaceAfterReady(current, replacement, async () => undefined)).resolves.toBe(replacement);
    expect(current.free).toHaveBeenCalledOnce();
    expect(replacement.free).not.toHaveBeenCalled();
  });
});
