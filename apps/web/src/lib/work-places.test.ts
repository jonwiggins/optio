import { describe, it, expect } from "vitest";
import { groupWorkByPlace, nowSummary, placeSize } from "./work-places";
import type { WorkRow } from "./work-feed";

const row = (
  key: string,
  over: Partial<WorkRow> & Pick<WorkRow, "source" | "status" | "where">,
): WorkRow =>
  ({
    key,
    id: key,
    href: `/x/${key}`,
    name: key,
    when: "now",
    who: "claude-code",
    then: "exits",
    statusLabel: over.status,
    note: null,
    prUrl: null,
    lastActivity: "2026-09-24T10:00:00Z",
    recurring: false,
    editHref: null,
    spawned: false,
    ...over,
  }) as WorkRow;

const onMachine = (hostId: string | null) => ({
  target: "machine" as const,
  detail: "M · ~/app",
  hostId,
});
const inPod = (detail: string | null) => ({ target: "pod" as const, detail });

describe("groupWorkByPlace", () => {
  const rows = [
    row("terminal", { source: "local-terminal", status: "needs_you", where: onMachine("h1") }),
    row("local-task", { source: "repo-task", status: "running", where: onMachine("h1") }),
    row("automation", {
      source: "local-blueprint",
      status: "scheduled",
      recurring: true,
      where: onMachine("h1"),
    }),
    row("old-terminal", { source: "local-terminal", status: "done", where: onMachine("h1") }),
    row("teammate", { source: "repo-task", status: "running", where: onMachine("h-other") }),
    row("unset", {
      source: "local-blueprint",
      status: "paused",
      recurring: true,
      where: onMachine(null),
    }),
    row("task-a", { source: "repo-task", status: "running", where: inPod("acme/a") }),
    row("blueprint-a", {
      source: "repo-blueprint",
      status: "scheduled",
      recurring: true,
      where: inPod("acme/a"),
    }),
    row("session-b", { source: "pod-session", status: "waiting", where: inPod("acme/b") }),
    row("task-b", { source: "repo-task", status: "waiting", where: inPod("acme/b") }),
    row("done-c", { source: "repo-task", status: "done", where: inPod("acme/c") }),
    row("job", { source: "standalone", status: "scheduled", recurring: true, where: inPod(null) }),
    row("job-run", { source: "standalone", status: "running", spawned: true, where: inPod(null) }),
    row("agent-idle", { source: "persistent-agent", status: "waiting", where: inPod("@forge") }),
    row("agent-paused", { source: "persistent-agent", status: "paused", where: inPod("@old") }),
    row("agent-archived", { source: "persistent-agent", status: "done", where: inPod("@gone") }),
  ];
  const places = groupWorkByPlace(rows, ["h1", "h2"]);
  const keys = (rs: WorkRow[]) => rs.map((r) => r.key);

  it("puts each machine's live and recurring work under it, history left out", () => {
    expect(keys(places.machines.h1.now)).toEqual(["terminal", "local-task"]);
    expect(keys(places.machines.h1.setUp)).toEqual(["automation"]);
    expect(places.machines.h2).toEqual({ now: [], setUp: [] });
  });

  it("collects work on machines that aren't yours (or none) apart", () => {
    expect(keys(places.otherMachines.now)).toEqual(["teammate"]);
    expect(keys(places.otherMachines.setUp)).toEqual(["unset"]);
  });

  it("groups pod work by repo (busiest first), then Jobs, then agents", () => {
    expect(places.pods.map((g) => g.label)).toEqual([
      "acme/b",
      "acme/a",
      "Jobs",
      "Persistent agents",
    ]);
    const [b, a, jobs, agents] = places.pods;
    expect(keys(b.work.now).sort()).toEqual(["session-b", "task-b"]);
    expect(keys(a.work.now)).toEqual(["task-a"]);
    expect(keys(a.work.setUp)).toEqual(["blueprint-a"]);
    expect(keys(jobs.work.now)).toEqual(["job-run"]);
    expect(keys(jobs.work.setUp)).toEqual(["job"]);
    // An idle agent is live; a paused one is still standing; an archived one is gone.
    expect(keys(agents.work.now)).toEqual(["agent-idle"]);
    expect(keys(agents.work.setUp)).toEqual(["agent-paused"]);
  });

  it("summarises a place", () => {
    expect(placeSize(places.machines.h1)).toBe(3);
    expect(nowSummary(places.machines.h1)).toBe("1 needs you · 1 active");
    expect(nowSummary(places.machines.h2)).toBeNull();
  });
});
