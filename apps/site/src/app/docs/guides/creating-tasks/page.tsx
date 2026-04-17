import type { Metadata } from "next";
import Link from "next/link";
import { CodeBlock } from "@/components/docs/code-block";
import { Callout } from "@/components/docs/callout";

export const metadata: Metadata = {
  title: "Creating Tasks",
  description:
    "How to create tasks from the dashboard, GitHub Issues, GitLab Issues, Linear, Jira, Notion, and the API.",
};

export default function CreatingTasksPage() {
  return (
    <>
      <h1 className="text-3xl font-bold text-text-heading">Creating Tasks</h1>
      <p className="mt-4 text-text-muted leading-relaxed">
        A <strong>Task</strong> is the unit of agent work in Optio. Every Task has a{" "}
        <strong>Who</strong> (agent), <strong>What</strong> (prompt), <strong>When</strong>{" "}
        (trigger), <strong>Why</strong> (description), and an optional <strong>Where</strong> (repo
        + branch). Attach a repo and the Task becomes a <strong>Repo Task</strong> that opens a PR;
        leave it off and it&apos;s a <strong>Standalone Task</strong> that runs the agent in an
        isolated pod with no git checkout.
      </p>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">From the Dashboard</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        The fastest way to create a Task is through the web UI.
      </p>
      <ol className="mt-3 list-decimal pl-5 space-y-2 text-[14px] text-text-muted">
        <li>
          Navigate to <strong className="text-text-heading">Tasks &rarr; New Task</strong>.
        </li>
        <li>
          At the top of the form, pick <strong className="text-text-heading">Repo Task</strong>{" "}
          (opens a PR) or <strong className="text-text-heading">Standalone Task</strong> (runs
          without a PR). The outcome banner underneath makes it explicit.
        </li>
        <li>
          Choose <strong className="text-text-heading">Run now</strong> or{" "}
          <strong className="text-text-heading">Schedule</strong>. Scheduled Tasks become{" "}
          <em>reusable blueprints</em> — each trigger firing spawns a fresh run.
        </li>
        <li>
          Fill in the <strong className="text-text-heading">title</strong> (becomes the PR title and
          branch name for Repo Tasks) and <strong className="text-text-heading">prompt</strong>.
          Prompts support <code>{"{{param}}"}</code> substitution on scheduled/webhook firings.
        </li>
        <li>
          Pick an <strong className="text-text-heading">agent</strong> (Claude Code, Codex, Copilot,
          Gemini, OpenCode).
        </li>
        <li>
          For Repo Tasks, select the <strong className="text-text-heading">repository</strong> and
          branch. For Standalone, this section is hidden.
        </li>
        <li>
          Click <strong className="text-text-heading">Start Task</strong> (or{" "}
          <strong className="text-text-heading">Save Schedule</strong>). The label adapts to the
          mode.
        </li>
      </ol>
      <p className="mt-3 text-text-muted leading-relaxed">
        The task enters the queue and is picked up by the worker. Watch live logs in the task detail
        view.
      </p>

      <Callout type="info">
        Scheduled Tasks live at <code>/tasks/scheduled</code>. Standalone Tasks are reachable via
        the <strong>Standalone</strong> tab on <code>/tasks</code> or directly at <code>/jobs</code>
        .
      </Callout>

      <Callout type="tip">
        Write prompts the way you would write a detailed GitHub Issue. Include the &quot;what&quot;
        and the &quot;why,&quot; reference specific files or functions when relevant, and mention
        any edge cases the agent should handle.
      </Callout>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">From Task Templates</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        If you frequently create similar tasks, save them as templates. Templates store the repo,
        prompt, agent type, and metadata so you can create tasks with a single click.
      </p>
      <ol className="mt-3 list-decimal pl-5 space-y-2 text-[14px] text-text-muted">
        <li>
          Go to <strong className="text-text-heading">Templates</strong> in the sidebar
        </li>
        <li>Create a template with your base prompt and settings</li>
        <li>
          Click <strong className="text-text-heading">Run</strong> on any template to instantly
          create a task
        </li>
      </ol>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">From GitHub Issues</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Optio can browse GitHub Issues from your connected repositories and turn them into tasks.
      </p>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Manual Assignment</h3>
      <ol className="mt-3 list-decimal pl-5 space-y-2 text-[14px] text-text-muted">
        <li>
          Navigate to the <strong className="text-text-heading">Issues</strong> view in the
          dashboard
        </li>
        <li>Browse issues across all connected repos</li>
        <li>
          Click <strong className="text-text-heading">Assign to Optio</strong> on any issue
        </li>
        <li>
          Optio creates a task with the issue title as the task title and the issue body as the
          prompt
        </li>
      </ol>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Automatic Sync</h3>
      <p className="mt-3 text-text-muted leading-relaxed">
        Configure a GitHub Issues ticket provider to automatically sync issues into Optio tasks. The
        ticket sync worker runs periodically and picks up new issues based on your filter
        configuration.
      </p>
      <ol className="mt-3 list-decimal pl-5 space-y-2 text-[14px] text-text-muted">
        <li>
          Go to <strong className="text-text-heading">Settings</strong> and configure a GitHub
          Issues ticket provider
        </li>
        <li>Set the sync scope (labels, assignees, or all issues)</li>
        <li>New matching issues are automatically created as tasks</li>
      </ol>

      <Callout type="info">
        A{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
          GITHUB_TOKEN
        </code>{" "}
        secret must be configured for issue browsing and syncing. Add it in{" "}
        <strong className="text-text-heading">Secrets</strong> if you haven&apos;t already.
      </Callout>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">From Linear</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Optio integrates with Linear as a ticket provider, syncing Linear issues into tasks.
      </p>
      <ol className="mt-3 list-decimal pl-5 space-y-2 text-[14px] text-text-muted">
        <li>
          Add a Linear ticket provider in <strong className="text-text-heading">Settings</strong>
        </li>
        <li>Configure your Linear API key and team/project scope</li>
        <li>The ticket sync worker polls Linear for new issues matching your configuration</li>
        <li>
          Matching issues are created as Optio tasks with the Linear issue title and description
        </li>
      </ol>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">From the API</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Create tasks programmatically via the REST API. This is useful for CI/CD pipelines,
        chatbots, or custom integrations.
      </p>
      <div className="mt-3">
        <CodeBlock title="POST /api/tasks">{`{
  "title": "Add email validation to signup form",
  "prompt": "Add client-side and server-side email validation to the signup form in src/components/SignupForm.tsx. Use Zod for schema validation. Show inline error messages below the input field.",
  "repoUrl": "https://github.com/acme/webapp",
  "repoBranch": "main",
  "agentType": "claude",
  "priority": 0
}`}</CodeBlock>
      </div>
      <div className="mt-3">
        <CodeBlock title="curl example">{`curl -X POST https://optio.example.com/api/tasks \\
  -H "Content-Type: application/json" \\
  -H "Cookie: optio_session=YOUR_SESSION_TOKEN" \\
  -d '{
    "title": "Add email validation to signup form",
    "prompt": "Add client-side and server-side email validation...",
    "repoUrl": "https://github.com/acme/webapp",
    "agentType": "claude"
  }'`}</CodeBlock>
      </div>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Task Fields</h3>
      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-bg-card">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-bg-subtle">
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Field</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Required</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {[
              ["title", "Yes", "Task title (becomes branch name and PR title)"],
              ["prompt", "Yes", "The full prompt/instructions for the agent"],
              ["repoUrl", "Yes", "Repository URL (must be connected in Optio)"],
              ["repoBranch", "No", "Branch to base the work on (defaults to repo default)"],
              [
                "agentType",
                "No",
                'Agent type: "claude-code", "codex", or "copilot" (defaults to "claude-code")',
              ],
              ["priority", "No", "Integer priority (lower = higher, default 0)"],
              ["metadata", "No", "Arbitrary JSON metadata for tracking"],
            ].map(([field, required, desc]) => (
              <tr key={field}>
                <td className="px-4 py-3 font-mono text-text-heading">{field}</td>
                <td className="px-4 py-3 text-text-muted">{required}</td>
                <td className="px-4 py-3 text-text-muted">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">From Schedules</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Create recurring tasks with cron-based schedules. Useful for regular maintenance like
        dependency updates, security audits, or documentation refreshes.
      </p>
      <ol className="mt-3 list-decimal pl-5 space-y-2 text-[14px] text-text-muted">
        <li>
          Go to <strong className="text-text-heading">Schedules</strong> in the sidebar
        </li>
        <li>Create a schedule with a cron expression and task template</li>
        <li>The schedule worker checks for due schedules and creates tasks automatically</li>
      </ol>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Task Priority &amp; Ordering</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Tasks have an integer priority field where lower numbers mean higher priority. You can
        reorder tasks in two ways:
      </p>
      <ul className="mt-3 list-disc pl-5 space-y-1 text-[14px] text-text-muted">
        <li>
          <strong className="text-text-heading">Dashboard</strong> — drag-and-drop reordering in the
          task list
        </li>
        <li>
          <strong className="text-text-heading">API</strong> —{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            POST /api/tasks/reorder
          </code>{" "}
          with an array of task IDs in desired order
        </li>
      </ul>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Bulk Operations</h2>
      <p className="mt-3 text-text-muted leading-relaxed">Manage multiple tasks at once:</p>
      <ul className="mt-3 list-disc pl-5 space-y-1 text-[14px] text-text-muted">
        <li>
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            POST /api/tasks/bulk/retry-failed
          </code>{" "}
          — retry all failed tasks at once
        </li>
        <li>
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            POST /api/tasks/bulk/cancel-active
          </code>{" "}
          — cancel all running and queued tasks
        </li>
      </ul>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">What Happens After Creation</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Once created, a task flows through the{" "}
        <Link href="/docs/task-lifecycle" className="text-primary-light hover:underline">
          task lifecycle
        </Link>
        :
      </p>
      <ol className="mt-3 list-decimal pl-5 space-y-1 text-[14px] text-text-muted">
        <li>
          Enters the queue (
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            pending &rarr; queued
          </code>
          )
        </li>
        <li>Task worker provisions a repo pod or reuses an existing one</li>
        <li>Agent runs in an isolated git worktree</li>
        <li>
          Agent opens a PR and the task transitions to{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">pr_opened</code>
        </li>
        <li>PR watcher monitors CI, reviews, and merge status</li>
        <li>
          On merge:{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">completed</code>
          . On failure: retried automatically or manually
        </li>
      </ol>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Next Steps</h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {[
          {
            title: "Task Lifecycle",
            href: "/docs/task-lifecycle",
            description: "States, transitions, and the feedback loop",
          },
          {
            title: "Connecting Repos",
            href: "/docs/guides/connecting-repos",
            description: "Set up repositories and image presets",
          },
          {
            title: "Review Agents",
            href: "/docs/guides/review-agents",
            description: "Automated code review configuration",
          },
          {
            title: "Integrations",
            href: "/docs/guides/integrations",
            description: "GitHub Issues, GitLab Issues, Linear, Jira, Notion, Slack, webhooks",
          },
        ].map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="card-hover rounded-lg border border-border bg-bg-card p-4 block"
          >
            <p className="text-[14px] font-semibold text-text-heading">{item.title}</p>
            <p className="mt-1 text-[13px] text-text-muted">{item.description}</p>
          </Link>
        ))}
      </div>
    </>
  );
}
