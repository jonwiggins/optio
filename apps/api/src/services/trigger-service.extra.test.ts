import { describe, it, expect, vi } from "vitest";

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

import { validateTriggerConfig } from "./trigger-service.js";

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
