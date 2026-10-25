import { describe, it, expect } from "vitest";
import { collectNeedsYou } from "./needs-you";

const NOW = Date.parse("2026-09-17T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("collectNeedsYou — a task with its PR open", () => {
  it("is listed as waiting on you, with the MR or PR to review and merge as its link", () => {
    const items = collectNeedsYou(
      [],
      [
        {
          id: "mr",
          title: "GitLab task",
          state: "pr_opened",
          repoUrl: "https://gitlab.example/acme/app",
          prUrl: "https://gitlab.example/acme/app/-/merge_requests/12",
          errorMessage: null,
          updatedAt: ago(60_000),
        },
        {
          id: "pr",
          title: "GitHub task",
          state: "pr_opened",
          repoUrl: "https://github.com/acme/app",
          prUrl: "https://github.com/acme/app/pull/7",
          errorMessage: null,
          updatedAt: ago(30_000),
        },
        {
          id: "stuck",
          title: "Needs attention",
          state: "needs_attention",
          repoUrl: "https://github.com/acme/app",
          prUrl: null,
          errorMessage: "merge conflict",
          updatedAt: ago(10_000),
        },
      ],
    );
    expect(items.map((i) => i.key)).toEqual(["task-mr", "task-pr", "task-stuck"]);
    expect(items[0]).toMatchObject({
      kind: "task",
      reason: "Review and merge the MR",
      href: "https://gitlab.example/acme/app/-/merge_requests/12",
      where: "acme/app",
    });
    expect(items[1]).toMatchObject({
      reason: "Review and merge the PR",
      href: "https://github.com/acme/app/pull/7",
    });
    expect(items[2]).toMatchObject({ reason: "merge conflict", href: "/work/stuck" });
  });

  it("falls back to the task page when the PR URL is missing", () => {
    const [item] = collectNeedsYou(
      [],
      [{ id: "t", title: "x", state: "pr_opened", prUrl: null, updatedAt: ago(1) }],
    );
    expect(item).toMatchObject({ reason: "Review and merge the PR", href: "/work/t" });
  });
});
