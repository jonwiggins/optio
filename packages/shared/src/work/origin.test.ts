import { describe, expect, it } from "vitest";
import { workOrigin } from "./origin.js";

describe("work source identity", () => {
  it.each(["manual", "api", "resume", "blueprint", "task", "job"])(
    "preserves a Local session's %s source",
    (spawnedBy) => {
      expect(workOrigin({ source: "local-terminal", spawnedBy })).toMatchObject({ spawnedBy });
    },
  );
  it("uses a ticket's tracker and an event's source", () => {
    expect(workOrigin({ source: "repo-task", ticketSource: "linear" })).toEqual({
      spawnedBy: "ticket",
      ticketSource: "linear",
    });
    expect(workOrigin({ source: "standalone", triggers: [{ type: "github" }] })).toMatchObject({
      spawnedBy: "trigger",
      triggerType: "github",
    });
  });
  it("keeps Local runs consistent with their task/job sessions", () => {
    expect(workOrigin({ source: "repo-task", runTarget: "local", ticketSource: "linear" })).toEqual(
      { spawnedBy: "task" },
    );
    expect(
      workOrigin({ source: "job-run", runTarget: "local", triggers: [{ type: "schedule" }] }),
    ).toEqual({ spawnedBy: "job" });
  });
  it("reserves Optio for its agents, and does not invent a source for deleted work", () => {
    expect(workOrigin({ source: "persistent-agent" })).toEqual({ spawnedBy: "optio" });
    expect(workOrigin({ source: "pod-session" })).toEqual({ spawnedBy: "manual" });
    expect(workOrigin({})).toBeNull();
  });
  it("does not select an arbitrary trigger for definitions with several sources", () => {
    expect(
      workOrigin({
        source: "standalone",
        triggers: [{ type: "github" }, { type: "ticket", source: "linear" }],
      }),
    ).toEqual({ spawnedBy: "trigger" });
    expect(
      workOrigin({ source: "standalone", triggers: [{ type: "github" }, { type: "github" }] }),
    ).toMatchObject({ triggerType: "github" });
  });
});
