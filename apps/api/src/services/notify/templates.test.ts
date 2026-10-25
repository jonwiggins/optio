import { afterEach, describe, expect, it, vi } from "vitest";
import {
  absoluteLink,
  publicWebUrl,
  renderNotice,
  renderTestEmail,
  renderWorkEmail,
  repoName,
  workPath,
  type WorkSummary,
} from "./templates.js";

const BASE = "https://optio.example.com";

const task: WorkSummary = {
  id: "t-1",
  kind: "repo",
  title: "Add a health endpoint",
  repoUrl: "https://gitlab.example.com/platform/hello-service.git",
  prUrl: "https://gitlab.example.com/platform/hello-service/-/merge_requests/7",
  errorMessage: null,
};

afterEach(() => vi.unstubAllEnvs());

describe("links", () => {
  it("reads PUBLIC_URL without its trailing slash, and nothing without one", () => {
    vi.stubEnv("PUBLIC_URL", "https://optio.example.com/");
    expect(publicWebUrl()).toBe(BASE);
    vi.stubEnv("PUBLIC_URL", "");
    expect(publicWebUrl()).toBeNull();
  });

  it("points a Task at /work/:id and a Job run under its Job", () => {
    expect(workPath({ id: "t-1", kind: "repo" })).toBe("/work/t-1");
    expect(workPath({ id: "r-1", kind: "standalone", workId: "j-1" })).toBe("/jobs/j-1/runs/r-1");
  });

  it("makes paths absolute under Optio's address and leaves full URLs alone", () => {
    expect(absoluteLink("/usage", BASE)).toBe(`${BASE}/usage`);
    expect(absoluteLink("usage", BASE)).toBe(`${BASE}/usage`);
    expect(absoluteLink("https://gitlab.example.com/x", BASE)).toBe("https://gitlab.example.com/x");
    expect(absoluteLink("/usage", null)).toBeNull();
  });

  it("names a repo by its path", () => {
    expect(repoName(task.repoUrl)).toBe("platform/hello-service");
  });
});

describe("renderWorkEmail", () => {
  it("tells the owner their MR waits for them, with the MR and the work's page", () => {
    const e = renderWorkEmail("task.pr_opened", task, { why: "owner" }, BASE);
    expect(e.subject).toBe("[Optio] Merge request waiting for you: Add a health endpoint");
    expect(e.link).toBe(`${BASE}/work/t-1`);
    expect(e.text).toContain("waiting for you to review and merge it");
    expect(e.text).toMatch(/Repository: +platform\/hello-service/);
    expect(e.text).toContain(`Merge request: ${task.prUrl}`);
    expect(e.text).toMatch(/Open in Optio: +https:\/\/optio\.corp\.example\/work\/t-1/);
    expect(e.text).toContain("You get this email because this is your work.");
    expect(e.text).toContain(`Choose which emails you get: ${BASE}/settings#notifications`);
  });

  it("says why a team admin gets it", () => {
    const e = renderWorkEmail(
      "task.needs_attention",
      task,
      { why: "team-admin", teamName: "Platform" },
      BASE,
    );
    expect(e.subject).toBe("[Optio] Needs your attention: Add a health endpoint");
    expect(e.text).toContain("you're an admin of the team Platform, which owns this work");
  });

  it("includes what went wrong when work fails, clipped", () => {
    const e = renderWorkEmail(
      "task.failed",
      { ...task, prUrl: null, errorMessage: `boom ${"x".repeat(3000)}` },
      { why: "creator" },
      BASE,
    );
    expect(e.subject).toBe("[Optio] Failed: Add a health endpoint");
    expect(e.text).toContain("What went wrong:\nboom");
    expect(e.text).not.toContain("x".repeat(1600));
    expect(e.text).not.toContain("Merge request:");
    expect(e.text).toContain("because you started this work");
  });

  it("links a failed Job run to its run page", () => {
    const e = renderWorkEmail(
      "task.failed",
      {
        id: "r-1",
        kind: "standalone",
        workId: "j-1",
        title: "Nightly report",
        errorMessage: "exit 3",
      },
      { why: "owner" },
      BASE,
    );
    expect(e.link).toBe(`${BASE}/jobs/j-1/runs/r-1`);
    expect(e.text).toMatch(/Job run: +Nightly report/);
  });

  it("keeps a title with newlines on one line of the subject", () => {
    const e = renderWorkEmail(
      "task.completed",
      { ...task, title: "Fix\r\nBcc: x@y.z" },
      { why: "owner" },
      BASE,
    );
    expect(e.subject).toBe("[Optio] Merged: Fix Bcc: x@y.z");
  });

  it("works without PUBLIC_URL (no links, the settings path in words)", () => {
    const e = renderWorkEmail("task.pr_opened", task, { why: "owner" }, null);
    expect(e.link).toBeNull();
    expect(e.text).not.toContain("Open in Optio");
    expect(e.text).toContain("under Settings → Notifications");
  });
});

describe("renderNotice", () => {
  it("adds the link and the footer to another part of Optio's message", () => {
    const e = renderNotice(
      { subject: "Platform used 80% of its budget", body: "80 of 100 USD.", link: "/usage" },
      { why: "team", teamName: "Platform" },
      BASE,
    );
    expect(e.subject).toBe("[Optio] Platform used 80% of its budget");
    expect(e.text).toContain("80 of 100 USD.\n\nOpen in Optio: https://optio.example.com/usage");
    expect(e.text).toContain("You get this email as an admin of the team Platform.");
  });

  it("doesn't double the [Optio] prefix", () => {
    expect(
      renderNotice({ subject: "[Optio] x", body: "y" }, { why: "addressed" }, BASE).subject,
    ).toBe("[Optio] x");
  });

  it("writes the test email", () => {
    const e = renderTestEmail("Alice <alice@example.com>", BASE);
    expect(e.subject).toBe("[Optio] Test email");
    expect(e.text).toMatch(/Sent by: +Alice <alice@corp\.example>/);
  });
});
