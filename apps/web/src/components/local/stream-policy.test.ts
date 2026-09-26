import { describe, it, expect } from "vitest";
import {
  closeAction,
  isPointerReport,
  isQueryReply,
  isTerminalStateDead,
  PERMANENT_CLOSE_MESSAGES,
} from "./stream-policy";

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

describe("isQueryReply", () => {
  it("recognises xterm.js answering a program's queries", () => {
    for (const reply of [
      "\x1b[12;40R", // cursor position (CPR)
      "\x1b[?12;40;1R", // DECXCPR
      "\x1b[0n", // device status
      "\x1b[?997;1n", // color-scheme report
      "\x1b[?1;2c", // DA1
      "\x1b[>0;276;0c", // DA2
      "\x1b[?2004;1$y", // DECRQM
      "\x1b[8;24;80t", // window size
      "\x1bP>|xterm.js(5.5.0)\x1b\\", // XTVERSION
      "\x1b]11;rgb:0909/0909/0b0b\x1b\\", // background color
      "\x1b]10;rgb:fafa/fafa/fafa\x07",
      "\x1b[12;40R\x1b[?1;2c", // two at once
    ]) {
      expect(isQueryReply(reply), JSON.stringify(reply)).toBe(true);
    }
  });

  it("never mistakes typing for one", () => {
    for (const key of [
      "a",
      "ls\r",
      "\x1b[A", // ↑
      "\x1b[1;3A", // ⌥↑
      "\x1b[H",
      "\x1b[3~", // delete
      "\x1b\r", // ⇧↩ in agent REPLs
      "\x03",
      "\x1b[200~pasted\x1b[201~",
      "echo \x1b[6n", // text that merely contains an escape
    ]) {
      expect(isQueryReply(key), JSON.stringify(key)).toBe(false);
    }
  });
});

describe("isPointerReport", () => {
  it("recognises mouse and focus reports", () => {
    for (const report of ["\x1b[I", "\x1b[O", "\x1b[<0;10;5M", "\x1b[<35;11;5m", "\x1b[M !!"]) {
      expect(isPointerReport(report), JSON.stringify(report)).toBe(true);
    }
    for (const key of ["\x1b[A", "i", "\x1bOP"]) {
      expect(isPointerReport(key), JSON.stringify(key)).toBe(false);
    }
  });
});
