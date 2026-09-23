import { describe, expect, it } from "vitest";
import { likelySameComputer, mergeTargets, type MergeableHost } from "./host-merge";

const host = (over: Partial<MergeableHost> & { id: string }): MergeableHost => ({
  name: over.id,
  state: "offline",
  platform: "darwin",
  arch: "arm64",
  lastSeenAt: null,
  dirs: [],
  ...over,
});

const dirs = (...paths: string[]) => paths.map((path) => ({ path }));

describe("mergeTargets", () => {
  it("ranks the same kind of machine sharing folders first, never the source itself", () => {
    const old = host({ id: "old", dirs: dirs("/Users/jon/repos/optio", "/Users/jon/play") });
    const linux = host({ id: "linux", platform: "linux", arch: "x64", state: "online" });
    const twin = host({ id: "twin", state: "online", dirs: dirs("/Users/jon/repos/optio") });
    const otherMac = host({ id: "other-mac", state: "online", dirs: dirs("/tmp") });
    expect(mergeTargets(old, [old, linux, otherMac, twin]).map((h) => h.id)).toEqual([
      "twin",
      "other-mac",
      "linux",
    ]);
  });

  it("breaks ties by the most recently seen", () => {
    const old = host({ id: "old" });
    const a = host({ id: "a", lastSeenAt: "2026-09-20T00:00:00Z" });
    const b = host({ id: "b", lastSeenAt: "2026-09-23T00:00:00Z" });
    expect(mergeTargets(old, [a, b]).map((h) => h.id)).toEqual(["b", "a"]);
  });
});

describe("likelySameComputer", () => {
  const old = host({ id: "M1-Macbook.local", dirs: dirs("/Users/jon/repos/optio") });

  it("names the one machine of the same kind that shares a folder", () => {
    const current = host({
      id: "MacBookPro",
      state: "online",
      dirs: dirs("/Users/jon/repos/optio"),
    });
    expect(likelySameComputer(old, [old, current])?.id).toBe("MacBookPro");
  });

  it("makes no guess when nothing matches, or more than one does", () => {
    const linux = host({ id: "box", platform: "linux", dirs: dirs("/Users/jon/repos/optio") });
    const noShared = host({ id: "mac", dirs: dirs("/elsewhere") });
    expect(likelySameComputer(old, [old, linux, noShared])).toBeNull();

    const a = host({ id: "a", dirs: dirs("/Users/jon/repos/optio") });
    const b = host({ id: "b", dirs: dirs("/Users/jon/repos/optio") });
    expect(likelySameComputer(old, [a, b])).toBeNull();
  });
});
