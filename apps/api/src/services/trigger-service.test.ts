import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("../db/schema.js", () => ({
  workflowTriggers: {
    id: "workflow_triggers.id",
    workflowId: "workflow_triggers.workflow_id",
    targetType: "workflow_triggers.target_type",
    targetId: "workflow_triggers.target_id",
    type: "workflow_triggers.type",
    enabled: "workflow_triggers.enabled",
    nextFireAt: "workflow_triggers.next_fire_at",
    createdAt: "workflow_triggers.created_at",
  },
}));

import { db } from "../db/client.js";
import {
  advanceSchedule,
  createTrigger,
  deleteTrigger,
  getTriggerFor,
  listDueScheduleTriggers,
  ticketTriggerMatches,
  ticketTriggerParams,
  updateTrigger,
  validateTriggerConfig,
} from "./trigger-service.js";

/** `db.select().from().where()` resolving to `rows`. */
function selectResolving(rows: unknown[]) {
  (db.select as any) = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  });
}

/** Capture what `db.insert().values()` is handed. */
function captureInsert() {
  const captured: { values?: any } = {};
  (db.insert as any) = vi.fn().mockReturnValue({
    values: vi.fn().mockImplementation((vals: any) => {
      captured.values = vals;
      return { returning: vi.fn().mockResolvedValue([{ id: "t-1", ...vals }]) };
    }),
  });
  return captured;
}

function captureUpdate(returning: unknown[] = [{ id: "t-1" }]) {
  const captured: { set?: any } = {};
  (db.update as any) = vi.fn().mockReturnValue({
    set: vi.fn().mockImplementation((vals: any) => {
      captured.set = vals;
      return {
        where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(returning) }),
      };
    }),
  });
  return captured;
}

describe("validateTriggerConfig — the same rules for every target", () => {
  it("accepts a complete config of each type", () => {
    expect(validateTriggerConfig("manual", {})).toBeNull();
    expect(validateTriggerConfig("schedule", { cronExpression: "0 9 * * *" })).toBeNull();
    expect(validateTriggerConfig("webhook", { path: "hook-1" })).toBeNull();
    expect(validateTriggerConfig("ticket", { source: "github" })).toBeNull();
    expect(
      validateTriggerConfig("github", { events: ["review_requested"], login: "octocat" }),
    ).toBeNull();
    expect(validateTriggerConfig("github", { events: ["pr_opened"] })).toBeNull();
    expect(validateTriggerConfig("slack", { channelId: "C0123ABCD" })).toBeNull();
    expect(validateTriggerConfig("linear", { events: ["created"], teams: ["ENG"] })).toBeNull();
  });

  it("names what's missing", () => {
    expect(validateTriggerConfig("schedule", {})).toMatch(/cronExpression/);
    expect(validateTriggerConfig("webhook", { path: "" })).toMatch(/path/);
    expect(validateTriggerConfig("ticket", {})).toMatch(/source/);
    expect(validateTriggerConfig("github", { events: ["mentioned"] })).toMatch(/login/);
    expect(validateTriggerConfig("github", {})).toMatch(/login/);
    expect(validateTriggerConfig("github", { events: ["nope"], login: "x" })).toMatch(/Unknown/);
    expect(validateTriggerConfig("github", { events: ["pr_opened"], repos: "acme/app" })).toMatch(
      /repos/,
    );
    expect(validateTriggerConfig("slack", { channelId: "general" })).toMatch(/channelId/);
    expect(validateTriggerConfig("linear", { events: ["assigned"] })).toMatch(/user/);
  });
});

describe("createTrigger", () => {
  beforeEach(() => vi.clearAllMocks());

  it("computes a schedule's first nextFireAt and mirrors a Job's id into workflowId", async () => {
    const captured = captureInsert();
    const row = await createTrigger({
      targetType: "job",
      targetId: "w-1",
      type: "schedule",
      config: { cronExpression: "0 0 * * *" },
    });
    expect(row.id).toBe("t-1");
    expect(captured.values.workflowId).toBe("w-1");
    expect(captured.values.targetType).toBe("job");
    expect(captured.values.enabled).toBe(true);
    expect(captured.values.nextFireAt).toBeInstanceOf(Date);
  });

  it("leaves workflowId null for other targets and nextFireAt null off-schedule", async () => {
    const captured = captureInsert();
    await createTrigger({ targetType: "task_config", targetId: "tc-1", type: "manual" });
    expect(captured.values.workflowId).toBeNull();
    expect(captured.values.nextFireAt).toBeNull();
    expect(captured.values.config).toEqual({});
  });

  it("a disabled schedule has no nextFireAt", async () => {
    const captured = captureInsert();
    await createTrigger({
      targetType: "local_blueprint",
      targetId: "b-1",
      type: "schedule",
      config: { cronExpression: "0 0 * * *" },
      enabled: false,
    });
    expect(captured.values.nextFireAt).toBeNull();
  });

  it("takes a GitHub event trigger on a Job, a scheduled Task, and an agent alike", async () => {
    for (const targetType of ["job", "task_config", "persistent_agent"] as const) {
      const captured = captureInsert();
      await createTrigger({
        targetType,
        targetId: "x",
        type: "github",
        config: { events: ["pr_opened"] },
      });
      expect(captured.values.type).toBe("github");
    }
  });

  it("refuses a type the target can't take", async () => {
    await expect(
      createTrigger({ targetType: "pr_review", targetId: "r-1", type: "webhook" }),
    ).rejects.toThrow("unsupported_type");
  });

  it("refuses a webhook path already in use", async () => {
    selectResolving([{ id: "other", type: "webhook", config: { path: "hook-1" } }]);
    await expect(
      createTrigger({
        targetType: "job",
        targetId: "w-1",
        type: "webhook",
        config: { path: "hook-1" },
      }),
    ).rejects.toThrow("duplicate_webhook_path");
  });
});

