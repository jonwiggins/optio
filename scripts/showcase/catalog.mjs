// Fictional, reusable examples. Every automatic trigger is seeded disabled.
export const examples = [
  {
    key: "dependencies",
    name: "Keep dependencies current",
    kind: "repo-blueprint",
    runtime: "codex",
    trigger: "schedule",
    config: { cronExpression: "0 9 * * 1-5" },
    prompt:
      "Review outdated dependencies. Update one compatible group, run the tests, and open a draft PR with a concise changelog.",
  },
  {
    key: "github-review",
    name: "Review incoming pull requests",
    kind: "repo-blueprint",
    runtime: "claude-code",
    trigger: "github",
    config: { events: ["pr_opened"], repos: ["example/storefront"] },
    prompt:
      "Review {{title}}. Check correctness, tests, and migration safety. Explain findings with file references; leave the merge decision to a person.",
  },
  {
    key: "linear",
    name: "Turn a Linear issue into a PR",
    kind: "repo-blueprint",
    runtime: "codex",
    trigger: "linear",
    config: { events: ["created"] },
    prompt:
      "Implement {{title}} using the acceptance criteria in {{description}}. Add focused tests and open a draft PR.",
  },
  {
    key: "ticket",
    name: "Pick up labeled GitHub issues",
    kind: "repo-blueprint",
    runtime: "copilot",
    trigger: "ticket",
    config: { source: "github", labels: ["optio"] },
    prompt:
      "Investigate {{ticketTitle}}. Make a focused change, verify it, and explain the result in a draft PR.",
  },
  {
    key: "morning",
    name: "Morning engineering briefing",
    kind: "standalone",
    runtime: "gemini",
    trigger: "schedule",
    config: { cronExpression: "0 8 * * 1-5" },
    prompt:
      "Prepare a short engineering briefing from the connected issue tracker and repository activity. Group blockers, shipped work, and decisions. Draft the report for review.",
  },
  {
    key: "incident",
    name: "Investigate a production incident",
    kind: "standalone",
    runtime: "claude-code",
    trigger: "pagerduty",
    config: { events: ["incident.triggered"], urgency: "high" },
    prompt:
      "Investigate {{title}}. Use read-only logs and metrics to form a timeline, likely cause, and next steps. Do not change production or send messages without approval.",
  },
  {
    key: "slack",
    name: "Answer an engineering question",
    kind: "standalone",
    runtime: "claude-code",
    trigger: "slack",
    config: { channelId: "C0EXAMPLE", postedBy: "people" },
    prompt:
      "Research the question in {{text}} using the connected documentation and source code. Draft an answer with citations for a teammate to review.",
  },
  {
    key: "webhook",
    name: "Explain a failed deployment",
    kind: "standalone",
    runtime: "opencode",
    trigger: "webhook",
    config: { path: "optio-example-deployment" },
    prompt:
      "Analyze deployment {{deployment}} and its failure {{error}}. Compare recent changes and produce a rollback recommendation. Make no external changes.",
  },
  {
    key: "support",
    name: "Triage a customer escalation",
    kind: "standalone",
    runtime: "cursor",
    trigger: "pylon",
    config: { events: ["issue.created"] },
    prompt:
      "Summarize the customer issue in {{title}}, identify the relevant component, and draft reproduction steps and a response for human review.",
  },
  {
    key: "shell",
    name: "Run the nightly smoke checks",
    kind: "standalone",
    runtime: null,
    trigger: "schedule",
    config: { cronExpression: "0 2 * * *" },
    prompt: "printf 'Example smoke check: configure your own endpoints before enabling.\\n'",
  },
  {
    key: "local",
    name: "Review a PR on my machine",
    kind: "local-blueprint",
    runtime: "claude-code",
    trigger: "github",
    config: {
      events: ["review_requested"],
      login: "example-developer",
      repos: ["example/storefront"],
    },
    prompt:
      "Review {{title}} in this checkout. Summarize the change, identify risks, and wait for me before posting anything.",
  },
  {
    key: "manual",
    name: "Prepare a release checklist",
    kind: "standalone",
    runtime: "openclaw",
    trigger: "manual",
    config: {},
    prompt:
      "Draft a release checklist covering migrations, deployment order, smoke checks, and rollback. Do not publish or deploy anything.",
  },
];
export const agents = [
  {
    key: "coordinator",
    name: "Engineering coordinator",
    runtime: "claude-code",
    prompt:
      "Coordinate a team of specialists. Break a request into bounded tasks, ask the reviewer to check results, and report back before external changes.",
  },
  {
    key: "researcher",
    name: "Codebase researcher",
    runtime: "gemini",
    prompt:
      "Answer architecture questions with specific source references. Report findings to the coordinator. Work read-only unless explicitly asked to edit.",
  },
  {
    key: "reviewer",
    name: "Release reviewer",
    runtime: "codex",
    prompt:
      "Review proposed changes, test evidence, and deployment risks. Return actionable feedback to the coordinator. Never merge or deploy automatically.",
  },
];
