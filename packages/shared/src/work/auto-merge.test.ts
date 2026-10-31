import { describe, expect, it } from "vitest";
import {
  AUTO_MERGE_CONFIRMATION_MESSAGE,
  autoMergeStamp,
  effectiveAutoMerge,
  isAutoMergeConfirmed,
  newAutoMergeStamp,
  requireAutoMergeConfirmation,
} from "./auto-merge.js";

describe("requireAutoMergeConfirmation", () => {
  it("refuses turning automatic merging on without the confirmation", () => {
    expect(requireAutoMergeConfirmation({ autoMerge: true }, undefined, true)).toBe(
      AUTO_MERGE_CONFIRMATION_MESSAGE,
    );
    expect(
      requireAutoMergeConfirmation({ autoMerge: true, autoMergeConfirmed: false }, undefined, true),
    ).toBe("Automatic merging needs the checkbox and the confirmation");
  });

  it("doesn't ask again when it was already on and confirmed", () => {
    const current = { autoMerge: true, autoMergeConfirmedAt: "2026-10-01T00:00:00Z" };
    expect(requireAutoMergeConfirmation({ autoMerge: true }, current, true)).toBeNull();
    expect(
      requireAutoMergeConfirmation(
        { autoMerge: true },
        { autoMerge: true, autoMergeConfirmedAt: null },
        true,
      ),
    ).toBe(AUTO_MERGE_CONFIRMATION_MESSAGE);
    expect(
      requireAutoMergeConfirmation(
        { autoMerge: true },
        { autoMerge: false, autoMergeConfirmedAt: "2026-10-01T00:00:00Z" },
        true,
      ),
    ).toBe(AUTO_MERGE_CONFIRMATION_MESSAGE);
  });

  it("lets a confirmed write, turning it off, or leaving it alone through", () => {
    expect(
      requireAutoMergeConfirmation({ autoMerge: true, autoMergeConfirmed: true }, undefined, true),
    ).toBeNull();
    expect(requireAutoMergeConfirmation({ autoMerge: false }, undefined, true)).toBeNull();
    expect(requireAutoMergeConfirmation({ autoMerge: null }, undefined, true)).toBeNull();
    expect(requireAutoMergeConfirmation({}, undefined, true)).toBeNull();
  });
});

describe("without the confirmation required (the default)", () => {
  it("lets any write through", () => {
    expect(requireAutoMergeConfirmation({ autoMerge: true }, undefined, false)).toBeNull();
    expect(
      requireAutoMergeConfirmation(
        { autoMerge: true },
        { autoMerge: true, autoMergeConfirmedAt: null },
        false,
      ),
    ).toBeNull();
  });

  it("merges by autoMerge alone, stamp or not", () => {
    const unstamped = { autoMerge: true, autoMergeConfirmedAt: null };
    expect(effectiveAutoMerge(null, unstamped, false)).toEqual({
      autoMerge: true,
      autoMergeConfirmed: true,
    });
    expect(effectiveAutoMerge({ autoMerge: false }, unstamped, false)).toEqual({
      autoMerge: false,
      autoMergeConfirmed: false,
    });
    expect(effectiveAutoMerge(null, null, false)).toEqual({
      autoMerge: false,
      autoMergeConfirmed: false,
    });
  });
});

describe("autoMergeStamp", () => {
  const now = new Date("2026-10-23T10:00:00Z");

  it("stamps now and who when it's confirmed", () => {
    expect(autoMergeStamp({ autoMerge: true, autoMergeConfirmed: true }, "u1", now)).toEqual({
      autoMergeConfirmedAt: now,
      autoMergeConfirmedBy: "u1",
    });
    expect(
      autoMergeStamp({ autoMerge: true, autoMergeConfirmed: true }, undefined, now)
        ?.autoMergeConfirmedBy,
    ).toBeNull();
  });

  it("clears the stamp when it's turned off or inherited", () => {
    const cleared = { autoMergeConfirmedAt: null, autoMergeConfirmedBy: null };
    expect(autoMergeStamp({ autoMerge: false }, "u1", now)).toEqual(cleared);
    expect(autoMergeStamp({ autoMerge: null, autoMergeConfirmed: true }, "u1", now)).toEqual(
      cleared,
    );
  });

  it("keeps the stamp when the write doesn't touch auto-merge or saves it on again", () => {
    expect(autoMergeStamp({}, "u1", now)).toBeUndefined();
    expect(autoMergeStamp({ autoMerge: true }, "u1", now)).toBeUndefined();
  });
});

describe("newAutoMergeStamp", () => {
  const now = new Date("2026-10-23T10:00:00Z");

  it("a new row is stamped only when this write confirmed it", () => {
    expect(newAutoMergeStamp({ autoMerge: true, autoMergeConfirmed: true }, "u1", now)).toEqual({
      autoMergeConfirmedAt: now,
      autoMergeConfirmedBy: "u1",
    });
    const none = { autoMergeConfirmedAt: null, autoMergeConfirmedBy: null };
    expect(newAutoMergeStamp({ autoMerge: true }, "u1", now)).toEqual(none);
    expect(newAutoMergeStamp({}, "u1", now)).toEqual(none);
  });
});

describe("effectiveAutoMerge", () => {
  const confirmed = { autoMerge: true, autoMergeConfirmedAt: new Date() };
  const unconfirmed = { autoMerge: true, autoMergeConfirmedAt: null };

  it("needs the setting on AND confirmed", () => {
    expect(isAutoMergeConfirmed(confirmed)).toBe(true);
    expect(isAutoMergeConfirmed(unconfirmed)).toBe(false);
    expect(isAutoMergeConfirmed({ autoMerge: false, autoMergeConfirmedAt: new Date() })).toBe(
      false,
    );
    expect(isAutoMergeConfirmed(null)).toBe(false);
  });

  it("uses the run's own setting over the repo's", () => {
    expect(effectiveAutoMerge(unconfirmed, confirmed, true)).toEqual({
      autoMerge: true,
      autoMergeConfirmed: false,
    });
    expect(effectiveAutoMerge({ autoMerge: false }, confirmed, true)).toEqual({
      autoMerge: false,
      autoMergeConfirmed: false,
    });
  });

  it("falls back to the repo's when the run inherits", () => {
    expect(effectiveAutoMerge({ autoMerge: null }, confirmed, true)).toEqual({
      autoMerge: true,
      autoMergeConfirmed: true,
    });
    expect(effectiveAutoMerge(null, unconfirmed, true)).toEqual({
      autoMerge: true,
      autoMergeConfirmed: false,
    });
    expect(effectiveAutoMerge(null, null, true)).toEqual({
      autoMerge: false,
      autoMergeConfirmed: false,
    });
  });
});
