import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("./task-service.js", () => ({
  getTask: vi.fn(),
}));

vi.mock("./repo-pool-service.js", () => ({
  killOrphanedAgentInPod: vi.fn(),
  updateWorktreeState: vi.fn(),
}));

import { getTask } from "./task-service.js";
import { killOrphanedAgentInPod, updateWorktreeState } from "./repo-pool-service.js";
import {
  registerActiveExec,
  unregisterActiveExec,
  abortActiveExec,
  activeExecCount,
  terminateTaskExecution,
} from "./task-cancellation-service.js";

describe("active exec registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("abortActiveExec closes and removes a registered session", () => {
    const close = vi.fn();
    registerActiveExec("t1", { close });
    expect(activeExecCount()).toBeGreaterThan(0);

    expect(abortActiveExec("t1")).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    // Second abort finds nothing
    expect(abortActiveExec("t1")).toBe(false);
    expect(activeExecCount()).toBe(0);
  });

  it("abortActiveExec returns false when no session is registered", () => {
    expect(abortActiveExec("missing")).toBe(false);
  });

  it("unregisterActiveExec removes without closing", () => {
    const close = vi.fn();
    registerActiveExec("t2", { close });
    unregisterActiveExec("t2");

    expect(close).not.toHaveBeenCalled();
    expect(abortActiveExec("t2")).toBe(false);
  });

  it("abortActiveExec swallows errors from close()", () => {
    registerActiveExec("t3", {
      close: () => {
        throw new Error("ws already closed");
      },
    });
    expect(abortActiveExec("t3")).toBe(true);
  });
});

describe("terminateTaskExecution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("aborts the exec stream and kills the in-pod agent", async () => {
    const close = vi.fn();
    registerActiveExec("task-1", { close });
    vi.mocked(getTask).mockResolvedValueOnce({ id: "task-1", lastPodId: "pod-9" } as any);
    vi.mocked(killOrphanedAgentInPod).mockResolvedValueOnce(true);

    const result = await terminateTaskExecution("task-1");

    expect(close).toHaveBeenCalledOnce();
    expect(killOrphanedAgentInPod).toHaveBeenCalledWith("pod-9", "task-1");
    expect(updateWorktreeState).toHaveBeenCalledWith("task-1", "removed");
    expect(result).toEqual({ streamAborted: true, agentKilled: true });
  });

  it("skips the pod kill when the task has no lastPodId", async () => {
    vi.mocked(getTask).mockResolvedValueOnce({ id: "task-2", lastPodId: null } as any);

    const result = await terminateTaskExecution("task-2");

    expect(killOrphanedAgentInPod).not.toHaveBeenCalled();
    expect(updateWorktreeState).not.toHaveBeenCalled();
    expect(result).toEqual({ streamAborted: false, agentKilled: false });
  });

  it("skips the pod kill when the task does not exist", async () => {
    vi.mocked(getTask).mockResolvedValueOnce(null as any);

    const result = await terminateTaskExecution("gone");

    expect(killOrphanedAgentInPod).not.toHaveBeenCalled();
    expect(result).toEqual({ streamAborted: false, agentKilled: false });
  });

  it("is best-effort: kill failures are swallowed, stream abort still reported", async () => {
    const close = vi.fn();
    registerActiveExec("task-3", { close });
    vi.mocked(getTask).mockResolvedValueOnce({ id: "task-3", lastPodId: "pod-1" } as any);
    vi.mocked(killOrphanedAgentInPod).mockRejectedValueOnce(new Error("pod unreachable"));

    const result = await terminateTaskExecution("task-3");

    expect(close).toHaveBeenCalledOnce();
    expect(result).toEqual({ streamAborted: true, agentKilled: false });
  });
});
