import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The merge confirmation's switch (docs/merge-confirmation.md): off unless
// the app or the environment says so, and a failed read never relaxes it.

const read = vi.hoisted(() => ({ rows: [] as unknown[], fail: false }));
vi.mock("../db/client.js", () => {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: async () => {
      if (read.fail) throw new Error("db down");
      return read.rows;
    },
  };
  return { db: chain };
});

import { forgetSwitches, mergeConfirmationRequired } from "./deployment-settings.js";

beforeEach(() => {
  read.rows = [];
  read.fail = false;
  forgetSwitches();
});
afterEach(() => vi.unstubAllEnvs());

describe("mergeConfirmationRequired", () => {
  it("is off by default", async () => {
    expect(await mergeConfirmationRequired()).toBe(false);
  });

  it("follows OPTIO_MERGE_CONFIRMATION when nothing is saved", async () => {
    vi.stubEnv("OPTIO_MERGE_CONFIRMATION", "true");
    expect(await mergeConfirmationRequired()).toBe(true);
  });

  it("a saved value wins over the environment", async () => {
    vi.stubEnv("OPTIO_MERGE_CONFIRMATION", "true");
    read.rows = [{ value: false }];
    expect(await mergeConfirmationRequired()).toBe(false);
  });

  it("a failed read asks for the confirmation (fails closed) and isn't remembered", async () => {
    read.fail = true;
    expect(await mergeConfirmationRequired()).toBe(true);
    read.fail = false;
    expect(await mergeConfirmationRequired()).toBe(false);
  });
});
