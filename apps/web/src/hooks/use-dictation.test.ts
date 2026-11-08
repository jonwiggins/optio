import { act, renderHook, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDictation } from "./use-dictation";

class Recognition {
  static latest: Recognition;
  continuous = false;
  interimResults = false;
  lang = "";
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onresult:
    ((event: { results: Array<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null =
    null;
  constructor() {
    Recognition.latest = this;
  }
  start = vi.fn(() => this.onstart?.());
  stop = vi.fn();
  abort = vi.fn();
  result(...words: Array<[string, boolean]>) {
    this.onresult?.({
      results: words.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } })),
    });
  }
}
beforeEach(() => {
  vi.stubGlobal("SpeechRecognition", Recognition);
  vi.stubGlobal("isSecureContext", true);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("dictation draft", () => {
  it("keeps interim words separate and commits each final result once", () => {
    const append = vi.fn();
    const { result } = renderHook(() => useDictation(append));
    act(() => result.current.start());
    act(() => Recognition.latest.result(["Start", false]));
    expect(result.current.interim).toBe("Start");
    expect(append).not.toHaveBeenCalled();
    act(() => Recognition.latest.result(["Start Codex", true], ["on my", false]));
    act(() => Recognition.latest.result(["Start Codex", true], ["on my Mac", true]));
    expect(append.mock.calls).toEqual([["Start Codex"], ["on my Mac"]]);
  });
  it("waits for the final words after stop", () => {
    const append = vi.fn();
    const { result } = renderHook(() => useDictation(append));
    act(() => result.current.start());
    act(() => result.current.stop());
    expect(result.current.state).toBe("stopping");
    act(() => Recognition.latest.result(["fix the login", true]));
    act(() => Recognition.latest.onend?.());
    expect(append).toHaveBeenCalledWith("fix the login");
    expect(result.current.active).toBe(false);
  });
  it("aborts on cancel/unmount and ignores late callbacks", () => {
    const append = vi.fn();
    const { result, unmount } = renderHook(() => useDictation(append));
    act(() => result.current.start());
    act(() => result.current.cancel());
    expect(Recognition.latest.abort).toHaveBeenCalledOnce();
    act(() => Recognition.latest.result(["late", true]));
    expect(append).not.toHaveBeenCalled();
    act(() => result.current.start());
    unmount();
    expect(Recognition.latest.abort).toHaveBeenCalledOnce();
  });
  it("reports denied permissions and lets the user retry", () => {
    const { result } = renderHook(() => useDictation(vi.fn()));
    act(() => result.current.start());
    act(() => Recognition.latest.onerror?.({ error: "not-allowed" }));
    expect(result.current.error).toContain("denied");
    expect(result.current.active).toBe(false);
    act(() => result.current.start());
    expect(result.current.error).toBeNull();
    expect(result.current.state).toBe("listening");
  });
  it("does not enable dictation on an insecure origin", () => {
    vi.stubGlobal("isSecureContext", false);
    const { result } = renderHook(() => useDictation(vi.fn()));
    expect(result.current.supported).toBe(false);
  });
  it("explains a click in a browser without recognition", () => {
    vi.stubGlobal("SpeechRecognition", undefined);
    vi.stubGlobal("webkitSpeechRecognition", undefined);
    const { result } = renderHook(() => useDictation(vi.fn()));
    act(() => result.current.start());
    expect(result.current.error).toContain("doesn’t provide speech recognition");
    expect(result.current.active).toBe(false);
  });
  it("reports a speech service that silently ends without starting", () => {
    const { result } = renderHook(() => useDictation(vi.fn()));
    act(() => result.current.start());
    act(() => Recognition.latest.onend?.());
    expect(result.current.error).toContain("ended without any text");
    expect(result.current.active).toBe(false);
  });
  it("reports a service failure separately from microphone permission", () => {
    const { result } = renderHook(() => useDictation(vi.fn()));
    act(() => result.current.start());
    act(() => Recognition.latest.onerror?.({ error: "service-not-allowed" }));
    expect(result.current.error).toContain("service is unavailable or disabled");
    expect(result.current.error).not.toContain("access was denied");
  });
  it("times out when the browser never starts and detaches late events", () => {
    vi.useFakeTimers();
    class SilentRecognition extends Recognition {
      override start = vi.fn();
    }
    vi.stubGlobal("SpeechRecognition", SilentRecognition);
    const { result } = renderHook(() => useDictation(vi.fn()));
    act(() => result.current.start());
    expect(result.current.state).toBe("starting");
    act(() => vi.advanceTimersByTime(15000));
    expect(result.current.error).toContain("microphone didn’t start");
    expect(result.current.active).toBe(false);
    expect(Recognition.latest.onstart).toBeNull();
  });
  it("times out after listening without any speech results", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useDictation(vi.fn()));
    act(() => result.current.start());
    act(() => vi.advanceTimersByTime(30000));
    expect(result.current.error).toContain("No speech reached");
    expect(result.current.active).toBe(false);
  });
  it("preserves the stop timeout if final words arrive without an end event", () => {
    vi.useFakeTimers();
    const append = vi.fn();
    const { result } = renderHook(() => useDictation(append));
    act(() => result.current.start());
    act(() => result.current.stop());
    act(() => Recognition.latest.result(["captured words", true]));
    act(() => vi.advanceTimersByTime(5000));
    expect(append).toHaveBeenCalledWith("captured words");
    expect(result.current.error).toContain("didn’t finish");
    expect(result.current.active).toBe(false);
  });
});
