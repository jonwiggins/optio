/**
 * The reconciler and run attachment (docs/plans/scale-out.md §2): every
 * kind re-attaches a run whose agent runs with nobody streaming it, puts
 * back a run whose starter went away before its agent started, and counts
 * a stall only while an instance streams the run.
 */
import { describe, it, expect } from "vitest";
import {
  ATTACH_LEASE_MS,
  attachAttempt,
  attachJobId,
  attachmentIsLive,
  readExecution,
  type RunExecution,
} from "./attachment.js";
import { reconcileRepo } from "./reconcile-repo.js";
import { reconcileStandalone } from "./reconcile-standalone.js";
import { NO_OPEN_TURN_GRACE_MS, reconcilePersistentAgent } from "./reconcile-persistent-agent.js";
import { reconcilePrReview } from "./reconcile-pr-review.js";
import type {
  PersistentAgentRunStatus,
  PodStatus,
  PrReviewRunStatus,
  RepoRunStatus,
  Run,
  StandaloneRunStatus,
  WorldSnapshot,
} from "./types.js";
import { TaskState } from "../types/task.js";
import { WorkflowRunState } from "../types/workflow.js";
import { PersistentAgentState, PersistentAgentPodLifecycle } from "../types/persistent-agent.js";
import { PrReviewState, PrReviewRunState } from "../types/pr-review.js";

