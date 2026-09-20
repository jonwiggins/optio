import Link from "next/link";

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Optio",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Kubernetes",
  description:
    "Self-hosted AI agent swarm and workflow orchestration platform. Run Claude Code, Codex, Copilot, Gemini, Cursor, OpenCode, and OpenClaw as sessions on your Kubernetes cluster or your own machines: ticket-to-merged-PR pipelines, scheduled and webhook-driven jobs, event automations, interactive terminals, and persistent multi-agent systems.",
  url: "https://optio.host",
  license: "https://opensource.org/licenses/MIT",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
  sourceOrganization: {
    "@type": "Organization",
    name: "Optio",
    url: "https://github.com/jonwiggins/optio",
  },
};

const features = [
  {
    title: "One Session Model",
    description:
      "Every kind of agent work is a session with five attributes — When, Where, Who, What, Then. One form creates a PR task, a cron job, a laptop automation, an interactive terminal, or a persistent agent; one feed shows them all with one status scale.",
    color: "#6d28d9",
  },
  {
    title: "Agent Swarms",
    description:
      "Persistent agents with a stable name, an inbox, and a turn loop. They wake on messages, webhooks, cron ticks, or tickets and message each other over an inter-agent API — dispatcher, specialists, reviewer — with per-agent pod lifecycle.",
    color: "#a78bfa",
  },
  {
    title: "Your Cluster or Your Laptop",
    description:
      "Sessions run in isolated pods on your Kubernetes cluster or in a directory on a paired machine using its own CLI login. Same triggers, same prompts, same feed — and no server secrets ever ship to laptops.",
    color: "#60a5fa",
  },
  {
    title: "Autonomous PR Feedback Loop",
    description:
      "When a session opens a PR, Optio watches CI and review. CI fails? The agent resumes with the failure. Reviewer requests changes? It picks up the comments. Green and approved? Squash-merge and close the issue.",
    color: "#34d399",
  },
  {
    title: "Seven Agent Runtimes",
    description:
      "Claude Code, OpenAI Codex, GitHub Copilot, Google Gemini, Cursor, OpenCode, and OpenClaw behind one interface, with live model discovery. Pick per session or per repo; run a review agent on a different vendor than the author.",
    color: "#f0a040",
  },
  {
    title: "Triggers Everywhere",
    description:
      "Start sessions now, on a cron, from a webhook, from GitHub / GitLab / Linear / Jira / Notion tickets, or from signed GitHub, Slack, and Linear events. Trigger payloads render into prompts as {{params}}.",
    color: "#f06060",
  },
  {
    title: "Connections via MCP",
    description:
      "Give any session tools at runtime: Notion, Slack, Linear, GitHub, PostgreSQL, Sentry, Filesystem, custom MCP servers, and HTTP APIs, with fine-grained per-repo and per-runtime access control.",
    color: "#818cf8",
  },
  {
    title: "Knows When It Needs You",
    description:
      "Layered attention detection for interactive sessions — Claude Code hooks, terminal bell, silence — surfaced as a favicon, a tab count, a browser notification, iOS push, widgets, and a Live Activity. Plus live logs, costs, and usage limits.",
    color: "#fb923c",
  },
];

const attributes = [
  {
    name: "When",
    question: "What starts it?",
    color: "#6d28d9",
    options: [
      "Now",
      "A cron schedule",
      "A webhook",
      "A ticket: GitHub, GitLab, Linear, Jira, Notion",
      "A GitHub, Slack, or Linear event",
      "A message from a person or another agent",
    ],
  },
  {
    name: "Where",
    question: "Where does it run?",
    color: "#60a5fa",
    options: [
      "An Optio pod with one of your repos",
      "An Optio pod with no repo",
      "A directory on your own machine",
      "A new branch on your machine that becomes a PR",
    ],
  },
  {
    name: "Who",
    question: "What does the work?",
    color: "#f0a040",
    options: [
      "A bare terminal",
      "Claude Code, Codex, Copilot, Gemini",
      "Cursor, OpenCode, OpenClaw",
      "With the model and options you choose",
    ],
  },
  {
    name: "What",
    question: "What is it asked to do?",
    color: "#34d399",
    options: ["A prompt", "A saved prompt template", "{{params}} filled from the trigger payload"],
  },
  {
    name: "Then",
    question: "What happens after?",
    color: "#a78bfa",
    options: [
      "Exits when done — opens a PR or produces side effects",
      "Waits for you — an interactive session between turns",
      "Persistent agent — keeps memory, wakes on messages",
    ],
  },
];

