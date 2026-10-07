import { describe, expect, it } from "vitest";
import { describeError } from "./error-message.js";

describe("describeError", () => {
  it("gives an Error's message, keeping a specific name", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
    class StateRaceError extends Error {
      constructor() {
        super("expected a → b");
        this.name = "StateRaceError";
      }
    }
    expect(describeError(new StateRaceError())).toBe("StateRaceError: expected a → b");
    expect(describeError(new TypeError("bad"))).toBe("TypeError: bad");
  });

  it("passes a string through", () => {
    expect(describeError("plain")).toBe("plain");
  });

  it("unwraps a WebSocket ErrorEvent (what the Kubernetes exec rejects with)", () => {
    const error = new Error("Unexpected server response: 500");
    const event = { type: "error", error, message: error.message, target: {} };
    expect(describeError(event)).toBe("Unexpected server response: 500");
    expect(String(event)).toBe("[object Object]");
  });

  it("reads a message field, or an API exception's body", () => {
    expect(describeError({ message: "nope" })).toBe("nope");
    expect(describeError({ statusCode: 404, body: { message: 'pods "x" not found' } })).toBe(
      'pods "x" not found',
    );
    expect(describeError({ statusCode: 500, body: "upstream exploded" })).toBe("upstream exploded");
  });

  it("falls back to JSON for other objects, and String() for the rest", () => {
    expect(describeError({ code: 7 })).toBe('{"code":7}');
    expect(describeError(null)).toBe("null");
    expect(describeError(undefined)).toBe("undefined");
    expect(describeError(42)).toBe("42");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(describeError(circular)).toBe("[object Object]");
  });
});
