import { describe, expect, it } from "vitest";
import {
  describeWorkLinkStatus,
  statusableWorkLinks,
  summarizeChecks,
  summarizeReviews,
} from "./work-link-status.js";
import { workLinkFromUrl } from "./extract-work-links.js";

describe("summarizeChecks", () => {
  it("is none with no checks, pending while any runs, failing over everything", () => {
    expect(summarizeChecks([])).toBe("none");
    expect(
      summarizeChecks([
        { name: "a", status: "completed", conclusion: "success" },
        { name: "b", status: "in_progress", conclusion: null },
      ]),
    ).toBe("pending");
    expect(
      summarizeChecks([
        { name: "a", status: "in_progress", conclusion: null },
        { name: "b", status: "completed", conclusion: "failure" },
      ]),
    ).toBe("failing");
    expect(
      summarizeChecks([
        { name: "a", status: "completed", conclusion: "success" },
        { name: "b", status: "completed", conclusion: "skipped" },
      ]),
    ).toBe("passing");
  });
});

describe("summarizeReviews", () => {
  it("takes each reviewer's latest verdict, changes requested outranking approvals", () => {
    expect(summarizeReviews([])).toBe("none");
    expect(summarizeReviews([{ author: "a", state: "COMMENTED", body: "" }])).toBe("none");
    expect(
      summarizeReviews([
        { author: "a", state: "CHANGES_REQUESTED", body: "" },
        { author: "a", state: "APPROVED", body: "" },
      ]),
    ).toBe("approved");
    expect(
      summarizeReviews([
        { author: "a", state: "APPROVED", body: "" },
        { author: "b", state: "CHANGES_REQUESTED", body: "" },
      ]),
    ).toBe("changes_requested");
    expect(
      summarizeReviews([
        { author: "a", state: "CHANGES_REQUESTED", body: "" },
        { author: "a", state: "DISMISSED", body: "" },
      ]),
    ).toBe("none");
  });
});

describe("describeWorkLinkStatus", () => {
  it("spells the state and, for an open PR, CI and review", () => {
    expect(describeWorkLinkStatus(undefined)).toBe("");
    expect(describeWorkLinkStatus({ url: "u", state: null })).toBe("");
    expect(describeWorkLinkStatus({ url: "u", state: "merged" })).toBe("merged");
    expect(
      describeWorkLinkStatus({ url: "u", state: "open", checks: "passing", review: "approved" }),
    ).toBe("open · CI passing · approved");
    expect(
      describeWorkLinkStatus({ url: "u", state: "open", checks: "none", review: "none" }),
    ).toBe("open");
    expect(describeWorkLinkStatus({ url: "u", state: "in_progress" })).toBe("in progress");
  });
});

describe("workLinkFromUrl", () => {
  it("reads one PR / ticket URL and rejects anything else", () => {
    expect(workLinkFromUrl("https://github.com/acme/app/pull/607")).toEqual({
      url: "https://github.com/acme/app/pull/607",
      kind: "pr",
      provider: "github",
      label: "acme/app#607",
    });
    expect(workLinkFromUrl("https://linear.app/acme/issue/ENG-12/slug")?.label).toBe("ENG-12");
    expect(workLinkFromUrl("https://example.com/not-a-pr")).toBeNull();
    expect(workLinkFromUrl("https://github.com/acme/app")).toBeNull();
  });

  it("keeps PRs, issues and refs for status lookups", () => {
    const ref = {
      url: "https://github.com/acme/app/issues/5",
      kind: "ref" as const,
      provider: "github" as const,
      label: "#5",
    };
    expect(statusableWorkLinks([ref])).toEqual([ref]);
  });
});
