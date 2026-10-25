import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { SettingsLayout } from "./settings-layout";

// jsdom has neither observer; the layout's resize follow is driven by hand.
let resize: (() => void) | null = null;
const scrolled: string[] = [];

beforeEach(() => {
  scrolled.length = 0;
  resize = null;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        resize = cb;
      }
      observe() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.id);
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const sections = [
  { id: "agents", title: "Agents", description: "a", content: <div>agents</div> },
  {
    id: "access",
    title: "Access",
    description: "b",
    content: <div id="sign-in">Sign-in card</div>,
  },
  { id: "integrations", title: "Integrations", description: "c", content: <div>i</div> },
];

describe("SettingsLayout deep links", () => {
  it("scrolls to the section in the URL and keeps it there while cards above load", () => {
    window.history.replaceState(null, "", "/settings#integrations");
    const { getByRole } = render(<SettingsLayout sections={sections} />);
    expect(scrolled).toEqual(["integrations"]);
    expect(getByRole("link", { name: "Integrations" })).toHaveAttribute("aria-current", "location");

    // Earlier cards replace their skeletons: the section is aligned again.
    act(() => resize?.());
    expect(scrolled).toEqual(["integrations", "integrations"]);

    // The person scrolls: the layout stops following.
    fireEvent.wheel(window);
    act(() => resize?.());
    expect(scrolled).toEqual(["integrations", "integrations"]);
  });

  it("follows a card's id, such as #sign-in", () => {
    window.history.replaceState(null, "", "/settings#sign-in");
    render(<SettingsLayout sections={sections} />);
    expect(scrolled).toEqual(["sign-in"]);
  });

  it("follows a later hash change", () => {
    render(<SettingsLayout sections={sections} />);
    expect(scrolled).toEqual([]);
    window.history.replaceState(null, "", "/settings#access");
    act(() => {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(scrolled).toEqual(["access"]);
  });

  it("does nothing without a hash", () => {
    render(<SettingsLayout sections={sections} />);
    act(() => resize?.());
    expect(scrolled).toEqual([]);
  });
});
