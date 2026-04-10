import { WorkflowState } from "../types/task.js";

const VALID_WORKFLOW_TRANSITIONS: Record<WorkflowState, WorkflowState[]> = {
  [WorkflowState.QUEUED]: [WorkflowState.RUNNING, WorkflowState.FAILED],
  [WorkflowState.RUNNING]: [WorkflowState.COMPLETED, WorkflowState.FAILED],
  [WorkflowState.COMPLETED]: [],
  [WorkflowState.FAILED]: [WorkflowState.QUEUED],
};

export class InvalidWorkflowTransitionError extends Error {
  constructor(
    public readonly from: WorkflowState,
    public readonly to: WorkflowState,
  ) {
    super(`Invalid workflow state transition: ${from} -> ${to}`);
    this.name = "InvalidWorkflowTransitionError";
  }
}

export function canTransitionWorkflow(from: WorkflowState, to: WorkflowState): boolean {
  return VALID_WORKFLOW_TRANSITIONS[from]?.includes(to) ?? false;
}

export function transitionWorkflow(from: WorkflowState, to: WorkflowState): WorkflowState {
  if (!canTransitionWorkflow(from, to)) {
    throw new InvalidWorkflowTransitionError(from, to);
  }
  return to;
}

export function isWorkflowTerminal(state: WorkflowState): boolean {
  return VALID_WORKFLOW_TRANSITIONS[state]?.length === 0;
}

export function getValidWorkflowTransitions(state: WorkflowState): WorkflowState[] {
  return VALID_WORKFLOW_TRANSITIONS[state] ?? [];
}
