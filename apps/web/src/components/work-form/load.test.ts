import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getTaskUnified: vi.fn(),
  listTaskTriggers: vi.fn(),
  getLocalBlueprint: vi.fn(),
  listLocalBlueprintTriggers: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));

import { draftFromRow, loadEditTarget, pickTrigger, whenFromTrigger } from "./load";
import { deriveKind, kindLock, missingFields } from "./model";

/**
 * A saved row reopened in the form must land on the kind it was saved as —
 * otherwise the lock would refuse every change — and must be submittable
 * as-is (no gaps the user didn't leave).
 */
describe("draftFromRow — the row round-trips to its own kind", () => {
  it("a scheduled pod Task", () => {
    const d = draftFromRow(
      "repo-blueprint",
      {
        name: "Nightly sweep",
        title: "Nightly sweep",
        prompt: "Sweep",
        repoUrl: "https://github.com/acme/app",
        repoBranch: "develop",
        agentType: "codex",
        agentOptions: { model: "gpt-5" },
        priority: 7,
        maxRetries: 1,
        runTarget: "cluster",
      },
      { type: "schedule", config: { cronExpression: "0 9 * * 1-5" } },
    );
    expect(deriveKind(d)).toBe("repo-blueprint");
    expect(d.when).toBe("schedule");
    expect(d.trigger.cronExpression).toBe("0 9 * * 1-5");
    expect(d.runtime).toBe("codex");
    expect(d.agentOptions).toEqual({ model: "gpt-5" });
    expect(d.repoBranch).toBe("develop");
    expect(d.priority).toBe(7);
    expect(missingFields(d)).toEqual([]);
  });

  it("a Job on a machine, folding the legacy model column into the options", () => {
    const d = draftFromRow(
      "standalone",
      {
        name: "Digest",
        promptTemplate: "Summarize {{ticketTitle}}",
        agentRuntime: "claude-code",
        model: "opus",
        agentOptions: null,
        maxRetries: 2,
        runTarget: "local",
        localHostId: "h1",
        localDir: "/Users/dev/notes",
        localSessionMode: "headless",
      },
      { type: "ticket", config: { source: "linear", labels: ["bug"] } },
    );
    expect(deriveKind(d)).toBe("standalone");
    expect(d.when).toBe("ticket");
    expect(d.trigger).toEqual({ type: "ticket", ticketSource: "linear", ticketLabels: ["bug"] });
    expect(d.location).toEqual({
      runTarget: "local",
      localHostId: "h1",
      localDir: "/Users/dev/notes",
      localSessionMode: "headless",
    });
    expect(d.agentOptions.claudeModel).toBe("opus");
    expect(d.then).toBe("exits");
  });

  it("a Local automation on a new branch with a GitHub event trigger", () => {
    const d = draftFromRow(
      "local-blueprint",
      {
        name: "Reviews",
        hostId: "h1",
        dir: "/Users/dev/repos/app",
        repoUrl: "https://github.com/acme/app",
        baseBranch: "main",
        commandTemplate: "Review PR {{number}}",
        agent: "claude-code",
        sessionMode: "interactive",
      },
      { type: "github", config: { events: ["review_requested"], login: "octocat" } },
    );
    expect(deriveKind(d)).toBe("local-blueprint");
    expect(d.when).toBe("github");
    expect(d.event).toEqual({
      type: "github",
      config: { events: ["review_requested"], login: "octocat" },
    });
    expect(d.withRepo).toBe(true);
    expect(d.then).toBe("waits-for-me");
    expect(missingFields(d)).toEqual([]);
  });

  it("a headless scheduled automation with no branch sits on the Job point, and the lock allows it", () => {
    const d = draftFromRow(
      "local-blueprint",
      {
        name: "Sync",
        hostId: "h1",
        dir: "/Users/dev/notes",
        baseBranch: null,
        commandTemplate: "Sync notes",
        agent: "codex",
        sessionMode: "headless",
      },
      { type: "schedule", config: { cronExpression: "0 * * * *" } },
    );
    // The form would file this as a Job on a machine; the save still patches the blueprint.
    expect(deriveKind(d)).toBe("standalone");
    expect(d.withRepo).toBe(false);
    expect(d.then).toBe("exits");
    expect(d.runtime).toBe("codex");
    expect(kindLock(d, "local-blueprint", { prompt: "x" })).toBeUndefined();
    // A new branch on a schedule is a scheduled Task on a machine — a different row.
    expect(kindLock(d, "local-blueprint", { withRepo: true })).toMatch(/automation/);
    // Waiting for you between turns is an interactive automation — still this row.
    expect(kindLock(d, "local-blueprint", { then: "waits-for-me" })).toBeUndefined();
  });
});

