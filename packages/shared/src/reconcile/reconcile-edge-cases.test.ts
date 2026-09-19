import { describe, it, expect } from "vitest";
import { reconcileRepo } from "./reconcile-repo.js";
import { reconcileStandalone } from "./reconcile-standalone.js";
import type {
  WorldSnapshot,
  RepoRunSpec,
  RepoRunStatus,
  StandaloneRunSpec,
  StandaloneRunStatus,
  Run,
  DependencyObservation,
  PrStatus,
} from "./types.js";
import { TaskState } from "../types/task.js";
import { WorkflowRunState } from "../types/workflow.js";

const NOW = new Date("2026-04-17T12:00:00Z");

// ─── Fixtures ───

function repoSnapshot(
  spec: Partial<RepoRunSpec> = {},
  status: Partial<RepoRunStatus> = {},
  extras: Partial<WorldSnapshot> = {},
): WorldSnapshot {
  const run: Run = {
    kind: "repo",
    ref: { kind: "repo", id: "task-1" },
    spec: {
      repoUrl: "https://github.com/acme/repo",
      repoBranch: "main",
      agentType: "claude-code",
      prompt: "fix",
      title: "Fix",
      taskType: "coding",
      maxRetries: 3,
      priority: 100,
      ignoreOffPeak: false,
      parentTaskId: null,
      blocksParent: false,
      workspaceId: "ws-1",
      workflowRunId: null,
      runTarget: "cluster",
      ...spec,
    },
    status: {
      state: TaskState.QUEUED,
      prUrl: null,
      prNumber: null,
      prState: null,
      prChecksStatus: null,
      prReviewStatus: null,
      prReviewComments: null,
      containerId: null,
      sessionId: null,
      worktreeState: null,
      lastPodId: null,
      lastActivityAt: null,
      retryCount: 0,
      errorMessage: null,
      costUsd: null,
      startedAt: null,
      completedAt: null,
      controlIntent: null,
      reconcileBackoffUntil: null,
      reconcileAttempts: 0,
      updatedAt: new Date(NOW.getTime() - 1000),
      ...status,
    },
  };
  return {
    now: NOW,
    run,
    pod: null,
    pr: null,
    dependencies: [],
    blockingSubtasks: [],
    capacity: {
      global: { running: 1, max: 5 },
      repo: { running: 0, max: 2 },
    },
    heartbeat: { lastActivityAt: null, isStale: false, silentForMs: 0 },
    settings: {
      stallThresholdMs: 300_000,
      autoMerge: false,
      cautiousMode: false,
      autoResume: false,
      reviewEnabled: false,
      reviewTrigger: null,
      offPeakOnly: false,
      offPeakActive: false,
      hasReviewSubtask: false,
      maxAutoResumes: 10,
      recentAutoResumeCount: 0,
    },
    readErrors: [],
    ...extras,
  };
}

function standaloneSnapshot(
  spec: Partial<StandaloneRunSpec> = {},
  status: Partial<StandaloneRunStatus> = {},
  extras: Partial<WorldSnapshot> = {},
): WorldSnapshot {
  const run: Run = {
    kind: "standalone",
    ref: { kind: "standalone", id: "run-1" },
    spec: {
      workflowId: "wf-1",
      workflowEnabled: true,
      agentRuntime: "claude-code",
      promptRendered: "do",
      params: null,
      maxConcurrent: 5,
      maxRetries: 3,
      workspaceId: "ws-1",
      runTarget: "cluster",
      ...spec,
    },
    status: {
      state: WorkflowRunState.QUEUED,
      costUsd: null,
      errorMessage: null,
      sessionId: null,
      podName: null,
      retryCount: 0,
      startedAt: null,
      finishedAt: null,
      controlIntent: null,
      reconcileBackoffUntil: null,
      reconcileAttempts: 0,
      updatedAt: new Date(NOW.getTime() - 1000),
      ...status,
    },
  };
  return {
    now: NOW,
    run,
    pod: null,
    pr: null,
    dependencies: [],
    blockingSubtasks: [],
    capacity: { global: { running: 0, max: 5 } },
    heartbeat: { lastActivityAt: null, isStale: false, silentForMs: 0 },
    settings: {
      stallThresholdMs: 300_000,
      autoMerge: false,
      cautiousMode: false,
      autoResume: false,
      reviewEnabled: false,
      reviewTrigger: null,
      offPeakOnly: false,
      offPeakActive: false,
      hasReviewSubtask: false,
      maxAutoResumes: 10,
      recentAutoResumeCount: 0,
    },
    readErrors: [],
    ...extras,
  };
}

