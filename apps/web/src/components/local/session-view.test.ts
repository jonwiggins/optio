import { describe, expect, it } from "vitest";
import { resolveSessionView } from "./session-view";

describe("resolveSessionView", () => {
  it("honors an explicit choice", () => {
    expect(resolveSessionView("screen", { isDead: true, hasTranscript: true, loaded: true })).toBe(
      "screen",
    );
    expect(
      resolveSessionView("transcript", { isDead: false, hasTranscript: false, loaded: false }),
    ).toBe("transcript");
  });

  it("shows the screen for a live session before anything is known", () => {
    expect(resolveSessionView(null, { isDead: false, hasTranscript: false, loaded: false })).toBe(
      "screen",
    );
  });

  it("waits for the transcript fetch on a finished session", () => {
    expect(resolveSessionView(null, { isDead: true, hasTranscript: false, loaded: false })).toBe(
      null,
    );
  });

  it("prefers the conversation of a finished session, falling back to the screen", () => {
    expect(resolveSessionView(null, { isDead: true, hasTranscript: true, loaded: true })).toBe(
      "transcript",
    );
    expect(resolveSessionView(null, { isDead: true, hasTranscript: false, loaded: true })).toBe(
      "screen",
    );
  });
});
