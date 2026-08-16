import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Architecture",
  description:
    "How Optio works under the hood: pod-per-repo isolation, git worktree concurrency, BullMQ workers, WebSocket streaming, and the full data flow.",
};

export default function ArchitecturePage() {
  return (
    <>
      <h1 className="text-3xl font-bold text-text-heading">Architecture</h1>
      <p className="mt-4 text-text-muted leading-relaxed">
        Optio is a monorepo with two applications (API server and web dashboard), four shared
        packages, and a Helm chart for Kubernetes deployment. All services run in Kubernetes,
        including the API and web app.
      </p>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">System Overview</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        The system has three layers: the web UI for user interaction, the API server for
        orchestration logic, and Kubernetes for agent execution.
      </p>
      <ul className="mt-4 list-disc pl-5 space-y-2 text-[14px] text-text-muted">
        <li>
          <strong className="text-text-heading">Web UI (Next.js)</strong> — Dashboard with live log
          streaming, task management, workflow management, connection catalog, repo configuration,
          cost analytics, and cluster monitoring. Communicates with the API via REST and WebSocket.
        </li>
        <li>
          <strong className="text-text-heading">API Server (Fastify)</strong> — Orchestration brain.
          Manages task queue, workflow engine, connection service, PR watching, health monitoring,
          ticket sync, and pod lifecycle. Stores state in PostgreSQL, uses Redis for job queue and
          pub/sub.
        </li>
        <li>
          <strong className="text-text-heading">Kubernetes</strong> — Execution environment. Repo
          pods run tasks in isolated git worktrees. Workflow pods run standalone agent jobs.
          Connections inject MCP servers into pods at runtime.
        </li>
      </ul>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Pod-per-Repo with Worktrees</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        This is the central design decision. Instead of one pod per task (slow and wasteful), Optio
        runs one long-lived pod per repository:
      </p>
      <ul className="mt-3 list-disc pl-5 space-y-2 text-[14px] text-text-muted">
        <li>
          The pod clones the repo once on creation, then runs{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            sleep infinity
          </code>
        </li>
        <li>
          When a task arrives, Optio execs into the pod:{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            git worktree add
          </code>{" "}
          &rarr; run agent &rarr; cleanup worktree
        </li>
        <li>
          Multiple tasks can run concurrently in the same pod (one per worktree), controlled by
          per-repo{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            maxConcurrentTasks
          </code>
        </li>
        <li>Pods use persistent volumes so installed tools survive restarts</li>
        <li>
          Idle pods are cleaned up after 10 minutes (configurable via{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            OPTIO_REPO_POD_IDLE_MS
          </code>
          )
        </li>
      </ul>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Multi-Pod Scaling</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Repos can scale beyond a single pod for higher throughput. Two per-repo settings control
        this:
      </p>
      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-bg-card">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-bg-subtle">
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Setting</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Default</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Description</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border/50">
              <td className="px-4 py-3 font-mono text-text-heading">maxPodInstances</td>
              <td className="px-4 py-3 text-text-muted">1</td>
              <td className="px-4 py-3 text-text-muted">Max pod replicas per repo (1&ndash;20)</td>
            </tr>
            <tr>
              <td className="px-4 py-3 font-mono text-text-heading">maxAgentsPerPod</td>
              <td className="px-4 py-3 text-text-muted">2</td>
              <td className="px-4 py-3 text-text-muted">
                Max concurrent agents per pod (1&ndash;50)
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-text-muted leading-relaxed">
        Total capacity ={" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
          maxPodInstances &times; maxAgentsPerPod
        </code>
        . Pods scale up dynamically when all existing pods are at capacity, and scale down LIFO when
        idle.
      </p>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Workers</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        The API server runs several BullMQ workers:
      </p>
      <ul className="mt-3 list-disc pl-5 space-y-2 text-[14px] text-text-muted">
        <li>
          <strong className="text-text-heading">Task Worker</strong> — Processes the task job queue.
          Handles concurrency limits, pod provisioning, connection injection, agent execution, and
          log streaming.
        </li>
        <li>
          <strong className="text-text-heading">Workflow Worker</strong> — Processes workflow runs.
          Provisions isolated pods, renders prompt templates with parameters, executes agents, and
          handles auto-retry with exponential backoff.
        </li>
        <li>
          <strong className="text-text-heading">Workflow Trigger Worker</strong> — Evaluates
          schedule triggers every 60 seconds and fires due cron-based workflows.
        </li>
        <li>
          <strong className="text-text-heading">PR Watcher</strong> — Polls open PRs every 30
          seconds for CI status, review state, and merge readiness. Triggers auto-resume and
          auto-merge.
        </li>
        <li>
          <strong className="text-text-heading">Health Monitor</strong> — Runs every 60 seconds.
          Detects crashed pods, cleans up orphaned worktrees, removes idle pods.
        </li>
        <li>
          <strong className="text-text-heading">Ticket Sync</strong> — Syncs tasks from GitHub
          Issues, Linear, Jira, and Notion.
        </li>
        <li>
          <strong className="text-text-heading">Webhook Worker</strong> — Delivers outgoing webhook
          events.
        </li>
      </ul>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Tech Stack</h2>
      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-bg-card">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-bg-subtle">
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Layer</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Technology</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {[
              ["Monorepo", "Turborepo + pnpm 10"],
              ["API", "Fastify 5, Drizzle ORM, BullMQ, Zod"],
              ["Web", "Next.js 15, Tailwind CSS 4, Zustand, Recharts"],
              ["Database", "PostgreSQL 16"],
              ["Queue", "Redis 7 + BullMQ"],
              ["Runtime", "Kubernetes + Docker"],
              ["Deploy", "Helm 3"],
              ["Auth", "OAuth (GitHub, Google, GitLab)"],
              ["CI", "GitHub Actions"],
            ].map(([layer, tech]) => (
              <tr key={layer}>
                <td className="px-4 py-3 text-text-heading">{layer}</td>
                <td className="px-4 py-3 text-text-muted">{tech}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Packages</h2>
      <ul className="mt-3 list-disc pl-5 space-y-2 text-[14px] text-text-muted">
        <li>
          <strong className="text-text-heading">@optio/shared</strong> — Types, state machine,
          prompt template renderer, error classifier, constants
        </li>
        <li>
          <strong className="text-text-heading">@optio/container-runtime</strong> — Abstract runtime
          interface with Kubernetes implementation
        </li>
        <li>
          <strong className="text-text-heading">@optio/agent-adapters</strong> — Claude Code, Codex,
          Copilot, Gemini, OpenCode, and Cursor adapters (auth, environment, config)
        </li>
        <li>
          <strong className="text-text-heading">@optio/ticket-providers</strong> — GitHub Issues,
          Linear, Jira, and Notion ticket sync
        </li>
      </ul>
    </>
  );
}
