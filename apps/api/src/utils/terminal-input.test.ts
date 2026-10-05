import { describe, expect, it } from "vitest";
import { splitSubmit } from "./terminal-input.js";

describe("splitSubmit", () => {
  it("separates a message from the Enter that submits it", () => {
    expect(splitSubmit("tell me a story\r")).toEqual(["tell me a story", "\r"]);
    expect(splitSubmit("ls\n")).toEqual(["ls", "\n"]);
    expect(splitSubmit("two\nlines\r\n")).toEqual(["two\nlines", "\r\n"]);
  });

  it("leaves a bare Enter and text without one alone", () => {
    expect(splitSubmit("\r")).toEqual(["\r"]);
    expect(splitSubmit("y")).toEqual(["y"]);
    expect(splitSubmit("")).toEqual([""]);
    expect(splitSubmit("\x1b[A")).toEqual(["\x1b[A"]);
  });
});
