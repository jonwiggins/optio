import { afterEach, describe, expect, it, vi } from "vitest";
import { listenWsApp, WsTestClient } from "../test-utils/integration/ws-client.js";
import { optioChatWs } from "./optio-chat.js";
import { ensureOptioSession } from "../services/session-harness-service.js";
import { attachHarnessChat } from "./harness-session-chat.js";
import { requireWsRole } from "./ws-authz.js";
vi.mock("./ws-auth.js", () => ({
  authenticateWs: vi.fn().mockResolvedValue({
    id: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
  }),
}));
vi.mock("./ws-authz.js", () => ({ requireWsRole: vi.fn().mockResolvedValue(true) }));
vi.mock("../services/session-harness-service.js", () => ({
  ensureOptioSession: vi.fn().mockResolvedValue({ id: "session-1" }),
}));
vi.mock("./harness-session-chat.js", () => ({
  attachHarnessChat: vi.fn(async (socket) =>
    socket.send(JSON.stringify({ type: "status", status: "ready" })),
  ),
}));
afterEach(() => vi.clearAllMocks());
describe("Ask Optio session view", () => {
  it("opens an ordinary session and delegates to its shared harness chat", async () => {
    const { app, wsBase } = await listenWsApp([optioChatWs]);
    const client = new WsTestClient(`${wsBase}/ws/optio/chat`);
    try {
      await client.next((f) => f.status === "ready");
      expect(ensureOptioSession).toHaveBeenCalledWith(
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      );
      expect(attachHarnessChat).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "session-1",
        expect.any(Function),
        true,
      );
    } finally {
      await client.close();
      await app.close();
    }
  });
  it("does not create work for a denied workspace member", async () => {
    vi.mocked(requireWsRole).mockImplementationOnce(async (socket) => {
      socket.close(4403);
      return false;
    });
    const { app, wsBase } = await listenWsApp([optioChatWs]);
    const client = new WsTestClient(`${wsBase}/ws/optio/chat`);
    try {
      await client.closed;
      expect(ensureOptioSession).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await app.close();
    }
  });
});