const sentences = [
  "Started by Linear events, a Claude Code session on my laptop on a new branch in ~/src/app that opens a PR and exits when done.",
  "Running weekdays at 09:00 UTC, an OpenAI Codex session in an Optio pod that exits when done.",
  "Woken by messages, a Claude Code agent in an Optio pod that keeps its memory between turns.",
];

const stages = [
  {
    name: "Intake",
    description: "GitHub, GitLab, Linear, Jira, Notion, or manual",
    icon: "\u2192",
  },
  { name: "Queued", description: "Enters the pipeline", icon: "\u25C7" },
  { name: "Provisioning", description: "Find or create pod", icon: "\u2699" },
  { name: "Running", description: "Agent writes code", icon: "\u26A1" },
  { name: "PR Opened", description: "Opens pull request", icon: "\u2197" },
  { name: "CI & Review", description: "Checks & feedback", icon: "\u25CE" },
  { name: "Merged", description: "Squash-merge & close", icon: "\u2713" },
];

export default function Home() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      {/* Hero */}
      <section className="relative overflow-hidden px-6 pt-32 pb-24">
        <div className="absolute inset-0 animated-gradient" />
        <div className="relative mx-auto max-w-4xl text-center">
          <div className="animate-reveal">
            <span className="inline-flex items-center gap-2 rounded-full border border-border bg-bg-card px-4 py-1.5 text-[12px] font-medium text-text-muted">
              <span
                className="h-1.5 w-1.5 rounded-full glow-dot"
                style={{ backgroundColor: "var(--color-success)", color: "var(--color-success)" }}
              />
              Open source &middot; MIT licensed
            </span>
          </div>
          <h1
            className="mt-8 text-5xl font-bold tracking-tight text-text-heading sm:text-7xl animate-reveal"
            style={{ animationDelay: "100ms" }}
          >
            Orchestrate your
            <br />
            <span className="text-primary-light">agent swarm.</span>
          </h1>
          <p
            className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-muted animate-reveal"
            style={{ animationDelay: "200ms" }}
          >
            Optio is a self-hosted platform for running AI agents as durable, triggerable sessions
            &mdash; on your Kubernetes cluster or your own machines. Ticket-to-merged-PR pipelines,
            scheduled and webhook-driven jobs, event automations, interactive terminals, and
            long-lived agents that message each other, all in one feed.
          </p>
          <div
            className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row animate-reveal"
            style={{ animationDelay: "300ms" }}
          >
            <Link
              href="/docs/getting-started"
              className="rounded-md bg-primary px-8 py-3 text-[14px] font-semibold text-white hover:bg-primary-hover transition-colors"
            >
              Get Started
            </Link>
            <a
              href="https://github.com/jonwiggins/optio"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md border border-border px-8 py-3 text-[14px] font-semibold text-text hover:bg-bg-hover transition-colors"
            >
              View on GitHub
            </a>
          </div>
        </div>
      </section>

      {/* Quick Start */}
      <section className="border-t border-border px-6 py-16">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-2xl font-bold tracking-tight text-text-heading">
            Up and running in minutes
          </h2>
          <div className="mt-6 rounded-xl border border-border bg-bg-card p-5 text-left font-mono text-[13px]">
            <div className="mb-3 flex items-center gap-2 border-b border-border pb-3">
              <div
                className="h-3 w-3 rounded-full"
                style={{ backgroundColor: "rgba(240, 96, 96, 0.6)" }}
              />
              <div
                className="h-3 w-3 rounded-full"
                style={{ backgroundColor: "rgba(240, 160, 64, 0.6)" }}
              />
              <div
                className="h-3 w-3 rounded-full"
                style={{ backgroundColor: "rgba(52, 211, 153, 0.6)" }}
              />
              <span className="ml-2 text-[11px] text-text-muted">terminal</span>
            </div>
            <div className="space-y-1 text-text-muted">
              <p>
                <span className="text-success">$</span> git clone
                https://github.com/jonwiggins/optio.git
              </p>
              <p>
                <span className="text-success">$</span> cd optio
              </p>
              <p>
                <span className="text-success">$</span> ./scripts/setup-local.sh
              </p>
              <p className="text-text-muted/50 pt-2"># Dashboard at http://localhost:30310</p>
              <p className="text-text-muted/50"># API at http://localhost:30400</p>
            </div>
          </div>
          <p className="mt-4 text-[13px] text-text-muted">
            Requires Docker Desktop with Kubernetes enabled.{" "}
            <Link href="/docs/installation" className="text-primary-light hover:underline">
              Full installation guide &rarr;
            </Link>
          </p>
        </div>
      </section>

      {/* Sessions */}
      <section className="border-t border-border px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <div className="text-center">
            <h2 className="text-3xl font-bold tracking-tight text-text-heading sm:text-4xl">
              One noun. Five attributes.
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-text-muted">
              Every kind of work Optio runs is a{" "}
              <strong className="text-text-heading">session</strong>. Answer five questions and
              Optio derives the runtime &mdash; a repo worktree that opens a PR, a pooled job pod, a
              terminal on your laptop, a recurring blueprint, or a persistent agent.
            </p>
          </div>
          <div className="stagger mt-16 grid gap-4 md:grid-cols-5">
            {attributes.map((a) => (
              <div
                key={a.name}
                className="card-hover rounded-xl border border-border border-t-2 bg-bg-card p-5"
                style={{ borderTopColor: a.color }}
              >
                <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                  {a.question}
                </p>
                <h3 className="mt-1 text-[17px] font-bold text-text-heading">{a.name}</h3>
                <ul className="mt-3 space-y-1.5">
                  {a.options.map((o) => (
                    <li
                      key={o}
                      className="flex items-start gap-2 text-[12px] leading-snug text-text-muted"
                    >
                      <span
                        className="mt-1.5 h-1 w-1 shrink-0 rounded-full"
                        style={{ backgroundColor: a.color }}
                      />
                      {o}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div className="mx-auto mt-10 max-w-3xl space-y-2 text-center font-mono text-[13px] text-text-muted">
            {sentences.map((line) => (
              <p key={line} className="rounded-lg border border-border bg-bg-card px-4 py-2.5">
                {line}
              </p>
            ))}
          </div>
          <p className="mt-4 text-center text-[13px] text-text-muted">
            The New Session form reads your draft back as a sentence like these.{" "}
            <Link href="/docs/sessions" className="text-primary-light hover:underline">
              Read about the session model &rarr;
            </Link>
          </p>
        </div>
      </section>

      {/* Pipeline */}
      <section className="border-t border-border px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <div className="text-center">
            <h2 className="text-3xl font-bold tracking-tight text-text-heading sm:text-4xl">
              When a session opens a PR, Optio drives it to merge
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-text-muted">
              PR sessions flow through a seven-stage pipeline. Optio monitors each stage &mdash; in
              a pod or on your machine &mdash; and automatically drives the work forward.
            </p>
          </div>
          <div className="mt-16 relative">
            <div className="hidden items-start justify-between relative md:flex">
              <div className="absolute top-5 left-[7%] right-[7%] h-px bg-border" />
              {stages.map((stage, i) => (
                <div
                  key={stage.name}
                  className="relative flex w-[calc(100%/7)] flex-col items-center text-center"
                >
                  <div
                    className={`relative z-10 flex h-10 w-10 items-center justify-center rounded-full border-2 text-sm font-mono ${
                      i === stages.length - 1
                        ? "border-success bg-bg text-success"
                        : i === 3
                          ? "border-primary bg-bg text-primary-light"
                          : "border-border bg-bg text-text-muted"
                    }`}
                  >
                    {stage.icon}
                  </div>
                  <p className="mt-3 text-[13px] font-semibold text-text-heading">{stage.name}</p>
                  <p className="mt-1 text-[11px] leading-tight text-text-muted">
                    {stage.description}
                  </p>
                </div>
              ))}
            </div>
            <div className="space-y-4 md:hidden">
              {stages.map((stage, i) => (
                <div key={stage.name} className="flex items-center gap-4">
                  <div
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 text-sm font-mono ${
                      i === stages.length - 1
                        ? "border-success bg-bg text-success"
                        : i === 3
                          ? "border-primary bg-bg text-primary-light"
                          : "border-border bg-bg text-text-muted"
                    }`}
                  >
                    {stage.icon}
                  </div>
                  <div>
                    <p className="text-[13px] font-semibold text-text-heading">{stage.name}</p>
                    <p className="text-[12px] text-text-muted">{stage.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Feedback Loop */}
      <section className="border-t border-border bg-bg-subtle px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div>
              <h2 className="text-3xl font-bold tracking-tight text-text-heading sm:text-4xl">
                The feedback loop is
                <br />
                what makes it different.
              </h2>
              <p className="mt-4 leading-relaxed text-text-muted">
                Optio doesn&apos;t just run an agent and walk away. It watches the PR, feeds
                failures back to the agent, and keeps going until the work is done &mdash; and the
                same reconciler that drives PRs keeps jobs, terminals, and persistent agents from
                ever getting stuck.
              </p>
              <div className="mt-8 space-y-4">
                {[
                  {
                    trigger: "CI fails",
                    action: "Resume agent with failure context",
                    color: "var(--color-error)",
                  },
                  {
                    trigger: "Merge conflicts",
                    action: "Resume agent to rebase",
                    color: "var(--color-warning)",
                  },
                  {
                    trigger: "Review requests changes",
                    action: "Resume agent with feedback",
                    color: "var(--color-info)",
                  },
                  {
                    trigger: "CI passes + approved",
                    action: "Squash-merge & close issue",
                    color: "var(--color-success)",
                  },
                ].map((item) => (
                  <div key={item.trigger} className="flex items-start gap-3">
                    <div
                      className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: item.color }}
                    />
                    <div>
                      <span className="text-[13px] font-medium text-text-heading">
                        {item.trigger}
                      </span>
                      <span className="text-[13px] text-text-muted"> &rarr; {item.action}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-border bg-bg-card p-6 font-mono text-[13px]">
              <div className="mb-4 flex items-center gap-2 border-b border-border pb-4">
                <div
                  className="h-3 w-3 rounded-full"
                  style={{ backgroundColor: "rgba(240, 96, 96, 0.6)" }}
                />
                <div
                  className="h-3 w-3 rounded-full"
                  style={{ backgroundColor: "rgba(240, 160, 64, 0.6)" }}
                />
                <div
                  className="h-3 w-3 rounded-full"
                  style={{ backgroundColor: "rgba(52, 211, 153, 0.6)" }}
                />
                <span className="ml-2 text-[11px] text-text-muted">task lifecycle</span>
              </div>
              <div className="space-y-2 text-text-muted">
                <p>
                  <span className="text-info">{"\u2192"}</span> Task created from GitHub Issue #142
                </p>
                <p>
                  <span className="text-text-muted">{"\u25C7"}</span> Queued, waiting for pod...
                </p>
                <p>
                  <span className="text-primary-light">{"\u26A1"}</span> Running claude-sonnet-4-6
                  in worktree
                </p>
                <p>
                  <span className="text-success">{"\u2197"}</span> PR #87 opened against main
                </p>
                <p>
                  <span className="text-error">{"\u2717"}</span> CI failed: lint errors in auth.ts
                </p>
                <p>
                  <span className="text-primary-light">{"\u26A1"}</span>{" "}
                  <span className="text-text-heading">Resuming agent with CI context...</span>
                </p>
                <p>
                  <span className="text-success">{"\u2713"}</span> CI passed, all checks green
                </p>
                <p>
                  <span className="text-info">{"\u25CE"}</span> Review requested, awaiting approval
                </p>
                <p>
                  <span className="text-warning">{"\u25B3"}</span> Review: &quot;add error handling
                  for edge case&quot;
                </p>
                <p>
                  <span className="text-primary-light">{"\u26A1"}</span>{" "}
                  <span className="text-text-heading">Resuming agent with review feedback...</span>
                </p>
                <p>
                  <span className="text-success">{"\u2713"}</span> CI passed, review approved
                </p>
                <p>
                  <span className="text-success">
                    {"\u2713"} PR #87 squash-merged, Issue #142 closed
                  </span>
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="border-t border-border px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <div className="text-center">
            <h2 className="text-3xl font-bold tracking-tight text-text-heading sm:text-4xl">
              Everything you need to run an agent swarm
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-text-muted">
              Built for teams that want many agents doing many kinds of work, on infrastructure they
              control, without losing track of any of it.
            </p>
          </div>
          <div className="stagger mt-16 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {features.map((feature) => (
              <div
                key={feature.title}
                className="card-hover rounded-xl border border-border border-l-2 bg-bg-card p-6"
                style={{ borderLeftColor: feature.color }}
              >
                <h3 className="text-[15px] font-semibold text-text-heading">{feature.title}</h3>
                <p className="mt-2 text-[13px] leading-relaxed text-text-muted">
                  {feature.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Architecture */}
      <section className="border-t border-border bg-bg-subtle px-6 py-24">
        <div className="mx-auto max-w-5xl text-center">
          <h2 className="text-3xl font-bold tracking-tight text-text-heading sm:text-4xl">
            Built for production
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-text-muted">
            Fastify API, Next.js dashboard, BullMQ workers, Drizzle on Postgres. Ships with a Helm
            chart for Kubernetes deployment.
          </p>
          <div className="mt-12 rounded-xl border border-border bg-bg-card p-6 sm:p-8 md:p-10">
            <div className="flex flex-col md:flex-row md:items-stretch gap-3 md:gap-0">
              <div className="flex-1 rounded-lg border border-border bg-bg p-5 text-left">
                <div className="flex items-center gap-2 mb-3">
                  <div
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: "var(--color-primary-light)" }}
                  />
                  <span className="text-[13px] font-semibold text-text-heading">Web UI</span>
                </div>
                <p className="text-[11px] text-text-muted mb-3">Next.js &middot; :3100</p>
                <div className="space-y-1.5">
                  {[
                    "Overview",
                    "Sessions",
                    "Reviews",
                    "Inbox",
                    "Prompts",
                    "Machines",
                    "Connections",
                  ].map((item) => (
                    <div key={item} className="flex items-center gap-2 text-[12px] text-text-muted">
                      <div className="h-1 w-1 rounded-full bg-border-strong" />
                      {item}
                    </div>
                  ))}
                </div>
              </div>
              <div className="hidden md:flex flex-col items-center justify-center w-12 shrink-0 text-text-muted">
                <span className="text-[10px] font-mono mb-0.5">REST</span>
                <span className="text-border-strong">{"\u2192"}</span>
                <span className="text-border-strong mt-1">{"\u2190"}</span>
                <span className="text-[10px] font-mono mt-0.5">ws</span>
              </div>
              <div className="flex md:hidden justify-center py-1 text-border-strong">
                <span>{"\u2193"}</span>
              </div>
              <div className="flex-[1.3] rounded-lg border border-border bg-bg p-5 text-left">
                <div className="flex items-center gap-2 mb-3">
                  <div
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: "var(--color-info)" }}
                  />
                  <span className="text-[13px] font-semibold text-text-heading">API Server</span>
                </div>
                <p className="text-[11px] text-text-muted mb-3">Fastify</p>
                <div className="grid grid-cols-2 gap-x-4">
                  <div>
                    <p className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-1.5">
                      Workers
                    </p>
                    {[
                      "Task Queue",
                      "Job Queue",
                      "Trigger Worker",
                      "PR Watcher",
                      "PA Worker",
                      "Reconciler",
                      "Ticket Sync",
                    ].map((item) => (
                      <div
                        key={item}
                        className="flex items-center gap-2 text-[12px] text-text-muted mb-1"
                      >
                        <div className="h-1 w-1 rounded-full bg-border-strong" />
                        {item}
                      </div>
                    ))}
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-1.5">
                      Services
                    </p>
                    {[
                      "Repo / Job / PA Pools",
                      "Local Relay",
                      "Connections",
                      "Review Agent",
                      "Auth / Secrets",
                    ].map((item) => (
                      <div
                        key={item}
                        className="flex items-center gap-2 text-[12px] text-text-muted mb-1"
                      >
                        <div className="h-1 w-1 rounded-full bg-border-strong" />
                        {item}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="hidden md:flex items-center justify-center w-12 shrink-0 text-border-strong">
                <span>{"\u2192"}</span>
              </div>
              <div className="flex md:hidden justify-center py-1 text-border-strong">
                <span>{"\u2193"}</span>
              </div>
              <div className="flex-[1.5] rounded-lg border border-border bg-bg p-5 text-left">
                <div className="flex items-center gap-2 mb-3">
                  <div
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: "var(--color-success)" }}
                  />
                  <span className="text-[13px] font-semibold text-text-heading">Kubernetes</span>
                </div>
                <div className="space-y-2.5">
                  <div className="rounded-md border border-border/60 bg-bg-card p-3">
                    <p className="text-[11px] font-medium text-text-muted mb-2">Repo Pod A</p>
                    <div className="space-y-1">
                      {["worktree 1", "worktree 2", "worktree N"].map((wt) => (
                        <div key={wt} className="flex items-center justify-between text-[11px]">
                          <span className="text-text-muted">{wt}</span>
                          <span className="text-primary-light">{"\u26A1"}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-md border border-border/60 bg-bg-card p-3">
                    <p className="text-[11px] font-medium text-text-muted mb-2">Repo Pod B</p>
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-text-muted">worktree 1</span>
                      <span className="text-primary-light">{"\u26A1"}</span>
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-md border border-border/60 bg-bg-card p-3">
                    <p className="text-[11px] font-medium text-text-muted mb-2">Job Pod</p>
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-text-muted">pooled runs</span>
                      <span className="text-primary-light">{"\u26A1"}</span>
                    </div>
                  </div>
                  <div className="rounded-md border border-border/60 bg-bg-card p-3">
                    <p className="text-[11px] font-medium text-text-muted mb-2">Persistent Agent</p>
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-text-muted">turns on wake</span>
                      <span className="text-primary-light">{"\u26A1"}</span>
                    </div>
                  </div>
                </div>
                <div className="mt-3 rounded-md border border-dashed border-border/60 bg-bg-card p-3">
                  <p className="text-[11px] font-medium text-text-muted mb-2">
                    Your machine &middot; optio local up
                  </p>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-text-muted">
                      terminals &middot; automations &middot; local runs
                    </span>
                    <span className="text-primary-light">{"\u26A1"}</span>
                  </div>
                </div>
                <p className="mt-3 text-[10px] text-text-muted">
                  {"\u26A1"} = Claude Code / Codex / Copilot / Gemini / Cursor / OpenCode / OpenClaw
                </p>
              </div>
            </div>
            <div className="hidden md:flex justify-center py-1">
              <span className="text-border-strong">{"\u2193"}</span>
            </div>
            <div className="flex md:hidden justify-center py-1 text-border-strong">
              <span>{"\u2193"}</span>
            </div>
            <div className="rounded-lg border border-border bg-bg p-4 text-center">
              <div className="flex items-center justify-center gap-2 mb-2">
                <div
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: "var(--color-warning)" }}
                />
                <span className="text-[13px] font-semibold text-text-heading">
                  Postgres + Redis
                </span>
              </div>
              <div className="flex flex-wrap justify-center gap-x-4 gap-y-1">
                {[
                  "Tasks",
                  "Workflows",
                  "Connections",
                  "Logs",
                  "Secrets",
                  "Job queue",
                  "Pub/sub",
                  "Live streaming",
                ].map((item) => (
                  <span key={item} className="text-[11px] text-text-muted">
                    {item}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-border px-6 py-24">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="text-3xl font-bold tracking-tight text-text-heading sm:text-4xl">
            Open source. Deploy on your infrastructure.
          </h2>
          <p className="mx-auto mt-4 max-w-2xl leading-relaxed text-text-muted">
            Optio is fully open source under the MIT license. Deploy on your own Kubernetes cluster
            with the Helm chart, pair your laptop, and start orchestrating your agent swarm in
            minutes.
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <Link
              href="/docs/getting-started"
              className="rounded-md bg-primary px-8 py-3 text-[14px] font-semibold text-white hover:bg-primary-hover transition-colors"
            >
              Read the Docs
            </Link>
            <a
              href="https://github.com/jonwiggins/optio"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md border border-border px-8 py-3 text-[14px] font-semibold text-text hover:bg-bg-hover transition-colors"
            >
              Star on GitHub
            </a>
          </div>
        </div>
      </section>
    </>
  );
}
