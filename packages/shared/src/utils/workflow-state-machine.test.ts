import { describe, it, expect } from "vitest";
import {
  canTransitionWorkflow,
  transitionWorkflow,
  isWorkflowTerminal,
  getValidWorkflowTransitions,
  InvalidWorkflowTransitionError,
} from "./workflow-state-machine.js";
import { WorkflowState } from "../types/task.js";

describe("workflow-state-machine", () => {
  describe("canTransitionWorkflow", () => {
    it("allows queued → running", () => {
      expect(canTransitionWorkflow(WorkflowState.QUEUED, WorkflowState.RUNNING)).toBe(true);
    });

    it("allows queued → failed", () => {
      expect(canTransitionWorkflow(WorkflowState.QUEUED, WorkflowState.FAILED)).toBe(true);
    });

    it("allows running → completed", () => {
      expect(canTransitionWorkflow(WorkflowState.RUNNING, WorkflowState.COMPLETED)).toBe(true);
    });

    it("allows running → failed", () => {
      expect(canTransitionWorkflow(WorkflowState.RUNNING, WorkflowState.FAILED)).toBe(true);
    });

    it("allows failed → queued (retry)", () => {
      expect(canTransitionWorkflow(WorkflowState.FAILED, WorkflowState.QUEUED)).toBe(true);
    });

    it("disallows completed → any", () => {
      expect(canTransitionWorkflow(WorkflowState.COMPLETED, WorkflowState.QUEUED)).toBe(false);
      expect(canTransitionWorkflow(WorkflowState.COMPLETED, WorkflowState.RUNNING)).toBe(false);
      expect(canTransitionWorkflow(WorkflowState.COMPLETED, WorkflowState.FAILED)).toBe(false);
    });

    it("disallows queued → completed (must go through running)", () => {
      expect(canTransitionWorkflow(WorkflowState.QUEUED, WorkflowState.COMPLETED)).toBe(false);
    });
  });

  describe("transitionWorkflow", () => {
    it("returns the target state on valid transition", () => {
      expect(transitionWorkflow(WorkflowState.QUEUED, WorkflowState.RUNNING)).toBe(
        WorkflowState.RUNNING,
      );
    });

    it("throws InvalidWorkflowTransitionError on invalid transition", () => {
      expect(() => transitionWorkflow(WorkflowState.COMPLETED, WorkflowState.RUNNING)).toThrow(
        InvalidWorkflowTransitionError,
      );
    });
  });

  describe("isWorkflowTerminal", () => {
    it("completed is terminal", () => {
      expect(isWorkflowTerminal(WorkflowState.COMPLETED)).toBe(true);
    });

    it("queued is not terminal", () => {
      expect(isWorkflowTerminal(WorkflowState.QUEUED)).toBe(false);
    });

    it("running is not terminal", () => {
      expect(isWorkflowTerminal(WorkflowState.RUNNING)).toBe(false);
    });

    it("failed is not terminal (can retry)", () => {
      expect(isWorkflowTerminal(WorkflowState.FAILED)).toBe(false);
    });
  });

  describe("getValidWorkflowTransitions", () => {
    it("returns [running, failed] for queued", () => {
      const transitions = getValidWorkflowTransitions(WorkflowState.QUEUED);
      expect(transitions).toContain(WorkflowState.RUNNING);
      expect(transitions).toContain(WorkflowState.FAILED);
      expect(transitions).toHaveLength(2);
    });

    it("returns empty array for completed", () => {
      expect(getValidWorkflowTransitions(WorkflowState.COMPLETED)).toEqual([]);
    });
  });
});
