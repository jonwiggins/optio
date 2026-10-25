import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskState } from "@optio/shared";

const getTaskByPrUrl = vi.hoisted(() => vi.fn());
const transitionTask = vi.hoisted(() => vi.fn());
vi.mock("./task-service.js", () => ({ getTaskByPrUrl, transitionTask }));
const enqueueReconcile = vi.hoisted(() => vi.fn());
vi.mock("./reconcile-queue.js", () => ({ enqueueReconcile }));
const syncAllTickets = vi.hoisted(() => vi.fn());
vi.mock("./ticket-sync-service.js", () => ({ syncAllTickets }));
vi.mock("../logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

import {
  applyGitLabHookUpdates,
  hookMergeRequestUrl,
  issueGotTicketLabel,
} from "./gitlab-hook-updates.js";

const MR = "https://gitlab.example.test/acme/app/-/merge_requests/7";
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  getTaskByPrUrl.mockReset().mockResolvedValue({ id: "task-1" });
  transitionTask.mockReset().mockResolvedValue({});
  enqueueReconcile.mockReset().mockResolvedValue(undefined);
  syncAllTickets.mockReset().mockResolvedValue(1);
});

describe("an issue hook", () => {
  it("syncs tickets when the issue just got the optio label, once at a time", async () => {
    const labeled = {
      object_kind: "issue",
      object_attributes: { iid: 3, action: "update" },
      changes: {
        labels: { previous: [{ title: "bug" }], current: [{ title: "bug" }, { title: "optio" }] },
      },
    };
    expect(issueGotTicketLabel(labeled)).toBe(true);
    await applyGitLabHookUpdates(labeled);
    await applyGitLabHookUpdates(labeled); // during the first sync: covered by it
    await flush();
    expect(syncAllTickets).toHaveBeenCalledTimes(1);
    expect(getTaskByPrUrl).not.toHaveBeenCalled();
  });

  it("opened with the label counts; another label change or an unlabeled issue doesn't", () => {
    expect(
      issueGotTicketLabel({
        object_kind: "issue",
        object_attributes: { action: "open" },
        labels: [{ title: "optio" }],
      }),
    ).toBe(true);
    expect(
      issueGotTicketLabel({
        object_kind: "issue",
        object_attributes: { action: "update" },
        labels: [{ title: "optio" }],
        changes: {
          labels: { previous: [{ title: "optio" }], current: [{ title: "optio" }, { title: "x" }] },
        },
      }),
    ).toBe(false);
    expect(
      issueGotTicketLabel({
        object_kind: "issue",
        object_attributes: { action: "open" },
        labels: [],
      }),
    ).toBe(false);
  });
});

describe("a merge request, pipeline or comment hook on a task's MR", () => {
  it("a merged MR completes its task at once, as GitHub's merge does", async () => {
    await applyGitLabHookUpdates({
      object_kind: "merge_request",
      object_attributes: { action: "merge", url: MR },
    });
    expect(getTaskByPrUrl).toHaveBeenCalledWith(MR);
    expect(transitionTask).toHaveBeenCalledWith("task-1", TaskState.COMPLETED, "pr_merged", MR);
    expect(enqueueReconcile).not.toHaveBeenCalled();
  });

  it("a merge that can't complete the task (already done) leaves it to the reconciler", async () => {
    transitionTask.mockRejectedValue(new Error("Invalid state transition"));
    await applyGitLabHookUpdates({
      object_kind: "merge_request",
      object_attributes: { action: "merge", url: MR },
    });
    expect(enqueueReconcile).toHaveBeenCalledWith(
      { kind: "repo", id: "task-1" },
      { reason: "gitlab_hook:merge_request:merge" },
    );
  });

  it("an update, a pipeline or a comment wakes the task's reconcile", async () => {
    await applyGitLabHookUpdates({
      object_kind: "merge_request",
      object_attributes: { action: "update", url: MR },
    });
    await applyGitLabHookUpdates({
      object_kind: "pipeline",
      object_attributes: { status: "failed" },
      merge_request: { iid: 7, url: MR },
    });
    await applyGitLabHookUpdates({
      object_kind: "note",
      object_attributes: { noteable_type: "MergeRequest" },
      merge_request: { iid: 7, url: MR },
    });
    expect(enqueueReconcile.mock.calls.map((c) => c[1].reason)).toEqual([
      "gitlab_hook:merge_request:update",
      "gitlab_hook:pipeline",
      "gitlab_hook:note",
    ]);
    expect(transitionTask).not.toHaveBeenCalled();
  });

  it("ignores an MR no task opened, a branch pipeline, and other events", async () => {
    getTaskByPrUrl.mockResolvedValue(null);
    await applyGitLabHookUpdates({
      object_kind: "merge_request",
      object_attributes: { action: "merge", url: MR },
    });
    expect(
      hookMergeRequestUrl({ object_kind: "pipeline", object_attributes: { status: "success" } }),
    ).toBeNull();
    await applyGitLabHookUpdates({ object_kind: "pipeline", object_attributes: {} });
    await applyGitLabHookUpdates({ object_kind: "push", ref: "refs/heads/main" });
    expect(transitionTask).not.toHaveBeenCalled();
    expect(enqueueReconcile).not.toHaveBeenCalled();
    expect(syncAllTickets).not.toHaveBeenCalled();
  });
});