const NOW = new Date("2026-10-10T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const inFuture = (ms: number) => new Date(NOW.getTime() + ms);
const EXPIRED = ago(5_000);

function execution(overrides: Partial<RunExecution> = {}): RunExecution {
  return {
    runId: "run-1",
    execState: "started",
    attachedBy: "api-0:abc123",
    attachLeaseUntil: inFuture(30_000),
    touchedAt: ago(1_000),
    ...overrides,
  };
}

const unattached = (overrides: Partial<RunExecution> = {}) =>
  execution({ attachLeaseUntil: EXPIRED, ...overrides });

const deadPod: PodStatus = { podName: "pod-a", phase: "error", lastError: "OOMKilled" };

function world(run: Run, extras: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    now: NOW,
    run,
    pod: null,
    pr: null,
    dependencies: [],
    blockingSubtasks: [],
    capacity: { global: { running: 1, max: 5 } },
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

const STALE = { lastActivityAt: ago(600_000), isStale: true, silentForMs: 600_000 };

// ── The reading ──────────────────────────────────────────────────────────────

describe("attachment reading", () => {
  it("a lease in the future is live; a past one is not", () => {
    expect(attachmentIsLive(execution(), NOW)).toBe(true);
    expect(attachmentIsLive(unattached(), NOW)).toBe(false);
  });

  it("with no lease yet, a freshly touched row is live for two lease periods", () => {
    const fresh = execution({ attachLeaseUntil: null, touchedAt: ago(ATTACH_LEASE_MS) });
    const old = execution({ attachLeaseUntil: null, touchedAt: ago(2 * ATTACH_LEASE_MS + 1) });
    expect(attachmentIsLive(fresh, NOW)).toBe(true);
    expect(attachmentIsLive(old, NOW)).toBe(false);
    expect(attachmentIsLive(execution({ attachLeaseUntil: null, touchedAt: null }), NOW)).toBe(
      false,
    );
  });

  it("reads nothing observed as unknown, so decisions fall back to the old rules", () => {
    expect(readExecution(undefined, NOW)).toEqual({ kind: "unknown" });
    expect(readExecution(null, NOW)).toEqual({ kind: "unknown" });
  });

  it("a started or settling run nobody holds is detached, named by its expired lease", () => {
    expect(readExecution(unattached(), NOW)).toEqual({
      kind: "detached",
      attempt: EXPIRED.getTime(),
    });
    expect(readExecution(unattached({ execState: "exited" }), NOW).kind).toBe("detached");
    expect(readExecution(execution(), NOW)).toEqual({ kind: "attached" });
  });

  it("a run never started says whether the protocol ever held it", () => {
    expect(readExecution(unattached({ execState: null }), NOW)).toEqual({
      kind: "never_started",
      held: true,
    });
    expect(
      readExecution(
        execution({
          execState: null,
          attachedBy: null,
          attachLeaseUntil: null,
          touchedAt: ago(9e6),
        }),
        NOW,
      ),
    ).toEqual({ kind: "never_started", held: false });
  });

  it("an attempt is the expired lease; its job id has no ':' (BullMQ)", () => {
    expect(attachAttempt(unattached())).toBe(EXPIRED.getTime());
    expect(attachAttempt(execution({ attachLeaseUntil: null }))).toBe(0);
    expect(attachJobId("abc", 42)).toBe("attach__abc__42");
    expect(attachJobId("abc", 42)).not.toContain(":");
  });
});

// ── Repo Tasks ───────────────────────────────────────────────────────────────

function repoRun(status: Partial<RepoRunStatus>, runTarget: "cluster" | "local" = "cluster"): Run {
  return {
    kind: "repo",
    ref: { kind: "repo", id: "run-1" },
    spec: {
      repoUrl: "https://github.com/acme/repo",
      repoBranch: "main",
      agentType: "claude-code",
      prompt: "p",
      title: "t",
      taskType: "coding",
      maxRetries: 3,
      priority: 100,
      ignoreOffPeak: false,
      parentTaskId: null,
      blocksParent: false,
      workspaceId: null,
      runTarget,
    },
    status: {
      state: TaskState.RUNNING,
      prUrl: null,
      prNumber: null,
      prState: null,
      prChecksStatus: null,
      prReviewStatus: null,
      prReviewComments: null,
      containerId: null,
      sessionId: null,
      worktreeState: null,
      lastPodId: "pod-a",
      lastActivityAt: null,
      retryCount: 0,
      errorMessage: null,
      costUsd: null,
      startedAt: null,
      completedAt: null,
      controlIntent: null,
      reconcileBackoffUntil: null,
      reconcileAttempts: 0,
      updatedAt: ago(1_000),
      ...status,
    },
  };
}

describe("reconcileRepo — attachment", () => {
  const running = repoRun({ state: TaskState.RUNNING });
  const provisioning = repoRun({ state: TaskState.PROVISIONING });

  it("re-attaches a running task nobody streams", () => {
    expect(reconcileRepo(world(running, { execution: unattached() }))).toEqual({
      kind: "reattach",
      runId: "run-1",
      attempt: EXPIRED.getTime(),
      reason: "running_unattached",
    });
  });

  it("re-attaches a task whose result was half recorded (exited, unattached)", () => {
    const action = reconcileRepo(
      world(running, { execution: unattached({ execState: "exited" }) }),
    );
    expect(action.kind).toBe("reattach");
  });

  it("an unattached run's silence is no stall: it is re-attached first", () => {
    const action = reconcileRepo(world(running, { execution: unattached(), heartbeat: STALE }));
    expect(action.kind).toBe("reattach");
  });

  it("a stall counts while an instance streams the run", () => {
    const action = reconcileRepo(world(running, { execution: execution(), heartbeat: STALE }));
    expect(action).toMatchObject({
      kind: "transition",
      to: TaskState.FAILED,
      trigger: "stall_detected",
    });
  });

  it("with no execution observed, a stall counts as before", () => {
    const action = reconcileRepo(world(running, { heartbeat: STALE }));
    expect(action).toMatchObject({ kind: "transition", trigger: "stall_detected" });
  });

  it("a dead pod fails an unattached run with the pod's reason, not a re-attach", () => {
    const action = reconcileRepo(world(running, { execution: unattached(), pod: deadPod }));
    expect(action).toMatchObject({
      kind: "transition",
      to: TaskState.FAILED,
      trigger: "running_pod_died",
      statusPatch: { errorMessage: "OOMKilled" },
    });
  });

  it("a running task that predates the protocol needs attention (its outcome is unknown)", () => {
    const legacy = execution({
      execState: null,
      attachedBy: null,
      attachLeaseUntil: null,
      touchedAt: ago(10 * ATTACH_LEASE_MS),
    });
    expect(reconcileRepo(world(running, { execution: legacy }))).toMatchObject({
      kind: "transition",
      to: TaskState.NEEDS_ATTENTION,
      trigger: "execution_interrupted",
    });
  });

  it("re-attaches a provisioning task whose agent started (its starter went away)", () => {
    expect(reconcileRepo(world(provisioning, { execution: unattached() }))).toMatchObject({
      kind: "reattach",
      runId: "run-1",
      reason: "provisioning_started_unattached",
    });
  });

  it("requeues a provisioning task whose starter went away before the agent started", () => {
    expect(
      reconcileRepo(world(provisioning, { execution: unattached({ execState: null }) })),
    ).toEqual({
      kind: "requeueRun",
      runId: "run-1",
      trigger: "provisioning_interrupted",
      reason: "provisioning_unattached_never_started",
    });
  });

  it("leaves a provisioning task alone while it is held, or freshly claimed with no lease yet", () => {
    expect(
      reconcileRepo(world(provisioning, { execution: execution({ execState: null }) })),
    ).toEqual({ kind: "noop", reason: "provisioning_in_progress" });
    const justClaimed = execution({
      execState: null,
      attachedBy: null,
      attachLeaseUntil: null,
      touchedAt: ago(500),
    });
    expect(reconcileRepo(world(provisioning, { execution: justClaimed })).kind).toBe("noop");
  });

  it("a dead pod still fails a provisioning task first", () => {
    const action = reconcileRepo(world(provisioning, { execution: unattached(), pod: deadPod }));
    expect(action).toMatchObject({ kind: "transition", trigger: "provisioning_pod_died" });
  });

  it("a cancel intent wins over a re-attach", () => {
    const action = reconcileRepo(
      world(repoRun({ state: TaskState.RUNNING, controlIntent: "cancel" }), {
        execution: unattached(),
      }),
    );
    expect(action).toMatchObject({ kind: "transition", to: TaskState.CANCELLED });
  });

  it("a local task has no execution to re-attach", () => {
    const local = repoRun({ state: TaskState.RUNNING }, "local");
    expect(reconcileRepo(world(local, { execution: null, heartbeat: STALE }))).toEqual({
      kind: "noop",
      reason: "running_local",
    });
  });
});

// ── Job runs ─────────────────────────────────────────────────────────────────

function jobRun(status: Partial<StandaloneRunStatus> = {}): Run {
  return {
    kind: "standalone",
    ref: { kind: "standalone", id: "run-1" },
    spec: {
      workflowId: "wf-1",
      workflowEnabled: true,
      agentRuntime: "claude-code",
      promptRendered: "p",
      params: null,
      maxConcurrent: 2,
      maxRetries: 0,
      workspaceId: null,
      runTarget: "cluster",
    },
    status: {
      state: WorkflowRunState.RUNNING,
      costUsd: null,
      errorMessage: null,
      sessionId: null,
      podName: "pod-a",
      retryCount: 0,
      startedAt: ago(60_000),
      finishedAt: null,
      controlIntent: null,
      reconcileBackoffUntil: null,
      reconcileAttempts: 0,
      updatedAt: ago(1_000),
      ...status,
    },
  };
}

describe("reconcileStandalone — attachment", () => {
  it("re-attaches a running Job run nobody streams, stale or not", () => {
    for (const heartbeat of [world(jobRun()).heartbeat, STALE]) {
      expect(reconcileStandalone(world(jobRun(), { execution: unattached(), heartbeat }))).toEqual({
        kind: "reattach",
        runId: "run-1",
        attempt: EXPIRED.getTime(),
        reason: "running_unattached",
      });
    }
  });

  it("an unattached run on a dead pod fails with the pod's reason", () => {
    const action = reconcileStandalone(world(jobRun(), { execution: unattached(), pod: deadPod }));
    expect(action).toMatchObject({
      kind: "transition",
      to: WorkflowRunState.FAILED,
      trigger: "pod_died",
      statusPatch: { recoveryRequired: true, errorMessage: "OOMKilled" },
    });
  });

  it("requeues a run whose claimer went away before the agent started", () => {
    expect(
      reconcileStandalone(world(jobRun(), { execution: unattached({ execState: null }) })),
    ).toEqual({
      kind: "requeueRun",
      runId: "run-1",
      trigger: "start_interrupted",
      reason: "running_unattached_never_started",
    });
  });

  it("a run that predates the protocol fails as uncertain, awaiting an explicit retry", () => {
    const legacy = execution({
      execState: null,
      attachedBy: null,
      attachLeaseUntil: null,
      touchedAt: ago(10 * ATTACH_LEASE_MS),
    });
    expect(reconcileStandalone(world(jobRun(), { execution: legacy }))).toMatchObject({
      kind: "transition",
      to: WorkflowRunState.FAILED,
      trigger: "execution_interrupted",
      statusPatch: { recoveryRequired: true },
    });
  });

  it("a stall counts while attached", () => {
    const action = reconcileStandalone(
      world(jobRun(), { execution: execution(), heartbeat: STALE }),
    );
    expect(action).toMatchObject({ kind: "transition", trigger: "stall_detected" });
  });

  it("a recorded finish settles before anything about the attachment", () => {
    const done = jobRun({ finishedAt: ago(10) });
    expect(reconcileStandalone(world(done, { execution: unattached() }))).toMatchObject({
      kind: "transition",
      to: WorkflowRunState.COMPLETED,
    });
  });
});

// ── Persistent agents ────────────────────────────────────────────────────────

function agentRun(status: Partial<PersistentAgentRunStatus>): Run {
  return {
    kind: "persistent-agent",
    ref: { kind: "persistent-agent", id: "agent-1" },
    spec: {
      agentId: "agent-1",
      slug: "forge",
      workspaceId: null,
      agentRuntime: "claude-code",
      enabled: true,
      podLifecycle: PersistentAgentPodLifecycle.STICKY,
      idlePodTimeoutMs: 600_000,
      consecutiveFailureLimit: 3,
      maxTurnDurationMs: 1_800_000,
    },
    status: {
      state: PersistentAgentState.RUNNING,
      errorMessage: null,
      sessionId: null,
      consecutiveFailures: 0,
      lastFailureAt: null,
      lastFailureReason: null,
      lastTurnAt: null,
      totalCostUsd: "0",
      controlIntent: null,
      reconcileBackoffUntil: null,
      reconcileAttempts: 0,
      updatedAt: ago(1_000),
      pendingMessages: 0,
      oldestPendingAt: null,
      ...status,
    },
  };
}

describe("reconcilePersistentAgent — attachment", () => {
  const turn = (overrides: Partial<RunExecution> = {}) =>
    unattached({ runId: "turn-7", ...overrides });

  it("re-attaches a running turn nobody streams (by the turn's id)", () => {
    expect(
      reconcilePersistentAgent(world(agentRun({}), { execution: turn(), heartbeat: STALE })),
    ).toEqual({
      kind: "reattach",
      runId: "turn-7",
      attempt: EXPIRED.getTime(),
      reason: "running_turn_unattached",
    });
  });

  it("an unattached turn on a dead pod fails the agent with the pod's reason", () => {
    const action = reconcilePersistentAgent(
      world(agentRun({}), { execution: turn(), pod: deadPod }),
    );
    expect(action).toMatchObject({
      kind: "transition",
      to: PersistentAgentState.FAILED,
      trigger: "pod_died",
    });
  });

  it("a stall counts while attached", () => {
    const action = reconcilePersistentAgent(
      world(agentRun({}), { execution: execution({ runId: "turn-7" }), heartbeat: STALE }),
    );
    expect(action).toMatchObject({ kind: "transition", trigger: "stall_detected" });
  });

  it("re-attaches a provisioning agent whose turn's agent started", () => {
    const action = reconcilePersistentAgent(
      world(agentRun({ state: PersistentAgentState.PROVISIONING }), { execution: turn() }),
    );
    expect(action).toMatchObject({ kind: "reattach", runId: "turn-7" });
  });

  it("puts back a turn whose starter went away before its agent started", () => {
    const action = reconcilePersistentAgent(
      world(agentRun({ state: PersistentAgentState.PROVISIONING }), {
        execution: turn({ execState: null }),
      }),
    );
    expect(action).toEqual({
      kind: "requeueRun",
      runId: "turn-7",
      trigger: "turn_start_interrupted",
      reason: "provisioning_turn_unattached_never_started",
    });
  });

  it("an agent stuck provisioning with no turn is put back only after the grace", () => {
    const fresh = agentRun({ state: PersistentAgentState.PROVISIONING, updatedAt: ago(60_000) });
    const stuck = agentRun({
      state: PersistentAgentState.PROVISIONING,
      updatedAt: ago(NO_OPEN_TURN_GRACE_MS + 1),
    });
    expect(reconcilePersistentAgent(world(fresh, { execution: null })).kind).toBe("noop");
    expect(reconcilePersistentAgent(world(stuck, { execution: null }))).toMatchObject({
      kind: "requeueRun",
      runId: null,
    });
    // Unknown (no observation) is not "no turn".
    expect(reconcilePersistentAgent(world(stuck)).kind).toBe("noop");
  });

  it("a running agent whose turn was halted but never moved on is put back after the grace", () => {
    const stuck = agentRun({ updatedAt: ago(NO_OPEN_TURN_GRACE_MS + 1) });
    expect(reconcilePersistentAgent(world(stuck, { execution: null }))).toMatchObject({
      kind: "requeueRun",
      runId: null,
      trigger: "turn_settle_interrupted",
    });
    expect(reconcilePersistentAgent(world(agentRun({}), { execution: null })).kind).toBe("noop");
  });

  it("a turn that predates the protocol fails the agent as uncertain", () => {
    const legacy = execution({
      runId: "turn-7",
      execState: null,
      attachedBy: null,
      attachLeaseUntil: null,
      touchedAt: ago(10 * ATTACH_LEASE_MS),
    });
    expect(reconcilePersistentAgent(world(agentRun({}), { execution: legacy }))).toMatchObject({
      kind: "transition",
      to: PersistentAgentState.FAILED,
      trigger: "execution_interrupted",
    });
  });
});

// ── PR reviews ───────────────────────────────────────────────────────────────

function reviewRun(status: Partial<PrReviewRunStatus>): Run {
  return {
    kind: "pr-review",
    ref: { kind: "pr-review", id: "review-1" },
    spec: {
      prUrl: "https://github.com/acme/repo/pull/3",
      prNumber: 3,
      repoOwner: "acme",
      repoName: "repo",
      repoUrl: "https://github.com/acme/repo",
      workspaceId: null,
      origin: "manual",
      userEngaged: false,
      autoSubmitted: false,
      headSha: "abc",
      autoSubmitOnReady: false,
      maxAutoRereviews: 3,
    },
    status: {
      state: PrReviewState.REVIEWING,
      verdict: null,
      summary: null,
      fileComments: null,
      submittedAt: null,
      errorMessage: null,
      controlIntent: null,
      latestRunKind: "initial",
      latestRunState: PrReviewRunState.RUNNING,
      recentAutoRereviewCount: 0,
      reconcileBackoffUntil: null,
      reconcileAttempts: 0,
      updatedAt: ago(1_000),
      ...status,
    },
  };
}

describe("reconcilePrReview — attachment", () => {
  const run = (overrides: Partial<RunExecution> = {}) =>
    unattached({ runId: "rr-2", ...overrides });

  it("re-attaches the review's active run (by the run's id)", () => {
    expect(reconcilePrReview(world(reviewRun({}), { execution: run() }))).toEqual({
      kind: "reattach",
      runId: "rr-2",
      attempt: EXPIRED.getTime(),
      reason: "review_run_unattached",
    });
  });

  it("re-attaches a chat run too, whatever state the review is in", () => {
    const ready = reviewRun({ state: PrReviewState.READY, latestRunKind: "chat" });
    expect(reconcilePrReview(world(ready, { execution: run() })).kind).toBe("reattach");
  });

  it("re-attaches without the PR (a failed PR read does not hold it up)", () => {
    const action = reconcilePrReview(
      world(reviewRun({}), {
        execution: run(),
        readErrors: [{ source: "pr", message: "rate limited" }],
      }),
    );
    expect(action.kind).toBe("reattach");
  });

  it("requeues a run whose starter went away before its agent started", () => {
    expect(
      reconcilePrReview(world(reviewRun({}), { execution: run({ execState: null }) })),
    ).toEqual({
      kind: "requeueRun",
      runId: "rr-2",
      trigger: "review_run_start_interrupted",
      reason: "review_run_unattached_never_started",
    });
  });

  it("an attached run leaves the review's own decision alone", () => {
    expect(
      reconcilePrReview(world(reviewRun({}), { execution: execution({ runId: "rr-2" }) })),
    ).toEqual({
      kind: "noop",
      reason: "reviewing_in_progress",
    });
  });

  it("a cancel intent wins over a re-attach", () => {
    const action = reconcilePrReview(
      world(reviewRun({ controlIntent: "cancel" }), { execution: run() }),
    );
    expect(action).toMatchObject({ kind: "transition", to: PrReviewState.CANCELLED });
  });
});
