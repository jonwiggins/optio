import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUND_TRIP,
  ROUND_TRIP_SOURCES,
  normalizeRoundTrip,
  roundTripActive,
  roundTripSettings,
  roundTripSupport,
} from "./ticket-round-trip.js";

describe("a ticket provider's round-trip settings", () => {
  it("are the defaults for a provider saved before the round trip existed", () => {
    expect(roundTripSettings({ baseUrl: "https://jira.example.test" })).toEqual(DEFAULT_ROUND_TRIP);
    expect(roundTripSettings(null)).toEqual(DEFAULT_ROUND_TRIP);
    // Off; once on: comments and the link, follow-ups from any person, no status moves.
    expect(DEFAULT_ROUND_TRIP).toEqual({
      enabled: false,
      comments: true,
      remoteLink: true,
      followUps: "any",
      transitions: { started: "", mrOpened: "", merged: "", failed: "" },
    });
  });

  it("read what was saved", () => {
    expect(
      roundTripSettings({
        roundTrip: {
          comments: false,
          remoteLink: false,
          followUps: "mention",
          transitions: { started: "In Progress", mrOpened: "In Review", merged: "Done" },
        },
      }),
    ).toEqual({
      enabled: false,
      comments: false,
      remoteLink: false,
      followUps: "mention",
      transitions: { started: "In Progress", mrOpened: "In Review", merged: "Done", failed: "" },
    });
  });

  it("are on only when switched on, and only for a source with a round trip", () => {
    expect(roundTripSettings({ roundTrip: { enabled: true } }).enabled).toBe(true);
    expect(roundTripSettings({ roundTrip: { enabled: "yes" } }).enabled).toBe(false);
    const on = { roundTrip: { enabled: true } };
    for (const source of ROUND_TRIP_SOURCES) {
      expect(roundTripActive({ source, config: on })).toBe(true);
      expect(roundTripActive({ source, config: {} })).toBe(false);
    }
    expect(roundTripActive({ source: "trello", config: on })).toBe(false);
    expect(roundTripSupport("trello")).toBeNull();
  });

  it("say what each source can do", () => {
    expect(ROUND_TRIP_SOURCES).toEqual([...ROUND_TRIP_SOURCES].sort());
    expect(roundTripSupport("jira")).toMatchObject({ link: "remote-link", statuses: true });
    expect(roundTripSupport("github")).toMatchObject({ link: "comment", statuses: true });
    expect(roundTripSupport("gitlab")).toMatchObject({ link: "comment", statuses: true });
    expect(roundTripSupport("linear")).toMatchObject({ link: "attachment", statuses: true });
    expect(roundTripSupport("notion")).toMatchObject({ link: null, statuses: true });
    // An issue number names an issue only within its repository.
    expect(ROUND_TRIP_SOURCES.filter((s) => !roundTripSupport(s)!.uniqueIds)).toEqual([
      "github",
      "gitlab",
    ]);
  });

  it("drop what they don't know and clean status names", () => {
    expect(
      normalizeRoundTrip({
        comments: "yes",
        followUps: "always",
        extra: 1,
        transitions: { started: "  In\nProgress ", merged: 7, nope: "x" },
      }),
    ).toEqual({
      ...DEFAULT_ROUND_TRIP,
      transitions: { started: "In Progress", mrOpened: "", merged: "", failed: "" },
    });
    expect(
      normalizeRoundTrip({ transitions: { started: "x".repeat(500) } }).transitions.started,
    ).toHaveLength(120);
  });
});
