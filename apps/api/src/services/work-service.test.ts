import { describe, it, expect, vi } from "vitest";
import { countWork, inView } from "@optio/shared";

// projectWork is pure; keep the services it gathers from (DB, queues) out of the test.
vi.mock("./task-service.js", () => ({}));
vi.mock("./workflow-service.js", () => ({}));
vi.mock("./work-definition-service.js", () => ({}));
vi.mock("./local-terminal-service.js", () => ({}));
vi.mock("./local-blueprint-service.js", () => ({}));
vi.mock("./local-host-service.js", () => ({}));
vi.mock("./interactive-session-service.js", () => ({}));
vi.mock("./persistent-agent-service.js", () => ({}));

import { projectWork, type WorkSources } from "./work-service.js";

const at = (s: string) => new Date(s);

function sources(over: Partial<WorkSources> = {}): WorkSources {
  return {
    tasks: [],
    jobRuns: [],
    definitions: [],
    localTerminals: [],
    podSessions: [],
    agents: [],
    hosts: [],
    triggers: [],
    ...over,
  };
}

describe("projectWork", () => {
  it("projects every source onto the same row shape and ranks needs-you first", () => {
    const rows = projectWork(
      sources({
        tasks: [
          {
            id: "t1",
            title: "Fix bug",
            state: "completed",
            repoUrl: "https://github.com/acme/app",
            agentType: "codex",
            prUrl: "https://github.com/acme/app/pull/7",
            runTarget: "cluster",
            localHostId: null,
            localDir: null,
            metadata: null,
            autoResume: null,
            createdAt: at("2026-08-01T00:00:00Z"),
            updatedAt: at("2026-09-01T00:00:00Z"),
          },
          {
            id: "t2",
            title: "Needs me",
            state: "needs_attention",
            repoUrl: "https://github.com/acme/app",
            agentType: "claude-code",
            prUrl: null,
            runTarget: "local",
            localHostId: "h1",
            localDir: "/Users/dev/app",
            metadata: null,
            workId: "b1",
            autoResume: true,
            createdAt: at("2026-07-01T00:00:00Z"),
            updatedAt: at("2026-08-01T00:00:00Z"),
          },
        ] as unknown as WorkSources["tasks"],
        definitions: [
          {
            id: "b1",
            kind: "repo-blueprint",
            name: "Nightly",
            runTitle: "Nightly",
            enabled: true,
            repoUrl: "https://github.com/acme/app",
            agentType: null,
            runTarget: "cluster",
            localHostId: null,
            localDir: null,
            autoResume: null,
            createdAt: at("2026-07-01T00:00:00Z"),
            updatedAt: at("2026-07-01T00:00:00Z"),
          },
          {
            id: "j1",
            kind: "standalone",
            name: "Report",
            enabled: false,
            agentType: "gemini",
            runTarget: "cluster",
            localHostId: null,
            localDir: null,
            createdAt: at("2026-07-01T00:00:00Z"),
            updatedAt: at("2026-07-01T00:00:00Z"),
          },
          {
            id: "a1",
            kind: "local-blueprint",
            name: "Review PRs",
            agentType: "claude-code",
            runTarget: "local",
            localHostId: "h1",
            localDir: null,
            localSessionMode: "interactive",
            enabled: true,
            createdAt: at("2026-07-01T00:00:00Z"),
            updatedAt: at("2026-07-01T00:00:00Z"),
          },
        ] as unknown as WorkSources["definitions"],
        localTerminals: [
          {
            id: "lt1",
            title: "shell",
            state: "running",
            attentionState: "needs_you",
            attentionReason: "waiting for input",
            hostId: "h1",
            dir: "/Users/dev/notes",
            spec: { kind: "shell" },
            spawnedBy: "manual",
            taskId: null,
            blueprintId: null,
            workflowRunId: null,
            lastActivityAt: at("2026-09-02T00:00:00Z"),
            updatedAt: at("2026-09-02T00:00:00Z"),
          },
          {
            id: "lt2",
            title: "dup",
            state: "running",
            attentionState: "working",
            taskId: "t2",
            spec: { kind: "agent", agent: "claude-code" },
          },
        ] as unknown as WorkSources["localTerminals"],
        podSessions: [
          {
            id: "s1abcdef-0000-0000-0000-000000000000",
            repoUrl: "https://github.com/acme/app",
            state: "active",
            branch: "session/x",
            title: null,
            createdAt: at("2026-07-01T00:00:00Z"),
            endedAt: null,
          },
        ] as unknown as WorkSources["podSessions"],
        agents: [
          {
            id: "pa1",
            slug: "forge",
            name: "Forge",
            state: "idle",
            agentRuntime: "claude-code",
            lastTurnAt: null,
            createdAt: at("2026-07-01T00:00:00Z"),
            updatedAt: at("2026-07-01T00:00:00Z"),
          },
        ] as unknown as WorkSources["agents"],
        hosts: [{ id: "h1", name: "M1" }],
      }),
    );

    expect(rows.map((r) => r.key)).not.toContain("terminal-lt2");
    expect(rows.slice(0, 2).map((r) => r.status)).toEqual(["needs_you", "needs_you"]);
    expect(rows[0].key).toBe("terminal-lt1"); // most recent needs-you first
    expect(rows[0]).toMatchObject({
      id: "lt1",
      note: "waiting for input",
      when: "now",
      then: "waits-for-me",
      lastActivity: "2026-09-02T00:00:00.000Z",
    });

    const t2 = rows.find((r) => r.key === "task-t2")!;
    expect(t2.where).toEqual({ target: "machine", detail: "M1 · ~/app" });
    expect(t2).toMatchObject({ when: "on a trigger", spawned: true, then: "until-merged" });
    expect(rows.find((r) => r.key === "task-t1")).toMatchObject({
      note: "PR 7",
      where: { target: "pod", detail: "acme/app" },
      who: "codex",
    });
    expect(rows.find((r) => r.key === "blueprint-b1")).toMatchObject({
      status: "scheduled",
      statusLabel: "armed",
      who: "claude-code",
      editHref: "/work/b1/edit",
    });
    expect(rows.find((r) => r.key === "job-j1")).toMatchObject({
      status: "paused",
      who: "gemini",
      href: "/jobs/j1",
    });
    expect(rows.find((r) => r.key === "agent-pa1")?.then).toBe("waits-for-messages");
    expect(rows.find((r) => r.source === "pod-session")).toMatchObject({
      who: "terminal",
      name: "session/x",
      status: "waiting",
    });

    expect(countWork(rows)).toEqual({
      needsYou: 2,
      running: 0,
      waiting: 1,
      recurring: 2,
      agents: 1,
    });
    expect(
      rows
        .filter((r) => inView(r, "active"))
        .map((r) => r.key)
        .sort(),
    ).toEqual(
      [
        "session-s1abcdef-0000-0000-0000-000000000000",
        "task-t2",
        "terminal-lt1",
        "agent-pa1",
      ].sort(),
    );
    expect(
      rows
        .filter((r) => inView(r, "recurring"))
        .map((r) => r.key)
        .sort(),
    ).toEqual(["automation-a1", "blueprint-b1", "job-j1"].sort());
    expect(rows.filter((r) => inView(r, "history")).map((r) => r.key)).toEqual(["task-t1"]);
  });

  it("names only the caller's machines and shortens home directories", () => {
    const [row] = projectWork(
      sources({
        localTerminals: [
          {
            id: "lt",
            title: "agent",
            state: "exited",
            attentionState: "idle",
            hostId: "someone-elses",
            dir: "/home/dev/app",
            spec: { kind: "agent", agent: "codex", mode: "headless" },
            spawnedBy: "trigger",
            taskId: null,
            blueprintId: "a1",
            workflowRunId: null,
            lastActivityAt: null,
            updatedAt: at("2026-09-02T00:00:00Z"),
          },
        ] as unknown as WorkSources["localTerminals"],
      }),
    );
    expect(row).toMatchObject({
      where: { target: "machine", detail: "~/app" },
      who: "codex",
      then: "exits",
      when: "trigger",
      status: "done",
      spawned: true,
    });
  });
});

