/**
 * Pinned sessions against a real database: a pin is kept on the terminal row,
 * is idempotent, and clears on unpin.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { localTerminals } from "../db/schema.js";
import * as relay from "./local-relay.js";
import { registerHost } from "./local-host-service.js";
import {
  createTerminal,
  getTerminal,
  listTerminals,
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

describe("listTerminals", () => {
  it("keeps a live session past the cap when newer ones have finished", async () => {
    const host = await makeHost();
    const create = () =>
      createTerminal({
        host,
        userId: null,
        workspaceId: null,
        dir: "/home/dev/scratch",
        spec: { kind: "shell" },
      });
    const live = await create();
    const finished = await create();
    await db
      .update(localTerminals)
      .set({ state: "exited", createdAt: new Date(Date.now() + 60_000) })
      .where(eq(localTerminals.id, finished.id));

    const rows = await listTerminals(null, { hostId: host.id }, 1);
    expect(rows.map((r) => r.id)).toEqual([live.id]);
  });
});

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