function makePr(overrides: Partial<PrStatus> = {}): PrStatus {
  return {
    url: "https://github.com/acme/repo/pull/1",
    number: 1,
    state: "open",
    merged: false,
    mergeable: true,
    checksStatus: "none",
    reviewStatus: "none",
    latestReviewComments: null,
    ...overrides,
  };
}

// ─── Cross-reconciler: kind mismatch ───

describe("cross-reconciler — kind mismatch", () => {
  it("reconcileRepo on a standalone run returns noop", () => {
    const action = reconcileRepo(standaloneSnapshot());
    expect(action.kind).toBe("noop");
    expect(action.reason).toContain("reconcile-repo called on standalone");
  });

  it("reconcileStandalone on a repo run returns noop", () => {
    const action = reconcileStandalone(repoSnapshot());
    expect(action.kind).toBe("noop");
    expect(action.reason).toContain("reconcile-standalone called on repo");
  });
});

// ─── Backoff attempts scaling ───

describe("backoff — attempt scaling", () => {
  it("defer duration grows with reconcile attempts (repo)", () => {
    const snap1 = repoSnapshot(
      {},
      { state: TaskState.RUNNING, reconcileAttempts: 1 },
      { readErrors: [{ source: "pod", message: "timeout" }] },
    );
    const snap4 = repoSnapshot(
      {},
      { state: TaskState.RUNNING, reconcileAttempts: 4 },
      { readErrors: [{ source: "pod", message: "timeout" }] },
    );
    const a1 = reconcileRepo(snap1);
    const a4 = reconcileRepo(snap4);
    expect(a1.kind).toBe("deferWithBackoff");
    expect(a4.kind).toBe("deferWithBackoff");
    if (a1.kind === "deferWithBackoff" && a4.kind === "deferWithBackoff") {
      expect(a4.untilMs - NOW.getTime()).toBeGreaterThan(a1.untilMs - NOW.getTime());
    }
  });

  it("backoff caps at attempt = 6 (prevents runaway)", () => {
    const snap6 = repoSnapshot(
      {},
      { state: TaskState.RUNNING, reconcileAttempts: 6 },
      { readErrors: [{ source: "pod", message: "x" }] },
    );
    const snap20 = repoSnapshot(
      {},
      { state: TaskState.RUNNING, reconcileAttempts: 20 },
      { readErrors: [{ source: "pod", message: "x" }] },
    );
    const a6 = reconcileRepo(snap6);
    const a20 = reconcileRepo(snap20);
    if (a6.kind === "deferWithBackoff" && a20.kind === "deferWithBackoff") {
      const d6 = a6.untilMs - NOW.getTime();
      const d20 = a20.untilMs - NOW.getTime();
      // Both should be within one jitter window of each other (≤ 5s).
      expect(Math.abs(d20 - d6)).toBeLessThanOrEqual(5000);
    }
  });
});

// ─── Read-error precedence ───

describe("read-error precedence", () => {
  it("picks first error source when multiple fail", () => {
    const snap = repoSnapshot(
      {},
      { state: TaskState.RUNNING },
      {
        readErrors: [
          { source: "deps", message: "db" },
          { source: "pod", message: "k8s" },
          { source: "pr", message: "github" },
        ],
      },
    );
    const action = reconcileRepo(snap);
    expect(action.kind).toBe("deferWithBackoff");
    expect(action.reason).toBe("world_read_failed:deps");
  });
});

// ─── PENDING edge cases ───

describe("PENDING — edge cases", () => {
  it("PENDING with completed deps still goes to WAITING_ON_DEPS then resolves next tick", () => {
    const deps: DependencyObservation[] = [
      { taskId: "d1", state: TaskState.COMPLETED, blocksParent: false },
    ];
    const s = repoSnapshot({}, { state: TaskState.PENDING }, { dependencies: deps });
    const action = reconcileRepo(s);
    expect(action.kind).toBe("transition");
    if (action.kind === "transition") {
      expect(action.to).toBe(TaskState.WAITING_ON_DEPS);
    }
  });
});

