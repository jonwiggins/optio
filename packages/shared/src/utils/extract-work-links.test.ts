import { describe, expect, it } from "vitest";
import { extractWorkLinks, MAX_WORK_LINKS } from "./extract-work-links.js";

describe("extractWorkLinks", () => {
  it("finds GitHub PRs and issues with owner/repo#N labels", () => {
    const links = extractWorkLinks(
      "Opened https://github.com/acme/widgets/pull/42 for https://github.com/acme/widgets/issues/7.",
    );
    expect(links).toEqual([
      {
        url: "https://github.com/acme/widgets/pull/42",
        kind: "pr",
        provider: "github",
        label: "acme/widgets#42",
      },
      {
        url: "https://github.com/acme/widgets/issues/7",
        kind: "issue",
        provider: "github",
        label: "acme/widgets#7",
      },
    ]);
  });

  it("finds GitLab MRs/issues (any host, nested groups), Linear and Jira tickets", () => {
    const links = extractWorkLinks(
      [
        "https://gitlab.example.com/platform/core/api/-/merge_requests/15",
        "https://gitlab.com/g/p/-/issues/3",
        "https://linear.app/acme/issue/ENG-123/fix-the-thing",
        "https://acme.atlassian.net/browse/OPS-9?focusedCommentId=1",
      ].join(" "),
    );
    expect(links.map((l) => [l.provider, l.kind, l.label])).toEqual([
      ["gitlab", "pr", "platform/core/api!15"],
      ["gitlab", "issue", "g/p#3"],
      ["linear", "issue", "ENG-123"],
      ["jira", "issue", "OPS-9"],
    ]);
    expect(links[2].url).toBe("https://linear.app/acme/issue/ENG-123");
    expect(links[3].url).toBe("https://acme.atlassian.net/browse/OPS-9");
  });

  it("heals TUI hard-wraps: a URL split across newline + indentation is still found", () => {
    const wrapped =
      "  ⏺ PR opened: https://github.com/jonwiggins/optio/pull/\n    581 — CI running";
    expect(extractWorkLinks(wrapped).map((l) => l.label)).toEqual(["jonwiggins/optio#581"]);
  });

  it("dedupes by URL, keeps first-seen order, ignores trailing punctuation and query strings", () => {
    const text =
      "see https://github.com/a/b/pull/1). again https://github.com/a/b/pull/1?diff=split then https://github.com/a/b/pull/2";
    expect(extractWorkLinks(text).map((l) => l.url)).toEqual([
      "https://github.com/a/b/pull/1",
      "https://github.com/a/b/pull/2",
    ]);
  });

  it("ignores generic URLs and repo roots", () => {
    expect(
      extractWorkLinks(
        "https://github.com/a/b and https://example.com/browse-all https://docs.x.io",
      ),
    ).toEqual([]);
  });

  it("caps the result", () => {
    const text = Array.from({ length: 80 }, (_, i) => `https://github.com/a/b/pull/${i + 1}`).join(
      "\n",
    );
    expect(extractWorkLinks(text)).toHaveLength(MAX_WORK_LINKS);
  });
});
