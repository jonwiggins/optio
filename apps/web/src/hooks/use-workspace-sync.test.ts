import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useWorkspaceSync } from "./use-workspace-sync";

const reload = vi.fn();

afterEach(() => {
  cleanup();
  reload.mockReset();
});

function storage(key: string, oldValue: string | null, newValue: string | null) {
  window.dispatchEvent(new StorageEvent("storage", { key, oldValue, newValue }));
}

describe("useWorkspaceSync", () => {
  it("reloads the tab when another tab switches the workspace", () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });
    renderHook(() => useWorkspaceSync());
    storage("optio_workspace_id", "ws-a", "ws-b");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("ignores other keys and writes that change nothing", () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });
    renderHook(() => useWorkspaceSync());
    storage("optio_theme", "light", "dark");
    storage("optio_workspace_id", "ws-a", "ws-a");
    expect(reload).not.toHaveBeenCalled();
  });
});
