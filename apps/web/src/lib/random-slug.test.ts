import { describe, expect, it, vi } from "vitest";
import { randomSlug } from "./random-slug.js";

describe("randomSlug", () => {
  it("is 16 lowercase URL-safe characters by default", () => {
    const slug = randomSlug();
    expect(slug).toHaveLength(16);
    expect(slug).toMatch(/^[a-z2-7]+$/);
  });

  it("honours the requested length", () => {
    expect(randomSlug(8)).toHaveLength(8);
    expect(randomSlug(32)).toHaveLength(32);
  });

  it("draws from the CSPRNG, not Math.random", () => {
    const getRandomValues = vi.spyOn(crypto, "getRandomValues");
    const mathRandom = vi.spyOn(Math, "random");
    try {
      randomSlug();
      expect(getRandomValues).toHaveBeenCalledTimes(1);
      expect(mathRandom).not.toHaveBeenCalled();
    } finally {
      getRandomValues.mockRestore();
      mathRandom.mockRestore();
    }
  });

  it("maps every byte value onto the alphabet", () => {
    const getRandomValues = vi
      .spyOn(crypto, "getRandomValues")
      .mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint8Array) for (let i = 0; i < array.length; i++) array[i] = i;
        return array;
      });
    try {
      const slug = randomSlug(256);
      // Byte b → alphabet[b & 31]: the alphabet repeats eight times.
      expect(slug).toBe("abcdefghijklmnopqrstuvwxyz234567".repeat(8));
    } finally {
      getRandomValues.mockRestore();
    }
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 200 }, () => randomSlug()));
    expect(seen.size).toBe(200);
  });
});
