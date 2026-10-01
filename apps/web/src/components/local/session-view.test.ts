import { describe, expect, it } from "vitest";
import { canShowChat, resolveSessionView } from "./session-view";

describe("resolveSessionView", () => {
  it("honors an explicit choice", () => {
    expect(resolveSessionView("screen", { isDead: true, hasTranscript: true, loaded: true })).toBe(
      "screen",
    );
    expect(
      resolveSessionView("transcript", { isDead: false, hasTranscript: false, loaded: false }),
    ).toBe("transcript");
    expect(
      resolveSessionView("screen", {
        isDead: false,
        hasTranscript: true,
        loaded: true,
        narrow: true,
      }),
    ).toBe("screen");
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

  it("opens a live session with a conversation on Chat on a narrow screen", () => {
    expect(
      resolveSessionView(null, { isDead: false, hasTranscript: true, loaded: true, narrow: true }),
    ).toBe("transcript");
  });

  it("waits for the transcript fetch on a narrow screen, even while live", () => {
    expect(
      resolveSessionView(null, {
        isDead: false,
        hasTranscript: false,
        loaded: false,
        narrow: true,
      }),
    ).toBe(null);
  });

  it("shows the terminal on a narrow screen when there is no conversation", () => {
    expect(
      resolveSessionView(null, {
        isDead: false,
        hasTranscript: false,
        loaded: true,
        narrow: true,
      }),
    ).toBe("screen");
  });

  it("keeps the terminal for a live session on a wide screen", () => {
    expect(
      resolveSessionView(null, { isDead: false, hasTranscript: true, loaded: true, narrow: false }),
    ).toBe("screen");
  });

  it("treats a finished session the same on a narrow screen", () => {
    expect(
      resolveSessionView(null, { isDead: true, hasTranscript: false, loaded: false, narrow: true }),
    ).toBe(null);
    expect(
      resolveSessionView(null, { isDead: true, hasTranscript: false, loaded: true, narrow: true }),
    ).toBe("screen");
  });
});

describe("canShowChat", () => {
  const agent = (agentType: string, state = "running") => ({
    state,
    spec: { kind: "agent", agent: agentType },
  });

  it("offers Chat once there is a conversation", () => {
    expect(canShowChat({ state: "exited", spec: { kind: "shell" } }, true)).toBe(true);
  });

  it("offers Chat to a live Claude Code or Codex session before its first entry", () => {
    expect(canShowChat(agent("claude-code"), false)).toBe(true);
    expect(canShowChat(agent("codex", "launching"), false)).toBe(true);
  });

  it("doesn't offer Chat to shells, other agents, or a finished empty session", () => {
    expect(canShowChat({ state: "running", spec: { kind: "shell" } }, false)).toBe(false);
    expect(canShowChat(agent("gemini"), false)).toBe(false);
    expect(canShowChat(agent("claude-code", "exited"), false)).toBe(false);
    expect(canShowChat({ state: "running", spec: null }, false)).toBe(false);
  });
});