// ─── WAITING_ON_DEPS — boundary ───

describe("WAITING_ON_DEPS — boundary", () => {
  it("one completed + one pending → noop", () => {
    const deps: DependencyObservation[] = [
      { taskId: "d1", state: TaskState.COMPLETED, blocksParent: false },
      { taskId: "d2", state: TaskState.PENDING, blocksParent: false },
    ];
    const s = repoSnapshot({}, { state: TaskState.WAITING_ON_DEPS }, { dependencies: deps });
    expect(reconcileRepo(s).kind).toBe("noop");
  });

  it("single cancelled dep cascades failure", () => {
    const deps: DependencyObservation[] = [
      { taskId: "d1", state: TaskState.CANCELLED, blocksParent: false },
    ];
    const s = repoSnapshot({}, { state: TaskState.WAITING_ON_DEPS }, { dependencies: deps });
    const action = reconcileRepo(s);
    expect(action.kind).toBe("transition");
    if (action.kind === "transition") expect(action.to).toBe(TaskState.FAILED);
  });
});

// ─── QUEUED — capacity ordering ───

describe("QUEUED — capacity ordering", () => {
  it("global saturation short-circuits before per-repo check", () => {
    const s = repoSnapshot(
      {},
      { state: TaskState.QUEUED },
      {
        capacity: {
          global: { running: 5, max: 5 },
          repo: { running: 0, max: 10 },
        },
      },
    );
    const action = reconcileRepo(s);
    expect(action.reason).toContain("global_capacity_saturated");
  });

  it("off-peak check runs before capacity checks", () => {
    const s = repoSnapshot(
      { ignoreOffPeak: false },
      { state: TaskState.QUEUED },
      {
        capacity: {
          global: { running: 5, max: 5 },
          repo: { running: 10, max: 10 },
        },
        settings: {
          stallThresholdMs: 300_000,
          autoMerge: false,
          cautiousMode: false,
          autoResume: false,
          reviewEnabled: false,
          reviewTrigger: null,
          offPeakOnly: true,
          offPeakActive: false,
          hasReviewSubtask: false,
          maxAutoResumes: 10,
          recentAutoResumeCount: 0,
          maxAutoResumes: 10,
          recentAutoResumeCount: 0,
        },
      },
    );
    expect(reconcileRepo(s).reason).toBe("off_peak_blocked");
  });

  it("no repo capacity entry → global limit applies only", () => {
    const s = repoSnapshot(
      {},
      { state: TaskState.QUEUED },
      { capacity: { global: { running: 1, max: 5 } } },
    );
    expect(reconcileRepo(s).kind).toBe("requeueForAgent");
  });
});

// ─── PROVISIONING ───

describe("PROVISIONING — pod state variations", () => {
  it("pod pending → noop (normal startup)", () => {
    const s = repoSnapshot(
      {},
      { state: TaskState.PROVISIONING },
      { pod: { podName: "p", phase: "pending", lastError: null } },
    );
    expect(reconcileRepo(s).kind).toBe("noop");
  });

  it("pod ready → noop (worker transitions to RUNNING)", () => {
    const s = repoSnapshot(
      {},
      { state: TaskState.PROVISIONING },
      { pod: { podName: "p", phase: "ready", lastError: null } },
    );
    expect(reconcileRepo(s).kind).toBe("noop");
  });

  it("unknown pod phase → noop (don't act on ambiguity)", () => {
    const s = repoSnapshot(
      {},
      { state: TaskState.PROVISIONING },
      { pod: { podName: "p", phase: "unknown", lastError: null } },
    );
    expect(reconcileRepo(s).kind).toBe("noop");
  });
});

// ─── RUNNING — precedence ───

describe("RUNNING — signal precedence", () => {
  it("PR URL wins over stall (PR came in just before timeout)", () => {
    const s = repoSnapshot(
      {},
      {
        state: TaskState.RUNNING,
        prUrl: "https://github.com/acme/repo/pull/1",
        lastActivityAt: new Date(NOW.getTime() - 600_000),
      },
      {
        heartbeat: {
          lastActivityAt: new Date(NOW.getTime() - 600_000),
          isStale: true,
          silentForMs: 600_000,
        },
      },
    );
    const action = reconcileRepo(s);
    expect(action.kind).toBe("transition");
    if (action.kind === "transition") {
      expect(action.to).toBe(TaskState.PR_OPENED);
    }
  });

  it("pod dead wins over stall", () => {
    const s = repoSnapshot(
      {},
      { state: TaskState.RUNNING },
      {
        pod: { podName: "p", phase: "terminated", lastError: "OOMKilled" },
        heartbeat: {
          lastActivityAt: new Date(NOW.getTime() - 600_000),
          isStale: true,
          silentForMs: 600_000,
        },
      },
    );
    const action = reconcileRepo(s);
    expect(action.kind).toBe("transition");
    if (action.kind === "transition") {
      expect(action.statusPatch?.errorMessage).toBe("OOMKilled");
    }
  });
});

