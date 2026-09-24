import { describe, expect, it } from "vitest";
import {
  dedupeWorkLinks,
  extractHyperlinkUrls,
  extractWorkLinks,
  MAX_WORK_LINKS,
  workLinkIdentity,
  type WorkLink,
} from "./extract-work-links.js";

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

  it("heals only lines long enough to have wrapped when the width is known", () => {
    // "…/pull/612" ends a short line; the next opens with a count, not more PR number.
    const stat =
      "https://github.com/jonwiggins/optio/pull/612\n19 files changed, 300 insertions(+)";
    expect(extractWorkLinks(stat, { wrapWidth: 120 }).map((l) => l.label)).toEqual([
      "jonwiggins/optio#612",
    ]);
    // A line that ran to the edge (48 columns here) is a hard wrap: healed.
    const wrapped =
      "  ⏺ PR opened: https://github.com/jonwiggins/optio/pull/\n    581 — CI running";
    expect(extractWorkLinks(wrapped, { wrapWidth: 48 }).map((l) => l.label)).toEqual([
      "jonwiggins/optio#581",
    ]);
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

  it("harvests URLs from OSC 8 hyperlinks (BEL and ST terminated)", () => {
    const raw =
      "PR:\x1b[7G\x1b]8;id=pl872k;https://github.com/jonwiggins/optio/pull/581\x07#581\x1b]8;;\x07 and " +
      "\x1b]8;;https://linear.app/acme/issue/ENG-7\x1b\\ENG-7\x1b]8;;\x1b\\";
    expect(extractHyperlinkUrls(raw)).toEqual([
      "https://github.com/jonwiggins/optio/pull/581",
      "https://linear.app/acme/issue/ENG-7",
    ]);
  });

  it("resolves bare #N mentions against the dir's GitHub remote, skipping numbers a URL already covers", () => {
    const links = extractWorkLinks(
      "Note that #539 is opened from a fork. See https://github.com/jonwiggins/optio/pull/581 (#581). Also #12, and issue#7 is not a ref, nor #fff.",
      { repoUrl: "https://github.com/jonwiggins/optio" },
    );
    expect(links.map((l) => [l.kind, l.label, l.url])).toEqual([
      ["pr", "jonwiggins/optio#581", "https://github.com/jonwiggins/optio/pull/581"],
      ["ref", "#539", "https://github.com/jonwiggins/optio/issues/539"],
      ["ref", "#12", "https://github.com/jonwiggins/optio/issues/12"],
    ]);
  });

  it("ignores bare #N when the remote is not GitHub/GitLab or absent", () => {
    expect(extractWorkLinks("fix #12", { repoUrl: "https://bitbucket.org/a/b" })).toEqual([]);
    expect(extractWorkLinks("fix #12")).toEqual([]);
  });
});

describe("dedupeWorkLinks", () => {
  const pr: WorkLink = {
    url: "https://github.com/acme/app/pull/607",
    kind: "pr",
    provider: "github",
    label: "acme/app#607",
  };
  const ref: WorkLink = {
    url: "https://github.com/acme/app/issues/607",
    kind: "ref",
    provider: "github",
    label: "#607",
  };

  it("keeps one badge per PR: a bare #607 seen first gives way to its PR, in its place", () => {
    const other: WorkLink = {
      ...pr,
      url: "https://github.com/acme/app/pull/9",
      label: "acme/app#9",
    };
    expect(dedupeWorkLinks([ref, other, pr])).toEqual([pr, other]);
  });

  it("matches owner and repo whatever their case, and PR vs issue URLs of one number", () => {
    const shouty: WorkLink = {
      ...pr,
      url: "https://github.com/Acme/App/pull/607",
      label: "Acme/App#607",
    };
    const asIssue: WorkLink = {
      ...pr,
      url: "https://github.com/acme/app/issues/607",
      kind: "issue",
    };
    expect(dedupeWorkLinks([pr, shouty, asIssue])).toHaveLength(1);
  });

  it("prefers the fuller label between two of a kind", () => {
    const ticket: WorkLink = { ...pr, label: "#607" };
    expect(dedupeWorkLinks([ticket, pr])).toEqual([pr]);
  });

  it("keeps GitLab merge requests and issues of one number apart", () => {
    const mr: WorkLink = {
      url: "https://gitlab.com/g/p/-/merge_requests/5",
      kind: "pr",
      provider: "gitlab",
      label: "g/p!5",
    };
    const issue: WorkLink = {
      url: "https://gitlab.com/g/p/-/issues/5",
      kind: "issue",
      provider: "gitlab",
      label: "g/p#5",
    };
    expect(dedupeWorkLinks([mr, issue])).toEqual([mr, issue]);
  });

  it("goes by the key for Linear and Jira", () => {
    const a: WorkLink = {
      url: "https://linear.app/acme/issue/ENG-12",
      kind: "issue",
      provider: "linear",
      label: "ENG-12",
    };
    expect(workLinkIdentity(a)).toBe("linear:ENG-12");
    expect(dedupeWorkLinks([a, { ...a, url: `${a.url}/fix-the-thing` }])).toHaveLength(1);
  });
});
