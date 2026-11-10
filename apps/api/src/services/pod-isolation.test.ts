import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { podIsolationKey, podRunId, resolvePodScope } from "./pod-isolation.js";

afterEach(() => vi.unstubAllEnvs());

describe("podIsolationKey", () => {
  const boundary = { workspaceId: "ws-1", ownerUserId: "user-1", isolationPurpose: "work" };

  it("is unchanged for shared pods: existing pods keep matching their runs", () => {
    // The key as it was before a pod could be scoped to one run.
    const before = createHash("sha256")
      .update(JSON.stringify(["v1", "ws-1", "user-1", "work", null]))
      .digest("hex")
      .slice(0, 32);
    expect(podIsolationKey(boundary)).toBe(before);
    expect(podIsolationKey({ ...boundary, runId: null })).toBe(before);
  });

  it("gives each run its own key, stable across that run's retries", () => {
    const a = podIsolationKey({ ...boundary, runId: "task-a" });
    const b = podIsolationKey({ ...boundary, runId: "task-b" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(podIsolationKey(boundary));
    expect(podIsolationKey({ ...boundary, runId: "task-a" })).toBe(a);
  });
});

describe("resolvePodScope", () => {
  it("defaults to one pod per repo", () => {
    vi.stubEnv("OPTIO_POD_SCOPE", "");
    expect(resolvePodScope(null)).toBe("repo");
    expect(resolvePodScope(undefined)).toBe("repo");
  });

  it("follows the deployment's OPTIO_POD_SCOPE when the repo says nothing", () => {
    vi.stubEnv("OPTIO_POD_SCOPE", " Run ");
    expect(resolvePodScope(null)).toBe("run");
    vi.stubEnv("OPTIO_POD_SCOPE", "per-task");
    expect(resolvePodScope(null)).toBe("repo");
  });

  it("lets the repo's own setting win either way", () => {
    vi.stubEnv("OPTIO_POD_SCOPE", "run");
    expect(resolvePodScope("repo")).toBe("repo");
    vi.stubEnv("OPTIO_POD_SCOPE", "repo");
    expect(resolvePodScope("run")).toBe("run");
    expect(resolvePodScope("bogus")).toBe("repo");
  });

  it("names the run to isolate by only under the run scope", () => {
    vi.stubEnv("OPTIO_POD_SCOPE", "");
    expect(podRunId(null, "task-a")).toBeUndefined();
    expect(podRunId("run", "task-a")).toBe("task-a");
  });
});