describe("draftFromRow — run names", () => {
  it("reads each kind's run-title template back, blank when it just repeats the name", () => {
    const linear = { type: "linear", config: { events: ["mentioned"], user: "jon" } };
    const task = { name: "Triage", prompt: "p", repoUrl: "https://github.com/a/b" };
    expect(
      draftFromRow("repo-blueprint", { ...task, title: "Triage: {{ticketTitle}}" }, linear).runName,
    ).toBe("Triage: {{ticketTitle}}");
    expect(draftFromRow("repo-blueprint", { ...task, title: "Triage" }, linear).runName).toBe("");
    expect(
      draftFromRow(
        "standalone",
        { name: "Triage", promptTemplate: "p", runTitle: "Job: {{title}}" },
        linear,
      ).runName,
    ).toBe("Job: {{title}}");
    expect(
      draftFromRow(
        "local-blueprint",
        { name: "Triage", commandTemplate: "p", agent: "claude-code", runTitle: "T: {{title}}" },
        linear,
      ).runName,
    ).toBe("T: {{title}}");
  });
});

describe("whenFromTrigger / pickTrigger", () => {
  it("maps each stored trigger type back to the form's When", () => {
    expect(whenFromTrigger({ type: "webhook", config: { path: "hook-1" } }).trigger).toEqual({
      type: "webhook",
      webhookPath: "hook-1",
    });
    expect(whenFromTrigger({ type: "slack", config: { channelId: "C0123ABCD" } }).when).toBe(
      "slack",
    );
    expect(whenFromTrigger(null).when).toBe("manual");
  });

  it("prefers the first enabled trigger", () => {
    expect(
      pickTrigger([
        { id: "a", type: "webhook", enabled: false },
        { id: "b", type: "schedule", enabled: true },
      ]).id,
    ).toBe("b");
    expect(pickTrigger([{ id: "a", enabled: false }]).id).toBe("a");
    expect(pickTrigger([])).toBeNull();
  });
});

describe("kindLock — an edit stays inside its saved kind", () => {
  const job = draftFromRow(
    "standalone",
    { name: "Digest", promptTemplate: "p", agentRuntime: "claude-code", runTarget: "cluster" },
    { type: "schedule", config: { cronExpression: "0 9 * * *" } },
  );

  it("allows changes that keep the kind and refuses ones that move it", () => {
    expect(kindLock(job, "standalone", { runtime: "codex" })).toBeUndefined();
    expect(
      kindLock(job, "standalone", { trigger: { type: "webhook" }, when: "webhook" }),
    ).toBeUndefined();
    // A repo would make it a scheduled Task.
    expect(kindLock(job, "standalone", { withRepo: true })).toMatch(/saved as a Job/);
    // Waiting for messages would make it a persistent agent.
    expect(kindLock(job, "standalone", { then: "waits-for-messages" })).toMatch(/saved as a Job/);
    // A GitHub event is just another When: still a Job, still in its pod.
    expect(kindLock(job, "standalone", { when: "github" })).toBeUndefined();
  });

  it("is a no-op when nothing is locked", () => {
    expect(kindLock(job, null, { withRepo: true })).toBeUndefined();
  });
});

describe("loadEditTarget", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves a unified id and its triggers", async () => {
    api.getTaskUnified.mockResolvedValue({
      task: { type: "standalone", id: "w-1", name: "Digest", promptTemplate: "p" },
    });
    api.listTaskTriggers.mockResolvedValue({
      triggers: [{ id: "t1", type: "schedule", config: { cronExpression: "0 9 * * *" } }],
    });
    const target = await loadEditTarget("w-1");
    expect(target.kind).toBe("standalone");
    expect(target.trigger.id).toBe("t1");
    expect(target.draft.when).toBe("schedule");
    expect(api.getLocalBlueprint).not.toHaveBeenCalled();
  });

  it("falls through to Local automations on a 404", async () => {
    api.getTaskUnified.mockRejectedValue(Object.assign(new Error("nope"), { status: 404 }));
    api.getLocalBlueprint.mockResolvedValue({
      blueprint: { id: "b-1", name: "Reviews", hostId: "h1", dir: "/x", commandTemplate: "p" },
    });
    api.listLocalBlueprintTriggers.mockResolvedValue({ triggers: [] });
    const target = await loadEditTarget("b-1");
    expect(target.kind).toBe("local-blueprint");
    expect(target.trigger).toBeNull();
  });

  it("refuses a one-shot Task", async () => {
    api.getTaskUnified.mockResolvedValue({ task: { type: "repo-task", id: "t-1" } });
    await expect(loadEditTarget("t-1")).rejects.toMatchObject({ status: 405 });
  });
});
