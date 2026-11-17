import {
  comparePrInboxItems,
  derivePrStatus,
  type PrAgentLink,
  type PrFacts,
  type PrInboxItem,
  type PrInboxResponse,
  type PrOptioReview,
} from "@optio/shared";

/**
 * A believable /api/pr-inbox answer for the browser tests (and screenshots):
 * real `derivePrStatus` over hand-written facts, so the rows say what the
 * server would say. The viewer is @jon.
 */

const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

const REPOS = {
  web: {
    id: "11111111-1111-4111-8111-111111111111",
    fullName: "acme/web",
    repoUrl: "https://github.com/acme/web",
  },
  api: {
    id: "22222222-2222-4222-8222-222222222222",
    fullName: "acme/api",
    repoUrl: "https://github.com/acme/api",
  },
  infra: {
    id: "33333333-3333-4333-8333-333333333333",
    fullName: "acme/infra",
    repoUrl: "https://github.com/acme/infra",
  },
};

function facts(repo: keyof typeof REPOS, number: number, over: Partial<PrFacts>): PrFacts {
  return {
    url: `https://github.com/${REPOS[repo].fullName}/pull/${number}`,
    number,
    title: "Untitled",
    platform: "github",
    repoFullName: REPOS[repo].fullName,
    author: "jon",
    draft: false,
    createdAt: ago(30),
    updatedAt: ago(1),
    headBranch: `branch-${number}`,
    baseBranch: "main",
    headSha: "abc123",
    isFork: false,
    lastPushAt: ago(6),
    checks: "passing",
    failingChecks: [],
    mergeState: "clean",
    reviewDecision: "review_required",
    reviews: [],
    requestedReviewers: [],
    requestedTeams: [],
    assignees: [],
    threads: [],
    comments: [],
    bodyMentions: [],
    ...over,
  };
}

const ROWS: Array<{
  repo: keyof typeof REPOS;
  facts: PrFacts;
  agent?: PrAgentLink;
  optioReview?: PrOptioReview;
}> = [
  {
    repo: "web",
    facts: facts("web", 742, {
      title: "Redis cluster pub/sub fallback for the session bus",
      checks: "failing",
      failingChecks: ["Web E2E (Playwright 3/6)", "Typecheck"],
      requestedReviewers: ["kim"],
      lastPushAt: ago(3),
    }),
  },
  {
    repo: "api",
    facts: facts("api", 318, {
      title: "Codex credential refresh on 401",
      reviewDecision: "changes_requested",
      reviews: [{ author: "asaf", state: "changes_requested", submittedAt: ago(5) }],
      threads: [
        {
          resolved: false,
          participants: ["asaf", "jon"],
          lastAuthor: "asaf",
          lastAt: ago(5),
          path: "src/auth.ts",
        },
        {
          resolved: false,
          participants: ["asaf"],
          lastAuthor: "asaf",
          lastAt: ago(5),
          path: "src/refresh.ts",
        },
      ],
      lastPushAt: ago(20),
    }),
  },
  {
    repo: "web",
    facts: facts("web", 745, {
      title: "GitLab MR pipelines in the PR status strip",
      author: "kim",
      requestedReviewers: ["jon", "lee"],
      createdAt: ago(26),
    }),
  },
  {
    repo: "infra",
    facts: facts("infra", 91, {
      title: "Bump the Helm chart to 0.7",
      mergeState: "conflict",
      requestedReviewers: ["lee"],
    }),
  },
  {
    repo: "api",
    facts: facts("api", 322, {
      title: "Queue fairness across workspaces",
      threads: [
        {
          resolved: false,
          participants: ["lee", "jon"],
          lastAuthor: "lee",
          lastAt: ago(0.7),
          path: "src/queue.ts",
        },
      ],
      requestedReviewers: [],
      reviews: [{ author: "lee", state: "commented", submittedAt: ago(2) }],
    }),
  },
  {
    repo: "web",
    facts: facts("web", 733, {
      title: "Fix ⌥↑ in the web terminal",
      reviewDecision: "approved",
      reviews: [{ author: "kim", state: "approved", submittedAt: ago(1.5) }],
    }),
  },
  {
    repo: "api",
    facts: facts("api", 327, {
      title: "Contributor: OpenTelemetry spans for the reconciler",
      author: "asaf",
      isFork: true,
      requestedReviewers: ["jon"],
      createdAt: ago(50),
    }),
    optioReview: { id: "44444444-4444-4444-8444-444444444444", state: "ready", verdict: "comment" },
  },
  {
    repo: "web",
    facts: facts("web", 729, {
      title: "Fix worktree cleanup after a retried task",
      author: "optio-agent[bot]",
      checks: "failing",
      failingChecks: ["Unit"],
    }),
    agent: {
      taskId: "55555555-5555-4555-8555-555555555555",
      title: "Fix worktree cleanup after a retried task",
      state: "running",
      startedByViewer: true,
    },
  },
  {
    repo: "infra",
    facts: facts("infra", 88, {
      title: "Alertmanager receiver for the staging cluster",
      checks: "pending",
      requestedReviewers: ["kim"],
    }),
  },
  {
    repo: "web",
    facts: facts("web", 740, {
      title: "Getting-started checklist copy",
      requestedReviewers: ["kim", "lee"],
      lastPushAt: ago(80),
      createdAt: ago(90),
    }),
  },
  {
    repo: "api",
    facts: facts("api", 301, {
      title: "Drop the legacy /api/task-configs alias",
      author: "lee",
      requestedReviewers: [],
      reviewDecision: "changes_requested",
      reviews: [{ author: "jon", state: "changes_requested", submittedAt: ago(30) }],
      lastPushAt: ago(40),
    }),
  },
  {
    repo: "web",
    facts: facts("web", 701, {
      title: "Dark mode for the usage charts",
      author: "sam",
      checks: "failing",
      failingChecks: ["lint"],
      requestedReviewers: ["kim"],
    }),
  },
  {
    repo: "infra",
    facts: facts("infra", 80, {
      title: "WIP: Terraform for the EKS node groups",
      draft: true,
      checks: "none",
    }),
  },
];

export function prInboxFixture(handles: string[] = ["jon"]): PrInboxResponse {
  const viewer = { handles };
  const items: PrInboxItem[] = ROWS.map((r) => ({
    facts: r.facts,
    status: derivePrStatus(r.facts, viewer, { agent: r.agent, optioReview: r.optioReview }),
    repo: REPOS[r.repo],
    agent: r.agent ?? null,
    optioReview: r.optioReview ?? null,
  }));
  items.sort(comparePrInboxItems);
  return {
    viewer: {
      handles,
      source: handles.length ? "sign-in" : "none",
      suggestedHandle: handles.length ? null : "jon",
    },
    items,
    errors: [
      { repo: "acme/legacy", message: "Optio's token can't read this repository's pull requests" },
    ],
    fetchedAt: new Date().toISOString(),
  };
}