describe("updateTrigger", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reschedules on a new cron", async () => {
    selectResolving([
      { id: "t-1", type: "schedule", config: { cronExpression: "0 0 * * *" }, enabled: true },
    ]);
    const captured = captureUpdate();
    await updateTrigger("t-1", { config: { cronExpression: "*/5 * * * *" } });
    expect(captured.set.config).toEqual({ cronExpression: "*/5 * * * *" });
    expect(captured.set.nextFireAt).toBeInstanceOf(Date);
  });

  it("clears nextFireAt when a schedule is disabled", async () => {
    selectResolving([
      { id: "t-1", type: "schedule", config: { cronExpression: "0 0 * * *" }, enabled: true },
    ]);
    const captured = captureUpdate();
    await updateTrigger("t-1", { enabled: false });
    expect(captured.set.nextFireAt).toBeNull();
  });

  it("returns null for an unknown trigger", async () => {
    selectResolving([]);
    expect(await updateTrigger("nope", { enabled: false })).toBeNull();
  });
});

describe("getTriggerFor / deleteTrigger", () => {
  it("only returns a trigger that belongs to the target", async () => {
    selectResolving([{ id: "t-1", targetType: "job", targetId: "w-1" }]);
    expect(await getTriggerFor("job", "w-1", "t-1")).toMatchObject({ id: "t-1" });
    expect(await getTriggerFor("job", "w-2", "t-1")).toBeNull();
    expect(await getTriggerFor("task_config", "w-1", "t-1")).toBeNull();
  });

  it("reports whether a delete removed a row", async () => {
    (db.delete as any) = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: "t-1" }]) }),
    });
    expect(await deleteTrigger("t-1")).toBe(true);
    (db.delete as any) = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
    });
    expect(await deleteTrigger("t-2")).toBe(false);
  });
});

describe("schedules", () => {
  it("advanceSchedule stamps lastFiredAt and moves nextFireAt past it", async () => {
    let captured: any;
    (db.update as any) = vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((vals: any) => {
        captured = vals;
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    });
    await advanceSchedule("t-1", "0 0 * * *");
    expect(captured.lastFiredAt).toBeInstanceOf(Date);
    expect(captured.nextFireAt.getTime()).toBeGreaterThan(captured.lastFiredAt.getTime());
  });

  it("listDueScheduleTriggers returns rows of every target type", async () => {
    const rows = [
      { id: "t-1", targetType: "job" },
      { id: "t-2", targetType: "local_blueprint" },
    ];
    selectResolving(rows);
    expect(await listDueScheduleTriggers()).toEqual(rows);
  });
});

describe("ticket trigger helpers", () => {
  it("ticketTriggerMatches filters by source and any-match labels", () => {
    const ticket = { source: "linear", labels: ["bug", "triage"] };
    expect(ticketTriggerMatches({}, ticket)).toBe(true);
    expect(ticketTriggerMatches({ source: "linear" }, ticket)).toBe(true);
    expect(ticketTriggerMatches({ source: "github" }, ticket)).toBe(false);
    expect(ticketTriggerMatches({ labels: ["triage", "cve"] }, ticket)).toBe(true);
    expect(ticketTriggerMatches({ labels: ["cve"] }, ticket)).toBe(false);
    expect(ticketTriggerMatches({ labels: [] }, ticket)).toBe(true);
  });

  it("ticketTriggerParams emits the six ticket params every target reads", () => {
    expect(
      ticketTriggerParams({ source: "jira", externalId: "OPS-1", title: "T", labels: ["a", "b"] }),
    ).toEqual({
      ticketSource: "jira",
      ticketExternalId: "OPS-1",
      ticketTitle: "T",
      ticketBody: "",
      ticketUrl: "",
      ticketLabels: "a,b",
    });
  });
});