// ─── PR_OPENED — complex states ───

describe("PR_OPENED — combined signals", () => {
  it("PR merged with stale CI status still transitions to COMPLETED", () => {
    const s = repoSnapshot(
      {},
      {
        state: TaskState.PR_OPENED,
        prUrl: "https://github.com/acme/repo/pull/1",
        prNumber: 1,
        prChecksStatus: "failing",
      },
      { pr: makePr({ merged: true, state: "merged" }) },
    );
    const action = reconcileRepo(s);
    expect(action.kind).toBe("transition");
    if (action.kind === "transition") expect(action.to).toBe(TaskState.COMPLETED);
  });

  it("steady-state: no drift → noop", () => {
    const s = repoSnapshot(
      {},
      {
        state: TaskState.PR_OPENED,
        prUrl: "https://github.com/acme/repo/pull/1",
        prNumber: 1,
        prChecksStatus: "passing",
        prReviewStatus: "approved",
        prState: "open",
      },
      {
        pr: makePr({
          checksStatus: "passing",
          reviewStatus: "approved",
        }),
      },
    );
    expect(reconcileRepo(s).kind).toBe("noop");
  });

  it("patchStatus when prReviewStatus drifts", () => {
    const s = repoSnapshot(
      {},
      {
        state: TaskState.PR_OPENED,
        prUrl: "https://github.com/acme/repo/pull/1",
        prNumber: 1,
        prChecksStatus: "passing",
        prReviewStatus: "none",
        prState: "open",
      },
      {
        pr: makePr({
          checksStatus: "passing",
          reviewStatus: "pending",
        }),
      },
    );
    const action = reconcileRepo(s);
    expect(action.kind).toBe("patchStatus");
    if (action.kind === "patchStatus") {
      expect(action.statusPatch.prReviewStatus).toBe("pending");
    }
  });

  it("CI passing stale (already seen) → no launchReview re-trigger", () => {
    const s = repoSnapshot(
      {},
      {
        state: TaskState.PR_OPENED,
        prUrl: "https://github.com/acme/repo/pull/1",
        prNumber: 1,
        prChecksStatus: "passing", // previously passing
      },
      {
        pr: makePr({ checksStatus: "passing" }),
        settings: {
          stallThresholdMs: 300_000,
          autoMerge: false,
          cautiousMode: false,
          autoResume: false,
          reviewEnabled: true,
          reviewTrigger: "on_ci_pass",
          offPeakOnly: false,
          offPeakActive: false,
          hasReviewSubtask: false,
          maxAutoResumes: 10,
          recentAutoResumeCount: 0,
          maxAutoResumes: 10,
          recentAutoResumeCount: 0,
        },
      },
    );
    const action = reconcileRepo(s);
    expect(action.kind).not.toBe("launchReview");
  });

  it("auto-merge with existing review subtask still allowed if review passed", () => {
    // blockingSubtasks is authoritative for merge-gate; hasReviewSubtask only
    // controls whether to spawn a new one.
    const subs: DependencyObservation[] = [
      { taskId: "rev", state: TaskState.COMPLETED, blocksParent: true },
    ];
    const s = repoSnapshot(
      {},
      {
        state: TaskState.PR_OPENED,
        prUrl: "https://github.com/acme/repo/pull/1",
        prNumber: 1,
        prChecksStatus: "passing",
      },
      {
        pr: makePr({ checksStatus: "passing" }),
        blockingSubtasks: subs,
        settings: {
          stallThresholdMs: 300_000,
          autoMerge: true,
          cautiousMode: false,
          autoResume: false,
          reviewEnabled: true,
          reviewTrigger: "on_ci_pass",
          offPeakOnly: false,
          offPeakActive: false,
          hasReviewSubtask: true,
          maxAutoResumes: 10,
          recentAutoResumeCount: 0,
        },
      },
    );
    expect(reconcileRepo(s).kind).toBe("autoMergePr");
  });

  it("review requested on already-requested review → stable noop", () => {
    const s = repoSnapshot(
      {},
      {
        state: TaskState.PR_OPENED,
        prUrl: "https://github.com/acme/repo/pull/1",
        prNumber: 1,
        prReviewStatus: "changes_requested",
        prChecksStatus: "passing",
        prState: "open",
      },
      {
        pr: makePr({
          reviewStatus: "changes_requested",
          checksStatus: "passing",
        }),
        settings: {
          stallThresholdMs: 300_000,
          autoMerge: false,
          cautiousMode: false,
          autoResume: true,
          reviewEnabled: false,
          reviewTrigger: null,
          offPeakOnly: false,
          offPeakActive: false,
          hasReviewSubtask: false,
          maxAutoResumes: 10,
          recentAutoResumeCount: 0,
          maxAutoResumes: 10,
          recentAutoResumeCount: 0,
        },
      },
    );
    // Not a fresh edge — already recorded as changes_requested.
    const action = reconcileRepo(s);
    expect(action.kind).not.toBe("resumeAgent");
  });
});