describe("projectWork — Job runs and what started them", () => {
  it("lists a Job's runs as spawned rows linking to the run, marked with their trigger", () => {
    const job = {
      id: "j1",
      kind: "standalone",
      name: "Report",
      agentType: "gemini",
      runTarget: "cluster",
      localHostId: null,
      localDir: null,
      enabled: true,
      createdAt: new Date("2026-09-01T00:00:00Z"),
      updatedAt: new Date("2026-09-01T00:00:00Z"),
    } as unknown as WorkSources["definitions"][number];
    const rows = projectWork(
      sources({
        definitions: [job],
        jobRuns: [
          {
            job,
            run: {
              id: "r1",
              workflowId: "j1",
              triggerId: "tr1",
              title: "Report: Monday",
              state: "running",
              errorMessage: null,
              createdAt: new Date("2026-09-02T00:00:00Z"),
              updatedAt: new Date("2026-09-02T01:00:00Z"),
            } as unknown as WorkSources["jobRuns"][number]["run"],
          },
        ],
        triggers: [
          { id: "tr1", type: "schedule", targetId: "j1", config: { cronExpression: "0 9 * * 1" } },
          { id: "tr2", type: "ticket", targetId: "j1", config: { source: "linear" } },
        ],
      }),
    );
    expect(rows.find((r) => r.key === "job-run-r1")).toMatchObject({
      source: "standalone",
      href: "/jobs/j1/runs/r1",
      name: "Report: Monday",
      when: "on a trigger",
      who: "gemini",
      status: "running",
      spawned: true,
      recurring: false,
      triggers: [{ type: "schedule" }],
    });
    expect(rows.find((r) => r.key === "job-j1")?.triggers).toEqual([
      { type: "schedule" },
      { type: "ticket", source: "linear" },
    ]);
  });
});
