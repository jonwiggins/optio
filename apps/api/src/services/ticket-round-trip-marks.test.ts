import { describe, expect, it, vi } from "vitest";

vi.mock("../db/client.js", () => ({ db: {} }));

import { followUpFloor, followUpsWidened, roundTripMarks } from "./ticket-round-trip-marks.js";

describe("a provider's round-trip marks", () => {
  it("are read from config.roundTrip, null where absent or unreadable", () => {
    expect(roundTripMarks(undefined)).toEqual({ since: null, followUpsSince: null });
    expect(roundTripMarks({ roundTrip: "x" })).toEqual({ since: null, followUpsSince: null });
    expect(
      roundTripMarks({ roundTrip: { since: "2026-10-01T00:00:00.000Z", followUpsSince: "nope" } }),
    ).toEqual({ since: new Date("2026-10-01T00:00:00.000Z"), followUpsSince: null });
  });

  it("the follow-up floor is the later of the two, or none", () => {
    expect(followUpFloor({ since: null, followUpsSince: null })).toBeNull();
    const since = new Date("2026-10-01T00:00:00Z");
    const widened = new Date("2026-10-20T00:00:00Z");
    expect(followUpFloor({ since, followUpsSince: null })).toEqual(since);
    expect(followUpFloor({ since, followUpsSince: widened })).toEqual(widened);
    expect(followUpFloor({ since: widened, followUpsSince: since })).toEqual(widened);
  });

  it("follow-ups widen from Off to Mentions only to Any comment, not back", () => {
    expect(followUpsWidened("off", "mention")).toBe(true);
    expect(followUpsWidened("off", "any")).toBe(true);
    expect(followUpsWidened("mention", "any")).toBe(true);
    expect(followUpsWidened("any", "any")).toBe(false);
    expect(followUpsWidened("any", "mention")).toBe(false);
    expect(followUpsWidened("mention", "off")).toBe(false);
  });
});
