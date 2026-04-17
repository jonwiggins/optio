import type { Metadata } from "next";
import Link from "next/link";
import { CodeBlock } from "@/components/docs/code-block";
import { Callout } from "@/components/docs/callout";

export const metadata: Metadata = {
  title: "Integrations",
  description:
    "Integrate Optio with GitHub Issues, GitLab Issues, Linear, Jira, Notion, Slack, and webhooks.",
};

export default function IntegrationsPage() {
  return (
    <>
      <h1 className="text-3xl font-bold text-text-heading">Integrations</h1>
      <p className="mt-4 text-text-muted leading-relaxed">
        Optio integrates with external services for task sourcing, notifications, agent tool access,
        and event delivery. This page covers task intake integrations and notifications. For giving
        agents access to external tools at runtime, see{" "}
        <Link href="/docs/guides/connections" className="text-primary-light hover:underline">
          Connections
        </Link>
        .
      </p>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">GitHub Issues</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        GitHub Issues is the most common task source. Optio can browse issues from connected repos
        and turn them into tasks, either manually or automatically.
      </p>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Prerequisites</h3>
      <ul className="mt-3 list-disc pl-5 space-y-1 text-[14px] text-text-muted">
        <li>
          A{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            GITHUB_TOKEN
          </code>{" "}
          secret configured in Optio (requires{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">repo</code>{" "}
          scope for private repos)
        </li>
        <li>At least one repository connected</li>
      </ul>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Browsing Issues</h3>
      <p className="mt-3 text-text-muted leading-relaxed">
        The Issues view in the dashboard lists open issues across all connected repositories. You
        can browse, filter, and assign issues to Optio with a single click.
      </p>
      <div className="mt-3">
        <CodeBlock title="API: Browse issues">{`GET /api/issues

# Returns issues across all connected repos
# Requires GITHUB_TOKEN secret`}</CodeBlock>
      </div>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Manual Assignment</h3>
      <p className="mt-3 text-text-muted leading-relaxed">
        Assign a specific issue to Optio, creating a task with the issue title and body as the
        prompt:
      </p>
      <div className="mt-3">
        <CodeBlock title="API: Assign issue">{`POST /api/issues/assign
{
  "issueUrl": "https://github.com/acme/webapp/issues/42",
  "repoUrl": "https://github.com/acme/webapp"
}`}</CodeBlock>
      </div>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Automatic Sync</h3>
      <p className="mt-3 text-text-muted leading-relaxed">
        Set up a GitHub Issues ticket provider to automatically sync issues into tasks. The ticket
        sync worker polls periodically for new issues matching your filter.
      </p>
      <ol className="mt-3 list-decimal pl-5 space-y-2 text-[14px] text-text-muted">
        <li>
          Go to <strong className="text-text-heading">Settings</strong> and add a ticket provider
        </li>
        <li>
          Select <strong className="text-text-heading">GitHub Issues</strong> as the source
        </li>
        <li>Configure the sync scope (specific labels, assignees, or all issues)</li>
        <li>Enable the provider</li>
      </ol>
      <div className="mt-3">
        <CodeBlock title="API: Create ticket provider">{`POST /api/tickets/providers
{
  "source": "github",
  "config": {
    "repos": ["https://github.com/acme/webapp"],
    "labels": ["optio", "ai-task"],
    "assignee": null
  },
  "enabled": true
}`}</CodeBlock>
      </div>

      <Callout type="tip">
        Use a dedicated label like{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">optio</code> or{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">ai-task</code> to
        control which issues get automatically picked up. This prevents every issue from becoming a
        task.
      </Callout>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">GitLab Issues</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Optio integrates with GitLab as a ticket provider, syncing GitLab issues into Optio tasks.
      </p>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Setup</h3>
      <ol className="mt-3 list-decimal pl-5 space-y-2 text-[14px] text-text-muted">
        <li>Generate a personal access token in GitLab with API read/write scope</li>
        <li>Add the token as a secret in Optio</li>
        <li>
          Create a GitLab ticket provider in <strong className="text-text-heading">Settings</strong>
        </li>
        <li>Configure the GitLab instance URL and project ID</li>
      </ol>
      <div className="mt-3">
        <CodeBlock title="API: Create GitLab provider">{`POST /api/tickets/providers
{
  "source": "gitlab",
  "config": {
    "baseUrl": "https://gitlab.com",
    "token": "glpat-...",
    "projectId": "12345"
  },
  "enabled": true
}`}</CodeBlock>
      </div>

      <Callout type="info">
        GitLab supports both GitLab.com and self-hosted instances. Set{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">baseUrl</code> to
        your instance URL for self-hosted GitLab.
      </Callout>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Linear</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Optio integrates with Linear as a ticket provider, syncing Linear issues into Optio tasks.
      </p>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Setup</h3>
      <ol className="mt-3 list-decimal pl-5 space-y-2 text-[14px] text-text-muted">
        <li>Generate a Linear API key from your Linear workspace settings</li>
        <li>Add the API key as a secret in Optio</li>
        <li>
          Create a Linear ticket provider in <strong className="text-text-heading">Settings</strong>
        </li>
        <li>Configure the team and project scope</li>
      </ol>
      <div className="mt-3">
        <CodeBlock title="API: Create Linear provider">{`POST /api/tickets/providers
{
  "source": "linear",
  "config": {
    "apiKey": "lin_api_...",
    "teamId": "TEAM_ID",
    "projectId": "PROJECT_ID"
  },
  "enabled": true
}`}</CodeBlock>
      </div>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">How Sync Works</h3>
      <ul className="mt-3 list-disc pl-5 space-y-1 text-[14px] text-text-muted">
        <li>The ticket sync worker runs periodically and polls each enabled provider</li>
        <li>New issues matching the filter criteria are created as Optio tasks</li>
        <li>
          The issue title becomes the task title, and the issue description becomes the prompt
        </li>
        <li>
          Tasks track their source via{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            ticketSource
          </code>{" "}
          and{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            ticketExternalId
          </code>{" "}
          fields
        </li>
        <li>Duplicate issues are not re-synced (deduplication by external ID)</li>
      </ul>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Jira</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Optio integrates with Jira as a ticket provider, syncing Jira issues into Optio tasks.
      </p>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Setup</h3>
      <ol className="mt-3 list-decimal pl-5 space-y-2 text-[14px] text-text-muted">
        <li>
          Add a Jira ticket provider in <strong className="text-text-heading">Settings</strong>
        </li>
        <li>Configure your Jira base URL, email, API token, and project key</li>
        <li>The ticket sync worker polls Jira for new issues matching your configuration</li>
      </ol>
      <div className="mt-3">
        <CodeBlock title="API: Create Jira provider">{`POST /api/tickets/providers
{
  "source": "jira",
  "config": {
    "baseUrl": "https://your-org.atlassian.net",
    "email": "you@example.com",
    "apiToken": "your-jira-api-token",
    "projectKey": "PROJ"
  },
  "enabled": true
}`}</CodeBlock>
      </div>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Notion</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Optio integrates with Notion as a ticket provider, syncing pages from a Notion database into
        Optio tasks. Pages are filtered by a configurable multi-select label (default:{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">optio</code>).
      </p>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Setup</h3>
      <ol className="mt-3 list-decimal pl-5 space-y-2 text-[14px] text-text-muted">
        <li>
          Create an internal integration at{" "}
          <a
            href="https://www.notion.so/my-integrations"
            className="text-primary-light hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            notion.so/my-integrations
          </a>
        </li>
        <li>Share your database with the integration</li>
        <li>
          Add a Notion ticket provider in <strong className="text-text-heading">Settings</strong>{" "}
          with the integration token and database ID
        </li>
      </ol>
      <div className="mt-3">
        <CodeBlock title="API: Create Notion provider">{`POST /api/tickets/providers
{
  "source": "notion",
  "config": {
    "apiKey": "ntn_...",
    "databaseId": "your-database-id"
  },
  "enabled": true
}`}</CodeBlock>
      </div>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Configuration Options</h3>
      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-bg-card">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-bg-subtle">
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Field</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Default</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {[
              ["apiKey", "(required)", "Notion integration token"],
              ["databaseId", "(required)", "Notion database ID"],
              ["label", '"optio"', "Multi-select label to filter pages"],
              ["statusProperty", '"Status"', "Name of the status property"],
              ["doneValue", '"Done"', "Status value that marks a page as done"],
              ["titleProperty", '"Name"', "Name of the title property"],
              ["maxPages", "unlimited", "Maximum pages to fetch per sync"],
            ].map(([field, def, desc]) => (
              <tr key={field}>
                <td className="px-4 py-3 font-mono text-text-heading">{field}</td>
                <td className="px-4 py-3 text-text-muted">{def}</td>
                <td className="px-4 py-3 text-text-muted">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Callout type="tip">
        Add an{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">optio</code> tag
        to a multi-select property on your Notion pages to control which pages get picked up by the
        sync. Only pages with this label are created as tasks.
      </Callout>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Slack</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Optio can send Slack notifications for task events. Configure Slack per repository to get
        notified when tasks complete, fail, or need attention.
      </p>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Setup</h3>
      <ol className="mt-3 list-decimal pl-5 space-y-2 text-[14px] text-text-muted">
        <li>
          Create an{" "}
          <a
            href="https://api.slack.com/messaging/webhooks"
            className="text-primary-light hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            Incoming Webhook
          </a>{" "}
          in your Slack workspace
        </li>
        <li>
          Navigate to{" "}
          <strong className="text-text-heading">Repos &rarr; (select repo) &rarr; Settings</strong>
        </li>
        <li>
          Enable{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            slackEnabled
          </code>
        </li>
        <li>
          Paste the webhook URL in{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            slackWebhookUrl
          </code>
        </li>
      </ol>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Testing</h3>
      <p className="mt-3 text-text-muted leading-relaxed">
        Send a test notification to verify the webhook is working:
      </p>
      <div className="mt-3">
        <CodeBlock title="API: Test Slack">{`POST /api/slack/test
{
  "webhookUrl": "https://hooks.slack.com/services/T.../B.../..."
}`}</CodeBlock>
      </div>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Notification Events</h3>
      <p className="mt-3 text-text-muted leading-relaxed">
        Slack notifications are sent for key task lifecycle events:
      </p>
      <ul className="mt-3 list-disc pl-5 space-y-1 text-[14px] text-text-muted">
        <li>Task completed (PR merged)</li>
        <li>Task failed</li>
        <li>Task needs attention (CI failure or review changes requested)</li>
        <li>PR opened</li>
      </ul>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Webhooks</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Webhooks let you push Optio events to any HTTP endpoint in real time. This is the most
        flexible integration option, enabling custom workflows, dashboards, and third-party
        integrations.
      </p>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Creating a Webhook</h3>
      <div className="mt-3">
        <CodeBlock title="API: Create webhook">{`POST /api/webhooks
{
  "url": "https://your-app.example.com/optio-events",
  "events": ["task.completed", "task.failed", "task.pr_opened"],
  "secret": "your-webhook-secret"
}`}</CodeBlock>
      </div>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Event Types</h3>
      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-bg-card">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-bg-subtle">
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Event</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Fired When</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {[
              ["task.created", "A new task is created"],
              ["task.queued", "Task enters the job queue"],
              ["task.running", "Agent starts executing"],
              ["task.pr_opened", "Agent opens a pull request"],
              ["task.completed", "PR is merged and task completes"],
              ["task.failed", "Task fails (agent error, timeout, etc.)"],
              ["task.cancelled", "Task is manually cancelled"],
              ["task.needs_attention", "CI failed or review requested changes"],
            ].map(([event, desc]) => (
              <tr key={event}>
                <td className="px-4 py-3 font-mono text-text-heading">{event}</td>
                <td className="px-4 py-3 text-text-muted">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Payload Format</h3>
      <div className="mt-3">
        <CodeBlock title="webhook payload">{`{
  "event": "task.completed",
  "timestamp": "2025-01-15T10:30:00Z",
  "data": {
    "taskId": "abc123",
    "title": "Add email validation",
    "repoUrl": "https://github.com/acme/webapp",
    "state": "completed",
    "prUrl": "https://github.com/acme/webapp/pull/42",
    "costUsd": "0.35"
  }
}`}</CodeBlock>
      </div>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Webhook Security</h3>
      <p className="mt-3 text-text-muted leading-relaxed">
        If you provide a{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">secret</code> when
        creating a webhook, Optio signs each delivery with an HMAC-SHA256 signature in the request
        headers. Verify this signature on your server to ensure payloads are authentic.
      </p>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Delivery Tracking</h3>
      <p className="mt-3 text-text-muted leading-relaxed">
        Every webhook delivery is recorded in the{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
          webhook_deliveries
        </code>{" "}
        table with the HTTP status code and success/failure status. The webhook worker handles
        delivery asynchronously via BullMQ.
      </p>

      <Callout type="info">
        Webhook delivery is handled by the webhook worker, so it does not block task processing.
        Failed deliveries are logged but not retried automatically.
      </Callout>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">WebSocket Events</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        For real-time browser-based integrations, Optio provides WebSocket endpoints. Events are
        published to Redis pub/sub and relayed to connected clients.
      </p>
      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-bg-card">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-bg-subtle">
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Endpoint</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {[
              ["/ws/logs/:taskId", "Structured log stream for a running task (NDJSON)"],
              ["/ws/events", "Global event stream — task state changes, new tasks, errors"],
            ].map(([endpoint, desc]) => (
              <tr key={endpoint}>
                <td className="px-4 py-3 font-mono text-text-heading">{endpoint}</td>
                <td className="px-4 py-3 text-text-muted">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-text-muted leading-relaxed">
        WebSocket connections authenticate via the{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">?token=</code>{" "}
        query parameter using the same session token as the REST API.
      </p>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">MCP Servers &amp; Connections</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Optio supports{" "}
        <a
          href="https://modelcontextprotocol.io/"
          className="text-primary-light hover:underline"
          target="_blank"
          rel="noopener noreferrer"
        >
          Model Context Protocol (MCP)
        </a>{" "}
        servers that extend the agent&apos;s capabilities. The recommended way to manage MCP servers
        is through{" "}
        <Link href="/docs/guides/connections" className="text-primary-light hover:underline">
          Connections
        </Link>
        , which provides a catalog of built-in providers (Notion, Slack, Linear, GitHub, PostgreSQL,
        Sentry), access control per repo and agent type, health checking, and secret management.
      </p>
      <p className="mt-3 text-text-muted leading-relaxed">
        You can also configure MCP servers directly via the API for simpler setups:
      </p>
      <div className="mt-3">
        <CodeBlock title="API: Add MCP server directly">{`POST /api/mcp-servers
{
  "name": "GitHub Tools",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_TOKEN": "{{GITHUB_TOKEN}}" },
  "repoUrl": null
}`}</CodeBlock>
      </div>
      <p className="mt-3 text-text-muted leading-relaxed">
        Set <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">repoUrl</code>{" "}
        to scope the MCP server to a specific repo, or leave it{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">null</code> for
        global availability.
      </p>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Next Steps</h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {[
          {
            title: "Connections",
            href: "/docs/guides/connections",
            description: "Give agents access to external services via MCP",
          },
          {
            title: "Standalone Tasks",
            href: "/docs/guides/standalone-tasks",
            description: "Reusable agent jobs with triggers",
          },
          {
            title: "Creating Tasks",
            href: "/docs/guides/creating-tasks",
            description: "Create tasks from issues and tickets",
          },
          {
            title: "Configuration",
            href: "/docs/configuration",
            description: "Environment variables and settings",
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