// ─── Intent interaction with backoff ───

describe("intent vs backoff ordering", () => {
  it("backoff short-circuits intent interpretation", () => {
    const s = repoSnapshot(
      {},
      {
        state: TaskState.FAILED,
        controlIntent: "retry",
        reconcileBackoffUntil: new Date(NOW.getTime() + 60_000),
      },
    );
    expect(reconcileRepo(s).reason).toBe("reconcile_backoff_active");
  });

  it("intent runs before read-error defer (intent is actionable without world)", () => {
    const s = repoSnapshot(
      {},
      { state: TaskState.RUNNING, controlIntent: "cancel" },
      { readErrors: [{ source: "pod", message: "k8s timeout" }] },
    );
    const action = reconcileRepo(s);
    expect(action.kind).toBe("transition");
    if (action.kind === "transition") expect(action.to).toBe(TaskState.CANCELLED);
  });
});

// ─── Standalone: finishedAt + stall interaction ───

describe("standalone — finishedAt precedence", () => {
  it("finishedAt without error wins over stale heartbeat", () => {
    const s = standaloneSnapshot(
      {},
      {
        state: WorkflowRunState.RUNNING,
        finishedAt: NOW,
        errorMessage: null,
      },
      {
        heartbeat: {
          lastActivityAt: new Date(NOW.getTime() - 600_000),
          isStale: true,
          silentForMs: 600_000,
        },
      },
    );
    const action = reconcileStandalone(s);
    expect(action.kind).toBe("transition");
    if (action.kind === "transition") {
      expect(action.to).toBe(WorkflowRunState.COMPLETED);
    }
  });

  it("finishedAt with error wins over stall", () => {
    const s = standaloneSnapshot(
      {},
      {
        state: WorkflowRunState.RUNNING,
        finishedAt: NOW,
        errorMessage: "crash",
      },
      {
        heartbeat: {
          lastActivityAt: new Date(NOW.getTime() - 600_000),
          isStale: true,
          silentForMs: 600_000,
        },
      },
    );
    const action = reconcileStandalone(s);
    expect(action.kind).toBe("transition");
    if (action.kind === "transition") expect(action.to).toBe(WorkflowRunState.FAILED);
  });
});

// ─── Restart intent: proper reset ───

describe("restart intent — state reset", () => {
  it("restart clears retry count AND fields", () => {
    const s = repoSnapshot(
      {},
      {
        state: TaskState.COMPLETED,
        controlIntent: "restart",
        retryCount: 5,
        containerId: "c1",
        sessionId: "s1",
        errorMessage: "prev",
      },
    );
    const action = reconcileRepo(s);
    if (action.kind === "transition") {
      expect(action.statusPatch?.retryCount).toBe(0);
      expect(action.statusPatch?.containerId).toBeNull();
      expect(action.statusPatch?.sessionId).toBeNull();
      expect(action.statusPatch?.errorMessage).toBeNull();
    } else {
      throw new Error("expected transition");
    }
  });
});

// ─── Retry boundary ───

