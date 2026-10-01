import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CHAT_DISPLAY,
  clampChatFontSize,
  normalizeChatWidth,
  readChatDisplay,
  stepChatFontSize,
  stepChatWidth,
  useChatDisplayStore,
} from "./chat-display-store";

const KEY = "optio.chat.display";

describe("chat-display-store", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useChatDisplayStore.setState({ ...DEFAULT_CHAT_DISPLAY, hydrated: false });
  });
  afterEach(() => vi.restoreAllMocks());

  it("clamps font sizes to the nearest step and rejects junk", () => {
    expect(clampChatFontSize(13)).toBe(13);
    expect(clampChatFontSize(4)).toBe(12);
    expect(clampChatFontSize(99)).toBe(20);
    expect(clampChatFontSize(17.2)).toBe(18);
    expect(clampChatFontSize("16")).toBe(13);
    expect(clampChatFontSize(NaN)).toBe(13);
    expect(normalizeChatWidth("wide")).toBe("wide");
    expect(normalizeChatWidth("huge")).toBe("medium");
  });

  it("steps stop at the ends", () => {
    expect(stepChatFontSize(13, 1)).toBe(14);
    expect(stepChatFontSize(16, 1)).toBe(18);
    expect(stepChatFontSize(20, 1)).toBe(20);
    expect(stepChatFontSize(12, -1)).toBe(12);
    expect(stepChatWidth("medium", 1)).toBe("wide");
    expect(stepChatWidth("full", 1)).toBe("full");
    expect(stepChatWidth("narrow", -1)).toBe("narrow");
  });

  it("persists changes and hydrates them back", () => {
    const s = useChatDisplayStore.getState();
    s.stepFontSize(1);
    s.stepWidth(1);
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual({ fontSize: 14, width: "wide" });

    useChatDisplayStore.setState({ ...DEFAULT_CHAT_DISPLAY, hydrated: false });
    useChatDisplayStore.getState().hydrate();
    expect(useChatDisplayStore.getState()).toMatchObject({ fontSize: 14, width: "wide" });

    useChatDisplayStore.getState().reset();
    expect(useChatDisplayStore.getState()).toMatchObject(DEFAULT_CHAT_DISPLAY);
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual(DEFAULT_CHAT_DISPLAY);
  });

  it("sanitizes stored values", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ fontSize: 400, width: "giant" }));
    expect(readChatDisplay()).toEqual({ fontSize: 20, width: "medium" });
    window.localStorage.setItem(KEY, "{not json");
    expect(readChatDisplay()).toEqual(DEFAULT_CHAT_DISPLAY);
  });

  it("works without storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    useChatDisplayStore.getState().hydrate();
    expect(useChatDisplayStore.getState()).toMatchObject(DEFAULT_CHAT_DISPLAY);
    useChatDisplayStore.getState().stepFontSize(1);
    expect(useChatDisplayStore.getState().fontSize).toBe(14);
  });
});
