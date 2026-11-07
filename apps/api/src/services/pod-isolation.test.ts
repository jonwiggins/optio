import { describe, expect, it } from "vitest";
import { podIsolationKey } from "./pod-isolation.js";

describe("podIsolationKey", () => {
  it("keeps the key shared pods always had (no run id)", () => {
    // Keys of pods made before fresh pods existed: a changed hash would strand them.
    expect(
      podIsolationKey({ workspaceId: "ws-1", ownerUserId: "user-1", isolationPurpose: "work" }),
    ).toBe("05d01a654236b288f143546f32d885b5");
    expect(podIsolationKey({})).toBe("8060a371a24f9e20869c0958025bc3a7");
    expect(podIsolationKey({ runId: undefined })).toBe(podIsolationKey({}));
  });

  it("gives every run its own key, never another run's or the shared one", () => {
    const scope = { workspaceId: "ws-1", ownerUserId: "user-1", isolationPurpose: "work" };
    const shared = podIsolationKey(scope);
    const a = podIsolationKey({ ...scope, runId: "run-a" });
    const b = podIsolationKey({ ...scope, runId: "run-b" });
    expect(a).not.toBe(shared);
    expect(b).not.toBe(shared);
    expect(a).not.toBe(b);
    expect(podIsolationKey({ ...scope, runId: "run-a" })).toBe(a);
  });

  it("keeps the boundary in a run's key: the same run id elsewhere is a different key", () => {
    const a = podIsolationKey({ workspaceId: "ws-1", runId: "run-a" });
    const b = podIsolationKey({ workspaceId: "ws-2", runId: "run-a" });
    expect(a).not.toBe(b);
  });
});
