import { describe, it, expect } from "vitest";
import { isShiftEnter, SHIFT_ENTER_SEQUENCE } from "./conn-state";

const key = (overrides: Partial<Parameters<typeof isShiftEnter>[0]> = {}) => ({
  type: "keydown",
  key: "Enter",
  shiftKey: true,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...overrides,
});

describe("isShiftEnter", () => {
  it("matches the bare Shift+Enter keydown", () => {
    expect(isShiftEnter(key())).toBe(true);
  });

  it("ignores keyup and keypress so the chord fires once", () => {
    expect(isShiftEnter(key({ type: "keyup" }))).toBe(false);
    expect(isShiftEnter(key({ type: "keypress" }))).toBe(false);
  });

  it("leaves plain Enter to xterm", () => {
    expect(isShiftEnter(key({ shiftKey: false }))).toBe(false);
  });

  it("leaves the rail's Ctrl/⌘+Shift+Enter chord alone", () => {
    expect(isShiftEnter(key({ ctrlKey: true }))).toBe(false);
    expect(isShiftEnter(key({ metaKey: true }))).toBe(false);
    expect(isShiftEnter(key({ altKey: true }))).toBe(false);
  });

  it("sends ESC CR, the sequence `claude /terminal-setup` installs", () => {
    expect(SHIFT_ENTER_SEQUENCE).toBe("\x1b\r");
  });
});
