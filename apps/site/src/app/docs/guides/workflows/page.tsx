import type { Metadata } from "next";
import Link from "next/link";
import { CodeBlock } from "@/components/docs/code-block";
import { Callout } from "@/components/docs/callout";

export const metadata: Metadata = {
  title: "Standalone Tasks",
  description:
    "Run AI agents without attaching a repo. Standalone tasks are ideal for reports, triage, and anything that doesn't need a code checkout.",
};

export default function WorkflowsPage() {
  return (
    <>
      <h1 className="text-3xl font-bold text-text-heading">Standalone Tasks</h1>
      <p className="mt-4 text-text-muted leading-relaxed">
        Every unit of agent work in Optio is a <strong>Task</strong>. When a Task has a repo
        attached (a <strong>Repo Task</strong>), the agent clones the repo and opens a PR. When it
        doesn&apos;t (a <strong>Standalone Task</strong>), the agent runs in an isolated pod with no
        git checkout and produces logs + side effects through its{" "}
        <Link href="/docs/guides/connections" className="text-primary-light hover:underline">
          Connections
        </Link>
        .
      </p>
      <p className="mt-3 text-text-muted leading-relaxed">
        Use Standalone Tasks for generating reports, analyzing data, triaging alerts, drafting
        documentation, or anything repeatable that doesn&apos;t need a repo checkout.
      </p>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Standalone vs Repo Tasks</h2>
      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-bg-card">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-bg-subtle">
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Aspect</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Repo Task</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">
                Standalone Task
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {[
              ["Repository", "Required (Git repo)", "Not required"],
              ["Output", "Pull request", "Logs + side effects"],
              ["Prompt", "Static or template override", "Template with {{params}}"],
              ["Triggers", "Manual, schedule, webhook, ticket", "Manual, schedule, webhook"],
              ["Review loop", "CI + code review + auto-resume", "Retry on failure"],
              [
                "State machine",
                "12 states (pending to merged)",
                "3 states (queued, running, completed/failed)",
              ],
            ].map(([aspect, tasks, workflows]) => (
              <tr key={aspect}>
                <td className="px-4 py-3 font-medium text-text-heading">{aspect}</td>
                <td className="px-4 py-3 text-text-muted">{tasks}</td>
                <td className="px-4 py-3 text-text-muted">{workflows}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Creating a Standalone Task</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Navigate to <strong className="text-text-heading">Tasks &rarr; New Task</strong> in the
        dashboard. A standalone task definition includes:
      </p>
      <ul className="mt-3 list-disc pl-5 space-y-2 text-[14px] text-text-muted">
        <li>
          <strong className="text-text-heading">Name and description</strong> — identify the task in
          the dashboard and logs
        </li>
        <li>
          <strong className="text-text-heading">Agent runtime</strong> — choose from Claude Code,
          OpenAI Codex, GitHub Copilot, Google Gemini, or OpenCode
        </li>
        <li>
          <strong className="text-text-heading">Prompt template</strong> — the agent prompt, with{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            {"{{PARAM}}"}
          </code>{" "}
          placeholders for dynamic values
        </li>
        <li>
          <strong className="text-text-heading">Parameter schema</strong> — optional JSON Schema
          that validates inputs before each run
        </li>
        <li>
          <strong className="text-text-heading">Environment</strong> — Docker image, setup commands,
          secrets, and network configuration
        </li>
        <li>
          <strong className="text-text-heading">Limits</strong> — max turns, budget (USD), max
          concurrent runs, and retry count
        </li>
      </ul>

      <div className="mt-4">
        <CodeBlock title="API: Create a standalone task">{`POST /api/tasks
{
  "type": "standalone",
  "name": "Weekly Security Report",
  "description": "Scans dependencies and generates a vulnerability summary",
  "agentRuntime": "claude-code",
  "model": "sonnet",
  "promptTemplate": "Analyze the dependency list for {{REPO_NAME}} and produce a security report. Focus on: {{FOCUS_AREAS}}",
  "paramsSchema": {
    "type": "object",
    "properties": {
      "REPO_NAME": { "type": "string" },
      "FOCUS_AREAS": { "type": "string", "default": "CVEs, outdated packages, license issues" }
    },
    "required": ["REPO_NAME"]
  },
  "maxTurns": 20,
  "maxRetries": 2,
  "maxConcurrent": 1
}`}</CodeBlock>
      </div>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Prompt Templates</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Standalone task prompts use{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
          {"{{PARAM_NAME}}"}
        </code>{" "}
        syntax. When a run is created, each placeholder is replaced with the corresponding value
        from the run&apos;s parameters. Unmatched placeholders are left as-is.
      </p>
      <div className="mt-4">
        <CodeBlock title="Example template">{`Summarize the latest {{COUNT}} support tickets for {{TEAM}}.
Group by category and highlight any recurring issues.
Output as markdown.`}</CodeBlock>
      </div>
      <p className="mt-3 text-text-muted leading-relaxed">
        If a{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
          paramsSchema
        </code>{" "}
        is defined, Optio validates the parameters against it before starting the run.
      </p>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Triggers</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Each standalone task can have up to three triggers — one of each type. Triggers determine
        how and when a standalone task run starts.
      </p>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Manual</h3>
      <p className="mt-3 text-text-muted leading-relaxed">
        Run the task on demand from the dashboard or via the API. Pass parameters in the request
        body.
      </p>
      <div className="mt-3">
        <CodeBlock title="API: Trigger a manual run">{`POST /api/tasks/:id/runs
{
  "params": {
    "REPO_NAME": "optio",
    "FOCUS_AREAS": "CVEs, outdated packages"
  }
}`}</CodeBlock>
      </div>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Schedule</h3>
      <p className="mt-3 text-text-muted leading-relaxed">
        Run the task on a cron schedule. The trigger worker checks for due schedules every 60
        seconds.
      </p>
      <div className="mt-3">
        <CodeBlock title="API: Create a schedule trigger">{`POST /api/tasks/:id/triggers
{
  "type": "schedule",
  "config": {
    "cronExpression": "0 9 * * 1",
    "paramMapping": {
      "REPO_NAME": "optio"
    }
  }
}`}</CodeBlock>
      </div>
      <p className="mt-3 text-text-muted leading-relaxed">
        The dashboard includes presets for common schedules: every hour, daily at midnight, weekdays
        at 9 AM, and weekly on Monday.
      </p>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Webhook</h3>
      <p className="mt-3 text-text-muted leading-relaxed">
        Trigger the task from an external system via HTTP POST. Each webhook trigger gets a unique
        path that you can point third-party services at.
      </p>
      <div className="mt-3">
        <CodeBlock title="API: Create a webhook trigger">{`POST /api/tasks/:id/triggers
{
  "type": "webhook",
  "config": {
    "path": "security-scan",
    "secret": "whsec_...",
    "paramMapping": {
      "REPO_NAME": "$.repository.name"
    }
  }
}`}</CodeBlock>
      </div>
      <p className="mt-3 text-text-muted leading-relaxed">
        The webhook endpoint is{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
          POST /api/hooks/security-scan
        </code>
        . If a secret is configured, Optio validates the{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
          X-Optio-Signature
        </code>{" "}
        header using HMAC-SHA256. The{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
          paramMapping
        </code>{" "}
        field uses JSONPath expressions to extract values from the incoming webhook payload.
      </p>

      <Callout type="info">
        Webhook endpoints are rate-limited to 60 requests per minute. The endpoint returns{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
          202 Accepted
        </code>{" "}
        with the run ID immediately — the run executes asynchronously.
      </Callout>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Execution</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        When a run is created, it enters the{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">queued</code>{" "}
        state and is picked up by the worker. The worker:
      </p>
      <ol className="mt-3 list-decimal pl-5 space-y-2 text-[14px] text-text-muted">
        <li>Renders the prompt template with the run&apos;s parameters</li>
        <li>Provisions a Kubernetes pod (or reuses one from the warm pool)</li>
        <li>Executes the agent with the rendered prompt</li>
        <li>Streams logs to the dashboard in real time via WebSocket</li>
        <li>Captures output, cost, and token usage when the agent completes</li>
      </ol>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Concurrency and Retries</h3>
      <p className="mt-3 text-text-muted leading-relaxed">Two concurrency limits apply:</p>
      <ul className="mt-3 list-disc pl-5 space-y-1 text-[14px] text-text-muted">
        <li>
          <strong className="text-text-heading">Global</strong>:{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            OPTIO_MAX_WORKFLOW_CONCURRENT
          </code>{" "}
          (default: 5) — total standalone task runs
        </li>
        <li>
          <strong className="text-text-heading">Per-task</strong>:{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            maxConcurrent
          </code>{" "}
          (default: 2) — parallel runs of the same standalone task
        </li>
      </ul>
      <p className="mt-3 text-text-muted leading-relaxed">
        Failed runs are automatically retried up to{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">maxRetries</code>{" "}
        times (default: 1) with exponential backoff starting at 5 seconds.
      </p>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Monitoring Runs</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        The detail page shows all runs with their status, duration, cost, and parameters. Click a
        run to view its full log stream, output, and metadata. You can also retry failed runs or
        cancel running ones from the dashboard.
      </p>
      <div className="mt-4">
        <CodeBlock title="API: List runs for a workflow">{`GET /api/tasks/:id/runs`}</CodeBlock>
      </div>
      <div className="mt-3">
        <CodeBlock title="API: Get run details and logs">{`GET /api/workflow-runs/:runId
GET /api/workflow-runs/:runId/logs`}</CodeBlock>
      </div>

      <Callout type="tip">
        Set{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
          warmPoolSize
        </code>{" "}
        to pre-provision pods for frequently-triggered workflows. This eliminates cold-start latency
        at the cost of keeping idle pods running.
      </Callout>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Next Steps</h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {[
          {
            title: "Creating Tasks",
            href: "/docs/guides/creating-tasks",
            description: "Learn about repo-based coding tasks",
          },
          {
            title: "Integrations",
            href: "/docs/guides/integrations",
            description: "Connect ticket sources and webhooks",
          },
          {
            title: "API Reference",
            href: "/docs/api-reference",
            description: "Full workflow and run API endpoints",
          },
          {
            title: "Deployment",
            href: "/docs/deployment",
            description: "Production configuration and limits",
          },
        ].map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="rounded-lg border border-border bg-bg-card p-4 hover:bg-bg-hover transition-colors"
          >
            <p className="text-[14px] font-semibold text-text-heading">{item.title}</p>
            <p className="mt-1 text-[12px] text-text-muted">{item.description}</p>
          </Link>
        ))}
      </div>
    </>
  );
}
