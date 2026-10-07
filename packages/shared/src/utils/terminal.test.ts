import { describe, expect, it } from "vitest";
import {
  isTerminalTyping,
  TERMINAL_THEME,
  hexToRgb,
  isTerminalQueryReply,
  terminalPaletteColor,
  xParseColor,
} from "./terminal.js";

describe("isTerminalQueryReply", () => {
  it("recognises an emulator answering a program's queries", () => {
    for (const reply of [
      "\x1b[12;40R", // cursor position (CPR)
      "\x1b[1;1R", // Codex's startup CPR
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
      expect(isTerminalQueryReply(reply), JSON.stringify(reply)).toBe(true);
    }
  });

  it("never mistakes typing for one", () => {
    for (const key of [
      "a",
      "ls\r",
      "\x1b[A", // ↑
      "\x1b[1;3A", // ⌥↑
      "\x1b[1;5R", // ⌃F3 (the shape of a cursor position on row 1)
      "\x1b[1;2R", // ⇧F3
      "\x1b[H",
      "\x1b[3~", // delete
      "\x1b\r", // ⇧↩ in agent REPLs
      "\x03",
      "\x1b[200~pasted\x1b[201~",
      "echo \x1b[6n", // text that merely contains an escape
      "\x1b[I", // focus in
    ]) {
      expect(isTerminalQueryReply(key), JSON.stringify(key)).toBe(false);
    }
  });
});

describe("terminal colors", () => {
  it("reports the theme in the form terminals answer with", () => {
    expect(xParseColor(hexToRgb(TERMINAL_THEME.background))).toBe("rgb:0909/0909/0b0b");
    expect(xParseColor(hexToRgb(TERMINAL_THEME.foreground))).toBe("rgb:fafa/fafa/fafa");
  });

  it("covers the whole 256-color palette", () => {
    expect(terminalPaletteColor(1)).toEqual(hexToRgb(TERMINAL_THEME.red));
    expect(terminalPaletteColor(15)).toEqual(hexToRgb(TERMINAL_THEME.brightWhite));
    expect(terminalPaletteColor(16)).toEqual([0, 0, 0]);
    expect(terminalPaletteColor(196)).toEqual([255, 0, 0]);
    expect(terminalPaletteColor(231)).toEqual([255, 255, 255]);
    expect(terminalPaletteColor(232)).toEqual([8, 8, 8]);
    expect(terminalPaletteColor(255)).toEqual([238, 238, 238]);
  });

  it("keeps black and white apart from the background and foreground", () => {
    expect(TERMINAL_THEME.black).not.toBe(TERMINAL_THEME.background);
    expect(TERMINAL_THEME.white).not.toBe(TERMINAL_THEME.foreground);
  });
});

describe("isTerminalTyping", () => {
  it("does not count what the emulator sends on its own", () => {
    for (const data of [
      "\x1b[I", // focus in: what a click into the session produces
      "\x1b[O", // focus out
      "\x1b[<0;10;5M", // SGR mouse press
      "\x1b[<0;10;5m", // SGR mouse release
      "\x1b[M !!", // X10 mouse
      "\x1b[?1;2c", // DA1 reply
      "\x1b[0n", // DSR reply
      "\x1b[24;80R", // cursor position report
      "\x1b[I\x1b[<0;10;5M", // several in one frame
      "",
    ]) {
      expect(isTerminalTyping(data), JSON.stringify(data)).toBe(false);
    }
  });

  it("counts keystrokes, including escape-prefixed keys and pastes", () => {
    for (const data of [
      "a",
      "\r",
      "\x1b[A", // arrow up
      "\x1b[1;5R", // ⌃F3, the same bytes as a cursor report on row 1
      "\x1b[200~hello\x1b[201~", // bracketed paste
      "\x1b", // a lone Escape
      "y\x1b[I", // typed, then a focus report: still typing
    ]) {
      expect(isTerminalTyping(data), JSON.stringify(data)).toBe(true);
    }
  });
});
