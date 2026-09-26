import { describe, expect, it } from "vitest";
import { OSC52_MAX_BYTES, parseOsc52 } from "./terminal-clipboard";

const b64 = (text: string) => Buffer.from(text, "utf-8").toString("base64");

describe("parseOsc52", () => {
  it("reads the text a program copies, whichever selection it names", () => {
    expect(parseOsc52(`c;${b64("npm test")}`)).toBe("npm test");
    expect(parseOsc52(`;${b64("empty selection means the clipboard")}`)).toBe(
      "empty selection means the clipboard",
    );
    expect(parseOsc52(`p;${b64("primary")}`)).toBe("primary");
    // UTF-8, line breaks, and base64 wrapped across lines.
    expect(parseOsc52(`c;${b64("héllo ✓\nline two")}`)).toBe("héllo ✓\nline two");
    const wrapped = b64("a longer line that some programs wrap").replace(/(.{8})/g, "$1\n");
    expect(parseOsc52(`c;${wrapped}`)).toBe("a longer line that some programs wrap");
  });

  it("never answers a read, and ignores clears and garbage", () => {
    expect(parseOsc52("c;?")).toBeNull();
    expect(parseOsc52("c;")).toBeNull();
    expect(parseOsc52("c")).toBeNull();
    expect(parseOsc52("c;not base64!")).toBeNull();
    expect(parseOsc52("c;====")).toBeNull();
  });

  it("refuses more than the limit", () => {
    expect(parseOsc52(`c;${b64("x".repeat(OSC52_MAX_BYTES))}`)).toBe("x".repeat(OSC52_MAX_BYTES));
    expect(parseOsc52(`c;${b64("x".repeat(OSC52_MAX_BYTES + 3))}`)).toBeNull();
  });
});
