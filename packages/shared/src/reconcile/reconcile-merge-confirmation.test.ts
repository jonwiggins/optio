import { describe, it, expect } from "vitest";
import { reconcileRepo } from "./reconcile-repo.js";
import type { WorldSnapshot, PrStatus } from "./types.js";
import { TaskState } from "../types/task.js";

// The auto-merge path under the deployment's merge confirmation
// (work/auto-merge.ts): off, autoMerge alone decides; on, only a confirmed
// setting merges, and never over "changes requested".

const NOW = new Date("2026-04-17T12:00:00Z");

function pr(overrides: Partial<PrStatus> = {}): PrStatus {
  return {
    url: "https://github.com/acme/repo/pull/1",
    number: 1,
    state: "open",
    merged: false,
    mergeable: true,
    checksStatus: "passing",
    reviewStatus: "none",
    latestReviewComments: null,
    ...overrides,
  };
}

function snapshot(
  settings: Partial<WorldSnapshot["settings"]>,
  prOverrides: Partial<PrStatus> = {},
): WorldSnapshot {
  return {
    now: NOW,
    run: {
      kind: "repo",
      ref: { kind: "repo", id: "task-1" },
      spec: {
        repoUrl: "https://github.com/acme/repo",
        repoBranch: "main",
        agentType: "claude-code",
        prompt: "fix the bug",
        title: "Fix bug",
        taskType: "coding",
        maxRetries: 3,
        priority: 100,
        ignoreOffPeak: false,
        parentTaskId: null,
        blocksParent: false,
        workspaceId: "ws-1",
        runTarget: "cluster",
      },
      status: {
        state: TaskState.PR_OPENED,
        prUrl: "https://github.com/acme/repo/pull/1",
        prNumber: 1,
        prState: "open",
        prChecksStatus: "passing",
        prReviewStatus: prOverrides.reviewStatus ?? "none",
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
      },
    },
    pod: null,
    pr: pr(prOverrides),
    dependencies: [],
    blockingSubtasks: [],
    capacity: { global: { running: 1, max: 5 }, repo: { running: 0, max: 2 } },
    heartbeat: { lastActivityAt: null, isStale: false, silentForMs: 0 },
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
      ...settings,
    },
    readErrors: [],
  };
}

describe("auto-merge without the merge confirmation (the default)", () => {
  it("merges on autoMerge alone, as before", () => {
    expect(reconcileRepo(snapshot({})).kind).toBe("autoMergePr");
    expect(reconcileRepo(snapshot({ mergeConfirmationRequired: false })).kind).toBe("autoMergePr");
  });

  it("ignores the confirmation fields while it is off", () => {
    expect(reconcileRepo(snapshot({ autoMergeConfirmed: false })).kind).toBe("autoMergePr");
  });
});

describe("auto-merge with the merge confirmation on", () => {
  it("merges a confirmed setting", () => {
    const s = snapshot({ mergeConfirmationRequired: true, autoMergeConfirmed: true });
    expect(reconcileRepo(s).kind).toBe("autoMergePr");
  });

  it("never merges an unconfirmed or unknown one (fails closed)", () => {
    for (const autoMergeConfirmed of [false, undefined]) {
      const s = snapshot({ mergeConfirmationRequired: true, autoMergeConfirmed });
      expect(reconcileRepo(s).kind).not.toBe("autoMergePr");
    }
  });

  it("never merges over a reviewer's changes requested", () => {
    const s = snapshot(
      { mergeConfirmationRequired: true, autoMergeConfirmed: true },
      { reviewStatus: "changes_requested" },
    );
    expect(reconcileRepo(s).kind).not.toBe("autoMergePr");
  });

  it("still holds back in cautious mode", () => {
    const s = snapshot({
      mergeConfirmationRequired: true,
      autoMergeConfirmed: true,
      cautiousMode: true,
    });
    expect(reconcileRepo(s).kind).not.toBe("autoMergePr");
  });
});
