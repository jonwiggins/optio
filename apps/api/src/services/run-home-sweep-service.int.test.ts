import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/client.js";
import { agentPods, tasks } from "../db/schema.js";
import { insertTask } from "../test-utils/integration/fixtures.js";

const runtime = vi.hoisted(() => ({
  listings: new Map<string, string>(),
  removed: [] as string[],
}));
vi.mock("./container-service.js", () => ({
  getRuntime: () => ({
    exec: async (handle: { name: string }, command: string[]) => {
      const script = command.at(-1)!;
      if (script.startsWith("for d in ")) {
        return { stdout: Readable.from([runtime.listings.get(handle.name) ?? ""]) };
      }
      runtime.removed.push(script);
      return { stdout: Readable.from([]) };
    },
  }),
}));

import { sweepFinishedRunHomes } from "./run-home-sweep-service.js";

async function readyPod(name: string) {
  await db.insert(agentPods).values({
    pool: "repo",
    poolKey: "https://github.com/test/" + name,
    state: "ready",
    podName: name,
  });
}

afterEach(async () => {
  runtime.listings.clear();
  runtime.removed.length = 0;
  await db.delete(tasks);
  await db.delete(agentPods);
});

describe("run-home sweep UUID lookups", () => {
  it("keeps unknown names and active runs while cleaning finished homes across pods", async () => {
    const finished = await insertTask({ state: "completed" });
    const active = await insertTask({ state: "running" });
    const later = await insertTask({ state: "failed" });
    await readyPod("mixed-run-homes");
    await readyPod("later-run-homes");
    runtime.listings.set(
      "mixed-run-homes",
      [
        `09a2b5653567 0`,
        `turn-7 0`,
        `00000000-1111-4222-8333-444444444444 0`,
        `${finished.id} 0`,
        `${active.id} 0`,
      ].join("\n"),
    );
    runtime.listings.set("later-run-homes", `${later.id} 0`);

    await expect(sweepFinishedRunHomes()).resolves.toBe(2);

    const removed = runtime.removed.join("\n");
    expect(removed).toContain(finished.id);
    expect(removed).toContain(later.id);
    expect(removed).not.toContain(active.id);
    expect(removed).not.toContain("09a2b5653567");
    expect(removed).not.toContain("turn-7");
    expect(removed).not.toContain("00000000-1111-4222-8333-444444444444");
  });

  it("leaves a pod containing only non-UUID directories untouched", async () => {
    await readyPod("unknown-run-homes");
    runtime.listings.set("unknown-run-homes", "09a2b5653567 0\nturn-7 0");

    await expect(sweepFinishedRunHomes()).resolves.toBe(0);
    expect(runtime.removed).toEqual([]);
  });
});
