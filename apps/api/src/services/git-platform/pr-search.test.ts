import { describe, it, expect } from "vitest";
import type { PullRequest } from "@optio/shared";
import {
  defaultBranchFirst,
  filterBranches,
  filterPullRequests,
  pullRequestMatches,
  pullRequestNumberOf,
  uniqueNewestFirst,
} from "./pr-search.js";

function pr(over: Partial<PullRequest>): PullRequest {
  return {
    number: 1,
    title: "",
    body: "",
    state: "open",
    merged: false,
    mergeable: null,
    draft: false,
    headSha: "",
    baseBranch: "main",
    url: `https://gitlab.example/g/p/-/merge_requests/${over.number ?? 1}`,
    author: "alice",
    assignees: [],
    labels: [],
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

describe("pullRequestMatches", () => {
  const row = pr({
    number: 12,
    title: "Fix login flow",
    body: "Closes #3",
    headBranch: "bug/login",
  });

  it("matches the number exactly, with or without a prefix", () => {
    expect(pullRequestMatches(row, "12")).toBe(true);
    expect(pullRequestMatches(row, "#12")).toBe(true);
    expect(pullRequestMatches(row, "!12")).toBe(true);
    expect(pullRequestMatches(row, "1")).toBe(false);
    expect(pullRequestMatches(row, "112")).toBe(false);
  });

  it("matches words in the title, body, head branch and author, ignoring case", () => {
    expect(pullRequestMatches(row, "LOGIN")).toBe(true);
    expect(pullRequestMatches(row, "closes")).toBe(true);
    expect(pullRequestMatches(row, "bug/")).toBe(true);
    expect(pullRequestMatches(row, "alice")).toBe(true);
    expect(pullRequestMatches(row, "payments")).toBe(false);
  });

  it("matches everything when blank", () => {
    expect(pullRequestMatches(row, "")).toBe(true);
    expect(pullRequestMatches(row, "   ")).toBe(true);
  });
});

describe("pullRequestNumberOf", () => {
  it("reads a bare, # or ! number and nothing else", () => {
    expect(pullRequestNumberOf("12")).toBe(12);
    expect(pullRequestNumberOf(" #12 ")).toBe(12);
    expect(pullRequestNumberOf("!12")).toBe(12);
    expect(pullRequestNumberOf("12a")).toBeNull();
    expect(pullRequestNumberOf("fix")).toBeNull();
  });
});

describe("filterPullRequests / uniqueNewestFirst", () => {
  it("keeps the order and drops non-matches", () => {
    const rows = [pr({ number: 1, title: "a" }), pr({ number: 2, title: "b" })];
    expect(filterPullRequests(rows, "b").map((p) => p.number)).toEqual([2]);
    expect(filterPullRequests(rows).map((p) => p.number)).toEqual([1, 2]);
  });

  it("dedupes by url and sorts newest first", () => {
    const old = pr({ number: 1, updatedAt: "2024-01-01T00:00:00Z" });
    const fresh = pr({ number: 2, updatedAt: "2024-02-01T00:00:00Z" });
    expect(uniqueNewestFirst([old, fresh, old]).map((p) => p.number)).toEqual([2, 1]);
  });
});

describe("branches", () => {
  it("puts the default branch first and filters by name", () => {
    const rows = [
      { name: "release/1", default: false },
      { name: "main", default: true },
      { name: "feature/x", default: false },
    ];
    expect(defaultBranchFirst(rows).map((b) => b.name)).toEqual(["main", "release/1", "feature/x"]);
    expect(filterBranches(rows, "REL").map((b) => b.name)).toEqual(["release/1"]);
    expect(filterBranches(rows, "").map((b) => b.name)).toHaveLength(3);
  });
});
