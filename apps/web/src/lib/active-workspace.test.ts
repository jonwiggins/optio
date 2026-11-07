import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api-client";
import { WsClient } from "./ws-client";

const WS = "22222222-2222-4222-8222-222222222222";

function clearCookie() {
  document.cookie = "optio_workspace=; path=/; max-age=0";
}

describe("sockets follow the workspace the page uses", () => {
  beforeEach(() => {
    clearCookie();
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    clearCookie();
  });

  it("keeps the optio_workspace cookie equal to the workspace API calls send", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ tasks: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    localStorage.setItem("optio_workspace_id", WS);
    await api.listTasks();
    expect(fetchMock.mock.calls[0][1].headers["x-workspace-id"]).toBe(WS);
    expect(document.cookie).toContain(`optio_workspace=${WS}`);

    // No stored workspace: no header, and no stale cookie for the API to fall back on.
    localStorage.removeItem("optio_workspace_id");
    await api.listTasks();
    expect(document.cookie).not.toContain("optio_workspace=");
  });

  it("names the workspace on a token-authenticated socket", async () => {
    const opened: Array<string[] | undefined> = [];
    class FakeSocket {
      static OPEN = 1;
      readyState = 0;
      constructor(_url: string, protocols?: string[]) {
        opened.push(protocols);
      }
      close() {}
    }
    vi.stubGlobal("WebSocket", FakeSocket);
    localStorage.setItem("optio_workspace_id", WS);
    const client = new WsClient("ws://localhost/ws/events", async () => "tok");
    client.connect();
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toEqual(["optio-ws-v1", "optio-auth-tok", `optio-workspace-${WS}`]);
    client.disconnect();
  });
});
