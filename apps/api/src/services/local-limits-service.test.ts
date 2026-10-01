import { afterEach, describe, expect, it, vi } from "vitest";

const mockHandleAgentLimits = vi.fn();

vi.mock("./local-host-service.js", () => ({
  handleAgentLimits: (...args: unknown[]) => mockHandleAgentLimits(...args),
}));

import {
  LimitsRefreshError,
  deliverLimitsResult,
  refreshHostLimits,
} from "./local-limits-service.js";
import { registerDaemon, resetRelayForTests, type RelaySocket } from "./local-relay.js";
import type { LocalHostRow } from "./local-host-service.js";

class FakeSocket implements RelaySocket {
  readyState = 1;
  sent: string[] = [];
  send(data: string | Buffer) {
    if (typeof data === "string") this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
}

const host = { id: "h1", name: "laptop", userId: "u1" } as LocalHostRow;
const codex = {
  primary: { usedPercent: 10, windowMinutes: 300, resetsAt: null },
  secondary: null,
  planType: "pro",
  observedAt: "2026-10-01T00:00:00.000Z",
};

describe("refreshHostLimits", () => {
  afterEach(() => {
    resetRelayForTests();
    mockHandleAgentLimits.mockReset();
  });

  it("asks a capable daemon and stores what it answers", async () => {
    const socket = new FakeSocket();
    registerDaemon("h1", "u1", socket, { refreshLimits: true });
    const pending = refreshHostLimits(host);
    const req = JSON.parse(socket.sent[0]);
    expect(req.type).toBe("limits-refresh");
    // Another host can't answer for it.
    expect(
      deliverLimitsResult("h2", { type: "limits-refresh-result", requestId: req.requestId }),
    ).toBe(false);
    deliverLimitsResult("h1", {
      type: "limits-refresh-result",
      requestId: req.requestId,
      limits: { codex },
    });
    await expect(pending).resolves.toEqual({ codex });
    expect(mockHandleAgentLimits).toHaveBeenCalledWith("h1", { codex });
  });

  it("passes Codex's reason through and refuses older or offline daemons", async () => {
    const socket = new FakeSocket();
    registerDaemon("h1", "u1", socket, { refreshLimits: true });
    const pending = refreshHostLimits(host);
    const req = JSON.parse(socket.sent[0]);
    deliverLimitsResult("h1", {
      type: "limits-refresh-result",
      requestId: req.requestId,
      error: "Codex isn't signed in on this machine",
    });
    await expect(pending).rejects.toMatchObject({ status: 502 });

    resetRelayForTests();
    registerDaemon("h1", "u1", new FakeSocket(), {});
    await expect(refreshHostLimits(host)).rejects.toBeInstanceOf(LimitsRefreshError);
    resetRelayForTests();
    await expect(refreshHostLimits(host)).rejects.toMatchObject({ status: 409 });
  });
});
