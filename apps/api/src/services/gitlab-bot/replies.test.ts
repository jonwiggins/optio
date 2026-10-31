import { describe, expect, it } from "vitest";
import {
  ackReply,
  helpReply,
  outcomeReply,
  publicReason,
  refusalReply,
  runLink,
  shortReason,
} from "./replies.js";
import { issueTaskPrompt, mergeRequestTaskPrompt, resumePrompt } from "./prompts.js";
import { GITHUB_WORDS } from "./words.js";

const BASE = "https://optio.example.test";

describe("replies", () => {
  it("link the run on Optio, or name it without PUBLIC_URL", () => {
    expect(runLink("t1", BASE)).toBe(`${BASE}/work/t1`);
    expect(runLink("t1", null)).toBeNull();
    expect(ackReply("alice", "issue", "t1", null)).toContain("(run t1)");
  });

  it("answer the person and never name the bot outside code", () => {
    for (const body of [
      ackReply("alice", "issue", "t1", BASE),
      ackReply("alice", "resume", "t1", BASE),
      ackReply("alice", "mr", "t1", BASE, { sourceBranch: "feature/x" }),
      refusalReply("alice", { code: "no_account", username: "alice" }, BASE),
      refusalReply("alice", { code: "rate_limited", limit: 5 }, BASE),
      outcomeReply({ author: "alice", state: "failed", taskId: "t1", base: BASE, sameMr: false }),
    ]) {
      expect(body.startsWith("@alice ")).toBe(true);
      expect(body).not.toMatch(/(^|[^`])@optio/);
    }
    const help = helpReply("alice", "optio-bot");
    expect(help).toContain("`@optio-bot add a health check`");
    expect(help).not.toMatch(/fix pipeline|team:/);
    expect(help).not.toMatch(/(^|[\s(])@optio-bot/);
  });

  it("say where the change goes", () => {
    expect(ackReply("a", "mr", "t", BASE, { sourceBranch: "feature/x" })).toContain(
      "a merge request into `feature/x`",
    );
  });

  it("word each refusal", () => {
    expect(refusalReply("a", { code: "viewer", project: "p/q" }, BASE)).toContain("viewer");
    expect(refusalReply("a", { code: "gitlab_access", project: "p/q" }, BASE)).toContain(
      "Developer role on `p/q`",
    );
    expect(refusalReply("a", { code: "busy", taskId: "t9" }, BASE)).toContain(`${BASE}/work/t9`);
    expect(refusalReply("a", { code: "mr_closed", state: "closed" }, BASE)).toContain("is closed");
  });

  it("say how to be found, without any email", () => {
    const none = refusalReply("a", { code: "no_account", username: "a" }, BASE);
    expect(none).toContain("this GitLab account isn't linked to one");
    expect(none).toContain(`Sign in to Optio (${BASE}) with this GitLab account`);
    expect(none).not.toMatch(/username|@[\w.-]+\.[a-z]+/);
  });

  it("count the rate limit per person", () => {
    expect(refusalReply("a", { code: "rate_limited", limit: 5 }, BASE)).toContain(
      "at most 5 from one person per merge request or issue in 10 minutes",
    );
  });

  it("never post an internal error, only a reference to it", () => {
    const body = refusalReply("a", { code: "error", ref: "0b5f-ref" }, BASE);
    expect(body).toBe(
      "@a Something went wrong on my side and I couldn't start the work. An Optio admin can look it up with the reference `0b5f-ref`.",
    );
    expect(refusalReply("a", { code: "no_branch" }, BASE)).toContain(
      "didn't say which branch this merge request is from",
    );
  });

  it("mask secrets in a reason and cut it", () => {
    expect(shortReason("failed: PRIVATE-TOKEN: glpat-" + "abcdefghijklmnopqrstuv")).not.toContain(
      "glpat-" + "abcdefghijklmnopqrstuv",
    );
    expect(shortReason("x".repeat(1000), 50)).toHaveLength(50);
  });

  it("report each way a run ends", () => {
    const base = { author: "a", taskId: "t1", base: BASE };
    expect(outcomeReply({ ...base, state: "pr_opened", sameMr: true })).toContain(
      "pushed the changes to this merge request",
    );
    expect(
      outcomeReply({
        ...base,
        state: "pr_opened",
        sameMr: false,
        prUrl: "https://g/p/-/merge_requests/3",
      }),
    ).toContain("https://g/p/-/merge_requests/3 is ready for your review");
    expect(
      outcomeReply({
        ...base,
        state: "needs_attention",
        sameMr: false,
        reason: publicReason("completed_without_pr", null),
      }),
    ).toContain("This needs you: the agent finished without opening a merge request");
    expect(outcomeReply({ ...base, state: "failed", sameMr: false, reason: null })).toContain(
      "no reason given",
    );
    expect(outcomeReply({ ...base, state: "cancelled", sameMr: false })).toContain("cancelled");
    expect(outcomeReply({ ...base, state: "completed", sameMr: false })).toBe(
      `@a Done (${BASE}/work/t1).`,
    );
  });

  it("say why a run stopped by its class, never its error message", () => {
    const stderr =
      "Agent exited with code 1: open /home/runner/.config/internal.corp.lan/creds: DB_PASSWORD unset";
    expect(publicReason(null, stderr)).not.toMatch(/home|corp|DB_PASSWORD/);
    expect(publicReason(null, "OOMKilled")).toBe("Out of memory");
    expect(publicReason("agent_failed", "something only the run's viewers should read")).toBe("");
    expect(publicReason("ci_failing", "Pipeline 99 failed: secret=1", GITHUB_WORDS)).toBe(
      "its pull request's checks fail",
    );
    expect(publicReason(undefined, "  ")).toBe("");
    const failed = outcomeReply({
      author: "a",
      taskId: "t1",
      base: BASE,
      state: "failed",
      sameMr: false,
      reason: publicReason(null, stderr),
    });
    expect(failed).not.toMatch(/home|corp|DB_PASSWORD/);
  });

  it("don't name the owner when the work is someone else's", () => {
    expect(refusalReply("a", { code: "not_yours" }, BASE)).toBe(
      "@a This merge request is someone else's work in Optio, so I can't change it for you.",
    );
  });
});

describe("prompts", () => {
  const ctx = {
    author: "alice",
    project: "platform/hello-service",
    noteUrl: "https://g/n/1",
    iid: 3,
    title: "README is missing a line",
    description: "Say how to run the tests.",
    url: "https://g/i/3",
  };

  it("quote the request and add the issue", () => {
    const p = issueTaskPrompt(ctx, "add a line\nabout tests");
    expect(p).toContain("@alice asked on issue #3");
    expect(p).toContain("> add a line\n> about tests");
    expect(p).toContain("Say how to run the tests.");
    expect(p).toContain("Closes #3");
    expect(issueTaskPrompt(ctx, "")).toContain("asked you to work on issue #3");
  });

  it("send someone else's merge request's work into its branch", () => {
    const p = mergeRequestTaskPrompt(
      { ...ctx, sourceBranch: "feature/x", targetBranch: "main" },
      "rename it",
    );
    expect(p).toContain("merges `feature/x` into `main`");
    expect(p).toContain("your merge request goes into `feature/x`");
  });

  it("resume on the same merge request", () => {
    const p = resumePrompt(ctx, "rename it");
    expect(p).toContain("your merge request !3");
    expect(p).toContain("Don't open another merge request");
  });
});
