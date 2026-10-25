import { describe, expect, it } from "vitest";
import {
  ImagePresetUnavailableError,
  assertPresetAvailable,
  availablePresets,
  presetAvailable,
} from "./image-presets.js";

const bundled = { OPTIO_AGENT_PRESETS: "base,node,python,go,rust,full" };

describe("availablePresets", () => {
  it("unset or empty: every preset, as before", () => {
    expect(availablePresets({})).toContain("dind");
    expect(availablePresets({ OPTIO_AGENT_PRESETS: "  " })).toContain("ruby");
  });

  it("lists what OPTIO_AGENT_PRESETS names, in catalog order, ignoring unknown names", () => {
    expect(availablePresets({ OPTIO_AGENT_PRESETS: "rust, node ,cobol" })).toEqual([
      "base",
      "node",
      "rust",
    ]);
  });

  it("always counts base, the default image", () => {
    expect(availablePresets({ OPTIO_AGENT_PRESETS: "node" })).toEqual(["base", "node"]);
    expect(presetAvailable(undefined, { OPTIO_AGENT_PRESETS: "node" })).toBe(true);
  });
});

describe("assertPresetAvailable", () => {
  it("passes a bundled preset and no preset at all", () => {
    expect(() => assertPresetAvailable("node", bundled)).not.toThrow();
    expect(() => assertPresetAvailable(null, bundled)).not.toThrow();
  });

  it("names an unbundled preset and what there is", () => {
    let err: unknown;
    try {
      assertPresetAvailable("dind", bundled);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ImagePresetUnavailableError);
    expect((err as Error).message).toBe(
      'Image preset "dind" is not available in this deployment (available: base, node, python, go, rust, full)',
    );
    expect((err as ImagePresetUnavailableError).statusCode).toBe(400);
  });

  it("rejects a preset Optio doesn't know, even with every preset available", () => {
    expect(() => assertPresetAvailable("cobol", {})).toThrow('Unknown image preset "cobol"');
  });
});
