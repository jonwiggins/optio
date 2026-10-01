import { describe, it, expect } from "vitest";
import { sessionScreenTarget, type WorkRow } from "./work-feed";

describe("sessionScreenTarget", () => {
  const row = (
    key: string,
    status: WorkRow["status"],
    lastActivity: string,
    source = "local-terminal",
  ) =>
    ({
      key,
      source,
      href: `/local/${key}`,
      name: key,
      status,
      lastActivity,
    }) as WorkRow;

  it("opens on the session that has waited on you longest", () => {
    const target = sessionScreenTarget([
      row("busy", "running", "2026-09-24T12:00:00Z"),
      row("waiting-long", "needs_you", "2026-09-24T09:00:00Z"),
      row("waiting", "needs_you", "2026-09-24T11:00:00Z"),
    ]);
    expect(target?.href).toBe("/local/waiting-long");
  });

  it("else the latest one still running, else the latest at all", () => {
    expect(
      sessionScreenTarget([
        row("old", "running", "2026-09-24T09:00:00Z"),
        row("new", "waiting", "2026-09-24T11:00:00Z"),
        row("finished", "done", "2026-09-24T12:00:00Z"),
      ])?.href,
    ).toBe("/local/new");
    expect(
      sessionScreenTarget([
        row("a", "done", "2026-09-24T09:00:00Z"),
        row("b", "done", "2026-09-24T10:00:00Z"),
      ])?.href,
    ).toBe("/local/b");
  });

  it("is null without sessions on a machine", () => {
    expect(
      sessionScreenTarget([row("t", "needs_you", "2026-09-24T09:00:00Z", "repo-task")]),
    ).toBeNull();
  });
});
