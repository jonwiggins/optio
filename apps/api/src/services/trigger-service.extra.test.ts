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
  publicTrigger,
  publicTriggers,
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

describe("validateTriggerConfig with the trigger and ticket source lists narrowed", () => {
  it("refuses triggers and ticket sources the lists leave out; the default accepts them", () => {
    vi.stubEnv("OPTIO_TRIGGERS", "manual,schedule,webhook,ticket,gitlab,jira,sentry,alertmanager");
    vi.stubEnv("OPTIO_TICKET_SOURCES", "gitlab,jira");
    try {
      expect(validateTriggerConfig("slack", { channelId: "C0123ABCD" })).toBe(
        "slack isn't available in this deployment",
      );
      expect(validateTriggerConfig("github", { events: ["pr_opened"] })).toBe(
        "github isn't available in this deployment",
      );
      expect(validateTriggerConfig("ticket", { source: "linear" })).toBe(
        "linear isn't available in this deployment",
      );
      expect(validateTriggerConfig("ticket", { source: "jira" })).toBeNull();
      expect(validateTriggerConfig("schedule", { cronExpression: "0 9 * * *" })).toBeNull();
      expect(validateTriggerConfig("webhook", { path: "hook-1" })).toBeNull();
      // Listed alerting sources are on.
      expect(
        validateTriggerConfig("alertmanager", { events: ["firing"], alertnames: ["HighErrors"] }),
      ).toBeNull();
      expect(validateTriggerConfig("sentry", { events: ["issue_created"] })).toBeNull();
      for (const saas of ["pylon", "pagerduty", "datadog"]) {
        expect(validateTriggerConfig(saas, {})).toBe(`${saas} isn't available in this deployment`);
      }
    } finally {
      vi.unstubAllEnvs();
    }
    expect(validateTriggerConfig("slack", { channelId: "C0123ABCD" })).toBeNull();
    expect(validateTriggerConfig("ticket", { source: "linear" })).toBeNull();
  });
});
