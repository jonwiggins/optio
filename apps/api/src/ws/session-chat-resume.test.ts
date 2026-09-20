import { describe, it, expect } from "vitest";
import {
  CHAT_EXIT_SENTINEL,
  buildClaudeChatCommand,
  extractSessionIdFromLine,
  inspectClaudeLine,
  parseExitSentinel,
  shouldFallbackToFreshSession,
} from "./session-chat-resume.js";

/** Verbatim shape claude prints after a failed `--resume` (before the sentinel). */
const RESUME_FAILED_TEXT =
  "No conversation found with session ID: 00000000-0000-4000-8000-000000000bad";
const RESUME_FAILED_RESULT = JSON.stringify({
  type: "result",
  subtype: "error_during_execution",
  duration_ms: 0,
  is_error: true,
  num_turns: 0,
  session_id: "ecf6b7ef-4234-459f-9a2e-37248e390d7d",
  total_cost_usd: 0,
});

describe("buildClaudeChatCommand", () => {
  it("builds a fresh one-shot run without --resume", () => {
    const cmd = buildClaudeChatCommand({ prompt: "hello", model: "sonnet" });
    expect(cmd).toContain("claude -p 'hello' --model 'sonnet' --output-format stream-json");
    expect(cmd).toContain("--verbose --dangerously-skip-permissions < /dev/null");
    expect(cmd).not.toContain("--resume");
    expect(cmd).toContain(`echo "${CHAT_EXIT_SENTINEL}$rc"`);
  });

  it("passes --resume <id> when a session id is known", () => {
    const cmd = buildClaudeChatCommand({
      prompt: "again",
      model: "opus",
      resumeSessionId: "abc-123",
    });
    expect(cmd).toContain("--resume 'abc-123'");
    // Model and resume coexist so set_model mid-conversation keeps the session.
    expect(cmd).toContain("--model 'opus'");
  });

  it("omits --model when none is set", () => {
    expect(buildClaudeChatCommand({ prompt: "x", model: null })).not.toContain("--model");
  });

  it("single-quotes the prompt and session id so shell metacharacters are inert", () => {
    const cmd = buildClaudeChatCommand({
      prompt: "it's $(rm -rf /) `x`",
      resumeSessionId: "id'; echo pwned; '",
    });
    expect(cmd).toContain(`-p 'it'\\''s $(rm -rf /) \`x\`'`);
    expect(cmd).toContain(`--resume 'id'\\''; echo pwned; '\\'''`);
  });

  it("does not abort the script on a non-zero exit (captures it in the sentinel instead)", () => {
    const cmd = buildClaudeChatCommand({ prompt: "x" });
    expect(cmd.startsWith("rc=0; claude")).toBe(true);
    expect(cmd).toContain("|| rc=$?");
  });
});

describe("parseExitSentinel", () => {
  it("returns the exit code for a sentinel line", () => {
    expect(parseExitSentinel(`${CHAT_EXIT_SENTINEL}0`)).toBe(0);
    expect(parseExitSentinel(`  ${CHAT_EXIT_SENTINEL}1\n`)).toBe(1);
  });

  it("returns null for ordinary output", () => {
    expect(parseExitSentinel('{"type":"result"}')).toBeNull();
    expect(parseExitSentinel(RESUME_FAILED_TEXT)).toBeNull();
  });

  it("treats a malformed sentinel as a failure", () => {
    expect(parseExitSentinel(`${CHAT_EXIT_SENTINEL}garbage`)).toBe(1);
  });
});

