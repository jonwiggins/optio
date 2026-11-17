import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api-client";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("signing out", () => {
  it("forgets the stored workspace, so the next user starts in their own", async () => {
    localStorage.setItem("optio_workspace_id", "ws-of-last-user");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    );
    await api.logout();
    expect(localStorage.getItem("optio_workspace_id")).toBeNull();
  });
});
