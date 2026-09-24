import { describe, it, expect } from "vitest";
import { collectWork, countWork, inView, sessionScreenTarget, type WorkRow } from "./work-feed";

const hosts = [{ id: "h1", name: "M1" }];

describe("collectWork", () => {
  it("projects every source onto the same row shape and ranks needs-you first", () => {
    const rows = collectWork({
      unified: [
        {
          type: "repo-task",
          id: "t1",
          title: "Fix bug",
          state: "completed",
          repoUrl: "https://github.com/acme/app",
          agentType: "codex",
          prUrl: "https://github.com/acme/app/pull/7",
          updatedAt: "2026-09-01T00:00:00Z",
        },
        {
          type: "repo-task",
          id: "t2",
          title: "Needs me",
          state: "needs_attention",
          runTarget: "local",
          localHostId: "h1",
          localDir: "/Users/dev/app",
          updatedAt: "2026-08-01T00:00:00Z",
        },
        { type: "repo-blueprint", id: "b1", name: "Nightly", enabled: true, repoUrl: "x" },
        { type: "standalone", id: "j1", name: "Report", enabled: false, agentRuntime: "gemini" },
      ],
      localTerminals: [
        {
          id: "lt1",
          title: "shell",
          state: "running",
          attentionState: "needs_you",
          hostId: "h1",
          dir: "/Users/dev/notes",
          spec: { kind: "shell" },
          spawnedBy: "manual",
          lastActivityAt: "2026-09-02T00:00:00Z",
        },
        {
          id: "lt2",
          title: "dup",
          state: "running",
          taskId: "t2",
          spec: { kind: "agent", agent: "claude-code" },
        },
      ],
      localBlueprints: [
        { id: "a1", name: "Review PRs", agent: "claude-code", hostId: "h1", enabled: true },
      ],
      podSessions: [
        { id: "s1", repoUrl: "https://github.com/acme/app", state: "active", branch: "session/x" },
      ],
      agents: [
        { id: "pa1", slug: "forge", name: "Forge", state: "idle", agentRuntime: "claude-code" },
      ],
      hosts,
    });

    expect(rows.map((r) => r.key)).not.toContain("terminal-lt2");
    expect(rows.slice(0, 2).map((r) => r.status)).toEqual(["needs_you", "needs_you"]);
    expect(rows[0].key).toBe("terminal-lt1"); // most recent needs-you first
    expect(rows.find((r) => r.key === "task-t2")?.where).toEqual({
      target: "machine",
      detail: "M1 · ~/app",
    });
    expect(rows.find((r) => r.key === "task-t1")?.note).toBe("PR 7");
    expect(rows.find((r) => r.key === "job-j1")?.status).toBe("paused");
    expect(rows.find((r) => r.key === "agent-pa1")?.then).toBe("waits-for-messages");
    expect(rows.find((r) => r.key === "session-s1")?.who).toBe("terminal");

    const counts = countWork(rows);
    expect(counts).toEqual({ needsYou: 2, running: 0, waiting: 1, recurring: 2, agents: 1 });

    expect(
      rows
        .filter((r) => inView(r, "active"))
        .map((r) => r.key)
        .sort(),
    ).toEqual(["session-s1", "task-t2", "terminal-lt1", "agent-pa1"].sort());
    expect(
      rows
        .filter((r) => inView(r, "recurring"))
        .map((r) => r.key)
        .sort(),
    ).toEqual(["automation-a1", "blueprint-b1", "job-j1"].sort());
    expect(rows.filter((r) => inView(r, "history")).map((r) => r.key)).toEqual(["task-t1"]);
  });
});

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
