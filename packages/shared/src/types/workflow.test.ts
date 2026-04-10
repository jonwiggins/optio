import { describe, it, expect } from "vitest";
import {
  WorkflowRunState,
  WorkflowTriggerType,
  WorkflowPodState,
  canTransitionWorkflowRun,
  transitionWorkflowRun,
  isTerminalWorkflowRunState,
} from "./workflow.js";

describe("WorkflowRunState enum", () => {
  it("has the expected values", () => {
    expect(WorkflowRunState.QUEUED).toBe("queued");
    expect(WorkflowRunState.RUNNING).toBe("running");
    expect(WorkflowRunState.COMPLETED).toBe("completed");
    expect(WorkflowRunState.FAILED).toBe("failed");
  });
});

describe("WorkflowTriggerType enum", () => {
  it("has the expected values", () => {
    expect(WorkflowTriggerType.MANUAL).toBe("manual");
    expect(WorkflowTriggerType.SCHEDULE).toBe("schedule");
    expect(WorkflowTriggerType.WEBHOOK).toBe("webhook");
  });
});

describe("WorkflowPodState enum", () => {
  it("has the expected values", () => {
    expect(WorkflowPodState.PROVISIONING).toBe("provisioning");
    expect(WorkflowPodState.READY).toBe("ready");
    expect(WorkflowPodState.ERROR).toBe("error");
    expect(WorkflowPodState.TERMINATING).toBe("terminating");
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

  describe("transitionWorkflowRun", () => {
    it("returns the target state on valid transition", () => {
      expect(transitionWorkflowRun(WorkflowRunState.QUEUED, WorkflowRunState.RUNNING)).toBe(
        WorkflowRunState.RUNNING,
      );
    });

    it("throws on invalid transition", () => {
      expect(() =>
        transitionWorkflowRun(WorkflowRunState.COMPLETED, WorkflowRunState.RUNNING),
      ).toThrow("Invalid workflow run transition: completed → running");
    });
  });

  describe("isTerminalWorkflowRunState", () => {
    it("identifies completed as terminal", () => {
      expect(isTerminalWorkflowRunState(WorkflowRunState.COMPLETED)).toBe(true);
    });

    it("identifies non-terminal states", () => {
      expect(isTerminalWorkflowRunState(WorkflowRunState.QUEUED)).toBe(false);
      expect(isTerminalWorkflowRunState(WorkflowRunState.RUNNING)).toBe(false);
      expect(isTerminalWorkflowRunState(WorkflowRunState.FAILED)).toBe(false);
    });
  });

  describe("retry lifecycle", () => {
    it("supports failed → queued retry path", () => {
      let state = WorkflowRunState.QUEUED;
      state = transitionWorkflowRun(state, WorkflowRunState.RUNNING);
      state = transitionWorkflowRun(state, WorkflowRunState.FAILED);
      state = transitionWorkflowRun(state, WorkflowRunState.QUEUED);
      expect(state).toBe(WorkflowRunState.QUEUED);
    });

    it("supports full happy path: queued → running → completed", () => {
      let state = WorkflowRunState.QUEUED;
      state = transitionWorkflowRun(state, WorkflowRunState.RUNNING);
      state = transitionWorkflowRun(state, WorkflowRunState.COMPLETED);
      expect(state).toBe(WorkflowRunState.COMPLETED);
    });
  });
});
