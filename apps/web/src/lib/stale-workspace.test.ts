import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api-client";

const reload = vi.fn();

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, reload },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  reload.mockReset();
  localStorage.clear();
});

function refuse(error: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error }) }),
  );
}

describe("a stored workspace the user is no longer in", () => {
  it("is forgotten, and the page starts over in the server's workspace", async () => {
    localStorage.setItem("optio_workspace_id", "gone");
    refuse("Forbidden: not a member of requested workspace");
    await expect(api.listTasks()).rejects.toThrow();
    expect(localStorage.getItem("optio_workspace_id")).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("is kept on any other refusal", async () => {
    localStorage.setItem("optio_workspace_id", "ws-1");
    refuse("Requires admin role");
    await expect(api.listTasks()).rejects.toThrow();
    expect(localStorage.getItem("optio_workspace_id")).toBe("ws-1");
    expect(reload).not.toHaveBeenCalled();
  });
});
