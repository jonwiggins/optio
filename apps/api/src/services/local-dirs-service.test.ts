import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalHostDir, LocalServerMessage } from "@optio/shared";

const mockSetHostDirs = vi.fn();

vi.mock("./local-host-service.js", () => ({
  setHostDirs: (...args: unknown[]) => mockSetHostDirs(...args),
}));

import {
  HostDirError,
  changeHostDir,
  deliverDirsResult,
  resetDirRequestsForTests,
} from "./local-dirs-service.js";
import {
  hostCanManageDirs,
  registerDaemon,
  resetRelayForTests,
  type RelaySocket,
} from "./local-relay.js";
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
  last(): Extract<LocalServerMessage, { type: "dirs" }> {
    return JSON.parse(this.sent[this.sent.length - 1]);
  }
}

const host = { id: "h1", name: "laptop", userId: "u1" } as LocalHostRow;
const DIRS: LocalHostDir[] = [{ path: "/Users/me/app", repoUrl: "git@github.com:acme/app.git" }];

describe("local-dirs-service", () => {
  beforeEach(() => {
    resetRelayForTests();
    resetDirRequestsForTests();
    mockSetHostDirs.mockReset();
    mockSetHostDirs.mockImplementation(async (id: string, dirs: LocalHostDir[]) => ({
      ...host,
      id,
      dirs,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks the daemon, then mirrors its new list onto the host", async () => {
    const socket = new FakeSocket();
    registerDaemon("h1", "u1", socket, { manageDirs: true });
    expect(hostCanManageDirs("h1")).toBe(true);

    const pending = changeHostDir(host, "add", "~/app");
    const req = socket.last();
    expect(req).toMatchObject({ type: "dirs", op: "add", path: "~/app" });
    expect(
      deliverDirsResult("h1", {
        type: "dirs-result",
        requestId: req.requestId,
        path: "/Users/me/app",
        dirs: DIRS,
      }),
    ).toBe(true);

    const result = await pending;
    expect(result.path).toBe("/Users/me/app");
    expect(result.host.dirs).toEqual(DIRS);
    expect(mockSetHostDirs).toHaveBeenCalledWith("h1", DIRS);
  });

  it("turns the daemon's refusal into a 400 and leaves the host alone", async () => {
    const socket = new FakeSocket();
    registerDaemon("h1", "u1", socket, { manageDirs: true });
    const pending = changeHostDir(host, "remove", "/Users/me/other");
    deliverDirsResult("h1", {
      type: "dirs-result",
      requestId: socket.last().requestId,
      error: "/Users/me/other is not in the allowlist",
    });
    await expect(pending).rejects.toMatchObject({
      status: 400,
      message: "/Users/me/other is not in the allowlist",
    });
    expect(mockSetHostDirs).not.toHaveBeenCalled();
  });

  it("ignores an answer from another host", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    registerDaemon("h1", "u1", socket, { manageDirs: true });
    const pending = changeHostDir(host, "add", "/Users/me/app");
    const settled = expect(pending).rejects.toMatchObject({ status: 504 });
    const requestId = socket.last().requestId;
    expect(deliverDirsResult("h2", { type: "dirs-result", requestId, dirs: [] })).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;
    // The request is gone once it timed out.
    expect(deliverDirsResult("h1", { type: "dirs-result", requestId, dirs: [] })).toBe(false);
  });

  it("refuses up front when the machine is offline or its daemon can't", async () => {
    await expect(changeHostDir(host, "add", "/Users/me/app")).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/offline/),
    });

    registerDaemon("h1", "u1", new FakeSocket()); // an older daemon: no manageDirs
    expect(hostCanManageDirs("h1")).toBe(false);
    const err = await changeHostDir(host, "add", "/Users/me/app").catch((e) => e);
    expect(err).toBeInstanceOf(HostDirError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/optio local add <dir>/);
  });
});