describe("inspectClaudeLine", () => {
  it("recognises the init event and its session id", () => {
    const info = inspectClaudeLine(
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1", tools: [] }),
    );
    expect(info).toEqual({ isInit: true, isErrorResult: false, sessionId: "sess-1" });
  });

  it("recognises the error result a failed resume emits", () => {
    const info = inspectClaudeLine(RESUME_FAILED_RESULT);
    expect(info.isInit).toBe(false);
    expect(info.isErrorResult).toBe(true);
    expect(info.sessionId).toBe("ecf6b7ef-4234-459f-9a2e-37248e390d7d");
  });

  it("treats raw text and malformed JSON as non-events", () => {
    expect(inspectClaudeLine(RESUME_FAILED_TEXT)).toEqual({ isInit: false, isErrorResult: false });
    expect(inspectClaudeLine("{not json")).toEqual({ isInit: false, isErrorResult: false });
    expect(inspectClaudeLine("")).toEqual({ isInit: false, isErrorResult: false });
  });

  it("does not flag a successful result as an error", () => {
    const info = inspectClaudeLine(
      JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "s" }),
    );
    expect(info.isErrorResult).toBe(false);
  });
});

describe("extractSessionIdFromLine", () => {
  it("captures session_id from the init event", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "sess-init-1",
      model: "claude-sonnet-4-5",
      tools: [],
    });
    expect(extractSessionIdFromLine(line)).toBe("sess-init-1");
  });

  it("ignores the fresh session_id on a failed-resume error result", () => {
    // Remembering this id would make the *next* resume fail too.
    expect(extractSessionIdFromLine(RESUME_FAILED_RESULT)).toBeUndefined();
  });

  it("ignores later events, raw text and events without a session id", () => {
    expect(
      extractSessionIdFromLine(
        JSON.stringify({ type: "result", subtype: "success", session_id: "sess-2" }),
      ),
    ).toBeUndefined();
    expect(extractSessionIdFromLine(RESUME_FAILED_TEXT)).toBeUndefined();
    expect(extractSessionIdFromLine(JSON.stringify({ type: "rate_limit_event" }))).toBeUndefined();
    expect(extractSessionIdFromLine("")).toBeUndefined();
  });
});

describe("shouldFallbackToFreshSession", () => {
  const base = {
    resumed: true,
    exitCode: 0,
    sawInit: false,
    sawErrorResult: false,
    rawOutput: "",
  };

  it("never falls back for a fresh (non-resumed) turn", () => {
    expect(
      shouldFallbackToFreshSession({
        ...base,
        resumed: false,
        exitCode: 1,
        sawErrorResult: true,
        rawOutput: RESUME_FAILED_TEXT,
      }),
    ).toBe(false);
  });

  it("falls back on the exact output claude prints for a missing session", () => {
    expect(
      shouldFallbackToFreshSession({
        ...base,
        exitCode: 1,
        sawErrorResult: true,
        rawOutput: RESUME_FAILED_TEXT + "\n",
      }),
    ).toBe(true);
  });

  it("falls back on a known message even if the exit code was not captured", () => {
    expect(
      shouldFallbackToFreshSession({
        ...base,
        exitCode: null,
        rawOutput: "Error: Session abc not found",
      }),
    ).toBe(true);
  });

  it("falls back on an error result with no init, even with an unknown message", () => {
    expect(shouldFallbackToFreshSession({ ...base, exitCode: null, sawErrorResult: true })).toBe(
      true,
    );
  });

  it("falls back on a non-zero exit with no init (unknown message)", () => {
    expect(shouldFallbackToFreshSession({ ...base, exitCode: 1, rawOutput: "something odd" })).toBe(
      true,
    );
  });

  it("does not fall back once the resumed turn reached the init event", () => {
    expect(
      shouldFallbackToFreshSession({
        ...base,
        sawInit: true,
        sawErrorResult: true,
        exitCode: 1,
        rawOutput: "No conversation found",
      }),
    ).toBe(false);
  });

  it("does not fall back on a clean, init-less exit", () => {
    expect(shouldFallbackToFreshSession({ ...base, exitCode: 0 })).toBe(false);
    expect(shouldFallbackToFreshSession({ ...base, exitCode: null })).toBe(false);
  });
});
