import Link from "next/link";

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Optio",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Kubernetes",
  description:
    "Workflow orchestration system for AI coding agents. Turn tickets into merged pull requests, run reusable agent workflows, and connect external services — all with autonomous feedback loops.",
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
    title: "Autonomous Feedback Loop",
    description:
      "CI fails? Agent resumes with failure context. Reviewer requests changes? Agent picks up the comments and pushes a fix. It keeps going until the PR merges.",
    color: "#6d28d9",
  },
  {
    title: "Agent Workflows",
    description:
      "Reusable, parameterized agent jobs that run standalone. Define prompt templates with variables, trigger manually, on a cron schedule, or via webhook. Auto-retry, cost tracking, and real-time log streaming included.",
    color: "#60a5fa",
  },
  {
    title: "Connections",
    description:
      "Give your agents access to external services at runtime. Built-in providers for Notion, Slack, Linear, GitHub, PostgreSQL, and Sentry, plus custom MCP servers and HTTP APIs with fine-grained access control.",
    color: "#34d399",
  },
  {
    title: "Multi-Agent Support",
    description:
      "Run Claude Code, OpenAI Codex, GitHub Copilot, Google Gemini, OpenCode, or Cursor. Configure model, prompt template, and settings per repository. Launch review agents as subtasks with separate prompts.",
    color: "#f0a040",
  },
  {
    title: "Pod-per-Repo Isolation",
    description:
      "One long-lived Kubernetes pod per repo with git worktree isolation. Multiple tasks run concurrently in separate worktrees. Multi-pod scaling and idle cleanup built in.",
    color: "#a78bfa",
  },
  {
    title: "GitHub, GitLab, Linear, Jira & Notion Intake",
    description:
      "Pull tasks from GitHub Issues, GitLab Issues, Linear, Jira, or Notion, or create them manually. One-click assign from the web UI kicks off the full pipeline.",
    color: "#f06060",
  },
  {
    title: "Real-time Dashboard",
    description:
      "Live log streaming, pipeline progress visualization, cost analytics, and cluster health monitoring. Watch your agents work in real time.",
    color: "#818cf8",
  },
  {
    title: "Self-Healing Pipeline",
    description:
      "Auto-resume on CI failures, merge conflicts, and stale tasks. Auto-merge when CI passes and review is approved. Close linked issues on completion.",
    color: "#fb923c",
  },
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
            From ticket to
            <br />
            <span className="text-primary-light">merged PR.</span>
          </h1>
          <p
            className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-muted animate-reveal"
            style={{ animationDelay: "200ms" }}
          >
            Optio orchestrates AI coding agents across three modes: tasks that drive tickets to
            merged PRs, reusable agent workflows triggered on schedule or by webhook, and
            connections that give agents access to external tools &mdash; all automatically.
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

      {/* Pipeline */}
      <section className="border-t border-border px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <div className="text-center">
            <h2 className="text-3xl font-bold tracking-tight text-text-heading sm:text-4xl">
              The complete task lifecycle
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-text-muted">
              Every task flows through a seven-stage pipeline. Optio monitors each stage and
              automatically drives the task forward.
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
                failures back to the agent, and keeps going until the work is done.
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
              Everything you need to orchestrate AI agents
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-text-muted">
              Built for teams that want to scale AI-assisted development without the manual
              overhead.
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
                  {["Dashboard", "Tasks", "Workflows", "Connections", "Repos", "Costs"].map(
                    (item) => (
                      <div
                        key={item}
                        className="flex items-center gap-2 text-[12px] text-text-muted"
                      >
                        <div className="h-1 w-1 rounded-full bg-border-strong" />
                        {item}
                      </div>
                    ),
                  )}
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
                      "Workflow Queue",
                      "PR Watcher",
                      "Health Mon",
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
                    {["Repo Pool", "Connections", "Review Agent", "Auth / Secrets"].map((item) => (
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
                <div className="rounded-md border border-border/60 bg-bg-card p-3">
                  <p className="text-[11px] font-medium text-text-muted mb-2">Workflow Pod</p>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-text-muted">isolated agent</span>
                    <span className="text-primary-light">{"\u26A1"}</span>
                  </div>
                </div>
                <p className="mt-3 text-[10px] text-text-muted">
                  {"\u26A1"} = Claude Code / Codex / Copilot / Gemini
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
            with the Helm chart and start orchestrating AI agents in minutes.
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
