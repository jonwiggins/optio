import { afterEach, describe, expect, it, vi } from "vitest";
import { isOpenLinkClick, openTerminalLink } from "./terminal-links";

const click = (mods: { metaKey?: boolean; ctrlKey?: boolean } = {}) =>
  ({ metaKey: false, ctrlKey: false, ...mods }) as MouseEvent;

afterEach(() => vi.restoreAllMocks());

describe("isOpenLinkClick", () => {
  it("opens on ⌘-click on a Mac and Ctrl-click elsewhere", () => {
    expect(isOpenLinkClick(click({ metaKey: true }), { mac: true, touchOnly: false })).toBe(true);
    expect(isOpenLinkClick(click({ ctrlKey: true }), { mac: true, touchOnly: false })).toBe(false);
    expect(isOpenLinkClick(click({ ctrlKey: true }), { mac: false, touchOnly: false })).toBe(true);
    expect(isOpenLinkClick(click({ metaKey: true }), { mac: false, touchOnly: false })).toBe(false);
  });

  it("leaves a plain click to the terminal", () => {
    expect(isOpenLinkClick(click(), { mac: true, touchOnly: false })).toBe(false);
  });

  it("opens on a tap where there is no ⌘ to hold", () => {
    expect(isOpenLinkClick(click(), { mac: true, touchOnly: true })).toBe(true);
  });
});

describe("openTerminalLink", () => {
  it("opens web links only, in a new tab, never with a prompt", () => {
    Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const confirm = vi.spyOn(window, "confirm");
    openTerminalLink(click({ metaKey: true }), "https://github.com/acme/app/pull/7");
    expect(open).toHaveBeenCalledWith(
      "https://github.com/acme/app/pull/7",
      "_blank",
      "noopener,noreferrer",
    );
    openTerminalLink(click({ metaKey: true }), "javascript:alert(1)");
    openTerminalLink(click({ metaKey: true }), "file:///etc/passwd");
    openTerminalLink(click(), "https://github.com/acme/app/pull/8");
    expect(open).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });
});
