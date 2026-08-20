import { describe, it, expect } from "vitest";
import { closeAction, isTerminalStateDead, PERMANENT_CLOSE_MESSAGES } from "./stream-policy";

describe("closeAction", () => {
  it("reconnects on 4503 (host disconnected — the daemon will be back)", () => {
    expect(closeAction({ code: 4503, terminalDead: false, retryRequested: false })).toEqual({
      kind: "reconnect",
    });
  });

  it("reconnects on abnormal closes (1006) and 1001 going-away", () => {
    for (const code of [1001, 1006]) {
      expect(closeAction({ code, terminalDead: false, retryRequested: false })).toEqual({
        kind: "reconnect",
      });
    }
  });

  it("stops with a message on permanent rejections (4401/4403/4429)", () => {
    for (const code of [4401, 4403, 4429]) {
      expect(closeAction({ code, terminalDead: false, retryRequested: false })).toEqual({
        kind: "stop",
        message: PERMANENT_CLOSE_MESSAGES[code],
      });
    }
  });

  it("permanent rejections win even when a retry was requested", () => {
    expect(closeAction({ code: 4403, terminalDead: false, retryRequested: true })).toEqual({
      kind: "stop",
      message: PERMANENT_CLOSE_MESSAGES[4403],
    });
  });

  it("never reconnects once the terminal has exited/errored (history stays)", () => {
    for (const code of [1000, 1006, 4503]) {
      expect(closeAction({ code, terminalDead: true, retryRequested: false })).toEqual({
        kind: "stop",
        message: null,
      });
    }
  });

  it("does not loop on deliberate normal closes (1000/1005)", () => {
    for (const code of [1000, 1005]) {
      expect(closeAction({ code, terminalDead: false, retryRequested: false })).toEqual({
        kind: "stop",
        message: null,
      });
    }
  });

  it("a self-initiated retry close (code 1000) still reconnects", () => {
    expect(closeAction({ code: 1000, terminalDead: false, retryRequested: true })).toEqual({
      kind: "reconnect",
    });
  });
});

describe("isTerminalStateDead", () => {
  it("only exited/error are dead", () => {
    expect(isTerminalStateDead("exited")).toBe(true);
    expect(isTerminalStateDead("error")).toBe(true);
    expect(isTerminalStateDead("running")).toBe(false);
    expect(isTerminalStateDead("launching")).toBe(false);
    expect(isTerminalStateDead("pending")).toBe(false);
  });
});