describe("retry intent — maxRetries boundary", () => {
  it("retry at exactly maxRetries is exhausted", () => {
    const s = repoSnapshot(
      { maxRetries: 3 },
      { state: TaskState.FAILED, controlIntent: "retry", retryCount: 3 },
    );
    expect(reconcileRepo(s).kind).toBe("clearControlIntent");
  });

  it("retry at maxRetries - 1 succeeds", () => {
    const s = repoSnapshot(
      { maxRetries: 3 },
      { state: TaskState.FAILED, controlIntent: "retry", retryCount: 2 },
    );
    const action = reconcileRepo(s);
    expect(action.kind).toBe("transition");
    if (action.kind === "transition") expect(action.statusPatch?.retryCount).toBe(3);
  });

  it("maxRetries=0 means no retries allowed", () => {
    const s = repoSnapshot(
      { maxRetries: 0 },
      { state: TaskState.FAILED, controlIntent: "retry", retryCount: 0 },
    );
    expect(reconcileRepo(s).kind).toBe("clearControlIntent");
  });
});

// ─── Review subtasks ───

describe("review subtask — blocking gate", () => {
  it("pending review subtask blocks auto-merge", () => {
    const subs: DependencyObservation[] = [
      { taskId: "rev", state: TaskState.RUNNING, blocksParent: true },
    ];
    const s = repoSnapshot(
      {},
      {
        state: TaskState.PR_OPENED,
        prUrl: "https://github.com/acme/repo/pull/1",
        prNumber: 1,
        prChecksStatus: "passing",
      },
      {
        pr: makePr({ checksStatus: "passing" }),
        blockingSubtasks: subs,
        settings: {
          stallThresholdMs: 300_000,
          autoMerge: true,
          cautiousMode: false,
          autoResume: false,
          reviewEnabled: false,
          reviewTrigger: null,
          offPeakOnly: false,
          offPeakActive: false,
          hasReviewSubtask: true,
          maxAutoResumes: 10,
          recentAutoResumeCount: 0,
        },
      },
    );
    expect(reconcileRepo(s).kind).not.toBe("autoMergePr");
  });

  it("non-blocking subtask does not block auto-merge", () => {
    const subs: DependencyObservation[] = [
      { taskId: "info", state: TaskState.RUNNING, blocksParent: false },
    ];
    const s = repoSnapshot(
      {},
      {
        state: TaskState.PR_OPENED,
        prUrl: "https://github.com/acme/repo/pull/1",
        prNumber: 1,
        prChecksStatus: "passing",
      },
      {
        pr: makePr({ checksStatus: "passing" }),
        blockingSubtasks: subs,
        settings: {
          stallThresholdMs: 300_000,
          autoMerge: true,
          cautiousMode: false,
          autoResume: false,
          reviewEnabled: false,
          reviewTrigger: null,
          offPeakOnly: false,
          offPeakActive: false,
          hasReviewSubtask: false,
          maxAutoResumes: 10,
          recentAutoResumeCount: 0,
          maxAutoResumes: 10,
          recentAutoResumeCount: 0,
        },
      },
    );
    expect(reconcileRepo(s).kind).toBe("autoMergePr");
  });
});

// ─── FAILED with open PR ───

describe("FAILED — PR still watched", () => {
  it("failed + PR open, autoResume cannot resume failed (edge: skip)", () => {
    const s = repoSnapshot(
      {},
      {
        state: TaskState.FAILED,
        prUrl: "https://github.com/acme/repo/pull/1",
        prNumber: 1,
        prChecksStatus: "passing",
      },
      {
        pr: makePr({ mergeable: false, checksStatus: "passing" }),
        settings: {
          stallThresholdMs: 300_000,
          autoMerge: false,
          cautiousMode: false,
          autoResume: true,
          reviewEnabled: false,
          reviewTrigger: null,
          offPeakOnly: false,
          offPeakActive: false,
          hasReviewSubtask: false,
          maxAutoResumes: 10,
          recentAutoResumeCount: 0,
          maxAutoResumes: 10,
          recentAutoResumeCount: 0,
        },
      },
    );
    // canResume = false for FAILED → falls through to needs_attention path.
    const action = reconcileRepo(s);
    expect(action.kind).toBe("transition");
    if (action.kind === "transition") {
      expect(action.to).toBe(TaskState.NEEDS_ATTENTION);
    }
  });
});
