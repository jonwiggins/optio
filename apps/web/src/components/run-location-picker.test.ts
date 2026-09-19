import { describe, it, expect } from "vitest";
import {
  CLUSTER_RUN_LOCATION,
  agentRunsLocally,
  runLocationFromRow,
  runLocationPayload,
} from "./run-location-picker";

describe("runLocationFromRow", () => {
  it("defaults to the cluster for missing rows and cluster rows", () => {
    expect(runLocationFromRow(null)).toEqual(CLUSTER_RUN_LOCATION);
    expect(runLocationFromRow({ runTarget: "cluster", localHostId: "h", localDir: "/x" })).toEqual(
      CLUSTER_RUN_LOCATION,
    );
  });

  it("reads a local row back, defaulting the session mode to headless", () => {
    expect(
      runLocationFromRow({ runTarget: "local", localHostId: "h1", localDir: "/home/dev/app" }),
    ).toEqual({
      runTarget: "local",
      localHostId: "h1",
      localDir: "/home/dev/app",
      localSessionMode: "headless",
    });
    expect(
      runLocationFromRow({
        runTarget: "local",
        localHostId: "h1",
        localDir: "/home/dev/app",
        localSessionMode: "interactive",
      }).localSessionMode,
    ).toBe("interactive");
  });
});

describe("runLocationPayload", () => {
  it("clears the local fields when the target is the cluster", () => {
    expect(
      runLocationPayload({
        runTarget: "cluster",
        localHostId: "stale",
        localDir: "/stale",
        localSessionMode: "interactive",
      }),
    ).toEqual({ runTarget: "cluster", localHostId: null, localDir: null, localSessionMode: null });
  });

  it("passes a local location through", () => {
    expect(
      runLocationPayload({
        runTarget: "local",
        localHostId: "h1",
        localDir: "/home/dev/app",
        localSessionMode: "headless",
      }),
    ).toEqual({
      runTarget: "local",
      localHostId: "h1",
      localDir: "/home/dev/app",
      localSessionMode: "headless",
    });
  });
});

describe("agentRunsLocally", () => {
  it("knows which agent runtimes the local daemon can launch", () => {
    for (const a of ["claude-code", "codex", "cursor", "gemini", "opencode"]) {
      expect(agentRunsLocally(a)).toBe(true);
    }
    expect(agentRunsLocally("copilot")).toBe(false);
    expect(agentRunsLocally("openclaw")).toBe(false);
    expect(agentRunsLocally(undefined)).toBe(false);
  });
});
