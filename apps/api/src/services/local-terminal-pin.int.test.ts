/**
 * Pinned sessions against a real database: a pin is kept on the terminal row,
 * is idempotent, and clears on unpin.
 */
import { beforeEach, describe, expect, it } from "vitest";
import * as relay from "./local-relay.js";
import { registerHost } from "./local-host-service.js";
import {
  createTerminal,
  getTerminal,
  pinTerminal,
  unpinTerminal,
} from "./local-terminal-service.js";

async function makeHost() {
  return registerHost({
    userId: null,
    workspaceId: null,
    hostname: `pin-host-${Math.random().toString(36).slice(2, 8)}`,
    platform: "darwin",
    arch: "arm64",
    daemonVersion: "0.1.0",
    dirs: [{ path: "/home/dev/scratch" }],
  });
}

beforeEach(() => relay.resetRelayForTests());

describe("pinned sessions", () => {
  it("pins once, keeps the first pin time, and clears on unpin", async () => {
    const host = await makeHost();
    const row = await createTerminal({
      host,
      userId: null,
      workspaceId: null,
      dir: "/home/dev/scratch",
      spec: { kind: "shell" },
    });
    expect(row.pinnedAt).toBeNull();

    const pinned = await pinTerminal(row);
    expect(pinned.pinnedAt).toBeInstanceOf(Date);
    const again = await pinTerminal(pinned);
    expect(again.pinnedAt?.getTime()).toBe(pinned.pinnedAt?.getTime());
    expect((await getTerminal(row.id))?.pinnedAt?.getTime()).toBe(pinned.pinnedAt?.getTime());

    const unpinned = await unpinTerminal(again);
    expect(unpinned.pinnedAt).toBeNull();
    expect((await getTerminal(row.id))?.pinnedAt).toBeNull();
    expect((await unpinTerminal(unpinned)).pinnedAt).toBeNull();
  });
});
