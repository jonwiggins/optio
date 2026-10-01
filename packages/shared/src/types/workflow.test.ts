import { describe, it, expect } from "vitest";
import { WorkflowRunState, WorkflowTriggerType, canTransitionWorkflowRun } from "./workflow.js";

describe("WorkflowRunState enum", () => {
  it("has the expected values", () => {
    expect(WorkflowRunState.QUEUED).toBe("queued");
    expect(WorkflowRunState.RUNNING).toBe("running");
    expect(WorkflowRunState.COMPLETED).toBe("completed");
    expect(WorkflowRunState.FAILED).toBe("failed");
    expect(WorkflowRunState.CANCELLED).toBe("cancelled");
  });
});

describe("WorkflowTriggerType enum", () => {
  it("has the expected values", () => {
    expect(WorkflowTriggerType.MANUAL).toBe("manual");
    expect(WorkflowTriggerType.SCHEDULE).toBe("schedule");
    expect(WorkflowTriggerType.WEBHOOK).toBe("webhook");
  });
});

describe("workflow run state machine", () => {
  describe("canTransitionWorkflowRun", () => {
    it("allows valid transitions", () => {
      expect(canTransitionWorkflowRun(WorkflowRunState.QUEUED, WorkflowRunState.RUNNING)).toBe(
        true,
      );
      expect(canTransitionWorkflowRun(WorkflowRunState.RUNNING, WorkflowRunState.COMPLETED)).toBe(
        true,
      );
      expect(canTransitionWorkflowRun(WorkflowRunState.RUNNING, WorkflowRunState.FAILED)).toBe(
        true,
      );
      expect(canTransitionWorkflowRun(WorkflowRunState.QUEUED, WorkflowRunState.FAILED)).toBe(true);
      expect(canTransitionWorkflowRun(WorkflowRunState.FAILED, WorkflowRunState.QUEUED)).toBe(true);
    });

    it("rejects invalid transitions", () => {
      expect(canTransitionWorkflowRun(WorkflowRunState.COMPLETED, WorkflowRunState.RUNNING)).toBe(
        false,
      );
      expect(canTransitionWorkflowRun(WorkflowRunState.COMPLETED, WorkflowRunState.QUEUED)).toBe(
        false,
      );
      expect(canTransitionWorkflowRun(WorkflowRunState.QUEUED, WorkflowRunState.COMPLETED)).toBe(
        false,
      );
      expect(canTransitionWorkflowRun(WorkflowRunState.FAILED, WorkflowRunState.RUNNING)).toBe(
        false,
      );
    });
  });
});
